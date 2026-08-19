import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { partitionVerifyScope } from "./dreamer/verify-gate";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { auditIdentityMerge, mergeProjectIdentities } from "./storage-identity-merge";

let db: Database | null = null;

function makeDb(): Database {
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function insertMemory(
    database: Database,
    projectPath: string,
    content: string,
    hash: string,
): number {
    const result = database
        .prepare(
            `INSERT INTO memories
                (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES (?, 'CONSTRAINTS', ?, ?, 1, 1, 1, 1)`,
        )
        .run(projectPath, content, hash) as { lastInsertRowid?: number };
    return Number(result.lastInsertRowid);
}

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

describe("project identity merge", () => {
    test("dry-run audits schema-scoped tables without writing", () => {
        const database = makeDb();
        insertMemory(database, "dir:old", "old", "old-hash");
        database.prepare("INSERT INTO project_state(project_path) VALUES (?)").run("dir:old");

        const report = mergeProjectIdentities(database, "dir:old", "git:new", { dryRun: true });

        expect(report.dryRun).toBe(true);
        expect(report.auditedTables.map((table) => table.tableName)).toContain("memories");
        expect(report.auditedTables.map((table) => table.tableName)).toContain("project_state");
        expect(report.changedRows).toBe(2);
        expect(database.prepare("SELECT COUNT(*) AS count FROM identity_merge_log").get()).toEqual({
            count: 0,
        });
        expect(database.prepare("SELECT project_path FROM memories").get()).toEqual({
            project_path: "dir:old",
        });
    });

    test("rekeys audited rows, supersedes memory collisions, bumps epoch, and logs each mutation", () => {
        const database = makeDb();
        const sourceId = insertMemory(database, "dir:old", "legacy", "same-hash");
        const targetId = insertMemory(database, "git:new", "canonical", "same-hash");
        database
            .prepare(
                `INSERT INTO memory_evidence
                    (memory_id, content_hash, source_session_id, source_message_id, source_type, observed_at)
                 VALUES (?, 'same-hash', 'session-source', 'assistant-source', 'agent', 1),
                        (?, 'same-hash', 'session-target', 'assistant-target', 'agent', 2)`,
            )
            .run(sourceId, targetId);
        database
            .prepare("INSERT INTO project_state(project_path, project_memory_epoch) VALUES (?, 4)")
            .run("git:new");
        database
            .prepare(
                "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
            )
            .run("ses-old", "opencode", "dir:old", 1);
        database
            .prepare(
                "INSERT INTO git_commits(sha, project_path, short_sha, message, committed_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run("sha-old", "dir:old", "sha-old", "legacy commit", 1, 1);

        const report = mergeProjectIdentities(database, "dir:old", "git:new", { now: 10 });

        expect(report.changedRows).toBeGreaterThanOrEqual(4);
        expect(
            database
                .prepare(
                    "SELECT project_path, status, superseded_by_memory_id FROM memories WHERE id = ?",
                )
                .get(sourceId),
        ).toEqual({
            project_path: "dir:old",
            status: "archived",
            superseded_by_memory_id: targetId,
        });
        expect(
            database
                .prepare("SELECT COUNT(*) AS count FROM memories WHERE project_path = 'git:new'")
                .get(),
        ).toEqual({
            count: 1,
        });
        expect(
            database
                .prepare("SELECT project_path FROM session_projects WHERE session_id = 'ses-old'")
                .get(),
        ).toEqual({
            project_path: "git:new",
        });
        expect(
            database.prepare("SELECT project_path FROM git_commits WHERE sha = 'sha-old'").get(),
        ).toEqual({
            project_path: "git:new",
        });
        expect(
            database
                .prepare(
                    "SELECT project_memory_epoch FROM project_state WHERE project_path = 'git:new'",
                )
                .get(),
        ).toEqual({
            project_memory_epoch: 5,
        });
        expect(database.prepare("SELECT COUNT(*) AS count FROM identity_merge_log").get()).toEqual({
            count: report.changedRows,
        });
        expect(
            database
                .prepare(
                    "SELECT source_session_id FROM memory_evidence WHERE memory_id = ? ORDER BY source_session_id",
                )
                .all(targetId),
        ).toEqual([
            { source_session_id: "session-source" },
            { source_session_id: "session-target" },
        ]);
    });

    test("preserves the oldest open broad cycle when task schedule rows collide", async () => {
        const database = makeDb();
        insertMemory(database, "dir:old", "legacy", "same-hash");
        const targetId = insertMemory(database, "git:new", "canonical", "same-hash");
        database
            .prepare(
                `INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
                 VALUES (?, 'src/banked.ts', 150, 150)`,
            )
            .run(targetId);
        database
            .prepare(
                `INSERT INTO task_schedule_state
                    (project_path, task, last_run_at, next_due_at, schedule, last_status,
                     retry_count, last_broad_run_at)
                 VALUES (?, 'verify-broad', 50, 60, 'old', 'completed', 0, 100)`,
            )
            .run("dir:old");
        database
            .prepare(
                `INSERT INTO task_schedule_state
                    (project_path, task, last_run_at, next_due_at, schedule, last_status,
                     retry_count, last_broad_run_at)
                 VALUES (?, 'verify-broad', 200, 210, 'new', 'completed', 0, NULL)`,
            )
            .run("git:new");

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 250 });

        expect(
            database
                .prepare(
                    `SELECT last_run_at, last_broad_run_at
                       FROM task_schedule_state
                      WHERE project_path = 'git:new' AND task = 'verify-broad'`,
                )
                .get(),
        ).toEqual({ last_run_at: 200, last_broad_run_at: 100 });
        const gate = await partitionVerifyScope({
            db: database,
            projectIdentity: "git:new",
            projectDirectory: process.cwd(),
            forceBroad: true,
            now: 300,
        });
        expect(gate.broadCycleStartAt).toBe(100);
        expect(gate.inScopeIds).toEqual([]);
        expect(gate.skippedIds).toEqual([targetId]);
    });

    test("moves newer classification, mural cue, and verifications to a collision survivor", () => {
        const database = makeDb();
        const sourceId = insertMemory(database, "dir:old", "legacy", "same-hash");
        const targetId = insertMemory(database, "git:new", "canonical", "same-hash");
        database
            .prepare(
                `UPDATE memories
                    SET importance = 91, scope = 'workspace', shareable = 1, classified_at = 20,
                        mural_cue = 'new cue', mural_cue_hash = 'cue-hash', mural_cue_at = 30,
                        mural_cue_rejection_count = 2
                  WHERE id = ?`,
            )
            .run(sourceId);
        database
            .prepare(
                `UPDATE memories
                    SET importance = 12, scope = 'project', shareable = 0, classified_at = 10
                  WHERE id = ?`,
            )
            .run(targetId);
        database
            .prepare(
                `INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
                 VALUES (?, 'src/shared.ts', 40, 35), (?, 'src/source.ts', 30, 25)`,
            )
            .run(sourceId, sourceId);
        database
            .prepare(
                `INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
                 VALUES (?, 'src/shared.ts', 15, 10)`,
            )
            .run(targetId);

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 50 });

        expect(
            database
                .prepare(
                    `SELECT importance, scope, shareable, classified_at, mural_cue,
                            mural_cue_hash, mural_cue_at, mural_cue_rejection_count
                       FROM memories WHERE id = ?`,
                )
                .get(targetId),
        ).toEqual({
            importance: 91,
            scope: "workspace",
            shareable: 1,
            classified_at: 20,
            mural_cue: "new cue",
            mural_cue_hash: "cue-hash",
            mural_cue_at: 30,
            mural_cue_rejection_count: 2,
        });
        expect(
            database
                .prepare(
                    `SELECT memory_id, file_path, verified_at, mapped_at
                       FROM memory_verifications
                      WHERE memory_id = ?
                      ORDER BY file_path`,
                )
                .all(targetId),
        ).toEqual([
            {
                memory_id: targetId,
                file_path: "src/shared.ts",
                verified_at: 40,
                mapped_at: 35,
            },
            {
                memory_id: targetId,
                file_path: "src/source.ts",
                verified_at: 30,
                mapped_at: 25,
            },
        ]);
        expect(
            database
                .prepare("SELECT COUNT(*) AS count FROM memory_verifications WHERE memory_id = ?")
                .get(sourceId),
        ).toEqual({ count: 0 });
    });

    test("refuses a module-owned source pool before any mutation", () => {
        const database = makeDb();
        insertMemory(database, "dir:module", "memory", "module-hash");
        database
            .prepare(
                "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, ?, ?)",
            )
            .run("dir:module", "store", 1);

        expect(() => mergeProjectIdentities(database, "dir:module", "git:new")).toThrow(
            "managed by the Rust module",
        );
        expect(auditIdentityMerge(database, "dir:module", "git:new").changedRows).toBe(2);
        expect(database.prepare("SELECT project_path FROM memories").get()).toEqual({
            project_path: "dir:module",
        });
    });
});
