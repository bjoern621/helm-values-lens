import { relative } from "node:path"
import { Document, isPair, isScalar, isSeq, visit } from "yaml"
import { releaseTitle } from "./hints"
import type { Release } from "./release"
import { pathKey } from "./yamlPaths"

/**
 * Prints the final values of a release as YAML.
 * Each scalar and list carries a comment naming the layer and line that set it.
 * A value that no layer set at its own path, such as an item of a list, carries no comment.
 */
export function annotatedFinalValues(release: Release, root: string): string {
    const document = new Document(release.trace.final)
    visit(document, {
        Pair(_, pair, ancestors) {
            if (!isScalar(pair.key) || !(isScalar(pair.value) || isSeq(pair.value))) return
            const path = [...ancestors.filter(isPair), pair].map((item) =>
                String((item.key as { value: unknown }).value)
            )
            const source = sourceOf(release, path, root)
            if (source === undefined) return
            if (isSeq(pair.value) && pair.value.items.length === 0) pair.value.flow = true
            pair.value.comment = ` ${source}`
        }
    })
    const header = [
        `# Final values of ${releaseTitle(release.spec)}, lowest layer first:`,
        ...release.trace.layers.map((layer, index) => `#   ${index}. ${layer.label}`),
        ""
    ].join("\n")
    return header + document.toString({ lineWidth: 0 })
}

function sourceOf(release: Release, path: string[], root: string): string | undefined {
    const winner = release.trace.settings
        .get(pathKey(path))
        ?.find((setting) => setting.status === "wins")
    if (winner === undefined) return undefined
    const layer = release.trace.layers[winner.layerIndex]!
    const site = layer.sites.get(pathKey(path))
    const line = site === undefined ? "" : `:${site.key.line + 1 + (layer.offset?.lineDelta ?? 0)}`
    const file =
        layer.fsPath === undefined
            ? layer.label
            : layer.kind === "file"
              ? relative(root, layer.fsPath)
              : layer.label
    return winner.layerIndex < release.firstUserLayer ? `${layer.label}` : `${file}${line}`
}
