/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    getProtectedTailStartOrdinal,
    getRawSessionMessageIdsThrough,
    readRawSessionMessages,
    readSessionChunk,
    withRawSessionMessageCache,
} from "./read-session-chunk";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function createOpenCodeDb(sessionId: string): void {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
      CREATE TABLE IF NOT EXISTS message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS part (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);

        const insertMessage = db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        const insertPart = db.prepare(
            "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );

        const messages = [
            { id: "m-1", role: "user", part: { type: "text", text: "hello" } },
            { id: "m-2", role: "assistant", part: { type: "tool", callID: "call-1" } },
            { id: "m-3", role: "assistant", part: { type: "text", text: "done" } },
        ];

        messages.forEach((message, index) => {
            const timestamp = index + 1;
            insertMessage.run(
                message.id,
                sessionId,
                timestamp,
                timestamp,
                JSON.stringify({ id: message.id, role: message.role, sessionID: sessionId }),
            );
            insertPart.run(
                message.id,
                sessionId,
                timestamp,
                timestamp,
                JSON.stringify(message.part),
            );
        });
    } finally {
        closeQuietly(db);
    }
}

function createOpenCodeDbWithMessages(
    sessionId: string,
    messages: Array<{ id: string; role: string; part: Record<string, unknown> }>,
): void {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
      CREATE TABLE IF NOT EXISTS message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS part (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);

        const insertMessage = db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        const insertPart = db.prepare(
            "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );

        messages.forEach((message, index) => {
            const timestamp = index + 1;
            insertMessage.run(
                message.id,
                sessionId,
                timestamp,
                timestamp,
                JSON.stringify({ id: message.id, role: message.role, sessionID: sessionId }),
            );
            insertPart.run(
                message.id,
                sessionId,
                timestamp,
                timestamp,
                JSON.stringify(message.part),
            );
        });
    } finally {
        closeQuietly(db);
    }
}

function appendOpenCodeMessage(
    sessionId: string,
    message: { id: string; role: string; part: Record<string, unknown> },
    timestamp: number,
): void {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    const db = new Database(dbPath);
    try {
        db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        ).run(
            message.id,
            sessionId,
            timestamp,
            timestamp,
            JSON.stringify({ id: message.id, role: message.role, sessionID: sessionId }),
        );
        db.prepare(
            "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        ).run(message.id, sessionId, timestamp, timestamp, JSON.stringify(message.part));
    } finally {
        closeQuietly(db);
    }
}

describe("readSessionChunk", () => {
    it("reads raw OpenCode messages with stable ordinals and ids", () => {
        useTempDataHome("read-session-chunk-");
        createOpenCodeDb("ses-raw");

        const chunk = readSessionChunk("ses-raw", 10_000, 1);

        expect(chunk.startIndex).toBe(1);
        expect(chunk.endIndex).toBe(3);
        expect(chunk.startMessageId).toBe("m-1");
        expect(chunk.endMessageId).toBe("m-3");
        expect(chunk.text).toContain("[1] U: hello");
        expect(chunk.text).toContain("[2-3] A: done");
        expect(chunk.text).not.toContain("msg_");
        expect(chunk.text).not.toContain("tool call");
    });

    it("reuses cached raw messages within nested cache scopes and clears afterward", () => {
        useTempDataHome("read-session-cache-scope-");
        createOpenCodeDbWithMessages("ses-cache", [
            { id: "m-1", role: "user", part: { type: "text", text: "turn 1" } },
        ]);

        withRawSessionMessageCache(() => {
            const outerRead = readRawSessionMessages("ses-cache");
            expect(outerRead).toHaveLength(1);

            withRawSessionMessageCache(() => {
                const nestedRead = readRawSessionMessages("ses-cache");
                expect(nestedRead).toBe(outerRead);

                appendOpenCodeMessage(
                    "ses-cache",
                    { id: "m-2", role: "assistant", part: { type: "text", text: "turn 2" } },
                    2,
                );

                const nestedCachedRead = readRawSessionMessages("ses-cache");
                expect(nestedCachedRead).toBe(outerRead);
                expect(nestedCachedRead).toHaveLength(1);
            });

            const outerCachedRead = readRawSessionMessages("ses-cache");
            expect(outerCachedRead).toBe(outerRead);
            expect(outerCachedRead).toHaveLength(1);
        });

        const freshRead = readRawSessionMessages("ses-cache");
        expect(freshRead).toHaveLength(2);
    });

    it("returns raw message ids through an ordinal", () => {
        useTempDataHome("read-session-ids-");
        createOpenCodeDb("ses-raw");

        expect(getRawSessionMessageIdsThrough("ses-raw", 2)).toEqual(["m-1", "m-2"]);
    });

    it("extracts commit hashes into compact assistant block metadata", () => {
        useTempDataHome("read-session-commits-");
        createOpenCodeDbWithMessages("ses-commits", [
            { id: "m-1", role: "user", part: { type: "text", text: "ship it" } },
            {
                id: "m-2",
                role: "assistant",
                part: {
                    type: "text",
                    text: "Done. `4301a084` on feat, cherry-picked `7e80a1a7` to integrate.",
                },
            },
            {
                id: "m-3",
                role: "assistant",
                part: { type: "text", text: "Build passes after commit `4301a084`." },
            },
        ]);

        const chunk = readSessionChunk("ses-commits", 10_000, 1);

        expect(chunk.text).toContain("[2-3] A: commits: 4301a084, 7e80a1a7");
        expect(chunk.text).not.toContain("`4301a084`");
        expect(chunk.text).not.toContain("`7e80a1a7`");
    });

    describe("getProtectedTailStartOrdinal", () => {
        it("returns 1 when exactly 5 user turns exist", () => {
            //#given
            useTempDataHome("protected-tail-ordinal-");
            createOpenCodeDbWithMessages("ses-tail", [
                { id: "m-1", role: "user", part: { type: "text", text: "turn 1" } },
                { id: "m-2", role: "assistant", part: { type: "text", text: "reply 1" } },
                { id: "m-3", role: "user", part: { type: "text", text: "turn 2" } },
                { id: "m-4", role: "assistant", part: { type: "text", text: "reply 2" } },
                { id: "m-5", role: "user", part: { type: "text", text: "turn 3" } },
                { id: "m-6", role: "assistant", part: { type: "text", text: "reply 3" } },
            ]);

            //#when
            const ordinal = getProtectedTailStartOrdinal("ses-tail");

            //#then: all 5 user turns are protected
            expect(ordinal).toBe(1);
        });

        it("returns ordinal of the 5th-to-last user message when 6+ user turns exist", () => {
            //#given
            useTempDataHome("protected-tail-6turns-");
            createOpenCodeDbWithMessages("ses-6turns", [
                { id: "m-1", role: "user", part: { type: "text", text: "turn 1" } },
                { id: "m-2", role: "assistant", part: { type: "text", text: "reply 1" } },
                { id: "m-3", role: "user", part: { type: "text", text: "turn 2" } },
                { id: "m-4", role: "assistant", part: { type: "text", text: "reply 2" } },
                { id: "m-5", role: "user", part: { type: "text", text: "turn 3" } },
                { id: "m-6", role: "assistant", part: { type: "text", text: "reply 3" } },
                { id: "m-7", role: "user", part: { type: "text", text: "turn 4" } },
                { id: "m-8", role: "assistant", part: { type: "text", text: "reply 4" } },
                { id: "m-9", role: "user", part: { type: "text", text: "turn 5" } },
                { id: "m-10", role: "assistant", part: { type: "text", text: "reply 5" } },
                { id: "m-11", role: "user", part: { type: "text", text: "turn 6" } },
                { id: "m-12", role: "assistant", part: { type: "text", text: "reply 6" } },
            ]);

            //#when
            const ordinal = getProtectedTailStartOrdinal("ses-6turns");

            //#then: the 5th-to-last user message is m-3 at ordinal 3
            expect(ordinal).toBe(3);
        });

        it("returns 1 when fewer than 5 user turns exist", () => {
            //#given
            useTempDataHome("protected-tail-few-");
            createOpenCodeDbWithMessages("ses-few", [
                { id: "m-1", role: "user", part: { type: "text", text: "only turn" } },
                { id: "m-2", role: "assistant", part: { type: "text", text: "reply" } },
                { id: "m-3", role: "user", part: { type: "text", text: "second turn" } },
            ]);

            //#when
            const ordinal = getProtectedTailStartOrdinal("ses-few");

            //#then: everything is protected
            expect(ordinal).toBe(1);
        });

        it("ignores system-reminder and ignored synthetic user messages when counting protected tail", () => {
            //#given
            useTempDataHome("protected-tail-ignore-synthetic-");
            createOpenCodeDbWithMessages("ses-synthetic", [
                { id: "m-1", role: "user", part: { type: "text", text: "real turn 1" } },
                { id: "m-2", role: "assistant", part: { type: "text", text: "reply 1" } },
                {
                    id: "m-3",
                    role: "user",
                    part: {
                        type: "text",
                        text: "<system-reminder>background finished</system-reminder>\n<!-- OMO_INTERNAL_INITIATOR -->",
                    },
                },
                { id: "m-4", role: "assistant", part: { type: "text", text: "reply 2" } },
                {
                    id: "m-5",
                    role: "user",
                    part: { type: "text", text: "## Magic Status", ignored: true },
                },
                { id: "m-6", role: "assistant", part: { type: "text", text: "reply 3" } },
                { id: "m-7", role: "user", part: { type: "text", text: "real turn 2" } },
                { id: "m-8", role: "assistant", part: { type: "text", text: "reply 4" } },
                { id: "m-9", role: "user", part: { type: "text", text: "real turn 3" } },
                { id: "m-10", role: "assistant", part: { type: "text", text: "reply 5" } },
                { id: "m-11", role: "user", part: { type: "text", text: "real turn 4" } },
            ]);

            //#when
            const ordinal = getProtectedTailStartOrdinal("ses-synthetic");

            //#then: all 4 real user turns are protected because there are fewer than 5
            expect(ordinal).toBe(1);
        });

        it("still counts mixed user messages when real user text remains after stripping reminders", () => {
            //#given
            useTempDataHome("protected-tail-mixed-user-");
            createOpenCodeDbWithMessages("ses-mixed", [
                { id: "m-1", role: "user", part: { type: "text", text: "real turn 1" } },
                { id: "m-2", role: "assistant", part: { type: "text", text: "reply 1" } },
                { id: "m-3", role: "user", part: { type: "text", text: "real turn 2" } },
                { id: "m-4", role: "assistant", part: { type: "text", text: "reply 2" } },
                {
                    id: "m-5",
                    role: "user",
                    part: {
                        type: "text",
                        text: "<system-reminder>background finished</system-reminder>\nPlease also keep this architectural concern in mind.",
                    },
                },
                { id: "m-6", role: "assistant", part: { type: "text", text: "reply 3" } },
                { id: "m-7", role: "user", part: { type: "text", text: "real turn 4" } },
            ]);

            //#when
            const ordinal = getProtectedTailStartOrdinal("ses-mixed");

            //#then: all 4 meaningful user turns are protected because there are fewer than 5
            expect(ordinal).toBe(1);
        });
    });

    describe("readSessionChunk with eligibleEndOrdinal", () => {
        it("stops before the protected tail messages", () => {
            //#given
            useTempDataHome("read-session-eligible-end-");
            createOpenCodeDbWithMessages("ses-eligible", [
                { id: "m-1", role: "user", part: { type: "text", text: "old work" } },
                { id: "m-2", role: "assistant", part: { type: "text", text: "done" } },
                { id: "m-3", role: "user", part: { type: "text", text: "protected turn 1" } },
                { id: "m-4", role: "assistant", part: { type: "text", text: "protected reply 1" } },
                { id: "m-5", role: "user", part: { type: "text", text: "protected turn 2" } },
            ]);

            //#when: eligible end is ordinal 3 (protected tail starts at m-3)
            const chunk = readSessionChunk("ses-eligible", 100_000, 1, 3);

            //#then: only m-1 and m-2 are included
            expect(chunk.text).toContain("old work");
            expect(chunk.text).toContain("done");
            expect(chunk.text).not.toContain("protected turn");
            expect(chunk.endIndex).toBe(2);
            expect(chunk.hasMore).toBe(false);
        });

        it("reports hasMore false when all eligible messages fit within the budget", () => {
            //#given
            useTempDataHome("read-session-hasmore-");
            createOpenCodeDbWithMessages("ses-hasmore", [
                { id: "m-1", role: "user", part: { type: "text", text: "eligible" } },
                { id: "m-2", role: "user", part: { type: "text", text: "tail turn 1" } },
                { id: "m-3", role: "user", part: { type: "text", text: "tail turn 2" } },
                { id: "m-4", role: "user", part: { type: "text", text: "tail turn 3" } },
            ]);

            //#when: eligible end excludes m-2 onward
            const chunk = readSessionChunk("ses-hasmore", 100_000, 1, 2);

            //#then
            expect(chunk.messageCount).toBe(1);
            expect(chunk.hasMore).toBe(false);
        });
    });
});
