/**
 * Fallback detection for `is_subagent` when OpenCode's `session.created` event
 * has not yet been processed by our event handler.
 *
 * Why this exists:
 *   OpenCode creates a session and returns the ID to the API caller. The
 *   caller can immediately prompt against that session. Our
 *   `experimental.chat.system.transform` and `experimental.chat.messages.transform`
 *   hooks fire during that prompt flow. But the `session.created` event is
 *   published via `Effect.sync(SyncEvent.run(...))` → `Database.effect(() => ...)`
 *   → `void publish(result)` in OpenCode's sync/index.ts. Fire-and-forget.
 *
 *   So on a fresh child session, the very first transform pass can run BEFORE
 *   our event handler has written `is_subagent=1` to session_meta.
 *   `getOrCreateSessionMeta` then returns the default `isSubagent: false`,
 *   which misclassifies the session as primary for that pass. The plugin
 *   injects §N§ prefixes, adjunct blocks, and attempts primary-mode gates —
 *   all of which are wrong for a subagent and can bust Anthropic prompt-cache
 *   when the correct reduced-mode state kicks in on the next pass.
 *
 *   This fallback bridges that gap by reading OpenCode's `session.parent_id`
 *   directly from its SQLite DB when we first create a session_meta row.
 */

import { withReadOnlySessionDb } from "../../hooks/magic-context/read-session-db";
import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";

interface SessionParentRow {
    parent_id: string | null;
}

/**
 * Peek at OpenCode's `session` table to determine whether the given session
 * is a subagent (has a non-empty `parent_id`).
 *
 * Returns:
 *   - `true`  → session row exists with non-empty parent_id → SUBAGENT
 *   - `false` → session row exists with null/empty parent_id → PRIMARY
 *   - `null`  → session row doesn't exist yet OR DB read failed → UNKNOWN
 *
 * Callers should default to PRIMARY behavior on `null` because the common
 * case (root sessions, test harness edge cases, DB unavailable) is primary.
 * But when the row EXISTS and `parent_id` is populated, we can trust it
 * immediately — OpenCode writes this row synchronously as part of
 * `Session.create()`, before returning the session ID to the API caller.
 */
export function resolveIsSubagentFromOpenCodeDb(sessionId: string): boolean | null {
    try {
        return withReadOnlySessionDb((openCodeDb: Database) => {
            const row = openCodeDb
                .prepare("SELECT parent_id FROM session WHERE id = ?")
                .get(sessionId) as SessionParentRow | null;

            if (!row) return null;
            return typeof row.parent_id === "string" && row.parent_id.length > 0;
        });
    } catch (error) {
        // Never throw — fallback is best-effort. Log once and return null.
        log(`[magic-context] resolveIsSubagentFromOpenCodeDb failed for ${sessionId}:`, error);
        return null;
    }
}
