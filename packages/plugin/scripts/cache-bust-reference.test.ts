import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../src/shared/test-temp-dir";
import { analyzeOpenCodeCacheBustSession, createOpenCodeDumpScanIndex } from "./analyze-cache-busts";
import { agentDeliverRequest, DEFAULT_MAX_WAKE_AGE_MS, loadSentinelState, runSentinelOnce, saveSentinelState } from "./cache-bust-sentinel";

const roots: string[] = [];
const epoch = Date.parse("2026-09-04T10:00:00Z");
const sessionId = "ses_reference";
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(stepMs = 1_000) {
    const root = createTestTempDirFromPath(join(tmpdir(), "cache-reference-"));
    roots.push(root);
    const files: string[] = [];
    const user = (index: number) => ({ role: "user", content: [{ type: "text", text: `client ${index}`, cache_control: { type: "ephemeral" } }] });
    const full = (index: number) => [user(0), ...Array.from({ length: index }, (_, i) => [
        { role: "assistant", content: [{ type: "text", text: `undumped reply ${i}` }] }, user(i + 1),
    ]).flat()];
    for (let index = 0; index <= 12; index++) {
        const createdAt = new Date(epoch + index * stepMs).toISOString();
        const stem = `${createdAt.replace(/[:.]/g, "-")}-${index}-${sessionId}`;
        const body = join(root, `${stem}.body.json`);
        const response = join(root, `${stem}.response.json`);
        const thread = { type: [0, 6, 12].includes(index) ? "create" : "continue" };
        writeFileSync(body, JSON.stringify({ system: "system", thread, messages: thread.type === "create" ? full(index) : [user(index)] }));
        writeFileSync(response, JSON.stringify({ usage: { input_tokens: 4, cache_read_input_tokens: index === 12 ? 97_013 : 100_000, cache_creation_input_tokens: index === 12 ? 2_987 : 0 },
            ...(index === 12 ? { diagnostics: { cache_miss_reason: { type: "messages_changed", cache_missed_input_tokens: 27_641 } } } : {}) }));
        files.push(`${stem}.meta.json`);
        writeFileSync(join(root, files[index]), JSON.stringify({ session: sessionId, createdAt, body: { thread }, files: { body, response } }));
    }
    const mcLogPath = join(root, "mc.log");
    writeFileSync(mcLogPath, files.map((_, i) => `[${new Date(epoch + i * stepMs - 1).toISOString()}] [magic-context][${sessionId}] transform scheduler: inputTokens=100000 decision=defer`).join("\n"));
    const key = (index: number) => `${String(epoch + index * stepMs).padStart(16, "0")}:${String(index).padStart(8, "0")}:${files[index]}:anthropic`;
    // The cursor leaves old backfill before request 3 and new arrivals after 9.
    // The newest earlier full body (request 6) is between those selected groups.
    const scanCursor = JSON.stringify({ head: key(9), before: key(3), highWaterMarkMs: epoch + 9 * stepMs });
    const options = { sessionId, anthropicDir: root, openaiDir: join(root, "missing"), mcLogPath, sinceExclusiveMs: epoch };
    const analyze = (indexed: boolean, cursor = scanCursor) => analyzeOpenCodeCacheBustSession({
        ...options, scanCursor: cursor, scanDeadlineMs: epoch + 999_999, scanNow: () => epoch,
        ...(indexed ? { scanIndex: createOpenCodeDumpScanIndex() } : {}),
    });
    const sentinelOptions = {
        once: true, send: false, intervalMs: 60_000, lookbackMs: 60_000,
        stateFile: join(root, "state.json"), databasePath: join(root, "missing.db"), rustStorePath: join(root, "missing-rust.db"),
        connectionFile: join(root, "missing-connection.json"), runnerDataDir: join(root, "missing-runner"),
        wakeModuleId: "fixture-module", wakeAgentId: "fixture-agent", wakeFromAgent: "sentinel", ...options,
    };
    const state = loadSentinelState(sentinelOptions.stateFile);
    state.sessions[sessionId] = { lastAnalyzedRequestTimestampMs: epoch, scanCursor };
    saveSentinelState(sentinelOptions.stateFile, state);
    return { root, files, options, analyze, sentinelOptions };
}

for (const indexed of [false, true]) test(`disjoint cursor groups use the analyzer's newest full reference (indexed=${indexed})`, () => {
    const f = fixture();
    const expected = analyzeOpenCodeCacheBustSession(f.options).requests.at(-1)!;
    expect(expected).toMatchObject({ divergenceClass: "thread_break_unchanged_client_bytes", rewrittenTokens: 2_987 });
    expect(expected.firstDivergence).toBe("(18 client messages compared and matched; reply bytes not dumped)");
    const actual = f.analyze(indexed).requests.at(-1)!;
    expect({ class: actual.divergenceClass, first: actual.firstDivergence, command: actual.analyzerCmd }).toEqual({
        class: expected.divergenceClass, first: expected.firstDivergence, command: expected.analyzerCmd,
    });
});

test("a small thread break across disjoint cursor groups never wakes", async () => {
    const f = fixture();
    const events: string[] = [];
    const counters = await runFixture(f, events);
    expect(events.filter(line => JSON.parse(line).kind === "cache_bust")).toEqual([]);
    expect(counters).toMatchObject({ requests: 5, dryRun: 0, unaccountedWindows: 0 });
    expect(Object.values(loadSentinelState(f.sentinelOptions.stateFile).suppressedWindows)).toContainEqual(expect.objectContaining({
        divergenceClass: "thread_break_unchanged_client_bytes", rewrittenTokens: 2_987,
    }));
});

function runFixture(f: ReturnType<typeof fixture>, events: string[], logs: string[] = [], now = epoch + 13_000) {
    return runSentinelOnce(f.sentinelOptions, {
        now: () => now,
        listActiveSessions: () => [{ sessionId, harness: "opencode", projectPath: f.root, activityMs: epoch + 13_000 }],
        loadDecisions: () => [],
        analyzeSession: async (_session, sinceExclusiveMs, decisions, scan) => analyzeOpenCodeCacheBustSession({
            ...f.options, ...scan, sessionId, sinceExclusiveMs, decisions,
        }),
        stdout: (line) => events.push(line), stderr: (line) => logs.push(line),
    });
}

for (const incomplete of [6, 12]) test(`an unreadable ${incomplete === 6 ? "newest full reference" : "chosen request"} is not judged and is retried`, async () => {
    const f = fixture();
    const body = join(f.root, f.files[incomplete].replace(".meta.json", ".body.json"));
    const original = readFileSync(body, "utf8");
    writeFileSync(body, "{");
    const events: string[] = [];
    const logs: string[] = [];
    const before = loadSentinelState(f.sentinelOptions.stateFile).sessions[sessionId];
    expect(await runFixture(f, events, logs)).toMatchObject({ requests: 0, bounded: true, dryRun: 0, notJudgedPending: 1, notJudgedFinal: 0 });
    expect(logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
        kind: "cache_bust_sentinel_not_judged", session_id: sessionId, at: new Date(epoch + incomplete * 1_000).toISOString(), final: false,
    }));
    expect(loadSentinelState(f.sentinelOptions.stateFile).sessions[sessionId]).toMatchObject({
        lastAnalyzedRequestTimestampMs: before.lastAnalyzedRequestTimestampMs, scanCursor: before.scanCursor,
    });
    writeFileSync(body, original);
    expect(await runFixture(f, events)).toMatchObject({ requests: 5, bounded: false, dryRun: 0 });
    expect(events.filter(line => JSON.parse(line).kind === "cache_bust")).toEqual([]);
});

test("expired unreadable reference is finalized once without blocking later requests", async () => {
    const step = DEFAULT_MAX_WAKE_AGE_MS / 10;
    const f = fixture(step);
    const file = join(f.root, f.files[6]);
    writeFileSync(file.replace(".meta.json", ".body.json"), "{");
    const events: string[] = [];
    const logs: string[] = [];
    expect(await runFixture(f, events, logs, epoch + 13 * step)).toMatchObject({ requests: 0, bounded: true });
    const pendingState = loadSentinelState(f.sentinelOptions.stateFile).sessions[sessionId];
    const final = await runFixture(f, events, logs, epoch + 17 * step);
    expect(final).toMatchObject({ requests: 3, bounded: false, notJudgedPending: 0, notJudgedFinal: 1, dryRun: 0 });
    const state = loadSentinelState(f.sentinelOptions.stateFile);
    expect(state.notJudgedRequests?.[`${sessionId}|${epoch + 6 * step}`]).toMatchObject({
        at: new Date(epoch + 6 * step).toISOString(), file, final: true, reason: expect.stringContaining("unreadable"),
    });
    expect(state.sessions[sessionId].lastAnalyzedRequestTimestampMs).toBe(epoch + 12 * step);
    expect(state.sessions[sessionId].lastAnalyzedRequestTimestampMs).toBeGreaterThan(pendingState.lastAnalyzedRequestTimestampMs);
    expect(state.sessions[sessionId].scanCursor).toBeUndefined();
    expect(state.sessions[sessionId].pendingNotJudged).toBeUndefined();
    expect(Object.values(state.suppressedWindows)).toContainEqual({ divergenceClass: "full_body_no_baseline", rewrittenTokens: 2_987 });
    const finalLines = () => logs.map(line => JSON.parse(line)).filter(line => line.kind === "cache_bust_sentinel_not_judged" && line.final);
    expect(finalLines()).toHaveLength(1);
    expect(await runFixture(f, events, logs, epoch + 17 * step)).toMatchObject({ requests: 0, notJudgedFinal: 0, notJudgedPending: 0 });
    expect(finalLines()).toHaveLength(1);
    expect(events.filter(line => JSON.parse(line).kind === "cache_bust")).toEqual([]);
});

test("a large full request after a finalized unreadable reference still wakes without a first divergence", async () => {
    const step = DEFAULT_MAX_WAKE_AGE_MS / 10;
    const f = fixture(step);
    writeFileSync(join(f.root, f.files[6]).replace(".meta.json", ".body.json"), "{");
    const response = join(f.root, f.files[12]).replace(".meta.json", ".response.json");
    const value = JSON.parse(readFileSync(response, "utf8"));
    value.usage.cache_read_input_tokens = 80_000;
    value.usage.cache_creation_input_tokens = 20_000;
    writeFileSync(response, JSON.stringify(value));
    const events: string[] = [];
    expect(await runFixture(f, events, [], epoch + 17 * step)).toMatchObject({ notJudgedFinal: 1, dryRun: 1 });
    const event = events.map(line => JSON.parse(line)).find(line => line.kind === "cache_bust");
    expect(event.payload.divergence_class).toBe("full_body_no_baseline");
    expect(event.payload.first_divergence).toContain(new Date(epoch + 6 * step).toISOString());
    expect(event.payload.first_divergence).toContain("unreadable");
    expect(event.payload.first_divergence).not.toContain("message[");
});

test("a chosen unreadable request is finalized even after it ages out of ordinary scan selection", async () => {
    const step = DEFAULT_MAX_WAKE_AGE_MS / 10;
    const f = fixture(step);
    const file = join(f.root, f.files[12]);
    writeFileSync(file.replace(".meta.json", ".body.json"), "{");
    const events: string[] = [];
    const logs: string[] = [];
    expect(await runFixture(f, events, logs, epoch + 13 * step)).toMatchObject({ bounded: true, notJudgedPending: 1 });
    expect(await runFixture(f, events, logs, epoch + 23 * step)).toMatchObject({ bounded: false, notJudgedPending: 0, notJudgedFinal: 1, dryRun: 0 });
    const state = loadSentinelState(f.sentinelOptions.stateFile);
    expect(state.notJudgedRequests?.[`${sessionId}|${epoch + 12 * step}`]).toMatchObject({ file, final: true });
    expect(state.sessions[sessionId].scanCursor).toBeUndefined();
    expect(state.sessions[sessionId].pendingNotJudged).toBeUndefined();
    expect(await runFixture(f, events, logs, epoch + 23 * step)).toMatchObject({ notJudgedFinal: 0, bounded: false });
    expect(logs.map(line => JSON.parse(line)).filter(line => line.kind === "cache_bust_sentinel_not_judged" && line.final)).toHaveLength(1);
    expect(events.filter(line => JSON.parse(line).kind === "cache_bust")).toEqual([]);
});

for (const tokens of [2_987, 20_000]) test(`thread break logs once across replay and restart (${tokens} tokens)`, async () => {
    const f = fixture();
    const response = join(f.root, f.files[12]).replace(".meta.json", ".response.json");
    const value = JSON.parse(readFileSync(response, "utf8"));
    value.usage.cache_read_input_tokens = 100_000 - tokens;
    value.usage.cache_creation_input_tokens = tokens;
    writeFileSync(response, JSON.stringify(value));
    const events: string[] = [];
    const logs: string[] = [];
    const originalCursor = loadSentinelState(f.sentinelOptions.stateFile).sessions[sessionId].scanCursor;
    expect(await runFixture(f, events, logs)).toMatchObject({ dryRun: tokens >= 20_000 ? 1 : 0 });
    const threadLines = () => logs.map(line => JSON.parse(line)).filter(line => line.kind === "cache_bust_thread_break");
    expect(threadLines()).toEqual([{ kind: "cache_bust_thread_break", at: new Date(epoch + 12_000).toISOString(),
        session_id: sessionId, directory: f.root, rewritten_tokens: tokens, cache_read: 100_000 - tokens,
        previous_total: 100_004, gap_ms: 1_000, continues_since_full: 5,
        provider_reason: "messages_changed", provider_missed: 27_641 }]);
    // Force a replay after loading persisted window observations, not merely a
    // scan whose watermark already skips the request.
    const replay = loadSentinelState(f.sentinelOptions.stateFile);
    replay.sessions[sessionId] = { lastAnalyzedRequestTimestampMs: epoch, scanCursor: originalCursor };
    saveSentinelState(f.sentinelOptions.stateFile, replay);
    expect(await runFixture(f, events, logs)).toMatchObject({ requests: 5, dryRun: 0 });
    expect(threadLines()).toHaveLength(1);
    expect(events.filter(line => JSON.parse(line).kind === "cache_bust")).toHaveLength(tokens >= 20_000 ? 1 : 0);
});

test("thread-break log omits figures the analysis does not have", async () => {
    const f = fixture();
    const logs: string[] = [];
    const at = new Date(epoch + 12_000).toISOString();
    await runSentinelOnce(f.sentinelOptions, {
        now: () => epoch + 13_000, loadDecisions: () => [], stdout: () => {}, stderr: line => logs.push(line),
        listActiveSessions: () => [{ sessionId, harness: "opencode", projectPath: f.root, activityMs: epoch + 13_000 }],
        analyzeSession: async () => ({ requests: [{ session: sessionId, at, timestampMs: epoch + 12_000,
            verdict: "SHORT", divergenceClass: "thread_break_unchanged_client_bytes", rewrittenTokens: 2_987,
            firstDivergence: "matched client bytes", analyzerCmd: "fixture" }], highWaterMarkMs: epoch + 12_000 }),
    });
    expect(logs.map(line => JSON.parse(line)).filter(line => line.kind === "cache_bust_thread_break")).toEqual([
        { kind: "cache_bust_thread_break", at, session_id: sessionId, directory: f.root, rewritten_tokens: 2_987 },
    ]);
});

test("thread-break continuation count uses dump order when request timestamps tie", () => {
    const f = fixture(0);
    const result = analyzeOpenCodeCacheBustSession({ ...f.options, sinceExclusiveMs: epoch - 1 });
    expect(result.requests.at(-1)?.threadBreak).toMatchObject({ continuesSinceFull: 5, gapMs: 0 });
});

test("older window state skips recorded requests but logs a new thread break in the same window", async () => {
    const f = fixture();
    const state = loadSentinelState(f.sentinelOptions.stateFile);
    state.sessions[sessionId] = { lastAnalyzedRequestTimestampMs: epoch,
        openWindow: { startMs: epoch, lastBustMs: epoch, lastBustClass: "thread_break_unchanged_client_bytes", threadRewrittenTokens: 1_000 } };
    state.suppressedWindows[`${sessionId}|${epoch}`] = { divergenceClass: "thread_break_unchanged_client_bytes", rewrittenTokens: 1_000 };
    saveSentinelState(f.sentinelOptions.stateFile, state);
    const logs: string[] = [];
    const row = (offset: number) => ({ session: sessionId, at: new Date(epoch + offset).toISOString(), timestampMs: epoch + offset,
        verdict: "SHORT" as const, divergenceClass: "thread_break_unchanged_client_bytes" as const, rewrittenTokens: 1_000,
        firstDivergence: "matched client bytes", analyzerCmd: "fixture" });
    let rows = [row(1_000)];
    const deps = { now: () => epoch + 13_000, loadDecisions: () => [], stdout: () => {}, stderr: (line: string) => logs.push(line),
        listActiveSessions: () => [{ sessionId, harness: "opencode" as const, projectPath: f.root, activityMs: epoch + 13_000 }],
        analyzeSession: async () => ({ requests: rows, highWaterMarkMs: epoch + 1_000 }) };
    await runSentinelOnce(f.sentinelOptions, deps);
    const replay = loadSentinelState(f.sentinelOptions.stateFile);
    replay.sessions[sessionId].lastAnalyzedRequestTimestampMs = epoch - 1;
    saveSentinelState(f.sentinelOptions.stateFile, replay);
    rows = [row(0), row(1_000)];
    await runSentinelOnce(f.sentinelOptions, deps);
    expect(logs.map(line => JSON.parse(line)).filter(line => line.kind === "cache_bust_thread_break").map(line => line.at)).toEqual([new Date(epoch + 1_000).toISOString()]);
});

test("a real rewrite with only a scheduler line still wakes without claiming a no-change pass", async () => {
    const f = fixture();
    const body = join(f.root, f.files[12].replace(".meta.json", ".body.json"));
    const changed = JSON.parse(readFileSync(body, "utf8"));
    changed.messages[0].content[0].text = "rewritten baseline";
    writeFileSync(body, JSON.stringify(changed));
    const events: string[] = [];
    expect(await runFixture(f, events)).toMatchObject({ dryRun: 1, unaccountedWindows: 1 });
    const event = events.map(line => JSON.parse(line)).find(event => event.kind === "cache_bust");
    expect(event.payload).toMatchObject({ divergence_class: "no_mc_pass_row", rewritten_tokens: 2_987,
        pass_evidence: "no pass record for this request; a scheduler line was found" });
    expect(event.payload.first_divergence).toContain("rewritten baseline");
    const wake = agentDeliverRequest(event, "maintainer", "sentinel");
    expect(wake.urgency).toBe("high");
    expect(wake.body.content).toContain("no pass record for this request; a scheduler line was found");
});

test("length-only changes never print an absent segment as the first divergence", () => {
    const f = fixture();
    for (let index = 0; index <= 12; index++) {
        const meta = join(f.root, f.files[index]);
        if (index > 0 && index < 12) { rmSync(meta); continue; }
        const body = meta.replace(".meta.json", ".body.json");
        const value = JSON.parse(readFileSync(body, "utf8"));
        delete value.thread;
        writeFileSync(body, JSON.stringify(value));
        const metadata = JSON.parse(readFileSync(meta, "utf8"));
        delete metadata.body.thread;
        writeFileSync(meta, JSON.stringify(metadata));
    }
    expect(analyzeOpenCodeCacheBustSession(f.options).requests.at(-1)!.firstDivergence).toBe(
        "(common client prefix matches; request length changed, not a changed message)",
    );
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "analyze-cache-busts.ts"),
        "--source", "dumps", "--session", sessionId, "--dir", f.root, "--mc-log", f.options.mcLogPath,
        "--all-rows", "--show-diff", "--all-busts"], { cwd: join(import.meta.dir, ".."), windowsHide: true });
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain("request length changed, not a changed message");
    expect(output).not.toContain("segment absent");
    expect(output).not.toContain("diverge @");
    expect(output).not.toContain("message[2]");
});
