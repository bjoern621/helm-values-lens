import * as vscode from "vscode"
import {
    documentEdits,
    groupLayer,
    type KeyGroup,
    keyGroups,
    removableGroup,
    removeKeysEdits,
    renameKeyEdit,
    similarKeys,
    type TextEdit,
    unknownSites,
    valuesRegion,
    type ValuesRegion
} from "../quickFixes"
import { dottedPath } from "../yamlPaths"
import { DIAGNOSTIC_SOURCE, DOCUMENT_SELECTOR } from "./config"
import type { LensState } from "./state"

/** How many spellings a rename offers for an unknown key. */
const RENAMES_OFFERED = 3

/** The keys of one values text in a document, such as a values file or the `helm.values` block of one Application. */
interface RegionKeys {
    region: ValuesRegion
    /** Names the region in the title of a fix that edits all of it. */
    label: string
    groups: KeyGroup[]
}

/**
 * Offers to remove a key equal to the chart default, alone or with every such key of its values text.
 * Offers to rename an unknown key to a known one a typo away, or to remove it.
 * The fixes edit values files and the values blocks of Applications alike.
 */
export function registerCodeActions(state: LensState): vscode.Disposable {
    return vscode.languages.registerCodeActionsProvider(
        DOCUMENT_SELECTOR,
        {
            provideCodeActions: (document, range, context) =>
                codeActions(state, document, range, context)
        },
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    )
}

function codeActions(
    state: LensState,
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext
): vscode.CodeAction[] {
    const text = document.getText()
    const actions: vscode.CodeAction[] = []
    const action = (title: string, edits: readonly TextEdit[] | undefined, preferred = false) => {
        if (edits === undefined || edits.length === 0) return undefined
        const fix = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix)
        fix.edit = new vscode.WorkspaceEdit()
        for (const edit of edits)
            fix.edit.replace(
                document.uri,
                new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
                edit.text
            )
        fix.isPreferred = preferred
        actions.push(fix)
        return fix
    }
    for (const { region, label, groups } of regionKeys(
        text,
        keyGroups(document.uri.fsPath, state.releases)
    )) {
        const inRegion = (edits: TextEdit[] | undefined) =>
            edits === undefined ? undefined : documentEdits(text, region, edits)
        const removable = groups.filter(removableGroup)
        const here = groups.filter(
            (group) => group.key.line >= range.start.line && group.key.line <= range.end.line
        )
        for (const group of here) {
            const { path } = group
            const name = dottedPath(path)
            const markers = context.diagnostics.filter(
                (marker) =>
                    marker.source === DIAGNOSTIC_SOURCE &&
                    marker.range.start.line === group.key.line
            )
            if (removable.includes(group)) {
                const fix = action(
                    `Remove ${name}, equal to the chart default`,
                    inRegion(removeKeysEdits(region.text, [path]))
                )
                if (fix !== undefined) fix.diagnostics = markers.filter(isHint)
            }
            const unknown = unknownSites(group)
            if (unknown.length === 0) continue
            const renames = [...new Set(unknown.flatMap((site) => similarKeys(site.release, path)))]
            renames.slice(0, RENAMES_OFFERED).forEach((candidate, index) => {
                const edit = renameKeyEdit(region.text, path, candidate)
                const fix = action(
                    `Rename ${path.at(-1)} to ${candidate}`,
                    inRegion(edit === undefined ? undefined : [edit]),
                    index === 0
                )
                if (fix !== undefined) fix.diagnostics = markers.filter((marker) => !isHint(marker))
            })
            if (unknown.length === group.sites.length) {
                const fix = action(
                    `Remove ${name}, unknown to the chart`,
                    inRegion(removeKeysEdits(region.text, [path]))
                )
                if (fix !== undefined) fix.diagnostics = markers.filter((marker) => !isHint(marker))
            }
        }
        if (removable.length > 1 && here.some((group) => removable.includes(group)))
            action(
                `Remove all ${removable.length} keys equal to the chart default in ${label}`,
                inRegion(
                    removeKeysEdits(
                        region.text,
                        removable.map((group) => group.path)
                    )
                )
            )
    }
    return actions
}

/** Sorts the key groups of a document by the values text that holds them. Keys in no editable text drop out. */
function regionKeys(documentText: string, groups: readonly KeyGroup[]): RegionKeys[] {
    const regions = new Map<string, RegionKeys>()
    for (const group of groups) {
        const layer = groupLayer(group)
        const region = valuesRegion(documentText, layer)
        if (region === undefined) continue
        const place = `${region.offset.lineDelta}:${region.offset.columnDelta}`
        const found = regions.get(place)
        if (found !== undefined) found.groups.push(group)
        else
            regions.set(place, {
                region,
                label: layer.kind === "file" ? "this file" : layer.label,
                groups: [group]
            })
    }
    return [...regions.values()]
}

function isHint(marker: vscode.Diagnostic): boolean {
    return marker.severity === vscode.DiagnosticSeverity.Hint
}
