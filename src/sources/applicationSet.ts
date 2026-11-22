import { readdirSync, readFileSync } from "node:fs"
import { join, posix } from "node:path"
import {
    isMap,
    isScalar,
    isSeq,
    LineCounter,
    parse,
    parseAllDocuments,
    type Node,
    type YAMLMap
} from "yaml"
import { type ReleaseSpec, readRelease, sourcesOf } from "../argo"
import type { Position } from "../yamlPaths"
import type { SourceContext, SourceReader, WorkspaceFile } from "./types"

/**
 * The parameters of one generated Application.
 * Under fasttemplate, a flat map of strings by dotted name (`path.basename`).
 * Under `goTemplate: true`, nested data (`{ path: { basename } }`).
 */
type Params = Record<string, unknown>

interface Mode {
    goTemplate: boolean
}

/** What the ApplicationSets of one file generate and why a generator or a set yields nothing. */
export interface ApplicationSetReading {
    releases: ReleaseSpec[]
    /** Log lines, one per generator or ApplicationSet that the reader leaves out. */
    skips: string[]
}

/** Thrown where a generator yields nothing that the reader could trust. */
class Skip extends Error {}

/** Thrown where a template expression holds something that the reader cannot evaluate. */
class Unevaluable extends Error {}

const OUTSIDE_GENERATORS = [
    "clusters",
    "scmProvider",
    "pullRequest",
    "plugin",
    "clusterDecisionResource"
]

/** Fields of a rendered template that decide the chart and the layers. An expression that fails elsewhere, such as in a label, changes no value. */
const DECISIVE_FIELDS = ["metadata.name", "spec.source", "spec.sources", "spec.destination"]

/** Reads the Applications that the ApplicationSets of a file generate. */
export const readApplicationSets: SourceReader = (file, context) =>
    readApplicationSetsWithSkips(file, context).releases

/**
 * Like `readApplicationSets`. Also returns why a generator or an ApplicationSet yields no release.
 * Generators that read state outside the workspace (`clusters`, `scmProvider`, ...) yield no release.
 * Each generated Application keeps the positions of the ApplicationSet's `template:` block.
 * An expression that the reader cannot evaluate in a decisive field gives a release with an unresolved chart that names it.
 */
export function readApplicationSetsWithSkips(
    file: WorkspaceFile,
    context: SourceContext
): ApplicationSetReading {
    const reading: ApplicationSetReading = { releases: [], skips: [] }
    const { fsPath, text } = file
    if (!text.includes("argoproj.io") || !/kind:\s*ApplicationSet\b/.test(text)) return reading
    const lineCounter = new LineCounter()
    const at = (offset: number): Position => {
        const { line, col } = lineCounter.linePos(offset)
        return { line: line - 1, column: col - 1 }
    }
    for (const document of parseAllDocuments(text, { lineCounter })) {
        if (!("contents" in document) || !isMap(document.contents)) continue
        const root = document.contents
        if (scalarAt(root, "kind") !== "ApplicationSet") continue
        if (!String(scalarAt(root, "apiVersion") ?? "").startsWith("argoproj.io/")) continue
        const setName = String(scalarAt(mapAt(root, "metadata"), "name") ?? "")
        const spec = mapAt(root, "spec")
        const template = mapAt(spec, "template")
        const nameNode = mapAt(template, "metadata")?.get("name", true) as Node | undefined
        if (spec === undefined || template === undefined || !isScalar(nameNode)) {
            reading.skips.push(`${fsPath}: ApplicationSet ${setName} has no template.metadata.name`)
            continue
        }
        if (spec.has("templatePatch")) {
            reading.skips.push(
                `${fsPath}: ApplicationSet ${setName} sets templatePatch, which the reader does not apply`
            )
            continue
        }
        const mode: Mode = { goTemplate: scalarAt(spec, "goTemplate") === true }
        const generators = spec.get("generators", true)
        const paramSets: Params[] = []
        for (const [index, generator] of (isSeq(generators) ? generators.items : []).entries()) {
            try {
                paramSets.push(...generate((generator as Node).toJSON(), mode, context))
            } catch (error) {
                if (!(error instanceof Skip)) throw error
                reading.skips.push(
                    `${fsPath}: ApplicationSet ${setName}, generator ${index}: ${error.message}`
                )
            }
        }
        const appLine = nameNode.range ? at(nameNode.range[0]).line : 0
        const ids = new Set<string>()
        for (const params of paramSets) {
            const release = generatedRelease(file, context, template, params, mode, appLine, at)
            if (release === undefined) continue
            if (ids.has(release.id)) {
                reading.skips.push(
                    `${fsPath}: ApplicationSet ${setName} generates ${release.name} twice, the reader keeps the first`
                )
                continue
            }
            ids.add(release.id)
            reading.releases.push(release)
        }
    }
    return reading
}

/** Renders the template with one parameter set and reads its Helm source. Undefined for an Application without one. */
function generatedRelease(
    file: WorkspaceFile,
    context: SourceContext,
    template: YAMLMap,
    params: Params,
    mode: Mode,
    appLine: number,
    at: (offset: number) => Position
): ReleaseSpec | undefined {
    const failures: string[] = []
    const rendered = template.clone() as YAMLMap
    renderNode(rendered, params, mode, [], failures)
    const metadata = mapAt(rendered, "metadata")
    const spec = mapAt(rendered, "spec")
    if (spec === undefined) return undefined
    const name = String(scalarAt(metadata, "name") ?? "")
    const sources = sourcesOf(spec)
    const helmSource = sources.find(
        (source) => mapAt(source, "helm") !== undefined || scalarAt(source, "chart") !== undefined
    )
    const id = `${file.fsPath}:${appLine}:${name}`
    const base = {
        id,
        name,
        origin: "Argo CD ApplicationSet",
        appFile: file.fsPath,
        appLine,
        namespace:
            (scalarAt(mapAt(spec, "destination"), "namespace") as string | undefined) ?? undefined
    }
    const decisive = failures.find((failure) =>
        DECISIVE_FIELDS.some((field) => failure.startsWith(`template.${field}`))
    )
    if (decisive !== undefined)
        return {
            ...base,
            releaseName: name,
            chart: { kind: "unresolved", reason: decisive },
            layers: []
        }
    if (helmSource === undefined) return undefined
    const release = readRelease(file.fsPath, file.text, helmSource, sources, context.checkoutOf, at)
    return {
        ...base,
        releaseName: release.releaseName ?? name,
        chart: release.chart,
        layers: release.layers
    }
}

/** Substitutes the parameters into every string scalar under `node`, in place. Keys and ranges stay. */
function renderNode(
    node: unknown,
    params: Params,
    mode: Mode,
    path: string[],
    failures: string[]
): void {
    if (isScalar(node)) {
        if (typeof node.value !== "string") return
        try {
            node.value = render(node.value, params, mode)
        } catch (error) {
            if (!(error instanceof Unevaluable)) throw error
            failures.push(
                `${["template", ...path].join(".")}: cannot evaluate ${JSON.stringify(node.value)} (${error.message})`
            )
        }
    } else if (isMap(node)) {
        for (const pair of node.items) {
            const key = isScalar(pair.key) ? String(pair.key.value) : ""
            renderNode(pair.value, params, mode, [...path, key], failures)
        }
    } else if (isSeq(node)) {
        node.items.forEach((item, index) =>
            renderNode(item, params, mode, [...path, String(index)], failures)
        )
    }
}

function render(text: string, params: Params, mode: Mode): string {
    return mode.goTemplate ? renderGoTemplate(text, params) : renderFasttemplate(text, params)
}

/** Replaces each `{{name}}` with its parameter. Argo CD leaves a tag without a parameter as written. */
function renderFasttemplate(text: string, params: Params): string {
    return text.replace(/\{\{([\s\S]*?)\}\}/g, (tag, inner: string) => {
        const name = inner.trim()
        return name !== "" && Object.hasOwn(params, name) ? String(params[name]) : tag
    })
}

/** Renders `data` with its strings substituted, for a generator that reads the parameters of another. */
function renderData(data: unknown, params: Params, mode: Mode): unknown {
    if (typeof data === "string") {
        try {
            return render(data, params, mode)
        } catch (error) {
            // The string may name a parameter of the generator itself, such as its own `{{.path.basename}}`.
            if (error instanceof Unevaluable) return data
            throw error
        }
    }
    if (Array.isArray(data)) return data.map((item) => renderData(item, params, mode))
    if (isObject(data))
        return Object.fromEntries(
            Object.entries(data).map(([key, value]) => [key, renderData(value, params, mode)])
        )
    return data
}

// Generators

function generate(generator: unknown, mode: Mode, context: SourceContext): Params[] {
    if (!isObject(generator)) throw new Skip("the generator holds no map")
    if (isObject(generator.selector))
        throw new Skip("the reader does not apply a generator selector")
    if (isObject(generator.template) && !isEmptyTemplate(generator.template))
        throw new Skip("the reader does not apply a template set on the generator")
    const kind = Object.keys(generator).find((key) => key !== "selector" && key !== "template")
    const spec = kind === undefined ? undefined : generator[kind]
    if (kind === undefined || !isObject(spec)) throw new Skip("the generator names no kind")
    if (OUTSIDE_GENERATORS.includes(kind))
        throw new Skip(`the ${kind} generator reads state outside the workspace`)
    switch (kind) {
        case "list":
            return listParams(spec, mode)
        case "git":
            return gitParams(spec, mode, context)
        case "matrix":
            return matrixParams(spec, mode, context)
        case "merge":
            return mergeParams(spec, mode, context)
        default:
            throw new Skip(`the reader does not know the ${kind} generator`)
    }
}

/** True for the template that the API server writes on each generator: empty strings and empty maps. */
function isEmptyTemplate(data: unknown): boolean {
    if (data === null || data === "" || data === undefined) return true
    if (Array.isArray(data)) return data.length === 0
    if (isObject(data)) return Object.values(data).every(isEmptyTemplate)
    return false
}

function listParams(spec: Record<string, unknown>, mode: Mode): Params[] {
    const elements = Array.isArray(spec.elements) ? [...spec.elements] : []
    if (typeof spec.elementsYaml === "string") {
        let parsed: unknown
        try {
            parsed = parse(spec.elementsYaml)
        } catch (error) {
            throw new Skip(`elementsYaml does not parse: ${String(error)}`)
        }
        if (!Array.isArray(parsed)) throw new Skip("elementsYaml holds no list")
        elements.push(...parsed)
    }
    return elements.map((element) => {
        if (!isObject(element)) throw new Skip("a list element holds no map")
        return mode.goTemplate ? element : flatten(element)
    })
}

function gitParams(spec: Record<string, unknown>, mode: Mode, context: SourceContext): Params[] {
    const repoURL = String(spec.repoURL ?? "")
    const checkout = context.checkoutOf(repoURL)
    if (checkout === undefined) throw new Skip(`${repoURL} is not checked out in the workspace`)
    const prefix = typeof spec.pathParamPrefix === "string" ? spec.pathParamPrefix : ""
    const values = isObject(spec.values) ? spec.values : {}
    const withValues = (params: Params): Params => appendValues(params, values, mode)
    if (Array.isArray(spec.directories)) {
        const { include, exclude } = globs(spec.directories)
        return walk(checkout, include, "directories")
            .filter((dir) => !exclude.some((pattern) => matches(pattern, dir)))
            .map((dir) => withValues(pathParams(dir, undefined, prefix, mode)))
    }
    if (Array.isArray(spec.files)) {
        const { include, exclude } = globs(spec.files)
        return walk(checkout, include, "files")
            .filter((file) => !exclude.some((pattern) => matches(pattern, file)))
            .flatMap((file) => {
                const params = pathParams(posix.dirname(file), posix.basename(file), prefix, mode)
                return fileContents(checkout, file).map((content) =>
                    withValues(
                        mode.goTemplate
                            ? { ...content, ...params }
                            : { ...flatten(content), ...params }
                    )
                )
            })
    }
    throw new Skip("the git generator names neither directories nor files")
}

/** The path parameters that Argo CD's git generator sets for a directory, or for a file in it. */
function pathParams(dir: string, filename: string | undefined, prefix: string, mode: Mode): Params {
    const base = posix.basename(dir)
    const fields: Record<string, string> = {
        basename: base,
        basenameNormalized: sanitizeName(base)
    }
    if (filename !== undefined) {
        fields.filename = filename
        fields.filenameNormalized = sanitizeName(filename)
    }
    const segments = dir.split("/")
    if (mode.goTemplate) {
        const path = { path: dir, ...fields, segments }
        return prefix === "" ? { path } : { [prefix]: { path } }
    }
    const name = prefix === "" ? "path" : `${prefix}.path`
    const params: Params = { [name]: dir }
    for (const [field, value] of Object.entries(fields)) params[`${name}.${field}`] = value
    segments.forEach((segment, index) => (params[`${name}[${index}]`] = segment))
    return params
}

/** Adds the generator's `values`, rendered with its parameters, under `values`. */
function appendValues(params: Params, values: Record<string, unknown>, mode: Mode): Params {
    const entries = Object.entries(values)
    if (entries.length === 0) return params
    const rendered = entries.map(([key, value]) => {
        try {
            return [key, render(String(value), params, mode)] as const
        } catch (error) {
            if (error instanceof Unevaluable)
                throw new Skip(
                    `values.${key}: cannot evaluate ${JSON.stringify(value)} (${error.message})`
                )
            throw error
        }
    })
    if (mode.goTemplate) return { ...params, values: Object.fromEntries(rendered) }
    return {
        ...params,
        ...Object.fromEntries(rendered.map(([key, value]) => [`values.${key}`, value]))
    }
}

function fileContents(checkout: string, file: string): Record<string, unknown>[] {
    let data: unknown
    try {
        data = parse(readFileSync(join(checkout, file), "utf8"))
    } catch (error) {
        throw new Skip(`${file} does not parse: ${String(error)}`)
    }
    const items = Array.isArray(data) ? data : [data]
    return items.map((item) => {
        if (!isObject(item)) throw new Skip(`${file} holds no map`)
        return item
    })
}

/** Takes the first child's parameters into the second child, the way Argo CD does, and joins each pair. */
function matrixParams(spec: Record<string, unknown>, mode: Mode, context: SourceContext): Params[] {
    const children = Array.isArray(spec.generators) ? spec.generators : []
    if (children.length !== 2) throw new Skip("a matrix generator must hold exactly two generators")
    const result: Params[] = []
    for (const first of generate(children[0], mode, context)) {
        for (const second of generate(renderData(children[1], first, mode), mode, context))
            result.push(mode.goTemplate ? deepMerge(first, second) : { ...first, ...second })
    }
    return result
}

/** Overrides each parameter set of the first child with the sets of later children that share its `mergeKeys` values. */
function mergeParams(spec: Record<string, unknown>, mode: Mode, context: SourceContext): Params[] {
    const children = Array.isArray(spec.generators) ? spec.generators : []
    const mergeKeys = Array.isArray(spec.mergeKeys) ? spec.mergeKeys.map(String) : []
    if (children.length < 2) throw new Skip("a merge generator must hold at least two generators")
    if (mergeKeys.length === 0) throw new Skip("a merge generator must name mergeKeys")
    const keyOf = (params: Params): string | undefined => {
        const values = mergeKeys.map((key) =>
            mode.goTemplate ? lookupDotted(params, key) : params[key]
        )
        return values.some((value) => value === undefined) ? undefined : JSON.stringify(values)
    }
    let base = generate(children[0], mode, context)
    for (const child of children.slice(1)) {
        const byKey = new Map<string, Params>()
        for (const params of generate(child, mode, context)) {
            const key = keyOf(params)
            if (key !== undefined) byKey.set(key, params)
        }
        base = base.map((params) => {
            const key = keyOf(params)
            const override = key === undefined ? undefined : byKey.get(key)
            if (override === undefined) return params
            return mode.goTemplate ? deepMerge(params, override) : { ...params, ...override }
        })
    }
    return base
}

// Paths and globs

function globs(entries: unknown[]): { include: string[][]; exclude: string[][] } {
    const include: string[][] = []
    const exclude: string[][] = []
    for (const entry of entries) {
        if (!isObject(entry) || typeof entry.path !== "string") continue
        const segments = entry.path.replace(/^(\.?\/)+/, "").split("/")
        ;(entry.exclude === true ? exclude : include).push(segments)
    }
    return { include, exclude }
}

/**
 * Lists the directories or the files under `root` that some pattern matches, as slash-separated paths relative to `root`, sorted.
 * The walk enters only folders that could lead to a match.
 * Directories whose name starts with a dot stay out of a directory listing, the way Argo CD leaves them out.
 */
function walk(root: string, patterns: string[][], want: "directories" | "files"): string[] {
    const found: string[] = []
    const visit = (relative: string[]): void => {
        let entries
        try {
            entries = readdirSync(join(root, ...relative), { withFileTypes: true })
        } catch {
            return
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        for (const entry of entries) {
            const path = [...relative, entry.name]
            if (entry.isDirectory()) {
                if (entry.name === ".git") continue
                if (want === "directories" && entry.name.startsWith(".")) continue
                if (
                    want === "directories" &&
                    patterns.some((pattern) => matchSegments(pattern, path))
                )
                    found.push(path.join("/"))
                if (patterns.some((pattern) => couldMatchBelow(pattern, path))) visit(path)
            } else if (want === "files" && entry.isFile()) {
                if (patterns.some((pattern) => matchSegments(pattern, path)))
                    found.push(path.join("/"))
            }
        }
    }
    visit([])
    return found
}

function matches(pattern: string[], path: string): boolean {
    return matchSegments(pattern, path.split("/"))
}

/** Matches a path segment by segment. `**` matches any number of segments. `*` stays within one. */
function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
    const [head, ...rest] = pattern
    if (head === undefined) return path.length === 0
    if (head === "**")
        return (
            matchSegments(rest, path) || (path.length > 0 && matchSegments(pattern, path.slice(1)))
        )
    return (
        path.length > 0 && segmentRegExp(head).test(path[0]!) && matchSegments(rest, path.slice(1))
    )
}

/** True once some path below the folder `path` could match `pattern`. */
function couldMatchBelow(pattern: readonly string[], path: readonly string[]): boolean {
    const [head, ...rest] = pattern
    if (path.length === 0) return pattern.length > 0
    if (head === undefined) return false
    if (head === "**") return true
    return segmentRegExp(head).test(path[0]!) && couldMatchBelow(rest, path.slice(1))
}

/** Turns one segment of a Go `path.Match` pattern into a regular expression: `*`, `?`, `[a-z]`, `[^a]` and `\` escapes. */
function segmentRegExp(segment: string): RegExp {
    let source = ""
    for (let index = 0; index < segment.length; index++) {
        const char = segment[index]!
        if (char === "*") source += "[^/]*"
        else if (char === "?") source += "[^/]"
        else if (char === "\\" && index + 1 < segment.length)
            source += escapeRegExp(segment[++index]!)
        else if (char === "[") {
            const end = segment.indexOf("]", index + 2)
            if (end === -1) {
                source += "\\["
                continue
            }
            const body = segment.slice(index + 1, end)
            source += body.startsWith("^") ? `[^${body.slice(1)}]` : `[${body}]`
            index = end
        } else source += escapeRegExp(char)
    }
    return new RegExp(`^${source}$`)
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
}

/** Argo CD's `SanitizeName`: lower case, every character outside `a-z0-9-.` turned into `-`, at most 253 characters. */
function sanitizeName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^-a-z0-9.]/g, "-")
        .slice(0, 253)
        .replace(/^[-.]+|[-.]+$/g, "")
}

// Parameter data

/** Flattens nested data into dotted keys with string values, the way fasttemplate mode sees a list element or a file. */
function flatten(data: Record<string, unknown>): Params {
    const params: Params = {}
    const visit = (value: unknown, key: string): void => {
        if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${key}.${index}`))
        else if (isObject(value))
            for (const [child, item] of Object.entries(value))
                visit(item, key === "" ? child : `${key}.${child}`)
        else params[key] = value === null ? "<nil>" : String(value)
    }
    visit(data, "")
    return params
}

function deepMerge(base: Params, override: Params): Params {
    const merged: Params = { ...base }
    for (const [key, value] of Object.entries(override)) {
        const current = merged[key]
        merged[key] = isObject(current) && isObject(value) ? deepMerge(current, value) : value
    }
    return merged
}

function lookupDotted(params: Params, key: string): unknown {
    let value: unknown = params
    for (const segment of key.split(".")) {
        if (!isObject(value) || !Object.hasOwn(value, segment)) return undefined
        value = value[segment]
    }
    return value
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mapAt(map: YAMLMap | undefined, key: string): YAMLMap | undefined {
    const value = map?.get(key, true)
    return isMap(value) ? value : undefined
}

function scalarAt(map: YAMLMap | undefined, key: string): unknown {
    const value = map?.get(key, true)
    return isScalar(value) ? value.value : undefined
}

// Go templates

/**
 * Renders the subset of Go's text/template that ApplicationSets use for names and paths:
 * field chains (`.path.basename`), literals, pipelines and a few Sprig functions.
 * A missing key throws, where Argo CD would write `<no value>` or fail under `missingkey=error`.
 */
function renderGoTemplate(text: string, params: Params): string {
    let output = ""
    let index = 0
    for (;;) {
        const open = text.indexOf("{{", index)
        if (open === -1) return output + text.slice(index)
        let literal = text.slice(index, open)
        let start = open + 2
        if (text[start] === "-" && /\s/.test(text[start + 1] ?? "")) {
            literal = literal.trimEnd()
            start++
        }
        const close = closingBraces(text, start)
        let end = close
        let trimAfter = false
        if (text[close - 1] === "-" && /\s/.test(text[close - 2] ?? "")) {
            end = close - 1
            trimAfter = true
        }
        output += literal + evaluateAction(text.slice(start, end).trim(), params)
        index = close + 2
        if (trimAfter) while (/\s/.test(text[index] ?? "")) index++
    }
}

function closingBraces(text: string, start: number): number {
    let quote: string | undefined
    for (let index = start; index < text.length; index++) {
        const char = text[index]!
        if (quote !== undefined) {
            if (char === "\\" && quote === '"') index++
            else if (char === quote) quote = undefined
        } else if (char === '"' || char === "`") quote = char
        else if (text.startsWith("}}", index)) return index
    }
    throw new Unevaluable("an action misses its closing }}")
}

type Token =
    | { kind: "field"; path: string[] }
    | { kind: "literal"; value: string | number | boolean }
    | { kind: "name"; name: string }
    | { kind: "pipe" }

const KEYWORDS = [
    "if",
    "else",
    "end",
    "range",
    "with",
    "define",
    "template",
    "block",
    "break",
    "continue"
]

function evaluateAction(source: string, params: Params): string {
    if (/^\/\*[\s\S]*\*\/$/.test(source)) return ""
    const commands: Token[][] = [[]]
    for (const token of tokenize(source)) {
        if (token.kind === "pipe") commands.push([])
        else commands[commands.length - 1]!.push(token)
    }
    let value: unknown
    commands.forEach((command, position) => {
        const [head, ...rest] = command
        if (head === undefined) throw new Unevaluable("an empty command")
        const piped = position === 0 ? [] : [value]
        if (head.kind === "name") {
            value = callFunction(head.name, [
                ...rest.map((token) => operand(token, params)),
                ...piped
            ])
            return
        }
        if (rest.length > 0 || piped.length > 0)
            throw new Unevaluable(`${source} passes arguments to a value`)
        value = operand(head, params)
    })
    return printed(value)
}

function tokenize(source: string): Token[] {
    const tokens: Token[] = []
    let index = 0
    while (index < source.length) {
        const rest = source.slice(index)
        const space = /^\s+/.exec(rest)
        if (space !== null) {
            index += space[0].length
            continue
        }
        let match: RegExpExecArray | null
        if (rest.startsWith("|")) {
            tokens.push({ kind: "pipe" })
            index++
        } else if ((match = /^"(?:[^"\\]|\\.)*"/.exec(rest)) !== null) {
            tokens.push({ kind: "literal", value: JSON.parse(match[0]) as string })
            index += match[0].length
        } else if ((match = /^`[^`]*`/.exec(rest)) !== null) {
            tokens.push({ kind: "literal", value: match[0].slice(1, -1) })
            index += match[0].length
        } else if ((match = /^-?\d+(?![\w.])/.exec(rest)) !== null) {
            tokens.push({ kind: "literal", value: Number(match[0]) })
            index += match[0].length
        } else if ((match = /^(?:\.[A-Za-z_]\w*)+|^\./.exec(rest)) !== null) {
            const path = match[0] === "." ? [] : match[0].slice(1).split(".")
            tokens.push({ kind: "field", path })
            index += match[0].length
        } else if ((match = /^[A-Za-z_]\w*/.exec(rest)) !== null) {
            const name = match[0]
            if (KEYWORDS.includes(name)) throw new Unevaluable(`the reader does not run ${name}`)
            if (name === "true" || name === "false")
                tokens.push({ kind: "literal", value: name === "true" })
            else tokens.push({ kind: "name", name })
            index += name.length
        } else {
            throw new Unevaluable(
                `the reader does not take ${JSON.stringify(rest[0])} in an action`
            )
        }
    }
    return tokens
}

function operand(token: Token, params: Params): unknown {
    if (token.kind === "literal") return token.value
    if (token.kind === "field") {
        let value: unknown = params
        for (const segment of token.path) {
            if (!isObject(value) || !Object.hasOwn(value, segment)) return undefined
            value = value[segment]
        }
        return value
    }
    if (token.kind === "name") return callFunction(token.name, [])
    throw new Unevaluable("a pipe stands where a value belongs")
}

function callFunction(name: string, args: unknown[]): unknown {
    const text = (value: unknown): string => printed(value)
    switch (name) {
        case "index": {
            let [value, ...keys] = args
            for (const key of keys) {
                if (Array.isArray(value) && typeof key === "number") {
                    if (key < 0 || key >= value.length)
                        throw new Unevaluable(`index ${key} lies outside a list of ${value.length}`)
                    value = value[key]
                } else if (isObject(value) && typeof key === "string") {
                    value = Object.hasOwn(value, key) ? value[key] : undefined
                } else {
                    throw new Unevaluable(
                        `cannot index ${printedType(value)} with ${JSON.stringify(key)}`
                    )
                }
            }
            return value
        }
        case "default": {
            const [fallback, value] = args
            return isEmpty(value) ? fallback : value
        }
        case "lower":
            return text(args[0]).toLowerCase()
        case "upper":
            return text(args[0]).toUpperCase()
        case "trim":
            return text(args[0]).trim()
        case "base":
            return posix.basename(text(args[0])) || "."
        case "dir":
            return posix.dirname(text(args[0]))
        case "trimPrefix": {
            const [prefix, value] = args.map(text)
            return value!.startsWith(prefix!) ? value!.slice(prefix!.length) : value
        }
        case "trimSuffix": {
            const [suffix, value] = args.map(text)
            return value!.endsWith(suffix!)
                ? value!.slice(0, value!.length - suffix!.length)
                : value
        }
        case "replace": {
            const [from, to, value] = args.map(text)
            return value!.split(from!).join(to!)
        }
        case "normalize":
            return sanitizeName(text(args[0]))
        default:
            throw new Unevaluable(`the reader does not know the function ${name}`)
    }
}

function isEmpty(value: unknown): boolean {
    if (value === undefined || value === null || value === "" || value === 0 || value === false)
        return true
    if (Array.isArray(value)) return value.length === 0
    if (isObject(value)) return Object.keys(value).length === 0
    return false
}

/** Writes a value the way Go prints it. A missing key, a map and a list throw, since their text would be no real value. */
function printed(value: unknown): string {
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    if (value === undefined || value === null) throw new Unevaluable("a key is missing")
    throw new Unevaluable(`the action yields ${printedType(value)}`)
}

function printedType(value: unknown): string {
    if (Array.isArray(value)) return "a list"
    if (isObject(value)) return "a map"
    return value === undefined || value === null ? "a missing value" : typeof value
}
