import { existsSync, readFileSync } from "node:fs"
import {
    isMap,
    isScalar,
    isSeq,
    LineCounter,
    parseAllDocuments,
    type Node,
    type YAMLMap
} from "yaml"
import type { LayerSource } from "../argo"
import { collectSites, type KeySite, type Offset, pathKey, type Position } from "../yamlPaths"
import type { SourceContext, WorkspaceFile } from "./types"

/** Turns a character offset of a parsed text into a zero-based line and column. */
export type At = (offset: number) => Position

/** The documents of a YAML text whose top level holds a map. Documents with errors get skipped. */
export function mapDocuments(text: string): { roots: YAMLMap[]; at: At } {
    const lineCounter = new LineCounter()
    const at: At = (offset) => {
        const { line, col } = lineCounter.linePos(offset)
        return { line: line - 1, column: col - 1 }
    }
    const roots: YAMLMap[] = []
    for (const document of parseAllDocuments(text, { lineCounter })) {
        if (!("contents" in document) || document.errors.length > 0) continue
        if (isMap(document.contents)) roots.push(document.contents)
    }
    return { roots, at }
}

export function mapAt(map: YAMLMap | undefined, key: string): YAMLMap | undefined {
    const value = map?.get(key, true)
    return isMap(value) ? value : undefined
}

/** The maps in the list under `key`. Undefined if `key` holds no list. */
export function mapsAt(map: YAMLMap | undefined, key: string): YAMLMap[] | undefined {
    const value = map?.get(key, true)
    return isSeq(value) ? value.items.filter((item): item is YAMLMap => isMap(item)) : undefined
}

export function scalarAt(map: YAMLMap | undefined, key: string): unknown {
    const value = map?.get(key, true)
    return isScalar(value) ? value.value : undefined
}

/** The scalar under `key` as text. Undefined for a missing key, a null, a map or a list. */
export function stringAt(map: YAMLMap | undefined, key: string): string | undefined {
    const value = scalarAt(map, key)
    return value === undefined || value === null ? undefined : String(value)
}

export function nodeAt(map: YAMLMap | undefined, key: string): Node | undefined {
    return (map?.get(key, true) as Node | undefined) ?? undefined
}

/** The line where `node` starts, or 0 for a node without a range. */
export function lineOf(node: Node | undefined, at: At): number {
    return node?.range ? at(node.range[0]).line : 0
}

/** A map in the file as a layer, with the site of each of its keys. */
export function objectLayer(label: string, fsPath: string, node: YAMLMap, at: At): LayerSource {
    const sites = new Map<string, KeySite>()
    collectSites(node, [], sites, at)
    return { kind: "object", label, fsPath, data: node.toJSON() ?? {}, sites }
}

/** A string in the file that holds a values text, such as `data.values.yaml` of a ConfigMap. */
export function inlineLayer(
    label: string,
    fsPath: string,
    text: string,
    node: Node,
    at: At
): LayerSource {
    const value = isScalar(node) ? String(node.value ?? "") : ""
    return { kind: "inline", label, fsPath, text: value, offset: blockOffset(text, node, at) }
}

/** A layer that cannot load. The editor reports `problem` and the trace leaves the layer out. */
export function missingLayer(label: string, problem: string): LayerSource {
    return { kind: "file", label, fsPath: undefined, raw: label, problem }
}

/** The site of a `--set` style name, split at each dot that no backslash escapes. */
export function parameterSite(
    sites: Map<string, KeySite>,
    name: string,
    node: Node | undefined,
    at: At
): void {
    if (!node?.range) return
    const path = name.split(/(?<!\\)\./).map((segment) => segment.replace(/\\\./g, "."))
    sites.set(pathKey(path), { key: at(node.range[0]), valueEnd: undefined })
}

/**
 * Finds how far the lines of a block scalar sit from the lines of its text.
 * The text of `values: |` starts on the line after the indicator, indented by the indentation of its first line.
 * Undefined for a quoted or flow string, whose lines the editor cannot map.
 */
export function blockOffset(text: string, node: Node, at: At): Offset | undefined {
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

/** Reads a file of the workspace, from the editor where it holds unsaved changes. Undefined if it does not exist. */
export function readWorkspaceText(fsPath: string, context: SourceContext): string | undefined {
    const open = context.files.find((file) => file.fsPath === fsPath)
    if (open !== undefined) return open.text
    return existsSync(fsPath) ? readFileSync(fsPath, "utf8") : undefined
}

export function existsInWorkspace(fsPath: string, context: SourceContext): boolean {
    return context.files.some((file) => file.fsPath === fsPath) || existsSync(fsPath)
}

/**
 * A Kubernetes resource in a file of the workspace.
 * `namespace` stays undefined where the manifest leaves it to the namespace that it gets applied to.
 */
export interface Resource {
    file: WorkspaceFile
    kind: string
    name: string
    namespace: string | undefined
    root: YAMLMap
    at: At
}

const parsedResources = new Map<string, { text: string; resources: Resource[] }>()

/**
 * Finds a resource by kind and name in the files of the workspace.
 * A resource without a namespace matches any `namespace`. An undefined `namespace` matches any resource.
 * A resource in the exact namespace wins over one that leaves it open.
 * Each file gets parsed once per text.
 */
export function findResource(
    context: SourceContext,
    kind: string,
    name: string,
    namespace: string | undefined
): Resource | undefined {
    let loose: Resource | undefined
    for (const file of context.files) {
        if (!file.text.includes(kind) || !file.text.includes(name)) continue
        for (const resource of resourcesOf(file)) {
            if (resource.kind !== kind || resource.name !== name) continue
            if (namespace !== undefined && resource.namespace === namespace) return resource
            if (namespace === undefined || resource.namespace === undefined) loose ??= resource
        }
    }
    return loose
}

function resourcesOf(file: WorkspaceFile): Resource[] {
    const cached = parsedResources.get(file.fsPath)
    if (cached !== undefined && cached.text === file.text) return cached.resources
    const { roots, at } = mapDocuments(file.text)
    const resources = roots.flatMap((root) => {
        const kind = stringAt(root, "kind")
        const metadata = mapAt(root, "metadata")
        const name = stringAt(metadata, "name")
        if (kind === undefined || name === undefined) return []
        return [{ file, kind, name, namespace: stringAt(metadata, "namespace"), root, at }]
    })
    parsedResources.set(file.fsPath, { text: file.text, resources })
    return resources
}

/** Splits an OCI chart URL such as `oci://ghcr.io/org/charts/app` into the registry path and the chart. */
export function splitOciChart(url: string): { repoURL: string; chart: string } {
    const path = withoutOciScheme(url).replace(/\/$/, "")
    const slash = path.lastIndexOf("/")
    return { repoURL: path.slice(0, Math.max(slash, 0)), chart: path.slice(slash + 1) }
}

/** `chartDir` reads a `repoURL` without a scheme as an OCI registry. */
export function withoutOciScheme(url: string): string {
    return url.replace(/^oci:\/\//, "")
}
