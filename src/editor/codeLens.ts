import * as vscode from "vscode"
import { countOf } from "../text"
import type { RenderState } from "../markdown"
import { DOCUMENT_SELECTOR } from "./config"
import type { LensState } from "./state"

/** Puts the final values, the chart files and the render of each release above the line that names it. */
export function registerCodeLens(state: LensState): vscode.Disposable {
    return vscode.languages.registerCodeLensProvider(DOCUMENT_SELECTOR, {
        onDidChangeCodeLenses: state.onDidChange,
        provideCodeLenses: (document) => codeLenses(state, document)
    })
}

function codeLenses(state: LensState, document: vscode.TextDocument): vscode.CodeLens[] {
    const here = state.releases.filter((release) => release.spec.appFile === document.uri.fsPath)
    const perLine = new Map<number, number>()
    for (const release of here)
        perLine.set(release.spec.appLine, (perLine.get(release.spec.appLine) ?? 0) + 1)
    return here.flatMap((release) => {
        const line = Math.min(release.spec.appLine, document.lineCount - 1)
        const range = new vscode.Range(line, 0, line, 0)
        const userLayers = release.trace.layers.length - release.firstUserLayer
        const id = release.spec.id
        const name = (perLine.get(release.spec.appLine) ?? 0) > 1 ? `${release.spec.name}: ` : ""
        return [
            new vscode.CodeLens(range, {
                title: `${name}Final values: ${countOf(userLayers, "layer")} over ${release.chart.name}`,
                command: "helmValuesLens.showFinalValues",
                arguments: [id]
            }),
            new vscode.CodeLens(range, {
                title: "Chart files",
                command: "helmValuesLens.openChartFile",
                arguments: [id]
            }),
            new vscode.CodeLens(range, {
                title: renderTitle(state.renderState(id)),
                command: "helmValuesLens.showManifests",
                arguments: [id]
            })
        ]
    })
}

function renderTitle(render: RenderState): string {
    switch (render.kind) {
        case "failed":
            return "Could not render"
        case "rendered":
            return `Rendered ${countOf(render.rendered.resources.size, "resource")}`
        case "none":
            return "Render"
    }
}
