import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../shared/test-temp-dir";
import { restoreRow } from "./fold/restore";
import { V2StoreReader } from "./store-reader";

// OpenCode 2.2.6 with `experimental.part_rows: true` (the table exists since
// 2.2.2) stores an assistant message's content in `session_part`, one row per
// part, and leaves `content: []` in the `session_message` row. The host reads
// both; Magic Context reads only `session_message`. Every place that rebuilds
// an assistant message from the store (rows restored around a host
// checkpoint, the historian's chunk) then sees an assistant with no content.
// Measured on a real 2.2.6 host: after a manual compaction every restored
// assistant reply was missing from the request, and the historian prompt
// carried no assistant text.

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) cleanupTestTempDir(root);
});

function partRowStore() {
    const base = join(tmpdir(), "magic-context", "oc2-part-rows");
    mkdirSync(base, { recursive: true });
    const root = createTestTempDirFromPath(join(base, "store-"));
    roots.push(root);
    const path = join(root, "opencode.db");
    const db = new Database(path);
    db.exec(`
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
            time_created INTEGER, time_updated INTEGER, data TEXT);
        CREATE TABLE session_part (message_id TEXT NOT NULL, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
            type TEXT NOT NULL, call_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
            data TEXT NOT NULL, PRIMARY KEY (message_id, ordinal));
    `);
    const insert = db.prepare(
        "INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)",
    );
    insert.run(
        "m-user",
        "s",
        "user",
        1,
        1000,
        1000,
        JSON.stringify({ text: "Read the file.", time: { created: 1000 } }),
    );
    insert.run(
        "m-assistant",
        "s",
        "assistant",
        2,
        2000,
        2000,
        JSON.stringify({
            content: [],
            model: { providerID: "openai", id: "mock-model" },
            time: { created: 2000, completed: 3000 },
            tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
    );
    const part = db.prepare(
        "INSERT INTO session_part(message_id,session_id,ordinal,type,call_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?,?)",
    );
    part.run(
        "m-assistant",
        "s",
        0,
        "text",
        null,
        2000,
        3000,
        JSON.stringify({ type: "text", text: "PART_ROW_REPLY" }),
    );
    part.run(
        "m-assistant",
        "s",
        1,
        "tool",
        "call-1",
        2000,
        3000,
        JSON.stringify({
            type: "tool",
            id: "call-1",
            name: "read",
            state: {
                status: "completed",
                input: { path: "a.ts" },
                content: [{ type: "text", text: "PART_ROW_TOOL_OUTPUT" }],
            },
        }),
    );
    db.close();
    return path;
}

test.failing("assistant content stored in session_part is read with its message", () => {
    const reader = new V2StoreReader(partRowStore());
    try {
        const assistant = reader.range("s", -1, 2).find((row) => row.id === "m-assistant");
        expect(assistant).toBeDefined();
        expect(JSON.stringify(assistant!.data.content)).toContain("PART_ROW_REPLY");
        expect(JSON.stringify(assistant!.data.content)).toContain("PART_ROW_TOOL_OUTPUT");
        // The message a restore around a host checkpoint would serve.
        const restored = JSON.stringify(
            restoreRow(assistant!, { providerID: "openai", id: "mock-model" }),
        );
        expect(restored).toContain("PART_ROW_REPLY");
        expect(restored).toContain("PART_ROW_TOOL_OUTPUT");
    } finally {
        reader.close();
    }
});
