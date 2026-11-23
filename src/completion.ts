import { stringify } from "yaml"
import { isPlainMap } from "./coalesce"
import { preview, releaseTitle } from "./hints"
import { schemaMarkdown } from "./markdown"
import { valuesRegion } from "./quickFixes"
import { type KnownKey, knownKeys, type Release } from "./release"
import { schemaField } from "./schema"
import { dottedPath, type Position, type ValuePath } from "./yamlPaths"

/** What a completed key takes after its colon: a nested map, a list or a scalar on the same line. */
export type ValueShape = "map" | "list" | "scalar"

/** One suggestion for a key or a value at the cursor of a values text. */
export interface Completion {
    kind: "key" | "value"
    label: string
    /** The YAML text that the suggestion inserts, quoted where the plain label would read as another type. */
    text: string
    /** The key that the suggestion completes, or that the value goes under. */
    path: ValuePath
    shape: ValueShape
    /** A short line beside the label, such as the default of the key. */
    detail: string | undefined
    /** Markdown with theme icons, from the chart that knows the key. */
    documentation: string
    /** Where the text that the suggestion replaces starts on the cursor's line. */
    replaceFrom: number
    /** The indent of the cursor's line in the document, for the lines that a map or a list adds. */
    indent: string
}

/** Where the cursor sits in a values text: in a key of the map at `parent`, or in the value of `parent`. */
interface CursorContext {
    kind: "key" | "value"
    path: ValuePath
    /** The keys already set beside the cursor's key. */
    siblings: Set<string>
    /** The column in the region text where the typed key or value starts. */
    start: number
    /** The indent of the cursor's key in the region text. */
    indent: number
}

/**
 * Suggests the keys that the chart defaults, reads or describes in a schema, and the values that a schema or a default names.
 * Each release whose layers come from `fsPath` adds its own keys. A key known to several releases appears once.
 */
export function completionsAt(
    documentText: string,
    fsPath: string,
    position: Position,
    releases: readonly Release[]
): Completion[] {
    const found = new Map<string, Completion & { titles: string[] }>()
    const contributing = new Set<string>()
    for (const release of releases)
        for (const layer of release.trace.layers.slice(release.firstUserLayer)) {
            if (layer.fsPath !== fsPath) continue
            const region = valuesRegion(documentText, layer)
            if (region === undefined) continue
            const context = cursorContext(documentText, region.text, region.offset, position)
            if (context === undefined) continue
            contributing.add(release.spec.id)
            const replaceFrom = context.start + region.offset.columnDelta
            for (const completion of releaseCompletions(release, context)) {
                const id = `${completion.kind}\u0000${completion.label}`
                const known = found.get(id)
                if (known !== undefined) {
                    known.titles.push(releaseTitle(release.spec))
                    continue
                }
                found.set(id, {
                    ...completion,
                    replaceFrom,
                    indent: " ".repeat(region.offset.columnDelta + context.indent),
                    titles: [releaseTitle(release.spec)]
                })
            }
            break
        }
    return [...found.values()].map(({ titles, ...completion }) => ({
        ...completion,
        documentation:
            completion.documentation +
            (contributing.size > 1 ? `\n\n$(layers) ${titles.join(", ")}` : "")
    }))
}

function releaseCompletions(release: Release, context: CursorContext): ReleaseCompletion[] {
    if (context.kind === "key")
        return [...knownKeys(release, context.path).values()]
            .filter((key) => !context.siblings.has(key.name))
            .map((key) => keyCompletion(release, context.path, key))
    const parent = context.path.slice(0, -1)
    const name = context.path.at(-1)!
    const key = knownKeys(release, parent).get(name) ?? {
        name,
        default: undefined,
        read: false,
        schema: schemaField(release.chart.schemas, context.path)
    }
    return valueCompletions(release, parent, key)
}

type ReleaseCompletion = Omit<Completion, "replaceFrom" | "indent">

function keyCompletion(release: Release, parent: ValuePath, key: KnownKey): ReleaseCompletion {
    const type = key.schema?.type
    const shape: ValueShape =
        isPlainMap(key.default) || type === "object"
            ? "map"
            : Array.isArray(key.default) || type === "array"
              ? "list"
              : "scalar"
    return {
        kind: "key",
        label: key.name,
        text: /^[\w.\/-]+$/.test(key.name) ? key.name : JSON.stringify(key.name),
        path: [...parent, key.name],
        shape,
        detail: key.default === undefined ? type : preview(key.default, 40),
        documentation: keyMarkdown(release, parent, key)
    }
}

/** The values that the schema of the key allows, `true` and `false` for a boolean, and the chart default. */
function valueCompletions(release: Release, parent: ValuePath, key: KnownKey): ReleaseCompletion[] {
    const values: { value: unknown; detail: string }[] = []
    for (const value of key.schema?.enum ?? [])
        values.push({ value, detail: "allowed by the schema" })
    if (key.schema?.type === "boolean" || typeof key.default === "boolean")
        for (const value of [true, false]) values.push({ value, detail: "boolean" })
    const fallback = key.default
    if (fallback !== undefined && fallback !== null && typeof fallback !== "object")
        values.push({ value: fallback, detail: "chart default" })
    const documentation = keyMarkdown(release, parent, key)
    const seen = new Set<string>()
    return values.flatMap(({ value, detail }) => {
        const label = typeof value === "string" ? value : JSON.stringify(value)
        if (seen.has(label)) return []
        seen.add(label)
        const text = stringify(value, { lineWidth: 0 }).trimEnd()
        const path = [...parent, key.name]
        return [{ kind: "value", label, text, path, shape: "scalar", detail, documentation }]
    })
}

/** Describes a key in the documentation beside a suggestion: its schema, its default and whether a template reads it. */
function keyMarkdown(release: Release, parent: ValuePath, key: KnownKey): string {
    const lines = [`**${release.chart.name}** \`${dottedPath([...parent, key.name])}\``]
    if (key.schema !== undefined) lines.push(...schemaMarkdown(key.schema))
    if (key.default !== undefined) lines.push(`$(package) Default: \`${preview(key.default, 80)}\``)
    if (key.read) lines.push("$(file-code) Read by a template")
    return lines.join("\n\n")
}

const KEY_TYPED = /^(\s*)([\w.\/-]*)$/
const VALUE_TYPED = /^(\s*)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#:'"][^:#]*?):[ \t]+([^\s#]*)$/
const MAP_KEY = /^(\s*)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#:'"-][^:#]*?):\s*(?:#.*)?$/

/**
 * Reads the key path of the cursor from the indents above it.
 * The cursor may sit on a blank line after the region, where a user starts a new key.
 * Undefined inside a list, a block scalar or a flow collection, where no key completes.
 */
function cursorContext(
    documentText: string,
    regionText: string,
    offset: { lineDelta: number; columnDelta: number },
    position: Position
): CursorContext | undefined {
    const lines = regionText.split("\n")
    const line = position.line - offset.lineDelta
    const documentLine = lineAt(documentText, position.line)
    if (line < 0 || documentLine.length < offset.columnDelta) return undefined
    if (documentLine.slice(0, offset.columnDelta).trim() !== "") return undefined
    if (line >= lines.length - 1) {
        const between = documentText
            .split("\n")
            .slice(offset.lineDelta + lines.length - 1, position.line)
        if (between.some((text) => text.trim() !== "")) return undefined
    }
    const before = documentLine.slice(offset.columnDelta, position.column)
    const key = KEY_TYPED.exec(before)
    const value = key === null ? VALUE_TYPED.exec(before) : null
    if (key === null && value === null) return undefined
    const indent = (key ?? value)![1]!.length
    const parent = ancestors(lines.slice(0, Math.min(line, lines.length)), indent)
    if (parent === undefined) return undefined
    if (value !== null)
        return {
            kind: "value",
            path: [...parent, unquoted(value[2]!)],
            siblings: new Set(),
            start: before.length - value[3]!.length,
            indent
        }
    return {
        kind: "key",
        path: parent,
        siblings: siblings(lines, line, indent),
        start: indent,
        indent
    }
}

/** The keys of the maps that hold a line of the given indent, outermost first. */
function ancestors(above: readonly string[], indent: number): ValuePath | undefined {
    const path: string[] = []
    let inner = indent
    for (let index = above.length - 1; index >= 0 && inner > 0; index--) {
        const text = above[index]!
        if (text.trim() === "" || text.trimStart().startsWith("#")) continue
        const own = indentOf(text)
        if (own >= inner) continue
        const key = MAP_KEY.exec(text)
        if (key === null) return undefined
        path.unshift(unquoted(key[2]!))
        inner = own
    }
    return inner === 0 || path.length === 0 ? path : undefined
}

/** The keys at the same indent as the cursor's line within the map that holds it. */
function siblings(lines: readonly string[], line: number, indent: number): Set<string> {
    const keys = new Set<string>()
    const collect = (step: number) => {
        for (let index = line + step; index >= 0 && index < lines.length; index += step) {
            const text = lines[index]!
            if (text.trim() === "" || text.trimStart().startsWith("#")) continue
            const own = indentOf(text)
            if (own < indent) return
            const key =
                own === indent
                    ? /^\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#:'"-][^:#]*?):/.exec(text)
                    : null
            if (key !== null) keys.add(unquoted(key[1]!))
        }
    }
    collect(-1)
    collect(1)
    return keys
}

function unquoted(key: string): string {
    if (key.startsWith('"')) return JSON.parse(key) as string
    if (key.startsWith("'")) return key.slice(1, -1).replaceAll("''", "'")
    return key
}

function indentOf(text: string): number {
    return text.length - text.trimStart().length
}

function lineAt(documentText: string, line: number): string {
    return documentText.split("\n")[line] ?? ""
}
