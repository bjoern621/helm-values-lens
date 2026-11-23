import { relative } from "node:path"
import { isPlainMap, type Layer, sameValue, settingOf, valueAt } from "./coalesce"
import { chartDefault, isUnknownKey, type Release, VALUES_READ } from "./release"
import {
    type KeySite,
    pathKey,
    type Position,
    shifted,
    splitPathKey,
    type ValuePath
} from "./yamlPaths"

export type HintKind = "overridden" | "deleted" | "replaced" | "default" | "unknown" | "final"

/** A note that the editor shows at one place in a file. */
export interface Hint {
    /** Where the key or the `.Values` read that the hint describes begins. */
    start: Position
    position: Position
    kind: HintKind
    label: string
    release: Release
    path: ValuePath
}

/** Where one layer sets one path, in the coordinates of the file that holds it. */
export interface SettingSite {
    release: Release
    layerIndex: number
    path: ValuePath
    key: Position
    valueEnd: Position | undefined
}

/** A key or a `.Values` read under the cursor, with the span of its line that it covers. */
export interface Target {
    release: Release
    path: ValuePath
    start: Position
    end: Position
}

/** Lists every key that some layer of `releases` sets in the file at `fsPath`. */
export function settingSites(fsPath: string, releases: readonly Release[]): SettingSite[] {
    const sites: SettingSite[] = []
    for (const release of releases) {
        release.trace.layers.forEach((layer, layerIndex) => {
            if (layer.fsPath !== fsPath) return
            if (layer.kind === "inline" && layer.offset === undefined) return
            for (const [key, site] of layer.sites)
                sites.push(placed(release, layerIndex, key, site, layer))
        })
    }
    return sites
}

function placed(
    release: Release,
    layerIndex: number,
    key: string,
    site: KeySite,
    layer: Layer
): SettingSite {
    const offset = layer.offset
    return {
        release,
        layerIndex,
        path: splitPathKey(key),
        key: offset === undefined ? site.key : shifted(site.key, offset),
        valueEnd:
            site.valueEnd === undefined || offset === undefined
                ? site.valueEnd
                : shifted(site.valueEnd, offset)
    }
}

/**
 * Builds the hints for the values that `releases` read from the file at `fsPath`.
 * A setting that a later layer overrides, replaces or deletes names that layer and the final value.
 * A user setting equal to the chart default says so. A key that the chart neither defaults nor reads gets flagged.
 * Several releases reading one file each prefix their hints with their name.
 */
export function valueHints(fsPath: string, releases: readonly Release[]): Hint[] {
    const sites = settingSites(fsPath, releases)
    const names = new Set(sites.map((site) => site.release.spec.id))
    const prefix = (release: Release) => (names.size > 1 ? `${release.spec.name}: ` : "")
    const hints: Hint[] = []
    for (const site of sites) {
        const { release, layerIndex, path } = site
        const setting = settingOf(release.trace, layerIndex, path)
        if (setting === undefined) continue
        const by =
            setting.byLayerIndex === undefined
                ? ""
                : layerName(release, setting.byLayerIndex, fsPath)
        const final = valueAt(release.trace.final, path)
        const at = site.valueEnd ?? { line: site.key.line, column: Number.MAX_SAFE_INTEGER }
        const add = (kind: HintKind, label: string) =>
            hints.push({
                start: site.key,
                position: at,
                kind,
                label: prefix(release) + label,
                release,
                path
            })
        if (setting.status === "overridden")
            add(
                "overridden",
                sameValue(final, setting.value)
                    ? `also set by ${by}`
                    : `overridden by ${by}: ${preview(final)}`
            )
        else if (setting.status === "deleted") add("deleted", `deleted by ${by}`)
        else if (setting.status === "replaced") add("replaced", `replaced by ${by}`)
        else if (layerIndex >= release.firstUserLayer) {
            if (isUnknownKey(release, path)) add("unknown", "unknown to the chart")
            else if (!isPlainMap(setting.value) && equalsDefault(release, path, setting.value))
                add("default", "= chart default")
        }
    }
    return hints
}

/**
 * Builds a hint with the final value after each `.Values` path that a template of a release reads.
 * `firstLine` names the line of the file that `text` starts at.
 */
export function templateHints(
    fsPath: string,
    text: string,
    releases: readonly Release[],
    firstLine = 0
): Hint[] {
    const hints: Hint[] = []
    const templated = releases.filter((release) => templatePrefix(fsPath, release) !== undefined)
    const lines = text.split("\n")
    for (const release of templated) {
        const prefix = templatePrefix(fsPath, release)!
        lines.forEach((line, index) => {
            const lineIndex = firstLine + index
            for (const match of line.matchAll(VALUES_READ)) {
                const read = match[1]!.slice(1).split(".")
                const own = [...prefix, ...read]
                const global = read[0] === "global" ? valueAt(release.trace.final, read) : undefined
                const path = global === undefined ? own : read
                const final = valueAt(release.trace.final, path)
                const name = templated.length > 1 ? `${release.spec.name}: ` : ""
                hints.push({
                    start: { line: lineIndex, column: match.index },
                    position: { line: lineIndex, column: match.index + match[0].length },
                    kind: "final",
                    label: `${name}${preview(final)}`,
                    release,
                    path
                })
            }
        })
    }
    return hints
}

/**
 * Finds what the cursor at `position` points at on `lineText`: a key that a layer sets, or a `.Values` read of a template.
 * The order of `releases` carries over to the targets.
 * A `.Values` read inside the value of a key wins over the key, so that the cursor names one path.
 */
export function targetsAt(
    fsPath: string,
    lineText: string,
    position: Position,
    releases: readonly Release[]
): Target[] {
    const covers = (start: Position, end: Position) =>
        position.column >= start.column && position.column <= end.column
    const targets: Target[] = []
    for (const release of releases) {
        for (const site of settingSites(fsPath, [release])) {
            if (site.key.line !== position.line) continue
            const end = {
                line: position.line,
                column: Math.min(siteEnd(site).column, lineText.length)
            }
            if (covers(site.key, end))
                targets.push({ release, path: site.path, start: site.key, end })
        }
        for (const hint of templateHints(fsPath, lineText, [release], position.line))
            if (covers(hint.start, hint.position))
                targets.push({ release, path: hint.path, start: hint.start, end: hint.position })
    }
    const width = (target: Target) => target.end.column - target.start.column
    const narrowest = Math.min(...targets.map(width))
    return targets.filter((target) => width(target) === narrowest)
}

/** The key that the values of the chart holding `fsPath` sit under, or undefined for a file outside the templates of the release. */
export function templatePrefix(fsPath: string, release: Release): string[] | undefined {
    if (fsPath.startsWith(release.chart.dir + "/templates/")) return []
    const dependency = release.chart.dependencies.find(
        (candidate) =>
            !release.disabled.has(candidate.key) && fsPath.startsWith(candidate.dir + "/templates/")
    )
    return dependency === undefined ? undefined : [dependency.key]
}

/** The end of a setting on its key line: the end of a scalar value, or the end of the line for a map or a list. */
export function siteEnd(site: SettingSite): Position {
    return site.valueEnd !== undefined && site.valueEnd.line === site.key.line
        ? site.valueEnd
        : { line: site.key.line, column: Number.MAX_SAFE_INTEGER }
}

/** A `file://` link to the line where the layer at `layerIndex` sets `path`, or undefined where it sets nothing. */
export function siteLink(
    release: Release,
    layerIndex: number,
    path: ValuePath
): string | undefined {
    const layer = release.trace.layers[layerIndex]!
    const site = layer.sites.get(pathKey(path))
    if (layer.fsPath === undefined || site === undefined) return undefined
    const key = layer.offset === undefined ? site.key : shifted(site.key, layer.offset)
    return `${fileLink(layer.fsPath)}#L${key.line + 1}`
}

export function fileLink(fsPath: string): string {
    return `file://${encodeURI(fsPath)}`
}

function equalsDefault(release: Release, path: ValuePath, value: unknown): boolean {
    const fallback = chartDefault(release, path)
    return fallback !== undefined && sameValue(fallback, value)
}

/** Names a layer for a hint: an app file layer by its label, a values file by its path from the current file's folder. */
export function layerName(release: Release, layerIndex: number, fromFile: string): string {
    const layer = release.trace.layers[layerIndex]!
    if (layer.kind !== "file" || layer.fsPath === undefined) return layer.label
    const path = relative(fromFile.replace(/\/[^/]*$/, ""), layer.fsPath)
    return path.startsWith("../../") ? layer.label : path
}

/** Names a release after the release whose chart renders it, if any. */
export function releaseTitle(spec: { name: string; parent?: string }): string {
    return spec.parent === undefined ? spec.name : `${spec.parent} > ${spec.name}`
}

/** Shows a value in one short line: a string bare, a map or a list by its size. */
export function preview(value: unknown, width = 40): string {
    if (value === undefined) return "unset"
    if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${value.length} items]`
    if (isPlainMap(value)) {
        const keys = Object.keys(value).length
        return keys === 0 ? "{}" : `{${keys} keys}`
    }
    const text = typeof value === "string" ? (value === "" ? '""' : value) : JSON.stringify(value)
    const line = text.split("\n")[0]!
    return line.length > width || line !== text ? line.slice(0, width - 1) + "…" : line
}
