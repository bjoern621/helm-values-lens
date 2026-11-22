import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parse, parseAllDocuments } from "yaml"
import type { LayerSource, ReleaseSpec } from "../src/argo"
import { helmArgs } from "../src/render"
import { readFluxHelmReleases } from "../src/sources/flux"
import { readHelmfile } from "../src/sources/helmfile"
import { readKustomizeHelmCharts } from "../src/sources/kustomize"
import type { SourceContext, SourceReader, WorkspaceFile } from "../src/sources/types"
import { loadRelease, yamlFiles } from "../src/workspace"
import { pathKey, type Position } from "../src/yamlPaths"
import { FIXTURES, fixtureCheckout } from "./fixtures"

const HELMFILE = join(FIXTURES, "helmfile", "helmfile.yaml")
const HELMFILE_ENVIRONMENTS = join(FIXTURES, "helmfile", "envs", "helmfile.yaml.gotmpl")
const FLUX_RELEASE = join(FIXTURES, "flux", "release.yaml")
const KUSTOMIZATION = join(FIXTURES, "kustomize", "kustomization.yaml")

function hasTool(command: string, args: string[]): boolean {
    try {
        execFileSync(command, args, { stdio: "ignore" })
        return true
    } catch {
        return false
    }
}

const hasHelm = hasTool("helm", ["version"])
const hasHelmfile = hasHelm && hasTool("helmfile", ["--version"])
const hasKustomize = hasHelm && hasTool("kustomize", ["version"])

function onDisk(fsPath: string): WorkspaceFile {
    return { fsPath, text: readFileSync(fsPath, "utf8") }
}

/** The YAML files of the fixture repository, with `extra` in place of a file of the same path. */
function contextWith(...extra: WorkspaceFile[]): SourceContext {
    const files = yamlFiles(FIXTURES)
        .filter((fsPath) => !extra.some((file) => file.fsPath === fsPath))
        .map(onDisk)
    return { files: [...files, ...extra], checkoutOf: fixtureCheckout }
}

function read(reader: SourceReader, fsPath: string): ReleaseSpec[] {
    return reader(onDisk(fsPath), contextWith())
}

function readText(reader: SourceReader, fsPath: string, text: string, ...extra: WorkspaceFile[]) {
    const file = { fsPath, text }
    return reader(file, contextWith(file, ...extra))
}

function only(specs: ReleaseSpec[]): ReleaseSpec {
    expect(specs).toHaveLength(1)
    return specs[0]!
}

function layerLabels(spec: ReleaseSpec): string[] {
    return spec.layers.map((layer) => `${layer.kind} ${layer.label}`)
}

function layer(spec: ReleaseSpec, label: string): LayerSource {
    const found = spec.layers.find((each) => each.label === label)
    expect(found, label).toBeDefined()
    return found!
}

function siteOf(source: LayerSource, ...path: string[]): Position | undefined {
    if (source.kind !== "object" && source.kind !== "parameters") return undefined
    return source.sites.get(pathKey(path))?.key
}

function problemOf(source: LayerSource): string | undefined {
    return source.kind === "file" ? source.problem : undefined
}

function fixtureReleases(): ReleaseSpec[] {
    return [
        ...read(readHelmfile, HELMFILE),
        ...read(readHelmfile, HELMFILE_ENVIRONMENTS),
        ...read(readFluxHelmReleases, FLUX_RELEASE),
        ...read(readKustomizeHelmCharts, KUSTOMIZATION)
    ]
}

describe("readHelmfile", () => {
    it("passes values files and maps in their order, then set, then setString", () => {
        const [web, dump] = read(readHelmfile, HELMFILE)
        expect(layerLabels(web!)).toEqual([
            "file ../charts/app/values-base.yaml",
            "object values[1]",
            "file values/web.yaml",
            "parameters set",
            "parameters setString"
        ])
        expect(web!.chart).toEqual({ kind: "directory", dir: join(FIXTURES, "charts", "app") })
        expect(dump!.chart).toEqual({ kind: "directory", dir: join(FIXTURES, "charts", "dump") })
    })

    it("names each release after the file, the line of its name and its name", () => {
        const [web] = read(readHelmfile, HELMFILE)
        expect(web).toMatchObject({
            id: `${HELMFILE}:4:web`,
            name: "web",
            origin: "Helmfile release",
            appFile: HELMFILE,
            appLine: 4,
            releaseName: "web",
            namespace: "web"
        })
    })

    it("records where each inline key and each set name sits", () => {
        const [web] = read(readHelmfile, HELMFILE)
        expect(siteOf(layer(web!, "values[1]"), "podAnnotations", "team")).toEqual({
            line: 12,
            column: 10
        })
        expect(siteOf(layer(web!, "set"), "cache", "ttl")).toEqual({ line: 18, column: 14 })
        const setString = layer(web!, "setString")
        expect(setString.kind === "parameters" && setString.parameters).toEqual([
            { name: "podAnnotations.note", value: "true", forceString: true }
        ])
    })

    it("skips a missing values file under missingFileHandler Warn and keeps it under the default", () => {
        const [web] = read(readHelmfile, HELMFILE)
        expect(web!.layers.some((each) => each.label === "values/absent.yaml")).toBe(false)
        const fsPath = join(FIXTURES, "helmfile", "strict", "helmfile.yaml")
        const strict = only(
            readText(
                readHelmfile,
                fsPath,
                "releases:\n  - name: strict\n    chart: ../../charts/app\n    values:\n      - absent.yaml\n"
            )
        )
        expect(strict.layers).toEqual([
            {
                kind: "file",
                label: "absent.yaml",
                fsPath: join(FIXTURES, "helmfile", "strict", "absent.yaml"),
                raw: "absent.yaml"
            }
        ])
    })

    it("turns a release that the environments render apart into one release per environment", () => {
        const [dev, prod] = read(readHelmfile, HELMFILE_ENVIRONMENTS)
        expect(dev).toMatchObject({
            id: `${HELMFILE_ENVIRONMENTS}:5:dump:dev`,
            name: "dump (dev)",
            releaseName: "dump",
            namespace: "dump-dev"
        })
        expect(prod).toMatchObject({ name: "dump (prod)", namespace: "dump-prod" })
        expect(layerLabels(prod!)).toEqual([
            "file values/prod.yaml",
            "inline values/common.yaml.gotmpl",
            "parameters set"
        ])
        const common = layer(prod!, "values/common.yaml.gotmpl")
        expect(common.kind === "inline" && common.text).toBe(
            "annotations:\n  release: dump\n  environment: prod\n"
        )
    })

    it("keeps one release where every environment renders it alike", () => {
        const fsPath = join(FIXTURES, "helmfile", "alike", "helmfile.yaml.gotmpl")
        const text =
            "environments:\n  dev: {}\n  prod: {}\n---\nreleases:\n  - name: app\n    chart: ../../charts/app\n"
        expect(readText(readHelmfile, fsPath, text).map((spec) => spec.id)).toEqual([
            `${fsPath}:5:app`
        ])
    })

    it("resolves a chart through repositories, oci: true and an oci:// URL", () => {
        const fsPath = join(FIXTURES, "helmfile", "remote", "helmfile.yaml")
        const text = [
            "repositories:",
            "  - name: bitnami",
            "    url: https://charts.bitnami.com/bitnami",
            "  - name: ghcr",
            "    url: ghcr.io/org/charts",
            "    oci: true",
            "releases:",
            "  - name: a",
            "    chart: bitnami/redis",
            "    version: 1.2.3",
            "  - name: b",
            "    chart: ghcr/app",
            "  - name: c",
            "    chart: oci://registry.example.com/team/web",
            "    version: 0.4.0",
            "  - name: d",
            "    chart: unknown/app",
            "  - name: e",
            "    chart: bitnami/redis",
            "    installed: false",
            ""
        ].join("\n")
        expect(readText(readHelmfile, fsPath, text).map((spec) => spec.chart)).toEqual([
            {
                kind: "repository",
                repoURL: "https://charts.bitnami.com/bitnami",
                chart: "redis",
                version: "1.2.3"
            },
            { kind: "repository", repoURL: "ghcr.io/org/charts", chart: "app", version: "" },
            {
                kind: "repository",
                repoURL: "registry.example.com/team",
                chart: "web",
                version: "0.4.0"
            },
            { kind: "unresolved", reason: "no repository unknown under repositories:" }
        ])
    })

    it("leaves a layer or a chart unread where it holds another template expression", () => {
        const fsPath = join(FIXTURES, "helmfile", "templated", "helmfile.yaml.gotmpl")
        const text = [
            "releases:",
            '  - name: {{ requiredEnv "NAME" }}',
            "    chart: ../../charts/{{ .Values.chart }}",
            "    values:",
            "      - {{ .Values.file }}",
            "      - region: {{ .Values.region }}",
            ""
        ].join("\n")
        const spec = only(readText(readHelmfile, fsPath, text))
        expect(spec.name).toBe('{{ requiredEnv "NAME" }}')
        expect(spec.chart).toEqual({
            kind: "unresolved",
            reason: "the chart holds the template expression {{ .Values.chart }}"
        })
        expect(spec.layers.map(problemOf)).toEqual([
            "the path holds the template expression {{ .Values.file }}",
            "holds the template expression {{ .Values.region }}, which the trace leaves out"
        ])
    })

    it("renders the release fields in valuesTemplate and setTemplate", () => {
        const fsPath = join(FIXTURES, "helmfile", "fields", "helmfile.yaml")
        const text = [
            "releases:",
            "  - name: app",
            "    namespace: team",
            "    chart: ../../charts/app",
            "    valuesTemplate:",
            '      - podAnnotations: { owner: "{{ .Release.Namespace }}" }',
            "    values:",
            '      - podAnnotations: { name: "{{ .Release.Name }}" }',
            "    setTemplate:",
            "      - name: image.tag",
            '        value: "{{ .Release.Name }}"',
            "    secrets:",
            "      - secrets.yaml",
            ""
        ].join("\n")
        const spec = only(readText(readHelmfile, fsPath, text))
        expect(layerLabels(spec)).toEqual([
            "object valuesTemplate[0]",
            "object values[0]",
            "file secrets.yaml",
            "parameters set"
        ])
        const [template, values, secrets, set] = spec.layers
        expect(template!.kind === "object" && template!.data).toEqual({
            podAnnotations: { owner: "team" }
        })
        expect(values!.kind === "object" && values!.data).toEqual({
            podAnnotations: { name: "{{ .Release.Name }}" }
        })
        expect(problemOf(secrets!)).toBe("helm-secrets decrypts it, which the trace leaves out")
        expect(set!.kind === "parameters" && set!.parameters).toEqual([
            { name: "image.tag", value: "app", forceString: false }
        ])
    })

    it("reads a file in helmfile.d and leaves other files alone", () => {
        const text = "releases:\n  - name: app\n    chart: ../../charts/app\n"
        const inD = join(FIXTURES, "helmfile", "helmfile.d", "10-app.yaml")
        expect(readText(readHelmfile, inD, text)).toHaveLength(1)
        expect(readText(readHelmfile, join(FIXTURES, "helmfile", "app.yaml"), text)).toEqual([])
    })
})

describe("readFluxHelmReleases", () => {
    it("passes valuesFiles, valuesFrom, spec.values, then the targetPath values", () => {
        const spec = only(read(readFluxHelmReleases, FLUX_RELEASE))
        expect(layerLabels(spec)).toEqual([
            "file charts/app/values.yaml",
            "file charts/app/values-base.yaml",
            "inline ConfigMap web-values values.yaml",
            "file ConfigMap web-env env.yaml",
            "object spec.values",
            "parameters valuesFrom targetPath"
        ])
        expect(spec).toMatchObject({
            id: `${FLUX_RELEASE}:3:web`,
            name: "web",
            origin: "Flux HelmRelease",
            appLine: 3,
            releaseName: "web-web",
            namespace: "web",
            chart: { kind: "directory", dir: join(FIXTURES, "charts", "app") }
        })
    })

    it("maps a ConfigMap block, a generator file and a Secret key to their sources", () => {
        const spec = only(read(readFluxHelmReleases, FLUX_RELEASE))
        const configMap = layer(spec, "ConfigMap web-values values.yaml")
        expect(configMap).toMatchObject({
            fsPath: join(FIXTURES, "flux", "configmap.yaml"),
            offset: { lineDelta: 8, columnDelta: 4 }
        })
        expect(layer(spec, "ConfigMap web-env env.yaml")).toMatchObject({
            fsPath: join(FIXTURES, "flux", "values", "env.yaml")
        })
        const targetPaths = layer(spec, "valuesFrom targetPath")
        expect(targetPaths.kind === "parameters" && targetPaths.parameters).toEqual([
            { name: "image.tag", value: "4.2", forceString: false },
            { name: "cache.ttl", value: "300", forceString: false }
        ])
        expect(siteOf(targetPaths, "cache", "ttl")).toEqual({ line: 28, column: 18 })
        expect(siteOf(layer(spec, "spec.values"), "image", "tag")).toEqual({ line: 35, column: 6 })
    })

    it("resolves a HelmRepository, an OCI HelmRepository and a chartRef to an OCIRepository", () => {
        const fsPath = join(FIXTURES, "flux", "remote", "releases.yaml")
        const sources: WorkspaceFile = {
            fsPath: join(FIXTURES, "flux", "remote", "sources.yaml"),
            text: [
                "apiVersion: source.toolkit.fluxcd.io/v1",
                "kind: HelmRepository",
                "metadata: { name: bitnami, namespace: flux-system }",
                "spec: { url: https://charts.bitnami.com/bitnami }",
                "---",
                "apiVersion: source.toolkit.fluxcd.io/v1",
                "kind: HelmRepository",
                "metadata: { name: ghcr, namespace: flux-system }",
                "spec: { type: oci, url: oci://ghcr.io/org/charts }",
                "---",
                "apiVersion: source.toolkit.fluxcd.io/v1beta2",
                "kind: OCIRepository",
                "metadata: { name: podinfo, namespace: apps }",
                "spec: { url: oci://ghcr.io/stefanprodan/charts/podinfo, ref: { tag: 6.5.0 } }",
                ""
            ].join("\n")
        }
        const release = (name: string, apiVersion: string, chart: string) =>
            `apiVersion: ${apiVersion}\nkind: HelmRelease\nmetadata: { name: ${name}, namespace: apps }\nspec:\n${chart}`
        const text = [
            release(
                "redis",
                "helm.toolkit.fluxcd.io/v2beta1",
                "  chart:\n    spec:\n      chart: redis\n      version: 1.2.3\n      sourceRef: { kind: HelmRepository, name: bitnami, namespace: flux-system }\n      valuesFiles: [values-prod.yaml]\n"
            ),
            release(
                "app",
                "helm.toolkit.fluxcd.io/v2beta2",
                "  chart:\n    spec:\n      chart: app\n      version: '*'\n      sourceRef: { kind: HelmRepository, name: ghcr, namespace: flux-system }\n"
            ),
            release(
                "podinfo",
                "helm.toolkit.fluxcd.io/v2",
                "  chartRef: { kind: OCIRepository, name: podinfo }\n"
            ),
            release(
                "lost",
                "helm.toolkit.fluxcd.io/v2",
                "  chartRef: { kind: OCIRepository, name: lost }\n"
            )
        ].join("---\n")
        const specs = readText(readFluxHelmReleases, fsPath, text, sources)
        expect(specs.map((spec) => spec.chart)).toEqual([
            {
                kind: "repository",
                repoURL: "https://charts.bitnami.com/bitnami",
                chart: "redis",
                version: "1.2.3"
            },
            { kind: "repository", repoURL: "ghcr.io/org/charts", chart: "app", version: "" },
            {
                kind: "repository",
                repoURL: "ghcr.io/stefanprodan/charts",
                chart: "podinfo",
                version: "6.5.0"
            },
            { kind: "unresolved", reason: "no OCIRepository lost in the workspace" }
        ])
        expect(specs[0]!.layers.map(problemOf)).toEqual([
            "a values file inside the chart from https://charts.bitnami.com/bitnami gets no lookup"
        ])
    })

    it("reads a quoted or literal targetPath value as a string and reports a missing reference", () => {
        const fsPath = join(FIXTURES, "flux", "strings", "release.yaml")
        const configMap: WorkspaceFile = {
            fsPath: join(FIXTURES, "flux", "strings", "configmap.yaml"),
            text: "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: strings }\ndata:\n  quoted: '\"42\"'\n  plain: '42'\n"
        }
        const text = [
            "apiVersion: helm.toolkit.fluxcd.io/v2",
            "kind: HelmRelease",
            "metadata: { name: strings }",
            "spec:",
            "  releaseName: custom",
            "  chart: { spec: { chart: ./charts/app, sourceRef: { kind: GitRepository, name: fixtures, namespace: flux-system } } }",
            "  valuesFrom:",
            "    - { kind: ConfigMap, name: strings, valuesKey: quoted, targetPath: a }",
            "    - { kind: ConfigMap, name: strings, valuesKey: plain, targetPath: b, literal: true }",
            "    - { kind: ConfigMap, name: strings, valuesKey: plain, targetPath: c }",
            "    - { kind: Secret, name: absent, optional: true }",
            ""
        ].join("\n")
        const spec = only(readText(readFluxHelmReleases, fsPath, text, configMap))
        expect(spec.releaseName).toBe("custom")
        expect(layerLabels(spec)).toEqual([
            "file Secret absent values.yaml",
            "parameters valuesFrom targetPath"
        ])
        expect(problemOf(spec.layers[0]!)).toBe("no Secret absent in the workspace (optional)")
        const parameters = spec.layers[1]!
        expect(parameters.kind === "parameters" && parameters.parameters).toEqual([
            { name: "a", value: "42", forceString: true },
            { name: "b", value: "42", forceString: true },
            { name: "c", value: "42", forceString: false }
        ])
    })

    it("shortens a default release name above 53 characters with a hash", () => {
        const name = "a-very-long-helm-release-name-that-goes-on"
        const text = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata: { name: ${name} }\nspec: { targetNamespace: another-long-namespace }\n`
        const spec = only(
            readText(readFluxHelmReleases, join(FIXTURES, "flux", "long", "release.yaml"), text)
        )
        expect(spec.releaseName).toBe("another-long-namespace-a-very-long-helm--7526b5bcaf51")
    })
})

describe("readKustomizeHelmCharts", () => {
    it("orders valuesFile and valuesInline as valuesMerge says, then additionalValuesFiles", () => {
        const [override, merge, replace] = read(readKustomizeHelmCharts, KUSTOMIZATION)
        expect(layerLabels(override!)).toEqual([
            "file values/base.yaml",
            "object valuesInline",
            "file values/extra.yaml"
        ])
        expect(layerLabels(merge!)).toEqual([
            "object valuesInline",
            "file chart values.yaml (valuesMerge: merge)"
        ])
        expect(layer(merge!, "chart values.yaml (valuesMerge: merge)")).toMatchObject({
            fsPath: join(FIXTURES, "charts", "dump", "values.yaml")
        })
        expect(layerLabels(replace!)).toEqual(["object valuesInline"])
    })

    it("names each chart after its releaseName and finds it under chartHome", () => {
        const [override] = read(readKustomizeHelmCharts, KUSTOMIZATION)
        expect(override).toMatchObject({
            id: `${KUSTOMIZATION}:5:kapp`,
            name: "kapp",
            origin: "Kustomize helmCharts",
            appLine: 5,
            releaseName: "kapp",
            namespace: "kust",
            chart: { kind: "directory", dir: join(FIXTURES, "charts", "app") }
        })
        expect(siteOf(layer(override!, "valuesInline"), "podAnnotations", "team")).toEqual({
            line: 12,
            column: 8
        })
    })

    it("pulls a chart with a repo and lets a local chart under chartHome win", () => {
        const fsPath = join(FIXTURES, "kustomize", "remote", "kustomization.yaml")
        const text = [
            "helmGlobals: { chartHome: ../.. }",
            "helmCharts:",
            "  - { name: redis, repo: https://charts.bitnami.com/bitnami, version: 1.2.3 }",
            "  - { name: web, repo: oci://ghcr.io/org/charts, version: 0.4.0, valuesMerge: merge, valuesInline: { a: 1 } }",
            "  - { name: charts, repo: https://charts.example.com }",
            "  - { name: lost }",
            "  - { name: bad, repo: https://charts.example.com, valuesMerge: deep }",
            ""
        ].join("\n")
        const specs = readText(readKustomizeHelmCharts, fsPath, text)
        expect(specs.map((spec) => spec.chart)).toEqual([
            {
                kind: "repository",
                repoURL: "https://charts.bitnami.com/bitnami",
                chart: "redis",
                version: "1.2.3"
            },
            { kind: "repository", repoURL: "ghcr.io/org/charts", chart: "web", version: "0.4.0" },
            { kind: "directory", dir: join(FIXTURES, "charts") },
            {
                kind: "unresolved",
                reason: `no repo specified for pull, no chart found at ${join(FIXTURES, "lost")}`
            },
            { kind: "repository", repoURL: "https://charts.example.com", chart: "bad", version: "" }
        ])
        expect(specs[1]!.layers.map(problemOf)).toEqual([
            undefined,
            "the values of a chart from a repository win over valuesInline, which the trace leaves out"
        ])
        expect(specs[4]!.layers.map(problemOf)).toEqual([
            "valuesMerge must be one of merge,override,replace"
        ])
    })
})

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

/** Drops the `global` that Helm copies into each dependency and the empty `global` at the top. */
function withoutCopiedGlobals(values: unknown, keys: readonly string[]): unknown {
    const copy = structuredClone(values) as Record<string, Record<string, unknown>>
    for (const key of keys) delete copy[key]?.global
    if (JSON.stringify(copy.global) === "{}") delete (copy as Record<string, unknown>).global
    return copy
}

const CACHE_DIR = join(homedir(), ".cache", "helm-values-lens")

async function withScratch<T>(run: (scratch: string) => Promise<T> | T): Promise<T> {
    const scratch = mkdtempSync(join(tmpdir(), "helm-values-lens-test-"))
    try {
        return await run(scratch)
    } finally {
        rmSync(scratch, { recursive: true, force: true })
    }
}

describe.skipIf(!hasHelm)("the trace agrees with the COMPUTED VALUES of helm", () => {
    for (const spec of fixtureReleases())
        it(`for ${spec.origin} ${spec.name}`, async () => {
            const release = await loadRelease(spec, CACHE_DIR, "helm")
            expect(release.problems).toEqual([])
            const keys = release.chart.dependencies.map((dependency) => dependency.key)
            const helm = await withScratch((scratch) =>
                withoutCopiedGlobals(computedValues(helmArgs(release, scratch)), keys)
            )
            expect(withoutCopiedGlobals(release.trace.final, keys)).toEqual(helm)
        })
})

/** Sorts the keys of each map, since kustomize writes them sorted and Helm in the order of the template. */
function sortedKeys(data: unknown): unknown {
    if (Array.isArray(data)) return data.map(sortedKeys)
    if (data === null || typeof data !== "object") return data
    return Object.fromEntries(
        Object.entries(data)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [key, sortedKeys(value)])
    )
}

/** The documents of a multi-document manifest text, sorted to compare two renders. */
function documents(manifests: string): string[] {
    return parseAllDocuments(manifests)
        .map((document) => document.toJSON() as unknown)
        .filter((document) => document !== null)
        .map((document) => JSON.stringify(sortedKeys(document)))
        .sort()
}

/** Renders the releases with `helm template`, handing Helm the layers as the trace reads them. */
async function renderedByHelm(specs: ReleaseSpec[]): Promise<string[]> {
    const manifests: string[] = []
    for (const spec of specs) {
        const release = await loadRelease(spec, CACHE_DIR, "helm")
        manifests.push(
            await withScratch((scratch) =>
                execFileSync("helm", ["template", ...helmArgs(release, scratch)], {
                    encoding: "utf8"
                })
            )
        )
    }
    return documents(manifests.join("\n---\n"))
}

function renderedByTool(command: string, args: string[]): string[] {
    return documents(
        execFileSync(command, args, {
            cwd: FIXTURES,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        })
    )
}

describe("the layers render as the tool renders them", () => {
    it.skipIf(!hasHelmfile)("for helmfile template", async () => {
        const args = ["-f", HELMFILE, "template", "--skip-deps"]
        expect(await renderedByHelm(read(readHelmfile, HELMFILE))).toEqual(
            renderedByTool("helmfile", args)
        )
    })

    it.skipIf(!hasHelmfile)("for helmfile template in each environment", async () => {
        const specs = read(readHelmfile, HELMFILE_ENVIRONMENTS)
        for (const environment of ["dev", "prod"]) {
            const args = ["-f", HELMFILE_ENVIRONMENTS, "-e", environment, "template", "--skip-deps"]
            const ours = specs.filter((spec) => spec.id.endsWith(`:${environment}`))
            expect(await renderedByHelm(ours)).toEqual(renderedByTool("helmfile", args))
        }
    })

    it.skipIf(!hasKustomize)("for kustomize build --enable-helm", async () => {
        const args = [
            "build",
            "--enable-helm",
            "--load-restrictor",
            "LoadRestrictionsNone",
            join(FIXTURES, "kustomize")
        ]
        expect(await renderedByHelm(read(readKustomizeHelmCharts, KUSTOMIZATION))).toEqual(
            renderedByTool("kustomize", args)
        )
    })
})
