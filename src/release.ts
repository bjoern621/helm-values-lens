import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { LayerSource, ReleaseSpec } from "./argo"
import type { Dependency, LoadedChart } from "./chart"
import { coalesce, isPlainMap, type Layer, parametersData, type Trace, valueAt } from "./coalesce"
import { parseValues, pathKey, splitPathKey, type ValuePath } from "./yamlPaths"

/** A release with its layers merged. */
export interface Release {
    spec: ReleaseSpec
    chart: LoadedChart
    trace: Trace
    /** The index in `trace.layers` of the first layer above the chart defaults. */
    firstUserLayer: number
    /** What kept a layer from loading, such as a values file that does not exist. */
    problems: string[]
    /** The keys of the dependencies that a `condition` or the `tags` turn off. */
    disabled: Set<string>
    /** Every path that a template of the chart or a dependency reads through `.Values`, by `pathKey`. */
    readPaths: Set<string>
}

/** Reads a file, from the editor where it holds unsaved changes. */
export type ReadText = (fsPath: string) => string

export const readFromDisk: ReadText = (fsPath) => readFileSync(fsPath, "utf8")

export function buildRelease(
    spec: ReleaseSpec,
    chart: LoadedChart,
    readText: ReadText = readFromDisk
): Release {
    const problems: string[] = []
    const userLayers = spec.layers.flatMap((source) => {
        const layer = loadLayer(source, problems, readText)
        return layer === undefined ? [] : [layer]
    })
    let trace = coalesce([...chart.layers, ...userLayers])
    const disabled = new Set(
        chart.dependencies
            .filter((dependency) => !isEnabled(dependency, trace.final))
            .map((dependency) => dependency.key)
    )
    const defaults = chart.layers.filter(
        (_, index) =>
            !chart.dependencies.some(
                (dependency) => dependency.layerIndex === index && disabled.has(dependency.key)
            )
    )
    if (disabled.size > 0) trace = coalesce([...defaults, ...userLayers])
    return {
        spec,
        chart,
        trace,
        firstUserLayer: defaults.length,
        disabled,
        problems,
        readPaths: templateReads(chart)
    }
}

function loadLayer(source: LayerSource, problems: string[], readText: ReadText): Layer | undefined {
    switch (source.kind) {
        case "file": {
            if (source.fsPath === undefined || !existsSync(source.fsPath)) {
                problems.push(`${source.raw}: ${source.problem ?? "the file does not exist"}`)
                return undefined
            }
            const parsed = parseValues(readText(source.fsPath))
            for (const error of parsed.errors) problems.push(`${source.label}: ${error}`)
            return {
                kind: "file",
                label: source.label,
                fsPath: source.fsPath,
                offset: undefined,
                data: parsed.data ?? {},
                sites: parsed.sites
            }
        }
        case "inline": {
            const parsed = parseValues(source.text)
            for (const error of parsed.errors) problems.push(`${source.label}: ${error}`)
            return {
                kind: "inline",
                label: source.label,
                fsPath: source.fsPath,
                offset: source.offset,
                data: parsed.data ?? {},
                sites: parsed.sites
            }
        }
        case "object":
            return {
                kind: "object",
                label: source.label,
                fsPath: source.fsPath,
                offset: undefined,
                data: source.data,
                sites: source.sites
            }
        case "parameters": {
            const { data, unsupported } = parametersData(source.parameters)
            for (const name of unsupported)
                problems.push(
                    `helm.parameters: ${name} sets a list item, which the trace leaves out`
                )
            return {
                kind: "parameters",
                label: source.label,
                fsPath: source.fsPath,
                offset: undefined,
                data,
                sites: source.sites
            }
        }
    }
}

/**
 * Decides as Helm does whether a dependency renders, from the values that all layers merge to.
 * The first `condition` path that holds a boolean decides.
 * Without one, a dependency renders when one of its tags is true or none of them is false.
 */
function isEnabled(dependency: Dependency, values: unknown): boolean {
    for (const condition of dependency.conditions) {
        const value = valueAt(values, condition.split("."))
        if (typeof value === "boolean") return value
    }
    const tags = dependency.tags.map((tag) => valueAt(values, ["tags", tag]))
    return tags.includes(true) || !tags.includes(false)
}

export const VALUES_READ = /\$?\.Values((?:\.[A-Za-z_][\w]*)+)/g

/** Collects the `.Values` paths that the templates of a chart and its dependencies read. */
function templateReads(chart: LoadedChart): Set<string> {
    const paths = new Set<string>()
    const scan = (dir: string, prefix: string[]) => {
        for (const file of templateFiles(join(dir, "templates"))) {
            const text = readFileSync(file, "utf8")
            for (const match of text.matchAll(VALUES_READ)) {
                const path = match[1]!.slice(1).split(".")
                paths.add(pathKey([...prefix, ...path]))
                if (path[0] === "global") paths.add(pathKey(path))
            }
        }
    }
    scan(chart.dir, [])
    for (const dependency of chart.dependencies) scan(dependency.dir, [dependency.key])
    return paths
}

function templateFiles(dir: string): string[] {
    if (!existsSync(dir)) return []
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) return templateFiles(path)
        return /\.(ya?ml|tpl|txt|json)$/.test(name) ? [path] : []
    })
}

/**
 * True if neither the chart defaults nor any template knows `path`, which points at a misspelled or outdated key.
 * A key under a default that holds an empty map or a scalar counts as known, since such a default takes keys of any name.
 * A read of the path or a key inside it counts as known.
 * A read of an ancestor that no template reads deeper counts as known too.
 * Such a template hands the whole map on, as `{{- with .Values.probe }}{{ toYaml . }}` does.
 */
export function isUnknownKey(release: Release, path: ValuePath): boolean {
    const { trace, firstUserLayer, readPaths } = release
    for (let length = path.length - 1; length > 0; length--) {
        const ancestor = pathKey(path.slice(0, length))
        if (readPaths.has(ancestor) && !readsBelow(readPaths, ancestor)) return false
    }
    const defaults = trace.layers.slice(0, firstUserLayer)
    const defaultAt = (prefix: ValuePath) => {
        for (const layer of defaults) {
            const value = valueAt(layer.data, prefix)
            if (value !== undefined) return value
        }
        return undefined
    }
    if (defaultAt(path) !== undefined) return false
    const key = pathKey(path)
    if (readPaths.has(key) || readsBelow(readPaths, key)) return false
    for (let length = path.length - 1; length >= 0; length--) {
        const ancestor =
            length === 0
                ? defaults.map((layer) => layer.data).find(isPlainMap)
                : defaultAt(path.slice(0, length))
        if (ancestor === undefined) continue
        return isPlainMap(ancestor) && Object.keys(ancestor).length > 0
    }
    return false
}

function readsBelow(readPaths: Set<string>, key: string): boolean {
    const prefix = key + "\u0000"
    for (const read of readPaths) if (read.startsWith(prefix)) return true
    return false
}

/** The user-set leaf paths that `isUnknownKey` flags, highest-level key first. */
export function unknownKeys(release: Release): ValuePath[] {
    const flagged: ValuePath[] = []
    for (const [key, settings] of release.trace.settings) {
        if (!settings.some((setting) => setting.layerIndex >= release.firstUserLayer)) continue
        const path = splitPathKey(key)
        if (flagged.some((parent) => parent.every((segment, index) => path[index] === segment)))
            continue
        if (isUnknownKey(release, path)) flagged.push(path)
    }
    return flagged
}
