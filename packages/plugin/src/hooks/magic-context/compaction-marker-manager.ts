/**
 * Compaction Marker Manager
 *
 * Coordinates compaction marker injection/update/removal with historian
 * publication. Called after compartments are published. Always-on since
 * v0.21.4 — the `compaction_markers` config knob was removed because the
 * feature is required for sane transform performance on long sessions.
 *
 * The marker summary text is a static placeholder — the real <session-history>
 * is injected by the transform pipeline via inject-compartments.ts. The marker
 * exists solely to make OpenCode's filterCompacted stop at the boundary so the
 * transform receives only the live tail.
 */

import { join } from "node:path";
import {
    closeCompactionMarkerDb,
    compareOpenCodeMessagesByCanonicalOrder,
    findBoundaryUserMessage,
    getOpenCodeMessageById,
    injectCompactionMarker,
    listSessionCompactionMarkers,
    removeCompactionMarker,
    removeForeignCompactionMarker,
} from "../../features/magic-context/compaction-marker";
import { getCompartmentsByEndMessageId } from "../../features/magic-context/compartment-storage";
import {
    getPersistedCompactionMarkerState,
    type PendingCompactionMarker,
    type PersistedCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import {
    getTagNumberByMessageId,
    updateTagStatus,
} from "../../features/magic-context/storage-tags";
import { getDataDir } from "../../shared/data-path";
import { getHarness } from "../../shared/harness";
import { log, sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { Database as SqliteDb } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";

/** Static placeholder. The real session-history comes from transform injection. */
export const MARKER_SUMMARY_TEXT =
    "[Compacted by magic-context — session history is managed by the plugin]";

function dropMarkerSummaryTag(db: Database, sessionId: string, summaryMessageId: string): void {
    const tagNumber = getTagNumberByMessageId(db, sessionId, `${summaryMessageId}:p0`);
    if (tagNumber !== null) updateTagStatus(db, sessionId, tagNumber, "dropped");
}

function persistMarkerStateAndDropReplacedTag(
    db: Database,
    sessionId: string,
    state: PersistedCompactionMarkerState | null,
    replacedSummaryMessageId: string | null,
): void {
    const transactionStartedAt = performance.now();
    db.transaction(() => {
        setPersistedCompactionMarkerState(db, sessionId, state);
        if (replacedSummaryMessageId !== null) {
            dropMarkerSummaryTag(db, sessionId, replacedSummaryMessageId);
        }
    })();
    logSlowWriteTransaction("marker-drain", transactionStartedAt);
}

/**
 * Result of draining one persisted marker request.
 *
 * Applied, already-current, and stale requests can clear their pending blob.
 * Retryable failures keep both the blob and deferred-history signal so the
 * next consuming pass can repeat the deterministic mutation.
 */
export type MarkerUpdateOutcome =
    | {
          kind: "applied";
          markerOrdinal: number;
      }
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

function getCompartmentEndMessageIdForOrdinal(
    db: Database,
    sessionId: string,
    endOrdinal: number,
): string | null {
    const row = db
        .prepare(
            `SELECT end_message_id
             FROM compartments
             WHERE session_id = ? AND end_message = ?
             ORDER BY sequence DESC
             LIMIT 1`,
        )
        .get(sessionId, endOrdinal) as { end_message_id?: unknown } | undefined;
    return typeof row?.end_message_id === "string" && row.end_message_id.length > 0
        ? row.end_message_id
        : null;
}

function existingMarkerAlreadyCoversTarget(
    sessionId: string,
    existing: NonNullable<ReturnType<typeof getPersistedCompactionMarkerState>>,
    targetOrdinal: number,
    targetEndMessageId: string,
): boolean {
    if (existing.boundaryOrdinal < targetOrdinal) {
        return false;
    }

    if (existing.boundaryOrdinal === targetOrdinal) {
        const boundaryCompare = compareOpenCodeMessagesByCanonicalOrder(
            sessionId,
            existing.boundaryMessageId,
            targetEndMessageId,
        );
        if (boundaryCompare === null || boundaryCompare > 0) {
            return false;
        }
        if (
            existing.targetEndMessageId !== null &&
            existing.targetEndMessageId !== targetEndMessageId
        ) {
            return false;
        }
        return true;
    }

    // A strictly higher ordinal normally means a newer direct/recomp publish has
    // already advanced the marker. If the new target id column proves the stored
    // target is not actually after this pending/direct target, the state is
    // inconsistent and should be repaired rather than preserved.
    if (existing.targetEndMessageId !== null) {
        const targetCompare = compareOpenCodeMessagesByCanonicalOrder(
            sessionId,
            existing.targetEndMessageId,
            targetEndMessageId,
        );
        if (targetCompare !== null && targetCompare <= 0) {
            return false;
        }
    }

    return true;
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
 * Retrying the full sequence is safe. Removal is a no-op when rows are already
 * absent, and injection uses deterministic IDs with exact-row upserts, so a
 * committed marker whose context-state write failed is reused rather than duplicated.
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
        if (
            existing &&
            existingMarkerAlreadyCoversTarget(
                sessionId,
                existing,
                pending.ordinal,
                pending.endMessageId,
            )
        ) {
            // Marker already at this boundary (or further). Nothing to do.
            return { kind: "already-current" };
        }

        // Resolve the replacement boundary BEFORE removing the existing marker.
        // If the target no longer maps to a user boundary (e.g. raw rows changed
        // under us), leave the old marker intact so OpenCode keeps its current
        // cache boundary instead of seeing a needless no-marker/full-history pass.
        const boundary = findBoundaryUserMessage(sessionId, pending.endMessageId);
        if (!boundary) {
            return {
                kind: "retryable-failure",
                error: new Error(
                    `no user boundary found at or before endMessageId ${pending.endMessageId} (ordinal ${pending.ordinal}); preserving existing marker`,
                ),
            };
        }

        // Remove old marker if present. `removeCompactionMarker` returns false
        // only when the DELETE transaction itself failed (e.g. SQLITE_BUSY).
        // Keep the summary id so its tag drops atomically when marker state advances.
        const removedSummaryMessageId = existing?.summaryMessageId ?? null;
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

        // Inject new marker. The boundary was pre-resolved above, so a null
        // return here means the INSERT transaction failed and rolled back
        // cleanly (no half-write); retrying is safe.
        const result = injectCompactionMarker({
            sessionId,
            endOrdinal: pending.ordinal,
            endMessageId: pending.endMessageId,
            summaryText: MARKER_SUMMARY_TEXT,
            directory: directory ?? process.cwd(),
            resolvedBoundary: boundary,
        });
        if (!result) {
            return {
                kind: "retryable-failure",
                error: new Error(
                    `injectCompactionMarker returned null for ordinal ${pending.ordinal}; will retry`,
                ),
            };
        }

        persistMarkerStateAndDropReplacedTag(
            db,
            sessionId,
            {
                ...result,
                boundaryOrdinal: pending.ordinal,
                targetEndMessageId: pending.endMessageId,
            },
            removedSummaryMessageId,
        );
        sessionLog(
            sessionId,
            `compaction-marker drain: applied at ordinal ${pending.ordinal}, boundary user msg ${result.boundaryMessageId}`,
        );
        return {
            kind: "applied",
            markerOrdinal: pending.ordinal,
        };
    } catch (err) {
        // Thrown paths:
        //   - getWritableOpenCodeDb() (attached DB missing/locked)
        //   - getOpenCodeMessageById() raw SELECT failure
        //   - getCompartmentsByEndMessageId() local SELECT failure
        //   - setPersistedCompactionMarkerState() UPDATE failure
        // All retryable. Note: findBoundaryUserMessage() returning null is
        // handled before any old-marker removal and does NOT flow through this
        // catch unless the OpenCode DB query itself throws.
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
 * `preserveInjectionCacheUntilConsumed === false`). Deferred path uses
 * `applyDeferredCompactionMarker` from postprocess drain.
 */
export function updateCompactionMarkerAfterPublication(
    db: Database,
    sessionId: string,
    lastCompartmentEnd: number,
    directory?: string,
): boolean {
    // OpenCode-only: this writes marker rows into opencode.db. Pi reaches this
    // function through the recompilation runners both harnesses share, but Pi
    // writes its native marker via a separate path (see pi-recomp-marker.ts),
    // and on a Pi-only install the opencode.db parent directory may not exist
    // at all — SQLite then throws `unable to open database file`, which turned
    // a fully successful recompilation into a scary "Failed" report. There is
    // nothing to update on Pi, so report success.
    if (getHarness() !== "opencode") {
        return true;
    }
    const targetEndMessageId = getCompartmentEndMessageIdForOrdinal(
        db,
        sessionId,
        lastCompartmentEnd,
    );
    if (!targetEndMessageId) {
        sessionLog(
            sessionId,
            `compaction-marker: no compartment endMessageId for ordinal ${lastCompartmentEnd}; preserving existing marker`,
        );
        return false;
    }

    const existing = getPersistedCompactionMarkerState(db, sessionId);
    const removedSummaryMessageId = existing?.summaryMessageId ?? null;

    if (existing) {
        if (
            existingMarkerAlreadyCoversTarget(
                sessionId,
                existing,
                lastCompartmentEnd,
                targetEndMessageId,
            )
        ) {
            // Same/newer boundary — nothing to do (placeholder text never changes).
            // Already current = success.
            return true;
        }
    }

    // Resolve the new boundary before mutating the existing marker. If the
    // target is stale or no user exists at/before it, leave the old marker in
    // place to avoid needless cache churn and history-boundary loss.
    const boundary = findBoundaryUserMessage(sessionId, targetEndMessageId);
    if (!boundary) {
        sessionLog(
            sessionId,
            `compaction-marker: no user boundary found at or before endMessageId ${targetEndMessageId} (ordinal ${lastCompartmentEnd}); preserving existing marker`,
        );
        return false;
    }

    if (existing) {
        // Boundary moved forward — remove old marker and inject new one.
        // removeCompactionMarker returns false on failure (it does NOT throw),
        // so honor the boolean: only clear persisted state after a SUCCESSFUL
        // removal. Clearing it on a failed removal would orphan the old marker
        // rows AND, if the injection below also fails, lose the durable retry
        // path entirely. On removal failure we abort WITHOUT clearing — the
        // caller (and the next pass) can retry against the still-persisted state.
        const removed = removeCompactionMarker(existing);
        if (!removed) {
            sessionLog(
                sessionId,
                `compaction-marker: failed to remove old boundary at ordinal ${existing.boundaryOrdinal}; preserving persisted state for retry (not injecting new marker this pass)`,
            );
            return false;
        }
        persistMarkerStateAndDropReplacedTag(db, sessionId, null, removedSummaryMessageId);
        sessionLog(
            sessionId,
            `compaction-marker: removed old boundary at ordinal ${existing.boundaryOrdinal}, moving to ${lastCompartmentEnd}`,
        );
    }

    const result = injectCompactionMarker({
        sessionId,
        endOrdinal: lastCompartmentEnd,
        endMessageId: targetEndMessageId,
        summaryText: MARKER_SUMMARY_TEXT,
        directory: directory ?? process.cwd(),
        resolvedBoundary: boundary,
    });

    if (result) {
        persistMarkerStateAndDropReplacedTag(
            db,
            sessionId,
            {
                ...result,
                boundaryOrdinal: lastCompartmentEnd,
                targetEndMessageId,
            },
            removedSummaryMessageId,
        );
        sessionLog(
            sessionId,
            `compaction-marker: injected at ordinal ${lastCompartmentEnd}, boundary user msg ${result.boundaryMessageId}`,
        );
        return true;
    }
    // Injection failed after boundary preflight (e.g. OpenCode DB write error).
    // Report failure so callers preserve any pending retry state.
    return false;
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
 * Result of a fork-orphan marker hygiene pass (#263).
 *
 * `removed` counts foreign markers deleted this pass. `failed` signals that at
 * least one deletion was attempted but could not complete (e.g. SQLITE_BUSY);
 * the caller treats that as "retry on the next degraded pass" and never as a
 * fatal error.
 */
export interface OrphanMarkerReconcileResult {
    removed: number;
    failed: boolean;
}

/**
 * Fork-orphan compaction-marker hygiene (#263).
 *
 * OpenCode's `/fork` copies the parent session's message rows into the fork —
 * including the parent's magic-context compaction-marker rows — but does NOT
 * inherit magic-context's durable state (PARITY.md gap #25: OpenCode re-mints
 * message ids on fork, so entry-id-keyed migration is unsafe). The fork then
 * injects its own fresh marker at its own (much older) historian boundary, and
 * `filterCompacted` — which walks newest→oldest and stops at the FIRST marker
 * it sees (opencode message-v2.ts `filterCompacted`) — honours the NEWER
 * orphan instead of ours. The visible window is cut at the orphan, our boundary
 * message falls below the cut, and inject-compartments degrades with no
 * recovery path while context usage climbs.
 *
 * A marker row in opencode.db for this session that the durable state does not
 * recognize as its own current marker is a fork-orphan. This pass scans for
 * them and removes the ones that actively outrank ours:
 *
 *   - not owned: `part.id != persisted.compactionPartId`
 *   - magic-context-shaped: carries one of OUR summary messages
 *     (providerID="magic-context") — OpenCode-native /compact markers carry the
 *     real provider id and are never touched
 *   - newer than ours: its boundary message sorts AFTER ours in canonical
 *     order, which is exactly the case where `filterCompacted` stops at the
 *     orphan first. Older foreign markers are harmless (ours already wins) and
 *     are left alone to keep the repair minimally invasive.
 *
 * Removal is idempotent (plain DELETEs) so concurrent processes racing on the
 * same orphan converge on the same end state; the only guarded invariant is
 * never deleting our own marker, re-checked against freshly-read persisted
 * state below.
 *
 * Cost gate: callers invoke this only when degraded mode fires (never on every
 * pass), so steady state pays nothing. Any failure is swallowed and reported
 * via the result so the next degraded pass retries.
 */
export function reconcileForkOrphanedCompactionMarkers(
    db: Database,
    sessionId: string,
): OrphanMarkerReconcileResult {
    // Markers live in opencode.db; Pi writes its native marker via a separate
    // path and has no rows here to reconcile.
    if (getHarness() !== "opencode") {
        return { removed: 0, failed: false };
    }

    try {
        // Our own marker must exist in durable state; without it we have no
        // ownership anchor to diff against (and nothing to defend).
        const owned = getPersistedCompactionMarkerState(db, sessionId);
        if (!owned) {
            return { removed: 0, failed: false };
        }

        const markers = listSessionCompactionMarkers(sessionId);
        let removed = 0;
        let failed = false;

        for (const marker of markers) {
            if (marker.compactionPartId === owned.compactionPartId) {
                continue; // our own marker
            }
            // A marker without our summary lineage is either an OpenCode-native
            // /compact or a half-written row. filterCompacted only stops at a
            // user message that has BOTH a compaction part and a completed
            // summary, so a part-only row cannot outrank us; and we must never
            // delete a native compaction. Skip it.
            if (marker.summaryMessageIds.length === 0) {
                continue;
            }
            // Only repair orphans that actively outrank ours. If ordering cannot
            // be established (a referenced message vanished mid-pass), be
            // conservative and leave the row for the next pass.
            const ordering = compareOpenCodeMessagesByCanonicalOrder(
                sessionId,
                marker.boundaryMessageId,
                owned.boundaryMessageId,
            );
            if (ordering === null || ordering <= 0) {
                continue;
            }

            // Re-read persisted state right before mutating: if our marker
            // advanced between the scan and now, make sure we still don't touch
            // anything the current state owns.
            const currentOwned = getPersistedCompactionMarkerState(db, sessionId);
            if (!currentOwned || marker.compactionPartId === currentOwned.compactionPartId) {
                continue;
            }

            const ok = removeForeignCompactionMarker(
                sessionId,
                marker,
                currentOwned.summaryMessageId,
            );
            if (ok) {
                removed += 1;
                sessionLog(
                    sessionId,
                    `compaction-marker hygiene: removed fork-orphaned marker part=${marker.compactionPartId} boundary=${marker.boundaryMessageId} (outranked owned boundary ${currentOwned.boundaryMessageId})`,
                );
            } else {
                failed = true;
            }
        }

        if (removed > 0) {
            log(
                `[magic-context][${sessionId}] compaction-marker hygiene: removed ${removed} fork-orphaned marker(s); filterCompacted will now stop at this session's own marker`,
            );
        }
        return { removed, failed };
    } catch (error) {
        // opencode.db missing/locked, schema drift, etc. Never fatal: degraded
        // mode simply persists until the next retry, and layer-B re-anchor keeps
        // injection alive in the meantime.
        sessionLog(
            sessionId,
            "compaction-marker hygiene: scan failed (will retry on next degraded pass):",
            error,
        );
        return { removed: 0, failed: true };
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

            // Check all 3 referenced rows. Use `!= null` (not `!== null`):
            // bun:sqlite's .get() returns `undefined` for a missing row, so a
            // strict `!== null` is always true and a deleted OpenCode row would
            // be treated as present — leaving stale marker state never reconciled.
            const boundaryExists = checkMessage.get(state.boundaryMessageId) != null;
            const summaryMessageExists = checkMessage.get(state.summaryMessageId) != null;
            const compactionPartExists = checkPart.get(state.compactionPartId) != null;
            const summaryPartExists = checkPart.get(state.summaryPartId) != null;

            const allPresent =
                boundaryExists && summaryMessageExists && compactionPartExists && summaryPartExists;

            if (allPresent) continue;

            // Inconsistent — best-effort clean up any surviving half-written rows,
            // then clear persisted state so next publication can re-inject.
            //
            // Only clear persisted state after verified successful cleanup.
            // If `removeCompactionMarker` fails (DB locked, IO error), keeping
            // persisted state lets a retry on the
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
