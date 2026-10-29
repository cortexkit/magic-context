/// <reference types="bun-types" />
/**
 * The next historian chunk continues after the last summarized message id,
 * resolved through the host's own order — not at the stored `end_message + 1`.
 *
 * A stored end number that sits one short of its end id used to repeat the
 * end message in the next chunk (and, combined with a drifted reader, to
 * skip one). Resolving the stored id through the host order starts the chunk
 * right after the summarized message on every host: the OpenCode 1
 * canonical read, the OpenCode 2 seq-based SQL read, and (in the companion
 * pi-plugin test) the Pi branch walk.
 */
import { Database as RawDatabase } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "../../features/magic-context/__tests__/opencode1-query-fixture";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { createV2RawMessageProvider, createV2RawMessageReader } from "../../v2/hooks/store";
import { V2StoreReader } from "../../v2/store-reader";
import {
    prewarmRawSessionOrdinalsForDb,
    resetRawSessionOrdinalWarmupsForTest,
} from "./raw-ordinal-warmup";
import {
    readSessionChunk,
    resolveHistorianChunkStart,
    setBoundedRawMessageProvider,
} from "./read-session-chunk";
import { closeReadOnlySessionDb, withReadOnlySessionDb } from "./read-session-db";

const id = (index: number) => `msg-${String(index).padStart(8, "0")}`;
const timeOf = (index: number) => index * 100;

function insertOpenCode1Message(
    source: RawDatabase,
    messageId: string,
    timeCreated: number,
    text: string,
): void {
    source
        .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
        .run(
            messageId,
            "ses-chunk-start",
            timeCreated,
            timeCreated,
            JSON.stringify({ role: "user" }),
        );
    source
        .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
        .run(
            `part-${messageId}`,
            messageId,
            "ses-chunk-start",
            timeCreated,
            timeCreated,
            JSON.stringify({ type: "text", text }),
        );
}

test("OpenCode 1: a stored end_message one short of its end id continues after the id", async () => {
    const temp = createTestTempDir("mc-chunk-start-oc1-");
    const path = join(temp.dir, "opencode.db");
    const source = new RawDatabase(path);
    source.exec("PRAGMA journal_mode=WAL");
    source.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
    for (let index = 0; index < 10; index++)
        insertOpenCode1Message(
            source,
            id(index),
            timeOf(index),
            `message ${index} with enough content to survive the noise gate`,
        );
    const previousPath = process.env.OPENCODE_DB;
    process.env.OPENCODE_DB = path;
    closeReadOnlySessionDb();
    try {
        await withReadOnlySessionDb(async (reader) => {
            expect(await prewarmRawSessionOrdinalsForDb(reader, "ses-chunk-start")).toBe("warm");
        });

        // The compartment covers through the 9th message (true ordinal 9) but
        // its stored number says 8. The next chunk must start at 10: the
        // message after the end id, skipping nothing and repeating nothing.
        expect(
            resolveHistorianChunkStart("ses-chunk-start", {
                endMessage: 8,
                endMessageId: id(8),
            }),
        ).toBe(10);
        const chunk = readSessionChunk("ses-chunk-start", 1_000_000, 10);
        expect(chunk.startIndex).toBe(10);
        expect(chunk.startMessageId).toBe(id(9));
        expect(chunk.endMessageId).toBe(id(9));
        expect(chunk.lines.map((line) => line.messageId)).toEqual([id(9)]);

        // The end id is gone from history (a revert): with no position to
        // resolve, the stored number stands, exactly as before.
        expect(
            resolveHistorianChunkStart("ses-chunk-start", {
                endMessage: 8,
                endMessageId: "msg-gone",
            }),
        ).toBe(9);
        expect(resolveHistorianChunkStart("ses-chunk-start", null)).toBe(1);

        // A block-indexed end (Rust historian) still continues at the next
        // message; starting inside it would leave the earlier end uncovered.
        expect(
            resolveHistorianChunkStart("ses-chunk-start", {
                endMessage: 8,
                endMessageId: id(8),
                endBlockIndex: 0,
            }),
        ).toBe(10);
    } finally {
        closeReadOnlySessionDb();
        if (previousPath === undefined) delete process.env.OPENCODE_DB;
        else process.env.OPENCODE_DB = previousPath;
        source.close();
        resetRawSessionOrdinalWarmupsForTest();
        temp.cleanup();
    }
}, 30_000);

test("OpenCode 2: a provider session keeps the stored-number start", () => {
    const temp = createTestTempDir("mc-chunk-start-oc2-");
    const path = join(temp.dir, "opencode.db");
    const db = new RawDatabase(path);
    try {
        db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
            CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);`);
        const insert = db.prepare("INSERT INTO session_message VALUES (?, 's', ?, ?, 10, ?)");
        for (let seq = 1; seq <= 10; seq++) {
            insert.run(
                `m-${seq}`,
                "user",
                seq,
                JSON.stringify({
                    text: `message ${seq} with enough content to survive the noise gate`,
                }),
            );
        }
        const reader = createV2RawMessageReader(() => new V2StoreReader(path));
        const unregister = setBoundedRawMessageProvider(
            "s",
            createV2RawMessageProvider(reader, "s"),
        );
        try {
            // Provider sessions number in their own coordinates; only OpenCode
            // 1's store-file count can drift, so the end id is not consulted.
            expect(resolveHistorianChunkStart("s", { endMessage: 8, endMessageId: "m-9" })).toBe(9);
            expect(resolveHistorianChunkStart("s", null)).toBe(1);
        } finally {
            unregister();
        }
    } finally {
        db.close();
        temp.cleanup();
    }
});
