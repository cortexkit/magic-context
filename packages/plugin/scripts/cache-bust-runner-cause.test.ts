import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeRunnerFeed } from "./cache-bust-runner-analyzer";
import {
    decodeRunnerFeedPage,
    type RunnerFeedRow,
    type RunnerMeterSource,
} from "./cache-bust-runner-feed";
import { parseRunnerDecision } from "./cache-bust-runner-log";
import {
    emptyRunnerState,
    parseRunnerMonitorState,
    scanRunnerFeed,
    type RunnerAlert,
    type RunnerHeads,
} from "./cache-bust-runner-monitor";

// Astrocyte's tagged sample set `usage-cache-causes-v1`, file reply-feed-read.json,
// SHA-256 f142bb1c6eddb4a66ff1d1f8304f3e31fbbe38a4e1ae9ddd67064ab7ef864ef4
// (see test-fixtures/usage-cache-causes-v1/README.md).
const SAMPLE_SHA256 = "f142bb1c6eddb4a66ff1d1f8304f3e31fbbe38a4e1ae9ddd67064ab7ef864ef4";
const sampleBytes = readFileSync(
    join(import.meta.dir, "test-fixtures/usage-cache-causes-v1/reply-feed-read.json"),
);
const sample = decodeRunnerFeedPage(JSON.parse(sampleBytes.toString("utf8"))).rows;
const SESSION = "synthetic-rewrite-causes";
const MINUTE = 60_000;
const at = (offset: number) => 4_000_000_000_000 + offset;
const FACT_MEMBERS = [
    "account_ref", "started_at_ms", "finished_at_ms", "cache_ttl_ms", "warm_up",
    "view_version", "tools_digest", "system_digest", "signed_floor",
] as const;

function sampleRow(stepRef: string): RunnerFeedRow {
    const row = sample.find((item) => item.step_ref === stepRef);
    if (!row) throw new Error(`sample has no ${stepRef}`);
    return row;
}

// The sample rows carry no cache_write, which the watcher needs before it
// judges a step. Give each row counts large enough to wake, keeping every
// fact and cause exactly as Astrocyte served them: a baseline reads the whole
// prefix, and a rewrite reads nothing and writes it again.
function metered(row: RunnerFeedRow): RunnerFeedRow {
    const read = row.cache_read === 0 ? 0 : 100_000;
    const write = 100_000 - read;
    return { ...row, cache_read: read, cache_write: write, prompt: read + write + (row.input ?? 0) };
}
const meteredSample = () => sample.map(metered);

/** A row as Astrocyte recorded it before runners sent facts. */
function withoutFacts(row: RunnerFeedRow): RunnerFeedRow {
    const copy: Partial<RunnerFeedRow> = { ...row };
    for (const member of FACT_MEMBERS) delete copy[member];
    return copy as RunnerFeedRow;
}

function inSession(row: RunnerFeedRow, session: string, shift: number): RunnerFeedRow {
    const moved = (value?: number) => (value === undefined ? undefined : value + shift);
    return {
        ...row, session, cursor: `${session}/${row.cursor}`, step_ref: `${session}/${row.step_ref}`,
        occurred_at_ms: row.occurred_at_ms + shift,
        started_at_ms: moved(row.started_at_ms), finished_at_ms: moved(row.finished_at_ms),
    };
}

const logLine = (session: string, when: number, body: string) =>
    `${new Date(when).toISOString()} INFO  magic-context: ck-mc: session ${session}: ${body}`;

function source(rows: RunnerFeedRow[]): RunnerMeterSource {
    let unread = true;
    return { id: "astrocyte", read: async () => {
        const page = { rows: unread ? rows : [], next: null, through: "end" };
        unread = false;
        return page;
    } };
}

function headsFor(sessions: readonly string[], lines: readonly string[]): RunnerHeads {
    return new Map(sessions.map((session) => [session, {
        harness: "pi",
        decisions: lines.flatMap((line) => parseRunnerDecision(line, session) ?? []),
    }]));
}

async function scan(rows: RunnerFeedRow[], lines: string[] = [], sessions = [SESSION]) {
    const now = Math.max(...rows.map((row) => row.occurred_at_ms)) + 1000;
    const alerts: RunnerAlert[] = [];
    const logs: string[] = [];
    const args = {
        state: emptyRunnerState(), source: source(rows), heads: headsFor(sessions, lines),
        root: "fixture-root", now, clock: () => now, deadline: now + 30_000, wakeAge: 30 * MINUTE,
        emit: async (alert: RunnerAlert) => { alerts.push(alert); },
        log: (line: string) => { logs.push(line); },
    };
    // A row is judged one complete run after it is first read.
    await scanRunnerFeed(args);
    await scanRunnerFeed(args);
    const observations = new Map(Object.values(args.state.heads)
        .flatMap((head) => head.summary).map((item) => [item.step, item]));
    return { args, alerts, logs: logs.map((line) => JSON.parse(line)), observations };
}

const analyze = async (rows: RunnerFeedRow[], lines: string[] = [], session = SESSION, sessions = [SESSION]) =>
    new Map((await analyzeRunnerFeed(source(rows), headsFor(sessions, lines), session))
        .map((item) => [item.row.step_ref, item.classification]));

test("the sample decodes byte for byte with every fact and cause", () => {
    expect(createHash("sha256").update(sampleBytes).digest("hex")).toBe(SAMPLE_SHA256);
    expect(sample).toHaveLength(14);
    expect(sample.flatMap((row) => row.cause ?? [])).toEqual([
        "account_or_model_changed", "cache_expired", "tools_or_system_changed",
        "view_changed", "signed_floor_moved", "unexplained",
    ]);
    expect(sampleRow("cause-view_changed")).toMatchObject({
        account_ref: "a".repeat(64), started_at_ms: at(30_100), finished_at_ms: at(30_110),
        cache_ttl_ms: 1000, warm_up: true, view_version: 2, tools_digest: "tools-v1",
        system_digest: "system-v1", signed_floor: "floor-1", cause: "view_changed",
    });
});

test("each Astrocyte cause decides the class when both steps carry facts", async () => {
    const s = await scan(meteredSample());
    const expected = {
        "cause-account_or_model_changed": ["scope_changed", "account aaaaaaaa→bbbbbbbb"],
        "cause-cache_expired": ["expired", "1990ms from the previous request's finish to this one's start exceeds its cache lifetime 1000ms"],
        "cause-tools_or_system_changed": ["plan_changed", "tools digest changed"],
        "cause-view_changed": ["view", "view 1→2"],
        "cause-signed_floor_moved": ["plan_changed", "signed floor floor-1→floor-2"],
        "cause-unexplained": ["unexplained", "no account, model, expiry, tools, system, view or signed-floor change"],
    } as const;
    for (const [step, [kind, facts]] of Object.entries(expected)) {
        const observation = s.observations.get(step);
        expect(observation, step).toMatchObject({ class: kind, cause: sampleRow(step).cause });
        expect(observation!.evidence).toBe(
            `cause=${sampleRow(step).cause} (astrocyte); ${facts}${step === "cause-view_changed" ? "; no acceptance of view 2 in the module log" : ""}`,
        );
    }
    expect(s.observations.get("cause-view_changed")?.viewVersion).toBe(2);
    for (const step of ["baseline-1", "baseline-6", "cause-none"])
        expect(s.observations.get(step)?.healthy).toBe(true);
    // Only the unexplained rewrite wakes: a plan change needs three sessions,
    // and scope changes, expiry and views never wake on their own.
    expect(s.alerts.map((alert) => [alert.id, alert.class, alert.urgency])).toEqual([
        ["runner-step:pi:cause-unexplained", "unexplained", "high"],
    ]);
    // The one-off analyzer applies the same rule.
    const analyzed = await analyze(meteredSample());
    for (const step of Object.keys(expected))
        expect(analyzed.get(step), step).toMatchObject({
            class: s.observations.get(step)!.class, evidence: s.observations.get(step)!.evidence,
        });
});

test("a cause whose facts are missing on either step falls back to the module log", async () => {
    const pair = ["baseline-5", "cause-unexplained"].map((step) => metered(sampleRow(step)));
    const accepted = logLine(SESSION, at(50_050), "view 7 accepted (12 edits, no cut)");
    const cases = {
        // Every rewrite Astrocyte judged before runners sent facts reads
        // "unexplained" with nothing compared.
        "neither step": pair.map(withoutFacts),
        "the previous step": [withoutFacts(pair[0]!), pair[1]!],
        "the rewrite": [pair[0]!, withoutFacts(pair[1]!)],
        // A newer Astrocyte may name a cause this watcher has no class for.
        "an unfamiliar cause": [pair[0]!, { ...pair[1]!, cause: "route_changed" }],
        // A step that carries its account but not the view or digests, as a
        // runner's request that skipped the module did: "unexplained" then
        // compared nothing that would show a view or plan change.
        "the view and digests only": [
            { ...pair[0]!, view_version: undefined, tools_digest: undefined, system_digest: undefined },
            pair[1]!,
        ],
        // Without the previous request's cache lifetime and times Astrocyte
        // cannot see an idle-expired cache, so its "unexplained" compared no
        // expiry.
        "the previous step's cache lifetime": [{ ...pair[0]!, cache_ttl_ms: undefined }, pair[1]!],
        "the rewrite's start time": [pair[0]!, { ...pair[1]!, started_at_ms: undefined }],
    };
    for (const [missing, rows] of Object.entries(cases)) {
        const s = await scan(rows, [accepted]);
        const rewrite = s.observations.get("cause-unexplained");
        expect(rewrite, missing).toMatchObject({ class: "view", viewVersion: 7 });
        expect(rewrite!.cause).toBeUndefined();
        expect(rewrite!.evidence).not.toContain("astrocyte");
        expect(s.alerts, missing).toEqual([]);
        expect(s.logs, missing).toEqual([]);
        expect((await analyze(rows, [accepted])).get("cause-unexplained")?.class).toBe("view");
    }
    // Without a log explanation the old row is still the log path's unexplained,
    // exactly as before runners sent facts.
    const unlogged = await scan(pair.map(withoutFacts));
    expect(unlogged.observations.get("cause-unexplained")?.evidence).toStartWith("no model change");
});

test("a view change credits the applied view, even one logged after the request", async () => {
    const rows = [
        ...["baseline-3", "cause-view_changed"].map((step) => metered(sampleRow(step))),
        // Later rewrites from a runner that sends no facts fall back to the log.
        ...["baseline-4", "cause-signed_floor_moved"].map((step) => withoutFacts(metered(sampleRow(step)))),
    ];
    // ck-mc logged the acceptance only after the request that applied it.
    const late = logLine(SESSION, at(30_105), "view 2 accepted (4 edits, no cut)");
    const s = await scan(rows, [late]);
    expect(s.observations.get("cause-view_changed")).toMatchObject({
        class: "view", viewVersion: 2, viewAcceptedAt: at(30_105),
    });
    expect(s.observations.get("cause-view_changed")!.evidence).toBe(
        `cause=view_changed (astrocyte); view 1→2; view 2 accepted at ${new Date(at(30_105)).toISOString()}; ${late}`,
    );
    // View 2 is spent, so it cannot also explain the next rewrite.
    expect(s.observations.get("cause-signed_floor_moved")?.class).toBe("unexplained");
    expect((await analyze(rows, [late])).get("cause-signed_floor_moved")?.class).toBe("unexplained");
    // Only views up to the applied one are spent. A newer view accepted while
    // that request was in flight still explains the later rewrite.
    const applied = logLine(SESSION, at(30_050), "view 2 accepted (4 edits, no cut)");
    const newer = logLine(SESSION, at(30_080), "view 3 accepted (2 edits, no cut)");
    const pending = await scan(rows, [applied, newer]);
    expect(pending.observations.get("cause-view_changed")).toMatchObject({ viewVersion: 2, viewAcceptedAt: at(30_050) });
    // Two view rewrites ten seconds apart are a double rebuild, with its usual wake.
    expect(pending.observations.get("cause-signed_floor_moved")).toMatchObject({ class: "double_rebuild", viewVersion: 3 });
    expect(pending.alerts.map((alert) => alert.class)).toEqual(["double_rebuild"]);
    expect(pending.alerts[0]!.detail).toContain("view 2 wrote 100000 tokens; ");
});

const accountWaveRows = () => {
    const pair = ["baseline-0", "cause-account_or_model_changed"].map((step) => metered(sampleRow(step)));
    return [
        ...pair.map((row) => inSession(row, "alpha", 0)),
        ...pair.map((row) => inSession(row, "beta", 2 * MINUTE)),
    ];
};
const PROVEN_WORDING = "The account change is proven by the runner's account facts";
const UNPROVEN_WORDING = "The feed carries no account, so this is not proven. A tool or system change for many sessions looks the same from here.";

test("account changes Astrocyte proves still group into one zero-read wave", async () => {
    const rows = accountWaveRows();
    const s = await scan(rows, [], ["alpha", "beta"]);
    expect(s.args.state.wave.open?.members.map((member) => member.session)).toEqual(["alpha", "beta"]);
    // A proven account change has no wake of its own; the wave wakes once.
    expect(s.alerts.map((alert) => [alert.class, alert.session])).toEqual([["zero_read_wave", "beta"]]);
    for (const session of ["alpha", "beta"]) {
        const member = s.observations.get(`${session}/cause-account_or_model_changed`)!;
        expect(member).toMatchObject({ class: "zero_read_wave", cause: "account_or_model_changed" });
        expect(member.evidence).toContain("cause=account_or_model_changed (astrocyte); account aaaaaaaa→bbbbbbbb");
        expect(member.evidence).not.toContain("not proven");
        const analyzed = await analyze(rows, [], session, ["alpha", "beta"]);
        expect(analyzed.get(`${session}/cause-account_or_model_changed`)).toMatchObject({
            class: "zero_read_wave", evidence: member.evidence,
        });
    }
});

test("a wave whose every member's account change is proven says so in its wake", async () => {
    const s = await scan(accountWaveRows(), [], ["alpha", "beta"]);
    expect(s.args.state.wave.open?.members.map((member) => member.account))
        .toEqual([{ from: "aaaaaaaa", to: "bbbbbbbb" }, { from: "aaaaaaaa", to: "bbbbbbbb" }]);
    const wake = s.alerts.find((alert) => alert.class === "zero_read_wave")!;
    expect(wake.detail).toContain(`${PROVEN_WORDING}: every member's account changed (aaaaaaaa→bbbbbbbb).`);
    expect(wake.detail).not.toContain("not proven");
    expect(wake.detail).not.toContain("A tool or system change");
    expect(wake.detail).toContain("Ask the runner's owner which account stopped being given");
});

test("a wave with any member lacking proof of an account change keeps the unproven wake", async () => {
    const [alpha0, alpha1, beta0, beta1] = accountWaveRows();
    // Astrocyte's same-account rewrite: facts present, account unchanged.
    const sameAccount = ["baseline-5", "cause-unexplained"]
        .map((step) => inSession(metered(sampleRow(step)), "beta", 2 * MINUTE - 50_000));
    const cases = {
        "a member without facts": [alpha0!, alpha1!, withoutFacts(beta0!), withoutFacts(beta1!)],
        "a member whose account did not change": [alpha0!, alpha1!, ...sameAccount],
    };
    for (const [mixed, rows] of Object.entries(cases)) {
        const s = await scan(rows, [], ["alpha", "beta"]);
        expect(s.args.state.wave.open?.members.map((member) => member.session), mixed).toEqual(["alpha", "beta"]);
        expect(s.args.state.wave.open!.members.map((member) => member.account !== undefined)).toEqual([true, false]);
        const wake = s.alerts.find((alert) => alert.class === "zero_read_wave")!;
        expect(wake.detail, mixed).toContain(UNPROVEN_WORDING);
        expect(wake.detail, mixed).not.toContain(PROVEN_WORDING);
        // Each member's own evidence still says whether its change is proven.
        const observations = [...s.observations.values()].filter((item) => item.class === "zero_read_wave");
        expect(observations.map((item) => item.evidence.includes("not proven"))).toEqual([false, true]);
    }
});

test("a cause that differs from the log guess writes one disagreement line", async () => {
    const s = await scan(meteredSample());
    // With no module log, the timing guess finds every rewrite unexplained.
    expect(s.logs.filter((line) => line.kind === "runner_cause_disagreement")).toEqual([
        ["cause-account_or_model_changed", "account_or_model_changed", "scope_changed", 100],
        ["cause-cache_expired", "cache_expired", "expired", 12_000],
        ["cause-tools_or_system_changed", "tools_or_system_changed", "plan_changed", 20_100],
        ["cause-view_changed", "view_changed", "view", 30_100],
        ["cause-signed_floor_moved", "signed_floor_moved", "plan_changed", 40_100],
    ].map(([step, cause, astrocyteClass, offset]) => ({
        kind: "runner_cause_disagreement", session: SESSION, step, harness: "pi",
        at: at(offset as number), cause, astrocyteClass, logClass: "unexplained",
    })));
    // When the module log agrees, nothing is written.
    const view = logLine(SESSION, at(30_050), "view 2 accepted (4 edits, no cut)");
    const agreed = await scan(["baseline-3", "cause-view_changed"].map((step) => metered(sampleRow(step))), [view]);
    expect(agreed.observations.get("cause-view_changed")?.class).toBe("view");
    expect(agreed.logs).toEqual([]);
});

test("a step's facts survive a saved watcher state for the next step's comparison", async () => {
    const [baseline, rewrite] = ["baseline-5", "cause-unexplained"].map((step) => metered(sampleRow(step)));
    const first = await scan([baseline!]);
    const saved = parseRunnerMonitorState(JSON.parse(JSON.stringify(first.args.state)));
    expect(Object.values(saved.heads)[0]!.last?.facts).toMatchObject({ view_version: 1, account_ref: "a".repeat(64) });
    const now = rewrite!.occurred_at_ms + 1000;
    const alerts: RunnerAlert[] = [];
    const args = {
        state: saved, source: source([rewrite!]), heads: headsFor([SESSION], []), root: "fixture-root",
        now, clock: () => now, deadline: now + 30_000, wakeAge: 30 * MINUTE,
        emit: async (alert: RunnerAlert) => { alerts.push(alert); },
    };
    await scanRunnerFeed(args);
    await scanRunnerFeed(args);
    expect(Object.values(saved.heads)[0]!.summary.at(-1)).toMatchObject({ class: "unexplained", cause: "unexplained" });
    // State saved before steps kept facts still loads.
    const old = JSON.parse(JSON.stringify(first.args.state));
    for (const head of Object.values(old.heads) as { last: { facts?: unknown } }[]) delete head.last.facts;
    expect(Object.values(parseRunnerMonitorState(old).heads)[0]!.last?.facts).toBeUndefined();
});
