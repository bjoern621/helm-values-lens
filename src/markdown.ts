import type { Setting } from "./coalesce"
import { sameValue, valueAt } from "./coalesce"
import { fileLink, layerName, preview, releaseTitle, siteLink } from "./hints"
import type { Release } from "./release"
import { type SchemaField, schemaField } from "./schema"
import { type Rendered, resourcesHolding } from "./render"
import { countOf, listed } from "./text"
import { dottedPath, pathKey, type ValuePath } from "./yamlPaths"

/** How many resources "Rendered in" names before it counts the rest. */
const RENDERED_IN_SHOWN = 5

export interface PathDetails {
    /** Lists every layer from the chart's own defaults up, the ones that leave the path alone included. */
    allLayers: boolean
    /** The last render of the release, which adds the resources that hold the final value. */
    rendered: Rendered | undefined
}

/**
 * Describes one path of one release as Markdown with theme icons.
 * The hover of a key, of a `.Values` read and the tooltip of an inlay hint all show this text.
 */
export function pathMarkdown(
    release: Release,
    path: ValuePath,
    fromFile: string,
    details: PathDetails
): string {
    const sections = [chainMarkdown(release, path, fromFile, details.allLayers)]
    const field = schemaField(release.chart.schemas, path)
    if (field !== undefined) sections.push(...schemaMarkdown(field))
    if (details.rendered !== undefined) {
        const holders = resourcesHolding(details.rendered, valueAt(release.trace.final, path))
        const names = holders.map((holder) => `\`${holder}\``)
        if (holders.length > 0) sections.push(`Rendered in ${listed(names, RENDERED_IN_SHOWN)}`)
    }
    return sections.join("\n\n")
}

/** What a `values.schema.json` says about one key: its description, then its type and the values that it allows. */
export function schemaMarkdown(field: SchemaField): string[] {
    const allowed = field.enum?.map((value) => `\`${JSON.stringify(value)}\``).join(", ")
    const facts = [
        field.type === undefined ? undefined : `\`${field.type}\``,
        allowed === undefined ? undefined : `one of ${allowed}`
    ].filter((fact) => fact !== undefined)
    return [
        ...(field.description === undefined ? [] : [field.description]),
        ...(facts.length === 0 ? [] : [`$(symbol-ruler) Schema: ${facts.join(" · ")}`])
    ]
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
    const settings = release.trace.settings.get(pathKey(path)) ?? []
    const final = valueAt(release.trace.final, path)
    const lines = [
        `**${releaseTitle(release.spec)}** \`${dottedPath(path)}\` = \`${preview(final, 80)}\``,
        ""
    ]
    const chartDefaults = release.firstUserLayer - 1
    release.trace.layers.forEach((layer, layerIndex) => {
        const setting = settings.find((candidate) => candidate.layerIndex === layerIndex)
        const name = layerName(release, layerIndex, fromFile)
        if (setting === undefined) {
            if (!allLayers || layerIndex < chartDefaults) return
            const link = layer.fsPath === undefined ? name : `[${name}](${fileLink(layer.fsPath)})`
            lines.push(`$(circle-small-filled) *not set* · ${link}`)
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
            return "$(verified-filled) *final*"
        case "overridden":
            return sameValue(final, setting.value)
                ? "$(pass-filled) *same as final*"
                : "$(circle-slash) *overridden*"
        case "replaced":
            return "$(replace) *replaced*"
        case "deleted":
            return "$(trash) *deleted*"
    }
}

/** What a render left of a release: its resources, the error of helm, or nothing yet. */
export type RenderState =
    { kind: "rendered"; rendered: Rendered } | { kind: "failed"; error: string } | { kind: "none" }

/**
 * Describes a release as Markdown for the hover of the line that names it.
 * The text names the chart, each values layer from the lowest up with a link and the resources of the last render.
 * The problems of the release stay out, since VS Code shows their diagnostics on the same line above the hover.
 */
export function releaseMarkdown(release: Release, fromFile: string, render: RenderState): string {
    const { chart } = release
    const lines = [
        `**${releaseTitle(release.spec)}** · ${release.spec.origin}`,
        `$(package) Chart [${chart.name} ${chart.version}](${fileLink(chart.dir + "/Chart.yaml")})`
    ]
    release.trace.layers.forEach((layer, layerIndex) => {
        if (layerIndex < release.firstUserLayer - 1) return
        const name = layerName(release, layerIndex, fromFile)
        const link = layer.fsPath === undefined ? name : `[${name}](${fileLink(layer.fsPath)})`
        const kind = layerIndex < release.firstUserLayer ? "chart defaults" : "values"
        lines.push(`$(layers) ${kind} · ${link}`)
    })
    if (render.kind === "rendered")
        lines.push(`$(file-code) Rendered ${countOf(render.rendered.resources.size, "resource")}`)
    return lines.join("\n\n")
}
