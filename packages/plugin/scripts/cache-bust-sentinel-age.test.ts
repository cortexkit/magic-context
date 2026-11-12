import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../src/shared/test-temp-dir";
import type { AnalyzedCacheRequest } from "./cache-bust-attribution";
import {
    __test, type CacheBustEvent, type CacheBustSentinelOptions, DEFAULT_MAX_WAKE_AGE_MS,
    loadSentinelState, parseSentinelArgs, runSentinelOnce, saveSentinelState, SubcWakeEventTransport,
} from "./cache-bust-sentinel";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const minute = 60_000;
const session = { sessionId: "ses_age", harness: "opencode" as const, projectPath: "dir:fixture", activityMs: 1 };
function options(): CacheBustSentinelOptions {
    const directory = createTestTempDirFromPath(join(tmpdir(), "sentinel-age-"));
    directories.push(directory);
    return { once: true, send: true, intervalMs: minute, lookbackMs: 5 * minute,
        stateFile: join(directory, "state.json"), databasePath: join(directory, "missing.db"),
        rustStorePath: join(directory, "missing-rust.db"), connectionFile: join(directory, "missing.json"),
        wakeModuleId: "prefrontal-core", wakeAgentId: "fixture-agent", wakeFromAgent: "sentinel" };
}
function request(timestampMs: number, divergenceClass: AnalyzedCacheRequest["divergenceClass"] = "no_mc_pass_row"): AnalyzedCacheRequest {
    return { session: session.sessionId, at: new Date(timestampMs).toISOString(), timestampMs,
        verdict: "BUST", divergenceClass, rewrittenTokens: 81_726, firstDivergence: "message[0]", analyzerCmd: "fixture-analyzer" };
}

test("wake age defaults to 30 minutes and requires a positive CLI override", () => {
    expect(parseSentinelArgs(["bun", "sentinel"]).maxWakeAgeMs).toBe(DEFAULT_MAX_WAKE_AGE_MS);
    expect(parseSentinelArgs(["bun", "sentinel", "--max-wake-age-ms", "900000"]).maxWakeAgeMs).toBe(900_000);
    for (const value of ["0", "-1", "NaN"]) expect(() => parseSentinelArgs(["bun", "sentinel", "--max-wake-age-ms", value])).toThrow("positive integer");
});

test("a resumed old watermark is clamped to the wake horizon, not the initial lookback", async () => {
    const opts = options();
    const now = 3 * 24 * 60 * minute;
    const state = __test.defaultState();
    state.sessions[session.sessionId] = { lastAnalyzedRequestTimestampMs: minute };
    saveSentinelState(opts.stateFile, state);
    const events: CacheBustEvent[] = [];
    let seenSince = 0;
    await runSentinelOnce(opts, { now: () => now, listActiveSessions: () => [session], loadDecisions: () => [],
        analyzeSession: async (_, since) => { seenSince = since; return { requests: [request(now - 10 * minute)], highWaterMarkMs: now - 10 * minute }; },
        transport: { record: async (event) => { events.push(event); return { disposition: "delivered", committed_order: 1 }; } },
        stdout: () => {}, stderr: () => {} });
    expect(seenSince).toBe(now - 30 * minute);
    expect(events).toHaveLength(1);
});

test("an old-watermark window expiring during analysis persists once as stale and advances the watermark", async () => {
    const opts = options();
    const start = 3 * 24 * 60 * minute;
    const at = start - 29 * minute;
    const state = __test.defaultState();
    state.sessions[session.sessionId] = { lastAnalyzedRequestTimestampMs: minute };
    saveSentinelState(opts.stateFile, state);
    let now = start;
    let sent = 0;
    const deps = { now: () => now, listActiveSessions: () => [session], loadDecisions: () => [],
        analyzeSession: async () => { now += 2 * minute; return { requests: [request(at, "full_body_no_baseline")], highWaterMarkMs: at }; },
        transport: { record: async () => { sent++; return { disposition: "delivered", committed_order: 1 }; } }, stdout: () => {}, stderr: () => {} };
    await runSentinelOnce(opts, deps);
    const observed = loadSentinelState(opts.stateFile);
    expect(sent).toBe(0);
    expect(Object.values(observed.suppressedWindows)).toEqual([
        { divergenceClass: "full_body_no_baseline", rewrittenTokens: 81_726, windowStartMs: at, reason: "stale" },
    ]);
    expect(observed.sessions[session.sessionId].lastAnalyzedRequestTimestampMs).toBe(at);
    expect(observed.windows).toEqual({});
    await runSentinelOnce(opts, deps);
    expect(loadSentinelState(opts.stateFile).suppressedWindows).toEqual(observed.suppressedWindows);
    expect(sent).toBe(0);
});

test("fresh windows wake, including a newest request exactly at the age limit", async () => {
    const opts = { ...options(), lookbackMs: 40 * minute };
    const now = 60 * minute;
    const events: CacheBustEvent[] = [];
    await runSentinelOnce(opts, { now: () => now, listActiveSessions: () => [session], loadDecisions: () => [],
        analyzeSession: async () => ({ requests: [request(now - 31 * minute), request(now - 30 * minute)], highWaterMarkMs: now - 30 * minute }),
        transport: { record: async (event) => { events.push(event); return { disposition: "queued", committed_order: 1 }; } },
        stdout: () => {}, stderr: () => {} });
    expect(events).toHaveLength(1);
    expect(events[0].occurred_at_ms).toBe(now - 31 * minute);
});

test("stale backfill below the thread threshold still records an observation and visible lag", async () => {
    const opts = { ...options(), lookbackMs: 30 * minute };
    const start = 60 * minute;
    let now = start;
    let batches = 0;
    const logs: Array<Record<string, unknown>> = [];
    const counters = await runSentinelOnce(opts, { now: () => now, listActiveSessions: () => [session], loadDecisions: () => [],
        analyzeSession: async () => { batches++; now += 2 * minute; return {
            requests: [{ ...request(start - 29 * minute, "full_body_no_baseline"), rewrittenTokens: 1_000 }],
            highWaterMarkMs: start - 29 * minute, scanBounded: true, scanCursor: "backlog",
            pendingFiles: 4, oldestPendingTimestampMs: start - 28 * minute }; },
        transport: { record: async () => { throw new Error("must not wake"); } }, stdout: () => {},
        stderr: (line) => logs.push(JSON.parse(line)) });
    expect(counters.bounded).toBe(true);
    expect(batches).toBe(1);
    const state = loadSentinelState(opts.stateFile);
    expect(Object.values(state.suppressedWindows)).toEqual([
        { divergenceClass: "full_body_no_baseline", rewrittenTokens: 1_000, windowStartMs: start - 29 * minute, reason: "stale" },
    ]);
    expect(state.sessions[session.sessionId].lastAnalyzedRequestTimestampMs).toBe(start - 29 * minute);
    expect(state.lag).toMatchObject({ consecutiveRuns: 1, notified: false, pendingFiles: 4 });
    expect(logs.some((line) => line.kind === "cache_bust_sentinel_lag")).toBe(true);
});

test("age is checked again for later windows after a slow earlier delivery", async () => {
    const opts = { ...options(), lookbackMs: 30 * minute };
    const start = 60 * minute;
    let now = start;
    const events: CacheBustEvent[] = [];
    await runSentinelOnce(opts, { now: () => now, listActiveSessions: () => [session], loadDecisions: () => [],
        analyzeSession: async () => ({ requests: [request(start - 29 * minute), request(start - 26 * minute)], highWaterMarkMs: start - 26 * minute }),
        transport: { record: async (event) => { events.push(event); now += 5 * minute; return { disposition: "delivered", committed_order: 1 }; } },
        stdout: () => {}, stderr: () => {} });
    expect(events).toHaveLength(1);
    expect(Object.values(loadSentinelState(opts.stateFile).suppressedWindows)).toEqual([
        { divergenceClass: "no_mc_pass_row", rewrittenTokens: 81_726, windowStartMs: start - 26 * minute, reason: "stale" },
    ]);
});

test("a persisted six-hour backlog cannot replay an old window after a restart", async () => {
    const opts = options();
    const now = 8 * 60 * minute;
    const at = now - 6 * 60 * minute;
    const state = __test.defaultState();
    state.sessions[session.sessionId] = { lastAnalyzedRequestTimestampMs: at - minute,
        scanCursor: "legacy-forward-cursor", openWindow: { startMs: at - minute, lastBustMs: at - minute, lastBustClass: "accounted_hard_fold" } };
    saveSentinelState(opts.stateFile, state);
    let sent = 0;
    await runSentinelOnce(opts, { now: () => now, listActiveSessions: () => [session], loadDecisions: () => [],
        analyzeSession: async (_, since) => { expect(since).toBe(now - 30 * minute); return { requests: [request(at)], highWaterMarkMs: at }; },
        transport: { record: async () => { sent++; } }, stdout: () => {}, stderr: () => {} });
    expect(sent).toBe(0);
    expect(loadSentinelState(opts.stateFile).sessions[session.sessionId].lastAnalyzedRequestTimestampMs).toBe(now - 30 * minute);
});

test("host removal never wakes even immediately after an accounted reclaim", async () => {
    const opts = options();
    const events: CacheBustEvent[] = [];
    await runSentinelOnce(opts, { now: () => 10 * minute, listActiveSessions: () => [session], loadDecisions: () => [],
        analyzeSession: async () => ({ requests: [request(8 * minute, "accounted_hard_fold"), request(9 * minute, "host_messages_removed")], highWaterMarkMs: 9 * minute }),
        transport: { record: async (event) => { events.push(event); } }, stdout: () => {}, stderr: () => {} });
    expect(events).toEqual([]);
});

test("backfilling a long bust streak retains its delivery ID instead of waking again", async () => {
    const opts = { ...options(), lookbackMs: 30 * minute };
    const now = 60 * minute;
    const events: CacheBustEvent[] = [];
    let batch = 0;
    const deps = { now: () => now, listActiveSessions: () => [session], loadDecisions: () => [],
        analyzeSession: async () => {
            batch++;
            const times = batch === 1 ? [40, 41, 42, 43, 44, 45] : batch === 2 ? [35, 36, 37, 38, 39] : [31, 32, 33, 34];
            return { requests: times.map((value) => request(value * minute)), highWaterMarkMs: 45 * minute,
                scanBounded: batch < 3, scanCursor: batch < 3 ? JSON.stringify({ head: "head", before: `batch${3 - batch}`, highWaterMarkMs: 45 * minute }) : undefined };
        }, transport: { record: async (event: CacheBustEvent) => { events.push(event); return { disposition: "delivered", committed_order: events.length }; } },
        stdout: () => {}, stderr: () => {} };
    expect((await runSentinelOnce(opts, deps)).bounded).toBe(false);
    expect(batch).toBe(3);
    expect(events).toHaveLength(1);
    expect(loadSentinelState(opts.stateFile).sessions[session.sessionId].lastAnalyzedRequestTimestampMs).toBe(45 * minute);
});

test("backfill remembers the partial first streak even when a later streak ends the batch", async () => {
    const opts = { ...options(), lookbackMs: 30 * minute };
    const now = 60 * minute;
    let batch = 0;
    const events: CacheBustEvent[] = [];
    const stable = { ...request(44 * minute), verdict: "STABLE" as const, divergenceClass: undefined };
    const deps = { now: () => now, listActiveSessions: () => [session], loadDecisions: () => [],
        analyzeSession: async () => {
            batch++;
            return { requests: batch === 1 ? [request(40 * minute), request(41 * minute), stable, request(45 * minute)]
                : [request(38 * minute), request(39 * minute)], highWaterMarkMs: 45 * minute, scanBounded: batch === 1,
                scanCursor: batch === 1 ? JSON.stringify({ head: "head", before: "before", highWaterMarkMs: 45 * minute }) : undefined };
        }, transport: { record: async (event: CacheBustEvent) => { events.push(event); return { disposition: "delivered", committed_order: events.length }; } },
        stdout: () => {}, stderr: () => {} };
    expect((await runSentinelOnce(opts, deps)).bounded).toBe(false);
    expect(batch).toBe(2);
    expect(events).toHaveLength(2);
    await runSentinelOnce(opts, deps);
    expect(events).toHaveLength(2);
});

test("lag persists and prints a line, sends once after three runs, and resets after catch-up", async () => {
    const opts = { ...options(), maxRunMs: 1 };
    let now = 60 * minute;
    let bounded = true;
    const notices: Array<{ deliveryId: string; content: string }> = [];
    const logs: Array<Record<string, unknown>> = [];
    const deps = { now: () => now, listActiveSessions: () => [session], loadDecisions: () => [],
        analyzeSession: async () => { now += 1; return { requests: [], highWaterMarkMs: null, scanBounded: bounded,
            scanCursor: bounded ? "fixture-cursor" : undefined, pendingFiles: bounded ? 70 : 0,
            oldestPendingTimestampMs: bounded ? now - 20 * minute : undefined }; },
        transport: { record: async () => {}, recordLag: async (notice: { deliveryId: string; content: string }) => {
            notices.push(notice); return { disposition: "delivered", committed_order: notices.length }; } },
        stdout: () => {}, stderr: (line: string) => logs.push(JSON.parse(line)) };
    await runSentinelOnce(opts, deps);
    expect(loadSentinelState(opts.stateFile).lag).toMatchObject({ consecutiveRuns: 1, notified: false, lagMs: 20 * minute, pendingFiles: 70 });
    expect(logs.filter((line) => line.kind === "cache_bust_sentinel_lag")).toHaveLength(1);
    await runSentinelOnce(opts, deps);
    expect(notices).toHaveLength(0);
    await runSentinelOnce(opts, deps);
    await runSentinelOnce(opts, deps);
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toBe("Cache-bust sentinel is behind by 20 minutes and 70 files.");
    bounded = false;
    await runSentinelOnce(opts, deps);
    expect(loadSentinelState(opts.stateFile).lag).toBeUndefined();
    bounded = true;
    now += minute;
    for (let i = 0; i < 3; i++) await runSentinelOnce(opts, deps);
    expect(notices).toHaveLength(2);
    expect(notices[1].deliveryId).not.toBe(notices[0].deliveryId);
});

test("quiet lag delivery uses normal urgency and a refusal is logged without retry", async () => {
    const requests: unknown[] = [];
    const transport = new SubcWakeEventTransport("fixture", "module", "agent", "sentinel", async () => ({
        call: async (_, __, params) => { requests.push(params); throw new Error("refused urgency"); }, close: () => {},
    }));
    const opts = { ...options(), maxRunMs: 1 };
    let now = 60 * minute;
    const logs: string[] = [];
    const deps = { now: () => now, listActiveSessions: () => [session], loadDecisions: () => [],
        analyzeSession: async () => { now += 1; return { requests: [], highWaterMarkMs: null, scanBounded: true, scanCursor: "fixture",
            pendingFiles: 100, oldestPendingTimestampMs: now - 20 * minute }; }, transport,
        stdout: () => {}, stderr: (line: string) => logs.push(line) };
    for (let i = 0; i < 4; i++) await runSentinelOnce(opts, deps);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ urgency: "normal", body: { one_way: true } });
    expect(logs.some((line) => line.includes("cache_bust_sentinel_lag_delivery_refused"))).toBe(true);
});
