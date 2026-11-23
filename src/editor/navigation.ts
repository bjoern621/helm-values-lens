import * as vscode from "vscode"
import { templatePrefix } from "../hints"
import {
    originPlace,
    type Place,
    settingPlaces,
    templateReadPlaces,
    valueFileLinks,
    winningPlace
} from "../navigation"
import { DOCUMENT_SELECTOR } from "./config"
import type { LensState } from "./state"
import { everyTargetUnderCursor, targetsUnderCursor } from "./valueViews"

/**
 * Lets the user jump from a key or a `.Values` read to where its value comes from (F12) and to every place that sets or reads it (Shift+F12).
 * A deployment file links each values file that it names (Ctrl+click).
 */
export function registerNavigation(state: LensState): vscode.Disposable[] {
    return [
        vscode.languages.registerDefinitionProvider(DOCUMENT_SELECTOR, {
            provideDefinition: (document, position) => definitions(state, document, position)
        }),
        vscode.languages.registerReferenceProvider(DOCUMENT_SELECTOR, {
            provideReferences: (document, position) => references(state, document, position)
        }),
        vscode.languages.registerDocumentLinkProvider(DOCUMENT_SELECTOR, {
            provideDocumentLinks: (document) => documentLinks(state, document)
        })
    ]
}

/**
 * From a `.Values` read: the line whose value the release ends up with.
 * From a key in a values file: the line where its value first gets set, such as its default in the chart.
 * On that line itself, the location spans the whole line around the cursor.
 * VS Code then opens the references in its place, as `editor.gotoLocation.alternativeDefinitionCommand` sets.
 */
function definitions(
    state: LensState,
    document: vscode.TextDocument,
    position: vscode.Position
): vscode.Location[] {
    const fsPath = document.uri.fsPath
    const places = targetsUnderCursor(state, document, position).flatMap((target) => {
        const place =
            templatePrefix(fsPath, target.release) !== undefined
                ? winningPlace(target.release, target.path)
                : originPlace(target.release, target.path)
        return place === undefined ? [] : [place]
    })
    return locations(places).map((location) =>
        location.uri.fsPath === fsPath && location.range.start.line === position.line
            ? new vscode.Location(location.uri, document.lineAt(position.line).range)
            : location
    )
}

/** Every layer that sets the path under the cursor and every template read that takes its value, for every release that reads the file. */
function references(
    state: LensState,
    document: vscode.TextDocument,
    position: vscode.Position
): vscode.Location[] {
    const places = everyTargetUnderCursor(state, document, position).flatMap((target) => [
        ...settingPlaces(target.release, target.path),
        ...templateReadPlaces(target.release, target.path, false)
    ])
    return locations(places)
}

function documentLinks(state: LensState, document: vscode.TextDocument): vscode.DocumentLink[] {
    const specs = state.releases.map((release) => release.spec)
    return valueFileLinks(document.uri.fsPath, document.getText(), specs).map((link) => {
        const documentLink = new vscode.DocumentLink(rangeOf(link), vscode.Uri.file(link.target))
        documentLink.tooltip = `Open ${vscode.workspace.asRelativePath(link.target)}`
        return documentLink
    })
}

/** The places as locations, each once, in the order found. */
function locations(places: readonly Place[]): vscode.Location[] {
    const seen = new Set<string>()
    const unique = places.filter((place) => {
        const key = `${place.fsPath}:${place.start.line}:${place.start.column}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
    return unique.map((place) => new vscode.Location(vscode.Uri.file(place.fsPath), rangeOf(place)))
}

export function rangeOf(place: Place): vscode.Range {
    return new vscode.Range(place.start.line, place.start.column, place.end.line, place.end.column)
}
