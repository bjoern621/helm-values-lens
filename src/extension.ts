import { basename, join } from "node:path"
import * as vscode from "vscode"
import { registerCodeActions } from "./editor/codeActions"
import { registerCodeLens } from "./editor/codeLens"
import { registerCompletion } from "./editor/completion"
import { registerNavigation } from "./editor/navigation"
import { registerRename } from "./editor/rename"
import { registerCommands } from "./editor/commands"
import { DIAGNOSTIC_SOURCE, SETTINGS_SECTION } from "./editor/config"
import { Diagnostics } from "./editor/diagnostics"
import { Indexer } from "./editor/indexer"
import { LensState } from "./editor/state"
import { StatusBar } from "./editor/statusBar"
import { registerValueViews } from "./editor/valueViews"
import { VirtualDocs } from "./editor/virtualDocs"
import { WorkingFile } from "./editor/workingFile"
import { RenderCache } from "./renderCache"
import { RELEASE_FILE } from "./workspace"

/** The files whose creation or deletion can add or remove a release. */
const WATCHED_FILES = "**/{*.yaml,*.yml,*.gotmpl,*.tpl,Kustomization}"

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel(DIAGNOSTIC_SOURCE, { log: true })
    const state = new LensState(context.workspaceState)
    const renderCache =
        context.storageUri === undefined
            ? undefined
            : new RenderCache(
                  join(context.storageUri.fsPath, "renders"),
                  String(context.extension.packageJSON.version)
              )
    const indexer = new Indexer(state, output, context.globalStorageUri.fsPath, renderCache)
    const docs = new VirtualDocs(state)
    const workingFile = new WorkingFile()
    const watcher = vscode.workspace.createFileSystemWatcher(WATCHED_FILES)
    context.subscriptions.push(
        output,
        state,
        indexer,
        docs,
        workingFile,
        new StatusBar(state, workingFile),
        new Diagnostics(state),
        ...registerValueViews(state),
        registerCodeActions(state),
        registerCodeLens(state),
        registerCompletion(state),
        ...registerNavigation(state),
        registerRename(state),
        ...registerCommands(state, indexer, docs, workingFile),
        watcher,
        watcher.onDidCreate(() => indexer.scheduleReindex(false)),
        watcher.onDidDelete(() => indexer.scheduleReindex(false)),
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.contentChanges.length > 0 && isWatched(event.document))
                indexer.scheduleReindex(false)
        }),
        vscode.workspace.onDidSaveTextDocument((document) => {
            const chartChanged = indexer.forgetChartsHolding(document.uri.fsPath)
            if (chartChanged || isWatched(document)) indexer.scheduleReindex(true)
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
