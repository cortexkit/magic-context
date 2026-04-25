import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import {
    addNote,
    buildCompartmentBlock,
    clearPendingOps,
    clearPersistedNudgePlacement,
    clearPersistedStickyTurnReminder,
    clearSession,
    closeDatabase,
    dismissNote,
    getOrCreateSessionMeta,
    getPendingOps,
    getPendingSmartNotes,
    getPersistedNudgePlacement,
    getPersistedStickyTurnReminder,
    getSessionNotes,
    getSmartNotes,
    getTagById,
    getTagsBySession,
    getTopNBySize,
    insertTag,
    markNoteReady,
    openDatabase,
    queuePendingOp,
    removePendingOp,
    replaceAllSessionNotes,
    setPersistedNudgePlacement,
    setPersistedStickyTurnReminder,
    updateNote,
    updateSessionMeta,
    updateTagStatus,
} from "./storage";
import { initializeDatabase } from "./storage-db";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function useTempDataHome(prefix: string): string {
    const dataHome = makeTempDir(prefix);
    process.env.XDG_DATA_HOME = dataHome;
    return dataHome;
}

function resolveDbPath(dataHome: string): string {
    // Plugin v0.16+ — shared cortexkit/magic-context path. See data-path.ts.
    return join(dataHome, "cortexkit", "magic-context", "context.db");
}

function makeMemoryDatabase(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("magic-context storage", () => {
    it("opens file DB with WAL mode, busy timeout, and required tables", () => {
        //#given
        const dataHome = useTempDataHome("context-storage-open-");
        //#when
        const db = openDatabase();
        const wal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
        const timeout = db.prepare("PRAGMA busy_timeout").get() as Record<string, number>;
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as Array<{ name: string }>;
        //#then
        expect(wal.journal_mode.toLowerCase()).toBe("wal");
        expect(Object.values(timeout)[0]).toBe(5000);
        expect(existsSync(resolveDbPath(dataHome))).toBe(true);
        expect(tables.map((t) => t.name)).toEqual(
            expect.arrayContaining([
                "tags",
                "pending_ops",
                "source_contents",
                "session_meta",
                "notes",
            ]),
        );
        closeDatabase();
    });

    it("handles tags and pending-ops CRUD with session scoping", () => {
        //#given
        const db = makeMemoryDatabase();
        const sessionId = "ses-1";
        const tagA = insertTag(db, sessionId, "m-1", "message", 120, 1);
        const tagB = insertTag(db, sessionId, "m-2", "tool", 420, 2);
        queuePendingOp(db, sessionId, tagA, "drop");
        queuePendingOp(db, sessionId, tagB, "drop");
        //#when
        updateTagStatus(db, sessionId, tagA, "dropped");
        const tags = getTagsBySession(db, sessionId);
        const oneTag = getTagById(db, sessionId, tagA);
        const top = getTopNBySize(db, sessionId, 1);
        const pending = getPendingOps(db, sessionId);
        removePendingOp(db, sessionId, tagA);
        clearPendingOps(db, sessionId);
        //#then
        expect(tags).toHaveLength(2);
        expect(oneTag?.status).toBe("dropped");
        expect(top[0]?.tagNumber).toBe(tagB);
        expect(pending.map((op) => op.operation)).toEqual(["drop", "drop"]);
        expect(getPendingOps(db, sessionId)).toEqual([]);
        closeQuietly(db);
    });

    it("updates session meta and clears session-scoped state", () => {
        //#given
        const db = makeMemoryDatabase();
        const sessionId = "ses-meta";
        insertTag(db, sessionId, "m-3", "message", 90, 1);
        //#when
        const initialMeta = getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, {
            counter: 7,
            lastNudgeTokens: 20_000,
            lastNudgeBand: "near",
            isSubagent: true,
        });
        addNote(db, "session", { sessionId, content: "Persist me until clearSession runs." });
        const updatedMeta = getOrCreateSessionMeta(db, sessionId);
        //#then
        expect(initialMeta.counter).toBe(0);
        expect(updatedMeta.counter).toBe(7);
        expect(updatedMeta.lastNudgeTokens).toBe(20_000);
        expect(updatedMeta.lastNudgeBand).toBe("near");
        expect(updatedMeta.isSubagent).toBe(true);
        updateSessionMeta(db, sessionId, { lastNudgeBand: null });
        expect(getOrCreateSessionMeta(db, sessionId).lastNudgeBand).toBeNull();
        clearSession(db, sessionId);
        expect(getTagsBySession(db, sessionId)).toEqual([]);
        expect(getSessionNotes(db, sessionId)).toEqual([]);
        closeQuietly(db);
    });

    it("stores and replaces session notes by session", () => {
        //#given
        const db = makeMemoryDatabase();
        const sessionId = "ses-notes";

        //#when
        addNote(db, "session", {
            sessionId,
            content: "Remember broad magic-context rename.",
        });
        addNote(db, "session", { sessionId, content: "Keep historian notes terse." });

        //#then
        expect(getSessionNotes(db, sessionId).map((note) => note.content)).toEqual([
            "Remember broad magic-context rename.",
            "Keep historian notes terse.",
        ]);

        //#when
        replaceAllSessionNotes(db, sessionId, ["Keep historian notes very terse."]);

        //#then
        expect(getSessionNotes(db, sessionId).map((note) => note.content)).toEqual([
            "Keep historian notes very terse.",
        ]);

        //#when
        replaceAllSessionNotes(db, sessionId, []);

        //#then
        expect(getSessionNotes(db, sessionId)).toEqual([]);
        closeQuietly(db);
    });

    it("stores smart notes in the unified notes table and filters by status", () => {
        //#given
        const db = makeMemoryDatabase();
        const smartNote = addNote(db, "smart", {
            content: "Surface the release checklist when CI stabilizes.",
            projectPath: "git:test-project",
            sessionId: "ses-smart",
            surfaceCondition: "When CI is green on main",
        });

        //#then
        expect(getPendingSmartNotes(db, "git:test-project").map((note) => note.id)).toEqual([
            smartNote.id,
        ]);

        //#when
        const updated = updateNote(db, smartNote.id, {
            content: "Surface the release checklist when release CI stabilizes.",
            surfaceCondition: "When release CI is green on main",
        });
        markNoteReady(db, smartNote.id, "release CI is green on main");

        //#then
        expect(updated?.content).toBe("Surface the release checklist when release CI stabilizes.");
        expect(getSmartNotes(db, "git:test-project", "ready")[0]?.readyReason).toBe(
            "release CI is green on main",
        );

        //#when
        dismissNote(db, smartNote.id);

        //#then
        expect(getSmartNotes(db, "git:test-project")).toEqual([]);
        closeQuietly(db);
    });

    it("persists and clears nudge anchors by session", () => {
        //#given
        const db = makeMemoryDatabase();
        const sessionId = "ses-anchor";

        //#when
        setPersistedNudgePlacement(db, sessionId, "m-assistant", "\n[nudge]");

        //#then
        expect(getPersistedNudgePlacement(db, sessionId)).toEqual({
            messageId: "m-assistant",
            nudgeText: "\n[nudge]",
        });

        //#when
        clearPersistedNudgePlacement(db, sessionId);

        //#then
        expect(getPersistedNudgePlacement(db, sessionId)).toBeNull();
        closeQuietly(db);
    });

    it("persists and clears sticky turn reminders by session", () => {
        //#given
        const db = makeMemoryDatabase();
        const sessionId = "ses-sticky-turn-reminder";

        //#when
        setPersistedStickyTurnReminder(db, sessionId, "\n[sticky reminder]");

        //#then
        expect(getPersistedStickyTurnReminder(db, sessionId)).toEqual({
            text: "\n[sticky reminder]",
            messageId: null,
        });

        //#when
        setPersistedStickyTurnReminder(db, sessionId, "\n[sticky reminder]", "m-user");

        //#then
        expect(getPersistedStickyTurnReminder(db, sessionId)).toEqual({
            text: "\n[sticky reminder]",
            messageId: "m-user",
        });

        //#when
        clearPersistedStickyTurnReminder(db, sessionId);

        //#then
        expect(getPersistedStickyTurnReminder(db, sessionId)).toBeNull();
        closeQuietly(db);
    });

    it("escapes XML-sensitive compartment body content", () => {
        const block = buildCompartmentBlock(
            [
                {
                    id: 1,
                    sessionId: "ses-1",
                    sequence: 1,
                    title: "Title",
                    content: "Keep <instruction> & <magic-context> safe.",
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "m1",
                    endMessageId: "m2",
                    createdAt: Date.now(),
                },
            ],
            [
                {
                    id: 1,
                    sessionId: "ses-1",
                    category: "USER_DIRECTIVES",
                    content: "Don't drop Sam's <ctx_reduce> note & rationale.",
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            ],
        );

        expect(block).toContain("Keep &lt;instruction&gt; &amp; &lt;magic-context&gt; safe.");
        expect(block).toContain("Don't drop Sam's &lt;ctx_reduce&gt; note &amp; rationale.");
    });

    it("throws when storage operations fail", () => {
        //#given
        const failingDb = {
            prepare: () => {
                throw new Error("boom");
            },
        } as unknown as Database;
        //#when + #then
        expect(() => insertTag(failingDb, "ses-x", "m", "message", 1, 1)).toThrow("boom");
        expect(() => updateTagStatus(failingDb, "ses-x", 1, "dropped")).toThrow("boom");
        expect(() => getTagsBySession(failingDb, "ses-x")).toThrow("boom");
        expect(() => getTagById(failingDb, "ses-x", 1)).toThrow("boom");
        expect(() => queuePendingOp(failingDb, "ses-x", 1, "drop")).toThrow("boom");
        expect(() => getPendingOps(failingDb, "ses-x")).toThrow("boom");
        expect(() => clearPendingOps(failingDb, "ses-x")).toThrow("boom");
        expect(() => removePendingOp(failingDb, "ses-x", 1)).toThrow("boom");
        expect(() => getOrCreateSessionMeta(failingDb, "ses-x")).toThrow("boom");
        expect(() => updateSessionMeta(failingDb, "ses-x", { counter: 1 })).toThrow();
        expect(() => clearSession(failingDb, "ses-x")).toThrow();
        expect(() => getTopNBySize(failingDb, "ses-x", 2)).toThrow("boom");
    });

    it("fails open in openDatabase/closeDatabase when file path setup fails", () => {
        //#given
        const dataHome = useTempDataHome("context-storage-fail-open-");
        // Force mkdirSync to fail by creating a file at one of the expected
        // parent directories (cortexkit). The new shared path is
        // <dataHome>/cortexkit/magic-context/, so blocking the cortexkit
        // segment forces openDatabase() into its in-memory fallback.
        writeFileSync(join(dataHome, "cortexkit"), "not-a-directory", "utf-8");
        //#when
        const db = openDatabase();
        //#then
        expect(db).toBeInstanceOf(Database);
        expect(() => closeDatabase()).not.toThrow();
        expect(() => closeDatabase()).not.toThrow();
    });

    it("filters out malformed rows from getPendingOps", () => {
        //#given
        const db = makeMemoryDatabase();
        queuePendingOp(db, "ses-bad", 1, "drop");
        db.prepare(
            "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, NULL, ?)",
        ).run("ses-bad", 2, Date.now());
        //#when
        const ops = getPendingOps(db, "ses-bad");
        //#then
        expect(ops).toHaveLength(1);
        expect(ops[0].operation).toBe("drop");
        closeQuietly(db);
    });

    it("filters out malformed rows from getTagsBySession and getTopNBySize", () => {
        //#given
        const db = makeMemoryDatabase();
        insertTag(db, "ses-bad", "m-1", "message", 100, 1);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, NULL, ?, ?, NULL)",
        ).run("ses-bad", "message", 200);
        //#when
        const tags = getTagsBySession(db, "ses-bad");
        const top = getTopNBySize(db, "ses-bad", 10);
        //#then
        expect(tags).toHaveLength(1);
        expect(tags[0].messageId).toBe("m-1");
        expect(top).toHaveLength(1);
        closeQuietly(db);
    });

    it("returns defaults for malformed session meta row", () => {
        //#given
        const db = makeMemoryDatabase();
        db.prepare(
            "INSERT INTO session_meta (session_id, last_response_time, cache_ttl, counter, last_nudge_tokens, last_nudge_band, last_transform_error, is_subagent) VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
        ).run("ses-bad");
        //#when
        const meta = getOrCreateSessionMeta(db, "ses-bad");
        //#then
        expect(meta.sessionId).toBe("ses-bad");
        expect(meta.counter).toBe(0);
        expect(meta.cacheTtl).toBe("5m");
        closeQuietly(db);
    });

    it("preserves numeric columns when text columns are NULL (regression: cache bust cascade)", () => {
        //#given
        // Simulates an older row seeded before ensureColumn added last_transform_error
        // with a DEFAULT. SQLite sets existing rows to NULL, not the default, so the
        // text column is NULL but the numeric columns (last_response_time,
        // last_context_percentage, etc.) carry real cumulative state.
        // Pre-fix: validator rejected the row, getOrCreateSessionMeta returned
        // defaults with lastResponseTime=0, scheduler thought TTL had elapsed on
        // every pass, applyPendingOperations re-ran forever, and each execute
        // mutation busted cache.
        const db = makeMemoryDatabase();
        const realResponseTime = 1_700_000_000_000;
        // First seed the row so subsequent UPDATE matches.
        db.prepare(
            `INSERT INTO session_meta (session_id, last_response_time, cache_ttl, counter)
             VALUES (?, ?, '59m', 42)`,
        ).run("ses-nullish", realResponseTime);
        db.prepare(
            `UPDATE session_meta SET
                last_response_time = ?,
                cache_ttl = '59m',
                counter = 42,
                last_nudge_tokens = 100,
                last_context_percentage = 25.5,
                last_input_tokens = 250000,
                last_transform_error = NULL
             WHERE session_id = ?`,
        ).run(realResponseTime, "ses-nullish");

        //#when
        const meta = getOrCreateSessionMeta(db, "ses-nullish");

        //#then — real cumulative state must survive, not be reset to defaults
        expect(meta.sessionId).toBe("ses-nullish");
        expect(meta.lastResponseTime).toBe(realResponseTime);
        expect(meta.cacheTtl).toBe("59m");
        expect(meta.counter).toBe(42);
        expect(meta.lastContextPercentage).toBe(25.5);
        expect(meta.lastInputTokens).toBe(250000);
        expect(meta.lastTransformError).toBeNull();
        closeQuietly(db);
    });

    it("getTopNBySize only returns tags with active status", () => {
        //#given
        const db = makeMemoryDatabase();
        const activeTag = insertTag(db, "ses-filter", "m-1", "message", 500, 1);
        const droppedTag = insertTag(db, "ses-filter", "m-2", "tool", 300, 2);
        updateTagStatus(db, "ses-filter", droppedTag, "dropped");
        //#when
        const top = getTopNBySize(db, "ses-filter", 10);
        //#then
        expect(top).toHaveLength(1);
        expect(top[0].tagNumber).toBe(activeTag);
        expect(top[0].status).toBe("active");
        closeQuietly(db);
    });
});
