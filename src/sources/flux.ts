import { createHash } from "node:crypto"
import { basename, dirname, join, normalize } from "node:path"
import { isMap, isScalar, type Node, type YAMLMap } from "yaml"
import type { ChartRef, LayerSource, ReleaseSpec } from "../argo"
import type { KeySite } from "../yamlPaths"
import type { SourceContext, SourceReader } from "./types"
import {
    type At,
    blockOffset,
    existsInWorkspace,
    findResource,
    lineOf,
    mapAt,
    mapDocuments,
    mapsAt,
    missingLayer,
    nodeAt,
    objectLayer,
    parameterSite,
    readWorkspaceText,
    type Resource,
    scalarAt,
    splitOciChart,
    stringAt,
    withoutOciScheme
} from "./yamlNodes"

/** Helm caps a release name at 53 characters. Flux shortens a longer default name with a hash. */
const MAX_RELEASE_NAME_LENGTH = 53
const RELEASE_NAME_HASH_LENGTH = 12

const KUSTOMIZATION_NAMES = new Set(["kustomization.yaml", "kustomization.yml", "Kustomization"])

/**
 * Finds the Flux HelmReleases in a YAML text and the layers that Flux hands Helm, in the order of
 * `ChartValuesFromReferences` in `fluxcd/pkg/chartutil/values.go`:
 * - `valuesFiles` of the HelmChart, which source-controller packages into the chart as its values.
 * - `spec.valuesFrom` without a `targetPath`, in their order.
 * - `spec.values`.
 * - `spec.valuesFrom` with a `targetPath`, in their order, as `--set` style parameters.
 *
 * The HelmRepository, GitRepository, OCIRepository or HelmChart that the release names comes from `context.files`.
 * Its ConfigMaps and Secrets come from there as well, or from a kustomize `configMapGenerator` or `secretGenerator` entry of that name.
 * Source-controller drops the `values.yaml` of the chart once `valuesFiles` leaves it out.
 * The layers keep the defaults of the chart below `valuesFiles` all the same.
 */
export const readFluxHelmReleases: SourceReader = (file, context) => {
    if (!file.text.includes("helm.toolkit.fluxcd.io") || !/kind:\s*HelmRelease\b/.test(file.text))
        return []
    const { roots, at } = mapDocuments(file.text)
    const releases: ReleaseSpec[] = []
    for (const root of roots) {
        if (stringAt(root, "kind") !== "HelmRelease") continue
        if (!(stringAt(root, "apiVersion") ?? "").startsWith("helm.toolkit.fluxcd.io/")) continue
        const metadata = mapAt(root, "metadata")
        const spec = mapAt(root, "spec")
        if (metadata === undefined || spec === undefined) continue
        const name = stringAt(metadata, "name") ?? ""
        const namespace = stringAt(metadata, "namespace")
        const targetNamespace = stringAt(spec, "targetNamespace")
        const { chart, valuesFiles } = chartOf(spec, namespace, context)
        const appLine = lineOf(nodeAt(metadata, "name"), at)
        releases.push({
            id: `${file.fsPath}:${appLine}:${name}`,
            name,
            origin: "Flux HelmRelease",
            appFile: file.fsPath,
            appLine,
            releaseName:
                stringAt(spec, "releaseName") ??
                shortenedName(targetNamespace === undefined ? name : `${targetNamespace}-${name}`),
            namespace: targetNamespace ?? namespace,
            chart,
            layers: [...valuesFiles, ...valueLayers(file.fsPath, spec, namespace, context, at)]
        })
    }
    return releases
}

/** Shortens a release name as `ShortenName` of the helm-controller API does. */
function shortenedName(name: string): string {
    if (name.length <= MAX_RELEASE_NAME_LENGTH) return name
    const hash = createHash("sha256").update(name).digest("hex").slice(0, RELEASE_NAME_HASH_LENGTH)
    return `${name.slice(0, MAX_RELEASE_NAME_LENGTH - RELEASE_NAME_HASH_LENGTH - 1)}-${hash}`
}

interface ResolvedChart {
    chart: ChartRef
    valuesFiles: LayerSource[]
}

function unresolved(reason: string): ResolvedChart {
    return { chart: { kind: "unresolved", reason }, valuesFiles: [] }
}

function chartOf(
    spec: YAMLMap,
    namespace: string | undefined,
    context: SourceContext
): ResolvedChart {
    const chartRef = mapAt(spec, "chartRef")
    if (chartRef !== undefined) {
        const kind = stringAt(chartRef, "kind") ?? ""
        const name = stringAt(chartRef, "name") ?? ""
        const refNamespace = stringAt(chartRef, "namespace") ?? namespace
        if (kind !== "OCIRepository" && kind !== "HelmChart")
            return unresolved(`a chartRef to a ${kind} gets no lookup`)
        const source = findResource(context, kind, name, refNamespace)
        if (source === undefined) return unresolved(`no ${kind} ${name} in the workspace`)
        const sourceSpec = mapAt(source.root, "spec")
        return kind === "OCIRepository"
            ? ociChart(sourceSpec)
            : helmChart(sourceSpec, source.namespace ?? refNamespace, context)
    }
    const template = mapAt(spec, "chart")
    if (template === undefined)
        return unresolved("the HelmRelease sets neither spec.chart nor spec.chartRef")
    const templateSpec = mapAt(template, "spec")
    return stringAt(template, "kind") === "OCIRepository"
        ? ociChart(templateSpec)
        : helmChart(templateSpec, namespace, context)
}

function ociChart(spec: YAMLMap | undefined): ResolvedChart {
    const url = stringAt(spec, "url") ?? ""
    if (!url.startsWith("oci://")) return unresolved(`the OCIRepository has no oci:// URL`)
    const ref = mapAt(spec, "ref")
    const version = stringAt(ref, "tag") ?? stringAt(ref, "semver") ?? ""
    return { chart: { kind: "repository", ...splitOciChart(url), version }, valuesFiles: [] }
}

/** Resolves the spec of a HelmChart, from `spec.chart.spec` of a HelmRelease or a HelmChart resource. */
function helmChart(
    spec: YAMLMap | undefined,
    namespace: string | undefined,
    context: SourceContext
): ResolvedChart {
    const chartName = stringAt(spec, "chart") ?? ""
    const version = stringAt(spec, "version") ?? ""
    const sourceRef = mapAt(spec, "sourceRef")
    const kind = stringAt(sourceRef, "kind") ?? ""
    const name = stringAt(sourceRef, "name") ?? ""
    const valuesFiles = (
        (nodeAt(spec, "valuesFiles")?.toJSON() as unknown[] | undefined) ?? []
    ).filter((raw): raw is string => typeof raw === "string")
    const ignoreMissing = scalarAt(spec, "ignoreMissingValuesFiles") === true
    const unreadable = (reason: string): ResolvedChart => ({
        ...unresolved(reason),
        valuesFiles: valuesFiles.map((raw) => missingLayer(raw, reason))
    })

    if (kind !== "HelmRepository" && kind !== "GitRepository")
        return unreadable(`a chart from a ${kind} gets no lookup`)
    const source = findResource(context, kind, name, stringAt(sourceRef, "namespace") ?? namespace)
    if (source === undefined) return unreadable(`no ${kind} ${name} in the workspace`)
    const url = stringAt(mapAt(source.root, "spec"), "url") ?? ""

    if (kind === "HelmRepository") {
        const oci =
            stringAt(mapAt(source.root, "spec"), "type") === "oci" || url.startsWith("oci://")
        return {
            chart: {
                kind: "repository",
                repoURL: oci ? withoutOciScheme(url) : url,
                chart: chartName,
                version: version === "*" ? "" : version
            },
            valuesFiles: valuesFiles.map((raw) =>
                missingLayer(raw, `a values file inside the chart from ${url} gets no lookup`)
            )
        }
    }

    const checkout = context.checkoutOf(url)
    if (checkout === undefined) return unreadable(`${url} is not checked out in the workspace`)
    // Source-controller reads the values files relative to the root of the source.
    const layers = valuesFiles.flatMap((raw): LayerSource[] => {
        const fsPath = normalize(join(checkout, raw))
        if (ignoreMissing && !existsInWorkspace(fsPath, context)) return []
        return [{ kind: "file", label: raw, fsPath, raw }]
    })
    return {
        chart: { kind: "directory", dir: normalize(join(checkout, chartName)) },
        valuesFiles: layers
    }
}

function valueLayers(
    fsPath: string,
    spec: YAMLMap,
    namespace: string | undefined,
    context: SourceContext,
    at: At
): LayerSource[] {
    const layers: LayerSource[] = []
    const parameters: { name: string; value: string; forceString?: boolean }[] = []
    const sites = new Map<string, KeySite>()
    const pathLayers: LayerSource[] = []

    for (const ref of mapsAt(spec, "valuesFrom") ?? []) {
        const kind = stringAt(ref, "kind") ?? ""
        const name = stringAt(ref, "name") ?? ""
        const key = stringAt(ref, "valuesKey") ?? "values.yaml"
        const targetPath = stringAt(ref, "targetPath") ?? ""
        const label = `${kind} ${name} ${key}`
        const found = referencedValues(kind, name, key, namespace, context)
        if (typeof found === "string") {
            const optional = scalarAt(ref, "optional") === true ? " (optional)" : ""
            ;(targetPath === "" ? layers : pathLayers).push(missingLayer(label, found + optional))
            continue
        }
        if (targetPath === "") {
            layers.push(found.layer(label))
            continue
        }
        let value = found.text
        // Flux reads a quoted value as a string, as `--set-string` does. `literal` keeps the text as it stands.
        const quoted = /^(".*"|'.*')$/s.test(value)
        if (quoted) value = value.replace(/^["']+|["']+$/g, "")
        parameters.push({
            name: targetPath,
            value,
            forceString: quoted || scalarAt(ref, "literal") === true
        })
        parameterSite(sites, targetPath, nodeAt(ref, "targetPath"), at)
    }

    const values = nodeAt(spec, "values")
    if (isMap(values)) layers.push(objectLayer("spec.values", fsPath, values, at))
    layers.push(...pathLayers)
    if (parameters.length > 0)
        layers.push({
            kind: "parameters",
            label: "valuesFrom targetPath",
            fsPath,
            parameters,
            sites
        })
    return layers
}

interface ReferencedValues {
    /** The text under the key, which a `targetPath` takes as one value. */
    text: string
    layer: (label: string) => LayerSource
}

/** Finds the text under `key` of a ConfigMap or Secret. Returns the reason as a string where none resolves. */
function referencedValues(
    kind: string,
    name: string,
    key: string,
    namespace: string | undefined,
    context: SourceContext
): ReferencedValues | string {
    if (kind !== "ConfigMap" && kind !== "Secret") return `valuesFrom of a ${kind} gets no lookup`
    const resource = findResource(context, kind, name, namespace)
    if (resource !== undefined) return resourceValues(resource, key)
    const generated = generatedValues(kind, name, key, context)
    if (generated !== undefined) return generated
    return `no ${kind} ${name} in the workspace`
}

function resourceValues(resource: Resource, key: string): ReferencedValues | string {
    const { root, file, at, kind, name } = resource
    if (kind === "Secret" && mapAt(root, "sops") !== undefined)
        return `SOPS encrypts Secret ${name}, which the trace leaves out`
    const plain = nodeAt(mapAt(root, kind === "Secret" ? "stringData" : "data"), key)
    if (isScalar(plain)) {
        const text = String(plain.value ?? "")
        return {
            text,
            layer: (label) => ({
                kind: "inline",
                label,
                fsPath: file.fsPath,
                text,
                offset: blockOffset(file.text, plain as Node, at)
            })
        }
    }
    const encoded = kind === "Secret" ? scalarAt(mapAt(root, "data"), key) : undefined
    if (typeof encoded === "string") {
        const text = Buffer.from(encoded, "base64").toString("utf8")
        return {
            text,
            layer: (label) => ({
                kind: "inline",
                label,
                fsPath: file.fsPath,
                text,
                offset: undefined
            })
        }
    }
    return `${kind} ${name} has no key ${key}`
}

/**
 * Finds a `configMapGenerator` or `secretGenerator` entry of a kustomization that builds `name`.
 * An entry of `files` reads `key=path` or `path`, whose file name gives the key.
 * Kustomize appends a hash to the generated name, which the lookup leaves out.
 */
function generatedValues(
    kind: string,
    name: string,
    key: string,
    context: SourceContext
): ReferencedValues | undefined {
    const generator = kind === "ConfigMap" ? "configMapGenerator" : "secretGenerator"
    for (const file of context.files) {
        if (!KUSTOMIZATION_NAMES.has(basename(file.fsPath)) || !file.text.includes(generator))
            continue
        for (const root of mapDocuments(file.text).roots) {
            for (const entry of mapsAt(root, generator) ?? []) {
                if (stringAt(entry, "name") !== name) continue
                for (const item of (nodeAt(entry, "files")?.toJSON() as unknown[] | undefined) ??
                    []) {
                    if (typeof item !== "string") continue
                    const separator = item.indexOf("=")
                    const path = separator === -1 ? item : item.slice(separator + 1)
                    const itemKey = separator === -1 ? basename(path) : item.slice(0, separator)
                    if (itemKey !== key) continue
                    const fsPath = normalize(join(dirname(file.fsPath), path))
                    return {
                        text: readWorkspaceText(fsPath, context) ?? "",
                        layer: (label) => ({ kind: "file", label, fsPath, raw: path })
                    }
                }
            }
        }
    }
    return undefined
}
