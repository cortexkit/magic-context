import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../shared/test-temp-dir";
import { restoreRow } from "./fold/restore";
import { oc2ContextFixture } from "./hooks/__tests__/oc2-context.fixture";
import { RAW_MESSAGE_TYPES, V2StoreReader } from "./store-reader";

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

// Every row shape a store without part rows holds: user, assistant with
// reasoning, text and a tool call, an assistant with empty content, an
// instruction row, an edited row, running and completed compactions, an idle
// row and a directory switch. A second session in the same store may have part
// rows of its own, as on a 2.2.6 store that holds old and new sessions.
function mixedStore(variant: "no-table" | "empty-table" | "other-session-parts") {
    const base = join(tmpdir(), "magic-context", "oc2-part-rows");
    mkdirSync(base, { recursive: true });
    const root = createTestTempDirFromPath(join(base, "mixed-"));
    roots.push(root);
    const path = join(root, "opencode.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
        seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)`);
    if (variant !== "no-table")
        db.exec(`CREATE TABLE session_part (message_id TEXT NOT NULL, session_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL, type TEXT NOT NULL, call_id TEXT, time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (message_id, ordinal))`);
    const insert = db.prepare(
        "INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)",
    );
    const assistant = (content: unknown[], created: number) =>
        JSON.stringify({
            content,
            model,
            time: { created, completed: created + 500 },
            tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 1, write: 2 } },
        });
    const rows: Array<[string, string, number, number | null, string]> = [
        ["u1", "user", 1000, null, JSON.stringify({ text: "Read a.ts.", time: { created: 1000 } })],
        [
            "a1",
            "assistant",
            2000,
            2600,
            assistant(
                [{ type: "reasoning", text: "Thinking.", metadata: { signature: "sig" } }, REPLY, TOOL],
                2000,
            ),
        ],
        ["a-empty", "assistant", 2500, null, assistant([], 2500)],
        ["sys1", "system", 2700, null, JSON.stringify({ text: "Today's date is day 2." })],
        [
            "u2",
            "user",
            3000,
            3100,
            JSON.stringify({ text: "Edited later.", time: { created: 3000 }, metadata: {} }),
        ],
        ["cmp-run", "compaction", 3500, null, JSON.stringify({ status: "running" })],
        [
            "cmp-done",
            "compaction",
            3600,
            3700,
            JSON.stringify({
                status: "completed",
                reason: "manual",
                summary: "Summary text.",
                metadata: { keepID: "u2" },
                time: { completed: 3700 },
            }),
        ],
        ["idle1", "idle", 3800, null, JSON.stringify({ outcome: "succeeded" })],
        ["loc1", "location-switched", 3900, null, JSON.stringify({ directory: "/elsewhere" })],
        ["a2", "assistant", 4000, null, assistant([{ type: "text", text: "Done." }], 4000)],
        ["u3", "user", 5000, null, JSON.stringify({ text: "Thanks.", time: { created: 5000 } })],
    ];
    rows.forEach(([id, type, created, updated, data], index) =>
        insert.run(id, "s", type, index + 1, created, updated, data),
    );
    insert.run("o-a1", "other", "assistant", 1, 1000, 1000, assistant([], 1000));
    if (variant === "other-session-parts")
        db.prepare(
            "INSERT INTO session_part(message_id,session_id,ordinal,type,call_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?,?)",
        ).run("o-a1", "other", 0, "text", null, 1000, 1000, JSON.stringify(REPLY));
    db.close();
    return { path, ids: rows.map(([id]) => id), through: rows.length };
}

const sha = (value: unknown) =>
    createHash("sha256")
        .update(JSON.stringify(value instanceof Map ? [...value] : value) ?? "undefined")
        .digest("hex");

/** Digests of every reader output a session without part rows feeds into requests,
 * restored rows, edit detection and saved fold proofs. */
function readerDigests(path: string, ids: string[], through: number) {
    const reader = new V2StoreReader(path);
    try {
        const range = reader.range("s", -1, through);
        const conversational = (row: { type: string }) =>
            (RAW_MESSAGE_TYPES as readonly string[]).includes(row.type) ||
            row.type === "location-switched";
        return {
            range: sha(range),
            // The formula native fold replay uses for its saved history proof.
            historyDigest: sha(range.filter(conversational)),
            restored: sha(
                range
                    .filter((row) => row.type === "assistant")
                    .map((row) => restoreRow(row, model)),
            ),
            spanRowStamps: sha(reader.spanRowStamps("s", -1, through)),
            spanRowStampsAfter3: sha(reader.spanRowStamps("s", 3, through)),
            page: sha(reader.page("s", {})),
            pageAssistant: sha(reader.page("s", { type: "assistant" })),
            messagePage: sha(reader.messagePage("s", 0, 100, reader.latestSequence("s"))),
            rawRowsThrough: sha(reader.rawRowsThrough("s", through, 100)),
            messageById: sha(ids.map((id) => reader.messageById("s", id))),
            assistantSince: sha(reader.assistantSince("s", -1)),
            latestAssistant: sha(reader.latestAssistant("s")),
            latestCompaction: sha(reader.latestCompaction("s")),
            rowStampsThrough: sha(reader.rowStampsThrough("s", through)),
        };
    } finally {
        reader.close();
    }
}

// Captured by running readerDigests against store-reader.ts as it was before it
// read session_part (commit cb915d8e2c). A session without part rows must keep
// these bytes: its saved fold proofs, edit stamps and served requests depend on
// them, and a change would rebuild every such session's cache after an upgrade.
const BEFORE_PART_ROWS: Record<string, string> = {
    range: "320cd35f5744ae0f9dc4603b835d91d67895b4a5971e38f1580e2aaa4b284f2b",
    historyDigest: "b057ccdd8855b08cdabf4d1bc04873ca83d3c0a7c481b4087883c52ea429714c",
    restored: "a15d0d3fe584289c25f165793fd7185695def28518ad2a07e083358c20152459",
    spanRowStamps: "8dbcbac22a4cfef673b7df3b1da564cff9ebd635897a3f08016dd7abe77e2ff1",
    spanRowStampsAfter3: "48ff57f9eb97e92058510b23d11ad3f95e75ebb3cbd3d38f87b698e703e2c8a4",
    page: "7b78a5e61400a18982c1b1c7280d79127a4b6d5a0125be19ad38477bb29114ac",
    pageAssistant: "d7fbb8ff6c5d6a44fe221102b7c902c6ad85f98af9b5ab760df0608e3a09c213",
    messagePage: "83541d73fce73043d239b47850741c9e09648f9dcf8ca3fab12285afa4331d00",
    rawRowsThrough: "200e3fb4a632004e2835082497353a9deed91a86b949a602f90cde7ecb53dac3",
    messageById: "ae166a3c4c68930d3a20a875ca539454b37eed301435143bac1cea58099e6e7a",
    assistantSince: "d53828db1fd0b795011b4fe1c3e9fb049c5d0ee857dc37425c91cfb76896c17c",
    latestAssistant: "e4bb056529ba5e587b23a1003f96837afeae81db74fc520231ec935e489fa5ac",
    latestCompaction: "f00d8877e2b127bca500b9a64975d5abba0bce410fea9019a8e196649cd86a0b",
    rowStampsThrough: "c965b2af742c643c7e2990ba9cb5823711ea7ed207c0c5ad8aef82880bcfa696",
};

test("a session without part rows reads exactly as before the reader read session_part", () => {
    for (const variant of ["no-table", "empty-table", "other-session-parts"] as const) {
        const { path, ids, through } = mixedStore(variant);
        expect({ variant, digests: readerDigests(path, ids, through) }).toEqual({
            variant,
            digests: BEFORE_PART_ROWS,
        });
    }
});
