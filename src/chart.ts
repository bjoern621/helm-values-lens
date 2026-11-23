import { execFile, execFileSync } from "node:child_process"
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync
} from "node:fs"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { parse } from "yaml"
import type { ChartRef } from "./argo"
import type { Layer } from "./coalesce"
import { clock, type Log, SILENT, durationSince } from "./log"
import { type ChartSchema, readSchema } from "./schema"
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
    version: string
    /** The defaults of the chart and of each dependency, the dependencies first. */
    layers: Layer[]
    dependencies: Dependency[]
    /** The `values.schema.json` of the chart and of each dependency that has one. */
    schemas: ChartSchema[]
}

/** How long a download may take before it counts as failed. An unreachable registry otherwise holds discovery for minutes. */
const PULL_TIMEOUT_MS = 45_000

/**
 * How long a failed download stays failed before the next attempt, across restarts of VS Code.
 * A registry out of reach, such as one behind a VPN, would otherwise hold every start for `PULL_TIMEOUT_MS`.
 */
const PULL_RETRY_DELAY_MS = 60 * 60_000

const pulls = new Map<string, Promise<string>>()
interface FailedPull {
    at: number
    message: string
}

/** The failed downloads by target folder, read from and written to a file in their cache folder. */
const failedPulls = new Map<string, FailedPull>()
/** The cache folders whose file of failed downloads got read. */
const failuresRead = new Set<string>()

/**
 * Returns the folder of a chart, pulling a chart from a Helm repository into `cacheDir` once per version.
 * An OCI registry takes a `repoURL` without a scheme, as Argo CD writes it, or with `oci://`.
 * Releases that ask for one chart at once share one download.
 * A failed download fails again without a retry for `PULL_RETRY_DELAY_MS`, or until `forgetFailedPulls`.
 */
export async function chartDir(
    ref: ChartRef,
    cacheDir: string,
    helmPath: string,
    log: Log = SILENT
): Promise<string> {
    if (ref.kind === "directory") return ref.dir
    if (ref.kind === "unresolved") throw new Error(ref.reason)
    const target = join(cacheDir, safeName(`${ref.repoURL}_${ref.chart}_${ref.version}`))
    const chartFolder = join(target, ref.chart)
    if (existsSync(join(chartFolder, "Chart.yaml"))) return chartFolder
    readFailures(cacheDir)
    const failed = failedPulls.get(target)
    if (failed !== undefined && Date.now() - failed.at < PULL_RETRY_DELAY_MS)
        throw new Error(
            `${failed.message}. Last try at ${clock(failed.at)}. Reload Releases tries again.`
        )
    let pull = pulls.get(target)
    if (pull === undefined) {
        pull = loggedPull(ref, target, helmPath, log).finally(() => pulls.delete(target))
        pulls.set(target, pull)
    }
    await pull
    return chartFolder
}

/** Pulls a chart, writing the start, the duration and a failure to `log` and keeping a failure on disk. */
async function loggedPull(
    ref: { repoURL: string; chart: string; version: string },
    target: string,
    helmPath: string,
    log: Log
): Promise<string> {
    const cacheDir = dirname(target)
    const name = `${ref.chart} ${ref.version}`
    const started = Date.now()
    log.info(`Pulling ${name} from ${ref.repoURL}`)
    try {
        const dir = await pullChart(ref, target, helmPath)
        log.info(`Pulled ${name} in ${durationSince(started)}`)
        if (failedPulls.delete(target)) writeFailures(cacheDir)
        return dir
    } catch (error) {
        const { message } = error as Error
        failedPulls.set(target, { at: Date.now(), message })
        writeFailures(cacheDir)
        log.warn(
            `${message} (after ${durationSince(started)}). The next try waits until ${clock(Date.now() + PULL_RETRY_DELAY_MS)} or Reload Releases.`
        )
        throw error
    }
}

/** Lets the next `chartDir` for each chart in `cacheDir` download it again, failed before or not. */
export function forgetFailedPulls(cacheDir: string): void {
    for (const target of [...failedPulls.keys()])
        if (dirname(target) === cacheDir) failedPulls.delete(target)
    rmSync(failuresFile(cacheDir), { force: true })
}

function failuresFile(cacheDir: string): string {
    return join(cacheDir, "failed-pulls.json")
}

function readFailures(cacheDir: string): void {
    if (failuresRead.has(cacheDir)) return
    failuresRead.add(cacheDir)
    let saved: Record<string, FailedPull>
    try {
        saved = JSON.parse(readFileSync(failuresFile(cacheDir), "utf8")) as Record<
            string,
            FailedPull
        >
    } catch {
        return
    }
    for (const [target, failure] of Object.entries(saved))
        if (!failedPulls.has(target)) failedPulls.set(target, failure)
}

function writeFailures(cacheDir: string): void {
    const own = [...failedPulls].filter(([target]) => dirname(target) === cacheDir)
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(failuresFile(cacheDir), JSON.stringify(Object.fromEntries(own)))
}

async function pullChart(
    ref: { repoURL: string; chart: string; version: string },
    target: string,
    helmPath: string
): Promise<string> {
    const partial = `${target}.partial`
    rmSync(partial, { recursive: true, force: true })
    mkdirSync(partial, { recursive: true })
    const oci = !/^https?:\/\//.test(ref.repoURL)
    const registry = ref.repoURL.replace(/^oci:\/\//, "").replace(/\/$/, "")
    const args = oci
        ? ["pull", `oci://${registry}/${ref.chart}`]
        : ["pull", ref.chart, "--repo", ref.repoURL]
    if (ref.version !== "") args.push("--version", ref.version)
    args.push("--untar", "--untardir", partial)
    try {
        await run(helmPath, args, { timeout: PULL_TIMEOUT_MS })
    } catch (error) {
        rmSync(partial, { recursive: true, force: true })
        const { stderr, killed } = error as { stderr?: string; killed?: boolean }
        const reason = killed
            ? `no answer within ${PULL_TIMEOUT_MS / 1000} s`
            : (stderr
                  ?.trim()
                  .replace(/^Error: /, "")
                  .split("\n")[0] ?? String(error))
        throw new Error(
            `${ref.chart} ${ref.version} did not download from ${ref.repoURL}: ${reason}`
        )
    }
    rmSync(target, { recursive: true, force: true })
    renameSync(partial, target)
    return target
}

/** Reads the defaults of a chart and of the charts in its `charts/` folder. */
export function loadChart(dir: string, cacheDir: string): LoadedChart {
    const meta = (parse(readFileSync(join(dir, "Chart.yaml"), "utf8")) ?? {}) as {
        name?: string
        version?: string
        dependencies?: { name: string; alias?: string; condition?: string; tags?: string[] }[]
    }
    const name = meta.name ?? dir
    const layers: Layer[] = []
    const dependencies: Dependency[] = []
    const schemas: ChartSchema[] = []
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
                const schema = readSchema(subDir, [key], `${key} values.schema.json`)
                if (schema !== undefined) schemas.push(schema)
            }
        }
    }
    layers.push(defaultsLayer(dir, "chart values.yaml", "chart"))
    const schema = readSchema(dir, [], "values.schema.json")
    if (schema !== undefined) schemas.push(schema)
    return { dir, name, version: String(meta.version ?? ""), layers, dependencies, schemas }
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
