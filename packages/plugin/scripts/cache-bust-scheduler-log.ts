import { readFileSync } from "node:fs";
import { getMagicContextLogPath } from "../src/shared/data-path";
import type { CacheBustDecisionAttribution } from "./cache-bust-attribution";

const SCHEDULER_LINE =
    /^\[([^\]]+)\] \[magic-context\]\[([^\]]+)\] transform scheduler: .*\binputTokens=(\d+)\b.*\bdecision=(execute|defer)\b/;
const APPLY_LINE =
    /^\[([^\]]+)\] \[magic-context\]\[([^\]]+)\] pending ops WILL APPLY — reason=(.*?), pendingOps=/;
const RUST_PASS_LINE =
    /^\[([^\]]+)\] \[magic-context\]\[([^\]]+)\] rust pass: decision=(HARD|SOFT\+?|DEFER) reason=([^ ]+).*\bin=(\d+)\b/;
/** The pass logs its apply decision within the same pass, a beat after the scheduler line. */
const APPLY_JOIN_MS = 5_000;

/** Scheduler lines cover TS defers that have no durable transform_decisions row. */
export function schedulerLogDecisions(text: string, sessionId: string): CacheBustDecisionAttribution[] {
    const decisions: CacheBustDecisionAttribution[] = [];
    for (const line of text.split("\n")) {
        const match = SCHEDULER_LINE.exec(line);
        if (match) {
            if (match[2] !== sessionId) continue;
            const timestampMs = Date.parse(match[1]);
            if (!Number.isFinite(timestampMs)) continue;
            decisions.push({ timestampMs, decision: match[4], materialized: false, materializeReason: null,
                emergency: false, droppedTokens: 0, droppedCount: 0, inputTokens: Number(match[3]), flush: false,
                source: "transform scheduler log" });
            continue;
        }
        // "pending ops WILL APPLY" names the reclaim ride that authorized the
        // mutation. Attach it to the pass that just logged its scheduler line, so
        // a drain that rode freshly published history can be told apart from an
        // ordinary execute refresh.
        const apply = APPLY_LINE.exec(line);
        if (!apply || apply[2] !== sessionId) continue;
        const appliedAtMs = Date.parse(apply[1]);
        const pass = decisions.at(-1);
        if (!pass || !Number.isFinite(appliedAtMs)) continue;
        if (appliedAtMs < pass.timestampMs || appliedAtMs - pass.timestampMs > APPLY_JOIN_MS) continue;
        pass.appliedRide = /\bride=([A-Za-z+]+)/.exec(apply[3])?.[1] ?? apply[3];
    }
    return decisions.sort((a, b) => a.timestampMs - b.timestampMs);
}

function rustPassLogDecisions(
    text: string,
    sessionId: string,
): CacheBustDecisionAttribution[] {
    return text.split("\n").flatMap((line) => {
        const match = RUST_PASS_LINE.exec(line);
        if (!match || match[2] !== sessionId) return [];
        const timestampMs = Date.parse(match[1]);
        if (!Number.isFinite(timestampMs)) return [];
        const reason = match[4] === "none" ? null : match[4];
        const release = reason?.startsWith("lkg_frozen_release:")
            ? reason.slice("lkg_frozen_release:".length).split(";materialize_reason=")[0]
            : undefined;
        const identityDelta = /\bidentity_delta=([^ ]+)/.exec(line)?.[1]
            ?.split(",")
            .filter(Boolean);
        return [{
            timestampMs,
            decision: match[3],
            canonicalDecision: match[3],
            materialized: reason !== null,
            materializeReason: reason,
            lkgFrozenReleaseReason: release,
            emergency: false,
            droppedTokens: 0,
            droppedCount: 0,
            inputTokens: 0,
            inputCount: Number(match[5]),
            identityDelta,
            flush: reason === "explicit_flush" || reason === "user_flush",
            source: "rust pass log",
        }];
    });
}

const LOG_PREFIX = /^\[([^\]]+)\] \[magic-context\]\[([^\]]+)\] (.*)$/;

/** Removal logs are host evidence, not transform passes, so they never claim a pass join. */
export function messageRemovalLogMarkers(text: string, sessionId: string): CacheBustDecisionAttribution[] {
    return text.split("\n").flatMap((line) => {
        const match = LOG_PREFIX.exec(line);
        if (!match || match[2] !== sessionId || !match[3].startsWith("event message.removed:")) return [];
        const timestampMs = Date.parse(match[1]);
        if (!Number.isFinite(timestampMs)) return [];
        return [{ timestampMs, decision: "host_event", materialized: false, materializeReason: null,
            emergency: false, droppedTokens: 0, droppedCount: 0, inputTokens: 0, flush: false,
            source: "host message removal log", disruption: "host_messages_removed" }];
    });
}

/**
 * Name the disruption a Rust adapter log line records, if any. These explain an
 * epoch HARD that follows within a minute: the module failed or asked for full
 * arrays, the adapter served a fallback, or the adapter process started fresh
 * (its first ordinal read of a session is a cold whole-session prime).
 */
function disruptionKind(body: string): string | undefined {
    if (/\bretry=full\b/.test(body)) return "full_retry";
    if (/^rust pass: decision=(error|need_full_sync|parked)\b/.test(body)) return "module_fault";
    if (/^rust pass: .*\bserved_from=(raw|lkg)\b/.test(body)) return "fallback_serve";
    if (/\bstage=rust\.ordinal_rebuild\b.*\bcause=cold\b/.test(body)) return "adapter_restart";
    return undefined;
}

export function disruptionLogMarkers(
    text: string,
    sessionId: string,
): CacheBustDecisionAttribution[] {
    return text.split("\n").flatMap((line) => {
        const match = LOG_PREFIX.exec(line);
        if (!match || match[2] !== sessionId) return [];
        const kind = disruptionKind(match[3]);
        if (!kind) return [];
        const timestampMs = Date.parse(match[1]);
        if (!Number.isFinite(timestampMs)) return [];
        return [{
            timestampMs,
            decision: "disruption",
            materialized: false,
            materializeReason: null,
            emergency: false,
            droppedTokens: 0,
            droppedCount: 0,
            inputTokens: 0,
            flush: false,
            source: "rust adapter log",
            disruption: kind,
        }];
    });
}

export function withSchedulerLogFallback(
    decisions: readonly CacheBustDecisionAttribution[],
    sessionId: string,
    logPath: string | null = getMagicContextLogPath("opencode"),
): CacheBustDecisionAttribution[] {
    if (logPath === null) return [...decisions];
    let text: string;
    try { text = readFileSync(logPath, "utf8"); }
    catch { return [...decisions]; }
    const logged = schedulerLogDecisions(text, sessionId);
    const rustPasses = rustPassLogDecisions(text, sessionId);
    const fallback = logged.filter((pass, index) => {
        // A completed row is richer evidence than its scheduler line. Do not let
        // a previous pass's row hide a later defer, even inside the join window.
        const next = logged[index + 1]?.timestampMs ?? Number.POSITIVE_INFINITY;
        return !decisions.some(row => row.timestampMs >= pass.timestampMs && row.timestampMs < next && row.timestampMs - pass.timestampMs <= 30_000);
    });
    return [...decisions, ...fallback, ...rustPasses, ...disruptionLogMarkers(text, sessionId), ...messageRemovalLogMarkers(text, sessionId)];
}
