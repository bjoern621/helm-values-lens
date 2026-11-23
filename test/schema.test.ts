import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { winningUserSite } from "../src/hints"
import { chartDefault, knownKeys, type Release } from "../src/release"
import { schemaErrors } from "../src/schema"
import { findReleases, loadRelease } from "../src/workspace"
import { FIXTURES, fixtureCheckout } from "./fixtures"

const PROD = join(FIXTURES, "envs/prod.yaml")
const CACHE = join(homedir(), ".cache", "helm-values-lens")

/** The release of `apps/demo.yaml`, with `envs/prod.yaml` holding `prod` in place of its text on disk. */
async function demoWith(prod?: string): Promise<Release> {
    const readText = (fsPath: string) =>
        fsPath === PROD && prod !== undefined ? prod : readFileSync(fsPath, "utf8")
    const [spec] = findReleases([FIXTURES], readText, fixtureCheckout)
    return loadRelease(spec!, CACHE, "helm", readText)
}

let release: Release

beforeAll(async () => {
    release = await demoWith()
})

describe("values.schema.json", () => {
    it("accepts the values of the fixture, as helm template does", () => {
        expect(release.schemaErrors).toEqual([])
    })

    it("rejects a value at the key that sets it, naming the schema of the chart or the dependency", async () => {
        const broken = await demoWith(
            "image:\n  tag: 2\n  pullPolicy: Sometimes\ncache:\n  size: 500\n"
        )
        expect(broken.schemaErrors.map((error) => error.message).sort()).toEqual(
            [
                'image.pullPolicy must be one of "Always", "IfNotPresent", "Never" (values.schema.json)',
                "image.tag must be string (values.schema.json)",
                "cache.size must be <= 100 (cache values.schema.json)"
            ].sort()
        )
        const size = broken.schemaErrors.find((error) => error.path.join(".") === "cache.size")!
        const site = winningUserSite(broken, size.path)!
        expect(broken.trace.layers[site.layerIndex]!.fsPath).toBe(PROD)
        expect(site.key).toEqual({ line: 4, column: 2 })
    })

    it("marks a missing required key at the map around it", () => {
        const problems: string[] = []
        const schema = {
            type: "object",
            properties: { image: { type: "object", required: ["repository"] } }
        }
        const errors = schemaErrors(
            [
                {
                    prefix: [],
                    fsPath: "values.schema.json",
                    label: "values.schema.json",
                    schema,
                    error: undefined
                }
            ],
            { image: { tag: "1" } },
            problems
        )
        expect(errors).toEqual([
            { path: ["image"], message: "image.repository is required (values.schema.json)" }
        ])
        expect(problems).toEqual([])
    })

    it("reports a schema that does not compile as a problem of the release", () => {
        const problems: string[] = []
        const schema = { type: "object", properties: { a: { $ref: "#/definitions/missing" } } }
        const errors = schemaErrors(
            [
                {
                    prefix: [],
                    fsPath: "values.schema.json",
                    label: "values.schema.json",
                    schema,
                    error: undefined
                }
            ],
            {},
            problems
        )
        expect(errors).toEqual([])
        expect(problems).toHaveLength(1)
        expect(problems[0]).toMatch(/^values\.schema\.json: /)
    })
})

describe("the chart defaults", () => {
    it("take the value of the parent chart over the default of a dependency, as Helm does", () => {
        expect(chartDefault(release, ["cache", "size"])).toBe(10)
        expect(chartDefault(release, ["cache", "ttl"])).toBe(60)
    })

    it("name the keys that the defaults, the templates and the schema know, with the schema's description", () => {
        const image = knownKeys(release, ["image"])
        expect([...image.keys()].sort()).toEqual(["pullPolicy", "repository", "tag"])
        expect(image.get("pullPolicy")).toMatchObject({
            default: undefined,
            schema: {
                description: "When the kubelet pulls the image.",
                enum: ["Always", "IfNotPresent", "Never"]
            }
        })
        expect(image.get("repository")!.default).toBe("nginx")
        expect(knownKeys(release, ["resources"]).has("requests")).toBe(true)
    })
})
