import { execFileSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { type CheckoutOf, normalizeRepoURL, readApplications, type ReleaseSpec } from "./argo"
import { chartDir, loadChart } from "./chart"
import type { LoadedChart } from "./chart"
import { buildRelease, type ReadText, readFromDisk, type Release } from "./release"

const SKIPPED_DIRS = new Set([".git", ".claude", "node_modules", ".direnv", "dist", "charts"])

/** Lists the YAML files under `root` that may hold an Argo CD Application. */
export function yamlFiles(root: string): string[] {
    const found: string[] = []
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRS.has(entry.name)) walk(join(dir, entry.name))
            } else if (/\.ya?ml$/.test(entry.name)) {
                found.push(join(dir, entry.name))
            }
        }
    }
    walk(root)
    return found
}

/** Maps the URL of each remote of the Git checkout at `root` to `root`. */
export function checkoutsOf(roots: readonly string[]): CheckoutOf {
    const checkouts = new Map<string, string>()
    for (const root of roots) {
        try {
            const remotes = execFileSync("git", ["-C", root, "remote", "-v"], { encoding: "utf8" })
            for (const line of remotes.split("\n")) {
                const url = line.split(/\s+/)[1]
                if (url !== undefined) checkouts.set(normalizeRepoURL(url), root)
            }
        } catch {
            // A folder outside Git maps no URL.
        }
    }
    return (repoURL) => checkouts.get(normalizeRepoURL(repoURL))
}

export function findReleases(
    roots: readonly string[],
    readText: ReadText = readFromDisk,
    checkoutOf: CheckoutOf = checkoutsOf(roots)
): ReleaseSpec[] {
    return roots.flatMap((root) =>
        yamlFiles(root).flatMap((file) => readApplications(file, readText(file), checkoutOf))
    )
}

/** Loads the chart of a release and merges its layers. `charts` keeps each chart that got loaded, by folder. */
export async function loadRelease(
    spec: ReleaseSpec,
    cacheDir: string,
    helmPath: string,
    readText: ReadText = readFromDisk,
    charts: Map<string, LoadedChart> = new Map()
): Promise<Release> {
    const dir = await chartDir(spec.chart, join(cacheDir, "charts"), helmPath)
    let chart = charts.get(dir)
    if (chart === undefined) {
        chart = loadChart(dir, cacheDir)
        charts.set(dir, chart)
    }
    return buildRelease(spec, chart, readText)
}
