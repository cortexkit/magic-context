/// <reference types="bun-types" />
/**
 * Reproduction: a message that is committed to OpenCode's `message` table after
 * a message created later than it has already been counted.
 *
 * OpenCode stores `time_created` as the time the message object was created, not
 * the time its row was written, so two messages created a few milliseconds apart
 * can be written in the opposite order. Every reader here orders by
 * `(time_created, id)`. The warm rank checkpoints in read-session-raw.ts are
 * only ever extended past their newest checkpoint, so a row that lands behind
 * that point is never counted on this connection. Every checkpoint taken after
 * it is one short, and so is every ordinal derived from those checkpoints: the
 * session count, id-to-ordinal lookups (used by live message indexing), and the
 * first page of an ordinal range read (used by the historian's chunk reader).
 * A fresh connection (a restart) counts correctly again.
 *
 * Expected values below come from a recount of the table with the rule the
 * stored ordinals are meant to follow: rows of the session ordered by
 * `(time_created, id)`, 1-based, finished compaction summaries skipped.
 */
import { Database as RawDatabase } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "../../features/magic-context/__tests__/opencode1-query-fixture";
import { createTestTempDir } from "../../shared/test-temp-dir";
import {
    prewarmRawSessionOrdinalsForDb,
    resetRawSessionOrdinalWarmupsForTest,
} from "./raw-ordinal-warmup";
import { readSessionChunk } from "./read-session-chunk";
import { closeReadOnlySessionDb, withReadOnlySessionDb } from "./read-session-db";
import {
    countRawSessionMessageOrdinalsFromDb,
    readRawSessionMessageByIdFromDb,
    readRawSessionMessageOrdinalByIdFromDb,
} from "./read-session-raw";

const SESSION = "ses-late-commit";
const id = (index: number) => `msg-${String(index).padStart(8, "0")}`;
/** Time slots 100 ms apart leave room for the pair created 73 ms apart. */
const timeOf = (index: number) => index * 100;

function insertMessage(
    source: RawDatabase,
    messageId: string,
    timeCreated: number,
    role: string,
    text: string,
): void {
    source
        .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
        .run(messageId, SESSION, timeCreated, timeCreated, JSON.stringify({ role }));
    source
        .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
        .run(
            `part-${messageId}`,
            messageId,
            SESSION,
            timeCreated,
            timeCreated,
            JSON.stringify({ type: "text", text }),
        );
}

/** The reference order: (time_created, id), 1-based, finished summaries skipped. */
function recount(source: RawDatabase): { byId: Map<string, number>; byOrdinal: string[] } {
    const rows = source
        .prepare(
            `SELECT id FROM message WHERE session_id = ?
               AND NOT (COALESCE(json_type(data, '$.summary'), '') = 'true'
                        AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')
             ORDER BY time_created, id`,
        )
        .all(SESSION) as Array<{ id: string }>;
    return {
        byId: new Map(rows.map((row, index) => [row.id, index + 1])),
        byOrdinal: rows.map((row) => row.id),
    };
}

test("a message written after a later-created one keeps warm ordinals one short", async () => {
    const temp = createTestTempDir("mc-ordinal-late-commit-");
    const path = join(temp.dir, "opencode.db");
    const source = new RawDatabase(path);
    source.exec("PRAGMA journal_mode=WAL");
    source.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
    const initial = 1024;
    source.transaction(() => {
        for (let index = 0; index < initial; index++)
            insertMessage(source, id(index), timeOf(index), "user", `message ${index}`);
    })();
    const previousPath = process.env.OPENCODE_DB;
    process.env.OPENCODE_DB = path;
    closeReadOnlySessionDb();
    try {
        const drifted = await withReadOnlySessionDb(async (reader) => {
            expect(await prewarmRawSessionOrdinalsForDb(reader, SESSION)).toBe("warm");

            // A user message and its assistant reply, created 73 ms apart. The
            // reply's row is written first and this connection counts it...
            const user = "msg-late-user";
            const reply = "msg-late-reply";
            insertMessage(source, reply, timeOf(initial) + 73, "assistant", "the reply");
            expect(await prewarmRawSessionOrdinalsForDb(reader, SESSION)).toBe("warm");
            expect(readRawSessionMessageOrdinalByIdFromDb(reader, SESSION, reply)).toBe(
                initial + 1,
            );
            // ...then the user message's row is written, sorting before the reply.
            insertMessage(source, user, timeOf(initial), "user", "the late user message");

            // The session carries on: 300 more messages, enough to pass the next
            // 256-row checkpoint.
            for (let index = initial + 1; index <= initial + 300; index++)
                insertMessage(source, id(index), timeOf(index), "user", `message ${index}`);
            expect(await prewarmRawSessionOrdinalsForDb(reader, SESSION)).toBe("warm");

            const truth = recount(source);
            const probe = id(initial + 280);
            // The historian has summarized through `previousEnd` and asks for the
            // next chunk, as compartment-runner does with offset = end + 1.
            const previousEnd = truth.byId.get(id(initial + 266)) as number;
            const chunk = readSessionChunk(SESSION, 120, previousEnd + 1);
            return {
                truth,
                chunk,
                expected: {
                    sessionCount: truth.byOrdinal.length,
                    ordinalOfProbe: truth.byId.get(probe),
                    indexedOrdinalOfProbe: truth.byId.get(probe),
                    chunkStart: {
                        ordinal: chunk.startIndex,
                        id: truth.byOrdinal[chunk.startIndex - 1],
                    },
                    chunkEnd: { ordinal: chunk.endIndex, id: truth.byOrdinal[chunk.endIndex - 1] },
                },
                actual: {
                    sessionCount: countRawSessionMessageOrdinalsFromDb(reader, SESSION),
                    ordinalOfProbe: readRawSessionMessageOrdinalByIdFromDb(reader, SESSION, probe),
                    indexedOrdinalOfProbe: readRawSessionMessageByIdFromDb(reader, SESSION, probe)
                        ?.ordinal,
                    chunkStart: { ordinal: chunk.startIndex, id: chunk.startMessageId },
                    chunkEnd: { ordinal: chunk.endIndex, id: chunk.endMessageId },
                },
            };
        });
        // A new connection (an OpenCode restart) counts the whole session again.
        // The historian resumes at the stored end ordinal + 1. That end was one
        // short, so after the recount ordinal end + 1 is the previous chunk's
        // own last message, which would be summarized a second time.
        closeReadOnlySessionDb();
        const restarted = await withReadOnlySessionDb(async (reader) => {
            expect(await prewarmRawSessionOrdinalsForDb(reader, SESSION)).toBe("warm");
            const next = readSessionChunk(SESSION, 120, drifted.chunk.endIndex + 1);
            return {
                expected: {
                    sessionCount: drifted.truth.byOrdinal.length,
                    nextChunkRepeatsPreviousEnd: false,
                },
                actual: {
                    sessionCount: countRawSessionMessageOrdinalsFromDb(reader, SESSION),
                    nextChunkRepeatsPreviousEnd:
                        next.messageCount > 0 && next.startMessageId === drifted.chunk.endMessageId,
                },
            };
        });
        expect({ drifted: drifted.actual, restarted: restarted.actual }).toEqual({
            drifted: drifted.expected,
            restarted: restarted.expected,
        });
    } finally {
        closeReadOnlySessionDb();
        if (previousPath === undefined) delete process.env.OPENCODE_DB;
        else process.env.OPENCODE_DB = previousPath;
        source.close();
        resetRawSessionOrdinalWarmupsForTest();
        temp.cleanup();
    }
}, 30_000);
