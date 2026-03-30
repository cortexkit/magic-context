import type { Database } from "bun:sqlite";
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
    clearedReasoningThroughTag: "cleared_reasoning_through_tag",
};

export const BOOLEAN_META_KEYS = new Set(["isSubagent", "compartmentInProgress"]);

export function isSessionMetaRow(row: unknown): row is SessionMetaRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.session_id === "string" &&
        typeof r.last_response_time === "number" &&
        typeof r.cache_ttl === "string" &&
        typeof r.counter === "number" &&
        typeof r.last_nudge_tokens === "number" &&
        typeof r.last_nudge_band === "string" &&
        typeof r.last_transform_error === "string" &&
        typeof r.is_subagent === "number" &&
        typeof r.last_context_percentage === "number" &&
        typeof r.last_input_tokens === "number" &&
        typeof r.times_execute_threshold_reached === "number" &&
        typeof r.compartment_in_progress === "number" &&
        (typeof r.system_prompt_hash === "string" || typeof r.system_prompt_hash === "number") &&
        typeof r.cleared_reasoning_through_tag === "number"
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
        clearedReasoningThroughTag: 0,
    };
}

export function ensureSessionMetaRow(db: Database, sessionId: string): void {
    const defaults = getDefaultSessionMeta(sessionId);
    // Note-nudge persistence columns rely on session_meta defaults and are updated
    // through storage-meta-persisted helpers, not SessionMeta writes.
    db.prepare(
        "INSERT OR IGNORE INTO session_meta (session_id, last_response_time, cache_ttl, counter, last_nudge_tokens, last_nudge_band, last_transform_error, is_subagent, last_context_percentage, last_input_tokens, times_execute_threshold_reached, compartment_in_progress, system_prompt_hash, cleared_reasoning_through_tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        sessionId,
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
    return {
        sessionId: row.session_id,
        lastResponseTime: row.last_response_time,
        cacheTtl: row.cache_ttl,
        counter: row.counter,
        lastNudgeTokens: row.last_nudge_tokens,
        lastNudgeBand:
            row.last_nudge_band.length > 0
                ? (row.last_nudge_band as SessionMeta["lastNudgeBand"])
                : null,
        lastTransformError: row.last_transform_error.length > 0 ? row.last_transform_error : null,
        isSubagent: row.is_subagent === 1,
        lastContextPercentage: row.last_context_percentage,
        lastInputTokens: row.last_input_tokens,
        timesExecuteThresholdReached: row.times_execute_threshold_reached,
        compartmentInProgress: row.compartment_in_progress === 1,
        systemPromptHash: String(row.system_prompt_hash),
        clearedReasoningThroughTag: row.cleared_reasoning_through_tag,
    };
}
