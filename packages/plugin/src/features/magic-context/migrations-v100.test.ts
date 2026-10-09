/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { LATEST_MIGRATION_VERSION, MIGRATIONS, runMigrations } from "./migrations";
import { enforceSchemaFence, initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";
import { clearCachedM0M1 } from "./storage-meta-shared";
import { healAllNullColumns } from "./storage-schema-helpers";

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: unknown };

function prefixColumns(db: Database): ColumnInfo[] {
    return (db.prepare("PRAGMA table_info(session_meta)").all() as ColumnInfo[])
        .filter((column) => column.name === "served_prefix" || column.name === "held_release")
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }));
}

describe("migration 100", () => {
    it("tolerates a sparse legacy database without session metadata", () => {
        const db = new Database(":memory:");
        try {
            MIGRATIONS.find((entry) => entry.version === 100)!.up(db);
            expect(db.prepare("PRAGMA table_info(session_meta)").all()).toEqual([]);
        } finally {
            db.close();
        }
    });

    it("steps populated v99 through v100 with nullable TEXT prefix documents and a matching fresh schema", () => {
        const db = new Database(":memory:");
        const fresh = new Database(":memory:");
        try {
            initializeDatabase(db);
            db.exec("ALTER TABLE session_meta DROP COLUMN served_prefix");
            db.exec("ALTER TABLE session_meta DROP COLUMN held_release");
            db.exec(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT, applied_at INTEGER)",
            );
            for (const migration of MIGRATIONS.filter((entry) => entry.version <= 99)) {
                migration.up(db);
                db.prepare("INSERT INTO schema_migrations VALUES (?, ?, 0)").run(
                    migration.version,
                    migration.description,
                );
            }
            db.prepare(
                "INSERT INTO session_meta (session_id, counter) VALUES ('legacy', 42)",
            ).run();
            expect(prefixColumns(db)).toEqual([]);
            expect(
                db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
            ).toEqual({ version: 99 });

            runMigrations(db);
            expect(LATEST_SUPPORTED_VERSION).toBe(100);
            expect(LATEST_MIGRATION_VERSION).toBe(100);
            expect(MIGRATIONS.slice(-2).map((entry) => entry.version)).toEqual([99, 100]);
            expect(prefixColumns(db)).toEqual([
                { name: "held_release", type: "TEXT", notnull: 0, dflt_value: null },
                { name: "served_prefix", type: "TEXT", notnull: 0, dflt_value: null },
            ]);
            expect(
                db
                    .prepare(
                        "SELECT counter, served_prefix, held_release FROM session_meta WHERE session_id = 'legacy'",
                    )
                    .get(),
            ).toEqual({ counter: 42, served_prefix: null, held_release: null });
            expect(
                db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
            ).toEqual({ version: 100 });
            initializeDatabase(fresh);
            expect(prefixColumns(fresh)).toEqual(prefixColumns(db));
            runMigrations(fresh);
            expect(prefixColumns(fresh)).toEqual(prefixColumns(db));

            const documents = {
                served_prefix: '{"first_kept":{"id":"message"}}',
                held_release: '{"reason":"flush","obligations":["flush"]}',
            };
            db.prepare(
                "UPDATE session_meta SET served_prefix = ?, held_release = ? WHERE session_id = 'legacy'",
            ).run(documents.served_prefix, documents.held_release);
            MIGRATIONS.find((entry) => entry.version === 100)!.up(db);
            runMigrations(db);
            expect(
                db
                    .prepare(
                        "SELECT served_prefix, held_release FROM session_meta WHERE session_id = 'legacy'",
                    )
                    .get(),
            ).toEqual(documents);
            db.prepare(
                "UPDATE session_meta SET served_prefix = NULL, held_release = NULL WHERE session_id = 'legacy'",
            ).run();
            expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
        } finally {
            db.close();
            fresh.close();
        }
    });

    it("refuses the migrated context database at the previous binary fence", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            expect(enforceSchemaFence(db, ":previous-binary:", 99)).toBe(false);
            expect(enforceSchemaFence(db, ":current-binary:", 100)).toBe(true);
        } finally {
            db.close();
        }
    });

    it("initialization repairs missing prefix columns without healing their NULL absence sentinel", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            db.prepare("INSERT INTO session_meta (session_id) VALUES ('missing-columns')").run();
            db.exec("ALTER TABLE session_meta DROP COLUMN served_prefix");
            db.exec("ALTER TABLE session_meta DROP COLUMN held_release");
            initializeDatabase(db);
            expect(prefixColumns(db)).toEqual([
                { name: "held_release", type: "TEXT", notnull: 0, dflt_value: null },
                { name: "served_prefix", type: "TEXT", notnull: 0, dflt_value: null },
            ]);
            healAllNullColumns(db);
            expect(
                db
                    .prepare(
                        "SELECT served_prefix, held_release FROM session_meta WHERE session_id='missing-columns'",
                    )
                    .get(),
            ).toEqual({ served_prefix: null, held_release: null });
            db.prepare(
                "UPDATE session_meta SET served_prefix = ?, held_release = ? WHERE session_id='missing-columns'",
            ).run('{"prefix":"original"}', '{"reason":"flush"}');
            initializeDatabase(db);
            expect(
                db
                    .prepare(
                        "SELECT served_prefix, held_release FROM session_meta WHERE session_id='missing-columns'",
                    )
                    .get(),
            ).toEqual({
                served_prefix: '{"prefix":"original"}',
                held_release: '{"reason":"flush"}',
            });
        } finally {
            db.close();
        }
    });

    it("clearCachedM0M1 preserves the served prefix and held release documents", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            db.prepare(
                "INSERT INTO session_meta (session_id, cached_m0_bytes, cached_m1_bytes, served_prefix, held_release) VALUES ('held', ?, ?, ?, ?)",
            ).run(
                Buffer.from("head"),
                Buffer.from("summary"),
                '{"prefix":"original"}',
                '{"reason":"flush"}',
            );
            clearCachedM0M1(db, "held");
            expect(
                db
                    .prepare(
                        "SELECT cached_m0_bytes, cached_m1_bytes, served_prefix, held_release FROM session_meta WHERE session_id = 'held'",
                    )
                    .get(),
            ).toEqual({
                cached_m0_bytes: null,
                cached_m1_bytes: null,
                served_prefix: '{"prefix":"original"}',
                held_release: '{"reason":"flush"}',
            });
        } finally {
            db.close();
        }
    });
});
