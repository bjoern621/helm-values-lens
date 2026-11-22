import { existsSync } from "node:fs"
import { basename, dirname, isAbsolute, join, normalize } from "node:path"
import { isMap, type YAMLMap } from "yaml"
import type { ChartRef, LayerSource, ReleaseSpec } from "../argo"
import type { SourceReader } from "./types"
import {
    type At,
    mapAt,
    mapDocuments,
    mapsAt,
    missingLayer,
    nodeAt,
    lineOf,
    objectLayer,
    stringAt,
    withoutOciScheme
} from "./yamlNodes"

const KUSTOMIZATION_NAMES = new Set(["kustomization.yaml", "kustomization.yml", "Kustomization"])

/** Kustomize's `HelmDefaultHome`. */
const DEFAULT_CHART_HOME = "charts"

const VALUES_MERGE_OPTIONS = ["merge", "override", "replace"]

/**
 * Finds the `helmCharts` of a kustomization and the layers that kustomize hands Helm for each.
 * The order follows `HelmChartInflationGenerator.go` and `HelmChart.AsHelmArgs` of kustomize v5.8.3:
 * - `valuesFile` defaults to `values.yaml` of the chart.
 * - `valuesInline` merges into the text of `valuesFile` as `valuesMerge` says.
 *   `override` (the default) lets the inline values win, `merge` lets the file win and `replace` drops the file.
 *   Kustomize hands Helm the merged text as one `-f`.
 * - Each of `additionalValuesFiles` follows as its own `-f`, relative to the kustomization.
 *
 * The layers model the `merge2` of kyaml as a Helm merge of two layers. The two differ in two cases:
 * - `merge2` merges a list of maps by a key such as `name`. Helm replaces the list whole.
 * - A null in `valuesInline` clears the key in the merged text. The default of the chart stays.
 *   As a layer, the null deletes that default.
 */
export const readKustomizeHelmCharts: SourceReader = (file) => {
    if (!KUSTOMIZATION_NAMES.has(basename(file.fsPath)) || !file.text.includes("helmCharts"))
        return []
    const dir = dirname(file.fsPath)
    const { roots, at } = mapDocuments(file.text)
    const releases: ReleaseSpec[] = []
    for (const root of roots) {
        const chartHome = stringAt(mapAt(root, "helmGlobals"), "chartHome") ?? DEFAULT_CHART_HOME
        const homeDir = isAbsolute(chartHome) ? chartHome : join(dir, chartHome)
        for (const entry of mapsAt(root, "helmCharts") ?? [])
            releases.push(readHelmChart(file.fsPath, dir, homeDir, entry, at))
    }
    return releases
}

function readHelmChart(
    fsPath: string,
    dir: string,
    homeDir: string,
    entry: YAMLMap,
    at: At
): ReleaseSpec {
    const name = stringAt(entry, "name") ?? ""
    const repo = stringAt(entry, "repo") ?? ""
    const version = stringAt(entry, "version") ?? ""
    // Kustomize pulls a chart with both `repo` and `version` into a folder of its own per version.
    const absChartHome =
        repo !== "" && version !== "" ? join(homeDir, `${name}-${version}`) : homeDir
    const localDir = join(absChartHome, name)
    const local = existsSync(localDir)
    const chart: ChartRef = local
        ? { kind: "directory", dir: localDir }
        : repo === ""
          ? {
                kind: "unresolved",
                reason: `no repo specified for pull, no chart found at ${localDir}`
            }
          : { kind: "repository", repoURL: withoutOciScheme(repo), chart: name, version }

    const appLine = lineOf(nodeAt(entry, "name"), at)
    const releaseName = stringAt(entry, "releaseName")
    return {
        id: `${fsPath}:${appLine}:${releaseName ?? name}`,
        name: releaseName ?? name,
        origin: "Kustomize helmCharts",
        appFile: fsPath,
        appLine,
        // Without `releaseName`, kustomize passes `--generate-name`, which picks a name per render.
        releaseName: releaseName ?? name,
        namespace: stringAt(entry, "namespace"),
        chart,
        layers: valueLayers(fsPath, dir, entry, local ? localDir : undefined, at)
    }
}

function valueLayers(
    fsPath: string,
    dir: string,
    entry: YAMLMap,
    localDir: string | undefined,
    at: At
): LayerSource[] {
    const merge = stringAt(entry, "valuesMerge") ?? "override"
    if (!VALUES_MERGE_OPTIONS.includes(merge))
        return [missingLayer("valuesMerge", `valuesMerge must be one of ${VALUES_MERGE_OPTIONS}`)]

    const valuesFile = stringAt(entry, "valuesFile")
    const explicitFile = valuesFile === undefined ? undefined : fileLayer(dir, valuesFile)
    const inlineNode = nodeAt(entry, "valuesInline")
    const inline =
        isMap(inlineNode) && inlineNode.items.length > 0
            ? objectLayer("valuesInline", fsPath, inlineNode, at)
            : undefined

    const layers: LayerSource[] = []
    if (inline === undefined) {
        if (explicitFile !== undefined) layers.push(explicitFile)
    } else if (merge === "override") {
        if (explicitFile !== undefined) layers.push(explicitFile)
        layers.push(inline)
    } else if (merge === "merge") {
        layers.push(inline)
        // The defaults of the chart sit below every layer. They go on top once more to win over the inline values.
        if (explicitFile !== undefined) layers.push(explicitFile)
        else if (localDir !== undefined)
            layers.push({
                kind: "file",
                label: "chart values.yaml (valuesMerge: merge)",
                fsPath: join(localDir, "values.yaml"),
                raw: "values.yaml"
            })
        else
            layers.push(
                missingLayer(
                    "chart values.yaml (valuesMerge: merge)",
                    "the values of a chart from a repository win over valuesInline, which the trace leaves out"
                )
            )
    } else {
        layers.push(inline)
    }

    const additional = nodeAt(entry, "additionalValuesFiles")
    for (const raw of (additional?.toJSON() as unknown[] | undefined) ?? []) {
        if (typeof raw === "string") layers.push(fileLayer(dir, raw))
    }
    return layers
}

function fileLayer(dir: string, raw: string): LayerSource {
    if (/^https?:\/\//.test(raw))
        return {
            kind: "file",
            label: raw,
            fsPath: undefined,
            raw,
            problem: "a values file by URL gets no lookup"
        }
    return {
        kind: "file",
        label: raw,
        fsPath: normalize(isAbsolute(raw) ? raw : join(dir, raw)),
        raw
    }
}
