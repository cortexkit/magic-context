import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../src/shared/test-temp-dir";
import { analyzeRunnerFeed, printRunnerFeedAnalysis } from "./cache-bust-runner-analyzer";
import type { RunnerFeedRow, RunnerMeterSource } from "./cache-bust-runner-feed";
import { emptyRunnerState, scanRunnerFeed, type RunnerAlert, type RunnerHeads } from "./cache-bust-runner-monitor";
import { loadSentinelState, saveSentinelState } from "./cache-bust-sentinel";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-10-01T05:00:00Z");
const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function row(session: string, at: number, read = 0, write = 100_000): RunnerFeedRow {
    return { cursor: `${session}/${at}`, harness: "opencode", source: "runner", step_ref: `${session}/${at}`,
        session, occurred_at_ms: at, provider: "anthropic", model: "claude-opus", cache_read: read,
        cache_write: write, prompt: read + write, verdict: "stable" };
}
function pair(session: string, at: number, previous = T0 - MINUTE): RunnerFeedRow[] {
    return [row(session, previous, 100_000, 0), row(session, at)];
}
const opening = () => [...pair("alpha", T0), ...pair("beta", T0 + 2 * MINUTE), ...pair("gamma", T0 + 3 * MINUTE)];
function source(rows: RunnerFeedRow[]): RunnerMeterSource {
    let first = true;
    return { id: "astrocyte", read: async () => {
        const page = { rows: first ? rows : [], next: null, through: "end" };
        first = false;
        return page;
    } };
}
function fixture(rows = opening(), at = T0 + 4 * MINUTE) {
    const alerts: RunnerAlert[] = [];
    const logs: string[] = [];
    const heads: RunnerHeads = new Map();
    const args = { state: emptyRunnerState(), source: source([]), heads, root: "fixture-root", now: at,
        clock: () => args.now, deadline: at + MINUTE, wakeAge: 30 * MINUTE,
        emit: async (alert: RunnerAlert) => { alerts.push(alert); }, log: (line: string) => logs.push(line) };
    async function feed(next: RunnerFeedRow[], now = args.now) {
        args.now = now;
        args.deadline = now + MINUTE;
        for (const item of next) if (!heads.has(item.session)) heads.set(item.session, { harness: "opencode", decisions: [] });
        args.source = source(next);
        await scanRunnerFeed(args);
        await scanRunnerFeed(args);
    }
    return { args, alerts, logs, feed, start: () => feed(rows, at) };
}

test("no urgent wake for the fourth session in a zero-read wave", async () => {
    const s = fixture([...opening(), ...pair("delta", T0 + 9 * MINUTE)], T0 + 10 * MINUTE);
    await s.start();
    expect(s.alerts.filter((alert) => alert.session === "delta" && alert.urgency === "high")).toHaveLength(0);
    expect(s.alerts.map((alert) => alert.class)).toEqual(["unexplained", "zero_read_wave"]);
    expect(s.args.state.wave.open?.members).toHaveLength(4);
});

test("two distinct sessions nine or ten minutes apart open once; eleven minutes apart do not", async () => {
    for (const [secondAt, expected] of [[T0 + 9 * MINUTE, true], [T0 + 10 * MINUTE, true], [T0 + 10 * MINUTE + 1, false], [T0 + 11 * MINUTE, false]] as const) {
        const s = fixture([...pair("alpha", T0), ...pair("beta", secondAt)], secondAt);
        await s.start();
        expect(Boolean(s.args.state.wave.open)).toBe(expected);
        expect(s.alerts.map((alert) => alert.class)).toEqual(["unexplained", expected ? "zero_read_wave" : "unexplained"]);
        if (expected) {
            expect(s.args.state.wave.open?.startedAt).toBe(T0);
            const wake = s.alerts[1]!;
            expect(wake.urgency).toBe("high");
            for (const member of s.args.state.wave.open!.members) {
                expect(wake.detail).toContain(`session=${member.session}`);
                expect(wake.detail).toContain(new Date(member.previousStepAt).toISOString());
            }
            expect(wake.detail).toContain("written=100000");
            expect(wake.detail).toContain("feed carries no account");
            expect(wake.detail).toContain("not proven");
            expect(wake.detail).toContain("Ask the runner's owner");
            expect(wake.detail).toContain("Two sessions lost their whole cache");
            expect(wake.detail).toContain("A tool or system change for many sessions looks the same");
        }
    }
    const repeated = fixture([...pair("alpha", T0), row("alpha", T0 + 1000)]);
    await repeated.start();
    expect(repeated.args.state.wave.open).toBeUndefined();
    expect(repeated.alerts).toHaveLength(2);
});

test("only later members need a predecessor strictly before the wave start", async () => {
    const rows = [...pair("alpha", T0), ...pair("beta", T0 + 2 * MINUTE, T0 + 1), ...pair("gamma", T0 + 3 * MINUTE),
        ...pair("before", T0 + 5 * MINUTE, T0 - 1), ...pair("at", T0 + 5 * MINUTE, T0)];
    const s = fixture(rows, T0 + 6 * MINUTE);
    await s.start();
    expect(s.args.state.wave.open?.members.map((member) => member.session)).toEqual(["alpha", "beta", "gamma", "before"]);
    expect(s.alerts.find((alert) => alert.session === "at")).toMatchObject({ class: "unexplained", urgency: "high" });
    expect(s.alerts.at(-1)!.detail).toContain("zero_read_wave is open");
});

test("a second rewrite before or after opening stays urgent and does not inflate wave totals", async () => {
    const s = fixture([...opening(), row("alpha", T0 + 15_000), row("beta", T0 + 4 * MINUTE)], T0 + 5 * MINUTE);
    await s.start();
    expect(s.alerts.filter((alert) => alert.class === "unexplained")).toHaveLength(3);
    expect(s.alerts.at(-1)!.detail).toContain("zero_read_wave is open");
    expect(s.args.state.wave.open?.members.map((member) => member.at)).toEqual([T0, T0 + 2 * MINUTE, T0 + 3 * MINUTE]);
    expect(s.alerts.find((alert) => alert.class === "zero_read_wave")!.rewrittenTokens).toBe(200_000);
});

test("a session that read normally after T0 and then reads zero is a new urgent event", async () => {
    const s = fixture([...opening(), row("new-event", T0 - MINUTE, 100_000, 0),
        row("new-event", T0 + MINUTE, 100_000, 0), row("new-event", T0 + 5 * MINUTE)], T0 + 6 * MINUTE);
    await s.start();
    expect(s.alerts.at(-1)).toMatchObject({ session: "new-event", class: "unexplained", urgency: "high" });
    expect(s.alerts.at(-1)!.detail).toContain("zero_read_wave is open");
    expect(s.args.state.wave.open?.members).toHaveLength(3);
});

test("expiry wins over the wave, while model changes, small writes and nonzero reads never join", async () => {
    const expired = pair("expired", T0 + 5 * MINUTE, T0 - 2 * HOUR);
    const changed = pair("changed", T0 + 5 * MINUTE);
    changed[1]!.model = "claude-sonnet";
    const short = pair("short", T0 + 5 * MINUTE);
    short[1] = row("short", T0 + 5 * MINUTE, 0, 19_999);
    const partial = pair("partial", T0 + 5 * MINUTE);
    partial[1] = row("partial", T0 + 5 * MINUTE, 1, 100_000);
    const smallPrevious = [row("small-previous", T0 - MINUTE, 19_999, 0), row("small-previous", T0 + 5 * MINUTE)];
    const s = fixture([...opening(), ...expired, ...changed, ...short, ...partial, ...smallPrevious], T0 + 6 * MINUTE);
    await s.start();
    expect(s.args.state.wave.open?.members).toHaveLength(3);
    const observations = Object.values(s.args.state.heads).flatMap((head) => head.summary);
    expect(observations.find((item) => item.step === expired[1]!.step_ref)?.class).toBe("expired");
    expect(s.alerts.some((alert) => alert.session === "expired")).toBe(false);
    expect(s.alerts.some((alert) => alert.session === "partial")).toBe(true);
    const noWave = fixture([...pair("alpha", T0), ...expired], T0 + 6 * MINUTE);
    await noWave.start();
    expect(noWave.args.state.wave.open).toBeUndefined();
});

test("the exact twenty-thousand-token boundaries qualify, including direct prompt tokens", async () => {
    const rows = ["alpha", "beta", "gamma"].flatMap((session, i) => [
        { ...row(session, T0 - MINUTE, 19_000, 0), prompt: 20_000 }, row(session, T0 + i * MINUTE, 0, 20_000),
    ]);
    const s = fixture(rows);
    await s.start();
    expect(s.args.state.wave.open?.members).toHaveLength(3);
    expect(s.alerts.at(-1)).toMatchObject({ class: "zero_read_wave", rewrittenTokens: 40_000 });
});

test("accepted views, provider-forgot rides and plan changes keep their cause outside the wave", async () => {
    const s = fixture([...opening(), ...pair("view", T0 + 5 * MINUTE), ...pair("forgot", T0 + 5 * MINUTE),
        ...pair("plan", T0 + 5 * MINUTE)], T0 + 6 * MINUTE);
    for (const [session, kind, detail] of [
        ["view", "view", "view 2 accepted (4 edits, no cut)"],
        ["forgot", "ride", "ride [AccountChange]"],
        ["plan", "signed_floor", "signed floor moved to msg_2"],
    ] as const) {
        s.args.heads.set(session, { harness: "opencode", decisions: [{ at: T0 + 4 * MINUTE, kind, detail, version: 2 }] });
    }
    await s.start();
    expect(s.args.state.wave.open?.members).toHaveLength(3);
    const classes = Object.values(s.args.state.heads).flatMap((head) => head.summary.map((item) => item.class));
    expect(classes).toContain("view");
    expect(classes).toContain("provider_forgot");
    expect(classes).toContain("plan_changed");
});

test("normal summaries list new members and totals no more often than every thirty minutes", async () => {
    const s = fixture(opening(), T0 + 3 * MINUTE);
    await s.start();
    await s.feed(pair("delta", T0 + 9 * MINUTE), T0 + 10 * MINUTE);
    expect(s.alerts).toHaveLength(2);
    await s.feed([], T0 + 33 * MINUTE - 1);
    expect(s.alerts).toHaveLength(2);
    await s.feed([], T0 + 33 * MINUTE);
    expect(s.alerts.at(-1)).toMatchObject({ class: "zero_read_wave", urgency: "normal", rewrittenTokens: 400_000 });
    expect(s.alerts.at(-1)!.detail).toContain("session=delta");
    expect(s.alerts.at(-1)!.detail).toContain("4 sessions, 400000 tokens written");
    await s.feed(pair("epsilon", T0 + 35 * MINUTE), T0 + 36 * MINUTE);
    await s.feed([], T0 + 63 * MINUTE - 1);
    expect(s.alerts).toHaveLength(3);
    await s.feed([], T0 + 63 * MINUTE);
    expect(s.alerts).toHaveLength(4);
    expect(s.alerts.at(-1)!.detail).toContain("session=epsilon");
    expect(s.alerts.at(-1)!.detail).not.toContain("session=delta");
    expect(s.alerts.at(-1)!.detail).toContain("5 sessions, 500000 tokens written");
    await s.feed([], T0 + 65 * MINUTE);
    expect(s.alerts).toHaveLength(4);
});

test("a wave closes at six hours even without feed rows, logs once, and the next wave starts from nothing", async () => {
    const s = fixture();
    await s.start();
    await s.feed([], T0 + 6 * HOUR - 1);
    expect(s.args.state.wave.open).toBeDefined();
    await s.feed([], T0 + 6 * HOUR);
    expect(s.args.state.wave).toEqual({ candidates: [] });
    await s.feed(pair("delta", T0 + 6 * HOUR + MINUTE, T0 + 6 * HOUR), T0 + 6 * HOUR + MINUTE);
    expect(s.alerts.at(-1)).toMatchObject({ session: "delta", class: "unexplained", urgency: "high" });
    expect(s.args.state.wave.open).toBeUndefined();
    await s.feed([...pair("epsilon", T0 + 6 * HOUR + 2 * MINUTE, T0 + 6 * HOUR),
        ...pair("zeta", T0 + 6 * HOUR + 3 * MINUTE, T0 + 6 * HOUR)], T0 + 6 * HOUR + 3 * MINUTE);
    expect(s.args.state.wave.open?.startedAt).toBe(T0 + 6 * HOUR + MINUTE);
    const logs = s.logs.map((line) => JSON.parse(line));
    expect(logs.filter((line) => line.kind === "runner_zero_read_wave_opened")).toHaveLength(2);
    expect(logs.filter((line) => line.kind === "runner_zero_read_wave_member")).toHaveLength(6);
    expect(logs.filter((line) => line.kind === "runner_zero_read_wave_closed")).toMatchObject([
        { startedAt: T0, at: T0 + 6 * HOUR, sessions: 3, written: 300_000 },
    ]);
});

test("candidate sessions expire after ten minutes and closed waves keep no member history", async () => {
    const s = fixture([...pair("alpha", T0), row("alpha", T0 + MINUTE)]);
    await s.start();
    await s.feed([], T0 + 12 * MINUTE);
    expect(s.args.state.wave).toEqual({ candidates: [] });
});

test("wave candidates, members and summary timing survive a watcher state-file restart; old files load", async () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "runner-wave-"));
    dirs.push(dir);
    const path = join(dir, "sentinel.json");
    const s = fixture(pair("alpha", T0), T0 + MINUTE);
    const restart = () => {
        saveSentinelState(path, { version: 1, sessions: {}, windows: {}, deliveries: {}, suppressedWindows: {}, runner: s.args.state });
        s.args.state = loadSentinelState(path).runner!;
    };
    await s.start();
    restart();
    await s.feed(pair("beta", T0 + 2 * MINUTE), T0 + 3 * MINUTE);
    restart();
    await s.feed(pair("gamma", T0 + 3 * MINUTE), T0 + 3 * MINUTE);
    restart();
    await s.feed(pair("delta", T0 + 9 * MINUTE), T0 + 10 * MINUTE);
    restart();
    await s.feed([], T0 + 33 * MINUTE);
    expect(s.alerts.map((alert) => alert.urgency)).toEqual(["high", "high", "normal"]);
    restart();
    await s.feed([row("alpha", T0 + 34 * MINUTE)], T0 + 35 * MINUTE);
    expect(s.alerts.at(-1)).toMatchObject({ class: "unexplained", urgency: "high" });
    expect(s.args.state.wave.open?.members).toHaveLength(4);
    const old = { ...emptyRunnerState() } as Partial<ReturnType<typeof emptyRunnerState>>;
    delete old.wave;
    writeFileSync(path, JSON.stringify({ version: 1, sessions: {}, windows: {}, runner: old }));
    expect(loadSentinelState(path).runner?.wave).toEqual({ candidates: [] });
    writeFileSync(path, JSON.stringify({ version: 1, sessions: {}, windows: {} }));
    expect(loadSentinelState(path).runner).toBeUndefined();
});

test("the analyzer shares wave membership across sessions without reading watcher state", async () => {
    const rows = [...opening(), row("alpha", T0 + 15_000), ...pair("delta", T0 + 9 * MINUTE),
        row("new-event", T0 - MINUTE, 100_000, 0), row("new-event", T0 + MINUTE, 100_000, 0), row("new-event", T0 + 5 * MINUTE)];
    const heads: RunnerHeads = new Map(["alpha", "beta", "gamma", "delta", "new-event"].map((session) => [session, { harness: "opencode", decisions: [] }]));
    for (const session of ["alpha", "beta", "gamma", "delta"]) {
        const analyzed = await analyzeRunnerFeed(source(rows), heads, session, { since: T0 - MINUTE, until: T0 + 10 * MINUTE });
        expect(analyzed.find((item) => item.row.cache_read === 0)?.classification).toMatchObject({ class: "zero_read_wave", zeroReadWaveStartedAt: T0 });
        if (session === "alpha") expect(analyzed.at(-1)?.classification?.class).toBe("unexplained");
        const output: string[] = [];
        printRunnerFeedAnalysis(analyzed, (line) => output.push(line));
        expect(output.some((line) => line.includes(" | zero_read_wave | ") && line.includes(new Date(T0).toISOString()))).toBe(true);
    }
    const narrowed = await analyzeRunnerFeed(source(rows), heads, "delta", { since: T0 + 6 * MINUTE });
    expect(narrowed.at(-1)?.classification?.class).toBe("unexplained");
    const tooFew = await analyzeRunnerFeed(source(rows.filter((item) => item.session === "alpha")), heads, "alpha");
    expect(tooFew.find((item) => item.row.cache_read === 0)?.classification?.class).toBe("unexplained");
    expect(tooFew.at(-1)?.classification?.class).toBe("unexplained");
    const newEvent = await analyzeRunnerFeed(source(rows), heads, "new-event");
    expect(newEvent.at(-1)?.classification?.class).toBe("unexplained");
});
