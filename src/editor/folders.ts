import { relative } from "node:path"
import * as vscode from "vscode"
import type { ReleaseSpec } from "../argo"

/** The folders of the workspace on the local disk. */
export function roots(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === "file")
        .map((folder) => folder.uri.fsPath)
}

/** The first folder of the workspace, which the paths of the settings start from. */
export function firstRoot(): string {
    return roots()[0] ?? "/"
}

/** The workspace folder that holds a file, or the root of the disk for a file outside the workspace. */
export function rootOf(fsPath: string): string {
    return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath))?.uri.fsPath ?? "/"
}

/** Names the file and line of the release description, from `root`. */
export function where(spec: ReleaseSpec, root: string): string {
    return `${relative(root, spec.appFile)}:${spec.appLine + 1}`
}
