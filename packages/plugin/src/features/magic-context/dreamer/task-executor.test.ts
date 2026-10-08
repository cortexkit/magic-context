/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createDreamTimerModuleClient } from "../../../plugin/dream-timer-module-client";
import * as logger from "../../../shared/logger";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { userFacingFailureCode } from "../../../shared/user-facing-codes";
import {
    ensureContextStoreUuid,
    installAuthorityManagedMarker,
} from "../legacy-authority-fixture.test-support";
import {
    getMemoriesByProject,
    getUnclassifiedMemoryIds,
    insertMemory,
    recordMemoryVerifications,
} from "../memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { ensureProjectState, getProjectState } from "../storage-project-state";
import { getUserMemoryCandidates } from "../user-memory/storage-user-memory";
import { recordCurateSafetyRefusal } from "./curate-memory-safety";
import { acquireLease, acquireLeaseWithAcquisition, releaseLease } from "./lease";
import { MAP_BATCH_FLOOR_MS } from "./map-memories";
import { recordedGeminiQuotaMessages } from "./provider-output-failure.test-support";
import { applyRetrospectiveLearnings } from "./retrospective-learnings";
import {
    PRIVACY_SENSITIVE_CHILD_TITLE_MATCHES,
    sweepOrphanedRetrospectiveChildren,
} from "./retrospective-orphan-sweep";
import { getDreamRuns } from "./storage-dream-runs";
import {
    getTaskScheduleState,
    seedTaskScheduleState,
    writeTaskScheduleState,
} from "./storage-task-schedule";
import { createDreamTaskExecutor } from "./task-executor";
import { type DreamTaskProgress, leaseKeyFor } from "./task-registry";
import {
    type DreamTaskRuntimeConfig,
    runDueTasksForProject,
    runManualDream,
} from "./task-scheduler";

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

function assistantMessages(text: string) {
    return [
        {
            info: { role: "assistant", time: { created: Date.now() } },
            parts: [{ type: "text", text }],
        },
    ];
}

function curateToolMessages(
    calls: Array<{
        action: string;
        status: "completed" | "pending" | "error";
        output?: string;
    }>,
    text?: string,
    finish = "stop",
) {
    return [
        {
            info: { role: "assistant", time: { created: Date.now() }, finish },
            parts: [
                ...calls.map((call, index) => ({
                    type: "tool",
                    callID: `curate-call-${index}`,
                    tool: "ctx_memory",
                    state: {
                        status: call.status,
                        input: { action: call.action },
                        ...(call.status === "completed"
                            ? {
                                  output:
                                      call.output ??
                                      (
                                          {
                                              merge: "Merged memories [1, 2]",
                                              archive: "Archived memory [ID: 1]",
                                              update: "Updated memory [ID: 1]",
                                          } as Record<string, string>
                                      )[call.action] ??
                                      "read memory",
                              }
                            : {}),
                        ...(call.status === "error" ? { error: "tool failed" } : {}),
                    },
                })),
                ...(text ? [{ type: "text", text }] : []),
            ],
        },
    ];
}

function providerFailureMessages(text: string) {
    return [
        {
            info: {
                role: "assistant",
                time: { created: Date.now() },
                finish: "stop",
                error: null,
                tokens: { output: 8, reasoning: 0 },
            },
            parts: [{ type: "text", text }],
        },
    ];
}

const CURATE_PSEUDO_TOOL_CALL = `归档与全局用户画像完全重复且无项目特化信息的记忆条目。[historical tool call]
id: call_2080315
name: ctx_memory
arguments:
{"action":"archive","reason":"与全局用户画像重复","ids":[6]}`;

describe("createDreamTaskExecutor — curate", () => {
    test("drives separate children for category snapshot chunks", async () => {
        db = freshDb();
        const project = "/repo/chunked-curate";
        for (let i = 0; i < 3; i++)
            insertMemory(db, {
                projectPath: project,
                category: "PROJECT_RULES",
                content: `Rule ${i}: ${"meaningful context ".repeat(170)}`,
            });
        const prompts: string[] = [];
        let children = 0;
        const client = {
            session: {
                list: mock(async () => ({
                    data: [
                        { id: "old-dream", title: "magic-context-dream-map-memories" },
                        { id: "other-child", title: "subagent", parentID: "ses-parent" },
                        { id: "ses-parent", title: "ordinary session" },
                    ],
                })),
                create: mock(async () => ({ data: { id: `child-${++children}` } })),
                prompt: mock(async (args: { body: { parts: Array<{ text: string }> } }) => {
                    prompts.push(args.body.parts[0].text);
                    return {};
                }),
                messages: mock(async () => ({
                    data: assistantMessages("No duplicates in this snapshot."),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            resolveRetrospectiveUsableInputTokens: () => 2000,
        });
        const result = await executor(
            { task: "curate", schedule: "0 4 * * 0", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-chunk",
                leaseKey: leaseKeyFor("curate", project),
            },
        );
        expect(result.status).toBe("completed");
        expect(children).toBe(3);
        expect(client.session.create).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.objectContaining({ parentID: "ses-parent" }),
            }),
        );
        expect(prompts).toHaveLength(3);
        expect(prompts.every((prompt) => (prompt.match(/Content: Rule/g) ?? []).length === 1)).toBe(
            true,
        );
    });
    test("archives an unsettled child through a detached final-part write, then the age gate sweeps it", async () => {
        db = freshDb();
        const project = "/repo/detached-writer";
        insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: "Keep internal child sessions until detached writers have drained.",
        });

        const opencodeDb = new Database(":memory:");
        opencodeDb.exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE session (
                id TEXT PRIMARY KEY,
                title TEXT,
                directory TEXT,
                time_created INTEGER
            );
            CREATE TABLE part (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES session(id)
            );
        `);
        let resolveWriter: (() => void) | undefined;
        const writerSettled = new Promise<void>((resolve) => {
            resolveWriter = resolve;
        });
        let writerError: unknown;
        const deleted: string[] = [];
        const archived: unknown[] = [];
        const logSpy = spyOn(logger, "log").mockImplementation(() => {});
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => {
                    opencodeDb
                        .prepare(
                            "INSERT INTO session (id, title, directory, time_created) VALUES (?, ?, ?, ?)",
                        )
                        .run("delayed-child", "magic-context-dream-curate", project, 1);
                    return { data: { id: "delayed-child" } };
                }),
                prompt: mock(async () => {
                    setTimeout(() => {
                        try {
                            opencodeDb
                                .prepare("INSERT INTO part (id, session_id) VALUES (?, ?)")
                                .run("final-part", "delayed-child");
                        } catch (error) {
                            writerError = error;
                        } finally {
                            resolveWriter?.();
                        }
                    }, 200);
                    throw new Error("prompt timed out after 1200000ms");
                }),
                abort: mock(async () => ({})),
                update: mock(async (input: unknown) => {
                    archived.push(input);
                    return {};
                }),
                messages: mock(async () => ({ data: assistantMessages("curation complete") })),
                delete: mock(async ({ path }: { path: { id: string } }) => {
                    deleted.push(path.id);
                    opencodeDb.prepare("DELETE FROM part WHERE session_id = ?").run(path.id);
                    opencodeDb.prepare("DELETE FROM session WHERE id = ?").run(path.id);
                    return {};
                }),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => opencodeDb,
        });

        try {
            const result = await executor(
                { task: "curate", schedule: "0 4 * * 0", timeoutMinutes: 20 },
                {
                    db,
                    projectIdentity: project,
                    holderId: "holder-delayed-writer",
                    leaseKey: leaseKeyFor("curate", project),
                },
            );
            await writerSettled;

            expect(result).toMatchObject({ status: "failed" });
            expect(writerError).toBeUndefined();
            expect(
                opencodeDb.prepare("SELECT id FROM part WHERE id = ?").get("final-part"),
            ).toEqual({ id: "final-part" });
            expect(deleted).toEqual([]);
            expect(archived).toEqual([
                {
                    path: { id: "delayed-child" },
                    query: { directory: project },
                    body: { time: { archived: expect.any(Number) } },
                },
            ]);
            expect(
                logSpy.mock.calls.some(
                    ([message]) =>
                        message ===
                        "[dreamer] curate: prompt unsettled — session delayed-child left to the age-gated sweep",
                ),
            ).toBe(true);

            const swept = await sweepOrphanedRetrospectiveChildren({
                opencodeDb,
                client: client as never,
                sessionDirectory: project,
                staleMs: 60_000,
                titleMatches: PRIVACY_SENSITIVE_CHILD_TITLE_MATCHES,
                now: 60_002,
            });
            expect(swept).toBe(1);
            expect(deleted).toEqual(["delayed-child"]);
        } finally {
            closeQuietly(opencodeDb);
        }
    });

    test("scopes curation to one category without verification data from another", async () => {
        db = freshDb();
        const project = "/repo/project";
        const architecture = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "First memory uses src/first.ts because it is load-bearing.",
        });
        const projectRule = insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: "Second memory is a project workflow rule.",
        });
        recordMemoryVerifications(db, architecture.id, ["src/first.ts"], Date.now());
        let capturedPrompt = "";
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                    capturedPrompt = args.body?.parts?.[0]?.text ?? "";
                    return {};
                }),
                messages: mock(async () => ({ data: assistantMessages("curation complete") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const config: DreamTaskRuntimeConfig = {
            task: "curate",
            schedule: "0 4 * * 0",
            timeoutMinutes: 20,
        };

        const result = await executor(config, {
            db,
            projectIdentity: project,
            holderId: "holder-curate",
            leaseKey: leaseKeyFor("curate", project),
        });

        expect(result.status).toBe("completed");
        expect(capturedPrompt).toContain("## Task: Curate Project Memory Pool (hygiene)");
        expect(capturedPrompt).toContain(
            "whole of the `PROJECT_RULES` category (the other categories run in later windows)",
        );
        expect(capturedPrompt).toContain(`[${projectRule.id}] PROJECT_RULES`);
        expect(capturedPrompt).not.toContain(`[${architecture.id}] ARCHITECTURE`);
        expect(capturedPrompt).not.toContain("Mapped files: src/first.ts");
        expect(capturedPrompt).toContain(
            "global user profile describes the operator and is never a substitute",
        );
        expect(capturedPrompt).not.toContain("### Global user profile");
        expect(capturedPrompt).not.toContain('ctx_memory(action="verified"');
        expect(capturedPrompt).not.toContain("verified_files");
    });

    test("rotates five successful runs in taxonomy order and keeps each prompt ID-scoped", async () => {
        db = freshDb();
        const project = "/repo/curate-rotation";
        const categories = [
            "PROJECT_RULES",
            "ARCHITECTURE",
            "CONSTRAINTS",
            "CONFIG_VALUES",
            "NAMING",
        ] as const;
        const expectedIds = new Map<string, number[]>();
        for (const category of categories) {
            const first = insertMemory(db, {
                projectPath: project,
                category,
                content: `${category} first scoped fixture.`,
            });
            const second = insertMemory(db, {
                projectPath: project,
                category,
                content: `${category} second scoped fixture.`,
            });
            expectedIds.set(category, [first.id, second.id]);
        }

        const prompts: string[] = [];
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: `rotation-${prompts.length}` } })),
                prompt: mock(async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                    prompts.push(args.body?.parts?.[0]?.text ?? "");
                    return {};
                }),
                messages: mock(async () => ({ data: assistantMessages("curation complete") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const config: DreamTaskRuntimeConfig = {
            task: "curate",
            schedule: "0 4 * * 0",
            timeoutMinutes: 20,
        };

        for (const category of categories) {
            const result = await runManualDream({
                db,
                projectIdentity: project,
                tasks: [config],
                executor,
                task: "curate",
            });
            expect(result.failed).toEqual([]);
            const prompt = prompts.at(-1) ?? "";
            const promptIds = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
            expect(prompt).toContain(`whole of the \`${category}\` category`);
            expect(promptIds.sort((left, right) => left - right)).toEqual(
                [...(expectedIds.get(category) ?? [])].sort((left, right) => left - right),
            );
        }
        expect(prompts).toHaveLength(5);
    });

    test("retries the failed category and skips an empty category in the same window", async () => {
        db = freshDb();
        const project = "/repo/curate-retry-skip";
        const architecture = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "Architecture remains the retry scope.",
        });
        const prompts: string[] = [];
        let attempts = 0;
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: `retry-${attempts}` } })),
                prompt: mock(async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                    prompts.push(args.body?.parts?.[0]?.text ?? "");
                    attempts += 1;
                    if (attempts === 1) throw new Error("provider request timed out");
                    return {};
                }),
                messages: mock(async () => ({ data: assistantMessages("curation complete") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const config: DreamTaskRuntimeConfig = {
            task: "curate",
            schedule: "0 4 * * 0",
            timeoutMinutes: 20,
        };

        const failed = await runManualDream({
            db,
            projectIdentity: project,
            tasks: [config],
            executor,
            task: "curate",
        });
        const retried = await runManualDream({
            db,
            projectIdentity: project,
            tasks: [config],
            executor,
            task: "curate",
        });

        expect(failed.failed).toEqual(["curate"]);
        expect(retried.ran).toEqual(["curate"]);
        expect(prompts).toHaveLength(2);
        for (const prompt of prompts) {
            expect(prompt).toContain("whole of the `ARCHITECTURE` category");
            expect([...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]))).toEqual([
                architecture.id,
            ]);
        }
    });

    test("archives expired active memories before curation without expiring permanent rows", async () => {
        db = freshDb();
        const project = "/repo/expired-curate";
        const now = Date.now();
        const expired = insertMemory(db, {
            projectPath: project,
            category: "KNOWN_ISSUES",
            content: "This legacy issue has reached its TTL.",
            expiresAt: now - 1,
        });
        const permanent = insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: "Permanent memories are never expired.",
            expiresAt: now - 1,
        });
        db.prepare("UPDATE memories SET status = 'permanent' WHERE id = ?").run(permanent.id);
        const create = mock(async () => ({ data: { id: "must-not-create" } }));
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create,
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });

        const result = await executor(
            { task: "curate", schedule: "0 4 * * 0", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-expired-curate",
                leaseKey: leaseKeyFor("curate", project),
            },
        );

        expect(result).toMatchObject({
            status: "completed",
            detail: "curate: archived 1 expired memory",
        });
        expect(create).not.toHaveBeenCalled();
        expect(
            db.prepare("SELECT status, metadata_json FROM memories WHERE id = ?").get(expired.id),
        ).toEqual({
            status: "archived",
            metadata_json: JSON.stringify({ archive_reason: "expired" }),
        });
        expect(db.prepare("SELECT status FROM memories WHERE id = ?").get(permanent.id)).toEqual({
            status: "permanent",
        });
        expect(
            db
                .prepare(
                    "SELECT mutation_type, target_memory_id FROM memory_mutation_log WHERE project_path = ?",
                )
                .all(project),
        ).toEqual([{ mutation_type: "archive", target_memory_id: expired.id }]);
        expect(
            JSON.parse(getDreamRuns(db, project)[0]?.memory_changes_json ?? "null"),
        ).toMatchObject({
            archived: 1,
            archivedIds: [expired.id],
        });
    });

    test("accepts tool-only curate output after completed ctx_memory operations", async () => {
        db = freshDb();
        const project = "/repo/curate-tool-only";
        insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: "Keep the memory pool concise.",
        });
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "dream-child-tool-only" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: curateToolMessages([
                        { action: "merge", status: "completed" },
                        { action: "archive", status: "completed" },
                        { action: "get", status: "completed" },
                        { action: "list", status: "completed" },
                        { action: "update", status: "completed", output: "Error: unsafe" },
                    ]),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });

        const result = await executor(
            { task: "curate", schedule: "0 4 * * 0", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-curate-tool-only",
                leaseKey: leaseKeyFor("curate", project),
            },
        );

        expect(result).toMatchObject({
            status: "completed",
            detail: expect.stringContaining("curate: 2 memory operations applied"),
        });
        const task = JSON.parse(getDreamRuns(db, project)[0]?.tasks_json ?? "[]")[0] as {
            progress?: string;
        };
        expect(task.progress).toContain("curate: 2 memory operations applied");
        expect(task.progress).toContain("merge");
        expect(task.progress).toContain("archive");
    });

    test("rejects curate output when its ctx_memory call never completed", async () => {
        db = freshDb();
        const project = "/repo/curate-pending-tool";
        insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: "Keep the memory pool concise.",
        });
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "dream-child-pending-tool" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: curateToolMessages(
                        [{ action: "archive", status: "pending" }],
                        undefined,
                        "aborted",
                    ),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });

        const result = await executor(
            { task: "curate", schedule: "0 4 * * 0", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-curate-pending-tool",
                leaseKey: leaseKeyFor("curate", project),
            },
        );

        expect(result.status).toBe("failed");
        expect(result.failureDetail).toContain("(MC-D03)");
        const task = JSON.parse(getDreamRuns(db, project)[0]?.tasks_json ?? "[]")[0] as {
            failure?: { failure_class?: string };
        };
        expect(task.failure?.failure_class).toBe("empty_completion");
    });

    test("reports host-side curate refusal progress without failing the task", async () => {
        db = freshDb();
        const project = "/repo/curate-refusal-progress";
        const memory = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "The registry owns startup ordering.",
        });
        const progress: DreamTaskProgress[] = [];
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "dream-child-refusal" } })),
                prompt: mock(async () => {
                    recordCurateSafetyRefusal("dream-child-refusal", {
                        memoryId: memory.id,
                        verdict: "archive",
                        reason: "missing-active-same-category-successor",
                    });
                    return {};
                }),
                messages: mock(async () => ({ data: assistantMessages("curation complete") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            onProgress: (update) => {
                if (update) progress.push(update);
            },
        });

        const result = await executor(
            { task: "curate", schedule: "0 4 * * 0", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-curate-refusal",
                leaseKey: leaseKeyFor("curate", project),
            },
        );

        expect(result).toMatchObject({
            status: "completed",
            detail: "curate: ARCHITECTURE (1); curate: refused 1 unsafe mutation(s)",
            backlog: { category: "ARCHITECTURE", pending: 1, total: 1 },
        });
        expect(progress).toContainEqual(
            expect.objectContaining({
                task: "curate",
                category: "ARCHITECTURE",
                total: 1,
                processed: 1,
                refused: 1,
            }),
        );
        const tasks = JSON.parse(getDreamRuns(db, project)[0]?.tasks_json ?? "[]") as Array<{
            progress?: string;
        }>;
        expect(tasks[0]?.progress).toBe(
            "curate: ARCHITECTURE (1); curate: refused 1 unsafe mutation(s)",
        );
    });

    test("rejects a textual pseudo-tool-call and retries with the fallback model", async () => {
        db = freshDb();
        const project = "/repo/curate-pseudo-tool-call";
        insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: "Use the shared release checklist before publishing.",
        });

        let promptCalls = 0;
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(async () => {
                    promptCalls += 1;
                    return {};
                }),
                messages: mock(async () => ({
                    data: curateToolMessages(
                        [{ action: "archive", status: "completed" }],
                        promptCalls === 1 ? CURATE_PSEUDO_TOOL_CALL : "curation complete",
                    ),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });

        const result = await executor(
            {
                task: "curate",
                schedule: "0 4 * * 0",
                timeoutMinutes: 20,
                fallbackModels: ["fallback/curator"],
            },
            {
                db,
                projectIdentity: project,
                holderId: "holder-curate-pseudo-tool-call",
                leaseKey: leaseKeyFor("curate", project),
            },
        );

        expect(promptCalls).toBe(2);
        expect(result).toMatchObject({
            status: "completed",
            detail: "curate: PROJECT_RULES (1); curate: 1 memory operation applied (archive)",
            backlog: { category: "PROJECT_RULES", pending: 1, total: 1 },
        });
    });

    test("adds the content language directive to curated prose tasks", async () => {
        db = freshDb();
        const project = "/repo/language-project";
        insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "The project stores prompts in src/prompts.ts.",
        });

        let capturedSystem = "";
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(async (args: { body?: { system?: string } }) => {
                    capturedSystem = args.body?.system ?? "";
                    return {};
                }),
                messages: mock(async () => ({ data: assistantMessages("curation complete") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            language: "tr",
        });

        await executor(
            { task: "curate", schedule: "0 4 * * 0", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-curate-language",
                leaseKey: leaseKeyFor("curate", project),
            },
        );

        expect(capturedSystem).toContain(
            "Write human-readable prose you author in: Turkish (Türkçe).",
        );
        expect(capturedSystem).toContain("Copy required output schemas exactly");
    });
});

describe("createDreamTaskExecutor — structured failure telemetry", () => {
    test("distinguishes provider errors, executor timeouts, and empty completions", async () => {
        db = freshDb();

        const drive = async (
            suffix: string,
            mode: "provider_error" | "provider_timeout" | "empty_completion",
        ) => {
            const project = `/repo/failure-${suffix}`;
            insertMemory(db as Database, {
                projectPath: project,
                category: "PROJECT_RULES",
                content: `Failure telemetry fixture ${suffix}.`,
            });
            const childId = `failure-child-${suffix}`;
            const client = {
                session: {
                    list: mock(async () => ({
                        data: [{ id: "ses-parent", title: "ordinary session" }],
                    })),
                    create: mock(async () => ({ data: { id: childId } })),
                    prompt: mock(async (args: { signal?: AbortSignal }) => {
                        if (mode === "provider_error") {
                            throw new Error(`HTTP 429 provider rate limit ${"x".repeat(600)}`);
                        }
                        if (mode === "provider_timeout") {
                            await new Promise<never>((_resolve, reject) => {
                                args.signal?.addEventListener("abort", () =>
                                    reject(new Error("provider request aborted")),
                                );
                            });
                        }
                        return {};
                    }),
                    messages: mock(async () => ({ data: [] })),
                    abort: mock(async () => ({})),
                    delete: mock(async () => ({})),
                },
            };
            const executor = createDreamTaskExecutor({
                client: client as never,
                sessionDirectory: project,
                openOpenCodeDb: () => null,
            });
            const result = await executor(
                {
                    task: "curate",
                    schedule: "0 4 * * 0",
                    model: "provider/primary",
                    timeoutMinutes: mode === "provider_timeout" ? 0.001 : 20,
                },
                {
                    db: db as Database,
                    projectIdentity: project,
                    holderId: `holder-${suffix}`,
                    leaseKey: leaseKeyFor("curate", project),
                },
            );
            const row = getDreamRuns(db as Database, project)[0];
            const task = JSON.parse(row?.tasks_json ?? "[]")[0] as {
                error?: string;
                failure?: {
                    failure_class: string;
                    model_attempted: string | null;
                    models_tried: string[];
                    provider_error: string | null;
                    timeout_ms: number | null;
                    child_session_id: string | null;
                };
            };
            return { result, task, childId };
        };

        const provider = await drive("provider", "provider_error");
        const timeout = await drive("timeout", "provider_timeout");
        const empty = await drive("empty", "empty_completion");

        expect([
            provider.task.failure?.failure_class,
            timeout.task.failure?.failure_class,
            empty.task.failure?.failure_class,
        ]).toEqual(["provider_error", "provider_timeout", "empty_completion"]);
        expect(
            new Set([
                provider.task.failure?.failure_class,
                timeout.task.failure?.failure_class,
                empty.task.failure?.failure_class,
            ]).size,
        ).toBe(3);
        expect(provider.task.failure).toMatchObject({
            model_attempted: "provider/primary",
            models_tried: ["provider/primary"],
            timeout_ms: null,
            child_session_id: provider.childId,
        });
        expect(
            provider.task.failure?.provider_error?.startsWith("HTTP 429 provider rate limit"),
        ).toBe(true);
        expect(provider.task.failure?.provider_error?.length).toBe(500);
        expect(timeout.task.failure).toMatchObject({
            failure_class: "provider_timeout",
            child_session_id: timeout.childId,
        });
        expect(timeout.task.failure?.timeout_ms).toBeGreaterThan(0);
        expect(timeout.task.failure?.timeout_ms).toBeLessThanOrEqual(60);
        expect(empty.task.failure).toMatchObject({
            failure_class: "empty_completion",
            provider_error: null,
            child_session_id: empty.childId,
        });
        expect(provider.result.failureDetail).toContain("(MC-D02)");
        expect(timeout.result.failureDetail).toContain("(MC-D01)");
        expect(empty.result.failureDetail).toContain("(MC-D03)");
        expect(empty.task.error).toContain("Dreamer returned no assistant output.");
    });
});

describe("createDreamTaskExecutor — verify-broad disposition", () => {
    test("persists the recorded Gemini quota exhaustion as a transient provider error", async () => {
        db = freshDb();
        const project = "git:recorded-gemini-quota";
        const memory = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "Mapped fact.",
        });
        recordMemoryVerifications(db, memory.id, ["src/fact.ts"], 1_000);
        const client = {
            session: {
                list: async () => ({ data: [{ id: "ses-parent", title: "ordinary session" }] }),
                create: async () => ({ data: { id: "quota-child" } }),
                prompt: async () => ({}),
                messages: async () => ({ data: recordedGeminiQuotaMessages() }),
                delete: async () => ({}),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const leaseKey = leaseKeyFor("verify", project);
        const holderId = "quota-holder";
        expect(acquireLease(db, holderId, leaseKey)).toBe(true);
        const outcome = await executor(
            {
                task: "verify",
                schedule: "0 3 * * *",
                timeoutMinutes: 20,
                model: "google/antigravity-gemini-3.8-flash",
            },
            { db, projectIdentity: project, holderId, leaseKey },
        );
        expect(outcome).toMatchObject({ status: "failed", transient: true });
        expect(outcome.error).toContain("primary quota exhausted until");
        expect(outcome.failureDetail).toContain("primary quota exhausted until");
        const task = JSON.parse(getDreamRuns(db, project)[0].tasks_json)[0];
        expect(task.failure.failure_class).toBe("provider_error");
        expect(task.failure.provider_error).toContain("primary quota exhausted until");
        expect(task.error).not.toContain("manifest missing");
    });
    test("keeps a textless assistant completion without a row error as empty_completion", async () => {
        db = freshDb();
        const project = "/repo/verify-plain-empty";
        const memory = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "Mapped fact with a plain empty completion.",
        });
        recordMemoryVerifications(db, memory.id, ["src/fact.ts"], 1_000);
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "verify-plain-empty" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: [
                        {
                            info: {
                                role: "assistant",
                                time: { created: 1 },
                                finish: "stop",
                                error: null,
                                tokens: { output: 0, reasoning: 0 },
                            },
                            parts: [],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const leaseKey = leaseKeyFor("verify", project);
        expect(acquireLease(db, "holder-plain-empty", leaseKey)).toBe(true);

        await executor(
            { task: "verify", schedule: "0 3 * * *", model: "synthetic/model", timeoutMinutes: 20 },
            { db, projectIdentity: project, holderId: "holder-plain-empty", leaseKey },
        );

        const task = JSON.parse(getDreamRuns(db, project)[0]?.tasks_json ?? "[]")[0] as {
            failure?: { failure_class: string; provider_error: string | null };
        };
        expect(task.failure).toMatchObject({
            failure_class: "empty_completion",
            provider_error: null,
        });
    });
    test("records a host-recorded provider refusal on an empty assistant row", async () => {
        db = freshDb();
        const project = "/repo/verify-host-refusal";
        seedTaskScheduleState(db, project, "verify", null, null, "0 3 * * *");
        const memory = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "Mapped fact refused by provider.",
        });
        recordMemoryVerifications(db, memory.id, ["src/fact.ts"], 1_000);
        const providerText =
            "UnknownError: custody accounts exhausted: provider=synthetic accounts=main:cooldown";
        const messages = [
            {
                info: {
                    role: "assistant",
                    time: { created: 1 },
                    finish: "stop",
                    error: null,
                    tokens: { output: 0, reasoning: 0 },
                },
                parts: [],
            },
            {
                info: { role: "assistant", time: { created: 2 }, error: providerText },
                parts: [],
            },
        ];
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "verify-host-refusal" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({ data: messages })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const now = Date.now();
        writeTaskScheduleState(db, {
            projectPath: project,
            task: "verify",
            lastRunAt: null,
            nextDueAt: now - 1_000,
            schedule: "0 3 * * *",
            lastStatus: null,
            lastError: null,
            retryCount: 0,
        });
        await runDueTasksForProject({
            db,
            projectIdentity: project,
            tasks: [
                {
                    task: "verify",
                    schedule: "0 3 * * *",
                    model: "synthetic/model",
                    timeoutMinutes: 20,
                },
            ],
            executor,
            now,
        });
        const scheduled = getTaskScheduleState(db, project, "verify");
        expect(scheduled?.retryCount).toBe(1);
        expect(scheduled?.lastRunAt).toBeNull();
        expect(scheduled?.nextDueAt).toBeLessThan(now);
        const run = getDreamRuns(db, project)[0];
        const task = JSON.parse(run?.tasks_json ?? "[]")[0] as {
            failure?: { failure_class: string; provider_error: string | null };
        };
        expect(task.failure?.failure_class).toBe("provider_error");
        expect(task.failure?.provider_error).toContain("custody accounts exhausted");
        expect(task.failure?.provider_error).toContain("provider=synthetic");
    });
    test("a verify batch timeout waits for the next scheduled run instead of hot-retrying", async () => {
        db = freshDb();
        const project = "/repo/verify-batch-timeout";
        seedTaskScheduleState(db, project, "verify", null, null, "0 3 * * *");
        const memory = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "Mapped fact whose batch times out.",
        });
        recordMemoryVerifications(db, memory.id, ["src/fact.ts"], 1_000);
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "verify-batch-timeout" } })),
                // Bun's fetch rejects this way when the host client's request timer fires.
                prompt: mock(async () => {
                    throw new DOMException("The operation timed out.", "TimeoutError");
                }),
                abort: mock(async () => ({})),
                messages: mock(async () => ({ data: [] })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const now = Date.now();
        writeTaskScheduleState(db, {
            projectPath: project,
            task: "verify",
            lastRunAt: null,
            nextDueAt: now - 1_000,
            schedule: "0 3 * * *",
            lastStatus: null,
            lastError: null,
            retryCount: 0,
        });
        await runDueTasksForProject({
            db,
            projectIdentity: project,
            tasks: [
                {
                    task: "verify",
                    schedule: "0 3 * * *",
                    model: "synthetic/model",
                    timeoutMinutes: 20,
                },
            ],
            executor,
            now,
        });
        const scheduled = getTaskScheduleState(db, project, "verify");
        // Retrying in fifteen minutes would split the deadline into the same
        // too-short batch slices, so the batch would time out again.
        expect(scheduled?.retryCount).toBe(0);
        expect(scheduled?.nextDueAt).toBeGreaterThan(now);
        expect(scheduled?.lastStatus).toBe("failed");
        expect(scheduled?.lastError).toContain("timed out");
        expect(client.session.abort).toHaveBeenCalledTimes(1);
    });
    test("records cycle progress as a completed run result instead of an error status", async () => {
        db = freshDb();
        const project = "/repo/verify-broad-result";
        seedTaskScheduleState(db, project, "verify-broad", null, null, "0 3 * * 0");
        const memories = [];
        for (let i = 0; i < 21; i += 1) {
            const memory = insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: `Mapped broad fact ${i}.`,
            });
            recordMemoryVerifications(db, memory.id, ["src/fact.ts"], 1_000);
            memories.push(memory.id);
        }

        let promptCalls = 0;
        let childCount = 0;
        const manifests = new Map<string, string>();
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: `verify-child-${++childCount}` } })),
                prompt: mock(
                    async (args: {
                        path?: { id?: string };
                        body?: { parts?: Array<{ text?: string }> };
                    }) => {
                        promptCalls += 1;
                        const prompt = args.body?.parts?.[0]?.text ?? "";
                        const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) =>
                            Number(match[1]),
                        );
                        manifests.set(
                            args.path?.id ?? "",
                            promptCalls > 1
                                ? "<verify>"
                                : `<verify>${ids.map((id) => `<verified id="${id}"/>`).join("")}</verify>`,
                        );
                        return {};
                    },
                ),
                messages: mock(async (args: { path?: { id?: string } }) => ({
                    data: assistantMessages(
                        manifests.get(args.path?.id ?? "") ?? "<verify></verify>",
                    ),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const leaseKey = leaseKeyFor("verify-broad", project);
        expect(acquireLease(db, "holder-broad-result", leaseKey)).toBe(true);

        const result = await executor(
            { task: "verify-broad", schedule: "0 3 * * 0", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-broad-result",
                leaseKey,
            },
        );

        expect(result.status).toBe("completed");
        expect(result.error).toBeUndefined();
        const state = getTaskScheduleState(db, project, "verify-broad");
        expect(state?.lastBroadRunAt).toBeGreaterThan(0);
        const run = getDreamRuns(db, project)[0];
        expect(run?.tasks_failed).toBe(0);
        const task = JSON.parse(run?.tasks_json ?? "[]")[0] as {
            error?: string;
            progress?: string;
            backlog?: { pendingAtStart: number; pendingAtEnd: number; processed: number };
        };
        expect(task.error).toBeUndefined();
        expect(task.progress).toContain("verify-broad cycle");
        expect(task.progress).toContain("remain");
        expect(task.backlog).toMatchObject({ pendingAtStart: 21, pendingAtEnd: 1, processed: 20 });
    });

    test("surfaces provider-outage completions as transient task failures", async () => {
        db = freshDb();
        const project = "/repo/verify-broad-provider-outage";
        seedTaskScheduleState(db, project, "verify-broad", null, null, "0 3 * * 0");
        const memory = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "Mapped fact blocked by a provider outage.",
        });
        recordMemoryVerifications(db, memory.id, ["src/fact.ts"], 1_000);
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "verify-provider-outage" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: providerFailureMessages("All Antigravity endpoints failed"),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const leaseKey = leaseKeyFor("verify-broad", project);
        expect(acquireLease(db, "holder-broad-provider-outage", leaseKey)).toBe(true);

        const result = await executor(
            { task: "verify-broad", schedule: "0 3 * * 0", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-broad-provider-outage",
                leaseKey,
            },
        );

        expect(result.status).toBe("failed");
        expect(result.transient).toBe(true);
        expect(result.error).toContain("provider-outage completion");
        expect(result.error).not.toContain("manifest missing");
        expect(getTaskScheduleState(db, project, "verify-broad")?.lastBroadRunAt).toBeGreaterThan(
            0,
        );
        const run = getDreamRuns(db, project)[0];
        expect(run?.tasks_failed).toBe(1);
        const task = JSON.parse(run?.tasks_json ?? "[]")[0] as { error?: string };
        expect(task.error).toContain("provider-outage completion");
    });

    test("keeps a zero-progress broad run failed", async () => {
        db = freshDb();
        const project = "/repo/verify-broad-zero";
        seedTaskScheduleState(db, project, "verify-broad", null, null, "0 3 * * 0");
        const memory = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "Mapped fact that cannot be verified yet.",
        });
        recordMemoryVerifications(db, memory.id, ["src/fact.ts"], 1_000);
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => {
                    throw new Error("provider unavailable");
                }),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const leaseKey = leaseKeyFor("verify-broad", project);
        expect(acquireLease(db, "holder-broad-zero", leaseKey)).toBe(true);

        const result = await executor(
            { task: "verify-broad", schedule: "0 3 * * 0", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-broad-zero",
                leaseKey,
            },
        );

        expect(result.status).toBe("failed");
        expect(result.transient).toBe(true);
        expect(getTaskScheduleState(db, project, "verify-broad")?.lastBroadRunAt).toBeGreaterThan(
            0,
        );
        expect(getDreamRuns(db, project)[0]?.tasks_failed).toBe(1);
    });
});

describe("createDreamTaskExecutor — parent session resolution", () => {
    test("finds an ordinary project root outside the checkout and behind recent children", async () => {
        db = freshDb();
        const project = "/repo/worktree";
        insertMemory(db, { projectPath: project, category: "ARCHITECTURE", content: "A fact." });
        const children = Array.from({ length: 100 }, (_, i) => ({
            id: `recent-child-${i}`,
            parentID: "ordinary-parent",
            title: "subagent",
            directory: project,
        }));
        const parent = {
            id: "ordinary-parent",
            title: "ordinary session",
            directory: "/repo/main",
        };
        const client = {
            session: {
                // Model the host's directory filter, root filter and default 100-row limit.
                list: mock(
                    async ({
                        query,
                    }: {
                        query: { scope?: string; roots?: boolean; limit?: number };
                    }) => ({
                        data:
                            query.scope === "project"
                                ? (query.roots ? [parent] : [...children, parent]).slice(
                                      0,
                                      query.limit ?? 100,
                                  )
                                : children,
                    }),
                ),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: assistantMessages("No duplicates in this snapshot."),
                })),
                delete: mock(async () => ({})),
            },
        };
        const leaseKey = leaseKeyFor("curate", project);
        expect(acquireLease(db, "holder", leaseKey)).toBe(true);
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const result = await executor(
            { task: "curate", schedule: "0 3 * * *", timeoutMinutes: 5 },
            { db, projectIdentity: project, holderId: "holder", leaseKey },
        );
        expect(result.status).toBe("completed");
        expect(client.session.create).toHaveBeenCalledWith({
            body: expect.objectContaining({ parentID: parent.id }),
            query: { directory: project },
        });
        expect(client.session.prompt).toHaveBeenCalledTimes(1);
        expect(
            db
                .prepare("SELECT parent_session_id FROM dream_runs WHERE project_path = ?")
                .get(project),
        ).toEqual({ parent_session_id: parent.id });
    });

    test("looks beyond a full page of leaked internal roots", async () => {
        db = freshDb();
        const project = "/repo/legacy-roots";
        insertMemory(db, { projectPath: project, category: "ARCHITECTURE", content: "A fact." });
        const roots = [
            ...Array.from({ length: 100 }, (_, i) => ({
                id: `leak-${i}`,
                title: "magic-context-dream-verify",
            })),
            { id: "ordinary-parent", title: "ordinary session" },
        ];
        const client = {
            session: {
                list: mock(async ({ query }: { query: { limit?: number } }) => ({
                    data: roots.slice(0, query.limit ?? 100),
                })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: assistantMessages("No duplicates in this snapshot."),
                })),
                delete: mock(async () => ({})),
            },
        };
        const leaseKey = leaseKeyFor("curate", project);
        expect(acquireLease(db, "holder", leaseKey)).toBe(true);
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const result = await executor(
            { task: "curate", schedule: "0 3 * * *", timeoutMinutes: 5 },
            { db, projectIdentity: project, holderId: "holder", leaseKey },
        );
        expect(result.status).toBe("completed");
        expect(client.session.list).toHaveBeenCalledTimes(2);
        expect(client.session.create).toHaveBeenCalledWith({
            body: expect.objectContaining({ parentID: "ordinary-parent" }),
            query: { directory: project },
        });
    });

    test("skips a parentless verify-broad task once without consuming retries or its backlog", async () => {
        db = freshDb();
        const project = "/repo/parentless";
        const memory = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "A mapped fact.",
        });
        recordMemoryVerifications(db, memory.id, ["src/fact.ts"], 1000);
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "old-dream", title: "magic-context-dream-verify" }],
                })),
                create: mock(async () => ({ data: { id: "must-not-create" } })),
                prompt: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const config: DreamTaskRuntimeConfig = {
            task: "verify-broad",
            schedule: "0 3 * * *",
            timeoutMinutes: 5,
        };
        const now = Date.now();
        seedTaskScheduleState(db, project, config.task, now - 1000, null, config.schedule);
        const lastRunBefore = getTaskScheduleState(db, project, config.task)!.lastRunAt;
        expect(
            await runDueTasksForProject({
                db,
                projectIdentity: project,
                tasks: [config],
                executor,
                now,
            }),
        ).toBe(1);
        const runs = getDreamRuns(db, project);
        expect(runs).toHaveLength(1);
        expect(runs[0]?.tasks_failed).toBe(0);
        expect(JSON.parse(runs[0]!.tasks_json)[0]).toMatchObject({
            status: "skipped",
            skipReason: "no ordinary parent session is available on this host",
            backlog: { processed: 0 },
        });
        const state = getTaskScheduleState(db, project, config.task)!;
        expect(state.lastStatus).toBe("skipped");
        expect(state.retryCount).toBe(0);
        expect(state.lastRunAt).toBe(lastRunBefore);
        expect(state.nextDueAt).toBeGreaterThan(now);
        expect(state.taskStateJson).toBeNull();
        expect(client.session.create).not.toHaveBeenCalled();
        expect(client.session.prompt).not.toHaveBeenCalled();
        expect(
            await runDueTasksForProject({
                db,
                projectIdentity: project,
                tasks: [config],
                executor,
                now,
            }),
        ).toBe(0);
    });

    test("discovers the first ordinary session after a skipped run", async () => {
        db = freshDb();
        const project = "/repo/new-parent";
        insertMemory(db, { projectPath: project, category: "ARCHITECTURE", content: "A fact." });
        let hasParent = false;
        const client = {
            session: {
                list: mock(async () => ({
                    data: hasParent ? [{ id: "new-parent", title: "ordinary session" }] : [],
                })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: assistantMessages("No duplicates in this snapshot."),
                })),
                delete: mock(async () => ({})),
            },
        };
        const leaseKey = leaseKeyFor("curate", project);
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const run = async () => {
            expect(acquireLease(db!, "holder", leaseKey)).toBe(true);
            try {
                return await executor(
                    { task: "curate", schedule: "0 3 * * *", timeoutMinutes: 5 },
                    { db: db!, projectIdentity: project, holderId: "holder", leaseKey },
                );
            } finally {
                releaseLease(db!, "holder", leaseKey);
            }
        };
        expect((await run()).status).toBe("skipped");
        hasParent = true;
        expect((await run()).status).toBe("completed");
        expect(client.session.list).toHaveBeenCalledTimes(2);
        expect(client.session.create).toHaveBeenCalledTimes(1);
    });

    test("does not require a parent for explicitly hidden process-local sessions", async () => {
        db = freshDb();
        const project = "/repo/process-local";
        insertMemory(db, { projectPath: project, category: "ARCHITECTURE", content: "A fact." });
        const client = {
            backgroundSessionsAreHidden: true,
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "process-local-child" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: assistantMessages("No duplicates in this snapshot."),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const outcome = await executor(
            { task: "curate", schedule: "0 3 * * *", timeoutMinutes: 5 },
            {
                db,
                projectIdentity: project,
                holderId: "holder",
                leaseKey: leaseKeyFor("curate", project),
            },
        );
        expect(outcome.status).toBe("completed");
        expect(client.session.list).not.toHaveBeenCalled();
        expect(client.session.create).toHaveBeenCalledWith({
            body: expect.not.objectContaining({ parentID: expect.any(String) }),
            query: { directory: project },
        });
    });

    test("concurrent tasks share parent resolution while docs without a git repo skip model invocation", async () => {
        db = freshDb();
        const project = "/repo/project";
        for (let i = 0; i < 3; i += 1) {
            insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: `Memory ${i} backed by src/file${i}.ts.`,
            });
        }

        // Delay session.list so the resolution await spans both concurrent calls
        // — the exact window the old flag-before-await memo leaked undefined into.
        let listCalls = 0;
        const createParentIds: Array<string | undefined> = [];
        const client = {
            session: {
                list: mock(async () => {
                    listCalls += 1;
                    await new Promise((r) => setTimeout(r, 20));
                    return { data: [{ id: "real-parent-session" }] };
                }),
                create: mock(async (args: { body?: { parentID?: string } }) => {
                    createParentIds.push(args.body?.parentID);
                    return { data: { id: `child-${createParentIds.length}` } };
                }),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({ data: assistantMessages("done") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });

        // Two DIFFERENT lease domains run concurrently (as the scheduler does via
        // Promise.all): curate (memory domain) + maintain-docs (its own domain).
        const curateKey = leaseKeyFor("curate", project);
        const docsKey = leaseKeyFor("maintain-docs", project);
        expect(acquireLease(db, "h-curate", curateKey)).toBe(true);
        expect(acquireLease(db, "h-docs", docsKey)).toBe(true);
        await Promise.all([
            executor(
                { task: "curate", schedule: "0 4 * * 0", timeoutMinutes: 20 },
                { db, projectIdentity: project, holderId: "h-curate", leaseKey: curateKey },
            ),
            executor(
                { task: "maintain-docs", schedule: "0 4 * * 0", timeoutMinutes: 20 },
                { db, projectIdentity: project, holderId: "h-docs", leaseKey: docsKey },
            ),
        ]);

        // Without a Git repository, maintain-docs skips its child session;
        // curation still receives the resolved parent session.
        expect(listCalls).toBe(1);
        expect(createParentIds.length).toBe(1);
        expect(createParentIds.every((id) => id === "real-parent-session")).toBe(true);
    });
});

describe("createDreamTaskExecutor — lease setup fence", () => {
    test("aborts after a pre-heartbeat TTL stall lets an interloper acquire and release", async () => {
        db = freshDb();
        const project = "/repo/lease-setup-stall";
        const leaseKey = leaseKeyFor("curate", project);
        const realNow = Date.now();
        const clock = { value: realNow };
        const nowSpy = spyOn(Date, "now").mockImplementation(() => clock.value);
        try {
            const acquisition = acquireLeaseWithAcquisition(db, "stalled-holder", leaseKey);
            expect(acquisition).not.toBeNull();
            const create = mock(async () => ({ data: { id: "must-not-create" } }));
            const client = {
                session: {
                    list: mock(async () => {
                        clock.value = realNow + 3 * 60 * 1_000;
                        expect(acquireLease(db as Database, "interloper", leaseKey)).toBe(true);
                        releaseLease(db as Database, "interloper", leaseKey);
                        return { data: [] };
                    }),
                    create,
                },
            };
            const executor = createDreamTaskExecutor({
                client: client as never,
                sessionDirectory: project,
                openOpenCodeDb: () => null,
            });

            let thrown: unknown;
            try {
                await executor(
                    { task: "curate", schedule: "0 4 * * 0", timeoutMinutes: 20 },
                    {
                        db,
                        projectIdentity: project,
                        holderId: "stalled-holder",
                        leaseKey,
                        leaseAcquisition: acquisition ?? undefined,
                    },
                );
            } catch (error) {
                thrown = error;
            }

            expect(String(thrown)).toContain("lease lost during executor setup");
            expect(create).not.toHaveBeenCalled();
        } finally {
            nowSpy.mockRestore();
        }
    });
});

describe("createDreamTaskExecutor — map-memories disposition", () => {
    test("records banked deadline progress as completed and advances lastRunAt", async () => {
        db = freshDb();
        const project = "/repo/map-banked-progress";
        for (let index = 0; index < 21; index += 1) {
            insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: `Scheduled mapping fact ${index}.`,
            });
        }
        const startedAt = Date.now();
        const nowSpy = spyOn(Date, "now").mockReturnValue(startedAt);
        try {
            let promptCalls = 0;
            let manifest = "";
            const client = {
                session: {
                    list: mock(async () => ({
                        data: [{ id: "ses-parent", title: "ordinary session" }],
                    })),
                    create: mock(async () => ({ data: { id: "map-child" } })),
                    prompt: mock(async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                        promptCalls += 1;
                        const prompt = args.body?.parts?.[0]?.text ?? "";
                        const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) =>
                            Number(match[1]),
                        );
                        manifest = `<mappings>${ids.map((id) => `<memory id="${id}" independent="true"/>`).join("")}</mappings>`;
                        return {};
                    }),
                    messages: mock(async () => ({ data: assistantMessages(manifest) })),
                    delete: mock(async () => {
                        // The first batch is already committed when its child is
                        // removed. Leave only one minute for the next loop turn.
                        nowSpy.mockReturnValue(startedAt + MAP_BATCH_FLOOR_MS - 60_000);
                        return {};
                    }),
                },
            };
            const task: DreamTaskRuntimeConfig = {
                task: "map-memories",
                schedule: "0 5 * * *",
                timeoutMinutes: 4,
            };
            writeTaskScheduleState(db, {
                projectPath: project,
                task: task.task,
                lastRunAt: 1_234,
                nextDueAt: startedAt - 1,
                schedule: task.schedule,
                lastStatus: "completed",
                lastError: null,
                retryCount: 0,
            });
            const executor = createDreamTaskExecutor({
                client: client as never,
                sessionDirectory: project,
                openOpenCodeDb: () => null,
            });

            await runDueTasksForProject({
                db,
                projectIdentity: project,
                tasks: [task],
                executor,
                now: startedAt,
            });

            expect(promptCalls).toBe(1);
            const scheduleState = getTaskScheduleState(db, project, task.task);
            // last_run_at records the START of the last successful run — the
            // "changed since" cutoff the scheduler's gates compare against — not
            // the completion moment. The banked deadline is therefore later than
            // the recorded value, and the recorded value is no earlier than the
            // run start (`now`, the clock the scheduler was invoked with).
            expect(scheduleState?.lastRunAt).toBeGreaterThanOrEqual(startedAt);
            expect(scheduleState?.lastRunAt).toBeLessThan(startedAt + MAP_BATCH_FLOOR_MS - 60_000);
            expect(scheduleState).toMatchObject({
                lastStatus: "completed",
                retryCount: 0,
            });
            const run = getDreamRuns(db, project)[0];
            expect(run?.tasks_succeeded).toBe(1);
            expect(run?.tasks_failed).toBe(0);
            const summary = JSON.parse(run?.tasks_json ?? "[]")[0] as {
                progress?: string;
                backlog?: { pendingAtStart: number; pendingAtEnd: number; processed: number };
            };
            expect(summary.progress).toContain(
                "committed 20 mapping(s) (mapped 0, independent 20); 1 remain",
            );
            expect(summary.backlog).toEqual({
                pendingAtStart: 21,
                totalAtStart: 21,
                pendingAtEnd: 1,
                totalAtEnd: 21,
                processed: 20,
            });
        } finally {
            nowSpy.mockRestore();
        }
    });

    test("surfaces the mapping timeout breaker as a starvation failure", async () => {
        db = freshDb();
        const project = "/repo/map-timeout-starvation";
        for (let index = 0; index < 241; index += 1) {
            insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: `Timeout-status mapping fact ${index}.`,
            });
        }
        let promptCalls = 0;
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "map-timeout-child" } })),
                prompt: mock(async () => {
                    promptCalls += 1;
                    throw new Error("prompt timed out after 99997ms");
                }),
                messages: mock(async () => ({ data: [] })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const leaseKey = leaseKeyFor("map-memories", project);
        expect(acquireLease(db, "holder-map-timeout", leaseKey)).toBe(true);

        const result = await executor(
            { task: "map-memories", schedule: "0 5 * * *", timeoutMinutes: 20 },
            { db, projectIdentity: project, holderId: "holder-map-timeout", leaseKey },
        );

        expect(promptCalls).toBe(2);
        expect(result).toMatchObject({ status: "failed", transient: true });
        expect(result.error).toContain("map-memories starvation");
        const run = getDreamRuns(db, project)[0];
        expect(run?.tasks_failed).toBe(1);
        expect(JSON.parse(run?.tasks_json ?? "[]")[0]?.error).toContain("starvation");
    });
});

describe("createDreamTaskExecutor — classify-memories", () => {
    test("module-managed memory on a TS host records a skipped migration refusal without a prompt", async () => {
        db = freshDb();
        const project = "git:ts-not-owner";
        for (let i = 0; i < 10; i++)
            insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: `Fact ${i}`,
            });
        installAuthorityManagedMarker(db, project);
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => {
                    throw new Error("must not prompt");
                }),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: process.cwd(),
            openOpenCodeDb: () => null,
            transformMode: "ts",
        });
        const leaseKey = leaseKeyFor("classify-memories", project);
        expect(acquireLease(db, "ts-holder", leaseKey)).toBe(true);
        const outcome = await executor(
            { task: "classify-memories", schedule: "0 6 * * *", timeoutMinutes: 20 },
            { db, projectIdentity: project, holderId: "ts-holder", leaseKey },
        );
        expect(outcome.status).toBe("skipped");
        expect(outcome.detail).toBe(
            "Magic Context's Rust mode needs a one-time migration of its store. Quit OpenCode and every ck-mc process, then run `magic-context doctor single-store migrate`. (MC-C14)",
        );
        expect(client.session.create).not.toHaveBeenCalled();
        expect(client.session.list).not.toHaveBeenCalled();
        expect(getDreamRuns(db, project)[0]?.tasks_succeeded).toBe(0);
        expect(JSON.parse(getDreamRuns(db, project)[0]!.tasks_json)[0].skipReason).toContain(
            "MC-C14",
        );
    });
    test("runs the non-agentic XML transform and applies the manifest host-side", async () => {
        db = freshDb();
        const project = "/repo/project";
        // Stage 2 needs >= 10 memories in the pool to classify at all.
        const ids: number[] = [];
        for (let i = 0; i < 12; i += 1) {
            const m = insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: `Memory ${i}: the transform lives in src/file${i}.ts.`,
            });
            if (m) ids.push(m.id);
        }

        let capturedPrompt = "";
        let capturedAgent = "";
        // The classifier emits ONE <classify> manifest; the host parses + applies.
        const manifest = `<classify>\n${ids
            .map(
                (id) =>
                    `<memory id="${id}" importance="${40 + (id % 30)}" scope="project" shareable="true"/>`,
            )
            .join("\n")}\n</classify>`;
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(
                    async (args: {
                        body?: { agent?: string; parts?: Array<{ text?: string }> };
                    }) => {
                        capturedPrompt = args.body?.parts?.[0]?.text ?? "";
                        capturedAgent = args.body?.agent ?? "";
                        return {};
                    },
                ),
                messages: mock(async () => ({ data: assistantMessages(manifest) })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });

        // classify applies the manifest host-side under a lease-guarded
        // transaction, so the holder must actually hold the lease.
        const leaseKey = leaseKeyFor("classify-memories", project);
        expect(acquireLease(db, "holder-classify", leaseKey)).toBe(true);

        const result = await executor(
            { task: "classify-memories", schedule: "0 6 * * *", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-classify",
                leaseKey,
            },
        );

        expect(result).toEqual({ status: "completed", schedulePatch: undefined });
        // Zero-tool pure transform agent + the new XML prompt (no ctx_memory call).
        expect(capturedAgent).toBe("dreamer-classifier");
        expect(capturedPrompt).toContain("## Task: Classify Project Memories");
        expect(capturedPrompt).toContain("Emit one <classify> manifest");
        expect(capturedPrompt).not.toContain('ctx_memory(action="classify"');

        // Host applied the manifest: every memory is now classified (classified_at
        // stamped → no longer unclassified) and importance moved off the default.
        const stillUnclassified = getUnclassifiedMemoryIds(db, ids);
        expect(stillUnclassified).toEqual([]);
    });

    test("provider-outage chunk aborts the run without advancing lastRunAt", async () => {
        db = freshDb();
        const project = "/repo/classify-provider-outage";
        const ids: number[] = [];
        for (let index = 0; index < 201; index += 1) {
            ids.push(
                insertMemory(db, {
                    projectPath: project,
                    category: "ARCHITECTURE",
                    content: `Provider outage classification fixture ${index}.`,
                }).id,
            );
        }
        let promptCalls = 0;
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "classify-provider-outage" } })),
                prompt: mock(async () => {
                    promptCalls += 1;
                    return {};
                }),
                messages: mock(async () => ({
                    data: providerFailureMessages("All Antigravity endpoints failed"),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const now = Date.now();
        const task: DreamTaskRuntimeConfig = {
            task: "classify-memories",
            schedule: "0 6 * * *",
            timeoutMinutes: 20,
            fallbackModels: ["provider/fallback-one", "provider/fallback-two"],
        };
        writeTaskScheduleState(db, {
            projectPath: project,
            task: task.task,
            lastRunAt: 1_234,
            nextDueAt: now - 1_000,
            schedule: task.schedule,
            lastStatus: "completed",
            lastError: null,
            retryCount: 0,
        });

        await runDueTasksForProject({
            db,
            projectIdentity: project,
            tasks: [task],
            executor,
            now,
        });

        expect(promptCalls).toBe(3);
        expect(getUnclassifiedMemoryIds(db, ids)).toHaveLength(201);
        expect(getTaskScheduleState(db, project, task.task)).toMatchObject({
            lastRunAt: 1_234,
            lastStatus: "failed",
            retryCount: 1,
        });
    });
    test("module failures are transient and never fall back to a TypeScript child", async () => {
        db = freshDb();
        const project = "/repo/rust-classify-failure";
        ensureContextStoreUuid(db);
        for (let i = 0; i < 12; i += 1) {
            const memory = insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: `Module classification failure fixture ${i}.`,
            });
            db.prepare(
                "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', ?, ?, ?)",
            ).run(project, 11000 + i, memory.id);
            db.prepare(
                "INSERT INTO mirror_live_memory_rows(module_project, module_row_id, category, normalized_hash) VALUES (?, ?, ?, ?)",
            ).run(project, 11000 + i, memory.category, memory.normalizedHash);
        }

        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "must-not-create" } })),
                delete: mock(async () => ({})),
            },
        };
        const moduleCalls: string[] = [];
        class FailingTimerModuleClient {
            private readonly instanceState = "timer-transport";

            async authorityStatus() {
                if (this.instanceState !== "timer-transport")
                    throw new Error("lost transport this");
                return { authority: { state: "MODULE", generation: 9 } };
            }

            async call(args: { method: string }) {
                if (this.instanceState !== "timer-transport")
                    throw new Error("lost transport this");
                moduleCalls.push(args.method);
                throw new Error("module transport unavailable");
            }
        }
        const moduleClient = createDreamTimerModuleClient(new FailingTimerModuleClient() as never);
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            moduleClient: moduleClient as never,
        });
        const leaseKey = leaseKeyFor("classify-memories", project);
        expect(acquireLease(db, "holder-rust-classify-failure", leaseKey)).toBe(true);

        const result = await executor(
            { task: "classify-memories", schedule: "0 6 * * *", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-rust-classify-failure",
                leaseKey,
            },
        );

        expect(result.status).toBe("failed");
        expect(result.transient).toBe(true);
        expect(result.error).toContain("Rust classify module failed");
        expect(client.session.create).not.toHaveBeenCalled();
        expect(moduleCalls).toEqual(["dreamer.run_task"]);
    });
});

describe("createDreamTaskExecutor — compress-cues", () => {
    test("reports a structural membership failure as transient", async () => {
        db = freshDb();
        const project = "/repo/malformed-cues";
        insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "A cue candidate omitted by the manifest.",
        });
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "cue-child" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({ data: assistantMessages("<cues></cues>") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            mural: { enabled: true },
        });
        const leaseKey = leaseKeyFor("compress-cues", project);
        expect(acquireLease(db, "holder-malformed-cues", leaseKey)).toBe(true);

        const result = await executor(
            { task: "compress-cues", schedule: "0 7 * * *", timeoutMinutes: 20 },
            { db, projectIdentity: project, holderId: "holder-malformed-cues", leaseKey },
        );

        expect(result.status).toBe("failed");
        expect(result.transient).toBe(true);
        expect(result.error).toContain("1 remain (was 1 at run start; processed 0 this run)");
        expect(client.session.prompt).toHaveBeenCalledTimes(1);
    });

    test("reports a fully drained cue set as completed", async () => {
        db = freshDb();
        const project = "/repo/complete-cues";
        const memory = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "A cue candidate completed by the manifest.",
        });
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "cue-child" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: assistantMessages(
                        `<cues><cue id="${memory.id}">completed anchor</cue></cues>`,
                    ),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            mural: { enabled: true },
        });
        const leaseKey = leaseKeyFor("compress-cues", project);
        expect(acquireLease(db, "holder-complete-cues", leaseKey)).toBe(true);

        const result = await executor(
            { task: "compress-cues", schedule: "0 7 * * *", timeoutMinutes: 20 },
            { db, projectIdentity: project, holderId: "holder-complete-cues", leaseKey },
        );

        expect(result).toEqual({ status: "completed" });
    });
});

describe("createDreamTaskExecutor — retrospective", () => {
    test("two size rejections persist recovery and make the third source window disjoint", async () => {
        db = freshDb();
        const project = "/repo/retrospective-overflow";
        const start = Date.now() - 10_000;
        const rows = Array.from({ length: 20 }, (_, index) => ({
            sessionId: "s1",
            ordinal: index + 1,
            role: "user" as const,
            text: `line-${index + 1} ${"diagnostic payload ".repeat(80)}`,
            ts: start + index * 10,
        }));
        db.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
        ).run("s1", "opencode", project, rows.at(-1)?.ts ?? start);
        const provider = {
            listProjectSessions: mock(() => [{ sessionId: "s1", updatedAt: rows.at(-1)?.ts }]),
            readUserMessagesSince: mock((_sessionId: string, sinceMs: number, cap: number) => {
                const eligible = rows.filter((row) => row.ts > sinceMs);
                return { messages: eligible.slice(0, cap), truncated: eligible.length > cap };
            }),
            readOldestMessageTimesSince: mock((_ids: readonly string[], sinceMs: number) => {
                const oldest = rows.find((row) => row.ts > sinceMs);
                return oldest ? new Map([["s1", oldest.ts]]) : new Map<string, number>();
            }),
            readUserMessagesBefore: mock(() => []),
        };
        const promptedWindows: string[][] = [];
        let promptAttempts = 0;
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: `retro-overflow-${promptAttempts}` } })),
                prompt: mock(async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                    promptedWindows.push(args.body?.parts?.[0]?.text?.match(/line-\d+/g) ?? []);
                    promptAttempts += 1;
                    if (promptAttempts <= 2) {
                        throw new Error(
                            "maximum context length is 2000 tokens; prompt exceeds the context window",
                        );
                    }
                    return {};
                }),
                messages: mock(async () => ({ data: assistantMessages("n") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            retrospectiveRawProvider: provider,
            resolveRetrospectiveUsableInputTokens: () => 2_000,
        });
        const task: DreamTaskRuntimeConfig = {
            task: "retrospective",
            schedule: "",
            timeoutMinutes: 20,
            retrospectiveRecencyDays: 30,
        };

        const first = await runManualDream({
            db,
            projectIdentity: project,
            tasks: [task],
            executor,
            task: "retrospective",
        });
        const afterFirst = getTaskScheduleState(db, project, "retrospective");
        expect(first.failed).toEqual(["retrospective"]);
        // lastRunAt and the content watermark do not move on the first rejected run:
        // neither field may claim source was processed. Only the smaller retry budget persists.
        expect(afterFirst?.lastRunAt).toBeNull();
        expect(afterFirst?.retrospectiveWatermarkMs).toBeNull();
        expect(afterFirst?.taskStateJson).toContain("retrospectiveOverflow");

        const second = await runManualDream({
            db,
            projectIdentity: project,
            tasks: [task],
            executor,
            task: "retrospective",
        });
        expect(second.failed).toEqual(["retrospective"]);
        expect(
            getTaskScheduleState(db, project, "retrospective")?.retrospectiveWatermarkMs,
        ).toBeGreaterThan(start);

        const third = await runManualDream({
            db,
            projectIdentity: project,
            tasks: [task],
            executor,
            task: "retrospective",
        });
        expect(third.ran).toEqual(["retrospective"]);
        const recordedTask = JSON.parse(getDreamRuns(db, project)[0]?.tasks_json ?? "[]")[0] as {
            backlog?: { pendingAtEnd: number };
        };
        expect(recordedTask.backlog?.pendingAtEnd).toBe(0);
        expect(promptedWindows).toHaveLength(3);
        expect(promptedWindows[1]?.length).toBeLessThan(promptedWindows[0]?.length ?? 0);
        expect(promptedWindows[2]?.filter((line) => promptedWindows[0]?.includes(line))).toEqual(
            [],
        );
    });

    test("retrospective memory insert leaves project memory epoch unchanged", () => {
        db = freshDb();
        const project = "/repo/project";
        ensureProjectState(db, project, 1);
        const epochBefore = getProjectState(db, project)?.projectMemoryEpoch;

        const applied = applyRetrospectiveLearnings({
            db,
            projectIdentity: project,
            sourceSessionId: "s1",
            learnings: [
                {
                    route: "memory",
                    category: "PROJECT_RULES",
                    content:
                        "Verify provider-executed tool availability before describing it as supported.",
                },
            ],
            userMemoryCollectionEnabled: false,
            sourceUserTexts: [],
        });

        expect(applied.memoryWritten).toBe(1);
        expect(getProjectState(db, project)?.projectMemoryEpoch).toBe(epochBefore);
    });

    test("gate returns 'n' → one settled gate turn deletes inline, advances the watermark, and does not deepen", async () => {
        db = freshDb();
        const project = "/repo/project";
        const provider = {
            listProjectSessions: mock(() => [{ sessionId: "s1" }]),
            readUserMessagesSince: mock(() => ({
                messages: [
                    {
                        sessionId: "s1",
                        ordinal: 1,
                        role: "user" as const,
                        text: "Please add a focused migration test for the new config key.",
                        ts: 200,
                    },
                ],
                truncated: false,
            })),
            readUserMessagesBefore: mock(() => []),
        };
        let prompts = 0;
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "retro-child" } })),
                prompt: mock(async () => {
                    prompts += 1;
                    return {};
                }),
                // Gate turn → verdict "n" (no friction). The deepen turn never runs.
                messages: mock(async () => ({ data: assistantMessages("n") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            retrospectiveRawProvider: provider,
            userMemoryCollectionEnabled: true,
        });

        const result = await executor(
            {
                task: "retrospective",
                schedule: "0 5 * * *",
                timeoutMinutes: 20,
                retrospectiveRecencyDays: 100_000,
            },
            {
                db,
                projectIdentity: project,
                holderId: "holder-retro-clean",
                leaseKey: leaseKeyFor("retrospective", project),
            },
        );

        // Completed with the content watermark advanced to the max ts scanned.
        expect(result).toEqual({
            status: "completed",
            schedulePatch: { retrospectiveWatermarkMs: 200 },
        });
        expect(client.session.create).toHaveBeenCalled();
        expect(prompts).toBe(1); // gate only — no deepen turn
        const { delete: deleteSession } = client.session;
        expect(deleteSession).toHaveBeenCalledWith({
            path: { id: "retro-child" },
            query: { directory: project },
        });
        expect(getMemoriesByProject(db, project)).toHaveLength(0);
    });

    test("signal deepens, parses XML, host-applies memory and gated observation", async () => {
        db = freshDb();
        const project = "/repo/project";
        const provider = {
            listProjectSessions: mock(() => [{ sessionId: "s1" }]),
            readUserMessagesSince: mock(() => ({
                messages: [
                    {
                        sessionId: "s1",
                        ordinal: 1,
                        role: "user" as const,
                        text: "Please verify provider-executed tools on the wire before saying they work.",
                        ts: 200,
                    },
                    {
                        sessionId: "s1",
                        ordinal: 2,
                        role: "assistant" as const,
                        text: "It should work.",
                        ts: 210,
                    },
                    {
                        sessionId: "s1",
                        ordinal: 3,
                        role: "user" as const,
                        text: "Please verify provider executed tools on wire before saying they work.",
                        ts: 220,
                    },
                ],
                truncated: false,
            })),
        };
        provider.readUserMessagesBefore = mock(() => []);
        // The two turns share one `messages` mock — drive the response off the
        // per-prompt system string the runner sets: gate system → "y: <ord>",
        // deepen system → the learnings XML.
        const captured: Array<{ agent: string; system: string; prompt: string }> = [];
        let lastSystem = "";
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "retro-child" } })),
                prompt: mock(
                    async (args: {
                        body?: {
                            agent?: string;
                            system?: string;
                            parts?: Array<{ text?: string }>;
                        };
                    }) => {
                        lastSystem = args.body?.system ?? "";
                        captured.push({
                            agent: args.body?.agent ?? "",
                            system: lastSystem,
                            prompt: args.body?.parts?.[0]?.text ?? "",
                        });
                        return {};
                    },
                ),
                messages: mock(async () => {
                    const isGate = lastSystem.includes("friction detector");
                    return {
                        data: assistantMessages(
                            isGate
                                ? "y: 3"
                                : `<learnings>
  <learning route="memory" category="PROJECT_RULES">Verify provider-executed tool availability on wire before describing it as supported.</learning>
  <learning route="observation">Prefers concise root-cause summaries before implementation details.</learning>
  <learning route="memory" category="PROJECT_RULES">On 2026-06-01 the user said &quot;wrong again&quot;.</learning>
</learnings>`,
                        ),
                    };
                }),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            retrospectiveRawProvider: provider,
            userMemoryCollectionEnabled: true,
        });

        const result = await executor(
            {
                task: "retrospective",
                schedule: "0 5 * * *",
                timeoutMinutes: 20,
                retrospectiveRecencyDays: 100_000,
            },
            {
                db,
                projectIdentity: project,
                holderId: "holder-retro-hit",
                leaseKey: leaseKeyFor("retrospective", project),
            },
        );

        expect(result).toEqual({
            status: "completed",
            schedulePatch: { retrospectiveWatermarkMs: 220 },
        });
        // Two turns: gate (friction-detector system) then deepen (learning system).
        expect(captured).toHaveLength(2);
        expect(captured[0]?.system).toContain("friction detector");
        expect(captured[1]?.agent).toBe("dreamer-retrospective");
        expect(captured[1]?.system).toContain("retrospective learning agent");
        expect(captured[1]?.prompt).toContain("### Friction window");
        expect(captured[1]?.prompt).not.toContain("ctx_memory");
        const memories = getMemoriesByProject(db, project);
        expect(memories.map((memory) => memory.content)).toEqual([
            "Verify provider-executed tool availability on wire before describing it as supported.",
        ]);
        expect(memories[0]?.sourceType).toBe("dreamer");
        expect(getUserMemoryCandidates(db).map((candidate) => candidate.content)).toEqual([
            "Prefers concise root-cause summaries before implementation details.",
        ]);
    });

    test("drops observation learnings when user-memory collection is disabled", async () => {
        db = freshDb();
        const project = "/repo/project";
        const provider = {
            listProjectSessions: mock(() => [{ sessionId: "s1" }]),
            readUserMessagesSince: mock(() => ({
                messages: [
                    {
                        sessionId: "s1",
                        ordinal: 1,
                        role: "user" as const,
                        text: "Please stop assuming CLI commands work without checking the actual output.",
                        ts: 200,
                    },
                    {
                        sessionId: "s1",
                        ordinal: 2,
                        role: "user" as const,
                        text: "Please stop assuming CLI commands work without checking actual output.",
                        ts: 220,
                    },
                ],
                truncated: false,
            })),
            readUserMessagesBefore: mock(() => []),
        };
        let lastSystem = "";
        const client = {
            session: {
                list: mock(async () => ({
                    data: [{ id: "ses-parent", title: "ordinary session" }],
                })),
                create: mock(async () => ({ data: { id: "retro-child" } })),
                prompt: mock(async (args: { body?: { system?: string } }) => {
                    lastSystem = args.body?.system ?? "";
                    return {};
                }),
                messages: mock(async () => ({
                    data: assistantMessages(
                        lastSystem.includes("friction detector")
                            ? "y: 2"
                            : `<learnings>
  <learning route="observation">Prefers tool claims backed by observed command output.</learning>
</learnings>`,
                    ),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            retrospectiveRawProvider: provider,
            userMemoryCollectionEnabled: false,
        });

        await executor(
            {
                task: "retrospective",
                schedule: "0 5 * * *",
                timeoutMinutes: 20,
                retrospectiveRecencyDays: 100_000,
            },
            {
                db,
                projectIdentity: project,
                holderId: "holder-retro-observation-off",
                leaseKey: leaseKeyFor("retrospective", project),
            },
        );

        expect(getUserMemoryCandidates(db)).toEqual([]);
    });
});

test("createDreamTaskExecutor surfaces host-refused verify counts", async () => {
    db = freshDb();
    const project = "/repo/verify-broad-directive-refusal";
    seedTaskScheduleState(db, project, "verify-broad", null, null, "0 3 * * 0");
    const memory = insertMemory(db, {
        projectPath: project,
        category: "PROJECT_RULES",
        content: "Always inspect src/fact.ts first and brief workers with the result.",
    });
    recordMemoryVerifications(db, memory.id, ["src/fact.ts"], 1_000);
    const client = {
        session: {
            list: mock(async () => ({ data: [{ id: "ses-parent", title: "ordinary session" }] })),
            create: mock(async () => ({ data: { id: "verify-refusal-child" } })),
            prompt: mock(async () => ({})),
            messages: mock(async () => ({
                data: assistantMessages(
                    `<verify><archive id="${memory.id}" reason="file omits the rule"/></verify>`,
                ),
            })),
            delete: mock(async () => ({})),
        },
    };
    const progress: (DreamTaskProgress | null)[] = [];
    const executor = createDreamTaskExecutor({
        client: client as never,
        sessionDirectory: project,
        openOpenCodeDb: () => null,
        onProgress: (current) => progress.push(current),
    });
    const leaseKey = leaseKeyFor("verify-broad", project);
    expect(acquireLease(db, "holder-broad-refusal", leaseKey)).toBe(true);

    const result = await executor(
        { task: "verify-broad", schedule: "0 3 * * 0", timeoutMinutes: 20 },
        {
            db,
            projectIdentity: project,
            holderId: "holder-broad-refusal",
            leaseKey,
        },
    );

    expect(result.status).toBe("completed");
    const live = progress.find((current) => current?.refused === 1);
    expect(live).toMatchObject({ task: "verify-broad", processed: 1, refused: 1 });
    const task = JSON.parse(getDreamRuns(db, project)[0]?.tasks_json ?? "[]")[0] as {
        progress?: string;
    };
    expect(task.progress).toContain("refused 1");
});

for (const task of ["curate", "map-memories", "verify", "verify-broad"] as const) {
    test(`tools:false refuses ${task} before dispatch and records a failed dream run`, async () => {
        db = freshDb();
        const project = `/repo/hidden-${task}`;
        const open = mock(async () => {
            throw new Error("unexpected hidden dispatch");
        });
        const executor = createDreamTaskExecutor({
            sessionDirectory: project,
            parentSessionId: "existing-user-session",
            openOpenCodeDb: () => null,
            hiddenCompletionExecutor: {
                capabilities: { tools: false, harness: "opencode2" },
                open,
                async attempt() {
                    throw new Error("unexpected prompt");
                },
                async collect() {
                    throw new Error("unexpected read");
                },
                async close() {},
            },
        });
        const result = await executor(
            { task, schedule: "0 4 * * 0", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: `holder-${task}`,
                leaseKey: leaseKeyFor(task, project),
            },
        );
        expect(result).toMatchObject({ status: "failed", transient: false });
        expect(open).toHaveBeenCalledTimes(0);
        const rows = getDreamRuns(db, project);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.tasks_failed).toBe(1);
        expect(rows[0]!.tasks_succeeded).toBe(0);
        // The recorded refusal must name the task and carry the stable code, so a
        // reader of dreamer history can tell WHICH task this host cannot run and
        // why, rather than finding one anonymous capability error.
        const recorded = JSON.stringify(rows[0]);
        expect(recorded).toContain(task);
        expect(recorded).toContain("unavailable on this host");
        expect(recorded).toContain(userFacingFailureCode("dream_task_needs_tool_loop"));
    });
}

/**
 * OpenCode 2's schedule timer has no triggering session, so it hands the
 * executor a lookup for one. A hidden child created without a parent would be
 * a separate top-level session in the user's list, so when the lookup finds
 * nothing the task is skipped, not run parentless and not failed.
 */
describe("carrier host with a parent lookup (OpenCode 2 schedule timer)", () => {
    function carrier(open: ReturnType<typeof mock>) {
        return {
            capabilities: { tools: true, harness: "opencode2" as const },
            open,
            async attempt(): Promise<never> {
                throw new Error("unexpected prompt");
            },
            async collect(): Promise<never> {
                throw new Error("unexpected read");
            },
            async close() {},
        };
    }

    test("skips a task that needs a child session when no parent is found, without a strike", async () => {
        db = freshDb();
        const project = "/repo/v2-timer-parentless";
        const memory = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "A mapped fact.",
        });
        recordMemoryVerifications(db, memory.id, ["src/fact.ts"], 1000);
        const open = mock(async () => {
            throw new Error("must not open a parentless hidden child");
        });
        const findParentSessionId = mock(() => undefined);
        const executor = createDreamTaskExecutor({
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            hiddenCompletionExecutor: carrier(open) as never,
            findParentSessionId,
        });
        const config: DreamTaskRuntimeConfig = {
            task: "verify-broad",
            schedule: "0 3 * * *",
            timeoutMinutes: 5,
        };
        const now = Date.now();
        seedTaskScheduleState(db, project, config.task, now - 1000, null, config.schedule);
        expect(
            await runDueTasksForProject({
                db,
                projectIdentity: project,
                tasks: [config],
                executor,
                now,
            }),
        ).toBe(1);
        expect(findParentSessionId).toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        const runs = getDreamRuns(db, project);
        expect(runs).toHaveLength(1);
        expect(runs[0]?.tasks_failed).toBe(0);
        expect(
            db
                .prepare("SELECT parent_session_id FROM dream_runs WHERE project_path = ?")
                .get(project),
        ).toEqual({ parent_session_id: null });
        expect(JSON.parse(runs[0]!.tasks_json)[0]).toMatchObject({
            status: "skipped",
            skipReason:
                "no session in this directory to hold the run's child session; it runs once one exists",
        });
        const state = getTaskScheduleState(db, project, config.task)!;
        expect(state.lastStatus).toBe("skipped");
        expect(state.retryCount).toBe(0);
        expect(state.nextDueAt).toBeGreaterThan(now);
    });

    test("hands the found parent to the carrier and records it on the run", async () => {
        db = freshDb();
        const project = "/repo/v2-timer-parented";
        insertMemory(db, { projectPath: project, category: "ARCHITECTURE", content: "A fact." });
        const open = mock(async (_identity: { parentSessionId?: string }) => {
            throw new Error("stop after open");
        });
        const executor = createDreamTaskExecutor({
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            hiddenCompletionExecutor: carrier(open) as never,
            findParentSessionId: async () => "ses-v2-parent",
        });
        const leaseKey = leaseKeyFor("curate", project);
        expect(acquireLease(db, "holder", leaseKey)).toBe(true);
        await executor(
            { task: "curate", schedule: "0 3 * * *", timeoutMinutes: 5 },
            { db, projectIdentity: project, holderId: "holder", leaseKey },
        );
        expect(open).toHaveBeenCalled();
        expect(open.mock.calls[0]?.[0]).toMatchObject({ parentSessionId: "ses-v2-parent" });
        expect(
            db
                .prepare("SELECT parent_session_id FROM dream_runs WHERE project_path = ?")
                .get(project),
        ).toEqual({ parent_session_id: "ses-v2-parent" });
    });

    test("still runs a task that needs no child session when no parent is found", async () => {
        db = freshDb();
        const project = "/repo/v2-timer-host-only";
        const open = mock(async () => {
            throw new Error("must not open a hidden child");
        });
        const executor = createDreamTaskExecutor({
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            hiddenCompletionExecutor: carrier(open) as never,
            findParentSessionId: () => undefined,
        });
        const leaseKey = leaseKeyFor("promote-primers", project);
        expect(acquireLease(db, "holder", leaseKey)).toBe(true);
        const result = await executor(
            { task: "promote-primers", schedule: "0 3 * * *", timeoutMinutes: 5 },
            { db, projectIdentity: project, holderId: "holder", leaseKey },
        );
        expect(result.status).not.toBe("failed");
        expect(open).not.toHaveBeenCalled();
        const task = JSON.parse(getDreamRuns(db, project)[0]?.tasks_json ?? "[]")[0] as {
            skipReason?: string;
        };
        expect(task.skipReason ?? "").not.toContain("no session in this directory");
    });
});
