import { isMap, isScalar, LineCounter, parseDocument, type Node } from "yaml"

/** A key path through nested maps, such as `["general", "email", "smtpHost"]`. */
export type ValuePath = readonly string[]

/** A zero-based line and column. */
export interface Position {
    line: number
    column: number
}

/** Where a values text sets one key: the key itself and the end of its value. */
export interface KeySite {
    key: Position
    /** Undefined for a map or a list, whose value spans the lines below the key. */
    valueEnd: Position | undefined
}

export interface ParsedValues {
    /** The values as plain data. Undefined for an empty text. */
    data: unknown
    /** The site of every key in every map, by `pathKey`. */
    sites: Map<string, KeySite>
    errors: string[]
}

/** Joins a path to one map key. Segments may hold dots, so they get joined with a character that YAML keys rarely hold. */
export function pathKey(path: ValuePath): string {
    return path.join("\u0000")
}

export function splitPathKey(key: string): string[] {
    return key === "" ? [] : key.split("\u0000")
}

/** Writes a path the way a template reads it: `general.email.smtpHost`. */
export function dottedPath(path: ValuePath): string {
    return path
        .map((segment) => (/^[A-Za-z_][\w]*$/.test(segment) ? segment : `"${segment}"`))
        .join(".")
}

/** Parses a values text and records where each key sits. */
export function parseValues(text: string): ParsedValues {
    const lineCounter = new LineCounter()
    const document = parseDocument(text, { lineCounter, keepSourceTokens: false })
    const sites = new Map<string, KeySite>()
    const at = (offset: number): Position => {
        const { line, col } = lineCounter.linePos(offset)
        return { line: line - 1, column: col - 1 }
    }
    collectSites(document.contents, [], sites, at)
    return {
        data: document.toJS({ maxAliasCount: -1 }) ?? undefined,
        sites,
        errors: document.errors.map((error) => error.message)
    }
}

/** Records the site of every key inside `node` under `path`. */
export function collectSites(
    node: Node | null,
    path: string[],
    sites: Map<string, KeySite>,
    at: (offset: number) => Position
): void {
    if (!isMap(node)) return
    for (const pair of node.items) {
        if (!isScalar(pair.key) || pair.key.range === undefined || pair.key.range === null) continue
        const childPath = [...path, String(pair.key.value)]
        const value = pair.value as Node | null
        const scalarEnd = isScalar(value) ? value.range?.[1] : undefined
        sites.set(pathKey(childPath), {
            key: at(pair.key.range[0]),
            valueEnd: scalarEnd === undefined ? undefined : at(scalarEnd)
        })
        if (isMap(value)) collectSites(value, childPath, sites, at)
    }
}

/** Maps a position inside a block scalar back to the file that holds the block. */
export interface Offset {
    lineDelta: number
    columnDelta: number
}

export function shifted(position: Position, offset: Offset): Position {
    return { line: position.line + offset.lineDelta, column: position.column + offset.columnDelta }
}
