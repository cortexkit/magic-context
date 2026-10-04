/**
 * Housekeeping for what the Claude Code harness leaves in the shared database.
 *
 * `ctx_search` indexes a session's transcript on demand. The OpenCode plugins
 * sweep index rows whose session was deleted; Claude Code sessions are plain
 * files that Claude Code deletes after its retention period, and nothing tells
 * Magic Context. So the index of a session whose transcript is gone is dropped
 * here. Notes and memories are never touched: they are not derived from the
 * transcript.
 */

import { clearIndexedMessages } from "@magic-context/core/features/magic-context/message-index";
import type { Database } from "@magic-context/core/shared/sqlite";
import { locateTranscript } from "./transcript";

const IDLE_BEFORE_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 25;

export interface PruneResult {
    checked: number;
    pruned: number;
}

export function pruneVanishedTranscriptIndexes(
    db: Database,
    options: { now?: number; configDir?: string } = {},
): PruneResult {
    const cutoff = (options.now ?? Date.now()) - IDLE_BEFORE_PRUNE_MS;
    const rows = db
        .prepare(
            "SELECT session_id FROM message_history_index WHERE harness = 'claude-code' AND updated_at < ? ORDER BY updated_at ASC LIMIT ?",
        )
        .all(cutoff, PRUNE_BATCH) as Array<{ session_id: string }>;
    let pruned = 0;
    for (const { session_id: sessionId } of rows) {
        if (locateTranscript({ sessionId, configDir: options.configDir })) continue;
        clearIndexedMessages(db, sessionId);
        pruned++;
    }
    return { checked: rows.length, pruned };
}
