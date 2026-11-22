import { homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Release } from "../src/release"
import {
    checkoutsOf,
    discover,
    findReleases,
    indexWorkspace,
    templateSkeleton
} from "../src/workspace"
import { pathKey } from "../src/yamlPaths"
import { hasHelm, oursAndHelms } from "./helmValues"

/** A GitOps repository whose remote the workspace does not know: two clusters render a platform chart, which renders one Application per cluster. */
const GITOPS = join(__dirname, "workspaces", "gitops")
const CACHE = join(homedir(), ".cache", "helm-values-lens")

describe("templateSkeleton", () => {
    it("keeps every line and blanks a line holding only actions", () => {
        const template = "{{- if .Values.on }}\nname: web-{{ .Values.name }}\n{{- end }}\n"
        const skeleton = templateSkeleton(template)
        expect(skeleton.split("\n")).toHaveLength(template.split("\n").length)
        expect(skeleton).toBe(`\nname: web-${"_".repeat("{{ .Values.name }}".length)}\n\n`)
    })
})

describe("checkoutsOf", () => {
    it("finds a checkout by the end of the URL path once no remote names the URL", () => {
        const checkoutOf = checkoutsOf(indexWorkspace([GITOPS]))
        expect(checkoutOf("https://git.example.com/acme/gitops.git")).toBe(GITOPS)
        expect(checkoutOf("git@git.example.com:acme/gitops.git")).toBe(GITOPS)
    })

    it("matches nothing where two folders end the same way", () => {
        const index = { files: [], charts: [], checkouts: [], dirs: ["/a/team/web", "/b/team/web"] }
        expect(checkoutsOf(index)("https://git.example.com/team/web.git")).toBeUndefined()
    })

    it("takes the repositories setting first", () => {
        const checkoutOf = checkoutsOf(
            indexWorkspace([GITOPS]),
            {
                "https://git.example.com/acme/gitops.git": "charts"
            },
            [GITOPS]
        )
        expect(checkoutOf("https://git.example.com/acme/gitops.git")).toBe(join(GITOPS, "charts"))
    })
})

describe("findReleases", () => {
    it("guesses one release per values file beside a chart that nothing deploys", () => {
        const names = findReleases([GITOPS]).map((spec) => spec.name)
        expect(names).toEqual(
            expect.arrayContaining(["platform", "worker", "worker (dev)", "worker (prod)"])
        )
        expect(names.filter((name) => name === "platform")).toHaveLength(2)
        expect(names).not.toContain("platform (production)")
    })
})

describe.skipIf(!hasHelm)("discover", () => {
    let releases: Release[] = []
    const named = (name: string) => releases.find((release) => release.spec.name === name)!

    it("renders the platform chart of each cluster and reads the Applications in the output", async () => {
        const discovery = await discover([GITOPS], CACHE, "helm")
        releases = discovery.releases
        expect(discovery.failures).toEqual([])
        expect(releases.map((release) => release.spec.name).sort()).toEqual([
            "platform",
            "platform",
            "web-production",
            "web-staging",
            "worker",
            "worker (dev)",
            "worker (prod)"
        ])
    })

    it("hands an Application in the output the values of its cluster", () => {
        const staging = named("web-staging")
        expect(staging.spec.parent).toBe("platform")
        expect(staging.trace.layers.map((layer) => layer.label)).toEqual([
            "chart values.yaml",
            "values-staging.yaml",
            "helm.valuesObject"
        ])
        expect(staging.trace.final).toMatchObject({
            replicas: 1,
            image: { tag: "1.27-rc" },
            ingress: { host: "web.staging.example.com" }
        })
        expect(named("web-production").trace.final).toMatchObject({
            replicas: 3,
            ingress: { host: "web.example.com" }
        })
    })

    it("points the keys of an Application in the output at the lines of its template", () => {
        const staging = named("web-staging")
        const template = join(GITOPS, "charts", "platform", "templates", "web.yaml")
        expect(staging.spec.appFile).toBe(template)
        expect(staging.spec.appLine).toBe(4)
        const layer = staging.spec.layers.find((source) => source.label === "helm.valuesObject")!
        expect(layer.fsPath).toBe(template)
        expect(
            layer.kind === "object" && layer.sites.get(pathKey(["ingress", "host"]))?.key
        ).toEqual({ line: 18, column: 10 })
    })

    it("agrees with the COMPUTED VALUES of helm for every release", () => {
        for (const release of releases) {
            const { ours, helm } = oursAndHelms(release)
            expect(ours, release.spec.id).toEqual(helm)
        }
    })
})
