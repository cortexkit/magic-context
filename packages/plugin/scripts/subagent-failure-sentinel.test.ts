import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    db.exec(readFileSync(join(import.meta.dir, "../../../crates/mc-module/tests/fixtures/context-db-schema.sql"), "utf8"));
    serial = 0;
});
afterEach(() => { db.close(false); rmSync(root, { recursive: true, force: true }); });

function add(status: string, time = NOW - 1_000, error = "failure code 42", task = "historian", subagent = "historian") {
    serial++;
    db.query("INSERT INTO subagent_invocations (session_id, harness, subagent, task, started_at, ended_at, status, error) VALUES (?, 'opencode', ?, ?, ?, ?, ?, ?)")
        .run(`session-${serial}`, subagent, task, time - 100, time, status, error);
}
async function run(now = NOW) {
    return runFailureSentinel({ db: join(root, "context.db"), stateFile: join(root, "state.json"), connectionFile: join(root, "none"), send: false, now: () => now, stdout: () => {}, stderr: () => {} });
}

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
    ).toBe("APIError: Insufficient Balance (request_id: <id>)");
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
        connectionFile: join(root, "none"), send: true, now: () => NOW,
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
