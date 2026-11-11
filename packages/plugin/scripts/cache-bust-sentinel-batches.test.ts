import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../src/shared/test-temp-dir";
import type { AnalyzedCacheRequest } from "./cache-bust-attribution";
import { selectScanBatch } from "./cache-bust-scan";
import {
    __test,
    type ActiveCacheBustSession,
    type CacheBustEvent,
    type CacheBustSentinelOptions,
    loadSentinelState,
    runSentinelOnce,
    saveSentinelState,
} from "./cache-bust-sentinel";

const directories: string[] = [];
afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function options(): CacheBustSentinelOptions {
    const directory = createTestTempDirFromPath(join(tmpdir(), "sentinel-batches-"));
    directories.push(directory);
    return {
        once: true, send: false, intervalMs: 60_000, lookbackMs: 500_000,
        stateFile: join(directory, "state.json"), databasePath: join(directory, "missing.db"),
        rustStorePath: join(directory, "missing-rust.db"), connectionFile: join(directory, "missing.json"),
        wakeModuleId: "fixture-module", wakeAgentId: "fixture-agent", wakeFromAgent: "sentinel",
    };
}

const sessions = ["ses_a", "ses_b", "ses_c"].map((sessionId): ActiveCacheBustSession => ({
    sessionId, harness: "opencode", projectPath: "dir:fixture", activityMs: 1_000_000,
}));

function requests(sessionId: string, count = 65): AnalyzedCacheRequest[] {
    return Array.from({ length: count }, (_, index) => ({
        session: sessionId, timestampMs: 900_001 + index, at: new Date(900_001 + index).toISOString(),
        verdict: "STABLE", firstDivergence: "none", analyzerCmd: "fixture-analyzer",
    }));
}

function analyzeBatch(rows: AnalyzedCacheRequest[], sinceExclusiveMs: number, scanCursor?: string) {
    const batch = selectScanBatch(rows.map((row) => ({ ...row, timestamp: row.timestampMs })),
        (row) => String(row.timestampMs).padStart(16, "0"),
        { sinceExclusiveMs, scanCursor, scanDeadlineMs: Infinity, scanNow: () => 0 });
    const highWaterMarkMs = rows.at(-1)!.timestampMs;
    return {
        requests: batch.chosen.sort((left, right) => left.timestampMs - right.timestampMs),
        highWaterMarkMs, filesExamined: batch.chosen.length, scanBounded: batch.remaining.length > 0,
        scanCursor: batch.remaining.length ? JSON.stringify({ ...batch.cursor, highWaterMarkMs }) : undefined,
        pendingFiles: batch.remaining.length, oldestPendingTimestampMs: batch.remaining[0]?.timestampMs,
    };
}

test("drains three sessions of three batches in pass order within one run", async () => {
    const opts = options();
    const calls: string[] = [];
    const covered: Record<string, number[]> = {};
    const counters = await runSentinelOnce(opts, {
        now: () => 1_000_000, listActiveSessions: () => sessions, loadDecisions: () => [],
        analyzeSession: async (session, since, _, scan: CacheBustSentinelOptions & { scanCursor?: string }) => {
            calls.push(session.sessionId);
            const analysis = analyzeBatch(requests(session.sessionId), since, scan.scanCursor);
            (covered[session.sessionId] ??= []).push(...analysis.requests.map((row) => row.timestampMs));
            return analysis;
        }, stdout: () => {}, stderr: () => {},
    });

    expect(calls).toEqual(["ses_a", "ses_b", "ses_c", "ses_a", "ses_b", "ses_c", "ses_a", "ses_b", "ses_c"]);
    expect(counters).toMatchObject({ sessions: 3, requests: 195, filesExamined: 195, bounded: false });
    for (const session of sessions) {
        expect(covered[session.sessionId]).toEqual([
            ...Array.from({ length: 32 }, (_, i) => 900_034 + i),
            ...Array.from({ length: 32 }, (_, i) => 900_002 + i), 900_001,
        ]);
        expect(loadSentinelState(opts.stateFile).sessions[session.sessionId]).toEqual({
            lastAnalyzedRequestTimestampMs: 900_065, lastScannedAtMs: 1_000_000,
        });
    }
});

test("a deadline preserves cursors and the next run covers the remainder exactly once", async () => {
    const opts = { ...options(), maxRunMs: 25 };
    let now = 1_000_000;
    const calls: string[] = [];
    const covered: Record<string, number[]> = {};
    const cursors: Array<string | undefined> = [];
    const deps = {
        now: () => now, listActiveSessions: () => sessions, loadDecisions: () => [],
        analyzeSession: async (session: ActiveCacheBustSession, since: number, _: unknown,
            scan: CacheBustSentinelOptions & { scanCursor?: string }) => {
            calls.push(session.sessionId);
            cursors.push(scan.scanCursor);
            now += 5;
            const analysis = analyzeBatch(requests(session.sessionId), since, scan.scanCursor);
            (covered[session.sessionId] ??= []).push(...analysis.requests.map((row) => row.timestampMs));
            return analysis;
        }, stdout: () => {}, stderr: () => {},
    };
    expect(await runSentinelOnce(opts, deps)).toMatchObject({ requests: 160, bounded: true });
    expect(calls).toEqual(["ses_a", "ses_b", "ses_c", "ses_a", "ses_b"]);
    const saved = loadSentinelState(opts.stateFile).sessions;
    expect([saved.ses_a.pendingFiles, saved.ses_b.pendingFiles, saved.ses_c.pendingFiles]).toEqual([1, 1, 33]);

    calls.length = 0;
    cursors.length = 0;
    expect(await runSentinelOnce(opts, deps)).toMatchObject({ requests: 35, bounded: false });
    expect(calls).toEqual(["ses_c", "ses_a", "ses_b", "ses_c"]);
    expect(cursors.slice(0, 3)).toEqual([saved.ses_c.scanCursor, saved.ses_a.scanCursor, saved.ses_b.scanCursor]);
    for (const session of sessions) {
        expect(covered[session.sessionId].sort((a, b) => a - b)).toEqual(
            Array.from({ length: 65 }, (_, i) => 900_001 + i));
    }
});

test.each([undefined, "stuck-cursor"])("an empty bounded scan with unchanged cursor %p gets one batch per run without blocking others", async (cursor) => {
    const opts = { ...options(), maxRunMs: 100 };
    const state = __test.defaultState();
    state.sessions.ses_a = { lastAnalyzedRequestTimestampMs: 500_000, scanCursor: cursor };
    saveSentinelState(opts.stateFile, state);
    let ticks = 0;
    const calls: string[] = [];
    const deps = {
        now: () => 1_000_000 + ticks++, listActiveSessions: () => sessions.slice(0, 2), loadDecisions: () => [],
        analyzeSession: async (session: ActiveCacheBustSession, since: number, _: unknown,
            scan: CacheBustSentinelOptions & { scanCursor?: string }) => {
            calls.push(session.sessionId);
            if (session.sessionId === "ses_a") return {
                requests: [], highWaterMarkMs: null, scanBounded: true, scanCursor: scan.scanCursor,
                pendingFiles: 7, oldestPendingTimestampMs: 900_000,
            };
            return analyzeBatch(requests(session.sessionId), since, scan.scanCursor);
        }, stdout: () => {}, stderr: () => {},
    };
    for (let run = 0; run < 2; run += 1) {
        calls.length = 0;
        const counters = await runSentinelOnce(opts, deps);
        expect(counters.bounded).toBe(true);
        expect(calls.filter((sessionId) => sessionId === "ses_a")).toHaveLength(1);
        expect(counters.requests).toBe(run === 0 ? 65 : 0);
    }
    expect(loadSentinelState(opts.stateFile).sessions.ses_a.pendingFiles).toBe(7);
});

test("a wake in a second batch is sent once and replaying the same data sends nothing new", async () => {
    const opts = { ...options(), send: true };
    const rows = requests("ses_a");
    rows[1] = { ...rows[1], verdict: "BUST", divergenceClass: "unaccounted_rewrite", rewrittenTokens: 80_000 };
    const events: CacheBustEvent[] = [];
    let batches = 0;
    const deps = {
        now: () => 1_000_000, listActiveSessions: () => [sessions[0]], loadDecisions: () => [],
        analyzeSession: async (_: ActiveCacheBustSession, since: number, __: unknown,
            scan: CacheBustSentinelOptions & { scanCursor?: string }) => {
            batches += 1;
            const analysis = analyzeBatch(rows, since, scan.scanCursor);
            if (batches === 2) expect(events).toHaveLength(0);
            return analysis;
        },
        transport: { record: async (event: CacheBustEvent) => {
            events.push(event);
            expect(batches).toBe(2);
            return { disposition: "delivered", committed_order: 1 };
        } }, stdout: () => {}, stderr: () => {},
    };
    expect(await runSentinelOnce(opts, deps)).toMatchObject({ bounded: false, accepted: 1, requests: 65 });
    expect(batches).toBe(3);
    expect(events).toHaveLength(1);
    expect(events[0].occurred_at_ms).toBe(900_002);
    expect(await runSentinelOnce(opts, deps)).toMatchObject({ bounded: false, accepted: 0, requests: 0 });
    expect(events).toHaveLength(1);
});

test("later batches refresh their clock snapshot and cover a new arrival once", async () => {
    const opts = { ...options(), maxWakeAgeMs: 200_000, maxRunMs: 1_000 };
    let now = 1_000_000;
    const rows = [...requests("ses_a"), { ...requests("ses_a", 1)[0],
        timestampMs: 1_000_050, at: new Date(1_000_050).toISOString() }];
    const covered: number[] = [];
    const sinceValues: number[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const deps = {
        now: () => now, listActiveSessions: () => [sessions[0]], loadDecisions: () => [],
        analyzeSession: async (_: ActiveCacheBustSession, since: number, __: unknown,
            scan: CacheBustSentinelOptions & { scanCursor?: string }) => {
            sinceValues.push(since);
            const analysis = analyzeBatch(rows.filter((row) => row.timestampMs <= now), since, scan.scanCursor);
            covered.push(...analysis.requests.map((row) => row.timestampMs));
            now = 1_000_100;
            return analysis;
        }, stdout: () => {}, stderr: (line: string) => logs.push(JSON.parse(line)),
    };
    expect(await runSentinelOnce(opts, deps)).toMatchObject({ bounded: false, requests: 66 });
    expect(sinceValues).toEqual([500_000, 800_100, 800_100]);
    expect(covered.slice(0, 32)).toEqual(Array.from({ length: 32 }, (_, i) => 900_034 + i));
    expect(covered.filter((at) => at === 1_000_050)).toHaveLength(1);
    expect(covered.sort((a, b) => a - b)).toEqual([
        ...Array.from({ length: 65 }, (_, i) => 900_001 + i), 1_000_050,
    ]);
    expect(loadSentinelState(opts.stateFile).sessions.ses_a).toEqual({
        lastAnalyzedRequestTimestampMs: 1_000_050, lastScannedAtMs: 1_000_100,
    });
    expect(logs.find((line) => line.kind === "cache_bust_sentinel_summary")).toMatchObject({
        at: new Date(1_000_100).toISOString(), elapsedMs: 100,
    });
    expect(await runSentinelOnce(opts, deps)).toMatchObject({ bounded: false, requests: 0 });
});
