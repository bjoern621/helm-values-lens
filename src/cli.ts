// Prints the trace of every release under a folder: `node dist/cli.js <folder> [release]`.
// RENDER=1 renders each release as well.

import { homedir } from "node:os"
import { join, relative } from "node:path"
import { isPlainMap } from "./coalesce"
import { releaseTitle } from "./hints"
import { unknownKeys } from "./release"
import { renderRelease } from "./render"
import { dottedPath, splitPathKey } from "./yamlPaths"
import { discover } from "./workspace"
import { countOf } from "./text"

const [root = ".", only] = process.argv.slice(2)
const cacheDir = join(homedir(), ".cache", "helm-values-lens")

const show = (value: unknown) => {
    const text = JSON.stringify(value)
    return text === undefined ? "∅" : text.length > 40 ? text.slice(0, 39) + "…" : text
}

async function main(): Promise<void> {
    const discovery = await discover([root], cacheDir, "helm")
    const wanted = (name: string) => only === undefined || name === only
    for (const failure of discovery.failures) {
        if (!wanted(failure.spec.name)) continue
        console.log(`\n${releaseTitle(failure.spec)}: chart not loaded: ${failure.reason}`)
    }
    for (const release of discovery.releases) {
        const spec = release.spec
        if (!wanted(spec.name)) continue
        const layers = release.trace.layers
        console.log(
            `\n${releaseTitle(spec)} [${spec.origin}] (${relative(root, spec.appFile)}:${spec.appLine + 1})`
        )
        console.log(`  chart ${release.chart.name} at ${release.chart.dir}`)
        layers.forEach((layer, index) => console.log(`  ${index}. ${layer.label}`))
        for (const problem of release.problems) console.log(`  problem: ${problem}`)
        const renderError = discovery.renderErrors.get(spec.id)
        if (renderError !== undefined)
            console.log(`  could not render: ${renderError.replace(/\s*\n\s*/g, " ")}`)
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
        if (process.env.RENDER === "1" && !discovery.rendered.has(spec.id)) {
            try {
                const rendered = await renderRelease(release, "helm")
                console.log(`  rendered ${countOf(rendered.resources.size, "resource")}`)
            } catch (error) {
                console.log(`  could not render: ${String(error).split("\n")[0]}`)
            }
        }
    }
    console.log(
        `\n${countOf(discovery.releases.length, "release")} loaded, ${discovery.failures.length} not loaded, ${discovery.renderErrors.size} could not render`
    )
}

void main()
