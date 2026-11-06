// OpenCode 2 requires an answer to its checkpoint even before the historian
// publishes history. An empty answer can strand the host without usable history.
export const RAW_HISTORY_ACCOUNT =
    "Magic Context retains the conversation as raw messages; no summarized history is available yet.";

/** Markup without any history is not a usable host compaction summary. */
export function hasFoldSummary(summary: string | null | undefined): summary is string {
    return typeof summary === "string" && summary.replace(/<[^>]*>/g, "").trim().length > 0;
}
