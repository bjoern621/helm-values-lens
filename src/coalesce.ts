import { type KeySite, type Offset, pathKey, splitPathKey, type ValuePath } from "./yamlPaths"

export type LayerKind = "chart" | "subchart" | "file" | "inline" | "object" | "parameters"

/** One source of values, in the order that Helm applies them. */
export interface Layer {
    kind: LayerKind
    /** What the editor shows for the layer, such as `values.yaml` or `helm.values`. */
    label: string
    /** The file that holds the layer. Undefined for parameters built from no file. */
    fsPath: string | undefined
    /** Moves a site of an inline layer to its place in `fsPath`. */
    offset: Offset | undefined
    data: unknown
    sites: Map<string, KeySite>
}

export type SettingStatus = "wins" | "overridden" | "replaced" | "deleted"

/** What one layer sets at one path. */
export interface Setting {
    layerIndex: number
    value: unknown
    status: SettingStatus
    /** The layer whose setting took this one's place. Undefined for a setting that wins. */
    byLayerIndex: number | undefined
}

export interface Trace {
    layers: readonly Layer[]
    final: Record<string, unknown>
    /** The settings of every path in layer order, by `pathKey`. A map counts as a setting of its own path. */
    settings: Map<string, Setting[]>
    /** Paths where a layer put a map in place of a scalar or the reverse, which Helm warns about. */
    typeChanges: string[]
}

/**
 * Merges the layers as Helm does and records which layer set each path.
 * A map merges into the map below it key by key.
 * A scalar or a list replaces whatever sat at its path, a whole map included.
 * A null deletes the key, the defaults below it included. A null in the chart defaults leaves the key unset.
 */
export function coalesce(layers: readonly Layer[]): Trace {
    const final: Record<string, unknown> = {}
    /** The layer that set each scalar, list or null now in `final`, by `pathKey`. */
    const origin = new Map<string, number>()
    const settings = new Map<string, Setting[]>()
    const typeChanges: string[] = []

    const apply = (
        layerIndex: number,
        target: Record<string, unknown>,
        data: unknown,
        path: string[]
    ) => {
        if (!isPlainMap(data)) return
        for (const [key, value] of Object.entries(data)) {
            const childPath = [...path, key]
            const childKey = pathKey(childPath)
            record(settings, childKey, layerIndex, value)
            const before = target[key]
            if (isPlainMap(value)) {
                if (before !== undefined && before !== null && !isPlainMap(before)) {
                    typeChanges.push(childKey)
                    replaceSubtree(origin, childKey, undefined)
                }
                const child = isPlainMap(before) ? before : {}
                target[key] = child
                apply(layerIndex, child, value, childPath)
                continue
            }
            if (isPlainMap(before) && value !== null) typeChanges.push(childKey)
            replaceSubtree(origin, childKey, layerIndex)
            if (value === null) {
                delete target[key]
                continue
            }
            target[key] = value
        }
    }

    layers.forEach((layer, index) => apply(index, final, layer.data, []))
    settle(settings, origin, final)
    return { layers, final, settings, typeChanges }
}

function record(settings: Map<string, Setting[]>, key: string, layerIndex: number, value: unknown) {
    let list = settings.get(key)
    if (list === undefined) {
        list = []
        settings.set(key, list)
    }
    list.push({ layerIndex, value, status: "wins", byLayerIndex: undefined })
}

/** Drops the origins inside `key` and gives `key` itself the layer that sets it, if any. */
function replaceSubtree(origin: Map<string, number>, key: string, layerIndex: number | undefined) {
    const prefix = key + "\u0000"
    for (const known of origin.keys()) {
        if (known === key || known.startsWith(prefix)) origin.delete(known)
    }
    if (layerIndex !== undefined) origin.set(key, layerIndex)
}

/** Marks each setting with the layer that decides its path in the end. */
function settle(
    settings: Map<string, Setting[]>,
    origin: Map<string, number>,
    final: Record<string, unknown>
) {
    for (const [key, list] of settings) {
        const path = splitPathKey(key)
        const present = valueAt(final, path) !== undefined
        const finalIsMap = isPlainMap(valueAt(final, path))
        // A map that a later map replaced a scalar with has no origin. The last setting decides it.
        const decider = decidingLayer(origin, path) ?? list.at(-1)!.layerIndex
        for (const setting of list) {
            if (isPlainMap(setting.value) && finalIsMap) continue
            if (decider === setting.layerIndex) continue
            if (!present) setting.status = "deleted"
            else setting.status = origin.has(key) ? "overridden" : "replaced"
            setting.byLayerIndex = decider
        }
    }
}

/** The layer that set `path` itself or the nearest of its ancestors that holds a scalar, a list or a null. */
function decidingLayer(origin: Map<string, number>, path: ValuePath): number | undefined {
    for (let length = path.length; length > 0; length--) {
        const layer = origin.get(pathKey(path.slice(0, length)))
        if (layer !== undefined) return layer
    }
    return undefined
}

export function valueAt(data: unknown, path: ValuePath): unknown {
    let current = data
    for (const segment of path) {
        if (!isPlainMap(current)) return undefined
        current = current[segment]
    }
    return current
}

export function isPlainMap(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Whether two values hold the same data, as Helm would render them. */
export function sameValue(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
}

/** What the layer at `layerIndex` sets at `path`, or undefined where it leaves the path alone. */
export function settingOf(trace: Trace, layerIndex: number, path: ValuePath): Setting | undefined {
    return trace.settings.get(pathKey(path))?.find((setting) => setting.layerIndex === layerIndex)
}

/** The chain of one path, lowest layer first, with the value that the chart renders with. */
export interface Explanation {
    path: ValuePath
    final: unknown
    settings: Setting[]
}

export function explain(trace: Trace, path: ValuePath): Explanation {
    return {
        path,
        final: valueAt(trace.final, path),
        settings: trace.settings.get(pathKey(path)) ?? []
    }
}

/**
 * Builds the parameters layer from Argo CD `helm.parameters`, which reach Helm as `--set` and `--set-string`.
 * A name splits at each dot that no backslash escapes.
 * `--set` reads `true`, `false`, `null` and integers as such. `forceString` keeps the text.
 */
export function parametersData(
    parameters: readonly { name: string; value: string; forceString?: boolean }[]
): { data: Record<string, unknown>; unsupported: string[] } {
    const data: Record<string, unknown> = {}
    const unsupported: string[] = []
    for (const parameter of parameters) {
        if (/\[\d+\]/.test(parameter.name)) {
            unsupported.push(parameter.name)
            continue
        }
        const path = parameter.name
            .split(/(?<!\\)\./)
            .map((segment) => segment.replace(/\\\./g, "."))
        let target = data
        for (const segment of path.slice(0, -1)) {
            const next = target[segment]
            target = isPlainMap(next) ? next : (target[segment] = {})
        }
        target[path.at(-1)!] =
            parameter.forceString === true ? parameter.value : setValue(parameter.value)
    }
    return { data, unsupported }
}

function setValue(text: string): unknown {
    if (text === "true") return true
    if (text === "false") return false
    if (text === "null") return null
    if (/^-?(0|[1-9]\d*)$/.test(text)) return Number(text)
    return text
}
