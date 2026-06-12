/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { getTagsBySession, insertTag } from "./storage-tags";
import {
    _getBackfillState,
    isToolOwnerBackfillNeeded,
    runToolOwnerBackfill,
} from "./tool-owner-backfill";

/**
 * Tests run against a real on-disk MC DB (so ATTACH works) and a
 * synthetic OpenCode DB built in the same temp dir. The MC DB
 * resolves the OC path via getDataDir() — we override XDG_DATA_HOME
 * to point inside the temp dir.
 */
const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    }
    tempDirs.length = 0;
});

function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

interface OcMessage {
    id: string;
    sessionId: string;
    role: "user" | "assistant";
    timeCreated: number;
}

interface OcPart {
    id: string;
    messageId: string;
    type: string;
    callId?: string;
    timeCreated: number;
}

function buildOpencodeDb(messages: OcMessage[], parts: OcPart[]): Database {
    const dataHome = createTempDir("mc-backfill-test-");
    process.env.XDG_DATA_HOME = dataHome;

    // The plugin resolves opencode.db at $XDG_DATA_HOME/opencode/opencode.db.
    const ocDir = join(dataHome, "opencode");
    require("node:fs").mkdirSync(ocDir, { recursive: true });
    const ocPath = join(ocDir, "opencode.db");

    const oc = new Database(ocPath);
    oc.exec(`
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            data TEXT NOT NULL
        );
    `);

    const insertMessage = oc.prepare(
        "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
    );
    for (const m of messages) {
        insertMessage.run(m.id, m.sessionId, m.timeCreated, JSON.stringify({ role: m.role }));
    }

    const insertPart = oc.prepare(
        "INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)",
    );
    for (const p of parts) {
        const data: Record<string, unknown> = { type: p.type };
        if (p.type === "tool" || p.type === "tool-invocation") {
            if (p.callId) data.callID = p.callId;
        } else if (p.type === "tool_use") {
            if (p.callId) data.id = p.callId;
        }
        insertPart.run(p.id, p.messageId, p.timeCreated, JSON.stringify(data));
    }

    oc.close();
    return new Database(ocPath); // re-open just to verify; closed by caller
}

function createMcDb(): Database {
    const dataHome = process.env.XDG_DATA_HOME!;
    const mcDir = join(dataHome, "cortexkit", "magic-context");
    require("node:fs").mkdirSync(mcDir, { recursive: true });
    const mcPath = join(mcDir, "context.db");
    const db = new Database(mcPath);
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("runToolOwnerBackfill", () => {
    test("no-op when no NULL-owner tool tags exist", () => {
        const oc = buildOpencodeDb([], []);
        oc.close();
        const mc = createMcDb();

        // Insert a tag with owner already populated.
        insertTag(mc, "ses-1", "read:1", "tool", 100, 1, 0, "read", 0, "msg-A");

        expect(isToolOwnerBackfillNeeded(mc)).toBe(false);
        const result = runToolOwnerBackfill(mc);
        expect(result.sessionsProcessed).toBe(0);
        expect(result.rowsUpdated).toBe(0);

        closeQuietly(mc);
    });

    test("OpenCode tool shape: backfills oldest assistant for callID", () => {
        // OC has two assistant messages, both with a 'tool' part for read:1.
        // The backfill should pick the older one as owner.
        const oc = buildOpencodeDb(
            [
                { id: "msg-old", sessionId: "ses-1", role: "assistant", timeCreated: 1000 },
                { id: "msg-new", sessionId: "ses-1", role: "assistant", timeCreated: 2000 },
            ],
            [
                {
                    id: "p-old",
                    messageId: "msg-old",
                    type: "tool",
                    callId: "read:1",
                    timeCreated: 1100,
                },
                {
                    id: "p-new",
                    messageId: "msg-new",
                    type: "tool",
                    callId: "read:1",
                    timeCreated: 2100,
                },
            ],
        );
        oc.close();
        const mc = createMcDb();
        insertTag(mc, "ses-1", "read:1", "tool", 100, 1);

        const result = runToolOwnerBackfill(mc);
        expect(result.sessionsCompleted).toBe(1);
        expect(result.rowsUpdated).toBe(1);

        const tags = getTagsBySession(mc, "ses-1");
        expect(tags[0].toolOwnerMessageId).toBe("msg-old");

        closeQuietly(mc);
    });

    test("Anthropic tool_use shape: backfills oldest assistant for callID", () => {
        const oc = buildOpencodeDb(
            [
                { id: "msg-A", sessionId: "ses-1", role: "assistant", timeCreated: 1000 },
                { id: "msg-B", sessionId: "ses-1", role: "assistant", timeCreated: 2000 },
            ],
            [
                {
                    id: "p-A",
                    messageId: "msg-A",
                    type: "tool_use",
                    callId: "toolu_abc",
                    timeCreated: 1100,
                },
                {
                    id: "p-B",
                    messageId: "msg-B",
                    type: "tool_use",
                    callId: "toolu_abc",
                    timeCreated: 2100,
                },
            ],
        );
        oc.close();
        const mc = createMcDb();
        insertTag(mc, "ses-1", "toolu_abc", "tool", 100, 1);

        const result = runToolOwnerBackfill(mc);
        expect(result.sessionsCompleted).toBe(1);
        expect(result.rowsUpdated).toBe(1);

        const tags = getTagsBySession(mc, "ses-1");
        expect(tags[0].toolOwnerMessageId).toBe("msg-A");

        closeQuietly(mc);
    });

    test("mixed shapes (tool + tool_use) on same callID respect ORDER BY", () => {
        // Ensures the four-key ORDER BY makes shape-mixed sessions
        // deterministic. Older message wins, regardless of which
        // shape it uses.
        const oc = buildOpencodeDb(
            [
                { id: "msg-old", sessionId: "ses-1", role: "assistant", timeCreated: 1000 },
                { id: "msg-new", sessionId: "ses-1", role: "assistant", timeCreated: 2000 },
            ],
            [
                {
                    id: "p-old",
                    messageId: "msg-old",
                    type: "tool_use",
                    callId: "shared:1",
                    timeCreated: 1100,
                },
                {
                    id: "p-new",
                    messageId: "msg-new",
                    type: "tool",
                    callId: "shared:1",
                    timeCreated: 2100,
                },
            ],
        );
        oc.close();
        const mc = createMcDb();
        insertTag(mc, "ses-1", "shared:1", "tool", 100, 1);

        const result = runToolOwnerBackfill(mc);
        expect(result.sessionsCompleted).toBe(1);

        const tags = getTagsBySession(mc, "ses-1");
        expect(tags[0].toolOwnerMessageId).toBe("msg-old");

        closeQuietly(mc);
    });

    test("collision: callID ghosts keep the session pending until NULL owners are gone", () => {
        // Real-world bug case: read:32 reused on three turns. We have
        // three NULL-owner tag rows for the same callID; only one can
        // claim the oldest assistant message without violating the partial
        // UNIQUE index.
        const oc = buildOpencodeDb(
            [
                { id: "msg-1", sessionId: "ses-1", role: "assistant", timeCreated: 1000 },
                { id: "msg-2", sessionId: "ses-1", role: "assistant", timeCreated: 2000 },
                { id: "msg-3", sessionId: "ses-1", role: "assistant", timeCreated: 3000 },
            ],
            [
                {
                    id: "p1",
                    messageId: "msg-1",
                    type: "tool",
                    callId: "read:32",
                    timeCreated: 1100,
                },
                {
                    id: "p2",
                    messageId: "msg-2",
                    type: "tool",
                    callId: "read:32",
                    timeCreated: 2100,
                },
                {
                    id: "p3",
                    messageId: "msg-3",
                    type: "tool",
                    callId: "read:32",
                    timeCreated: 3100,
                },
            ],
        );
        oc.close();
        const mc = createMcDb();
        // Pre-existing tag rows in MC DB (could come from before the
        // partial UNIQUE index existed). Need different tag_numbers
        // because UNIQUE(session_id, tag_number) is enforced.
        // We DON'T have the partial UNIQUE blocking us because none of
        // these have a non-NULL owner yet.
        insertTag(mc, "ses-1", "read:32", "tool", 100, 1);
        insertTag(mc, "ses-1", "read:32", "tool", 100, 2);
        insertTag(mc, "ses-1", "read:32", "tool", 100, 3);

        const result = runToolOwnerBackfill(mc);
        expect(result.rowsUpdated).toBe(1);
        expect(result.rowsLeftNull).toBe(2);
        expect(result.sessionsCompleted).toBe(0);
        expect(_getBackfillState(mc, "ses-1")?.status).toBe("pending");

        const tags = getTagsBySession(mc, "ses-1");
        expect(tags.filter((t) => t.toolOwnerMessageId === "msg-1")).toHaveLength(1);
        expect(tags.filter((t) => t.toolOwnerMessageId === null)).toHaveLength(2);

        const retry = runToolOwnerBackfill(mc);
        expect(retry.sessionsProcessed).toBe(1);
        expect(retry.sessionsCompleted).toBe(0);
        expect(retry.sessionsErrored).toBe(0);
        expect(_getBackfillState(mc, "ses-1")?.status).toBe("pending");

        closeQuietly(mc);
    });

    test("OpenCode DB missing → all sessions marked skipped", () => {
        const dataHome = createTempDir("mc-backfill-no-oc-");
        process.env.XDG_DATA_HOME = dataHome;
        // Don't create the OC DB — simulates Pi-only install.
        const mc = createMcDb();
        insertTag(mc, "ses-1", "read:1", "tool", 100, 1);
        insertTag(mc, "ses-2", "read:1", "tool", 100, 1);

        const result = runToolOwnerBackfill(mc);
        expect(result.sessionsSkippedNoOcDb).toBeGreaterThan(0);
        expect(result.rowsUpdated).toBe(0);

        // State table records them as skipped.
        expect(_getBackfillState(mc, "ses-1")?.status).toBe("skipped");
        expect(_getBackfillState(mc, "ses-2")?.status).toBe("skipped");

        // Tag rows remain NULL — lazy adoption handles them at runtime.
        const tags1 = getTagsBySession(mc, "ses-1");
        expect(tags1[0].toolOwnerMessageId).toBeNull();

        closeQuietly(mc);
    });

    test("session in OpenCode DB but no tool parts → marked skipped (no_oc_matches)", () => {
        // A session that exists in the MC tags table but has no
        // matching assistant tool parts in OC — could happen if the
        // OC session was deleted/pruned. Backfill marks it skipped
        // so it's not retried forever.
        const oc = buildOpencodeDb(
            [{ id: "msg-1", sessionId: "ses-1", role: "user", timeCreated: 1000 }],
            [],
        );
        oc.close();
        const mc = createMcDb();
        insertTag(mc, "ses-1", "read:1", "tool", 100, 1);

        const result = runToolOwnerBackfill(mc);
        expect(result.sessionsSkippedNoMatches).toBe(1);

        expect(_getBackfillState(mc, "ses-1")?.status).toBe("skipped");
        expect(_getBackfillState(mc, "ses-1")?.last_error).toBe("no_oc_matches");

        closeQuietly(mc);
    });

    test("idempotent: running backfill twice does not re-process completed sessions", () => {
        const oc = buildOpencodeDb(
            [{ id: "msg-1", sessionId: "ses-1", role: "assistant", timeCreated: 1000 }],
            [
                {
                    id: "p1",
                    messageId: "msg-1",
                    type: "tool",
                    callId: "read:1",
                    timeCreated: 1100,
                },
            ],
        );
        oc.close();
        const mc = createMcDb();
        insertTag(mc, "ses-1", "read:1", "tool", 100, 1);

        const r1 = runToolOwnerBackfill(mc);
        expect(r1.sessionsCompleted).toBe(1);
        expect(r1.rowsUpdated).toBe(1);

        // Second run sees the completed state row and short-circuits.
        const r2 = runToolOwnerBackfill(mc);
        expect(r2.sessionsProcessed).toBe(0);
        expect(r2.rowsUpdated).toBe(0);

        closeQuietly(mc);
    });

    test("NULL-guarded UPDATE: backfill does not clobber a row already adopted at runtime", () => {
        // Simulates the race where a runtime adoption populated
        // owner between backfill SELECT and UPDATE. The NULL guard
        // ensures backfill matches zero rows.
        const oc = buildOpencodeDb(
            [{ id: "msg-old", sessionId: "ses-1", role: "assistant", timeCreated: 1000 }],
            [
                {
                    id: "p1",
                    messageId: "msg-old",
                    type: "tool",
                    callId: "read:1",
                    timeCreated: 1100,
                },
            ],
        );
        oc.close();
        const mc = createMcDb();
        insertTag(mc, "ses-1", "read:1", "tool", 100, 1);

        // Pre-populate owner via direct SQL — simulates lazy-adoption
        // having claimed the row to msg-runtime.
        mc.prepare(
            "UPDATE tags SET tool_owner_message_id = ? WHERE session_id = ? AND tag_number = ?",
        ).run("msg-runtime", "ses-1", 1);

        const result = runToolOwnerBackfill(mc);
        // The backfill found owner=msg-old in OC DB but the runtime
        // adoption already set msg-runtime. NULL-guard means
        // rowsUpdated = 0; the row keeps msg-runtime.
        expect(result.rowsUpdated).toBe(0);

        const tags = getTagsBySession(mc, "ses-1");
        expect(tags[0].toolOwnerMessageId).toBe("msg-runtime");

        closeQuietly(mc);
    });

    test("ORDER BY determinism: identical time_created ties broken by id", () => {
        // Two assistant messages with the SAME time_created. The
        // ORDER BY tiebreaker on m.id ASC must produce deterministic
        // owner selection.
        const oc = buildOpencodeDb(
            [
                { id: "msg-A", sessionId: "ses-1", role: "assistant", timeCreated: 1000 },
                { id: "msg-B", sessionId: "ses-1", role: "assistant", timeCreated: 1000 },
            ],
            [
                {
                    id: "p-A",
                    messageId: "msg-A",
                    type: "tool",
                    callId: "read:1",
                    timeCreated: 1100,
                },
                {
                    id: "p-B",
                    messageId: "msg-B",
                    type: "tool",
                    callId: "read:1",
                    timeCreated: 1100,
                },
            ],
        );
        oc.close();
        const mc = createMcDb();
        insertTag(mc, "ses-1", "read:1", "tool", 100, 1);

        runToolOwnerBackfill(mc);

        // 'msg-A' < 'msg-B' lexicographically, so msg-A wins.
        const tags = getTagsBySession(mc, "ses-1");
        expect(tags[0].toolOwnerMessageId).toBe("msg-A");

        closeQuietly(mc);
    });

    test("lease acquired then released → second run completes the session", () => {
        // Process A acquires the lease and crashes. Process B should
        // see the row exists but skip-because-lease-held while the
        // lease is alive, then claim once it expires. Hard to
        // simulate process death cleanly in-process; instead we
        // simulate by manipulating lease_expires_at directly.
        const oc = buildOpencodeDb(
            [{ id: "msg-1", sessionId: "ses-1", role: "assistant", timeCreated: 1000 }],
            [
                {
                    id: "p1",
                    messageId: "msg-1",
                    type: "tool",
                    callId: "read:1",
                    timeCreated: 1100,
                },
            ],
        );
        oc.close();
        const mc = createMcDb();
        insertTag(mc, "ses-1", "read:1", "tool", 100, 1);

        // Trigger the state table creation by calling
        // isToolOwnerBackfillNeeded — it ensures the table exists.
        // Real production code creates it via the first
        // runToolOwnerBackfill call.
        // Plant a stale 'running' row with an unexpired lease.
        // ensureBackfillStateTable runs inside isToolOwnerBackfillNeeded.
        // We can't import that helper directly, so route through a
        // benign call that lands the table:
        runToolOwnerBackfill(mc); // first run creates state, completes session
        // Reset state so we can test the "blocked by lease" path
        // against a fresh setup.
        mc.exec("DELETE FROM tool_owner_backfill_state");
        mc.exec("UPDATE tags SET tool_owner_message_id = NULL");

        const futureLease = Date.now() + 10 * 60 * 1000;
        mc.prepare(
            `INSERT INTO tool_owner_backfill_state(session_id, status, started_at, lease_expires_at)
             VALUES ('ses-1', 'running', ?, ?)`,
        ).run(Date.now(), futureLease);

        const r1 = runToolOwnerBackfill(mc);
        expect(r1.sessionsBlockedByLease).toBe(1);
        expect(r1.rowsUpdated).toBe(0);

        // Now expire the lease and re-run.
        mc.prepare(
            "UPDATE tool_owner_backfill_state SET lease_expires_at = ? WHERE session_id = ?",
        ).run(Date.now() - 1, "ses-1");

        const r2 = runToolOwnerBackfill(mc);
        expect(r2.sessionsCompleted).toBe(1);
        expect(r2.rowsUpdated).toBe(1);

        closeQuietly(mc);
    });

    test("ATTACH succeeds when the OpenCode DB path contains a single quote", () => {
        // Regression guard: the OpenCode DB path is interpolated into an
        // `ATTACH '<path>'` statement (SQLite/bun:sqlite reject a bound
        // parameter there), so an unescaped single quote in the path would
        // break out of the SQL string literal and throw a syntax error. The
        // path is resolved from XDG_DATA_HOME via getDataDir(), so a data home
        // containing a quote exercises the escaping end-to-end.
        const fs = require("node:fs");
        const base = createTempDir("mc-backfill-quote-");
        const dataHome = join(base, "o'brien");
        fs.mkdirSync(dataHome, { recursive: true });
        process.env.XDG_DATA_HOME = dataHome;

        // OpenCode DB at $XDG_DATA_HOME/opencode/opencode.db with one tool part.
        const ocDir = join(dataHome, "opencode");
        fs.mkdirSync(ocDir, { recursive: true });
        const oc = new Database(join(ocDir, "opencode.db"));
        oc.exec(`
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE part (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );
        `);
        oc.prepare(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
        ).run("msg-A", "ses-1", 1000, JSON.stringify({ role: "assistant" }));
        oc.prepare("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)").run(
            "p-A",
            "msg-A",
            1100,
            JSON.stringify({ type: "tool", callID: "read:1" }),
        );
        oc.close();

        const mc = createMcDb();
        insertTag(mc, "ses-1", "read:1", "tool", 100, 1);

        // No throw + the session is backfilled proves ATTACH parsed the quoted path.
        const result = runToolOwnerBackfill(mc);
        expect(result.sessionsCompleted).toBe(1);
        expect(result.rowsUpdated).toBe(1);
        const tags = getTagsBySession(mc, "ses-1");
        expect(tags[0].toolOwnerMessageId).toBe("msg-A");

        closeQuietly(mc);
    });
});
