import * as vscode from "vscode"
import {
    type Hint,
    settingSites,
    type Target,
    targetsAt,
    templateHints,
    valueHints
} from "../hints"
import { pathMarkdown, releaseMarkdown } from "../markdown"
import type { Release } from "../release"
import { agreeing, countOf } from "../text"
import type { Position, ValuePath } from "../yamlPaths"
import { DOCUMENT_SELECTOR, readSettings } from "./config"
import type { FileReleases, LensState } from "./state"

/**
 * Shows the values of the releases in the editor: an inlay hint after each key and `.Values` read, and a hover over each.
 * The hover of a key and the tooltip of its hint show the same text.
 * A place that no shown release covers, such as the block of another Application in the same file, shows the releases that cover it.
 */
export function registerValueViews(state: LensState): vscode.Disposable[] {
    return [
        vscode.languages.registerInlayHintsProvider(DOCUMENT_SELECTOR, {
            onDidChangeInlayHints: state.onDidChange,
            provideInlayHints: (document) => inlayHints(state, document)
        }),
        vscode.languages.registerHoverProvider(DOCUMENT_SELECTOR, {
            provideHover: (document, position) => hover(state, document, position)
        })
    ]
}

function inlayHints(state: LensState, document: vscode.TextDocument): vscode.InlayHint[] {
    const fsPath = document.uri.fsPath
    const text = document.getText()
    const { shown, others } = state.fileReleases(fsPath)
    const shownReads = templateHints(fsPath, text, shown)
    const covered = new Set(
        [
            ...settingSites(fsPath, shown).map((site) => site.key),
            ...shownReads.map((hint) => hint.start)
        ].map(place)
    )
    const otherHints = [...templateHints(fsPath, text, others), ...valueHints(fsPath, others)]
    return [
        ...shownReads,
        ...valueHints(fsPath, shown),
        ...otherHints.filter((hint) => !covered.has(place(hint.start)))
    ]
        .filter((hint) => hint.kind !== "unknown")
        .map((hint) => inlayHint(document, hint))
}

function inlayHint(document: vscode.TextDocument, hint: Hint): vscode.InlayHint {
    const line = Math.min(hint.position.line, document.lineCount - 1)
    const text = document.lineAt(line).text
    const column = Math.min(hint.position.column, text.length)
    // Every hint sits right after its key or read with the same padding, so that the gap matches at the end of a line and inside a template expression.
    const inlay = new vscode.InlayHint(new vscode.Position(line, column), hint.label)
    inlay.paddingLeft = true
    inlay.paddingRight = column < text.length && !/\s/.test(text.charAt(column))
    inlay.tooltip = describe(hint.release, hint.path, document.uri.fsPath)
    return inlay
}

/** Shows what the cursor points at: a key or a `.Values` read, or the line that names a release. */
function hover(
    state: LensState,
    document: vscode.TextDocument,
    position: vscode.Position
): vscode.Hover | undefined {
    const fsPath = document.uri.fsPath
    const releases = state.fileReleases(fsPath)
    const targets = targetsUnderCursor(state, document, position)
    if (targets.length > 0) return targetHover(fsPath, targets, releases)
    const lineText = document.lineAt(position.line).text
    return releaseHover(state, fsPath, lineText, position.line, releases)
}

/**
 * Finds the key or the `.Values` read under the cursor, for each release that reads the file.
 * The releases picked in the status bar go first. The others count where none of those covers the place.
 */
export function targetsUnderCursor(
    state: LensState,
    document: vscode.TextDocument,
    position: vscode.Position
): Target[] {
    const releases = state.fileReleases(document.uri.fsPath)
    const all = everyTargetUnderCursor(state, document, position)
    const shown = (target: Target) => releases.shown.includes(target.release)
    return covering(
        all.filter(shown),
        all.filter((target) => !shown(target))
    )
}

/** Finds the key or the `.Values` read under the cursor for every release that reads the file, whichever the status bar picks. */
export function everyTargetUnderCursor(
    state: LensState,
    document: vscode.TextDocument,
    position: vscode.Position
): Target[] {
    const fsPath = document.uri.fsPath
    const lineText = document.lineAt(position.line).text
    const at = { line: position.line, column: position.character }
    const releases = state.fileReleases(fsPath)
    return targetsAt(fsPath, lineText, at, [...releases.shown, ...releases.others])
}

function targetHover(
    fsPath: string,
    targets: readonly Target[],
    releases: FileReleases
): vscode.Hover {
    const sections = targets.map((target) => markdownOf(target.release, target.path, fsPath))
    const hidden = releases.otherChoices.length
    const shownOnly = targets.every((target) => releases.shown.includes(target.release))
    if (hidden > 0 && shownOnly)
        sections.push(
            `$(info) ${countOf(hidden, "other release")} ${agreeing(hidden, "reads", "read")} this file. Pick one in the status bar to show its values.`
        )
    const markdown = hoverMarkdown([...new Set(sections)].join("\n\n---\n\n"))
    const line = targets[0]!.start.line
    const range = new vscode.Range(
        line,
        Math.min(...targets.map((target) => target.start.column)),
        line,
        Math.max(...targets.map((target) => target.end.column))
    )
    return new vscode.Hover(markdown, range)
}

/**
 * Describes the releases that the line at `line` names, such as the `name` of an Argo CD Application.
 * The releases that the hints follow go first. The others show where none of those sits on the line.
 */
function releaseHover(
    state: LensState,
    fsPath: string,
    lineText: string,
    line: number,
    releases: FileReleases
): vscode.Hover | undefined {
    const namedIn = (list: readonly Release[]) =>
        list.filter((release) => release.spec.appFile === fsPath && release.spec.appLine === line)
    const shownNamed = namedIn(releases.shown)
    const named = shownNamed.length > 0 ? shownNamed : namedIn(releases.others)
    if (named.length === 0) return undefined
    const sections = named.map((release) =>
        releaseMarkdown(release, fsPath, state.renderState(release.spec.id))
    )
    const markdown = hoverMarkdown(sections.join("\n\n---\n\n"))
    const start = lineText.length - lineText.trimStart().length
    return new vscode.Hover(
        markdown,
        new vscode.Range(line, start, line, lineText.trimEnd().length)
    )
}

function describe(release: Release, path: ValuePath, fsPath: string): vscode.MarkdownString {
    return hoverMarkdown(markdownOf(release, path, fsPath))
}

/** Markdown with theme icons and the HTML that colours the layer of the current file. */
function hoverMarkdown(text: string): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString(text, true)
    markdown.supportHtml = true
    return markdown
}

function markdownOf(release: Release, path: ValuePath, fsPath: string): string {
    return pathMarkdown(release, path, fsPath, {
        allLayers: readSettings().showAllLayers
    })
}

/** Takes the targets of the shown releases, then the targets of the others at places that the shown ones leave uncovered. */
function covering(shown: readonly Target[], others: readonly Target[]): Target[] {
    const covered = new Set(shown.map((target) => place(target.start)))
    return [...shown, ...others.filter((target) => !covered.has(place(target.start)))]
}

function place(position: Position): string {
    return `${position.line}:${position.column}`
}
