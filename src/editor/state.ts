import * as vscode from "vscode"
import { releaseTitle, templatePrefix } from "../hints"
import type { RenderState } from "../markdown"
import { outermost, type Release } from "../release"
import { changedResources, type Rendered, type ResourceChanges } from "../render"
import type { Discovery, Failure, WorkspaceIndex } from "../workspace"
import { ALL_RELEASES, FOCUS_KEY } from "./config"

/** What the extension works on in the background, with how far it got. */
export interface Progress {
    kind: "reading" | "rendering"
    done: number
    total: number
}

/** The releases a file shows hints for, split into the focused ones and the rest that read the file. */
export interface FileReleases {
    shown: Release[]
    others: Release[]
    /** The entries of the release picker that the others make up. */
    otherChoices: Release[]
}

/**
 * Holds the releases of the workspace with their renders and the release that the hints follow.
 * Every view reads from here and redraws on its events.
 */
export class LensState implements vscode.Disposable {
    private releaseList: readonly Release[] = []
    private failureList: readonly Failure[] = []
    private workspaceIndex: WorkspaceIndex | undefined
    private readonly renders = new Map<string, Rendered>()
    private readonly renderErrors = new Map<string, string>()
    private readonly running = new Map<Progress["kind"], Progress>()
    private focus: string | undefined
    private readonly changes = new vscode.EventEmitter<void>()
    private readonly progressChanges = new vscode.EventEmitter<void>()
    private readonly renderChanges = new vscode.EventEmitter<string>()
    /** Fires once the releases, a render or the focus changed. */
    readonly onDidChange = this.changes.event
    /** Fires once a background step starts, moves on or ends. */
    readonly onDidChangeProgress = this.progressChanges.event
    /** Fires with the id of a release whose render or render error changed. */
    readonly onDidRender = this.renderChanges.event

    constructor(private readonly memento: vscode.Memento) {
        this.focus = memento.get<string>(FOCUS_KEY)
    }

    dispose(): void {
        this.changes.dispose()
        this.progressChanges.dispose()
        this.renderChanges.dispose()
    }

    get releases(): readonly Release[] {
        return this.releaseList
    }

    get failures(): readonly Failure[] {
        return this.failureList
    }

    get index(): WorkspaceIndex | undefined {
        return this.workspaceIndex
    }

    get renderErrorCount(): number {
        return this.renderErrors.size
    }

    byId(id: string): Release | undefined {
        return this.releaseList.find((release) => release.spec.id === id)
    }

    rendered(id: string): Rendered | undefined {
        return this.renders.get(id)
    }

    renderError(id: string): string | undefined {
        return this.renderErrors.get(id)
    }

    renderState(id: string): RenderState {
        const error = this.renderErrors.get(id)
        if (error !== undefined) return { kind: "failed", error }
        const rendered = this.renders.get(id)
        return rendered === undefined ? { kind: "none" } : { kind: "rendered", rendered }
    }

    /** The step that the status bar names: reading the releases goes before rendering them. */
    get progress(): Progress | undefined {
        return this.running.get("reading") ?? this.running.get("rendering")
    }

    setProgress(kind: Progress["kind"], progress: Omit<Progress, "kind"> | undefined): void {
        if (progress === undefined) this.running.delete(kind)
        else this.running.set(kind, { kind, ...progress })
        this.progressChanges.fire()
    }

    /** Takes the result of a discovery. Renders of releases that are gone get dropped. */
    replace(discovery: Discovery): void {
        this.releaseList = discovery.releases
        this.failureList = discovery.failures
        this.workspaceIndex = discovery.index
        const ids = new Set(this.releaseList.map((release) => release.spec.id))
        for (const id of [...this.renders.keys()]) if (!ids.has(id)) this.renders.delete(id)
        for (const id of [...this.renderErrors.keys()])
            if (!ids.has(id)) this.renderErrors.delete(id)
        for (const [id, error] of discovery.renderErrors) this.storeRenderError(id, error)
    }

    /** Keeps a render. Hands back what changed against the render before, or undefined for a first render. */
    storeRender(id: string, rendered: Rendered): ResourceChanges | undefined {
        const before = this.renders.get(id)
        this.renders.set(id, rendered)
        this.renderErrors.delete(id)
        this.renderChanges.fire(id)
        return before === undefined ? undefined : changedResources(before, rendered)
    }

    storeRenderError(id: string, error: string): void {
        this.renderErrors.set(id, error)
        this.renderChanges.fire(id)
    }

    /** Tells the views to redraw after a batch of changes. */
    notify(): void {
        this.changes.fire()
    }

    /** The releases that read a file, describe their release in it or render it as a template. */
    candidates(fsPath: string): Release[] {
        return this.releaseList
            .filter(
                (release) =>
                    release.spec.appFile === fsPath ||
                    release.trace.layers.some((layer) => layer.fsPath === fsPath) ||
                    templatePrefix(fsPath, release) !== undefined
            )
            .sort((a, b) => releaseTitle(a.spec).localeCompare(releaseTitle(b.spec)))
    }

    /**
     * The releases of a file that the release picker lists.
     * An Application that a chart renders shows with the release of that chart, which renders it whenever the chart reads the file too.
     */
    choices(fsPath: string): Release[] {
        return outermost(this.candidates(fsPath))
    }

    /** The release of `candidates` that the hints follow, or undefined once the user picked every release. */
    focused(candidates: readonly Release[]): Release | undefined {
        if (this.focus === ALL_RELEASES) return undefined
        const focus = this.focus
        if (focus !== undefined) {
            const exact = candidates.find((release) => release.spec.id === focus)
            if (exact !== undefined) return exact
            const relative = candidates.find((release) => related(release.spec.id, focus))
            if (relative !== undefined) return relative
        }
        return candidates[0]
    }

    /**
     * Splits the releases of a file into the shown ones and the others.
     * The shown ones hold the focused release with the release that renders it and the releases that it renders.
     * An Application that a chart renders thereby shows its values beside the values of the chart that renders it.
     */
    fileReleases(fsPath: string): FileReleases {
        const candidates = this.candidates(fsPath)
        const choices = outermost(candidates)
        const focus = this.focused(choices)
        if (focus === undefined) return { shown: candidates, others: [], otherChoices: [] }
        const shown = candidates.filter((release) => related(release.spec.id, focus.spec.id))
        return {
            shown,
            others: candidates.filter((release) => !shown.includes(release)),
            otherChoices: choices.filter((release) => !shown.includes(release))
        }
    }

    async setFocus(id: string): Promise<void> {
        this.focus = id
        await this.memento.update(FOCUS_KEY, id)
        this.changes.fire()
    }
}

/** Whether one release renders the other, directly or through releases between them. */
function related(a: string, b: string): boolean {
    return a === b || a.startsWith(b + ">") || b.startsWith(a + ">")
}
