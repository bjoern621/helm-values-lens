import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import type { CheckoutOf } from "../src/argo"
import { helmArgs } from "../src/render"
import { findReleases, loadRelease } from "../src/workspace"
import { FIXTURES, fixtureCheckout } from "./fixtures"

const CLUSTER_REPO = process.env.HELM_VALUES_LENS_REPO

const hasHelm = (() => {
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

async function compare(root: string, checkoutOf?: CheckoutOf): Promise<void> {
    const cacheDir = join(homedir(), ".cache", "helm-values-lens")
    const specs = findReleases([root], undefined, checkoutOf)
    expect(specs.length).toBeGreaterThan(0)
    for (const spec of specs) {
        const release = await loadRelease(spec, cacheDir, "helm")
        const scratch = mkdtempSync(join(tmpdir(), "helm-values-lens-test-"))
        try {
            const keys = release.chart.dependencies.map((dependency) => dependency.key)
            const helm = withoutCopiedGlobals(computedValues(helmArgs(release, scratch)), keys)
            const ours = withoutCopiedGlobals(release.trace.final, keys)
            expect(ours, spec.name).toEqual(helm)
        } finally {
            rmSync(scratch, { recursive: true, force: true })
        }
    }
}

describe.skipIf(!hasHelm)("the trace agrees with the COMPUTED VALUES of helm", () => {
    it("for the fixture repository", async () => {
        expect(existsSync(FIXTURES)).toBe(true)
        await compare(FIXTURES, fixtureCheckout)
    })

    it.skipIf(CLUSTER_REPO === undefined)(
        "for the repository in HELM_VALUES_LENS_REPO",
        async () => {
            await compare(CLUSTER_REPO!)
        },
        600_000
    )
})
