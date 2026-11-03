/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { getMemoryById, insertMemory } from "../memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { archiveExpiredMemories } from "./expire-memories";
import { acquireLeaseWithAcquisition, releaseLease } from "./lease";
import type { DreamerModuleRoute } from "./module-apply";
import { createDreamTaskExecutor } from "./task-executor";
import { leaseKeyFor } from "./task-registry";
import { planDueTasks, runDueTasksForProject } from "./task-scheduler";

let db: Database | null = null;

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

describe("archiveExpiredMemories", () => {
    test("idle expiry ticks take no write lease when no project memory has expired", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        const project = "/repo/idle-expiry";
        insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: "A future rule.",
            expiresAt: Date.now() + 60_000,
        });
        insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: "A rule without a TTL.",
        });
        insertMemory(db, {
            projectPath: "/repo/another-project",
            category: "PROJECT_RULES",
            content: "An expired rule in another project.",
            expiresAt: Date.now() - 1,
        });
        const call = mock(async () => ({ result: { ok: true } }));
        const executor = createDreamTaskExecutor({
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            transformMode: "rust",
            moduleClient: { call },
        });
        // Initialize daily schedule housekeeping before observing an idle tick.
        planDueTasks(db, project, [], Date.now());
        const exec = spyOn(db, "exec");
        try {
            for (let tick = 0; tick < 2; tick++) {
                expect(
                    await runDueTasksForProject({
                        db,
                        projectIdentity: project,
                        tasks: [],
                        executor,
                    }),
                ).toBe(0);
            }
            expect(exec.mock.calls.filter(([sql]) => /\bBEGIN\s+IMMEDIATE\b/i.test(sql))).toEqual(
                [],
            );
            expect(call).not.toHaveBeenCalled();
        } finally {
            exec.mockRestore();
        }
    });

    test("scheduled expiry runs with curate and all model tasks disabled", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        const project = "/repo/disabled-curate-expiry";
        const expired = insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: "Expired rule.",
            expiresAt: Date.now() - 1,
        });
        const future = insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: "Future rule.",
            expiresAt: Date.now() + 60_000,
        });
        const call = mock(async () => {
            throw new Error("Expiry must not open a model child");
        });
        const executor = createDreamTaskExecutor({
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            hiddenCompletionExecutor: {
                capabilities: { tools: false, harness: "opencode2" },
                open: call,
                attempt: async () => {
                    throw new Error("Unexpected model attempt");
                },
                collect: async () => {
                    throw new Error("Unexpected model collection");
                },
                close: async () => {},
            },
        });
        const run = () =>
            runDueTasksForProject({
                db: db!,
                projectIdentity: project,
                tasks: [{ task: "curate", schedule: "", timeoutMinutes: 1 }],
                executor,
            });
        const leaseKey = leaseKeyFor("curate", project);
        const lease = acquireLeaseWithAcquisition(db, "other-worker", leaseKey);
        expect(lease).not.toBeNull();
        await run();
        expect(getMemoryById(db, expired.id)?.status).toBe("active");
        releaseLease(db, "other-worker", leaseKey);

        expect(await run()).toBe(0);
        expect(getMemoryById(db, expired.id)?.status).toBe("archived");
        expect(getMemoryById(db, future.id)?.status).toBe("active");
        expect(call).not.toHaveBeenCalled();
        await run();
        expect(call).not.toHaveBeenCalled();
        expect(db.prepare("SELECT COUNT(*) AS count FROM dream_runs").get()).toEqual({
            count: 0,
        });
        expect(db.prepare("SELECT COUNT(*) AS count FROM memory_mutation_log").get()).toEqual({
            count: 0,
        });
    });
    test("routes expiry using shared context ids without a mirror pull", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        const project = "/repo/module-expiry";
        const now = Date.now();
        const memory = insertMemory(db, {
            projectPath: project,
            category: "KNOWN_ISSUES",
            content: "A module-owned TTL memory.",
            expiresAt: now - 1,
        });
        const call = mock(async () => {
            db!
                .prepare("UPDATE memories SET status = 'archived', metadata_json = ? WHERE id = ?")
                .run(JSON.stringify({ archive_reason: "expired" }), memory.id);
            return { result: { ok: true } };
        });
        const moduleRoute: DreamerModuleRoute = {
            moduleClient: { call },
            moduleSessionId: project,
            moduleProjectRoot: project,
            moduleCommandId: "curate-expiry",
        };
        const holderId = "module-expiry-holder";
        const leaseKey = leaseKeyFor("curate", project);
        const leaseAcquisition = acquireLeaseWithAcquisition(db, holderId, leaseKey);
        expect(leaseAcquisition).not.toBeNull();

        const archived = await archiveExpiredMemories({
            db,
            projectIdentity: project,
            holderId,
            leaseKey,
            leaseAcquisition: leaseAcquisition!,
            now,
            moduleRoute,
        });

        expect(archived).toBe(1);
        expect(call).toHaveBeenCalledWith({
            sessionId: project,
            projectRoot: project,
            // The automated expiry facade, not the agent ctx_memory archive.
            method: "memory.expire",
            body: {
                name: "memory.expire",
                arguments: {
                    memory_project: project,
                    ids: [memory.id],
                    command_id: "curate-expiry:expire:0",
                },
            },
        });
        expect(
            db.prepare("SELECT status, metadata_json FROM memories WHERE id = ?").get(memory.id),
        ).toEqual({
            status: "archived",
            metadata_json: JSON.stringify({ archive_reason: "expired" }),
        });
        expect(db.prepare("SELECT COUNT(*) AS count FROM memory_mutation_log").get()).toEqual({
            count: 0,
        });
    });
});
