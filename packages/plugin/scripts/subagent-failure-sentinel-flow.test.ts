// Checks that the basal flow in scripts/flows/mc-subagent-failure-sentinel
// raises exactly the alerts this directory's launchd sentinel raises on the
// same rows. Each case of subagent-failure-sentinel.test.ts is replayed through
// both: run by run, `step` compares their alerts, cursor, dedupe state and wake
// text, and the normalisation case compares the two `normalizeError`s directly. The flow runs under a small harness that stands in for basal's
// `ops.call`, `kv` and `sink`; its op answers from the same SQLite rows with the
// queries the script runs itself.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../src/shared/sqlite";
import { initializeDatabase } from "../src/features/magic-context/storage-db";
import { runMigrations } from "../src/features/magic-context/migrations";

import {
    type Alert,
    evaluateFailures,
    normalizeError,
    recoveredByFallback,
    runFailureSentinel,
} from "./subagent-failure-sentinel";

const FLOW_DIR = join(import.meta.dir, "../../../scripts/flows/mc-subagent-failure-sentinel");
const FLOW_SOURCE = readFileSync(join(FLOW_DIR, "flow.js"), "utf8");
const MAIN_MARKER = "// ---- The run ----";
const FIELDS = "id, session_id, subagent, task, started_at, ended_at, status, error, parent_invocation_id";
const SETTLE = 5 * 60_000;
const DAY = 86_400_000;
const NOW = 2_000_000_000_000;

type Row = Parameters<typeof evaluateFailures>[0][number];
type FlowPure = {
    normalizeError: typeof normalizeError;
    recoveredByFallback: typeof recoveredByFallback;
    evaluateFailures: typeof evaluateFailures;
};
type Digest = { agent: string; item: { title: string; body: string; data: Record<string, unknown> }; action: string; options?: { replace_key?: string } };
type FlowResult = {
    examined: number; alerts: number; bounded: boolean; evaluated: boolean; bootstrap_rows: number;
    tail_rows: number; stored_bytes: number; watermark: { ended_at: number; id: number };
};

// basal evaluates the script as the body of an async function.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

function loadFlowPure(): FlowPure {
    const cut = FLOW_SOURCE.indexOf(MAIN_MARKER);
    if (cut < 0) throw new Error("flow.js lost its run marker");
    const body = `${FLOW_SOURCE.slice(0, cut)}\nreturn { normalizeError, recoveredByFallback, evaluateFailures };`;
    return new Function(body)() as FlowPure;
}
const flow = loadFlowPure();

let root: string;
let db: Database;
let serial: number;
let kvStore: Map<string, unknown>;
let opCalls: Record<string, unknown>[];
let digests: Digest[];
let oldWakes: { content: string; id: string }[];

beforeEach(() => {
    mkdirSync(join(tmpdir(), "magic-context"), { recursive: true });
    root = mkdtempSync(join(tmpdir(), "magic-context", "subagent-failure-flow-"));
    db = new Database(join(root, "context.db"));
    // Fixture rows need no durability; without fsyncs the 5,000-row cases stay quick.
    db.exec("PRAGMA synchronous = OFF");
    initializeDatabase(db);
    runMigrations(db);
    serial = 0;
    kvStore = new Map();
    opCalls = [];
    digests = [];
    oldWakes = [];
    pageRows = 7;
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

function add(status: string, time = NOW - 1_000, error = "failure code 42", task = "historian", subagent = "historian") {
    serial++;
    db.prepare("INSERT INTO subagent_invocations (session_id, harness, subagent, task, started_at, ended_at, status, error) VALUES (?, 'opencode', ?, ?, ?, ?, ?, ?)")
        .run(`session-${serial}`, subagent, task, time - 100, time, status, error);
}
function attempt(fields: { session: string; status: string; time: number; error?: string | null; task?: string | null; parent?: number | null; subagent?: string }): number {
    const row = db.prepare("INSERT INTO subagent_invocations (session_id, harness, subagent, task, started_at, ended_at, status, error, parent_invocation_id) VALUES (?, 'opencode', ?, ?, ?, ?, ?, ?, ?) RETURNING id")
        .get(fields.session, fields.subagent ?? "historian", fields.task ?? null, fields.time - 100, fields.time, fields.status, fields.error ?? null, fields.parent ?? null) as { id: number };
    return row.id;
}

// Stands in for ck-mc's `subagent_invocations.read`, with the same arguments,
// limits and `{rows, more}` reply. ck-mc ends a page at a byte budget; here a
// page ends after `pageRows` rows, so the flow's multi-page reads are exercised
// against the script's single queries.
let pageRows: number;
function fakeOp(module: string, op: string, args: Record<string, unknown>) {
    expect([module, op]).toEqual(["magic-context", "subagent_invocations.read"]);
    opCalls.push(args);
    const limit = args.limit as number;
    let rows: Row[];
    if (args.query === "after_cursor") {
        expect(Object.keys(args).sort()).toEqual(["cursor", "limit", "query", "settled_before"]);
        expect(limit >= 1 && limit <= 500).toBe(true);
        const cursor = args.cursor as { ended_at: number; id: number };
        expect(Object.keys(cursor).sort()).toEqual(["ended_at", "id"]);
        rows = db.prepare(`SELECT ${FIELDS} FROM subagent_invocations WHERE ended_at IS NOT NULL AND ended_at <= ? AND (ended_at > ? OR (ended_at = ? AND id > ?)) ORDER BY ended_at, id LIMIT ?`)
            .all(args.settled_before as number, cursor.ended_at, cursor.ended_at, cursor.id, limit + 1) as Row[];
    } else {
        expect(args.query).toBe("window");
        expect(limit >= 1 && limit <= 5_000).toBe(true);
        const keys = Object.keys(args).sort();
        expect(keys).toEqual(args.before ? ["after", "before", "limit", "query", "until"] : ["after", "limit", "query", "until"]);
        const before = (args.before as { ended_at: number; id: number } | undefined) ?? { ended_at: (args.until as number) + 1, id: Number.MIN_SAFE_INTEGER };
        rows = db.prepare(`SELECT ${FIELDS} FROM subagent_invocations WHERE ended_at > ? AND ended_at <= ? AND (ended_at < ? OR (ended_at = ? AND id < ?)) ORDER BY ended_at DESC, id DESC LIMIT ?`)
            .all(args.after as number, args.until as number, before.ended_at, before.ended_at, before.id, limit + 1) as Row[];
    }
    const kept = rows.slice(0, Math.min(limit, pageRows));
    return { rows: kept, more: rows.length > kept.length };
}

// Bytes one run put in basal's journal, counted as basal records them: the full
// arguments and outcome of every `ops.call` and `kv` call. Reset per run.
let journalBytes = 0;
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) ?? "null").length;

async function runFlow(now: number, options: { replaceKeySupported?: boolean } = {}): Promise<FlowResult> {
    journalBytes = 0;
    const journal = <T>(args: unknown, result: T): T => {
        journalBytes += jsonBytes(args) + jsonBytes(result);
        return result;
    };
    // Values go through JSON, as basal's kv stores them, under basal's default
    // limits: 64 KiB of JSON per value and 1 MiB of keys and values per flow.
    const kv = {
        get: async (key: string) => journal([key], kvStore.has(key) ? JSON.parse(JSON.stringify(kvStore.get(key))) : null),
        set: async (key: string, value: unknown) => {
            expect(jsonBytes(value)).toBeLessThanOrEqual(64 * 1024);
            kvStore.set(key, JSON.parse(JSON.stringify(value)));
            expect(kvBytes()).toBeLessThanOrEqual(1024 * 1024);
            return journal([key, value], true);
        },
        delete: async (key: string) => journal([key], kvStore.delete(key)),
    };
    const digest = async (agent: string, item: Digest["item"], action: string, opts?: Digest["options"]) => {
        if (opts?.replace_key !== undefined && options.replaceKeySupported === false) {
            throw Object.assign(new Error("unsupported"), { data: { code: "digest_replace_key_unsupported" } });
        }
        digests.push({ agent, item, action, options: opts });
    };
    const ops = { call: async (module: string, op: string, args: Record<string, unknown>) => journal(args, JSON.parse(JSON.stringify(fakeOp(module, op, args)))) };
    const script = new AsyncFunction("ops", "kv", "sink", "Date", FLOW_SOURCE);
    return (await script(ops, kv, { digest }, { now: () => now })) as FlowResult;
}

// The flow's whole kv footprint: key and JSON value bytes.
function kvBytes(): number {
    let total = 0;
    for (const [key, value] of kvStore) total += new TextEncoder().encode(key).length + jsonBytes(value);
    return total;
}

async function runOld(now: number) {
    return runFailureSentinel({
        db: join(root, "context.db"), stateFile: join(root, "state.json"), connectionFile: join(root, "none"),
        send: true, now: () => now, stdout: () => {}, stderr: () => {},
        wake: async (content, id) => { oldWakes.push({ content, id }); },
    });
}

// The script's first run starts its cursor five minutes before `now`. The
// original cases judged rows the moment they ended, at NOW; here both run five
// minutes later with the real settle window, from that same starting cursor.
function seed(cursorEndedAt = NOW - SETTLE) {
    const state = { version: 1, cursor: { ended_at: cursorEndedAt, id: 0 }, sent: {} };
    writeFileSync(join(root, "state.json"), `${JSON.stringify(state)}\n`);
    kvStore.set("state", state);
}

// The part of the flow's kv state the script also keeps: its cursor, dedupe keys
// and the budget stops it holds (the flow never holds one, see flow.js).
function sharedState() {
    const { cursor, sent, pending } = kvStore.get("state") as {
        cursor: unknown;
        sent: unknown;
        pending?: unknown;
    };
    return { version: 1, cursor, sent, ...(pending === undefined ? {} : { pending }) };
}

// Runs both at `now`, requires identical outcomes, and returns the flow's alerts.
async function step(now: number): Promise<Alert[]> {
    const wakesBefore = oldWakes.length;
    const digestsBefore = digests.length;
    const old = await runOld(now);
    const flowed = await runFlow(now);
    const oldState = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    expect(sharedState()).toEqual(oldState);
    // `bounded` covers the same reads only when the flow evaluates, which it does
    // when a new row failed; otherwise it skips the evaluation the script made.
    if (flowed.evaluated) expect(flowed.bounded).toBe(old.bounded);
    expect(flowed.alerts).toBe(old.alerts.length);
    expect(flowed.watermark).toEqual(oldState.cursor);
    const newWakes = oldWakes.slice(wakesBefore);
    const newDigests = digests.slice(digestsBefore);
    expect(newDigests).toHaveLength(newWakes.length);
    if (!newWakes.length) return [];
    const [wake] = newWakes;
    const [sent] = newDigests;
    expect(sent.agent).toBe("MC");
    expect(sent.action).toBe("wake");
    expect(sent.options).toEqual({ replace_key: wake.id });
    expect(sent.item.body).toBe(wake.content);
    expect(sent.item.data).toEqual({ delivery_id: wake.id, alerts: old.alerts.length, bounded: old.bounded });
    const alerts = JSON.parse(sent.item.body.slice("Magic Context subagent failure sentinel: ".length)) as Alert[];
    expect(alerts).toEqual(old.alerts);
    return alerts;
}
const at = (now = NOW) => now + SETTLE;
const QUOTA = "Historian host recorded an assistant error: APIError: Antigravity account pool has no account available within the configured wait limit.";

// ---- The script's cases, replayed through both ----

// The one known difference (see flow.js's header): the script leaves out a
// dreamer budget stop whose dream task completed, reading the outcome from
// dream_runs; the flow cannot read run outcomes and counts it. Flip this test
// when `subagent_invocations.read` returns the run's outcome for such rows.
test("known difference: a dreamer budget stop whose task completed is left out by the script and counted by the flow", async () => {
    seed();
    const child = "ses_e3247cff8ffex5Zghx4fDip24A";
    const error = `DreamTokenBudgetExceeded message="Dreamer child ${child} spent 18891 prompt tokens (token_budget)"`;
    attempt({ session: "parent-1", status: "failed", time: NOW - 1_000, error, task: "verify", subagent: "dreamer" });
    db.prepare("INSERT OR REPLACE INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'opencode', ?, ?)")
        .run("parent-1", "/fixture/project", NOW);
    db.prepare("INSERT INTO dream_runs (project_path, started_at, finished_at, holder_id, tasks_json, tasks_succeeded, tasks_failed, smart_notes_surfaced, smart_notes_pending, memory_changes_json, parent_session_id) VALUES (?, ?, ?, 'fixture-holder', ?, 1, 0, 0, 0, NULL, ?)")
        .run("/fixture/project", NOW - 10_000, NOW - 500, JSON.stringify([{ name: "verify", status: "completed", children: [{ sessionId: child, promptTokens: 18_891 }] }]), "parent-1");
    const old = await runOld(at());
    const flowed = await runFlow(at());
    expect(old.alerts).toEqual([]);
    expect(flowed.alerts).toBeGreaterThan(0);
});

test("a quota failure recovered by a completed fallback raises no alert", async () => {
    seed();
    for (let i = 0; i < 8; i++) {
        const primary = attempt({ session: `s-${i}`, status: "failed", time: NOW - 60_000 + i * 1_000, error: QUOTA });
        attempt({ session: `s-${i}`, status: "completed", time: NOW - 30_000 + i * 1_000, task: "fallback", parent: i % 2 === 0 ? primary : null });
    }
    expect(await step(at())).toHaveLength(0);
});

test("a quota failure whose fallback also failed still alerts", async () => {
    seed();
    for (let i = 0; i < 8; i++) {
        const primary = attempt({ session: `s-${i}`, status: "failed", time: NOW - 60_000 + i * 1_000, error: QUOTA });
        attempt({ session: `s-${i}`, status: "failed", time: NOW - 30_000 + i * 1_000, task: "fallback", parent: primary, error: "overloaded_error 529" });
    }
    const rules = (await step(at())).map((alert) => `${alert.rule}:${alert.task}`);
    expect(rules).toContain("new_class:(untitled)");
    expect(rules).toContain("failure_share:(untitled)");
});

test("a non-quota failure is not excused by its fallback", async () => {
    seed();
    const primary = attempt({ session: "s", status: "failed", time: NOW - 60_000, error: "missing complete root element" });
    attempt({ session: "s", status: "completed", time: NOW - 30_000, task: "fallback", parent: primary });
    expect((await step(at())).map((alert) => alert.rule)).toContain("new_class");
});

test("an unlinked fallback in another session or outside the start window recovers nothing", async () => {
    seed();
    attempt({ session: "a", status: "failed", time: NOW - 250_000, error: QUOTA });
    attempt({ session: "b", status: "completed", time: NOW - 240_000, task: "fallback" });
    attempt({ session: "c", status: "failed", time: NOW - 200_000, error: QUOTA });
    attempt({ session: "c", status: "completed", time: NOW - 50_000, task: "fallback" });
    const alerts = (await step(at())).filter((alert) => alert.rule === "new_class");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.count).toBe(2);
});

test("a failure is judged only after the settle window, once its fallback has finished", async () => {
    seed();
    const primary = attempt({ session: "s", status: "failed", time: NOW - 1_000, error: QUOTA });
    // Inside the window nothing is examined and the cursor stays before the failure.
    expect(await step(NOW)).toHaveLength(0);
    expect(kvStore.get("state")).toMatchObject({ cursor: { ended_at: NOW - SETTLE, id: 0 } });
    attempt({ session: "s", status: "completed", time: NOW + 30_000, task: "fallback", parent: primary });
    expect(await step(NOW + 6 * 60_000)).toHaveLength(0);
    expect(kvStore.get("state")).toMatchObject({ cursor: { id: 2 } });
});

test("new class alerts once and a seven-day prior class prevents a new-class wake", async () => {
    seed();
    add("failed", NOW - 6 * DAY, "failure code 9");
    add("failed", NOW - 1_000, "failure code 42");
    expect((await step(at())).some((a) => a.rule === "new_class")).toBe(false);
    add("timed_out", NOW - 500, "different failure 7");
    const alerts = await step(at());
    expect(alerts.map((a) => a.rule)).toContain("new_class");
    expect(alerts[0]?.newest_session_id).toBe("session-3");
});

test("failure share crosses at eight runs and reports empty and aborted separately", async () => {
    seed();
    for (let i = 0; i < 5; i++) add("completed");
    add("empty"); add("aborted"); add("failed");
    expect((await step(at())).some((a) => a.rule === "failure_share")).toBe(false);
    add("timed_out", NOW - 500);
    expect((await step(at())).some((a) => a.rule === "failure_share")).toBe(false);
    add("failed", NOW - 250);
    const alert = (await step(at())).find((a) => a.rule === "failure_share");
    expect(alert).toMatchObject({ count: 3, empty: 1, aborted: 1 });
    expect(alert?.share).toBeCloseTo(3 / 10);
});

test("a share alert is per task: a new failure class in the same burst does not re-fire it", async () => {
    seed();
    for (let i = 0; i < 6; i++) add("completed");
    for (let i = 0; i < 4; i++) add("timed_out", NOW - 900 + i, "prompt timed out after 120000ms");
    expect((await step(at())).find((a) => a.rule === "failure_share")).toMatchObject({ class: "*", count: 4 });
    add("failed", NOW - 500, "TimeoutError message=\"The operation timed out.\" code=23");
    expect((await step(at())).some((a) => a.rule === "failure_share")).toBe(false);
});

test("failure share alerts at exactly two of eight runs", async () => {
    seed();
    for (let i = 0; i < 6; i++) add("completed");
    add("failed"); add("timed_out");
    const alert = (await step(at())).find((a) => a.rule === "failure_share");
    expect(alert?.share).toBe(0.25);
    expect(alert?.count).toBe(2);
});

test("class doubling compares the preceding 24 hours", async () => {
    seed();
    add("failed", NOW - DAY - 1_000);
    add("failed", NOW - 1_000);
    expect((await step(at())).some((a) => a.rule === "class_doubled")).toBe(false);
    add("timed_out", NOW - 500);
    expect((await step(at())).some((a) => a.rule === "class_doubled")).toBe(true);
});

test("normalisation folds ids numbers durations and paths but preserves the failure class", () => {
    const pairs: [string, string][] = [
        ["job_abcdef failed /tmp/one/file after 20ms code 42", "job_xyz123 failed /var/two/file after 7.5 seconds code 99"],
        ["timeout 4ms", "permission denied 4ms"],
        ["APIError: Insufficient Balance (request_id: 6ccd58a4-fd7d-4695-ae30-b3cbd8c5b633)", "APIError: Insufficient Balance (request_id: 3f5266e0-127a-42d4-9a78-8f5c32e6bc8c)"],
        ["Insufficient Balance (request_id: 1a52d1e8-50cb…", "Insufficient Balance (request_id: 885b3a6a-e982-40a3…"],
        ["Account pool empty. Quota resets in 34h 34m 9s. (status=412)", "Account pool empty. Quota resets in 35h 45m 22s. (status=412)"],
        ["Quota resets in 2h", "Quota resets in 59m 3s"],
    ];
    for (const [left, right] of pairs) {
        expect(flow.normalizeError(left)).toBe(normalizeError(left));
        expect(flow.normalizeError(right)).toBe(normalizeError(right));
        expect(flow.normalizeError(left) === flow.normalizeError(right)).toBe(normalizeError(left) === normalizeError(right));
    }
    expect(flow.normalizeError(null)).toBe(normalizeError(null));
});

test("dedupe suppresses a wake for six hours unless class count grows by half", async () => {
    seed();
    for (let i = 0; i < 5; i++) add("completed");
    for (let i = 0; i < 3; i++) add("failed");
    expect((await step(at())).some((a) => a.rule === "failure_share")).toBe(true);
    add("failed", NOW + 1_000);
    expect(await step(at(NOW + 2_000))).toHaveLength(0);
    add("failed", NOW + 3_000);
    expect((await step(at(NOW + 4_000))).map((a) => a.rule)).toContain("failure_share");
    expect(await step(at(NOW + 5_000))).toHaveLength(0);
    // Six hours on, the held keys expire in both.
    add("failed", NOW + 6 * 3_600_000);
    await step(at(NOW + 6 * 3_600_000 + 1_000));
});

test("one wake contains all alerting classes and uses the persisted watermark", async () => {
    seed();
    add("failed", NOW - 1_000, "permission denied 17");
    add("timed_out", NOW - 500, "network timeout 2 seconds");
    const alerts = await step(at());
    expect(alerts.map((alert) => alert.rule)).toEqual(["new_class", "new_class"]);
    expect(digests).toHaveLength(1);
    expect(digests[0]?.item.body).toContain("network timeout");
    expect(kvStore.get("state")).toMatchObject({ cursor: { id: 2 } });
});

test("watermark resumes equal timestamps by id and bounds a backlog", async () => {
    seed();
    db.transaction(() => {
        for (let i = 0; i < 503; i++) add("completed");
    })();
    const first = await runFlow(at());
    await runOld(at());
    expect(first.bounded).toBe(true);
    expect(sharedState()).toEqual(JSON.parse(readFileSync(join(root, "state.json"), "utf8")));
    expect(kvStore.get("state")).toMatchObject({ cursor: { id: 500 } });
    await step(at());
    expect(kvStore.get("state")).toMatchObject({ cursor: { id: 503 } });
});

// ---- Cases the script's suite does not cover ----

test("a first run without state starts five minutes back, as the script did", async () => {
    add("failed", NOW - 1_000, "permission denied 17");
    expect(await step(NOW)).toHaveLength(0);
    expect(kvStore.get("state")).toMatchObject({ cursor: { ended_at: NOW - SETTLE, id: 0 } });
    expect(await step(at())).toHaveLength(1);
});

test("a backlog of failures pages through both queries and still matches", async () => {
    seed();
    for (let i = 0; i < 520; i++) {
        add(i % 3 === 0 ? "failed" : "completed", NOW - 100_000 + i, `failure code ${i % 4} in /tmp/a/b`, `task-${i % 5}`);
    }
    await step(at());
    await step(at());
    expect(kvStore.get("state")).toMatchObject({ cursor: { id: 520 } });
    // Both history and new rows took several pages.
    expect(opCalls.filter((call) => call.query === "window" && call.before).length).toBeGreaterThan(1);
    expect(opCalls.filter((call) => call.query === "after_cursor").length).toBeGreaterThan(70);
});

test("a history over 5,000 rows holds back the window rules in both", async () => {
    // Larger pages keep this case quick; the backlog case covers small ones.
    pageRows = 1_000;
    seed();
    db.transaction(() => {
        for (let i = 0; i < 5_001; i++) add("completed", NOW - 2 * DAY + i);
    })();
    add("failed", NOW - 1_000, "first failure of its kind");
    const flowed = await runFlow(at());
    const old = await runOld(at());
    expect(flowed.evaluated).toBe(true);
    // The cold start's seven-day read stops at 5,000 rows, as the script's did.
    expect(flowed.bootstrap_rows).toBe(5_000);
    expect(flowed.bounded).toBe(old.bounded);
    expect(flowed.bounded).toBe(true);
    expect(flowed.alerts).toBe(old.alerts.length);
    expect(old.alerts.some((alert) => alert.rule === "new_class")).toBe(false);
}, 30_000);

test("an oversized wake keeps whole alerts within the digest body limit", async () => {
    seed();
    for (let i = 0; i < 30; i++) add("failed", NOW - 1_000 + i, `unique failure ${"x".repeat(400)} kind-${String.fromCharCode(97 + (i % 26))}${i}`, `task-${i}`);
    const result = await runFlow(at());
    expect(result.alerts).toBeGreaterThan(5);
    const [sent] = digests;
    expect(new TextEncoder().encode(sent!.item.body).length).toBeLessThanOrEqual(4096);
    expect(sent!.item.body).toMatch(/\(\d+ more alerts? not shown\)$/);
    expect(sent!.item.data.alerts).toBe(result.alerts);
});

test("a core without replace_key support still gets the wake", async () => {
    seed();
    add("failed", NOW - 1_000, "permission denied 17");
    await runFlow(at(), { replaceKeySupported: false });
    expect(digests).toHaveLength(1);
    expect(digests[0]?.options).toBeUndefined();
    expect(digests[0]?.action).toBe("wake");
});

test("a corrupt stored state stops the run instead of resetting the cursor", async () => {
    kvStore.set("state", { version: 99, cursor: { ended_at: 1, id: 1 }, sent: {} });
    await expect(runFlow(at())).rejects.toThrow("invalid failure sentinel state");
    // A current-version state without its record bookkeeping is corrupt too.
    kvStore.set("state", { version: 2, cursor: { ended_at: 1, id: 1 }, sent: {} });
    await expect(runFlow(at())).rejects.toThrow("invalid failure sentinel state");
});

// ---- Incremental runs against the script's full re-evaluation ----
//
// After its first run the flow judges new rows against what it stored, not a
// fresh seven-day read. These sequences run both at every step over more than
// seven days, so each comparison covers hours leaving the records, failures
// moving into the older-failure summary, and their expiry.

const HOUR = 3_600_000;

// Window reads spanning more than two days. Only a cold start makes one; the
// tail read on an evaluating run spans just the rows after the new ones.
function longWindowReads(since: number) {
    return opCalls.slice(since).filter((call) => call.query === "window" && (call.until as number) - (call.after as number) > 2 * DAY);
}

test("incremental runs match full re-evaluation across the 24-hour, 48-hour and 7-day edges", async () => {
    seed();
    const B = NOW;
    // Seven-day edge: two classes whose only earlier failure is a millisecond apart.
    attempt({ session: "k0", status: "failed", time: B + 1_000, error: "edge class K", task: "edge-k" });
    attempt({ session: "l0", status: "failed", time: B + 1_001, error: "edge class L", task: "edge-l" });
    // A quota failure recovered by its fallback: it must not count as an earlier
    // failure once it has moved into the summary.
    const quota = attempt({ session: "q0", status: "failed", time: B + 2_000, error: QUOTA, task: "quota-y" });
    attempt({ session: "q0", status: "completed", time: B + 30_000, task: "fallback", parent: quota });
    // Day 3: the same quota class, but its fallback fails too.
    const quota2 = attempt({ session: "q1", status: "failed", time: B + 3 * DAY + 1_000, error: QUOTA, task: "quota-y" });
    attempt({ session: "q1", status: "failed", time: B + 3 * DAY + 31_000, task: "fallback", parent: quota2, error: "overloaded 529" });
    // A quota failure whose fallback has not settled yet at its run: only the unsettled tail recovers it.
    const Rp = B + 2 * DAY + 5 * HOUR;
    const tailPrimary = attempt({ session: "t0", status: "failed", time: Rp - SETTLE - 1_000, error: QUOTA, task: "tail-z" });
    attempt({ session: "t0", status: "completed", time: Rp - 60_000, task: "fallback", parent: tailPrimary });
    // 24-hour edge: the share rule must count the row 1 ms inside the day and not the one on its edge.
    const Rs = B + 5 * DAY + 12_345;
    for (let i = 0; i < 5; i++) attempt({ session: `x${i}`, status: "completed", time: Rs - 20 * HOUR + i, task: "share-x" });
    attempt({ session: "x5", status: "failed", time: Rs - 10 * HOUR, error: "share failure 1", task: "share-x" });
    attempt({ session: "x6", status: "completed", time: Rs - DAY, task: "share-x" });
    attempt({ session: "x7", status: "empty", time: Rs - DAY + 1, task: "share-x" });
    attempt({ session: "x8", status: "failed", time: Rs - SETTLE - 1_000, error: "share failure 2", task: "share-x" });
    // 48-hour edge: the doubling rule's prior day starts 1 ms after `now - 48h`.
    const Rd = B + 6 * DAY + 777;
    attempt({ session: "d0", status: "failed", time: Rd - 2 * DAY, error: "doubling class D", task: "double" });
    attempt({ session: "d1", status: "failed", time: Rd - 2 * DAY + 1, error: "doubling class D", task: "double" });
    attempt({ session: "d2", status: "failed", time: Rd - 3 * HOUR, error: "doubling class D", task: "double" });
    attempt({ session: "d3", status: "failed", time: Rd - SETTLE - 500, error: "doubling class D", task: "double" });
    // Class E has two failures just inside its prior day and three in the current
    // one, so it has not doubled; counting only one of the prior pair would say it had.
    attempt({ session: "e1", status: "failed", time: Rd - 2 * DAY + 1, error: "doubling class E", task: "double-e" });
    attempt({ session: "e2", status: "failed", time: Rd - 2 * DAY + 2, error: "doubling class E", task: "double-e" });
    attempt({ session: "e3", status: "failed", time: Rd - 5 * HOUR, error: "doubling class E", task: "double-e" });
    attempt({ session: "e4", status: "failed", time: Rd - 4 * HOUR, error: "doubling class E", task: "double-e" });
    attempt({ session: "e5", status: "failed", time: Rd - SETTLE - 400, error: "doubling class E", task: "double-e" });
    // Seven days after K's failure, K's is gone from the window and L's is not.
    // The regular run at B + 7d settles rows up to 1 s before R7's bound, so these land in R7.
    const R7 = B + 1_000 + 7 * DAY;
    attempt({ session: "k1", status: "failed", time: R7 - SETTLE - 500, error: "edge class K", task: "edge-k" });
    attempt({ session: "l1", status: "failed", time: R7 - SETTLE - 499, error: "edge class L", task: "edge-l" });

    const R0 = B + 30_000 + SETTLE + 60_000;
    const Rq = B + 3 * DAY + 31_000 + SETTLE + 1;
    const runs = new Set([R0, Rp, Rq, Rs, Rd, R7]);
    for (let t = B + 6 * HOUR; t <= B + 8 * DAY; t += 6 * HOUR) runs.add(t);
    const byRun = new Map<number, Alert[]>();
    let afterBootstrap = 0;
    for (const run of [...runs].sort((a, b) => a - b)) {
        byRun.set(run, await step(run));
        if (run === R0) afterBootstrap = opCalls.length;
        // The state never holds records older than the hour before `now - 48h`.
        const hours = [...kvStore.keys()].filter((key) => key.startsWith("hour:")).map((key) => Number(key.slice(5, key.indexOf("#"))));
        expect(hours.every((hour) => hour >= Math.floor((run - 2 * DAY) / HOUR) - 1)).toBe(true);
    }
    // Only the first run read the seven-day window; every later one was incremental.
    expect(longWindowReads(afterBootstrap)).toEqual([]);
    expect([...kvStore.keys()].some((key) => key.startsWith("older#"))).toBe(true);
    const rules = (run: number) => byRun.get(run)!.map((alert) => `${alert.rule}:${alert.task}`).sort();
    expect(rules(R0)).toEqual(["new_class:edge-k", "new_class:edge-l"]);
    expect(rules(Rp)).toEqual([]);
    expect(rules(Rq)).toContain("new_class:quota-y");
    expect(byRun.get(Rs)!.find((alert) => alert.rule === "failure_share")).toMatchObject({ task: "share-x", count: 2, share: 0.25, empty: 1 });
    expect(byRun.get(Rd)!.filter((alert) => alert.rule === "class_doubled")).toMatchObject([{ task: "double", count: 2 }]);
    expect(rules(R7)).toEqual(["new_class:edge-k"]);
}, 30_000);

test("incremental runs match full re-evaluation on generated traffic over nine days", async () => {
    seed();
    const pick = generator(7);
    const tasks = ["historian", "classify", null, "verify"];
    const statuses = ["completed", "completed", "completed", "failed", "timed_out", "empty", "aborted"];
    db.transaction(() => {
        for (let i = 0; i < 700; i++) {
            const time = NOW + pick(9 * DAY);
            const status = statuses[pick(statuses.length)]!;
            const session = `g-${pick(40)}`;
            const subagent = pick(4) ? "historian" : "dreamer";
            const id = attempt({ session, status, time, error: status === "failed" || status === "timed_out" ? GENERATED_ERRORS[pick(GENERATED_ERRORS.length)] : null, task: tasks[pick(tasks.length)]!, subagent });
            // Half the failures get a fallback, linked or not, finishing or failing,
            // inside or outside the unlinked match window, sometimes after the settle window.
            if ((status === "failed" || status === "timed_out") && pick(2) === 0) {
                attempt({
                    session: pick(6) ? session : "g-other", subagent, task: "fallback",
                    status: pick(3) ? "completed" : "failed", time: time + 1_000 + pick(15 * 60_000),
                    parent: pick(2) ? id : null, error: null,
                });
            }
        }
    })();
    let alerted = 0;
    let run = NOW;
    while (run < NOW + 10 * DAY) {
        run += HOUR + pick(5 * HOUR);
        if ((await step(run)).length) alerted++;
    }
    // The traffic reaches the rules often enough for the comparison to mean something.
    expect(alerted).toBeGreaterThan(5);
}, 60_000);

// ---- The evaluation alone, on generated rows ----

// A small deterministic generator, so a failure names a reproducible trial.
function generator(seed: number) {
    // Small seeds give small first values, so spread them before use.
    let value = (seed * 2_654_435) % 2_147_483_647;
    return (n: number) => {
        // Park-Miller: every product stays exact in a double.
        value = (value * 48_271) % 2_147_483_647;
        return Math.floor((value / 2_147_483_647) * n);
    };
}

type GeneratedCase = { rows: Row[]; fresh: Row[]; completeSince: number };
const GENERATED_ERRORS = [null, QUOTA, "rate limit hit after 20ms", "missing root at /a/b/c", "HTTP 429 too many requests", "boom code 7", "boom code 8", "Quota resets in 34h 34m 9s (request_id: 1a52d1e8-50cb"];

function generatedCases(trials: number): GeneratedCase[] {
    const statuses = ["completed", "completed", "failed", "timed_out", "empty", "aborted"];
    const cases: GeneratedCase[] = [];
    for (let trial = 1; trial <= trials; trial++) {
        const pick = generator(trial);
        const rows: Row[] = [];
        const count = 5 + pick(60);
        for (let id = 1; id <= count; id++) {
            const ended = NOW - pick(3 * DAY);
            const linked = rows.length && pick(4) === 0 ? rows[pick(rows.length)]!.id : null;
            const row: Row = {
                id, session_id: `s-${pick(4)}`, harness: "opencode", subagent: pick(5) ? "historian" : "dreamer",
                task: [null, "fallback", "historian", "classify"][pick(4)]!,
                started_at: ended - pick(200_000), ended_at: ended,
                status: statuses[pick(statuses.length)]!, error: GENERATED_ERRORS[pick(GENERATED_ERRORS.length)]!,
                parent_invocation_id: linked,
            };
            rows.push(row);
            // Often follow a failure with a fallback attempt: linked or not, finished or
            // failed, starting inside or outside the unlinked fallback's start window.
            if ((row.status === "failed" || row.status === "timed_out") && pick(2) === 0 && id < count) {
                id++;
                const started = row.ended_at - 6_000 + pick(130_000);
                rows.push({
                    id, session_id: pick(5) ? row.session_id : "s-other", harness: "opencode", subagent: row.subagent, task: "fallback",
                    started_at: started, ended_at: started + pick(60_000),
                    status: pick(3) ? "completed" : "failed", error: null,
                    parent_invocation_id: pick(2) ? row.id : null,
                });
            }
        }
        rows.sort((a, b) => b.ended_at - a.ended_at || b.id - a.id);
        const fresh = rows.filter((row) => row.ended_at > NOW - DAY && pick(2) === 0)
            .sort((a, b) => a.ended_at - b.ended_at || a.id - b.id);
        const completeSince = pick(3) === 0 ? NOW - pick(3 * DAY) : NOW - 7 * DAY;
        cases.push({ rows, fresh, completeSince });
    }
    return cases;
}
const byNumber = (a: number, b: number) => a - b;

test("evaluateFailures and recoveredByFallback agree on generated rows", () => {
    let alerted = 0;
    let recovered = 0;
    for (const { rows, fresh, completeSince } of generatedCases(300)) {
        const expectedRecovered = [...recoveredByFallback(rows)].sort(byNumber);
        expect([...flow.recoveredByFallback(rows)].sort(byNumber)).toEqual(expectedRecovered);
        const expected = evaluateFailures(rows, fresh, NOW, completeSince);
        expect(flow.evaluateFailures(rows, fresh, NOW, completeSince)).toEqual(expected);
        alerted += expected.length ? 1 : 0;
        recovered += expectedRecovered.length ? 1 : 0;
    }
    // The generated rows reach every outcome the comparison is meant to cover.
    expect(alerted).toBeGreaterThan(80);
    expect(alerted).toBeLessThan(280);
    expect(recovered).toBeGreaterThan(100);
});

// basal runs flows in QuickJS, not JavaScriptCore. This checks that the script
// parses as basal's async-function body there, and that its evaluation gives
// the script's results on the generated rows under QuickJS's own regex engine.
test("the flow parses and evaluates identically under QuickJS", async () => {
    const [{ default: variant }, { newQuickJSAsyncWASMModuleFromVariant }] = await Promise.all([
        import("@jitl/quickjs-singlefile-cjs-release-asyncify"),
        import("quickjs-emscripten"),
    ]);
    const quickjs = await newQuickJSAsyncWASMModuleFromVariant(variant);
    const vm = quickjs.newContext();
    try {
        const evaluate = (code: string): unknown => {
            const handle = vm.unwrapResult(vm.evalCode(code));
            try {
                return vm.dump(handle);
            } finally {
                handle.dispose();
            }
        };
        expect(evaluate(`typeof (async function (ops, kv, sink) {\n${FLOW_SOURCE}\n})`)).toBe("function");
        const cases = generatedCases(60);
        const pure = FLOW_SOURCE.slice(0, FLOW_SOURCE.indexOf(MAIN_MARKER));
        const answer = evaluate(`${pure}
            JSON.stringify(${JSON.stringify(cases)}.map((c) => ({
                alerts: evaluateFailures(c.rows, c.fresh, ${NOW}, c.completeSince),
                recovered: Array.from(recoveredByFallback(c.rows)).sort((a, b) => a - b),
            })).concat([${JSON.stringify(GENERATED_ERRORS)}.map(normalizeError)]))`) as string;
        const expected = [
            ...cases.map(({ rows, fresh, completeSince }) => ({
                alerts: evaluateFailures(rows, fresh, NOW, completeSince),
                recovered: [...recoveredByFallback(rows)].sort(byNumber),
            })),
            GENERATED_ERRORS.map(normalizeError),
        ];
        expect(JSON.parse(answer)).toEqual(JSON.parse(JSON.stringify(expected)));
    } finally {
        vm.dispose();
    }
});

for (const middleStatus of ["failed", "empty", "aborted"] as const) {
    test(`persisted ${middleStatus} fallback chains survive retirement after more than two hours`, async () => {
        seed(NOW - SETTLE);
        const first = attempt({ session: "chain", status: "failed", time: NOW, error: QUOTA, task: "chain-main" });
        const middle = attempt({ session: "chain", status: middleStatus, time: NOW + HOUR, error: middleStatus === "failed" ? QUOTA : null, task: "fallback", parent: first });
        await step(at(NOW + HOUR));

        const later = attempt({ session: "chain", status: "timed_out", time: NOW + 2 * HOUR, error: "prompt timed out after 3600000ms", task: "fallback" });
        db.prepare("UPDATE subagent_invocations SET started_at=(SELECT ended_at+1000 FROM subagent_invocations WHERE id=?) WHERE id=?").run(middle, later);
        attempt({ session: "chain", status: "completed", time: NOW + 3 * HOUR, task: "fallback", parent: later });
        for (let index = 1; index <= 6; index++)
            attempt({ session: `other-${index}`, status: "completed", time: NOW + 3 * HOUR + index * 1_000, task: "chain-main" });
        for (let index = 7; index <= 8; index++)
            attempt({ session: `new-${index}`, status: "failed", time: NOW + 3 * HOUR + index * 1_000, error: QUOTA, task: "chain-main" });
        const alerts = await step(at(NOW + 3 * HOUR + 20_000));
        const shares = alerts.filter((alert) => alert.rule === "failure_share" && alert.task === "chain-main");
        expect(shares).toHaveLength(1);
        expect(shares[0]!.count).toBe(2);
        const primaryHour = Math.floor(NOW / HOUR);
        expect((kvStore.get("state") as { hours: number[][] }).hours.some((hour) => hour[0] === primaryHour)).toBe(true);
        const retiringKeys = [...kvStore.keys()].filter((key) => key.startsWith(`hour:${primaryHour}#`));
        expect(retiringKeys.length).toBeGreaterThan(0);

        const retirement = (Math.floor(NOW / HOUR) + 2) * HOUR + 2 * DAY;
        await step(retirement);
        expect((kvStore.get("state") as { hours: number[][] }).hours.some((hour) => hour[0] === primaryHour)).toBe(false);
        for (const key of retiringKeys) expect(kvStore.has(key)).toBe(false);
        expect(kvStore.has("older#0")).toBe(false);
        expect(kvBytes()).toBeLessThanOrEqual(1024 * 1024);
    });
}

test("version 3 state without record bookkeeping refuses without advancing its cursor", async () => {
    const cursor = { ended_at: NOW - SETTLE, id: 0 };
    kvStore.set("state", { version: 3, cursor, sent: {} });
    await expect(runFlow(NOW)).rejects.toThrow("invalid failure sentinel state");
    expect((kvStore.get("state") as { cursor: unknown }).cursor).toEqual(cursor);
});

for (const mixed of [false, true]) {
    test(`version 2 ${mixed ? "mixed" : "legacy"} records rebootstrap links without losing cursor or dedupe`, async () => {
        seed(NOW - 30 * 60_000);
        const first = attempt({ session: "migration", status: "failed", time: NOW - 20 * 60_000, error: "producer_prompt_exceeds_window", task: "migration-main" });
        const middle = attempt({ session: "migration", status: "failed", time: NOW - 10 * 60_000, error: QUOTA, task: "fallback", parent: first });
        attempt({ session: "migration", status: "completed", time: NOW - 9 * 60_000, task: "fallback", parent: middle });
        await step(at(NOW));

        type Stored = { version: number; cursor: { ended_at: number; id: number }; sent: Record<string, { at: number; count: number }>; hours: [number, number, number][]; older_bytes: number };
        type Part = { g: unknown[]; r: unknown[][] };
        const state = kvStore.get("state") as Stored;
        const cursor = { ...state.cursor };
        const sent = { at: NOW, count: 1 };
        const dedupeKey = JSON.stringify(["new_class", "historian", "dedupe-main", "rate limit"]);
        state.version = 2;
        state.sent[dedupeKey] = sent;
        const referencePath = join(root, "state.json");
        const reference = JSON.parse(readFileSync(referencePath, "utf8"));
        reference.sent[dedupeKey] = sent;
        writeFileSync(referencePath, `${JSON.stringify(reference)}\n`);
        for (const hour of state.hours) {
            let bytes = 0;
            for (let index = 0; index < hour[1]; index++) {
                const part = kvStore.get(`hour:${hour[0]}#${index}`) as Part;
                for (const record of part.r) {
                    if (record[3] === 1 || record[3] === 2) {
                        if (!mixed || record[0] !== middle) record.length = 7;
                        // The old predicate did not mark pre-send refusals routine.
                        if (record[0] === first) record[5] = 0;
                    } else if (record[3] !== 0) record.length = 4;
                }
                bytes += jsonBytes(part);
            }
            hour[2] = bytes;
        }
        const oldSummary = { g: [["historian", "stale"]], r: [[0, "aaaaaaaaaaaaaaaa", NOW - 3 * DAY]] };
        kvStore.set("older#0", oldSummary);
        kvStore.set("older#1", oldSummary);
        state.older_bytes = 2 * jsonBytes(oldSummary);
        const beforeReads = opCalls.length;
        await step(at(NOW + 60_000));
        const upgraded = kvStore.get("state") as Stored;
        expect(upgraded.version).toBe(3);
        expect(upgraded.cursor).toEqual(cursor);
        expect(upgraded.sent[dedupeKey]).toEqual(sent);
        expect(opCalls.slice(beforeReads).some((call) => call.query === "window" && call.after === at(NOW + 60_000) - 7 * DAY && call.until === cursor.ended_at)).toBe(true);
        expect(kvStore.has("older#0")).toBe(false);
        expect(kvStore.has("older#1")).toBe(false);
        const records = [...kvStore.entries()]
            .filter(([key]) => key.startsWith("hour:"))
            .flatMap(([, part]) => (part as Part).r);
        expect(records.find((record) => record[0] === first)![5]).toBe(1);
        expect(records.find((record) => record[0] === middle)![7]).toBe(first);
        expect(kvBytes()).toBeLessThanOrEqual(1024 * 1024);

        attempt({ session: "new-work", status: "failed", time: NOW + 2 * 60_000, error: "producer_prompt_exceeds_window", task: "migration-main" });
        attempt({ session: "deduped-work", status: "failed", time: NOW + 2 * 60_000 + 1, error: "rate limit", task: "dedupe-main" });
        const alerts = await step(at(NOW + 3 * 60_000));
        expect(alerts.some((alert) => alert.rule === "new_class" && alert.task === "migration-main")).toBe(true);
        expect(alerts.some((alert) => alert.task === "dedupe-main")).toBe(false);
    });
}

for (const routine of [false, true]) {
    test(`retiring a ${routine ? "routine" : "non-routine"} first attempt behind a cursor backlog records exact completeness`, async () => {
        const firstTime = NOW - 3 * DAY;
        seed(firstTime - SETTLE);
        const first = attempt({ session: "backlog", status: "failed", time: firstTime, error: routine ? QUOTA : "missing credentials", task: "backlog-main" });
        await runFlow(at(firstTime));
        const before = (kvStore.get("state") as { complete_since: number }).complete_since;
        for (let index = 1; index <= 600; index++)
            attempt({ session: `filler-${index}`, status: "completed", time: firstTime + index * 1_000, task: "unrelated" });
        attempt({ session: "backlog", status: "completed", time: firstTime + 601_000, task: "fallback", parent: first });
        const page = await runFlow(NOW);
        expect(page.bounded).toBe(true);
        expect(page.watermark.ended_at).toBe(firstTime + 500_000);
        const state = kvStore.get("state") as { complete_since: number };
        expect(state.complete_since).toBe(routine ? (Math.floor(firstTime / HOUR) + 1) * HOUR : before);
    });
}
