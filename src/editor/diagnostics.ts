import * as vscode from "vscode"
import { releaseTitle } from "../hints"
import { groupLayer, type KeyGroup, keyGroups, removableGroup, unknownSites } from "../quickFixes"
import { listed } from "../text"
import { dottedPath, type Position } from "../yamlPaths"
import { DIAGNOSTIC_SOURCE, RELEASES_NAMED } from "./config"
import type { LensState } from "./state"

interface Span {
    start: Position
    end: Position
}

/**
 * Marks the problems of the releases in the files that hold them.
 * A release that did not load or render gets a warning or an error at the line that names it.
 * A key unknown to its chart gets a note. A key equal to the chart default gets a hint, which offers its quick fix and counts as no problem.
 */
export class Diagnostics implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE)
    private readonly subscription: vscode.Disposable

    constructor(private readonly state: LensState) {
        this.subscription = state.onDidChange(() => this.update())
    }

    dispose(): void {
        this.subscription.dispose()
        this.collection.dispose()
    }

    private update(): void {
        const byFile = new Map<string, vscode.Diagnostic[]>()
        const add = (
            fsPath: string,
            span: Span,
            message: string,
            severity: vscode.DiagnosticSeverity
        ) => {
            const list = byFile.get(fsPath) ?? []
            const line = span.start.line
            if (list.some((other) => other.message === message && other.range.start.line === line))
                return
            const range = new vscode.Range(
                span.start.line,
                span.start.column,
                span.end.line,
                span.end.column
            )
            const diagnostic = new vscode.Diagnostic(range, message, severity)
            diagnostic.source = DIAGNOSTIC_SOURCE
            list.push(diagnostic)
            byFile.set(fsPath, list)
        }
        const { Error, Warning, Information, Hint } = vscode.DiagnosticSeverity
        for (const release of this.state.releases) {
            const { appFile, appLine } = release.spec
            const title = releaseTitle(release.spec)
            for (const problem of release.problems)
                add(appFile, wholeLine(appLine), `${title}: ${problem}`, Warning)
            const renderError = this.state.renderError(release.spec.id)
            if (renderError !== undefined)
                add(
                    appFile,
                    wholeLine(appLine),
                    `${title}: helm template could not render the chart: ${renderError}`,
                    Error
                )
        }
        for (const { spec, reason } of this.state.failures)
            add(
                spec.appFile,
                wholeLine(spec.appLine),
                `${releaseTitle(spec)}: chart not loaded: ${reason}`,
                Warning
            )
        for (const fsPath of this.valuesFiles()) {
            for (const group of keyGroups(fsPath, this.state.releases)) {
                const span = { start: group.key, end: group.end }
                for (const { release, path } of unknownSites(group))
                    add(
                        fsPath,
                        span,
                        `${releaseTitle(release.spec)}: the chart ${release.chart.name} neither defaults nor reads ${dottedPath(path)}`,
                        Information
                    )
                if (groupLayer(group).kind !== "parameters" && removableGroup(group))
                    add(fsPath, span, defaultMessage(group), Hint)
            }
        }
        this.collection.clear()
        for (const [fsPath, list] of byFile) this.collection.set(vscode.Uri.file(fsPath), list)
    }

    private valuesFiles(): Set<string> {
        const files = new Set<string>()
        for (const release of this.state.releases)
            for (const layer of release.trace.layers)
                if (layer.fsPath !== undefined && layer.kind !== "parameters")
                    files.add(layer.fsPath)
        return files
    }
}

function defaultMessage(group: KeyGroup): string {
    const titles = [...new Set(group.sites.map((site) => releaseTitle(site.release.spec)))]
    return `${dottedPath(group.path)} equals the chart default. Removing it leaves the values of ${listed(titles, RELEASES_NAMED)} unchanged.`
}

function wholeLine(line: number): Span {
    return { start: { line, column: 0 }, end: { line, column: Number.MAX_SAFE_INTEGER } }
}
