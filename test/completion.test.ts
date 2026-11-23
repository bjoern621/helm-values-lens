import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { completionsAt } from "../src/completion"
import type { Release } from "../src/release"
import { findReleases, loadRelease } from "../src/workspace"
import { FIXTURES, fixtureCheckout } from "./fixtures"

const APP = join(FIXTURES, "apps/demo.yaml")
const PROD = join(FIXTURES, "envs/prod.yaml")

let release: Release

beforeAll(async () => {
    const [spec] = findReleases([FIXTURES], undefined, fixtureCheckout)
    release = await loadRelease(spec!, join(homedir(), ".cache", "helm-values-lens"), "helm")
})

/** The suggestions with the cursor at the `‸` of `text`, which stands in for the file at `fsPath`. */
function suggest(text: string, fsPath = PROD) {
    const document = text.replace("‸", "")
    const before = text.split("‸")[0]!.split("\n")
    const position = { line: before.length - 1, column: before.at(-1)!.length }
    return completionsAt(document, fsPath, position, [release])
}

const labels = (completions: ReturnType<typeof suggest>) => completions.map((c) => c.label).sort()

describe("key completion", () => {
    it("offers the keys of the chart defaults, the templates and the schema, without the keys already set", () => {
        const found = labels(suggest("image:\n  tag: x\n  ‸\n"))
        expect(found).toEqual(["pullPolicy", "repository"])
    })

    it("offers the top-level keys of the chart and its dependencies at the start of a line", () => {
        const found = labels(suggest("image:\n  tag: x\n‸"))
        expect(found).toContain("replicas")
        expect(found).toContain("cache")
        expect(found).not.toContain("image")
    })

    it("names the shape of the value, so that a map key opens an indented line", () => {
        const found = suggest("‸")
        expect(found.find((c) => c.label === "resources")).toMatchObject({ shape: "map" })
        expect(found.find((c) => c.label === "tolerations")).toMatchObject({ shape: "list" })
        expect(found.find((c) => c.label === "replicas")).toMatchObject({
            shape: "scalar",
            detail: "1"
        })
    })

    it("documents a key with its schema description and its default", () => {
        const replicas = suggest("‸").find((c) => c.label === "replicas")!
        expect(replicas.documentation).toContain("How many pods the Deployment runs.")
        expect(replicas.documentation).toContain("$(package) Default: `1`")
    })

    it("offers the keys of a dependency under its key", () => {
        expect(labels(suggest("cache:\n  ‸"))).toEqual(["global", "size", "ttl"])
    })

    it("offers nothing inside a list or a block scalar", () => {
        expect(suggest("tolerations:\n  - key: a\n    ‸")).toEqual([])
        expect(suggest("note: |\n  ‸")).toEqual([])
    })

    it("completes keys in the values block of an Application, at the indent of the block", () => {
        const text = readFileSync(APP, "utf8")
        const at = text.indexOf("          podAnnotations:")
        const document = text.slice(0, at) + "          ‸\n" + text.slice(at)
        const found = suggest(document, APP)
        expect(found.map((c) => c.label)).toContain("image")
        expect(found.map((c) => c.label)).not.toContain("replicas")
        expect(found[0]!.replaceFrom).toBe(10)
        expect(found.find((c) => c.label === "image")!.indent).toBe(" ".repeat(10))
    })
})

describe("value completion", () => {
    it("offers the values that the schema allows", () => {
        const found = suggest("image:\n  pullPolicy: ‸")
        expect(labels(found)).toEqual(["Always", "IfNotPresent", "Never"])
        expect(found[0]!.replaceFrom).toBe("  pullPolicy: ".length)
    })

    it("quotes a default that YAML would read as another type", () => {
        const tag = suggest("image:\n  tag: ‸").find((c) => c.detail === "chart default")!
        expect(tag).toMatchObject({ label: "1.0", text: '"1.0"' })
    })

    it("offers true and false for a boolean default", () => {
        expect(labels(suggest("legacy:\n  enabled: ‸"))).toEqual(["false", "true"])
    })
})
