import { join, normalize } from "node:path"
import {
    isMap,
    isScalar,
    isSeq,
    LineCounter,
    parseAllDocuments,
    type Node,
    type YAMLMap
} from "yaml"
import { collectSites, type KeySite, type Offset, pathKey, type Position } from "./yamlPaths"

/** Where the chart of a release comes from. */
export type ChartRef =
    | { kind: "repository"; repoURL: string; chart: string; version: string }
    | { kind: "directory"; dir: string }
    | { kind: "unresolved"; reason: string }

/** A layer of a release before its file got read. */
export type LayerSource =
    | { kind: "file"; label: string; fsPath: string | undefined; raw: string; problem?: string }
    | {
          kind: "inline"
          label: string
          fsPath: string
          text: string
          /** Undefined for a quoted or flow string, whose lines the editor cannot map. */
          offset: Offset | undefined
      }
    | { kind: "object"; label: string; fsPath: string; data: unknown; sites: Map<string, KeySite> }
    | {
          kind: "parameters"
          label: string
          fsPath: string
          parameters: { name: string; value: string; forceString?: boolean }[]
          sites: Map<string, KeySite>
      }

/** A Helm release, as a deployment tool such as Argo CD or Helmfile describes it. */
export interface ReleaseSpec {
    /** Tells two releases of one name apart, such as one Application rendered once per cluster. */
    id: string
    /** The name that the editor shows, such as `metadata.name` of an Application. */
    name: string
    /** Names what describes the release, such as "Argo CD Application" or "Helmfile release". */
    origin: string
    /** The file that describes the release. */
    appFile: string
    /** The line in `appFile` where the editor shows the summary of the release. */
    appLine: number
    releaseName: string
    namespace: string | undefined
    chart: ChartRef
    /** The layers above the defaults of the chart, lowest first. */
    layers: LayerSource[]
}

/** Maps a `repoURL` of a source to the folder that holds its checkout, or undefined for a repository outside the workspace. */
export type CheckoutOf = (repoURL: string) => string | undefined

/**
 * Finds the Argo CD Applications in a YAML text and the layers that each one hands Helm, in Argo CD's order:
 * `valueFiles` in their order, then `values`, then `valuesObject`, then `parameters`.
 * `valuesObject` takes the place of `values` once both are set.
 */
export function readApplications(
    fsPath: string,
    text: string,
    checkoutOf: CheckoutOf
): ReleaseSpec[] {
    if (!text.includes("argoproj.io") || !/kind:\s*Application\b/.test(text)) return []
    const lineCounter = new LineCounter()
    const releases: ReleaseSpec[] = []
    const at = (offset: number): Position => {
        const { line, col } = lineCounter.linePos(offset)
        return { line: line - 1, column: col - 1 }
    }
    for (const document of parseAllDocuments(text, { lineCounter })) {
        if (!("contents" in document) || !isMap(document.contents)) continue
        const root = document.contents
        if (scalarAt(root, "kind") !== "Application") continue
        if (!String(scalarAt(root, "apiVersion") ?? "").startsWith("argoproj.io/")) continue
        const metadata = mapAt(root, "metadata")
        const spec = mapAt(root, "spec")
        if (metadata === undefined || spec === undefined) continue
        const name = String(scalarAt(metadata, "name") ?? "")
        const nameNode = metadata.get("name", true) as Node | undefined
        const sources = sourcesOf(spec)
        const helmSource = sources.find(
            (source) =>
                mapAt(source, "helm") !== undefined || scalarAt(source, "chart") !== undefined
        )
        if (helmSource === undefined) continue
        const release = readRelease(fsPath, text, helmSource, sources, checkoutOf, at)
        const appLine = nameNode?.range ? at(nameNode.range[0]).line : 0
        releases.push({
            id: `${fsPath}:${appLine}:${name}`,
            name,
            origin: "Argo CD Application",
            appFile: fsPath,
            appLine,
            releaseName: release.releaseName ?? name,
            namespace:
                (scalarAt(mapAt(spec, "destination"), "namespace") as string | undefined) ??
                undefined,
            chart: release.chart,
            layers: release.layers
        })
    }
    return releases
}

function readRelease(
    fsPath: string,
    text: string,
    source: YAMLMap,
    sources: YAMLMap[],
    checkoutOf: CheckoutOf,
    at: (offset: number) => Position
): { releaseName: string | undefined; chart: ChartRef; layers: LayerSource[] } {
    const repoURL = String(scalarAt(source, "repoURL") ?? "")
    const chartName = scalarAt(source, "chart")
    const sourcePath = scalarAt(source, "path")
    let chart: ChartRef
    let chartDir: string | undefined
    if (chartName !== undefined) {
        chart = {
            kind: "repository",
            repoURL,
            chart: String(chartName),
            version: String(scalarAt(source, "targetRevision") ?? "")
        }
    } else if (sourcePath !== undefined) {
        const checkout = checkoutOf(repoURL)
        chartDir = checkout === undefined ? undefined : join(checkout, String(sourcePath))
        chart =
            chartDir === undefined
                ? { kind: "unresolved", reason: `${repoURL} is not checked out in the workspace` }
                : { kind: "directory", dir: chartDir }
    } else {
        chart = { kind: "unresolved", reason: "the source names neither a chart nor a path" }
    }

    const helm = mapAt(source, "helm")
    const layers: LayerSource[] = []
    const refs = new Map<string, string>()
    for (const other of sources) {
        const ref = scalarAt(other, "ref")
        if (ref !== undefined) refs.set(String(ref), String(scalarAt(other, "repoURL") ?? ""))
    }

    const valueFiles = helm?.get("valueFiles", true)
    if (isSeq(valueFiles)) {
        for (const item of valueFiles.items) {
            if (!isScalar(item)) continue
            const raw = String(item.value)
            layers.push(valueFileLayer(raw, refs, chartDir, checkoutOf))
        }
    }

    const valuesNode = helm?.get("values", true) as Node | undefined
    const valuesObject = helm?.get("valuesObject", true) as Node | undefined
    if (isMap(valuesObject)) {
        const sites = new Map<string, KeySite>()
        collectSites(valuesObject, [], sites, at)
        layers.push({
            kind: "object",
            label: "helm.valuesObject",
            fsPath,
            data: valuesObject.toJSON(),
            sites
        })
    } else if (isScalar(valuesNode) && typeof valuesNode.value === "string") {
        layers.push({
            kind: "inline",
            label: "helm.values",
            fsPath,
            text: valuesNode.value,
            offset: blockOffset(text, valuesNode, at)
        })
    } else if (isMap(valuesNode)) {
        // Argo CD takes a map under `values` as well, the way it takes `valuesObject`.
        const sites = new Map<string, KeySite>()
        collectSites(valuesNode, [], sites, at)
        layers.push({
            kind: "object",
            label: "helm.values",
            fsPath,
            data: valuesNode.toJSON(),
            sites
        })
    }

    const parametersNode = helm?.get("parameters", true)
    if (isSeq(parametersNode) && parametersNode.items.length > 0) {
        const parameters: { name: string; value: string; forceString?: boolean }[] = []
        const sites = new Map<string, KeySite>()
        for (const item of parametersNode.items) {
            if (!isMap(item)) continue
            const name = String(scalarAt(item, "name") ?? "")
            const nameNode = item.get("name", true) as Node | undefined
            parameters.push({
                name,
                value: String(scalarAt(item, "value") ?? ""),
                forceString: scalarAt(item, "forceString") === true
            })
            if (nameNode?.range) {
                const path = name.split(/(?<!\\)\./).map((segment) => segment.replace(/\\\./g, "."))
                sites.set(pathKey(path), { key: at(nameNode.range[0]), valueEnd: undefined })
            }
        }
        layers.push({ kind: "parameters", label: "helm.parameters", fsPath, parameters, sites })
    }

    const releaseName = scalarAt(helm, "releaseName")
    return {
        releaseName: releaseName === undefined ? undefined : String(releaseName),
        chart,
        layers
    }
}

function valueFileLayer(
    raw: string,
    refs: Map<string, string>,
    chartDir: string | undefined,
    checkoutOf: CheckoutOf
): LayerSource {
    const label = raw.replace(/^\$[^/]+\//, "")
    const refMatch = /^\$([^/]+)\/(.*)$/.exec(raw)
    if (refMatch !== null) {
        const repoURL = refs.get(refMatch[1]!)
        if (repoURL === undefined)
            return {
                kind: "file",
                label,
                fsPath: undefined,
                raw,
                problem: `no source has ref: ${refMatch[1]}`
            }
        const checkout = checkoutOf(repoURL)
        if (checkout === undefined)
            return {
                kind: "file",
                label,
                fsPath: undefined,
                raw,
                problem: `${repoURL} is not checked out in the workspace`
            }
        return { kind: "file", label, fsPath: normalize(join(checkout, refMatch[2]!)), raw }
    }
    if (/^https?:\/\//.test(raw))
        return {
            kind: "file",
            label,
            fsPath: undefined,
            raw,
            problem: "a values file by URL gets no lookup"
        }
    if (chartDir === undefined)
        return {
            kind: "file",
            label,
            fsPath: undefined,
            raw,
            problem: "a path relative to a chart from a Helm repository points into the chart"
        }
    return { kind: "file", label, fsPath: normalize(join(chartDir, raw)), raw }
}

/**
 * Finds how far the lines of a block scalar sit from the lines of its text.
 * The text of `values: |` starts on the line after the indicator, indented by the indentation of its first line.
 */
function blockOffset(
    text: string,
    node: Node,
    at: (offset: number) => Position
): Offset | undefined {
    if (
        !isScalar(node) ||
        (node.type !== "BLOCK_LITERAL" && node.type !== "BLOCK_FOLDED") ||
        !node.range
    )
        return undefined
    const header = at(node.range[0])
    const lines = text.split("\n")
    for (let line = header.line + 1; line < lines.length; line++) {
        const content = lines[line]!
        if (content.trim() === "") continue
        const indent = content.length - content.trimStart().length
        return { lineDelta: header.line + 1, columnDelta: indent }
    }
    return undefined
}

function sourcesOf(spec: YAMLMap): YAMLMap[] {
    const sources = spec.get("sources", true)
    if (isSeq(sources)) return sources.items.filter((item): item is YAMLMap => isMap(item))
    const source = spec.get("source", true)
    return isMap(source) ? [source] : []
}

function mapAt(map: YAMLMap | undefined, key: string): YAMLMap | undefined {
    const value = map?.get(key, true)
    return isMap(value) ? value : undefined
}

function scalarAt(map: YAMLMap | undefined, key: string): unknown {
    const value = map?.get(key, true)
    return isScalar(value) ? value.value : undefined
}

/** Turns a Git URL into a form that two spellings of one repository share: `github.com/bjoern621/hh-cluster-infra`. */
export function normalizeRepoURL(url: string): string {
    return url
        .trim()
        .replace(/^git@([^:]+):/, "$1/")
        .replace(/^[a-z+]+:\/\//, "")
        .replace(/^[^@/]+@/, "")
        .replace(/\.git$/, "")
        .replace(/\/$/, "")
        .toLowerCase()
}
