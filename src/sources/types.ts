import type { CheckoutOf, ReleaseSpec } from "../argo"

/** A YAML file of the workspace with its text, from the editor where it holds unsaved changes. */
export interface WorkspaceFile {
    fsPath: string
    text: string
}

/** What a reader may look up beyond the file that it reads. */
export interface SourceContext {
    /** Every YAML file of the workspace, for a lookup such as a Flux `HelmRepository` by name. */
    files: readonly WorkspaceFile[]
    /** Maps a Git URL to the folder in the workspace that holds its checkout. */
    checkoutOf: CheckoutOf
}

/** Reads the releases that one file describes. A file that describes none yields an empty list. */
export type SourceReader = (file: WorkspaceFile, context: SourceContext) => ReleaseSpec[]
