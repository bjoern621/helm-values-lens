import { basename, dirname } from "node:path"
import * as vscode from "vscode"
import { annotatedFinalValues } from "../finalValues"
import type { Release } from "../release"
import { VIRTUAL_SCHEME } from "./config"
import { rootOf } from "./folders"
import type { LensState } from "./state"

export type View = "final-values.yaml" | "manifests.yaml"

/** Serves the final values and the rendered manifests of a release as read-only documents. */
export class VirtualDocs implements vscode.Disposable {
    private readonly changes = new vscode.EventEmitter<vscode.Uri>()
    private readonly disposables: vscode.Disposable[]

    constructor(private readonly state: LensState) {
        this.disposables = [
            this.changes,
            vscode.workspace.registerTextDocumentContentProvider(VIRTUAL_SCHEME, {
                onDidChange: this.changes.event,
                provideTextDocumentContent: (uri) => this.content(uri)
            }),
            state.onDidRender((id) => {
                const release = state.byId(id)
                if (release !== undefined) this.changes.fire(virtualUri(release, "manifests.yaml"))
            })
        ]
    }

    dispose(): void {
        for (const disposable of this.disposables) disposable.dispose()
    }

    async open(release: Release, view: View): Promise<void> {
        const document = await vscode.workspace.openTextDocument(virtualUri(release, view))
        await vscode.languages.setTextDocumentLanguage(document, "yaml")
        await vscode.window.showTextDocument(document, {
            preview: true,
            viewColumn: vscode.ViewColumn.Beside
        })
    }

    private content(uri: vscode.Uri): string {
        const release = this.state.byId(uri.query)
        if (release === undefined) return `# The release ${basename(dirname(uri.path))} is gone\n`
        if (basename(uri.path) === "final-values.yaml")
            return annotatedFinalValues(release, rootOf(release.spec.appFile))
        const render = this.state.renderState(release.spec.id)
        switch (render.kind) {
            case "failed":
                return `# helm template could not render the chart:\n${render.error.replace(/^/gm, "# ")}\n`
            case "rendered":
                return render.rendered.manifests
            case "none":
                return "# Not rendered\n"
        }
    }
}

/** The release name shows as the tab title. The query holds the id, since names repeat. */
function virtualUri(release: Release, view: View): vscode.Uri {
    return vscode.Uri.from({
        scheme: VIRTUAL_SCHEME,
        path: `/${release.spec.name.replaceAll("/", "-")}/${view}`,
        query: release.spec.id
    })
}
