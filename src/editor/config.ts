import * as vscode from "vscode"
import type { ConfiguredRelease } from "../workspace"

export const SETTINGS_SECTION = "helmValuesLens"
export const DIAGNOSTIC_SOURCE = "Helm Values Lens"
/** The URI scheme of the final values and manifests that open beside a file. */
export const VIRTUAL_SCHEME = "helm-values-lens"
/** The workspace state key that keeps the release the hints follow. */
export const FOCUS_KEY = "helmValuesLens.focus"
/** The focus value under which the hints show every release that reads a file. */
export const ALL_RELEASES = "*"

export const REINDEX_DELAY_MS = 300
export const RENDER_DELAY_MS = 800
export const CHANGE_MESSAGE_DURATION_MS = 8000
/** How many release names a diagnostic names before it counts the rest. */
export const RELEASES_NAMED = 3

export const DOCUMENT_SELECTOR: vscode.DocumentSelector = [
    { language: "yaml" },
    { language: "helm" },
    { pattern: "**/templates/**" }
]

export interface Settings {
    helmPath: string
    renderOnSave: boolean
    showAllLayers: boolean
    releases: ConfiguredRelease[]
    repositories: Record<string, string>
}

/** Reads the settings of the extension, each with its default from `package.json`. */
export function readSettings(): Settings {
    const config = vscode.workspace.getConfiguration(SETTINGS_SECTION)
    return {
        helmPath: config.get("helmPath", "helm"),
        renderOnSave: config.get("renderOnSave", true),
        showAllLayers: config.get("hover.showAllLayers", true),
        releases: config.get<ConfiguredRelease[]>("releases", []),
        repositories: config.get<Record<string, string>>("repositories", {})
    }
}

/** Appends a release to the `releases` setting of the workspace. */
export async function addConfiguredRelease(entry: ConfiguredRelease): Promise<void> {
    const config = vscode.workspace.getConfiguration(SETTINGS_SECTION)
    const releases = config.get<ConfiguredRelease[]>("releases", [])
    await config.update("releases", [...releases, entry], vscode.ConfigurationTarget.Workspace)
}
