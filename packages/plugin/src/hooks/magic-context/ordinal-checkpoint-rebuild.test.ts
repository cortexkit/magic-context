/// <reference types="bun-types" />
/**
 * When the exact validation exposes drifted serving-thread ranks, dropping
 * them for the session rebuilds the count from a full scan on the same
 * connection: the session count, id-to-ordinal lookups and the historian
 * chunk all match the recount without a restart.
 *
 * The drift setup mirrors ordinal-late-commit-drift.test.ts: a message
 * created earlier is written after a message created later, so the serving
 * thread's rank checkpoints never count it until the connection is rebuilt.
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
    dropRawSessionOrdinalCheckpoints,
    RawOrdinalsNotReady,
    readRawSessionMessageByIdFromDb,
    readRawSessionMessageOrdinalByIdFromDb,
} from "./read-session-raw";

const SESSION = "ses-late-commit-rebuild";
const id = (index: number) => `msg-${String(index).padStart(8, "0")}`;
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

test("dropping drifted checkpoints rebuilds serving ranks from a full scan", async () => {
    const temp = createTestTempDir("mc-ordinal-rebuild-");
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
        await withReadOnlySessionDb(async (reader) => {
            expect(await prewarmRawSessionOrdinalsForDb(reader, SESSION)).toBe("warm");

            const user = "msg-late-user";
            const reply = "msg-late-reply";
            insertMessage(source, reply, timeOf(initial) + 73, "assistant", "the reply");
            expect(await prewarmRawSessionOrdinalsForDb(reader, SESSION)).toBe("warm");
            expect(readRawSessionMessageOrdinalByIdFromDb(reader, SESSION, reply)).toBe(
                initial + 1,
            );
            insertMessage(source, user, timeOf(initial), "user", "the late user message");
            for (let index = initial + 1; index <= initial + 300; index++)
                insertMessage(source, id(index), timeOf(index), "user", `message ${index}`);
            expect(await prewarmRawSessionOrdinalsForDb(reader, SESSION)).toBe("warm");

            const truth = recount(source);
            const probe = id(initial + 280);
            const previousEnd = truth.byId.get(id(initial + 266)) as number;

            // The third warm-up already healed the drift: extending the
            // retained ranks would have missed the late write, so the
            // extension dropped them and rebuilt from a full scan instead.
            // Count, id lookups and the historian chunk match the recount on
            // the same connection, without a restart.
            const healed = () => ({
                sessionCount: countRawSessionMessageOrdinalsFromDb(reader, SESSION),
                ordinalOfProbe: readRawSessionMessageOrdinalByIdFromDb(reader, SESSION, probe),
                indexedOrdinalOfProbe: readRawSessionMessageByIdFromDb(reader, SESSION, probe)
                    ?.ordinal,
                chunk: readSessionChunk(SESSION, 120, previousEnd + 1),
            });
            const first = healed();
            expect(first.sessionCount).toBe(truth.byOrdinal.length);
            expect(first.ordinalOfProbe).toBe(truth.byId.get(probe));
            expect(first.indexedOrdinalOfProbe).toBe(truth.byId.get(probe));
            expect(first.chunk.startMessageId).toBe(truth.byOrdinal[first.chunk.startIndex - 1]);
            expect(first.chunk.endMessageId).toBe(truth.byOrdinal[first.chunk.endIndex - 1]);
            expect(first.chunk.startIndex).toBe(previousEnd + 1);

            // The explicit drop heals the same way on demand. Until the next
            // warm-up installs rebuilt ranks, bounded reads defer instead of
            // answering from a half-dropped cache.
            dropRawSessionOrdinalCheckpoints(reader, SESSION);
            expect(() => countRawSessionMessageOrdinalsFromDb(reader, SESSION)).toThrow(
                RawOrdinalsNotReady,
            );
            expect(await prewarmRawSessionOrdinalsForDb(reader, SESSION)).toBe("warm");

            const second = healed();
            expect(second.sessionCount).toBe(truth.byOrdinal.length);
            expect(second.ordinalOfProbe).toBe(truth.byId.get(probe));
            expect(second.indexedOrdinalOfProbe).toBe(truth.byId.get(probe));
            expect(second.chunk.startMessageId).toBe(truth.byOrdinal[second.chunk.startIndex - 1]);
            expect(second.chunk.endMessageId).toBe(truth.byOrdinal[second.chunk.endIndex - 1]);
            expect(second.chunk.startIndex).toBe(previousEnd + 1);
        });
    } finally {
        closeReadOnlySessionDb();
        if (previousPath === undefined) delete process.env.OPENCODE_DB;
        else process.env.OPENCODE_DB = previousPath;
        source.close();
        resetRawSessionOrdinalWarmupsForTest();
        temp.cleanup();
    }
}, 60_000);
