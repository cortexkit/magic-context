/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { evaluateSmartNotes } from "../dreamer/evaluate-smart-notes";
import { acquireLease } from "../dreamer/lease";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { addNote, dismissNote, getNotes, getPendingSmartNotes, updateNote } from "../storage-notes";
import { runDueCompiledSmartNoteChecks } from "./runner";
import { __sandboxRunnerTest, runCompiledSmartNoteCheck } from "./sandbox-runner";
import {
    commitSmartNoteState,
    getSmartNotesNeedingCompilation,
    markCompiledCheckFalse,
    markSmartNoteCompilationFailure,
    storeCompiledSmartNoteCheck,
} from "./storage";
import { SMART_NOTE_CHECK_POLICY_VERSION } from "./types";

const PROJECT = "git:test";
const tempDirs: string[] = [];

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function tempProject(): string {
    const dir = createTestTempDirFromPath(path.join(tmpdir(), "mc-smart-note-storage-"));
    tempDirs.push(dir);
    return dir;
}

function setCheckColumns(db: Database, noteId: number, columns: Record<string, unknown>): void {
    const entries = Object.entries(columns);
    db.prepare(
        `UPDATE notes SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`,
    ).run(...entries.map(([, value]) => value), noteId);
}

afterEach(() => {
    __sandboxRunnerTest.reset();
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

describe("smart-note compilation selection", () => {
    test("honors check_next_due_at backoff before recompiling notes", () => {
        const db = freshDb();
        try {
            const now = 10_000;
            const due = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "due",
                surfaceCondition: "compile now",
            });
            const backedOff = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "backoff",
                surfaceCondition: "compile later",
            });
            setCheckColumns(db, due.id, { check_next_due_at: now - 1 });
            setCheckColumns(db, backedOff.id, { check_next_due_at: now + 60_000 });

            expect(getSmartNotesNeedingCompilation(db, PROJECT, now, 10).map((n) => n.id)).toEqual([
                due.id,
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("persistent compilation failure", () => {
    test.each([
        "dry-run failed: SMART_NOTE_NETWORK: response body too large at https://example.com/CHANGELOG.md",
        "dry-run failed: response exceeded configured ceiling",
    ])("records reason and does not retry nightly: %s", (error) => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "waiting for public source",
                surfaceCondition: "when schema changes",
            });
            const now = Date.now();
            markSmartNoteCompilationFailure(db, note.id, now, 3, error, true);
            const stored = getNotes(db, { projectPath: PROJECT, type: "smart" })[0];
            expect(stored?.readyReason).toBe(`Condition can't be checked: ${error}; rewrite it`);
            expect(stored?.checkStatus).toBe("uncompiled");
            expect(stored?.checkNextDueAt).toBe(now + 7 * 24 * 60 * 60 * 1_000);
            expect(
                getSmartNotesNeedingCompilation(db, PROJECT, now + 6 * 24 * 60 * 60 * 1_000, 10),
            ).toEqual([]);
            expect(
                getSmartNotesNeedingCompilation(db, PROJECT, now + 7 * 24 * 60 * 60 * 1_000, 10),
            ).toHaveLength(1);
            updateNote(
                db,
                note.id,
                { surfaceCondition: "when local schema changes" },
                { projectPath: PROJECT },
            );
            expect(getSmartNotesNeedingCompilation(db, PROJECT, Date.now(), 10)).toHaveLength(1);
            expect(
                getNotes(db, { projectPath: PROJECT, type: "smart" })[0]?.readyReason,
            ).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("message wording cannot turn a transient failure into a week-long backoff", () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "waiting",
                surfaceCondition: "when release arrives",
            });
            const now = Date.now();
            markSmartNoteCompilationFailure(db, note.id, now, 3, "response body too large", false);
            const stored = getNotes(db, { projectPath: PROJECT, type: "smart" })[0];
            expect(stored?.checkNextDueAt).toBeLessThan(now + 24 * 60 * 60 * 1_000);
            // A transient failure retries quietly; it doesn't ask the owner to rewrite.
            expect(stored?.readyReason).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});

describe("evaluateSmartNotes lease guard", () => {
    test("skips authoring-compiled notes only when retina handoff is enabled", async () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "retina owns this condition",
                surfaceCondition: "when path /tmp/result exists",
                compiledProvider: "local-fs",
                compiledConfig: JSON.stringify({ kind: "path_exists", path: "/tmp/result" }),
                compiledAt: Date.now(),
                compileStatus: "compiled",
            });

            expect(getSmartNotesNeedingCompilation(db, PROJECT, Date.now(), 10)).toHaveLength(1);
            expect(getSmartNotesNeedingCompilation(db, PROJECT, Date.now(), 10, true)).toHaveLength(
                0,
            );
            await expect(
                evaluateSmartNotes({
                    db,
                    client: {} as never,
                    projectIdentity: PROJECT,
                    parentSessionId: undefined,
                    sessionDirectory: tempProject(),
                    holderId: "no-lease-needed",
                    leaseKey: "smart-note-retina-handoff",
                    deadline: Date.now() + 60_000,
                    retinaHandoff: true,
                }),
            ).resolves.toEqual({ surfaced: 0, pending: 0, ran: false });
            expect(getNotes(db, { projectPath: PROJECT, type: "smart" })[0]?.id).toBe(note.id);
        } finally {
            closeQuietly(db);
        }
    });

    test("does not commit due-check results after the lease is lost", async () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "ready when check passes",
                surfaceCondition: "test condition",
            });
            setCheckColumns(db, note.id, {
                compiled_check: "function check() { return { met: true }; }",
                manifest_json: JSON.stringify({ capabilities: [], summary: "test" }),
                check_hash: "hash",
                check_cron: "* * * * *",
                check_version: 1,
                check_status: "compiled",
                check_next_due_at: 0,
                policy_version: SMART_NOTE_CHECK_POLICY_VERSION,
            });
            expect(acquireLease(db, "other-holder", "smart-note-lease")).toBe(true);

            await expect(
                evaluateSmartNotes({
                    db,
                    client: {} as never,
                    projectIdentity: PROJECT,
                    parentSessionId: undefined,
                    sessionDirectory: tempProject(),
                    holderId: "missing-holder",
                    leaseKey: "smart-note-lease",
                    deadline: Date.now() + 60_000,
                }),
            ).rejects.toThrow("Dream lease lost");

            expect(getPendingSmartNotes(db, PROJECT).map((n) => [n.id, n.status])).toEqual([
                [note.id, "pending"],
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("smart-note state compare-and-set", () => {
    test("a dismissal during compilation cannot resurrect the note", () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                sessionId: "session",
                content: "compile me",
                surfaceCondition: "when ready",
            });
            expect(dismissNote(db, note.id, { sessionId: "session", projectPath: PROJECT })).toBe(
                true,
            );

            const committed = commitSmartNoteState(db, {
                phase: "compile",
                expected: {
                    kind: "source-revision",
                    noteId: note.id,
                    content: note.content,
                    surfaceCondition: note.surfaceCondition,
                    updatedAt: note.updatedAt,
                },
                write: () =>
                    storeCompiledSmartNoteCheck(db, {
                        noteId: note.id,
                        compiledCheck: "function check() { return { met: true }; }",
                        manifest: { capabilities: [] },
                        checkHash: "new-hash",
                        checkCron: "* * * * *",
                        nextDueAt: Date.now(),
                        now: Date.now(),
                    }),
            });

            expect(committed).toBe(false);
            const current = getNotes(db, { type: "smart", status: "dismissed" })[0];
            expect(current.status).toBe("dismissed");
            expect(current.compiledCheck).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("a condition edit discards a stale compiled-check result", () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                sessionId: "session",
                content: "watch condition",
                surfaceCondition: "old condition",
            });
            setCheckColumns(db, note.id, {
                compiled_check: "function check() { return { met: false }; }",
                check_hash: "old-hash",
                check_compiled_at: 123,
                check_status: "compiled",
                policy_version: SMART_NOTE_CHECK_POLICY_VERSION,
            });
            const selected = getPendingSmartNotes(db, PROJECT)[0];
            expect(
                updateNote(
                    db,
                    note.id,
                    { surfaceCondition: "new condition" },
                    { sessionId: "session", projectPath: PROJECT },
                ),
            ).not.toBeNull();

            const committed = commitSmartNoteState(db, {
                phase: "due check",
                expected: {
                    kind: "compiled-check",
                    noteId: selected.id,
                    compiledCheck: selected.compiledCheck as string,
                    checkHash: selected.checkHash,
                    checkCompiledAt: selected.checkCompiledAt,
                },
                write: () => markCompiledCheckFalse(db, selected.id, 999, 456),
            });

            expect(committed).toBe(false);
            const current = getPendingSmartNotes(db, PROJECT)[0];
            expect(current.surfaceCondition).toBe("new condition");
            expect(current.lastCheckedAt).toBeNull();
            expect(current.checkStatus).toBe("uncompiled");
        } finally {
            closeQuietly(db);
        }
    });

    test("commits when the expected source revision is unchanged", () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "normal",
                surfaceCondition: "normal condition",
            });
            const now = Date.now();
            const committed = commitSmartNoteState(db, {
                phase: "compile",
                expected: {
                    kind: "source-revision",
                    noteId: note.id,
                    content: note.content,
                    surfaceCondition: note.surfaceCondition,
                    updatedAt: note.updatedAt,
                },
                write: () =>
                    storeCompiledSmartNoteCheck(db, {
                        noteId: note.id,
                        compiledCheck: "function check() { return { met: false }; }",
                        manifest: { capabilities: [] },
                        checkHash: "hash",
                        checkCron: "* * * * *",
                        nextDueAt: now + 60_000,
                        now,
                    }),
            });

            expect(committed).toBe(true);
            expect(getPendingSmartNotes(db, PROJECT)[0].checkStatus).toBe("compiled");
        } finally {
            closeQuietly(db);
        }
    });
});

describe("smart-note cancellation health policy", () => {
    test("pre-aborted due checks leave note health unchanged", async () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "cancelled",
                surfaceCondition: "later",
            });
            setCheckColumns(db, note.id, {
                compiled_check: "function check() { return { met: true }; }",
                check_hash: "hash",
                check_cron: "* * * * *",
                check_status: "compiled",
                check_next_due_at: 0,
                policy_version: SMART_NOTE_CHECK_POLICY_VERSION,
            });
            const controller = new AbortController();
            controller.abort(new Error("lease expired"));

            const result = await runDueCompiledSmartNoteChecks({
                db,
                projectIdentity: PROJECT,
                projectRoot: tempProject(),
                signal: controller.signal,
            });

            expect(result).toEqual({ ran: 1, surfaced: 0, failed: 0, networkFailed: 0 });
            const current = getPendingSmartNotes(db, PROJECT)[0];
            expect(current.checkFailureCount).toBe(0);
            expect(current.checkNetworkFailureCount).toBe(0);
            expect(current.status).toBe("pending");
        } finally {
            closeQuietly(db);
        }
    });

    test("a sandbox execution timeout still increments logic health", async () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "timeout",
                surfaceCondition: "later",
            });
            setCheckColumns(db, note.id, {
                compiled_check: "function check() { while (true) {} }",
                check_hash: "hash",
                check_cron: "* * * * *",
                check_status: "compiled",
                check_next_due_at: 0,
                policy_version: SMART_NOTE_CHECK_POLICY_VERSION,
            });

            // This assertion concerns guest CPU exhaustion, not whether a cold
            // infrastructure load fits inside the sweep's admission deadline.
            expect(
                await runCompiledSmartNoteCheck({
                    compiledCheck: "function check() { return { met: false }; }",
                    capabilities: {
                        readFile: async () => null,
                        gitHeadSha: async () => null,
                        gitTag: async () => null,
                        gitLog: async () => [],
                        httpGet: async () => ({ status: 200, body: "ok" }),
                    },
                }),
            ).toEqual({ ok: true, result: { met: false } });
            const result = await runDueCompiledSmartNoteChecks({
                db,
                projectIdentity: PROJECT,
                projectRoot: tempProject(),
                sweepBudgetMs: 5_000,
            });

            expect(result.failed).toBe(1);
            expect(getPendingSmartNotes(db, PROJECT)[0].checkFailureCount).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("a module load timeout leaves a due note healthy and eligible for the next sweep", async () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "waiting",
                surfaceCondition: "later",
            });
            setCheckColumns(db, note.id, {
                compiled_check: "function check() { return { met: true }; }",
                check_hash: "hash",
                check_cron: "* * * * *",
                check_status: "compiled",
                check_next_due_at: 0,
                policy_version: SMART_NOTE_CHECK_POLICY_VERSION,
            });
            const root = tempProject();
            __sandboxRunnerTest.setBeforeModuleLoad(() => new Promise<void>(() => {}), 50);
            expect(
                await runDueCompiledSmartNoteChecks({
                    db,
                    projectIdentity: PROJECT,
                    projectRoot: root,
                }),
            ).toEqual({ ran: 1, surfaced: 0, failed: 0, networkFailed: 0 });
            expect(getPendingSmartNotes(db, PROJECT)[0]).toMatchObject({
                checkFailureCount: 0,
                checkNetworkFailureCount: 0,
                checkNextDueAt: 0,
            });
            __sandboxRunnerTest.reset();
            expect(
                await runDueCompiledSmartNoteChecks({
                    db,
                    projectIdentity: PROJECT,
                    projectRoot: root,
                }),
            ).toEqual({ ran: 1, surfaced: 1, failed: 0, networkFailed: 0 });
        } finally {
            closeQuietly(db);
        }
    });
});
