import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    type AnalyzedCacheRequest,
    CACHE_BUST_RULE_TABLE,
    type CacheBustAttributionInput,
    type CacheBustDecisionAttribution,
    type CacheBustDivergenceClass,
    classifyCacheBust,
    createCacheBustDecisionJoiner,
    DEFAULT_CACHE_TTL_MS,
    isUnaccountedCacheBustClass,
    nearestCacheBustDecision,
} from "./cache-bust-attribution";
import {
    __test,
    type ActiveCacheBustSession,
    agentDeliverRequest,
    type AgentDeliverReply,
    type CacheBustEvent,
    CacheBustSentinelInputError,
    type CacheBustSentinelOptions,
    cacheBustWindowId,
    eventForWindow,
    groupBustWindows,
    loadSentinelState,
    loadSessionDecisions,
    parseAgentDeliverReply,
    parseSentinelArgs,
    runSentinelOnce,
    saveSentinelState,
    SubcWakeEventTransport,
} from "./cache-bust-sentinel";
import { disruptionLogMarkers } from "./cache-bust-scheduler-log";

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
    const directory = mkdtempSync(join(tmpdir(), label));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function request(
    timestampMs: number,
    verdict: AnalyzedCacheRequest["verdict"] = "BUST",
    divergenceClass = "unaccounted_rewrite",
    rewrittenTokens = verdict === "BUST" ? 123 : undefined,
): AnalyzedCacheRequest {
    return {
        session: "ses_sentinel",
        at: new Date(timestampMs).toISOString(),
        timestampMs,
        verdict,
        rewrittenTokens,
        divergenceClass:
            verdict === "BUST" || divergenceClass === "usage_missing"
                ? (divergenceClass as never)
                : undefined,
        firstDivergence: "message[4] role=assistant",
        analyzerCmd:
            "cd packages/plugin && bun scripts/analyze-cache-busts.ts --session ses_sentinel",
    };
}

function options(stateFile: string): CacheBustSentinelOptions {
    return {
        once: true,
        send: false,
        intervalMs: 60_000,
        lookbackMs: 500,
        stateFile,
        databasePath: join(stateFile, "missing-context.db"),
        rustStorePath: join(stateFile, "missing-store.db"),
        connectionFile: join(stateFile, "missing-subc.json"),
        wakeModuleId: "prefrontal-core",
        wakeAgentId: "agent_b613e5cf2ee55b8c",
        wakeFromAgent: "mc-cache-bust-sentinel",
    };
}

const activeSession: ActiveCacheBustSession = {
    sessionId: "ses_sentinel",
    harness: "opencode",
    projectPath: "dir:test-project",
    activityMs: 1_000,
    directory: "/tmp/sentinel-project",
};

function decision(partial: Partial<CacheBustDecisionAttribution>): CacheBustDecisionAttribution {
    return {
        timestampMs: 1,
        decision: "execute",
        materialized: false,
        materializeReason: null,
        emergency: false,
        droppedTokens: 0,
        droppedCount: 0,
        inputTokens: 10_000,
        flush: false,
        source: "fixture",
        ...partial,
    };
}

describe("cache-bust attribution contract", () => {
    test("joins one fixture decision row for every accounted and unaccounted class", () => {
        const fixture = JSON.parse(
            readFileSync(
                join(import.meta.dir, "test-fixtures", "cache-bust-sentinel", "classifier.json"),
                "utf8",
            ),
        ) as Array<{
            class: CacheBustDivergenceClass;
            decisionTimestampOffsetMs?: number;
            decision: Partial<CacheBustDecisionAttribution>;
            input: Omit<Partial<CacheBustAttributionInput>, "decision">;
        }>;
        expect(fixture.map((row) => row.class)).toEqual(
            CACHE_BUST_RULE_TABLE.map((row) => row.divergenceClass),
        );

        for (const row of fixture) {
            const passTimestampMs = 10_000;
            const joinedDecision = nearestCacheBustDecision(
                [
                    decision({
                        ...row.decision,
                        timestampMs: passTimestampMs + (row.decisionTimestampOffsetMs ?? 0),
                    }),
                ],
                passTimestampMs,
            );
            const input: CacheBustAttributionInput = {
                ...row.input,
                divergenceIndex: row.input.divergenceIndex ?? 2,
                previousMessageCount: row.input.previousMessageCount ?? 10,
                decision: joinedDecision,
            };
            expect(classifyCacheBust(input)).toBe(row.class);
            expect(isUnaccountedCacheBustClass(row.class)).toBe(
                !CACHE_BUST_RULE_TABLE.find((rule) => rule.divergenceClass === row.class)
                    ?.accounted,
            );
        }
    });

    test("accounts a released frozen replay before the defer rule", () => {
        const classified = classifyCacheBust({
            divergenceIndex: 2,
            previousMessageCount: 10,
            decision: decision({
                decision: "defer",
                canonicalDecision: "defer",
                lkgFrozenReleaseReason: "lkg_unsafe_seam",
            }),
        });

        expect(classified).toBe("accounted_lkg_frozen_release");
        expect(isUnaccountedCacheBustClass(classified)).toBe(false);
    });

    test("a defer bust without a frozen release remains unaccounted", () => {
        const classified = classifyCacheBust({
            divergenceIndex: 2,
            previousMessageCount: 10,
            decision: decision({ decision: "defer", canonicalDecision: "defer" }),
        });

        expect(classified).toBe("unaccounted_defer_pass");
        expect(isUnaccountedCacheBustClass(classified)).toBe(true);
    });

    test("a mural-only epoch is self-inflicted unless an external epoch independently explains it", () => {
        const classify = (externalEpoch: boolean): CacheBustDivergenceClass =>
            classifyCacheBust({
                divergenceIndex: 2,
                previousMessageCount: 10,
                decision: decision({
                    materialized: true,
                    materializeReason: "epoch_change",
                    identityDelta: ["mur"],
                    externalEpoch,
                }),
            });

        expect(classify(false)).toBe("self_inflicted_epoch");
        expect(classify(true)).toBe("accounted_hard_epoch");
    });

    test("two epoch HARDs within a minute without an external epoch wake the sentinel", () => {
        const first = decision({ timestampMs: 10_000, materialized: true, materializeReason: "epoch_change", identityDelta: ["other"] });
        const second = decision({ timestampMs: 16_000, materialized: true, materializeReason: "epoch_change", identityDelta: ["other"] });
        const classify = (prior: CacheBustDecisionAttribution, current: CacheBustDecisionAttribution) => classifyCacheBust({
            divergenceIndex: 2,
            previousMessageCount: 10,
            decision: current,
            previousEpochHard: prior,
        });
        expect(classify(first, second)).toBe("self_inflicted_epoch");
        expect(classify(first, { ...second, externalEpoch: true })).toBe("accounted_hard_epoch");
        expect(classify({ ...first, timestampMs: -50_000 }, second)).toBe("accounted_hard_epoch");
        expect(classify(first, { ...second, materializeReason: "model_change" })).toBe("accounted_hard_model_change");
    });

    test("an epoch HARD with no disruption in the preceding minute wakes as unfaulted", () => {
        const hard = decision({
            timestampMs: 100_000,
            materialized: true,
            materializeReason: "epoch_change",
            identityDelta: ["other"],
        });
        const classify = (
            precedingDisruption: string | null | undefined,
            current: CacheBustDecisionAttribution = hard,
        ) =>
            classifyCacheBust({
                divergenceIndex: 2,
                previousMessageCount: 10,
                decision: current,
                precedingDisruption,
            });
        expect(classify(null)).toBe("unfaulted_epoch");
        expect(isUnaccountedCacheBustClass("unfaulted_epoch")).toBe(true);
        expect(classify("full_retry")).toBe("accounted_hard_epoch");
        expect(classify("module_fault")).toBe("accounted_hard_epoch");
        // No adapter log: the disruption question is unanswered, so it stays accounted.
        expect(classify(undefined)).toBe("accounted_hard_epoch");
        expect(classify(null, { ...hard, externalEpoch: true })).toBe("accounted_hard_epoch");
    });

    test("reads fault, retry, fallback, and restart markers from the adapter log", () => {
        const session = "ses_313660571ffeZTsf4koSJwk50Q";
        const line = (at: string, body: string, id = session) =>
            `[${at}] [magic-context][${id}] ${body}`;
        const text = [
            line("2026-09-22T23:36:30.883Z", "transform stage: stage=rust.state_sync elapsed=5390.5ms retry=full reason=need_full_sync"),
            line("2026-09-22T23:36:31.000Z", "need_full_sync retry=full ordinal_memo=kept"),
            line("2026-09-23T00:11:14.902Z", "rust pass: decision=error reason=none served_from=raw in=929 out=929 applied=false"),
            line("2026-09-23T00:12:00.000Z", "rust pass: decision=SOFT+ reason=none served_from=lkg in=929 out=900 applied=false"),
            line("2026-09-23T00:13:00.000Z", "transform stage: stage=rust.ordinal_rebuild elapsed=900.0ms mode=prime rows=124219 pages=249 rewinds=0 cause=cold"),
            line("2026-09-23T00:14:00.000Z", "rust pass: decision=SOFT+ reason=none served_from=transform in=929 out=900 applied=true"),
            line("2026-09-23T00:15:00.000Z", "transform stage: stage=rust.ordinal_rebuild elapsed=90.0ms mode=rewind rows=499 pages=1 rewinds=1 cause=store_drift"),
            line("2026-09-23T00:16:00.000Z", "rust pass: decision=error reason=none served_from=raw", "ses_other"),
        ].join("\n");
        expect(
            disruptionLogMarkers(text, session).map((marker) => ({
                at: new Date(marker.timestampMs).toISOString(),
                kind: marker.disruption,
            })),
        ).toEqual([
            { at: "2026-09-22T23:36:30.883Z", kind: "full_retry" },
            { at: "2026-09-22T23:36:31.000Z", kind: "full_retry" },
            { at: "2026-09-23T00:11:14.902Z", kind: "module_fault" },
            { at: "2026-09-23T00:12:00.000Z", kind: "fallback_serve" },
            { at: "2026-09-23T00:13:00.000Z", kind: "adapter_restart" },
        ]);
    });

    test("the wake for an unfaulted epoch names the identity_delta components", () => {
        const row = {
            ...request(1_000, "BUST", "unfaulted_epoch"),
            identityDelta: ["other", "tfe"],
        };
        const [window] = groupBustWindows([row]);
        const event = eventForWindow(window!, "/tmp/sentinel-project", __test.defaultState());
        expect(event?.payload).toMatchObject({
            divergence_class: "unfaulted_epoch",
            identity_delta: ["other", "tfe"],
        });
        const wake = agentDeliverRequest(event!, "agent", "from");
        expect(wake.body.content).toContain("divergence_class=unfaulted_epoch");
        expect(wake.body.content).toContain("identity_delta=other,tfe");
    });

    test("a zero provider read with no MC pass row is still a provider full miss, not no_mc_pass_row", () => {
        // A billing-header rotation on a subagent session (no decision row) rewrote
        // 322k tokens at read=0; the sentinel woke the operator with
        // no_mc_pass_row because the pass-row join ran before the usage classes.
        const cls = classifyCacheBust({
            divergenceIndex: 0,
            firstDivergenceRole: "system",
            previousMessageCount: 248,
            providerComparableRead: 0,
            directInput: 2,
            previousTotal: 321_872,
            promptTokens: 322_315,
            rewrittenTokens: 322_315,
            decision: undefined,
        });
        expect(cls).toBe("provider_full_miss");
        expect(isUnaccountedCacheBustClass(cls)).toBe(false);
        // Absent usage on a row-less request stays usage_missing, and a short
        // (non-zero) read with no row is still the unaccounted no_mc_pass_row.
        expect(
            classifyCacheBust({
                divergenceIndex: 3,
                previousMessageCount: 10,
                providerComparableRead: 0,
                directInput: 0,
                previousTotal: 50_000,
                decision: undefined,
            }),
        ).toBe("usage_missing");
        expect(
            classifyCacheBust({
                divergenceIndex: 3,
                previousMessageCount: 10,
                providerComparableRead: 20_000,
                directInput: 500,
                previousTotal: 50_000,
                decision: undefined,
            }),
        ).toBe("no_mc_pass_row");
    });

    test("classifies a zero provider read as a full miss but keeps a short read unaccounted", () => {
        const fullMiss = classifyCacheBust({
            divergenceIndex: 4,
            previousMessageCount: 20,
            providerComparableRead: 0,
            previousTotal: 594_149,
            previousModel: "claude-opus-5",
            currentModel: "claude-opus-4-8",
            decision: decision({ decision: "defer", canonicalDecision: "defer" }),
        });
        expect(fullMiss).toBe("provider_full_miss");
        expect(isUnaccountedCacheBustClass(fullMiss)).toBe(false);

        expect(
            classifyCacheBust({
                divergenceIndex: 4,
                previousMessageCount: 20,
                providerComparableRead: 1,
                previousTotal: 594_149,
                decision: decision({ decision: "defer", canonicalDecision: "defer" }),
            }),
        ).toBe("unaccounted_defer_pass");
    });

    test("joins the execute pass that served the request, not the next turn's nearer defer", () => {
        // 2026-09-21 12:26:17Z: the request was shaped by the 12:26:08Z execute
        // pass — nine seconds of module and host latency between the pass and the
        // send — while the next turn's defer pass ran four seconds after it.
        // Ranking candidates by absolute distance picked that defer, and the
        // request was reported as an unaccounted defer bust.
        const requestMs = Date.parse("2026-09-21T12:26:17.760Z");
        const servingExecute = decision({
            timestampMs: Date.parse("2026-09-21T12:26:08.421Z"),
            decision: "execute",
            canonicalDecision: "execute",
            appliedRide: "publishedHistory",
            source: "transform scheduler log",
        });
        const nextTurnDefer = decision({
            timestampMs: Date.parse("2026-09-21T12:26:22.102Z"),
            decision: "defer",
            canonicalDecision: "defer",
            source: "transform scheduler log",
        });
        const bust = {
            divergenceIndex: 1,
            previousMessageCount: 594,
            providerComparableRead: 285_161,
            directInput: 2,
            previousTotal: 654_353,
        };

        const joined = nearestCacheBustDecision([nextTurnDefer, servingExecute], requestMs);

        expect(joined).toBe(servingExecute);
        const cls = classifyCacheBust({ ...bust, decision: joined });
        expect(cls).toBe("accounted_execute_published_history");
        expect(isUnaccountedCacheBustClass(cls)).toBe(false);
        // The defer really is the class this request used to get, so the two
        // candidates are not interchangeable.
        expect(classifyCacheBust({ ...bust, decision: nextTurnDefer })).toBe(
            "unaccounted_defer_pass",
        );
    });

    test("does not join a following pass when no pass ran before the request", () => {
        const requestMs = Date.parse("2026-09-21T12:26:17.760Z");
        const following = decision({
            timestampMs: requestMs + 4_000,
            decision: "defer",
            canonicalDecision: "defer",
        });

        expect(nearestCacheBustDecision([following], requestMs)).toBeUndefined();
        expect(
            nearestCacheBustDecision([decision({ timestampMs: requestMs + 5_001 })], requestMs),
        ).toBeUndefined();
    });

    test("joins a pressure-refold pass sent 31 seconds after its decision row", () => {
        const servingPass = decision({
            timestampMs: Date.parse("2026-10-28T12:56:32Z"),
            materialized: true,
            materializeReason: "pressure_refold",
            droppedCount: 183,
        });
        const joined = nearestCacheBustDecision([servingPass], Date.parse("2026-10-28T12:57:03Z"));
        expect(joined).toBe(servingPass);
        expect(
            classifyCacheBust({ divergenceIndex: 2, previousMessageCount: 200, decision: joined }),
        ).toBe("accounted_hard_pressure_refold");
    });

    test("consecutive requests each claim their nearest unclaimed preceding pass", () => {
        const first = decision({ timestampMs: 10_000 });
        const second = decision({ timestampMs: 50_000 });
        const join = createCacheBustDecisionJoiner([second, first]);

        expect(join(41_000)).toBe(first);
        expect(join(81_000)).toBe(second);
        expect(join(82_000)).toBeUndefined();
    });

    test("a pass older than one default cache TTL leaves no_mc_pass_row", () => {
        const stale = decision({ timestampMs: 10_000 });
        const atBound = nearestCacheBustDecision([stale], 10_000 + DEFAULT_CACHE_TTL_MS);
        expect(atBound).toBe(stale);
        const joined = nearestCacheBustDecision([stale], 10_001 + DEFAULT_CACHE_TTL_MS);
        expect(joined).toBeUndefined();
        expect(
            classifyCacheBust({ divergenceIndex: 2, previousMessageCount: 200, decision: joined }),
        ).toBe("no_mc_pass_row");
    });

    test("accounts all ten long-turn post-restart rows by request time", () => {
        const rows = JSON.parse(
            readFileSync(
                join(
                    import.meta.dir,
                    "test-fixtures",
                    "cache-bust-sentinel",
                    "restart-long-turns.json",
                ),
                "utf8",
            ),
        ) as Array<{ session: string; request: string }>;
        expect(rows).toHaveLength(10);
        for (const row of rows) {
            const requestTimestampMs = Date.parse(row.request);
            const matched = nearestCacheBustDecision(
                [
                    decision({
                        timestampMs: requestTimestampMs - 20_000,
                        decision: "defer",
                        materialized: true,
                        materializeReason: "system_hash",
                    }),
                ],
                requestTimestampMs,
            );
            expect(
                classifyCacheBust({
                    divergenceIndex: 0,
                    previousMessageCount: 100,
                    firstDivergenceRole: "system",
                    rewrittenTokens: 400_000,
                    promptTokens: 400_000,
                    decision: matched,
                }),
                row.session,
            ).toBe("accounted_hard_system_hash");
        }
    });

    test("creation meter vetoes system-row forgiveness despite a tiny rewrite estimate", () => {
        expect(
            classifyCacheBust({
                divergenceIndex: 0,
                previousMessageCount: 1197,
                firstDivergenceRole: "system",
                rewrittenTokens: 4,
                cacheCreationTokens: 202_813,
                promptTokens: 493_606,
                decision: decision({
                    decision: "defer",
                    materialized: false,
                    materializeReason: null,
                }),
            }),
        ).toBe("accounted_hard_system_hash");
    });

    test("keeps a tiny mid-history first_render seam unaccounted on a defer pass", () => {
        expect(
            classifyCacheBust({
                divergenceIndex: 268,
                previousMessageCount: 2_400,
                firstDivergenceRole: "user",
                firstDivergenceSize: 24,
                rewrittenTokens: 239_000,
                promptTokens: 256_000,
                decision: decision({
                    decision: "defer",
                    materialized: true,
                    materializeReason: "first_render",
                }),
            }),
        ).toBe("unaccounted_defer_pass");
    });

    test("uses a matched MC pass to distinguish a restart-sized system rewrite from effort-row noise", () => {
        const matchedDefer = decision({ decision: "defer", timestampMs: 10_000 });
        expect(
            classifyCacheBust({
                divergenceIndex: 0,
                previousMessageCount: 100,
                firstDivergenceRole: "system",
                rewrittenTokens: 536_000,
                promptTokens: 350_000,
                decision: nearestCacheBustDecision([matchedDefer], 10_100),
            }),
        ).toBe("accounted_hard_system_hash");
        expect(
            classifyCacheBust({
                divergenceIndex: 0,
                previousMessageCount: 100,
                firstDivergenceRole: "system",
                rewrittenTokens: 2_000,
                promptTokens: 350_000,
                decision: nearestCacheBustDecision([matchedDefer], 10_100),
            }),
        ).toBe("system_row_shift");
    });
});

describe("cache-bust windows and ids", () => {
    test("groups only consecutive BUST requests no more than 120 seconds apart", () => {
        const windows = groupBustWindows([
            request(1_000),
            request(121_000),
            request(121_001, "STABLE"),
            request(122_000),
            request(242_001),
        ]);

        expect(windows.map((window) => window.rows.map((row) => row.timestampMs))).toEqual([
            [1_000, 121_000],
            [122_000],
            [242_001],
        ]);
    });

    test("does not alert on a zero-rewrite tail shrink but still alerts on a 1,000-token tail rewrite", async () => {
        const directory = temporaryDirectory("cache-bust-tail-shrink-alerts-");
        const zeroState = join(directory, "zero-state.json");
        const zeroLogs: string[] = [];
        const zeroStdout: string[] = [];
        const zeroCalls: CacheBustEvent[] = [];
        const zero = await runSentinelOnce(
            { ...options(zeroState), send: true },
            {
                now: () => 2_000,
                listActiveSessions: () => [{ ...activeSession, activityMs: 2_000 }],
                analyzeSession: async () => ({
                    requests: [request(1_800, "BUST", "tail_shrink_no_rewrite", 0)],
                    highWaterMarkMs: 1_800,
                    directory: "/tmp/tail-shrink",
                }),
                transport: {
                    async record(event) {
                        zeroCalls.push(event);
                        return { disposition: "delivered", committed_order: 1 };
                    },
                },
                stdout: (line) => zeroStdout.push(line),
                stderr: (line) => zeroLogs.push(line),
            },
        );

        expect(zeroCalls).toEqual([]);
        expect(zeroStdout).toEqual([]);
        expect(zero).toMatchObject({ accountedWindows: 1, unaccountedWindows: 0 });
        expect(zeroLogs.map((line) => JSON.parse(line))).toContainEqual(
            expect.objectContaining({
                kind: "cache_bust_sentinel_observation",
                session_id: "ses_sentinel",
                divergence_class: "tail_shrink_no_rewrite",
                rewritten_tokens: 0,
            }),
        );

        const rewriteState = join(directory, "rewrite-state.json");
        const rewriteCalls: CacheBustEvent[] = [];
        const rewrite = await runSentinelOnce(
            { ...options(rewriteState), send: true },
            {
                now: () => 2_000,
                listActiveSessions: () => [{ ...activeSession, activityMs: 2_000 }],
                analyzeSession: async () => ({
                    requests: [request(1_800, "BUST", "unaccounted_tail_rewrite", 1_000)],
                    highWaterMarkMs: 1_800,
                    directory: "/tmp/tail-rewrite",
                }),
                transport: {
                    async record(event) {
                        rewriteCalls.push(event);
                        return { disposition: "delivered", committed_order: 2 };
                    },
                },
                stdout: () => {},
                stderr: () => {},
            },
        );

        expect(rewriteCalls).toHaveLength(1);
        expect(rewriteCalls[0]?.payload).toMatchObject({
            divergence_class: "unaccounted_tail_rewrite",
            rewritten_tokens: 1_000,
        });
        expect(rewrite).toMatchObject({ unaccountedWindows: 1, accepted: 1 });
    });
    test("does not emit a wake for a provider full miss", async () => {
        const directory = temporaryDirectory("cache-bust-provider-full-miss-");
        const events: string[] = [];
        const counters = await runSentinelOnce(
            options(join(directory, "state.json")),
            {
                now: () => 2_000,
                listActiveSessions: () => [{ ...activeSession, activityMs: 2_000 }],
                analyzeSession: async () => ({
                    requests: [request(1_800, "BUST", "provider_full_miss")],
                    highWaterMarkMs: 1_800,
                    directory: "/tmp/provider-full-miss",
                }),
                stdout: (line) => events.push(line),
            },
        );

        expect(events).toEqual([]);
        expect(counters.accountedWindows).toBe(1);
        expect(counters.unaccountedWindows).toBe(0);
    });

    test("does not evaluate a bust window while its newest request is unmetered", async () => {
        const directory = temporaryDirectory("cache-bust-in-flight-");
        const events: string[] = [];
        const counters = await runSentinelOnce(
            options(join(directory, "state.json")),
            {
                now: () => 3_000,
                listActiveSessions: () => [{ ...activeSession, activityMs: 3_000 }],
                analyzeSession: async () => ({
                    requests: [
                        request(2_800, "BUST", "unaccounted_defer_pass"),
                        request(2_900, "UNMETERED", "usage_missing"),
                    ],
                    highWaterMarkMs: 1_000,
                    directory: "/tmp/in-flight",
                }),
                stdout: (line) => events.push(line),
            },
        );

        expect(events).toEqual([]);
        expect(counters.unaccountedWindows).toBe(0);
    });

    test("does not hide a later unaccounted BUST inside an accounted window", () => {
        const state = __test.defaultState();
        const [window] = groupBustWindows([
            request(50_000, "BUST", "accounted_hard_fold"),
            request(60_000, "BUST", "unaccounted_defer_pass"),
        ]);

        expect(eventForWindow(window, "/project", state)?.payload.divergence_class).toBe(
            "unaccounted_defer_pass",
        );
    });

    test("a provider short read right after a reclaim alerts as provider-side and names its cause", () => {
        // 2026-10-12 15:28:51Z: the reclaim request carried the refreshed m[1]
        // and the trim; the next request only appended to it, but openai-codex
        // still served just the 24,448-token instructions+tools prefix.
        const state = __test.defaultState();
        const [window] = groupBustWindows([
            request(50_000, "BUST", "accounted_execute_published_history"),
            request(71_000, "BUST", "provider_short_read_identical_bytes"),
        ]);

        const event = eventForWindow(window!, "/project", state);

        expect(window!.rows.map((row) => row.divergenceClass)).toEqual([
            "accounted_execute_published_history",
            "provider_short_read_after_reclaim",
        ]);
        expect(event?.payload).toMatchObject({
            divergence_class: "provider_short_read_after_reclaim",
            cause: "provider_short_read_identical_bytes",
            at: new Date(71_000).toISOString(),
        });
        expect(agentDeliverRequest(event!, "agent", "from").body.content).toContain(
            "divergence_class=provider_short_read_after_reclaim; first_divergence=message[4] role=assistant; cause=provider_short_read_identical_bytes",
        );
    });

    test("any other accounted bust right after a reclaim alerts as a double bust", () => {
        const [window] = groupBustWindows([
            request(50_000, "BUST", "accounted_hard_marker_drain"),
            request(60_000, "BUST", "accounted_drop_applied"),
        ]);

        expect(eventForWindow(window!, "/project", __test.defaultState())?.payload).toMatchObject({
            divergence_class: "double_bust_after_reclaim",
            cause: "accounted_drop_applied",
        });
        // A lone reclaim stays accounted: it is the one bust a crossing may cost.
        const [single] = groupBustWindows([
            request(50_000, "BUST", "accounted_hard_marker_drain"),
        ]);
        expect(eventForWindow(single!, "/project", __test.defaultState())).toBeNull();
        // A provider short read after another provider-side miss is not a reclaim pair.
        const [providerPair] = groupBustWindows([
            request(50_000, "BUST", "provider_full_miss"),
            request(60_000, "BUST", "provider_short_read_identical_bytes"),
        ]);
        expect(eventForWindow(providerPair!, "/project", __test.defaultState())).toBeNull();
    });

    test("keeps the base id stable and never emits the same window id twice", () => {
        const state = __test.defaultState();
        const [window] = groupBustWindows([request(50_000)]);

        const first = eventForWindow(window, "/project", state);
        const rerun = eventForWindow(window, "/project", state);

        expect(first?.vendor_event_id).toBe(cacheBustWindowId("ses_sentinel", 50_000));
        expect(rerun).toBeNull();
    });

    test("uses a new id with supersedes when a re-analysis changes class", () => {
        const state = __test.defaultState();
        const [firstWindow] = groupBustWindows([
            request(50_000, "BUST", "unaccounted_tail_rewrite"),
        ]);
        const first = eventForWindow(firstWindow, "/project", state) as CacheBustEvent;
        const [changedWindow] = groupBustWindows([
            request(50_000, "BUST", "unaccounted_defer_pass"),
        ]);

        const changed = eventForWindow(changedWindow, "/project", state);

        expect(changed?.vendor_event_id).not.toBe(first.vendor_event_id);
        expect(changed?.supersedes).toBe(first.vendor_event_id);
    });
});

describe("MC decision store joins", () => {
    test("loads TS decision rows and rust scheduler-history mirrors read-only", () => {
        const directory = temporaryDirectory("cache-bust-sentinel-decisions-");
        const contextPath = join(directory, "context.db");
        const storePath = join(directory, "store.db");
        const context = new Database(contextPath);
        context.exec(`
            CREATE TABLE transform_decisions (
                session_id TEXT, harness TEXT, message_id TEXT, ts_ms INTEGER,
                decision TEXT, materialized INTEGER, materialize_reason TEXT,
                emergency INTEGER, dropped_tokens INTEGER, dropped_count INTEGER,
                input_tokens INTEGER
            );
            INSERT INTO transform_decisions VALUES
                ('ses_sentinel', 'opencode', 'msg-fold', 10000, 'defer', 1,
                 'system_hash', 0, 0, 4, 100000),
                ('ses_sentinel', 'opencode', 'msg-release', 30000, 'defer', 0,
                 'lkg_frozen_release:lkg_unsafe_seam', 0, 0, 0, 100000);
        `);
        context.close(false);
        const store = new Database(storePath);
        store.exec(`
            CREATE TABLE mc_pass_trace (
                session_id TEXT PRIMARY KEY,
                scheduler_history TEXT,
                scheduler_interesting_history TEXT
            );
        `);
        store.query("INSERT INTO mc_pass_trace VALUES (?, ?, ?)").run(
            "ses_sentinel",
            JSON.stringify([
                {
                    timestamp_ms: 20_200,
                    request_observed_at_ms: 20_100,
                    scheduler_decision: "Execute",
                    canonical_decision: "execute",
                    applied_drop_count: 2,
                },
            ]),
            "[]",
        );
        store.close(false);

        const loaded = loadSessionDecisions(activeSession, {
            ...options(join(directory, "state.json")),
            databasePath: contextPath,
            rustStorePath: storePath,
        });

        expect(nearestCacheBustDecision(loaded, 10_100)?.materializeReason).toBe("system_hash");
        expect(nearestCacheBustDecision(loaded, 30_100)).toMatchObject({
            decision: "defer",
            materialized: false,
            materializeReason: null,
            lkgFrozenReleaseReason: "lkg_unsafe_seam",
        });
        expect(nearestCacheBustDecision(loaded, 20_100)).toMatchObject({
            canonicalDecision: "execute",
            droppedCount: 2,
        });
    });

    // The pass-trace half of store migration 63, exactly as ck-mc runs it.
    const migration63PassTrace = readFileSync(
        join(
            import.meta.dir,
            "../../../crates/mc-store/src/migrations/store_063_pass_trace_ring.sql",
        ),
        "utf8",
    );

    test("reads rust scheduler history from migration 63 ring rows", () => {
        const directory = temporaryDirectory("cache-bust-sentinel-ring-");
        const storePath = join(directory, "store.db");
        const store = new Database(storePath);
        store.exec(`
            CREATE TABLE mc_pass_trace (
                session_id TEXT PRIMARY KEY,
                scheduler_history TEXT NOT NULL DEFAULT '[]',
                scheduler_interesting_history TEXT NOT NULL DEFAULT '[]'
            );
        `);
        store.query("INSERT INTO mc_pass_trace VALUES (?, ?, ?)").run(
            "ses_sentinel",
            JSON.stringify([
                {
                    timestamp_ms: 20_200,
                    request_observed_at_ms: 20_100,
                    scheduler_decision: "Execute",
                    canonical_decision: "execute",
                    applied_drop_count: 2,
                },
            ]),
            "[]",
        );
        store.exec(migration63PassTrace);
        const columns = (
            store.query("PRAGMA table_info(mc_pass_trace)").all() as Array<{ name: string }>
        ).map((row) => row.name);
        expect(columns).not.toContain("scheduler_history");
        store.close(false);

        const loaded = loadSessionDecisions(activeSession, {
            ...options(join(directory, "state.json")),
            databasePath: join(directory, "context.db"),
            rustStorePath: storePath,
        });

        expect(nearestCacheBustDecision(loaded, 20_100)).toMatchObject({
            canonicalDecision: "execute",
            droppedCount: 2,
        });
    });

    test("reports an error, not zero rows, for a trace row with no readable history", () => {
        const directory = temporaryDirectory("cache-bust-sentinel-no-history-");
        const storePath = join(directory, "store.db");
        const store = new Database(storePath);
        store.exec(`
            CREATE TABLE mc_pass_trace (session_id TEXT PRIMARY KEY, receive_count INTEGER);
            INSERT INTO mc_pass_trace VALUES ('ses_sentinel', 3);
        `);
        store.close(false);

        expect(() =>
            loadSessionDecisions(activeSession, {
                ...options(join(directory, "state.json")),
                databasePath: join(directory, "context.db"),
                rustStorePath: storePath,
            }),
        ).toThrow(CacheBustSentinelInputError);
    });
});

describe("agent.deliver contract", () => {
    test("parses delivered, queued, and replayed committed orders", () => {
        expect(
            parseAgentDeliverReply({
                result: { disposition: "delivered", committed_order: 41 },
            }),
        ).toEqual({ disposition: "delivered", committed_order: 41, accepted: true });
        expect(parseAgentDeliverReply({ disposition: "queued", committed_order: 42 })).toEqual({
            disposition: "queued",
            committed_order: 42,
            accepted: true,
        });
        expect(
            parseAgentDeliverReply(
                { result: { disposition: "delivered", committed_order: 41 } },
                { disposition: "queued", committed_order: 41 },
            ),
        ).toEqual({
            disposition: "delivered",
            committed_order: 41,
            accepted: false,
            reason: "dedup",
        });
    });

    test("rejects conflicts, unknown dispositions, and extra reply keys", () => {
        expect(() =>
            parseAgentDeliverReply({
                result: {
                    disposition: "idempotency_conflict",
                    committed_order: 41,
                },
            }),
        ).toThrow("idempotency_conflict");
        expect(() =>
            parseAgentDeliverReply({ disposition: "recorded", committed_order: 41 }),
        ).toThrow(CacheBustSentinelInputError);
        expect(() =>
            parseAgentDeliverReply({
                disposition: "delivered",
                committed_order: 41,
                extra: true,
            }),
        ).toThrow(CacheBustSentinelInputError);
    });

    test("sends the exact snake-case request fixture and keeps route identity in call options", async () => {
        const state = __test.defaultState();
        const [window] = groupBustWindows([request(50_000)]);
        const event = eventForWindow(window, "/tmp", state) as CacheBustEvent;
        const content =
            "ses_sentinel: cache bust detected in directory /tmp at 1970-01-01T00:00:50.000Z; rewritten_tokens=123; divergence_class=unaccounted_rewrite; first_divergence=message[4] role=assistant; analyzer_cmd=cd packages/plugin && bun scripts/analyze-cache-busts.ts --session ses_sentinel";
        const fixture = {
            agent_id: "agent_fixture",
            delivery_id: cacheBustWindowId("ses_sentinel", 50_000),
            body: {
                kind: "peer_message" as const,
                from_agent: "mc-cache-bust-sentinel",
                from_session_id: "health-sentinel-mc" as const,
                from_harness: "magic-context" as const,
                content,
                one_way: true as const,
            },
            urgency: "high" as const,
        };
        const calls: Array<{
            moduleId: string;
            method: string;
            params: unknown;
            options: unknown;
        }> = [];
        let closed = false;
        const transport = new SubcWakeEventTransport(
            "fixture-connection.json",
            "prefrontal-core",
            "agent_fixture",
            "mc-cache-bust-sentinel",
            async () => ({
                async call(moduleId, method, params, callOptions) {
                    calls.push({ moduleId, method, params, options: callOptions });
                    return { result: { disposition: "delivered", committed_order: 41 } };
                },
                close() {
                    closed = true;
                },
            }),
        );

        expect(
            agentDeliverRequest(event, "agent_fixture", "mc-cache-bust-sentinel"),
        ).toEqual(fixture);
        expect(Object.keys(fixture)).toEqual(["agent_id", "delivery_id", "body", "urgency"]);
        expect(Object.keys(fixture.body)).toEqual([
            "kind",
            "from_agent",
            "from_session_id",
            "from_harness",
            "content",
            "one_way",
        ]);
        expect(await transport.record(event)).toEqual({
            result: { disposition: "delivered", committed_order: 41 },
        });
        await transport.close();

        expect(calls).toEqual([
            {
                moduleId: "prefrontal-core",
                method: "agent.deliver",
                params: fixture,
                options: {
                    identity: {
                        project_root: "/tmp",
                        harness: "magic-context",
                        session: "ses_sentinel",
                    },
                    consumerIdentity: null,
                    timeoutMs: 15_000,
                },
            },
        ]);
        expect(closed).toBe(true);
    });

    test("pins either missing peer-message stamp field to the captured sender refusal", () => {
        const state = __test.defaultState();
        const [window] = groupBustWindows([request(50_000)]);
        const event = eventForWindow(window, "/tmp", state) as CacheBustEvent;
        const complete = agentDeliverRequest(
            event,
            "agent_b613e5cf2ee55b8c",
            "mc-cache-bust-sentinel",
        );
        const refusal = {
            code: "peer_delivery_refused",
            message:
                "managed call failed: registry peer delivery refused: peer-message-sender-unstamped",
        };

        for (const missing of ["from_session_id", "from_harness"] as const) {
            const body = { ...complete.body } as Partial<typeof complete.body>;
            delete body[missing];
            const outcome =
                typeof body.from_session_id === "string" &&
                body.from_session_id.length > 0 &&
                typeof body.from_harness === "string" &&
                body.from_harness.length > 0
                    ? null
                    : refusal;

            expect(outcome, missing).toEqual(refusal);
        }
    });

    test("defaults registry ids and accepts target and sender overrides", () => {
        const defaults = parseSentinelArgs(["bun", "cache-bust-sentinel.ts", "--once"]);
        const override = parseSentinelArgs([
            "bun",
            "cache-bust-sentinel.ts",
            "--once",
            "--wake-agent-id",
            "agent_override",
            "--wake-from-agent",
            "agent_sender_override",
        ]);

        expect(defaults.wakeModuleId).toBe("prefrontal-core");
        expect(defaults.wakeAgentId).toBe("agent_b613e5cf2ee55b8c");
        expect(defaults.wakeFromAgent).toBe("mc-cache-bust-sentinel");
        expect(override.wakeAgentId).toBe("agent_override");
        expect(override.wakeFromAgent).toBe("agent_sender_override");
    });
});

describe("cache-bust sentinel runs", () => {
    test("saves its state once per run, and keeps a failed run's progress", async () => {
        // The state file covers every session ever seen and a run walks thousands
        // of them, so saving after each session rewrote gigabytes an hour.
        const directory = temporaryDirectory("cache-bust-sentinel-save-once-");
        const stateFile = join(directory, "state.json");
        const sessions = ["ses_a", "ses_b", "ses_c"].map((sessionId) => ({ ...activeSession, sessionId }));
        const seenDuringRun: string[][] = [];
        let failOn: string | undefined;
        const deps = {
            now: () => 1_000,
            listActiveSessions: () => sessions,
            loadDecisions: () => [],
            analyzeSession: async (session: ActiveCacheBustSession) => {
                seenDuringRun.push(
                    existsSync(stateFile) ? Object.keys(loadSentinelState(stateFile).sessions).sort() : [],
                );
                if (session.sessionId === failOn) throw new Error("analysis failed");
                return { requests: [], highWaterMarkMs: 900 };
            },
            stdout: () => {},
            stderr: () => {},
        };

        await runSentinelOnce(options(stateFile), deps);
        expect(seenDuringRun).toEqual([[], [], []]);
        expect(Object.keys(loadSentinelState(stateFile).sessions).sort()).toEqual(["ses_a", "ses_b", "ses_c"]);

        rmSync(stateFile);
        seenDuringRun.length = 0;
        failOn = "ses_c";
        await expect(runSentinelOnce(options(stateFile), deps)).rejects.toThrow("analysis failed");
        expect(seenDuringRun).toEqual([[], [], []]);
        expect(Object.keys(loadSentinelState(stateFile).sessions).sort()).toEqual(["ses_a", "ses_b"]);
    });
    test("resumes a timed-out pass and emits every window", async () => {
        const directory = temporaryDirectory("cache-bust-sentinel-resume-");
        const stateFile = join(directory, "state.json");
        const sent: string[] = [];
        let time = 1_000;
        const sessions = ["ses_one", "ses_two"].map((sessionId) => ({ ...activeSession, sessionId }));
        const deps = {
            now: () => time,
            listActiveSessions: (state: { sessions: Record<string, { lastAnalyzedRequestTimestampMs: number }> }) =>
                sessions.filter((session) => (state.sessions[session.sessionId]?.lastAnalyzedRequestTimestampMs ?? 0) < 900),
            loadDecisions: () => [],
            analyzeSession: async (session: ActiveCacheBustSession) => {
                time += 20;
                return { requests: [{ ...request(900), session: session.sessionId }], highWaterMarkMs: 900 };
            },
            stdout: (line: string) => { sent.push(JSON.parse(line).session_id); },
            stderr: () => {},
        };
        const runOptions = { ...options(stateFile), maxRunMs: 10 };
        expect((await runSentinelOnce(runOptions, deps)).bounded).toBe(true);
        expect(sent).toEqual(["ses_one"]);
        expect((await runSentinelOnce(runOptions, deps)).bounded).toBe(true);
        expect(sent).toEqual(["ses_one", "ses_two"]);
    });
    test("alerts on a second bust that a later run sees after the reclaim it follows", async () => {
        // The run that analyzed the reclaim ended before the next request was
        // metered. The next run sees only the second bust, so the reclaim's class
        // must carry over in the open window.
        const directory = temporaryDirectory("cache-bust-sentinel-reclaim-carry-");
        const stateFile = join(directory, "state.json");
        const events: CacheBustEvent[] = [];
        let time = 60_000;
        const deps = {
            now: () => time,
            listActiveSessions: () => [{ ...activeSession, activityMs: time }],
            loadDecisions: () => [],
            analyzeSession: async (_session: ActiveCacheBustSession, sinceExclusiveMs: number) => {
                const requests = [
                    request(50_000, "BUST", "accounted_execute_published_history"),
                    request(71_000, "BUST", "provider_short_read_identical_bytes"),
                ].filter((row) => row.timestampMs > sinceExclusiveMs && row.timestampMs <= time);
                return {
                    requests,
                    highWaterMarkMs: requests.at(-1)?.timestampMs ?? null,
                    directory: "/tmp/sentinel-project",
                };
            },
            stdout: (line: string) => events.push(JSON.parse(line)),
            stderr: () => {},
        };
        const runOptions = { ...options(stateFile), lookbackMs: 50_000 };

        await runSentinelOnce(runOptions, deps);
        expect(events).toEqual([]);
        expect(loadSentinelState(stateFile).sessions.ses_sentinel?.openWindow).toEqual({
            startMs: 50_000,
            lastBustMs: 50_000,
            lastBustClass: "accounted_execute_published_history",
        });

        time = 120_000;
        await runSentinelOnce(runOptions, deps);
        expect(events.map((event) => event.payload)).toEqual([
            expect.objectContaining({
                divergence_class: "provider_short_read_after_reclaim",
                cause: "provider_short_read_identical_bytes",
            }),
        ]);
    });

    test("rotates sessions across bounded runs instead of starving the one listed last", async () => {
        // Each Pi analysis can exhaust a run's budget. The store lists sessions in a
        // fixed order, so the second session used to wait forever behind the first.
        const directory = temporaryDirectory("cache-bust-sentinel-rotation-");
        const stateFile = join(directory, "state.json");
        const analyzed: string[][] = [];
        let time = 10_000;
        const sessions = ["ses_listed_first", "ses_listed_second"];
        const deps = {
            now: () => time,
            listActiveSessions: () =>
                sessions.map((sessionId) => ({ ...activeSession, sessionId, activityMs: time - 1 })),
            loadDecisions: () => [],
            analyzeSession: async (session: ActiveCacheBustSession) => {
                analyzed.at(-1)?.push(session.sessionId);
                time += 31_000;
                return { requests: [], highWaterMarkMs: null };
            },
            stdout: () => {},
            stderr: () => {},
        };
        const runOptions = { ...options(stateFile), maxRunMs: 30_000 };

        for (let run = 0; run < 3; run += 1) {
            analyzed.push([]);
            expect((await runSentinelOnce(runOptions, deps)).bounded).toBe(true);
            time += 300_000;
        }

        expect(analyzed).toEqual([
            ["ses_listed_first"],
            ["ses_listed_second"],
            ["ses_listed_first"],
        ]);
    });

    test("persists and reuses the per-session request high-water mark", async () => {
        const directory = temporaryDirectory("cache-bust-sentinel-watermark-");
        const stateFile = join(directory, "state.json");
        const seenSince: number[] = [];
        const runOptions = options(stateFile);
        const deps = {
            now: () => 1_000,
            listActiveSessions: () => [activeSession],
            loadDecisions: () => [],
            analyzeSession: async (_session: ActiveCacheBustSession, sinceExclusiveMs: number) => {
                seenSince.push(sinceExclusiveMs);
                const requests = sinceExclusiveMs < 900 ? [request(900, "STABLE")] : [];
                return {
                    requests,
                    highWaterMarkMs: requests.at(-1)?.timestampMs ?? null,
                };
            },
            stdout: () => {},
            stderr: () => {},
        };

        await runSentinelOnce(runOptions, deps);
        await runSentinelOnce(runOptions, deps);

        expect(seenSince).toEqual([500, 900]);
        expect(loadSentinelState(stateFile).sessions.ses_sentinel).toEqual({
            lastAnalyzedRequestTimestampMs: 900,
            lastScannedAtMs: 1_000,
        });
    });

    test("loads the Pi analyzer library surface without mutating empty input roots", async () => {
        const directory = temporaryDirectory("cache-bust-sentinel-pi-library-");
        const runOptions = {
            ...options(join(directory, "state.json")),
            piDir: join(directory, "pi-sessions"),
            ompDir: join(directory, "omp-sessions"),
            ledgerDir: join(directory, "mc-data"),
        };

        const counters = await runSentinelOnce(runOptions, {
            now: () => 1_000,
            listActiveSessions: () => [{ ...activeSession, harness: "pi" }],
            loadDecisions: () => [],
            stdout: () => {},
            stderr: () => {},
        });

        expect(counters).toMatchObject({ sessions: 1, requests: 0, bustWindows: 0 });
    });

    test("prints one exact contract-shaped JSON line in dry-run mode", async () => {
        const directory = temporaryDirectory("cache-bust-sentinel-dry-run-");
        const output: string[] = [];
        const runOptions = options(join(directory, "state.json"));

        const counters = await runSentinelOnce(runOptions, {
            now: () => 1_000,
            listActiveSessions: () => [activeSession],
            loadDecisions: () => [],
            analyzeSession: async () => ({
                requests: [request(900)],
                highWaterMarkMs: 900,
                directory: "/tmp/sentinel-project",
            }),
            stdout: (line) => output.push(line),
            stderr: () => {},
        });

        expect(counters.dryRun).toBe(1);
        expect(output).toHaveLength(1);
        expect(JSON.parse(output[0])).toEqual({
            source_module: "magic-context",
            kind: "cache_bust",
            vendor_event_id: cacheBustWindowId("ses_sentinel", 900),
            session_id: "ses_sentinel",
            directory: "/tmp/sentinel-project",
            occurred_at_ms: 900,
            payload: {
                session: "ses_sentinel",
                at: new Date(900).toISOString(),
                rewritten_tokens: 123,
                divergence_class: "unaccounted_rewrite",
                first_divergence: "message[4] role=assistant",
                analyzer_cmd:
                    "cd packages/plugin && bun scripts/analyze-cache-busts.ts --session ses_sentinel",
            },
        });
    });

    test("counts delivered and queued dispositions as accepted", async () => {
        const directory = temporaryDirectory("cache-bust-sentinel-send-");
        const runOptions = {
            ...options(join(directory, "state.json")),
            send: true,
            lookbackMs: 1_000_000,
        };
        const calls: CacheBustEvent[] = [];
        const replies: AgentDeliverReply[] = [
            { disposition: "delivered", committed_order: 41 },
            { disposition: "queued", committed_order: 42 },
        ];

        const counters = await runSentinelOnce(runOptions, {
            now: () => 400_000,
            listActiveSessions: () => [activeSession],
            loadDecisions: () => [],
            analyzeSession: async () => ({
                requests: [request(100_000), request(300_001)],
                highWaterMarkMs: 300_001,
                directory: "/tmp/sentinel-project",
            }),
            transport: {
                async record(event) {
                    calls.push(event);
                    return replies[calls.length - 1];
                },
            },
            stdout: () => {},
            stderr: () => {},
        });

        expect(calls).toHaveLength(2);
        expect(counters).toMatchObject({
            bustWindows: 2,
            unaccountedWindows: 2,
            accepted: 2,
            dedup: 0,
        });
    });

    test("counts an advanced replay disposition as dedup by committed order", async () => {
        const directory = temporaryDirectory("cache-bust-sentinel-dedup-");
        const stateFile = join(directory, "state.json");
        const runOptions = {
            ...options(stateFile),
            send: true,
            lookbackMs: 1_000,
        };
        const calls: CacheBustEvent[] = [];
        const deps = {
            now: () => 1_000,
            listActiveSessions: () => [activeSession],
            loadDecisions: () => [],
            analyzeSession: async () => ({
                requests: [request(900)],
                highWaterMarkMs: 900,
                directory: "/tmp/sentinel-project",
            }),
            transport: {
                async record(event: CacheBustEvent) {
                    calls.push(event);
                    return {
                        disposition: calls.length === 1 ? "queued" : "delivered",
                        committed_order: 77,
                    } as const;
                },
            },
            stdout: () => {},
            stderr: () => {},
        };

        const first = await runSentinelOnce(runOptions, deps);
        const replayState = loadSentinelState(stateFile);
        replayState.sessions = {};
        replayState.windows = {};
        saveSentinelState(stateFile, replayState);
        const replay = await runSentinelOnce(runOptions, deps);

        expect(calls.map((event) => event.vendor_event_id)).toEqual([
            cacheBustWindowId("ses_sentinel", 900),
            cacheBustWindowId("ses_sentinel", 900),
        ]);
        expect(first).toMatchObject({ accepted: 1, dedup: 0 });
        expect(replay).toMatchObject({ accepted: 0, dedup: 1 });
    });

    test("counts both unstamped-sender refusals and never retries their delivery ids", async () => {
        const directory = temporaryDirectory("cache-bust-sentinel-refused-");
        const stateFile = join(directory, "state.json");
        const runOptions = {
            ...options(stateFile),
            send: true,
            lookbackMs: 1_000_000,
        };
        const calls: string[] = [];
        const logs: string[] = [];
        const deps = {
            now: () => 400_000,
            listActiveSessions: () => [activeSession],
            loadDecisions: () => [],
            analyzeSession: async () => ({
                requests: [request(100_000), request(300_001)],
                highWaterMarkMs: 300_001,
                directory: "/tmp/sentinel-project",
            }),
            transport: {
                async record(event: CacheBustEvent) {
                    calls.push(event.vendor_event_id);
                    throw Object.assign(
                        new Error(
                            "managed call failed: registry peer delivery refused: peer-message-sender-unstamped",
                        ),
                        { code: "peer_delivery_refused" },
                    );
                },
            },
            stdout: () => {},
            stderr: (line: string) => logs.push(line),
        };

        const first = await runSentinelOnce(runOptions, deps);
        const retryState = loadSentinelState(stateFile);
        retryState.sessions = {};
        saveSentinelState(stateFile, retryState);
        const retry = await runSentinelOnce(runOptions, deps);
        const refusals = logs
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .filter((line) => line.outcome === "send_refused:peer_delivery_refused");

        expect(first).toMatchObject({ sendRefused: 2, accepted: 0, dedup: 0 });
        expect(refusals).toEqual([
            {
                event_id: cacheBustWindowId("ses_sentinel", 100_000),
                outcome: "send_refused:peer_delivery_refused",
                error: "managed call failed: registry peer delivery refused: peer-message-sender-unstamped",
                counters: expect.objectContaining({ sendRefused: 1 }),
            },
            {
                event_id: cacheBustWindowId("ses_sentinel", 300_001),
                outcome: "send_refused:peer_delivery_refused",
                error: "managed call failed: registry peer delivery refused: peer-message-sender-unstamped",
                counters: expect.objectContaining({ sendRefused: 2 }),
            },
        ]);
        expect(retry).toMatchObject({ sendRefused: 0, skippedSeen: 2 });
        expect(calls).toHaveLength(2);
    });
});
