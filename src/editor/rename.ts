import * as vscode from "vscode"
import { planRename, type RenameContext, type RenamePlan, renameEdits } from "../rename"
import { DOCUMENT_SELECTOR } from "./config"
import { editorText } from "./indexer"
import { rangeOf } from "./navigation"
import type { LensState } from "./state"

/** Lets the user rename a key (F2) in every values layer, parameter name and template that spells it. */
export function registerRename(state: LensState): vscode.Disposable {
    return vscode.languages.registerRenameProvider(DOCUMENT_SELECTOR, {
        prepareRename: (document, position) => {
            const plan = planAt(state, document, position)
            return { range: rangeOf(plan.span), placeholder: plan.name }
        },
        provideRenameEdits: (document, position, name) => {
            const edits = renameEdits(planAt(state, document, position), name)
            if (typeof edits === "string") throw new Error(edits)
            const workspaceEdit = new vscode.WorkspaceEdit()
            for (const edit of edits)
                workspaceEdit.replace(vscode.Uri.file(edit.fsPath), rangeOf(edit), edit.text)
            return workspaceEdit
        }
    })
}

/** The rename of the key under the cursor. Throws the reason where the key cannot change, which VS Code shows. */
function planAt(
    state: LensState,
    document: vscode.TextDocument,
    position: vscode.Position
): RenamePlan {
    const plan = planRename(renameContext(state), document.uri.fsPath, {
        line: position.line,
        column: position.character
    })
    if (plan === undefined)
        throw new Error(
            "Place the cursor on a key of a values layer or on a `.Values` read to rename it."
        )
    if (typeof plan === "string") throw new Error(plan)
    return plan
}

function renameContext(state: LensState): RenameContext {
    return {
        releases: state.releases,
        failed: state.failures.map((failure) => failure.spec),
        readText: editorText,
        editable: (fsPath) =>
            vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath)) !== undefined,
        describe: (fsPath) => vscode.workspace.asRelativePath(fsPath)
    }
}
