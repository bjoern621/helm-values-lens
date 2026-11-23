import { existsSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import * as vscode from "vscode"
import { releaseTitle } from "../hints"
import type { Release } from "../release"
import { addConfiguredRelease, ALL_RELEASES } from "./config"
import { firstRoot, roots, where } from "./folders"
import type { Indexer } from "./indexer"
import type { LensState } from "./state"
import type { VirtualDocs } from "./virtualDocs"
import type { WorkingFile } from "./workingFile"

/** Registers the commands of the palette, the CodeLens and the status bar. */
export function registerCommands(
    state: LensState,
    indexer: Indexer,
    docs: VirtualDocs,
    workingFile: WorkingFile
): vscode.Disposable[] {
    const withRelease =
        (work: (release: Release) => Promise<void>) =>
        async (id?: string): Promise<void> => {
            const release =
                id === undefined ? await pickRelease(state, workingFile) : state.byId(id)
            if (release !== undefined) await work(release)
        }
    const command = (name: string, run: (...args: never[]) => unknown) =>
        vscode.commands.registerCommand(`helmValuesLens.${name}`, run)
    return [
        command(
            "showFinalValues",
            withRelease((release) => docs.open(release, "final-values.yaml"))
        ),
        command(
            "showManifests",
            withRelease(async (release) => {
                if (state.renderState(release.spec.id).kind === "none")
                    await indexer.render(release, true)
                await docs.open(release, "manifests.yaml")
            })
        ),
        command(
            "render",
            withRelease((release) => indexer.render(release, true))
        ),
        command("refresh", () => indexer.reload()),
        command("openChartFile", withRelease(openChartFile)),
        command("selectRelease", () => selectRelease(state, workingFile)),
        command("addRelease", () => addRelease(state))
    ]
}

type ReleaseItem = vscode.QuickPickItem & { id: string }

/** The quick pick entry of a release, which every release picker shows. */
function releaseItem(release: Release, root: string): ReleaseItem {
    return {
        label: releaseTitle(release.spec),
        description: `${release.chart.name} ${release.chart.version}`,
        detail: `${release.spec.origin} in ${where(release.spec, root)}`,
        id: release.spec.id
    }
}

function activeCandidates(state: LensState, workingFile: WorkingFile): Release[] {
    const file = workingFile.fsPath
    return file === undefined ? [] : state.candidates(file)
}

/** Lets the user pick a release, the releases of the active file first. */
async function pickRelease(
    state: LensState,
    workingFile: WorkingFile
): Promise<Release | undefined> {
    const first = new Set(activeCandidates(state, workingFile))
    const releases = [...state.releases].sort((a, b) => Number(first.has(b)) - Number(first.has(a)))
    const root = firstRoot()
    const picked = await vscode.window.showQuickPick(
        releases.map((release) => releaseItem(release, root)),
        { placeHolder: "Release", matchOnDescription: true, matchOnDetail: true }
    )
    return picked === undefined ? undefined : state.byId(picked.id)
}

/** Lets the user pick the release whose values the hints show, or every release of the file. */
async function selectRelease(state: LensState, workingFile: WorkingFile): Promise<void> {
    const file = workingFile.fsPath
    const choices = file === undefined ? [] : state.choices(file)
    const releases = choices.length > 0 ? choices : state.releases
    const root = firstRoot()
    const all: ReleaseItem = {
        label: "All releases",
        description: "names each release in its hints",
        id: ALL_RELEASES
    }
    const items = [
        ...(releases.length > 1 ? [all] : []),
        ...releases.map((release) => releaseItem(release, root))
    ]
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Release whose values the hints show",
        matchOnDescription: true,
        matchOnDetail: true
    })
    if (picked !== undefined) await state.setFocus(picked.id)
}

/** Lets the user pick a values file or template of the chart, which may sit in the chart cache outside the workspace. */
async function openChartFile(release: Release): Promise<void> {
    const dirs = [
        { dir: release.chart.dir, label: release.chart.name },
        ...release.chart.dependencies
            .filter((dependency) => !release.disabled.has(dependency.key))
            .map((dependency) => ({ dir: dependency.dir, label: dependency.key }))
    ]
    const items = dirs.flatMap(({ dir, label }) =>
        chartFiles(dir).map((fsPath) => ({
            label: relative(dir, fsPath),
            description: label,
            fsPath
        }))
    )
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Files of ${release.chart.name}`,
        matchOnDescription: true
    })
    if (picked !== undefined) await vscode.window.showTextDocument(vscode.Uri.file(picked.fsPath))
}

/** Adds a release with a chart of the workspace and the values files that the user picks to the `helmValuesLens.releases` setting. */
async function addRelease(state: LensState): Promise<void> {
    const root = roots()[0]
    const index = state.index
    if (root === undefined || index === undefined) {
        void vscode.window.showWarningMessage("Open a folder to add a release.")
        return
    }
    const chart = await vscode.window.showQuickPick(
        index.charts
            .filter((candidate) => !candidate.library)
            .map((candidate) => ({
                label: candidate.name,
                description: `${candidate.version} in ${relative(root, candidate.dir) || "."}`,
                chart: candidate
            })),
        { placeHolder: "Chart of the release" }
    )
    if (chart === undefined) return
    const chartDir = chart.chart.dir
    const ownValues = join(chartDir, "values.yaml")
    const files = index.files
        .filter((fsPath) => /\.ya?ml$/.test(fsPath) && fsPath !== ownValues)
        .filter((fsPath) => basename(fsPath) !== "Chart.yaml")
        .sort((a, b) => nearness(b, chartDir) - nearness(a, chartDir) || a.localeCompare(b))
    const picked = await vscode.window.showQuickPick(
        files.map((fsPath) => ({ label: relative(root, fsPath), fsPath })),
        {
            placeHolder:
                "Pick the values files of the release. Their order in the setting decides which file wins.",
            canPickMany: true
        }
    )
    if (picked === undefined) return
    const name = await vscode.window.showInputBox({
        prompt: "Name of the release",
        value: chart.chart.name
    })
    if (name === undefined || name === "") return
    await addConfiguredRelease({
        name,
        chart: relative(root, chartDir) || ".",
        valueFiles: picked.map((item) => relative(root, item.fsPath))
    })
    const action = await vscode.window.showInformationMessage(
        `Added the release ${name} to helmValuesLens.releases. Reorder its valueFiles there to change which file wins.`,
        "Open Settings"
    )
    if (action === "Open Settings")
        await vscode.commands.executeCommand("workbench.action.openWorkspaceSettingsFile")
}

/** How many folders a file shares with the chart folder, to list the files near the chart first. */
function nearness(fsPath: string, dir: string): number {
    const a = dirname(fsPath).split("/")
    const b = dir.split("/")
    let shared = 0
    while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++
    return shared
}

/** Lists the values file and the templates of a chart folder, without the charts that it depends on. */
function chartFiles(dir: string): string[] {
    const files = existsSync(join(dir, "values.yaml")) ? [join(dir, "values.yaml")] : []
    const walk = (folder: string) => {
        if (!existsSync(folder)) return
        for (const name of readdirSync(folder).sort()) {
            const path = join(folder, name)
            if (statSync(path).isDirectory()) walk(path)
            else files.push(path)
        }
    }
    walk(join(dir, "templates"))
    return files
}
