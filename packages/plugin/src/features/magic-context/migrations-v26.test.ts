import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (c) => c.name,
    );
}

function tableExists(db: Database, table: string): boolean {
    return Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
    );
}

describe("migration v26 — memory mutation log and m[1] cache", () => {
    test("adds mutation log and cache columns while clearing cached m0/m1 state", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    description TEXT NOT NULL,
                    applied_at INTEGER NOT NULL
                );
                INSERT INTO schema_migrations (version, description, applied_at)
                VALUES (25, 'legacy v25', 1);

                CREATE TABLE session_meta (
                    session_id TEXT PRIMARY KEY,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    cached_m0_bytes BLOB,
                    cached_m0_project_memory_epoch INTEGER,
                    cached_m0_project_user_profile_version INTEGER,
                    cached_m0_max_compartment_seq INTEGER,
                    cached_m0_max_memory_id INTEGER,
                    cached_m0_max_mutation_id INTEGER,
                    cached_m0_project_docs_hash TEXT,
                    cached_m0_materialized_at INTEGER,
                    cached_m0_session_facts_version INTEGER,
                    cached_m0_upgrade_state TEXT,
                    memory_block_cache TEXT DEFAULT '',
                    memory_block_count INTEGER DEFAULT 0,
                    memory_block_ids TEXT DEFAULT ''
                );
                INSERT INTO session_meta (
                    session_id,
                    cached_m0_bytes,
                    cached_m0_project_memory_epoch,
                    cached_m0_project_user_profile_version,
                    cached_m0_max_compartment_seq,
                    cached_m0_max_memory_id,
                    cached_m0_max_mutation_id,
                    cached_m0_project_docs_hash,
                    cached_m0_materialized_at,
                    cached_m0_session_facts_version,
                    cached_m0_upgrade_state,
                    memory_block_cache,
                    memory_block_count,
                    memory_block_ids
                ) VALUES (
                    'ses-v26',
                    X'6d30',
                    1,
                    2,
                    3,
                    4,
                    5,
                    'docs',
                    6,
                    7,
                    'ready',
                    '<memory>stale</memory>',
                    8,
                    '[1,2]'
                );
            `);

            runMigrations(db);

            expect(tableExists(db, "memory_mutation_log")).toBe(true);
            const mutationColumns = columnNames(db, "memory_mutation_log");
            expect(mutationColumns).toEqual([
                "id",
                "project_path",
                "mutation_type",
                "target_memory_id",
                "superseded_by_id",
                "category",
                "new_content",
                "queued_at",
                "adoption_class",
            ]);
            const metaColumns = columnNames(db, "session_meta");
            expect(metaColumns).toContain("cached_m0_max_memory_mutation_id");
            expect(metaColumns).toContain("cached_m1_bytes");
            expect(metaColumns).toContain("last_observed_model_key");

            const row = db
                .prepare(
                    `SELECT cached_m0_bytes, cached_m1_bytes,
                            cached_m0_project_memory_epoch,
                            cached_m0_project_user_profile_version,
                            cached_m0_max_compartment_seq,
                            cached_m0_max_memory_id,
                            cached_m0_max_mutation_id,
                            cached_m0_max_memory_mutation_id,
                            cached_m0_project_docs_hash,
                            cached_m0_materialized_at,
                            cached_m0_session_facts_version,
                            cached_m0_upgrade_state,
                            memory_block_cache,
                            memory_block_count,
                            memory_block_ids
                       FROM session_meta
                      WHERE session_id = ?`,
                )
                .get("ses-v26") as {
                cached_m0_bytes: Buffer | null;
                cached_m1_bytes: Buffer | null;
                cached_m0_project_memory_epoch: number | null;
                cached_m0_project_user_profile_version: number | null;
                cached_m0_max_compartment_seq: number | null;
                cached_m0_max_memory_id: number | null;
                cached_m0_max_mutation_id: number | null;
                cached_m0_max_memory_mutation_id: number | null;
                cached_m0_project_docs_hash: string | null;
                cached_m0_materialized_at: number | null;
                cached_m0_session_facts_version: number | null;
                cached_m0_upgrade_state: string | null;
                memory_block_cache: string;
                memory_block_count: number;
                memory_block_ids: string;
            };
            expect(row).toEqual({
                cached_m0_bytes: null,
                cached_m1_bytes: null,
                cached_m0_project_memory_epoch: null,
                cached_m0_project_user_profile_version: null,
                cached_m0_max_compartment_seq: null,
                cached_m0_max_memory_id: null,
                cached_m0_max_mutation_id: null,
                cached_m0_max_memory_mutation_id: null,
                cached_m0_project_docs_hash: null,
                cached_m0_materialized_at: null,
                cached_m0_session_facts_version: null,
                cached_m0_upgrade_state: null,
                memory_block_cache: "",
                memory_block_count: 0,
                memory_block_ids: "",
            });
        } finally {
            closeQuietly(db);
        }
    });
});
