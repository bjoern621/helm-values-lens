import { basename } from "node:path"
import * as vscode from "vscode"
import { registerCodeActions } from "./editor/codeActions"
import { registerCodeLens } from "./editor/codeLens"
import { registerCommands } from "./editor/commands"
import { DIAGNOSTIC_SOURCE, SETTINGS_SECTION } from "./editor/config"
import { Diagnostics } from "./editor/diagnostics"
import { Indexer } from "./editor/indexer"
import { LensState } from "./editor/state"
import { StatusBar } from "./editor/statusBar"
import { registerValueViews } from "./editor/valueViews"
import { VirtualDocs } from "./editor/virtualDocs"
import { RELEASE_FILE } from "./workspace"

/** The files whose creation or deletion can add or remove a release. */
const WATCHED_FILES = "**/{*.yaml,*.yml,*.gotmpl,*.tpl,Kustomization}"

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel(DIAGNOSTIC_SOURCE)
    const state = new LensState(context.workspaceState)
    const indexer = new Indexer(state, output, context.globalStorageUri.fsPath)
    const docs = new VirtualDocs(state)
    const watcher = vscode.workspace.createFileSystemWatcher(WATCHED_FILES)
    context.subscriptions.push(
        output,
        state,
        indexer,
        docs,
        new StatusBar(state),
        new Diagnostics(state),
        ...registerValueViews(state),
        registerCodeActions(state),
        registerCodeLens(state),
        ...registerCommands(state, indexer, docs),
        watcher,
        watcher.onDidCreate(() => indexer.scheduleReindex(false)),
        watcher.onDidDelete(() => indexer.scheduleReindex(false)),
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.contentChanges.length > 0 && isWatched(event.document))
                indexer.scheduleReindex(false)
        }),
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (isWatched(document)) indexer.scheduleReindex(true)
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => indexer.scheduleReindex(true)),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(SETTINGS_SECTION)) indexer.scheduleReindex(true)
        })
    )
    indexer.requestReindex(true)
}

export function deactivate(): void {}

/** Whether a change of the document can change a release: a file that may describe one, or a template. */
function isWatched(document: vscode.TextDocument): boolean {
    if (document.uri.scheme !== "file") return false
    const name = basename(document.uri.fsPath)
    return RELEASE_FILE.test(name) || name.endsWith(".tpl")
}
