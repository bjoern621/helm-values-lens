import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, isAbsolute, join, normalize, resolve, sep } from "node:path"
import { parseDocument } from "yaml"
import {
    type CheckoutOf,
    type LayerSource,
    normalizeRepoURL,
    readApplications,
    type ReleaseSpec
} from "./argo"
import { chartDir, loadChart } from "./chart"
import type { LoadedChart } from "./chart"
import { placeReleases } from "./hints"
import { buildRelease, type ReadText, readFromDisk, type Release } from "./release"
import { firstLine } from "./text"
import { type Rendered, renderRelease } from "./render"
import { readApplicationSets } from "./sources/applicationSet"
import { readFluxHelmReleases } from "./sources/flux"
import { readHelmfile } from "./sources/helmfile"
import { readKustomizeHelmCharts } from "./sources/kustomize"
import type { SourceContext, SourceReader, WorkspaceFile } from "./sources/types"

/** Folders that hold no release: build output and dependencies. Hidden folders get skipped as well. */
/** The files that may describe a release: YAML, Helmfile templates and a kustomization without extension. */
export const RELEASE_FILE = /(\.ya?ml|\.gotmpl|^Kustomization)$/
const SKIPPED_DIRS = new Set(["node_modules", "dist", "out", "target", "vendor"])

/** How deep Applications that a chart renders may nest, counting the release that renders the first ones. */
const MAX_APPLICATION_DEPTH = 4

/** How many releases discovery loads and renders at once. */
const DISCOVERY_CONCURRENCY = 6

/** A chart folder in the workspace. */
export interface WorkspaceChart {
    dir: string
    name: string
    version: string
    /** A library chart renders nothing of its own. */
    library: boolean
    /** The values files beside `values.yaml`, such as `values-prod.yaml`, each naming one environment. */
    environmentFiles: string[]
}

/** What one walk over the workspace found. */
export interface WorkspaceIndex {
    /** The YAML files outside the templates and dependency folders of a chart. */
    files: string[]
    charts: WorkspaceChart[]
    /** Every folder walked, to match a repository URL by the end of its path. */
    dirs: string[]
    /** Every folder that holds a Git checkout, nested ones included. */
    checkouts: string[]
}

/** A release that the `helmValuesLens.releases` setting describes. */
export interface ConfiguredRelease {
    name: string
    /** A chart folder, relative to the first workspace folder. */
    chart: string
    /** Values files in the order that Helm takes them, relative to the first workspace folder. */
    valueFiles?: string[]
    /** Values as `--set` passes them, keyed by their dotted path. */
    set?: Record<string, string | number | boolean>
    namespace?: string
    releaseName?: string
}

export interface DiscoveryOptions {
    readText?: ReadText
    checkoutOf?: CheckoutOf
    /** Repository URLs mapped to folders, for a checkout whose remote names another URL. */
    repositories?: Record<string, string>
    configured?: readonly ConfiguredRelease[]
    /** Readers besides the built-in ones. */
    readers?: readonly SourceReader[]
}

/** Walks the workspace once and lists its YAML files, charts and Git checkouts. */
export function indexWorkspace(roots: readonly string[]): WorkspaceIndex {
    const index: WorkspaceIndex = { files: [], charts: [], dirs: [], checkouts: [] }
    const walk = (dir: string) => {
        index.dirs.push(dir)
        let entries
        try {
            entries = readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        const isChart = entries.some((entry) => entry.isFile() && entry.name === "Chart.yaml")
        if (isChart)
            index.charts.push(
                workspaceChart(
                    dir,
                    entries.map((entry) => entry.name)
                )
            )
        for (const entry of entries) {
            if (entry.name === ".git") {
                index.checkouts.push(dir)
                continue
            }
            if (entry.isDirectory()) {
                if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue
                // Helm renders the templates of a chart. Its `charts/` folder holds its dependencies.
                if (isChart && (entry.name === "templates" || entry.name === "charts")) continue
                walk(join(dir, entry.name))
            } else if (RELEASE_FILE.test(entry.name)) {
                index.files.push(join(dir, entry.name))
            }
        }
    }
    for (const root of roots) walk(root)
    return index
}

function workspaceChart(dir: string, names: string[]): WorkspaceChart {
    let meta: { name?: string; version?: string; type?: string } = {}
    try {
        meta = (parseDocument(readFileSync(join(dir, "Chart.yaml"), "utf8")).toJSON() ??
            {}) as typeof meta
    } catch {
        // A broken Chart.yaml still marks a chart folder.
    }
    return {
        dir,
        name: String(meta.name ?? basename(dir)),
        version: String(meta.version ?? ""),
        library: meta.type === "library",
        environmentFiles: names
            .filter((name) => /^values[-_.].+\.ya?ml$/i.test(name))
            .sort()
            .map((name) => join(dir, name))
    }
}

/** Whether a template of the chart at `dir` holds an Argo CD Application. */
export function rendersApplications(dir: string): boolean {
    const walk = (folder: string): boolean => {
        if (!existsSync(folder)) return false
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
            const path = join(folder, entry.name)
            if (entry.isDirectory() ? walk(path) : holdsApplication(readFileSync(path, "utf8")))
                return true
        }
        return false
    }
    return walk(join(dir, "templates"))
}

function holdsApplication(text: string): boolean {
    return text.includes("argoproj.io") && /kind:\s*Application\b/.test(text)
}

const remotes = new Map<string, { stamp: number; urls: string[] }>()

/** The remote URLs of a checkout, read again once its `.git/config` changes. */
function remotesOf(checkout: string): string[] {
    let stamp = -1
    try {
        stamp = statSync(join(checkout, ".git", "config")).mtimeMs
    } catch {
        // A worktree keeps its config elsewhere, so its remotes get read on every call.
    }
    const known = remotes.get(checkout)
    if (known !== undefined && stamp !== -1 && known.stamp === stamp) return known.urls
    let urls: string[] = []
    try {
        const output = execFileSync("git", ["-C", checkout, "remote", "-v"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        })
        urls = output.split("\n").flatMap((line) => line.split(/\s+/)[1] ?? [])
    } catch {
        // A broken checkout maps no URL.
    }
    remotes.set(checkout, { stamp, urls })
    return urls
}

/**
 * Maps a repository URL to the folder of its checkout.
 * The `repositories` setting goes first, then the remotes of every checkout in the workspace.
 * Last comes the one folder whose path ends with the path of the URL, so `https://git.example.com/team/apps/web.git` finds `…/apps/web`.
 */
export function checkoutsOf(
    index: WorkspaceIndex,
    repositories: Record<string, string> = {},
    roots: readonly string[] = []
): CheckoutOf {
    const byRemote = new Map<string, string>()
    for (const checkout of index.checkouts) {
        for (const url of remotesOf(checkout))
            if (!byRemote.has(normalizeRepoURL(url))) byRemote.set(normalizeRepoURL(url), checkout)
    }
    const root = roots[0] ?? "/"
    const configured = new Map<string, string>()
    for (const [url, folder] of Object.entries(repositories))
        configured.set(normalizeRepoURL(url), isAbsolute(folder) ? folder : join(root, folder))
    const found = new Map<string, string | undefined>()
    return (repoURL) => {
        const key = normalizeRepoURL(repoURL)
        if (key === "") return undefined
        if (!found.has(key))
            found.set(key, configured.get(key) ?? byRemote.get(key) ?? folderEndingWith(index, key))
        return found.get(key)
    }
}

/** The one folder whose path ends with the longest tail of the URL path. Two folders matching the same tail match nothing. */
function folderEndingWith(index: WorkspaceIndex, key: string): string | undefined {
    const segments = key.split("/").slice(1)
    for (let length = segments.length; length >= 1; length--) {
        const tail = sep + segments.slice(-length).join(sep)
        const matches = index.dirs.filter((dir) => dir.toLowerCase().endsWith(tail))
        if (matches.length === 1) return matches[0]
        if (matches.length > 1) return undefined
    }
    return undefined
}

const argoReader: SourceReader = (file, context) =>
    readApplications(file.fsPath, file.text, context.checkoutOf)

const DEFAULT_READERS: readonly SourceReader[] = [
    argoReader,
    readApplicationSets,
    readHelmfile,
    readFluxHelmReleases,
    readKustomizeHelmCharts
]

/**
 * Lists the releases that the files of the workspace describe, without rendering anything.
 * A chart that no release uses gets one release with its defaults and one per values file beside `values.yaml`.
 */
export function findReleases(
    roots: readonly string[],
    readText: ReadText = readFromDisk,
    checkoutOf?: CheckoutOf,
    options: DiscoveryOptions = {}
): ReleaseSpec[] {
    const { specs, index } = discoverSpecs(roots, { ...options, readText, checkoutOf })
    return [...specs, ...chartReleases(index, specs)]
}

function discoverSpecs(
    roots: readonly string[],
    options: DiscoveryOptions
): { specs: ReleaseSpec[]; index: WorkspaceIndex; checkoutOf: CheckoutOf } {
    const readText = options.readText ?? readFromDisk
    const index = indexWorkspace(roots)
    const checkoutOf = options.checkoutOf ?? checkoutsOf(index, options.repositories, roots)
    const files: WorkspaceFile[] = []
    for (const fsPath of index.files) {
        try {
            files.push({ fsPath, text: readText(fsPath) })
        } catch {
            // A file that vanished since the walk holds no release.
        }
    }
    const context: SourceContext = { files, checkoutOf }
    const readers = [...DEFAULT_READERS, ...(options.readers ?? [])]
    const specs: ReleaseSpec[] = []
    for (const file of files) {
        for (const reader of readers) {
            try {
                specs.push(...reader(file, context))
            } catch {
                // A file that a reader cannot parse describes no release for that reader.
            }
        }
    }
    specs.push(...configuredReleases(options.configured ?? [], roots))
    return { specs: preferWorkspaceCharts(specs, index), index, checkoutOf }
}

function configuredReleases(
    configured: readonly ConfiguredRelease[],
    roots: readonly string[]
): ReleaseSpec[] {
    const root = roots[0] ?? "/"
    const inRoot = (path: string) => (isAbsolute(path) ? path : normalize(join(root, path)))
    const settingsFile = join(root, ".vscode", "settings.json")
    return configured.map((entry, index) => {
        const layers: LayerSource[] = (entry.valueFiles ?? []).map((raw) => ({
            kind: "file",
            label: raw,
            fsPath: inRoot(raw),
            raw
        }))
        const set = Object.entries(entry.set ?? {})
        if (set.length > 0)
            layers.push({
                kind: "parameters",
                label: "set",
                fsPath: settingsFile,
                parameters: set.map(([name, value]) => ({ name, value: String(value) })),
                sites: new Map()
            })
        return {
            id: `setting:${index}:${entry.name}`,
            name: entry.name,
            origin: "helmValuesLens.releases setting",
            appFile: join(inRoot(entry.chart), "Chart.yaml"),
            appLine: 0,
            releaseName: entry.releaseName ?? entry.name,
            namespace: entry.namespace,
            chart: { kind: "directory", dir: inRoot(entry.chart) },
            layers
        }
    })
}

/** One release with the defaults of each chart that no other release uses, and one per environment file beside its `values.yaml`. */
function chartReleases(
    index: WorkspaceIndex,
    specs: readonly ReleaseSpec[],
    loadedDirs: readonly string[] = []
): ReleaseSpec[] {
    const usedDirs = new Set([
        ...specs.flatMap((spec) =>
            spec.chart.kind === "directory" ? [resolve(spec.chart.dir)] : []
        ),
        ...loadedDirs.map((dir) => resolve(dir))
    ])
    const usedNames = new Set(
        specs.flatMap((spec) => (spec.chart.kind === "repository" ? [spec.chart.chart] : []))
    )
    const releases: ReleaseSpec[] = []
    for (const chart of index.charts) {
        if (chart.library || usedDirs.has(resolve(chart.dir)) || usedNames.has(chart.name)) continue
        const chartFile = join(chart.dir, "Chart.yaml")
        releases.push({
            id: `${chartFile}:defaults`,
            name: chart.name,
            origin: "Chart defaults",
            appFile: chartFile,
            appLine: nameLine(chartFile),
            releaseName: chart.name,
            namespace: undefined,
            chart: { kind: "directory", dir: chart.dir },
            layers: []
        })
        for (const file of chart.environmentFiles) {
            const environment = basename(file).replace(/^values[-_.]|\.ya?ml$/gi, "")
            releases.push({
                id: `${file}:environment`,
                name: `${chart.name} (${environment})`,
                origin: "Values file beside the chart",
                appFile: file,
                appLine: 0,
                releaseName: chart.name,
                namespace: undefined,
                chart: { kind: "directory", dir: chart.dir },
                layers: [{ kind: "file", label: basename(file), fsPath: file, raw: basename(file) }]
            })
        }
    }
    return releases
}

function nameLine(chartFile: string): number {
    try {
        const line = readFileSync(chartFile, "utf8")
            .split("\n")
            .findIndex((text) => /^name:/.test(text))
        return Math.max(line, 0)
    } catch {
        return 0
    }
}

/**
 * Takes the chart from the workspace for a release that names a chart of the same name and version from a repository.
 * Its templates then show the values of the release, and no download happens.
 */
function preferWorkspaceCharts(specs: ReleaseSpec[], index: WorkspaceIndex): ReleaseSpec[] {
    return specs.map((spec) => {
        const ref = spec.chart
        if (ref.kind !== "repository") return spec
        const local = index.charts.find(
            (chart) => chart.name === ref.chart && chart.version === ref.version
        )
        return local === undefined
            ? spec
            : { ...spec, chart: { kind: "directory", dir: local.dir } }
    })
}

/**
 * Loads the chart of a release and merges its layers. `charts` keeps each chart that got loaded, by folder.
 * A chart that does not download falls back to a chart of the same name in `workspaceCharts`, with a problem naming both versions.
 */
export async function loadRelease(
    spec: ReleaseSpec,
    cacheDir: string,
    helmPath: string,
    readText: ReadText = readFromDisk,
    charts: Map<string, LoadedChart> = new Map(),
    workspaceCharts: readonly WorkspaceChart[] = []
): Promise<Release> {
    let dir: string
    let fallback: string | undefined
    try {
        dir = await chartDir(spec.chart, join(cacheDir, "charts"), helmPath)
    } catch (error) {
        const ref = spec.chart
        if (ref.kind !== "repository") throw error
        const local = workspaceCharts.find((chart) => chart.name === ref.chart)
        if (local === undefined) throw error
        dir = local.dir
        fallback = `${firstLine(error)}. The trace uses the chart ${local.name} ${local.version} from the workspace.`
    }
    let chart = charts.get(dir)
    if (chart === undefined) {
        chart = loadChart(dir, cacheDir)
        charts.set(dir, chart)
    }
    const release = buildRelease(spec, chart, readText)
    if (fallback !== undefined) release.problems.unshift(fallback)
    return release
}

/** A release that did not load, with the reason. */
export interface Failure {
    spec: ReleaseSpec
    reason: string
}

export interface Discovery {
    releases: Release[]
    failures: Failure[]
    /** The renders that discovery ran to find Applications, by release id. */
    rendered: Map<string, Rendered>
    renderErrors: Map<string, string>
    index: WorkspaceIndex
}

/**
 * Finds every release of the workspace and loads it.
 * A release whose chart renders Argo CD Applications gets rendered. Each Application in the output becomes a release of its own.
 */
export async function discover(
    roots: readonly string[],
    cacheDir: string,
    helmPath: string,
    options: DiscoveryOptions & {
        charts?: Map<string, LoadedChart>
        /** Renders of an earlier discovery, taken in place of rendering the same release again. */
        renders?: ReadonlyMap<string, Rendered>
        /** Called after each release loads. The total grows as renders turn up Applications. */
        onProgress?: (done: number, total: number) => void
    } = {}
): Promise<Discovery> {
    const readText = options.readText ?? readFromDisk
    const charts = options.charts ?? new Map<string, LoadedChart>()
    const { specs, index, checkoutOf } = discoverSpecs(roots, options)
    const discovery: Discovery = {
        releases: [],
        failures: [],
        rendered: new Map(),
        renderErrors: new Map(),
        index
    }
    const seen = new Set<string>()
    const progress = { done: 0, total: 0 }
    const report = () => options.onProgress?.(progress.done, progress.total)
    const rendersApps = new Map<string, boolean>()
    /** Loads a release and renders a chart that renders Applications, handing back the Applications it found. */
    const visit = async (spec: ReleaseSpec, depth: number): Promise<ReleaseSpec[]> => {
        let release: Release
        try {
            release = await loadRelease(spec, cacheDir, helmPath, readText, charts, index.charts)
        } catch (error) {
            discovery.failures.push({ spec, reason: firstLine(error) })
            return []
        }
        discovery.releases.push(release)
        if (depth >= MAX_APPLICATION_DEPTH) return []
        const dir = release.chart.dir
        if (!rendersApps.has(dir)) rendersApps.set(dir, rendersApplications(dir))
        if (rendersApps.get(dir) !== true) return []
        let rendered = options.renders?.get(spec.id)
        try {
            rendered ??= await renderRelease(release, helmPath)
        } catch (error) {
            discovery.renderErrors.set(spec.id, (error as Error).message)
            return []
        }
        discovery.rendered.set(spec.id, rendered)
        return renderedApplications(release, rendered.manifests, checkoutOf, readText)
    }
    /** Visits the releases that no earlier step visited, counting each for the progress. */
    const visitAll = async (items: readonly ReleaseSpec[], depth: number): Promise<void> => {
        const fresh: ReleaseSpec[] = []
        for (const spec of items) {
            if (seen.has(spec.id)) continue
            seen.add(spec.id)
            fresh.push(spec)
        }
        progress.total += fresh.length
        report()
        await inBatches(fresh, async (spec) => {
            const children = await visit(spec, depth)
            progress.done++
            report()
            await visitAll(children, depth + 1)
        })
    }
    await visitAll(specs, 1)
    // A chart that only rendered Applications use gets no guessed release, so the guesses wait for the renders.
    const used = [
        ...discovery.releases.map((release) => release.spec),
        ...discovery.failures.map((failure) => failure.spec)
    ]
    const loadedDirs = discovery.releases.map((release) => release.chart.dir)
    await visitAll(chartReleases(index, used, loadedDirs), 1)
    placeReleases([
        ...discovery.releases.map((release) => release.spec),
        ...discovery.failures.map((failure) => failure.spec)
    ])
    return discovery
}

/** Runs `work` on each item, a few items at a time. */
export async function inBatches<T>(
    items: readonly T[],
    work: (item: T) => Promise<void>,
    concurrency = DISCOVERY_CONCURRENCY
): Promise<void> {
    let next = 0
    const worker = async () => {
        while (next < items.length) await work(items[next++]!)
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
}

/**
 * Reads the Argo CD Applications in the output of `helm template` for a release.
 * The values come from the output. The key positions come from the template file, read with each template action blanked out.
 */
export function renderedApplications(
    parent: Release,
    manifests: string,
    checkoutOf: CheckoutOf,
    readText: ReadText = readFromDisk
): ReleaseSpec[] {
    const specs: ReleaseSpec[] = []
    const shapes = new Map<string, ReleaseSpec[]>()
    const countPerTemplate = new Map<string, number>()
    for (const body of manifests.split(/^---\s*$/m)) {
        if (!holdsApplication(body)) continue
        const source = /^# Source: [^/\n]+\/(.+)$/m.exec(body)?.[1]
        const templateFile =
            source === undefined ? parent.spec.appFile : join(parent.chart.dir, source)
        const rendered = readApplications(templateFile, body, checkoutOf)
        let shape = shapes.get(templateFile)
        if (shape === undefined) {
            shape = templateApplications(templateFile, readText)
            shapes.set(templateFile, shape)
        }
        for (const spec of rendered) {
            const count = countPerTemplate.get(templateFile) ?? 0
            countPerTemplate.set(templateFile, count + 1)
            const twin = shape.length === 1 ? shape[0] : shape[count]
            specs.push({
                ...spec,
                id: `${parent.spec.id}>${spec.name}`,
                parent: parent.spec,
                origin: "Argo CD Application rendered by a chart",
                appFile: templateFile,
                appLine: twin?.appLine ?? 0,
                layers: spec.layers.map((layer) => adoptPositions(layer, twin, templateFile))
            })
        }
    }
    return specs
}

function templateApplications(templateFile: string, readText: ReadText): ReleaseSpec[] {
    try {
        return readApplications(
            templateFile,
            templateSkeleton(readText(templateFile)),
            () => undefined
        )
    } catch {
        return []
    }
}

/** Takes the key positions of a layer from the same layer in the template, since the rendered text sits in no file. */
function adoptPositions(
    layer: LayerSource,
    twin: ReleaseSpec | undefined,
    templateFile: string
): LayerSource {
    if (layer.kind === "file") return layer
    const same = twin?.layers.find(
        (candidate) => candidate.kind === layer.kind && candidate.label === layer.label
    )
    if (layer.kind === "inline")
        return {
            ...layer,
            fsPath: templateFile,
            offset:
                same?.kind === "inline" && lineCount(same.text) === lineCount(layer.text)
                    ? same.offset
                    : undefined
        }
    const sites =
        same !== undefined && (same.kind === "object" || same.kind === "parameters")
            ? same.sites
            : new Map()
    return { ...layer, fsPath: templateFile, sites }
}

function lineCount(text: string): number {
    return text.split("\n").length
}

/**
 * Blanks out the template actions of a chart template and keeps its lines, so a YAML parser reads the keys around them.
 * A line holding nothing but actions turns empty. An action inside a line turns into underscores of its length.
 */
export function templateSkeleton(text: string): string {
    const replaced = text.replace(/\{\{[\s\S]*?\}\}/g, (action) => action.replace(/[^\n]/g, "_"))
    const original = text.split("\n")
    return replaced
        .split("\n")
        .map((line, index) =>
            /^\s*\{\{/.test(original[index]!) && /^[\s_]*$/.test(line) ? "" : line
        )
        .join("\n")
}
