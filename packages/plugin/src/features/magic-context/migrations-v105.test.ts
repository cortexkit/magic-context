import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { LATEST_MIGRATION_VERSION, MIGRATIONS, runMigrations } from "./migrations";
import { enforceSchemaFence, initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

describe("migration 105", () => {
    it("steps populated v103 through nullable safety assessment without losing tag retirement indexes", () => {
        const db = new Database(":memory:");
        const fresh = new Database(":memory:");
        try {
            initializeDatabase(db);
            db.exec("ALTER TABLE memories DROP COLUMN safety_critical");
            for (const table of [
                "memory_placement",
                "memory_ops",
                "memory_outbox",
                "memory_sync_state",
            ])
                db.exec(`DROP TABLE ${table}`);
            db.exec(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT, applied_at INTEGER)",
            );
            for (const migration of MIGRATIONS.filter((entry) => entry.version <= 103)) {
                migration.up(db);
                db.prepare("INSERT INTO schema_migrations VALUES (?, ?, 0)").run(
                    migration.version,
                    migration.description,
                );
            }
            db.exec(`INSERT INTO memories(project_path,category,content,normalized_hash,importance,scope,shareable,status,classified_at,first_seen_at,created_at,updated_at,last_seen_at)
                VALUES ('git:upgrade','PROJECT_RULES','Never push without approval.','safety',40,'ecosystem',0,'active',7,1,2,3,4),
                       ('git:upgrade','ARCHITECTURE','An archived fact.','ordinary',95,'project',1,'archived',NULL,1,2,3,4)`);
            const before = db.prepare("SELECT * FROM memories ORDER BY id").all();
            const indexes = () =>
                db
                    .prepare(
                        "SELECT name,sql FROM sqlite_master WHERE name IN ('idx_tags_session_message_nocase','idx_tags_session_tool_owner') ORDER BY name",
                    )
                    .all();
            const beforeIndexes = indexes();
            expect(beforeIndexes).toHaveLength(2);
            expect(db.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({
                version: 103,
            });
            expect(enforceSchemaFence(db, ":previous-binary:", 103)).toBe(true);
            expect(
                db.prepare("SELECT name FROM sqlite_master WHERE name='memory_placement'").get(),
            ).toBeNull();

            const later = MIGRATIONS.splice(MIGRATIONS.findIndex((entry) => entry.version === 105));
            try {
                runMigrations(db);
            } finally {
                MIGRATIONS.push(...later);
            }
            expect(db.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({
                version: 104,
            });
            db.exec(
                `INSERT INTO memory_placement(memory_id,level,owner_kind,owner_id,written_at) VALUES (1,'project','project','git:upgrade',5)`,
            );
            const placement = db.prepare("SELECT * FROM memory_placement").all();
            expect(enforceSchemaFence(db, ":memory-levels:", 104)).toBe(true);
            runMigrations(db);
            expect(enforceSchemaFence(db, ":memory-levels:", 104)).toBe(false);
            expect(db.prepare("SELECT * FROM memory_placement").all()).toEqual(placement);

            expect(LATEST_SUPPORTED_VERSION).toBe(105);
            expect(LATEST_MIGRATION_VERSION).toBe(105);
            expect(MIGRATIONS.slice(-5).map((entry) => entry.version)).toEqual([
                101, 102, 103, 104, 105,
            ]);
            expect(db.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({
                version: 105,
            });
            expect(db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(
                before.map((row) => ({ ...row, safety_critical: null })),
            );
            expect(indexes()).toEqual(beforeIndexes);
            const safetyColumn = (database: Database) =>
                database
                    .prepare("PRAGMA table_info(memories)")
                    .all()
                    .find((column) => column.name === "safety_critical");
            expect(safetyColumn(db)).toMatchObject({
                name: "safety_critical",
                type: "INTEGER",
                notnull: 0,
                dflt_value: null,
            });
            initializeDatabase(fresh);
            expect(safetyColumn(fresh)).toMatchObject({
                name: "safety_critical",
                type: "INTEGER",
                notnull: 0,
                dflt_value: null,
            });
            expect(enforceSchemaFence(db, ":previous-binary:", 103)).toBe(false);
            expect(enforceSchemaFence(db, ":current-binary:", 105)).toBe(true);
            db.exec(
                "UPDATE memories SET safety_critical=1 WHERE id=1; UPDATE memories SET safety_critical=0 WHERE id=2",
            );
            expect(() => db.exec("UPDATE memories SET safety_critical=2 WHERE id=1")).toThrow();
            const assessed = db.prepare("SELECT * FROM memories ORDER BY id").all();
            MIGRATIONS.find((entry) => entry.version === 105)!.up(db);
            runMigrations(db);
            expect(db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(assessed);
            expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
        } finally {
            db.close();
            fresh.close();
        }
    });

    it("records the new version on a sparse v103 store without a memories table", () => {
        const db = new Database(":memory:");
        try {
            db.exec(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT, applied_at INTEGER); INSERT INTO schema_migrations VALUES (103,'sparse fixture',0)",
            );
            runMigrations(db);
            expect(db.prepare("SELECT MAX(version) version FROM schema_migrations").get()).toEqual({
                version: 105,
            });
            expect(
                db.prepare("SELECT name FROM sqlite_master WHERE name='memories'").get(),
            ).toBeNull();
        } finally {
            db.close();
        }
    });
});
