import * as vscode from "vscode"
import { releaseTitle } from "../hints"
import type { LensState, Progress } from "./state"
import type { WorkingFile } from "./workingFile"

/**
 * Names the release that the hints of the active file follow, and how far reading or rendering the releases got.
 * A click picks another release.
 */
export class StatusBar implements vscode.Disposable {
    private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
    private readonly disposables: vscode.Disposable[]

    constructor(
        private readonly state: LensState,
        private readonly workingFile: WorkingFile
    ) {
        this.item.command = "helmValuesLens.selectRelease"
        this.disposables = [
            this.item,
            state.onDidChange(() => this.update()),
            state.onDidChangeProgress(() => this.update()),
            workingFile.onDidChange(() => this.update())
        ]
    }

    dispose(): void {
        for (const disposable of this.disposables) disposable.dispose()
    }

    private update(): void {
        const file = this.workingFile.fsPath
        const candidates = file === undefined ? [] : this.state.candidates(file)
        const progress = this.state.progress
        if (candidates.length === 0 && progress === undefined) {
            this.item.hide()
            return
        }
        const parts: string[] = []
        const tooltip: string[] = []
        if (progress !== undefined) {
            parts.push(`$(sync~spin) ${progressText(progress)}`)
            tooltip.push(progressTooltip(progress))
        }
        if (candidates.length > 0) {
            const focus = this.state.focused(candidates)
            const count = candidates.length > 1 ? ` (${candidates.length})` : ""
            const name =
                focus === undefined
                    ? `All ${candidates.length} releases`
                    : `${releaseTitle(focus.spec)}${count}`
            parts.push(progress === undefined ? `$(layers) ${name}` : name)
            tooltip.push(
                candidates.length > 1
                    ? `${candidates.length} releases read this file. The hints follow the one named here. Click to pick another.`
                    : "The release whose values the hints show"
            )
        }
        this.item.text = parts.join(" · ")
        this.item.tooltip = tooltip.join("\n\n")
        this.item.show()
    }
}

function progressText({ kind, done, total }: Progress): string {
    return `${kind === "reading" ? "Reading" : "Rendering"} releases ${done}/${total}`
}

function progressTooltip({ kind, done, total }: Progress): string {
    return kind === "reading"
        ? `Read ${done} of ${total} Helm releases so far. A chart that renders Argo CD Applications adds their releases to the total.`
        : `Rendered ${done} of ${total} Helm releases with helm template.`
}
