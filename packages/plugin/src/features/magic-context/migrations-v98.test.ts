import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { installCompartmentRescoreSchema } from "./migration-v98-compartment-rescore";
import { LATEST_MIGRATION_VERSION, MIGRATIONS, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";
import { deleteSessionScopedRows, SESSION_SCOPED_TABLES } from "./storage-session-tables";

const scoreTables = ["compartment_score_selections", "compartment_score_revisions"];
const projectTables = [
    "rescore_items",
    "rescore_attempts",
    "rescore_batches",
    "rescore_jobs",
    "rescore_snapshots",
    "rescore_activation",
];

function schema(db: Database): unknown[] {
    return db
        .prepare(
            `SELECT type, name, tbl_name, sql FROM sqlite_master
             WHERE tbl_name IN (${[...scoreTables, ...projectTables].map(() => "?").join(",")})
             ORDER BY name`,
        )
        .all(...scoreTables, ...projectTables);
}

function populatedV97(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    // Drop the tables and column created by fresh-store initialization so the
    // test verifies that migration v98 creates them on a populated older store.
    for (const table of [...scoreTables, ...projectTables]) db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE session_meta DROP COLUMN cached_m0_score_selection_watermark;
        CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT)`);
    for (const migration of MIGRATIONS.filter((m) => m.version <= 97)) {
        migration.up(db);
        db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, 0)").run(
            migration.version,
        );
    }
    db.exec(`INSERT INTO session_meta(session_id, harness, counter, cached_m0_bytes)
        VALUES ('target', 'opencode', 42, X'010203');
        INSERT INTO compartments
            (id, session_id, sequence, start_message, end_message, title, content, p1,
             importance, created_at, harness)
        VALUES (1, 'target', 0, 1, 4, 'one', 'P1', 'P1', 50, 100, 'opencode'),
               (2, 'target', 1, 5, 8, 'two', 'P1', 'P1', 75, 101, 'pi'),
               (3, 'other', 0, 1, 4, 'three', 'P1', 'P1', 25, 102, 'pi');
        UPDATE compartments SET title='ONE' WHERE id=1;`);
    return db;
}

function insertRevision(db: Database, compartmentId: number, sessionId: string): number {
    const result = db
        .prepare(`INSERT INTO compartment_score_revisions
        (compartment_id, session_id, source_identity, old_importance, new_importance,
         rubric_version, prompt_hash, model, seed_ids, job_id, batch_id, attempt_id,
         completed_at, reason)
        VALUES (?, ?, 'identity', 50, 50, 1, 'prompt', 'model', '[]',
                'job', 'batch', 'attempt', 123, 'Equal scores still count')`)
        .run(compartmentId, sessionId);
    return Number(result.lastInsertRowid);
}

function insertSelection(
    db: Database,
    compartmentId: number,
    sessionId: string,
    sequence: number,
    revisionId: number,
): void {
    db.prepare(`INSERT INTO compartment_score_selections
        (session_id, compartment_id, sequence, revision_id, origin, job_id, batch_id, attempt_id)
        VALUES (?, ?, ?, ?, 'publication', 'job', 'batch', 'attempt')`).run(
        sessionId,
        compartmentId,
        sequence,
        revisionId,
    );
}

function insertJob(db: Database): void {
    db.exec(`INSERT INTO rescore_snapshots
        (id, scope, scope_key, project_path, target_sessions, items, cutoff, rubric_version,
         model_profile, seed_policy, cost_estimate, created_at)
        VALUES ('snapshot', 'project', 'project', 'project', '["target","other"]', '[]', 100,
                1, '{"model":"model","temperature":0.2,"maxOutputTokens":4096}', '[]', '{}', 1);
        INSERT INTO rescore_jobs
        (id, snapshot_id, originating_harness, project_path, model_profile, cutoff, rubric_version,
         heartbeat_at, state, last_error, created_at, updated_at)
        VALUES ('job', 'snapshot', 'opencode', 'project', '{"model":"model"}', 100, 1, 1,
                'running', 'provider: missing credentials', 1, 1);
        INSERT INTO rescore_batches(id, job_id, sequence, state, created_at)
        VALUES ('batch', 'job', 1, 'pending', 1), ('batch2', 'job', 2, 'pending', 1);
        INSERT INTO rescore_items(id, job_id, target_session_id, compartment_id, source_identity, state)
        VALUES ('item1', 'job', 'target', 1, 'identity', 'pending'),
               ('item2', 'job', 'other', 3, 'identity', 'pending');`);
}

function insertAttempt(db: Database, id: string, batch = "batch"): void {
    db.prepare(`INSERT INTO rescore_attempts
        (id, job_id, batch_id, state, handle_map, prompt_hash, seed_ids, model,
         owner_generation, admitted_at, payload)
        VALUES (?, 'job', ?, 'admitted', '{"opaque":"item1"}', 'prompt', '[]', 'model',
                1, 1, '[{"handle":"opaque","score":50,"reason":"private"}]')`).run(id, batch);
}

describe("migration 98", () => {
    test("a sparse legacy store without session metadata still installs job and score tables", () => {
        const db = new Database(":memory:");
        try {
            installCompartmentRescoreSchema(db);
            expect(db.prepare("PRAGMA table_info(session_meta)").all()).toEqual([]);
            expect(db.prepare("SELECT COUNT(*) AS n FROM rescore_activation").get()).toEqual({
                n: 1,
            });
            for (const table of [...scoreTables, ...projectTables]) {
                expect(db.prepare(`PRAGMA table_info(${table})`).all().length).toBeGreaterThan(0);
            }
        } finally {
            db.close();
        }
    });
    test("steps over populated v97 without changing base rows, revisions or existing schemas", () => {
        const db = populatedV97();
        const fresh = new Database(":memory:");
        try {
            const compartments = db.prepare("SELECT * FROM compartments ORDER BY id").all();
            const history = db
                .prepare("SELECT * FROM compartment_history_versions ORDER BY session_id")
                .all();
            expect(history).toEqual(
                expect.arrayContaining([expect.objectContaining({ rewrite_version: 1 })]),
            );
            const meta = db.prepare("SELECT * FROM session_meta WHERE session_id='target'").get();
            const unchangedSchema = db
                .prepare(`SELECT name, sql FROM sqlite_master
                WHERE tbl_name IN ('compartments', 'subagent_invocations') ORDER BY name`)
                .all();
            expect(schema(db)).toEqual([]);
            expect(
                db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
            ).toEqual({ version: 97 });

            runMigrations(db);

            expect(LATEST_MIGRATION_VERSION).toBe(98);
            expect(LATEST_SUPPORTED_VERSION).toBe(98);
            expect(
                db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
            ).toEqual({ version: 98 });
            expect(db.prepare("SELECT * FROM compartments ORDER BY id").all()).toEqual(
                compartments,
            );
            expect(
                db.prepare("SELECT * FROM compartment_history_versions ORDER BY session_id").all(),
            ).toEqual(history);
            expect(
                db.prepare("SELECT * FROM session_meta WHERE session_id='target'").get(),
            ).toEqual({
                ...(meta as object),
                cached_m0_score_selection_watermark: 0,
            });
            expect(
                db
                    .prepare(`SELECT name, sql FROM sqlite_master
                WHERE tbl_name IN ('compartments', 'subagent_invocations') ORDER BY name`)
                    .all(),
            ).toEqual(unchangedSchema);
            expect(db.prepare("SELECT COUNT(*) AS n FROM m0_mutation_log").get()).toEqual({ n: 0 });
            initializeDatabase(fresh);
            runMigrations(fresh);
            expect(schema(db)).toEqual(schema(fresh));
            insertJob(db);
            insertAttempt(db, "attempt");
            const accepted = insertRevision(db, 1, "target");
            insertSelection(db, 1, "target", 1, accepted);
            const rowsBefore = [...scoreTables, ...projectTables].map((table) =>
                db.prepare(`SELECT * FROM ${table}`).all(),
            );
            installCompartmentRescoreSchema(db);
            runMigrations(db);
            expect(
                [...scoreTables, ...projectTables].map((table) =>
                    db.prepare(`SELECT * FROM ${table}`).all(),
                ),
            ).toEqual(rowsBefore);
            expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
            db.close();
            fresh.close();
        }
    });

    test("fresh initialization and current startup heal the watermark and retain one activation timestamp", () => {
        const { dir } = createTestTempDir("mc-v98-activation-");
        const path = join(dir, "context.db");
        const first = new Database(path);
        let second: Database | undefined;
        try {
            const before = Date.now();
            initializeDatabase(first);
            const activation = first
                .prepare("SELECT id, activated_at FROM rescore_activation")
                .get() as { id: number; activated_at: number };
            expect(activation.id).toBe(1);
            expect(activation.activated_at).toBeGreaterThanOrEqual(before);
            expect(activation.activated_at).toBeLessThanOrEqual(Date.now());
            expect(() => first.exec("INSERT INTO rescore_activation VALUES (2, 1)")).toThrow();
            // A distinct historical timestamp makes an accidental startup overwrite observable.
            first.exec("UPDATE rescore_activation SET activated_at=123 WHERE id=1");
            runMigrations(first);
            first.exec("ALTER TABLE session_meta DROP COLUMN cached_m0_score_selection_watermark");
            second = new Database(path);
            initializeDatabase(second);
            expect(second.prepare("SELECT * FROM rescore_activation").all()).toEqual([
                { id: 1, activated_at: 123 },
            ]);
            second.exec("INSERT INTO session_meta(session_id) VALUES ('new')");
            expect(
                second
                    .prepare(
                        "SELECT cached_m0_score_selection_watermark AS w FROM session_meta WHERE session_id='new'",
                    )
                    .get(),
            ).toEqual({ w: 0 });
            expect(() =>
                second!.exec("UPDATE session_meta SET cached_m0_score_selection_watermark=-1"),
            ).toThrow();
        } finally {
            second?.close();
            first.close();
            cleanupTestTempDir(dir);
        }
    });
    test("selection publication key admits multiple items but rejects a duplicate item", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            const first = insertRevision(db, 1, "target");
            const second = insertRevision(db, 2, "target");
            db.exec("BEGIN IMMEDIATE");
            insertSelection(db, 1, "target", 1, first);
            insertSelection(db, 2, "target", 2, second);
            expect(() => insertSelection(db, 1, "target", 3, first)).toThrow();
            db.exec("COMMIT");
            expect(
                db
                    .prepare(
                        "SELECT compartment_id, sequence FROM compartment_score_selections ORDER BY sequence",
                    )
                    .all(),
            ).toEqual([
                { compartment_id: 1, sequence: 1 },
                { compartment_id: 2, sequence: 2 },
            ]);
        } finally {
            if (db.inTransaction) db.exec("ROLLBACK");
            db.close();
        }
    });

    test("selection sequences are positive and session-unique; undo is append-only and compartment-bound", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            const revision = insertRevision(db, 1, "target");
            const foreignRevision = insertRevision(db, 2, "target");
            insertSelection(db, 1, "target", 1, revision);
            const undo = db.prepare(`INSERT INTO compartment_score_selections
                (session_id, compartment_id, sequence, revision_id, origin) VALUES ('target', 1, ?, ?, 'undo')`);
            expect(() => undo.run(0, null)).toThrow();
            expect(() => undo.run(1, null)).toThrow();
            expect(() => undo.run(2, foreignRevision)).toThrow();
            expect(() => undo.run(2, 99999)).toThrow();
            undo.run(2, null);
            undo.run(3, revision);
            expect(() =>
                db.exec("UPDATE compartment_score_selections SET sequence=4 WHERE sequence=1"),
            ).toThrow("append-only");
            expect(
                db
                    .prepare(
                        "SELECT sequence, revision_id FROM compartment_score_selections ORDER BY sequence",
                    )
                    .all(),
            ).toEqual([
                { sequence: 1, revision_id: revision },
                { sequence: 2, revision_id: null },
                { sequence: 3, revision_id: revision },
            ]);
        } finally {
            db.close();
        }
    });

    test("accepted equal-score revisions are retained and score bounds reject invalid values", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            const revision = insertRevision(db, 1, "target");
            expect(() => insertRevision(db, 1, "target")).toThrow();
            for (const column of ["old_importance", "new_importance"]) {
                for (const invalid of [0, 101]) {
                    expect(() =>
                        db.exec(`UPDATE compartment_score_revisions SET ${column}=${invalid}`),
                    ).toThrow();
                }
            }
            db.exec(`INSERT INTO compartment_score_revisions
                (compartment_id, session_id, source_identity, old_importance, new_importance,
                 rubric_version, prompt_hash, model, seed_ids, job_id, batch_id, attempt_id,
                 completed_at, reason)
                SELECT compartment_id, session_id, 'changed-source', old_importance, 80,
                    rubric_version, prompt_hash, model, seed_ids, job_id, batch_id, 'later',
                    completed_at, reason FROM compartment_score_revisions WHERE id=${revision}`);
            expect(
                db
                    .prepare("SELECT new_importance FROM compartment_score_revisions ORDER BY id")
                    .all(),
            ).toEqual([{ new_importance: 50 }, { new_importance: 80 }]);
        } finally {
            db.close();
        }
    });

    test("one admitted attempt per job allows a new attempt after settlement", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            insertJob(db);
            insertAttempt(db, "first");
            expect(() => insertAttempt(db, "second", "batch2")).toThrow();
            db.exec(
                "UPDATE rescore_attempts SET state='settled', outcome='failed', payload=NULL WHERE id='first'",
            );
            insertAttempt(db, "second", "batch2");
            expect(db.prepare("SELECT id, state FROM rescore_attempts ORDER BY id").all()).toEqual([
                { id: "first", state: "settled" },
                { id: "second", state: "admitted" },
            ]);
        } finally {
            db.close();
        }
    });

    test("terminal attempts cannot retain a private payload and snapshots cannot be rewritten", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            insertJob(db);
            expect(() => db.exec("UPDATE rescore_snapshots SET items='[1]'")).toThrow("immutable");
            db.exec("UPDATE rescore_snapshots SET superseded_at=2");
            for (const state of ["settled", "abandoned", "cancelled"]) {
                insertAttempt(db, state);
                const outcome = state === "settled" ? "'published'" : "NULL";
                expect(() =>
                    db.exec(
                        `UPDATE rescore_attempts SET state='${state}', outcome=${outcome} WHERE id='${state}'`,
                    ),
                ).toThrow();
                db.exec(
                    `UPDATE rescore_attempts SET state='${state}', outcome=${outcome}, payload=NULL WHERE id='${state}'`,
                );
            }
            expect(db.prepare("SELECT payload FROM rescore_attempts").all()).toEqual([
                { payload: null },
                { payload: null },
                { payload: null },
            ]);
        } finally {
            db.close();
        }
    });

    test("a harness sweep retains score history with remaining compartments and keeps project jobs", () => {
        const db = populatedV97();
        try {
            runMigrations(db);
            insertJob(db);
            insertAttempt(db, "attempt");
            for (const [id, session, sequence] of [
                [1, "target", 1],
                [2, "target", 2],
                [3, "other", 1],
            ] as const) {
                insertSelection(db, id, session, sequence, insertRevision(db, id, session));
            }
            const projectRows = projectTables.map((table) =>
                db.prepare(`SELECT * FROM ${table}`).all(),
            );
            const otherRows = scoreTables.map((table) =>
                db.prepare(`SELECT * FROM ${table} WHERE session_id='other'`).all(),
            );
            for (const table of scoreTables) {
                expect(
                    SESSION_SCOPED_TABLES.find((entry) => entry.table === table)?.extraPredicate,
                ).toContain("NOT EXISTS");
            }
            for (const table of projectTables) {
                expect(SESSION_SCOPED_TABLES.some((entry) => entry.table === table)).toBe(false);
            }
            deleteSessionScopedRows(db, ["target"], "opencode");
            expect(
                db.prepare("SELECT id FROM compartments WHERE session_id='target'").all(),
            ).toEqual([{ id: 2 }]);
            for (const table of scoreTables) {
                expect(
                    db
                        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id='target'`)
                        .get(),
                ).toEqual({ n: 2 });
            }
            deleteSessionScopedRows(db, ["target"], "pi");
            for (const table of scoreTables) {
                expect(
                    db
                        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id='target'`)
                        .get(),
                ).toEqual({ n: 0 });
            }
            expect(
                scoreTables.map((table) =>
                    db.prepare(`SELECT * FROM ${table} WHERE session_id='other'`).all(),
                ),
            ).toEqual(otherRows);
            expect(
                projectTables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
            ).toEqual(projectRows);
            expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
            db.close();
        }
    });
});
