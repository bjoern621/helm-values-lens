import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "yaml"
import type { Release } from "../src/release"
import { helmArgs } from "../src/render"

export const hasHelm = (() => {
    try {
        execFileSync("helm", ["version"], { stdio: "ignore" })
        return true
    } catch {
        return false
    }
})()

/** Merges the layers with Helm itself and reads back its COMPUTED VALUES. */
function computedValues(args: string[]): unknown {
    const output = execFileSync("helm", ["install", ...args, "--dry-run=client", "--debug"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"]
    })
    const start = output.indexOf("COMPUTED VALUES:\n")
    const end = output.indexOf("\nHOOKS:\n", start)
    return parse(output.slice(start + "COMPUTED VALUES:\n".length, end === -1 ? undefined : end))
}

/**
 * Drops what Helm adds on its own: the `global` that it copies into each dependency and the empty `global` at the top.
 * The trace follows the values that some layer wrote.
 */
function withoutCopiedGlobals(values: unknown, keys: readonly string[]): unknown {
    const copy = structuredClone(values) as Record<string, Record<string, unknown>>
    for (const key of keys) delete copy[key]?.global
    if (JSON.stringify(copy.global) === "{}") delete (copy as Record<string, unknown>).global
    return copy
}

/** The final values of the trace and the COMPUTED VALUES of Helm for the same layers, for `toEqual`. */
export function oursAndHelms(release: Release): { ours: unknown; helm: unknown } {
    const scratch = mkdtempSync(join(tmpdir(), "helm-values-lens-test-"))
    try {
        const keys = release.chart.dependencies.map((dependency) => dependency.key)
        return {
            ours: withoutCopiedGlobals(release.trace.final, keys),
            helm: withoutCopiedGlobals(computedValues(helmArgs(release, scratch)), keys)
        }
    } finally {
        rmSync(scratch, { recursive: true, force: true })
    }
}
