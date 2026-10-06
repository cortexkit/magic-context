import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { addNote, getPendingSmartNotes } from "../storage-notes";
import * as capabilityModule from "./capabilities";
import { runDueCompiledSmartNoteChecks } from "./runner";
import { __sandboxRunnerTest, runCompiledSmartNoteCheck } from "./sandbox-runner";
import { SMART_NOTE_CHECK_POLICY_VERSION, SmartNoteNetworkError } from "./types";
import { __wakePlaneTest } from "./wake-plane";

const PROJECT = "git:smart-note-deadlines";
let db: Database;
let isolationProven = false;
const capabilities = {
    readFile: async () => null,
    gitHeadSha: async () => null,
    gitTag: async () => null,
    gitLog: async () => [],
    httpGet: async () => ({ status: 200, body: "ok" }),
};

beforeEach(async () => {
    __wakePlaneTest.reset();
    __wakePlaneTest.setCatalogProbe(async () => []);
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    if (!isolationProven) {
        const output = execFileSync("lsof", ["-p", String(process.pid)], {
            encoding: "utf8",
            timeout: 10_000,
            windowsHide: true,
        });
        const dbLines = output.split("\n").filter((line) => /\.db(?:[-\s]|$)/.test(line));
        // Other files in a full-suite worker may hold their own fixtures open.
        // They need not share this file's preload root, but none may be live.
        for (const line of dbLines) expect(line).toContain(realpathSync(tmpdir()));
        console.log(
            `lsof -p ${process.pid}: throwaway database descriptors\n${dbLines.join("\n")}`,
        );
        isolationProven = true;
    }
    // Instantiate the real VM before installing the virtual clock. The seam
    // controls availability, not QuickJS's implementation or interrupt handler.
    expect(
        await runCompiledSmartNoteCheck({
            compiledCheck: "function check() { return { met: false }; }",
            capabilities,
        }),
    ).toEqual({ ok: true, result: { met: false } });
});

afterEach(() => {
    __sandboxRunnerTest.reset();
    __wakePlaneTest.reset();
    jest.useRealTimers();
    closeQuietly(db);
});

function seed(compiledCheck: string): number {
    const note = addNote(db, "smart", {
        projectPath: PROJECT,
        content: "watch state",
        surfaceCondition: "later",
    });
    db.prepare(`UPDATE notes SET compiled_check=?, check_hash='hash', check_status='compiled',
            check_cron='* * * * *', check_next_due_at=0, policy_version=? WHERE id=?`).run(
        compiledCheck,
        SMART_NOTE_CHECK_POLICY_VERSION,
        note.id,
    );
    return note.id;
}

test("slow module acquisition gives the first busy check its full CPU budget and one logic strike", async () => {
    seed("function check() { while (true) {} }");
    seed("function check() { return { met: true }; }");
    jest.useFakeTimers();
    jest.setSystemTime(0);
    __sandboxRunnerTest.setBeforeModuleAcquisition(async () => {
        await Promise.resolve();
        jest.advanceTimersByTime(4_500);
    });
    let executionStarted = false;
    const clock = spyOn(performance, "now").mockImplementation(() => {
        // Deliver eligible timers at interrupt polls, including the sweep timer
        // while JavaScript is running. No machine-speed-dependent sleeps needed.
        if (executionStarted) jest.advanceTimersByTime(250);
        executionStarted = true;
        return Date.now();
    });
    try {
        const result = await runDueCompiledSmartNoteChecks({
            db,
            projectIdentity: PROJECT,
            projectRoot: process.cwd(),
            sweepBudgetMs: 5_000,
        });
        expect(result).toEqual({ ran: 1, surfaced: 0, failed: 1, networkFailed: 0 });
        expect(getPendingSmartNotes(db, PROJECT).map((note) => note.checkFailureCount)).toEqual([
            1, 0,
        ]);
        expect(Date.now()).toBeGreaterThanOrEqual(6_500);
        expect(Date.now()).toBeLessThanOrEqual(11_000);
    } finally {
        clock.mockRestore();
    }
});

test("module acquisition that outlasts the sweep is cancelled without a strike", async () => {
    seed("function check() { while (true) {} }");
    jest.useFakeTimers();
    jest.setSystemTime(0);
    __sandboxRunnerTest.setBeforeModuleAcquisition(async () => {
        await Promise.resolve();
        jest.advanceTimersByTime(5_000);
        // Model a load still in flight when its caller gives up, not guest code.
        await new Promise<void>(() => {});
    });
    expect(
        await runDueCompiledSmartNoteChecks({
            db,
            projectIdentity: PROJECT,
            projectRoot: process.cwd(),
            sweepBudgetMs: 5_000,
        }),
    ).toEqual({ ran: 1, surfaced: 0, failed: 0, networkFailed: 0 });
    expect(getPendingSmartNotes(db, PROJECT)[0].checkFailureCount).toBe(0);
    expect(Date.now()).toBe(5_000);
});

test("a load cannot start execution past an overdue but undelivered sweep timer", async () => {
    seed("function check() { return { met: true }; }");
    jest.useFakeTimers();
    jest.setSystemTime(0);
    __sandboxRunnerTest.setBeforeModuleAcquisition(async () => {
        await Promise.resolve();
        // Advancing system time alone does not deliver timers. This models a
        // synchronous module load that prevented the event loop from doing so.
        jest.setSystemTime(5_001);
    });
    expect(
        await runDueCompiledSmartNoteChecks({
            db,
            projectIdentity: PROJECT,
            projectRoot: process.cwd(),
            sweepBudgetMs: 5_000,
        }),
    ).toEqual({ ran: 1, surfaced: 0, failed: 0, networkFailed: 0 });
    expect(getPendingSmartNotes(db, PROJECT)[0].checkFailureCount).toBe(0);
});

test("a late-starting HTTP check gets one full deadline but no second note is admitted", async () => {
    seed('function check(cap) { cap.httpGet("https://example.test/"); return { met: false }; }');
    seed("function check() { return { met: true }; }");
    jest.useFakeTimers();
    jest.setSystemTime(0);
    __sandboxRunnerTest.setBeforeModuleAcquisition(async () => {
        await Promise.resolve();
        jest.advanceTimersByTime(4_500);
    });
    const clock = spyOn(performance, "now").mockImplementation(() => Date.now());
    const factory = spyOn(capabilityModule, "createSmartNoteCapabilities").mockImplementation(
        ({ signal }) => ({
            ...capabilities,
            httpGet: () =>
                new Promise((_resolve, reject) => {
                    signal?.addEventListener(
                        "abort",
                        () => reject(new SmartNoteNetworkError("SMART_NOTE_NETWORK: aborted")),
                        { once: true },
                    );
                    jest.advanceTimersByTime(6_000);
                }),
        }),
    );
    try {
        expect(
            await runDueCompiledSmartNoteChecks({
                db,
                projectIdentity: PROJECT,
                projectRoot: process.cwd(),
                sweepBudgetMs: 5_000,
            }),
        ).toEqual({ ran: 1, surfaced: 0, failed: 0, networkFailed: 1 });
        expect(Date.now()).toBe(10_500);
        const notes = getPendingSmartNotes(db, PROJECT);
        expect(notes.map((note) => note.checkFailureCount)).toEqual([0, 0]);
        expect(notes.map((note) => note.checkNetworkFailureCount)).toEqual([1, 0]);
        expect(notes[0].checkNextDueAt).toBeGreaterThanOrEqual(10_500 + 5 * 60_000);
        expect(notes[1].checkNextDueAt).toBe(0);
    } finally {
        factory.mockRestore();
        clock.mockRestore();
    }
});

test("an external abort at the CPU boundary cannot hide an execution failure", async () => {
    const controller = new AbortController();
    let polls = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => {
        if (polls++ === 0) return 0;
        if (!controller.signal.aborted) controller.abort(new Error("lease expired"));
        return 100;
    });
    try {
        expect(
            await runCompiledSmartNoteCheck({
                compiledCheck: "function check() { while (true) {} }",
                capabilities,
                signal: controller.signal,
                timeoutMs: 100,
            }),
        ).toMatchObject({ ok: false, cancelled: false, network: false, persistent: false });
    } finally {
        clock.mockRestore();
    }
});

test("external cancellation while suspended in HTTP does not spend a CPU strike", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const clock = spyOn(performance, "now").mockImplementation(() => Date.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("lease expired")), 2_500);
    try {
        expect(
            await runCompiledSmartNoteCheck({
                compiledCheck:
                    'function check(cap) { cap.httpGet("https://example.test/"); return { met: false }; }',
                signal: controller.signal,
                capabilityFactory: (signal) => ({
                    ...capabilities,
                    httpGet: () =>
                        new Promise((_resolve, reject) => {
                            signal.addEventListener("abort", () => reject(signal.reason), {
                                once: true,
                            });
                            jest.advanceTimersByTime(2_500);
                        }),
                }),
            }),
        ).toMatchObject({ ok: false, cancelled: true, network: false });
    } finally {
        clearTimeout(timer);
        clock.mockRestore();
    }
});

test("external cancellation before the CPU boundary remains cancellation", async () => {
    const controller = new AbortController();
    let polls = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => {
        if (polls++ === 0) return 0;
        if (!controller.signal.aborted) controller.abort(new Error("lease expired"));
        return 99;
    });
    try {
        expect(
            await runCompiledSmartNoteCheck({
                compiledCheck: "function check() { while (true) {} }",
                capabilities,
                signal: controller.signal,
                timeoutMs: 100,
            }),
        ).toMatchObject({ ok: false, cancelled: true, network: false });
    } finally {
        clock.mockRestore();
    }
});
