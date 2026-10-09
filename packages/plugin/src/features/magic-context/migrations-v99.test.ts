import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { MIGRATIONS, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";
import { deleteSessionScopedRows, SESSION_SCOPED_TABLES } from "./storage-session-tables";

const sessionTables = [
    "memory_stage_attempts",
    "memory_check_attempts",
    "memory_applied_rows",
    "memory_applied_snapshots",
];
const projectTables = [
    "memory_publications",
    "memory_fact_blocks",
    "memory_pending_facts",
    "memory_fact_block_links",
    "memory_history",
    "memory_journal",
    "memory_clause_evidence",
    "memory_successor_links",
    "memory_conflict_links",
    "memory_classification_items",
    "memory_tool_proposals",
    "memory_decision_receipts",
    "memory_activity_ledger",
];
function schema(db: Database) {
    return db
        .prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'memory_%' ORDER BY name")
        .all();
}

describe("migration 99", () => {
    test("populated v97 steps through v98 and v99 losslessly and matches fresh schema", () => {
        const db = new Database(":memory:");
        const fresh = new Database(":memory:");
        const directory = createTestTempDirFromPath(join(tmpdir(), "memory-v99-rehearsal-"));
        try {
            initializeDatabase(db);
            for (const table of [
                ...sessionTables,
                "memory_fact_block_links",
                "memory_pending_facts",
                "memory_fact_blocks",
                ...projectTables.filter(
                    (table) =>
                        ![
                            "memory_fact_block_links",
                            "memory_pending_facts",
                            "memory_fact_blocks",
                        ].includes(table),
                ),
            ])
                db.exec(`DROP TABLE ${table}`);
            for (const column of [
                "revision",
                "verify_result",
                "verify_files_json",
                "verify_commit",
            ])
                db.exec(`ALTER TABLE memories DROP COLUMN ${column}`);
            db.exec(
                "ALTER TABLE memory_mutation_log DROP COLUMN adoption_class; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT,applied_at INTEGER)",
            );
            for (const migration of MIGRATIONS.filter((m) => m.version <= 97)) {
                migration.up(db);
                db.prepare("INSERT INTO schema_migrations VALUES(?,?,0)").run(
                    migration.version,
                    migration.description,
                );
            }
            db.exec(
                "INSERT INTO memories(project_path,category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at) VALUES('p','NAMING','old bytes','hash',1,1,1,1)",
            );
            const before = db.prepare("SELECT content,seen_count,status FROM memories").all();
            const copyPath = join(directory, "copy.db");
            db.prepare("VACUUM INTO ?").run(copyPath);
            const copy = new Database(copyPath);
            try {
                runMigrations(copy);
                expect(
                    copy.prepare("SELECT content,seen_count,status FROM memories").all(),
                ).toEqual(before);
                expect(copy.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
                expect(
                    copy.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
                ).toEqual({ version: LATEST_SUPPORTED_VERSION });
            } finally {
                copy.close();
            }
            for (const version of [98, 99]) {
                MIGRATIONS.find((migration) => migration.version === version)!.up(db);
                db.prepare("INSERT INTO schema_migrations VALUES(?, 'step',0)").run(version);
                expect(db.prepare("SELECT content,seen_count,status FROM memories").all()).toEqual(
                    before,
                );
            }
            initializeDatabase(fresh);
            runMigrations(fresh);
            expect(schema(db)).toEqual(schema(fresh));
            const snapshot = schema(db);
            runMigrations(db);
            MIGRATIONS.find((m) => m.version === 99)!.up(db);
            expect(schema(db)).toEqual(snapshot);
            expect(LATEST_SUPPORTED_VERSION).toBeGreaterThanOrEqual(99);
            expect(
                MIGRATIONS.filter((m) => m.version >= 97 && m.version <= 99).map((m) => m.version),
            ).toEqual([97, 98, 99]);
        } finally {
            db.close();
            fresh.close();
            cleanupTestTempDir(directory);
        }
    });
    test("project facts blocks receipts and attempts survive session deletion with capped release", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            db.exec(`INSERT INTO memory_publications VALUES('pub','p','original',1,0);
                INSERT INTO memory_fact_blocks(publication_id,source_session_id,start_ordinal,end_ordinal,role,parts_json,joined_text) VALUES('pub','original',42,42,'user','["evidence"]','evidence');
                INSERT INTO memory_stage_attempts(stage_key,project_path,publication_id,run_attempt,stage,session_id,carrier,state,request_json,started_at) VALUES('stage','p','pub',1,'stage2','child','oc1','in_flight','{}',0);
                INSERT INTO memory_pending_facts(project_path,publication_id,fact_index,category,content,state,fact_attempts,reserved_stage_key) VALUES('p','pub',0,'NAMING','first','in_flight',1,'stage'),('p','pub',1,'NAMING','cap','in_flight',2,'stage');
                INSERT INTO memory_activity_ledger(project_path,publication_id,compartment_id,committed_at) VALUES('p','pub',1,0);`);
            db.transaction(() => deleteSessionScopedRows(db, ["child"]))();
            expect(
                db
                    .prepare(
                        "SELECT state,fact_attempts,reason FROM memory_pending_facts ORDER BY id",
                    )
                    .all(),
            ).toEqual([
                { state: "retryable", fact_attempts: 2, reason: "session_deleted" },
                { state: "decided_pending", fact_attempts: 3, reason: "session_deleted" },
            ]);
            expect(db.prepare("SELECT COUNT(*) AS n FROM memory_stage_attempts").get()).toEqual({
                n: 0,
            });
            expect(db.prepare("SELECT COUNT(*) AS n FROM memory_fact_blocks").get()).toEqual({
                n: 1,
            });
            expect(db.prepare("SELECT COUNT(*) AS n FROM memory_activity_ledger").get()).toEqual({
                n: 1,
            });
            for (const table of sessionTables)
                expect(
                    SESSION_SCOPED_TABLES.find((definition) => definition.table === table)
                        ?.harnessScoped,
                ).toBe(true);
            for (const table of projectTables)
                expect(SESSION_SCOPED_TABLES.some((definition) => definition.table === table)).toBe(
                    false,
                );
        } finally {
            db.close();
        }
    });
});
