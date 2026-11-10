import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../shared/test-temp-dir";
import { restoreRow } from "./fold/restore";
import { oc2ContextFixture } from "./hooks/__tests__/oc2-context.fixture";
import { V2StoreReader } from "./store-reader";

// OpenCode 2.2.6 with `experimental.part_rows: true` (the table exists since
// 2.2.2) stores an assistant message's content in `session_part`, one row per
// part, and leaves `content: []` in the `session_message` row. OpenCode reads
// the part rows as the content. Before the reader did the same, every place
// that rebuilds an assistant message from the store (rows restored around a
// host checkpoint, the historian's chunk) saw an assistant with no content:
// measured on a real 2.2.6 host, every restored assistant reply was missing
// from the request after a manual compaction.

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) cleanupTestTempDir(root);
});

const REPLY = { type: "text", text: "PART_ROW_REPLY" };
const TOOL = {
    type: "tool",
    id: "call-1",
    name: "read",
    state: {
        status: "completed",
        input: { path: "a.ts" },
        content: [{ type: "text", text: "PART_ROW_TOOL_OUTPUT" }],
    },
};

const model = { providerID: "openai", id: "mock-model" };
const USER_DATA = JSON.stringify({ text: "Read the file.", time: { created: 1000 } });
const assistantData = (content: unknown[]) =>
    JSON.stringify({
        content,
        model,
        time: { created: 2000, completed: 3000 },
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    });

/** A small OpenCode 2 store: one user row and one assistant row whose content
 * is either inline or, as OpenCode 2.2.6 writes it with part rows, in
 * `session_part`. `table` creates the (2.2.2+) part table even when unused. */
function store({ table, parts }: { table: boolean; parts: boolean }) {
    const base = join(tmpdir(), "magic-context", "oc2-part-rows");
    mkdirSync(base, { recursive: true });
    const root = createTestTempDirFromPath(join(base, "store-"));
    roots.push(root);
    const path = join(root, "opencode.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
        seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)`);
    if (table || parts)
        db.exec(`CREATE TABLE session_part (message_id TEXT NOT NULL, session_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL, type TEXT NOT NULL, call_id TEXT, time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (message_id, ordinal))`);
    const insert = db.prepare(
        "INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)",
    );
    insert.run("m-user", "s", "user", 1, 1000, 1000, USER_DATA);
    insert.run(
        "m-assistant",
        "s",
        "assistant",
        2,
        2000,
        2000,
        assistantData(parts ? [] : [REPLY, TOOL]),
    );
    if (parts) {
        const part = db.prepare(
            "INSERT INTO session_part(message_id,session_id,ordinal,type,call_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?,?)",
        );
        part.run("m-assistant", "s", 0, "text", null, 2000, 3000, JSON.stringify(REPLY));
        part.run("m-assistant", "s", 1, "tool", "call-1", 2000, 3000, JSON.stringify(TOOL));
    }
    db.close();
    return path;
}

test("assistant content stored in session_part is read with its message on every read path", () => {
    const reader = new V2StoreReader(store({ table: true, parts: true }));
    try {
        const reads = {
            range: reader.range("s", -1, 2).find((row) => row.id === "m-assistant"),
            messageById: reader.messageById("s", "m-assistant"),
            rawRowsThrough: reader
                .rawRowsThrough("s", 2, 10)
                .find((row) => row.id === "m-assistant"),
            assistantSince: reader.assistantSince("s", -1)[0],
            latestAssistant: reader.latestAssistant("s"),
        };
        for (const [path, row] of Object.entries(reads)) {
            expect({ path, content: row?.data.content }).toEqual({ path, content: [REPLY, TOOL] });
        }
        // The message a restore around a host checkpoint would serve.
        const restored = JSON.stringify(restoreRow(reads.range!, model));
        expect(restored).toContain("PART_ROW_REPLY");
        expect(restored).toContain("PART_ROW_TOOL_OUTPUT");
    } finally {
        reader.close();
    }
});

test("an edit to a part row changes its message's stamp", () => {
    const path = store({ table: true, parts: true });
    const before = (() => {
        const reader = new V2StoreReader(path);
        try {
            return reader.spanRowStamps("s", -1, 2);
        } finally {
            reader.close();
        }
    })();
    const db = new Database(path);
    db.prepare(
        "UPDATE session_part SET data = ?, time_updated = 4000 WHERE message_id = 'm-assistant' AND ordinal = 0",
    ).run(JSON.stringify({ type: "text", text: "PART_ROW_REPLY_EDITED" }));
    db.close();
    const reader = new V2StoreReader(path);
    try {
        const after = reader.spanRowStamps("s", -1, 2);
        expect(after.get(1)).toBe(before.get(1)!);
        expect(after.get(2)).not.toBe(before.get(2)!);
    } finally {
        reader.close();
    }
});

test("without part rows, rows, stamps and digests are byte-identical with or without the part table", () => {
    const read = (path: string) => {
        const reader = new V2StoreReader(path);
        try {
            const rows = JSON.stringify(reader.range("s", -1, 2));
            return {
                rows,
                digest: createHash("sha256").update(rows).digest("hex"),
                stamps: JSON.stringify([...reader.spanRowStamps("s", -1, 2)]),
                restored: JSON.stringify(
                    reader.range("s", -1, 2).map((row) => restoreRow(row, model)),
                ),
            };
        } finally {
            reader.close();
        }
    };
    const withoutTable = read(store({ table: false, parts: false }));
    const withEmptyTable = read(store({ table: true, parts: false }));
    expect(withEmptyTable).toEqual(withoutTable);
    // The stamp of a row without part rows keeps its earlier format: id, update
    // time and data size, separated by NUL characters.
    expect(JSON.parse(withoutTable.stamps)).toEqual([
        [1, ["m-user", 1000, Buffer.byteLength(USER_DATA)].join("\u0000")],
        [2, ["m-assistant", 2000, Buffer.byteLength(assistantData([REPLY, TOOL]))].join("\u0000")],
    ]);
});

test("a session without part rows gets byte-identical requests with or without the part table", async () => {
    // Separate seeds keep process-wide per-session caches apart; seeds 15 apart
    // give rows of the same lengths, so only the seed text differs.
    const run = async (table: boolean) => {
        const seed = table ? 44901 : 44886;
        const f = await oc2ContextFixture(seed, {
            area: "oc2-part-rows-bytes",
            instructions: false,
            temporal: false,
            cacheTtl: "never",
        });
        try {
            if (table)
                f.raw.exec(`CREATE TABLE session_part (message_id TEXT NOT NULL, session_id TEXT NOT NULL,
                    ordinal INTEGER NOT NULL, type TEXT NOT NULL, call_id TEXT, time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (message_id, ordinal))`);
            const requests: string[] = [];
            const pass = async () =>
                requests.push((await f.pass()).bytes.split(String(seed)).join("SEED"));
            f.compartment(4);
            await pass();
            f.respond();
            await pass();
            // A manual fold makes the next pass restore rows from the store.
            await f.nativeFold(3, 0, "", "manual");
            await pass();
            await pass();
            return requests;
        } finally {
            await f.cleanup();
        }
    };
    const withoutTable = await run(false);
    const withEmptyTable = await run(true);
    expect(withEmptyTable).toEqual(withoutTable);
}, 60000);
