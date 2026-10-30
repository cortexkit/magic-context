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

import {
    closeCompactionMarkerDb,
    compareOpenCodeMessagesByCanonicalOrder,
    findBoundaryUserMessage,
    getOpenCodeMessageById,
    isOpenCodeGapHistorianAbsent,
    listSessionCompactionMarkers,
    removeCompactionMarker,
    removeForeignCompactionMarker,
} from "../../features/magic-context/compaction-marker";
import {
    getCompartmentsByEndMessageId,
    getUncoveredCompartmentEndsThrough,
} from "../../features/magic-context/compartment-storage";
import {
    getCompactionMarkerPublicationState,
    getPersistedCompactionMarkerState,
    type PendingCompactionMarker,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { getHarness } from "../../shared/harness";
import { log, sessionLog } from "../../shared/logger";
import {
    claimOpenCodeDbDiagnosticOnce,
    openCodeDbPathExists,
    resolveOpenCodeDbPath,
} from "../../shared/opencode-db-path";
import type { Database } from "../../shared/sqlite";
import { Database as SqliteDb } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { publishRecoverableCompactionMarker } from "./compaction-marker-publication";

/** Static placeholder. The real session-history comes from transform injection. */
export const MARKER_SUMMARY_TEXT =
    "[Compacted by magic-context — session history is managed by the plugin]";

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
    | { kind: "deferred"; reason: "candidate-preparation" }
    | {
          kind: "stale-skip";
          reason: "compartment-removed" | "target-superseded" | "partial-message-boundary";
      }
    | {
          kind: "retryable-failure";
          error: Error;
          /**
           * Omitted means the host marker's commit status is unknown. Only a confirmed
           * unchanged marker keeps the previous last-known-good request (LKG)
           * eligible for replay.
           */
          cut?: "definitely-no-cut" | "uncertain";
      };

export function markerUpdateDefinitelyDidNotCut(outcome: MarkerUpdateOutcome): boolean {
    return (
        outcome.kind === "already-current" ||
        outcome.kind === "deferred" ||
        outcome.kind === "stale-skip" ||
        (outcome.kind === "retryable-failure" && outcome.cut === "definitely-no-cut")
    );
}

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

function boundaryWouldDiscardUncoveredMessage(
    db: Database,
    sessionId: string,
    ordinal: number,
    boundaryMessageId: string,
): boolean {
    const current = getPersistedCompactionMarkerState(db, sessionId);
    const partials = getUncoveredCompartmentEndsThrough(db, sessionId, ordinal);
    // OpenCode keeps the boundary user message and everything after it. A partly
    // summarized message at or after that user stays visible, so it need not
    // prevent this marker move. Unknown message order is not proof of safety.
    for (const partial of partials) {
        // boundaryOrdinal is the summary target, not where OpenCode starts its input.
        // For an assistant target, OpenCode also retains the preceding user and rest
        // of that turn. Ignore an old summary end only if timestamp/ID order proves
        // it is strictly before the old retained user; equal or unknown order stays checked.
        if (
            current &&
            compareOpenCodeMessagesByCanonicalOrder(
                sessionId,
                partial.endMessageId,
                current.boundaryMessageId,
            ) === -1
        )
            continue;
        const ordering = compareOpenCodeMessagesByCanonicalOrder(
            sessionId,
            boundaryMessageId,
            partial.endMessageId,
        );
        if (ordering !== null && ordering <= 0) continue;
        // The next summary can start beyond end+1 because the historian skips
        // synthetic messages. Require both recorded message IDs to exist, and
        // check that every intervening message would be skipped by the historian.
        if (
            partial.successorStartMessageId &&
            partial.successorStartMessage !== null &&
            partial.successorStartMessage > partial.endMessage + 1 &&
            isOpenCodeGapHistorianAbsent(
                sessionId,
                partial.endMessageId,
                partial.successorStartMessageId,
            )
        )
            continue;
        return true;
    }
    return false;
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
export interface TrustedMaterializedCompactionBoundary {
    rowVersion: number;
    ordinal: number;
    endMessageId: string;
}

export function applyDeferredCompactionMarker(
    db: Database,
    sessionId: string,
    pending: PendingCompactionMarker,
    directory?: string,
    trustedBoundary?: TrustedMaterializedCompactionBoundary,
): MarkerUpdateOutcome {
    let cut: "definitely-no-cut" | "uncertain" = "definitely-no-cut";
    // Step timings for the applied-drain log line. The drain reads both stores
    // and writes OpenCode's under its lock; one slow step must be attributable.
    let stepStartedAt = performance.now();
    const stepMs: string[] = [];
    const endStep = (name: string): void => {
        const now = performance.now();
        stepMs.push(`${name}Ms=${(now - stepStartedAt).toFixed(1)}`);
        stepStartedAt = now;
    };
    try {
        // Rust may fence the target with the exact durable boundary returned by the
        // materializing response. Other callers validate against local compartment rows.
        // Validation failures happen before any marker state mutation.
        const responseFencesTarget =
            trustedBoundary !== undefined &&
            Number.isSafeInteger(trustedBoundary.rowVersion) &&
            trustedBoundary.rowVersion > 0 &&
            trustedBoundary.ordinal === pending.ordinal &&
            trustedBoundary.endMessageId === pending.endMessageId;
        const validation = responseFencesTarget
            ? "ok"
            : validatePendingTarget(db, sessionId, pending);
        endStep("validate");
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
            !getCompactionMarkerPublicationState(db, sessionId).pending &&
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
        // Covers the existing-marker coverage check above and this lookup.
        endStep("boundary");
        if (!boundary) {
            return {
                kind: "retryable-failure",
                cut: "definitely-no-cut",
                error: new Error(
                    `no user boundary found at or before endMessageId ${pending.endMessageId} (ordinal ${pending.ordinal}); preserving existing marker`,
                ),
            };
        }

        // Keep the user at or before a partly summarized message so its entire tool
        // turn remains visible. Reject a later user boundary if it would discard parts
        // not covered by a following summary. Rust records the final block of fully
        // summarized messages too; a block index alone does not prove missing coverage.
        if (boundaryWouldDiscardUncoveredMessage(db, sessionId, pending.ordinal, boundary.id)) {
            sessionLog(
                sessionId,
                `compaction-marker drain: stale-skip (partial-message-boundary) for ordinal ${pending.ordinal} endMessageId=${pending.endMessageId}`,
            );
            return { kind: "stale-skip", reason: "partial-message-boundary" };
        }
        endStep("discardCheck");

        // Replace both host-store row sets under one BEGIN IMMEDIATE. A busy
        // store fails before deletion; any later failure rolls the deletion back.
        cut = "uncertain";
        const replacement = publishRecoverableCompactionMarker(
            db,
            {
                sessionId,
                endOrdinal: pending.ordinal,
                endMessageId: pending.endMessageId,
                summaryText: MARKER_SUMMARY_TEXT,
                directory: directory ?? process.cwd(),
                resolvedBoundary: boundary,
            },
            () =>
                JSON.stringify(getPersistedCompactionMarkerState(db, sessionId)) ===
                    JSON.stringify(existing) &&
                (responseFencesTarget || validatePendingTarget(db, sessionId, pending) === "ok"),
        );
        endStep("replace");
        if (replacement.kind === "deferred")
            return { kind: "deferred", reason: "candidate-preparation" };
        if (replacement.kind !== "committed") {
            return {
                kind: "retryable-failure",
                cut: replacement.kind,
                error: replacement.error,
            };
        }
        endStep("persist");
        sessionLog(sessionId, `compaction-marker drain timings: ${stepMs.join(" ")}`);
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
        return { kind: "retryable-failure", error, cut };
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

    if (existing && !getCompactionMarkerPublicationState(db, sessionId).pending) {
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

    if (boundaryWouldDiscardUncoveredMessage(db, sessionId, lastCompartmentEnd, boundary.id)) {
        return false;
    }

    const replacement = publishRecoverableCompactionMarker(
        db,
        {
            sessionId,
            endOrdinal: lastCompartmentEnd,
            endMessageId: targetEndMessageId,
            summaryText: MARKER_SUMMARY_TEXT,
            directory: directory ?? process.cwd(),
            resolvedBoundary: boundary,
        },
        () =>
            JSON.stringify(getPersistedCompactionMarkerState(db, sessionId)) ===
                JSON.stringify(existing) &&
            getCompartmentEndMessageIdForOrdinal(db, sessionId, lastCompartmentEnd) ===
                targetEndMessageId,
    );

    if (replacement.kind === "committed") {
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
 * This function only diagnoses missing rows. A discovered database path does
 * not prove which store the server writes, and startup has no cache-busting
 * permission. Retain state and surviving rows; the deferred publication drain
 * performs replacement on a priced pass instead.
 *
 * Called once at plugin startup. Safe to call multiple times (idempotent).
 */
export function checkCompactionMarkerConsistency(db: Database): void {
    const resolution = resolveOpenCodeDbPath();
    const opencodeDbPath = resolution.path;
    if (!openCodeDbPathExists(resolution)) {
        if (claimOpenCodeDbDiagnosticOnce("compaction-marker-consistency", resolution)) {
            log(
                `[magic-context] compaction-marker consistency check skipped: reason=opencode_db_missing path=${opencodeDbPath} source=${resolution.source}`,
            );
        }
        return;
    }
    let opencodeDb: SqliteDb;
    try {
        // Read-only + immutable-less: we only need read access for the existence
        // check. OpenCode may also be running, so avoid exclusive locks.
        opencodeDb = new SqliteDb(opencodeDbPath, { readonly: true });
    } catch (error) {
        // OpenCode DB missing or inaccessible — nothing to reconcile.
        log(
            `[magic-context] compaction-marker consistency check SKIPPED retaining state path=${opencodeDbPath} source=${resolution.source} mode=readonly wal=aware: ${error instanceof Error ? error.message : String(error)}`,
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

        log(
            `[magic-context] compaction-marker consistency probe path=${opencodeDbPath} source=${resolution.source} mode=readonly wal=aware sessions=${persistedRows.length}; diagnostic-only, no startup bust permission`,
        );
        const checkMessage = opencodeDb.prepare("SELECT 1 FROM message WHERE id = ? LIMIT 1");
        const checkPart = opencodeDb.prepare("SELECT 1 FROM part WHERE id = ? LIMIT 1");

        for (const row of persistedRows) {
            const state = getPersistedCompactionMarkerState(db, row.session_id);
            if (!state) continue;

            // Check all 4 referenced rows. Use `!= null` (not `!== null`):
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

            // Discovery identifies the plugin's read store, not the server's writer.
            // Even an error-free absence is therefore not authority to delete rows.
            // Startup also has no cache-bust permission: retain the marker and let
            // the deferred publication drain replace it on a priced transform.
            sessionLog(
                row.session_id,
                `compaction-marker consistency: SKIPPED destructive reconciliation reason=unproven_writer_and_no_bust_permission path=${opencodeDbPath} source=${resolution.source} mode=readonly wal=aware boundary=${boundaryExists} summary=${summaryMessageExists} cPart=${compactionPartExists} sPart=${summaryPartExists}; retaining state until priced publication`,
            );
        }
    } catch (error) {
        log(
            `[magic-context] compaction-marker consistency check SKIPPED retaining state path=${opencodeDbPath} source=${resolution.source} mode=readonly wal=aware: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
        try {
            closeQuietly(opencodeDb);
        } catch {
            // ignore
        }
    }
}
