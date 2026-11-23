import { describe, expect, it } from "vitest"
import { agreeing, countOf, listed } from "../src/text"

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

    it("takes the verb form that agrees with it", () => {
        expect(`${countOf(1, "release")} ${agreeing(1, "reads", "read")}`).toBe("1 release reads")
        expect(`${countOf(2, "release")} ${agreeing(2, "reads", "read")}`).toBe("2 releases read")
    })
})
