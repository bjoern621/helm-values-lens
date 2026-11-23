import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import type { ChartRef } from "../src/argo"

const cacheDir = mkdtempSync(join(tmpdir(), "helm-values-lens-pulls-"))
const ref: ChartRef = {
    kind: "repository",
    repoURL: "registry.example.com/charts",
    chart: "web",
    version: "1.0.0"
}
/** A helm that fails every command at once, as a registry out of reach does after its timeout. */
const FAILING_HELM = "false"

afterAll(() => rmSync(cacheDir, { recursive: true, force: true }))

/** Loads the chart module afresh, the way a restart of VS Code does. */
async function freshChartModule() {
    vi.resetModules()
    return import("../src/chart")
}

describe("a failed chart download", () => {
    it("fails at once after a restart, without calling helm", async () => {
        const first = await freshChartModule()
        await expect(first.chartDir(ref, cacheDir, FAILING_HELM)).rejects.toThrow(
            "web 1.0.0 did not download from registry.example.com/charts"
        )
        expect(existsSync(join(cacheDir, "failed-pulls.json"))).toBe(true)

        const restarted = await freshChartModule()
        await expect(restarted.chartDir(ref, cacheDir, "no-such-helm")).rejects.toThrow(
            "Reload Releases tries again"
        )
    })

    it("downloads again once forgotten", async () => {
        const chart = await freshChartModule()
        chart.forgetFailedPulls(cacheDir)
        expect(existsSync(join(cacheDir, "failed-pulls.json"))).toBe(false)
        const error = await chart.chartDir(ref, cacheDir, "no-such-helm").catch((e: Error) => e)
        expect(String(error)).toContain("did not download")
        expect(String(error)).not.toContain("Last try")
    })

    it("writes the start and the failure of the download to the log", async () => {
        const chart = await freshChartModule()
        chart.forgetFailedPulls(cacheDir)
        const lines: string[] = []
        const log = {
            info: (m: string) => lines.push(m),
            warn: (m: string) => lines.push(m),
            debug() {}
        }
        await expect(chart.chartDir(ref, cacheDir, FAILING_HELM, log)).rejects.toThrow()
        expect(lines[0]).toBe("Pulling web 1.0.0 from registry.example.com/charts")
        expect(lines[1]).toMatch(
            /did not download .* \(after \d+(\.\d)? m?s\)\. The next try waits until \d\d:\d\d/
        )
    })
})
