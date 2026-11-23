import { isMap, isScalar, type Node, type Pair, parseDocument, stringify, type YAMLMap } from "yaml"
import { coalesce, isPlainMap, type Layer, sameValue, settingOf, valueAt } from "./coalesce"
import { type SettingSite, settingSites, siteEnd } from "./hints"
import { chartDefault, isUnknownKey, knownKeys, type Release } from "./release"
import { type Offset, pathKey, type Position, splitPathKey, type ValuePath } from "./yamlPaths"

/** Replaces the text between two offsets of a document. */
export interface TextEdit {
    start: number
    end: number
    text: string
}

/** The settings of one key of a file, one for each release and layer that reads it there. */
export interface KeyGroup {
    path: ValuePath
    key: Position
    end: Position
    sites: SettingSite[]
}

/** Groups the keys that `releases` set in the file at `fsPath` by their place in the file. */
export function keyGroups(fsPath: string, releases: readonly Release[]): KeyGroup[] {
    const groups = new Map<string, KeyGroup>()
    for (const site of settingSites(fsPath, releases)) {
        const place = `${site.key.line}:${site.key.column}`
        const group = groups.get(place)
        if (group === undefined)
            groups.set(place, { path: site.path, key: site.key, end: siteEnd(site), sites: [site] })
        else group.sites.push(site)
    }
    return [...groups.values()]
}

/** Whether removing the key leaves the final values of every release that reads it unchanged. */
export function removableGroup(group: KeyGroup): boolean {
    return group.sites.every((site) => removableAsDefault(site.release, site.layerIndex, site.path))
}

/** The user settings of one key, split by whether the chart of their release reads the key. */
export interface KeyUse {
    group: KeyGroup
    readers: SettingSite[]
    ignorers: SettingSite[]
}

/**
 * The keys of a file that the chart of at least one release reading the file ignores.
 * A file such as a shared `globals.yaml` feeds the releases of several charts, which read different parts of it.
 * A map comes back once for the keys below it that the same releases read and ignore.
 */
export function ignoredKeys(groups: readonly KeyGroup[]): KeyUse[] {
    const ordered = [...groups].sort(
        (a, b) => a.key.line - b.key.line || a.key.column - b.key.column
    )
    const ignored: KeyUse[] = []
    ordered.forEach((group, index) => {
        const use = keyUse(group)
        if (use.ignorers.length === 0) return
        const parentKey = pathKey(group.path.slice(0, -1))
        const parent = ordered
            .slice(0, index)
            .filter(
                (other: KeyGroup) =>
                    other.path.length === group.path.length - 1 && pathKey(other.path) === parentKey
            )
            .at(-1)
        if (parent !== undefined && sameUse(keyUse(parent), use)) return
        ignored.push(use)
    })
    return ignored
}

function keyUse(group: KeyGroup): KeyUse {
    const user = group.sites.filter((site) => site.layerIndex >= site.release.firstUserLayer)
    return {
        group,
        readers: user.filter((site) => !isUnknownKey(site.release, site.path)),
        ignorers: user.filter((site) => isUnknownKey(site.release, site.path))
    }
}

function sameUse(a: KeyUse, b: KeyUse): boolean {
    const ids = (sites: SettingSite[]) =>
        [...new Set(sites.map((site) => site.release.spec.id))].sort().join("\0")
    return ids(a.readers) === ids(b.readers) && ids(a.ignorers) === ids(b.ignorers)
}

/**
 * The values files that can take a key from its file, for a key that the charts of some releases read and others ignore.
 * Every release reading such a file reads the key. The move takes the key away from the releases that ignore it.
 * The final values of every release stay the same.
 */
export function moveTargets(use: KeyUse, releases: readonly Release[]): string[] {
    const { readers, ignorers } = use
    if (readers.length === 0 || ignorers.length === 0) return []
    const readerIds = new Set(readers.map((site) => site.release.spec.id))
    if (readerIds.size !== readers.length) return []
    const source = groupLayer(use.group).fsPath
    const filesOf = (release: Release) =>
        new Set(
            release.trace.layers.flatMap((layer) =>
                layer.kind === "file" && layer.fsPath !== undefined ? [layer.fsPath] : []
            )
        )
    let shared = filesOf(readers[0]!.release)
    for (const { release } of readers.slice(1)) {
        const files = filesOf(release)
        shared = new Set([...shared].filter((file) => files.has(file)))
    }
    shared.delete(source!)
    return [...shared]
        .filter((file) =>
            releases.every(
                (release) => !filesOf(release).has(file) || readerIds.has(release.spec.id)
            )
        )
        .filter((file) => readers.every((site) => movesUnchanged(site, file)))
        .sort()
}

/** Whether the final values of the release stay the same once its setting at `site` moves to the file at `target`. */
function movesUnchanged(site: SettingSite, target: string): boolean {
    const { release, layerIndex, path } = site
    const layers = release.trace.layers
    const targets = layers.flatMap((layer, index) =>
        layer.kind === "file" && layer.fsPath === target ? [index] : []
    )
    if (targets.length !== 1 || valueAt(layers[targets[0]!]!.data, path) !== undefined) return false
    const value = valueAt(layers[layerIndex]!.data, path)
    const moved = layers.map((layer, index) => {
        if (index === layerIndex) return { ...layer, data: withoutPath(layer.data, path) }
        if (index === targets[0]) return { ...layer, data: withPath(layer.data, path, value) }
        return layer
    })
    return sameValue(coalesce(moved).final, release.trace.final)
}

/** A copy of the values without the key at `path`, dropping each map that the removal leaves empty, as `removeKeysEdits` does. */
function withoutPath(data: unknown, path: ValuePath): unknown {
    if (!isPlainMap(data) || path.length === 0) return data
    const [head, ...rest] = path
    if (!(head! in data)) return data
    const copy = { ...data }
    if (rest.length === 0) delete copy[head!]
    else {
        const child = withoutPath(copy[head!], rest)
        if (isPlainMap(child) && Object.keys(child).length === 0) delete copy[head!]
        else copy[head!] = child
    }
    return copy
}

function withPath(data: unknown, path: ValuePath, value: unknown): unknown {
    if (path.length === 0) return value
    const map = isPlainMap(data) ? data : {}
    const [head, ...rest] = path
    return { ...map, [head!]: withPath(map[head!], rest, value) }
}

/** The layer that holds the key. Every site of a group sits in the same text. */
export function groupLayer(group: KeyGroup): Layer {
    const site = group.sites[0]!
    return site.release.trace.layers[site.layerIndex]!
}

/**
 * Whether removing the setting of `path` from the layer at `layerIndex` leaves the final values unchanged.
 * That holds for a scalar equal to the chart default that no user layer below sets as well.
 */
export function removableAsDefault(release: Release, layerIndex: number, path: ValuePath): boolean {
    if (layerIndex < release.firstUserLayer) return false
    const own = settingOf(release.trace, layerIndex, path)
    if (own === undefined || own.status !== "wins" || isPlainMap(own.value)) return false
    const userBelow = (release.trace.settings.get(pathKey(path)) ?? []).some(
        (setting) => setting.layerIndex >= release.firstUserLayer && setting.layerIndex < layerIndex
    )
    if (userBelow) return false
    const fallback = chartDefault(release, path)
    return fallback !== undefined && sameValue(fallback, own.value)
}

/** A values text inside a document, with the shift from a position in the text to its place in the document. */
export interface ValuesRegion {
    text: string
    offset: Offset
}

/**
 * Finds the text of a layer in the document that holds it: a whole values file, or the block under `helm.values` or `helm.valuesObject`.
 * Undefined for a layer that no fix can edit, such as parameters, a quoted string or a flow map.
 */
export function valuesRegion(documentText: string, layer: Layer): ValuesRegion | undefined {
    switch (layer.kind) {
        case "file":
            return { text: documentText, offset: { lineDelta: 0, columnDelta: 0 } }
        case "inline":
            return layer.offset === undefined ? undefined : blockRegion(documentText, layer.offset)
        case "object":
            return objectRegion(documentText, layer)
        default:
            return undefined
    }
}

/** The region of a map in the document, found from the place of its top-level keys. */
function objectRegion(documentText: string, layer: Layer): ValuesRegion | undefined {
    const keys = [...layer.sites]
        .filter(([key]) => splitPathKey(key).length === 1)
        .map(([, site]) => site.key)
    if (keys.length === 0) return undefined
    const column = keys[0]!.column
    const lines = documentText.split("\n")
    const block = keys.every(
        (key) => key.column === column && lines[key.line]?.slice(0, column).trim() === ""
    )
    if (!block) return undefined
    const lineDelta = Math.min(...keys.map((key) => key.line))
    return blockRegion(documentText, { lineDelta, columnDelta: column })
}

/** The lines from `offset.lineDelta` on that sit indented by `offset.columnDelta` or more, with the indent cut. */
function blockRegion(documentText: string, offset: Offset): ValuesRegion {
    const lines = documentText.split("\n")
    const block: string[] = []
    for (let line = offset.lineDelta; line < lines.length; line++) {
        const text = lines[line]!
        if (text.trim() !== "" && text.length - text.trimStart().length < offset.columnDelta) break
        block.push(text.slice(offset.columnDelta))
    }
    while (block.length > 0 && block.at(-1)!.trim() === "") block.pop()
    return { text: block.map((line) => line + "\n").join(""), offset }
}

/**
 * Moves edits of the text of a region to the document that holds it.
 * A deletion of whole lines takes their indent along.
 */
export function documentEdits(
    documentText: string,
    region: ValuesRegion,
    edits: readonly TextEdit[]
): TextEdit[] {
    const { lineDelta, columnDelta } = region.offset
    if (lineDelta === 0 && columnDelta === 0) return [...edits]
    const regionStarts = lineStarts(region.text)
    const documentStarts = lineStarts(documentText)
    const lineStart = (line: number) => documentStarts[line] ?? documentText.length
    const place = (offset: number, wholeLine: boolean) => {
        let line = regionStarts.length - 1
        while (regionStarts[line]! > offset) line--
        const start = lineStart(line + lineDelta)
        return wholeLine ? start : start + columnDelta + offset - regionStarts[line]!
    }
    const atLineStart = (offset: number) => offset === 0 || region.text[offset - 1] === "\n"
    return edits.map((edit) => {
        const wholeLines = edit.text === "" && atLineStart(edit.start) && atLineStart(edit.end)
        return {
            start: place(edit.start, wholeLines),
            end: place(edit.end, wholeLines),
            text: edit.text
        }
    })
}

function lineStarts(text: string): number[] {
    const starts = [0]
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1))
        starts.push(index + 1)
    return starts
}

/**
 * The keys next to an unknown key that the chart defaults or reads, closest spelling first.
 * Only keys a typo away qualify: a different case, or a few letters changed.
 */
export function similarKeys(release: Release, path: ValuePath): string[] {
    if (!isUnknownKey(release, path)) return []
    const name = path.at(-1)!
    const known = new Set(knownKeys(release, path.slice(0, -1)).keys())
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

/**
 * The edit that adds `value` at `path` to a values text, below the deepest map of the path that the text holds.
 * The new lines take the indentation of the map's keys.
 * Undefined where the text sets the path or puts something other than a block map at one of its parents.
 */
export function insertKeyEdit(text: string, path: ValuePath, value: unknown): TextEdit | undefined {
    const document = parseDocument(text)
    let map: unknown = document.contents
    if (map !== null && !isMap(map)) return undefined
    let depth = 0
    while (isMap(map) && depth < path.length) {
        const pair = map.items.find(
            (item) => isScalar(item.key) && String(item.key.value) === path[depth]
        )
        if (pair === undefined) break
        if (!isMap(pair.value)) return undefined
        map = pair.value
        depth++
    }
    if (depth === path.length) return undefined
    const nested = path.slice(depth).reduceRight<unknown>((inner, key) => ({ [key]: inner }), value)
    const last = isMap(map) ? map.items.at(-1) : undefined
    if (isMap(map) && map.flow) return undefined
    let at = text.length
    let indent = 0
    if (last !== undefined) {
        const span = pairLines(text, last)
        if (span === undefined || !isScalar(last.key) || !last.key.range) return undefined
        at = span.end
        indent = last.key.range[0] - (text.lastIndexOf("\n", last.key.range[0] - 1) + 1)
    }
    const unit = depth > 0 ? Math.max(1, Math.round(indent / depth)) : indentUnit(text)
    const lines = stringify(nested, { indent: unit })
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => " ".repeat(indent) + line)
    const newline = at > 0 && text[at - 1] !== "\n" ? "\n" : ""
    return { start: at, end: at, text: `${newline}${lines.join("\n")}\n` }
}

/** The smallest indentation of a line in the text, the step that its nested maps take. */
function indentUnit(text: string): number {
    const indents = text
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
        .map((line) => line.length - line.trimStart().length)
        .filter((width) => width > 0)
    return indents.length === 0 ? 2 : Math.min(...indents)
}
