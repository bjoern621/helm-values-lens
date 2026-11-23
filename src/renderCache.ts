import { createHash } from "node:crypto"
import {
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync
} from "node:fs"
import { join } from "node:path"
import { stringify } from "yaml"
import { releaseTitle } from "./hints"
import { type Log, SILENT, durationSince } from "./log"
import type { Release } from "./release"
import { type Rendered, renderRelease, resourcesOf } from "./render"

interface Entry {
    fingerprint: string
    manifests: string
}

/**
 * Keeps the output of `helm template` on disk, one file per release.
 * A render read back counts only while every input of `helm template` matches the one it came from.
 * A restart and a save then call helm for the releases whose inputs changed.
 */
export class RenderCache {
    /**
     * @param dir the folder of the cache, which the cache owns
     * @param salt sets apart the renders of another version of the extension, which may build its helm arguments another way
     */
    constructor(
        private readonly dir: string,
        private readonly salt: string
    ) {}

    /** Hands back the render kept for the release, or undefined once an input changed since. */
    get(release: Release, helmPath: string): Rendered | undefined {
        let entry: Entry
        try {
            entry = JSON.parse(readFileSync(this.fileOf(release), "utf8")) as Entry
        } catch {
            return undefined
        }
        if (entry.fingerprint !== fingerprint(release, helmPath, this.salt)) return undefined
        return { manifests: entry.manifests, resources: resourcesOf(entry.manifests) }
    }

    put(release: Release, helmPath: string, rendered: Rendered): void {
        const entry: Entry = {
            fingerprint: fingerprint(release, helmPath, this.salt),
            manifests: rendered.manifests
        }
        mkdirSync(this.dir, { recursive: true })
        // A reader never sees half a file, since the rename replaces the old one whole.
        const partial = `${this.fileOf(release)}.${process.pid}.partial`
        writeFileSync(partial, JSON.stringify(entry))
        renameSync(partial, this.fileOf(release))
    }

    /** Deletes the renders of every release outside `ids`, such as one whose Application got removed. */
    prune(ids: Iterable<string>): void {
        const kept = new Set([...ids].map(fileName))
        let names: string[]
        try {
            names = readdirSync(this.dir)
        } catch {
            return
        }
        for (const name of names) if (!kept.has(name)) rmSync(join(this.dir, name), { force: true })
    }

    private fileOf(release: Release): string {
        return join(this.dir, fileName(release.spec.id))
    }
}

/** Renders a release, reading the render from `cache` where its inputs stayed the same. */
export async function cachedRender(
    release: Release,
    helmPath: string,
    cache: RenderCache | undefined,
    log: Log = SILENT
): Promise<Rendered> {
    const title = releaseTitle(release.spec)
    const kept = cache?.get(release, helmPath)
    if (kept !== undefined) {
        log.debug(`${title}: took the render from disk`)
        return kept
    }
    const started = Date.now()
    const rendered = await renderRelease(release, helmPath)
    log.debug(
        `${title}: rendered ${rendered.resources.size} resources in ${durationSince(started)}`
    )
    cache?.put(release, helmPath, rendered)
    return rendered
}

function fileName(id: string): string {
    return `${sha256(id).slice(0, 32)}.json`
}

/**
 * Sums up what `helm template` reads for the release: the helm binary, the name and namespace, each values layer and the files of the chart.
 * A values file counts by its text on disk, which helm reads, even while an editor holds unsaved changes.
 * A chart file counts by its size and modification time, which spares reading every template.
 */
export function fingerprint(release: Release, helmPath: string, salt: string): string {
    const layers = release.trace.layers.slice(release.firstUserLayer).map((layer) => {
        if (layer.kind !== "file") return stringify(layer.data ?? {})
        if (layer.fsPath === undefined) return ""
        try {
            return sha256(readFileSync(layer.fsPath, "utf8"))
        } catch {
            return "missing"
        }
    })
    const parameters = release.spec.layers.flatMap((source) =>
        source.kind === "parameters" ? source.parameters : []
    )
    return sha256(
        JSON.stringify([
            salt,
            helmPath,
            release.spec.releaseName,
            release.spec.namespace,
            release.chart.dir,
            layers,
            parameters,
            treeStamp(release.chart.dir)
        ])
    )
}

/** Lists each file under `dir` with its size and modification time, following links into folders once. */
function treeStamp(dir: string): string[] {
    const stamps: string[] = []
    const visited = new Set<string>()
    const walk = (folder: string, prefix: string) => {
        let real: string
        try {
            real = realpathSync(folder)
        } catch {
            return
        }
        if (visited.has(real)) return
        visited.add(real)
        for (const name of readdirSync(folder).sort()) {
            const path = join(folder, name)
            let stat
            try {
                stat = statSync(path)
            } catch {
                continue
            }
            if (stat.isDirectory()) walk(path, `${prefix}${name}/`)
            else stamps.push(`${prefix}${name}:${stat.size}:${stat.mtimeMs}`)
        }
    }
    walk(dir, "")
    return stamps
}

function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex")
}
