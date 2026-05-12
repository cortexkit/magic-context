/**
 * Compaction Marker Manager
 *
 * Coordinates compaction marker injection/update/removal with historian
 * publication. Called after compartments are published, behind the
 * `compaction_markers` config flag (default: true).
 *
 * The marker summary text is a static placeholder — the real <session-history>
 * is injected by the transform pipeline via inject-compartments.ts. The marker
 * exists solely to make OpenCode's filterCompacted stop at the boundary so the
 * transform receives only the live tail.
 */

import { join } from "node:path";
import {
    closeCompactionMarkerDb,
    getOpenCodeMessageById,
    injectCompactionMarker,
    removeCompactionMarker,
} from "../../features/magic-context/compaction-marker";
import { getCompartmentsByEndMessageId } from "../../features/magic-context/compartment-storage";
import {
    getPersistedCompactionMarkerState,
    type PendingCompactionMarker,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { getDataDir } from "../../shared/data-path";
import { log, sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { Database as SqliteDb } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";

/** Static placeholder — the real session-history comes from transform injection. */
const MARKER_SUMMARY_TEXT =
    "[Compacted by magic-context — session history is managed by the plugin]";

/**
 * Outcome of `updateCompactionMarkerAfterPublication` after the plan-v6
 * refactor. Currently UNUSED — the legacy `void`-returning entry point is
 * still the call site for incremental, recomp, and partial-recomp runners.
 * Step 2 of plan v6 wires this in.
 *
 * Drain policy (consumer reads this in transform-postprocess-phase):
 *   - `applied` / `already-current` / `stale-skip` → CAS-clear pending
 *   - `retryable-failure` → keep pending, do NOT consume
 *     `deferredHistoryRefreshSessions`
 */
export type MarkerUpdateOutcome =
    | { kind: "applied"; markerOrdinal: number }
    | { kind: "already-current" }
    | {
          kind: "stale-skip";
          reason: "compartment-removed" | "target-superseded";
      }
    | { kind: "retryable-failure"; error: Error };

/**
 * Validate that a deferred pending-marker target is still the right thing to
 * apply. Plan v6 §5 two-step check:
 *
 *   1. PRIMARY: raw OpenCode message at `pending.endMessageId` must still
 *      exist. If recomp / revert / partial-recomp wiped that message between
 *      publication and the consuming pass, the deferred target is gone.
 *   2. SECONDARY: a compartment row in our own DB must still have
 *      `end_message_id == pending.endMessageId` AND
 *      `end_message == pending.ordinal`. Catches the case where the raw
 *      message survives but compartmentalization changed (recomp redistributed
 *      boundaries, partial recomp resequenced).
 *
 * Returns `"ok"` only when both checks pass.
 * Returns `"compartment-removed"` when either the raw message or the
 * compartment row is gone.
 * Returns `"target-superseded"` when the compartment row exists at the
 * boundary endMessageId but its ordinal differs from `pending.ordinal` (a
 * later publish moved past us).
 *
 * Throws on DB-access failures (locked OpenCode DB, missing attach) — caller's
 * outer try/catch maps that to `retryable-failure`.
 */
function validatePendingTarget(
    db: Database,
    sessionId: string,
    pending: PendingCompactionMarker,
): "ok" | "compartment-removed" | "target-superseded" {
    // 1. PRIMARY: raw OpenCode message must still exist. May throw on DB
    //    failure; caller catches and returns retryable-failure.
    const ocMessage = getOpenCodeMessageById(sessionId, pending.endMessageId);
    if (!ocMessage) {
        return "compartment-removed";
    }

    // 2. SECONDARY: compartment row keyed by endMessageId.
    const compartments = getCompartmentsByEndMessageId(db, sessionId, pending.endMessageId);
    if (compartments.length === 0) {
        return "compartment-removed";
    }
    if (compartments.length > 1) {
        // Schema doesn't enforce UNIQUE(session_id, end_message_id), but the
        // historian's validation effectively makes them unique. >1 here means
        // a future schema/validation bug; loud-fail rather than guess.
        log(
            `[magic-context][${sessionId}] WARNING: ${compartments.length} compartments share endMessageId=${pending.endMessageId} — schema invariant violated; treating as stale`,
        );
        return "compartment-removed";
    }
    const compartment = compartments[0];
    if (compartment.endMessage !== pending.ordinal) {
        // Same end-message id but different ordinal — a later publish already
        // moved the marker past us. Skip this stale pending and let the newer
        // publish's drain heal.
        return "target-superseded";
    }
    return "ok";
}

/**
 * Apply a deferred compaction-marker mutation owned by a specific pending
 * blob. Called from the transform postprocess drain — see
 * `transform-postprocess-phase.ts` Plan v6 §1.
 *
 * Returns one of four outcomes; the drain interprets each:
 *   - `applied`         → CAS-clear pending (we did the work)
 *   - `already-current` → CAS-clear pending (boundary already at this ordinal)
 *   - `stale-skip`      → CAS-clear pending (target gone or superseded)
 *   - `retryable-failure` → KEEP pending (transient failure; next consuming
 *                          pass will retry; another publish may overwrite
 *                          blob and that publish's drain heals)
 *
 * The justification for "retry on inject failure" is that
 * `removeCompactionMarker()` is a no-op success on already-missing rows (per
 * `compaction-marker.ts:358-367`), so a retry of the full sequence is safe:
 * the second remove sees nothing to delete and succeeds; the second inject
 * tries again.
 */
export function applyDeferredCompactionMarker(
    db: Database,
    sessionId: string,
    pending: PendingCompactionMarker,
    directory?: string,
): MarkerUpdateOutcome {
    try {
        // Stale-target check FIRST — cheap and avoids any state mutation when
        // the target is already gone. The check may throw on DB failure;
        // outer catch turns that into retryable-failure.
        const validation = validatePendingTarget(db, sessionId, pending);
        if (validation !== "ok") {
            sessionLog(
                sessionId,
                `compaction-marker drain: stale-skip (${validation}) for ordinal ${pending.ordinal} endMessageId=${pending.endMessageId}`,
            );
            return { kind: "stale-skip", reason: validation };
        }

        const existing = getPersistedCompactionMarkerState(db, sessionId);
        if (existing && existing.boundaryOrdinal >= pending.ordinal) {
            // Marker already at this boundary (or further). Nothing to do.
            // Includes the equal case — placeholder text never changes.
            return { kind: "already-current" };
        }

        // Remove old marker if present. `removeCompactionMarker` returns false
        // only when the DELETE transaction itself failed (e.g. SQLITE_BUSY).
        // No-op success on already-missing rows is fine — that's why retry is
        // safe. False here means we couldn't even attempt the delete cleanly;
        // bail to retryable WITHOUT calling inject (avoids leaving two marker
        // rows for the same boundary).
        if (existing) {
            const removed = removeCompactionMarker(existing);
            if (!removed) {
                return {
                    kind: "retryable-failure",
                    error: new Error(
                        `failed to remove old compaction marker at ordinal ${existing.boundaryOrdinal}`,
                    ),
                };
            }
            sessionLog(
                sessionId,
                `compaction-marker drain: removed old boundary at ordinal ${existing.boundaryOrdinal}, advancing to ${pending.ordinal}`,
            );
        }

        // Inject new marker. injectCompactionMarker's internal transaction is
        // atomic — null return means the transaction rolled back cleanly, so
        // state is CONSISTENT (no half-write). The OLD marker is gone (if it
        // was present), so OpenCode briefly sees no marker between old-remove
        // and next-retry-inject. That window is acceptable: filterCompacted
        // simply falls back to full-history, the transform sees more raw
        // messages on those passes, and the next consuming pass either
        // succeeds the inject or another publish overwrites pending.
        const result = injectCompactionMarker({
            sessionId,
            endOrdinal: pending.ordinal,
            summaryText: MARKER_SUMMARY_TEXT,
            directory: directory ?? process.cwd(),
        });
        if (!result) {
            return {
                kind: "retryable-failure",
                error: new Error(
                    `injectCompactionMarker returned null for ordinal ${pending.ordinal}; will retry`,
                ),
            };
        }

        setPersistedCompactionMarkerState(db, sessionId, {
            ...result,
            boundaryOrdinal: pending.ordinal,
        });
        sessionLog(
            sessionId,
            `compaction-marker drain: applied at ordinal ${pending.ordinal}, boundary user msg ${result.boundaryMessageId}`,
        );
        return { kind: "applied", markerOrdinal: pending.ordinal };
    } catch (err) {
        // Thrown paths:
        //   - getWritableOpenCodeDb() (attached DB missing/locked)
        //   - getOpenCodeMessageById() raw SELECT failure
        //   - getCompartmentsByEndMessageId() local SELECT failure
        //   - setPersistedCompactionMarkerState() UPDATE failure
        // All retryable. Note: findBoundaryUserMessage() returning null flows
        // through injectCompactionMarker() returning null (handled above),
        // NOT through this catch.
        const error = err instanceof Error ? err : new Error(String(err));
        sessionLog(
            sessionId,
            `compaction-marker drain: retryable failure for ordinal ${pending.ordinal}:`,
            error,
        );
        return { kind: "retryable-failure", error };
    }
}

/**
 * After historian publishes new compartments, inject or move the compaction marker.
 * Only moves the boundary forward; summary text is a static placeholder.
 *
 * Plan v6: callers in incremental / recomp / partial-recomp paths invoke this
 * directly only when they are NOT deferring (i.e.
 * `preserveInjectionCacheUntilConsumed === false` OR
 * `experimentalCompactionMarkers === false`). Deferred path uses
 * `applyDeferredCompactionMarker` from postprocess drain.
 */
export function updateCompactionMarkerAfterPublication(
    db: Database,
    sessionId: string,
    lastCompartmentEnd: number,
    directory?: string,
): void {
    const existing = getPersistedCompactionMarkerState(db, sessionId);

    if (existing) {
        if (existing.boundaryOrdinal === lastCompartmentEnd) {
            // Same boundary — nothing to do (placeholder text never changes)
            return;
        }

        // Boundary moved forward — remove old marker and inject new one.
        // Clear persisted state only after successful removal to avoid orphaned DB rows.
        try {
            removeCompactionMarker(existing);
            setPersistedCompactionMarkerState(db, sessionId, null);
            sessionLog(
                sessionId,
                `compaction-marker: removed old boundary at ordinal ${existing.boundaryOrdinal}, moving to ${lastCompartmentEnd}`,
            );
        } catch (error) {
            sessionLog(
                sessionId,
                `compaction-marker: failed to remove old boundary at ordinal ${existing.boundaryOrdinal}, proceeding with new injection:`,
                error,
            );
            // State kept so next cleanup/update can retry removal
        }
    }

    const result = injectCompactionMarker({
        sessionId,
        endOrdinal: lastCompartmentEnd,
        summaryText: MARKER_SUMMARY_TEXT,
        directory: directory ?? process.cwd(),
    });

    if (result) {
        setPersistedCompactionMarkerState(db, sessionId, {
            ...result,
            boundaryOrdinal: lastCompartmentEnd,
        });
        sessionLog(
            sessionId,
            `compaction-marker: injected at ordinal ${lastCompartmentEnd}, boundary user msg ${result.boundaryMessageId}`,
        );
    }
}

/**
 * Remove the compaction marker for a session (e.g. on session.deleted).
 */
export function removeCompactionMarkerForSession(db: Database, sessionId: string): void {
    const existing = getPersistedCompactionMarkerState(db, sessionId);
    if (existing) {
        try {
            removeCompactionMarker(existing);
            setPersistedCompactionMarkerState(db, sessionId, null);
            sessionLog(sessionId, "compaction-marker: removed on session cleanup");
        } catch (error) {
            // Clear state anyway on session deletion — orphaned rows in OpenCode's DB
            // are acceptable since the session is being deleted, and retaining stale
            // persisted state for a deleted session causes worse problems.
            setPersistedCompactionMarkerState(db, sessionId, null);
            sessionLog(
                sessionId,
                "compaction-marker: removal failed during session cleanup, cleared persisted state:",
                error,
            );
        }
    }
}

/**
 * Close the writable OpenCode DB connection used for marker injection.
 */
export function closeCompactionMarkerConnection(): void {
    closeCompactionMarkerDb();
}

/**
 * Startup consistency check for compaction markers.
 *
 * Magic Context persists marker state in context.db's `session_meta`, while the
 * actual marker rows (compaction part + summary message + summary part) live in
 * OpenCode's separate `opencode.db`. There is no cross-DB transaction between
 * the two stores, so a crash between writes — or any external cleanup of
 * OpenCode's DB — can leave the two in an inconsistent state:
 *
 * - Phantom state: persisted in context.db but the referenced rows no longer
 *   exist in opencode.db. On next publication, the manager tries to remove a
 *   marker that isn't there, ignores the failure, and re-injects, but the
 *   stale persisted state can also confuse readers that trust it.
 * - Orphaned rows: rows in opencode.db exist without matching context.db
 *   state. Those can't be surfaced from here (we don't track them), but the
 *   natural-healing path already handles them: the next historian publication
 *   moves the boundary forward and the new injection replaces the orphans by
 *   moving filterCompacted past them.
 *
 * This function scans all persisted marker states and, for each one, verifies
 * that the referenced rows still exist in opencode.db. If any referenced row
 * is missing, it treats the marker as inconsistent, attempts to remove
 * whatever rows ARE still present (best-effort cleanup of half-written
 * markers), and clears the persisted state so the next publication can
 * re-inject cleanly.
 *
 * Called once at plugin startup. Safe to call multiple times (idempotent).
 */
export function checkCompactionMarkerConsistency(db: Database): void {
    const opencodeDbPath = join(getDataDir(), "opencode", "opencode.db");
    let opencodeDb: SqliteDb;
    try {
        // Read-only + immutable-less: we only need read access for the existence
        // check. OpenCode may also be running, so avoid exclusive locks.
        opencodeDb = new SqliteDb(opencodeDbPath, { readonly: true });
    } catch (error) {
        // OpenCode DB missing or inaccessible — nothing to reconcile.
        log(
            `[magic-context] compaction-marker consistency check skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
    }

    try {
        const persistedRows = db
            .prepare(
                "SELECT session_id, compaction_marker_state FROM session_meta WHERE compaction_marker_state IS NOT NULL AND compaction_marker_state != ''",
            )
            .all() as Array<{ session_id: string; compaction_marker_state: string }>;

        if (persistedRows.length === 0) return;

        const checkMessage = opencodeDb.prepare("SELECT 1 FROM message WHERE id = ? LIMIT 1");
        const checkPart = opencodeDb.prepare("SELECT 1 FROM part WHERE id = ? LIMIT 1");

        let reconciledCount = 0;

        for (const row of persistedRows) {
            const state = getPersistedCompactionMarkerState(db, row.session_id);
            if (!state) continue;

            // Check all 3 referenced rows
            const boundaryExists = checkMessage.get(state.boundaryMessageId) !== null;
            const summaryMessageExists = checkMessage.get(state.summaryMessageId) !== null;
            const compactionPartExists = checkPart.get(state.compactionPartId) !== null;
            const summaryPartExists = checkPart.get(state.summaryPartId) !== null;

            const allPresent =
                boundaryExists && summaryMessageExists && compactionPartExists && summaryPartExists;

            if (allPresent) continue;

            // Inconsistent — best-effort clean up any surviving half-written rows,
            // then clear persisted state so next publication can re-inject.
            //
            // Only clear persisted state after verified successful cleanup
            // (council Finding #11). If `removeCompactionMarker` fails (DB
            // locked, IO error), keeping persisted state lets a retry on the
            // next startup try again; clearing would leave orphaned rows in
            // OpenCode's DB that filterCompacted still respects. The natural
            // healing path via the next historian publication still exists as
            // a backup when the state IS cleared after a success.
            let removedOk = false;
            try {
                removedOk = removeCompactionMarker(state);
            } catch (error) {
                // Partial failure during half-written cleanup is expected and
                // not worth warning about — we just want to get the DBs back
                // into a consistent state.
                sessionLog(
                    row.session_id,
                    "compaction-marker consistency: partial cleanup of half-written marker failed:",
                    error,
                );
            }

            if (removedOk) {
                setPersistedCompactionMarkerState(db, row.session_id, null);
                sessionLog(
                    row.session_id,
                    `compaction-marker consistency: cleared orphaned state (boundary=${boundaryExists} summary=${summaryMessageExists} cPart=${compactionPartExists} sPart=${summaryPartExists}); next publication will re-inject`,
                );
                reconciledCount++;
            } else {
                sessionLog(
                    row.session_id,
                    `compaction-marker consistency: cleanup failed for orphaned state (boundary=${boundaryExists} summary=${summaryMessageExists} cPart=${compactionPartExists} sPart=${summaryPartExists}); will retry on next startup`,
                );
            }
        }

        if (reconciledCount > 0) {
            log(
                `[magic-context] compaction-marker consistency: reconciled ${reconciledCount} session(s) with orphaned marker state at startup`,
            );
        }
    } catch (error) {
        log(
            `[magic-context] compaction-marker consistency check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
        try {
            closeQuietly(opencodeDb);
        } catch {
            // ignore
        }
    }
}
