import { describe, expect, it } from "vitest"
import { coalesce, type Layer } from "../src/coalesce"
import {
    documentEdits,
    ignoredKeys,
    insertKeyEdit,
    keyGroups,
    moveTargets,
    removableAsDefault,
    removeKeysEdits,
    renameKeyEdit,
    similarKeys,
    type TextEdit,
    valuesRegion
} from "../src/quickFixes"
import type { SettingSite } from "../src/hints"
import type { Release } from "../src/release"
import { parseValues, pathKey, splitPathKey } from "../src/yamlPaths"

const layer = (label: string, text: string, kind: Layer["kind"] = "file"): Layer => {
    const { data, sites } = parseValues(text)
    return { kind, label, fsPath: `/${label}`, offset: undefined, data, sites }
}

let releases = 0
const releaseOf = (layers: Layer[], reads: string[][] = []): Release =>
    ({
        spec: { id: String(++releases) },
        chart: { schemas: [] },
        trace: coalesce(layers),
        defaults: coalesce(layers.slice(0, 1)).final,
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

    it("marks the outermost key that the chart of some release ignores, in a file shared with other charts", () => {
        const globals = layer("globals.yaml", "global:\n  tracing: true\n  colour: blue\n")
        const web = releaseOf([layer("values.yaml", DEFAULTS, "chart"), globals])
        const api = releaseOf(
            [layer("values.yaml", DEFAULTS, "chart"), globals],
            [["global", "tracing"]]
        )
        const names = (sites: SettingSite[]) =>
            sites.map(({ release }) => (release === web ? "web" : "api"))
        expect(
            ignoredKeys(keyGroups("/globals.yaml", [web, api])).map((use) => [
                use.group.path.join("."),
                names(use.readers),
                names(use.ignorers)
            ])
        ).toEqual([
            ["global", ["api"], ["web"]],
            ["global.colour", [], ["web", "api"]]
        ])
    })

    it("gets renamed in place", () => {
        const text = "image:\n  tga: v2 # pinned\n"
        expect(apply(text, [renameKeyEdit(text, ["image", "tga"], "tag")!])).toBe(
            "image:\n  tag: v2 # pinned\n"
        )
    })
})

describe("a key that the chart of some release ignores", () => {
    const chart = () => layer("values.yaml", DEFAULTS, "chart")
    const globals = layer("globals.yaml", "global:\n  tracing: true\n")
    const reads = [["global", "tracing"]]
    const partlyRead = (releases: Release[]) =>
        ignoredKeys(keyGroups("/globals.yaml", releases)).find((use) => use.readers.length > 0)!

    it("moves to a values file that only the releases reading it take", () => {
        const web = releaseOf([chart(), globals, layer("web.yaml", "replicas: 2\n")])
        const api = releaseOf([chart(), globals, layer("api.yaml", "replicas: 3\n")], reads)
        const both = layer("both.yaml", "replicas: 4\n")
        web.trace = coalesce([...web.trace.layers, both])
        api.trace = coalesce([...api.trace.layers, both])
        expect(moveTargets(partlyRead([web, api]), [web, api])).toEqual(["/api.yaml"])
    })

    it("stays where a move would change the final value", () => {
        const web = releaseOf([chart(), globals])
        const api = releaseOf(
            [
                chart(),
                globals,
                layer("staging.yaml", "global:\n  tracing: false\n"),
                layer("api.yaml", "replicas: 3\n")
            ],
            reads
        )
        expect(moveTargets(partlyRead([web, api]), [web, api])).toEqual([])
    })

    it("gets inserted below the deepest map that the target file holds", () => {
        const text = "global:\n  domain: example.com\nreplicas: 2\n"
        expect(apply(text, [insertKeyEdit(text, ["global", "tracing", "enabled"], true)!])).toBe(
            "global:\n  domain: example.com\n  tracing:\n    enabled: true\nreplicas: 2\n"
        )
    })

    it("takes the indentation of the target file", () => {
        const text = "image:\n    tag: v1"
        expect(apply(text, [insertKeyEdit(text, ["image", "pullPolicy"], "Always")!])).toBe(
            "image:\n    tag: v1\n    pullPolicy: Always\n"
        )
        expect(apply(text, [insertKeyEdit(text, ["service", "port"], 80)!])).toBe(
            "image:\n    tag: v1\nservice:\n    port: 80\n"
        )
    })

    it("fills an empty target file", () => {
        expect(insertKeyEdit("", ["global", "tracing"], true)?.text).toBe(
            "global:\n  tracing: true\n"
        )
    })

    it("leaves a target file alone that sets the key or a scalar above it", () => {
        expect(
            insertKeyEdit("global:\n  tracing: false\n", ["global", "tracing"], true)
        ).toBeUndefined()
        expect(insertKeyEdit("global: off\n", ["global", "tracing"], true)).toBeUndefined()
    })
})

describe("a values block inside an Application", () => {
    const APPLICATION = [
        "spec:",
        "  source:",
        "    helm:",
        "      values: |",
        "        replicas: 1",
        "        image:",
        "          tag: latest",
        "      valueFiles: []",
        ""
    ].join("\n")
    const inline = (): Layer => {
        const { data, sites } = parseValues("replicas: 1\nimage:\n  tag: latest\n")
        return {
            kind: "inline",
            label: "helm.values",
            fsPath: "/app.yaml",
            offset: { lineDelta: 4, columnDelta: 8 },
            data,
            sites
        }
    }

    it("cuts the block out of the document without its indent", () => {
        const region = valuesRegion(APPLICATION, inline())!
        expect(region.text).toBe("replicas: 1\nimage:\n  tag: latest\n")
    })

    it("removes a key from the document with its whole line", () => {
        const region = valuesRegion(APPLICATION, inline())!
        const edits = documentEdits(
            APPLICATION,
            region,
            removeKeysEdits(region.text, [["replicas"]])!
        )
        expect(apply(APPLICATION, edits)).toBe(APPLICATION.replace("        replicas: 1\n", ""))
    })

    it("removes a map that the removal leaves empty", () => {
        const region = valuesRegion(APPLICATION, inline())!
        const edits = documentEdits(
            APPLICATION,
            region,
            removeKeysEdits(region.text, [["image", "tag"]])!
        )
        expect(apply(APPLICATION, edits)).toBe(
            APPLICATION.replace("        image:\n          tag: latest\n", "")
        )
    })

    it("renames a key in the document", () => {
        const region = valuesRegion(APPLICATION, inline())!
        const edits = documentEdits(APPLICATION, region, [
            renameKeyEdit(region.text, ["replicas"], "replicaCount")!
        ])
        expect(apply(APPLICATION, edits)).toBe(
            APPLICATION.replace("replicas: 1", "replicaCount: 1")
        )
    })

    it("finds a valuesObject map from the place of its keys", () => {
        const document = [
            "spec:",
            "  source:",
            "    helm:",
            "      valuesObject:",
            "        replicas: 1",
            "        image:",
            "          tag: latest",
            "  destination: {}",
            ""
        ].join("\n")
        const { data, sites } = parseValues(document)
        const shifted = new Map(
            [...sites]
                .filter(([key]) =>
                    key.startsWith(pathKey(["spec", "source", "helm", "valuesObject"]))
                )
                .map(([key, site]) => [pathKey(splitPathKey(key).slice(4)), site])
        )
        const layer: Layer = {
            kind: "object",
            label: "helm.valuesObject",
            fsPath: "/app.yaml",
            offset: undefined,
            data,
            sites: shifted
        }
        const region = valuesRegion(document, layer)!
        expect(region.text).toBe("replicas: 1\nimage:\n  tag: latest\n")
        const edits = documentEdits(document, region, removeKeysEdits(region.text, [["replicas"]])!)
        expect(apply(document, edits)).toBe(document.replace("        replicas: 1\n", ""))
    })

    it("offers no region for parameters", () => {
        expect(valuesRegion(APPLICATION, { ...inline(), kind: "parameters" })).toBeUndefined()
    })
})
