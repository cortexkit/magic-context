import { Buffer } from "node:buffer";
import { getHarness } from "../../shared/harness";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import { type Database, prepareCachedStatement, type Statement } from "../../shared/sqlite";
import type { SessionMeta } from "./types";

export interface SessionMetaRow {
    session_id: string;
    last_response_time: number | null;
    cache_ttl: string;
    counter: number;
    last_nudge_tokens: number;
    last_nudge_band: string;
    last_transform_error: string;
    is_subagent: number | null;
    last_context_percentage: number;
    last_input_tokens: number;
    observed_safe_input_tokens: number;
    cache_alert_sent: number;
    times_execute_threshold_reached: number;
    compartment_in_progress: number;
    // Intentional: type is string (MD5 hex digest), but the guard accepts string|number
    // for backward compatibility with pre-release DBs where the column was INTEGER.
    system_prompt_hash: string | number;
    system_prompt_tokens: number;
    conversation_tokens: number;
    tool_call_tokens: number;
    cleared_reasoning_through_tag: number;
    tool_reclaim_watermark: number | null;
    last_todo_state: string;
    cached_m0_bytes: Buffer | Uint8Array | null;
    cached_m0_mural_data_url: string | null;
    cached_m0_mural_hash: string | null;
    cached_m1_bytes: Buffer | Uint8Array | null;
    cached_m0_project_memory_epoch: number | null;
    cached_m0_workspace_fingerprint: string | null;
    cached_m0_project_user_profile_version: number | null;
    cached_m0_max_compartment_seq: number | null;
    cached_m0_max_memory_id: number | null;
    cached_m0_max_mutation_id: number | null;
    cached_m0_max_memory_mutation_id: number | null;
    cached_m0_project_docs_hash: string | null;
    cached_m0_materialized_at: number | null;
    cached_m0_session_facts_version: number | null;
    cached_m0_upgrade_state: string | null;
    cached_m0_system_hash: string | null;
    cached_m0_tool_set_hash: string | null;
    cached_m0_model_key: string | null;
    cached_m0_project_identity: string | null;
    last_observed_model_key: string | null;
    last_usage_context_limit: number | null;
    prior_boundary_ordinal: number | null;
    protected_tail_policy_version: number | null;
    protected_tail_drain_window_started_at: number | null;
    protected_tail_drain_tokens: number | null;
    recovery_no_eligible_head_count: number | null;
    force_emergency_bypass_window_start: number | null;
    force_emergency_bypass_used: number | null;
    emergency_drain_active: number | null;
    historian_drain_failure_at: number | null;
    upgrade_reminded_at: number | null;
    upgrade_reminder_last_sent_at: number | null;
    upgrade_reminder_count: number | null;
    pi_stable_id_scheme: number | null;
}

export const SESSION_META_SELECT_COLUMNS = [
    "session_id",
    "last_response_time",
    "cache_ttl",
    "counter",
    "last_nudge_tokens",
    "last_nudge_band",
    "last_transform_error",
    "is_subagent",
    "last_context_percentage",
    "last_input_tokens",
    "observed_safe_input_tokens",
    "cache_alert_sent",
    "times_execute_threshold_reached",
    "compartment_in_progress",
    "system_prompt_hash",
    "system_prompt_tokens",
    "conversation_tokens",
    "tool_call_tokens",
    "cleared_reasoning_through_tag",
    "tool_reclaim_watermark",
    "last_todo_state",
    "cached_m0_bytes",
    "cached_m0_mural_data_url",
    "cached_m0_mural_hash",
    "cached_m1_bytes",
    "cached_m0_project_memory_epoch",
    "cached_m0_workspace_fingerprint",
    "cached_m0_project_user_profile_version",
    "cached_m0_max_compartment_seq",
    "cached_m0_max_memory_id",
    "cached_m0_max_mutation_id",
    "cached_m0_max_memory_mutation_id",
    "cached_m0_project_docs_hash",
    "cached_m0_materialized_at",
    "cached_m0_session_facts_version",
    "cached_m0_upgrade_state",
    "cached_m0_system_hash",
    "cached_m0_tool_set_hash",
    "cached_m0_model_key",
    "cached_m0_project_identity",
    "last_observed_model_key",
    "last_usage_context_limit",
    "prior_boundary_ordinal",
    "protected_tail_policy_version",
    "protected_tail_drain_window_started_at",
    "protected_tail_drain_tokens",
    "recovery_no_eligible_head_count",
    "force_emergency_bypass_window_start",
    "force_emergency_bypass_used",
    "emergency_drain_active",
    "historian_drain_failure_at",
    "upgrade_reminded_at",
    "upgrade_reminder_last_sent_at",
    "upgrade_reminder_count",
    "pi_stable_id_scheme",
] as const;

export const META_COLUMNS: Record<string, string> = {
    lastResponseTime: "last_response_time",
    cacheTtl: "cache_ttl",
    counter: "counter",
    lastNudgeTokens: "last_nudge_tokens",
    lastNudgeBand: "last_nudge_band",
    lastTransformError: "last_transform_error",
    isSubagent: "is_subagent",
    lastContextPercentage: "last_context_percentage",
    lastInputTokens: "last_input_tokens",
    observedSafeInputTokens: "observed_safe_input_tokens",
    cacheAlertSent: "cache_alert_sent",
    timesExecuteThresholdReached: "times_execute_threshold_reached",
    compartmentInProgress: "compartment_in_progress",
    systemPromptHash: "system_prompt_hash",
    systemPromptTokens: "system_prompt_tokens",
    conversationTokens: "conversation_tokens",
    toolCallTokens: "tool_call_tokens",
    clearedReasoningThroughTag: "cleared_reasoning_through_tag",
    toolReclaimWatermark: "tool_reclaim_watermark",
    lastTodoState: "last_todo_state",
    cachedM0Bytes: "cached_m0_bytes",
    cachedM0MuralDataUrl: "cached_m0_mural_data_url",
    cachedM0MuralHash: "cached_m0_mural_hash",
    cachedM1Bytes: "cached_m1_bytes",
    cachedM0ProjectMemoryEpoch: "cached_m0_project_memory_epoch",
    cachedM0WorkspaceFingerprint: "cached_m0_workspace_fingerprint",
    cachedM0ProjectUserProfileVersion: "cached_m0_project_user_profile_version",
    cachedM0MaxCompartmentSeq: "cached_m0_max_compartment_seq",
    cachedM0MaxMemoryId: "cached_m0_max_memory_id",
    cachedM0MaxMutationId: "cached_m0_max_mutation_id",
    cachedM0MaxMemoryMutationId: "cached_m0_max_memory_mutation_id",
    cachedM0ProjectDocsHash: "cached_m0_project_docs_hash",
    cachedM0MaterializedAt: "cached_m0_materialized_at",
    cachedM0SessionFactsVersion: "cached_m0_session_facts_version",
    cachedM0UpgradeState: "cached_m0_upgrade_state",
    cachedM0SystemHash: "cached_m0_system_hash",
    cachedM0ToolSetHash: "cached_m0_tool_set_hash",
    cachedM0ModelKey: "cached_m0_model_key",
    cachedM0ProjectIdentity: "cached_m0_project_identity",
    lastObservedModelKey: "last_observed_model_key",
    lastUsageContextLimit: "last_usage_context_limit",
    priorBoundaryOrdinal: "prior_boundary_ordinal",
    protectedTailPolicyVersion: "protected_tail_policy_version",
    protectedTailDrainWindowStartedAt: "protected_tail_drain_window_started_at",
    protectedTailDrainTokens: "protected_tail_drain_tokens",
    recoveryNoEligibleHeadCount: "recovery_no_eligible_head_count",
    forceEmergencyBypassWindowStart: "force_emergency_bypass_window_start",
    forceEmergencyBypassUsed: "force_emergency_bypass_used",
    emergencyDrainActive: "emergency_drain_active",
    historianDrainFailureAt: "historian_drain_failure_at",
    upgradeRemindedAt: "upgrade_reminded_at",
    upgradeReminderLastSentAt: "upgrade_reminder_last_sent_at",
    upgradeReminderCount: "upgrade_reminder_count",
    piStableIdScheme: "pi_stable_id_scheme",
};

export const BOOLEAN_META_KEYS = new Set(["isSubagent", "compartmentInProgress", "cacheAlertSent"]);

function ensureSessionFactsVersionColumn(db: Database): void {
    const rows = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name?: string }>;
    if (!rows.some((row) => row.name === "session_facts_version")) {
        db.exec(
            "ALTER TABLE session_meta ADD COLUMN session_facts_version INTEGER NOT NULL DEFAULT 0",
        );
    }
}

export const NULL_BIND_META_KEYS = new Set([
    "cachedM0Bytes",
    "cachedM0MuralDataUrl",
    "cachedM0MuralHash",
    "cachedM1Bytes",
    "cachedM0ProjectMemoryEpoch",
    "cachedM0WorkspaceFingerprint",
    "cachedM0ProjectUserProfileVersion",
    "cachedM0MaxCompartmentSeq",
    "cachedM0MaxMemoryId",
    "cachedM0MaxMutationId",
    "cachedM0MaxMemoryMutationId",
    "cachedM0ProjectDocsHash",
    "cachedM0MaterializedAt",
    "cachedM0SessionFactsVersion",
    "cachedM0UpgradeState",
    "cachedM0ProjectIdentity",
    "lastObservedModelKey",
    "upgradeRemindedAt",
    "upgradeReminderLastSentAt",
    "piStableIdScheme",
]);

// Defensive typeof checks: columns may be NULL in DB when a row was seeded
// before a column was added with ensureColumn (SQLite sets existing rows to
// NULL, not to the DEFAULT). Treat null as "absent/empty" rather than
// rejecting the whole row — falling back to defaults silently loses the real
// lastResponseTime, cacheTtl, lastContextPercentage, etc., causing the
// scheduler to always return "execute" and pending ops to re-apply across
// every turn (cache bust cascade).
function isStringOrNull(value: unknown): boolean {
    return value === null || typeof value === "string";
}

function isNumberOrNull(value: unknown): boolean {
    return value === null || typeof value === "number";
}

function isBlobOrNull(value: unknown): boolean {
    return value === null || Buffer.isBuffer(value) || value instanceof Uint8Array;
}

function toBufferOrNull(value: Buffer | Uint8Array | null): Buffer | null {
    if (value === null) return null;
    if (Buffer.isBuffer(value)) return value;
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

export function isSessionMetaRow(row: unknown): row is SessionMetaRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.session_id === "string" &&
        // session_id proves row existence; NULL here means the nullable timestamp is unset.
        isNumberOrNull(r.last_response_time) &&
        isStringOrNull(r.cache_ttl) &&
        typeof r.counter === "number" &&
        typeof r.last_nudge_tokens === "number" &&
        isStringOrNull(r.last_nudge_band) &&
        isStringOrNull(r.last_transform_error) &&
        isNumberOrNull(r.is_subagent) &&
        typeof r.last_context_percentage === "number" &&
        typeof r.last_input_tokens === "number" &&
        isNumberOrNull(r.observed_safe_input_tokens) &&
        isNumberOrNull(r.cache_alert_sent) &&
        // INTEGER columns added via ensureColumn: pre-existing rows get NULL
        // instead of DEFAULT. Strict typeof "number" would reject those rows
        // and trigger the scheduler-reset cascade described above. toSessionMeta
        // falls back to 0 for NULL.
        isNumberOrNull(r.times_execute_threshold_reached) &&
        isNumberOrNull(r.compartment_in_progress) &&
        (r.system_prompt_hash === null ||
            typeof r.system_prompt_hash === "string" ||
            typeof r.system_prompt_hash === "number") &&
        isNumberOrNull(r.system_prompt_tokens) &&
        isNumberOrNull(r.conversation_tokens) &&
        isNumberOrNull(r.tool_call_tokens) &&
        isNumberOrNull(r.cleared_reasoning_through_tag) &&
        isStringOrNull(r.last_todo_state) &&
        isBlobOrNull(r.cached_m0_bytes) &&
        isStringOrNull(r.cached_m0_mural_data_url) &&
        isStringOrNull(r.cached_m0_mural_hash) &&
        isBlobOrNull(r.cached_m1_bytes) &&
        isNumberOrNull(r.cached_m0_project_memory_epoch) &&
        isStringOrNull(r.cached_m0_workspace_fingerprint) &&
        isNumberOrNull(r.cached_m0_project_user_profile_version) &&
        isNumberOrNull(r.cached_m0_max_compartment_seq) &&
        isNumberOrNull(r.cached_m0_max_memory_id) &&
        isNumberOrNull(r.cached_m0_max_mutation_id) &&
        isNumberOrNull(r.cached_m0_max_memory_mutation_id) &&
        isStringOrNull(r.cached_m0_project_docs_hash) &&
        isNumberOrNull(r.cached_m0_materialized_at) &&
        isNumberOrNull(r.cached_m0_session_facts_version) &&
        isStringOrNull(r.cached_m0_upgrade_state) &&
        isStringOrNull(r.cached_m0_system_hash) &&
        isStringOrNull(r.cached_m0_tool_set_hash) &&
        isStringOrNull(r.cached_m0_model_key) &&
        isStringOrNull(r.cached_m0_project_identity) &&
        isStringOrNull(r.last_observed_model_key) &&
        isNumberOrNull(r.last_usage_context_limit) &&
        isNumberOrNull(r.prior_boundary_ordinal) &&
        isNumberOrNull(r.protected_tail_policy_version) &&
        isNumberOrNull(r.protected_tail_drain_window_started_at) &&
        isNumberOrNull(r.protected_tail_drain_tokens) &&
        isNumberOrNull(r.recovery_no_eligible_head_count) &&
        isNumberOrNull(r.force_emergency_bypass_window_start) &&
        isNumberOrNull(r.force_emergency_bypass_used) &&
        isNumberOrNull(r.upgrade_reminded_at) &&
        isNumberOrNull(r.upgrade_reminder_last_sent_at) &&
        isNumberOrNull(r.upgrade_reminder_count) &&
        isNumberOrNull(r.pi_stable_id_scheme) &&
        isNumberOrNull(r.tool_reclaim_watermark)
    );
}

export function getDefaultSessionMeta(sessionId: string): SessionMeta {
    return {
        sessionId,
        lastResponseTime: 0,
        cacheTtl: "5m",
        counter: 0,
        lastNudgeTokens: 0,
        lastNudgeBand: null,
        lastTransformError: null,
        isSubagent: false,
        lastContextPercentage: 0,
        lastInputTokens: 0,
        observedSafeInputTokens: 0,
        cacheAlertSent: false,
        timesExecuteThresholdReached: 0,
        compartmentInProgress: false,
        systemPromptHash: "",
        systemPromptTokens: 0,
        conversationTokens: 0,
        toolCallTokens: 0,
        clearedReasoningThroughTag: 0,
        toolReclaimWatermark: 0,
        lastTodoState: "",
        cachedM0Bytes: null,
        cachedM0MuralDataUrl: null,
        cachedM0MuralHash: null,
        cachedM1Bytes: null,
        cachedM0ProjectMemoryEpoch: null,
        cachedM0WorkspaceFingerprint: null,
        cachedM0ProjectUserProfileVersion: null,
        cachedM0MaxCompartmentSeq: null,
        cachedM0MaxMemoryId: null,
        cachedM0MaxMutationId: null,
        cachedM0MaxMemoryMutationId: null,
        cachedM0ProjectDocsHash: null,
        cachedM0MaterializedAt: null,
        cachedM0SessionFactsVersion: null,
        cachedM0UpgradeState: null,
        cachedM0SystemHash: null,
        cachedM0ToolSetHash: null,
        cachedM0ModelKey: null,
        cachedM0ProjectIdentity: null,
        lastObservedModelKey: null,
        lastUsageContextLimit: 0,
        priorBoundaryOrdinal: 1,
        protectedTailPolicyVersion: 0,
        protectedTailDrainWindowStartedAt: 0,
        protectedTailDrainTokens: 0,
        recoveryNoEligibleHeadCount: 0,
        forceEmergencyBypassWindowStart: 0,
        forceEmergencyBypassUsed: 0,
        upgradeRemindedAt: null,
        upgradeReminderLastSentAt: null,
        upgradeReminderCount: 0,
        piStableIdScheme: null,
    };
}

const sessionMetaExistsStatements = new WeakMap<Database, Statement>();

export function ensureSessionMetaRow(
    db: Database,
    sessionId: string,
    initialIsSubagent: boolean | null = getHarness() === "opencode2" ? null : false,
): void {
    // OC2 callers that only write metadata have not read the host parent yet.
    // Keep that classification unknown until getOrCreateSessionMeta resolves it.
    let exists = sessionMetaExistsStatements.get(db);
    if (!exists) {
        exists = prepareCachedStatement(db, "SELECT 1 FROM session_meta WHERE session_id = ?");
        sessionMetaExistsStatements.set(db, exists);
    }
    // Most callers already have a row. Even INSERT OR IGNORE takes the writer
    // lock, so a read must not wait on sibling hosts merely to ensure it exists.
    // Keep INSERT OR IGNORE for the race where another host creates it first.
    if (exists.get(sessionId)) return;
    const defaults = getDefaultSessionMeta(sessionId);
    // Note-nudge persistence columns rely on session_meta defaults and are updated
    // through storage-meta-persisted helpers, not SessionMeta writes.
    db.prepare(
        "INSERT OR IGNORE INTO session_meta (session_id, harness, last_response_time, cache_ttl, counter, last_nudge_tokens, last_nudge_band, last_transform_error, is_subagent, last_context_percentage, last_input_tokens, observed_safe_input_tokens, cache_alert_sent, times_execute_threshold_reached, compartment_in_progress, system_prompt_hash, cleared_reasoning_through_tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        sessionId,
        getHarness(),
        defaults.lastResponseTime,
        defaults.cacheTtl,
        defaults.counter,
        defaults.lastNudgeTokens,
        defaults.lastNudgeBand ?? "",
        defaults.lastTransformError ?? "",
        initialIsSubagent === null ? null : initialIsSubagent ? 1 : 0,
        defaults.lastContextPercentage,
        defaults.lastInputTokens,
        defaults.observedSafeInputTokens,
        defaults.cacheAlertSent ? 1 : 0,
        defaults.timesExecuteThresholdReached,
        defaults.compartmentInProgress ? 1 : 0,
        defaults.systemPromptHash ?? "",
        defaults.clearedReasoningThroughTag,
    );
}

/**
 * Increment the session facts version after a wholesale session_facts replacement.
 *
 * Transaction contract: callers must invoke this inside the same write transaction
 * that deletes/inserts the session_facts rows. This helper deliberately does not
 * create its own transaction so there is no race window between the data write
 * and the version bump.
 */
export function bumpSessionFactsVersion(db: Database, sessionId: string): void {
    ensureSessionFactsVersionColumn(db);
    ensureSessionMetaRow(db, sessionId);
    db.prepare(
        "UPDATE session_meta SET session_facts_version = COALESCE(session_facts_version, 0) + 1 WHERE session_id = ?",
    ).run(sessionId);
}

export function toSessionMeta(row: SessionMetaRow): SessionMeta {
    // Defensive: NULL text columns (e.g. seeded rows pre-ensureColumn) must not
    // crash with `.length on null`. Treat null/empty as absent and map to the
    // SessionMeta representation.
    const nudgeBandRaw = typeof row.last_nudge_band === "string" ? row.last_nudge_band : "";
    const transformErrorRaw =
        typeof row.last_transform_error === "string" ? row.last_transform_error : "";
    const cacheTtlRaw =
        typeof row.cache_ttl === "string" && row.cache_ttl.length > 0 ? row.cache_ttl : "5m";
    const systemPromptHashRaw = row.system_prompt_hash == null ? "" : row.system_prompt_hash;
    const lastTodoStateRaw = typeof row.last_todo_state === "string" ? row.last_todo_state : "";
    // Defensive numeric fallbacks: when isSessionMetaRow accepts NULL for
    // INTEGER columns added via ensureColumn, the raw row may have `null`
    // here. Coerce to 0 so callers see a usable SessionMeta without having
    // to null-check every scalar field.
    const numOrZero = (value: unknown): number => (typeof value === "number" ? value : 0);
    const numOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);
    const stringOrNull = (value: unknown): string | null =>
        typeof value === "string" ? value : null;
    return {
        sessionId: row.session_id,
        lastResponseTime: numOrZero(row.last_response_time),
        cacheTtl: cacheTtlRaw,
        counter: row.counter,
        lastNudgeTokens: row.last_nudge_tokens,
        lastNudgeBand:
            nudgeBandRaw.length > 0 ? (nudgeBandRaw as SessionMeta["lastNudgeBand"]) : null,
        lastTransformError: transformErrorRaw.length > 0 ? transformErrorRaw : null,
        isSubagent: row.is_subagent === 1,
        lastContextPercentage: row.last_context_percentage,
        lastInputTokens: row.last_input_tokens,
        observedSafeInputTokens: numOrZero(row.observed_safe_input_tokens),
        cacheAlertSent: numOrZero(row.cache_alert_sent) === 1,
        timesExecuteThresholdReached: numOrZero(row.times_execute_threshold_reached),
        compartmentInProgress: row.compartment_in_progress === 1,
        systemPromptHash: String(systemPromptHashRaw),
        systemPromptTokens: numOrZero(row.system_prompt_tokens),
        conversationTokens: numOrZero(row.conversation_tokens),
        toolCallTokens: numOrZero(row.tool_call_tokens),
        clearedReasoningThroughTag: numOrZero(row.cleared_reasoning_through_tag),
        toolReclaimWatermark: numOrZero(row.tool_reclaim_watermark),
        lastTodoState: lastTodoStateRaw,
        cachedM0Bytes: toBufferOrNull(row.cached_m0_bytes),
        cachedM0MuralDataUrl: stringOrNull(row.cached_m0_mural_data_url),
        cachedM0MuralHash: stringOrNull(row.cached_m0_mural_hash),
        cachedM1Bytes: toBufferOrNull(row.cached_m1_bytes),
        cachedM0ProjectMemoryEpoch: numOrNull(row.cached_m0_project_memory_epoch),
        cachedM0WorkspaceFingerprint: stringOrNull(row.cached_m0_workspace_fingerprint),
        cachedM0ProjectUserProfileVersion: numOrNull(row.cached_m0_project_user_profile_version),
        cachedM0MaxCompartmentSeq: numOrNull(row.cached_m0_max_compartment_seq),
        cachedM0MaxMemoryId: numOrNull(row.cached_m0_max_memory_id),
        cachedM0MaxMutationId: numOrNull(row.cached_m0_max_mutation_id),
        cachedM0MaxMemoryMutationId: numOrNull(row.cached_m0_max_memory_mutation_id),
        cachedM0ProjectDocsHash: stringOrNull(row.cached_m0_project_docs_hash),
        cachedM0MaterializedAt: numOrNull(row.cached_m0_materialized_at),
        cachedM0SessionFactsVersion: numOrNull(row.cached_m0_session_facts_version),
        cachedM0UpgradeState: stringOrNull(row.cached_m0_upgrade_state),
        cachedM0SystemHash: stringOrNull(row.cached_m0_system_hash),
        cachedM0ToolSetHash: stringOrNull(row.cached_m0_tool_set_hash),
        cachedM0ModelKey: stringOrNull(row.cached_m0_model_key),
        cachedM0ProjectIdentity: stringOrNull(row.cached_m0_project_identity),
        lastObservedModelKey: stringOrNull(row.last_observed_model_key),
        lastUsageContextLimit: numOrZero(row.last_usage_context_limit),
        priorBoundaryOrdinal: Math.max(1, numOrZero(row.prior_boundary_ordinal) || 1),
        protectedTailPolicyVersion: numOrZero(row.protected_tail_policy_version),
        protectedTailDrainWindowStartedAt: numOrZero(row.protected_tail_drain_window_started_at),
        protectedTailDrainTokens: numOrZero(row.protected_tail_drain_tokens),
        recoveryNoEligibleHeadCount: numOrZero(row.recovery_no_eligible_head_count),
        forceEmergencyBypassWindowStart: numOrZero(row.force_emergency_bypass_window_start),
        forceEmergencyBypassUsed: numOrZero(row.force_emergency_bypass_used),
        upgradeRemindedAt: numOrNull(row.upgrade_reminded_at),
        upgradeReminderLastSentAt: numOrNull(row.upgrade_reminder_last_sent_at),
        upgradeReminderCount: numOrZero(row.upgrade_reminder_count),
        piStableIdScheme: numOrNull(row.pi_stable_id_scheme),
    };
}

export interface PersistCachedM0Payload {
    m0Bytes: Buffer;
    muralDataUrl?: string | null;
    muralHash?: string | null;
    projectMemoryEpoch: number | null;
    workspaceFingerprint?: string | null;
    projectUserProfileVersion: number | null;
    maxCompartmentSeq: number;
    maxMemoryId: number | null;
    maxMutationId: number | null;
    maxMemoryMutationId?: number | null;
    m1Bytes?: Buffer | null;
    projectDocsHash: string | null;
    materializedAt: number;
    sessionFactsVersion: number;
    upgradeState: string | null;
    systemHash?: string | null;
    toolSetHash?: string | null;
    modelKey?: string | null;
    projectIdentity?: string | null;
}

export function persistCachedM0(
    db: Database,
    sessionId: string,
    payload: PersistCachedM0Payload,
): void {
    ensureSessionMetaRow(db, sessionId);
    db.prepare(
        `UPDATE session_meta SET
            cached_m0_bytes = ?,
            cached_m0_mural_data_url = ?,
            cached_m0_mural_hash = ?,
            cached_m0_project_memory_epoch = ?,
            cached_m0_workspace_fingerprint = ?,
            cached_m0_project_user_profile_version = ?,
            cached_m0_max_compartment_seq = ?,
            cached_m0_max_memory_id = ?,
            cached_m0_max_mutation_id = ?,
            cached_m0_max_memory_mutation_id = ?,
            cached_m1_bytes = ?,
            cached_m0_project_docs_hash = ?,
            cached_m0_materialized_at = ?,
            cached_m0_session_facts_version = ?,
            cached_m0_upgrade_state = ?,
            cached_m0_system_hash = ?,
            cached_m0_tool_set_hash = ?,
            cached_m0_model_key = ?,
            cached_m0_project_identity = ?
         WHERE session_id = ?`,
    ).run(
        Buffer.from(payload.m0Bytes),
        payload.muralDataUrl ?? null,
        payload.muralHash ?? null,
        payload.projectMemoryEpoch,
        payload.workspaceFingerprint ?? null,
        payload.projectUserProfileVersion,
        payload.maxCompartmentSeq,
        payload.maxMemoryId,
        payload.maxMutationId,
        payload.maxMemoryMutationId ?? null,
        payload.m1Bytes ? Buffer.from(payload.m1Bytes) : null,
        payload.projectDocsHash,
        payload.materializedAt,
        payload.sessionFactsVersion,
        payload.upgradeState,
        payload.systemHash ?? "",
        payload.toolSetHash ?? "",
        payload.modelKey ? piModelRefToCanonical(payload.modelKey) : "",
        payload.projectIdentity ?? null,
        sessionId,
    );
}

export function clearCachedM0M1(db: Database, sessionId: string): void {
    ensureSessionMetaRow(db, sessionId);
    const existingColumns = new Set(
        (db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name?: string }>).map(
            (column) => column.name,
        ),
    );
    const clears: Array<[string, string | number | null]> = [
        ["cached_m0_bytes", null],
        ["cached_m0_mural_data_url", null],
        ["cached_m0_mural_hash", null],
        ["cached_m1_bytes", null],
        ["cached_m0_project_memory_epoch", null],
        ["cached_m0_workspace_fingerprint", null],
        ["cached_m0_project_user_profile_version", null],
        ["cached_m0_max_compartment_seq", null],
        ["cached_m0_max_memory_id", null],
        ["cached_m0_max_mutation_id", null],
        ["cached_m0_max_memory_mutation_id", null],
        ["cached_m0_project_docs_hash", null],
        ["cached_m0_materialized_at", null],
        ["cached_m0_session_facts_version", null],
        ["cached_m0_upgrade_state", null],
        ["cached_m0_system_hash", null],
        ["cached_m0_tool_set_hash", null],
        ["cached_m0_model_key", null],
        ["cached_m0_project_identity", null],
        ["cached_m0_last_baseline_end_message_id", null],
        ["memory_block_cache", ""],
        ["memory_block_count", 0],
        ["memory_block_ids", ""],
    ];
    const setClauses: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [column, value] of clears) {
        if (!existingColumns.has(column)) continue;
        setClauses.push(`${column} = ?`);
        values.push(value);
    }
    if (setClauses.length === 0) return;
    db.prepare(`UPDATE session_meta SET ${setClauses.join(", ")} WHERE session_id = ?`).run(
        ...values,
        sessionId,
    );
}

export function clearCachedM0(db: Database, sessionId: string): void {
    clearCachedM0M1(db, sessionId);
}
