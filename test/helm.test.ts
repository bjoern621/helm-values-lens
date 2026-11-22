import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { CheckoutOf } from "../src/argo"
import { findReleases, loadRelease } from "../src/workspace"
import { FIXTURES, fixtureCheckout } from "./fixtures"
import { hasHelm, oursAndHelms } from "./helmValues"

const CLUSTER_REPO = process.env.HELM_VALUES_LENS_REPO

async function compare(root: string, checkoutOf?: CheckoutOf): Promise<void> {
    const cacheDir = join(homedir(), ".cache", "helm-values-lens")
    const specs = findReleases([root], undefined, checkoutOf)
    expect(specs.length).toBeGreaterThan(0)
    for (const spec of specs) {
        const { ours, helm } = oursAndHelms(await loadRelease(spec, cacheDir, "helm"))
        expect(ours, spec.name).toEqual(helm)
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
