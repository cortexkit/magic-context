import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamTokenBudgetExceeded } from "../src/features/magic-context/dreamer/token-budget";
import { dreamBudgetChildSessionId, normalizeError, runFailureSentinel } from "./subagent-failure-sentinel";

const NOW = 2_000_000_000_000;
const HOUR = 3_600_000;
const PROJECT = "/fixture/project";
const CHILDREN = ["ses_e3247cff8ffex5Zghx4fDip24A", "ses_e324513faffeXtFIkdMrhuJCGL"];
const PARENTS = ["ses_12f72c654ffe94Fkze4RXRpXng", "ses_0d9602e50ffe0yxsEU1JrCXRVx"];
let root: string;
let db: Database;

beforeEach(() => {
    mkdirSync(join(tmpdir(), "magic-context"), { recursive: true });
    root = mkdtempSync(join(tmpdir(), "magic-context", "subagent-failure-budget-"));
    db = new Database(join(root, "context.db"));
    db.exec(readFileSync(join(import.meta.dir, "../../../crates/mc-module/tests/fixtures/context-db-schema.sql"), "utf8"));
});
afterEach(() => { db.close(false); rmSync(root, { recursive: true, force: true }); });

function budgetError(child = CHILDREN[0]!, spent = 18_891) {
    const error = new DreamTokenBudgetExceeded(child, spent);
    return `${error.name} message="${error.message}"`;
}

function invocation(error = budgetError(), time = NOW - 1_000, parent = PARENTS[0]!, subagent = "dreamer") {
    const row = db.query("INSERT INTO subagent_invocations (session_id, harness, subagent, task, started_at, ended_at, status, error) VALUES (?, 'opencode', ?, 'verify', ?, ?, 'failed', ?) RETURNING id")
        .get(parent, subagent, time - 100, time, error) as { id: number };
    db.query("INSERT OR REPLACE INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'opencode', ?, ?)")
        .run(parent, PROJECT, time);
    return row.id;
}

function dreamRun(status: "completed" | "failed", child = CHILDREN[0]!, finished = NOW - 500, project = PROJECT) {
    const second = child === CHILDREN[1];
    const tasks = [{
        name: "verify", status, durationMs: 10_000, resultChars: 0,
        ...(status === "failed" ? { error: budgetError(child, 1_502_666), failure: { failure_class: "token_budget" } } : {}),
        progress: second ? "verify: processed 36 (verified 15, archived 21); 723 remain" : "verify: processed 50 (verified 45, refused 5); 75 remain",
        children: [{ sessionId: child, promptTokens: second ? 32_486 : 18_891 }],
        tokenBudget: { budget: status === "failed" ? 1_500_000 : 2_500_000, spent: status === "failed" ? 1_502_666 : second ? 2_502_431 : 2_500_109, finalizeFired: status === "completed", banked: second ? 36 : 45 },
    }];
    db.query("INSERT INTO dream_runs (project_path, started_at, finished_at, holder_id, tasks_json, tasks_succeeded, tasks_failed, smart_notes_surfaced, smart_notes_pending, memory_changes_json, parent_session_id) VALUES (?, ?, ?, 'fixture-holder', ?, ?, ?, 0, 0, NULL, ?)")
        .run(project, finished - 10_000, finished, JSON.stringify(tasks), status === "completed" ? 1 : 0, status === "failed" ? 1 : 0, PARENTS[second ? 1 : 0]!);
}

async function run(now = NOW) {
    const logs: string[] = [];
    const result = await runFailureSentinel({ db: join(root, "context.db"), stateFile: join(root, "state.json"), connectionFile: join(root, "none"), send: false, settleMs: 0, now: () => now, stdout: () => {}, stderr: (line) => logs.push(line) });
    return { ...result, summary: JSON.parse(logs.at(-1)!), state: JSON.parse(readFileSync(join(root, "state.json"), "utf8")) };
}

test("budget regression: class text folds the two wake child ids and message ids", () => {
    const expected = 'DreamTokenBudgetExceeded message="Dreamer child <id> spent <number> prompt tokens (token_budget)"';
    expect(normalizeError(budgetError())).toBe(expected);
    expect(normalizeError(budgetError(CHILDREN[1], 32_486))).toBe(expected);
    expect(dreamBudgetChildSessionId(budgetError())).toBe(CHILDREN[0]);
    expect(normalizeError("error in msg_abc123 request 6ccd58a4-fd7d-4695-ae30-b3cbd8c5b633"))
        .toBe(normalizeError("error in msg_def456 request 3f5266e0-127a-42d4-9a78-8f5c32e6bc8c"));
});

test("budget regression: old state classes are normalised on load without a new-class wake", async () => {
    const oldClass = `DreamTokenBudgetExceeded message="Dreamer child ${CHILDREN[0]} spent <number> prompt tokens (token_budget)"`;
    writeFileSync(join(root, "state.json"), JSON.stringify({ version: 1, cursor: { ended_at: NOW - 300_000, id: 0 }, sent: {
        [JSON.stringify(["new_class", "dreamer", "verify", oldClass])]: { at: NOW - 60_000, count: 1 },
    } }));
    invocation(budgetError(CHILDREN[1], 32_486), NOW - 1_000, PARENTS[1]);
    dreamRun("failed", CHILDREN[1]);
    const result = await run();
    expect(result.alerts).toEqual([]);
    expect(Object.keys(result.state.sent)).toEqual([JSON.stringify(["new_class", "dreamer", "verify", normalizeError(budgetError())])]);
});

test("budget regression: completed verify runs exclude their child stops from every rule and log the count", async () => {
    invocation();
    invocation(budgetError(CHILDREN[1], 32_486), NOW - 900, PARENTS[1]);
    dreamRun("completed");
    dreamRun("completed", CHILDREN[1]);
    const result = await run();
    expect(result.alerts).toEqual([]);
    expect(result.summary.budget_stops_not_counted).toBe(2);
});

test("colliding old class reservations combine counts instead of re-alerting on upgrade", async () => {
    const sent = Object.fromEntries(CHILDREN.map((child) => [JSON.stringify(["new_class", "dreamer", "verify",
        `DreamTokenBudgetExceeded message="Dreamer child ${child} spent <number> prompt tokens (token_budget)"`]), { at: NOW - 60_000, count: 1 }]));
    writeFileSync(join(root, "state.json"), JSON.stringify({ version: 1, cursor: { ended_at: NOW - 300_000, id: 0 }, sent }));
    for (const child of CHILDREN) { invocation(budgetError(child)); dreamRun("failed", child); }
    const result = await run();
    expect(result.alerts).toEqual([]);
    expect(Object.values(result.state.sent)).toEqual([{ at: NOW - 60_000, count: 2 }]);
});

test("a failed task with the budget class still wakes with the existing new-class rule", async () => {
    invocation(budgetError(CHILDREN[0], 1_502_666));
    dreamRun("failed");
    const result = await run();
    expect(result.alerts.map((alert) => alert.rule)).toEqual(["new_class"]);
    expect(result.alerts[0]).toMatchObject({ count: 1, share: 1, class: normalizeError(budgetError()) });
    expect(result.summary.budget_stops_not_counted).toBe(0);
});

test("a pending budget stop survives restart and is retried without a new invocation", async () => {
    const id = invocation();
    const first = await run();
    expect(first.alerts).toEqual([]);
    expect(first.state.pending).toEqual([id]);
    expect(first.state.cursor.id).toBe(id);
    dreamRun("completed", CHILDREN[0], NOW + 30_000);
    const second = await run(NOW + 60_000);
    expect(second.alerts).toEqual([]);
    expect(second.summary.budget_stops_not_counted).toBe(1);
    expect(second.state.pending).toEqual([]);
});

test("an unresolved budget stop counts as a failure after sixty minutes", async () => {
    invocation();
    expect((await run()).alerts).toEqual([]);
    const result = await run(NOW + HOUR);
    expect(result.alerts.map((alert) => alert.rule)).toEqual(["new_class"]);
    expect(result.summary.budget_stops_not_counted).toBe(0);
    expect(result.state.pending).toEqual([]);
});

test("a late failed task row wakes on the retry", async () => {
    invocation();
    expect((await run()).alerts).toEqual([]);
    dreamRun("failed", CHILDREN[0], NOW + 30_000);
    expect((await run(NOW + 60_000)).alerts.map((alert) => alert.rule)).toEqual(["new_class"]);
});

test("completed budget stops are absent from failure counts and share denominators", async () => {
    for (let i = 0; i < 6; i++) {
        db.query("INSERT INTO subagent_invocations (session_id, harness, subagent, task, started_at, ended_at, status) VALUES ('fixture', 'opencode', 'dreamer', 'verify', ?, ?, 'completed')")
            .run(NOW - 2_100, NOW - 2_000);
    }
    invocation();
    dreamRun("completed");
    invocation("actual failure A", NOW - 800);
    invocation("actual failure B", NOW - 700);
    const result = await run();
    const share = result.alerts.find((alert) => alert.rule === "failure_share");
    expect(share).toMatchObject({ count: 2, share: 0.25 });
    expect(result.alerts.some((alert) => alert.example_error.includes("token_budget"))).toBe(false);
});

test("budget lookup requires the child, project, and sixty-minute run window", async () => {
    invocation();
    dreamRun("completed", CHILDREN[1]);
    dreamRun("completed", CHILDREN[0], NOW - 500, "/another/project");
    dreamRun("completed", CHILDREN[0], NOW - 2_000);
    dreamRun("completed", CHILDREN[0], NOW + HOUR);
    expect((await run()).state.pending).toHaveLength(1);
    expect((await run(NOW + HOUR)).alerts.map((alert) => alert.rule)).toEqual(["new_class"]);
});

test("malformed task JSON is ignored and a missing project falls back to the time window", async () => {
    invocation();
    db.exec("DELETE FROM session_projects");
    for (const tasks of ["{bad", "{}", '[null, {"children":{}}, {"children":[null]}]']) {
        db.query("INSERT INTO dream_runs (project_path, started_at, finished_at, holder_id, tasks_json) VALUES (?, ?, ?, 'fixture', ?)")
            .run(PROJECT, NOW - 10_000, NOW - 500, tasks);
    }
    dreamRun("completed");
    const result = await run();
    expect(result.alerts).toEqual([]);
    expect(result.summary.budget_stops_not_counted).toBe(1);
});

test("an unextractable budget error is judged as a failure rather than silenced", async () => {
    invocation("DreamTokenBudgetExceeded message=truncated token_budget");
    expect((await run()).alerts.map((alert) => alert.rule)).toEqual(["new_class"]);
});

test("non-budget errors and non-dreamer failures need no dream run lookup", async () => {
    invocation("ordinary failure");
    invocation(budgetError(), NOW - 900, PARENTS[1], "historian");
    db.exec("DROP TABLE dream_runs; DROP TABLE session_projects");
    expect((await run()).alerts.map((alert) => alert.rule)).toEqual(["new_class", "new_class"]);
});

test("pending budget stops are bounded without losing the unprocessed cursor tail", async () => {
    for (let i = 0; i < 501; i++) invocation(budgetError(`ses_child${i}`), NOW - 1_000 + i);
    const first = await run();
    expect(first.state.pending).toHaveLength(500);
    expect(first.bounded).toBe(true);
    const second = await run(NOW + 1_000);
    expect(second.state.pending).toHaveLength(500);
    expect(second.state.cursor.id).toBe(500);
    expect(second.bounded).toBe(true);
    const expired = await run(NOW + HOUR);
    expect(expired.state.pending).toEqual([]);
    expect(expired.state.cursor.id).toBe(501);
    expect(expired.alerts.map((alert) => alert.rule)).toContain("failure_share");
});
