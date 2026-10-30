import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripSystemInjection } from "../src/hooks/magic-context/system-injection-stripper";
import { __test, analyzeOpenCodeCacheBustSession } from "./analyze-cache-busts";
import { type CacheBustDecisionAttribution } from './cache-bust-attribution';
import { describeBodyPair, normalizeRequestBody } from "./cache-bust-body-sources";

type UsageFixture = {
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    input_tokens: number;
};

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function responseUsage(usage: UsageFixture): unknown {
    return { status: 200, usage };
}

function streamedUsage(usage: UsageFixture): unknown {
    return {
        events: [
            { type: "message_start", message: { usage } },
            { type: "message_delta", usage },
        ],
    };
}

function writeDump(
    dir: string,
    stem: string,
    createdAt: string,
    session: string,
    body: unknown,
    response: unknown = responseUsage({ input_tokens: 1 }),
): void {
    const bodyPath = join(dir, `${stem}.body.json`);
    const responsePath = join(dir, `${stem}.response.json`);
    writeFileSync(bodyPath, JSON.stringify(body));
    writeFileSync(responsePath, JSON.stringify(response));
    writeFileSync(
        join(dir, `${stem}.meta.json`),
        JSON.stringify({
            createdAt,
            session: `${session.slice(0, 12)}…`,
            files: { body: bodyPath, response: responsePath },
            body: {
                messagesCount: Array.isArray((body as { messages?: unknown[] }).messages)
                    ? (body as { messages: unknown[] }).messages.length
                    : 0,
            },
        }),
    );
}

function bodyWithBreakpointMessage(text: string): unknown {
    return {
        messages: [
            {
                role: "user",
                content: [{ type: "text", text, cache_control: { type: "ephemeral" } }],
            },
        ],
    };
}

function bodyWithModelAndBreakpoint(model: string, text: string): unknown {
    return { model, ...(bodyWithBreakpointMessage(text) as object) };
}

function bodyWithTail(text: string, tailBreakpoint = false): unknown {
    const tail = { type: "text", text } as { type: string; text: string; cache_control?: unknown };
    if (tailBreakpoint) tail.cache_control = { type: "ephemeral" };
    return {
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "cached prefix", cache_control: { type: "ephemeral" } },
                ],
            },
            { role: "assistant", content: [tail] },
        ],
    };
}

function bodyWithTailCheckpoint(text: string): unknown {
    return {
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "cached prefix", cache_control: { type: "ephemeral" } },
                ],
            },
            { role: "assistant", content: [{ type: "text", text }] },
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "current tail checkpoint",
                        cache_control: { type: "ephemeral" },
                    },
                ],
            },
        ],
    };
}

function snapshotsFor(dir: string, session: string) {
    return __test.loadSnapshots(
        __test.parseArgs(["bun", "analyze-cache-busts.ts", "--session", session, "--dir", dir]),
    );
}

describe("analyze-cache-bust dump discovery", () => {
    test("claims slow passes once across consecutive requests, including BASE and UNMETERED", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-pass-claims-"));
        tempDirs.push(dir);
        const session = "ses_passClaims";
        const start = Date.parse("2026-10-28T12:56:00Z");
        const offsets = [0, 41_000, 81_000, 82_000, 83_000];
        for (const [index, offset] of offsets.entries()) {
            const at = new Date(start + offset).toISOString();
            writeDump(
                dir,
                `${at.replaceAll(":", "-").replace(".", "-")}-00000${index + 1}-${session}`,
                at,
                session,
                bodyWithBreakpointMessage(`prefix ${index}`),
                index === 3
                    ? {}
                    : responseUsage({
                          input_tokens: 100,
                          cache_read_input_tokens: index === 0 ? 20_000 : 100,
                          cache_creation_input_tokens: index === 0 ? 0 : 19_900,
                      }),
            );
        }
        const passes: CacheBustDecisionAttribution[] = [-1_000, 10_000, 50_000, 81_500].map(
            (offset) => ({
                timestampMs: start + offset,
                decision: "execute",
                materialized: true,
                materializeReason: "pressure_refold",
                emergency: false,
                droppedTokens: 100,
                droppedCount: 1,
                inputTokens: 20_000,
                flush: false,
                source: "fixture",
            }),
        );

        const rows = __test.analyzeSnapshots(snapshotsFor(dir, session), passes);
        expect(rows.map((row) => row.decision)).toEqual([
            passes[0], passes[1], passes[2], undefined, undefined,
        ]);
        expect(rows.map((row) => row.divergenceClass)).toEqual([
            undefined,
            "accounted_hard_pressure_refold",
            "accounted_hard_pressure_refold",
            "usage_missing",
            "no_mc_pass_row",
        ]);
    });

    test("partial and bounded scans do not reclaim a pass used before the comparison snapshots", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-pass-watermark-"));
        tempDirs.push(dir);
        const session = "ses_passWatermark";
        const start = Date.parse("2026-10-28T12:56:00Z");
        for (let index = 0; index < 5; index += 1) {
            const at = new Date(start + index * 1_000).toISOString();
            writeDump(
                dir,
                `${at.replaceAll(":", "-").replace(".", "-")}-00000${index + 1}-${session}`,
                at,
                session,
                bodyWithBreakpointMessage(index === 4 ? "changed prefix" : "cached prefix"),
                responseUsage({
                    input_tokens: 100,
                    cache_read_input_tokens: index === 4 ? 100 : 20_000,
                    cache_creation_input_tokens: index === 4 ? 19_900 : 0,
                }),
            );
        }
        const pass: CacheBustDecisionAttribution = {
            timestampMs: start - 1_000,
            decision: "execute",
            materialized: true,
            materializeReason: "pressure_refold",
            emergency: false,
            droppedTokens: 100,
            droppedCount: 1,
            inputTokens: 20_000,
            flush: false,
            source: "fixture",
        };
        for (const scanDeadlineMs of [undefined, Number.MAX_SAFE_INTEGER]) {
            const result = analyzeOpenCodeCacheBustSession({
                sessionId: session,
                anthropicDir: dir,
                openaiDir: join(dir, "missing"),
                mcLogPath: join(dir, "missing.log"),
                decisions: [pass],
                sinceExclusiveMs: start + 3_000,
                scanDeadlineMs,
            });
            expect(result.requests).toHaveLength(1);
            expect(result.requests[0]?.divergenceClass).toBe("no_mc_pass_row");
        }
    });

    test("classifies an Anthropic zero read and wire-model swap as a provider full miss", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-provider-full-miss-"));
        tempDirs.push(dir);
        const session = "ses_brocaFullMiss";
        const previousAt = "2026-09-20T16:25:56.000Z";
        const currentAt = "2026-09-20T16:26:06.000Z";
        writeDump(
            dir,
            "2026-09-20T16-25-56-000Z-000001-ses_brocaFullMiss",
            previousAt,
            session,
            bodyWithModelAndBreakpoint("claude-opus-5", "cached prefix"),
            responseUsage({ input_tokens: 4_855, cache_read_input_tokens: 589_294 }),
        );
        writeDump(
            dir,
            "2026-09-20T16-26-06-000Z-000002-ses_brocaFullMiss",
            currentAt,
            session,
            bodyWithModelAndBreakpoint("claude-opus-4-8", "provider fallback"),
            responseUsage({
                input_tokens: 4_855,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 589_294,
            }),
        );

        const rows = __test.analyzeSnapshots(snapshotsFor(dir, session), [
            {
                timestampMs: Date.parse(currentAt),
                decision: "defer",
                canonicalDecision: "defer",
                materialized: false,
                materializeReason: null,
                emergency: false,
                droppedTokens: 0,
                droppedCount: 0,
                inputTokens: 4_855,
                flush: false,
                source: "fixture",
            },
        ]);

        expect(rows[1]?.divergenceClass).toBe("provider_full_miss");
        expect(rows[1]?.previous?.wireModel).toBe("claude-opus-5");
        expect(rows[1]?.current.wireModel).toBe("claude-opus-4-8");

        const run = Bun.spawnSync([
            process.execPath,
            join(import.meta.dir, "analyze-cache-busts.ts"),
            "--session",
            session,
            "--dir",
            dir,
            "--all-rows",
        ]);
        expect(run.exitCode).toBe(0);
        expect(run.stdout.toString()).toContain(
            "wireModel=claude-opus-5 → claude-opus-4-8",
        );
    });

    test("repeated epoch HARD decisions on one session are attributed to self-inflicted epochs", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-double-epoch-"));
        tempDirs.push(dir);
        const session = "ses_doubleEpoch";
        const start = Date.parse("2026-09-20T16:00:00.000Z");
        for (const [index, text] of ["initial", "first epoch", "second epoch"].entries()) {
            const at = new Date(start + index * 6_000).toISOString();
            writeDump(
                dir,
                `2026-09-20T16-00-${String(index * 6).padStart(2, "0")}-000Z-00000${index + 1}-${session}`,
                at,
                session,
                bodyWithBreakpointMessage(text),
                responseUsage({ input_tokens: 100, cache_read_input_tokens: index === 0 ? 20_000 : 100, cache_creation_input_tokens: index === 0 ? 0 : 19_900 }),
            );
        }
        const decisions = [6_000, 12_000].map((offset) => ({
            timestampMs: start + offset,
            decision: "defer",
            materialized: true,
            materializeReason: "epoch_change",
            identityDelta: ["other"],
            emergency: false,
            droppedTokens: 0,
            droppedCount: 0,
            inputTokens: 100,
            flush: false,
            source: "fixture",
        }));
        const rows = __test.analyzeSnapshots(snapshotsFor(dir, session), decisions);
        expect(rows[1]?.divergenceClass).toBe("accounted_hard_epoch");
        expect(rows[2]?.divergenceClass).toBe("self_inflicted_epoch");
    });

    test("an epoch HARD explained by a preceding full retry stays accounted; one with nothing before it is unfaulted", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-unfaulted-epoch-"));
        tempDirs.push(dir);
        const session = "ses_unfaultedEpoch";
        const start = Date.parse("2026-09-20T16:00:00.000Z");
        // Two epoch HARDs five minutes apart, so neither counts as a repeat of the other.
        const offsets = [0, 60_000, 360_000];
        for (const [index, text] of ["initial", "after retry", "spontaneous"].entries()) {
            const at = new Date(start + offsets[index]!).toISOString();
            writeDump(
                dir,
                `${at.replaceAll(":", "-").replace(".", "-")}-00000${index + 1}-${session}`,
                at,
                session,
                bodyWithBreakpointMessage(text),
                responseUsage({ input_tokens: 100, cache_read_input_tokens: index === 0 ? 20_000 : 100, cache_creation_input_tokens: index === 0 ? 0 : 19_900 }),
            );
        }
        const pass = (offset: number, source: string) => ({
            timestampMs: start + offset,
            decision: "HARD",
            materialized: true,
            materializeReason: "epoch_change",
            identityDelta: ["other"],
            emergency: false,
            droppedTokens: 0,
            droppedCount: 0,
            inputTokens: 100,
            flush: false,
            source,
        });
        const decisions = [
            pass(60_000, "rust pass log"),
            pass(360_000, "rust pass log"),
            {
                ...pass(55_000, "rust adapter log"),
                decision: "disruption",
                materialized: false,
                materializeReason: null,
                disruption: "full_retry",
            },
        ];
        const rows = __test.analyzeSnapshots(snapshotsFor(dir, session), decisions);
        expect(rows[1]?.divergenceClass).toBe("accounted_hard_epoch");
        expect(rows[2]?.divergenceClass).toBe("unfaulted_epoch");
        expect(rows[2]?.decision?.identityDelta).toEqual(["other"]);
        // The disruption marker is never joined to a request as its pass.
        expect(rows.every((row) => row.decision?.disruption === undefined)).toBe(true);
    });

    test("skips an unmetered pass as a baseline for the next real short-read bust", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-usage-missing-baseline-"));
        tempDirs.push(dir);
        const session = "ses_usageMissingBaseline";
        const body = bodyWithBreakpointMessage("changed");
        writeDump(
            dir,
            "2026-09-20T16-00-00-000Z-000001-ses_usageMissingBaseline",
            "2026-09-20T16:00:00.000Z",
            session,
            body,
            responseUsage({ input_tokens: 100, cache_read_input_tokens: 20_000 }),
        );
        writeDump(
            dir,
            "2026-09-20T16-00-01-000Z-000002-ses_usageMissingBaseline",
            "2026-09-20T16:00:01.000Z",
            session,
            bodyWithBreakpointMessage("in flight"),
            responseUsage({ input_tokens: 0, cache_read_input_tokens: 0 }),
        );
        writeDump(
            dir,
            "2026-09-20T16-00-02-000Z-000003-ses_usageMissingBaseline",
            "2026-09-20T16:00:02.000Z",
            session,
            bodyWithBreakpointMessage("short read"),
            responseUsage({ input_tokens: 100, cache_read_input_tokens: 100 }),
        );

        const rows = __test.analyzeSnapshots(snapshotsFor(dir, session), [
            {
                timestampMs: Date.parse("2026-09-20T16:00:02.000Z"),
                decision: "defer",
                canonicalDecision: "defer",
                materialized: false,
                materializeReason: null,
                emergency: false,
                droppedTokens: 0,
                droppedCount: 0,
                inputTokens: 100,
                flush: false,
                source: "fixture",
            },
        ]);

        expect(rows[1]?.verdict).toBe("UNMETERED");
        expect(rows[1]?.divergenceClass).toBe("usage_missing");
        expect(rows[2]?.prevTotal).toBe(20_100);
        expect(rows[2]?.verdict).toBe("BUST");
        expect(rows[2]?.divergenceClass).toBe("unaccounted_defer_pass");
    });

    test("reminder strip golden agrees with the Rust block-strip parser", () => {
        const fixture = JSON.parse(
            readFileSync(
                join(
                    import.meta.dir,
                    "test-fixtures/cache-bust-sentinel/reminder-restart-001871.json",
                ),
                "utf8",
            ),
        ) as { parts: string[]; stripped: Array<string | null> };
        expect(fixture.parts.map(stripSystemInjection)).toEqual(fixture.stripped);
    });
    test("001871 reminder restart uses creation meter and remains an unaccounted defer bust", () => {
        const fixture = JSON.parse(
            readFileSync(
                join(
                    import.meta.dir,
                    "test-fixtures/cache-bust-sentinel/reminder-restart-001871.json",
                ),
                "utf8",
            ),
        ) as {
            session: string;
            readings: Array<{ sequence: string; at: string; read: number; creation: number }>;
            parts: string[];
        };
        const dir = mkdtempSync(join(tmpdir(), "cache-reminder-restart-"));
        tempDirs.push(dir);
        for (const [index, reading] of fixture.readings.entries()) {
            const parts = fixture.parts.map((text, part) => ({
                type: "text",
                text: index >= 2 && part >= 2 ? `§${434 + part}§ ` : text,
            }));
            const messages = Array.from({ length: 224 }, (_, n) => ({
                role: "user",
                content: [{ type: "text", text: `prefix ${n}` }],
            }));
            messages.push({ role: "user", content: parts });
            const body = {
                messages: [
                    ...messages,
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: "checkpoint",
                                cache_control: { type: "ephemeral" },
                            },
                        ],
                    },
                ],
            };
            writeDump(
                dir,
                `${reading.at.replaceAll(":", "-").replace(".", "-")}-${reading.sequence}-${fixture.session}`,
                reading.at,
                fixture.session,
                body,
                responseUsage({
                    cache_read_input_tokens: reading.read,
                    cache_creation_input_tokens: reading.creation,
                    input_tokens: 4,
                }),
            );
        }
        const at = Date.parse(fixture.readings[2]!.at);
        const rows = __test.analyzeSnapshots(snapshotsFor(dir, fixture.session), [
            {
                timestampMs: at,
                decision: "SOFT+",
                canonicalDecision: "defer",
                deferReason: "scheduler_defer",
                materialized: false,
                materializeReason: null,
                emergency: false,
                droppedTokens: 0,
                droppedCount: 0,
                inputTokens: 482285,
                flush: false,
                source: "fixture",
            },
        ]);
        expect(rows[2]?.divergenceIndex).toBe(224);
        expect(rows[2]?.verdict).toBe("BUST");
        expect(rows[2]?.rewrittenTokens).toBe(202_813);
        expect(rows[2]?.divergenceClass).toBe("unaccounted_defer_pass");
        expect(rows[3]?.verdict).toBe("STABLE");
    });
    test("classifies a shorter tail with no cache rewrite without changing the meter", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-tail-shrink-no-rewrite-"));
        tempDirs.push(dir);
        const session = "ses_tailshrink";
        writeDump(
            dir,
            `2026-09-11T08-00-00-000Z-000001-${session}`,
            "2026-09-11T08:00:00Z",
            session,
            bodyWithBreakpointMessage("the previous request had a longer tail"),
            responseUsage({ input_tokens: 0, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0 }),
        );
        writeDump(
            dir,
            `2026-09-11T08-00-10-000Z-000002-${session}`,
            "2026-09-11T08:00:10Z",
            session,
            bodyWithBreakpointMessage("the previous request had a longer"),
            responseUsage({ input_tokens: 0, cache_read_input_tokens: 930, cache_creation_input_tokens: 0 }),
        );

        const row = __test.analyzeSnapshots(snapshotsFor(dir, session))[1];

        expect(row.verdict).toBe("BUST");
        expect(row.rewrittenTokens).toBe(0);
        expect(row.divergenceClass).toBe("tail_shrink_no_rewrite");
    });
    test("classifies a zero-write request that removes multiple trailing messages", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-tail-messages-shrunk-"));
        tempDirs.push(dir);
        const session = "ses_tailmessages";
        const bodyWithTailMessages = (count: number) => ({
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "shared cached prefix",
                            cache_control: { type: "ephemeral" },
                        },
                    ],
                },
                ...Array.from({ length: count }, (_, index) => ({
                    role: index % 2 === 0 ? "assistant" : "user",
                    content: [
                        {
                            type: "text",
                            text: `tail message ${index}`,
                            ...(index === count - 1
                                ? { cache_control: { type: "ephemeral" } }
                                : {}),
                        },
                    ],
                })),
            ],
        });
        writeDump(
            dir,
            `2026-09-11T08-00-20-000Z-000001-${session}`,
            "2026-09-11T08:00:20Z",
            session,
            bodyWithTailMessages(20),
            responseUsage({ input_tokens: 0, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0 }),
        );
        writeDump(
            dir,
            `2026-09-11T08-00-30-000Z-000002-${session}`,
            "2026-09-11T08:00:30Z",
            session,
            bodyWithTailMessages(10),
            responseUsage({ input_tokens: 0, cache_read_input_tokens: 930, cache_creation_input_tokens: 0 }),
        );

        const row = __test.analyzeSnapshots(snapshotsFor(dir, session))[1];

        expect(row.divergenceIndex).toBe(11);
        expect(row.previous?.segments.length).toBe(21);
        expect(row.current.segments.length).toBe(11);
        expect(row.verdict).toBe("BUST");
        expect(row.rewrittenTokens).toBe(0);
        expect(row.divergenceClass).toBe("tail_shrink_no_rewrite");
    });
    test("keeps a 1,000-token tail rewrite unaccounted", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-tail-rewrite-1000-"));
        tempDirs.push(dir);
        const session = "ses_tailrewrite";
        writeDump(
            dir,
            `2026-09-11T08-01-00-000Z-000001-${session}`,
            "2026-09-11T08:01:00Z",
            session,
            bodyWithBreakpointMessage("the original tail with extra content"),
            responseUsage({ input_tokens: 0, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0 }),
        );
        writeDump(
            dir,
            `2026-09-11T08-01-10-000Z-000002-${session}`,
            "2026-09-11T08:01:10Z",
            session,
            bodyWithBreakpointMessage("the original tail"),
            responseUsage({ input_tokens: 0, cache_read_input_tokens: 1, cache_creation_input_tokens: 1_000 }),
        );

        const rows = __test.analyzeSnapshots(snapshotsFor(dir, session), [
            {
                timestampMs: Date.parse("2026-09-11T08:01:10Z"),
                decision: "unknown",
                canonicalDecision: "unknown",
                materialized: false,
                materializeReason: null,
                emergency: false,
                droppedTokens: 0,
                droppedCount: 0,
                inputTokens: 1_000,
                flush: false,
                source: "fixture",
            },
        ]);
        const row = rows[1];

        expect(row.verdict).toBe("BUST");
        expect(row.rewrittenTokens).toBe(1_000);
        expect(row.divergenceClass).toBe("unaccounted_tail_rewrite");
    });
    test("does not forgive consecutive prefix rewrites at the same read floor", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-rebust-"));
        tempDirs.push(dir);
        const session = "ses_rebust";
        const readings = [
            [254592, 1054],
            [16896, 173076],
            [16896, 173524],
            [190336, 493],
        ];
        readings.forEach(([cacheRead, input], index) => {
            writeDump(
                dir,
                `2026-09-11T07-56-0${index}-000Z-${session}`,
                `2026-09-11T07:56:0${index}Z`,
                session,
                bodyWithBreakpointMessage(String(index)),
                responseUsage({
                    input_tokens: input!,
                    cache_read_input_tokens: cacheRead!,
                    cache_creation_input_tokens: 0,
                }),
            );
        });
        const rows = __test.analyzeSnapshots(snapshotsFor(dir, session));
        expect(rows.map((row) => row.verdict)).toEqual(["BASE", "BUST", "BUST", "STABLE"]);
        // On the Anthropic meter a short read that wrote nothing while ~173k
        // tokens went uncached is the missing-breakpoint shape.
        expect(rows[1]?.divergenceClass).toBe("missing_breakpoint_after_read");
        expect(rows[2]?.divergenceClass).toBe("missing_breakpoint_after_read");
        expect(rows[2]?.rewrittenTokens).toBe(0);
    });
    test("joins a pre-send pass by request time when its long response finishes four minutes later", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-pass-time-"));
        tempDirs.push(dir);
        const session = "ses_passtime123";
        const firstStem = `2026-09-11T06-59-00-000Z-${session}`;
        const bustStem = `2026-09-11T07-00-10-000Z-${session}`;
        writeDump(
            dir,
            firstStem,
            "2026-09-11T06:59:00Z",
            session,
            bodyWithBreakpointMessage("old"),
            responseUsage({
                input_tokens: 100,
                cache_read_input_tokens: 900,
                cache_creation_input_tokens: 0,
            }),
        );
        writeDump(
            dir,
            bustStem,
            "2026-09-11T07:00:10Z",
            session,
            bodyWithBreakpointMessage("new"),
            responseUsage({
                input_tokens: 10,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
            }),
        );
        const responseCompletion = new Date("2026-09-11T07:04:10Z");
        utimesSync(join(dir, `${bustStem}.response.json`), responseCompletion, responseCompletion);
        const passTime = new Date("2026-09-11T06:59:45Z");

        const analysis = analyzeOpenCodeCacheBustSession({
            sessionId: session,
            anthropicDir: dir,
            openaiDir: join(dir, "missing-openai"),
            decisions: [
                {
                    timestampMs: passTime.getTime(),
                    decision: "defer",
                    materialized: true,
                    materializeReason: "system_hash",
                    emergency: false,
                    droppedTokens: 0,
                    droppedCount: 0,
                    inputTokens: 1_000,
                    flush: false,
                    source: "fixture",
                },
            ],
        });

        expect(analysis.requests.at(-1)?.divergenceClass).toBe("accounted_hard_system_hash");
    });

    test("joins slow AFT passes and wakes for an input-step epoch", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-aft-slow-pass-"));
        tempDirs.push(dir);
        const session = "ses_313660571ffeZTsf4koSJwk50Q";
        const requests = [
            ["2026-09-22T11:54:34.997Z", "baseline", 300_000],
            ["2026-09-22T11:54:40.313Z", "coverage fold", 10_000],
            ["2026-09-22T11:55:29.581Z", "epoch rewrite", 10_000],
        ] as const;
        for (const [at, text, cacheRead] of requests) {
            const stem = `${at.replaceAll(":", "-").replace(".", "-")}-${session}`;
            writeDump(
                dir,
                stem,
                at,
                session,
                bodyWithBreakpointMessage(text),
                responseUsage({
                    input_tokens: 2,
                    cache_read_input_tokens: cacheRead,
                    cache_creation_input_tokens: 200_000,
                }),
            );
        }
        const decisions: CacheBustDecisionAttribution[] = [
            {
                timestampMs: Date.parse("2026-09-22T11:54:36.709Z"),
                decision: "SOFT",
                canonicalDecision: "execute",
                materialized: true,
                materializeReason: "coverage_fold",
                emergency: false,
                droppedTokens: 0,
                droppedCount: 0,
                inputTokens: 373_959,
                inputCount: 513,
                flush: false,
                source: "fixture",
            },
            {
                timestampMs: Date.parse("2026-09-22T11:55:13.792Z"),
                decision: "HARD",
                canonicalDecision: "HARD",
                materialized: true,
                materializeReason: "epoch_change",
                emergency: false,
                droppedTokens: 0,
                droppedCount: 0,
                inputTokens: 343_741,
                inputCount: 12_747,
                flush: false,
                source: "fixture",
            },
        ];

        const analysis = analyzeOpenCodeCacheBustSession({
            sessionId: session,
            anthropicDir: dir,
            openaiDir: join(dir, "missing-openai"),
            decisions,
            mcLogPath: null,
        });
        expect(analysis.requests[1]?.divergenceClass).not.toBe("no_mc_pass_row");
        expect(analysis.requests[2]?.divergenceClass).toBe("self_inflicted_epoch");
    });

    test("prints complete UTF-8 body bytes separately from reusable normalized prefix bytes", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-body-bytes-"));
        tempDirs.push(dir);
        const session = "ses_bodyBytes";
        const previous = bodyWithTailCheckpoint("old § tail");
        const current = bodyWithTailCheckpoint("new § tail with more bytes");
        const previousStem = `2026-09-02T08-41-00-000Z-${session}`;
        const currentStem = `2026-09-02T08-42-00-000Z-${session}`;
        writeDump(dir, previousStem, "2026-09-02T08:41:00Z", session, previous);
        writeDump(dir, currentStem, "2026-09-02T08:42:00Z", session, current);
        const prettyBody = `${JSON.stringify(current, null, 2)}\n`;
        writeFileSync(join(dir, `${currentStem}.body.json`), prettyBody);
        const expected = [
            Buffer.byteLength(JSON.stringify(previous)),
            Buffer.byteLength(prettyBody),
        ];
        expect(snapshotsFor(dir, session).map((snapshot) => snapshot.bodyBytes)).toEqual(expected);
        const run = Bun.spawnSync([
            process.execPath,
            join(import.meta.dir, "analyze-cache-busts.ts"),
            "--session",
            session,
            "--dir",
            dir,
            "--all-rows",
        ]);
        expect(run.exitCode).toBe(0);
        const output = run.stdout.toString();
        expect(output).toContain("prevBodyBytes → curBodyBytes");
        expect(output).toContain("reusableNormalizedPrefix@breakpoint");
        expect(output).toContain(
            `${expected[0]!.toLocaleString()}B → ${expected[1]!.toLocaleString()}B`,
        );
    });
    test("loads and orders legacy and sequence+routing filename layouts by timestamp and sequence", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-fixture-"));
        tempDirs.push(dir);
        const session = "ses_fixtureFull123";
        const legacy = `2026-09-02T08-41-39-474Z-${session}`;
        const currentEarly = `2026-09-02T08-46-03-306Z-000002-${session}-direct-sticky-yiyi`;
        const currentLate = `2026-09-02T08-46-03-306Z-000013-${session}-direct-sticky-yiyi`;
        writeDump(dir, currentLate, "2026-09-02T08:46:03.306Z", session, bodyWithTail("late"));
        writeDump(dir, legacy, "2026-09-02T08:41:39.474Z", session, bodyWithTail("legacy"));
        writeDump(dir, currentEarly, "2026-09-02T08:46:03.306Z", session, bodyWithTail("early"));

        const snapshots = snapshotsFor(dir, session);

        expect(snapshots.map((snapshot) => snapshot.file)).toEqual([
            `${legacy}.meta.json`,
            `${currentEarly}.meta.json`,
            `${currentLate}.meta.json`,
        ]);
        expect(snapshots.every((snapshot) => snapshot.session === session)).toBe(true);
    });

    test("records actual request bytes independently of cached-prefix attribution", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-wire-bytes-"));
        tempDirs.push(dir);
        const session = "ses_wireBytesFixture";
        const body = bodyWithTail("wire byte payload");
        writeDump(
            dir,
            `2026-09-02T08-46-03-306Z-000002-${session}`,
            "2026-09-02T08:46:03.306Z",
            session,
            body,
        );

        expect(snapshotsFor(dir, session)[0]?.bodyBytes).toBe(
            Buffer.byteLength(JSON.stringify(body)),
        );
    });

    test("lists ambiguous cross-provider candidates and selects the newest", () => {
        const anthropicDir = mkdtempSync(join(tmpdir(), "cache-bust-anthropic-candidate-"));
        const openaiDir = mkdtempSync(join(tmpdir(), "cache-bust-openai-candidate-"));
        tempDirs.push(anthropicDir, openaiDir);
        const oldSession = "ses_ambiguousOld";
        const newSession = "ses_ambiguousNew";
        const oldStem = `2026-09-02T08-41-00-000Z-000001-${oldSession}`;
        const newStem = `2026-09-02T08-42-00-000Z-000001-${newSession}`;
        writeDump(anthropicDir, oldStem, "2026-09-02T08:41:00Z", oldSession, bodyWithTail("old"));
        writeDump(openaiDir, newStem, "2026-09-02T08:42:00Z", newSession, {
            input: [
                { type: "message", role: "user", content: [{ type: "input_text", text: "new" }] },
            ],
        });
        utimesSync(join(anthropicDir, `${oldStem}.body.json`), new Date(1_000), new Date(1_000));
        utimesSync(join(openaiDir, `${newStem}.body.json`), new Date(2_000), new Date(2_000));

        const run = Bun.spawnSync(
            [
                process.execPath,
                join(import.meta.dir, "analyze-cache-busts.ts"),
                "--session",
                "ses_ambiguous",
                "--all-rows",
            ],
            {
                env: {
                    ...process.env,
                    OPENCODE_ANTHROPIC_AUTH_DUMP_DIR: anthropicDir,
                    OPENCODE_OPENAI_AUTH_DUMP_DIR: openaiDir,
                },
            },
        );

        expect(run.exitCode).toBe(0);
        const output = run.stdout.toString();
        expect(output).toContain("Ambiguous session prefix");
        expect(output).toContain(`${oldSession} provider=anthropic mtime=`);
        expect(output).toContain(`${newSession} provider=openai mtime=`);
        expect(output).toContain("size=");
        expect(output).toContain(`Using newest candidate ${newSession} from ${openaiDir}.`);
    });

    test("resolves relative --since durations", () => {
        expect(__test.resolveTimeBound("30m", 1_800_000)).toBe("1970-01-01T00:00:00.000Z");
        expect(__test.resolveTimeBound("2026-09-02T08:30:00Z", 0)).toBe("2026-09-02T08:30:00.000Z");
    });
});

describe("analyze-cache-bust normalized provider fixtures", () => {
    const fixtureRoot = join(import.meta.dir, "test-fixtures", "cache-bust-bodies");
    const fixtureJson = (source: string, file: string): Record<string, unknown> =>
        JSON.parse(readFileSync(join(fixtureRoot, source, file), "utf8")) as Record<
            string,
            unknown
        >;

    for (const source of ["anthropic", "openai-auth"] as const) {
        test(`${source} names the normalized first-diverging message`, () => {
            const provider = source === "anthropic" ? "anthropic" : "openai";
            const previous = normalizeRequestBody(
                fixtureJson(source, "001-request.json"),
                provider,
            );
            const current = normalizeRequestBody(fixtureJson(source, "002-request.json"), provider);

            const divergence = describeBodyPair(previous.messages, current.messages);

            expect(divergence?.description).toBe(
                `message[1] role=user parts=[${provider === "anthropic" ? "text" : "input_text"}(19)] text="cached prefix after"`,
            );
        });

        test(`${source} applies its provider meter rule`, () => {
            const dir = mkdtempSync(join(tmpdir(), `cache-bust-${source}-fixture-`));
            tempDirs.push(dir);
            const session = `ses_${source.replace("-", "")}`;
            for (const [index, timestamp] of [
                [1, "2026-09-02T08:41:00.000Z"],
                [2, "2026-09-02T08:42:00.000Z"],
            ] as const) {
                writeDump(
                    dir,
                    `2026-09-02T08-${index === 1 ? "41" : "42"}-00-000Z-00000${index}-${session}`,
                    timestamp,
                    session,
                    fixtureJson(source, `00${index}-request.json`),
                    fixtureJson(source, `00${index}-response.json`),
                );
            }

            const row = __test.analyzeSnapshots(snapshotsFor(dir, session))[1];

            expect(row.verdict).toBe("BUST");
            expect(row.current.provider).toBe(source === "anthropic" ? "anthropic" : "openai");
            expect(row.current.usage?.rule).toContain(
                source === "anthropic"
                    ? "Anthropic explicit cache"
                    : "OpenAI implicit-prefix cache",
            );
        });
    }
});

describe("analyze-cache-bust provider meter verdicts", () => {
    test("discriminates one metered bust from one latency row", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-discrimination-"));
        tempDirs.push(dir);
        const bustSession = "ses_bustDiscrimination";
        const latencySession = "ses_latencyDiscrimination";

        writeDump(
            dir,
            `2026-09-02T04-47-20-000Z-000001-${bustSession}`,
            "2026-09-02T04:47:20.000Z",
            bustSession,
            bodyWithBreakpointMessage("stable predecessor"),
            responseUsage({ cache_read_input_tokens: 387_595, input_tokens: 4 }),
        );
        writeDump(
            dir,
            `2026-09-02T04-47-29-000Z-000002-${bustSession}`,
            "2026-09-02T04:47:29.000Z",
            bustSession,
            bodyWithBreakpointMessage("rewritten breakpoint"),
            responseUsage({
                cache_read_input_tokens: 267_383,
                cache_creation_input_tokens: 120_212,
                input_tokens: 4,
            }),
        );

        const unchangedBody = bodyWithTailCheckpoint("unchanged tail");
        writeDump(
            dir,
            `2026-09-02T04-48-00-000Z-000001-${latencySession}`,
            "2026-09-02T04:48:00.000Z",
            latencySession,
            unchangedBody,
            responseUsage({ cache_creation_input_tokens: 300_000, input_tokens: 2 }),
        );
        writeDump(
            dir,
            `2026-09-02T04-48-01-000Z-000002-${latencySession}`,
            "2026-09-02T04:48:01.000Z",
            latencySession,
            unchangedBody,
            responseUsage({ cache_read_input_tokens: 100_000, input_tokens: 2 }),
        );

        const bust = __test.analyzeSnapshots(snapshotsFor(dir, bustSession))[1];
        const latency = __test.analyzeSnapshots(snapshotsFor(dir, latencySession))[1];

        expect([bust.verdict, latency.verdict]).toEqual(["BUST", "LATENCY"]);
        expect(bust.byteVerdict).toBe("BUST");
        expect(latency.byteVerdict).toBe("STABLE");
        expect(bust.rewrittenTokens).not.toBe(latency.rewrittenTokens);
    });

    test("classifies a breakpoint rewrite as a metered bust", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-meter-"));
        tempDirs.push(dir);
        const session = "ses_realBustFixture";
        writeDump(
            dir,
            `2026-09-02T08-45-00-000Z-000001-${session}`,
            "2026-09-02T08:45:00.000Z",
            session,
            bodyWithBreakpointMessage("old prompt section"),
            responseUsage({ cache_read_input_tokens: 387_595, input_tokens: 4 }),
        );
        writeDump(
            dir,
            `2026-09-02T08-46-03-000Z-000002-${session}`,
            "2026-09-02T08:46:03.000Z",
            session,
            bodyWithBreakpointMessage("rewritten prompt section"),
            responseUsage({
                cache_read_input_tokens: 267_383,
                cache_creation_input_tokens: 120_212,
                input_tokens: 4,
            }),
        );

        const row = __test.analyzeSnapshots(snapshotsFor(dir, session))[1];

        expect(row.verdict).toBe("BUST");
        expect(row.byteVerdict).toBe("BUST");
        expect(row.meterVsBytes).toBe("AGREE");
        expect(row.rewrittenTokens).toBe(120_212);
    });

    test("forgives a tail divergence when the streamed usage meter reports a hit", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-meter-"));
        tempDirs.push(dir);
        const session = "ses_falsePositiveFixture";
        const priorUsage = {
            cache_read_input_tokens: 411_287,
            input_tokens: 4,
        };
        writeDump(
            dir,
            `2026-09-02T09-17-40-000Z-000001-${session}`,
            "2026-09-02T09:17:40.000Z",
            session,
            bodyWithTail("older tail payload", true),
            responseUsage(priorUsage),
        );
        writeDump(
            dir,
            `2026-09-02T09-17-52-000Z-000002-${session}`,
            "2026-09-02T09:17:52.000Z",
            session,
            bodyWithTailCheckpoint("new tail payload"),
            streamedUsage({
                cache_read_input_tokens: 411_287,
                cache_creation_input_tokens: 1_771,
                input_tokens: 4,
            }),
        );

        const row = __test.analyzeSnapshots(snapshotsFor(dir, session))[1];

        // The provider meter remains authoritative when a changed segment is within
        // the current tail breakpoint but the read is not materially short.
        expect(row.verdict).toBe("STABLE");
        expect(row.byteVerdict).toBe("BUST");
        expect(row.meterVsBytes).toBe("BYTES-ONLY");
        // The floor is the previous read + write - 64; the read alone is compared.
        expect(row.meterFloor).toBe(411_223);
        expect(row.comparableRead).toBe(411_287);
        expect(row.current.usage?.source).toBe("message_delta.usage");
    });

    test("classifies the CKIOS cold-write follow-up as a metered bust", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-meter-"));
        tempDirs.push(dir);
        const session = "ses_ckiosFixture";
        writeDump(
            dir,
            `2026-09-02T10-00-24-000Z-000001-${session}`,
            "2026-09-02T10:00:24.000Z",
            session,
            bodyWithTailCheckpoint("before cold write"),
            responseUsage({ cache_creation_input_tokens: 312_913, input_tokens: 4 }),
        );
        writeDump(
            dir,
            `2026-09-02T10-01-43-000Z-000002-${session}`,
            "2026-09-02T10:01:43.000Z",
            session,
            bodyWithTailCheckpoint("rewritten after cold write"),
            responseUsage({
                cache_read_input_tokens: 224_224,
                cache_creation_input_tokens: 91_447,
                input_tokens: 2,
            }),
        );

        const row = __test.analyzeSnapshots(snapshotsFor(dir, session))[1];

        expect(row.verdict).toBe("BUST");
        expect(row.shortRead).toBe(true);
        expect(row.byteVerdict).toBe("BUST");
        expect(row.rewrittenTokens).toBe(91_447);
    });

    test("labels a short read without reusable-prefix byte divergence as latency", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-meter-"));
        tempDirs.push(dir);
        const session = "ses_latencyFixture";
        const unchangedBody = bodyWithTailCheckpoint("unchanged tail");
        writeDump(
            dir,
            `2026-09-02T10-10-00-000Z-000001-${session}`,
            "2026-09-02T10:10:00.000Z",
            session,
            unchangedBody,
            responseUsage({ cache_creation_input_tokens: 300_000, input_tokens: 2 }),
        );
        writeDump(
            dir,
            `2026-09-02T10-10-01-000Z-000002-${session}`,
            "2026-09-02T10:10:01.000Z",
            session,
            unchangedBody,
            responseUsage({ cache_read_input_tokens: 100_000, input_tokens: 2 }),
        );

        const row = __test.analyzeSnapshots(snapshotsFor(dir, session))[1];

        expect(row.shortRead).toBe(true);
        expect(row.verdict).toBe("LATENCY");
        expect(row.byteVerdict).toBe("STABLE");
        expect(row.meterVsBytes).toBe("LATENCY");
        expect(row.rewrittenTokens).toBe(200_002);
    });

    test("reports an unmetered byte-attributed candidate when a response has no usage", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-meter-"));
        tempDirs.push(dir);
        const session = "ses_unmeteredFixture";
        writeDump(
            dir,
            `2026-09-02T09-20-00-000Z-000001-${session}`,
            "2026-09-02T09:20:00.000Z",
            session,
            bodyWithBreakpointMessage("before"),
            responseUsage({ cache_read_input_tokens: 10, input_tokens: 1 }),
        );
        writeDump(
            dir,
            `2026-09-02T09-20-01-000Z-000002-${session}`,
            "2026-09-02T09:20:01.000Z",
            session,
            bodyWithBreakpointMessage("after"),
            { status: 200, stream_complete: false },
        );

        const row = __test.analyzeSnapshots(snapshotsFor(dir, session))[1];

        expect(row.verdict).toBe("UNMETERED");
        expect(row.byteVerdict).toBe("BUST");
        expect(row.meterVsBytes).toBe("UNMETERED");
    });
});

describe("analyze-cache-bust rotating billing header", () => {
    // Redacted from three consecutive captured Anthropic requests. The content is
    // replaced; the shape that produced the defect is kept: a three-block system
    // whose first block is the auth plugin's per-request billing header, a head
    // message carrying cache_control breakpoints, two messages appended per
    // request, and the tail cache_control marker moving onto the newest message
    // each time.
    const fixtureRoot = join(
        import.meta.dir,
        "test-fixtures",
        "cache-bust-bodies",
        "anthropic-billing-header",
    );
    const fixtureJson = (file: string): Record<string, unknown> =>
        JSON.parse(readFileSync(join(fixtureRoot, file), "utf8")) as Record<string, unknown>;

    function billingHeaderSession(): { dir: string; session: string } {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-billing-header-"));
        tempDirs.push(dir);
        const session = "ses_billingHeaderRotation";
        for (const [index, timestamp] of [
            [1, "2026-09-21T12:26:17.760Z"],
            [2, "2026-09-21T12:26:31.108Z"],
            [3, "2026-09-21T12:32:32.610Z"],
        ] as const) {
            writeDump(
                dir,
                `${timestamp.replaceAll(":", "-").replace(".", "-")}-00000${index}-${session}`,
                timestamp,
                session,
                fixtureJson(`00${index}-request.json`),
                fixtureJson(`00${index}-response.json`),
            );
        }
        return { dir, session };
    }

    test("the fixture really does rotate the header, so the normalization is load-bearing", () => {
        const headerText = (file: string): string =>
            ((fixtureJson(file).system as Array<{ text: string }>)[0] as { text: string }).text;

        expect(headerText("002-request.json")).not.toBe(headerText("003-request.json"));
        expect(headerText("002-request.json")).toContain("x-anthropic-billing-header:");
        // Both `cch` and `cc_prev_req` move; `cc_prompt_id` moves across an idle gap.
        for (const field of ["cch=", "cc_prev_req=req_", "cc_prompt_id="]) {
            expect(headerText("002-request.json").split(field)[1]).not.toBe(
                headerText("003-request.json").split(field)[1],
            );
        }
    });

    test("an appended-tail request over a rotated header is STABLE, not a byte bust", () => {
        const { dir, session } = billingHeaderSession();

        const row = __test.analyzeSnapshots(snapshotsFor(dir, session))[1];

        expect(row.verdict).toBe("STABLE");
        expect(row.byteVerdict).toBe("STABLE");
        expect(row.meterVsBytes).toBe("AGREE");
        // The first divergence is the appended tail, not the rotating system row.
        expect(row.divergenceIndex).toBe(252);
        expect(row.current.segments[row.divergenceIndex].role).toBe("assistant");
    });

    test("a short read over an unchanged reusable prefix is provider-side latency", () => {
        const { dir, session } = billingHeaderSession();

        // The fixture's third request came 6 min after the second. A 1 h TTL keeps
        // this about the identical-bytes provider class, not idle expiry.
        const row = __test.analyzeSnapshots(snapshotsFor(dir, session), [], {
            cacheTtlMs: 3_600_000,
        })[2];

        expect(row.verdict).toBe("LATENCY");
        expect(row.byteVerdict).toBe("STABLE");
        expect(row.meterVsBytes).toBe("LATENCY");
        expect(row.divergenceClass).toBe("provider_short_read_identical_bytes");
        // The tail cache_control marker moved from message 252 to message 254;
        // the reusable prefix is still the one the previous request wrote.
        expect(row.divergenceIndex).toBe(254);
        expect(row.current.usage?.cacheRead).toBe(285_161);
    });

    test("the same short read 6 min after the last refresh is idle expiry under the default 5 min TTL", () => {
        const { dir, session } = billingHeaderSession();

        const row = __test.analyzeSnapshots(snapshotsFor(dir, session))[2];

        expect(row.verdict).toBe("LATENCY");
        expect(row.idleGapMs).toBe(361_502);
        expect(row.divergenceClass).toBe("idle_cache_expiry");
    });

    test("prints no bytes-BUST cell for the whole rotated-header run", () => {
        const { dir, session } = billingHeaderSession();

        const run = Bun.spawnSync([
            process.execPath,
            join(import.meta.dir, "analyze-cache-busts.ts"),
            "--session",
            session,
            "--dir",
            dir,
            "--all-rows",
            "--cache-ttl",
            "1h",
        ]);

        expect(run.exitCode).toBe(0);
        const output = run.stdout.toString();
        expect(output).not.toContain("(bytes BUST)");
        expect(output).not.toContain("message[0] role=system");
        expect(output).toContain("divergence-class: provider_short_read_identical_bytes");
        expect(output).toContain("No metered busts across 3 request(s).");
        expect(output).toContain("1 latency-only short read(s)");
    });

    test("never prints reasoning text, while a change inside it still diverges", () => {
        const secret = "PRIVATE-REASONING-SENTENCE about the plan";
        const changed = "PRIVATE-REASONING-SENTENCE about another plan";
        const anthropic = (thinking: string) => ({
            system: [{ type: "text", text: "stable system" }],
            messages: [
                { role: "user", content: [{ type: "text", text: "question" }] },
                {
                    role: "assistant",
                    content: [
                        { type: "thinking", thinking, signature: "SIGNATURE-BYTES-abc" },
                        { type: "redacted_thinking", data: "REDACTED-DATA-xyz" },
                        { type: "text", text: "visible answer" },
                    ],
                },
            ],
        });
        const openai = {
            input: [
                {
                    type: "reasoning",
                    summary: [{ type: "summary_text", text: secret }],
                    encrypted_content: "ENCRYPTED-REASONING-123",
                },
                { role: "assistant", content: [{ type: "output_text", text: "visible answer" }] },
            ],
        };
        const gemini = {
            contents: [
                {
                    role: "model",
                    parts: [
                        { text: secret, thought: true },
                        {
                            functionCall: { name: "read", args: { path: "a.ts" } },
                            thoughtSignature: "GEMINI-SIGNATURE-777",
                        },
                    ],
                },
            ],
        };
        const forbidden = [
            secret,
            changed,
            "SIGNATURE-BYTES-abc",
            "REDACTED-DATA-xyz",
            "ENCRYPTED-REASONING-123",
            "GEMINI-SIGNATURE-777",
        ];
        const printed = (messages: ReturnType<typeof normalizeRequestBody>["messages"]) =>
            messages
                .flatMap((message) => [
                    message.display,
                    ...message.parts.map((part) => part.textPrefix),
                ])
                .join("\n");

        const before = normalizeRequestBody(anthropic(secret), "anthropic").messages;
        const after = normalizeRequestBody(anthropic(changed), "anthropic").messages;
        for (const messages of [
            before,
            after,
            normalizeRequestBody(openai, "openai").messages,
            normalizeRequestBody(gemini, "gemini").messages,
        ]) {
            const text = printed(messages);
            for (const value of forbidden) expect(text).not.toContain(value);
        }
        // Visible text, tool calls and part types stay printable.
        expect(printed(before)).toContain("visible answer");
        expect(printed(normalizeRequestBody(gemini, "gemini").messages)).toContain("a.ts");
        expect(before[2].parts.map((part) => part.type)).toEqual([
            "thinking",
            "redacted_thinking",
            "text",
        ]);

        // The raw canonical still drives detection, so a reasoning edit diverges and
        // its redacted marker changes, without the printed diff showing either text.
        expect(before[2].hash).not.toBe(after[2].hash);
        const divergence = describeBodyPair(before, after);
        expect(divergence?.index).toBe(2);
        expect(divergence?.previousText).not.toBe(divergence?.currentText);
        expect(divergence?.description).not.toContain("PRIVATE-REASONING");
        for (const value of forbidden) {
            expect(divergence?.previousText).not.toContain(value);
            expect(divergence?.currentText).not.toContain(value);
        }
    });

    test("normalizes the rotated header into one shared system-message identity", () => {
        const [previous, current] = ["002-request.json", "003-request.json"].map(
            (file) => normalizeRequestBody(fixtureJson(file), "anthropic").messages[0],
        );

        expect(previous.canonical).toContain("x-anthropic-billing-header: <rotating>");
        expect(previous.canonical).not.toContain("cc_prev_req=req_0");
        expect(current.hash).toBe(previous.hash);
        expect(describeBodyPair([previous], [current])).toBeUndefined();
    });
});


describe("analyze-cache-bust uncached input never counts as reuse", () => {
    type Reading = readonly [at: string, input: number, read: number, write: number];
    // A conversation that only grows: every request appends one message and moves
    // the tail breakpoint, so the reusable bytes never change and any short read
    // is decided by the meter alone.
    const growingBody = (turns: number): unknown => ({
        system: [{ type: "text", text: "system head", cache_control: { type: "ephemeral" } }],
        messages: Array.from({ length: turns }, (_, index) => ({
            role: index % 2 === 0 ? "user" : "assistant",
            content: [
                {
                    type: "text",
                    text: `turn ${index}`,
                    ...(index === turns - 1 ? { cache_control: { type: "ephemeral" } } : {}),
                },
            ],
        })),
    });
    const anthropicSession = (session: string, readings: readonly Reading[]) => {
        const dir = mkdtempSync(join(tmpdir(), "cache-uncached-input-"));
        tempDirs.push(dir);
        readings.forEach(([at, input, read, write], index) => {
            writeDump(
                dir,
                `${at.replaceAll(":", "-").replace(".", "-")}-${String(index + 1).padStart(6, "0")}-${session}`,
                at,
                session,
                growingBody(index + 1),
                responseUsage({
                    input_tokens: input,
                    cache_read_input_tokens: read,
                    cache_creation_input_tokens: write,
                }),
            );
        });
        return __test.analyzeSnapshots(snapshotsFor(dir, session));
    };

    test("flags the 2026-10-17 Pi requests that read only the 47k head and wrote nothing", () => {
        // Session 019de471, 14:04:44-14:10:34 UTC, exact usage numbers.
        const rows = anthropicSession("ses_missingBreakpoint", [
            ["2026-10-17T14:04:44.317Z", 2, 519_900, 506],
            ["2026-10-17T14:05:06.355Z", 474_229, 47_083, 0],
            ["2026-10-17T14:05:11.503Z", 2, 520_406, 1_260],
            ["2026-10-17T14:09:55.464Z", 474_788, 47_083, 0],
            ["2026-10-17T14:10:11.085Z", 479_189, 47_083, 0],
            ["2026-10-17T14:10:23.287Z", 2, 47_083, 483_683],
            ["2026-10-17T14:10:34.445Z", 2, 530_766, 1_126],
        ]);

        expect(rows.map((row) => row.verdict)).toEqual([
            "BASE",
            "BUST",
            "STABLE",
            "BUST",
            "BUST",
            "LATENCY",
            "STABLE",
        ]);
        expect(rows.map((row) => row.divergenceClass)).toEqual([
            undefined,
            "missing_breakpoint_after_read",
            undefined,
            "missing_breakpoint_after_read",
            "missing_breakpoint_after_read",
            // 14:10:23 wrote the rest, but the 521k prefix was last read at
            // 14:05:11, 5 min 12 s earlier: the two head-only reads in between did
            // not refresh it, so it had expired.
            "idle_cache_expiry",
            undefined,
        ]);
        expect(rows[3]?.comparableRead).toBe(47_083);
        expect(rows[3]?.meterFloor).toBe(521_602);
    });

    test("flags the 019e8905 13:52 request that read 47k of a 621k prompt", () => {
        const rows = anthropicSession("ses_missingBreakpoint1352", [
            ["2026-10-17T13:51:37.698Z", 2, 614_837, 2_869],
            ["2026-10-17T13:52:16.089Z", 573_919, 47_081, 0],
            ["2026-10-17T13:52:21.895Z", 2, 617_706, 3_741],
        ]);

        expect(rows.map((row) => row.verdict)).toEqual(["BASE", "BUST", "STABLE"]);
        expect(rows[1]?.divergenceClass).toBe("missing_breakpoint_after_read");
    });

    test("keeps a warm Anthropic tool loop STABLE", () => {
        const rows = anthropicSession("ses_warmToolLoop", [
            ["2026-10-17T14:10:34.445Z", 2, 530_766, 1_126],
            ["2026-10-17T14:10:41.091Z", 2, 531_892, 784],
            ["2026-10-17T14:11:01.762Z", 2, 532_676, 1_688],
            ["2026-10-17T14:15:58.303Z", 2, 534_364, 1_950],
        ]);

        expect(rows.map((row) => row.verdict)).toEqual(["BASE", "STABLE", "STABLE", "STABLE"]);
    });

    test("labels a short read after more than the TTL idle as expiry", () => {
        // Session 019e8905: 17 min idle after 13:28:40, then a turn start that
        // read nothing and rewrote the prompt over two requests.
        const rows = anthropicSession("ses_idleExpiry", [
            ["2026-10-17T13:28:40.073Z", 2, 600_452, 719],
            ["2026-10-17T13:46:00.084Z", 554_630, 0, 47_081],
            ["2026-10-17T13:46:24.402Z", 2, 47_081, 555_984],
            ["2026-10-17T13:46:44.637Z", 2, 603_065, 648],
        ]);

        expect(rows[1]?.verdict).toBe("LATENCY");
        expect(rows[1]?.divergenceClass).toBe("idle_cache_expiry");
        expect(rows[1]?.idleGapMs).toBe(1_040_011);
        expect(rows.slice(2).map((row) => row.verdict)).toEqual(["STABLE", "STABLE"]);
    });

    test("keeps the OpenAI implicit-prefix meter: cached tokens alone, no missing-breakpoint class", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-uncached-input-openai-"));
        tempDirs.push(dir);
        const session = "ses_openaiImplicit";
        const readings = [
            ["2026-10-17T12:00:00.000Z", 50_000, 0],
            ["2026-10-17T12:00:10.000Z", 51_200, 49_920],
            ["2026-10-17T12:00:20.000Z", 52_000, 51_072],
            ["2026-10-17T12:00:30.000Z", 53_000, 10_112],
            ["2026-10-17T12:00:40.000Z", 53_800, 52_992],
        ] as const;
        readings.forEach(([at, prompt, cached], index) => {
            writeDump(
                dir,
                `${at.replaceAll(":", "-").replace(".", "-")}-${String(index + 1).padStart(6, "0")}-${session}`,
                at,
                session,
                {
                    model: "gpt-fixture",
                    instructions: "stable system",
                    input: Array.from({ length: index + 1 }, (_, turn) => ({
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: `turn ${turn}` }],
                    })),
                },
                {
                    usage: {
                        input_tokens: prompt,
                        input_tokens_details: { cached_tokens: cached },
                    },
                },
            );
        });

        const rows = __test.analyzeSnapshots(snapshotsFor(dir, session));

        expect(rows.map((row) => row.current.provider)).toEqual(Array(5).fill("openai"));
        // The 10k read over an appended-only prompt is short; its 43k of uncached
        // input does not cover it, and an implicit cache has no breakpoints to miss.
        expect(rows.map((row) => row.verdict)).toEqual([
            "BASE",
            "STABLE",
            "STABLE",
            "LATENCY",
            "STABLE",
        ]);
        expect(rows[3]?.comparableRead).toBe(10_112);
        expect(rows[3]?.divergenceClass).toBe("provider_short_read_identical_bytes");
    });
});

describe("bounded sentinel dump scans", () => {
    test("skips old files and resumes a bounded scan without losing requests", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-sentinel-scan-"));
        tempDirs.push(dir);
        for (let i = 0; i < 400; i++) {
            writeFileSync(join(dir, `dump-2026-09-23T00-00-00-000Z-${String(i).padStart(5, "0")}-ses_scanfixture.meta.json`), "{}");
        }
        const sessionId = "ses_scanfixture";
        const base = Date.parse("2026-09-24T12:00:00.000Z");
        for (let i = 0; i < 40; i++) {
            const createdAt = new Date(base + i * 1_000).toISOString();
            const stem = `dump-${createdAt.replace(/:(\d\d):(\d\d)\.(\d\d\d)Z$/, "-$1-$2-$3Z")}-${i}-ses_scanfixture`;
            writeDump(dir, stem, createdAt, sessionId, bodyWithBreakpointMessage(`request ${i}`));
        }
        const scan = (sinceExclusiveMs: number, scanCursor?: string) => analyzeOpenCodeCacheBustSession({
            sessionId,
            anthropicDir: dir,
            openaiDir: join(dir, "missing"),
            sinceExclusiveMs,
            scanCursor,
            scanDeadlineMs: Date.now() + 60_000,
        });
        const first = scan(base - 1);
        expect(first.filesExamined).toBe(32);
        expect(first.scanBounded).toBe(true);
        const second = scan(base - 1, first.scanCursor);
        expect(second.filesExamined).toBe(8);
        expect(second.scanBounded).toBe(false);
        expect([...first.requests, ...second.requests].map((row) => row.timestampMs)).toEqual(
            Array.from({ length: 40 }, (_, i) => base + i * 1_000),
        );
        expect(scan(base + 39_000).filesExamined).toBe(0);
    }, 30_000);
});

describe("analyze-cache-bust wire-family meters (Broca cache-dump exports)", () => {
    const brocaRoot = join(import.meta.dir, "test-fixtures", "cache-bust-broca");
    const bodiesRoot = join(import.meta.dir, "test-fixtures", "cache-bust-bodies");
    const analyzer = join(import.meta.dir, "analyze-cache-busts.ts");
    const runAnalyzer = (args: string[]) =>
        Bun.spawnSync([process.execPath, analyzer, ...args, "--mc-log", "/nonexistent"]);
    const geminiRows = () =>
        __test.analyzeSnapshots(
            snapshotsFor(join(brocaRoot, "google-codeassist"), "alfonso:bg_geminiFixture"),
        );

    test("google_codeassist reads the Gemini meter: a hit stays STABLE, a zero read over an unchanged prefix is LATENCY", () => {
        const rows = geminiRows();

        expect(rows.map((row) => row.verdict)).toEqual([
            "BASE",
            "STABLE",
            "LATENCY",
            "LATENCY",
            "STABLE",
            "BUST",
        ]);
        const base = rows[0].current;
        expect(base.wireFamily).toBe("google_codeassist");
        expect(base.provider).toBe("gemini");
        // promptTokenCount already includes cachedContentTokenCount: the total is
        // the prompt count and the direct input is the prompt minus the cache read.
        expect(base.usage).toMatchObject({
            provider: "gemini",
            total: 20_000,
            cacheRead: 16_000,
            input: 4_000,
            output: 50,
        });
        // system + tools + one user turn: the Code Assist envelope was unwrapped.
        expect(base.segments.map((segment) => segment.role)).toEqual(["system", "tools", "user"]);

        // Hit: a 9-token dip below the previous read is meter jitter, not a miss.
        expect(rows[1].comparableRead).toBe(15_991);
        expect(rows[1].meterFloor).toBe(15_936);
        expect(rows[1].byteVerdict).toBe("STABLE");

        // Miss: nothing cached over an appended-only (byte-identical) prefix.
        expect(rows[2].comparableRead).toBe(0);
        expect(rows[2].byteVerdict).toBe("STABLE");
        expect(rows[2].divergenceClass).toBe("provider_short_read_identical_bytes");
    });

    test("a partial Gemini read inside a miss run is still short against the read before the run", () => {
        const rows = geminiRows();

        // The previous request read nothing, so its uncached input is the whole
        // prompt; the floor comes from the request before the miss instead.
        expect(rows[3].verdict).toBe("LATENCY");
        expect(rows[3].comparableRead).toBe(4_000);
        expect(rows[3].meterReference?.file).toBe("run-sid-fixture-s2.meta.json");
        expect(rows[3].meterFloor).toBe(15_927);
        // The raw Code Assist `{response: {usageMetadata}}` shape is read too.
        expect(rows[4].current.usage?.source).toBe("response.response.usageMetadata");
        expect(rows[4].verdict).toBe("STABLE");
        // An in-place rewrite of the first user turn is a byte bust at that turn.
        expect(rows[5].divergenceIndex).toBe(2);
        expect(rows[5].byteVerdict).toBe("BUST");
    });

    test("prints the wire family, the meter, and the metered count in the report", () => {
        const run = runAnalyzer([
            "--session",
            "alfonso:bg_geminiFixture",
            "--dir",
            join(brocaRoot, "google-codeassist"),
        ]);
        const output = run.stdout.toString();

        expect(run.exitCode).toBe(0);
        expect(output).toContain("Provider: gemini (from wire_family; searched as explicit --dir)");
        expect(output).toContain("Wire family: google_codeassist");
        expect(output).toContain("Meter:    gemini (promptTokenCount/cachedContentTokenCount)");
        expect(output).toContain("Metered:  6 of 6 analysed request(s) carry a usable meter reading.");
        expect(output).toContain("2 latency-only short read(s)");
    });

    test("refuses with meter_missing when no request carries the meter's fields", () => {
        const run = runAnalyzer([
            "--session",
            "alfonso:bg_geminiUnmetered",
            "--dir",
            join(brocaRoot, "google-codeassist-unmetered"),
            "--all-rows",
        ]);
        const output = run.stdout.toString();

        expect(run.exitCode).toBe(2);
        expect(output).toContain(
            "meter_missing: 2 of 2 requests carry no gemini usage (promptTokenCount/cachedContentTokenCount) (wire_family=google_codeassist)",
        );
        expect(output).toContain("Metered:  0 of 2 analysed request(s)");
        expect(output).not.toContain("No metered busts");
    });

    test("refuses when the OpenAI meter is forced onto a Gemini export", () => {
        const run = runAnalyzer([
            "--session",
            "alfonso:bg_geminiFixture",
            "--dir",
            join(brocaRoot, "google-codeassist"),
            "--meter",
            "openai",
        ]);
        const output = run.stdout.toString();

        expect(run.exitCode).toBe(2);
        expect(output).toContain(
            "meter_missing: 6 of 6 requests carry no openai usage (prompt_tokens|input_tokens + cached_tokens) (wire_family=google_codeassist; meter forced by --meter)",
        );
        expect(output).not.toContain("No metered busts");
    });

    test("a recorded anthropic_messages or openai_responses wire family overrides the directory it was found in", () => {
        for (const [source, family, provider, wrongDirFlag] of [
            ["anthropic", "anthropic_messages", "anthropic", "--openai-dir"],
            ["openai-auth", "openai_responses", "openai", "--anthropic-dir"],
        ] as const) {
            const dir = mkdtempSync(join(tmpdir(), `cache-bust-wire-family-${provider}-`));
            tempDirs.push(dir);
            const session = `ses_wireFamily${provider}`;
            for (const index of [1, 2] as const) {
                const stem = `2026-09-02T08-4${index}-00-000Z-00000${index}-${session}`;
                writeDump(
                    dir,
                    stem,
                    `2026-09-02T08:4${index}:00.000Z`,
                    session,
                    JSON.parse(readFileSync(join(bodiesRoot, source, `00${index}-request.json`), "utf8")),
                    JSON.parse(readFileSync(join(bodiesRoot, source, `00${index}-response.json`), "utf8")),
                );
                const metaPath = join(dir, `${stem}.meta.json`);
                const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
                writeFileSync(metaPath, JSON.stringify({ ...meta, wire_family: family }));
            }
            // Found under the other provider's directory, the dump is still read
            // with its own body shape and meter because meta.json names them.
            const snapshots = __test.loadSnapshots(
                __test.parseArgs([
                    "bun",
                    "analyze-cache-busts.ts",
                    "--session",
                    session,
                    wrongDirFlag,
                    dir,
                    wrongDirFlag === "--openai-dir" ? "--anthropic-dir" : "--openai-dir",
                    join(dir, "missing"),
                ]),
            );
            const row = __test.analyzeSnapshots(snapshots)[1];

            expect(row.current.provider).toBe(provider);
            expect(row.verdict).toBe("BUST");
            // Anthropic compares the read alone against the previous read + write
            // (900 + 0) - 64; OpenAI keeps its implicit-prefix floor.
            expect(row.comparableRead).toBe(100);
            expect(row.meterFloor).toBe(provider === "anthropic" ? 836 : 900);
        }
    });

    // Dumps from the OpenCode auth plugins carry no wire family. Their report must
    // stay byte-for-byte what it was before wire families existed; these goldens
    // were captured from the analyzer before the wire-family change. The Anthropic
    // meter rule and meter cell were recaptured when the meter stopped counting
    // uncached input as reuse.
    for (const [source, flag, session, golden] of [
        [
            "anthropic",
            "--anthropic-dir",
            "ses_anthropicGolden",
            `Session:  ses_anthropicGolden
Provider: anthropic (anthropic-auth)
Dumps:    2  (dir: <dir>)

Dashboard times are local (UTC+2); table times are UTC.
Meter rule (anthropic): Anthropic explicit cache: cache_read_input_tokens versus prior read + write; uncached input_tokens never count as reuse. Short when the cache read < previous read + previous write - 64, and a short read with no write and ≥1,024 uncached input tokens is a missing-breakpoint BUST; bytes distinguish BUST from LATENCY.
time(UTC)          | segs | verdict          | meter                                                  | meterVsBytes | first-divergence                | prevBodyBytes → curBodyBytes | reusableNormalizedPrefix@breakpoint
-------------------|------|------------------|--------------------------------------------------------|--------------|---------------------------------|-----------------------------|------------------------
09-02 08:41:00 UTC |    2 | BASE             |                                                        |              | (first request)                 |                             |
09-02 08:42:00 UTC |    2 | BUST (meter)     | read=100 (write=800, uncached input=100); floor=836 (prev read+write-64; prevTotal=1,000); rewritten≈800 | AGREE        | message[1] role=user parts=[text(19)] text="cached prefix after" (bytes BUST) | 417B → 416B                 | message[0] role=system parts=[text(13)] text="stable system" (77B)
          └─ divergence-class: no_mc_pass_row
          └─ segment diff @char 63:
             prev: {"role":"user","content":[{"type":"text","text":"cached prefix [before]"}]}
             cur:  {"role":"user","content":[{"type":"text","text":"cached prefix [after]"}]}

1 metered bust(s) across 2 request(s).
`,
        ],
        [
            "openai-auth",
            "--openai-dir",
            "ses_openaiGolden",
            `Session:  ses_openaiGolden
Provider: openai (openai-auth)
Dumps:    2  (dir: <dir>)

Dashboard times are local (UTC+2); table times are UTC.
Meter rule (openai): OpenAI implicit-prefix cache: prompt_tokens_details.cached_tokens; no write premium. Short when the provider-comparable read < prevTotal - ε, ε=max(64, previous direct/uncached input); bytes distinguish BUST from LATENCY.
time(UTC)          | segs | verdict          | meter                                                  | meterVsBytes | first-divergence                | prevBodyBytes → curBodyBytes | reusableNormalizedPrefix@breakpoint
-------------------|------|------------------|--------------------------------------------------------|--------------|---------------------------------|-----------------------------|------------------------
09-02 08:41:00 UTC |    2 | BASE             |                                                        |              | (first request)                 |                             |
09-02 08:42:00 UTC |    2 | BUST (meter)     | cached=100; floor=900 (prevTotal=1,000, ε=100); rewritten≈900 | AGREE        | message[1] role=user parts=[input_text(19)] text="cached prefix after" (bytes BUST) | 251B → 250B                 | (none) (0B)
          └─ divergence-class: no_mc_pass_row
          └─ segment diff @char 69:
             prev: {"role":"user","content":[{"type":"input_text","text":"cached prefix [before]"}]}
             cur:  {"role":"user","content":[{"type":"input_text","text":"cached prefix [after]"}]}

1 metered bust(s) across 2 request(s).
`,
        ],
    ] as const) {
        test(`${source} dumps without a wire family keep the pre-wire-family report byte for byte`, () => {
            const dir = mkdtempSync(join(tmpdir(), `cache-bust-golden-${source}-`));
            tempDirs.push(dir);
            for (const index of [1, 2] as const) {
                // Raw copies keep the fixture's exact body bytes, which the report prints.
                const stem = `2026-09-02T08-4${index}-00-000Z-00000${index}-${session}`;
                writeFileSync(
                    join(dir, `${stem}.body.json`),
                    readFileSync(join(bodiesRoot, source, `00${index}-request.json`)),
                );
                writeFileSync(
                    join(dir, `${stem}.response.json`),
                    readFileSync(join(bodiesRoot, source, `00${index}-response.json`)),
                );
                writeFileSync(
                    join(dir, `${stem}.meta.json`),
                    JSON.stringify({ createdAt: `2026-09-02T08:4${index}:00.000Z` }),
                );
            }
            const other = flag === "--anthropic-dir" ? "--openai-dir" : "--anthropic-dir";
            const run = runAnalyzer([
                "--session",
                session,
                flag,
                dir,
                other,
                join(dir, "missing"),
                "--all-rows",
                "--show-diff",
            ]);

            expect(run.exitCode).toBe(0);
            expect(run.stdout.toString().replaceAll(dir, "<dir>")).toBe(golden);
        });
    }
});
