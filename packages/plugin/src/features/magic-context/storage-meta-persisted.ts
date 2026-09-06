import {
    type ContextLimitProvenance,
    normalizeContextLimitProvenance,
} from "../../shared/context-limit-provenance";
import { escalationBands } from "../../shared/escalation-bands";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { stableStringify } from "../../shared/stable-json";
import {
    decodeMergedReasoningParts,
    readFrozenMergedReasoningParts,
} from "./merged-reasoning-decisions";
import { ensureSessionMetaRow } from "./storage-meta-shared";
import type { ContextUsage } from "./types";

const emergencyRecoveryArmedSessions = new Set<string>();
const emergencyRecoveryArmedAtBySession = new Map<string, number>();
const providerOverflowReconfirmedSessions = new Set<string>();
const providerOverflowKnownLimitSessions = new Set<string>();

export function isEmergencyRecoveryArmed(sessionId: string): boolean {
    return emergencyRecoveryArmedSessions.has(sessionId);
}

export function isProviderOverflowReconfirmed(sessionId: string): boolean {
    return providerOverflowReconfirmedSessions.has(sessionId);
}

export function isProviderOverflowFailClosedProven(sessionId: string): boolean {
    return (
        providerOverflowKnownLimitSessions.has(sessionId) ||
        providerOverflowReconfirmedSessions.has(sessionId)
    );
}

export function getEmergencyRecoveryArmedAt(sessionId: string): number | null {
    return emergencyRecoveryArmedAtBySession.get(sessionId) ?? null;
}

export function resetEmergencyRecoveryRegistryForTest(): void {
    emergencyRecoveryArmedSessions.clear();
    emergencyRecoveryArmedAtBySession.clear();
    providerOverflowReconfirmedSessions.clear();
    providerOverflowKnownLimitSessions.clear();
}

interface PersistedUsageRow {
    last_context_percentage: number;
    last_input_tokens: number;
    last_response_time: number;
    last_observed_model_key: string | null;
    last_usage_context_limit: number | null;
}

interface PersistedReasoningWatermarkRow {
    cleared_reasoning_through_tag: number;
}

interface PersistedNoteNudgeRow {
    note_nudge_trigger_pending: number;
    note_nudge_trigger_message_id: string;
    note_nudge_sticky_text: string;
    note_nudge_sticky_message_id: string;
}

interface PersistedTodoSyntheticAnchorRow {
    todo_synthetic_call_id: string;
    todo_synthetic_anchor_message_id: string;
    todo_synthetic_state_json: string;
}

interface PersistedTodoPermissionRow {
    todo_permission_denied: number;
}

interface PersistedHistorianFailureRow {
    historian_failure_count: number;
    historian_last_error: string | null;
    historian_last_failure_at: number | null;
}

export interface PersistedNoteNudge {
    triggerPending: boolean;
    triggerMessageId: string | null;
    stickyText: string | null;
    stickyMessageId: string | null;
}

export interface NoteNudgeAnchor {
    messageId: string;
    text: string;
}

export type AutoSearchHintNoHintReason =
    | "below-threshold"
    | "timeout"
    | "empty"
    | "error"
    | "stacked"
    | "too-short";

export type AutoSearchHintDecision =
    | { messageId: string; decision: "hint"; text: string }
    | { messageId: string; decision: "no-hint"; reason: AutoSearchHintNoHintReason };

export type NoteNudgeDeliveryOutcome =
    | { ok: true; kind: "appended" }
    | { ok: true; kind: "already-present" }
    | { ok: false; kind: "conflict" }
    | { ok: false; kind: "cas-exhausted" };

export type AppendAutoSearchHintOutcome =
    | { ok: true; kind: "appended"; decision: AutoSearchHintDecision }
    | { ok: true; kind: "already-present"; decision: AutoSearchHintDecision }
    | { ok: false; kind: "cas-exhausted" };

export interface PersistedTodoSyntheticAnchor {
    callId: string;
    messageId: string;
    /**
     * Snapshot JSON of the todos as they existed at the moment we injected.
     * Source of truth for defer-pass replay so the prefix bytes stay
     * identical across T0-cache-bust → T1-defer even when a real
     * `todowrite` mutates `last_todo_state` between T0 and T1.
     */
    stateJson: string;
}

export interface PersistedHistorianFailureState {
    failureCount: number;
    lastError: string | null;
    lastFailureAt: number | null;
}

export interface PersistedUsageState {
    usage: ContextUsage;
    updatedAt: number;
    lastObservedModelKey: string | null;
    lastUsageContextLimit: number;
}

export interface ProtectedTailMeta {
    priorBoundaryOrdinal: number;
    protectedTailPolicyVersion: number;
    protectedTailDrainWindowStartedAt: number;
    protectedTailDrainTokens: number;
    recoveryNoEligibleHeadCount: number;
    forceEmergencyBypassWindowStart: number;
    forceEmergencyBypassUsed: number;
    // ms-timestamp latch: 0 = inactive, else the time the session entered the
    // emergency drain catch-up (>=95%). While active the historian drains a chunk
    // every pass, bypassing the per-window drain budget, until usage falls below
    // the safe zone (executeThreshold - 10) or the latch self-expires.
    emergencyDrainActive: number;
    // ms of the last genuine historian FAILURE; suppresses the latch bypass for a
    // short backoff so a broken historian can't retry-thrash under the latch.
    historianDrainFailureAt: number;
}

export interface ProtectedTailSeedResult extends ProtectedTailMeta {
    seeded: boolean;
}

export interface ProtectedTailDrainReservation {
    sessionId: string;
    runId: string;
    tokens: number;
}

export interface ProtectedTailDrainBudgetState {
    windowStartedAt: number;
    resetsAt: number;
    resetInMs: number;
    spentTokens: number;
    limitTokens: number;
}

export interface ProtectedTailDrainReserveResult {
    ok: boolean;
    reservedTokens: number;
    overQuotaBypass: boolean;
    reservation: ProtectedTailDrainReservation | null;
    budgetState: ProtectedTailDrainBudgetState | null;
    skippedReason?: string;
}

/** Describe the internal limiter without implying that the model provider rejected a request. */
export function describeProtectedTailDrainBudgetSkip(
    result: ProtectedTailDrainReserveResult,
): string {
    const state = result.budgetState;
    if (!state) return "historian skip: internal drain budget spent";
    const resetMinutes = Math.max(1, Math.ceil(state.resetInMs / 60_000));
    return `historian skip: internal drain budget spent (${state.spentTokens}/${state.limitTokens} tokens; resets in ${resetMinutes}m)`;
}

export interface WrapupInProgressState {
    holderId: string;
    acquiredAt: number;
    expiresAt: number;
    messagesToKeep: number;
    anchorRawMessageCount: number;
    targetEligibleEndOrdinal: number;
    lastCompartmentEnd: number;
    chunkIndex: number;
    expectedChunks: number;
    updatedAt: number;
}

export type AcquireWrapupResult =
    | { ok: true; state: WrapupInProgressState }
    | { ok: false; state: WrapupInProgressState | null };

const CAS_RETRY_LIMIT = 5;
const AUTO_SEARCH_NO_HINT_REASONS = new Set<string>([
    "below-threshold",
    "timeout",
    "empty",
    "error",
    "stacked",
    "too-short",
]);

function isPersistedUsageRow(row: unknown): row is PersistedUsageRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.last_context_percentage === "number" &&
        typeof r.last_input_tokens === "number" &&
        typeof r.last_response_time === "number" &&
        (typeof r.last_observed_model_key === "string" || r.last_observed_model_key === null) &&
        (typeof r.last_usage_context_limit === "number" || r.last_usage_context_limit === null)
    );
}

function isPersistedReasoningWatermarkRow(row: unknown): row is PersistedReasoningWatermarkRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.cleared_reasoning_through_tag === "number";
}

function isPersistedNoteNudgeRow(row: unknown): row is PersistedNoteNudgeRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.note_nudge_trigger_pending === "number" &&
        typeof r.note_nudge_trigger_message_id === "string" &&
        typeof r.note_nudge_sticky_text === "string" &&
        typeof r.note_nudge_sticky_message_id === "string"
    );
}

function isValidNoteNudgeAnchor(value: unknown): value is NoteNudgeAnchor {
    if (value === null || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    return (
        typeof row.messageId === "string" &&
        row.messageId.length > 0 &&
        typeof row.text === "string" &&
        row.text.length > 0
    );
}

function isValidAutoSearchHintDecision(value: unknown): value is AutoSearchHintDecision {
    if (value === null || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    if (typeof row.messageId !== "string" || row.messageId.length === 0) return false;
    if (row.decision === "hint") {
        return typeof row.text === "string" && row.text.length > 0;
    }
    if (row.decision === "no-hint") {
        return typeof row.reason === "string" && AUTO_SEARCH_NO_HINT_REASONS.has(row.reason);
    }
    return false;
}

function parseJsonArray<T>(
    json: string | null | undefined,
    validator: (value: unknown) => value is T,
): T[] {
    if (!json) return [];
    try {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(validator);
    } catch {
        return [];
    }
}

function isPersistedTodoSyntheticAnchorRow(row: unknown): row is PersistedTodoSyntheticAnchorRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.todo_synthetic_call_id === "string" &&
        typeof r.todo_synthetic_anchor_message_id === "string" &&
        typeof r.todo_synthetic_state_json === "string"
    );
}

function isPersistedHistorianFailureRow(row: unknown): row is PersistedHistorianFailureRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.historian_failure_count === "number" &&
        (typeof r.historian_last_error === "string" || r.historian_last_error === null) &&
        (typeof r.historian_last_failure_at === "number" || r.historian_last_failure_at === null)
    );
}

function getDefaultPersistedNoteNudge(): PersistedNoteNudge {
    return {
        triggerPending: false,
        triggerMessageId: null,
        stickyText: null,
        stickyMessageId: null,
    };
}

function getDefaultHistorianFailureState(): PersistedHistorianFailureState {
    return {
        failureCount: 0,
        lastError: null,
        lastFailureAt: null,
    };
}

export function loadPersistedUsage(db: Database, sessionId: string): PersistedUsageState | null {
    const result = db
        .prepare(
            "SELECT last_context_percentage, last_input_tokens, last_response_time, last_observed_model_key, last_usage_context_limit FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);

    if (
        !isPersistedUsageRow(result) ||
        (result.last_context_percentage === 0 && result.last_input_tokens === 0)
    ) {
        return null;
    }

    return {
        usage: {
            percentage: result.last_context_percentage,
            inputTokens: result.last_input_tokens,
        },
        updatedAt: result.last_response_time || Date.now(),
        lastObservedModelKey: result.last_observed_model_key,
        lastUsageContextLimit:
            typeof result.last_usage_context_limit === "number"
                ? result.last_usage_context_limit
                : 0,
    };
}

const DEFAULT_PROTECTED_TAIL_META: ProtectedTailMeta = {
    priorBoundaryOrdinal: 1,
    protectedTailPolicyVersion: 0,
    protectedTailDrainWindowStartedAt: 0,
    protectedTailDrainTokens: 0,
    recoveryNoEligibleHeadCount: 0,
    forceEmergencyBypassWindowStart: 0,
    forceEmergencyBypassUsed: 0,
    emergencyDrainActive: 0,
    historianDrainFailureAt: 0,
};

function toProtectedTailMeta(row: unknown): ProtectedTailMeta {
    if (row === null || typeof row !== "object") return { ...DEFAULT_PROTECTED_TAIL_META };
    const r = row as Record<string, unknown>;
    const numberOr = (value: unknown, fallback: number): number =>
        typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return {
        priorBoundaryOrdinal: Math.max(1, numberOr(r.prior_boundary_ordinal, 1)),
        protectedTailPolicyVersion: numberOr(r.protected_tail_policy_version, 0),
        protectedTailDrainWindowStartedAt: numberOr(r.protected_tail_drain_window_started_at, 0),
        protectedTailDrainTokens: numberOr(r.protected_tail_drain_tokens, 0),
        recoveryNoEligibleHeadCount: numberOr(r.recovery_no_eligible_head_count, 0),
        forceEmergencyBypassWindowStart: numberOr(r.force_emergency_bypass_window_start, 0),
        forceEmergencyBypassUsed: numberOr(r.force_emergency_bypass_used, 0),
        emergencyDrainActive: numberOr(r.emergency_drain_active, 0),
        historianDrainFailureAt: numberOr(r.historian_drain_failure_at, 0),
    };
}

export function loadProtectedTailMeta(db: Database, sessionId: string): ProtectedTailMeta {
    ensureSessionMetaRow(db, sessionId);
    const row = db
        .prepare(
            `SELECT prior_boundary_ordinal, protected_tail_policy_version,
                    protected_tail_drain_window_started_at, protected_tail_drain_tokens,
                    recovery_no_eligible_head_count, force_emergency_bypass_window_start,
                    force_emergency_bypass_used, emergency_drain_active, historian_drain_failure_at
             FROM session_meta WHERE session_id = ?`,
        )
        .get(sessionId);
    return toProtectedTailMeta(row);
}

export function markProtectedTailPolicyV3Seeded(
    db: Database,
    sessionId: string,
    priorBoundaryOrdinal: number,
): ProtectedTailSeedResult {
    let seeded = false;
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const existing = loadProtectedTailMeta(db, sessionId);
        if (existing.protectedTailPolicyVersion < 3) {
            db.prepare(
                `UPDATE session_meta
                 SET prior_boundary_ordinal = ?, protected_tail_policy_version = 3
                 WHERE session_id = ? AND protected_tail_policy_version < 3`,
            ).run(Math.max(1, Math.floor(priorBoundaryOrdinal)), sessionId);
            seeded = true;
        }
    })();
    return { ...loadProtectedTailMeta(db, sessionId), seeded };
}

export function recordProtectedTailPublicationFloor(
    db: Database,
    sessionId: string,
    floorOrdinal: number,
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            `UPDATE session_meta
             SET prior_boundary_ordinal = MAX(COALESCE(prior_boundary_ordinal, 1), ?),
                 recovery_no_eligible_head_count = 0
             WHERE session_id = ?`,
        ).run(Math.max(1, Math.floor(floorOrdinal)), sessionId);
    })();
}

export function recordProtectedTailNoEligibleHead(db: Database, sessionId: string): number {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            `UPDATE session_meta
             SET recovery_no_eligible_head_count = COALESCE(recovery_no_eligible_head_count, 0) + 1
             WHERE session_id = ?`,
        ).run(sessionId);
    })();
    return loadProtectedTailMeta(db, sessionId).recoveryNoEligibleHeadCount;
}

export function resetProtectedTailNoEligibleHead(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET recovery_no_eligible_head_count = 0 WHERE session_id = ?",
        ).run(sessionId);
    })();
}

export const DRAIN_WINDOW_MS = 10 * 60 * 1000;

export const WRAPUP_IN_PROGRESS_TTL_MS = 5 * 60 * 1000;

function parseWrapupState(value: unknown): WrapupInProgressState | null {
    if (typeof value !== "string" || value.trim().length === 0) return null;
    try {
        const parsed = JSON.parse(value) as Partial<WrapupInProgressState> | null;
        if (!parsed || typeof parsed !== "object") return null;
        if (typeof parsed.holderId !== "string" || parsed.holderId.length === 0) return null;
        const numberFields: Array<keyof WrapupInProgressState> = [
            "acquiredAt",
            "expiresAt",
            "messagesToKeep",
            "anchorRawMessageCount",
            "targetEligibleEndOrdinal",
            "lastCompartmentEnd",
            "chunkIndex",
            "expectedChunks",
            "updatedAt",
        ];
        for (const field of numberFields) {
            if (typeof parsed[field] !== "number" || !Number.isFinite(parsed[field])) return null;
        }
        return parsed as WrapupInProgressState;
    } catch {
        return null;
    }
}

function readRawWrapupState(db: Database, sessionId: string): WrapupInProgressState | null {
    const row = db
        .prepare<[string], { wrapup_in_progress_state: string | null }>(
            "SELECT wrapup_in_progress_state FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);
    return parseWrapupState(row?.wrapup_in_progress_state);
}

export function getWrapupInProgressState(
    db: Database,
    sessionId: string,
    now = Date.now(),
): WrapupInProgressState | null {
    const state = readRawWrapupState(db, sessionId);
    if (!state) return null;
    if (state.expiresAt > now) return state;
    try {
        db.exec("BEGIN IMMEDIATE");
    } catch {
        // Callers sometimes check this from inside their own write transaction.
        // Treat an expired marker as absent there and let a later standalone check
        // reclaim the stale blob.
        return null;
    }
    let finished = false;
    try {
        const current = readRawWrapupState(db, sessionId);
        if (current && current.expiresAt <= now) {
            db.prepare(
                "UPDATE session_meta SET wrapup_in_progress_state = NULL WHERE session_id = ?",
            ).run(sessionId);
        }
        db.exec("COMMIT");
        finished = true;
    } finally {
        if (!finished) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // Transaction may have already been closed by SQLite.
            }
        }
    }
    return null;
}

export function isWrapupInProgress(db: Database, sessionId: string, now = Date.now()): boolean {
    return getWrapupInProgressState(db, sessionId, now) !== null;
}

export function acquireWrapupInProgress(
    db: Database,
    sessionId: string,
    state: Omit<WrapupInProgressState, "acquiredAt" | "expiresAt" | "updatedAt">,
    now = Date.now(),
): AcquireWrapupResult {
    const acquiredAt = now;
    const next: WrapupInProgressState = {
        ...state,
        acquiredAt,
        expiresAt: acquiredAt + WRAPUP_IN_PROGRESS_TTL_MS,
        updatedAt: acquiredAt,
    };
    db.exec("BEGIN IMMEDIATE");
    let finished = false;
    try {
        ensureSessionMetaRow(db, sessionId);
        const current = readRawWrapupState(db, sessionId);
        if (current && current.expiresAt > now && current.holderId !== state.holderId) {
            db.exec("COMMIT");
            finished = true;
            return { ok: false, state: current };
        }
        db.prepare("UPDATE session_meta SET wrapup_in_progress_state = ? WHERE session_id = ?").run(
            stableStringify(next),
            sessionId,
        );
        db.exec("COMMIT");
        finished = true;
        return { ok: true, state: next };
    } finally {
        if (!finished) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // Transaction may have already been closed by SQLite.
            }
        }
    }
}

export function updateWrapupInProgress(
    db: Database,
    sessionId: string,
    holderId: string,
    updates: Partial<Omit<WrapupInProgressState, "holderId" | "acquiredAt">>,
    now = Date.now(),
): WrapupInProgressState | null {
    db.exec("BEGIN IMMEDIATE");
    let finished = false;
    try {
        const current = readRawWrapupState(db, sessionId);
        if (!current || current.holderId !== holderId || current.expiresAt <= now) {
            db.exec("ROLLBACK");
            finished = true;
            return null;
        }
        const next: WrapupInProgressState = {
            ...current,
            ...updates,
            holderId,
            expiresAt: now + WRAPUP_IN_PROGRESS_TTL_MS,
            updatedAt: now,
        };
        db.prepare("UPDATE session_meta SET wrapup_in_progress_state = ? WHERE session_id = ?").run(
            stableStringify(next),
            sessionId,
        );
        db.exec("COMMIT");
        finished = true;
        return next;
    } finally {
        if (!finished) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // Transaction may have already been closed by SQLite.
            }
        }
    }
}

export function releaseWrapupInProgress(db: Database, sessionId: string, holderId: string): void {
    db.exec("BEGIN IMMEDIATE");
    let finished = false;
    try {
        const current = readRawWrapupState(db, sessionId);
        if (current?.holderId === holderId) {
            db.prepare(
                "UPDATE session_meta SET wrapup_in_progress_state = NULL WHERE session_id = ?",
            ).run(sessionId);
        }
        db.exec("COMMIT");
        finished = true;
    } finally {
        if (!finished) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // Transaction may have already been closed by SQLite.
            }
        }
    }
}

/**
 * Per-session compaction mode record. Stored in the `compaction_mode_record`
 * column added by migration v72. Value domain:
 *   - NULL  → no record (treated as "on" by the transition logic, so a
 *             pre-existing row is unambiguously no-record; a session with no
 *             record that boots into compaction-off mode runs the off cleanup)
 *   - "on" / "off" → settled mode for this session
 *   - "on_notice_pending" / "off_notice_pending" → the matching mode is
 *     already active, but its out-of-band transition notice must be retried
 *     after a restart until delivery succeeds
 *   - "off_cleanup_pending" → off mode is active while marker cleanup awaits
 *     a later verification pass; this keeps cleanup retry durable after its
 *     notice has already been delivered
 *
 * Helpers use a simple UPDATE under the session row (no compare-and-swap)
 * because there is a single writer per session on the transform path.
 * clearSession() needs no change (the column is row-scoped).
 */
export type CompactionModeRecord =
    | "on"
    | "off"
    | "on_notice_pending"
    | "off_notice_pending"
    | "off_cleanup_pending";

export type ResolvedCompactionModeRecord = "on" | "off";

const COMPACTION_MODE_RECORD_VALUES: ReadonlySet<CompactionModeRecord> = new Set([
    "on",
    "off",
    "on_notice_pending",
    "off_notice_pending",
    "off_cleanup_pending",
]);

function normalizeCompactionModeRecord(value: unknown): CompactionModeRecord | null {
    if (value === null || value === undefined) return null;
    if (
        typeof value === "string" &&
        COMPACTION_MODE_RECORD_VALUES.has(value as CompactionModeRecord)
    ) {
        return value as CompactionModeRecord;
    }
    return null;
}

/** Resolves transient delivery/cleanup records to the mode their gates must use. */
export function resolveCompactionModeRecord(
    record: CompactionModeRecord | null,
): ResolvedCompactionModeRecord | null {
    switch (record) {
        case "on":
        case "on_notice_pending":
            return "on";
        case "off":
        case "off_notice_pending":
        case "off_cleanup_pending":
            return "off";
        default:
            return null;
    }
}

/** Reads the persisted compaction mode record for a session. NULL → no record. */
export function getCompactionModeRecord(
    db: Database,
    sessionId: string,
): CompactionModeRecord | null {
    const row = db
        .prepare<[string], { compaction_mode_record: string | null }>(
            "SELECT compaction_mode_record FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);
    return normalizeCompactionModeRecord(row?.compaction_mode_record);
}

/**
 * Writes the compaction mode record for a session. Ensures the session_meta row
 * exists first. Pass `null` to clear the record (no record). Only supported
 * settled or transient `CompactionModeRecord` values (or null) are accepted;
 * any other value throws (defensive — callers should pass a typed record).
 */
export function setCompactionModeRecord(
    db: Database,
    sessionId: string,
    value: CompactionModeRecord | null,
): void {
    if (value !== null && !COMPACTION_MODE_RECORD_VALUES.has(value)) {
        throw new Error(
            `Invalid compaction_mode_record value: ${String(value)} (expected a supported compaction mode record or null)`,
        );
    }
    ensureSessionMetaRow(db, sessionId);
    db.prepare("UPDATE session_meta SET compaction_mode_record = ? WHERE session_id = ?").run(
        value,
        sessionId,
    );
}

export function protectedTailWindowBudget(
    usagePercentage: number,
    usable: number,
    perRunCap: number,
): number {
    if (usagePercentage >= 95)
        return Math.min(1_000_000, Math.max(4 * perRunCap, Math.round(0.5 * usable)));
    if (usagePercentage >= 80)
        return Math.min(750_000, Math.max(3 * perRunCap, Math.round(0.35 * usable)));
    return Math.min(500_000, Math.max(perRunCap, Math.round(0.2 * usable)));
}

/**
 * The latch exits when usage falls this far BELOW the execute threshold, leaving
 * headroom for a normal execute cycle to resume after the drops (exiting exactly
 * at the threshold would immediately re-enter the force-fire band).
 */
export const EMERGENCY_DRAIN_EXIT_MARGIN = 10;
/**
 * Fallback exit threshold when the execute threshold is unknown/0 (schema default
 * execute threshold is 65 → 65 − 10 = 55).
 */
export const EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE = 55;
/**
 * After a genuine historian FAILURE, suppress the latch bypass for this long so a
 * broken historian backs off instead of retry-thrashing every pass under the latch.
 */
export const EMERGENCY_DRAIN_FAILURE_BACKOFF_MS = 60_000;
/**
 * Self-expiry backstop: clear the latch once it has been active this long, in case
 * a high irreducible floor (system + tools + m[0]/m[1] + protected tail) keeps usage
 * above the exit threshold forever and a usage-driven exit never fires.
 */
export const EMERGENCY_DRAIN_MAX_LATCH_MS = 30 * 60 * 1000;

/** Resolve the usage % below which the emergency drain latch clears. */
export function emergencyDrainExitThreshold(executeThresholdPercentage: number): number {
    if (!Number.isFinite(executeThresholdPercentage) || executeThresholdPercentage <= 0) {
        return EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE;
    }
    return Math.max(0, executeThresholdPercentage - EMERGENCY_DRAIN_EXIT_MARGIN);
}

export function reserveProtectedTailDrainTokens(args: {
    db: Database;
    sessionId: string;
    runId: string;
    trueRawTokens: number;
    usagePercentage: number;
    usable: number;
    perRunCap: number;
    executeThresholdPercentage: number;
    now?: number;
}): ProtectedTailDrainReserveResult {
    const now = args.now ?? Date.now();
    const requested = Math.max(0, Math.floor(args.trueRawTokens));
    if (requested === 0) {
        return {
            ok: true,
            reservedTokens: 0,
            overQuotaBypass: false,
            reservation: null,
            budgetState: null,
        };
    }
    let result: ProtectedTailDrainReserveResult = {
        ok: false,
        reservedTokens: 0,
        overQuotaBypass: false,
        reservation: null,
        budgetState: null,
        skippedReason: "internal drain budget spent",
    };
    args.db.transaction(() => {
        ensureSessionMetaRow(args.db, args.sessionId);
        let meta = loadProtectedTailMeta(args.db, args.sessionId);
        const windowStartedAt = meta.protectedTailDrainWindowStartedAt;
        const windowExpired =
            windowStartedAt <= 0 ||
            windowStartedAt > now ||
            now - windowStartedAt >= DRAIN_WINDOW_MS;
        if (windowExpired) {
            // Expiry is checked before every reservation, including skipped attempts.
            // A future timestamp is invalid wall-clock state and starts a fresh window
            // instead of holding the session behind the limiter until that time arrives.
            args.db
                .prepare(
                    `UPDATE session_meta
                     SET protected_tail_drain_window_started_at = ?, protected_tail_drain_tokens = 0
                     WHERE session_id = ?`,
                )
                .run(now, args.sessionId);
            meta = loadProtectedTailMeta(args.db, args.sessionId);
        }

        // Drain catch-up latch lifecycle (usage-driven). Enter when the session
        // reaches the derived force band; exit once usage falls back below
        // the safe zone, or after a self-expiry backstop. Persisted unconditionally
        // so the next pass sees the resolved state even when we skip below.
        const exitThreshold = emergencyDrainExitThreshold(args.executeThresholdPercentage);
        let latchActiveSince = meta.emergencyDrainActive;
        const { forceMaterializationPercentage } = escalationBands(args.executeThresholdPercentage);
        if (args.usagePercentage >= forceMaterializationPercentage) {
            if (latchActiveSince <= 0) latchActiveSince = now;
        } else if (latchActiveSince > 0) {
            const expired = now - latchActiveSince > EMERGENCY_DRAIN_MAX_LATCH_MS;
            if (args.usagePercentage < exitThreshold || expired) latchActiveSince = 0;
        }
        if (latchActiveSince !== meta.emergencyDrainActive) {
            args.db
                .prepare("UPDATE session_meta SET emergency_drain_active = ? WHERE session_id = ?")
                .run(latchActiveSince, args.sessionId);
        }
        const latchActive = latchActiveSince > 0;

        const budget = protectedTailWindowBudget(args.usagePercentage, args.usable, args.perRunCap);
        const remaining = Math.max(0, budget - meta.protectedTailDrainTokens);
        let reserved = Math.min(requested, args.perRunCap, remaining);
        let bypass = false;
        // While emergency draining is active, reserve a chunk on every pass beyond
        // the normal window budget unless a recent historian failure is still backing
        // off. A future failure timestamp is ignored because it cannot represent a
        // recent failure after the wall clock moved backward.
        const inFailureBackoff =
            meta.historianDrainFailureAt > 0 &&
            meta.historianDrainFailureAt <= now &&
            now - meta.historianDrainFailureAt < EMERGENCY_DRAIN_FAILURE_BACKOFF_MS;
        if (reserved <= 0 && latchActive && !inFailureBackoff) {
            reserved = Math.min(requested, args.perRunCap);
            bypass = true;
        }

        const activeWindowStartedAt = meta.protectedTailDrainWindowStartedAt;
        const budgetState = (spentTokens: number): ProtectedTailDrainBudgetState => ({
            windowStartedAt: activeWindowStartedAt,
            resetsAt: activeWindowStartedAt + DRAIN_WINDOW_MS,
            resetInMs: Math.max(0, activeWindowStartedAt + DRAIN_WINDOW_MS - now),
            spentTokens,
            limitTokens: budget,
        });
        if (reserved <= 0) {
            result = {
                ...result,
                budgetState: budgetState(meta.protectedTailDrainTokens),
            };
            return;
        }
        args.db
            .prepare(
                `UPDATE session_meta
                 SET protected_tail_drain_tokens = COALESCE(protected_tail_drain_tokens, 0) + ?
                 WHERE session_id = ?`,
            )
            .run(reserved, args.sessionId);
        result = {
            ok: true,
            reservedTokens: reserved,
            overQuotaBypass: bypass,
            reservation: { sessionId: args.sessionId, runId: args.runId, tokens: reserved },
            budgetState: budgetState(meta.protectedTailDrainTokens + reserved),
        };
    })();
    return result;
}

/** Clear the emergency drain catch-up latch (called when the historian no-ops on
 *  an exhausted tail — nothing left to drain, so the latch has done its job). */
export function clearEmergencyDrainLatch(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare("UPDATE session_meta SET emergency_drain_active = 0 WHERE session_id = ?").run(
            sessionId,
        );
    })();
}

/** Record a genuine historian drain FAILURE (model error / no output). Suppresses
 *  the latch bypass for EMERGENCY_DRAIN_FAILURE_BACKOFF_MS. */
export function recordHistorianDrainFailure(db: Database, sessionId: string, now?: number): void {
    const ts = now ?? Date.now();
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET historian_drain_failure_at = ? WHERE session_id = ?",
        ).run(ts, sessionId);
    })();
}

/** Clear the historian drain-failure backoff (called on a successful publish). */
export function clearHistorianDrainFailure(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET historian_drain_failure_at = 0 WHERE session_id = ?",
        ).run(sessionId);
    })();
}

export function rollbackProtectedTailDrainReservation(
    db: Database,
    reservation: ProtectedTailDrainReservation | null,
): void {
    if (!reservation || reservation.tokens <= 0) return;
    db.transaction(() => {
        ensureSessionMetaRow(db, reservation.sessionId);
        db.prepare(
            `UPDATE session_meta
             SET protected_tail_drain_tokens = MAX(0, COALESCE(protected_tail_drain_tokens, 0) - ?)
             WHERE session_id = ?`,
        ).run(reservation.tokens, reservation.sessionId);
    })();
}

export function getPersistedReasoningWatermark(db: Database, sessionId: string): number {
    const result = db
        .prepare("SELECT cleared_reasoning_through_tag FROM session_meta WHERE session_id = ?")
        .get(sessionId);

    return isPersistedReasoningWatermarkRow(result) ? result.cleared_reasoning_through_tag : 0;
}

export function setPersistedReasoningWatermark(
    db: Database,
    sessionId: string,
    tagNumber: number,
): void {
    ensureSessionMetaRow(db, sessionId);
    db.prepare(
        "UPDATE session_meta SET cleared_reasoning_through_tag = ? WHERE session_id = ?",
    ).run(tagNumber, sessionId);
}

/**
 * Reset the persisted reasoning watermark for a session. Used during model
 * switches to make sure stale reasoning state from the previous model does
 * not leak into pressure or replay decisions for the new one.
 */
export function clearPersistedReasoningWatermark(db: Database, sessionId: string): void {
    setPersistedReasoningWatermark(db, sessionId, 0);
}

// ---- Tiered emergency-drop watermark (Phase 2) ----
// `last_emergency_input_sample` is the pressure-episode latch for the tiered
// emergency drop. Zero means no originating batch has acted in the current force
// episode; non-zero records the usage at that batch. Fresh provider samples do
// not release it, because sustained force-band residency otherwise ages one tag
// at a time past the protected tail and mints one bust per execute pass. The
// postprocess caller resets it after pressure exits or immediately before an
// independent provider-visible mutation, so accumulated candidates either start
// one pressure bust or ride an already-priced bust. There is deliberately no
// tag-number watermark: tier-ordered drops are non-contiguous, and a scalar
// cursor would exclude still-active lower-numbered tags.
interface PersistedEmergencyInputSampleRow {
    last_emergency_input_sample: number;
}

function isEmergencyInputSampleRow(row: unknown): row is PersistedEmergencyInputSampleRow {
    return (
        typeof row === "object" &&
        row !== null &&
        typeof (row as PersistedEmergencyInputSampleRow).last_emergency_input_sample === "number"
    );
}

export function getEmergencyInputSample(db: Database, sessionId: string): number {
    const result = db
        .prepare("SELECT last_emergency_input_sample FROM session_meta WHERE session_id = ?")
        .get(sessionId);
    return isEmergencyInputSampleRow(result) ? result.last_emergency_input_sample : 0;
}

/**
 * Latch a force-band episode only after an emergency batch removes content.
 * Zero-removal evaluations stay armed so later completed outputs can form the batch.
 */
export function setEmergencyDropSample(db: Database, sessionId: string, inputSample: number): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET last_emergency_input_sample = ? WHERE session_id = ?",
        ).run(Math.max(0, Math.round(inputSample)), sessionId);
    })();
}

export function clearEmergencyDropSample(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET last_emergency_input_sample = 0 WHERE session_id = ?",
        ).run(sessionId);
    })();
}

// ---- Channel 1 (in-turn tool-output ctx_reduce nudge) cadence + band state ----
// `last_nudge_undropped` records the U watermark for cadence. The existing
// `last_nudge_level` scalar holds band, turn cadence, and post-reduce grace as
// JSON so the state machine remains durable without another schema column.
export type PersistedChannel1NudgeLevel = "" | "gentle" | "firm" | "urgent";

interface PersistedLastNudgeUndroppedRow {
    last_nudge_undropped: number;
}

interface PersistedLastNudgeLevelRow {
    last_nudge_level: string;
}

export interface PersistedChannel1NudgeState {
    /** Currently observed band; an upward change is the only full-copy crossing. */
    level: PersistedChannel1NudgeLevel;
    /** Real-user-turn counter at the last fire; the JSON key stays stable. */
    ordinal: number;
    /** Waiting for the first tail walk whose U already excludes queued drops. */
    postReduceGracePending?: boolean;
    /** U measured after queued drops were excluded. */
    postReduceGraceBaselineU?: number;
    /** Band observed before the complying ctx_reduce call. */
    postReduceGracePreLevel?: PersistedChannel1NudgeLevel;
}

const EMPTY_CHANNEL1_NUDGE_STATE: PersistedChannel1NudgeState = { level: "", ordinal: 0 };

function isLastNudgeUndroppedRow(row: unknown): row is PersistedLastNudgeUndroppedRow {
    return (
        typeof row === "object" &&
        row !== null &&
        typeof (row as PersistedLastNudgeUndroppedRow).last_nudge_undropped === "number"
    );
}

function isLastNudgeLevelRow(row: unknown): row is PersistedLastNudgeLevelRow {
    return (
        typeof row === "object" &&
        row !== null &&
        typeof (row as PersistedLastNudgeLevelRow).last_nudge_level === "string"
    );
}

function normalizeLastNudgeLevel(value: unknown): PersistedChannel1NudgeLevel {
    return value === "gentle" || value === "firm" || value === "urgent" ? value : "";
}

function parseChannel1NudgeState(raw: string): PersistedChannel1NudgeState {
    try {
        const parsed = JSON.parse(raw) as {
            level?: unknown;
            ordinal?: unknown;
            postReduceGracePending?: unknown;
            postReduceGraceBaselineU?: unknown;
            postReduceGracePreLevel?: unknown;
        };
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            const state: PersistedChannel1NudgeState = {
                level: normalizeLastNudgeLevel(parsed.level),
                ordinal:
                    typeof parsed.ordinal === "number"
                        ? Math.max(0, Math.round(parsed.ordinal))
                        : 0,
            };
            if (parsed.postReduceGracePending === true) state.postReduceGracePending = true;
            if (
                typeof parsed.postReduceGraceBaselineU === "number" &&
                Number.isFinite(parsed.postReduceGraceBaselineU)
            ) {
                state.postReduceGraceBaselineU = Math.max(
                    0,
                    Math.round(parsed.postReduceGraceBaselineU),
                );
            }
            const preLevel = normalizeLastNudgeLevel(parsed.postReduceGracePreLevel);
            if (preLevel !== "" || parsed.postReduceGracePreLevel === "") {
                state.postReduceGracePreLevel = preLevel;
            }
            return state;
        }
    } catch {
        // Legacy rows stored only the cadence level as a scalar.
    }
    return { level: normalizeLastNudgeLevel(raw), ordinal: 0 };
}

function serializeChannel1NudgeState(value: PersistedChannel1NudgeState): string {
    const serialized: Record<string, boolean | number | string> = {
        level: normalizeLastNudgeLevel(value.level),
        ordinal: Math.max(0, Math.round(value.ordinal)),
    };
    if (value.postReduceGracePending === true) serialized.postReduceGracePending = true;
    if (value.postReduceGraceBaselineU !== undefined) {
        serialized.postReduceGraceBaselineU = Math.max(
            0,
            Math.round(value.postReduceGraceBaselineU),
        );
    }
    if (value.postReduceGracePreLevel !== undefined) {
        serialized.postReduceGracePreLevel = normalizeLastNudgeLevel(value.postReduceGracePreLevel);
    }
    return JSON.stringify(serialized);
}

export function getLastNudgeUndropped(db: Database, sessionId: string): number {
    const result = db
        .prepare("SELECT last_nudge_undropped FROM session_meta WHERE session_id = ?")
        .get(sessionId);
    return isLastNudgeUndroppedRow(result) ? result.last_nudge_undropped : 0;
}

export function setLastNudgeUndropped(db: Database, sessionId: string, value: number): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare("UPDATE session_meta SET last_nudge_undropped = ? WHERE session_id = ?").run(
            Math.max(0, Math.round(value)),
            sessionId,
        );
    })();
}

export function getChannel1NudgeState(
    db: Database,
    sessionId: string,
): PersistedChannel1NudgeState {
    const result = db
        .prepare("SELECT last_nudge_level FROM session_meta WHERE session_id = ?")
        .get(sessionId);
    return isLastNudgeLevelRow(result)
        ? parseChannel1NudgeState(result.last_nudge_level)
        : EMPTY_CHANNEL1_NUDGE_STATE;
}

export function setChannel1NudgeState(
    db: Database,
    sessionId: string,
    value: PersistedChannel1NudgeState,
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare("UPDATE session_meta SET last_nudge_level = ? WHERE session_id = ?").run(
            serializeChannel1NudgeState(value),
            sessionId,
        );
    })();
}

/** Record compliance without guessing U from the stale pre-drop baseline. */
export function markChannel1PostReduceGracePending(
    db: Database,
    sessionId: string,
): PersistedChannel1NudgeState {
    return db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const current = getChannel1NudgeState(db, sessionId);
        const next: PersistedChannel1NudgeState = {
            level: current.level,
            ordinal: current.ordinal,
            postReduceGracePending: true,
            postReduceGracePreLevel: current.level,
        };
        db.prepare("UPDATE session_meta SET last_nudge_level = ? WHERE session_id = ?").run(
            serializeChannel1NudgeState(next),
            sessionId,
        );
        return next;
    })();
}

/** Start grace from the first U value that has already excluded queued drops. */
export function captureChannel1PostReduceGraceBaseline(
    db: Database,
    sessionId: string,
    measuredUndropped: number,
): PersistedChannel1NudgeState {
    return db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const current = getChannel1NudgeState(db, sessionId);
        if (current.postReduceGracePending !== true) return current;
        const baselineU = Math.max(0, Math.round(measuredUndropped));
        const next: PersistedChannel1NudgeState = {
            level: current.level,
            ordinal: current.ordinal,
            postReduceGraceBaselineU: baselineU,
            postReduceGracePreLevel: current.postReduceGracePreLevel ?? current.level,
        };
        db.prepare("UPDATE session_meta SET last_nudge_level = ? WHERE session_id = ?").run(
            serializeChannel1NudgeState(next),
            sessionId,
        );
        return next;
    })();
}

export function resetLastNudgeCycle(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET last_nudge_undropped = 0, last_nudge_level = ? WHERE session_id = ?",
        ).run(serializeChannel1NudgeState(EMPTY_CHANNEL1_NUDGE_STATE), sessionId);
    })();
}

/**
 * Clear the persisted Channel-1 cadence/band state when a fresh baseline sees
 * that the reclaimable tail already shrank below the old watermark.
 *
 * Why this exists: historian publication, emergency eviction, or pending-op
 * replay can shrink the tail WITHOUT a `ctx_reduce` tool call. The old nudge then
 * referred to a pile that no longer exists, so a regrowth must start a new
 * gentle→firm→urgent cycle instead of inheriting a stale persisted band.
 */
export function resetLastNudgeCycleIfTailShrank(
    db: Database,
    sessionId: string,
    measuredUndropped: number,
): boolean {
    let changed = false;
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const result = db
            .prepare(
                "UPDATE session_meta SET last_nudge_undropped = 0, last_nudge_level = ? WHERE session_id = ? AND last_nudge_undropped > ?",
            )
            .run(
                serializeChannel1NudgeState(EMPTY_CHANNEL1_NUDGE_STATE),
                sessionId,
                Math.max(0, Math.round(measuredUndropped)),
            );
        changed = (result.changes ?? 0) > 0;
    })();
    return changed;
}

// ---- Channel 2 (synthetic-user-message ceiling) cycle lease/outbox ----
// State machine stored as a single string in `channel2_nudge_state`:
//   ''         — no intent (initial)
//   'pending'  — transform recorded the ceiling condition; deliver on next event
//   'claimed'  — a delivery attempt is in flight (CAS-claimed before send);
//                `channel2_nudge_claimed_at` stores the lease timestamp so boot
//                recovery only rewinds stale claims, never a live sibling send.
//                OpenCode also writes `channel2_nudge_claim_token` so a slow
//                sender cannot confirm a lease after another process heals and
//                re-delivers it.
//   'delivered'— confirmed sent; the current tail-reset cycle is consumed
// On send failure the caller reverts 'claimed' -> 'pending' so a transient error
// does not consume the cycle. After send succeeds, a
// confirm failure must NOT re-arm; callers leave the lease non-pending.
export type Channel2NudgeState = "" | "pending" | "claimed" | "delivered";

interface PersistedChannel2StateRow {
    channel2_nudge_state: string;
}

interface PersistedChannel2ClaimRow {
    channel2_nudge_state?: string;
    channel2_nudge_claimed_at: number;
    channel2_nudge_claim_token?: string | null;
}

function isChannel2StateRow(row: unknown): row is PersistedChannel2StateRow {
    return (
        typeof row === "object" &&
        row !== null &&
        typeof (row as PersistedChannel2StateRow).channel2_nudge_state === "string"
    );
}

export function getChannel2NudgeState(db: Database, sessionId: string): Channel2NudgeState {
    const result = db
        .prepare("SELECT channel2_nudge_state FROM session_meta WHERE session_id = ?")
        .get(sessionId);
    if (!isChannel2StateRow(result)) return "";
    const raw = result.channel2_nudge_state;
    return raw === "pending" || raw === "claimed" || raw === "delivered" ? raw : "";
}

export function getChannel2NudgeClaimedAt(db: Database, sessionId: string): number {
    const result = db
        .prepare("SELECT channel2_nudge_claimed_at FROM session_meta WHERE session_id = ?")
        .get(sessionId);
    return typeof result === "object" &&
        result !== null &&
        typeof (result as PersistedChannel2ClaimRow).channel2_nudge_claimed_at === "number"
        ? (result as PersistedChannel2ClaimRow).channel2_nudge_claimed_at
        : 0;
}

export interface Channel2NudgeClaim {
    state: Channel2NudgeState;
    claimedAt: number;
    claimToken: string;
}

export function getChannel2NudgeClaim(db: Database, sessionId: string): Channel2NudgeClaim {
    const result = db
        .prepare(
            "SELECT channel2_nudge_state, channel2_nudge_claimed_at, channel2_nudge_claim_token FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as PersistedChannel2ClaimRow | null;
    const rawState =
        typeof result?.channel2_nudge_state === "string" ? result.channel2_nudge_state : "";
    const state: Channel2NudgeState =
        rawState === "pending" || rawState === "claimed" || rawState === "delivered"
            ? rawState
            : "";
    return {
        state,
        claimedAt:
            typeof result?.channel2_nudge_claimed_at === "number"
                ? result.channel2_nudge_claimed_at
                : 0,
        claimToken:
            typeof result?.channel2_nudge_claim_token === "string"
                ? result.channel2_nudge_claim_token
                : "",
    };
}

export function setChannel2NudgeState(
    db: Database,
    sessionId: string,
    state: Channel2NudgeState,
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const claimedAt = state === "claimed" ? Date.now() : 0;
        db.prepare(
            "UPDATE session_meta SET channel2_nudge_state = ?, channel2_nudge_claimed_at = ?, channel2_nudge_claim_token = '' WHERE session_id = ?",
        ).run(state, claimedAt, sessionId);
    })();
}

/**
 * Atomically move the Channel-2 lease from one state to another. Returns true
 * only if the row was in `from` and is now `to` — a cross-process CAS so two
 * concurrent processes can't both claim+deliver the single ceiling nudge.
 */
export function casChannel2NudgeState(
    db: Database,
    sessionId: string,
    from: Channel2NudgeState,
    to: Channel2NudgeState,
): boolean {
    let changed = false;
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const claimedAt = to === "claimed" ? Date.now() : 0;
        const result = db
            .prepare(
                "UPDATE session_meta SET channel2_nudge_state = ?, channel2_nudge_claimed_at = ?, channel2_nudge_claim_token = '' WHERE session_id = ? AND channel2_nudge_state = ?",
            )
            .run(to, claimedAt, sessionId, from);
        changed = (result.changes ?? 0) > 0;
    })();
    return changed;
}

export function claimChannel2NudgeState(
    db: Database,
    sessionId: string,
    claimToken: string,
): boolean {
    let changed = false;
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const result = db
            .prepare(
                "UPDATE session_meta SET channel2_nudge_state = 'claimed', channel2_nudge_claimed_at = ?, channel2_nudge_claim_token = ? WHERE session_id = ? AND channel2_nudge_state = 'pending'",
            )
            .run(Date.now(), claimToken, sessionId);
        changed = (result.changes ?? 0) > 0;
    })();
    return changed;
}

export function casChannel2NudgeClaim(
    db: Database,
    sessionId: string,
    to: Channel2NudgeState,
    claimToken: string,
): boolean {
    let changed = false;
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const claimedAt = to === "claimed" ? Date.now() : 0;
        const nextClaimToken = to === "claimed" ? claimToken : "";
        const result = db
            .prepare(
                "UPDATE session_meta SET channel2_nudge_state = ?, channel2_nudge_claimed_at = ?, channel2_nudge_claim_token = ? WHERE session_id = ? AND channel2_nudge_state = 'claimed' AND channel2_nudge_claim_token = ?",
            )
            .run(to, claimedAt, nextClaimToken, sessionId, claimToken);
        changed = (result.changes ?? 0) > 0;
    })();
    return changed;
}

export function getPersistedNoteNudge(db: Database, sessionId: string): PersistedNoteNudge {
    const result = db
        .prepare(
            "SELECT note_nudge_trigger_pending, note_nudge_trigger_message_id, note_nudge_sticky_text, note_nudge_sticky_message_id FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);

    if (!isPersistedNoteNudgeRow(result)) {
        return getDefaultPersistedNoteNudge();
    }

    return {
        triggerPending: result.note_nudge_trigger_pending === 1,
        triggerMessageId:
            result.note_nudge_trigger_message_id.length > 0
                ? result.note_nudge_trigger_message_id
                : null,
        stickyText: result.note_nudge_sticky_text.length > 0 ? result.note_nudge_sticky_text : null,
        stickyMessageId:
            result.note_nudge_sticky_message_id.length > 0
                ? result.note_nudge_sticky_message_id
                : null,
    };
}

export function setPersistedNoteNudgeTrigger(
    db: Database,
    sessionId: string,
    triggerMessageId = "",
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET note_nudge_trigger_pending = 1, note_nudge_trigger_message_id = ? WHERE session_id = ?",
        ).run(triggerMessageId, sessionId);
    })();
}

export function setPersistedNoteNudgeTriggerMessageId(
    db: Database,
    sessionId: string,
    triggerMessageId: string,
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET note_nudge_trigger_message_id = ? WHERE session_id = ?",
        ).run(triggerMessageId, sessionId);
    })();
}

export function clearPersistedNoteNudge(db: Database, sessionId: string): void {
    db.prepare(
        "UPDATE session_meta SET note_nudge_trigger_pending = 0, note_nudge_trigger_message_id = '', note_nudge_sticky_text = '', note_nudge_sticky_message_id = '' WHERE session_id = ?",
    ).run(sessionId);
}

export function getNoteNudgeAnchors(db: Database, sessionId: string): NoteNudgeAnchor[] {
    const row = db
        .prepare("SELECT note_nudge_anchors FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { note_nudge_anchors?: string | null } | undefined;
    return parseJsonArray(row?.note_nudge_anchors, isValidNoteNudgeAnchor);
}

export function getAutoSearchHintDecisions(
    db: Database,
    sessionId: string,
): AutoSearchHintDecision[] {
    const row = db
        .prepare("SELECT auto_search_hint_decisions FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { auto_search_hint_decisions?: string | null } | undefined;
    return parseJsonArray(row?.auto_search_hint_decisions, isValidAutoSearchHintDecision);
}

function casUpdateJsonArrayColumn<T>(
    db: Database,
    sessionId: string,
    column: "note_nudge_anchors" | "auto_search_hint_decisions",
    validator: (value: unknown) => value is T,
    mutate: (current: T[]) => T[] | null,
    options?: { ensureRow?: boolean },
): boolean {
    // Runtime allow-set guard. `column` is string-interpolated into SELECT/
    // UPDATE SQL below; the TS union is the only compile-time guard, so a
    // future JS-interop or untyped caller could otherwise inject SQL. Throw on
    // any column outside the known set so interpolation is always safe.
    if (column !== "note_nudge_anchors" && column !== "auto_search_hint_decisions") {
        throw new Error(`casUpdateJsonArrayColumn: refusing unknown column "${column}"`);
    }
    if (options?.ensureRow === false) {
        const exists = db.prepare("SELECT 1 FROM session_meta WHERE session_id = ?").get(sessionId);
        if (!exists) return true;
    } else {
        ensureSessionMetaRow(db, sessionId);
    }
    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt += 1) {
        const row = db
            .prepare(`SELECT ${column} FROM session_meta WHERE session_id = ?`)
            .get(sessionId) as Record<string, string | null> | undefined;
        // Preserve the RAW stored value (may be SQL NULL on a legacy row written
        // before the NOT-NULL default / v17 heal). The CAS predicate below uses
        // `IS ?` so it matches NULL too — a `= ?` predicate with the coalesced
        // "[]" would never match a genuinely-NULL row (`NULL = '[]'` is NULL in
        // SQLite), making the CAS fail forever. Mirrors applyStrippedPlaceholderDelta.
        const rawCurrent = (row?.[column] ?? null) as string | null;
        const currentBlob = rawCurrent ?? "[]";
        const current = parseJsonArray(currentBlob, validator);
        const next = mutate(current);
        if (next === null) return true;
        const nextBlob = stableStringify(next);
        if (nextBlob === currentBlob) return true;
        const result = db
            .prepare(
                `UPDATE session_meta SET ${column} = ? WHERE session_id = ? AND ${column} IS ?`,
            )
            .run(nextBlob, sessionId, rawCurrent);
        if (result.changes > 0) return true;
    }
    sessionLog(sessionId, `${column} CAS: ${CAS_RETRY_LIMIT} retries exhausted`);
    return false;
}

export function appendNoteNudgeAnchor(
    db: Database,
    sessionId: string,
    messageId: string,
    text: string,
): boolean {
    if (!messageId || !text) return false;
    return casUpdateJsonArrayColumn(
        db,
        sessionId,
        "note_nudge_anchors",
        isValidNoteNudgeAnchor,
        (current) => {
            if (current.some((anchor) => anchor.messageId === messageId && anchor.text === text)) {
                return null;
            }
            if (current.some((anchor) => anchor.messageId === messageId)) {
                sessionLog(sessionId, "note-nudge: messageId conflict, refusing append");
                return null;
            }
            return [...current, { messageId, text }];
        },
    );
}

type NoteNudgeDeliveryPlan = { kind: "appended" | "already-present" | "conflict" };

export function deliverNoteNudgeAtomic(
    db: Database,
    sessionId: string,
    messageId: string,
    text: string,
): NoteNudgeDeliveryOutcome {
    let plan: NoteNudgeDeliveryPlan | null = null;
    const casOk = casUpdateJsonArrayColumn(
        db,
        sessionId,
        "note_nudge_anchors",
        isValidNoteNudgeAnchor,
        (current) => {
            if (current.some((anchor) => anchor.messageId === messageId && anchor.text === text)) {
                plan = { kind: "already-present" };
                return null;
            }
            if (current.some((anchor) => anchor.messageId === messageId)) {
                plan = { kind: "conflict" };
                sessionLog(sessionId, "note-nudge: messageId conflict, refusing append");
                return null;
            }
            plan = { kind: "appended" };
            return [...current, { messageId, text }];
        },
    );
    if (!casOk) {
        sessionLog(sessionId, `note-nudge: CAS exhausted for ${messageId}; skipping wire append`);
        return { ok: false, kind: "cas-exhausted" };
    }
    const committedPlan = plan as NoteNudgeDeliveryPlan | null;
    if (!committedPlan) {
        sessionLog(
            sessionId,
            "note-nudge: CAS reported success with no plan staged; treating as failure",
        );
        return { ok: false, kind: "cas-exhausted" };
    }
    if (committedPlan.kind === "conflict") {
        return { ok: false, kind: "conflict" };
    }
    db.prepare(
        "UPDATE session_meta SET note_nudge_trigger_pending = 0, note_nudge_trigger_message_id = '' WHERE session_id = ?",
    ).run(sessionId);
    return { ok: true, kind: committedPlan.kind };
}

export function appendAutoSearchHintDecision(
    db: Database,
    sessionId: string,
    entry: AutoSearchHintDecision,
): AppendAutoSearchHintOutcome {
    if (!entry.messageId) return { ok: false, kind: "cas-exhausted" };
    let staged: { kind: "appended" | "already-present"; decision: AutoSearchHintDecision } | null =
        null;
    const casOk = casUpdateJsonArrayColumn(
        db,
        sessionId,
        "auto_search_hint_decisions",
        isValidAutoSearchHintDecision,
        (current) => {
            const existing = current.find((decision) => decision.messageId === entry.messageId);
            if (existing) {
                staged = { kind: "already-present", decision: existing };
                return null;
            }
            staged = { kind: "appended", decision: entry };
            return [...current, entry];
        },
    );
    if (!casOk) return { ok: false, kind: "cas-exhausted" };
    const committed = staged as {
        kind: "appended" | "already-present";
        decision: AutoSearchHintDecision;
    } | null;
    if (!committed) {
        sessionLog(sessionId, "auto-search: CAS reported success with no staged outcome");
        return { ok: false, kind: "cas-exhausted" };
    }
    return { ok: true, kind: committed.kind, decision: committed.decision };
}

export function pruneNoteNudgeAnchors(
    db: Database,
    sessionId: string,
    visibleMessageIds: Set<string>,
): number {
    let pruned = 0;
    casUpdateJsonArrayColumn(
        db,
        sessionId,
        "note_nudge_anchors",
        isValidNoteNudgeAnchor,
        (current) => {
            const next = current.filter((anchor) => visibleMessageIds.has(anchor.messageId));
            pruned = current.length - next.length;
            return pruned > 0 ? next : null;
        },
    );
    return pruned;
}

export function pruneAutoSearchHintDecisions(
    db: Database,
    sessionId: string,
    visibleMessageIds: Set<string>,
): number {
    let pruned = 0;
    casUpdateJsonArrayColumn(
        db,
        sessionId,
        "auto_search_hint_decisions",
        isValidAutoSearchHintDecision,
        (current) => {
            const next = current.filter((decision) => visibleMessageIds.has(decision.messageId));
            pruned = current.length - next.length;
            return pruned > 0 ? next : null;
        },
    );
    return pruned;
}

export function removeNoteNudgeAnchorByMessageId(
    db: Database,
    sessionId: string,
    messageId: string,
): boolean {
    let removed = false;
    const ok = casUpdateJsonArrayColumn(
        db,
        sessionId,
        "note_nudge_anchors",
        isValidNoteNudgeAnchor,
        (current) => {
            const next = current.filter((anchor) => anchor.messageId !== messageId);
            removed = next.length !== current.length;
            return removed ? next : null;
        },
        { ensureRow: false },
    );
    return ok && removed;
}

export function removeAutoSearchHintDecisionByMessageId(
    db: Database,
    sessionId: string,
    messageId: string,
): boolean {
    let removed = false;
    const ok = casUpdateJsonArrayColumn(
        db,
        sessionId,
        "auto_search_hint_decisions",
        isValidAutoSearchHintDecision,
        (current) => {
            const next = current.filter((decision) => decision.messageId !== messageId);
            removed = next.length !== current.length;
            return removed ? next : null;
        },
        { ensureRow: false },
    );
    return ok && removed;
}

export function getPersistedTodoPermissionDenied(db: Database, sessionId: string): boolean | null {
    const row = db
        .prepare("SELECT todo_permission_denied FROM session_meta WHERE session_id = ?")
        .get(sessionId) as PersistedTodoPermissionRow | undefined;
    if (row?.todo_permission_denied === 1) return true;
    if (row?.todo_permission_denied === 0) return false;
    return null;
}

export function setPersistedTodoPermissionDenied(
    db: Database,
    sessionId: string,
    denied: boolean,
): void {
    ensureSessionMetaRow(db, sessionId);
    db.prepare("UPDATE session_meta SET todo_permission_denied = ? WHERE session_id = ?").run(
        denied ? 1 : 0,
        sessionId,
    );
}

export function getPersistedTodoSyntheticAnchor(
    db: Database,
    sessionId: string,
): PersistedTodoSyntheticAnchor | null {
    const result = db
        .prepare(
            "SELECT todo_synthetic_call_id, todo_synthetic_anchor_message_id, todo_synthetic_state_json FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);

    if (!isPersistedTodoSyntheticAnchorRow(result)) {
        return null;
    }

    if (
        result.todo_synthetic_call_id.length === 0 ||
        result.todo_synthetic_anchor_message_id.length === 0
    ) {
        return null;
    }

    return {
        callId: result.todo_synthetic_call_id,
        messageId: result.todo_synthetic_anchor_message_id,
        // stateJson may be empty for rows persisted by the pre-Finding-#1
        // version of this code path. Defer-pass replay falls back to skip
        // when stateJson is empty, which is the same behavior as before.
        stateJson: result.todo_synthetic_state_json,
    };
}

export function setPersistedTodoSyntheticAnchor(
    db: Database,
    sessionId: string,
    callId: string,
    messageId: string,
    stateJson: string,
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET todo_synthetic_call_id = ?, todo_synthetic_anchor_message_id = ?, todo_synthetic_state_json = ? WHERE session_id = ?",
        ).run(callId, messageId, stateJson, sessionId);
    })();
}

export function clearPersistedTodoSyntheticAnchor(db: Database, sessionId: string): void {
    db.prepare(
        "UPDATE session_meta SET todo_synthetic_call_id = '', todo_synthetic_anchor_message_id = '', todo_synthetic_state_json = '' WHERE session_id = ?",
    ).run(sessionId);
}

/**
 * Return the timestamp of the most recent ctx_note(read) call for this session,
 * or 0 when the session has never called it. Used by note-nudger to suppress
 * reminders when the agent has already seen notes in recent context.
 */
export function getNoteLastReadAt(db: Database, sessionId: string): number {
    try {
        const result = db
            .prepare("SELECT note_last_read_at FROM session_meta WHERE session_id = ?")
            .get(sessionId);
        if (!result || typeof result !== "object") return 0;
        const value = (result as { note_last_read_at?: unknown }).note_last_read_at;
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
    } catch {
        // Column may not exist yet on a DB that hasn't gone through
        // ensureColumn (e.g. minimal test schemas). The watermark is a
        // suppression hint, not required for correctness — return 0 so
        // the nudge flow proceeds as if ctx_note(read) has never been called.
        return 0;
    }
}

/**
 * Record that ctx_note(read) was just called for this session. The watermark is
 * compared against note updated_at / created_at on each nudge decision.
 */
export function setNoteLastReadAt(db: Database, sessionId: string, at = Date.now()): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare("UPDATE session_meta SET note_last_read_at = ? WHERE session_id = ?").run(
            at,
            sessionId,
        );
    })();
}

export function getHistorianFailureState(
    db: Database,
    sessionId: string,
): PersistedHistorianFailureState {
    const result = db
        .prepare(
            "SELECT historian_failure_count, historian_last_error, historian_last_failure_at FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);

    if (!isPersistedHistorianFailureRow(result)) {
        return getDefaultHistorianFailureState();
    }

    return {
        failureCount: result.historian_failure_count,
        lastError:
            typeof result.historian_last_error === "string" &&
            result.historian_last_error.length > 0
                ? result.historian_last_error
                : null,
        lastFailureAt:
            typeof result.historian_last_failure_at === "number"
                ? result.historian_last_failure_at
                : null,
    };
}

/** Records a failure and returns the new consecutive-failure count (callers may
 *  ignore the return). The count drives whether a failure notice is framed as
 *  transient (low count — Magic Context will just retry) or escalated to an
 *  actionable "your historian model needs attention" notice (persistent). */
export function incrementHistorianFailure(db: Database, sessionId: string, error: string): number {
    let nextCount = 1;
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const current = getHistorianFailureState(db, sessionId);
        nextCount = current.failureCount + 1;
        db.prepare(
            "UPDATE session_meta SET historian_failure_count = ?, historian_last_error = ?, historian_last_failure_at = ? WHERE session_id = ?",
        ).run(nextCount, error, Date.now(), sessionId);
        // Normalize error to single line for log greppability
        const reason = error.replace(/\s+/g, " ").trim().slice(0, 300);
        sessionLog(sessionId, `historian failure recorded: count=${nextCount} reason="${reason}"`);
    })();
    return nextCount;
}

export function clearHistorianFailureState(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET historian_failure_count = 0, historian_last_error = NULL, historian_last_failure_at = NULL WHERE session_id = ?",
        ).run(sessionId);
    })();
}

// ── Overflow detection state ──
//
// Recovery can be armed by either a provider rejection or a proactive model
// shrink check. Persisting the origin keeps restarts from conflating the two:
// only the provider's own overflow rejection is trustworthy enough for the
// transform to abort before another request. Numeric gating is deferred to the
// module-side provider-accurate estimator.

export type EmergencyRecoveryOrigin = "provider_overflow" | "proactive_model_shrink";

export interface PersistedOverflowState {
    /** Provider-reported context limit from the overflow error; 0 means none detected. */
    detectedContextLimit: number;
    /** Model key that produced the detected limit, when known. */
    detectedContextLimitModelKey: string | null;
    /** Whether the detected number is prompt-only, combined, or ambiguous. */
    detectedContextLimitProvenance: ContextLimitProvenance;
    /** True while emergency recovery is still required. */
    needsEmergencyRecovery: boolean;
    /** Why recovery was armed; null for unarmed or untyped legacy state. */
    emergencyRecoveryOrigin: EmergencyRecoveryOrigin | null;
}

function normalizeDetectedLimitModelKey(modelKey: string | null | undefined): string | null {
    return typeof modelKey === "string" && modelKey.length > 0
        ? piModelRefToCanonical(modelKey)
        : null;
}

function normalizeEmergencyRecoveryOrigin(value: unknown): EmergencyRecoveryOrigin | null {
    return value === "provider_overflow" || value === "proactive_model_shrink" ? value : null;
}

export function getOverflowState(
    db: Database,
    sessionId: string,
    modelKey?: string | null,
): PersistedOverflowState {
    const result = db
        .prepare(
            "SELECT detected_context_limit, detected_context_limit_model_key, detected_context_limit_provenance, needs_emergency_recovery, emergency_recovery_origin FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as
        | {
              detected_context_limit?: number;
              detected_context_limit_model_key?: string | null;
              detected_context_limit_provenance?: string | null;
              needs_emergency_recovery?: number;
              emergency_recovery_origin?: string | null;
          }
        | undefined;
    if (!result) {
        return {
            detectedContextLimit: 0,
            detectedContextLimitModelKey: null,
            detectedContextLimitProvenance: "unknown",
            needsEmergencyRecovery: false,
            emergencyRecoveryOrigin: null,
        };
    }
    const storedModelKey = normalizeDetectedLimitModelKey(result.detected_context_limit_model_key);
    const requestedModelKey = normalizeDetectedLimitModelKey(modelKey);
    const provenance = normalizeContextLimitProvenance(result.detected_context_limit_provenance);
    const limit =
        typeof result.detected_context_limit === "number" && result.detected_context_limit > 0
            ? result.detected_context_limit
            : 0;
    const modelMatches =
        limit > 0 && requestedModelKey && storedModelKey
            ? requestedModelKey === storedModelKey
            : true;
    const needs =
        typeof result.needs_emergency_recovery === "number" && result.needs_emergency_recovery > 0;
    const persistedOrigin = normalizeEmergencyRecoveryOrigin(result.emergency_recovery_origin);
    // Legacy provider-overflow rows predate the origin column. A positive detected
    // limit is provider proof; an untyped flag without one is not abort-eligible.
    const recoveryOrigin = needs
        ? (persistedOrigin ?? (limit > 0 ? "provider_overflow" : null))
        : null;
    return {
        detectedContextLimit: modelMatches ? limit : 0,
        detectedContextLimitModelKey: storedModelKey,
        detectedContextLimitProvenance: provenance,
        needsEmergencyRecovery: needs,
        emergencyRecoveryOrigin: recoveryOrigin,
    };
}

/**
 * Arm emergency recovery with its source. Provider overflow is the default;
 * proactive model-shrink callers must pass that origin explicitly. A parsed
 * provider limit is persisted transactionally with the arm. Repeating a provider
 * overflow while recovery is already durable records a process-local reconfirmation.
 */
export function recordOverflowDetected(
    db: Database,
    sessionId: string,
    reportedLimit: number | undefined,
    modelKey?: string | null,
    origin: EmergencyRecoveryOrigin = "provider_overflow",
    provenance: ContextLimitProvenance = "unknown",
): void {
    // Arm before the durable write so an unreadable or failed write remains fail-closed.
    emergencyRecoveryArmedSessions.add(sessionId);
    emergencyRecoveryArmedAtBySession.set(sessionId, Date.now());
    if (origin === "provider_overflow" && typeof reportedLimit === "number" && reportedLimit > 0) {
        providerOverflowKnownLimitSessions.add(sessionId);
    }
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const prior = db
            .prepare("SELECT needs_emergency_recovery FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { needs_emergency_recovery?: number } | undefined;
        if (
            origin === "provider_overflow" &&
            typeof prior?.needs_emergency_recovery === "number" &&
            prior.needs_emergency_recovery > 0
        ) {
            providerOverflowReconfirmedSessions.add(sessionId);
        }
        if (typeof reportedLimit === "number" && reportedLimit > 0) {
            db.prepare(
                "UPDATE session_meta SET detected_context_limit = ?, detected_context_limit_model_key = ?, detected_context_limit_provenance = ?, needs_emergency_recovery = 1, emergency_recovery_origin = ?, observed_safe_input_tokens = 0, cache_alert_sent = 0 WHERE session_id = ?",
            ).run(
                reportedLimit,
                normalizeDetectedLimitModelKey(modelKey),
                normalizeContextLimitProvenance(provenance),
                origin,
                sessionId,
            );
        } else {
            db.prepare(
                "UPDATE session_meta SET needs_emergency_recovery = 1, emergency_recovery_origin = ?, observed_safe_input_tokens = 0, cache_alert_sent = 0 WHERE session_id = ?",
            ).run(origin, sessionId);
        }
    })();
}

/**
 * Record the real provider-reported context limit WITHOUT arming emergency
 * recovery. Used for subagent overflow: the limit is useful data for accurate
 * pressure math (consumed by `resolveContextLimit()` via `getOverflowState()`),
 * but subagents can't run historian so the recovery flag would be orphan state.
 */
export function recordDetectedContextLimit(
    db: Database,
    sessionId: string,
    reportedLimit: number,
    modelKey?: string | null,
    provenance: ContextLimitProvenance = "unknown",
): void {
    if (!(reportedLimit > 0)) return;
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET detected_context_limit = ?, detected_context_limit_model_key = ?, detected_context_limit_provenance = ?, observed_safe_input_tokens = 0, cache_alert_sent = 0 WHERE session_id = ?",
        ).run(
            reportedLimit,
            normalizeDetectedLimitModelKey(modelKey),
            normalizeContextLimitProvenance(provenance),
            sessionId,
        );
    })();
}

/** Clear the recovery flag. Keeps the detected limit (valuable even after recovery). */
export function clearEmergencyRecovery(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        try {
            db.prepare(
                "UPDATE session_meta SET needs_emergency_recovery = 0, emergency_recovery_origin = '', recovery_no_eligible_head_count = 0 WHERE session_id = ?",
            ).run(sessionId);
        } catch {
            db.prepare(
                "UPDATE session_meta SET needs_emergency_recovery = 0, emergency_recovery_origin = '' WHERE session_id = ?",
            ).run(sessionId);
        }
    })();
    // Clear only after the durable clear succeeds.
    emergencyRecoveryArmedSessions.delete(sessionId);
    emergencyRecoveryArmedAtBySession.delete(sessionId);
    providerOverflowReconfirmedSessions.delete(sessionId);
    providerOverflowKnownLimitSessions.delete(sessionId);
}

/**
 * Clear the detected limit. Called when the session switches to a different
 * model — the old limit is no longer relevant.
 */
export function clearDetectedContextLimit(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET detected_context_limit = 0, detected_context_limit_model_key = NULL, detected_context_limit_provenance = 'unknown' WHERE session_id = ?",
        ).run(sessionId);
    })();
}

// ── Compaction marker state ──

export interface PersistedCompactionMarkerState {
    boundaryMessageId: string;
    summaryMessageId: string;
    compactionPartId: string;
    summaryPartId: string;
    /** The raw ordinal at which the boundary was set */
    boundaryOrdinal: number;
    /** OpenCode message id of the compartment target used to resolve this marker. */
    targetEndMessageId: string | null;
}

export function getPersistedCompactionMarkerState(
    db: Database,
    sessionId: string,
): PersistedCompactionMarkerState | null {
    const row = db
        .prepare(
            "SELECT compaction_marker_state, compaction_marker_target_end_message_id FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as {
        compaction_marker_state?: string;
        compaction_marker_target_end_message_id?: string | null;
    } | null;
    const raw = row?.compaction_marker_state;
    if (!raw || raw.length === 0) return null;
    try {
        const parsed = JSON.parse(raw);
        if (
            parsed &&
            typeof parsed === "object" &&
            typeof parsed.boundaryMessageId === "string" &&
            typeof parsed.summaryMessageId === "string" &&
            typeof parsed.compactionPartId === "string" &&
            typeof parsed.summaryPartId === "string" &&
            typeof parsed.boundaryOrdinal === "number"
        ) {
            const targetEndMessageId =
                typeof row?.compaction_marker_target_end_message_id === "string" &&
                row.compaction_marker_target_end_message_id.length > 0
                    ? row.compaction_marker_target_end_message_id
                    : typeof parsed.targetEndMessageId === "string" &&
                        parsed.targetEndMessageId.length > 0
                      ? parsed.targetEndMessageId
                      : null;
            return {
                ...(parsed as Omit<PersistedCompactionMarkerState, "targetEndMessageId">),
                targetEndMessageId,
            };
        }
    } catch {
        // Intentional: corrupt JSON → treat as empty
    }
    return null;
}

export function setPersistedCompactionMarkerState(
    db: Database,
    sessionId: string,
    state: PersistedCompactionMarkerState | null,
): void {
    ensureSessionMetaRow(db, sessionId);
    const json = state ? JSON.stringify(state) : "";
    db.prepare(
        "UPDATE session_meta SET compaction_marker_state = ?, compaction_marker_target_end_message_id = ? WHERE session_id = ?",
    ).run(json, state?.targetEndMessageId ?? null, sessionId);
}

// ── Stripped placeholder message IDs ──

/**
 * A session may retain seam decisions while a deferred marker catches up, but
 * the durable blob must not grow without limit when removal events are missed.
 */
export const MAX_STRIPPED_PLACEHOLDER_IDS = 4096;

interface StrippedPlaceholderState {
    ids: string[];
    hiddenSeamIds: string[];
}

function parseStrippedPlaceholderState(raw: string | null | undefined): StrippedPlaceholderState {
    if (!raw || raw.length === 0) return { ids: [], hiddenSeamIds: [] };
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
            return {
                ids: parsed.filter((value): value is string => typeof value === "string"),
                hiddenSeamIds: [],
            };
        }
        if (parsed && typeof parsed === "object") {
            const state = parsed as { ids?: unknown; hiddenSeamIds?: unknown };
            return {
                ids: Array.isArray(state.ids)
                    ? state.ids.filter((value): value is string => typeof value === "string")
                    : [],
                hiddenSeamIds: Array.isArray(state.hiddenSeamIds)
                    ? state.hiddenSeamIds.filter(
                          (value): value is string => typeof value === "string",
                      )
                    : [],
            };
        }
    } catch {
        // Intentional: corrupt JSON → treat as empty.
    }
    return { ids: [], hiddenSeamIds: [] };
}

function parseStrippedBlob(raw: string | null | undefined): string[] {
    if (!raw || raw.length === 0) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.filter((value): value is string => typeof value === "string")
            : [];
    } catch {
        return [];
    }
}

function serializeStrippedPlaceholderState(state: StrippedPlaceholderState): string {
    if (state.ids.length === 0) return "";
    if (state.hiddenSeamIds.length === 0) return JSON.stringify(state.ids);
    return JSON.stringify(state);
}

export function getStrippedPlaceholderIds(db: Database, sessionId: string): Set<string> {
    const row = db
        .prepare("SELECT stripped_placeholder_ids FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { stripped_placeholder_ids?: string } | null;
    return new Set(parseStrippedPlaceholderState(row?.stripped_placeholder_ids).ids);
}

export function getHiddenSeamPlaceholderIds(db: Database, sessionId: string): Set<string> {
    const row = db
        .prepare("SELECT stripped_placeholder_ids FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { stripped_placeholder_ids?: string } | null;
    return new Set(parseStrippedPlaceholderState(row?.stripped_placeholder_ids).hiddenSeamIds);
}

export function setStrippedPlaceholderIds(db: Database, sessionId: string, ids: Set<string>): void {
    ensureSessionMetaRow(db, sessionId);
    const bounded = [...ids].slice(-MAX_STRIPPED_PLACEHOLDER_IDS);
    const json = bounded.length > 0 ? JSON.stringify(bounded) : "";
    db.prepare("UPDATE session_meta SET stripped_placeholder_ids = ? WHERE session_id = ?").run(
        json,
        sessionId,
    );
}

/**
 * Compare-and-swap a delta onto persisted placeholder decisions. Hidden seam
 * membership is stored beside the public id set so non-Anthropic replay can
 * remove only rows that were absent from the fold wire.
 */
export function applyStrippedPlaceholderDelta(
    db: Database,
    sessionId: string,
    delta: {
        add?: Iterable<string>;
        remove?: Iterable<string>;
        hiddenSeamAdd?: Iterable<string>;
    },
): boolean {
    const add = delta.add ? [...delta.add] : [];
    const remove = delta.remove ? [...delta.remove] : [];
    const hiddenSeamAdd = delta.hiddenSeamAdd ? [...delta.hiddenSeamAdd] : [];
    if (add.length === 0 && remove.length === 0 && hiddenSeamAdd.length === 0) return true;
    ensureSessionMetaRow(db, sessionId);

    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt += 1) {
        const row = db
            .prepare("SELECT stripped_placeholder_ids FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { stripped_placeholder_ids?: string | null } | undefined;
        const rawStored = row ? (row.stripped_placeholder_ids ?? null) : null;
        const parsed = parseStrippedPlaceholderState(rawStored);
        const current = new Set(parsed.ids);
        const hiddenSeamIds = new Set(parsed.hiddenSeamIds);
        for (const id of add) current.add(id);
        for (const id of hiddenSeamAdd) {
            current.add(id);
            hiddenSeamIds.add(id);
        }
        for (const id of remove) {
            current.delete(id);
            hiddenSeamIds.delete(id);
        }
        const boundedIds = [...current].slice(-MAX_STRIPPED_PLACEHOLDER_IDS);
        const boundedSet = new Set(boundedIds);
        const nextBlob = serializeStrippedPlaceholderState({
            ids: boundedIds,
            hiddenSeamIds: [...hiddenSeamIds].filter((id) => boundedSet.has(id)),
        });
        if (nextBlob === (rawStored ?? "")) return true;
        const result = db
            .prepare(
                "UPDATE session_meta SET stripped_placeholder_ids = ? WHERE session_id = ? AND stripped_placeholder_ids IS ?",
            )
            .run(nextBlob, sessionId, rawStored);
        if (result.changes > 0) return true;
    }
    sessionLog(sessionId, `stripped_placeholder_ids CAS: ${CAS_RETRY_LIMIT} retries exhausted`);
    return false;
}

export function removeStrippedPlaceholderId(
    db: Database,
    sessionId: string,
    messageId: string,
): boolean {
    const before = getStrippedPlaceholderIds(db, sessionId);
    if (!before.has(messageId)) return false;
    applyStrippedPlaceholderDelta(db, sessionId, { remove: [messageId] });
    return true;
}

// ── State for retrying Fable 5.1 requests after a thinking-prefix binding rejection ──

export const NEWEST_REASONING_BEARING_ASSISTANT = "newest_reasoning_bearing_assistant";
export const THINKING_BINDING_RECOVERY_FROZEN_PREFIX = "binding_mismatch:";

export function thinkingBindingRecoveryFrozenId(messageId: string): string {
    return `${THINKING_BINDING_RECOVERY_FROZEN_PREFIX}${messageId}`;
}

export function getThinkingBindingRecoveryTarget(db: Database, sessionId: string): string | null {
    const row = db
        .prepare("SELECT thinking_binding_recovery_target FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { thinking_binding_recovery_target?: string | null } | undefined;
    const target = row?.thinking_binding_recovery_target;
    return typeof target === "string" && target.length > 0 ? target : null;
}

/**
 * Persist the provider-supplied assistant id. When no id is available, store a
 * marker that makes the next live transform select the newest assistant that
 * still contains reasoning.
 */
export function armThinkingBindingRecovery(
    db: Database,
    sessionId: string,
    messageId?: string,
): void {
    ensureSessionMetaRow(db, sessionId);
    const target =
        typeof messageId === "string" && messageId.length > 0
            ? messageId
            : NEWEST_REASONING_BEARING_ASSISTANT;
    if (target === NEWEST_REASONING_BEARING_ASSISTANT) {
        // A later session.error without an id must not replace a more precise id
        // already captured from message.updated or the provider error body.
        db.prepare(
            "UPDATE session_meta SET thinking_binding_recovery_target = ? WHERE session_id = ? AND COALESCE(thinking_binding_recovery_target, '') = ''",
        ).run(target, sessionId);
        return;
    }
    db.prepare(
        "UPDATE session_meta SET thinking_binding_recovery_target = ? WHERE session_id = ?",
    ).run(target, sessionId);
}

/** Clear only the flag this live pass actually applied; a concurrent re-arm wins. */
export function clearThinkingBindingRecoveryIf(
    db: Database,
    sessionId: string,
    expectedTarget: string,
): boolean {
    const result = db
        .prepare(
            "UPDATE session_meta SET thinking_binding_recovery_target = '' WHERE session_id = ? AND thinking_binding_recovery_target = ?",
        )
        .run(sessionId, expectedTarget);
    return result.changes > 0;
}

// ── Merged-assistant reasoning stripped IDs (frozen replay watermark) ──

/**
 * Assistant message ids and versioned exact-part decisions whose merged-run
 * reasoning neutralization was first-applied on a cache-busting pass. Bare ids
 * retain legacy layout-dependent replay until an applying pass freezes parts.
 * Exact-part decisions survive fresh host rebuilds and changing adjacency;
 * the applied set never shrinks while the session exists.
 */
export function getMergedReasoningStrippedIds(db: Database, sessionId: string): Set<string> {
    const row = db
        .prepare("SELECT merged_reasoning_stripped_ids FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { merged_reasoning_stripped_ids?: string } | null;
    return new Set(parseStrippedBlob(row?.merged_reasoning_stripped_ids));
}

/**
 * Atomically merge assistant message ids into the persisted applied set. Persistence
 * must succeed before callers first mutate newly detected messages; otherwise a
 * later defer pass could not reproduce those bytes from a fresh rebuild.
 */
export function addMergedReasoningStrippedIds(
    db: Database,
    sessionId: string,
    ids: Iterable<string>,
): boolean {
    const add = [...ids];
    if (add.length === 0) return true;
    ensureSessionMetaRow(db, sessionId);

    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt += 1) {
        const row = db
            .prepare("SELECT merged_reasoning_stripped_ids FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { merged_reasoning_stripped_ids?: string | null } | undefined;
        const rawStored = row ? (row.merged_reasoning_stripped_ids ?? null) : null;
        const current = new Set<string>(parseStrippedBlob(rawStored));
        const frozenParts = readFrozenMergedReasoningParts(current);
        let changed = false;
        for (const id of add) {
            const decision = decodeMergedReasoningParts(id);
            // The first successful persistence fixes the exact reasoning parts.
            // Concurrent transforms must replay that selection rather than
            // replace it with a different plan for the same assistant.
            if (decision && frozenParts.has(decision[0])) continue;
            if (!current.has(id)) {
                current.add(id);
                if (decision) frozenParts.set(...decision);
                changed = true;
            }
        }
        if (!changed) return true;
        const nextBlob = JSON.stringify([...current]);
        const result = db
            .prepare(
                "UPDATE session_meta SET merged_reasoning_stripped_ids = ? WHERE session_id = ? AND merged_reasoning_stripped_ids IS ?",
            )
            .run(nextBlob, sessionId, rawStored);
        if (result.changes > 0) return true;
    }
    sessionLog(
        sessionId,
        `merged_reasoning_stripped_ids CAS: ${CAS_RETRY_LIMIT} retries exhausted`,
    );
    return false;
}

// ── Trailing assistant blank decisions (frozen replay map) ──

export type PersistedTrailingBlankDecision = "keep" | `keep:${number}` | "strip";

function isPersistedTrailingBlankDecision(value: unknown): value is PersistedTrailingBlankDecision {
    if (value === "keep" || value === "strip") return true;
    if (typeof value !== "string" || !value.startsWith("keep:")) return false;
    const countText = value.slice("keep:".length);
    if (!/^[1-9]\d*$/.test(countText)) return false;
    const count = Number(countText);
    return Number.isSafeInteger(count) && count > 1 && count <= 10_000;
}

function parseTrailingBlankDecisions(
    raw: string | null | undefined,
): Map<string, PersistedTrailingBlankDecision> {
    if (!raw) return new Map();
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
        const decisions = new Map<string, PersistedTrailingBlankDecision>();
        for (const [id, decision] of Object.entries(parsed)) {
            if (id.length > 0 && isPersistedTrailingBlankDecision(decision)) {
                decisions.set(id, decision);
            }
        }
        return decisions;
    } catch {
        return new Map();
    }
}

/**
 * Read each assistant's replay choice. A historical choice is immutable; the live
 * newest assistant may replace its choice until a later assistant freezes it.
 */
export function getTrailingBlankDecisions(
    db: Database,
    sessionId: string,
): Map<string, PersistedTrailingBlankDecision> {
    const row = db
        .prepare("SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { trailing_blank_decisions?: string } | null;
    return parseTrailingBlankDecisions(row?.trailing_blank_decisions);
}

/**
 * Persist new decisions, optionally refreshing the still-live newest assistant.
 * A persisted strip is absorbing; only keep decisions may refresh their count or
 * demote to strip.
 */
export function addTrailingBlankDecisions(
    db: Database,
    sessionId: string,
    additions: Iterable<readonly [string, PersistedTrailingBlankDecision]>,
    options?: { overwriteMessageId?: string },
): boolean {
    const add = [...additions];
    if (add.length === 0) return true;
    ensureSessionMetaRow(db, sessionId);

    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt += 1) {
        const row = db
            .prepare("SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { trailing_blank_decisions?: string | null } | undefined;
        const rawStored = row ? (row.trailing_blank_decisions ?? null) : null;
        const current = parseTrailingBlankDecisions(rawStored);
        let changed = false;
        for (const [id, decision] of add) {
            const currentDecision = current.get(id);
            if (
                currentDecision === undefined ||
                (id === options?.overwriteMessageId &&
                    currentDecision !== decision &&
                    currentDecision !== "strip")
            ) {
                current.set(id, decision);
                changed = true;
            }
        }
        if (!changed) return true;
        const nextBlob = JSON.stringify(Object.fromEntries(current));
        const result = db
            .prepare(
                "UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ? AND trailing_blank_decisions IS ?",
            )
            .run(nextBlob, sessionId, rawStored);
        if (result.changes > 0) return true;
    }
    sessionLog(sessionId, `trailing_blank_decisions CAS: ${CAS_RETRY_LIMIT} retries exhausted`);
    return false;
}

/**
 * Convert keep decisions that would incorrectly preserve trailing blank content to strip
 * without advancing the session metadata boundary. Returns the IDs changed by this call,
 * or null when compare-and-swap retries are exhausted.
 */
export function demoteTrailingBlankKeepDecisions(
    db: Database,
    sessionId: string,
    messageIds: Iterable<string>,
): string[] | null {
    const ids = new Set(messageIds);
    if (ids.size === 0) return [];
    ensureSessionMetaRow(db, sessionId);

    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt += 1) {
        const row = db
            .prepare("SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { trailing_blank_decisions?: string | null } | undefined;
        const rawStored = row ? (row.trailing_blank_decisions ?? null) : null;
        const current = parseTrailingBlankDecisions(rawStored);
        const demotedIds: string[] = [];
        for (const id of ids) {
            const decision = current.get(id);
            if (decision === "keep" || decision?.startsWith("keep:") === true) {
                current.set(id, "strip");
                demotedIds.push(id);
            }
        }
        if (demotedIds.length === 0) return [];
        const nextBlob = JSON.stringify(Object.fromEntries(current));
        const result = db
            .prepare(
                "UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ? AND trailing_blank_decisions IS ?",
            )
            .run(nextBlob, sessionId, rawStored);
        if (result.changes > 0) return demotedIds;
    }
    sessionLog(
        sessionId,
        `trailing_blank_decisions demotion CAS: ${CAS_RETRY_LIMIT} retries exhausted`,
    );
    return null;
}

// ── Stale ctx_reduce stripped message IDs (frozen replay watermark) ──

/**
 * Message ids whose ctx_reduce parts have been sentinel-stripped because they
 * aged past the protected window. This set is the FROZEN replay watermark for
 * `dropStaleReduceCalls`: it advances ONLY on cache-busting passes (where the
 * wire is allowed to change) and is replayed verbatim on every pass. Replaying
 * a frozen id set — instead of recomputing a live `messages.length - protected`
 * boundary every pass — is what keeps defer passes byte-identical: tail growth
 * can never push an older ctx_reduce call past a moving boundary and strip it
 * mid-prefix on a defer pass (which busts the Anthropic prompt cache).
 */
export function getStaleReduceStrippedIds(db: Database, sessionId: string): Set<string> {
    const row = db
        .prepare("SELECT stale_reduce_stripped_ids FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { stale_reduce_stripped_ids?: string } | null;
    return new Set(parseStrippedBlob(row?.stale_reduce_stripped_ids));
}

/**
 * CAS-merge new aged ctx_reduce message ids into the frozen set, retrying on a
 * concurrent write so sibling processes sharing the session DB merge instead of
 * clobbering. Returns true when the set ended in the intended state (incl.
 * no-op), false only when retries were exhausted.
 */
export function addStaleReduceStrippedIds(
    db: Database,
    sessionId: string,
    ids: Iterable<string>,
): boolean {
    const add = [...ids];
    if (add.length === 0) return true;
    ensureSessionMetaRow(db, sessionId);

    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt += 1) {
        const row = db
            .prepare("SELECT stale_reduce_stripped_ids FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { stale_reduce_stripped_ids?: string | null } | undefined;
        const rawStored = row ? (row.stale_reduce_stripped_ids ?? null) : null;
        const current = new Set<string>(parseStrippedBlob(rawStored));
        let changed = false;
        for (const id of add) {
            if (!current.has(id)) {
                current.add(id);
                changed = true;
            }
        }
        if (!changed) return true;
        const nextBlob = JSON.stringify([...current]);
        const result = db
            .prepare(
                "UPDATE session_meta SET stale_reduce_stripped_ids = ? WHERE session_id = ? AND stale_reduce_stripped_ids IS ?",
            )
            .run(nextBlob, sessionId, rawStored);
        if (result.changes > 0) return true;
    }
    sessionLog(sessionId, `stale_reduce_stripped_ids CAS: ${CAS_RETRY_LIMIT} retries exhausted`);
    return false;
}

/**
 * Message ids whose processed-image file parts have been sentinel-stripped.
 * Frozen replay watermark for `stripProcessedImages`, identical in purpose to
 * `stale_reduce_stripped_ids`: it advances ONLY on cache-busting passes and is
 * replayed verbatim every pass, so an aged image message can never have its
 * images first-removed on a defer pass (which busts the Anthropic prompt cache,
 * because the empty sentinel is filtered off the Anthropic wire).
 */
export function getProcessedImageStrippedIds(db: Database, sessionId: string): Set<string> {
    const row = db
        .prepare("SELECT processed_image_stripped_ids FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { processed_image_stripped_ids?: string } | null;
    return new Set(parseStrippedBlob(row?.processed_image_stripped_ids));
}

/**
 * CAS-merge new processed-image message ids into the frozen set, retrying on a
 * concurrent write so sibling processes sharing the session DB merge instead of
 * clobbering. Returns true when the set ended in the intended state (incl.
 * no-op), false only when retries were exhausted.
 */
export function addProcessedImageStrippedIds(
    db: Database,
    sessionId: string,
    ids: Iterable<string>,
): boolean {
    const add = [...ids];
    if (add.length === 0) return true;
    ensureSessionMetaRow(db, sessionId);

    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt += 1) {
        const row = db
            .prepare("SELECT processed_image_stripped_ids FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { processed_image_stripped_ids?: string | null } | undefined;
        const rawStored = row ? (row.processed_image_stripped_ids ?? null) : null;
        const current = new Set<string>(parseStrippedBlob(rawStored));
        let changed = false;
        for (const id of add) {
            if (!current.has(id)) {
                current.add(id);
                changed = true;
            }
        }
        if (!changed) return true;
        const nextBlob = JSON.stringify([...current]);
        const result = db
            .prepare(
                "UPDATE session_meta SET processed_image_stripped_ids = ? WHERE session_id = ? AND processed_image_stripped_ids IS ?",
            )
            .run(nextBlob, sessionId, rawStored);
        if (result.changes > 0) return true;
    }
    sessionLog(sessionId, `processed_image_stripped_ids CAS: ${CAS_RETRY_LIMIT} retries exhausted`);
    return false;
}

// ── Pending compaction marker state (plan v6 deferred drain) ──

/**
 * Payload stored in `session_meta.pending_compaction_marker_state` between
 * a background historian/compressor publish and its consuming pass in the
 * transform. The transform's drain step CAS-compares this blob against its
 * own copy so concurrent publishers don't double-clear.
 *
 * `endMessageId` lets the consuming pass validate the marker target is still
 * present (raw OpenCode message + compartment row), then write
 * `PersistedCompactionMarkerState` and clear pending atomically.
 *
 * Stored as a JSON string via `stableStringify` for byte-identical CAS.
 * Absence is signalled as SQL NULL, NEVER as `""` — the migration v13 column
 * is intentionally declared without a DEFAULT clause and is excluded from
 * `healNullTextColumns`.
 */
export interface PendingCompactionMarker {
    /** Raw ordinal at which the marker should land. */
    ordinal: number;
    /** OpenCode message ID at the end of the compartment target. */
    endMessageId: string;
    /** Unix ms of publication. Diagnostic only; used by doctor stale-pending checks. */
    publishedAt: number;
}

export interface DeferredExecutePayload {
    id: string;
    reason: string;
    recordedAt: number;
}

/** Type guard for a parsed PendingCompactionMarker payload. */
function isPendingCompactionMarker(value: unknown): value is PendingCompactionMarker {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { ordinal?: unknown }).ordinal === "number" &&
        typeof (value as { endMessageId?: unknown }).endMessageId === "string" &&
        typeof (value as { publishedAt?: unknown }).publishedAt === "number"
    );
}

export function getPendingCompactionMarkerState(
    db: Database,
    sessionId: string,
): PendingCompactionMarker | null {
    const row = db
        .prepare("SELECT pending_compaction_marker_state FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { pending_compaction_marker_state?: string | null } | null;
    const raw = row?.pending_compaction_marker_state;
    // Defensive: NULL is the canonical absence, but legacy / cross-version
    // writes might still put `""` here. Both treated as absent.
    if (raw === null || raw === undefined || raw === "") return null;
    try {
        const parsed = JSON.parse(raw);
        if (isPendingCompactionMarker(parsed)) {
            return parsed;
        }
    } catch {
        // Intentional: corrupt JSON → treat as absent. Next publish will
        // overwrite cleanly; next consuming pass will read the new value.
    }
    return null;
}

/**
 * Write or clear the pending-marker blob.
 *
 * Setting `state === null` writes SQL NULL (NOT `""`) so the absence sentinel
 * stays consistent across upgrades. Stringification uses `stableStringify`
 * so callers can later CAS-compare with the same serializer.
 */
export function setPendingCompactionMarkerState(
    db: Database,
    sessionId: string,
    state: PendingCompactionMarker | null,
): void {
    ensureSessionMetaRow(db, sessionId);
    const blob = state ? stableStringify(state) : null;
    db.prepare(
        "UPDATE session_meta SET pending_compaction_marker_state = ? WHERE session_id = ?",
    ).run(blob, sessionId);
}

/**
 * Compare-and-swap clear: only writes NULL when the currently-stored blob
 * matches `expected` byte-for-byte. Returns true if the CAS succeeded (we
 * cleared the row), false if the row had drifted (another publish overwrote
 * it; that publish's own consuming pass owns the heal).
 *
 * Used by the transform postprocess drain to clear pending without racing
 * a newer background publish: if Publish A's drain reads blob_X then Publish
 * B overwrites with blob_Y before A's CAS runs, A's CAS fails and B's
 * pending stays intact for B's own next consuming pass.
 */
export function clearPendingCompactionMarkerStateIf(
    db: Database,
    sessionId: string,
    expected: PendingCompactionMarker,
): boolean {
    const expectedBlob = stableStringify(expected);
    const result = db
        .prepare(
            `UPDATE session_meta SET pending_compaction_marker_state = NULL
             WHERE session_id = ? AND pending_compaction_marker_state = ?`,
        )
        .run(sessionId, expectedBlob);
    return result.changes > 0;
}

// ── Pending Pi compaction marker state (Pi deferred native compaction drain) ──

/**
 * Payload stored in `session_meta.pending_pi_compaction_marker_state` between
 * a Pi historian/recomp publication and the next materializing Pi context pass.
 * Stored with `stableStringify` so CAS clear can compare byte-for-byte.
 */
export interface PendingPiCompactionMarker {
    /** Null until a later Pi context projection exposes a replayable kept entry. */
    firstKeptEntryId: string | null;
    endMessageId: string;
    ordinal: number;
    tokensBefore: number;
    summary: string;
    publishedAt: number;
}

function isPendingPiCompactionMarker(value: unknown): value is PendingPiCompactionMarker {
    return (
        typeof value === "object" &&
        value !== null &&
        ((value as { firstKeptEntryId?: unknown }).firstKeptEntryId === null ||
            typeof (value as { firstKeptEntryId?: unknown }).firstKeptEntryId === "string") &&
        typeof (value as { endMessageId?: unknown }).endMessageId === "string" &&
        typeof (value as { ordinal?: unknown }).ordinal === "number" &&
        typeof (value as { tokensBefore?: unknown }).tokensBefore === "number" &&
        typeof (value as { summary?: unknown }).summary === "string" &&
        typeof (value as { publishedAt?: unknown }).publishedAt === "number"
    );
}

export function getPendingPiCompactionMarkerState(
    db: Database,
    sessionId: string,
): PendingPiCompactionMarker | null {
    const row = db
        .prepare("SELECT pending_pi_compaction_marker_state FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { pending_pi_compaction_marker_state?: string | null } | null;
    const raw = row?.pending_pi_compaction_marker_state;
    // Defensive: NULL is the canonical absence, but legacy / cross-version
    // writes might still put `""` here. Both treated as absent.
    if (raw === null || raw === undefined || raw === "") return null;
    try {
        const parsed = JSON.parse(raw);
        if (isPendingPiCompactionMarker(parsed)) {
            return parsed;
        }
    } catch {
        // Fall through to clear malformed durable state below.
    }
    db.prepare(
        "UPDATE session_meta SET pending_pi_compaction_marker_state = NULL WHERE session_id = ? AND pending_pi_compaction_marker_state = ?",
    ).run(sessionId, raw);
    return null;
}

export function setPendingPiCompactionMarkerState(
    db: Database,
    sessionId: string,
    state: PendingPiCompactionMarker | null,
): void {
    ensureSessionMetaRow(db, sessionId);
    const blob = state ? stableStringify(state) : null;
    db.prepare(
        "UPDATE session_meta SET pending_pi_compaction_marker_state = ? WHERE session_id = ?",
    ).run(blob, sessionId);
}

export function clearPendingPiCompactionMarkerStateIf(
    db: Database,
    sessionId: string,
    expected: PendingPiCompactionMarker,
): boolean {
    const expectedBlob = stableStringify(expected);
    const result = db
        .prepare(
            `UPDATE session_meta SET pending_pi_compaction_marker_state = NULL
             WHERE session_id = ? AND pending_pi_compaction_marker_state = ?`,
        )
        .run(sessionId, expectedBlob);
    return result.changes > 0;
}

export function getSessionsWithPendingPiMarker(db: Database): string[] {
    const rows = db
        .prepare(
            `SELECT session_id FROM session_meta
             WHERE pending_pi_compaction_marker_state IS NOT NULL
               AND pending_pi_compaction_marker_state != ''`,
        )
        .all() as Array<{ session_id: string }>;
    return rows.map((r) => r.session_id);
}

export function peekDeferredExecutePending(
    db: Database,
    sessionId: string,
): DeferredExecutePayload | null {
    const row = db
        .prepare("SELECT deferred_execute_state FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { deferred_execute_state?: string | null } | null;
    const raw = row?.deferred_execute_state;
    // Defensive: NULL is the canonical absence, but legacy / cross-version
    // writes might still put `""` here. Both treated as absent.
    if (raw === null || raw === undefined || raw === "") return null;
    try {
        return JSON.parse(raw) as DeferredExecutePayload;
    } catch {
        return null;
    }
}

export function setDeferredExecutePendingIfAbsent(
    db: Database,
    sessionId: string,
    payload: DeferredExecutePayload,
): boolean {
    ensureSessionMetaRow(db, sessionId);
    const payloadBlob = stableStringify(payload);
    const result = db
        .prepare(
            `UPDATE session_meta SET deferred_execute_state = ?
             WHERE session_id = ? AND deferred_execute_state IS NULL`,
        )
        .run(payloadBlob, sessionId);
    return result.changes > 0;
}

export function clearDeferredExecutePendingIfMatches(
    db: Database,
    sessionId: string,
    expected: DeferredExecutePayload,
): boolean {
    const expectedBlob = stableStringify(expected);
    const result = db
        .prepare(
            `UPDATE session_meta SET deferred_execute_state = NULL
             WHERE session_id = ? AND deferred_execute_state = ?`,
        )
        .run(sessionId, expectedBlob);
    return result.changes > 0;
}

/**
 * List all sessions with a deferred marker still pending. Used at hook init
 * to re-seed `deferredHistoryRefreshSessions` and
 * `deferredMaterializationSessions` after a plugin restart — without this,
 * a publish that ran before a crash would lose its deferred-history signal
 * and the next transform pass would not consume the marker.
 *
 * Defensive `!= ''` filter: even though setter writes NULL, an earlier
 * codepath or external write could have left an empty string. Treat both as
 * absent.
 */
export function getSessionsWithPendingMarker(db: Database): string[] {
    const rows = db
        .prepare(
            `SELECT session_id FROM session_meta
             WHERE pending_compaction_marker_state IS NOT NULL
               AND pending_compaction_marker_state != ''`,
        )
        .all() as Array<{ session_id: string }>;
    return rows.map((r) => r.session_id);
}

export function setSessionWorkMetrics(
    db: Database,
    sessionId: string,
    newWorkTokens: number,
    totalInputTokens: number,
): void {
    ensureSessionMetaRow(db, sessionId);
    db.prepare(
        `UPDATE session_meta
         SET new_work_tokens = ?, total_input_tokens = ?
         WHERE session_id = ?`,
    ).run(
        Math.max(0, Math.floor(newWorkTokens)),
        Math.max(0, Math.floor(totalInputTokens)),
        sessionId,
    );
}

export function getSessionWorkMetrics(
    db: Database,
    sessionId: string,
): { newWorkTokens: number; totalInputTokens: number } {
    const row = db
        .prepare(
            "SELECT new_work_tokens, total_input_tokens FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as {
        new_work_tokens?: number | null;
        total_input_tokens?: number | null;
    } | null;
    return {
        newWorkTokens: typeof row?.new_work_tokens === "number" ? row.new_work_tokens : 0,
        totalInputTokens: typeof row?.total_input_tokens === "number" ? row.total_input_tokens : 0,
    };
}
