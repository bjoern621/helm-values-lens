import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import type { Release } from "../src/release"
import { type FileEdit, planRename, type RenameContext, renameEdits } from "../src/rename"
import { findReleases, loadRelease } from "../src/workspace"
import { FIXTURES, fixtureCheckout } from "./fixtures"

let context: RenameContext

beforeAll(async () => {
    const specs = findReleases([FIXTURES], undefined, fixtureCheckout)
    const cache = join(homedir(), ".cache", "helm-values-lens")
    const releases: Release[] = await Promise.all(
        specs.map((spec) => loadRelease(spec, cache, "helm"))
    )
    context = {
        releases,
        failed: [],
        readText: (fsPath) => readFileSync(fsPath, "utf8"),
        editable: (fsPath) => fsPath.startsWith(FIXTURES + "/"),
        describe: (fsPath) => fsPath.slice(FIXTURES.length + 1)
    }
})

/** Plans the rename at the first place on the line holding `text`, at the column of `text` plus `shift`. */
const planAt = (relative: string, text: string, shift = 0) => {
    const fsPath = join(FIXTURES, relative)
    const lines = readFileSync(fsPath, "utf8").split("\n")
    const line = lines.findIndex((each) => each.includes(text))
    return planRename(context, fsPath, { line, column: lines[line]!.indexOf(text) + shift })
}

/** Each edit as the file and line that it changes, with the new text in place. */
const applied = (edits: FileEdit[]) =>
    edits.map((edit) => {
        const line = readFileSync(edit.fsPath, "utf8").split("\n")[edit.start.line]!
        const changed = line.slice(0, edit.start.column) + edit.text + line.slice(edit.end.column)
        return `${edit.fsPath.slice(FIXTURES.length + 1)}: ${changed.trim()}`
    })

/** The edits of a plan that goes ahead, as `applied` lists them. */
const renamed = (plan: ReturnType<typeof planAt>, name: string) => {
    if (typeof plan !== "object") throw new Error(`no plan: ${plan}`)
    const edits = renameEdits(plan, name)
    if (typeof edits === "string") throw new Error(edits)
    return applied(edits)
}

describe("renaming a key", () => {
    it("renames it in every layer of each release that shares a changed file", () => {
        expect(renamed(planAt("charts/app/values.yaml", "podAnnotations"), "annotations")).toEqual([
            "charts/app/values.yaml: annotations: {}",
            "apps/demo.yaml: annotations:",
            "apps/demo.yaml: - name: annotations.note",
            "appset/git-directories.yaml: annotations:",
            "appset/matrix.yaml: annotations:",
            "flux/release.yaml: annotations:",
            "helmfile/helmfile.yaml: annotations:",
            "helmfile/helmfile.yaml: - name: annotations.note",
            "kustomize/kustomization.yaml: annotations:",
            "kustomize/values/extra.yaml: annotations:"
        ])
    })

    it("renames the segment of a .Values read under the cursor and the keys that it reads", () => {
        expect(renamed(planAt("charts/app/templates/configmap.yaml", "region }}"), "zone")).toEqual(
            [
                "charts/app/values.yaml: zone: eu",
                "charts/app/templates/configmap.yaml: region: {{ .Values.global.zone }}"
            ]
        )
    })

    it("renames the segment of a parameter name under the cursor alone, in the release that sets it", () => {
        expect(renamed(planAt("apps/demo.yaml", "note"), "comment")).toEqual([
            "apps/demo.yaml: - name: podAnnotations.comment"
        ])
    })

    it("finds nothing to rename beside a key", () => {
        expect(planAt("charts/app/values.yaml", "nginx")).toBeUndefined()
    })
})

describe("refusing a rename", () => {
    it("refuses a key inside a map that a template reads whole", () => {
        expect(planAt("charts/app/values.yaml", "cpu")).toBe(
            "The rename cannot change `resources.limits.cpu`, since line 8 of charts/app/templates/configmap.yaml reads all of `resources.limits` and would still render the old name."
        )
    })

    it("refuses the key of a dependency and global", () => {
        expect(planAt("charts/app/values.yaml", "cache")).toMatch(
            /hands the values under it to a dependency/
        )
        expect(planAt("charts/app/values.yaml", "global")).toMatch(/to every dependency/)
    })

    it("refuses a key that a schema describes", () => {
        expect(planAt("charts/app/charts/sub/values.yaml", "ttl")).toMatch(
            /^The rename cannot change `cache.ttl`, since a values.schema.json of chart app describes it/
        )
    })

    it("refuses a name that a release already uses beside the key", () => {
        const plan = planAt("charts/app/values.yaml", "mode")
        if (typeof plan !== "object") throw new Error(`no plan: ${plan}`)
        expect(renameEdits(plan, "enabled")).toMatch(/^Release \S+ already uses `legacy.enabled`/)
        expect(renameEdits(plan, "a.b")).toMatch(/^A key name must start with a letter/)
    })

    it("refuses a hyphen where a template reads the key", () => {
        const plan = planAt("charts/app/templates/configmap.yaml", "region }}")
        if (typeof plan !== "object") throw new Error(`no plan: ${plan}`)
        expect(renameEdits(plan, "cloud-region")).toMatch(/^A hyphen would end the read/)
    })

    it("refuses where a chart that sets the key sits outside the workspace", () => {
        const outside = { ...context, editable: (fsPath: string) => !fsPath.includes("/charts/") }
        const fsPath = join(FIXTURES, "apps/demo.yaml")
        const line = readFileSync(fsPath, "utf8")
            .split("\n")
            .findIndex((each) => each.includes("podAnnotations:"))
        expect(planRename(outside, fsPath, { line, column: 12 })).toBe(
            "The rename cannot change `podAnnotations`, since chart app sits outside the workspace."
        )
    })

    it("refuses where a release that did not load reads a changed file", () => {
        const spec = context.releases.find((release) => release.spec.name === "demo")!.spec
        const failing = { ...context, failed: [{ ...spec, name: "broken" }] }
        const fsPath = join(FIXTURES, "apps/demo.yaml")
        const line = readFileSync(fsPath, "utf8")
            .split("\n")
            .findIndex((each) => each.includes("name: podAnnotations.note"))
        expect(planRename(failing, fsPath, { line, column: 33 })).toMatch(
            /since release broken did not load and also reads apps\/demo.yaml\.$/
        )
    })
})
