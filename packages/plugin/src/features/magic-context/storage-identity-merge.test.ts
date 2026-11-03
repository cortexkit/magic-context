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
        const sourceId = insertMemory(database, "dir:old", "canonical", "same-hash");
        const targetId = insertMemory(database, "git:new", "canonical", "same-hash");
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
    });

    test("preserves the oldest open broad cycle when task schedule rows collide", async () => {
        const database = makeDb();
        insertMemory(database, "dir:old", "canonical", "same-hash");
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
        const sourceId = insertMemory(database, "dir:old", "canonical", "same-hash");
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
                `INSERT INTO memory_verifications
                    (memory_id, file_path, verified_at, mapped_at, mapping_origin)
                 VALUES (?, 'src/shared.ts', 40, 35, 'host_rejected_fallback'),
                        (?, 'src/source.ts', 30, 25, 'host_rejected_fallback')`,
            )
            .run(sourceId, sourceId);
        database
            .prepare(
                `INSERT INTO memory_verifications
                    (memory_id, file_path, verified_at, mapped_at, mapping_origin)
                 VALUES (?, 'src/shared.ts', 15, 10, 'mapper')`,
            )
            .run(targetId);

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 50 });

        expect(
            database
                .prepare(
                    `SELECT importance, scope, shareable, classified_at, mural_cue,
                        mural_cue_hash, mural_cue_at, mural_cue_rejection_count, updated_at
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
            updated_at: 50,
        });
        expect(
            database
                .prepare(
                    `SELECT memory_id, file_path, verified_at, mapped_at, mapping_origin
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
                mapping_origin: "host_rejected_fallback",
            },
            {
                memory_id: targetId,
                file_path: "src/source.ts",
                verified_at: 30,
                mapped_at: 25,
                mapping_origin: "host_rejected_fallback",
            },
        ]);
        expect(
            database
                .prepare("SELECT COUNT(*) AS count FROM memory_verifications WHERE memory_id = ?")
                .get(sourceId),
        ).toEqual({ count: 0 });
    });

    test("timestamps a classification transfer to the collision survivor", () => {
        const database = makeDb();
        const sourceId = insertMemory(database, "dir:old", "canonical", "same-hash");
        const targetId = insertMemory(database, "git:new", "canonical", "same-hash");
        database
            .prepare(
                "UPDATE memories SET importance = 91, scope = 'workspace', shareable = 1, classified_at = 20 WHERE id = ?",
            )
            .run(sourceId);
        database.prepare("UPDATE memories SET classified_at = 10 WHERE id = ?").run(targetId);

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 50 });

        expect(
            database
                .prepare(
                    "SELECT importance, scope, shareable, classified_at, updated_at FROM memories WHERE id = ?",
                )
                .get(targetId),
        ).toEqual({
            importance: 91,
            scope: "workspace",
            shareable: 1,
            classified_at: 20,
            updated_at: 50,
        });
    });

    test.each([
        { targetSafety: 1, sourceSafety: 0, sourceImportance: 12, updatedAt: 1 },
        { targetSafety: 0, sourceSafety: 1, sourceImportance: 80, updatedAt: 50 },
    ])("timestamps only a change to the inherited safety assessment: %j", ({
        targetSafety,
        sourceSafety,
        sourceImportance,
        updatedAt,
    }) => {
        const database = makeDb();
        const sourceId = insertMemory(database, "dir:old", "canonical", "same-hash");
        const targetId = insertMemory(database, "git:new", "canonical", "same-hash");
        database
            .prepare(
                "UPDATE memories SET safety_critical = ?, importance = ?, classified_at = 20 WHERE id = ?",
            )
            .run(sourceSafety, sourceImportance, sourceId);
        database
            .prepare(
                "UPDATE memories SET safety_critical = ?, importance = 80, classified_at = 10 WHERE id = ?",
            )
            .run(targetSafety, targetId);

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 50 });

        expect(
            database
                .prepare(
                    "SELECT safety_critical, importance, classified_at, updated_at FROM memories WHERE id = ?",
                )
                .get(targetId),
        ).toEqual({
            safety_critical: 1,
            importance: 80,
            classified_at: 20,
            updated_at: updatedAt,
        });
    });

    test("copies a mural cue onto the collision survivor without marking it edited", () => {
        const database = makeDb();
        const sourceId = insertMemory(database, "dir:old", "canonical", "same-hash");
        const targetId = insertMemory(database, "git:new", "canonical", "same-hash");
        database
            .prepare(
                "UPDATE memories SET mural_cue = 'cue', mural_cue_hash = 'cue-hash', mural_cue_at = 20, mural_cue_rejection_count = 2 WHERE id = ?",
            )
            .run(sourceId);

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 50 });

        expect(
            database
                .prepare(
                    "SELECT mural_cue, mural_cue_hash, mural_cue_at, mural_cue_rejection_count, updated_at FROM memories WHERE id = ?",
                )
                .get(targetId),
        ).toEqual({
            mural_cue: "cue",
            mural_cue_hash: "cue-hash",
            mural_cue_at: 20,
            mural_cue_rejection_count: 2,
            updated_at: 1,
        });
    });

    test("merges seen-count changes without marking the collision survivor edited", () => {
        const database = makeDb();
        const sourceId = insertMemory(database, "dir:old", "canonical", "same-hash");
        const targetId = insertMemory(database, "git:new", "canonical", "same-hash");
        database.prepare("UPDATE memories SET seen_count = 3 WHERE id = ?").run(sourceId);

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 50 });

        expect(
            database
                .prepare("SELECT seen_count, status, updated_at FROM memories WHERE id = ?")
                .get(targetId),
        ).toEqual({ seen_count: 4, status: "active", updated_at: 1 });
    });

    test("rekeys a memory without changing anything but project_path", () => {
        const database = makeDb();
        const sourceId = insertMemory(database, "dir:old", "legacy", "old-hash");
        database
            .prepare(
                `UPDATE memories
                    SET importance = 40, scope = 'workspace', shareable = 1, seen_count = 3,
                        retrieval_count = 2, status = 'permanent', mural_cue = 'kept cue',
                        mural_cue_hash = 'kept-hash', mural_cue_at = 8,
                        mural_cue_rejection_count = 1, updated_at = 7, metadata_json = '{"k":1}'
                  WHERE id = ?`,
            )
            .run(sourceId);
        const before = database.prepare("SELECT * FROM memories WHERE id = ?").get(sourceId);

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 10 });

        expect(database.prepare("SELECT * FROM memories WHERE id = ?").get(sourceId)).toEqual({
            ...(before as Record<string, unknown>),
            project_path: "git:new",
        });
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

describe("offline merge safety", () => {
    test("rerunning a merge is a no-op including audit and epoch", () => {
        const database = makeDb();
        insertMemory(database, "dir:old", "same", "same");
        insertMemory(database, "git:new", "same", "same");
        mergeProjectIdentities(database, "dir:old", "git:new", { now: 10 });
        const before = database.serialize();
        expect(
            mergeProjectIdentities(database, "dir:old", "git:new", { now: 20 }).changedRows,
        ).toBe(0);
        expect(database.serialize()).toEqual(before);
    });

    test("different workspaces refuse before any mutation", () => {
        const database = makeDb();
        database.exec(`INSERT INTO workspaces(id,name,created_at,updated_at) VALUES (1,'one',1,1),(2,'two',1,1);
            INSERT INTO workspace_members VALUES (1,'dir:old','old','/same',1),(2,'git:new','new','/same',1)`);
        const before = database.serialize();
        expect(() => mergeProjectIdentities(database, "dir:old", "git:new")).toThrow("one");
        expect(database.serialize()).toEqual(before);
    });

    test("failure mid-transaction rolls back every table", () => {
        const database = makeDb();
        insertMemory(database, "dir:old", "old", "old");
        database.exec(
            `CREATE TRIGGER abort_merge BEFORE INSERT ON project_state BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
        );
        const before = database.serialize();
        expect(() => mergeProjectIdentities(database, "dir:old", "git:new")).toThrow(
            "injected failure",
        );
        expect(database.serialize()).toEqual(before);
    });
});

test("split fixture preserves notes, history, windows, queues, review memories and membership", () => {
    const database = makeDb();
    const source = insertMemory(database, "dir:old", "same", "same");
    const target = insertMemory(database, "git:new", "same", "same");
    const conflict = insertMemory(database, "dir:old", "different constraint", "different");
    database.exec(`
        INSERT INTO memory_verifications VALUES (${source},'src/file.ts',20,10,'mapper');
        INSERT INTO memory_embeddings VALUES (${conflict},X'01020304','model');
        INSERT INTO notes(type,status,content,project_path,created_at,updated_at) VALUES ('smart','ready','note','dir:old',1,1);
        INSERT INTO dream_queue(project_path,reason,enqueued_at) VALUES ('dir:old','scheduled',1),('git:new','scheduled',2);
        INSERT INTO dream_runs(project_path,started_at,finished_at,holder_id,tasks_json) VALUES ('dir:old',1,2,'holder','[]');
        INSERT INTO task_schedule_state(project_path,task,last_run_at,schedule,last_status,retrospective_watermark_ms) VALUES ('dir:old','retrospective',100,'0 * * * *','completed',500),('git:new','retrospective',50,'*/5 * * * *','completed',300);
        INSERT INTO retrospective_processed_windows VALUES ('dir:old','shared',20),('git:new','shared',10),('dir:old','unique',30);
        INSERT INTO workspaces VALUES (1,'shared',1,1,'[]');
        INSERT INTO workspace_members VALUES (1,'dir:old','old','/same',1),(1,'git:new','new','/same',1);
        INSERT INTO primers(project_path,question,created_at,updated_at) VALUES ('dir:old','question',1,1);
        INSERT INTO primer_candidates(project_path,session_id,question,normalized_question,source_message_time,created_at) VALUES ('dir:old','session','question','question',1,1);
        INSERT INTO project_key_files VALUES ('dir:old','file','content','hash',1,1,NULL,'config',NULL);
        INSERT INTO memory_embedding_watermarks VALUES ('dir:old',50,40,2),('git:new',30,20,1);
        INSERT INTO git_sweep_coordinator VALUES ('dir:old','stale-holder',1000,1);
        INSERT INTO embedding_identity_active VALUES ('dir:old','memory','model',1);
        INSERT INTO embedding_registrations(project_path) VALUES ('dir:old');
        INSERT INTO shadow_embedding_registrations(project_path,scope,model_id) VALUES ('dir:old','memory','model');
    `);
    const before = database.serialize();
    const preview = mergeProjectIdentities(database, "dir:old", "git:new", {
        dryRun: true,
        now: 1000,
    });
    expect(preview.duplicateMemoryIds).toEqual([source]);
    expect(preview.reviewMemoryIds).toEqual([conflict]);
    expect(database.serialize()).toEqual(before);
    mergeProjectIdentities(database, "dir:old", "git:new", { now: 1000 });
    expect(database.prepare("SELECT seen_count FROM memories WHERE id = ?").get(target)).toEqual({
        seen_count: 2,
    });
    expect(database.prepare("SELECT memory_id FROM memory_verifications").get()).toEqual({
        memory_id: target,
    });
    expect(database.prepare("SELECT memory_id FROM memory_embeddings").get()).toEqual({
        memory_id: conflict,
    });
    expect(
        database
            .prepare(
                "SELECT project_path, json_extract(metadata_json,'$.identity_merge_review') AS review FROM memories WHERE id = ?",
            )
            .get(conflict),
    ).toEqual({ project_path: "git:new", review: "dir:old" });
    expect(database.prepare("SELECT project_path,status FROM notes").get()).toEqual({
        project_path: "git:new",
        status: "ready",
    });
    expect(database.prepare("SELECT project_path FROM dream_runs").get()).toEqual({
        project_path: "git:new",
    });
    expect(
        database.prepare("SELECT project_path,reason,started_at FROM dream_queue").all(),
    ).toEqual([{ project_path: "git:new", reason: "scheduled", started_at: null }]);
    expect(
        database
            .prepare(
                "SELECT last_run_at,schedule,next_due_at,retrospective_watermark_ms FROM task_schedule_state",
            )
            .get(),
    ).toEqual({
        last_run_at: 100,
        schedule: "*/5 * * * *",
        next_due_at: 300000,
        retrospective_watermark_ms: 500,
    });
    expect(
        database
            .prepare(
                "SELECT window_key,processed_at FROM retrospective_processed_windows ORDER BY window_key",
            )
            .all(),
    ).toEqual([
        { window_key: "shared", processed_at: 20 },
        { window_key: "unique", processed_at: 30 },
    ]);
    expect(database.prepare("SELECT project_path FROM workspace_members").all()).toEqual([
        { project_path: "git:new" },
    ]);
    expect(
        database
            .prepare("SELECT written_memory_id,embedded_memory_id FROM memory_embedding_watermarks")
            .get(),
    ).toEqual({ written_memory_id: 50, embedded_memory_id: 40 });
    expect(
        database.prepare("SELECT lease_holder,last_swept_at FROM git_sweep_coordinator").get(),
    ).toEqual({ lease_holder: null, last_swept_at: null });
    expect(auditIdentityMerge(database, "dir:old", "git:new").changedRows).toBe(0);
    const after = database.serialize();
    expect(mergeProjectIdentities(database, "dir:old", "git:new").changedRows).toBe(0);
    expect(database.serialize()).toEqual(after);
});

test("a colliding hash with different content is retained for review, not superseded", () => {
    const database = makeDb();
    const source = insertMemory(database, "dir:old", "never delete this", "collision");
    const target = insertMemory(database, "git:new", "different content", "collision");
    const preview = mergeProjectIdentities(database, "dir:old", "git:new", { dryRun: true });
    expect(preview.duplicateMemoryIds).toEqual([]);
    expect(preview.reviewMemoryIds).toEqual([source]);
    mergeProjectIdentities(database, "dir:old", "git:new");
    expect(
        database
            .prepare("SELECT id, project_path, content, status FROM memories ORDER BY id")
            .all(),
    ).toEqual([
        { id: source, project_path: "git:new", content: "never delete this", status: "active" },
        { id: target, project_path: "git:new", content: "different content", status: "active" },
    ]);
    expect(
        database
            .prepare(
                "SELECT json_extract(metadata_json, '$.identity_merge_original_hash') AS original FROM memories WHERE id = ?",
            )
            .get(source),
    ).toEqual({ original: "collision" });
});
