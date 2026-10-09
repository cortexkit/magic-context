/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import {
    getMemoriesByProject,
    getUnclassifiedMemoryIds,
    insertMemory,
    recordMemoryVerifications,
    setMemoryClassification,
} from "../memory";
import { indexSingleMessage } from "../message-index";
import { runMigrations } from "../migrations";
import { advanceSessionActivity } from "../session-activity";
import { recordSessionProjectIdentity } from "../session-project-storage";
import { initializeDatabase } from "../storage-db";
import {
    evaluateTaskGate,
    getDreamTaskBacklog,
    getDreamTaskBacklogs,
    identityHasProjectInput,
    SCHEDULE_ACTIVITY_WINDOW_MS,
    taskHasSchedulableInput,
} from "./task-gates";
import { formatDreamTaskBacklogs, processedDreamTaskItems } from "./task-registry";

let db: Database | null = null;

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    runMigrations(database);
    return database;
}

function indexedSession(
    database: Database,
    sessionId: string,
    harness: string,
    project: string,
    indexedAt: number,
): void {
    database
        .prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(sessionId, harness, project, 1);
    database
        .prepare(
            "INSERT INTO message_history_index (session_id, harness, last_indexed_ordinal, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(sessionId, harness, 1, indexedAt);
}

describe("dream task backlog probes", () => {
    test("an empty task registry returns without requiring memory tables", () => {
        db = new Database(":memory:");
        expect(getDreamTaskBacklogs(db, "empty", [])).toEqual({});
    });

    test("backlog memo distinguishes non-finite watermarks from null", () => {
        db = freshDb();
        db.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
        ).run("watermark-session", "opencode", "watermark-project", 1);
        for (const value of [Number.POSITIVE_INFINITY, Number.NaN, null]) {
            const options = { retrospectiveWatermarkMs: value };
            expect(
                getDreamTaskBacklogs(db, "watermark-project", ["retrospective"], options)
                    .retrospective,
            ).toEqual(getDreamTaskBacklog(db, "watermark-project", "retrospective", options));
        }
    });
    test("backlog memo observes own and external writes, isolates handles and does not retain caller mutations", () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "backlog-cache-"));
        const reader = new Database(join(dir, "copy.db"));
        initializeDatabase(reader);
        runMigrations(reader);
        const writer = new Database(join(dir, "copy.db"));
        const other = freshDb();
        const project = "git:backlog-cache";
        const read = (database: Database) =>
            getDreamTaskBacklogs(database, project, ["map-memories"]);
        const add = (database: Database, content: string) =>
            insertMemory(database, { projectPath: project, category: "ARCHITECTURE", content });
        try {
            add(reader, "first");
            const first = read(reader);
            expect(first["map-memories"]).toEqual({ pending: 1, total: 1 });
            if (first["map-memories"]) first["map-memories"].total = 999;
            expect(read(reader)["map-memories"]).toEqual({ pending: 1, total: 1 });
            add(reader, "second");
            expect(read(reader)["map-memories"]).toEqual({ pending: 2, total: 2 });
            add(writer, "third");
            expect(read(reader)["map-memories"]).toEqual({ pending: 3, total: 3 });
            expect(read(other)["map-memories"]).toEqual({ pending: 0, total: 0 });
        } finally {
            reader.close();
            writer.close();
            other.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("backlog memo bypasses expiring pools even when no database write occurs", () => {
        db = freshDb();
        const originalNow = Date.now;
        try {
            Date.now = () => 1000;
            insertMemory(db, {
                projectPath: "git:expiry-cache",
                category: "ARCHITECTURE",
                content: "expires",
                expiresAt: 2000,
            });
            expect(
                getDreamTaskBacklogs(db, "git:expiry-cache", ["map-memories"])["map-memories"],
            ).toEqual({ pending: 1, total: 1 });
            Date.now = () => 2000;
            expect(
                getDreamTaskBacklogs(db, "git:expiry-cache", ["map-memories"])["map-memories"],
            ).toEqual({ pending: 0, total: 0 });
        } finally {
            Date.now = originalNow;
        }
    });
    test("map and classify probes match seeded candidate counts", () => {
        db = freshDb();
        const projectIdentity = "/repo/project";
        const first = insertMemory(db, {
            projectPath: projectIdentity,
            category: "PROJECT_RULES",
            content: "Keep the first memory mapped.",
        });
        insertMemory(db, {
            projectPath: projectIdentity,
            category: "ARCHITECTURE",
            content: "The second memory still needs mapping and classification.",
        });
        recordMemoryVerifications(db, first.id, ["src/first.ts"], Date.now());

        expect(getDreamTaskBacklog(db, projectIdentity, "map-memories")).toEqual({
            pending: 1,
            total: 2,
        });
        expect(getDreamTaskBacklog(db, projectIdentity, "classify-memories")).toEqual({
            pending: 2,
            total: 2,
        });

        setMemoryClassification(db, first.id, { importance: 80 });
        expect(getDreamTaskBacklog(db, projectIdentity, "classify-memories")).toEqual({
            pending: 1,
            total: 2,
        });
    });

    test("uses the executor's live pool for reporter backlog counts", () => {
        db = freshDb();
        const projectIdentity = "/repo/expiry-backlog";
        const now = Date.now();

        const classifiedLive = insertMemory(db, {
            projectPath: projectIdentity,
            category: "ARCHITECTURE",
            content: "A classified live memory.",
        });
        setMemoryClassification(db, classifiedLive.id, { importance: 70 });
        for (let index = 0; index < 2; index += 1) {
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "PROJECT_RULES",
                content: `Unclassified live memory ${index}.`,
            });
        }
        const expiredActive = [];
        for (let index = 0; index < 3; index += 1) {
            expiredActive.push(
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "KNOWN_ISSUES",
                    content: `Expired active memory ${index}.`,
                    expiresAt: now - 1,
                }),
            );
        }
        recordMemoryVerifications(db, classifiedLive.id, ["src/live.ts"], 0);
        recordMemoryVerifications(db, expiredActive[0]!.id, ["src/expired.ts"], 0);

        const sidebarSqlCount = (
            db
                .prepare(
                    `SELECT COUNT(*) AS count FROM memories
                      WHERE project_path = ?
                        AND status IN ('active','permanent')
                        AND classified_at IS NULL`,
                )
                .get(projectIdentity) as { count: number }
        ).count;
        const liveIds = getMemoriesByProject(db, projectIdentity).map((memory) => memory.id);
        const executorCandidates = getUnclassifiedMemoryIds(db, liveIds);
        const expiredActiveCount = (
            db
                .prepare(
                    `SELECT COUNT(*) AS count FROM memories
                      WHERE project_path = ?
                        AND status = 'active'
                        AND expires_at IS NOT NULL
                        AND expires_at <= ?`,
                )
                .get(projectIdentity, now) as { count: number }
        ).count;

        expect(sidebarSqlCount).toBe(5);
        expect(expiredActiveCount).toBe(3);
        expect(executorCandidates).toHaveLength(2);
        expect(getDreamTaskBacklog(db, projectIdentity, "classify-memories")).toEqual({
            pending: executorCandidates.length,
            total: 3,
        });
        expect(getDreamTaskBacklog(db, projectIdentity, "map-memories")).toEqual({
            pending: 2,
            total: 3,
        });
        expect(getDreamTaskBacklog(db, projectIdentity, "verify")).toEqual({
            pending: 1,
            total: 1,
        });
        expect(getDreamTaskBacklog(db, projectIdentity, "verify-broad")).toEqual({
            pending: 1,
            total: 1,
        });
        const curateBacklog = getDreamTaskBacklog(db, projectIdentity, "curate");
        expect(curateBacklog).toEqual({
            pending: 2,
            total: 2,
            category: "PROJECT_RULES",
        });
        expect(formatDreamTaskBacklogs({ curate: curateBacklog }, ["curate"])).toBe(
            "- curate: PROJECT_RULES (2)",
        );
        expect(getDreamTaskBacklog(db, projectIdentity, "compress-cues")).toEqual({
            pending: 3,
            total: 3,
        });
    });

    test("verify probe counts only mapped memories that are still unverified", () => {
        db = freshDb();
        const projectIdentity = "/repo/project";
        const pending = insertMemory(db, {
            projectPath: projectIdentity,
            category: "PROJECT_RULES",
            content: "This mapped memory still needs verification.",
        });
        const verified = insertMemory(db, {
            projectPath: projectIdentity,
            category: "ARCHITECTURE",
            content: "This mapped memory has already been verified.",
        });
        recordMemoryVerifications(db, pending.id, ["src/pending.ts"], Date.now());
        recordMemoryVerifications(db, verified.id, ["src/verified.ts"], Date.now());
        db.prepare("UPDATE memory_verifications SET verified_at = ? WHERE memory_id = ?").run(
            0,
            pending.id,
        );

        expect(getDreamTaskBacklog(db, projectIdentity, "verify")).toEqual({
            pending: 1,
            total: 2,
        });
    });

    test("uses persisted task watermarks unless an explicit value is supplied", () => {
        db = freshDb();
        const project = "/repo/watermarks";
        db.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
        ).run("old", "opencode", project, 100);
        db.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
        ).run("new", "opencode", project, 300);
        db.prepare(
            "INSERT INTO task_schedule_state (project_path, task, retrospective_watermark_ms, last_run_at) VALUES (?, ?, ?, ?)",
        ).run(project, "retrospective", 200, null);
        advanceSessionActivity(db, "old", 100);
        advanceSessionActivity(db, "new", 300);
        expect(getDreamTaskBacklog(db, project, "retrospective").pending).toBe(1);
        expect(
            getDreamTaskBacklog(db, project, "retrospective", { retrospectiveWatermarkMs: null })
                .pending,
        ).toBe(2);
        expect(
            getDreamTaskBacklog(db, project, "retrospective", { retrospectiveWatermarkMs: 200 })
                .pending,
        ).toBe(1);
        db.prepare(
            "UPDATE task_schedule_state SET retrospective_watermark_ms = ? WHERE project_path = ? AND task = ?",
        ).run(300, project, "retrospective");
        expect(getDreamTaskBacklog(db, project, "retrospective").pending).toBe(0);

        db.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
        ).run("docs-session", "opencode", project, 500);
        db.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run("docs-session", 1, 0, 1, "old doc", "old", 100);
        db.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run("docs-session", 2, 2, 3, "new doc", "new", 300);
        db.prepare(
            "INSERT INTO task_schedule_state (project_path, task, last_run_at) VALUES (?, ?, ?)",
        ).run(project, "maintain-docs", 200);
        expect(getDreamTaskBacklog(db, project, "maintain-docs").pending).toBe(1);
        expect(getDreamTaskBacklog(db, project, "maintain-docs", { lastRunAt: null }).pending).toBe(
            2,
        );
    });

    test("SDK retrospective backlog uses indexed activity without a ledger", () => {
        db = freshDb();
        const project = "git:bridge-backlog";
        indexedSession(db, "old", "hermes", project, 100);
        indexedSession(db, "at-watermark", "hermes", project, 200);
        indexedSession(db, "fresh", "hermes", project, 300);
        indexedSession(db, "newest", "hermes", project, 400);
        indexedSession(db, "foreign", "hermes", "git:other", 500);
        // Binding changes without messages are not session activity.
        db.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
        ).run("unindexed", "hermes", project, 9999);
        db.prepare(
            "INSERT INTO task_schedule_state (project_path, task, retrospective_watermark_ms) VALUES (?, ?, ?)",
        ).run(project, "retrospective", 200);

        expect(getDreamTaskBacklog(db, project, "retrospective")).toEqual({ pending: 2, total: 2 });
        expect(getDreamTaskBacklogs(db, project, ["retrospective"]).retrospective).toEqual({
            pending: 2,
            total: 2,
        });
        // A bounded scan must leave the later session pending, rather than report zero.
        expect(
            getDreamTaskBacklog(db, project, "retrospective", {
                retrospectiveWatermarkMs: 300,
            }),
        ).toEqual({ pending: 1, total: 1 });
        expect(
            getDreamTaskBacklog(db, project, "retrospective", {
                retrospectiveWatermarkMs: 400,
            }),
        ).toEqual({ pending: 0, total: 0 });
    });

    test("Pi retrospective backlog keeps ledger precision with mixed indexed sessions", () => {
        db = freshDb();
        const project = "git:pi-backlog";
        indexedSession(db, "idle-pi", "pi", project, 9999);
        indexedSession(db, "active-pi", "pi", project, 100);
        indexedSession(db, "bridge", "hermes", project, 300);
        advanceSessionActivity(db, "idle-pi", 200);
        advanceSessionActivity(db, "active-pi", 300);

        expect(
            getDreamTaskBacklog(db, project, "retrospective", {
                retrospectiveWatermarkMs: 200,
            }),
        ).toEqual({ pending: 2, total: 2 });
        expect(
            getDreamTaskBacklog(db, project, "retrospective", {
                retrospectiveWatermarkMs: 300,
            }),
        ).toEqual({ pending: 0, total: 0 });
    });

    test("processed count is the start-to-end backlog reduction", () => {
        expect(processedDreamTaskItems(17, 5)).toBe(12);
        expect(processedDreamTaskItems(5, 7)).toBe(0);
    });
});

describe("evaluateTaskGate", () => {
    test("SDK retrospective scheduling retains old bindings with fresh indexed activity", () => {
        db = freshDb();
        const project = "git:bridge-schedule";
        const now = SCHEDULE_ACTIVITY_WINDOW_MS + 200;
        indexedSession(db, "bridge", "hermes", project, 200);
        expect(taskHasSchedulableInput("retrospective", db, project, now)).toBe(false);
        expect(identityHasProjectInput(db, project, now)).toBe(false);
        db.prepare("UPDATE message_history_index SET updated_at = 300 WHERE session_id = ?").run(
            "bridge",
        );
        expect(taskHasSchedulableInput("retrospective", db, project, now)).toBe(true);
        expect(identityHasProjectInput(db, project, now)).toBe(true);
    });

    test("SDK retrospective gate reopens on indexed turns without host events", () => {
        db = freshDb();
        const projectIdentity = "git:bridge-gate";
        const originalNow = Date.now;
        const context = {
            db,
            projectIdentity,
            lastRunAt: 9999,
            retrospectiveWatermarkMs: 200,
            promotionThreshold: 3,
        };
        try {
            Date.now = () => 100;
            recordSessionProjectIdentity(db, "bridge", projectIdentity);
            Date.now = () => 300;
            recordSessionProjectIdentity(db, "bridge", projectIdentity);
            indexSingleMessage(db, "bridge", {
                id: "first",
                ordinal: 1,
                role: "user",
                parts: [{ type: "text", text: "First turn" }],
                createdAt: 300,
            });
            expect(
                db
                    .prepare("SELECT updated_at FROM session_projects WHERE session_id = ?")
                    .get("bridge"),
            ).toEqual({ updated_at: 100 });
            expect(
                db
                    .prepare(
                        "SELECT 1 FROM schema_migrations_meta WHERE key LIKE 'retrospective_activity:%'",
                    )
                    .get(),
            ).toBeNull();
            expect(evaluateTaskGate("retrospective", context)).toBe(true);
            context.retrospectiveWatermarkMs = 300;
            expect(evaluateTaskGate("retrospective", context)).toBe(false);

            Date.now = () => 400;
            indexSingleMessage(db, "bridge", {
                id: "second",
                ordinal: 2,
                role: "user",
                parts: [{ type: "text", text: "Second turn" }],
                createdAt: 400,
            });
            expect(evaluateTaskGate("retrospective", context)).toBe(true);
        } finally {
            Date.now = originalNow;
        }
    });

    test("Pi retrospective gate prefers ledger timestamps over index maintenance", () => {
        db = freshDb();
        const projectIdentity = "git:pi-gate";
        indexedSession(db, "pi-session", "pi", projectIdentity, 9999);
        advanceSessionActivity(db, "pi-session", 200);
        const context = {
            db,
            projectIdentity,
            lastRunAt: 9999,
            retrospectiveWatermarkMs: 200,
            promotionThreshold: 3,
        };
        expect(evaluateTaskGate("retrospective", context)).toBe(false);
        advanceSessionActivity(db, "pi-session", 201);
        expect(evaluateTaskGate("retrospective", context)).toBe(true);
        context.retrospectiveWatermarkMs = 201;
        expect(evaluateTaskGate("retrospective", context)).toBe(false);
    });

    test("classify-memories runs when active memories exist", () => {
        db = freshDb();
        const projectIdentity = "/repo/project";
        expect(
            evaluateTaskGate("classify-memories", {
                db,
                projectIdentity,
                lastRunAt: null,
                promotionThreshold: 3,
            }),
        ).toBe(false);

        insertMemory(db, {
            projectPath: projectIdentity,
            category: "PROJECT_RULES",
            content: "Use Bun for package scripts in this repo.",
        });

        expect(
            evaluateTaskGate("classify-memories", {
                db,
                projectIdentity,
                lastRunAt: Date.now(),
                promotionThreshold: 3,
            }),
        ).toBe(true);
    });

    test("only curate opens the memory lease for an expired-only pool", () => {
        db = freshDb();
        const projectIdentity = "/repo/expired-only";
        insertMemory(db, {
            projectPath: projectIdentity,
            category: "KNOWN_ISSUES",
            content: "An expired legacy issue needs a lifecycle transition, not task work.",
            expiresAt: Date.now() - 1,
        });
        const context = {
            db,
            projectIdentity,
            lastRunAt: null,
            promotionThreshold: 3,
        };

        expect(getDreamTaskBacklog(db, projectIdentity, "classify-memories")).toEqual({
            pending: 0,
            total: 0,
        });
        expect(evaluateTaskGate("map-memories", context)).toBe(false);
        expect(evaluateTaskGate("verify", context)).toBe(false);
        expect(evaluateTaskGate("verify-broad", context)).toBe(false);
        expect(evaluateTaskGate("compress-cues", context)).toBe(false);
        expect(evaluateTaskGate("classify-memories", context)).toBe(false);
        expect(evaluateTaskGate("curate", context)).toBe(true);
    });

    test("retrospective gates on the CONTENT watermark, not lastRunAt", () => {
        db = freshDb();
        const projectIdentity = "/repo/project";
        db.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
        ).run("s1", "opencode", projectIdentity, 200);
        advanceSessionActivity(db, "s1", 200);

        // Never scanned → runs.
        expect(
            evaluateTaskGate("retrospective", {
                db,
                projectIdentity,
                lastRunAt: null,
                retrospectiveWatermarkMs: null,
                promotionThreshold: 3,
            }),
        ).toBe(true);
        // Message activity newer than watermark runs even if lastRunAt is newer.
        expect(
            evaluateTaskGate("retrospective", {
                db,
                projectIdentity,
                lastRunAt: 9999,
                retrospectiveWatermarkMs: 100,
                promotionThreshold: 3,
            }),
        ).toBe(true);
        // Watermark at/after the last message → nothing new → skip.
        expect(
            evaluateTaskGate("retrospective", {
                db,
                projectIdentity,
                lastRunAt: null,
                retrospectiveWatermarkMs: 300,
                promotionThreshold: 3,
            }),
        ).toBe(false);
    });
});
