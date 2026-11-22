import { describe, expect, it } from "vitest"
import { coalesce, type Layer } from "../src/coalesce"
import {
    removableAsDefault,
    removeKeysEdits,
    renameKeyEdit,
    similarKeys,
    type TextEdit
} from "../src/quickFixes"
import type { Release } from "../src/release"
import { parseValues, pathKey } from "../src/yamlPaths"

const layer = (label: string, text: string, kind: Layer["kind"] = "file"): Layer => {
    const { data, sites } = parseValues(text)
    return { kind, label, fsPath: `/${label}`, offset: undefined, data, sites }
}

const releaseOf = (layers: Layer[], reads: string[][] = []): Release =>
    ({
        trace: coalesce(layers),
        firstUserLayer: 1,
        readPaths: new Set(reads.map(pathKey))
    }) as unknown as Release

const apply = (text: string, edits: readonly TextEdit[]) =>
    [...edits]
        .sort((a, b) => b.start - a.start)
        .reduce(
            (result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end),
            text
        )

const DEFAULTS = "replicas: 1\nimage:\n  repository: nginx\n  tag: latest\nservice:\n  port: 80\n"

describe("a key equal to the chart default", () => {
    it("counts as removable where no user layer below sets it", () => {
        const release = releaseOf([
            layer("values.yaml", DEFAULTS, "chart"),
            layer("prod.yaml", "replicas: 1\nimage:\n  tag: latest\n")
        ])
        expect(removableAsDefault(release, 1, ["replicas"])).toBe(true)
        expect(removableAsDefault(release, 1, ["image", "tag"])).toBe(true)
    })

    it("stays where removing it would bring back a lower user layer", () => {
        const release = releaseOf([
            layer("values.yaml", DEFAULTS, "chart"),
            layer("base.yaml", "replicas: 3\n"),
            layer("prod.yaml", "replicas: 1\n")
        ])
        expect(removableAsDefault(release, 2, ["replicas"])).toBe(false)
    })
})

describe("removing keys", () => {
    it("deletes the line of a scalar", () => {
        const text = "replicas: 1 # one pod\nimage:\n  tag: v2\n"
        expect(apply(text, removeKeysEdits(text, [["replicas"]])!)).toBe("image:\n  tag: v2\n")
    })

    it("deletes a map that the removal leaves empty, since `image:` alone deletes the defaults", () => {
        const text = "image:\n  tag: latest\nreplicas: 2\n"
        expect(apply(text, removeKeysEdits(text, [["image", "tag"]])!)).toBe("replicas: 2\n")
    })

    it("keeps a map that holds other keys", () => {
        const text = "image:\n  repository: nginx\n  tag: latest\n"
        expect(apply(text, removeKeysEdits(text, [["image", "repository"]])!)).toBe(
            "image:\n  tag: latest\n"
        )
    })

    it("deletes a key on the last line without a newline", () => {
        const text = "replicas: 2\nport: 80"
        expect(apply(text, removeKeysEdits(text, [["port"]])!)).toBe("replicas: 2\n")
    })

    it("leaves a flow map alone", () => {
        expect(removeKeysEdits("image: {tag: latest}\n", [["image", "tag"]])).toBeUndefined()
    })
})

describe("an unknown key", () => {
    const release = releaseOf(
        [layer("values.yaml", DEFAULTS, "chart"), layer("prod.yaml", "image:\n  tga: v2\n")],
        [["image", "pullPolicy"]]
    )

    it("gets the known keys a typo away", () => {
        expect(similarKeys(release, ["image", "tga"])).toEqual(["tag"])
        expect(similarKeys(release, ["image", "pulPolicy"])).toEqual(["pullPolicy"])
        expect(similarKeys(release, ["image", "registry"])).toEqual([])
    })

    it("gets renamed in place", () => {
        const text = "image:\n  tga: v2 # pinned\n"
        expect(apply(text, [renameKeyEdit(text, ["image", "tga"], "tag")!])).toBe(
            "image:\n  tag: v2 # pinned\n"
        )
    })
})
