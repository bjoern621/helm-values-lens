import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { explain } from "../src/coalesce"
import { annotatedFinalValues } from "../src/finalValues"
import { targetsAt, templateHints, valueHints } from "../src/hints"
import { chainMarkdown } from "../src/markdown"
import type { Release } from "../src/release"
import { findReleases, loadRelease } from "../src/workspace"
import { FIXTURES, fixtureCheckout } from "./fixtures"

const APP = join(FIXTURES, "apps/demo.yaml")
const BASE = join(FIXTURES, "charts/app/values-base.yaml")
const PROD = join(FIXTURES, "envs/prod.yaml")
const CHART_VALUES = join(FIXTURES, "charts/app/values.yaml")

let release: Release

beforeAll(async () => {
    const [spec] = findReleases([FIXTURES], undefined, fixtureCheckout)
    release = await loadRelease(spec!, join(homedir(), ".cache", "helm-values-lens"), "helm")
})

const lineOf = (fsPath: string, text: string) =>
    readFileSync(fsPath, "utf8")
        .split("\n")
        .findIndex((line) => line.includes(text))

const hintOn = (fsPath: string, text: string) =>
    valueHints(fsPath, [release]).find((hint) => hint.position.line === lineOf(fsPath, text))?.label

describe("the Application", () => {
    it("orders the layers as Argo CD does", () => {
        expect(release.spec.releaseName).toBe("demo-release")
        expect(release.trace.layers.map((layer) => layer.label)).toEqual([
            "cache chart values.yaml",
            "chart values.yaml",
            "values-base.yaml",
            "envs/prod.yaml",
            "helm.values",
            "helm.parameters"
        ])
    })

    it("resolves $values to the checkout of the ref source", () => {
        expect(release.trace.layers[3]!.fsPath).toBe(PROD)
    })
})

describe("the trace", () => {
    it("lets the last layer win and marks the earlier ones overridden", () => {
        const { final, settings } = explain(release.trace, ["replicas"])
        expect(final).toBe(3)
        expect(settings.map((setting) => setting.status)).toEqual([
            "overridden",
            "overridden",
            "wins"
        ])
    })

    it("deletes a key that a layer sets to null", () => {
        expect(explain(release.trace, ["resources", "limits", "memory"]).final).toBeUndefined()
        expect(explain(release.trace, ["legacy", "mode"]).settings[0]!.status).toBe("deleted")
    })

    it("replaces a list as a whole", () => {
        expect(explain(release.trace, ["tolerations"]).final).toEqual([{ key: "a" }])
    })

    it("lets the parent override a dependency under its alias", () => {
        expect(explain(release.trace, ["cache", "size"]).final).toBe(20)
        expect(explain(release.trace, ["cache", "ttl"]).final).toBe(120)
    })

    it("types --set values and keeps forceString text", () => {
        expect(explain(release.trace, ["podAnnotations", "note"]).final).toBe("true")
    })
})

describe("the hints", () => {
    it("name the layer that overrides a value and the final value", () => {
        expect(hintOn(BASE, "replicas: 2")).toBe("overridden by helm.values: 3")
        expect(hintOn(CHART_VALUES, "tag:")).toBe("overridden by envs/prod.yaml: 2.0")
    })

    it("name the layer that deletes a value", () => {
        expect(hintOn(CHART_VALUES, "mode: a")).toBe("deleted by envs/prod.yaml")
    })

    it("sit on the lines of the inline block in the Application", () => {
        const hints = valueHints(APP, [release])
        expect(hints.some((hint) => hint.position.line === lineOf(APP, "replicas: 3"))).toBe(false)
        const parameter = hints.find(
            (hint) => hint.position.line === lineOf(APP, "name: image.repository")
        )
        expect(parameter).toBeUndefined()
    })

    it("show the final value after each .Values read in a template", () => {
        const file = join(FIXTURES, "charts/app/templates/configmap.yaml")
        const labels = templateHints(file, readFileSync(file, "utf8"), [release]).map(
            (hint) => hint.label
        )
        expect(labels).toEqual(["myrepo", "2.0", "3", "{1 keys}", "eu"])
    })

    it("span the whole .Values path in a template and the whole setting in a values file", () => {
        const file = join(FIXTURES, "charts/app/templates/configmap.yaml")
        const lines = readFileSync(file, "utf8").split("\n")
        const spans = templateHints(file, lines.join("\n"), [release]).map((hint) =>
            lines[hint.start.line]!.slice(hint.start.column, hint.position.column)
        )
        expect(spans[0]).toBe(".Values.image.repository")
        const base = readFileSync(BASE, "utf8").split("\n")
        const replicas = valueHints(BASE, [release]).find(
            (hint) => hint.position.line === lineOf(BASE, "replicas: 2")
        )!
        expect(
            base[replicas.start.line]!.slice(replicas.start.column, replicas.position.column)
        ).toBe("replicas: 2")
    })

    it("read the values of a dependency under its alias", () => {
        const file = join(FIXTURES, "charts/app/charts/sub/templates/configmap.yaml")
        const labels = templateHints(file, readFileSync(file, "utf8"), [release]).map(
            (hint) => hint.label
        )
        expect(labels).toEqual(["20", "120"])
    })
})

describe("the hover chain", () => {
    it("marks each setting with what became of it", () => {
        const chain = chainMarkdown(release, ["replicas"], BASE)
        expect(chain).toContain("$(circle-slash) *overridden* · [values-base.yaml]")
        expect(chain).toContain("$(pass-filled) *final* · [helm.values]")
        expect(chain).not.toContain("*not set*")
    })

    it("lists the layers that leave the path alone once asked to", () => {
        const chain = chainMarkdown(release, ["replicas"], BASE, true)
        expect(chain).toContain("$(circle-large-outline) *not set* · [envs/prod.yaml]")
    })
})

describe("the final values", () => {
    it("name the file and line that set each value", () => {
        const text = annotatedFinalValues(release, FIXTURES)
        expect(text).toContain(`replicas: 3 # helm.values:${lineOf(APP, "replicas: 3") + 1}`)
        expect(text).toContain('tag: "2.0" # envs/prod.yaml:2')
        expect(text).toContain("repository: myrepo # helm.parameters")
    })
})

describe("the target under the cursor", () => {
    const CONFIGMAP = join(FIXTURES, "charts/app/templates/configmap.yaml")
    const targetAt = (fsPath: string, line: number, column: number) => {
        const lineText = readFileSync(fsPath, "utf8").split("\n")[line]!
        return targetsAt(fsPath, lineText, { line, column }, [release]).map((target) =>
            target.path.join(".")
        )
    }

    it("takes the one .Values read of a line that the cursor sits on", () => {
        const line = lineOf(CONFIGMAP, "image:")
        const text = readFileSync(CONFIGMAP, "utf8").split("\n")[line]!
        expect(targetAt(CONFIGMAP, line, text.indexOf("repository"))).toEqual(["image.repository"])
        expect(targetAt(CONFIGMAP, line, text.indexOf("tag"))).toEqual(["image.tag"])
        expect(targetAt(CONFIGMAP, line, 0)).toEqual([])
    })

    it("takes a key of a values file from its name to the end of its value", () => {
        const line = lineOf(BASE, "replicas: 2")
        expect(targetAt(BASE, line, 0)).toEqual(["replicas"])
        expect(targetAt(BASE, line, "replicas: 2".length)).toEqual(["replicas"])
    })

    it("highlights the name of a key alone, so that a hint after its value stays apart", () => {
        const line = lineOf(BASE, "replicas: 2")
        const lineText = readFileSync(BASE, "utf8").split("\n")[line]!
        const [target] = targetsAt(BASE, lineText, { line, column: lineText.length }, [release])
        expect(lineText.slice(target!.start.column, target!.end.column)).toBe("replicas")
    })

    it("takes a key of the inline block of an Application", () => {
        const line = lineOf(APP, "replicas: 3")
        const text = readFileSync(APP, "utf8").split("\n")[line]!
        expect(targetAt(APP, line, text.indexOf("replicas"))).toEqual(["replicas"])
    })
})
