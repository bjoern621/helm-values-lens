import { execFile, execFileSync } from "node:child_process"
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync
} from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { parse } from "yaml"
import type { ChartRef } from "./argo"
import type { Layer } from "./coalesce"
import { type KeySite, parseValues, pathKey } from "./yamlPaths"

const run = promisify(execFile)

/** A chart in the `charts/` folder of another. */
export interface Dependency {
    /** The key that its values sit under in the parent: its alias or its name. */
    key: string
    dir: string
    /** The index of its defaults in `LoadedChart.layers`. */
    layerIndex: number
    /** Paths whose first boolean value turns the dependency on or off. */
    conditions: string[]
    tags: string[]
}

/** A chart on disk with the charts that it depends on. */
export interface LoadedChart {
    dir: string
    name: string
    /** The defaults of the chart and of each dependency, the dependencies first. */
    layers: Layer[]
    dependencies: Dependency[]
}

/**
 * Returns the folder of a chart, pulling a chart from a Helm repository into `cacheDir` once per version.
 * An OCI registry takes a `repoURL` without a scheme, as Argo CD writes it.
 */
export async function chartDir(ref: ChartRef, cacheDir: string, helmPath: string): Promise<string> {
    if (ref.kind === "directory") return ref.dir
    if (ref.kind === "unresolved") throw new Error(ref.reason)
    const target = join(cacheDir, safeName(`${ref.repoURL}_${ref.chart}_${ref.version}`))
    const chartFolder = join(target, ref.chart)
    if (existsSync(join(chartFolder, "Chart.yaml"))) return chartFolder
    const partial = `${target}.partial`
    rmSync(partial, { recursive: true, force: true })
    mkdirSync(partial, { recursive: true })
    const oci = !/^https?:\/\//.test(ref.repoURL)
    const args = oci
        ? ["pull", `oci://${ref.repoURL.replace(/\/$/, "")}/${ref.chart}`]
        : ["pull", ref.chart, "--repo", ref.repoURL]
    if (ref.version !== "") args.push("--version", ref.version)
    args.push("--untar", "--untardir", partial)
    await run(helmPath, args, { timeout: 120_000 })
    rmSync(target, { recursive: true, force: true })
    renameSync(partial, target)
    return chartFolder
}

/** Reads the defaults of a chart and of the charts in its `charts/` folder. */
export function loadChart(dir: string, cacheDir: string): LoadedChart {
    const meta = (parse(readFileSync(join(dir, "Chart.yaml"), "utf8")) ?? {}) as {
        name?: string
        dependencies?: { name: string; alias?: string; condition?: string; tags?: string[] }[]
    }
    const name = meta.name ?? dir
    const layers: Layer[] = []
    const dependencies: Dependency[] = []
    const chartsDir = join(dir, "charts")
    if (existsSync(chartsDir)) {
        for (const entry of readdirSync(chartsDir, { withFileTypes: true })) {
            const subDir = entry.isDirectory()
                ? join(chartsDir, entry.name)
                : entry.name.endsWith(".tgz")
                  ? unpackedDependency(join(chartsDir, entry.name), cacheDir)
                  : undefined
            if (subDir === undefined || !existsSync(join(subDir, "Chart.yaml"))) continue
            const subName = String(
                (parse(readFileSync(join(subDir, "Chart.yaml"), "utf8")) as { name?: string })
                    .name ?? entry.name
            )
            const declared =
                meta.dependencies?.filter((dependency) => dependency.name === subName) ?? []
            for (const declaration of declared.length > 0 ? declared : [{ name: subName }]) {
                const key = declaration.alias ?? declaration.name
                dependencies.push({
                    key,
                    dir: subDir,
                    layerIndex: layers.length,
                    conditions: (declaration.condition ?? "")
                        .split(",")
                        .map((condition) => condition.trim())
                        .filter((condition) => condition !== ""),
                    tags: declaration.tags ?? []
                })
                const layer = defaultsLayer(subDir, `${key} chart values.yaml`, "subchart")
                layers.push(nestedUnder(layer, key))
            }
        }
    }
    layers.push(defaultsLayer(dir, "chart values.yaml", "chart"))
    return { dir, name, layers, dependencies }
}

function defaultsLayer(dir: string, label: string, kind: "chart" | "subchart"): Layer {
    const fsPath = join(dir, "values.yaml")
    const text = existsSync(fsPath) ? readFileSync(fsPath, "utf8") : ""
    const parsed = parseValues(text)
    return { kind, label, fsPath, offset: undefined, data: parsed.data ?? {}, sites: parsed.sites }
}

/**
 * Moves the defaults of a dependency under its key in the parent, its `global` included.
 * Helm copies the globals of the parent over the globals of the dependency at render time, which the trace leaves out.
 */
function nestedUnder(layer: Layer, key: string): Layer {
    const sites = new Map<string, KeySite>()
    for (const [path, site] of layer.sites) sites.set(pathKey([key]) + "\u0000" + path, site)
    return { ...layer, data: { [key]: layer.data ?? {} }, sites }
}

/**
 * Unpacks a packaged dependency into `cacheDir`, once per archive path and modification time.
 * Helm would read an unpacked copy inside `charts/` as a second dependency.
 */
function unpackedDependency(archive: string, cacheDir: string): string | undefined {
    const target = join(
        cacheDir,
        "dependencies",
        safeName(`${archive}_${statSync(archive).mtimeMs}`)
    )
    if (!existsSync(target)) {
        mkdirSync(target, { recursive: true })
        execFileSync("tar", ["-xzf", archive, "-C", target, "--strip-components=1"])
    }
    return target
}

function safeName(text: string): string {
    return text.replace(/^[a-z]+:\/\//, "").replace(/[^\w.-]+/g, "_")
}
