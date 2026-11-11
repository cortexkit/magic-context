import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../src/shared/test-temp-dir";
import { __test as analyzerTest, analyzeOpenCodeCacheBustSession, createOpenCodeDumpScanIndex, type OpenCodeCacheBustAnalysisOptions } from "./analyze-cache-busts";
import type { DumpScanMetrics } from "./cache-bust-dump-index";
import { type ActiveCacheBustSession, type CacheBustSentinelOptions, loadSentinelState, runSentinelOnce } from "./cache-bust-sentinel";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function metrics(): DumpScanMetrics {
    return { listings: 0, directoryStats: 0, fileStats: 0, metaReads: 0, bodyReads: 0 };
}

function dump(directory: string, session: string, index: number, at = 900_001 + index): string {
    const createdAt = new Date(at).toISOString();
    const stem = `${createdAt.replace(/[:.]/g, "-")}-${index}-${session}`;
    writeFileSync(join(directory, `${stem}.body.json`), JSON.stringify({
        messages: [{ role: "user", content: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }] }],
    }));
    writeFileSync(join(directory, `${stem}.response.json`), JSON.stringify({
        usage: { input_tokens: 100, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 },
    }));
    const file = join(directory, `${stem}.meta.json`);
    writeFileSync(file, JSON.stringify({ session, createdAt, step: index }));
    return file;
}

function fixture(sessionCount: number, requestsPerSession: number, names = 2_000) {
    const root = createTestTempDirFromPath(join(tmpdir(), "sentinel-index-"));
    roots.push(root);
    const directory = join(root, "dumps");
    mkdirSync(directory);
    const sessions = Array.from({ length: sessionCount }, (_, i): ActiveCacheBustSession => ({
        sessionId: `ses_fixture${i}`, harness: "opencode", projectPath: "dir:fixture", directory: root, activityMs: 1_000_000,
    }));
    for (const session of sessions) {
        for (let i = 0; i < requestsPerSession; i += 1) dump(directory, session.sessionId, i);
    }
    for (let i = sessionCount * requestsPerSession * 3; i < names; i += 1) {
        // Valid names from other sessions must not trigger metadata or body reads.
        writeFileSync(join(directory, `1970-01-01T00-15-00-000Z-${i}-ses_unrelated.meta.json`), "{partial");
    }
    const options: CacheBustSentinelOptions = {
        once: true, send: false, intervalMs: 60_000, lookbackMs: 500_000, maxRunMs: 30_000,
        stateFile: join(root, "state.json"), databasePath: join(root, "missing.db"),
        rustStorePath: join(root, "missing-rust.db"), connectionFile: join(root, "missing.json"),
        wakeModuleId: "fixture", wakeAgentId: "fixture", wakeFromAgent: "sentinel",
        anthropicDir: directory, openaiDir: join(root, "missing"), mcLogPath: join(root, "missing.log"),
    };
    return { root, directory, sessions, options };
}

test("one run shares one source listing across sessions and batches", async () => {
    const { sessions, options } = fixture(3, 65);
    const scanMetrics = metrics();
    const counters = await runSentinelOnce(options, {
        scanMetrics, now: () => 1_000_000, listActiveSessions: () => sessions, loadDecisions: () => [],
        stdout: () => {}, stderr: () => {},
    });
    console.info(JSON.stringify({ sessions: 3, batches: 9, names: 2_000, ...scanMetrics, requests: counters.requests }));
    expect(counters).toMatchObject({ requests: 195, filesExamined: 195, bounded: false });
    expect(scanMetrics.listings).toBe(1);
});

test("40 sessions of three batches fit a listing-cost budget over 20,000 names", async () => {
    const { sessions, options } = fixture(40, 65, 20_000);
    const scanMetrics = metrics();
    // A stationary clock cannot expire the shared listing. Count real reads,
    // rather than pricing filesystem operations using one machine's latency.
    const listing = spyOn(fs, "readdirSync");
    let counters;
    let dumpListings;
    try {
        counters = await runSentinelOnce(options, {
            scanMetrics, now: () => 1_000_000, listActiveSessions: () => sessions, loadDecisions: () => [],
            stdout: () => {}, stderr: () => {},
        });
        dumpListings = listing.mock.calls.filter(([path]) => String(path) === options.anthropicDir).length;
    } finally { listing.mockRestore(); }
    console.info(JSON.stringify({ sessions: 40, batches: 120, names: 20_000, ...scanMetrics, dumpListings }));
    expect(counters).toMatchObject({ sessions: 40, requests: 2_600, filesExamined: 2_600, bounded: false });
    expect(scanMetrics.listings).toBe(1);
    expect(dumpListings).toBe(1);
    expect(scanMetrics.directoryStats).toBe(121);
    // Each session loads 34 + 33 + 1 bodies, including comparison context. Only
    // those metadata files are statted, never the unrelated directory entries.
    expect(scanMetrics.fileStats).toBe(40 * 68);
    expect(scanMetrics.metaReads).toBe(40 * 65);
    expect(scanMetrics.bodyReads).toBe(40 * 68);
    // Creating 20,000 real entries can be slow on a loaded filesystem. Only
    // operation counts, not a wall-clock deadline, define this regression.
}, 0);

function analysisOptions(options: CacheBustSentinelOptions, sessionId: string): OpenCodeCacheBustAnalysisOptions {
    return {
        sessionId, anthropicDir: options.anthropicDir, openaiDir: options.openaiDir, mcLogPath: options.mcLogPath,
        sinceExclusiveMs: 500_000, untilInclusiveMs: 1_000_000, scanDeadlineMs: 1_030_000, scanNow: () => 1_000_000,
    };
}

test("without an index the analyzer still lists on each call", () => {
    const { options, sessions } = fixture(1, 3);
    const scanMetrics = metrics();
    const opts = { ...analysisOptions(options, sessions[0].sessionId), scanMetrics };
    const first = analyzeOpenCodeCacheBustSession(opts);
    expect(analyzeOpenCodeCacheBustSession(opts)).toEqual(first);
    expect(first.requests).toHaveLength(3);
    expect(scanMetrics).toEqual({ listings: 2, directoryStats: 0, fileStats: 0, metaReads: 6, bodyReads: 6 });
});

test.each([0, 2_000])("fleet writes before every batch respect the listing interval with a %ims pause", async (pauseMs) => {
    const { directory, options, sessions } = fixture(1, 1_279, 4_000);
    options.maxRunMs = 4_000 + pauseMs;
    const scanMetrics = metrics();
    const covered: number[] = [];
    const arrivalBatches: number[] = [];
    let batches = 0;
    let now = 1_000_000;
    const counters = await runSentinelOnce(options, {
        scanMetrics, now: () => now, listActiveSessions: () => sessions, loadDecisions: () => [],
        analyzeSession: async (session, since, decisions, scan) => {
            dump(directory, session.sessionId, 2_000 + batches, 905_000 + batches);
            const opts = { ...analysisOptions(options, session.sessionId), ...scan, sinceExclusiveMs: since, decisions };
            const actual = analyzeOpenCodeCacheBustSession(opts);
            if (batches === 0 || (pauseMs && batches === 30)) {
                expect(actual).toEqual(analyzeOpenCodeCacheBustSession({ ...opts, scanIndex: undefined, scanMetrics: undefined }));
            }
            covered.push(...actual.requests.map((request) => request.timestampMs));
            if (actual.requests.some((request) => request.timestampMs === 905_001)) arrivalBatches.push(batches + 1);
            batches += 1;
            now += 100;
            if (batches === 20) now += pauseMs;
            return actual;
        }, stdout: () => {}, stderr: () => {},
    });
    console.info(JSON.stringify({ changingFolder: true, batches, pauseMs, listings: scanMetrics.listings, arrivalBatches }));
    expect(counters).toMatchObject({ requests: 1_280, bounded: Boolean(pauseMs) });
    expect(batches).toBe(40);
    expect(scanMetrics.listings).toBe(pauseMs ? 2 : 1);
    // The second batch's arrival waits through the five-second minimum, then
    // preempts backfill exactly once when batch 31 refreshes the shared listing.
    expect(arrivalBatches).toEqual(pauseMs ? [31] : []);
    expect(new Set(covered).size).toBe(1_280);
});

test("an unchanged directory refreshes only when the listing reaches thirty seconds", () => {
    const { options, sessions } = fixture(1, 65);
    const scanMetrics = metrics();
    const scanIndex = createOpenCodeDumpScanIndex(scanMetrics);
    let now = 1_000_000;
    const opts = { ...analysisOptions(options, sessions[0].sessionId), scanIndex, scanMetrics, scanNow: () => now, scanDeadlineMs: 1_060_000 };
    const first = analyzeOpenCodeCacheBustSession(opts);
    for (const age of [5_000, 29_999]) {
        now = 1_000_000 + age;
        analyzeOpenCodeCacheBustSession({ ...opts, scanCursor: first.scanCursor });
        expect(scanMetrics.listings).toBe(1);
    }
    now = 1_030_001;
    const second = analyzeOpenCodeCacheBustSession({ ...opts, scanCursor: first.scanCursor });
    expect(second).toEqual(analyzeOpenCodeCacheBustSession({ ...opts, scanCursor: first.scanCursor, scanIndex: undefined, scanMetrics: undefined }));
    expect(scanMetrics.listings).toBe(2);
});

test("cached metadata revalidates same-size edits and bodies remain batch-local", () => {
    const { directory, options, sessions } = fixture(1, 65);
    const scanMetrics = metrics();
    const scanIndex = createOpenCodeDumpScanIndex(scanMetrics);
    const opts = { ...analysisOptions(options, sessions[0].sessionId), scanIndex, scanMetrics };
    // Index 32 is context for the newest batch and a chosen request in the next.
    const file = dump(directory, sessions[0].sessionId, 32);
    const original = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...original, route: "old" }));
    const before = statSync(file);
    const first = analyzeOpenCodeCacheBustSession(opts);
    writeFileSync(file, JSON.stringify({ ...original, route: "new" }));
    utimesSync(file, before.atime, before.mtime);
    const body = file.replace(/\.meta\.json$/, ".body.json");
    writeFileSync(body, readFileSync(body, "utf8").replace("stable", "edited"));
    const next = { ...opts, scanCursor: first.scanCursor };
    expect(analyzeOpenCodeCacheBustSession(next)).toEqual(
        analyzeOpenCodeCacheBustSession({ ...next, scanIndex: undefined, scanMetrics: undefined }));
    expect(scanMetrics.metaReads).toBe(66);
});

test("the CLI loader keeps its discovery and snapshot listings without an index", () => {
    const { directory, sessions } = fixture(1, 3, 9);
    const scanMetrics = metrics();
    const args = { ...analyzerTest.parseArgs(["bun", "analyze-cache-busts.ts", "--dir", directory, "--session", sessions[0].sessionId]), scanMetrics };
    expect(analyzerTest.loadSnapshots(args)).toHaveLength(3);
    expect(scanMetrics).toEqual({ listings: 2, directoryStats: 0, fileStats: 3, metaReads: 6, bodyReads: 3 });
});

test("thread context, legacy baselines, windows and wake events match uncached batches", async () => {
    const { root, directory, options, sessions } = fixture(1, 65);
    for (let index = 0; index < 65; index += 1) {
        const file = dump(directory, sessions[0].sessionId, index);
        const meta = JSON.parse(readFileSync(file, "utf8"));
        // Exporters can place the thread type in metadata rather than the body.
        writeFileSync(file, JSON.stringify({ ...meta, body: { thread: { type: index === 32 ? "create" : "continue" } } }));
        if (index === 32) {
            writeFileSync(file.replace(/\.meta\.json$/, ".body.json"), JSON.stringify({
                system: [{ type: "text", text: "new system", cache_control: { type: "ephemeral" } }],
                messages: [{ role: "user", content: [{ type: "text", text: "stable" }] }],
            }));
            writeFileSync(file.replace(/\.meta\.json$/, ".response.json"), JSON.stringify({
                usage: { input_tokens: 100, cache_read_input_tokens: 100, cache_creation_input_tokens: 30_000 },
            }));
        }
    }
    const legacy = dump(directory, sessions[0].sessionId, 0, 899_999);
    const legacyMeta = JSON.parse(readFileSync(legacy, "utf8"));
    writeFileSync(join(directory, "legacy-baseline.meta.json"), JSON.stringify({
        ...legacyMeta, files: { body: legacy.replace(/\.meta\.json$/, ".body.json"), response: legacy.replace(/\.meta\.json$/, ".response.json") },
        body: { thread: { type: "create" } },
    }));
    rmSync(legacy);
    const baselineEvents: string[] = [];
    const baseline = await runSentinelOnce({ ...options, stateFile: join(root, "baseline-state.json") }, {
        now: () => 1_000_000, listActiveSessions: () => sessions, loadDecisions: () => [],
        analyzeSession: async (session, since, decisions, scan) => analyzeOpenCodeCacheBustSession({
            ...analysisOptions(options, session.sessionId), ...scan, scanIndex: undefined, sinceExclusiveMs: since, decisions,
        }), stdout: (line) => baselineEvents.push(line), stderr: () => {},
    });
    const indexedEvents: string[] = [];
    const scanMetrics = metrics();
    const actual = await runSentinelOnce(options, {
        scanMetrics, now: () => 1_000_000, listActiveSessions: () => sessions, loadDecisions: () => [],
        analyzeSession: async (session, since, decisions, scan) => {
            const opts = { ...analysisOptions(options, session.sessionId), ...scan, sinceExclusiveMs: since, decisions };
            const result = analyzeOpenCodeCacheBustSession(opts);
            expect(result).toEqual(analyzeOpenCodeCacheBustSession({ ...opts, scanIndex: undefined, scanMetrics: undefined }));
            return result;
        }, stdout: (line) => indexedEvents.push(line), stderr: () => {},
    });
    expect(actual).toEqual(baseline);
    expect(actual.requests).toBe(65);
    expect(baselineEvents.length).toBeGreaterThan(0);
    expect(indexedEvents).toEqual(baselineEvents);
    expect(loadSentinelState(options.stateFile)).toEqual(loadSentinelState(join(root, "baseline-state.json")));
    expect(scanMetrics.listings).toBe(1);
});
