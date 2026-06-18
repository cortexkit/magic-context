import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

function tableInfo(
    db: Database,
    table: string,
): Array<{ name: string; notnull: number; pk: number }> {
    return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        notnull: number;
        pk: number;
    }>;
}

function column(db: Database, table: string, name: string) {
    const found = tableInfo(db, table).find((item) => item.name === name);
    expect(found).toBeDefined();
    return found!;
}

function countRows(db: Database, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe("migration v49 — per-model embedding coexistence", () => {
    test("rebuilds embedding leaves, maps NULL memory model ids to sentinel, and stays idempotent", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            db.exec(`
                DELETE FROM schema_migrations WHERE version >= 49;
                DROP TABLE IF EXISTS embedding_identity_active;
                DROP TABLE memory_embeddings;
                DROP TABLE git_commit_embeddings;
                DROP TABLE compartment_chunk_embeddings;

                CREATE TABLE memory_embeddings (
                    memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
                    embedding BLOB NOT NULL,
                    model_id TEXT
                );
                CREATE TABLE git_commit_embeddings (
                    sha TEXT PRIMARY KEY,
                    embedding BLOB NOT NULL,
                    model_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(sha) REFERENCES git_commits(sha) ON DELETE CASCADE
                );
                CREATE TABLE compartment_chunk_embeddings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    compartment_id INTEGER NOT NULL REFERENCES compartments(id) ON DELETE CASCADE,
                    session_id TEXT NOT NULL,
                    project_path TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    window_index INTEGER NOT NULL DEFAULT 0,
                    start_ordinal INTEGER NOT NULL,
                    end_ordinal INTEGER NOT NULL,
                    chunk_hash TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    dims INTEGER NOT NULL,
                    vector BLOB NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE(compartment_id, window_index)
                );
                CREATE INDEX idx_cce_session ON compartment_chunk_embeddings(session_id);
                CREATE INDEX idx_cce_project_model ON compartment_chunk_embeddings(project_path, model_id);

                INSERT INTO memories (id, project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
                VALUES
                    (1, 'git:v49', 'CONSTRAINTS', 'legacy null model', 'h1', 1, 1, 1, 1),
                    (2, 'git:v49', 'CONSTRAINTS', 'known model', 'h2', 1, 1, 1, 1);
                INSERT INTO memory_embeddings (memory_id, embedding, model_id)
                VALUES (1, x'0001', NULL), (2, x'0002', 'model:a');

                INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at)
                VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'git:v49', 'aaaaaaa', 'first', 'dev', 1, 1);
                INSERT INTO git_commit_embeddings (sha, embedding, model_id, created_at)
                VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', x'0003', 'model:a', 1);

                INSERT INTO compartments (id, session_id, sequence, start_message, end_message, title, content, created_at)
                VALUES (1, 'ses-v49', 0, 1, 2, 'Title', 'Content', 1);
                INSERT INTO compartment_chunk_embeddings (
                    compartment_id, session_id, project_path, harness, window_index,
                    start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at
                ) VALUES (1, 'ses-v49', 'git:v49', 'opencode', 0, 1, 2, 'hash-a', 'model:a', 2, x'0004', 1);
            `);

            runMigrations(db);

            expect(column(db, "memory_embeddings", "memory_id").pk).toBe(1);
            expect(column(db, "memory_embeddings", "model_id")).toMatchObject({
                notnull: 1,
                pk: 2,
            });
            expect(column(db, "git_commit_embeddings", "sha").pk).toBe(1);
            expect(column(db, "git_commit_embeddings", "model_id").pk).toBe(2);
            expect(countRows(db, "embedding_identity_active")).toBe(0);
            expect(
                db.prepare("SELECT model_id FROM memory_embeddings WHERE memory_id = 1").get(),
            ).toEqual({ model_id: "legacy:unknown" });

            db.prepare(
                `INSERT INTO git_commit_embeddings (sha, embedding, model_id, created_at)
                 VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', x'0005', 'model:b', 2)`,
            ).run();
            db.prepare(
                `INSERT INTO compartment_chunk_embeddings (
                    compartment_id, session_id, project_path, harness, window_index,
                    start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at
                 ) VALUES (1, 'ses-v49', 'git:v49', 'opencode', 0, 1, 2, 'hash-b', 'model:b', 2, x'0006', 2)`,
            ).run();
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO compartment_chunk_embeddings (
                            compartment_id, session_id, project_path, harness, window_index,
                            start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at
                         ) VALUES (1, 'ses-v49', 'git:v49', 'opencode', 0, 1, 2, 'hash-c', 'model:b', 2, x'0007', 3)`,
                    )
                    .run(),
            ).toThrow();

            expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
            runMigrations(db);
            expect(
                db
                    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                    .get(),
            ).toEqual({ version: LATEST_MIGRATION_VERSION });
        } finally {
            closeQuietly(db);
        }
    });

    test("reaches v49 with a pre-existing orphan in the chunk table (per-table FK check, not global)", () => {
        // A global foreign_key_check after the FIRST (memory) rebuild would also
        // inspect the still-old chunk table and fail closed on an orphan there —
        // before the chunk orphan pre-clean ever runs. The per-table check + each
        // table's own pre-clean must let the migration finish. The chunk table is
        // the sharpest case: no prior migration ever cleaned it.
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            // Inject a chunk orphan (no parent compartment) with FK enforcement off,
            // then roll v49 back and re-run.
            db.exec("PRAGMA foreign_keys=OFF");
            db.prepare(
                `INSERT INTO compartment_chunk_embeddings (
                    compartment_id, session_id, project_path, harness, window_index,
                    start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at
                 ) VALUES (999999, 'ses-orphan', 'git:orphan', 'opencode', 0, 0, 1, 'h', 'm', 4, x'01020304', 1)`,
            ).run();
            db.exec("PRAGMA foreign_keys=ON");
            // Delete v49 AND everything above it (upstream v50/51/52 + our skill
            // migrations v53/54/55) so getCurrentVersion drops below 49 and the
            // v49 body actually re-runs.
            db.prepare("DELETE FROM schema_migrations WHERE version >= 49").run();

            expect(() => runMigrations(db)).not.toThrow();
            expect(countRows(db, "compartment_chunk_embeddings")).toBe(0);
            expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
            expect(
                db
                    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                    .get(),
            ).toEqual({ version: LATEST_MIGRATION_VERSION });
        } finally {
            closeQuietly(db);
        }
    });
});
