import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../src/shared/test-temp-dir";
import { classifyRunnerStep } from "./cache-bust-runner-classification";
import { analyzeRunnerFeed, printRunnerFeedAnalysis } from "./cache-bust-runner-analyzer";
import type { RunnerFeedRow, RunnerMeterSource } from "./cache-bust-runner-feed";
import { parseRunnerDecision } from "./cache-bust-runner-log";
import {
    emptyRunnerState,
    loadRunnerHeads,
    parseRunnerMonitorState,
    pruneRunnerState,
    scanRunnerFeed,
    type RunnerAlert,
    type RunnerHeads,
} from "./cache-bust-runner-monitor";
import {
    agentDeliverRequest,
    loadSentinelState,
    runSentinelOnce,
    type CacheBustSentinelOptions,
} from "./cache-bust-sentinel";
import { __test as analyzer } from "./analyze-cache-busts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-11-11T04:10:00Z");
const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory(): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), "runner-sentinel-"));
    dirs.push(dir);
    return dir;
}
function line(at: number, body: string, session = "head"): string {
    return `${new Date(at).toISOString()} INFO ck-mc: session ${session}: ${body}`;
}
const setup =
    "setup (opencode, preset head, model anthropic/claude, window 1000000, reserve 32000, applied view Some(18))";
const event = (at: number, body: string) => parseRunnerDecision(line(at, body), "head")!;
function row(session = "head", at = NOW - 1000, read = 0, write = 100_000): RunnerFeedRow {
    return {
        cursor: `c${at}`,
        harness: "opencode",
        source: "runner",
        step_ref: `${session}/${at}`,
        session,
        occurred_at_ms: at,
        provider: "anthropic",
        model: "claude-opus",
        cache_read: read,
        cache_write: write,
        input: 1,
        output: 1,
        prompt: read + write + 1,
        verdict: "stable",
    };
}
function facts(sessions = ["head"]): RunnerHeads {
    return new Map(sessions.map((session) => [session, { harness: "opencode", decisions: [] }]));
}
function source(rows: RunnerFeedRow[] = []): RunnerMeterSource {
    let first = true;
    return {
        id: "astrocyte",
        read: async () => {
            const page = { rows: first ? rows : [], next: null, through: "end" };
            first = false;
            return page;
        },
    };
}
function scan(rows: RunnerFeedRow[], heads = facts(), now = NOW) {
    const state = emptyRunnerState();
    const alerts: RunnerAlert[] = [];
    const args = {
        state,
        source: source(rows),
        heads,
        root: "fixture-root",
        now,
        clock: () => now,
        deadline: now + 30_000,
        wakeAge: 30 * MINUTE,
        emit: async (alert: RunnerAlert) => {
            alerts.push(alert);
        },
    };
    return { state, alerts, args, run: () => scanRunnerFeed(args) };
}

function doubleRebuildFixture(gap = 3379) {
    const first = Date.parse("2026-11-11T17:29:24.444Z");
    const second = first + gap;
    const heads = facts();
    heads.get("head")!.harness = "broca";
    heads.get("head")!.decisions = [
        event(first - MINUTE - 1, "view 4 accepted (400 edits, no cut)"),
        event(first - 1, "view 5 accepted (579 edits, cut through msg_500)"),
        event(second - 1, "view 6 accepted (675 edits, cut through msg_600)"),
    ];
    const rows = [
        row("head", first - MINUTE, 654_946, 0),
        { ...row("head", first, 63_631, 293_685), prompt: 654_946 },
        { ...row("head", second, 63_631, 198_750), prompt: 357_316 },
    ].map((item) => ({ ...item, harness: "broca", model: "claude-opus-5-5" }));
    return { first, second, heads, rows, now: second + 1000 };
}

test("double rebuild pair wakes once for the two reported view rewrites", async () => {
    const fixture = doubleRebuildFixture();
    const s = scan(fixture.rows, fixture.heads, fixture.now);
    await s.run();
    await s.run();
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatchObject({ class: "double_rebuild", urgency: "high", rewrittenTokens: 492_435 });
    expect(s.alerts[0]!.detail).toBe(
        "session=head; harness=broca; runner=broca; model=claude-opus-5-5; class=double_rebuild; session took 2 view rewrites in a row: 2026-11-11T17:29:24.444Z view 5 wrote 293685 tokens; 2026-11-11T17:29:27.823Z view 6 wrote 198750 tokens; idle before first rewrite=60 seconds",
    );
    await s.run();
    expect(s.alerts).toHaveLength(1);
    expect(Object.values(s.state.rebuilds)[0]!.rewrites.map((rewrite) => rewrite.viewVersion)).toEqual([5, 6]);
});

test("double rebuild window is inclusive at 120 seconds, not ten minutes", async () => {
    for (const [gap, expected] of [[120_000, 1], [120_001, 0], [10 * MINUTE, 0]]) {
        const fixture = doubleRebuildFixture(gap);
        const s = scan(fixture.rows, fixture.heads, fixture.now);
        await s.run();
        await s.run();
        expect(s.alerts).toHaveLength(expected!);
    }
});

test("two rows attributed to the same accepted view are not a double rebuild and unexplained stays unexplained", async () => {
    const fixture = doubleRebuildFixture();
    fixture.heads.get("head")!.decisions.pop();
    const s = scan(fixture.rows, fixture.heads, fixture.now);
    await s.run();
    await s.run();
    expect(s.alerts.map((alert) => alert.class)).toEqual(["unexplained"]);
    expect(s.state.rebuilds).toEqual({});
    const analyzed = await analyzeRunnerFeed(source(fixture.rows), fixture.heads, "head");
    expect(analyzed.map((item) => item.classification?.class)).toEqual([undefined, "view", "unexplained"]);
});

test("double rebuild wakes without a token threshold and never joins different sessions or harnesses", async () => {
    const fixture = doubleRebuildFixture();
    const small = fixture.rows.map((item, index) => ({
        ...item, cache_read: [1000, 500, 0][index], cache_write: 0, prompt: 1000,
    }));
    const s = scan(small, fixture.heads, fixture.now);
    await s.run();
    await s.run();
    expect(s.alerts.map((alert) => [alert.class, alert.rewrittenTokens])).toEqual([["double_rebuild", 0]]);
    for (const other of [{ session: "other" }, { harness: "thalamus" }]) {
        const rows = fixture.rows.map((item) => ({ ...item }));
        rows[2] = { ...rows[2]!, ...other };
        fixture.heads.set("other", fixture.heads.get("head")!);
        const isolated = scan(rows, fixture.heads, fixture.now);
        await isolated.run();
        await isolated.run();
        expect(isolated.alerts).toHaveLength(0);
    }
});

test("three accepted views in one scan make one finding listing every rewrite", async () => {
    const fixture = doubleRebuildFixture();
    const third = fixture.second + 1000;
    fixture.heads.get("head")!.decisions.push(event(third - 1, "view 7 accepted (700 edits, no cut)"));
    const rows = [...fixture.rows, { ...fixture.rows[2]!, ...row("head", third, 0, 50_000), harness: "broca", model: "claude-opus-5-5" }];
    const s = scan(rows, fixture.heads, third + 1000);
    await s.run();
    await s.run();
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]!.detail).toContain("session took 3 view rewrites in a row");
    expect(s.alerts[0]!.detail).toContain("view 7 wrote 50000 tokens");
    expect(Object.values(s.state.rebuilds)[0]!.rewrites).toHaveLength(3);
    const analyzed = await analyzeRunnerFeed(source(rows), fixture.heads, "head");
    expect(analyzed.slice(1).map((item) => item.classification?.class)).toEqual([
        "double_rebuild", "double_rebuild", "double_rebuild",
    ]);
    const output: string[] = [];
    printRunnerFeedAnalysis(analyzed, (line) => output.push(line));
    expect(output.filter((line) => line.includes(" | double_rebuild | "))).toHaveLength(3);
});

test("a later scan extends the saved finding without another wake, including after restart", async () => {
    const fixture = doubleRebuildFixture();
    const s = scan(fixture.rows, fixture.heads, fixture.now);
    await s.run();
    await s.run();
    const third = fixture.second + MINUTE;
    fixture.heads.get("head")!.decisions.push(event(third - 1, "view 7 accepted (700 edits, no cut)"));
    const logs: string[] = [];
    const state = parseRunnerMonitorState(JSON.parse(JSON.stringify(s.state)));
    const args = { ...s.args, state, now: third + 1000, deadline: third + 31_000, clock: () => third + 1000,
        source: source([{ ...row("head", third, 0, 50_000), harness: "broca", model: "claude-opus-5-5" }]),
        log: (line: string) => logs.push(line) };
    await scanRunnerFeed(args);
    await scanRunnerFeed(args);
    expect(s.alerts).toHaveLength(1);
    expect(Object.values(state.rebuilds)[0]!.rewrites.map((rewrite) => rewrite.viewVersion)).toEqual([5, 6, 7]);
    expect(logs.map((line) => JSON.parse(line).kind)).toEqual(["runner_double_rebuild_extended"]);
    await scanRunnerFeed(args);
    expect(logs).toHaveLength(1);
    pruneRunnerState(state, third + 31 * HOUR);
    expect(state.rebuilds).toEqual({});
    expect(state.sent).toEqual({});
});

test("analyzer feed sees the pair even when the first rewrite is outside --since", async () => {
    const fixture = doubleRebuildFixture();
    const analyzed = await analyzeRunnerFeed(source(fixture.rows), fixture.heads, "head", { since: fixture.first });
    expect(analyzed).toHaveLength(1);
    expect(analyzed[0]!.classification).toMatchObject({ class: "double_rebuild", viewVersion: 6 });
});

test("each runner class uses exact causes and start-to-start windows", () => {
    const at = Date.parse("2026-11-11T04:02:16Z");
    const previous = { at: at - 20_000, model: "claude", read: 250_000, write: 100_000 };
    const current = { at, model: "claude", read: 47_682, write: 305_629 };
    const baseline = event(previous.at - 1, "view 18 accepted (4 edits, no cut)");
    const credited = () => ({ viewAttribution: { views: [{ at: baseline.at, version: 18,
        line: baseline.line!, credited: true }], steps: [] } });
    const floor = event(
        at - 1,
        "signed floor moved to msg_42 (message 41); the runner strips signed reasoning at or before it",
    );
    expect(classifyRunnerStep(previous, current, [baseline, floor], credited()).class).toBe("plan_changed");
    expect(
        classifyRunnerStep(previous, current, [
            baseline,
            event(at - 1, "view 18 accepted (4 edits, no cut)"),
        ], credited()).class,
    ).toBe("unexplained");
    expect(
        classifyRunnerStep(previous, { ...current, read: 64_239, write: 203_464 }, [
            event(previous.at - 1, "view 6 accepted (1 edits, no cut)"),
            event(at - 1, "view 7 accepted (2 edits, cut through msg_8)"),
        ]).class,
    ).toBe("view");
    expect(classifyRunnerStep(previous, { ...current, model: "other" }, [floor]).class).toBe(
        "scope_changed",
    );
    for (const cause of ["ChainReset", "CacheExpired", "TierChange", "AccountChange"]) {
        expect(
            classifyRunnerStep(previous, current, [
                event(
                    at - 1,
                    `ride [${cause}], request Some(353311) tokens, last prompt Some(350000), applied view Some(18)`,
                ),
            ]).class,
        ).toBe("provider_forgot");
    }
    expect(
        classifyRunnerStep(previous, current, [event(at - 1, "ride [UnknownCause], request None")])
            .class,
    ).toBe("unexplained");
    expect(
        classifyRunnerStep(previous, { ...current, at: previous.at + 60 * MINUTE }, []).class,
    ).toBe("unexplained");
    expect(
        classifyRunnerStep(previous, { ...current, at: previous.at + 60 * MINUTE + 1 }, []).class,
    ).toBe("expired");
    const restart = classifyRunnerStep(previous, { ...current, read: 0 }, [event(at - 1, setup)]);
    expect(restart).toMatchObject({ class: "unexplained", afterRestart: true });
    expect(restart.evidence).toContain("after a runner restart");
    expect(classifyRunnerStep(previous, { ...current, read: 349_936 }, [])).toMatchObject({
        healthy: true,
        rewrittenTokens: 0,
    });
});

test("60-minute live expiry is explained without a margin, but a 59-minute gap is not", async () => {
    const previousAt = Date.parse("2026-11-11T11:04:52.782Z");
    const currentAt = Date.parse("2026-11-11T12:05:14.335Z");
    const previous = { at: previousAt, model: "claude", read: 500_000, write: 0 };
    const current = { at: currentAt, model: "claude", read: 47_682, write: 445_598 };
    expect(classifyRunnerStep(previous, current, []).class).toBe("expired");
    expect(
        classifyRunnerStep(previous, { ...current, at: previousAt + 59 * MINUTE }, []).class,
    ).toBe("unexplained");
    const s = scan(
        [row("head", previousAt, 500_000, 0), row("head", currentAt, 47_682, 445_598)],
        facts(),
        currentAt + 1000,
    );
    await s.run();
    await s.run();
    expect(s.alerts).toHaveLength(0);
    const analyzed = await analyzeRunnerFeed(
        source([row("head", previousAt, 500_000, 0), row("head", currentAt, 47_682, 445_598)]),
        facts(),
        "head",
    );
    const output: string[] = [];
    printRunnerFeedAnalysis(analyzed, (line) => output.push(line));
    expect(output.join("\n")).toContain(
        "expired | idle=60.4; previous_step=2026-11-11T11:04:52.782Z",
    );
});

test("04:02 signed floor rewrite is plan_changed, not VIEW, in the store analyzer", () => {
    const at = Date.parse("2026-11-11T04:02:16Z");
    const requests = [
        {
            id: "before",
            at: at - 20_000,
            sequence: 0,
            model: "claude",
            provider: "anthropic",
            usage: { input: 1, output: 1, cacheRead: 300_000, cacheWrite: 53_311 },
        },
        {
            id: "rewrite",
            at,
            sequence: 1,
            model: "claude",
            provider: "anthropic",
            usage: { input: 1, output: 1, cacheRead: 47_682, cacheWrite: 305_629 },
        },
    ];
    const evidence = {
        decisions: [
            event(at - 31 * HOUR, "view 18 accepted (2 edits, no cut)"),
            event(at - 1, "signed floor moved to msg_42"),
        ],
        renders: [],
        files: [],
    };
    const rows = analyzer.analyzeSnapshots(
        analyzer.runnerSnapshots({ kind: "oc2", session: "head", files: [], requests }, []),
        [],
        { runnerEvidence: evidence },
    );
    expect(rows[1]!.verdict).toBe("PLAN_CHANGED");
    expect(rows[1]!.runnerClassification!.class).toBe("plan_changed");
});

test("head log discovery excludes workers, summarizers and old setups, including colon ids", () => {
    const root = directory();
    const dir = join(root, "magic-context/logs");
    mkdirSync(dir, { recursive: true });
    const colon = "alfonso:head:agent_123";
    writeFileSync(
        join(dir, "magic-context.2026-11-11.log"),
        [
            line(NOW - 1, setup),
            line(NOW - 1, setup, colon),
            line(NOW - 1, setup.replace("preset head", "preset worker"), "worker"),
            line(NOW - 1, setup.replace("preset head", "preset reader"), "summary-child"),
            line(NOW - 8 * 24 * HOUR, setup, "old"),
        ].join("\n"),
    );
    expect([...loadRunnerHeads(root, NOW).keys()].sort()).toEqual([colon, "head"]);
});

test("active heads without any feed row are visible, inactive heads and empty metered replies are not gaps", async () => {
    const root = directory();
    const path = join(root, "fixture.log");
    writeFileSync(
        path,
        [
            line(NOW - 2 * 24 * HOUR, setup, "silent"),
            line(NOW - 2 * 24 * HOUR, setup.replace("opencode", "claude-code"), "unmapped-claude"),
            line(NOW - MINUTE, "view 18 accepted (4 edits, no cut)", "unmapped-claude"),
            line(NOW - MINUTE, setup, "has-empty-row"),
        ].join("\n"),
    );
    const s = scan([{ ...row("has-empty-row"), prompt: 0 }], loadRunnerHeads(root, NOW, path));
    expect((await s.run()).heads_without_meter).toEqual([
        { harness: "claude-code", session: "unmapped-claude" },
    ]);
});

test("pending revisions win next run, zero reads wake once, missing counts never become baselines", async () => {
    const s = scan([row("head", NOW - 21_000, 100_000, 0), row(), { ...row("worker"), prompt: 0 }]);
    await s.run();
    expect(s.alerts).toHaveLength(0);
    expect(Object.values(s.state.heads)[0]!.last).toBeUndefined();
    s.args.source = source([{ ...row(), verdict: "warning" }]);
    expect((await s.run()).judged).toBe(1);
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatchObject({
        class: "unexplained",
        urgency: "high",
        rewrittenTokens: 100_000,
    });
    expect(s.alerts[0]!.analyzer).toContain("--source astrocyte");
    expect(Object.values(s.state.heads)[0]!.summary[0]!.feedVerdict).toBe("warning");
    await s.run();
    expect(s.alerts).toHaveLength(1);
    expect(parseRunnerMonitorState(JSON.parse(JSON.stringify(s.state)))).toEqual(s.state);
    const invalid = scan([
        row("head", NOW - 30_000, 100_000, 0),
        { ...row("head", NOW - 20_000), prompt: 0 },
        { ...row("head", NOW - 10_000), cache_read: undefined },
        row(),
    ]);
    await invalid.run();
    expect((await invalid.run()).skipped).toBe(2);
    expect(invalid.alerts[0]!.rewrittenTokens).toBe(100_000);
});

test("healthy revision suppresses false wake; other providers are not_metered", async () => {
    const s = scan([row("head", NOW - 21_000, 100_000, 0), row()]);
    await s.run();
    s.args.source = source([
        { ...row(), cache_read: 100_000, cache_write: 0 },
        { ...row("other"), provider: "openai", cache_write: undefined },
    ]);
    s.args.heads = facts(["head", "other"]);
    await s.run();
    expect(s.alerts).toHaveLength(0);
    expect((await s.run()).not_metered).toBe(1);
});

test("late revisions are counted without changing an already judged step", async () => {
    const s = scan([row("head", NOW - MINUTE, 100_000, 0), row()]);
    await s.run();
    await s.run();
    s.args.source = source([{ ...row(), cursor: "newer", cache_read: 100_000, cache_write: 0 }]);
    expect(await s.run()).toMatchObject({ late_revisions: 1, late_token_revisions: 1, judged: 0 });
    expect(s.alerts).toHaveLength(1);
    expect(Object.values(s.state.heads)[0]!.last!.read).toBe(0);
});

test("individual explained reads and subthreshold rewrites never wake", async () => {
    const cases = [
        { steps: [row("head", NOW - 66 * MINUTE, 100_000, 0), row()], decisions: [] },
        {
            steps: [row("head", NOW - MINUTE, 100_000, 0), { ...row(), model: "other-model" }],
            decisions: [],
        },
        { steps: [row("head", NOW - MINUTE, 19_999, 0), row()], decisions: [] },
        {
            steps: [row("head", NOW - 30 * MINUTE, 100_000, 0), row()],
            decisions: [
                event(
                    NOW - 1001,
                    "ride [CacheExpired], request Some(100000) tokens, last prompt Some(100000), applied view Some(18)",
                ),
            ],
        },
        {
            steps: [
                row("head", NOW - MINUTE, 267_703, 0),
                row("head", NOW - 1000, 64_239, 203_464),
            ],
            decisions: [
                event(NOW - 2 * MINUTE, "view 6 accepted (2 edits, no cut)"),
                event(NOW - 1001, "view 7 accepted (4 edits, no cut)"),
            ],
        },
    ];
    for (const { steps, decisions } of cases) {
        const heads = facts();
        heads.get("head")!.decisions = decisions;
        const s = scan(steps, heads);
        await s.run();
        await s.run();
        expect(s.alerts).toHaveLength(0);
    }
    const previous = { at: 1794373221424 - 272 * MINUTE, model: "claude", read: 635_014, write: 0 };
    expect(
        classifyRunnerStep(
            previous,
            { at: 1794373221424, model: "claude", read: 47_682, write: 587_332 },
            [],
        ).class,
    ).toBe("expired");
});

test("plan changes require three different heads within ten minutes and wake once", async () => {
    for (const count of [2, 3]) {
        const sessions = Array.from({ length: count }, (_, i) => `head-${i}`);
        const heads = facts(sessions);
        for (const fact of heads.values())
            fact.decisions = [event(NOW - 1001, "signed floor moved to msg_42")];
        const s = scan(
            sessions.flatMap((id) => [row(id, NOW - MINUTE, 100_000, 0), row(id)]),
            heads,
        );
        await s.run();
        await s.run();
        await s.run();
        expect(s.alerts).toHaveLength(count === 3 ? 1 : 0);
        if (count === 3)
            expect(s.alerts[0]).toMatchObject({ urgency: "normal", class: "plan_changed" });
    }
});

test("unexplained wakes show idle time and the other recently affected heads", async () => {
    const ids = ["head-0", "head-1", "head-2"];
    const s = scan(
        ids.flatMap((id, index) => {
            const at = NOW - (4 - index) * MINUTE;
            return [row(id, at - 59 * MINUTE, 100_000, 0), row(id, at)];
        }),
        facts(ids),
    );
    await s.run();
    await s.run();
    expect(s.alerts).toHaveLength(3);
    expect(s.alerts[0]!.detail).toContain("also_unexplained_last_10m=0");
    expect(s.alerts[1]!.detail).toContain("also_unexplained_last_10m=1: opencode/head-0");
    expect(s.alerts[2]!.detail).toContain(
        "also_unexplained_last_10m=2: opencode/head-0, opencode/head-1",
    );
    expect(s.alerts[2]!.detail).toContain("idle=59.0; previous_step=2026-11-11T03:09:00.000Z");
    const legacy = JSON.parse(JSON.stringify(s.state));
    delete legacy.unexplained;
    for (const head of Object.values(legacy.heads) as {
        summary: { previousStepAt?: number; idleGapMs?: number }[];
    }[]) {
        for (const observation of head.summary) {
            delete observation.previousStepAt;
            delete observation.idleGapMs;
        }
    }
    expect(parseRunnerMonitorState(legacy).unexplained).toEqual([]);
    pruneRunnerState(s.state, NOW + 11 * MINUTE);
    expect(s.state.unexplained).toEqual([]);
});

test("rate break uses prior day buckets, emits one episode and ignores quiet windows", async () => {
    for (const count of [5, 9]) {
        const ids = Array.from({ length: 10 + count }, (_, i) => `head-${i}`);
        const history = ids.flatMap((id, i) => {
            const at = i < 10 ? NOW - 10 * HOUR + i * MINUTE : NOW - 20 * MINUTE + i * 1000;
            return [
                row(id, at - 70 * MINUTE, 100_000, 0),
                row(id, at, i < 9 ? 100_000 : 0, i < 9 ? 0 : 100_000),
            ];
        });
        const s = scan(history, facts(ids));
        await s.run();
        await s.run();
        await s.run();
        expect(s.alerts.filter((alert) => alert.class === "rate_break")).toHaveLength(
            count === 9 ? 1 : 0,
        );
        expect(s.alerts.filter((alert) => alert.class === "unexplained")).toHaveLength(0);
        if (count === 9) expect(s.alerts[0]!.detail).toContain("previous 24h warm=9/10");
        s.args.now += 31 * HOUR;
        pruneRunnerState(s.state, s.args.now);
        expect(Object.keys(s.state.rates)).toHaveLength(0);
    }
});

test("historical rate break stays unreported until the next fresh sample wakes once", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `head-${i}`);
    const history = ids.slice(0, 19).flatMap((id, i) => {
        const at = i < 10 ? NOW - 10 * HOUR + i * MINUTE : NOW - HOUR + i * 1000;
        return [
            row(id, at - 70 * MINUTE, 100_000, 0),
            row(id, at, i < 9 ? 100_000 : 0, i < 9 ? 0 : 100_000),
        ];
    });
    const s = scan(history, facts(ids));
    await s.run();
    await s.run();
    expect(s.alerts).toHaveLength(0);
    expect(Object.values(s.state.rates).every((rate) => rate.episode === undefined)).toBe(true);
    s.args.source = source([row("head-19", NOW - 70 * MINUTE, 100_000, 0), row("head-19")]);
    await s.run();
    await s.run();
    await s.run();
    expect(s.alerts.filter((alert) => alert.class === "rate_break")).toHaveLength(1);
    expect(Object.values(s.state.rates)[0]!.episode).toBe(NOW - 1000);
});

test("cursor expiry restarts from retained feed, records a gap, and old rows build state without waking", async () => {
    const s = scan([]);
    s.state.cursor = "too-old";
    const calls: (string | undefined)[] = [];
    s.args.source = {
        id: "astrocyte",
        read: async (after) => {
            calls.push(after);
            if (after === "too-old") throw { code: "cursor_expired" };
            return {
                rows: after
                    ? []
                    : [row("head", NOW - 2 * HOUR, 100_000, 0), row("head", NOW - HOUR)],
                next: null,
                through: "fresh",
            };
        },
    };
    await s.run();
    await s.run();
    expect(calls.slice(0, 2)).toEqual(["too-old", undefined]);
    expect(s.state.gaps).toBe(1);
    expect(s.alerts).toHaveLength(0);
    expect(Object.values(s.state.heads)[0]!.last!.at).toBe(NOW - HOUR);
});

test("analyzer feed uses the shared classifier, deduplicates revisions and prints evidence", async () => {
    const heads = facts();
    heads.get("head")!.decisions = [event(NOW - 1001, "signed floor moved to msg_42")];
    const rows = await analyzeRunnerFeed(
        source([
            row("head", NOW - MINUTE, 100_000, 0),
            row(),
            { ...row(), cache_read: 47_682, cache_write: 305_629 },
        ]),
        heads,
        "head",
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]!.classification!.class).toBe("plan_changed");
    const output: string[] = [];
    printRunnerFeedAnalysis(rows, (line) => output.push(line));
    expect(output.join("\n")).toContain("47682 | 305629 | 100000 | plan_changed");
    expect(output.join("\n")).toContain(
        "plan_changed | idle=1.0; previous_step=2026-11-11T04:09:00.000Z",
    );
    expect(output.join("\n")).toContain("signed floor moved to msg_42");
});

test("identical feed and store facts produce identical attribution with extra facts withheld", async () => {
    const feedRows = [row("head", NOW - MINUTE, 100_000, 0), row()];
    const heads = facts();
    heads.get("head")!.decisions = [
        event(
            NOW - 1001,
            "signed floor moved to msg_42 (message 41); the runner strips signed reasoning at or before it",
        ),
    ];
    const feed = await analyzeRunnerFeed(source(feedRows), heads, "head");
    const requests = feedRows.map((row, sequence) => ({
        id: row.step_ref,
        at: row.occurred_at_ms,
        sequence,
        model: row.model!,
        provider: row.provider!,
        usage: {
            input: row.input!,
            output: row.output!,
            cacheRead: row.cache_read!,
            cacheWrite: row.cache_write!,
        },
    }));
    const store = analyzer.analyzeSnapshots(
        analyzer.runnerSnapshots({ kind: "pi", session: "head", files: [], requests }, []),
        [],
        { runnerEvidence: { decisions: heads.get("head")!.decisions, renders: [], files: [] } },
    );
    expect(feed[1]!.classification).toEqual(store[1]!.runnerClassification);
    const sentinel = scan(feedRows, heads);
    await sentinel.run();
    await sentinel.run();
    expect(Object.values(sentinel.state.heads)[0]!.summary[0]!.class).toEqual(
        feed[1]!.classification!.class,
    );
});

test("bounded pagination resumes before judging and replacements across pages win", async () => {
    const s = scan([]);
    let calls = 0;
    let time = NOW;
    s.args.clock = () => time;
    s.args.source = {
        id: "astrocyte",
        read: async (after) => {
            calls++;
            if (after === undefined) {
                time = NOW + 30_000;
                return {
                    rows: [row("head", NOW - MINUTE, 100_000, 0), row()],
                    next: "page2",
                    through: "tail",
                };
            }
            if (after === "page2")
                return {
                    rows: [{ ...row(), cache_read: 100_000, cache_write: 0 }],
                    next: null,
                    through: "tail",
                };
            return { rows: [], next: null, through: "tail" };
        },
    };
    expect((await s.run()).bounded).toBe(true);
    expect(s.state.cursor).toBe("page2");
    expect(s.alerts).toHaveLength(0);
    time = NOW;
    await s.run();
    expect(s.state.cursor).toBe("tail");
    expect(s.alerts).toHaveLength(0);
    expect(calls).toBe(2);
});

function sentinelOptions(root: string): CacheBustSentinelOptions {
    return {
        once: true,
        send: false,
        intervalMs: MINUTE,
        lookbackMs: 5 * MINUTE,
        maxRunMs: 30_000,
        stateFile: join(root, "state.json"),
        databasePath: join(root, "missing.db"),
        rustStorePath: join(root, "missing-rust.db"),
        connectionFile: join(root, "missing-connection.json"),
        runnerDataDir: root,
        wakeModuleId: "prefrontal-core",
        wakeAgentId: "test-agent",
        wakeFromAgent: "test-sentinel",
    };
}

test("shared budget runs legacy first, reserves a third for the feed, and does not overrun a slow source", async () => {
    const options = sentinelOptions(directory());
    let now = NOW;
    const order: string[] = [];
    await runSentinelOnce(options, {
        now: () => now,
        stdout: () => {},
        stderr: () => {},
        runnerHeads: facts(),
        listActiveSessions: () => [
            { sessionId: "legacy", harness: "opencode", projectPath: "fixture", activityMs: NOW },
        ],
        loadDecisions: () => [],
        analyzeSession: async (_session, _since, _decisions, options) => {
            order.push("legacy");
            expect(options.scanDeadlineMs).toBe(NOW + 20_000);
            now += 20_000;
            return { requests: [], highWaterMarkMs: null };
        },
        runnerSource: {
            id: "astrocyte",
            read: async (_after, timeout) => {
                order.push("runner");
                expect(timeout).toBe(2000);
                now += 10_000;
                return { rows: [], next: "more", through: "now" };
            },
        },
    });
    expect(order).toEqual(["legacy", "runner"]);
    expect(now).toBe(NOW + 30_000);
});

test("five feed failures give one quiet blind notice, recovery gives one more and legacy continues", async () => {
    const options = sentinelOptions(directory());
    const output: string[] = [];
    let legacy = 0;
    const deps = {
        now: () => NOW,
        stdout: (line: string) => output.push(line),
        stderr: () => {},
        runnerHeads: facts(),
        listActiveSessions: () => {
            legacy++;
            return [];
        },
        runnerSource: {
            id: "astrocyte",
            read: async () => {
                throw new Error("module missing");
            },
        } as RunnerMeterSource,
    };
    for (let i = 0; i < 6; i++) await runSentinelOnce(options, deps);
    expect(output.filter((line) => line.includes("is blind"))).toHaveLength(1);
    expect(legacy).toBe(6);
    deps.runnerSource = source();
    await runSentinelOnce(options, deps);
    await runSentinelOnce(options, deps);
    expect(output.filter((line) => line.includes("recovered"))).toHaveLength(1);
    expect(loadSentinelState(options.stateFile).runner!.failures).toBe(0);
    expect(
        agentDeliverRequest(
            {
                source_module: "magic-context",
                kind: "cache_bust",
                vendor_event_id: "test",
                session_id: "head",
                directory: "fixture",
                occurred_at_ms: NOW,
                urgency: "normal",
                payload: {
                    session: "head",
                    at: "now",
                    rewritten_tokens: 0,
                    divergence_class: "plan_changed",
                    first_divergence: "heads",
                    analyzer_cmd: "cmd",
                },
            },
            "agent",
            "sentinel",
        ).urgency,
    ).toBe("normal");
});

test("a wake delivery failure is not counted as a blind feed", async () => {
    const options = { ...sentinelOptions(directory()), send: true };
    const deps = {
        now: () => NOW,
        stdout: () => {},
        stderr: () => {},
        runnerHeads: facts(),
        listActiveSessions: () => [],
        runnerSource: source([row("head", NOW - MINUTE, 100_000, 0), row()]),
        transport: {
            record: async () => {
                throw new Error("delivery wire failure");
            },
        },
    };
    await runSentinelOnce(options, deps);
    await expect(runSentinelOnce(options, deps)).rejects.toThrow("delivery wire failure");
    expect(loadSentinelState(options.stateFile).runner!.failures).toBe(0);
});
