import { existsSync } from "node:fs"
import { basename, dirname, isAbsolute, join, normalize } from "node:path"
import { isMap, isScalar, isSeq, type Node, type YAMLMap } from "yaml"
import type { ChartRef, LayerSource, ReleaseSpec } from "../argo"
import type { KeySite } from "../yamlPaths"
import type { SourceContext, SourceReader, WorkspaceFile } from "./types"
import {
    type At,
    existsInWorkspace,
    lineOf,
    mapAt,
    mapDocuments,
    mapsAt,
    missingLayer,
    nodeAt,
    objectLayer,
    parameterSite,
    readWorkspaceText,
    scalarAt,
    splitOciChart,
    stringAt,
    withoutOciScheme
} from "./yamlNodes"

const HELMFILE_NAME = /^helmfile\.ya?ml(\.gotmpl)?$/
const HELMFILE_D_ENTRY = /\.(ya?ml|gotmpl)$/
const TEMPLATE_EXPRESSION = /\{\{[\s\S]*?\}\}/g
const TEMPLATE_COMMENT = /^\{\{-?\s*\/\*[\s\S]*\*\/\s*-?\}\}$/
const FIELD_EXPRESSION =
    /^\{\{-?\s*\.(Environment\.Name|Release\.Name|Release\.Namespace)\s*-?\}\}$/
/**
 * Stands in for a template expression that the reader leaves unrendered, to keep the YAML parseable.
 * It keeps the length of the expression where it can. The columns after it stay in place.
 */
const PLACEHOLDER = /§(\d+)§+/g
const PLACEHOLDER_MARK = "§"
const DEFAULT_ENVIRONMENT = "default"

/** The fields that the reader renders in a template. Each other expression stays a placeholder. */
interface TemplateFields {
    "Environment.Name": string
    "Release.Name"?: string
    "Release.Namespace"?: string
}

interface Rendered {
    text: string
    /** The expressions that stayed unrendered, by the index in their placeholder. */
    expressions: string[]
}

/**
 * Finds the releases of a helmfile and the layers that helmfile hands Helm, in the order of
 * `namespaceAndValuesFlags` in `pkg/state/state.go` of helmfile v1:
 * - `valuesTemplate`, which helmfile puts in front of `values`.
 * - `values` in their order. A string names a file relative to the helmfile and a map holds the values.
 * - `secrets`, which helm-secrets decrypts and the trace leaves out.
 * - `setTemplate` and `set` as `--set`, then `setString` as `--set-string`. Helm applies every `--set` first.
 *
 * Helmfile v1 renders a state file ending in `.gotmpl` as a Go template. It renders every `.gotmpl` values file as well.
 * The reader renders `{{ .Environment.Name }}` for each entry under `environments:`.
 * Values entries render `{{ .Release.Name }}` and `{{ .Release.Namespace }}` as well.
 * Each other expression leaves its layer unread with a problem, or its chart unresolved.
 * A release that the environments render alike stays one release.
 * One that they render apart turns into one release per environment, its name and id carrying the environment.
 */
export const readHelmfile: SourceReader = (file, context) => {
    if (!isHelmfile(file.fsPath)) return []
    const templated = file.fsPath.endsWith(".gotmpl")
    const environments = environmentNames(file.text, templated)
    const rendered = environments.map((environment) => ({
        environment,
        releases: readState(file, context, environment, templated)
    }))
    const first = rendered[0]!
    if (rendered.every((each) => signature(each.releases) === signature(first.releases)))
        return first.releases
    return rendered.flatMap(({ environment, releases }) =>
        releases.map((release) => ({
            ...release,
            id: `${release.id}:${environment}`,
            name: `${release.name} (${environment})`
        }))
    )
}

function isHelmfile(fsPath: string): boolean {
    const name = basename(fsPath)
    if (HELMFILE_NAME.test(name)) return true
    return basename(dirname(fsPath)) === "helmfile.d" && HELMFILE_D_ENTRY.test(name)
}

function signature(releases: ReleaseSpec[]): string {
    return JSON.stringify(releases, (_, value: unknown) =>
        value instanceof Map ? [...value.entries()] : value
    )
}

/** The keys of `environments:` across every part of the state file, or `default` if it names none. */
function environmentNames(text: string, templated: boolean): string[] {
    const { roots } = mapDocuments(render(text, templated, undefined).text)
    const names = new Set<string>()
    for (const root of roots) {
        const environments = mapAt(root, "environments")
        for (const pair of environments?.items ?? [])
            if (isScalar(pair.key)) names.add(String(pair.key.value))
    }
    return names.size === 0 ? [DEFAULT_ENVIRONMENT] : [...names]
}

/**
 * Renders the fields of `fields` in a template text and puts a placeholder in place of every other expression.
 * A comment renders to blanks. An untemplated text stays as it is.
 */
function render(text: string, templated: boolean, fields: TemplateFields | undefined): Rendered {
    const expressions: string[] = []
    if (!templated) return { text, expressions }
    const rendered = text.replace(TEMPLATE_EXPRESSION, (expression) => {
        if (TEMPLATE_COMMENT.test(expression)) return expression.replace(/[^\n]/g, " ")
        const field = FIELD_EXPRESSION.exec(expression)?.[1] as keyof TemplateFields | undefined
        const value = field === undefined ? undefined : fields?.[field]
        if (value !== undefined) return value
        expressions.push(expression)
        const placeholder = `${PLACEHOLDER_MARK}${expressions.length - 1}${PLACEHOLDER_MARK}`
        return placeholder.padEnd(expression.length, PLACEHOLDER_MARK)
    })
    return { text: rendered, expressions }
}

/** The first expression that a placeholder in `text` stands in for. */
function unrenderedIn(text: string, expressions: readonly string[]): string | undefined {
    const match = new RegExp(PLACEHOLDER.source).exec(text)
    return match === null ? undefined : (expressions[Number(match[1])] ?? match[0])
}

/** Puts the expressions back in place of their placeholders, for a name that the editor shows. */
function restored(text: string, expressions: readonly string[]): string {
    return text.replace(PLACEHOLDER, (match, index: string) => expressions[Number(index)] ?? match)
}

interface Repository {
    url: string
    oci: boolean
}

interface State {
    file: WorkspaceFile
    context: SourceContext
    dir: string
    environment: string
    expressions: string[]
    repositories: Map<string, Repository>
    missingFileHandler: string | undefined
    at: At
}

function readState(
    file: WorkspaceFile,
    context: SourceContext,
    environment: string,
    templated: boolean
): ReleaseSpec[] {
    const { text, expressions } = render(file.text, templated, {
        "Environment.Name": environment
    })
    const { roots, at } = mapDocuments(text)
    const state: State = {
        file,
        context,
        dir: dirname(file.fsPath),
        environment,
        expressions,
        repositories: new Map(),
        missingFileHandler: undefined,
        at
    }
    for (const root of roots) {
        for (const repository of mapsAt(root, "repositories") ?? []) {
            const name = stringAt(repository, "name")
            if (name === undefined) continue
            state.repositories.set(name, {
                url: stringAt(repository, "url") ?? "",
                oci: scalarAt(repository, "oci") === true
            })
        }
        state.missingFileHandler = stringAt(root, "missingFileHandler") ?? state.missingFileHandler
    }
    return roots.flatMap((root) =>
        (mapsAt(root, "releases") ?? []).flatMap((entry) => {
            if (scalarAt(entry, "installed") === false) return []
            return [readRelease(state, entry)]
        })
    )
}

function readRelease(state: State, entry: YAMLMap): ReleaseSpec {
    const { file, expressions, at } = state
    const name = restored(stringAt(entry, "name") ?? "", expressions)
    const namespace = stringAt(entry, "namespace")
    const appLine = lineOf(nodeAt(entry, "name"), at)
    const fields: TemplateFields = {
        "Environment.Name": state.environment,
        "Release.Name": name,
        ...(namespace === undefined ? {} : { "Release.Namespace": namespace })
    }
    return {
        id: `${file.fsPath}:${appLine}:${name}`,
        name,
        origin: "Helmfile release",
        appFile: file.fsPath,
        appLine,
        releaseName: name,
        namespace: namespace === undefined ? undefined : restored(namespace, expressions),
        chart: chartOf(state, stringAt(entry, "chart") ?? "", stringAt(entry, "version") ?? ""),
        layers: valueLayers(state, entry, fields)
    }
}

/**
 * Resolves a chart as helmfile does: a folder relative to the helmfile wins.
 * `oci://` names a registry. `repo/chart` names a chart from the repository that `repositories:` names.
 */
function chartOf(state: State, chart: string, version: string): ChartRef {
    const expression = unrenderedIn(chart + version, state.expressions)
    if (expression !== undefined)
        return {
            kind: "unresolved",
            reason: `the chart holds the template expression ${expression}`
        }
    if (chart === "") return { kind: "unresolved", reason: "the release names no chart" }
    if (chart.startsWith("oci://")) return { kind: "repository", ...splitOciChart(chart), version }
    const dir = normalize(isAbsolute(chart) ? chart : join(state.dir, chart))
    if (existsSync(dir)) return { kind: "directory", dir }
    const parts = chart.split("/")
    const repository = parts.length === 2 ? state.repositories.get(parts[0]!) : undefined
    if (repository !== undefined)
        return {
            kind: "repository",
            repoURL: repository.oci ? withoutOciScheme(repository.url) : repository.url,
            chart: parts[1]!,
            version
        }
    if (/^\.{0,2}\//.test(chart) || parts.length !== 2)
        return { kind: "unresolved", reason: `no chart at ${dir}` }
    return { kind: "unresolved", reason: `no repository ${parts[0]} under repositories:` }
}

function valueLayers(state: State, entry: YAMLMap, fields: TemplateFields): LayerSource[] {
    const handler = stringAt(entry, "missingFileHandler") ?? state.missingFileHandler ?? "Error"
    const layers: LayerSource[] = []
    const entries = (key: string): Node[] => {
        const node = nodeAt(entry, key)
        return isSeq(node) ? (node.items as Node[]) : []
    }
    entries("valuesTemplate").forEach((node, index) =>
        layers.push(...valuesEntry(state, node, `valuesTemplate[${index}]`, true, fields, handler))
    )
    entries("values").forEach((node, index) =>
        layers.push(...valuesEntry(state, node, `values[${index}]`, false, fields, handler))
    )
    for (const node of entries("secrets")) {
        const raw = isScalar(node) ? String(node.value) : "secrets"
        layers.push(missingLayer(raw, "helm-secrets decrypts it, which the trace leaves out"))
    }
    const set = setLayer(state, "set", [...entries("setTemplate"), ...entries("set")], fields)
    const setString = setLayer(state, "setString", entries("setString"), fields)
    for (const layer of [...set, ...setString]) layers.push(layer)
    return layers
}

/** Reads one entry of `values` or `valuesTemplate`. Yields nothing for a missing file that `missingFileHandler` skips. */
function valuesEntry(
    state: State,
    node: Node,
    label: string,
    template: boolean,
    fields: TemplateFields,
    handler: string
): LayerSource[] {
    const { file, expressions, at } = state
    if (isMap(node)) {
        const layer = objectLayer(label, file.fsPath, node, at)
        if (layer.kind !== "object") return [layer]
        const text = JSON.stringify(layer.data)
        // Helmfile renders a map under `valuesTemplate`. It passes a map under `values` as it stands.
        const expression =
            unrenderedIn(text, expressions) ??
            (template ? render(text, true, fields).expressions[0] : undefined)
        if (expression !== undefined)
            return [
                missingLayer(
                    label,
                    `holds the template expression ${expression}, which the trace leaves out`
                )
            ]
        if (template) layer.data = renderedData(layer.data, fields)
        return [layer]
    }
    if (!isScalar(node) || typeof node.value !== "string") return []
    const { text: raw, expressions: rawExpressions } = render(node.value, true, fields)
    const expression = unrenderedIn(raw, expressions) ?? rawExpressions[0]
    if (expression !== undefined)
        return [missingLayer(node.value, `the path holds the template expression ${expression}`)]
    if (/^[a-z0-9+]+:\/\//i.test(raw) || raw.includes("::"))
        return [missingLayer(raw, "a remote values file gets no lookup")]
    const fsPath = normalize(isAbsolute(raw) ? raw : join(state.dir, raw))
    if (!existsInWorkspace(fsPath, state.context)) {
        // Helmfile fails on a missing file under `Error` and skips it under `Warn`, `Info` or `Debug`.
        if (handler !== "Error") return []
        return [{ kind: "file", label: raw, fsPath, raw }]
    }
    if (!raw.endsWith(".gotmpl")) return [{ kind: "file", label: raw, fsPath, raw }]
    const source = readWorkspaceText(fsPath, state.context) ?? ""
    const renderedFile = render(source, true, fields)
    if (renderedFile.expressions.length > 0)
        return [
            missingLayer(
                raw,
                `holds the template expression ${renderedFile.expressions[0]}, which the trace leaves out`
            )
        ]
    if (renderedFile.text === source) return [{ kind: "file", label: raw, fsPath, raw }]
    return [
        {
            kind: "inline",
            label: raw,
            fsPath,
            text: renderedFile.text,
            offset: { lineDelta: 0, columnDelta: 0 }
        }
    ]
}

/** Renders the fields in each string of a `valuesTemplate` map. */
function renderedData(data: unknown, fields: TemplateFields): unknown {
    if (typeof data === "string") return render(data, true, fields).text
    if (Array.isArray(data)) return data.map((item) => renderedData(item, fields))
    if (data !== null && typeof data === "object")
        return Object.fromEntries(
            Object.entries(data).map(([key, value]) => [key, renderedData(value, fields)])
        )
    return data
}

/** Builds the `--set` or `--set-string` layer. An entry with `values` or `file` stays out with a problem. */
function setLayer(
    state: State,
    key: "set" | "setString",
    nodes: Node[],
    fields: TemplateFields
): LayerSource[] {
    const { file, expressions, at } = state
    const parameters: { name: string; value: string; forceString?: boolean }[] = []
    const sites = new Map<string, KeySite>()
    const problems: LayerSource[] = []
    for (const node of nodes) {
        if (!isMap(node)) continue
        const rawName = stringAt(node, "name") ?? ""
        const name = render(rawName, true, fields)
        const label = `${key} ${restored(rawName, expressions)}`
        if (nodeAt(node, "file") !== undefined) {
            problems.push(missingLayer(label, "--set-file gets no lookup"))
            continue
        }
        if (nodeAt(node, "values") !== undefined) {
            problems.push(missingLayer(label, "a list from values: gets no trace"))
            continue
        }
        const value = render(stringAt(node, "value") ?? "", true, fields)
        const expression =
            unrenderedIn(name.text + value.text, expressions) ??
            name.expressions[0] ??
            value.expressions[0]
        if (expression !== undefined) {
            problems.push(missingLayer(label, `holds the template expression ${expression}`))
            continue
        }
        // Helmfile passes no flag for an entry with an empty value.
        if (value.text === "") continue
        parameters.push({ name: name.text, value: value.text, forceString: key === "setString" })
        parameterSite(sites, name.text, nodeAt(node, "name"), at)
    }
    if (parameters.length === 0) return problems
    return [{ kind: "parameters", label: key, fsPath: file.fsPath, parameters, sites }, ...problems]
}
