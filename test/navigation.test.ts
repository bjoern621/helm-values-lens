import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import {
    defaultPlace,
    originPlace,
    type Place,
    settingPlaces,
    templateReadPlaces,
    valueFileLinks,
    winningPlace
} from "../src/navigation"
import type { Release } from "../src/release"
import { findReleases, loadRelease } from "../src/workspace"
import { FIXTURES, fixtureCheckout } from "./fixtures"

const APP = join(FIXTURES, "apps/demo.yaml")
const BASE = join(FIXTURES, "charts/app/values-base.yaml")
const PROD = join(FIXTURES, "envs/prod.yaml")
const CHART_VALUES = join(FIXTURES, "charts/app/values.yaml")
const CONFIGMAP = join(FIXTURES, "charts/app/templates/configmap.yaml")

let release: Release

beforeAll(async () => {
    const [spec] = findReleases([FIXTURES], undefined, fixtureCheckout)
    release = await loadRelease(spec!, join(homedir(), ".cache", "helm-values-lens"), "helm")
})

const lineOf = (fsPath: string, text: string) =>
    readFileSync(fsPath, "utf8")
        .split("\n")
        .findIndex((line) => line.includes(text))

/** The file and the text that a place spans, such as `values.yaml: tag`. */
const textOf = (place: Place | undefined) => {
    if (place === undefined) return undefined
    const line = readFileSync(place.fsPath, "utf8").split("\n")[place.start.line]!
    return `${place.fsPath.slice(FIXTURES.length + 1)}: ${line.slice(place.start.column, place.end.column)}`
}

describe("the place whose value wins", () => {
    it("finds the line of the last layer that sets the path", () => {
        expect(winningPlace(release, ["image", "tag"])).toMatchObject({
            fsPath: PROD,
            start: { line: lineOf(PROD, "tag:") }
        })
        expect(textOf(winningPlace(release, ["image", "tag"]))).toBe("envs/prod.yaml: tag")
    })

    it("maps a key of the inline block to its line in the Application", () => {
        expect(winningPlace(release, ["replicas"])).toMatchObject({
            fsPath: APP,
            start: { line: lineOf(APP, "replicas: 3") }
        })
    })

    it("falls back to the nearest map that a layer sets", () => {
        expect(textOf(winningPlace(release, ["podAnnotations", "absent"]))).toBe(
            "apps/demo.yaml: podAnnotations"
        )
    })
})

describe("the chart default", () => {
    it("finds the line in the values.yaml of the chart", () => {
        expect(defaultPlace(release, ["image", "tag"])).toMatchObject({
            fsPath: CHART_VALUES,
            start: { line: lineOf(CHART_VALUES, 'tag: "1.0"') }
        })
    })

    it("stays undefined for a path that the chart leaves out", () => {
        expect(defaultPlace(release, ["image", "pullPolicy"])).toBeUndefined()
    })
})

describe("the place where a value first gets set", () => {
    it("takes the chart default where one exists", () => {
        expect(originPlace(release, ["image", "tag"])).toEqual(
            defaultPlace(release, ["image", "tag"])
        )
    })

    it("takes the lowest layer that sets a path without a default", () => {
        expect(textOf(originPlace(release, ["podAnnotations", "team"]))).toBe(
            "apps/demo.yaml: team"
        )
    })
})

describe("the places that set a path", () => {
    it("lists every layer that sets it, lowest first", () => {
        expect(settingPlaces(release, ["replicas"]).map((place) => place.fsPath)).toEqual([
            CHART_VALUES,
            BASE,
            APP
        ])
    })
})

describe("the template reads", () => {
    it("finds each read of the path itself", () => {
        const reads = templateReadPlaces(release, ["image", "tag"], true)
        expect(reads.map(textOf)).toEqual([
            "charts/app/templates/configmap.yaml: .Values.image.tag"
        ])
    })

    it("counts a read of a map around the path once the path itself has no read", () => {
        expect(templateReadPlaces(release, ["resources", "limits", "cpu"], true)).toEqual([])
        const reads = templateReadPlaces(release, ["resources", "limits", "cpu"], false)
        expect(reads).toMatchObject([
            { fsPath: CONFIGMAP, start: { line: lineOf(CONFIGMAP, "toYaml .Values.resources") } }
        ])
    })

    it("counts a read of a key inside the path", () => {
        const reads = templateReadPlaces(release, ["image"], false)
        expect(reads.map(textOf)).toEqual([
            "charts/app/templates/configmap.yaml: .Values.image.repository",
            "charts/app/templates/configmap.yaml: .Values.image.tag"
        ])
    })
})

describe("the links to values files", () => {
    const linksOf = (relative: string) => {
        const fsPath = join(FIXTURES, relative)
        const specs = findReleases([FIXTURES], undefined, fixtureCheckout)
        return valueFileLinks(fsPath, readFileSync(fsPath, "utf8"), specs).map((link) => ({
            text: textOf(link),
            target: link.target.slice(FIXTURES.length + 1)
        }))
    }

    it("links each of valueFiles in an Application, $ref paths included", () => {
        expect(linksOf("apps/demo.yaml")).toEqual([
            { text: "apps/demo.yaml: values-base.yaml", target: "charts/app/values-base.yaml" },
            { text: "apps/demo.yaml: $values/envs/prod.yaml", target: "envs/prod.yaml" }
        ])
    })

    it("links the values of a Helmfile release and skips a file that does not exist", () => {
        expect(linksOf("helmfile/helmfile.yaml").map((link) => link.target)).toEqual([
            "charts/app/values-base.yaml",
            "helmfile/values/web.yaml",
            "helmfile/values/dump.yaml"
        ])
    })

    it("links valuesFile and additionalValuesFiles of Kustomize", () => {
        expect(linksOf("kustomize/kustomization.yaml").map((link) => link.target)).toEqual([
            "kustomize/values/base.yaml",
            "kustomize/values/extra.yaml"
        ])
    })

    it("links valuesFiles of the chart of a Flux HelmRelease", () => {
        expect(linksOf("flux/release.yaml").map((link) => link.target)).toEqual([
            "charts/app/values.yaml",
            "charts/app/values-base.yaml"
        ])
    })
})
