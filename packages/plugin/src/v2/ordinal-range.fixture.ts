import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../shared/sqlite";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import { RAW_MESSAGE_TYPES } from "./store-reader";

export function ordinalFixture(): { path: string; db: Database; cleanup(): void } {
    const dir = createTestTempDirFromPath(join(tmpdir(), "v2-ordinal-range-"));
    const path = join(dir, "opencode.db");
    const db = new Database(path);
    db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
        CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);`);
    const types = [...RAW_MESSAGE_TYPES, "idle", "compaction", "directory"];
    const insert = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, 10, ?)");
    db.transaction(() => {
        for (let i = 0; i < 40_000; i++) {
            insert.run(
                `m-${i}`,
                "s",
                types[i % types.length],
                i * 3,
                JSON.stringify({ text: `turn ${i}` }),
            );
        }
        insert.run("private", "other", "user", 0, '{"text":"other session"}');
    }).immediate();
    return {
        path,
        db,
        cleanup: () => {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
