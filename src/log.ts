/**
 * Takes the lines that describe what the extension loads, pulls and renders.
 * The output channel in VS Code stamps each line with its time and level and filters by the level that the user sets.
 */
export interface Log {
    info(message: string): void
    warn(message: string): void
    debug(message: string): void
}

/** Drops every line, for the command line and the tests. */
export const SILENT: Log = { info() {}, warn() {}, debug() {} }

/** The time passed since `start`, a `Date.now()` value, such as `85 ms` or `1.4 s`. */
export function durationSince(start: number): string {
    const ms = Date.now() - start
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** The local time of day of a `Date.now()` value, such as `14:05`. */
export function clock(at: number): string {
    return new Date(at).toTimeString().slice(0, 5)
}
