import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    addSessionNote,
    buildCompartmentBlock,
    clearPendingOps,
    clearPersistedNudgePlacement,
    clearPersistedStickyTurnReminder,
    clearSession,
    clearSessionNotes,
    closeDatabase,
    getOrCreateSessionMeta,
    getPendingOps,
    getPersistedNudgePlacement,
    getPersistedStickyTurnReminder,
    getSessionNotes,
    getTagById,
    getTagsBySession,
    getTopNBySize,
    insertTag,
    openDatabase,
    queuePendingOp,
    removePendingOp,
    setPersistedNudgePlacement,
    setPersistedStickyTurnReminder,
    updateSessionMeta,
    updateTagStatus,
} from "./storage";

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
    return join(dataHome, "opencode", "storage", "plugin", "magic-context", "context.db");
}

function makeMemoryDatabase(): Database {
    const db = new Database(":memory:");
    db.run(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      message_id TEXT,
      type TEXT,
      status TEXT DEFAULT 'active',
      byte_size INTEGER,
      tag_number INTEGER,
      UNIQUE(session_id, tag_number)
    );
    CREATE TABLE IF NOT EXISTS pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tag_id INTEGER,
      operation TEXT,
      queued_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS source_contents (
      tag_id INTEGER,
      session_id TEXT,
      content TEXT,
      created_at INTEGER,
      PRIMARY KEY(session_id, tag_id)
    );
    CREATE TABLE IF NOT EXISTS compartments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      start_message INTEGER NOT NULL,
      end_message INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(session_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS session_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY,
      last_response_time INTEGER,
      cache_ttl TEXT,
      counter INTEGER DEFAULT 0,
      last_nudge_tokens INTEGER DEFAULT 0,
      last_nudge_band TEXT DEFAULT '',
      last_transform_error TEXT DEFAULT '',
      nudge_anchor_message_id TEXT DEFAULT '',
      nudge_anchor_text TEXT DEFAULT '',
      sticky_turn_reminder_text TEXT DEFAULT '',
      sticky_turn_reminder_message_id TEXT DEFAULT '',
      is_subagent INTEGER DEFAULT 0,
      last_context_percentage REAL DEFAULT 0,
      last_input_tokens INTEGER DEFAULT 0,
      times_execute_threshold_reached INTEGER DEFAULT 0,
      compartment_in_progress INTEGER DEFAULT 0,
      system_prompt_hash INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS recomp_compartments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      start_message INTEGER NOT NULL,
      end_message INTEGER NOT NULL,
      start_message_id TEXT DEFAULT '',
      end_message_id TEXT DEFAULT '',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      pass_number INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(session_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS recomp_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      pass_number INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
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
                "session_notes",
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
        db.close(false);
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
        addSessionNote(db, sessionId, "Persist me until clearSession runs.");
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
        db.close(false);
    });

    it("stores and clears session notes by session", () => {
        //#given
        const db = makeMemoryDatabase();
        const sessionId = "ses-notes";

        //#when
        addSessionNote(db, sessionId, "Remember broad magic-context rename.");
        addSessionNote(db, sessionId, "Keep historian notes terse.");

        //#then
        expect(getSessionNotes(db, sessionId).map((note) => note.content)).toEqual([
            "Remember broad magic-context rename.",
            "Keep historian notes terse.",
        ]);

        //#when
        clearSessionNotes(db, sessionId);

        //#then
        expect(getSessionNotes(db, sessionId)).toEqual([]);
        db.close(false);
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
        db.close(false);
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
        db.close(false);
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
        writeFileSync(join(dataHome, "opencode"), "not-a-directory", "utf-8");
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
        db.close(false);
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
        db.close(false);
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
        db.close(false);
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
        db.close(false);
    });
});
