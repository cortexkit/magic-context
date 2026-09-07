/**
 * Compaction-off mode transitions (issue #266, slice S3).
 *
 * The mode is boot-resolved and process-stable, so a transition is only ever
 * observed on a session's first transform pass after a restart that changed
 * the resolved value. Each session reconciles its durable per-session mode
 * record (`session_meta.compaction_mode_record`: NULL = no record, settled
 * "on"/"off", or durable pending-delivery/cleanup variants) against the
 * resolved mode:
 *
 *   - NULL resolves to "on" (every pre-feature session ran with compaction
 *     enabled), so `no record + configured-off` IS the off-transition — the
 *     upgrade path that guarantees marker cleanup reaches legacy sessions.
 *   - `no record + on` → write "on", no transition work.
 *   - `no record | on  → off` → exactly ONE off-transition per session:
 *       delete MC-owned compaction-marker lineages (canonical + supported
 *       legacy), clear the marker bookkeeping that references those rows,
 *       clear the emergency-recovery latch, clear any persisted Channel-2
 *       pending/claimed intent, clear pre-existing pending_ops, invalidate
 *       the cached m[0]/m[1] baseline (so the off-mode render never replays
 *       an on-mode `<session-history>`), then write "off".
 *   - `off → on` → exactly ONE on-transition: invalidate the cached
 *       m[0]/m[1] baseline (so the dormant compartments' session-history
 *       re-renders before raw-tail trimming resumes), write the historian
 *       catch-up signal (compartmentInProgress, conditioned on the historian
 *       being runnable) and offer the `/ctx-wrapup` suggestion out of band.
 *
 * Crash safety: every cleanup operation is idempotent. A transition that
 * emits a notice stages a durable `*_notice_pending` record before returning
 * to the caller for delivery; a restart therefore retries that notice rather
 * than inferring it from already-cleared state. Duplicate delivery after a
 * crash remains the accepted at-least-once cost.
 *
 * Notices are delivered OUT OF BAND by the caller (the boot-warning /
 * command-output surface) — never into the message array, never through the
 * nudge machinery. A transition pass's message-array output is
 * indistinguishable from a steady-state pass of the resolved mode.
 */

import { existsSync } from "node:fs";
import {
    getOpenCodeDbPath,
    type McOwnedMarkerCleanupResult,
    removeMcOwnedCompactionMarkers,
} from "../../features/magic-context/compaction-marker";
import {
    clearPendingOps,
    getPendingOps,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    type CompactionModeRecord,
    clearEmergencyRecovery,
    clearPendingCompactionMarkerStateIf,
    getChannel2NudgeState,
    getCompactionModeRecord,
    getOverflowState,
    getPendingCompactionMarkerState,
    getPersistedCompactionMarkerState,
    resolveCompactionModeRecord,
    setChannel2NudgeState,
    setCompactionModeRecord,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { sessionLog } from "../../shared/logger";
import { MARKER_SUMMARY_TEXT } from "./compaction-marker-manager";

let loggedUnverifiedMarkerCleanupRetry = false;

/**
 * Flip-off unfold notice. Delivered out of band on the transition pass that
 * actually cleared something. The one-cycle warning wording is contractual
 * (spec #266): removing MC's markers exposes the history hidden solely by
 * MC, and on a long session that expansion can exceed the model window once
 * before native compaction reacts. Docs quote this same constant.
 */
export const COMPACTION_OFF_FLIP_NOTICE = [
    "## Magic Context — compaction-off mode is now active",
    "",
    "Magic Context no longer manages this session's context window; native compaction (or nothing) owns it. Memory, dreamer, notes and ctx_search stay live.",
    "",
    "Magic Context's compaction markers for this session were removed, so history previously hidden by them becomes visible again — the first turn after disabling may trigger one native compaction cycle on long sessions.",
].join("\n");

/**
 * Flip-off notice for DCP coexistence where markers are preserved.
 */
export const COMPACTION_OFF_DCP_COEXIST_NOTICE = [
    "## Magic Context — DCP coexistence active",
    "",
    "Magic Context's compaction markers for this session are preserved as the context baseline. DCP now manages further context pruning on top of that baseline; no previously-hidden history becomes visible.",
].join("\n");

/**
 * Flip-back suggestion, emitted out of band exactly once per off→on
 * transition and only when the historian is runnable (never advertising an
 * unavailable command). The gap accumulated while off is digested by the
 * normal chunked historian paths; /ctx-wrapup makes it explicit.
 */
export const COMPACTION_ON_WRAPUP_SUGGESTION = [
    "## Magic Context — compaction re-enabled",
    "",
    "Context-window management resumed for this session. History that grew while compaction was off will be picked up by the historian automatically; run `/ctx-wrapup` to digest the backlog now in bounded chunks.",
].join("\n");

export interface CompactionModeTransitionResult {
    /**
     * The settled record value the caller commits AFTER emitting `notice`.
     * `*_notice_pending` is staged durably by this reconciler before it returns;
     * null means either the stored mode already matches or a durable cleanup
     * retry remains pending.
     */
    recordToWrite: CompactionModeRecord | null;
    /** Out-of-band notice text; null when the transition emits nothing. */
    notice: string | null;
    /**
     * True when the cached m[0]/m[1] baseline was invalidated. The caller
     * must drop the pass-local session-meta cached bytes too, so this pass's
     * injection re-materializes instead of replaying the pre-flip baseline.
     */
    invalidatedM0Baseline: boolean;
    /** True when the historian catch-up signal (compartmentInProgress) was written. */
    historianCatchUpSignaled: boolean;
    /** True when a stale compartmentInProgress flag was cleared (off mode). */
    clearedCompartmentInProgress: boolean;
    /** True when the off-transition cleared at least one durable MC state item. */
    clearedSomething: boolean;
    /** Marker-row cleanup detail (off-transition only; zeros otherwise). */
    markerCleanup: McOwnedMarkerCleanupResult;
}

const NO_TRANSITION: CompactionModeTransitionResult = {
    recordToWrite: null,
    notice: null,
    invalidatedM0Baseline: false,
    historianCatchUpSignaled: false,
    clearedCompartmentInProgress: false,
    clearedSomething: false,
    markerCleanup: {
        verified: true,
        removedLineages: 0,
        removedRows: 0,
        retainedLineages: 0,
    },
};

/**
 * Null the persisted m[0]/m[1] baseline bytes so the next injection pass
 * re-materializes from the mode's own render rules. The marker columns are
 * left alone: `mustMaterialize` answers `first_render` as soon as the bytes
 * are NULL, before reading any marker, and the fresh materialize overwrites
 * every marker atomically with the bytes it rendered.
 */
function clearCachedM0Baseline(
    db: import("../../shared/sqlite").Database,
    sessionId: string,
): boolean {
    const result = db
        .prepare(
            "UPDATE session_meta SET cached_m0_bytes = NULL, cached_m1_bytes = NULL, cached_m0_mural_data_url = NULL WHERE session_id = ?",
        )
        .run(sessionId);
    return (result.changes ?? 0) > 0;
}

function cleanupOffMarkers(sessionId: string): McOwnedMarkerCleanupResult {
    if (!existsSync(getOpenCodeDbPath())) {
        return { verified: true, removedLineages: 0, removedRows: 0, retainedLineages: 0 };
    }
    return removeMcOwnedCompactionMarkers(sessionId, MARKER_SUMMARY_TEXT);
}

export function reconcileCompactionMode(args: {
    db: import("../../shared/sqlite").Database;
    sessionId: string;
    /** Boot-resolved mode for this process. */
    compactionOff: boolean;
    /** False when historian.disable=true; conditions the on-transition signal. */
    historianRunnable: boolean;
    /** Pass-local session meta (drives the stale compartmentInProgress clear). */
    compartmentInProgress: boolean;
    /** Preserve MC compaction markers when off-transition is due to DCP coexistence. */
    preserveMarkersForDcp: boolean;
}): CompactionModeTransitionResult {
    const { db, sessionId } = args;
    const stored = getCompactionModeRecord(db, sessionId);

    // A pending notice wins over a newly resolved configuration: this process
    // may be the first one after a crash, so it must finish the prior
    // transition's at-least-once delivery before reconciling another flip.
    if (stored === "on_notice_pending") {
        return {
            ...NO_TRANSITION,
            recordToWrite: "on",
            notice: COMPACTION_ON_WRAPUP_SUGGESTION,
        };
    }
    const completingOffNotice = stored === "off_notice_pending";

    if (!args.compactionOff && !completingOffNotice) {
        if (stored === null || resolveCompactionModeRecord(stored) === "on") {
            return stored === null ? { ...NO_TRANSITION, recordToWrite: "on" } : NO_TRANSITION;
        }

        // The only remaining resolved state is off (settled or an unfinished
        // marker-cleanup retry), so restart normal compaction work first.
        // Invalidate the cached baseline FIRST: the off-mode baseline carries
        // no <session-history>, and raw-tail trimming resumes on flip-back.
        // Rebuild the baseline before the first compaction pass so trimming
        // uses the same history range that the renderer will display; otherwise
        // the dormant range could be trimmed without being rendered.
        const invalidatedM0Baseline = clearCachedM0Baseline(db, sessionId);
        let historianCatchUpSignaled = false;
        if (args.historianRunnable) {
            // Historian catch-up signal: prime the compartment phase to start
            // a catch-up run on the backlog immediately (the same flag the
            // trigger sets on fire). The trigger skips this pass because the
            // flag is already set, so exactly one start path runs.
            updateSessionMeta(db, sessionId, { compartmentInProgress: true });
            historianCatchUpSignaled = true;
        }
        if (!historianCatchUpSignaled) {
            return {
                ...NO_TRANSITION,
                recordToWrite: "on",
                invalidatedM0Baseline,
            };
        }

        // Persist delivery intent before returning to the caller. The caller
        // may crash or lose its transport after this point; the next process
        // observes this record and retries the exact wrapup suggestion.
        setCompactionModeRecord(db, sessionId, "on_notice_pending");
        return {
            ...NO_TRANSITION,
            recordToWrite: "on",
            notice: COMPACTION_ON_WRAPUP_SUGGESTION,
            invalidatedM0Baseline,
            historianCatchUpSignaled,
        };
    }

    if (stored === "off") return NO_TRANSITION;

    if (stored === "off_cleanup_pending") {
        // This separate durable state means a successful notice delivery never
        // suppresses a retry after marker verification failed. It resolves as
        // off for all normal gates while retrying only the unverified cleanup.
        if (args.preserveMarkersForDcp) {
            return NO_TRANSITION;
        }
        const markerCleanup = cleanupOffMarkers(sessionId);
        return {
            ...NO_TRANSITION,
            recordToWrite: markerCleanup.verified ? "off" : null,
            markerCleanup,
        };
    }

    // stored === null | "on" | "off_notice_pending" → start or resume the
    // off-transition. Stage notice intent before touching either database so a
    // crash after the first durable clear cannot lose the one-time notice.
    if (!completingOffNotice) {
        setCompactionModeRecord(db, sessionId, "off_notice_pending");
    }
    let clearedSomething = false;

    // 1. Delete MC-owned marker lineages from opencode.db (canonical +
    //    supported legacy). No opencode.db means no markers — not an error.
    const markerCleanup = args.preserveMarkersForDcp
        ? { verified: true, removedLineages: 0, removedRows: 0, retainedLineages: 0 }
        : cleanupOffMarkers(sessionId);
    if (!args.preserveMarkersForDcp && markerCleanup.removedRows > 0) clearedSomething = true;

    // 2. Clear the context.db marker bookkeeping that references the deleted
    //    rows. Leaving it would dangle: the reconciler would replay a summary
    //    whose opencode.db rows are gone, and a flip-back drain would re-inject
    //    a marker at a boundary whose lineage was just removed.
    if (!args.preserveMarkersForDcp) {
        if (getPersistedCompactionMarkerState(db, sessionId) !== null) {
            setPersistedCompactionMarkerState(db, sessionId, null);
            clearedSomething = true;
        }
        const pendingMarker = getPendingCompactionMarkerState(db, sessionId);
        if (pendingMarker !== null) {
            clearPendingCompactionMarkerStateIf(db, sessionId, pendingMarker);
            clearedSomething = true;
        }
    }

    // 3. Clear the emergency-recovery latch: a persisted
    //    needs_emergency_recovery surviving a flip-off is cleared, never
    //    honored (the whole overflow/emergency machinery is gated off).
    if (getOverflowState(db, sessionId).needsEmergencyRecovery) {
        clearEmergencyRecovery(db, sessionId);
        clearedSomething = true;
    }

    // 4. Clear persisted Channel-2 pending/claimed intent. The terminal
    //    "delivered" cap stays — the single ceiling nudge remains consumed.
    const channel2State = getChannel2NudgeState(db, sessionId);
    if (channel2State === "pending" || channel2State === "claimed") {
        setChannel2NudgeState(db, sessionId, "");
        clearedSomething = true;
    }

    // 5. Clear pre-existing pending_ops so queued drop intents cannot survive
    //    dormant and apply on flip-back.
    if (getPendingOps(db, sessionId).length > 0) {
        clearPendingOps(db, sessionId);
        clearedSomething = true;
    }

    // 6. Invalidate the cached m[0]/m[1] baseline: the on-mode bytes carry a
    //    <session-history> render, which the off mode must never replay even
    //    though historical compartment rows exist. Not counted toward the
    //    notice gate — the spec's "cleared something" list is the MC-state
    //    items above.
    const invalidatedM0Baseline = args.preserveMarkersForDcp
        ? false
        : clearCachedM0Baseline(db, sessionId);

    // 7. A stale compartmentInProgress flag (a historian run that crashed
    //    before the flip) can never be consumed in off mode; clear it so the
    //    session state is honest and flip-back starts clean.
    let clearedCompartmentInProgress = false;
    if (args.compartmentInProgress) {
        updateSessionMeta(db, sessionId, { compartmentInProgress: false });
        clearedCompartmentInProgress = true;
    }

    sessionLog(
        sessionId,
        `compaction-off transition: marker cleanup verified=${markerCleanup.verified}, removed=${markerCleanup.removedLineages} lineage(s)/${markerCleanup.removedRows} row(s), retained=${markerCleanup.retainedLineages}, clearedSomething=${clearedSomething}`,
    );
    if (!markerCleanup.verified && !loggedUnverifiedMarkerCleanupRetry) {
        loggedUnverifiedMarkerCleanupRetry = true;
        sessionLog(
            sessionId,
            "compaction-off transition could not verify complete marker cleanup; durable cleanup retry will run on the next pass",
        );
    }

    let notice: string | null = null;
    if (args.preserveMarkersForDcp) {
        notice = COMPACTION_OFF_DCP_COEXIST_NOTICE;
    } else {
        notice = clearedSomething || completingOffNotice ? COMPACTION_OFF_FLIP_NOTICE : null;
        if (!notice && !markerCleanup.verified) {
            // No notice is warranted, but verification must still be retried even
            // though the mode record is now present and resolves to off.
            setCompactionModeRecord(db, sessionId, "off_cleanup_pending");
        }
    }

    return {
        recordToWrite: args.preserveMarkersForDcp
            ? "off"
            : notice
                ? markerCleanup.verified
                    ? "off"
                    : "off_cleanup_pending"
                : markerCleanup.verified
                    ? "off"
                    : null,
        notice,
        invalidatedM0Baseline,
        historianCatchUpSignaled: false,
        clearedCompartmentInProgress,
        clearedSomething,
        markerCleanup,
    };
}

/**
 * Commit the mode record AFTER transition work + notice emission. Kept
 * separate so the caller controls the at-least-once notice ordering.
 */
export function commitCompactionModeRecord(
    db: import("../../shared/sqlite").Database,
    sessionId: string,
    record: CompactionModeRecord,
): void {
    setCompactionModeRecord(db, sessionId, record);
}
