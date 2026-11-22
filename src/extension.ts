import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import * as vscode from "vscode"
import type { ReleaseSpec } from "./argo"
import type { LoadedChart } from "./chart"
import { annotatedFinalValues } from "./finalValues"
import {
    chainMarkdown,
    type Hint,
    siteAt,
    templateHints,
    templatePrefix,
    valueHints
} from "./hints"
import type { Release } from "./release"
import { changedResources, type Rendered, renderRelease, resourcesHolding } from "./render"
import { valueAt } from "./coalesce"
import { findReleases, loadRelease } from "./workspace"

const SCHEME = "helm-values-lens"
const REINDEX_DELAY_MS = 300
const RENDER_DELAY_MS = 800

export function activate(context: vscode.ExtensionContext): void {
    const lens = new Lens(context)
    context.subscriptions.push(lens)
    void lens.reindex(true)
}

export function deactivate(): void {}

class Lens implements vscode.Disposable {
    private releases: Release[] = []
    private failed = new Map<string, string>()
    private readonly charts = new Map<string, LoadedChart>()
    private readonly rendered = new Map<string, Rendered>()
    private readonly renderErrors = new Map<string, string>()
    private readonly changes = new vscode.EventEmitter<void>()
    private readonly virtualChanges = new vscode.EventEmitter<vscode.Uri>()
    private readonly diagnostics = vscode.languages.createDiagnosticCollection("Helm Values Lens")
    private readonly output = vscode.window.createOutputChannel("Helm Values Lens")
    private readonly disposables: vscode.Disposable[] = []
    private reindexTimer: NodeJS.Timeout | undefined
    private renderTimer: NodeJS.Timeout | undefined
    private generation = 0

    constructor(private readonly context: vscode.ExtensionContext) {
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
            vscode.languages.registerInlayHintsProvider(selector, {
                onDidChangeInlayHints: changes,
                provideInlayHints: (document) => this.inlayHints(document)
            }),
            vscode.languages.registerHoverProvider(selector, {
                provideHover: (document, position) => this.hover(document, position)
            }),
            vscode.languages.registerCodeLensProvider(
                { language: "yaml" },
                {
                    onDidChangeCodeLenses: changes,
                    provideCodeLenses: (document) => this.codeLenses(document)
                }
            ),
            vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
                onDidChange: this.virtualChanges.event,
                provideTextDocumentContent: (uri) => this.virtualContent(uri)
            }),
            vscode.commands.registerCommand("helmValuesLens.showFinalValues", (name?: string) =>
                this.open(name, "final-values.yaml")
            ),
            vscode.commands.registerCommand("helmValuesLens.showManifests", (name?: string) =>
                this.open(name, "manifests.yaml")
            ),
            vscode.commands.registerCommand("helmValuesLens.render", (name?: string) =>
                this.renderNamed(name)
            ),
            vscode.commands.registerCommand("helmValuesLens.refresh", () => this.reindex(true)),
            vscode.commands.registerCommand("helmValuesLens.openChartFile", (name?: string) =>
                this.openChartFile(name)
            ),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (this.isYaml(event.document)) this.scheduleReindex(false)
            }),
            vscode.workspace.onDidSaveTextDocument((document) => {
                if (this.isYaml(document)) this.scheduleReindex(true)
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleReindex(false))
        )
        const watcher = vscode.workspace.createFileSystemWatcher("**/*.{yaml,yml}")
        watcher.onDidCreate(() => this.scheduleReindex(false))
        watcher.onDidDelete(() => this.scheduleReindex(false))
        this.disposables.push(watcher)
    }

    dispose(): void {
        clearTimeout(this.reindexTimer)
        clearTimeout(this.renderTimer)
        for (const disposable of this.disposables) disposable.dispose()
    }

    private isYaml(document: vscode.TextDocument): boolean {
        return document.uri.scheme === "file" && /\.ya?ml$/.test(document.uri.fsPath)
    }

    private scheduleReindex(render: boolean): void {
        clearTimeout(this.reindexTimer)
        this.reindexTimer = setTimeout(() => void this.reindex(render), REINDEX_DELAY_MS)
    }

    /** Reads every Application of the workspace again, the open editors' unsaved text included. */
    async reindex(render = false): Promise<void> {
        const generation = ++this.generation
        const roots = (vscode.workspace.workspaceFolders ?? [])
            .filter((folder) => folder.uri.scheme === "file")
            .map((folder) => folder.uri.fsPath)
        const readText = (fsPath: string) =>
            vscode.workspace.textDocuments
                .find((document) => document.uri.fsPath === fsPath)
                ?.getText() ?? readFileSync(fsPath, "utf8")
        const specs = findReleases(roots, readText)
        const releases: Release[] = []
        const failed = new Map<string, string>()
        for (const spec of specs) {
            try {
                releases.push(
                    await loadRelease(spec, this.cacheDir(), this.helmPath(), readText, this.charts)
                )
            } catch (error) {
                failed.set(spec.appFile + "\u0000" + spec.name, String(error).split("\n")[0]!)
                this.output.appendLine(`${spec.name}: ${String(error)}`)
            }
        }
        if (generation !== this.generation) return
        this.releases = releases
        this.failed = failed
        this.updateDiagnostics()
        this.changes.fire()
        if (render && this.renderOnSave()) this.scheduleRender()
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
        await Promise.all(this.releases.map((release) => this.render(release, false)))
    }

    private async renderNamed(name: string | undefined): Promise<void> {
        const release = await this.pick(name)
        if (release !== undefined) await this.render(release, true)
    }

    /** Renders a release with `helm template`. The status bar names the resources that changed since the last render. */
    private async render(release: Release, announce: boolean): Promise<void> {
        const name = release.spec.name
        try {
            const rendered = await renderRelease(release, this.helmPath())
            const before = this.rendered.get(name)
            this.rendered.set(name, rendered)
            this.renderErrors.delete(name)
            if (before !== undefined) {
                const { added, removed, changed } = changedResources(before, rendered)
                const parts = [
                    ...changed.map((key) => `~${key}`),
                    ...added.map((key) => `+${key}`),
                    ...removed.map((key) => `-${key}`)
                ]
                if (parts.length > 0)
                    vscode.window.setStatusBarMessage(`${name}: ${parts.join(", ")}`, 8000)
            } else if (announce) {
                vscode.window.setStatusBarMessage(
                    `${name}: rendered ${rendered.resources.size} resources`,
                    5000
                )
            }
            this.virtualChanges.fire(this.virtualUri(name, "manifests.yaml"))
        } catch (error) {
            this.renderErrors.set(name, (error as Error).message)
            if (announce)
                void vscode.window.showErrorMessage(
                    `helm template ${name}: ${(error as Error).message.split("\n")[0]}`
                )
        }
        this.updateDiagnostics()
        this.changes.fire()
    }

    private updateDiagnostics(): void {
        const byFile = new Map<string, vscode.Diagnostic[]>()
        const add = (fsPath: string, diagnostic: vscode.Diagnostic) => {
            const list = byFile.get(fsPath) ?? []
            list.push(diagnostic)
            byFile.set(fsPath, list)
        }
        for (const release of this.releases) {
            const appLine = new vscode.Range(release.spec.appLine, 0, release.spec.appLine, 999)
            for (const problem of release.problems)
                add(
                    release.spec.appFile,
                    new vscode.Diagnostic(appLine, problem, vscode.DiagnosticSeverity.Warning)
                )
            const renderError = this.renderErrors.get(release.spec.name)
            if (renderError !== undefined)
                add(
                    release.spec.appFile,
                    new vscode.Diagnostic(
                        appLine,
                        `helm template failed: ${renderError}`,
                        vscode.DiagnosticSeverity.Error
                    )
                )
        }
        for (const [key, reason] of this.failed) {
            const [appFile] = key.split("\u0000")
            add(
                appFile!,
                new vscode.Diagnostic(
                    new vscode.Range(0, 0, 0, 999),
                    `chart not loaded: ${reason}`,
                    vscode.DiagnosticSeverity.Warning
                )
            )
        }
        for (const fsPath of new Set(
            this.releases.flatMap((release) => release.trace.layers.map((layer) => layer.fsPath))
        )) {
            if (fsPath === undefined) continue
            for (const hint of valueHints(fsPath, this.releases)) {
                if (hint.kind !== "unknown") continue
                const range = new vscode.Range(hint.position.line, 0, hint.position.line, 999)
                const diagnostic = new vscode.Diagnostic(
                    range,
                    `${hint.release.spec.name}: the chart ${hint.release.chart.name} neither defaults nor reads ${hint.path.join(".")}`,
                    vscode.DiagnosticSeverity.Information
                )
                diagnostic.source = "Helm Values Lens"
                add(fsPath, diagnostic)
            }
        }
        this.diagnostics.clear()
        for (const [fsPath, list] of byFile) this.diagnostics.set(vscode.Uri.file(fsPath), list)
    }

    private hintsOf(document: vscode.TextDocument): Hint[] {
        const fsPath = document.uri.fsPath
        if (this.releases.some((release) => templatePrefix(fsPath, release) !== undefined))
            return templateHints(fsPath, document.getText(), this.releases)
        return valueHints(fsPath, this.releases).filter((hint) => hint.kind !== "unknown")
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

    private hover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Hover | undefined {
        const fsPath = document.uri.fsPath
        const at = { line: position.line, column: position.character }
        const sections: string[] = []
        for (const site of siteAt(fsPath, at, this.releases)) {
            sections.push(this.chainWithResources(site.release, site.path, fsPath))
        }
        for (const hint of templateHints(
            fsPath,
            document.lineAt(position.line).text,
            this.releases
        )) {
            sections.push(this.chainWithResources(hint.release, hint.path, fsPath))
        }
        if (sections.length === 0) return undefined
        const markdown = new vscode.MarkdownString([...new Set(sections)].join("\n\n---\n\n"))
        markdown.isTrusted = false
        return new vscode.Hover(markdown)
    }

    private chainWithResources(release: Release, path: readonly string[], fsPath: string): string {
        const chain = chainMarkdown(release, path, fsPath)
        const rendered = this.rendered.get(release.spec.name)
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
        const lenses: vscode.CodeLens[] = []
        for (const release of this.releases) {
            if (release.spec.appFile !== document.uri.fsPath) continue
            const range = new vscode.Range(release.spec.appLine, 0, release.spec.appLine, 0)
            const userLayers = release.trace.layers.length - release.firstUserLayer
            const name = release.spec.name
            lenses.push(
                new vscode.CodeLens(range, {
                    title: `Final values: ${userLayers} ${userLayers === 1 ? "layer" : "layers"} over ${release.chart.name}`,
                    command: "helmValuesLens.showFinalValues",
                    arguments: [name]
                }),
                new vscode.CodeLens(range, {
                    title: "Chart files",
                    command: "helmValuesLens.openChartFile",
                    arguments: [name]
                }),
                new vscode.CodeLens(range, {
                    title: this.renderTitle(name),
                    command: "helmValuesLens.showManifests",
                    arguments: [name]
                })
            )
        }
        return lenses
    }

    /** Lets the user pick a values file or template of the chart, which may sit in the chart cache outside the workspace. */
    private async openChartFile(name: string | undefined): Promise<void> {
        const release = await this.pick(name)
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

    private renderTitle(name: string): string {
        if (this.renderErrors.has(name)) return "Render failed"
        const rendered = this.rendered.get(name)
        return rendered === undefined ? "Render" : `Rendered ${rendered.resources.size} resources`
    }

    private async open(name: string | undefined, view: string): Promise<void> {
        const release = await this.pick(name)
        if (release === undefined) return
        if (view === "manifests.yaml" && !this.rendered.has(release.spec.name))
            await this.render(release, true)
        const document = await vscode.workspace.openTextDocument(
            this.virtualUri(release.spec.name, view)
        )
        await vscode.languages.setTextDocumentLanguage(document, "yaml")
        await vscode.window.showTextDocument(document, {
            preview: true,
            viewColumn: vscode.ViewColumn.Beside
        })
    }

    private async pick(name: string | undefined): Promise<Release | undefined> {
        if (name !== undefined) return this.releases.find((release) => release.spec.name === name)
        const picked = await vscode.window.showQuickPick(
            this.releases.map((release) => ({
                label: release.spec.name,
                description: release.chart.name,
                release
            })),
            { placeHolder: "Release" }
        )
        return picked?.release
    }

    private virtualUri(name: string, view: string): vscode.Uri {
        return vscode.Uri.from({ scheme: SCHEME, path: `/${name}/${view}` })
    }

    private virtualContent(uri: vscode.Uri): string {
        const [, name, view] = uri.path.split("/")
        const release = this.releases.find((candidate) => candidate.spec.name === name)
        if (release === undefined) return `# No release named ${name}\n`
        if (view === "final-values.yaml")
            return annotatedFinalValues(release, this.rootOf(release.spec))
        const error = this.renderErrors.get(release.spec.name)
        if (error !== undefined) return `# helm template failed:\n${error.replace(/^/gm, "# ")}\n`
        return this.rendered.get(release.spec.name)?.manifests ?? "# Not rendered\n"
    }

    private rootOf(spec: ReleaseSpec): string {
        return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(spec.appFile))?.uri.fsPath ?? "/"
    }
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
