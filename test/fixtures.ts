import { join } from "node:path"
import type { CheckoutOf } from "../src/argo"

/** A repository with one Argo CD Application, whose sources point at `https://example.com/fixtures.git`. */
export const FIXTURES = join(__dirname, "fixtures")

export const fixtureCheckout: CheckoutOf = (url) =>
    url === "https://example.com/fixtures.git" ? FIXTURES : undefined
