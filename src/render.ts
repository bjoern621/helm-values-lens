import { execFile } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { parse, stringify } from "yaml"
import type { Release } from "./release"

const run = promisify(execFile)

export interface Rendered {
    manifests: string
    /** The kind and name of each rendered resource with the text of its document. */
    resources: Map<string, string>
}

/**
 * Builds the arguments that hand Helm the layers of a release in the order that Argo CD passes them.
 * Inline values and `valuesObject` go to files in `scratch`. Parameters go as `--set` and `--set-string`.
 */
export function helmArgs(release: Release, scratch: string): string[] {
    const args: string[] = [release.spec.releaseName, release.chart.dir]
    if (release.spec.namespace !== undefined) args.push("--namespace", release.spec.namespace)
    release.trace.layers.slice(release.firstUserLayer).forEach((layer, index) => {
        if (layer.kind === "file" && layer.fsPath !== undefined) {
            args.push("--values", layer.fsPath)
        } else if (layer.kind === "inline" || layer.kind === "object") {
            const file = join(scratch, `${index}.yaml`)
            writeFileSync(file, stringify(layer.data ?? {}))
            args.push("--values", file)
        }
    })
    for (const source of release.spec.layers) {
        if (source.kind !== "parameters") continue
        for (const parameter of source.parameters)
            args.push(
                parameter.forceString === true ? "--set-string" : "--set",
                `${parameter.name}=${parameter.value}`
            )
    }
    return args
}

/** Renders a release with `helm template`. Throws with the message of helm once the render fails. */
export async function renderRelease(
    release: Release,
    helmPath: string,
    signal?: AbortSignal
): Promise<Rendered> {
    const scratch = mkdtempSync(join(tmpdir(), "helm-values-lens-"))
    try {
        const { stdout } = await run(helmPath, ["template", ...helmArgs(release, scratch)], {
            maxBuffer: 64 * 1024 * 1024,
            timeout: 60_000,
            signal
        })
        return { manifests: stdout, resources: resourcesOf(stdout) }
    } catch (error) {
        const stderr = (error as { stderr?: string }).stderr
        throw new Error(stderr?.trim() || String(error))
    } finally {
        rmSync(scratch, { recursive: true, force: true })
    }
}

function resourcesOf(manifests: string): Map<string, string> {
    const resources = new Map<string, string>()
    for (const body of manifests.split(/^---\s*$/m)) {
        if (body.trim() === "") continue
        let name: string | undefined
        try {
            const data = parse(body) as { kind?: string; metadata?: { name?: string } } | null
            if (data?.kind !== undefined) name = `${data.kind}/${data.metadata?.name ?? "?"}`
        } catch {
            name = /^# Source: (.+)$/m.exec(body)?.[1]
        }
        if (name !== undefined) resources.set(name, body.trim())
    }
    return resources
}

/** Names the resources that a new render added, removed or changed against the last one. */
export function changedResources(
    before: Rendered,
    after: Rendered
): { added: string[]; removed: string[]; changed: string[] } {
    const added = [...after.resources.keys()].filter((key) => !before.resources.has(key))
    const removed = [...before.resources.keys()].filter((key) => !after.resources.has(key))
    const changed = [...after.resources.keys()].filter(
        (key) => before.resources.has(key) && before.resources.get(key) !== after.resources.get(key)
    )
    return { added, removed, changed }
}

/**
 * Finds the rendered resources whose text holds `value`, to show where a value lands.
 * A value shorter than four characters or a boolean finds nothing, since it would match everywhere.
 */
export function resourcesHolding(rendered: Rendered, value: unknown): string[] {
    if (typeof value !== "string" && typeof value !== "number") return []
    const text = String(value)
    if (text.length < 4) return []
    return [...rendered.resources].filter(([, body]) => body.includes(text)).map(([key]) => key)
}
