import * as vscode from "vscode"
import { releaseTitle, type SettingSite, siteEnd, winningUserSite } from "../hints"
import {
    groupLayer,
    ignoredKeys,
    type KeyGroup,
    keyGroups,
    type KeyUse,
    removableGroup
} from "../quickFixes"
import { agreeing, countOf, listed } from "../text"
import { dottedPath, type Position } from "../yamlPaths"
import { DIAGNOSTIC_SOURCE, RELEASES_NAMED } from "./config"
import type { LensState } from "./state"

/** Tells the quick fixes which marker they resolve. */
export const MarkerCode = {
    ChartDefault: "chart-default",
    PartlyRead: "partly-read",
    Unread: "unread"
} as const
type MarkerCode = (typeof MarkerCode)[keyof typeof MarkerCode]

interface Span {
    start: Position
    end: Position
}

/**
 * Marks the problems of the releases in the files that hold them.
 * A release that did not load or render gets a warning or an error at the line that names it.
 * A value that a `values.schema.json` rejects gets an error at the key that sets it, as `helm template` would fail on it.
 * A key that no chart reading its file reads gets a warning, since it changes nothing.
 * It gets a note where a release that takes the file did not load, since its chart could read the key unseen.
 * A key that the charts of some releases read and others ignore gets a hint, which counts as no problem.
 * A key equal to the chart default gets a hint, which offers its quick fix.
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
            severity: vscode.DiagnosticSeverity,
            code?: MarkerCode
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
            diagnostic.code = code
            list.push(diagnostic)
            byFile.set(fsPath, list)
        }
        const { Error, Warning, Information, Hint } = vscode.DiagnosticSeverity
        for (const release of this.state.releases) {
            const { appFile, appLine } = release.spec
            const title = releaseTitle(release.spec)
            for (const problem of release.problems)
                add(appFile, wholeLine(appLine), `${title}: ${problem}`, Warning)
            for (const { path, message } of release.schemaErrors) {
                const site = winningUserSite(release, path)
                const fsPath = site && release.trace.layers[site.layerIndex]!.fsPath
                if (site === undefined || fsPath === undefined)
                    add(appFile, wholeLine(appLine), `${title}: ${message}`, Error)
                else
                    add(
                        fsPath,
                        { start: site.key, end: siteEnd(site) },
                        `${title}: ${message}`,
                        Error
                    )
            }
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
            const groups = keyGroups(fsPath, this.state.releases)
            const unloaded = this.state.failures.filter(({ spec }) =>
                spec.layers.some((layer) => layer.fsPath === fsPath)
            ).length
            for (const use of ignoredKeys(groups)) {
                const span = { start: use.group.key, end: use.group.end }
                if (use.readers.length > 0)
                    add(fsPath, span, partlyReadMessage(use), Hint, MarkerCode.PartlyRead)
                else if (unloaded > 0)
                    add(
                        fsPath,
                        span,
                        `${unreadMessage(use)} ${countOf(unloaded, "release")} that ${agreeing(unloaded, "takes", "take")} this file did not load.`,
                        Information,
                        MarkerCode.Unread
                    )
                else add(fsPath, span, unreadMessage(use), Warning, MarkerCode.Unread)
            }
            for (const group of groups) {
                const span = { start: group.key, end: group.end }
                if (groupLayer(group).kind !== "parameters" && removableGroup(group))
                    add(fsPath, span, defaultMessage(group), Hint, MarkerCode.ChartDefault)
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

/** Names the releases whose charts read the key and the ones whose charts ignore it. */
function partlyReadMessage({ group, readers, ignorers }: KeyUse): string {
    return `${dottedPath(group.path)}: read by ${titles(readers)}, ignored by ${titles(ignorers)}.`
}

function unreadMessage({ group, ignorers }: KeyUse): string {
    return `${dottedPath(group.path)}: read by no chart, ignored by ${titles(ignorers)}.`
}

function titles(sites: readonly SettingSite[]): string {
    return listed(
        [...new Set(sites.map((site) => releaseTitle(site.release.spec)))],
        RELEASES_NAMED
    )
}

function wholeLine(line: number): Span {
    return { start: { line, column: 0 }, end: { line, column: Number.MAX_SAFE_INTEGER } }
}
