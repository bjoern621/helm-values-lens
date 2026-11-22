import { isMap, isScalar, type Node, type Pair, parseDocument, type YAMLMap } from "yaml"
import { isPlainMap, valueAt } from "./coalesce"
import { isUnknownKey, type Release } from "./release"
import { pathKey, splitPathKey, type ValuePath } from "./yamlPaths"

/** Replaces the text between two offsets of a document. */
export interface TextEdit {
    start: number
    end: number
    text: string
}

/**
 * Whether removing the setting of `path` from the layer at `layerIndex` leaves the final values unchanged.
 * That holds for a scalar equal to the chart default that no user layer below sets as well.
 */
export function removableAsDefault(release: Release, layerIndex: number, path: ValuePath): boolean {
    if (layerIndex < release.firstUserLayer) return false
    const settings = release.trace.settings.get(pathKey(path)) ?? []
    const own = settings.find((setting) => setting.layerIndex === layerIndex)
    if (own === undefined || own.status !== "wins" || isPlainMap(own.value)) return false
    const userBelow = settings.some(
        (setting) => setting.layerIndex >= release.firstUserLayer && setting.layerIndex < layerIndex
    )
    if (userBelow) return false
    const fallback = chartDefault(release, path)
    return fallback !== undefined && JSON.stringify(fallback) === JSON.stringify(own.value)
}

function chartDefault(release: Release, path: ValuePath): unknown {
    for (const layer of release.trace.layers.slice(0, release.firstUserLayer)) {
        const value = valueAt(layer.data, path)
        if (value !== undefined) return value
    }
    return undefined
}

/**
 * The keys next to an unknown key that the chart defaults or reads, closest spelling first.
 * Only keys a typo away qualify: a different case, or a few letters changed.
 */
export function similarKeys(release: Release, path: ValuePath): string[] {
    if (!isUnknownKey(release, path)) return []
    const parent = path.slice(0, -1)
    const name = path.at(-1)!
    const known = new Set<string>()
    for (const layer of release.trace.layers.slice(0, release.firstUserLayer)) {
        const map = parent.length === 0 ? layer.data : valueAt(layer.data, parent)
        if (isPlainMap(map)) for (const key of Object.keys(map)) known.add(key)
    }
    const parentKey = pathKey(parent)
    for (const read of release.readPaths) {
        const segments = splitPathKey(read)
        if (segments.length !== parent.length + 1) continue
        if (pathKey(segments.slice(0, -1)) === parentKey) known.add(segments.at(-1)!)
    }
    known.delete(name)
    const allowed = Math.max(1, Math.floor(name.length / 4))
    return [...known]
        .map((key) => ({ key, distance: distance(name.toLowerCase(), key.toLowerCase()) }))
        .filter(({ distance }) => distance <= allowed)
        .sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key))
        .map(({ key }) => key)
}

/** The edit distance between two strings, a swap of two neighbouring letters counting as one edit. */
function distance(a: string, b: string): number {
    const rows = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    )
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            let best = Math.min(
                rows[i - 1]![j]! + 1,
                rows[i]![j - 1]! + 1,
                rows[i - 1]![j - 1]! + cost
            )
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
                best = Math.min(best, rows[i - 2]![j - 2]! + 1)
            rows[i]![j] = best
        }
    }
    return rows[a.length]![b.length]!
}

/**
 * The edits that delete the lines setting `paths` from a values text.
 * A map left empty goes as well, since `key:` without a value reads as null and deletes the defaults below.
 * Undefined where a path sits in a flow map, such as `{a: 1}`, or nowhere in the text.
 */
export function removeKeysEdits(text: string, paths: readonly ValuePath[]): TextEdit[] | undefined {
    const document = parseDocument(text)
    if (!isMap(document.contents)) return undefined
    const wanted = new Set(paths.map(pathKey))
    const found = new Set<string>()
    /** The pairs to delete from `map`, and whether they leave it empty. */
    const plan = (map: YAMLMap, path: string[]): { pairs: Pair[]; all: boolean } => {
        const pairs: Pair[] = []
        let all = map.items.length > 0
        for (const pair of map.items) {
            if (!isScalar(pair.key)) {
                all = false
                continue
            }
            const childPath = [...path, String(pair.key.value)]
            const key = pathKey(childPath)
            const value = pair.value as Node | null
            if (wanted.has(key)) {
                found.add(key)
                pairs.push(pair)
                continue
            }
            if (isMap(value) && !value.flow) {
                const child = plan(value, childPath)
                if (child.all) {
                    pairs.push(pair)
                    continue
                }
                pairs.push(...child.pairs)
            }
            all = false
        }
        return { pairs, all }
    }
    const removed = plan(document.contents, []).pairs
    if (found.size !== wanted.size) return undefined
    const edits: TextEdit[] = []
    for (const pair of removed) {
        const span = pairLines(text, pair)
        if (span === undefined) return undefined
        edits.push({ ...span, text: "" })
    }
    return edits.sort((a, b) => a.start - b.start)
}

/** The lines that a block-style pair spans, from the start of its key line to the end of its value. */
function pairLines(text: string, pair: Pair): { start: number; end: number } | undefined {
    if (!isScalar(pair.key) || !pair.key.range) return undefined
    const keyStart = pair.key.range[0]
    const start = text.lastIndexOf("\n", keyStart - 1) + 1
    if (text.slice(start, keyStart).trim() !== "") return undefined
    const value = pair.value as Node | null
    if (isMap(value) && value.flow) return undefined
    let end = value?.range?.[1] ?? pair.key.range[1]
    if (end === 0 || text[end - 1] !== "\n") {
        const newline = text.indexOf("\n", end)
        end = newline === -1 ? text.length : newline + 1
    }
    return { start, end }
}

/** The edit that renames the key at `path`, quoting a name that YAML would read otherwise. */
export function renameKeyEdit(text: string, path: ValuePath, name: string): TextEdit | undefined {
    const document = parseDocument(text)
    let node: unknown = document.contents
    let pair: Pair | undefined
    for (const segment of path) {
        if (!isMap(node)) return undefined
        pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === segment)
        if (pair === undefined) return undefined
        node = pair.value
    }
    if (pair === undefined || !isScalar(pair.key) || !pair.key.range) return undefined
    const plain = /^[A-Za-z_][\w.-]*$/.test(name)
    return {
        start: pair.key.range[0],
        end: pair.key.range[1],
        text: plain ? name : JSON.stringify(name)
    }
}
