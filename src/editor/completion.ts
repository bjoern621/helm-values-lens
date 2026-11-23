import * as vscode from "vscode"
import { type Completion, completionsAt } from "../completion"
import { DOCUMENT_SELECTOR } from "./config"
import type { LensState } from "./state"

/**
 * Suggests keys and values in values files and in the values blocks of Applications, from the charts of the releases that read them.
 * The releases picked in the status bar come first. The others fill in where those cover nothing.
 */
export function registerCompletion(state: LensState): vscode.Disposable {
    return vscode.languages.registerCompletionItemProvider(
        DOCUMENT_SELECTOR,
        {
            provideCompletionItems: (document, position, _token, context) => {
                if (context.triggerCharacter === " " && !afterColon(document, position)) return []
                const fsPath = document.uri.fsPath
                const text = document.getText()
                const at = { line: position.line, column: position.character }
                const { shown, others } = state.fileReleases(fsPath)
                const completions = completionsAt(text, fsPath, at, shown)
                const found =
                    completions.length > 0 ? completions : completionsAt(text, fsPath, at, others)
                return found.map((completion) => completionItem(completion, position))
            }
        },
        " "
    )
}

function completionItem(completion: Completion, position: vscode.Position): vscode.CompletionItem {
    const { label, kind, shape, indent } = completion
    const item = new vscode.CompletionItem(
        { label, description: completion.detail },
        kind === "key" ? vscode.CompletionItemKind.Property : vscode.CompletionItemKind.Value
    )
    item.documentation = new vscode.MarkdownString(completion.documentation, true)
    item.keepWhitespace = true
    item.range = new vscode.Range(
        position.line,
        completion.replaceFrom,
        position.line,
        position.character
    )
    if (kind === "value") {
        item.insertText = completion.text
        return item
    }
    const child = `${indent}  `
    item.insertText = new vscode.SnippetString().appendText(completion.text)
    if (shape === "map") item.insertText.appendText(`:\n${child}`).appendTabstop(0)
    else if (shape === "list") item.insertText.appendText(`:\n${child}- `).appendTabstop(0)
    else {
        item.insertText.appendText(": ").appendTabstop(0)
        item.command = { title: "Suggest values", command: "editor.action.triggerSuggest" }
    }
    return item
}

/** Whether the cursor follows the colon and the blank of a key, where its values complete. */
function afterColon(document: vscode.TextDocument, position: vscode.Position): boolean {
    return document.lineAt(position.line).text.slice(0, position.character).endsWith(": ")
}
