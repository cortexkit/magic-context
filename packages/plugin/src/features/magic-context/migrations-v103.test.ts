import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { LATEST_MIGRATION_VERSION, MIGRATIONS, runMigrations } from "./migrations";
import { enforceSchemaFence, initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";
import { getOrCreateSessionMeta, updateSessionMeta } from "./storage-meta";
import { SESSION_RENDER_CACHE_COLUMNS, writeSessionRenderCache } from "./storage-session-cache";
import {
    readSessionMetaCollection,
    SESSION_META_CHUNK_BYTES,
    SESSION_META_COLLECTION_DEFAULTS,
    sessionMetaCollectionSelect,
    updateSessionMetaCollection,
    writeSessionMetaCollection,
} from "./storage-session-collections";
import { deleteSessionMetaWithPayloads } from "./storage-session-payloads";

function current() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

// Reconstruct the previous populated schema, not an empty database that can lose
// every old cached value without making the migration test fail.
function previous() {
    const db = current();
    db.exec(`DROP TABLE session_render_cache;
        ALTER TABLE session_meta ADD COLUMN cached_m0_bytes BLOB;
        ALTER TABLE session_meta ADD COLUMN cached_m1_bytes BLOB;
        ALTER TABLE session_meta ADD COLUMN cached_m0_mural_data_url TEXT;
        ALTER TABLE session_meta ADD COLUMN memory_block_cache TEXT DEFAULT '';
        ALTER TABLE session_meta ADD COLUMN cached_m0_upgrade_state TEXT;
        DELETE FROM schema_migrations WHERE version >= 103;`);
    for (const [column, fallback] of Object.entries(SESSION_META_COLLECTION_DEFAULTS)) {
        db.exec(`ALTER TABLE session_meta ADD COLUMN ${column} TEXT DEFAULT '${fallback}'`);
    }
    db.exec("DROP TABLE session_meta_chunks");
    db.exec("DROP TABLE session_meta_collection_revisions");
    return db;
}

const shape = (db: Database) => db.prepare("PRAGMA table_info(session_render_cache)").all();

describe("migration 103 session render payload isolation", () => {
    test("a populated v102 store preserves exact bytes, nulls and replay markers step by step", () => {
        const db = previous();
        const fresh = current();
        const m0 = Buffer.from([0, 255, 254, 1, ...Buffer.alloc(100_000, 97)]);
        const m1 = Buffer.from("m[1] é🙂".repeat(1000));
        const mural = `data:image/png;base64,${"abc".repeat(40_000)}`;
        const memory = "<project-memory>é🙂</project-memory>".repeat(1000);
        try {
            db.prepare(`INSERT INTO session_meta (session_id,counter,cached_m0_bytes,cached_m1_bytes,
                cached_m0_mural_data_url,memory_block_cache,trailing_blank_decisions,cached_m0_materialized_at)
                VALUES ('old',127,?,?,?,?,?,1234)`).run(
                m0,
                m1,
                mural,
                memory,
                '{"v":2,"piServedTagNumbers":[1,2]}',
            );
            db.prepare("INSERT INTO session_meta(session_id) VALUES ('empty')").run();
            const metadata = db
                .prepare(
                    `SELECT counter,${sessionMetaCollectionSelect("trailing_blank_decisions", "trailing_blank_decisions", db)},cached_m0_materialized_at FROM session_meta WHERE session_id='old'`,
                )
                .get();
            expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({
                v: 102,
            });
            expect(enforceSchemaFence(db, ":old:", 102)).toBe(true);
            runMigrations(db);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(LATEST_MIGRATION_VERSION).toBe(104);
            expect(MIGRATIONS.filter((m) => m.version === 103)).toHaveLength(1);
            expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({
                v: 104,
            });
            expect(enforceSchemaFence(db, ":old:", 102)).toBe(false);
            expect(enforceSchemaFence(db, ":previous:", 103)).toBe(false);
            expect(enforceSchemaFence(db, ":new:", 104)).toBe(true);
            expect(shape(db)).toEqual(shape(fresh));
            const columns = (
                db.prepare("PRAGMA table_info(session_meta)").all() as { name: string }[]
            ).map((c) => c.name);
            for (const column of SESSION_RENDER_CACHE_COLUMNS)
                expect(columns).not.toContain(column);
            expect(
                db
                    .prepare(
                        `SELECT counter,${sessionMetaCollectionSelect("trailing_blank_decisions", "trailing_blank_decisions", db)},cached_m0_materialized_at FROM session_meta WHERE session_id='old'`,
                    )
                    .get(),
            ).toEqual(metadata);
            expect(getOrCreateSessionMeta(db, "old").cachedM0Bytes).toEqual(m0);
            expect(getOrCreateSessionMeta(db, "old").cachedM1Bytes).toEqual(m1);
            expect(getOrCreateSessionMeta(db, "old").cachedM0MuralDataUrl).toBe(mural);
            expect(
                db
                    .prepare(
                        "SELECT value FROM session_render_cache WHERE session_id='old' AND cache_key='memory_block_cache'",
                    )
                    .get(),
            ).toEqual({ value: memory });
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS n FROM session_render_cache WHERE session_id='empty'",
                    )
                    .get(),
            ).toEqual({ n: 0 });
            expect(getOrCreateSessionMeta(db, "empty").cachedM0Bytes).toBeNull();
            MIGRATIONS.find((m) => m.version === 103)!.up(db);
            initializeDatabase(db);
            expect(
                (db.prepare("PRAGMA table_info(session_meta)").all() as { name: string }[]).some(
                    (c) => SESSION_RENDER_CACHE_COLUMNS.includes(c.name as never),
                ),
            ).toBe(false);
            expect(getOrCreateSessionMeta(db, "old").cachedM0Bytes).toEqual(m0);
            expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
        } finally {
            db.close();
            fresh.close();
        }
    });

    test("a failed 103 ledger commit rolls back every payload move and removed column", () => {
        const db = previous();
        const raw = ' { "version" : 2, "trailingBlank" : {}, "opaque" : "é🙂" }\n';
        const m0 = Buffer.alloc(20000, 97);
        try {
            db.prepare(
                "INSERT INTO session_meta(session_id,cached_m0_bytes,trailing_blank_decisions) VALUES ('rollback',?,?)",
            ).run(m0, raw);
            db.exec(
                "CREATE TRIGGER reject_103 BEFORE INSERT ON schema_migrations WHEN NEW.version=103 BEGIN SELECT RAISE(ABORT,'reject migration'); END",
            );
            expect(() => runMigrations(db)).toThrow("reject migration");
            expect(
                db
                    .prepare(
                        "SELECT cached_m0_bytes,trailing_blank_decisions FROM session_meta WHERE session_id='rollback'",
                    )
                    .get(),
            ).toEqual({ cached_m0_bytes: m0, trailing_blank_decisions: raw });
            expect(
                db
                    .prepare(
                        "SELECT name FROM sqlite_master WHERE name IN ('session_render_cache','session_meta_chunks')",
                    )
                    .all(),
            ).toEqual([]);
            expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({
                v: 102,
            });
            db.exec("DROP TRIGGER reject_103");
            runMigrations(db);
            expect(getOrCreateSessionMeta(db, "rollback").cachedM0Bytes).toEqual(m0);
            expect(readSessionMetaCollection(db, "rollback", "trailing_blank_decisions")).toBe(raw);
        } finally {
            db.close();
        }
    });

    test("malformed text and non-text collection values keep their SQLite storage classes", () => {
        const db = previous();
        const blob = Buffer.from('{"version":2,"trailingBlank":{}}');
        const raw = "malformed\0é🙂";
        try {
            db.prepare(
                "INSERT INTO session_meta(session_id,trailing_blank_decisions,memory_block_cache) VALUES ('blob',?,NULL),('text',?,'')",
            ).run(blob, raw);
            runMigrations(db);
            expect(readSessionMetaCollection(db, "blob", "trailing_blank_decisions")).toEqual(blob);
            expect(readSessionMetaCollection(db, "text", "trailing_blank_decisions")).toBe(raw);
            expect(
                db
                    .prepare(
                        "SELECT typeof(value) AS kind FROM session_render_cache WHERE session_id='blob' AND cache_key='memory_block_cache'",
                    )
                    .get(),
            ).toEqual({ kind: "null" });
            expect(
                updateSessionMetaCollection(db, "blob", "trailing_blank_decisions", "replacement", {
                    value: Buffer.from(blob),
                }),
            ).toEqual({ changes: 1 });
            expect(readSessionMetaCollection(db, "blob", "trailing_blank_decisions")).toBe(
                "replacement",
            );
        } finally {
            db.close();
        }
    });

    test("growing turn metadata cannot rewrite stable payload records", () => {
        const db = current();
        try {
            const m0 = Buffer.alloc(100_000, 97);
            updateSessionMeta(db, "growth", {
                counter: 127,
                cachedM0Bytes: m0,
                cachedM1Bytes: Buffer.from("m1"),
                cachedM0MuralDataUrl: `data:image/png;base64,${"a".repeat(120_000)}`,
            });
            writeSessionRenderCache(db, "growth", "memory_block_cache", "memories".repeat(3000));
            db.exec(`CREATE TABLE payload_writes(n INTEGER); INSERT INTO payload_writes VALUES(0);
                CREATE TRIGGER record_payload_update AFTER UPDATE ON session_render_cache BEGIN UPDATE payload_writes SET n=n+1; END;
                CREATE TRIGGER record_payload_insert AFTER INSERT ON session_render_cache BEGIN UPDATE payload_writes SET n=n+1; END;
                CREATE TRIGGER record_payload_delete AFTER DELETE ON session_render_cache BEGIN UPDATE payload_writes SET n=n+1; END;`);
            const pages = (
                db.prepare("SELECT pageno FROM dbstat WHERE name='session_render_cache'").all() as {
                    pageno: number;
                }[]
            ).map((r) => r.pageno);
            const serialize = () => (db as unknown as { serialize(): Buffer }).serialize();
            const before = serialize();
            for (let pass = 0; pass < 50; pass++) {
                updateSessionMeta(db, "growth", { counter: 128 + pass });
                writeSessionMetaCollection(
                    db,
                    "growth",
                    "trailing_blank_decisions",
                    JSON.stringify({
                        version: 2,
                        piServedTagNumbers: Array.from({ length: pass + 1 }, (_, i) => i + 1),
                    }),
                );
            }
            const after = serialize();
            for (const page of pages)
                expect(after.subarray((page - 1) * 4096, page * 4096)).toEqual(
                    before.subarray((page - 1) * 4096, page * 4096),
                );
            expect(db.prepare("SELECT n FROM payload_writes").get()).toEqual({ n: 0 });
            expect(getOrCreateSessionMeta(db, "growth").cachedM0Bytes).toEqual(m0);
            expect(getOrCreateSessionMeta(db, "growth").counter).toBe(177);
        } finally {
            db.close();
        }
    });

    test("metadata deletion removes owned payloads without touching another harness or other tables", () => {
        const db = current();
        try {
            updateSessionMeta(db, "owned", { cachedM0Bytes: Buffer.from("m0") });
            db.exec(
                "UPDATE session_meta SET harness='pi' WHERE session_id='owned'; CREATE TABLE external_rows(session_id TEXT); INSERT INTO external_rows VALUES('owned')",
            );
            writeSessionMetaCollection(db, "owned", "note_nudge_anchors", '["kept"]');
            expect(deleteSessionMetaWithPayloads(db, "owned", "opencode")).toBe(0);
            expect(getOrCreateSessionMeta(db, "owned").cachedM0Bytes).toEqual(Buffer.from("m0"));
            expect(deleteSessionMetaWithPayloads(db, "owned", "pi")).toBe(1);
            expect(
                db.prepare("SELECT 1 FROM session_meta WHERE session_id='owned'").get(),
            ).toBeNull();
            expect(db.prepare("SELECT COUNT(*) AS n FROM session_render_cache").get()).toEqual({
                n: 0,
            });
            expect(db.prepare("SELECT COUNT(*) AS n FROM session_meta_chunks").get()).toEqual({
                n: 0,
            });
            expect(db.prepare("SELECT COUNT(*) AS n FROM external_rows").get()).toEqual({ n: 1 });
        } finally {
            db.close();
        }
    });

    test("cache setters retain text affinity and ignore unsupported update shapes", () => {
        const db = current();
        try {
            updateSessionMeta(db, "affinity", {
                cachedM0Bytes: Buffer.from("old"),
                cachedM0UpgradeState: "old-state",
            });
            updateSessionMeta(db, "affinity", {
                cachedM0Bytes: false,
                cachedM0UpgradeState: Buffer.from("wrong type"),
            } as unknown as Parameters<typeof updateSessionMeta>[2]);
            expect(getOrCreateSessionMeta(db, "affinity").cachedM0Bytes).toEqual(
                Buffer.from("old"),
            );
            expect(getOrCreateSessionMeta(db, "affinity").cachedM0UpgradeState).toBe("old-state");
            updateSessionMeta(db, "affinity", {
                cachedM0UpgradeState: 1e21,
            } as unknown as Parameters<typeof updateSessionMeta>[2]);
            expect(
                db
                    .prepare(
                        "SELECT typeof(value) AS kind,value FROM session_render_cache WHERE session_id='affinity' AND cache_key='cached_m0_upgrade_state'",
                    )
                    .get(),
            ).toEqual({ kind: "text", value: "1.0e+21" });
        } finally {
            db.close();
        }
    });

    test("identical payload writes are skipped but a changed m1 is persisted independently", () => {
        const db = current();
        try {
            updateSessionMeta(db, "same", {
                cachedM0Bytes: Buffer.alloc(100_000, 97),
                cachedM1Bytes: Buffer.from("m1"),
            });
            db.exec(`CREATE TABLE writes(n INTEGER); INSERT INTO writes VALUES(0);
                CREATE TRIGGER count_payload_updates AFTER UPDATE ON session_render_cache BEGIN UPDATE writes SET n=n+1; END;`);
            for (let pass = 0; pass < 10; pass++)
                updateSessionMeta(db, "same", {
                    cachedM0Bytes: Buffer.alloc(100_000, 97),
                    cachedM1Bytes: Buffer.from("m1"),
                });
            expect(db.prepare("SELECT n FROM writes").get()).toEqual({ n: 0 });
            updateSessionMeta(db, "same", { cachedM1Bytes: Buffer.from("m1 changed") });
            expect(db.prepare("SELECT n FROM writes").get()).toEqual({ n: 1 });
            expect(getOrCreateSessionMeta(db, "same").cachedM1Bytes).toEqual(
                Buffer.from("m1 changed"),
            );
            expect(getOrCreateSessionMeta(db, "same").cachedM0Bytes).toEqual(
                Buffer.alloc(100_000, 97),
            );
        } finally {
            db.close();
        }
    });
});

describe("lossless session metadata chunks", () => {
    test("default collection values create no rows and clear back to their exact defaults", () => {
        const db = current();
        try {
            updateSessionMeta(db, "defaults", { counter: 1 });
            for (const [column, value] of Object.entries(SESSION_META_COLLECTION_DEFAULTS)) {
                writeSessionMetaCollection(
                    db,
                    "defaults",
                    column as keyof typeof SESSION_META_COLLECTION_DEFAULTS,
                    value,
                );
                expect(
                    readSessionMetaCollection(
                        db,
                        "defaults",
                        column as keyof typeof SESSION_META_COLLECTION_DEFAULTS,
                    ),
                ).toBe(value);
            }
            expect(db.prepare("SELECT COUNT(*) AS n FROM session_meta_chunks").get()).toEqual({
                n: 0,
            });
            writeSessionMetaCollection(db, "defaults", "note_nudge_anchors", '["retained"]');
            writeSessionMetaCollection(db, "defaults", "note_nudge_anchors", "[]");
            expect(db.prepare("SELECT COUNT(*) AS n FROM session_meta_chunks").get()).toEqual({
                n: 0,
            });
        } finally {
            db.close();
        }
    });

    test("collection round trips preserve serialization, Unicode boundaries, nulls and in-place edits", () => {
        const db = current();
        try {
            updateSessionMeta(db, "roundtrip", { counter: 1 });
            const values = [
                null,
                "",
                ' [ "é🙂", { "kept" : true } ]\n',
                JSON.stringify(Array.from({ length: 12000 }, (_, i) => `message-${i}-é🙂`)),
            ];
            for (const value of values) {
                for (const column of Object.keys(
                    SESSION_META_COLLECTION_DEFAULTS,
                ) as (keyof typeof SESSION_META_COLLECTION_DEFAULTS)[]) {
                    writeSessionMetaCollection(db, "roundtrip", column, value);
                    expect(readSessionMetaCollection(db, "roundtrip", column)).toBe(value);
                }
            }
            const replaced = '["edited middle", "same order", "é🙂"]';
            writeSessionMetaCollection(db, "roundtrip", "trailing_blank_decisions", replaced);
            expect(readSessionMetaCollection(db, "roundtrip", "trailing_blank_decisions")).toBe(
                replaced,
            );
            expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
        } finally {
            db.close();
        }
    });

    test("appending to a multi-megabyte list writes only its partial tail and new chunks", () => {
        const db = current();
        try {
            updateSessionMeta(db, "append", { counter: 1 });
            const raw = JSON.stringify(
                Array.from({ length: 110000 }, (_, i) => `historical-message-${i}-é🙂`),
            );
            expect(Buffer.byteLength(raw)).toBeGreaterThan(3_700_000);
            writeSessionMetaCollection(db, "append", "merged_reasoning_stripped_ids", raw);
            const oldKeys = (
                db
                    .prepare(
                        "SELECT chunk FROM session_meta_chunks WHERE session_id='append' AND column_name='merged_reasoning_stripped_ids' AND chunk!='-1' ORDER BY chunk",
                    )
                    .all() as { chunk: string }[]
            ).map((row) => row.chunk);
            const tail = new Set(oldKeys.slice(-2));
            db.exec(`CREATE TABLE chunk_writes(kind TEXT, chunk TEXT);
                CREATE TRIGGER count_chunk_updates AFTER UPDATE ON session_meta_chunks BEGIN INSERT INTO chunk_writes VALUES('update',new.chunk); END;
                CREATE TRIGGER count_chunk_inserts AFTER INSERT ON session_meta_chunks BEGIN INSERT INTO chunk_writes VALUES('insert',new.chunk); END;
                CREATE TRIGGER count_chunk_deletes AFTER DELETE ON session_meta_chunks BEGIN INSERT INTO chunk_writes VALUES('delete',old.chunk); END;`);
            const next = `${raw.slice(0, -1)},"new-message-é🙂"]`;
            writeSessionMetaCollection(db, "append", "merged_reasoning_stripped_ids", next);
            const writes = db.prepare("SELECT kind,chunk FROM chunk_writes").all() as {
                kind: string;
                chunk: string;
            }[];
            expect(writes.length).toBeGreaterThan(0);
            expect(writes.length).toBeLessThanOrEqual(2);
            expect(
                writes.every(
                    (row) =>
                        row.kind !== "delete" && (row.kind === "insert" || tail.has(row.chunk)),
                ),
            ).toBe(true);
            expect(
                (
                    db
                        .prepare(
                            "SELECT MAX(length(body)) AS n FROM session_meta_chunks WHERE chunk!='-1'",
                        )
                        .get() as { n: number }
                ).n,
            ).toBeLessThanOrEqual(SESSION_META_CHUNK_BYTES);
            expect(readSessionMetaCollection(db, "append", "merged_reasoning_stripped_ids")).toBe(
                next,
            );
            db.exec("DELETE FROM chunk_writes");
            writeSessionMetaCollection(db, "append", "merged_reasoning_stripped_ids", next);
            expect(db.prepare("SELECT COUNT(*) AS n FROM chunk_writes").get()).toEqual({ n: 0 });
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS n FROM dbstat WHERE name='session_meta_chunks' AND pagetype='overflow'",
                    )
                    .get(),
            ).toEqual({ n: 0 });
        } finally {
            db.close();
        }
    });
});

test("appending a replay namespace never rewrites a later multi-megabyte namespace", () => {
    const db = current();
    const inputs = Object.fromEntries(
        Array.from({ length: 28000 }, (_, i) => [
            `old-call-${i}`,
            JSON.stringify({
                path: `/src/file-${i}.ts`,
                query: "preserve the previous tool input and UTF-8 é🙂 ".repeat(3),
            }),
        ]),
    );
    const numbers = Array.from({ length: 12025 }, (_, i) => i + 1);
    try {
        db.exec(`CREATE TABLE namespace_writes(kind TEXT);
            CREATE TRIGGER namespace_update AFTER UPDATE ON session_meta_chunks BEGIN INSERT INTO namespace_writes VALUES('update'); END;
            CREATE TRIGGER namespace_insert AFTER INSERT ON session_meta_chunks BEGIN INSERT INTO namespace_writes VALUES('insert'); END;
            CREATE TRIGGER namespace_delete AFTER DELETE ON session_meta_chunks BEGIN INSERT INTO namespace_writes VALUES('delete'); END;`);
        for (const early of [true, false]) {
            const id = `namespace-${early}`;
            updateSessionMeta(db, id, { counter: 1 });
            const render = (tags: number[]) =>
                JSON.stringify(
                    early
                        ? {
                              version: 2,
                              trailingBlank: {},
                              piServedTagNumbers: tags,
                              piNative: { toolInputs: inputs, reasoningIds: [] },
                          }
                        : {
                              version: 2,
                              trailingBlank: {},
                              piNative: { toolInputs: inputs, reasoningIds: [] },
                              piServedTagNumbers: tags,
                          },
                );
            const before = render(numbers);
            expect(Buffer.byteLength(before)).toBeGreaterThan(3_700_000);
            writeSessionMetaCollection(db, id, "trailing_blank_decisions", before);
            db.exec("DELETE FROM namespace_writes");
            const after = render([...numbers, 12026]);
            writeSessionMetaCollection(db, id, "trailing_blank_decisions", after);
            const writes = db.prepare("SELECT kind FROM namespace_writes").all() as {
                kind: string;
            }[];
            expect(writes.length).toBeGreaterThan(0);
            expect(writes.length).toBeLessThanOrEqual(2);
            expect(writes.some((row) => row.kind === "delete")).toBe(false);
            expect(readSessionMetaCollection(db, id, "trailing_blank_decisions")).toBe(after);
        }
    } finally {
        db.close();
    }
});
