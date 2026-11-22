import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import * as vscode from "vscode"
import type { ReleaseSpec } from "./argo"
import type { LoadedChart } from "./chart"
import { valueAt } from "./coalesce"
import { annotatedFinalValues } from "./finalValues"
import {
    chainMarkdown,
    type Hint,
    releaseTitle,
    siteAt,
    siteEnd,
    templateHints,
    templatePrefix,
    valueHints
} from "./hints"
import type { Release } from "./release"
import { changedResources, type Rendered, renderRelease, resourcesHolding } from "./render"
import type { Position } from "./yamlPaths"
import {
    type ConfiguredRelease,
    discover,
    type Failure,
    RELEASE_FILE,
    type WorkspaceIndex
} from "./workspace"

const SCHEME = "helm-values-lens"
const REINDEX_DELAY_MS = 300
const RENDER_DELAY_MS = 800
const CHANGE_MESSAGE_DURATION_MS = 8000
const FOCUS_KEY = "helmValuesLens.focus"
/** The focus value under which the hints show every release that reads a file. */
const ALL_RELEASES = "*"

export function activate(context: vscode.ExtensionContext): void {
    const lens = new Lens(context)
    context.subscriptions.push(lens)
    lens.requestReindex(true)
}

export function deactivate(): void {}

class Lens implements vscode.Disposable {
    private releases: Release[] = []
    private failures: Failure[] = []
    private index: WorkspaceIndex | undefined
    private loading = false
    private lastSummary = ""
    /** The ids of the releases that the last discovery rendered, which the render after a save skips. */
    private freshRenders = new Set<string>()
    private focus: string | undefined
    private readonly charts = new Map<string, LoadedChart>()
    private readonly rendered = new Map<string, Rendered>()
    private readonly renderErrors = new Map<string, string>()
    private readonly changes = new vscode.EventEmitter<void>()
    private readonly virtualChanges = new vscode.EventEmitter<vscode.Uri>()
    private readonly diagnostics = vscode.languages.createDiagnosticCollection("Helm Values Lens")
    private readonly output = vscode.window.createOutputChannel("Helm Values Lens")
    private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
    private readonly disposables: vscode.Disposable[] = []
    private reindexTimer: NodeJS.Timeout | undefined
    private renderTimer: NodeJS.Timeout | undefined
    private generation = 0
    private running = false
    /** The reindex asked for while one ran, with whether it renders. */
    private pending: boolean | undefined

    constructor(private readonly context: vscode.ExtensionContext) {
        this.focus = context.workspaceState.get<string>(FOCUS_KEY)
        this.status.command = "helmValuesLens.selectRelease"
        const selector: vscode.DocumentSelector = [
            { language: "yaml" },
            { language: "helm" },
            { pattern: "**/templates/**" }
        ]
        const changes = this.changes.event
        this.disposables.push(
            this.changes,
            this.virtualChanges,
            this.diagnostics,
            this.output,
            this.status,
            vscode.languages.registerInlayHintsProvider(selector, {
                onDidChangeInlayHints: changes,
                provideInlayHints: (document) => this.inlayHints(document)
            }),
            vscode.languages.registerHoverProvider(selector, {
                provideHover: (document, position) => this.hover(document, position)
            }),
            vscode.languages.registerCodeLensProvider(selector, {
                onDidChangeCodeLenses: changes,
                provideCodeLenses: (document) => this.codeLenses(document)
            }),
            vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
                onDidChange: this.virtualChanges.event,
                provideTextDocumentContent: (uri) => this.virtualContent(uri)
            }),
            vscode.commands.registerCommand("helmValuesLens.showFinalValues", (id?: string) =>
                this.open(id, "final-values.yaml")
            ),
            vscode.commands.registerCommand("helmValuesLens.showManifests", (id?: string) =>
                this.open(id, "manifests.yaml")
            ),
            vscode.commands.registerCommand("helmValuesLens.render", (id?: string) =>
                this.renderPicked(id)
            ),
            vscode.commands.registerCommand("helmValuesLens.refresh", () =>
                this.requestReindex(true)
            ),
            vscode.commands.registerCommand("helmValuesLens.openChartFile", (id?: string) =>
                this.openChartFile(id)
            ),
            vscode.commands.registerCommand("helmValuesLens.selectRelease", () =>
                this.selectRelease()
            ),
            vscode.commands.registerCommand("helmValuesLens.addRelease", () => this.addRelease()),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.contentChanges.length > 0 && isWatched(event.document))
                    this.scheduleReindex(false)
            }),
            vscode.workspace.onDidSaveTextDocument((document) => {
                if (isWatched(document)) this.scheduleReindex(true)
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleReindex(true)),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration("helmValuesLens")) this.scheduleReindex(true)
            }),
            vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus())
        )
        const watcher = vscode.workspace.createFileSystemWatcher(
            "**/{*.yaml,*.yml,*.gotmpl,*.tpl,Kustomization}"
        )
        watcher.onDidCreate(() => this.scheduleReindex(false))
        watcher.onDidDelete(() => this.scheduleReindex(false))
        this.disposables.push(watcher)
    }

    dispose(): void {
        clearTimeout(this.reindexTimer)
        clearTimeout(this.renderTimer)
        for (const disposable of this.disposables) disposable.dispose()
    }

    private scheduleReindex(render: boolean): void {
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

    /** Reads every release of the workspace again, the unsaved text of open editors included. */
    private async reindex(render: boolean): Promise<void> {
        const generation = ++this.generation
        const roots = this.roots()
        const readText = (fsPath: string) =>
            vscode.workspace.textDocuments
                .find((document) => document.uri.fsPath === fsPath)
                ?.getText() ?? readFileSync(fsPath, "utf8")
        const config = vscode.workspace.getConfiguration("helmValuesLens")
        this.loading = true
        this.updateStatus()
        let discovery
        try {
            discovery = await discover(roots, this.cacheDir(), this.helmPath(), {
                readText,
                charts: this.charts,
                configured: config.get<ConfiguredRelease[]>("releases", []),
                repositories: config.get<Record<string, string>>("repositories", {}),
                // Rendering each chart that renders Applications on every keystroke would keep helm busy, so typing reuses the renders of the last save.
                renders: render ? undefined : this.rendered
            })
        } catch (error) {
            if (generation === this.generation) {
                this.loading = false
                this.updateStatus()
                this.output.appendLine(`Could not read the releases: ${String(error)}`)
            }
            return
        }
        if (generation !== this.generation) return
        this.loading = false
        this.releases = discovery.releases
        this.failures = discovery.failures
        this.index = discovery.index
        const ids = new Set(this.releases.map((release) => release.spec.id))
        for (const id of [...this.rendered.keys()]) if (!ids.has(id)) this.rendered.delete(id)
        for (const id of [...this.renderErrors.keys()])
            if (!ids.has(id)) this.renderErrors.delete(id)
        for (const [id, rendered] of discovery.rendered) this.storeRender(id, rendered)
        for (const [id, error] of discovery.renderErrors) this.renderErrors.set(id, error)
        this.freshRenders = new Set([
            ...discovery.rendered.keys(),
            ...discovery.renderErrors.keys()
        ])
        this.logSummary(roots[0] ?? "/")
        this.updateDiagnostics()
        this.updateStatus()
        this.changes.fire()
        for (const id of discovery.rendered.keys()) this.fireManifests(id)
        if (render && this.renderOnSave()) this.scheduleRender()
    }

    private roots(): string[] {
        return (vscode.workspace.workspaceFolders ?? [])
            .filter((folder) => folder.uri.scheme === "file")
            .map((folder) => folder.uri.fsPath)
    }

    /** Writes the releases that did not load to the output channel, once per change of the result. */
    private logSummary(root: string): void {
        const lines = [
            `${this.releases.length} releases loaded, ${this.failures.length} not loaded, ${this.renderErrors.size} could not render`,
            ...this.failures.map(
                ({ spec, reason }) => `  ${releaseTitle(spec)} (${where(spec, root)}): ${reason}`
            )
        ]
        const summary = lines.join("\n")
        if (summary === this.lastSummary) return
        this.lastSummary = summary
        this.output.appendLine(summary)
    }

    private cacheDir(): string {
        return this.context.globalStorageUri.fsPath
    }

    private helmPath(): string {
        return vscode.workspace.getConfiguration("helmValuesLens").get("helmPath", "helm")
    }

    private renderOnSave(): boolean {
        return vscode.workspace.getConfiguration("helmValuesLens").get("renderOnSave", true)
    }

    private scheduleRender(): void {
        clearTimeout(this.renderTimer)
        this.renderTimer = setTimeout(() => void this.renderAll(), RENDER_DELAY_MS)
    }

    private async renderAll(): Promise<void> {
        const skipped = this.freshRenders
        this.freshRenders = new Set()
        await Promise.all(
            this.releases
                .filter((release) => !skipped.has(release.spec.id))
                .map((release) => this.render(release, false))
        )
    }

    private async renderPicked(id: string | undefined): Promise<void> {
        const release = await this.pick(id)
        if (release !== undefined) await this.render(release, true)
    }

    /** Renders a release with `helm template`. */
    private async render(release: Release, announce: boolean): Promise<void> {
        const id = release.spec.id
        try {
            const rendered = await renderRelease(release, this.helmPath())
            const first = !this.rendered.has(id)
            this.storeRender(id, rendered)
            this.renderErrors.delete(id)
            if (first && announce)
                vscode.window.setStatusBarMessage(
                    `${releaseTitle(release.spec)}: rendered ${count(rendered.resources.size, "resource")}`,
                    CHANGE_MESSAGE_DURATION_MS
                )
            this.fireManifests(id)
        } catch (error) {
            this.renderErrors.set(id, (error as Error).message)
            if (announce)
                void vscode.window.showErrorMessage(
                    `helm template ${releaseTitle(release.spec)}: ${firstLine((error as Error).message)}`
                )
        }
        this.updateDiagnostics()
        this.changes.fire()
    }

    /** Keeps a render. The status bar names the resources that changed since the last render. */
    private storeRender(id: string, rendered: Rendered): void {
        const before = this.rendered.get(id)
        this.rendered.set(id, rendered)
        this.renderErrors.delete(id)
        if (before === undefined) return
        const { added, removed, changed } = changedResources(before, rendered)
        const parts = [
            ...changed.map((key) => `~${key}`),
            ...added.map((key) => `+${key}`),
            ...removed.map((key) => `-${key}`)
        ]
        const release = this.byId(id)
        if (parts.length > 0 && release !== undefined)
            vscode.window.setStatusBarMessage(
                `${releaseTitle(release.spec)}: ${parts.join(", ")}`,
                CHANGE_MESSAGE_DURATION_MS
            )
    }

    private fireManifests(id: string): void {
        const release = this.byId(id)
        if (release !== undefined)
            this.virtualChanges.fire(this.virtualUri(release, "manifests.yaml"))
    }

    private byId(id: string): Release | undefined {
        return this.releases.find((release) => release.spec.id === id)
    }

    private updateDiagnostics(): void {
        const byFile = new Map<string, vscode.Diagnostic[]>()
        const add = (
            fsPath: string,
            line: number,
            message: string,
            severity: vscode.DiagnosticSeverity,
            span?: { start: Position; end: Position }
        ) => {
            const range =
                span === undefined
                    ? new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER)
                    : new vscode.Range(
                          span.start.line,
                          span.start.column,
                          span.end.line,
                          span.end.column
                      )
            const diagnostic = new vscode.Diagnostic(range, message, severity)
            diagnostic.source = "Helm Values Lens"
            const list = byFile.get(fsPath) ?? []
            if (list.some((other) => other.message === message && other.range.start.line === line))
                return
            list.push(diagnostic)
            byFile.set(fsPath, list)
        }
        const { Error, Warning, Information } = vscode.DiagnosticSeverity
        for (const release of this.releases) {
            const { appFile, appLine } = release.spec
            const title = releaseTitle(release.spec)
            for (const problem of release.problems)
                add(appFile, appLine, `${title}: ${problem}`, Warning)
            const renderError = this.renderErrors.get(release.spec.id)
            if (renderError !== undefined)
                add(
                    appFile,
                    appLine,
                    `${title}: helm template could not render the chart: ${renderError}`,
                    Error
                )
        }
        for (const { spec, reason } of this.failures)
            add(
                spec.appFile,
                spec.appLine,
                `${releaseTitle(spec)}: chart not loaded: ${reason}`,
                Warning
            )
        const files = new Set(
            this.releases.flatMap((release) => release.trace.layers.map((layer) => layer.fsPath))
        )
        for (const fsPath of files) {
            if (fsPath === undefined) continue
            for (const hint of valueHints(fsPath, this.releases)) {
                if (hint.kind !== "unknown") continue
                add(
                    fsPath,
                    hint.position.line,
                    `${releaseTitle(hint.release.spec)}: the chart ${hint.release.chart.name} neither defaults nor reads ${hint.path.join(".")}`,
                    Information,
                    { start: hint.start, end: hint.position }
                )
            }
        }
        this.diagnostics.clear()
        for (const [fsPath, list] of byFile) this.diagnostics.set(vscode.Uri.file(fsPath), list)
    }

    /** The releases that read a file, describe their release in it or render it as a template. */
    private candidates(fsPath: string): Release[] {
        return this.releases
            .filter(
                (release) =>
                    release.spec.appFile === fsPath ||
                    release.trace.layers.some((layer) => layer.fsPath === fsPath) ||
                    templatePrefix(fsPath, release) !== undefined
            )
            .sort((a, b) => releaseTitle(a.spec).localeCompare(releaseTitle(b.spec)))
    }

    /** The release of `candidates` that the hints follow, or undefined once the user picked every release. */
    private focused(candidates: readonly Release[]): Release | undefined {
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
     * The releases whose hints a file shows: the focused release with the release that renders it and the releases that it renders.
     * An Application that a chart renders thereby shows its values beside the values of the chart that renders it.
     */
    private shown(fsPath: string): Release[] {
        const candidates = this.candidates(fsPath)
        const focus = this.focused(candidates)
        if (focus === undefined) return candidates
        return candidates.filter((release) => related(release.spec.id, focus.spec.id))
    }

    private updateStatus(): void {
        const document = vscode.window.activeTextEditor?.document
        const candidates = document === undefined ? [] : this.candidates(document.uri.fsPath)
        if (candidates.length === 0) {
            if (this.loading && this.releases.length === 0) {
                this.status.text = "$(sync~spin) Helm releases"
                this.status.tooltip = "Reading the Helm releases of the workspace."
                this.status.show()
            } else {
                this.status.hide()
            }
            return
        }
        const focus = this.focused(candidates)
        const spin = this.loading ? "$(sync~spin)" : "$(layers)"
        const count = candidates.length > 1 ? ` (${candidates.length})` : ""
        this.status.text =
            focus === undefined
                ? `${spin} All ${candidates.length} releases`
                : `${spin} ${releaseTitle(focus.spec)}${count}`
        this.status.tooltip =
            candidates.length > 1
                ? `${candidates.length} releases read this file. The hints follow the one named here. Click to pick another.`
                : "The release whose values the hints show"
        this.status.show()
    }

    private async selectRelease(): Promise<void> {
        const document = vscode.window.activeTextEditor?.document
        const candidates = document === undefined ? [] : this.candidates(document.uri.fsPath)
        const releases = candidates.length > 0 ? candidates : this.releases
        const root = this.roots()[0] ?? "/"
        const items: (vscode.QuickPickItem & { id: string })[] = [
            ...(releases.length > 1
                ? [
                      {
                          label: "All releases",
                          description: "names each release in its hints",
                          id: ALL_RELEASES
                      }
                  ]
                : []),
            ...releases.map((release) => ({ ...this.pickItem(release, root), id: release.spec.id }))
        ]
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: "Release whose values the hints show",
            matchOnDescription: true,
            matchOnDetail: true
        })
        if (picked === undefined) return
        this.focus = picked.id
        await this.context.workspaceState.update(FOCUS_KEY, picked.id)
        this.updateStatus()
        this.changes.fire()
    }

    private pickItem(release: Release, root: string): vscode.QuickPickItem {
        return {
            label: releaseTitle(release.spec),
            description: `${release.chart.name} ${release.chart.version}`,
            detail: `${release.spec.origin} in ${where(release.spec, root)}`
        }
    }

    /** Adds a release with a chart of the workspace and the values files that the user picks to the `helmValuesLens.releases` setting. */
    private async addRelease(): Promise<void> {
        const root = this.roots()[0]
        if (root === undefined || this.index === undefined) {
            void vscode.window.showWarningMessage("Open a folder to add a release.")
            return
        }
        const charts = this.index.charts.filter((chart) => !chart.library)
        const chart = await vscode.window.showQuickPick(
            charts.map((candidate) => ({
                label: candidate.name,
                description: `${candidate.version} in ${relative(root, candidate.dir) || "."}`,
                chart: candidate
            })),
            { placeHolder: "Chart of the release" }
        )
        if (chart === undefined) return
        const chartDir = chart.chart.dir
        const ownValues = join(chartDir, "values.yaml")
        const files = this.index.files
            .filter((fsPath) => /\.ya?ml$/.test(fsPath) && fsPath !== ownValues)
            .filter((fsPath) => basename(fsPath) !== "Chart.yaml")
            .sort((a, b) => nearness(b, chartDir) - nearness(a, chartDir) || a.localeCompare(b))
        const picked = await vscode.window.showQuickPick(
            files.map((fsPath) => ({ label: relative(root, fsPath), fsPath })),
            {
                placeHolder:
                    "Pick the values files of the release. Their order in the setting decides which file wins.",
                canPickMany: true
            }
        )
        if (picked === undefined) return
        const name = await vscode.window.showInputBox({
            prompt: "Name of the release",
            value: chart.chart.name
        })
        if (name === undefined || name === "") return
        const config = vscode.workspace.getConfiguration("helmValuesLens")
        const releases = config.get<ConfiguredRelease[]>("releases", [])
        const entry: ConfiguredRelease = {
            name,
            chart: relative(root, chartDir) || ".",
            valueFiles: picked.map((item) => relative(root, item.fsPath))
        }
        await config.update("releases", [...releases, entry], vscode.ConfigurationTarget.Workspace)
        const action = await vscode.window.showInformationMessage(
            `Added the release ${name} to helmValuesLens.releases. Reorder its valueFiles there to change which file wins.`,
            "Open Settings"
        )
        if (action === "Open Settings")
            await vscode.commands.executeCommand("workbench.action.openWorkspaceSettingsFile")
    }

    private hintsOf(document: vscode.TextDocument): Hint[] {
        const fsPath = document.uri.fsPath
        const shown = this.shown(fsPath)
        return [
            ...templateHints(fsPath, document.getText(), shown),
            ...valueHints(fsPath, shown).filter((hint) => hint.kind !== "unknown")
        ]
    }

    private inlayHints(document: vscode.TextDocument): vscode.InlayHint[] {
        return this.hintsOf(document).map((hint) => {
            const line = Math.min(hint.position.line, document.lineCount - 1)
            const column = Math.min(hint.position.column, document.lineAt(line).text.length)
            const inlay = new vscode.InlayHint(new vscode.Position(line, column), hint.label)
            inlay.paddingLeft = true
            inlay.tooltip = new vscode.MarkdownString(
                chainMarkdown(hint.release, hint.path, document.uri.fsPath)
            )
            return inlay
        })
    }

    /** Shows the chain of every release that sets or reads the value under the cursor, the focused ones first. */
    private hover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Hover | undefined {
        const fsPath = document.uri.fsPath
        const at = { line: position.line, column: position.character }
        const shown = new Set(this.shown(fsPath))
        const releases = [...this.candidates(fsPath)].sort(
            (a, b) => Number(shown.has(b)) - Number(shown.has(a))
        )
        const line = document.lineAt(position.line).text
        const sections: string[] = []
        const columns: number[] = []
        for (const release of releases) {
            for (const site of siteAt(fsPath, at, [release])) {
                sections.push(this.chainWithResources(site.release, site.path, fsPath))
                columns.push(site.key.column, Math.min(siteEnd(site).column, line.length))
            }
            for (const hint of templateHints(fsPath, line, [release])) {
                if (at.column < hint.start.column || at.column > hint.position.column) continue
                sections.push(this.chainWithResources(hint.release, hint.path, fsPath))
                columns.push(hint.start.column, hint.position.column)
            }
        }
        if (sections.length === 0) return undefined
        const markdown = new vscode.MarkdownString([...new Set(sections)].join("\n\n---\n\n"))
        markdown.isTrusted = false
        const range = new vscode.Range(
            position.line,
            Math.min(...columns),
            position.line,
            Math.max(...columns)
        )
        return new vscode.Hover(markdown, range)
    }

    private chainWithResources(release: Release, path: readonly string[], fsPath: string): string {
        const chain = chainMarkdown(release, path, fsPath)
        const rendered = this.rendered.get(release.spec.id)
        if (rendered === undefined) return chain
        const holders = resourcesHolding(rendered, valueAt(release.trace.final, path))
        if (holders.length === 0) return chain
        const shown = holders
            .slice(0, 5)
            .map((key) => `\`${key}\``)
            .join(", ")
        return `${chain}\n\nRendered in ${shown}${holders.length > 5 ? ` and ${holders.length - 5} more` : ""}`
    }

    private codeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const here = this.releases.filter((release) => release.spec.appFile === document.uri.fsPath)
        const perLine = new Map<number, number>()
        for (const release of here)
            perLine.set(release.spec.appLine, (perLine.get(release.spec.appLine) ?? 0) + 1)
        const lenses: vscode.CodeLens[] = []
        for (const release of here) {
            const line = Math.min(release.spec.appLine, document.lineCount - 1)
            const range = new vscode.Range(line, 0, line, 0)
            const userLayers = release.trace.layers.length - release.firstUserLayer
            const id = release.spec.id
            const name =
                (perLine.get(release.spec.appLine) ?? 0) > 1 ? `${release.spec.name}: ` : ""
            lenses.push(
                new vscode.CodeLens(range, {
                    title: `${name}Final values: ${userLayers} ${userLayers === 1 ? "layer" : "layers"} over ${release.chart.name}`,
                    command: "helmValuesLens.showFinalValues",
                    arguments: [id]
                }),
                new vscode.CodeLens(range, {
                    title: "Chart files",
                    command: "helmValuesLens.openChartFile",
                    arguments: [id]
                }),
                new vscode.CodeLens(range, {
                    title: this.renderTitle(id),
                    command: "helmValuesLens.showManifests",
                    arguments: [id]
                })
            )
        }
        return lenses
    }

    /** Lets the user pick a values file or template of the chart, which may sit in the chart cache outside the workspace. */
    private async openChartFile(id: string | undefined): Promise<void> {
        const release = await this.pick(id)
        if (release === undefined) return
        const dirs = [
            { dir: release.chart.dir, label: release.chart.name },
            ...release.chart.dependencies
                .filter((dependency) => !release.disabled.has(dependency.key))
                .map((dependency) => ({ dir: dependency.dir, label: dependency.key }))
        ]
        const items = dirs.flatMap(({ dir, label }) =>
            chartFiles(dir).map((fsPath) => ({
                label: relative(dir, fsPath),
                description: label,
                fsPath
            }))
        )
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: `Files of ${release.chart.name}`,
            matchOnDescription: true
        })
        if (picked === undefined) return
        await vscode.window.showTextDocument(vscode.Uri.file(picked.fsPath))
    }

    private renderTitle(id: string): string {
        if (this.renderErrors.has(id)) return "Could not render"
        const rendered = this.rendered.get(id)
        return rendered === undefined
            ? "Render"
            : `Rendered ${count(rendered.resources.size, "resource")}`
    }

    private async open(id: string | undefined, view: string): Promise<void> {
        const release = await this.pick(id)
        if (release === undefined) return
        if (view === "manifests.yaml" && !this.rendered.has(release.spec.id))
            await this.render(release, true)
        const document = await vscode.workspace.openTextDocument(this.virtualUri(release, view))
        await vscode.languages.setTextDocumentLanguage(document, "yaml")
        await vscode.window.showTextDocument(document, {
            preview: true,
            viewColumn: vscode.ViewColumn.Beside
        })
    }

    /** The release with `id`, or the one that the user picks, those of the active file first. */
    private async pick(id: string | undefined): Promise<Release | undefined> {
        if (id !== undefined) return this.byId(id)
        const document = vscode.window.activeTextEditor?.document
        const first = new Set(document === undefined ? [] : this.candidates(document.uri.fsPath))
        const releases = [...this.releases].sort(
            (a, b) => Number(first.has(b)) - Number(first.has(a))
        )
        const root = this.roots()[0] ?? "/"
        const picked = await vscode.window.showQuickPick(
            releases.map((release) => ({ ...this.pickItem(release, root), release })),
            { placeHolder: "Release", matchOnDescription: true, matchOnDetail: true }
        )
        return picked?.release
    }

    /** The release name shows as the tab title. The query holds the id, since names repeat. */
    private virtualUri(release: Release, view: string): vscode.Uri {
        return vscode.Uri.from({
            scheme: SCHEME,
            path: `/${release.spec.name.replaceAll("/", "-")}/${view}`,
            query: release.spec.id
        })
    }

    private virtualContent(uri: vscode.Uri): string {
        const view = basename(uri.path)
        const release = this.byId(uri.query)
        if (release === undefined) return `# The release ${basename(dirname(uri.path))} is gone\n`
        if (view === "final-values.yaml")
            return annotatedFinalValues(release, this.rootOf(release.spec))
        const error = this.renderErrors.get(release.spec.id)
        if (error !== undefined)
            return `# helm template could not render the chart:\n${error.replace(/^/gm, "# ")}\n`
        return this.rendered.get(release.spec.id)?.manifests ?? "# Not rendered\n"
    }

    private rootOf(spec: ReleaseSpec): string {
        return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(spec.appFile))?.uri.fsPath ?? "/"
    }
}

/** Whether a change of the document can change a release: a file that may describe one, or a template. */
function isWatched(document: vscode.TextDocument): boolean {
    if (document.uri.scheme !== "file") return false
    const name = basename(document.uri.fsPath)
    return RELEASE_FILE.test(name) || name.endsWith(".tpl")
}

/** Whether one release renders the other, directly or through releases between them. */
function related(a: string, b: string): boolean {
    return a === b || a.startsWith(b + ">") || b.startsWith(a + ">")
}

function where(spec: ReleaseSpec, root: string): string {
    return `${relative(root, spec.appFile)}:${spec.appLine + 1}`
}

/** How many folders a file shares with the chart folder, to list the files near the chart first. */
function nearness(fsPath: string, dir: string): number {
    const a = dirname(fsPath).split("/")
    const b = dir.split("/")
    let shared = 0
    while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++
    return shared
}

function count(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? "" : "s"}`
}

function firstLine(text: string): string {
    return text.split("\n")[0]!
}

/** Lists the values file and the templates of a chart folder, without the charts that it depends on. */
function chartFiles(dir: string): string[] {
    const files = existsSync(join(dir, "values.yaml")) ? [join(dir, "values.yaml")] : []
    const walk = (folder: string) => {
        if (!existsSync(folder)) return
        for (const name of readdirSync(folder).sort()) {
            const path = join(folder, name)
            if (statSync(path).isDirectory()) walk(path)
            else files.push(path)
        }
    }
    walk(join(dir, "templates"))
    return files
}
