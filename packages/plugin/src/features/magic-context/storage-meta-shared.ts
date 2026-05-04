import { getHarness } from "../../shared/harness";
import type { Database } from "../../shared/sqlite";
import type { SessionMeta } from "./types";

export interface SessionMetaRow {
    session_id: string;
    last_response_time: number;
    cache_ttl: string;
    counter: number;
    last_nudge_tokens: number;
    last_nudge_band: string;
    last_transform_error: string;
    is_subagent: number;
    last_context_percentage: number;
    last_input_tokens: number;
    times_execute_threshold_reached: number;
    compartment_in_progress: number;
    // Intentional: type is string (MD5 hex digest), but the guard accepts string|number
    // for backward compatibility with pre-release DBs where the column was INTEGER.
    system_prompt_hash: string | number;
    system_prompt_tokens: number;
    conversation_tokens: number;
    tool_call_tokens: number;
    cleared_reasoning_through_tag: number;
}

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
    timesExecuteThresholdReached: "times_execute_threshold_reached",
    compartmentInProgress: "compartment_in_progress",
    systemPromptHash: "system_prompt_hash",
    systemPromptTokens: "system_prompt_tokens",
    conversationTokens: "conversation_tokens",
    toolCallTokens: "tool_call_tokens",
    clearedReasoningThroughTag: "cleared_reasoning_through_tag",
};

export const BOOLEAN_META_KEYS = new Set(["isSubagent", "compartmentInProgress"]);

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

export function isSessionMetaRow(row: unknown): row is SessionMetaRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.session_id === "string" &&
        typeof r.last_response_time === "number" &&
        isStringOrNull(r.cache_ttl) &&
        typeof r.counter === "number" &&
        typeof r.last_nudge_tokens === "number" &&
        isStringOrNull(r.last_nudge_band) &&
        isStringOrNull(r.last_transform_error) &&
        typeof r.is_subagent === "number" &&
        typeof r.last_context_percentage === "number" &&
        typeof r.last_input_tokens === "number" &&
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
        isNumberOrNull(r.cleared_reasoning_through_tag)
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
        timesExecuteThresholdReached: 0,
        compartmentInProgress: false,
        systemPromptHash: "",
        systemPromptTokens: 0,
        conversationTokens: 0,
        toolCallTokens: 0,
        clearedReasoningThroughTag: 0,
    };
}

export function ensureSessionMetaRow(db: Database, sessionId: string): void {
    const defaults = getDefaultSessionMeta(sessionId);
    // Note-nudge persistence columns rely on session_meta defaults and are updated
    // through storage-meta-persisted helpers, not SessionMeta writes.
    db.prepare(
        "INSERT OR IGNORE INTO session_meta (session_id, harness, last_response_time, cache_ttl, counter, last_nudge_tokens, last_nudge_band, last_transform_error, is_subagent, last_context_percentage, last_input_tokens, times_execute_threshold_reached, compartment_in_progress, system_prompt_hash, cleared_reasoning_through_tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        sessionId,
        getHarness(),
        defaults.lastResponseTime,
        defaults.cacheTtl,
        defaults.counter,
        defaults.lastNudgeTokens,
        defaults.lastNudgeBand ?? "",
        defaults.lastTransformError ?? "",
        defaults.isSubagent ? 1 : 0,
        defaults.lastContextPercentage,
        defaults.lastInputTokens,
        defaults.timesExecuteThresholdReached,
        defaults.compartmentInProgress ? 1 : 0,
        defaults.systemPromptHash ?? "",
        defaults.clearedReasoningThroughTag,
    );
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
    // Defensive numeric fallbacks: when isSessionMetaRow accepts NULL for
    // INTEGER columns added via ensureColumn, the raw row may have `null`
    // here. Coerce to 0 so callers see a usable SessionMeta without having
    // to null-check every scalar field.
    const numOrZero = (value: unknown): number => (typeof value === "number" ? value : 0);
    return {
        sessionId: row.session_id,
        lastResponseTime: row.last_response_time,
        cacheTtl: cacheTtlRaw,
        counter: row.counter,
        lastNudgeTokens: row.last_nudge_tokens,
        lastNudgeBand:
            nudgeBandRaw.length > 0 ? (nudgeBandRaw as SessionMeta["lastNudgeBand"]) : null,
        lastTransformError: transformErrorRaw.length > 0 ? transformErrorRaw : null,
        isSubagent: row.is_subagent === 1,
        lastContextPercentage: row.last_context_percentage,
        lastInputTokens: row.last_input_tokens,
        timesExecuteThresholdReached: numOrZero(row.times_execute_threshold_reached),
        compartmentInProgress: row.compartment_in_progress === 1,
        systemPromptHash: String(systemPromptHashRaw),
        systemPromptTokens: numOrZero(row.system_prompt_tokens),
        conversationTokens: numOrZero(row.conversation_tokens),
        toolCallTokens: numOrZero(row.tool_call_tokens),
        clearedReasoningThroughTag: numOrZero(row.cleared_reasoning_through_tag),
    };
}
