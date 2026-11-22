import { relative } from "node:path"
import { isPlainMap, type Layer, type Setting, valueAt } from "./coalesce"
import { isUnknownKey, type Release, VALUES_READ } from "./release"
import { type KeySite, type Position, shifted, splitPathKey, type ValuePath } from "./yamlPaths"

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
        const setting = settingOf(release, layerIndex, path)
        if (setting === undefined) continue
        const at = site.valueEnd ?? { line: site.key.line, column: Number.MAX_SAFE_INTEGER }
        const by =
            setting.byLayerIndex === undefined
                ? ""
                : layerName(release, setting.byLayerIndex, fsPath)
        const final = valueAt(release.trace.final, path)
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
                JSON.stringify(final) === JSON.stringify(setting.value)
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

/** Builds a hint with the final value after each `.Values` path that a template of a release reads. */
export function templateHints(fsPath: string, text: string, releases: readonly Release[]): Hint[] {
    const hints: Hint[] = []
    const templated = releases.filter((release) => templatePrefix(fsPath, release) !== undefined)
    const lines = text.split("\n")
    for (const release of templated) {
        const prefix = templatePrefix(fsPath, release)!
        lines.forEach((line, lineIndex) => {
            for (const match of line.matchAll(VALUES_READ)) {
                const read = match[1]!.slice(1).split(".")
                const own = [...prefix, ...read]
                const global = read[0] === "global" ? valueAt(release.trace.final, read) : undefined
                const path = global === undefined ? own : read
                const final = valueAt(release.trace.final, path)
                const position = { line: lineIndex, column: match.index + match[0].length }
                const name = templated.length > 1 ? `${release.spec.name}: ` : ""
                hints.push({
                    start: { line: lineIndex, column: match.index },
                    position,
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

/** The key that the values of the chart holding `fsPath` sit under, or undefined for a file outside the templates of the release. */
export function templatePrefix(fsPath: string, release: Release): string[] | undefined {
    if (fsPath.startsWith(release.chart.dir + "/templates/")) return []
    const dependency = release.chart.dependencies.find(
        (candidate) =>
            !release.disabled.has(candidate.key) && fsPath.startsWith(candidate.dir + "/templates/")
    )
    return dependency === undefined ? undefined : [dependency.key]
}

/** The settings whose key or scalar value spans `position` in the file, for the hover. */
export function siteAt(
    fsPath: string,
    position: Position,
    releases: readonly Release[]
): SettingSite[] {
    return settingSites(fsPath, releases).filter((site) => {
        if (site.key.line !== position.line) return false
        return position.column >= site.key.column && position.column <= siteEnd(site).column
    })
}

/** The end of a setting on its key line: the end of a scalar value, or the end of the line for a map or a list. */
export function siteEnd(site: SettingSite): Position {
    return site.valueEnd !== undefined && site.valueEnd.line === site.key.line
        ? site.valueEnd
        : { line: site.key.line, column: Number.MAX_SAFE_INTEGER }
}

/**
 * Renders the chain of one path as Markdown, lowest layer first, with the final value on top.
 * With `allLayers`, the chart's own defaults and every layer above them appear, the ones that leave the path alone marked so.
 * The defaults of a dependency appear only where they set the path.
 */
export function chainMarkdown(
    release: Release,
    path: ValuePath,
    fromFile: string,
    allLayers = false
): string {
    const settings = release.trace.settings.get(path.join("\u0000")) ?? []
    const final = valueAt(release.trace.final, path)
    const lines = [
        `**${releaseTitle(release.spec)}** \`${path.join(".")}\` = \`${preview(final, 80)}\``,
        ""
    ]
    const chartDefaults = release.firstUserLayer - 1
    release.trace.layers.forEach((layer, layerIndex) => {
        const setting = settings.find((candidate) => candidate.layerIndex === layerIndex)
        const name = layerName(release, layerIndex, fromFile)
        if (setting === undefined) {
            if (!allLayers || layerIndex < chartDefaults) return
            const link =
                layer.fsPath === undefined ? name : `[${name}](file://${encodeURI(layer.fsPath)})`
            lines.push(`$(circle-large-outline) *not set* · ${link}`)
            return
        }
        const where = siteLink(release, layerIndex, path)
        lines.push(
            `${settingMark(setting, final)} · ${where === undefined ? name : `[${name}](${where})`}: \`${preview(setting.value, 60)}\``
        )
    })
    return lines.join("\n\n")
}

/** A codicon and a word for what became of a setting, for a Markdown string with theme icons on. */
function settingMark(setting: Setting, final: unknown): string {
    switch (setting.status) {
        case "wins":
            return "$(pass-filled) *final*"
        case "overridden":
            return JSON.stringify(final) === JSON.stringify(setting.value)
                ? "$(pass) *same as final*"
                : "$(circle-slash) *overridden*"
        case "replaced":
            return "$(replace) *replaced*"
        case "deleted":
            return "$(trash) *deleted*"
    }
}

function siteLink(release: Release, layerIndex: number, path: ValuePath): string | undefined {
    const layer = release.trace.layers[layerIndex]!
    const site = layer.sites.get(path.join("\u0000"))
    if (layer.fsPath === undefined || site === undefined) return undefined
    const key = layer.offset === undefined ? site.key : shifted(site.key, layer.offset)
    return `file://${encodeURI(layer.fsPath)}#L${key.line + 1}`
}

function settingOf(release: Release, layerIndex: number, path: ValuePath): Setting | undefined {
    return release.trace.settings
        .get(path.join("\u0000"))
        ?.find((setting) => setting.layerIndex === layerIndex)
}

function equalsDefault(release: Release, path: ValuePath, value: unknown): boolean {
    for (const layer of release.trace.layers.slice(0, release.firstUserLayer)) {
        const fallback = valueAt(layer.data, path)
        if (fallback !== undefined) return JSON.stringify(fallback) === JSON.stringify(value)
    }
    return false
}

/** Names a layer for a hint: an app file layer by its label, a values file by its path from the current file's folder. */
function layerName(release: Release, layerIndex: number, fromFile: string): string {
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
