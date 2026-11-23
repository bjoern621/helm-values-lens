import * as vscode from "vscode"

/**
 * Follows the file that the user works in, for the status bar and the release picker.
 * A click into a panel that shows text, such as the Output panel, makes the panel's document the active editor.
 * The file stays the one followed while an editor still shows it.
 */
export class WorkingFile implements vscode.Disposable {
    private file = fileOf(vscode.window.activeTextEditor)
    private readonly changed = new vscode.EventEmitter<void>()
    readonly onDidChange = this.changed.event
    private readonly disposables: vscode.Disposable[]

    constructor() {
        this.disposables = [
            this.changed,
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (editor === undefined) this.file = undefined
                else this.file = fileOf(editor) ?? this.file
                this.changed.fire()
            }),
            vscode.window.onDidChangeVisibleTextEditors(() => this.changed.fire())
        ]
    }

    dispose(): void {
        for (const disposable of this.disposables) disposable.dispose()
    }

    /** The path of the file, or undefined once no editor shows it. */
    get fsPath(): string | undefined {
        const file = this.file
        if (file === undefined) return undefined
        const shown = vscode.window.visibleTextEditors.some(
            (editor) => editor.document.uri.toString() === file.toString()
        )
        return shown ? file.fsPath : undefined
    }
}

function fileOf(editor: vscode.TextEditor | undefined): vscode.Uri | undefined {
    return editor?.document.uri.scheme === "file" ? editor.document.uri : undefined
}
