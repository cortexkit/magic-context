import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../src/shared/sqlite";
import { initializeDatabase } from "../src/features/magic-context/storage-db";
import { runMigrations } from "../src/features/magic-context/migrations";

import { normalizeError, runFailureSentinel } from "./subagent-failure-sentinel";

const DAY = 86_400_000;
const NOW = 2_000_000_000_000;
let root: string;
let db: Database;
let serial: number;

beforeEach(() => {
    mkdirSync(join(tmpdir(), "magic-context"), { recursive: true });
    root = mkdtempSync(join(tmpdir(), "magic-context", "subagent-failure-sentinel-"));
    db = new Database(join(root, "context.db"));
    initializeDatabase(db);
    runMigrations(db);
    serial = 0;
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

function add(status: string, time = NOW - 1_000, error = "failure code 42", task = "historian", subagent = "historian") {
    serial++;
    db.prepare("INSERT INTO subagent_invocations (session_id, harness, subagent, task, started_at, ended_at, status, error) VALUES (?, 'opencode', ?, ?, ?, ?, ?, ?)")
        .run(`session-${serial}`, subagent, task, time - 100, time, status, error);
}
// Inserts one attempt with explicit session, task and parent link, and returns its id.
function attempt(fields: { session: string; status: string; time: number; error?: string | null; task?: string | null; parent?: number | null; subagent?: string }): number {
    const row = db.prepare("INSERT INTO subagent_invocations (session_id, harness, subagent, task, started_at, ended_at, status, error, parent_invocation_id) VALUES (?, 'opencode', ?, ?, ?, ?, ?, ?, ?) RETURNING id")
        .get(fields.session, fields.subagent ?? "historian", fields.task ?? null, fields.time - 100, fields.time, fields.status, fields.error ?? null, fields.parent ?? null) as { id: number };
    return row.id;
}
// The existing cases judge rows the moment they end; the settle window has its own test.
async function run(now = NOW, settleMs = 0) {
    return runFailureSentinel({ db: join(root, "context.db"), stateFile: join(root, "state.json"), connectionFile: join(root, "none"), send: false, settleMs, now: () => now, stdout: () => {}, stderr: () => {} });
}

const QUOTA = "Historian host recorded an assistant error: APIError: Antigravity account pool has no account available within the configured wait limit.";

test("a quota failure recovered by a completed fallback raises no alert", async () => {
    for (let i = 0; i < 8; i++) {
        const primary = attempt({ session: `s-${i}`, status: "failed", time: NOW - 60_000 + i * 1_000, error: QUOTA });
        // Half the fallbacks record their parent link, half only share the session.
        attempt({ session: `s-${i}`, status: "completed", time: NOW - 30_000 + i * 1_000, task: "fallback", parent: i % 2 === 0 ? primary : null });
    }
    expect((await run()).alerts).toHaveLength(0);
});

test("two quota failures in a row recovered by a later completed fallback raise no alert", async () => {
    // Two models on one exhausted account pool both fail before the third model
    // in the chain completes.
    for (let i = 0; i < 8; i++) {
        const primary = attempt({ session: `q-${i}`, status: "failed", time: NOW - 60_000 + i * 1_000, error: QUOTA });
        const second = attempt({ session: `q-${i}`, status: "failed", time: NOW - 59_000 + i * 1_000, task: "fallback", parent: primary, error: QUOTA });
        attempt({ session: `q-${i}`, status: "completed", time: NOW - 30_000 + i * 1_000, task: "fallback", parent: second });
    }
    expect((await run()).alerts).toHaveLength(0);
});

test("a non-routine step in a completed chain stays eligible while the quota failure before it is excused", async () => {
    for (let i = 0; i < 8; i++) {
        const primary = attempt({ session: `r-${i}`, status: "failed", time: NOW - 60_000 + i * 1_000, error: QUOTA });
        const second = attempt({ session: `r-${i}`, status: "failed", time: NOW - 59_000 + i * 1_000, task: "fallback", parent: primary, error: "missing complete root element" });
        attempt({ session: `r-${i}`, status: "completed", time: NOW - 30_000 + i * 1_000, task: "fallback", parent: second });
    }
    const alerts = (await run()).alerts;
    expect(alerts.map((alert) => alert.rule)).toContain("failure_share");
    expect(alerts.some((alert) => alert.example_error.includes("missing complete root element"))).toBe(true);
    expect(alerts.some((alert) => alert.example_error.includes("account pool"))).toBe(false);
});

test("a quota failure whose chain completes after an empty fallback reply raises no quota alert", async () => {
    // Live shape 2026-10-26: the primary's account pool was exhausted, the first
    // fallback returned no output, and the next fallback completed the summary.
    for (let i = 0; i < 8; i++) {
        const primary = attempt({ session: `e-${i}`, status: "failed", time: NOW - 60_000 + i * 1_000, error: QUOTA });
        const empty = attempt({ session: `e-${i}`, status: "empty", time: NOW - 59_000 + i * 1_000, task: "fallback", parent: primary, error: "historian host completion returned no output" });
        attempt({ session: `e-${i}`, status: "completed", time: NOW - 30_000 + i * 1_000, task: "fallback", parent: empty });
    }
    const alerts = (await run()).alerts;
    expect(alerts.some((alert) => alert.example_error.includes("account pool"))).toBe(false);
});

test("a pre-send window refusal recovered by a completed fallback raises no alert", async () => {
    const WINDOW = "opencode/deepseek-v4.1-flash-free: producer_prompt_exceeds_window calibrated_tokens=287038 limit=162960 estimator_margin=0.03";
    for (let i = 0; i < 8; i++) {
        const primary = attempt({ session: `w-${i}`, status: "failed", time: NOW - 60_000 + i * 1_000, error: WINDOW });
        attempt({ session: `w-${i}`, status: "completed", time: NOW - 30_000 + i * 1_000, task: "fallback", parent: primary });
    }
    expect((await run()).alerts).toHaveLength(0);
});

test("a primary that timed out without answering, recovered by a completed fallback, raises no alert", async () => {
    const TIMEOUT = 'Error message=\'prompt timed out after 600000ms\'';
    for (let i = 0; i < 8; i++) {
        const primary = attempt({ session: `t-${i}`, status: "timed_out", time: NOW - 60_000 + i * 1_000, error: TIMEOUT });
        attempt({ session: `t-${i}`, status: "completed", time: NOW - 30_000 + i * 1_000, task: "fallback", parent: primary });
    }
    expect((await run()).alerts).toHaveLength(0);
});

test("a timeout with no completed fallback still alerts", async () => {
    const TIMEOUT = 'Error message=\'prompt timed out after 600000ms\'';
    for (let i = 0; i < 8; i++) {
        const primary = attempt({ session: `u-${i}`, status: "timed_out", time: NOW - 60_000 + i * 1_000, error: TIMEOUT });
        attempt({ session: `u-${i}`, status: "timed_out", time: NOW - 30_000 + i * 1_000, task: "fallback", parent: primary, error: TIMEOUT });
    }
    const rules = (await run()).alerts.map((alert) => alert.rule);
    expect(rules).toContain("failure_share");
});

test("a quota failure whose fallback also failed still alerts", async () => {
    for (let i = 0; i < 8; i++) {
        const primary = attempt({ session: `s-${i}`, status: "failed", time: NOW - 60_000 + i * 1_000, error: QUOTA });
        attempt({ session: `s-${i}`, status: "failed", time: NOW - 30_000 + i * 1_000, task: "fallback", parent: primary, error: "overloaded_error 529" });
    }
    const rules = (await run()).alerts.map((alert) => `${alert.rule}:${alert.task}`);
    expect(rules).toContain("new_class:(untitled)");
    expect(rules).toContain("failure_share:(untitled)");
});

test("a non-quota failure is not excused by its fallback", async () => {
    const primary = attempt({ session: "s", status: "failed", time: NOW - 60_000, error: "missing complete root element" });
    attempt({ session: "s", status: "completed", time: NOW - 30_000, task: "fallback", parent: primary });
    expect((await run()).alerts.map((alert) => alert.rule)).toContain("new_class");
});

test("an unlinked fallback in another session or outside the start window recovers nothing", async () => {
    attempt({ session: "a", status: "failed", time: NOW - 250_000, error: QUOTA });
    attempt({ session: "b", status: "completed", time: NOW - 240_000, task: "fallback" });
    attempt({ session: "c", status: "failed", time: NOW - 200_000, error: QUOTA });
    // Starts about 150 s after c failed, beyond the 120 s start window.
    attempt({ session: "c", status: "completed", time: NOW - 50_000, task: "fallback" });
    const alerts = (await run()).alerts.filter((alert) => alert.rule === "new_class");
    expect(alerts).toHaveLength(1);
    // Both failures still count, so neither unrelated fallback recovered one.
    expect(alerts[0]?.count).toBe(2);
});

test("a failure is judged only after the settle window, once its fallback has finished", async () => {
    const primary = attempt({ session: "s", status: "failed", time: NOW - 1_000, error: QUOTA });
    // Inside the default window the failure is not evaluated at all, and the
    // watermark stays before it.
    expect((await run(NOW, 5 * 60_000)).examined).toBe(0);
    attempt({ session: "s", status: "completed", time: NOW + 30_000, task: "fallback", parent: primary });
    expect((await run(NOW + 6 * 60_000, 5 * 60_000)).alerts).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(root, "state.json"), "utf8")).cursor.id).toBe(2);
});

test("new class alerts once and a seven-day prior class prevents a new-class wake", async () => {
    add("failed", NOW - 6 * DAY, "failure code 9");
    add("failed", NOW - 1_000, "failure code 42");
    expect((await run()).alerts.some((a) => a.rule === "new_class")).toBe(false);
    add("timed_out", NOW - 500, "different failure 7");
    const result = await run();
    expect(result.alerts.map((a) => a.rule)).toContain("new_class");
    expect(result.alerts[0]?.newest_session_id).toBe("session-3");
});

test("failure share crosses at eight runs and reports empty and aborted separately", async () => {
    for (let i = 0; i < 5; i++) add("completed");
    add("empty"); add("aborted"); add("failed");
    expect((await run()).alerts.some((a) => a.rule === "failure_share")).toBe(false);
    add("timed_out", NOW - 500);
    expect((await run()).alerts.some((a) => a.rule === "failure_share")).toBe(false);
    add("failed", NOW - 250);
    const alert = (await run()).alerts.find((a) => a.rule === "failure_share");
    expect(alert).toMatchObject({ count: 3, empty: 1, aborted: 1 });
    expect(alert?.share).toBeCloseTo(3 / 10);
});

test("a share alert is per task: a new failure class in the same burst does not re-fire it", async () => {
    for (let i = 0; i < 6; i++) add("completed");
    for (let i = 0; i < 4; i++) add("timed_out", NOW - 900 + i, "prompt timed out after 120000ms");
    const first = (await run()).alerts.find((a) => a.rule === "failure_share");
    expect(first).toMatchObject({ class: "*", count: 4 });
    // One more failure of a different class grows the task count 4 -> 5, below the
    // 50% re-alert threshold, so the share alert must stay quiet.
    add("failed", NOW - 500, "TimeoutError message=\"The operation timed out.\" code=23");
    expect((await run()).alerts.some((a) => a.rule === "failure_share")).toBe(false);
});

test("failure share alerts at exactly two of eight runs", async () => {
    for (let i = 0; i < 6; i++) add("completed");
    add("failed"); add("timed_out");
    const alert = (await run()).alerts.find((a) => a.rule === "failure_share");
    expect(alert?.share).toBe(0.25);
    expect(alert?.count).toBe(2);
});

test("class doubling compares the preceding 24 hours", async () => {
    add("failed", NOW - DAY - 1_000);
    add("failed", NOW - 1_000);
    expect((await run()).alerts.some((a) => a.rule === "class_doubled")).toBe(false);
    add("timed_out", NOW - 500);
    expect((await run()).alerts.some((a) => a.rule === "class_doubled")).toBe(true);
});

test("normalisation folds ids numbers durations and paths but preserves the failure class", () => {
    expect(normalizeError("job_abcdef failed /tmp/one/file after 20ms code 42"))
        .toBe(normalizeError("job_xyz123 failed /var/two/file after 7.5 seconds code 99"));
    expect(normalizeError("timeout 4ms")).not.toBe(normalizeError("permission denied 4ms"));
    // Provider request ids are standard 8-4-4-4-12 UUIDs; two failures that
    // differ only by request id are the same class.
    expect(
        normalizeError("APIError: Insufficient Balance (request_id: 6ccd58a4-fd7d-4695-ae30-b3cbd8c5b633)"),
    ).toBe(
        normalizeError("APIError: Insufficient Balance (request_id: 3f5266e0-127a-42d4-9a78-8f5c32e6bc8c)"),
    );
    expect(
        normalizeError("APIError: Insufficient Balance (request_id: 6ccd58a4-fd7d-4695-ae30-b3cbd8c5b633)"),
    ).not.toContain("<number>");
    // A request id cut short by the stored error's length limit is still an id.
    expect(normalizeError("Insufficient Balance (request_id: 1a52d1e8-50cb…")).toBe(
        normalizeError("Insufficient Balance (request_id: 885b3a6a-e982-40a3…"),
    );
    // A quota-reset countdown changes on every report of the same failure.
    expect(normalizeError("Account pool empty. Quota resets in 34h 34m 9s. (status=412)")).toBe(
        normalizeError("Account pool empty. Quota resets in 35h 45m 22s. (status=412)"),
    );
    expect(normalizeError("Quota resets in 2h")).toBe(normalizeError("Quota resets in 59m 3s"));
});

test("dedupe suppresses a wake for six hours unless class count grows by half", async () => {
    for (let i = 0; i < 5; i++) add("completed");
    for (let i = 0; i < 3; i++) add("failed");
    expect((await run()).alerts.some((a) => a.rule === "failure_share")).toBe(true);
    add("failed", NOW + 1_000);
    expect((await run(NOW + 2_000)).alerts).toHaveLength(0);
    add("failed", NOW + 3_000);
    expect((await run(NOW + 4_000)).alerts.map((a) => a.rule)).toContain("failure_share");
    expect((await run(NOW + 5_000)).alerts).toHaveLength(0);
});

test("one wake contains all alerting classes and uses the persisted watermark", async () => {
    add("failed", NOW - 1_000, "permission denied 17");
    add("timed_out", NOW - 500, "network timeout 2 seconds");
    const wakes: string[] = [];
    const result = await runFailureSentinel({
        db: join(root, "context.db"), stateFile: join(root, "state.json"),
        connectionFile: join(root, "none"), send: true, settleMs: 0, now: () => NOW,
        wake: async (content) => { wakes.push(content); }, stderr: () => {},
    });
    expect(result.alerts.map((alert) => alert.rule)).toEqual(["new_class", "new_class"]);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain("network timeout");
    expect(JSON.parse(readFileSync(join(root, "state.json"), "utf8")).cursor.id).toBe(2);
});

test("watermark resumes equal timestamps by id and bounds a backlog", async () => {
    for (let i = 0; i < 503; i++) add("completed");
    const first = await run();
    expect(first.examined).toBeLessThanOrEqual(501 + 5_001);
    expect(first.bounded).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "state.json"), "utf8")).cursor.id).toBe(500);
    const second = await run();
    expect(second.bounded).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "state.json"), "utf8")).cursor.id).toBe(503);
});
