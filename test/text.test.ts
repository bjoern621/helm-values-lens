import { describe, expect, it } from "vitest"
import { countOf, listed } from "../src/text"

describe("a list of names", () => {
    it("joins the last two names with and", () => {
        expect(listed(["web"], 3)).toBe("web")
        expect(listed(["web", "api"], 3)).toBe("web and api")
        expect(listed(["web", "api", "db"], 3)).toBe("web, api and db")
    })

    it("counts the names past the shown ones", () => {
        expect(listed(["web", "api", "db", "cache"], 2)).toBe("web, api and 2 more")
    })
})

describe("a count", () => {
    it("takes the plural unless it equals one", () => {
        expect(countOf(1, "resource")).toBe("1 resource")
        expect(countOf(0, "resource")).toBe("0 resources")
    })
})
