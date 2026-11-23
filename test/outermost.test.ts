import { describe, expect, it } from "vitest"
import { outermost } from "../src/release"

const release = (id: string) => ({ spec: { id } })

describe("the releases that the release picker lists", () => {
    it("leave out an Application that a listed release renders", () => {
        const web = release("apps/web.yaml:0")
        const crds = release("apps/web.yaml:0>crds")
        const nested = release("apps/web.yaml:0>crds>more")
        expect(outermost([web, crds, nested])).toEqual([web])
    })

    it("keep an Application whose renderer reads none of the file", () => {
        const crds = release("apps/web.yaml:0>crds")
        const api = release("apps/api.yaml:0")
        expect(outermost([crds, api])).toEqual([crds, api])
    })

    it("keep a release whose id only starts like another", () => {
        const web = release("apps/web.yaml:0")
        const webApi = release("apps/web.yaml:0-api")
        expect(outermost([web, webApi])).toEqual([web, webApi])
    })
})
