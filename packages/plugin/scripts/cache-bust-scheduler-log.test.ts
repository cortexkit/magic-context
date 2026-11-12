import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../src/shared/test-temp-dir";
import { analyzeOpenCodeCacheBustSession } from "./analyze-cache-busts";
import { nearestCacheBustDecision, type CacheBustDecisionAttribution } from "./cache-bust-attribution";
import { runSentinelOnce } from "./cache-bust-sentinel";
import { schedulerLogDecisions, withSchedulerLogFallback } from "./cache-bust-scheduler-log";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const session = "ses_ckios";
const aTime = Date.parse("2026-09-20T12:48:01.103Z");
const bTime = Date.parse("2026-09-20T12:48:26.943Z");
const log = `[2026-09-20T12:47:52.749Z] [magic-context][${session}] transform scheduler: percentage=75.2% inputTokens=655813 cacheTtl=never lastResponseTime=1789908472447 decision=execute
[2026-09-20T12:48:20.604Z] [magic-context][${session}] event message.updated: provider=mock model=test hasUsageTokens=true tokens.input=443412 cache.read=2 cache.write=0 message.id=msg_538 session.id=${session}
[2026-09-20T12:48:20.605Z] [magic-context][${session}] transform scheduler: percentage=50.8% inputTokens=443412 cacheTtl=never lastResponseTime=1789908499627 decision=defer
`;
const execute: CacheBustDecisionAttribution = { timestampMs: Date.parse("2026-09-20T12:47:54.609Z"), decision: "execute", materialized: true, materializeReason: "pressure_refold", emergency: false, droppedTokens: 100, droppedCount: 366, inputTokens: 655813, flush: false, source: "transform_decisions" };
function fixture(marker = true) {
    const dir = createTestTempDirFromPath(join(tmpdir(), "scheduler-attribution-")); dirs.push(dir);
    const logPath = join(dir, "mc.log"); writeFileSync(logPath, log);
    for (const [index, timestamp] of [aTime, bTime].entries()) {
        const stem = `${new Date(timestamp).toISOString().replaceAll(":", "-").replace(".", "-")}-00000${index}-${session}`;
        const messages = [{ role: "user", content: [{ type: "text", text: marker ? "[Compacted by magic-context — session history is managed by the plugin]" : "stable context" }] }, { role: "assistant", content: [{ type: "text", text: index ? "rewritten tail" : "old tail", cache_control: { type: "ephemeral" } }] }];
        writeFileSync(join(dir, `${stem}.meta.json`), JSON.stringify({ session, createdAt: new Date(timestamp).toISOString() }));
        writeFileSync(join(dir, `${stem}.body.json`), JSON.stringify({ system: [{ type: "text", text: `x-anthropic-billing-header: attempt=${index}` }], messages }));
        writeFileSync(join(dir, `${stem}.response.json`), JSON.stringify({ status: 200, usage: { input_tokens: 2, cache_read_input_tokens: index ? 255750 : 443410, cache_creation_input_tokens: index ? 189320 : 0 } }));
    }
    return { dir, logPath };
}

test("scheduler fallback keeps the priced row and joins the later defer six seconds before B", () => {
    const { logPath } = fixture();
    const decisions = withSchedulerLogFallback([execute], session, logPath);
    expect(decisions).toHaveLength(2);
    expect(nearestCacheBustDecision(decisions, aTime)).toEqual(execute);
    expect(nearestCacheBustDecision(decisions, bTime)?.decision).toBe("defer");
    expect(schedulerLogDecisions(log, "ses_other")).toEqual([]);
    expect(schedulerLogDecisions(log.replaceAll("2026-09-20T", "invalid"), session)).toEqual([]);
    expect(withSchedulerLogFallback([execute], session, `${logPath}.missing`)).toEqual([execute]);
});

test("Rust pass logs carry raw input counts for self-inflicted epoch attribution", () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "rust-pass-attribution-"));
    dirs.push(dir);
    const logPath = join(dir, "mc.log");
    writeFileSync(
        logPath,
        `[2026-09-22T11:54:37.372Z] [magic-context][ses_aft] rust pass: decision=SOFT reason=coverage_fold scheduler=execute in=513 out=97 applied=true\n` +
            `[2026-09-22T11:55:23.973Z] [magic-context][ses_aft] rust pass: decision=HARD reason=epoch_change scheduler=defer identity_delta=mur in=12747 out=87 applied=true\n`,
    );

    const decisions = withSchedulerLogFallback([], "ses_aft", logPath);
    expect(decisions).toHaveLength(2);
    expect(
        decisions.map((row) => [row.materializeReason, row.inputCount, row.identityDelta]),
    ).toEqual([
        ["coverage_fold", 513, undefined],
        ["epoch_change", 12_747, ["mur"]],
    ]);
});

test("analyzer and sentinel report a rewrite with only a scheduler line as no_mc_pass_row", async () => {
    const { dir, logPath } = fixture();
    const options = { sessionId: session, anthropicDir: dir, openaiDir: join(dir, "missing"), decisions: [execute] };
    const without = analyzeOpenCodeCacheBustSession({ ...options, mcLogPath: null });
    expect(without.requests[1]?.divergenceClass).toBe("no_mc_pass_row");
    const withLog = analyzeOpenCodeCacheBustSession({ ...options, mcLogPath: logPath });
    // A scheduler defer records usage below the execute threshold, not proof
    // that the completed pass made no changes. The byte rewrite still wakes.
    expect(withLog.requests[1]?.divergenceClass).toBe("no_mc_pass_row");
    expect(withLog.requests[1]?.passEvidence).toBe("no pass record for this request; a scheduler line was found");
    const events: string[] = [];
    await runSentinelOnce({ once: true, send: false, intervalMs: 60000, lookbackMs: 120000, stateFile: join(dir, "state.json"), databasePath: join(dir, "absent.db"), rustStorePath: join(dir, "absent-rust.db"), connectionFile: join(dir, "absent.json"), wakeModuleId: "prefrontal-core", wakeAgentId: "agent_b613e5cf2ee55b8c", wakeFromAgent: "mc-cache-bust-sentinel", anthropicDir: dir, openaiDir: join(dir, "missing"), mcLogPath: logPath }, {
        now: () => bTime + 1000,
        listActiveSessions: () => [{ sessionId: session, harness: "opencode", projectPath: "fixture", directory: dir, activityMs: bTime }],
        loadDecisions: () => [execute], stdout: line => events.push(line),
    });
    expect(events.some(line => line.includes('"divergence_class":"unaccounted_defer_pass"'))).toBe(false);
    expect(events.some(line => line.includes('"divergence_class":"no_mc_pass_row"'))).toBe(true);
});

// 2026-09-21 12:26Z. The execute pass at 12:26:08.421Z drained 160 queued drops
// on a published-history ride and the request it shaped went out 9 s later, at
// 12:26:17.760Z. The next turn's defer pass ran 4 s after that request.
const drainSession = "ses_publishedHistoryDrain";
const drainPassAt = "2026-09-21T12:26:08.421Z";
const drainRequestMs = Date.parse("2026-09-21T12:26:17.760Z");
const drainPreviousMs = Date.parse("2026-09-21T12:25:43.000Z");
const drainLog = (applyReason: string): string =>
    `[${drainPassAt}] [magic-context][${drainSession}] transform scheduler: percentage=75.0% inputTokens=654353 cacheTtl=never lastResponseTime=1789993567716 decision=execute
[2026-09-21T12:26:08.580Z] [magic-context][${drainSession}] pending ops WILL APPLY — reason=${applyReason}, pendingOps=160, context=75.0%
[2026-09-21T12:26:22.102Z] [magic-context][${drainSession}] transform scheduler: percentage=48.6% inputTokens=423813 cacheTtl=never lastResponseTime=1789993581708 decision=defer
`;

function drainFixture(applyReason: string): { dir: string; logPath: string } {
    const dir = createTestTempDirFromPath(join(tmpdir(), "published-history-drain-"));
    dirs.push(dir);
    const logPath = join(dir, "mc.log");
    writeFileSync(logPath, drainLog(applyReason));
    const requests = [
        {
            timestampMs: drainPreviousMs,
            head: "history before the drain",
            usage: { input_tokens: 2, cache_read_input_tokens: 653_706, cache_creation_input_tokens: 645 },
        },
        {
            timestampMs: drainRequestMs,
            head: "history after the drain",
            usage: { input_tokens: 2, cache_read_input_tokens: 285_161, cache_creation_input_tokens: 138_650 },
        },
    ];
    for (const [index, request] of requests.entries()) {
        const stem = `${new Date(request.timestampMs).toISOString().replaceAll(":", "-").replace(".", "-")}-00000${index}-${drainSession}`;
        writeFileSync(
            join(dir, `${stem}.meta.json`),
            JSON.stringify({ session: drainSession, createdAt: new Date(request.timestampMs).toISOString() }),
        );
        writeFileSync(
            join(dir, `${stem}.body.json`),
            JSON.stringify({
                // The per-request billing header rotates on both requests.
                system: [{ type: "text", text: `x-anthropic-billing-header: cch=${index}abcd; cc_prev_req=req_00${index};` }],
                messages: [
                    { role: "user", content: [{ type: "text", text: request.head, cache_control: { type: "ephemeral" } }] },
                    { role: "assistant", content: [{ type: "text", text: "shared tail" }] },
                ],
            }),
        );
        writeFileSync(join(dir, `${stem}.response.json`), JSON.stringify({ status: 200, usage: request.usage }));
    }
    return { dir, logPath };
}

test("attributes a request to the execute pass that served it nine seconds earlier", () => {
    const { dir, logPath } = drainFixture("ride=publishedHistory (scheduler=execute)");

    const pass = schedulerLogDecisions(drainLog("ride=publishedHistory (scheduler=execute)"), drainSession)[0];
    expect(pass.decision).toBe("execute");
    expect(pass.appliedRide).toBe("publishedHistory");

    const analysis = analyzeOpenCodeCacheBustSession({
        sessionId: drainSession,
        anthropicDir: dir,
        openaiDir: join(dir, "missing"),
        mcLogPath: logPath,
    });
    expect(analysis.requests.at(-1)?.verdict).toBe("BUST");
    expect(analysis.requests.at(-1)?.divergenceClass).toBe("accounted_execute_published_history");
});

test("a pass log without a ride label is still the serving execute pass, never a defer bust", () => {
    // The ride label in the "pending ops WILL APPLY" line is new; a log written
    // before it existed proves only that the serving pass was an execute pass.
    const { dir, logPath } = drainFixture("scheduler_execute (scheduler=execute)");

    const analysis = analyzeOpenCodeCacheBustSession({
        sessionId: drainSession,
        anthropicDir: dir,
        openaiDir: join(dir, "missing"),
        mcLogPath: logPath,
    });

    expect(analysis.requests.at(-1)?.divergenceClass).toBe("accounted_soft_m1_execute");
});

test("the served execute pass raises no sentinel wake for its window", async () => {
    const { dir, logPath } = drainFixture("ride=publishedHistory (scheduler=execute)");
    const events: string[] = [];

    await runSentinelOnce(
        {
            once: true,
            send: false,
            intervalMs: 60_000,
            lookbackMs: 120_000,
            stateFile: join(dir, "state.json"),
            databasePath: join(dir, "absent.db"),
            rustStorePath: join(dir, "absent-rust.db"),
            connectionFile: join(dir, "absent.json"),
            wakeModuleId: "prefrontal-core",
            wakeAgentId: "agent_b613e5cf2ee55b8c",
            wakeFromAgent: "mc-cache-bust-sentinel",
            anthropicDir: dir,
            openaiDir: join(dir, "missing"),
            mcLogPath: logPath,
        },
        {
            now: () => drainRequestMs + 1_000,
            listActiveSessions: () => [
                {
                    sessionId: drainSession,
                    harness: "opencode",
                    projectPath: "fixture",
                    directory: dir,
                    activityMs: drainRequestMs,
                },
            ],
            loadDecisions: () => [],
            stdout: (line) => events.push(line),
        },
    );

    // The window is accounted, so the sentinel emits no wake event at all.
    expect(events).toEqual([]);
});

for (const released of [true, false]) {
    test(`Rust safety-release evidence reaches analyzer and sentinel (released=${released})`, async () => {
        const { dir, logPath } = fixture(false);
        const reason = released ? "lkg_frozen_release:lkg_unsafe_seam;first_changed=historical#2;materialize_reason=model_change" : "none";
        writeFileSync(logPath, `[2026-09-20T12:48:24.000Z] [magic-context][${session}] rust pass: decision=${released ? "HARD" : "DEFER"} reason=${reason} in=20 out=20 applied=true\n`);
        const result = analyzeOpenCodeCacheBustSession({ sessionId: session, anthropicDir: dir, openaiDir: join(dir, "missing"), mcLogPath: logPath });
        const expected = released ? "accounted_lkg_frozen_release" : "unaccounted_defer_pass";
        expect(result.requests[1]?.divergenceClass).toBe(expected);
        const joined = withSchedulerLogFallback([], session, logPath);
        if (released) expect(joined[0]?.lkgFrozenReleaseReason).toBe("lkg_unsafe_seam;first_changed=historical#2");
        const events: string[] = [];
        await runSentinelOnce({ once: true, send: false, intervalMs: 60_000, lookbackMs: 120_000, stateFile: join(dir, "state.json"), databasePath: join(dir, "absent.db"), rustStorePath: join(dir, "absent-rust.db"), connectionFile: join(dir, "absent.json"), wakeModuleId: "prefrontal-core", wakeAgentId: "fixture", wakeFromAgent: "fixture", anthropicDir: dir, openaiDir: join(dir, "missing"), mcLogPath: logPath }, {
            now: () => bTime + 1000,
            listActiveSessions: () => [{ sessionId: session, harness: "opencode", projectPath: "fixture", directory: dir, activityMs: bTime }],
            loadDecisions: () => [], stdout: (line) => events.push(line),
        });
        expect(events.some((line) => line.includes('"divergence_class":"unaccounted_defer_pass"'))).toBe(!released);
    });
}
