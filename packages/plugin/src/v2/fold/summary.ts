/** Markup without any history is not a usable host compaction summary. */
export function hasFoldSummary(summary: string | null | undefined): summary is string {
    return typeof summary === "string" && summary.replace(/<[^>]*>/g, "").trim().length > 0;
}
