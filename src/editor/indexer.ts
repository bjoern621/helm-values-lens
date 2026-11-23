import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as vscode from "vscode"
import { forgetFailedPulls, type LoadedChart } from "../chart"
import { releaseTitle } from "../hints"
import { durationSince } from "../log"
import type { Release } from "../release"
import { type Rendered, renderRelease } from "../render"
import type { RenderCache } from "../renderCache"
import { countOf, firstLine } from "../text"
import { discover, inBatches } from "../workspace"
import {
    CHANGE_MESSAGE_DURATION_MS,
    readSettings,
    REINDEX_DELAY_MS,
    RENDER_DELAY_MS
} from "./config"
import { firstRoot, roots, where } from "./folders"
import type { LensState } from "./state"

/**
 * Reads the releases of the workspace into the state and renders them.
 * Typing reads the releases again. A save renders them as well, once `renderOnSave` holds.
 */
export class Indexer implements vscode.Disposable {
    private reindexTimer: NodeJS.Timeout | undefined
    private renderTimer: NodeJS.Timeout | undefined
    private generation = 0
    private running = false
    /** The reindex asked for while one ran, with whether it renders. */
    private pending: boolean | undefined
    /** The ids of the releases that the last discovery rendered, which the render after a save skips. */
    private freshRenders = new Set<string>()
    private lastSummary = ""
    /** The charts read so far by folder, which each discovery reuses. */
    private readonly charts = new Map<string, LoadedChart>()

    constructor(
        private readonly state: LensState,
        private readonly output: vscode.LogOutputChannel,
        private readonly cacheDir: string,
        private readonly renderCache: RenderCache | undefined
    ) {}

    dispose(): void {
        clearTimeout(this.reindexTimer)
        clearTimeout(this.renderTimer)
    }

    /** Reads every release again and downloads each chart whose download failed before. */
    reload(): void {
        forgetFailedPulls(join(this.cacheDir, "charts"))
        this.output.info("Reload Releases: downloads that failed before get tried again")
        this.requestReindex(true)
    }

    scheduleReindex(render: boolean): void {
        clearTimeout(this.reindexTimer)
        this.reindexTimer = setTimeout(() => this.requestReindex(render), REINDEX_DELAY_MS)
    }

    /** Starts a reindex, or queues one while another runs, so that typing never stacks discoveries. */
    requestReindex(render: boolean): void {
        if (this.running) {
            this.pending = (this.pending ?? false) || render
            return
        }
        this.running = true
        void this.reindex(render).finally(() => {
            this.running = false
            const next = this.pending
            this.pending = undefined
            if (next !== undefined) this.requestReindex(next)
        })
    }

    /**
     * Renders a release with `helm template` and keeps the render on disk.
     * With `announce`, a first render and a failure show a message.
     */
    async render(release: Release, announce: boolean): Promise<void> {
        const id = release.spec.id
        const title = releaseTitle(release.spec)
        const { helmPath } = readSettings()
        const started = Date.now()
        try {
            const rendered = await renderRelease(release, helmPath)
            this.output.debug(
                `${title}: rendered ${countOf(rendered.resources.size, "resource")} in ${durationSince(started)}`
            )
            this.renderCache?.put(release, helmPath, rendered)
            const first = this.state.rendered(id) === undefined
            this.store(release, rendered)
            if (first && announce)
                vscode.window.setStatusBarMessage(
                    `${title}: rendered ${countOf(rendered.resources.size, "resource")}`,
                    CHANGE_MESSAGE_DURATION_MS
                )
        } catch (error) {
            this.state.storeRenderError(id, (error as Error).message)
            this.output.warn(`${title}: helm template failed: ${firstLine(error)}`)
            if (announce)
                void vscode.window.showErrorMessage(`helm template ${title}: ${firstLine(error)}`)
        }
        this.state.notify()
    }

    /** Reads every release of the workspace again, the unsaved text of open editors included. */
    private async reindex(render: boolean): Promise<void> {
        const generation = ++this.generation
        const folders = roots()
        const settings = readSettings()
        const current = () => generation === this.generation
        const started = Date.now()
        // Typing reads the releases on each pause, which would fill the log at the info level.
        const note = (message: string) =>
            render ? this.output.info(message) : this.output.debug(message)
        note(`Reading the releases of ${countOf(folders.length, "folder")}`)
        this.state.setProgress("reading", { done: 0, total: 0 })
        try {
            const discovery = await discover(folders, this.cacheDir, settings.helmPath, {
                readText: editorText,
                charts: this.charts,
                configured: settings.releases,
                repositories: settings.repositories,
                // Rendering each chart that renders Applications on every keystroke would keep helm busy, so typing reuses the renders of the last save.
                renders: render ? undefined : this.renderedSoFar(),
                cache: this.renderCache,
                log: this.output,
                onProgress: (done, total) => {
                    if (current()) this.state.setProgress("reading", { done, total })
                }
            })
            if (!current()) return
            note(
                `Read ${countOf(discovery.releases.length + discovery.failures.length, "release")} in ${durationSince(started)}`
            )
            this.state.replace(discovery)
            for (const [id, rendered] of discovery.rendered) {
                const release = this.state.byId(id)
                if (release !== undefined) this.store(release, rendered)
            }
            this.freshRenders = new Set([
                ...discovery.rendered.keys(),
                ...discovery.renderErrors.keys()
            ])
            this.logSummary(firstRoot())
            this.state.notify()
            if (render && settings.renderOnSave) this.scheduleRender()
        } catch (error) {
            if (current()) this.output.error(`Could not read the releases: ${String(error)}`)
        } finally {
            if (current()) this.state.setProgress("reading", undefined)
        }
    }

    private renderedSoFar(): Map<string, Rendered> {
        const renders = new Map<string, Rendered>()
        for (const release of this.state.releases) {
            const rendered = this.state.rendered(release.spec.id)
            if (rendered !== undefined) renders.set(release.spec.id, rendered)
        }
        return renders
    }

    private scheduleRender(): void {
        clearTimeout(this.renderTimer)
        this.renderTimer = setTimeout(() => void this.renderAll(), RENDER_DELAY_MS)
    }

    /**
     * Renders each release that the last discovery left unrendered, counting the renders in the status bar.
     * A release whose inputs match a render on disk takes that render without calling helm.
     */
    private async renderAll(): Promise<void> {
        const skipped = this.freshRenders
        this.freshRenders = new Set()
        const { helmPath } = readSettings()
        const started = Date.now()
        const releases: Release[] = []
        for (const release of this.state.releases) {
            if (skipped.has(release.spec.id)) continue
            const kept = this.renderCache?.get(release, helmPath)
            if (kept === undefined) releases.push(release)
            else this.store(release, kept)
        }
        this.state.notify()
        const fromDisk = this.state.releases.length - skipped.size - releases.length
        this.output.info(
            `Rendering ${countOf(releases.length, "release")} with helm. ${countOf(fromDisk, "render")} came from disk.`
        )
        const progress = { done: 0, total: releases.length }
        this.state.setProgress("rendering", progress)
        await inBatches(releases, async (release) => {
            await this.render(release, false)
            progress.done++
            this.state.setProgress("rendering", progress)
        })
        this.state.setProgress("rendering", undefined)
        this.output.info(
            `Rendered in ${durationSince(started)}, ${countOf(this.state.renderErrorCount, "release")} could not render`
        )
        this.renderCache?.prune(this.state.releases.map((release) => release.spec.id))
    }

    /** Keeps a render. The status bar names the resources that changed since the render before. */
    private store(release: Release, rendered: Rendered): void {
        const changes = this.state.storeRender(release.spec.id, rendered)
        if (changes === undefined) return
        const parts = [
            ...changes.changed.map((key) => `~${key}`),
            ...changes.added.map((key) => `+${key}`),
            ...changes.removed.map((key) => `-${key}`)
        ]
        if (parts.length > 0)
            vscode.window.setStatusBarMessage(
                `${releaseTitle(release.spec)}: ${parts.join(", ")}`,
                CHANGE_MESSAGE_DURATION_MS
            )
    }

    /** Writes the releases that did not load to the output channel, once per change of the result. */
    private logSummary(root: string): void {
        const { releases, failures } = this.state
        const head = `${releases.length} releases loaded, ${failures.length} not loaded`
        const lines = failures.map(
            ({ spec, reason }) =>
                `Not loaded: ${releaseTitle(spec)} (${where(spec, root)}): ${reason}`
        )
        const summary = [head, ...lines].join("\n")
        if (summary === this.lastSummary) return
        this.lastSummary = summary
        this.output.info(head)
        for (const line of lines) this.output.warn(line)
    }
}

/** Reads a file from its editor where one holds it open, from the disk otherwise. */
export function editorText(fsPath: string): string {
    return (
        vscode.workspace.textDocuments
            .find((document) => document.uri.fsPath === fsPath)
            ?.getText() ?? readFileSync(fsPath, "utf8")
    )
}
