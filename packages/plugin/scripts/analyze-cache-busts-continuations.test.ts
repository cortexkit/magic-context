import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../src/shared/test-temp-dir";
import { __test, analyzeOpenCodeCacheBustSession } from "./analyze-cache-busts";
import {
    classifyBustAfterReclaim,
    classifyCacheBust,
    isUnaccountedCacheBustClass,
} from "./cache-bust-attribution";
import {
    eventForWindow,
    groupBustWindows,
    loadSentinelState,
    runSentinelOnce,
} from "./cache-bust-sentinel";

const roots: string[] = [];
const epoch = Date.parse("2026-09-04T10:00:00Z");
const sessionId = "ses_continuation";
const user = (text: string) => ({
    role: "user",
    content: [{ type: "text", text, cache_control: { type: "ephemeral" } }],
});
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
    const root = createTestTempDirFromPath(join(tmpdir(), "continuation-dumps-"));
    roots.push(root);
    const args = __test.parseArgs([
        "bun",
        "analyze-cache-busts.ts",
        "--session",
        sessionId,
        "--dir",
        root,
    ]);
    function dump(
        index: number,
        type: "create" | "continue" | undefined,
        messages: unknown[],
        options: {
            system?: string;
            tools?: string;
            read?: number;
            write?: number;
            systemTtl?: "1h" | "5m";
        } = {},
    ) {
        const createdAt = new Date(epoch + index * 1000).toISOString();
        const stem = `${createdAt.replace(/[:.]/g, "-")}-${index}-${sessionId}`;
        const body = join(root, `${stem}.body.json`);
        const response = join(root, `${stem}.response.json`);
        const thread = type
            ? { type, ...(type === "continue" ? { previous_message_id: `msg_${index - 1}` } : {}) }
            : undefined;
        writeFileSync(
            body,
            JSON.stringify({
                system: [
                    {
                        type: "text",
                        text: options.system ?? "system",
                        cache_control: {
                            type: "ephemeral",
                            ...(options.systemTtl ? { ttl: options.systemTtl } : {}),
                        },
                    },
                ],
                tools: [{ name: options.tools ?? "tool", input_schema: { type: "object" } }],
                messages,
                ...(thread ? { thread } : {}),
            }),
        );
        writeFileSync(
            response,
            JSON.stringify({
                message_id: `msg_${index}`,
                usage: {
                    input_tokens: 4,
                    cache_read_input_tokens: options.read ?? (index < 3 ? 100_000 : 50_000),
                    cache_creation_input_tokens: options.write ?? (index < 3 ? 0 : 50_000),
                },
            }),
        );
        writeFileSync(
            join(root, `${stem}.meta.json`),
            JSON.stringify({
                session: sessionId,
                createdAt,
                body: { thread, messagesCount: messages.length },
                files: { body, response },
            }),
        );
    }
    const snapshots = () => __test.loadSnapshots(args);
    const rows = (cacheTtlMs?: number) => __test.analyzeSnapshots(snapshots(), [], { cacheTtlMs });
    const analyze = (sinceExclusiveMs?: number, bounded = false) =>
        analyzeOpenCodeCacheBustSession({
            sessionId,
            anthropicDir: root,
            openaiDir: join(root, "missing"),
            mcLogPath: null,
            sinceExclusiveMs,
            ...(bounded ? { scanDeadlineMs: epoch + 999_999, scanNow: () => epoch } : {}),
        });
    return { root, dump, rows, snapshots, analyze };
}

test("continuation after continuation short read never compares delta messages", () => {
    const f = fixture();
    f.dump(1, "continue", [
        {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", content: "result" }],
        },
    ]);
    f.dump(3, "continue", [user("new user text")]);
    const row = f.rows()[1];
    expect(row.divergenceClass).toBe("continuation_short_read");
    expect(row.divergenceIndex).toBe(-1);
    expect(row.verdict).toBe("SHORT");
    expect(row.byteVerdict).toBeUndefined();
    expect(row.rewrittenTokens).toBe(50_000);
    expect(f.analyze().requests[1].firstDivergence).toContain("continuation");
});

test("full after continuation chain matches client bytes and skips undumped replies", () => {
    const f = fixture();
    f.dump(0, "create", [user("baseline")]);
    f.dump(1, "continue", [user("tool result")]);
    f.dump(2, "continue", [user("next user")]);
    f.dump(3, "create", [
        user("baseline"),
        assistant("undumped reply"),
        user("tool result"),
        assistant("another reply"),
        user("next user"),
    ]);
    const row = f.rows()[3];
    expect(row.divergenceClass).toBe("thread_break_unchanged_client_bytes");
    expect(row.divergenceIndex).toBe(-1);
    expect(f.analyze().requests[3].firstDivergence).toContain(
        "3 client messages compared and matched",
    );
});

test("full after chain reports real earlier-range rewrite using existing attribution", () => {
    const f = fixture();
    f.dump(0, "create", [user("baseline")]);
    f.dump(1, "continue", [user("delta")]);
    f.dump(3, "create", [user("rewritten baseline"), assistant("reply"), user("delta")]);
    const row = f.rows()[2];
    expect(row.previous?.file).toBe(f.snapshots()[0].file);
    expect(row.divergenceIndex).toBe(1);
    expect(row.divergenceClass).toBe("no_mc_pass_row");
});

test("full after chain reports a changed continuation-carried message at its full-body position", () => {
    const f = fixture();
    f.dump(0, "create", [user("baseline")]);
    f.dump(1, "continue", [user("delta one"), user("delta two")]);
    f.dump(3, "create", [
        user("baseline"),
        assistant("reply"),
        user("delta one"),
        user("changed two"),
    ]);
    const row = f.rows()[2];
    expect(row.divergenceIndex).toBe(4);
    expect(row.divergenceClass).toBe("no_mc_pass_row");
    expect(row.previous?.segments[4].canonical).toContain("delta two");
});

for (const bounded of [false, true])
    test(`full-body lookup widens past the window to its same-route baseline (bounded=${bounded})`, () => {
        const f = fixture();
        f.dump(0, "create", [user("baseline")]);
        for (let i = 1; i < 6; i++)
            f.dump(i, "continue", [user(`delta ${i}`)], { read: 100_000, write: 0 });
        f.dump(6, "create", [
            user("baseline"),
            ...Array.from({ length: 5 }, (_, i) => [
                assistant("reply"),
                user(`delta ${i + 1}`),
            ]).flat(),
        ]);
        const result = f.analyze(epoch + 5_000, bounded);
        expect(result.requests).toHaveLength(1);
        expect(result.requests[0].divergenceClass).toBe("thread_break_unchanged_client_bytes");
        expect(result.requests[0].firstDivergence).toContain(
            "6 client messages compared and matched",
        );
    });

test("full body without an earlier full baseline reports missing evidence instead of latency", () => {
    const f = fixture();
    f.dump(1, "continue", [user("delta")]);
    f.dump(3, "create", [user("unknown baseline"), assistant("reply"), user("delta")]);
    const row = f.rows()[1];
    expect(row.divergenceClass).toBe("full_body_no_baseline");
    expect(row.verdict).toBe("SHORT");
    expect(row.byteVerdict).toBeUndefined();
    expect(f.analyze().requests[1].firstDivergence).toContain("no earlier full body found");
});

test("continuation system change keeps the existing small system-row rule", () => {
    const f = fixture();
    f.dump(1, "continue", [user("delta")]);
    f.dump(3, "continue", [user("different delta")], {
        system: "changed system",
        read: 99_000,
        write: 1_000,
    });
    expect(f.rows()[1].divergenceIndex).toBe(0);
    expect(f.rows()[1].divergenceClass).toBe("system_row_shift");
});

test("continuation tools change is comparable rather than a continuation short read", () => {
    const f = fixture();
    f.dump(1, "continue", [user("delta")]);
    f.dump(3, "continue", [user("different delta")], {
        tools: "changed tool",
        read: 99_000,
        write: 1_000,
    });
    expect(f.rows()[1].divergenceClass).toBe("system_row_shift");
    expect(f.analyze().requests[1].firstDivergence).toContain("tools");
});

test("old dumps without thread remain full-body comparisons", () => {
    const f = fixture();
    f.dump(0, undefined, [user("baseline")]);
    f.dump(3, undefined, [user("changed")]);
    expect(f.rows()[1].divergenceClass).toBe("no_mc_pass_row");
    expect(f.rows()[1].divergenceIndex).toBe(1);
});

for (const type of ["continue", "create"] as const)
    test(`expired cache outranks thread evidence for ${type} bodies and runner joins`, () => {
        const f = fixture();
        f.dump(0, "create", [user("baseline")]);
        f.dump(1, "continue", [user("delta")]);
        f.dump(
            1000,
            type,
            type === "continue"
                ? [user("next delta")]
                : [user("baseline"), assistant("reply"), user("delta")],
        );
        expect(f.rows()[2].divergenceClass).toBe("idle_cache_expiry");
        expect(f.analyze().requests[2].divergenceClass).toBe("idle_cache_expiry");
        for (const kind of ["oc2", "pi"] as const) {
            const dumps = f.snapshots();
            const snapshots = __test.runnerSnapshots(
                {
                    kind,
                    session: sessionId,
                    files: [],
                    requests: dumps.map((dump) => ({
                        id: dump.file,
                        at: dump.requestTimestampMs,
                        sequence: dump.sequence,
                        model: "claude-opus",
                        provider: "anthropic",
                        usage: {
                            input: dump.usage!.input,
                            output: 10,
                            cacheRead: dump.usage!.cacheRead,
                            cacheWrite: dump.usage!.cacheCreation ?? 0,
                        },
                    })),
                },
                dumps,
            );
            expect(
                __test.analyzeSnapshots(snapshots, [], { cacheTtlMs: 300_000 })[2].divergenceClass,
            ).toBe("idle_cache_expiry");
        }
        expect(
            classifyCacheBust({
                divergenceIndex: -1,
                previousMessageCount: 2,
                idleCacheExpiry: true,
                threadEvidence:
                    type === "continue"
                        ? "continuation_short_read"
                        : "thread_break_unchanged_client_bytes",
            }),
        ).toBe("idle_cache_expiry");
    });

for (const kind of ["oc2", "pi"] as const)
    test(`${kind} runner adapter keeps continuation metadata when joining bodies to its meter`, () => {
        const f = fixture();
        f.dump(1, "continue", [user("delta")]);
        f.dump(3, "continue", [user("different delta")]);
        const snapshots = __test.runnerSnapshots(
            {
                kind,
                session: sessionId,
                files: [],
                requests: [1, 3].map((index) => ({
                    id: String(index),
                    at: epoch + index * 1000,
                    sequence: index,
                    model: "claude-opus",
                    provider: "anthropic",
                    usage: {
                        input: 4,
                        output: 10,
                        cacheRead: index === 1 ? 100_000 : 50_000,
                        cacheWrite: index === 1 ? 0 : 50_000,
                    },
                })),
            },
            f.snapshots(),
        );
        expect(__test.analyzeSnapshots(snapshots)[1].divergenceClass).toBe(
            "continuation_short_read",
        );
    });

test("table marks deltas and full-versus-full show-diff prints the real earlier body", () => {
    const f = fixture();
    f.dump(0, "create", [user("baseline")]);
    f.dump(1, "continue", [user("delta")]);
    f.dump(3, "create", [user("changed baseline"), assistant("reply"), user("delta")]);
    const result = Bun.spawnSync(
        [
            process.execPath,
            join(import.meta.dir, "analyze-cache-busts.ts"),
            "--source",
            "dumps",
            "--session",
            sessionId,
            "--dir",
            f.root,
            "--mc-log",
            join(f.root, "missing.log"),
            "--all-rows",
            "--show-diff",
        ],
        { cwd: join(import.meta.dir, ".."), windowsHide: true },
    );
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain("1c |");
    expect(output).toContain("continuation; message bytes not comparable");
    expect(output).toContain("prev:");
    expect(output).toContain("baseline");
    expect(output).toContain("changed baseline");
});

for (const divergenceClass of [
    "continuation_short_read",
    "thread_break_unchanged_client_bytes",
    "full_body_no_baseline",
] as const) {
    for (const tokens of [19_999, 20_000])
        test(`sentinel ${divergenceClass} wake policy at ${tokens} rewritten tokens`, async () => {
            const f = fixture();
            const stateFile = join(f.root, "state.json");
            const state = loadSentinelState(stateFile);
            const row = {
                session: sessionId,
                at: new Date(epoch).toISOString(),
                timestampMs: epoch,
                verdict: "SHORT" as const,
                rewrittenTokens: tokens,
                divergenceClass,
                firstDivergence: "client bytes not comparable",
                analyzerCmd: "fixture",
            };
            const shouldWake = divergenceClass !== "continuation_short_read" && tokens >= 20_000;
            expect(isUnaccountedCacheBustClass(divergenceClass, tokens)).toBe(shouldWake);
            expect(classifyBustAfterReclaim("accounted_ctx_reduce", divergenceClass)).toBe(
                divergenceClass,
            );
            const window = groupBustWindows([row])[0];
            expect(Boolean(eventForWindow(window, "fixture", state))).toBe(shouldWake);
            if (!shouldWake && divergenceClass !== "continuation_short_read") {
                expect(Object.values(state.suppressedWindows)).toEqual([
                    { divergenceClass, rewrittenTokens: tokens },
                ]);
                expect(eventForWindow(window, "fixture", state)).toBeNull();
                expect(Object.keys(state.suppressedWindows)).toHaveLength(1);
                const crossed = { ...window, rows: [{ ...row, rewrittenTokens: 20_000 }] };
                expect(eventForWindow(crossed, "fixture", state)?.payload.divergence_class).toBe(
                    divergenceClass,
                );
            }
            const output: string[] = [];
            const counters = await runSentinelOnce(
                {
                    once: true,
                    send: false,
                    intervalMs: 60_000,
                    lookbackMs: 500,
                    stateFile,
                    databasePath: join(f.root, "missing.db"),
                    rustStorePath: join(f.root, "missing-store.db"),
                    connectionFile: join(f.root, "missing.json"),
                    wakeModuleId: "fixture",
                    wakeAgentId: "fixture",
                    wakeFromAgent: "fixture",
                },
                {
                    now: () => epoch + 1,
                    listActiveSessions: () => [
                        {
                            sessionId,
                            harness: "opencode",
                            projectPath: "fixture",
                            activityMs: epoch,
                        },
                    ],
                    loadDecisions: () => [],
                    analyzeSession: async () => ({ requests: [row], highWaterMarkMs: epoch }),
                    stdout: (line) => output.push(line),
                    stderr: () => {},
                },
            );
            expect(counters.dryRun).toBe(shouldWake ? 1 : 0);
            expect(output).toHaveLength(shouldWake ? 1 : 0);
            if (!shouldWake && divergenceClass !== "continuation_short_read")
                expect(Object.values(loadSentinelState(stateFile).suppressedWindows)).toEqual([
                    { divergenceClass, rewrittenTokens: tokens },
                ]);
        });
}

test("suppressed thread-break observations do not suppress other wake classes", () => {
    const f = fixture();
    const state = loadSentinelState(join(f.root, "state.json"));
    const row = {
        session: sessionId,
        at: new Date(epoch).toISOString(),
        timestampMs: epoch,
        verdict: "BUST" as const,
        rewrittenTokens: 500,
        divergenceClass: "thread_break_unchanged_client_bytes" as const,
        firstDivergence: "unchanged",
        analyzerCmd: "fixture",
    };
    const window = groupBustWindows([row])[0];
    expect(eventForWindow(window, "fixture", state)).toBeNull();
    expect(
        eventForWindow(
            { ...window, rows: [row, { ...row, divergenceClass: "unaccounted_rewrite" }] },
            "fixture",
            state,
        )?.payload.divergence_class,
    ).toBe("unaccounted_rewrite");
});

for (const laterClass of [
    "thread_break_unchanged_client_bytes",
    "continuation_short_read",
] as const)
    test(`suppressed thread windows use only their own tokens across scans (${laterClass})`, async () => {
        const f = fixture();
        const stateFile = join(f.root, "state.json");
        const options = {
            once: true,
            send: false,
            intervalMs: 60_000,
            lookbackMs: 500,
            stateFile,
            databasePath: join(f.root, "missing.db"),
            rustStorePath: join(f.root, "missing-store.db"),
            connectionFile: join(f.root, "missing.json"),
            wakeModuleId: "fixture",
            wakeAgentId: "fixture",
            wakeFromAgent: "fixture",
        };
        const threadBreakOnly = laterClass === "thread_break_unchanged_client_bytes";
        const requests = (threadBreakOnly ? [12_000, 12_000] : [19_000, 10_000, 10_000]).map(
            (rewrittenTokens, index) => ({
                session: sessionId,
                at: new Date(epoch + index * 1000).toISOString(),
                timestampMs: epoch + index * 1000,
                verdict: "SHORT" as const,
                rewrittenTokens,
                divergenceClass:
                    index === 0 ? ("thread_break_unchanged_client_bytes" as const) : laterClass,
                firstDivergence: "unchanged",
                analyzerCmd: "fixture",
            }),
        );
        let now = epoch;
        const events: string[] = [];
        const deps = {
            now: () => now,
            listActiveSessions: () => [
                {
                    sessionId,
                    harness: "opencode" as const,
                    projectPath: "fixture",
                    activityMs: now,
                },
            ],
            loadDecisions: () => [],
            analyzeSession: async () => ({ requests, highWaterMarkMs: now }),
            stdout: (line: string) => events.push(line),
            stderr: () => {},
        };
        await runSentinelOnce(options, deps);
        expect(events).toHaveLength(0);
        expect(
            Object.values(loadSentinelState(stateFile).suppressedWindows)[0].rewrittenTokens,
        ).toBe(threadBreakOnly ? 12_000 : 19_000);
        await runSentinelOnce(options, deps);
        expect(
            Object.values(loadSentinelState(stateFile).suppressedWindows)[0].rewrittenTokens,
        ).toBe(threadBreakOnly ? 12_000 : 19_000);
        now += (requests.length - 1) * 1000;
        await runSentinelOnce(options, deps);
        expect(events).toHaveLength(threadBreakOnly ? 1 : 0);
        if (threadBreakOnly) {
            expect(JSON.parse(events[0]).payload.rewritten_tokens).toBe(24_000);
            expect(JSON.parse(events[0]).payload.divergence_class).toBe(
                "thread_break_unchanged_client_bytes",
            );
        } else {
            expect(
                Object.values(loadSentinelState(stateFile).suppressedWindows)[0].rewrittenTokens,
            ).toBe(19_000);
        }
    });

test("thread-only token threshold excludes accounted folds and sums thread rows in one scan", () => {
    const f = fixture();
    const state = loadSentinelState(join(f.root, "state.json"));
    const row = (
        offset: number,
        rewrittenTokens: number,
        divergenceClass: "accounted_hard_fold" | "thread_break_unchanged_client_bytes",
    ) => ({
        session: sessionId,
        at: new Date(epoch + offset).toISOString(),
        timestampMs: epoch + offset,
        verdict: "BUST" as const,
        rewrittenTokens,
        divergenceClass,
        firstDivergence: "fixture",
        analyzerCmd: "fixture",
    });
    const accounted = groupBustWindows([
        row(0, 300_000, "accounted_hard_fold"),
        row(1000, 2_000, "thread_break_unchanged_client_bytes"),
    ])[0];
    expect(eventForWindow(accounted, "fixture", state)).toBeNull();
    expect(Object.values(state.suppressedWindows)).toEqual([
        { divergenceClass: "thread_break_unchanged_client_bytes", rewrittenTokens: 2_000 },
    ]);
    const threads = groupBustWindows([
        row(10_000, 12_000, "thread_break_unchanged_client_bytes"),
        row(11_000, 12_000, "thread_break_unchanged_client_bytes"),
    ])[0];
    expect(eventForWindow(threads, "fixture", state)?.payload.rewritten_tokens).toBe(24_000);
    expect(eventForWindow(threads, "fixture", state)).toBeNull();
});

for (const type of ["continue", "create"] as const) {
    for (const scenario of [
        { name: "1h breakpoint survives 12 minutes", ttl: "1h", gapSeconds: 720, expired: false },
        {
            name: "unstated lifetime expires after 12 minutes",
            ttl: undefined,
            gapSeconds: 720,
            expired: true,
        },
        {
            name: "1h breakpoint expires after 61 minutes",
            ttl: "1h",
            gapSeconds: 3660,
            expired: true,
        },
        {
            name: "explicit 5m overrides a stated 1h",
            ttl: "1h",
            gapSeconds: 720,
            expired: true,
            overrideMs: 300_000,
        },
    ] as const)
        test(`request cache lifetime for ${type}: ${scenario.name}`, () => {
            const f = fixture();
            f.dump(0, "create", [user("baseline")], { systemTtl: scenario.ttl });
            f.dump(1, "continue", [user("delta")], { systemTtl: scenario.ttl });
            f.dump(
                1 + scenario.gapSeconds,
                type,
                type === "continue"
                    ? [user("next delta")]
                    : [user("baseline"), assistant("reply"), user("delta")],
                { systemTtl: "1h" },
            );
            const overrideMs = "overrideMs" in scenario ? scenario.overrideMs : undefined;
            const expected = scenario.expired
                ? "idle_cache_expiry"
                : type === "continue"
                  ? "continuation_short_read"
                  : "thread_break_unchanged_client_bytes";
            expect(f.rows(overrideMs)[2].divergenceClass).toBe(expected);
            const result = analyzeOpenCodeCacheBustSession({
                sessionId,
                anthropicDir: f.root,
                openaiDir: join(f.root, "missing"),
                mcLogPath: null,
                cacheTtlMs: overrideMs,
            });
            expect(result.requests[2].divergenceClass).toBe(expected);
        });
}

for (const longBreakpoint of ["system", "message"] as const)
    test(`request cache lifetime uses the longest stated breakpoint (${longBreakpoint})`, () => {
        const f = fixture();
        const message = user("baseline");
        const withTtl = {
            ...message,
            content: message.content.map((part) => ({
                ...part,
                cache_control: {
                    type: "ephemeral",
                    ttl: longBreakpoint === "message" ? "1h" : "5m",
                },
            })),
        };
        f.dump(0, "create", [withTtl], { systemTtl: longBreakpoint === "system" ? "1h" : "5m" });
        f.dump(720, "continue", [user("delta")]);
        expect(f.rows()[1].divergenceClass).toBe("continuation_short_read");
    });

for (const stated of [false, true])
    test(`request cache lifetime for runner joined bodies (stated 5m=${stated})`, () => {
        const f = fixture();
        f.dump(0, "create", [user("baseline")], { systemTtl: stated ? "5m" : undefined });
        f.dump(360, "continue", [user("delta")]);
        const dumps = f.snapshots();
        for (const kind of ["oc2", "pi"] as const) {
            const snapshots = __test.runnerSnapshots(
                {
                    kind,
                    session: sessionId,
                    files: [],
                    requests: dumps.map((dump) => ({
                        id: dump.file,
                        at: dump.requestTimestampMs,
                        sequence: dump.sequence,
                        model: "claude-opus",
                        provider: "anthropic",
                        usage: {
                            input: dump.usage!.input,
                            output: 10,
                            cacheRead: dump.usage!.cacheRead,
                            cacheWrite: dump.usage!.cacheCreation ?? 0,
                        },
                    })),
                },
                dumps,
            );
            expect(__test.analyzeSnapshots(snapshots)[1].divergenceClass).toBe(
                stated ? "idle_cache_expiry" : "continuation_short_read",
            );
        }
    });

test("request cache lifetime comes from the previous request of the same route", () => {
    const f = fixture();
    f.dump(0, "create", [user("baseline")], { systemTtl: "1h" });
    f.dump(1, "create", [user("other route")], { systemTtl: "5m" });
    f.dump(721, "continue", [user("delta")]);
    const snapshots = f.snapshots();
    snapshots[1].sourceDir = join(f.root, "another-route");
    expect(__test.analyzeSnapshots(snapshots)[2].divergenceClass).toBe("continuation_short_read");
});

test("request cache lifetime explicit --cache-ttl overrides the dump lifetime", () => {
    const f = fixture();
    f.dump(0, "create", [user("baseline")], { systemTtl: "1h" });
    f.dump(720, "continue", [user("delta")], { systemTtl: "1h" });
    const result = Bun.spawnSync(
        [
            process.execPath,
            join(import.meta.dir, "analyze-cache-busts.ts"),
            "--source",
            "dumps",
            "--session",
            sessionId,
            "--dir",
            f.root,
            "--mc-log",
            join(f.root, "missing.log"),
            "--cache-ttl",
            "5m",
        ],
        { cwd: join(import.meta.dir, ".."), windowsHide: true },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("divergence-class: idle_cache_expiry");
});
