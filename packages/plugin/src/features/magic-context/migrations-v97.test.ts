import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { LATEST_MIGRATION_VERSION, MIGRATIONS, runMigrations } from "./migrations";
import {
    getSchemaFenceRejection,
    initializeDatabase,
    LATEST_SUPPORTED_VERSION,
    openDatabase,
} from "./storage-db";
import {
    commitHostRunnerPass,
    createHostRunnerState,
    loadHostRunnerRecord,
} from "./storage-host-runner";
import { SESSION_SCOPED_TABLES } from "./storage-session-tables";

const tables = ["host_runner_entries", "host_runner_ids", "host_runner_views", "host_runner_state"];

function schema(db: Database): unknown[] {
    return db
        .prepare(
            "SELECT name, sql FROM sqlite_master WHERE name LIKE 'host_runner_%' ORDER BY name",
        )
        .all();
}

describe("migration 97", () => {
    test("populated v96 upgrades losslessly and converges with fresh schema, idempotently", () => {
        const db = new Database(":memory:");
        const fresh = new Database(":memory:");
        try {
            initializeDatabase(db);
            for (const table of tables) db.exec(`DROP TABLE ${table}`);
            db.exec(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT)",
            );
            for (const migration of MIGRATIONS.filter((m) => m.version <= 96)) {
                migration.up(db);
                db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, 0)").run(
                    migration.version,
                );
            }
            db.prepare(
                "INSERT INTO session_meta(session_id, harness, counter) VALUES ('legacy', 'opencode', 42)",
            ).run();
            const before = db.prepare("SELECT * FROM session_meta WHERE session_id='legacy'").get();
            runMigrations(db);
            expect(
                db.prepare("SELECT * FROM session_meta WHERE session_id='legacy'").get(),
            ).toEqual(before);
            expect(LATEST_SUPPORTED_VERSION).toBe(97);
            expect(LATEST_MIGRATION_VERSION).toBe(97);
            initializeDatabase(fresh);
            runMigrations(fresh);
            expect(schema(db)).toEqual(schema(fresh));
            const key = { session_id: "s", harness: "opencode2" };
            const state = {
                ...createHostRunnerState("lineage"),
                ordinal_divergence: 2,
                bootstrap_refused_json: '{"code":"misconfigured","config":{"model":"x"}}',
            };
            commitHostRunnerPass(db, key, { state, elided: ["marker"] });
            const record = loadHostRunnerRecord(db, key);
            MIGRATIONS.find((m) => m.version === 97)!.up(db);
            runMigrations(db);
            expect(loadHostRunnerRecord(db, key)).toEqual(record);
            for (const table of tables) {
                expect(
                    SESSION_SCOPED_TABLES.find((definition) => definition.table === table)
                        ?.harnessScoped,
                ).toBe(true);
            }
        } finally {
            db.close();
            fresh.close();
        }
    });

    test("startup heals missing race, divergence and bootstrap refusal columns", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            db.exec(
                "ALTER TABLE host_runner_entries DROP COLUMN race; ALTER TABLE host_runner_state DROP COLUMN ordinal_divergence; ALTER TABLE host_runner_state DROP COLUMN bootstrap_refused_json",
            );
            initializeDatabase(db);
            const columns = (table: string) =>
                (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
                    (c) => c.name,
                );
            expect(columns("host_runner_entries")).toContain("race");
            expect(columns("host_runner_state")).toContain("ordinal_divergence");
            expect(columns("host_runner_state")).toContain("bootstrap_refused_json");
        } finally {
            db.close();
        }
    });

    test("a v96 host refuses the migrated runner store at the normal open fence without changing it", () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "host-runner-fence-"));
        const path = join(directory, "context.db");
        const db = new Database(path);
        try {
            initializeDatabase(db);
            runMigrations(db);
            const before = schema(db);
            expect(openDatabase({ dbPath: path, latestSupportedVersion: 96 })).toBeNull();
            expect(getSchemaFenceRejection()).toEqual({
                persistedVersion: 97,
                supportedVersion: 96,
            });
            expect(schema(db)).toEqual(before);
        } finally {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
