import { appendFileSync, cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import type { Release } from "../src/release"
import { cachedRender, RenderCache } from "../src/renderCache"
import { findReleases, loadRelease } from "../src/workspace"
import { FIXTURES } from "./fixtures"

const scratch = mkdtempSync(join(tmpdir(), "helm-values-lens-cache-"))
const copy = join(scratch, "repo")
const cacheDir = join(scratch, "renders")
const rendered = { manifests: "kind: ConfigMap\nmetadata:\n  name: web\n", resources: new Map() }

let release: Release

/** Reads the demo Application of the copy of the fixtures. */
async function demoRelease(): Promise<Release> {
    const [spec] = findReleases([copy], undefined, (url) =>
        url === "https://example.com/fixtures.git" ? copy : undefined
    )
    return loadRelease(spec!, join(homedir(), ".cache", "helm-values-lens"), "helm")
}

beforeEach(async () => {
    rmSync(cacheDir, { recursive: true, force: true })
    // Each test gets a fresh copy, since a test may change its files.
    rmSync(copy, { recursive: true, force: true })
    cpSync(FIXTURES, copy, { recursive: true })
    release = await demoRelease()
})

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe("RenderCache", () => {
    it("hands back a render while the inputs of helm stay the same", async () => {
        const cache = new RenderCache(cacheDir, "1.0.0")
        cache.put(release, "helm", rendered)
        const kept = new RenderCache(cacheDir, "1.0.0").get(await demoRelease(), "helm")
        expect(kept?.manifests).toBe(rendered.manifests)
        expect([...kept!.resources.keys()]).toEqual(["ConfigMap/web"])
    })

    it("drops a render once a values file of the release changes on disk", () => {
        const cache = new RenderCache(cacheDir, "1.0.0")
        cache.put(release, "helm", rendered)
        appendFileSync(join(copy, "charts/app/values-base.yaml"), "\nextra: 1\n")
        expect(cache.get(release, "helm")).toBeUndefined()
    })

    it("drops a render once a template of the chart changes", () => {
        const cache = new RenderCache(cacheDir, "1.0.0")
        cache.put(release, "helm", rendered)
        writeFileSync(join(copy, "charts/app/templates/extra.yaml"), "kind: Secret\n")
        expect(cache.get(release, "helm")).toBeUndefined()
    })

    it("drops a render from another version of the extension or another helm", () => {
        new RenderCache(cacheDir, "1.0.0").put(release, "helm", rendered)
        expect(new RenderCache(cacheDir, "1.0.1").get(release, "helm")).toBeUndefined()
        expect(new RenderCache(cacheDir, "1.0.0").get(release, "/opt/helm")).toBeUndefined()
    })

    it("deletes the renders of releases that are gone", () => {
        const cache = new RenderCache(cacheDir, "1.0.0")
        cache.put(release, "helm", rendered)
        cache.prune(["another release"])
        expect(readdirSync(cacheDir)).toEqual([])
    })
})

describe("cachedRender", () => {
    it("takes the render on disk without calling helm", async () => {
        const cache = new RenderCache(cacheDir, "1.0.0")
        cache.put(release, "no-such-helm", rendered)
        const kept = await cachedRender(release, "no-such-helm", cache)
        expect(kept.manifests).toBe(rendered.manifests)
    })
})
