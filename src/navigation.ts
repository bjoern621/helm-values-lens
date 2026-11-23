import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { LayerSource, ReleaseSpec } from "./argo"
import { templateHints } from "./hints"
import { type Release, templateFiles } from "./release"
import { pathKey, type Position, shifted, type ValuePath } from "./yamlPaths"

/** A span of a file that the editor jumps to or underlines. */
export interface Place {
    fsPath: string
    start: Position
    end: Position
}

/**
 * Where the value of `path` that the release ends up with gets set: the line of the last layer that sets it, the chart defaults included.
 * Undefined where that layer sits in no file, such as a parameter given on the command line.
 * Where no layer sets the path itself, the place of the nearest map around it in the last layer that writes the map out.
 * A parameter such as `podAnnotations.team=x` sets the map without a line of its own.
 */
export function winningPlace(release: Release, path: ValuePath): Place | undefined {
    const settings = release.trace.settings.get(pathKey(path))
    if (settings !== undefined) return settingPlace(release, settings.at(-1)!.layerIndex, path)
    for (let length = path.length - 1; length > 0; length--) {
        const map = path.slice(0, length)
        const places = settingPlaces(release, map)
        if (places.length > 0) return places.at(-1)
    }
    return undefined
}

/** Where the chart or one of its dependencies sets the default of `path`, or undefined for a path without a default. */
export function defaultPlace(release: Release, path: ValuePath): Place | undefined {
    const defaults = (release.trace.settings.get(pathKey(path)) ?? []).filter(
        (setting) => setting.layerIndex < release.firstUserLayer
    )
    const last = defaults.at(-1)
    return last === undefined ? undefined : settingPlace(release, last.layerIndex, path)
}

/** Every place where a layer of the release sets `path`, lowest layer first. */
export function settingPlaces(release: Release, path: ValuePath): Place[] {
    return (release.trace.settings.get(pathKey(path)) ?? []).flatMap((setting) => {
        const place = settingPlace(release, setting.layerIndex, path)
        return place === undefined ? [] : [place]
    })
}

/**
 * Every `.Values` read in the templates of the chart and its dependencies that takes the value of `path`.
 * `exact` keeps the reads of the path itself.
 * Otherwise a read of a map around the path counts too, such as `toYaml .Values.image` for `image.tag`.
 * A read of a key inside the path counts as well.
 */
export function templateReadPlaces(release: Release, path: ValuePath, exact: boolean): Place[] {
    const places: Place[] = []
    for (const dir of templateDirs(release)) {
        for (const fsPath of templateFiles(join(dir, "templates"))) {
            let text: string
            try {
                text = readFileSync(fsPath, "utf8")
            } catch {
                continue
            }
            for (const hint of templateHints(fsPath, text, [release])) {
                const related = exact
                    ? samePath(hint.path, path)
                    : startsWith(hint.path, path) || startsWith(path, hint.path)
                if (related) places.push({ fsPath, start: hint.start, end: hint.position })
            }
        }
    }
    return places
}

/** The folders of the chart and of each dependency that the release turns on. */
export function templateDirs(release: Release): string[] {
    return [
        release.chart.dir,
        ...release.chart.dependencies
            .filter((dependency) => !release.disabled.has(dependency.key))
            .map((dependency) => dependency.dir)
    ]
}

/** A values file that a deployment file names, with the span of its name in that file. */
export interface FileLink extends Place {
    target: string
}

/**
 * Finds each values file that the releases described in `fsPath` take, where `text` names it as written in the release.
 * A name built by a template expression, such as `values-{{ .Environment.Name }}.yaml`, matches no text and gets no link.
 */
export function valueFileLinks(
    fsPath: string,
    text: string,
    specs: readonly ReleaseSpec[]
): FileLink[] {
    const targets = new Map<string, string>()
    for (const spec of specs) {
        if (spec.appFile !== fsPath) continue
        for (const layer of spec.layers) if (isLinkable(layer)) targets.set(layer.raw, layer.fsPath)
    }
    const links: FileLink[] = []
    text.split("\n").forEach((line, index) => {
        for (const [raw, target] of targets) {
            for (const column of scalarColumns(line, raw))
                links.push({
                    fsPath,
                    target,
                    start: { line: index, column },
                    end: { line: index, column: column + raw.length }
                })
        }
    })
    return links
}

function isLinkable(
    layer: LayerSource
): layer is Extract<LayerSource, { kind: "file" }> & { fsPath: string } {
    return layer.kind === "file" && layer.fsPath !== undefined && layer.raw !== ""
}

/** The columns where `raw` stands as a whole YAML scalar on `line`: after a colon, a dash, a bracket or a comma, inside quotes or bare. */
function scalarColumns(line: string, raw: string): number[] {
    const columns: number[] = []
    for (let from = line.indexOf(raw); from >= 0; from = line.indexOf(raw, from + 1)) {
        const before = line.slice(0, from).replace(/["']$/, "").trimEnd()
        const after = line
            .slice(from + raw.length)
            .replace(/^["']/, "")
            .trimStart()
        if (/(^|[:\-[,])$/.test(before) && /^($|[,\]#])/.test(after)) columns.push(from)
    }
    return columns
}

function settingPlace(release: Release, layerIndex: number, path: ValuePath): Place | undefined {
    const layer = release.trace.layers[layerIndex]!
    const site = layer.sites.get(pathKey(path))
    if (layer.fsPath === undefined || site === undefined) return undefined
    if (layer.kind === "inline" && layer.offset === undefined) return undefined
    const start = layer.offset === undefined ? site.key : shifted(site.key, layer.offset)
    return {
        fsPath: layer.fsPath,
        start,
        end: { line: start.line, column: start.column + (path.at(-1)?.length ?? 0) }
    }
}

function samePath(a: ValuePath, b: ValuePath): boolean {
    return a.length === b.length && startsWith(a, b)
}

/** True if `path` equals `prefix` or lies inside it. */
function startsWith(path: ValuePath, prefix: ValuePath): boolean {
    return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment)
}
