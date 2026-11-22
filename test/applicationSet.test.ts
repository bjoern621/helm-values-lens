import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { CheckoutOf, LayerSource, ReleaseSpec } from "../src/argo"
import { readApplicationSets, readApplicationSetsWithSkips } from "../src/sources/applicationSet"
import { pathKey } from "../src/yamlPaths"
import { FIXTURES, fixtureCheckout } from "./fixtures"

const CHART = join(FIXTURES, "charts/app")

function read(file: string, checkoutOf: CheckoutOf = fixtureCheckout): ReleaseSpec[] {
    const fsPath = join(FIXTURES, "appset", file)
    return readApplicationSets(
        { fsPath, text: readFileSync(fsPath, "utf8") },
        { files: [], checkoutOf }
    )
}

function readText(text: string): ReturnType<typeof readApplicationSetsWithSkips> {
    return readApplicationSetsWithSkips(
        { fsPath: "/inline.yaml", text },
        { files: [], checkoutOf: fixtureCheckout }
    )
}

const lineOf = (file: string, text: string) =>
    readFileSync(join(FIXTURES, "appset", file), "utf8")
        .split("\n")
        .findIndex((line) => line.includes(text))

const labels = (release: ReleaseSpec) => release.layers.map((layer) => layer.label)

function layer<K extends LayerSource["kind"]>(
    release: ReleaseSpec,
    kind: K
): Extract<LayerSource, { kind: K }> {
    const found = release.layers.find((candidate) => candidate.kind === kind)
    expect(found, `${release.name} has a ${kind} layer`).toBeDefined()
    return found as Extract<LayerSource, { kind: K }>
}

describe("a list generator with fasttemplate", () => {
    const releases = read("list.yaml")
    const [prod, staging] = releases

    it("generates one Application per element", () => {
        expect(releases.map((release) => release.name)).toEqual(["envs-prod", "envs-staging"])
        expect(prod!.origin).toBe("Argo CD ApplicationSet")
        expect(prod!.namespace).toBe("prod")
        expect(prod!.chart).toEqual({ kind: "directory", dir: CHART })
    })

    it("gives each Application an id of its own on the line of template.metadata.name", () => {
        const appLine = lineOf("list.yaml", 'name: "envs-{{env}}"')
        expect(prod!.appLine).toBe(appLine)
        expect(staging!.appLine).toBe(appLine)
        expect(prod!.id).toBe(`${join(FIXTURES, "appset/list.yaml")}:${appLine}:envs-prod`)
        expect(new Set(releases.map((release) => release.id)).size).toBe(2)
    })

    it("orders the layers as Argo CD does and substitutes the parameters into each", () => {
        expect(labels(prod!)).toEqual([
            "values-base.yaml",
            "appset/values/prod.yaml",
            "helm.values",
            "helm.parameters"
        ])
        expect(prod!.layers[1]).toMatchObject({
            kind: "file",
            fsPath: join(FIXTURES, "appset/values/prod.yaml")
        })
        expect(layer(staging!, "inline").text).toBe("replicas: 1\n")
        expect(layer(staging!, "parameters").parameters).toEqual([
            { name: "image.tag", value: "staging", forceString: false }
        ])
    })

    it("points the sites at the lines of the template", () => {
        expect(layer(prod!, "inline").offset).toEqual({
            lineDelta: lineOf("list.yaml", "replicas: {{replicas}}"),
            columnDelta: 14
        })
        const site = layer(prod!, "parameters").sites.get(pathKey(["image", "tag"]))
        expect(site?.key.line).toBe(lineOf("list.yaml", "- name: image.tag"))
    })
})

describe("a git directories generator with goTemplate", () => {
    const releases = read("git-directories.yaml")
    const [api] = releases

    it("generates one Application per matching directory and leaves out the excluded ones", () => {
        expect(releases.map((release) => release.name)).toEqual(["api", "web"])
    })

    it("fills path.basename, path.basenameNormalized, path.path and path.segments", () => {
        expect(api!.releaseName).toBe("svc-api")
        expect(api!.namespace).toBe("services")
        expect(labels(api!)).toEqual(["appset/services/api/values.yaml", "helm.valuesObject"])
        expect(api!.layers[0]).toMatchObject({
            fsPath: join(FIXTURES, "appset/services/api/values.yaml")
        })
        expect(layer(api!, "object").data).toEqual({ podAnnotations: { service: "api" } })
    })

    it("points the sites of valuesObject at the template", () => {
        const site = layer(api!, "object").sites.get(pathKey(["podAnnotations", "service"]))
        expect(site?.key).toEqual({
            line: lineOf("git-directories.yaml", "service:"),
            column: 16
        })
    })

    it("yields no release for a repository outside the workspace and says why", () => {
        const fsPath = join(FIXTURES, "appset/git-directories.yaml")
        const reading = readApplicationSetsWithSkips(
            { fsPath, text: readFileSync(fsPath, "utf8") },
            { files: [], checkoutOf: () => undefined }
        )
        expect(reading.releases).toEqual([])
        expect(reading.skips).toEqual([
            `${fsPath}: ApplicationSet services, generator 0: https://example.com/fixtures.git is not checked out in the workspace`
        ])
    })
})

describe("a matrix of git files and a list", () => {
    const releases = read("matrix.yaml")

    it("joins each file with each element", () => {
        expect(releases.map((release) => release.name)).toEqual([
            "eu-frontend",
            "eu-backend",
            "us-frontend",
            "us-backend"
        ])
    })

    it("flattens the file into dotted parameters and hands them to the second generator", () => {
        const usBackend = releases[3]!
        expect(usBackend.namespace).toBe("us")
        expect(layer(usBackend, "inline").text).toBe(
            'replicas: 3\npodAnnotations:\n  region: "us-east-1"\n'
        )
        expect(usBackend.chart).toEqual({ kind: "directory", dir: CHART })
    })
})

describe("a merge generator", () => {
    it("overrides the base elements that share the merge key", () => {
        const releases = read("merge.yaml")
        expect(releases.map((release) => release.name)).toEqual(["sizes-small", "sizes-large"])
        expect(
            releases.map((release) => layer(release, "parameters").parameters[0]?.value)
        ).toEqual(["1", "9"])
    })
})

const header = `apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: inline
spec:
`

const template = (name: string, path: string, labels = "") => `  template:
    metadata:
      name: "${name}"${labels}
    spec:
      destination:
        namespace: demo
      source:
        repoURL: https://example.com/fixtures.git
        path: "${path}"
        helm:
          values: "a: 1"
`

describe("what the reader leaves out", () => {
    it("skips a generator that reads clusters and keeps the others", () => {
        const reading = readText(`${header}  generators:
    - clusters: {}
    - list:
        elements:
          - name: one
${template("{{name}}", "charts/app")}`)
        expect(reading.releases.map((release) => release.name)).toEqual(["one"])
        expect(reading.skips).toEqual([
            "/inline.yaml: ApplicationSet inline, generator 0: the clusters generator reads state outside the workspace"
        ])
    })

    it("gives a release with an unresolved chart where a decisive expression fails", () => {
        const reading = readText(`${header}  goTemplate: true
  generators:
    - list:
        elements:
          - name: one
${template("{{ .name }}", '{{ printf \\"charts/%s\\" .name }}')}`)
        expect(reading.releases).toHaveLength(1)
        expect(reading.releases[0]).toMatchObject({
            name: "one",
            layers: [],
            chart: {
                kind: "unresolved",
                reason: expect.stringContaining("the reader does not know the function printf")
            }
        })
    })

    it("treats a missing key under goTemplate as a failure", () => {
        const reading = readText(`${header}  goTemplate: true
  generators:
    - list:
        elements:
          - name: one
${template("{{ .name }}", "charts/{{ .chart }}")}`)
        expect(reading.releases[0]?.chart).toMatchObject({ kind: "unresolved" })
        expect(reading.releases[0]?.chart).toHaveProperty(
            "reason",
            'template.spec.source.path: cannot evaluate "charts/{{ .chart }}" (a key is missing)'
        )
    })

    it("keeps the release where an expression fails outside the decisive fields", () => {
        const reading = readText(`${header}  goTemplate: true
  generators:
    - list:
        elements:
          - name: one
${template("{{ .name }}", "charts/app", "\n      labels:\n        team: '{{ .team }}'")}`)
        expect(reading.releases[0]?.chart).toMatchObject({ kind: "directory" })
    })

    it("leaves an unknown fasttemplate tag as written, the way Argo CD does", () => {
        const reading = readText(`${header}  generators:
    - list:
        elements:
          - name: one
${template("{{name}}-{{unknown}}", "charts/app")}`)
        expect(reading.releases[0]?.name).toBe("one-{{unknown}}")
    })

    it("skips an ApplicationSet with a templatePatch", () => {
        const reading = readText(`${header}  templatePatch: "spec: {}"
  generators:
    - list:
        elements:
          - name: one
${template("{{name}}", "charts/app")}`)
        expect(reading.releases).toEqual([])
        expect(reading.skips[0]).toContain("templatePatch")
    })
})
