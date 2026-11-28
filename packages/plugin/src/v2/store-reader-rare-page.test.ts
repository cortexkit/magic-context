import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../shared/sqlite";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import { IMPORTED_MC_SUMMARY, importedFloor } from "./fold/native-replay-v3";
import { type MessageType, V2StoreReader } from "./store-reader";

// OpenCode 2.0.22, 2.1.0, 2.3.2 and 2.4.2 all create this schema.
const HOST_SCHEMA = `CREATE TABLE \`session_message\` (
    \`id\` text PRIMARY KEY,
    \`session_id\` text NOT NULL,
    \`type\` text NOT NULL,
    \`seq\` integer NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    \`data\` text NOT NULL,
    CONSTRAINT \`fk_session_message_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);
CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);
CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);
CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`;

function withStore(run: (reader: V2StoreReader, db: Database) => void) {
    const dir = createTestTempDirFromPath(join(tmpdir(), "v2-rare-page-"));
    const path = join(dir, "opencode.db");
    const db = new Database(path);
    try {
        db.exec("PRAGMA foreign_keys = OFF");
        db.exec(HOST_SCHEMA);
        const put = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, 1, 1, ?)");
        db.transaction(() => {
            for (const session of ["s", "other"]) {
                for (let i = 0; i < 1400; i++) {
                    const type =
                        i % 97 === 0
                            ? "compaction"
                            : i % 3 === 0
                              ? "idle"
                              : i % 3 === 1
                                ? "user"
                                : "assistant";
                    const data =
                        type === "compaction"
                            ? { status: "completed", summary: IMPORTED_MC_SUMMARY }
                            : type === "idle"
                              ? { outcome: "succeeded" }
                              : { text: `row ${i}` };
                    put.run(`${session}-${1400 - i}`, session, type, i * 3, JSON.stringify(data));
                }
            }
        })();
        const reader = new V2StoreReader(path);
        try {
            run(reader, db);
        } finally {
            reader.close();
        }
    } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
}

test("the imported floor uses the type index on an unanalyzed OpenCode store", () => {
    withStore((reader, db) => {
        expect(
            db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'sqlite_stat*'").all(),
        ).toEqual([]);
        const prepare = spyOn(reader as unknown as { prepare(sql: string): unknown }, "prepare");
        const through = 4000;
        expect(importedFloor(reader, "s", through)).toMatchObject({ id: "s-139", seq: 3783 });
        const sql = prepare.mock.calls.find(([query]) =>
            query.includes("ORDER BY seq ASC LIMIT ?"),
        )?.[0];
        expect(sql).toBeDefined();
        const details = (
            db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("s", -1, through, "compaction", 1000) as {
                detail: string;
            }[]
        )
            .map(({ detail }) => detail)
            .join("\n");
        expect(details).toContain(
            "USING INDEX session_message_session_type_seq_idx (session_id=? AND type=?)",
        );
        expect(details).not.toContain("TEMP B-TREE");

        prepare.mockClear();
        reader.page("s", { after: 3970, through, type: "user", limit: 3 });
        const ordinary = prepare.mock.calls.find(([query]) =>
            query.includes("ORDER BY seq ASC LIMIT ?"),
        )?.[0];
        const plan = db
            .prepare(`EXPLAIN QUERY PLAN ${ordinary}`)
            .all("s", 3970, through, "user", 3);
        expect(JSON.stringify(plan)).toContain("USING INDEX session_message_session_seq_idx");
    });
});

test("opting into the type index preserves rows and cursors across generated typed ranges", () => {
    withStore((reader) => {
        const types = [
            "compaction",
            "idle",
            "user",
            "assistant",
            "system",
        ] as const satisfies readonly MessageType[];
        for (let i = 0; i < 160; i++) {
            const sessionID = i % 2 ? "s" : "other";
            const after = i % 13 ? ((i * 149) % 4203) - 1 : undefined;
            const through = i % 3 === 0 ? undefined : ((i * 919) % 4203) - 1;
            for (const type of types) {
                const options = { after, through, type, limit: 1 + (i % 37) };
                expect(reader.page(sessionID, { ...options, preferTypeIndex: true })).toEqual(
                    reader.page(sessionID, options),
                );
            }
        }
    });
});
