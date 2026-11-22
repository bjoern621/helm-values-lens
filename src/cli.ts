// Prints the trace of every Argo CD release under a folder: `node dist/cli.js <folder> [application]`.

import { homedir } from "node:os"
import { join, relative } from "node:path"
import { isPlainMap } from "./coalesce"
import { unknownKeys } from "./release"
import { renderRelease } from "./render"
import { dottedPath, splitPathKey } from "./yamlPaths"
import { findReleases, loadRelease } from "./workspace"

const [root = ".", only] = process.argv.slice(2)
const cacheDir = join(homedir(), ".cache", "helm-values-lens")

const show = (value: unknown) => {
    const text = JSON.stringify(value)
    return text === undefined ? "∅" : text.length > 40 ? text.slice(0, 39) + "…" : text
}

async function main(): Promise<void> {
    for (const spec of findReleases([root])) {
        if (only !== undefined && spec.name !== only) continue
        let release
        try {
            release = await loadRelease(spec, cacheDir, "helm")
        } catch (error) {
            console.log(`\n${spec.name}: chart not loaded: ${String(error).split("\n")[0]}`)
            continue
        }
        const layers = release.trace.layers
        console.log(`\n${spec.name} (${relative(root, spec.appFile)})`)
        layers.forEach((layer, index) => console.log(`  ${index}. ${layer.label}`))
        for (const problem of release.problems) console.log(`  problem: ${problem}`)
        for (const [key, settings] of release.trace.settings) {
            const own = settings.filter((setting) => setting.layerIndex >= release.firstUserLayer)
            if (own.length === 0 || own.every((setting) => isPlainMap(setting.value))) continue
            const chain = settings
                .map(
                    (setting) =>
                        `${layers[setting.layerIndex]!.label}=${show(setting.value)}${setting.status === "wins" ? "" : ` (${setting.status})`}`
                )
                .join("  ")
            console.log(`  ${dottedPath(splitPathKey(key))}: ${chain}`)
        }
        for (const path of unknownKeys(release))
            console.log(`  unknown to the chart: ${dottedPath(path)}`)
        if (process.env.RENDER === "1") {
            try {
                const rendered = await renderRelease(release, "helm")
                console.log(`  rendered ${rendered.resources.size} resources`)
            } catch (error) {
                console.log(`  render failed: ${String(error).split("\n")[0]}`)
            }
        }
    }
}

void main()
