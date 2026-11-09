import type { V2Message } from "../hooks/types";

// OpenCode 2 requires an answer to its checkpoint even before the historian
// publishes history. An empty answer can strand the host without usable history.
export const RAW_HISTORY_ACCOUNT =
    "Magic Context retains the conversation as raw messages; no summarized history is available yet.";

/**
 * The text OpenCode 2 stores for every checkpoint Magic Context answers, automatic
 * or a manual `/compact`. The host's interface draws a checkpoint's stored text
 * under its "Compaction" divider, so storing Magic Context's history head (the
 * first generated context message, m[0]) there showed users a wall of internal
 * context. The model never reads the stored text: Magic Context serves its own
 * head and restores the rows between its history and the host's cut. Code that
 * needs the head reads it from Magic Context's own state, never from this text.
 * Fixed bytes, with no per-session values.
 */
export const CHECKPOINT_NOTE =
    "Magic Context added a compaction marker here to keep this OpenCode session fast. Your history is unchanged: Magic Context still keeps it and sends it to the model.";

/** Markup without any history is not a usable host compaction summary. */
export function hasFoldSummary(summary: string | null | undefined): summary is string {
    return typeof summary === "string" && summary.replace(/<[^>]*>/g, "").trim().length > 0;
}

/**
 * A history head Magic Context can answer a checkpoint with: usable text that is
 * neither the raw-history account nor the stored checkpoint note.
 */
export function isHistoryHead(value: string | null | undefined): value is string {
    return value !== RAW_HISTORY_ACCOUNT && value !== CHECKPOINT_NOTE && hasFoldSummary(value);
}

/**
 * The checkpoint message with Magic Context's recorded head back in place of the
 * stored note, for the request paths that serve or measure the host's checkpoint
 * message itself. Only a checkpoint whose stored text is the note changes; any
 * other stored text already is the head it was answered with. The replacement is
 * literal, so `$` sequences in the head are never read as replacement patterns.
 */
export function withRecordedHead(
    checkpoint: V2Message,
    submitted: string,
    head: string | undefined,
): V2Message {
    if (submitted !== CHECKPOINT_NOTE || head === undefined || head === submitted)
        return checkpoint;
    const copy = structuredClone(checkpoint);
    for (const part of copy.content)
        if (part.type === "text" && typeof part.text === "string")
            part.text = part.text.replace(
                `<summary>\n${submitted}\n</summary>`,
                () => `<summary>\n${head}\n</summary>`,
            );
    return copy;
}
