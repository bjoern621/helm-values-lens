/** The first line of an error or a text, for a message that fits one line. */
export function firstLine(error: unknown): string {
    return String(error instanceof Error ? error.message : error).split("\n")[0]!
}

/** A count with its noun, the noun in the plural unless the count equals one. */
export function countOf(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? "" : "s"}`
}

/** Joins the first `shown` names with commas and "and", naming how many more the list leaves out. */
export function listed(names: readonly string[], shown: number): string {
    const rest = names.length - shown
    if (rest > 0) return `${names.slice(0, shown).join(", ")} and ${rest} more`
    if (names.length <= 1) return names.join("")
    return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}
