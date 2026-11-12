import { expect, test } from "bun:test";
import { analyzeRunnerFeed } from "./cache-bust-runner-analyzer";
import type { RunnerFeedRow, RunnerMeterSource } from "./cache-bust-runner-feed";
import { parseRunnerDecision } from "./cache-bust-runner-log";
import {
    emptyRunnerState,
    parseRunnerMonitorState,
    pruneRunnerState,
    scanRunnerFeed,
    type RunnerAlert,
    type RunnerHeads,
} from "./cache-bust-runner-monitor";

const MINUTE = 60_000;
const at = (time: string) => Date.parse(`2026-11-11T${time}Z`);
const session = "019de471-4fdc-762d-9286-624dfad0b5fe";
const acceptedAt = at("19:06:21.803");
const rewriteAt = at("19:06:47.106");
const log = (when: number, body: string) =>
    `${new Date(when).toISOString()} INFO  magic-context: ck-mc: session ${session}: ${body}`;
const accepted = (when = acceptedAt, version = 38) =>
    log(when, `view ${version} accepted (3325 edits, cut through 01dff6e5)`);
const staleReading = log(at("19:06:35.470"),
    "ignoring a prompt of 686824 tokens: reading from view 37, newest applied 38; waiting for a reading under the current view");

function heads(lines = [accepted(), staleReading]): RunnerHeads {
    return new Map([[session, {
        harness: "pi",
        decisions: lines.map((line) => {
            const decision = parseRunnerDecision(line, session);
            expect(decision).not.toBeNull();
            return decision!;
        }),
    }]]);
}
function row(when: number, read: number, write: number): RunnerFeedRow {
    return {
        cursor: `c${when}`, harness: "pi", source: "runner", step_ref: `${session}/${when}`,
        session, occurred_at_ms: when, provider: "anthropic", model: "claude-opus-5-5",
        cache_read: read, cache_write: write, input: 2, output: 1,
        prompt: read + write + 2, verdict: "stable",
    };
}
const rows = () => [
    row(at("19:06:20.744"), 686_474, 0),
    row(at("19:06:34.449"), 686_474, 348),
    row(rewriteAt, 62_208, 381_260),
];
function source(rows: RunnerFeedRow[]): RunnerMeterSource {
    let unread = true;
    return { id: "astrocyte", read: async () => {
        const page = { rows: unread ? rows : [], next: null, through: "end" };
        unread = false;
        return page;
    } };
}
function scan(feed = rows(), facts = heads([accepted()]), now = rewriteAt + 1000) {
    const alerts: RunnerAlert[] = [];
    const args = {
        state: emptyRunnerState(), source: source(feed), heads: facts,
        root: "fixture-root", now, clock: () => now, deadline: now + 30_000,
        wakeAge: 30 * MINUTE, emit: async (alert: RunnerAlert) => { alerts.push(alert); },
    };
    return { args, alerts, run: async () => { await scanRunnerFeed(args); await scanRunnerFeed(args); } };
}

test("delayed runner view rewrite after an in-flight healthy step is view without a wake", async () => {
    // The stale reading is optional supporting evidence, not a prerequisite.
    const s = scan();
    await s.run();
    const observations = Object.values(s.args.state.heads)[0]!.summary;
    expect(observations.map((step) => step.class ?? "healthy")).toEqual(["healthy", "view"]);
    expect(observations[1]).toMatchObject({ viewVersion: 38, viewAcceptedAt: acceptedAt, previousTotal: 686_822 });
    expect(observations[1]!.evidence).toContain("2026-11-11T19:06:21.803Z");
    expect(observations[1]!.evidence).toContain("1 metered step");
    expect(s.alerts).toEqual([]);
    const analyzed = await analyzeRunnerFeed(source(rows()), heads([accepted()]), session);
    expect(analyzed[2]!.classification?.class).toBe("view");
});

test("delayed view evidence quotes the stale reading and counts multiple intervening steps", async () => {
    const feed = rows();
    feed.splice(2, 0, row(at("19:06:40.000"), 686_822, 0));
    const s = scan(feed, heads());
    await s.run();
    const rewrite = Object.values(s.args.state.heads)[0]!.summary.at(-1)!;
    expect(rewrite.class).toBe("view");
    expect(rewrite.evidence).toContain("2 metered step(s)");
    expect(rewrite.evidence).toContain(staleReading);
    expect(s.alerts).toEqual([]);
});

test("an idle head applies a view 40 minutes after acceptance without a wake", async () => {
    const delayedAt = acceptedAt + 40 * MINUTE;
    const feed = [row(acceptedAt - 1, 686_474, 0), row(delayedAt, 62_208, 381_260)];
    const s = scan(feed, heads([accepted()]), delayedAt + 1000);
    await s.run();
    const rewrite = Object.values(s.args.state.heads)[0]!.summary.at(-1)!;
    expect(rewrite).toMatchObject({ class: "view", viewVersion: 38, viewAcceptedAt: acceptedAt });
    expect(rewrite.evidence).toContain("0 metered step(s)");
    expect(s.alerts).toEqual([]);
    const analyzed = await analyzeRunnerFeed(source(feed), heads([accepted()]), session);
    expect(analyzed[1]!.classification?.class).toBe("view");
});

test("an expired rewrite credits all pending views without hiding a second rewrite two steps later", async () => {
    const expiredAt = acceptedAt + 107 * MINUTE;
    const feed = [row(acceptedAt + 1, 686_474, 0), row(expiredAt, 62_208, 381_260),
        row(expiredAt + 1000, 443_468, 0), row(expiredAt + 2000, 0, 400_000)];
    const facts = heads([accepted(), accepted(acceptedAt + 1, 39)]);
    const s = scan(feed, facts, expiredAt + 3000);
    await s.run();
    const head = Object.values(s.args.state.heads)[0]!;
    expect(head.summary.map((step) => step.class ?? "healthy")).toEqual(["expired", "healthy", "unexplained"]);
    expect(head.summary[0]!.evidence).toContain("view 38 accepted at 2026-11-11T19:06:21.803Z was applied with this rewrite");
    expect(head.summary[0]!.evidence).toContain("view 39 accepted at 2026-11-11T19:06:21.804Z was applied with this rewrite");
    expect(head.viewAttribution!.views.map((view) => view.credited)).toEqual([true, true]);
    expect(s.alerts.map((alert) => alert.class)).toEqual(["unexplained"]);
    const analyzed = await analyzeRunnerFeed(source(feed), facts, session);
    expect(analyzed.map((item) => item.classification?.class)).toEqual([undefined, "expired", undefined, "unexplained"]);
});

test("scope and plan changes leave a pending view for its own later rewrite", async () => {
    for (const body of [undefined, "signed floor moved to msg_42"]) {
        const feed = rows();
        feed[2] = { ...feed[2]!, model: body ? feed[2]!.model : "claude-other" };
        feed.push({ ...row(rewriteAt + 1000, 0, 400_000), model: feed[2]!.model });
        const facts = heads([accepted(), ...(body ? [log(rewriteAt - 1, body)] : [])]);
        const s = scan(feed, facts, rewriteAt + 2000);
        await s.run();
        expect(Object.values(s.args.state.heads)[0]!.summary.map((step) => step.class ?? "healthy"))
            .toEqual(["healthy", body ? "plan_changed" : "scope_changed", "view"]);
        expect(s.alerts).toEqual([]);
    }
});

test("a pending view explains a rewrite through three intervening metered steps but not four", async () => {
    for (const [healthySteps, expected] of [[3, "view"], [4, "unexplained"]] as const) {
        const feed = [rows()[0]!, ...Array.from({ length: healthySteps }, (_, index) =>
            row(acceptedAt + (index + 1) * 1000, 686_474, 0)), rows()[2]!];
        const s = scan(feed);
        await s.run();
        const observations = Object.values(s.args.state.heads)[0]!.summary;
        expect(observations.slice(0, -1).every((step) => step.healthy)).toBe(true);
        expect(observations.at(-1)!.class).toBe(expected);
        expect(s.alerts.map((alert) => alert.class)).toEqual(expected === "view" ? [] : ["unexplained"]);
        const analyzed = await analyzeRunnerFeed(source(feed), heads([accepted()]), session);
        expect(analyzed.at(-1)!.classification?.class).toBe(expected);
    }
});

test("a rewrite without a retained accepted view still wakes", async () => {
    for (const lines of [[], [accepted(rewriteAt - 30 * 60 * MINUTE - 1)], [accepted(rewriteAt)], [accepted(rewriteAt + 1)]]) {
        const s = scan(rows(), heads(lines));
        await s.run();
        expect(Object.values(s.args.state.heads)[0]!.summary.at(-1)!.class).toBe("unexplained");
        expect(s.alerts.map((alert) => alert.class)).toEqual(["unexplained"]);
    }
});

test("a refused or rolled-back view cannot explain the rewrite", async () => {
    const refusalAt = at("19:06:41.000");
    for (const body of [
        'runner refused view 38 at a step boundary: Rule(SignedPartInvalid { mid: "1eeac46a", part: "0" })',
        "runner refused view 38: Rule(Invalid)",
        "unknown answer to view 38: Other",
    ]) {
        const s = scan(rows(), heads([accepted(), log(refusalAt, body)]));
        await s.run();
        expect(Object.values(s.args.state.heads)[0]!.summary.at(-1)!.class).toBe("unexplained");
        expect(s.alerts.map((alert) => alert.class)).toEqual(["unexplained"]);
    }
});

test("Setup preserves a pending view when a silent re-offer succeeds", async () => {
    for (const applied of ["Some(37)", "None", "Some(38)"]) {
        const facts = heads([accepted(), log(acceptedAt + 2,
            `setup (pi, preset head, model anthropic/claude, window 1000000, reserve 32000, applied view ${applied})`)]);
        const s = scan(rows(), facts);
        await s.run();
        expect(Object.values(s.args.state.heads)[0]!.summary.at(-1)).toMatchObject({ class: "view", viewVersion: 38 });
        expect(s.alerts).toEqual([]);
        const analyzed = await analyzeRunnerFeed(source(rows()), facts, session);
        expect(analyzed.at(-1)!.classification?.class).toBe("view");
    }
});

test.each([
    ["refused re-offer", "runner refused view 39 offered again: Rule(Invalid) (3325 edits)"],
    ["unknown re-offer answer", "unknown answer to view 39 offered again: Other"],
    ["missing saved policy members", "view 39 saved without its policy members; rebuilding instead of offering it again"],
    ["mismatched saved checksum", "view 39 no longer matches its checksum as saved; rebuilding instead of offering it again"],
    ["failed re-offer call", "offering view 39 again failed: runner unavailable"],
])("a %s withdraws every pending view, including older accepted versions", async (_name, body) => {
    const facts = heads([accepted(), accepted(acceptedAt + 1, 39), log(acceptedAt + 2, body)]);
    const s = scan(rows(), facts);
    await s.run();
    expect(Object.values(s.args.state.heads)[0]!.summary.at(-1)!.class).toBe("unexplained");
    expect(s.alerts.map((alert) => alert.class)).toEqual(["unexplained"]);
    const analyzed = await analyzeRunnerFeed(source(rows()), facts, session);
    expect(analyzed.at(-1)!.classification?.class).toBe("unexplained");
});

test("boundary refusals withdraw newer views too; unknown answers withdraw only their own view", async () => {
    const accepts = [accepted(acceptedAt, 38), accepted(acceptedAt + 1, 39)];
    const refused = scan(rows(), heads([...accepts,
        log(acceptedAt + 2, "runner refused view 38 at a step boundary: Rule(Invalid)")]));
    await refused.run();
    expect(refused.alerts.map((alert) => alert.class)).toEqual(["unexplained"]);
    const unknown = scan(rows(), heads([...accepts,
        log(acceptedAt + 2, "unknown answer to view 39: Other")]));
    await unknown.run();
    expect(Object.values(unknown.args.state.heads)[0]!.summary.at(-1)).toMatchObject({ class: "view", viewVersion: 38 });
});

test("one accepted view explains only the first rewrite, including a repeated accept line", async () => {
    const feed = [...rows(), row(rewriteAt + 1000, 0, 400_000)];
    const facts = heads([accepted(), accepted(rewriteAt + 1)]);
    const s = scan(feed, facts, rewriteAt + 2000);
    await s.run();
    expect(Object.values(s.args.state.heads)[0]!.summary.map((step) => step.class ?? "healthy"))
        .toEqual(["healthy", "view", "unexplained"]);
    expect(s.alerts.map((alert) => alert.class)).toEqual(["unexplained"]);
    const analyzed = await analyzeRunnerFeed(source(feed), facts, session);
    expect(analyzed.map((item) => item.classification?.class)).toEqual([undefined, undefined, "view", "unexplained"]);
});

test("a rewrite credits every pending accept through the newest view", async () => {
    const s = scan([...rows(), row(rewriteAt + 1000, 0, 400_000)],
        heads([accepted(acceptedAt, 38), accepted(acceptedAt + 1, 39)]), rewriteAt + 2000);
    await s.run();
    const head = Object.values(s.args.state.heads)[0]!;
    expect(head.summary[1]).toMatchObject({ class: "view", viewVersion: 39 });
    expect(head.viewAttribution!.views.map((view) => [view.version, view.credited])).toEqual([[38, true], [39, true]]);
    expect(s.alerts.map((alert) => alert.class)).toEqual(["unexplained"]);
});

test("a sentinel restart preserves pending acceptance and later preserves its credit", async () => {
    const s = scan(rows().slice(0, 2), heads([accepted()]), at("19:06:40.000"));
    await s.run();
    expect(Object.values(s.args.state.heads)[0]!.viewAttribution!.views[0]!.credited).toBe(false);
    const restored = parseRunnerMonitorState(JSON.parse(JSON.stringify(s.args.state)));
    const now = rewriteAt + 1000;
    const args = { ...s.args, state: restored, heads: heads([]), source: source([rows()[2]!]),
        now, clock: () => now, deadline: now + 30_000 };
    await scanRunnerFeed(args);
    await scanRunnerFeed(args);
    expect(Object.values(restored.heads)[0]!.summary.at(-1)).toMatchObject({ class: "view", viewVersion: 38 });
    expect(s.alerts).toEqual([]);

    args.state = parseRunnerMonitorState(JSON.parse(JSON.stringify(restored)));
    args.heads = heads([accepted()]);
    args.source = source([row(rewriteAt + 500, 0, 400_000)]);
    await scanRunnerFeed(args);
    await scanRunnerFeed(args);
    expect(s.alerts.map((alert) => alert.class)).toEqual(["unexplained"]);
    pruneRunnerState(args.state, acceptedAt + 30 * 60 * MINUTE);
    expect(Object.values(args.state.heads)[0]!.viewAttribution!.views[0]!.credited).toBe(true);
    pruneRunnerState(args.state, acceptedAt + 30 * 60 * MINUTE + 1);
    expect(Object.values(args.state.heads)[0]!.viewAttribution!.views).toEqual([]);
});

test("a pending view survives a sentinel restart and 40 idle minutes without its accept log", async () => {
    const s = scan([row(acceptedAt - 1, 686_474, 0)], heads([accepted()]), acceptedAt + 1000);
    await s.run();
    const state = parseRunnerMonitorState(JSON.parse(JSON.stringify(s.args.state)));
    const delayedAt = acceptedAt + 40 * MINUTE;
    const now = delayedAt + 1000;
    const args = { ...s.args, state, heads: heads([]), source: source([row(delayedAt, 62_208, 381_260)]),
        now, clock: () => now, deadline: now + 30_000 };
    await scanRunnerFeed(args);
    await scanRunnerFeed(args);
    expect(Object.values(state.heads)[0]!.summary.at(-1)).toMatchObject({ class: "view", viewVersion: 38 });
    expect(s.alerts).toEqual([]);
});

test("four intervening metered steps still exhaust a view after a sentinel restart", async () => {
    const feed = [rows()[0]!, ...Array.from({ length: 4 }, (_, index) =>
        row(acceptedAt + (index + 1) * 1000, 686_474, 0))];
    const s = scan(feed, heads([accepted()]), acceptedAt + 5000);
    await s.run();
    const state = parseRunnerMonitorState(JSON.parse(JSON.stringify(s.args.state)));
    const now = rewriteAt + 1000;
    const args = { ...s.args, state, heads: heads([]), source: source([rows()[2]!]),
        now, clock: () => now, deadline: now + 30_000 };
    await scanRunnerFeed(args);
    await scanRunnerFeed(args);
    expect(Object.values(state.heads)[0]!.summary.at(-1)!.class).toBe("unexplained");
    expect(s.alerts.map((alert) => alert.class)).toEqual(["unexplained"]);
});

test("acceptance and refusal are saved even in scans without a new metered step", async () => {
    const s = scan(rows().slice(0, 1), heads([]), at("19:06:40.000"));
    await s.run();
    s.args.heads = heads([accepted()]);
    await scanRunnerFeed(s.args);
    expect(Object.values(s.args.state.heads)[0]!.viewAttribution!.views[0]).toMatchObject({ version: 38, credited: false });
    s.args.heads = heads([log(acceptedAt + 1, "runner refused view 38 at a step boundary: Rule(Invalid)")]);
    await scanRunnerFeed(s.args);
    const restored = parseRunnerMonitorState(JSON.parse(JSON.stringify(s.args.state)));
    const now = rewriteAt + 1000;
    const args = { ...s.args, state: restored, heads: heads([]), source: source([rows()[2]!]),
        now, clock: () => now, deadline: now + 30_000 };
    await scanRunnerFeed(args);
    await scanRunnerFeed(args);
    expect(s.alerts.map((alert) => alert.class)).toEqual(["unexplained"]);
});
