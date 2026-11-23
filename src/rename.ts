import { join } from "node:path"
import type { ReleaseSpec } from "./argo"
import { valueAt } from "./coalesce"
import { releaseTitle, templateHints, templatePrefix } from "./hints"
import { type Place, templateDirs } from "./navigation"
import { type ReadText, type Release, templateFiles } from "./release"
import { schemaField } from "./schema"
import { pathKey, type Position, shifted, splitPathKey, type ValuePath } from "./yamlPaths"

/** What a rename reads besides the releases that loaded. */
export interface RenameContext {
    releases: readonly Release[]
    /** The releases that did not load, whose layers the rename cannot see. */
    failed: readonly ReleaseSpec[]
    readText: ReadText
    /** Whether the rename may change the file, such as a file inside the workspace. */
    editable: (fsPath: string) => boolean
    /** The name of a file in a message, such as its path from the workspace folder. */
    describe: (fsPath: string) => string
}

/** One place that spells the last segment of a path of one release. */
interface Occurrence extends Place {
    /** The text between `start` and `end`, such as `a\.b` for a segment of a parameter name. */
    raw: string
    release: Release
    path: ValuePath
    /** The layer that sets the path here, or undefined for a template read. */
    layerIndex: number | undefined
}

/** A path of one release that the rename changes. */
interface Target {
    release: Release
    path: ValuePath
}

/** A key under the cursor that the rename can change, with every place that spells it. */
export interface RenamePlan {
    name: string
    /** The span under the cursor that spells the key. */
    span: Place
    occurrences: Occurrence[]
    targets: Target[]
}

/** A change of one span of a file. */
export interface FileEdit extends Place {
    text: string
}

const KEY_NAME = /^[A-Za-z_][\w-]*$/

/**
 * Finds the key under the cursor and every place that spells it: a key of a values layer, a segment of a parameter name such as `image.tag` and a segment of a `.Values` read.
 * A place that one release shares with another, such as a values file that both take, draws the key of the other release in as well.
 * Undefined where the cursor sits on no such place.
 * A string tells why the key cannot change.
 */
export function planRename(
    context: RenameContext,
    fsPath: string,
    position: Position
): RenamePlan | string | undefined {
    const index = buildIndex(context)
    const under = (index.byFile.get(fsPath) ?? []).find(
        (occurrence) =>
            occurrence.start.line === position.line &&
            occurrence.start.column <= position.column &&
            position.column <= occurrence.end.column
    )
    if (under === undefined) return undefined
    const targets = new Map<string, Target>()
    const queue: Target[] = []
    const visit = (target: Target) => {
        const key = targetKey(target)
        if (targets.has(key)) return
        targets.set(key, target)
        queue.push(target)
    }
    for (const occurrence of index.byPlace.get(placeKey(under)) ?? []) visit(occurrence)
    for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
        for (const occurrence of index.byTarget.get(targetKey(target)) ?? [])
            for (const shared of index.byPlace.get(placeKey(occurrence)) ?? []) visit(shared)
    }
    const occurrences = [...targets.keys()].flatMap((key) => index.byTarget.get(key) ?? [])
    const plan: RenamePlan = {
        name: under.path.at(-1)!,
        span: { fsPath, start: under.start, end: under.end },
        occurrences,
        targets: [...targets.values()]
    }
    return refusal(context, index, plan) ?? plan
}

/**
 * The edits that give the key of `plan` the name `name`, or a string that tells why the name does not fit.
 * A name that a release already uses beside the key does not fit.
 */
export function renameEdits(plan: RenamePlan, name: string): FileEdit[] | string {
    if (name === plan.name) return []
    if (!KEY_NAME.test(name))
        return `A key name must start with a letter or an underscore and hold letters, digits, underscores and hyphens.`
    if (name.includes("-") && plan.occurrences.some((each) => each.layerIndex === undefined))
        return `A hyphen would end the read of ${quote(name)} in a template. Use an underscore.`
    for (const { release, path } of plan.targets) {
        const sibling = [...path.slice(0, -1), name]
        if (usesPath(release, sibling))
            return `Release ${releaseTitle(release.spec)} already uses ${quote(sibling.join("."))}. Pick another name.`
    }
    const seen = new Set<string>()
    const edits: FileEdit[] = []
    for (const occurrence of plan.occurrences) {
        const key = placeKey(occurrence)
        if (seen.has(key)) continue
        seen.add(key)
        edits.push({
            fsPath: occurrence.fsPath,
            start: occurrence.start,
            end: occurrence.end,
            text: name
        })
    }
    return edits
}

interface Index {
    byPlace: Map<string, Occurrence[]>
    byTarget: Map<string, Occurrence[]>
    byFile: Map<string, Occurrence[]>
    /** The `.Values` reads of each release, by release id, each with the path that it reads. */
    reads: Map<string, { path: ValuePath; place: Place }[]>
    /** The reads of `.Values` as a whole in the templates of each release, with the path that they stand for. */
    wholeReads: Map<string, { prefix: ValuePath; place: Place }[]>
    lines: (fsPath: string) => string[] | undefined
}

function buildIndex(context: RenameContext): Index {
    const texts = new Map<string, string[] | undefined>()
    const lines = (fsPath: string) => {
        if (!texts.has(fsPath)) {
            try {
                texts.set(fsPath, context.readText(fsPath).split("\n"))
            } catch {
                texts.set(fsPath, undefined)
            }
        }
        return texts.get(fsPath)
    }
    const index: Index = {
        byPlace: new Map(),
        byTarget: new Map(),
        byFile: new Map(),
        reads: new Map(),
        wholeReads: new Map(),
        lines
    }
    const add = (occurrence: Occurrence) => {
        push(index.byPlace, placeKey(occurrence), occurrence)
        push(index.byTarget, targetKey(occurrence), occurrence)
        push(index.byFile, occurrence.fsPath, occurrence)
    }
    for (const release of context.releases) {
        layerOccurrences(release, lines, add)
        templateOccurrences(release, lines, add, index)
    }
    return index
}

/** Adds the place of each key that a layer of the release sets, and of each segment of a parameter name. */
function layerOccurrences(
    release: Release,
    lines: (fsPath: string) => string[] | undefined,
    add: (occurrence: Occurrence) => void
): void {
    release.trace.layers.forEach((layer, layerIndex) => {
        if (layer.fsPath === undefined) return
        if (layer.kind === "inline" && layer.offset === undefined) return
        const text = lines(layer.fsPath)
        if (text === undefined) return
        for (const [key, site] of layer.sites) {
            const path = splitPathKey(key)
            const at = layer.offset === undefined ? site.key : shifted(site.key, layer.offset)
            const quoted = /["']/.test(text[at.line]?.[at.column] ?? "")
            let column = quoted ? at.column + 1 : at.column
            const segments = layer.kind === "parameters" ? path : [path.at(-1)!]
            const depth = path.length - segments.length
            segments.forEach((segment, offset) => {
                const raw = layer.kind === "parameters" ? segment.replace(/\./g, "\\.") : segment
                add({
                    fsPath: layer.fsPath!,
                    start: { line: at.line, column },
                    end: { line: at.line, column: column + raw.length },
                    raw,
                    release,
                    path: path.slice(0, depth + offset + 1),
                    layerIndex
                })
                column += raw.length + 1
            })
        }
    })
}

/** Adds the place of each segment of each `.Values` read in the templates of the release and notes the reads of `.Values` as a whole. */
function templateOccurrences(
    release: Release,
    lines: (fsPath: string) => string[] | undefined,
    add: (occurrence: Occurrence) => void,
    index: Index
): void {
    const reads: { path: ValuePath; place: Place }[] = []
    const wholeReads: { prefix: ValuePath; place: Place }[] = []
    for (const dir of templateDirs(release)) {
        for (const fsPath of templateFiles(join(dir, "templates"))) {
            const text = lines(fsPath)
            const prefix = templatePrefix(fsPath, release)
            if (text === undefined || prefix === undefined) continue
            for (const hint of templateHints(fsPath, text.join("\n"), [release])) {
                const spelled = text[hint.start.line]!.slice(
                    hint.start.column,
                    hint.position.column
                )
                const first = spelled.indexOf(".Values.") + ".Values.".length
                const segments = spelled.slice(first).split(".")
                const depth = hint.path.length - segments.length
                let column = hint.start.column + first
                segments.forEach((segment, offset) => {
                    add({
                        fsPath,
                        start: { line: hint.start.line, column },
                        end: { line: hint.start.line, column: column + segment.length },
                        raw: segment,
                        release,
                        path: hint.path.slice(0, depth + offset + 1),
                        layerIndex: undefined
                    })
                    column += segment.length + 1
                })
                reads.push({
                    path: hint.path,
                    place: { fsPath, start: hint.start, end: hint.position }
                })
            }
            text.forEach((line, lineIndex) => {
                for (const match of line.matchAll(/\.Values\b(?!\.[A-Za-z_])/g)) {
                    const start = { line: lineIndex, column: match.index }
                    const end = { line: lineIndex, column: match.index + match[0].length }
                    wholeReads.push({ prefix, place: { fsPath, start, end } })
                }
            })
        }
    }
    index.reads.set(release.spec.id, reads)
    index.wholeReads.set(release.spec.id, wholeReads)
}

/** Tells why the plan cannot go ahead, or undefined where it can. */
function refusal(context: RenameContext, index: Index, plan: RenamePlan): string | undefined {
    const name = quote(plan.name)
    const cannot = (target: Target) => `The rename cannot change ${quote(target.path.join("."))}`
    for (const target of plan.targets) {
        const { release, path } = target
        const chart = `chart ${release.chart.name}`
        if (path.length === 1 && path[0] === "global")
            return `${cannot(target)}, since Helm hands the values under it to every dependency.`
        const dependency = release.chart.dependencies.find((each) => each.key === path[0])
        if (path.length === 1 && dependency !== undefined)
            return `${cannot(target)}, since ${chart} hands the values under it to a dependency. Change the alias of the dependency in its Chart.yaml.`
        const condition = release.chart.dependencies
            .flatMap((each) => each.conditions)
            .find((each) => startsWith(each.split("."), path))
        if (condition !== undefined)
            return `${cannot(target)}, since the Chart.yaml of ${chart} turns a dependency on and off with ${quote(condition)}.`
        if (schemaField(release.chart.schemas, path) !== undefined)
            return `${cannot(target)}, since a values.schema.json of ${chart} describes it. Rename it in the schema first.`
        const around = (index.reads.get(release.spec.id) ?? []).find(
            (read) => read.path.length < path.length && startsWith(path, read.path)
        )
        if (around !== undefined)
            return `${cannot(target)}, since ${where(context, around.place)} reads all of ${quote(around.path.join("."))} and would still render the old name.`
        const whole = (index.wholeReads.get(release.spec.id) ?? []).find((read) =>
            startsWith(path, read.prefix)
        )
        if (whole !== undefined)
            return `${cannot(target)}, since ${where(context, whole.place)} hands on all values as ${quote(".Values")}, which the rename cannot follow.`
        const placed = new Set(
            plan.occurrences
                .filter((each) => each.release === release && samePath(each.path, path))
                .map((each) => each.layerIndex)
        )
        const unplaced = release.trace.layers.findIndex(
            (layer, layerIndex) =>
                valueAt(layer.data, path) !== undefined && !placed.has(layerIndex)
        )
        if (unplaced >= 0)
            return `${cannot(target)}, since ${release.trace.layers[unplaced]!.label} of release ${releaseTitle(release.spec)} sets it in a place that the rename cannot edit.`
    }
    for (const occurrence of plan.occurrences) {
        const { release } = occurrence
        if (!context.editable(occurrence.fsPath)) {
            const owner = occurrence.fsPath.startsWith(release.chart.dir + "/")
                ? `chart ${release.chart.name}`
                : context.describe(occurrence.fsPath)
            return `The rename cannot change ${name}, since ${owner} sits outside the workspace.`
        }
        const line = index.lines(occurrence.fsPath)?.[occurrence.start.line]
        if (line?.slice(occurrence.start.column, occurrence.end.column) !== occurrence.raw)
            return `The rename cannot change ${name}, since ${where(context, occurrence)} does not spell it as the extension read it. Save the file and try again.`
    }
    const files = new Set(plan.occurrences.map((each) => each.fsPath))
    for (const spec of context.failed) {
        const read = [
            spec.appFile,
            ...spec.layers.flatMap((layer) => (layer.fsPath === undefined ? [] : [layer.fsPath]))
        ].find((fsPath) => fsPath !== undefined && files.has(fsPath))
        if (read !== undefined)
            return `The rename cannot change ${name}, since release ${releaseTitle(spec)} did not load and also reads ${context.describe(read)}.`
    }
    return undefined
}

/** Whether a layer, the chart or its schema of the release sets, reads or describes `path` or a key inside it. */
function usesPath(release: Release, path: ValuePath): boolean {
    if (path.length === 1 && path[0] === "global") return true
    if (release.trace.layers.some((layer) => valueAt(layer.data, path) !== undefined)) return true
    const key = pathKey(path)
    if ([...release.readPaths].some((read) => read === key || read.startsWith(key + "\u0000")))
        return true
    return schemaField(release.chart.schemas, path) !== undefined
}

function where(context: RenameContext, place: Place): string {
    return `line ${place.start.line + 1} of ${context.describe(place.fsPath)}`
}

function quote(text: string): string {
    return `\`${text}\``
}

function placeKey(place: Place): string {
    return `${place.fsPath}:${place.start.line}:${place.start.column}`
}

function targetKey(target: Target): string {
    return `${target.release.spec.id}\u0001${pathKey(target.path)}`
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
    const list = map.get(key)
    if (list === undefined) map.set(key, [value])
    else list.push(value)
}

function samePath(a: ValuePath, b: ValuePath): boolean {
    return a.length === b.length && startsWith(a, b)
}

function startsWith(path: ValuePath, prefix: ValuePath): boolean {
    return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment)
}
