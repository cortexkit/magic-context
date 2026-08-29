/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createDreamTimerModuleClient } from "../../../plugin/dream-timer-module-client";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { applyMirrorPage, ensureContextStoreUuid } from "../context-authority";
import {
    getMemoriesByProject,
    getUnclassifiedMemoryIds,
    insertMemory,
    recordMemoryVerifications,
} from "../memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { ensureProjectState, getProjectState } from "../storage-project-state";
import { getUserMemoryCandidates, insertUserMemory } from "../user-memory/storage-user-memory";
import { acquireLease, acquireLeaseWithAcquisition, releaseLease } from "./lease";
import { MAP_BATCH_FLOOR_MS } from "./map-memories";
import { applyRetrospectiveLearnings } from "./retrospective-learnings";
import { getDreamRuns } from "./storage-dream-runs";
import {
    getTaskScheduleState,
    seedTaskScheduleState,
    writeTaskScheduleState,
} from "./storage-task-schedule";
import { createDreamTaskExecutor } from "./task-executor";
import { type DreamTaskProgress, leaseKeyFor } from "./task-registry";
import { type DreamTaskRuntimeConfig, runDueTasksForProject } from "./task-scheduler";

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
    test("runs whole-pool curation without verification gate or watermark patch", async () => {
        db = freshDb();
        const project = "/repo/project";
        const first = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "First memory uses src/first.ts because it is load-bearing.",
        });
        const second = insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: "Second memory is a project workflow rule.",
        });
        recordMemoryVerifications(db, first.id, ["src/first.ts"], Date.now());
        insertUserMemory(db, "Prefer concise answers globally.", []);

        let capturedPrompt = "";
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
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

        expect(result).toEqual({ status: "completed", schedulePatch: undefined });
        expect(capturedPrompt).toContain("## Task: Curate Project Memory Pool (hygiene)");
        expect(capturedPrompt).toContain(first.content);
        expect(capturedPrompt).toContain(second.content);
        expect(capturedPrompt).toContain("Mapped files: src/first.ts");
        expect(capturedPrompt).toContain("### Global user profile (for the redundancy check)");
        expect(capturedPrompt).toContain("Prefer concise answers globally.");
        expect(capturedPrompt).not.toContain('ctx_memory(action="verified"');
        expect(capturedPrompt).not.toContain("verified_files");
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
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(async () => {
                    promptCalls += 1;
                    return {};
                }),
                messages: mock(async () => ({
                    data: assistantMessages(
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
        expect(result).toEqual({ status: "completed", schedulePatch: undefined });
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
                list: mock(async () => ({ data: [] })),
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

describe("createDreamTaskExecutor — verify-broad disposition", () => {
    test("records cycle progress as a completed run result instead of an error status", async () => {
        db = freshDb();
        const project = "/repo/verify-broad-result";
        seedTaskScheduleState(db, project, "verify-broad", null, null, "0 3 * * 0");
        const memories = [];
        for (let i = 0; i < 51; i += 1) {
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
                list: mock(async () => ({ data: [] })),
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
        expect(task.backlog).toMatchObject({ pendingAtStart: 51, pendingAtEnd: 1, processed: 50 });
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
                list: mock(async () => ({ data: [] })),
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
                list: mock(async () => ({ data: [] })),
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
    test("concurrent task runs all create children under the resolved parentID (no race-NULL)", async () => {
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

        // The list runs once (shared promise), and BOTH children carry the real
        // parent — none created with an undefined parentID.
        expect(listCalls).toBe(1);
        expect(createParentIds.length).toBe(2);
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
        for (let index = 0; index < 81; index += 1) {
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
                    list: mock(async () => ({ data: [] })),
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
            expect(getTaskScheduleState(db, project, task.task)).toMatchObject({
                lastRunAt: startedAt + MAP_BATCH_FLOOR_MS - 60_000,
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
                "committed 80 mapping(s) (mapped 0, independent 80); 1 remain",
            );
            expect(summary.backlog).toEqual({
                pendingAtStart: 81,
                totalAtStart: 81,
                pendingAtEnd: 1,
                totalAtEnd: 81,
                processed: 80,
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
                list: mock(async () => ({ data: [] })),
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
                list: mock(async () => ({ data: [] })),
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
                list: mock(async () => ({ data: [] })),
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

    test("direct authority.status selects rust MODULE without a prior transform", async () => {
        db = freshDb();
        const project = "/repo/rust-classify";
        ensureContextStoreUuid(db);
        const sensitive = insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: "Use token sk-test-secret only on my localhost machine.",
        });
        const contextMemories = [sensitive];
        for (let i = 0; i < 11; i += 1) {
            contextMemories.push(
                insertMemory(db, {
                    projectPath: project,
                    category: "ARCHITECTURE",
                    content: `The cache-neutral classification path is module-owned (${i}).`,
                }),
            );
        }
        for (const [index, memory] of contextMemories.entries()) {
            db.prepare(
                "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', ?, ?, ?)",
            ).run(project, 10000 + index, memory.id);
            db.prepare(
                "INSERT INTO mirror_live_memory_rows(module_project, module_row_id, category, normalized_hash) VALUES (?, ?, ?, ?)",
            ).run(project, 10000 + index, memory.category, memory.normalizedHash);
        }
        const moduleCalls: Array<{ method: string; body: unknown }> = [];
        let authorityStatusCalls = 0;
        const client = {
            session: {
                list: mock(async () => ({ data: [{ id: "parent" }] })),
                create: mock(async () => ({ data: { id: "must-not-create" } })),
                delete: mock(async () => ({})),
            },
        };
        // This must be a class-backed fake: object-literal mocks cannot expose a detached-method
        // regression because they do not need instance state through the timer adapter.
        class StatefulTimerModuleClient {
            private readonly instanceState = "timer-transport";

            async authorityStatus() {
                authorityStatusCalls += 1;
                if (this.instanceState !== "timer-transport")
                    throw new Error("lost transport this");
                return { authority: { state: "MODULE", generation: 3 } };
            }

            async call(args: { method: string; body: unknown }) {
                if (this.instanceState !== "timer-transport")
                    throw new Error("lost transport this");
                moduleCalls.push(args);
                if (args.method === "dreamer.run_task") {
                    const body = args.body as { payload: { items: Array<{ memory_id: number }> } };
                    return {
                        ok: true,
                        manifest_text: `<classify>${body.payload.items
                            .map(
                                (item) =>
                                    `<memory id="${item.memory_id}" importance="80" scope="project" shareable="true"/>`,
                            )
                            .join("")}</classify>`,
                        truncated: false,
                    };
                }
                const rows = (args.body as { arguments: { rows: Array<{ memory_id: number }> } })
                    .arguments.rows;
                return { accepted: rows.map((row) => row.memory_id), rejected: [] };
            }
        }
        const moduleClient = createDreamTimerModuleClient(new StatefulTimerModuleClient() as never);
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            moduleClient: moduleClient as never,
        });
        const leaseKey = leaseKeyFor("classify-memories", project);
        expect(acquireLease(db, "holder-rust-classify", leaseKey)).toBe(true);
        const result = await executor(
            { task: "classify-memories", schedule: "0 6 * * *", timeoutMinutes: 20 },
            { db, projectIdentity: project, holderId: "holder-rust-classify", leaseKey },
        );
        expect(result.status).toBe("completed");
        expect(authorityStatusCalls).toBe(1);
        expect(client.session.create).not.toHaveBeenCalled();
        expect(moduleCalls.map((call) => call.method)).toEqual([
            "dreamer.run_task",
            "memory.set_classification",
        ]);
        const applyBody = moduleCalls[1].body as {
            arguments: { rows: Array<{ memory_id: number; shareable: boolean }> };
        };
        expect(applyBody.arguments.rows.find((row) => row.memory_id === 10000)?.shareable).toBe(
            false,
        );
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
                list: mock(async () => ({ data: [] })),
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
    test("rust-authority fixture routes cues through memory.set_mural_cue and leaves no parked facade path", async () => {
        db = freshDb();
        const project = "/repo/module-cues";
        const contextStoreUuid = ensureContextStoreUuid(db);
        const memory = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "A cue candidate routed through the module facade.",
        });
        db.prepare(
            `INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id)
             VALUES ('memories', ?, 101, ?)`,
        ).run(project, memory.id);
        db.prepare(
            `INSERT INTO mirror_live_memory_rows(
                 module_project, module_row_id, category, normalized_hash, full_row_snapshot
             ) VALUES (?, 101, ?, ?, '{}')`,
        ).run(project, memory.category, "module-hash");
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "cue-child" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: assistantMessages(`<cues><cue id="${memory.id}">module cue</cue></cues>`),
                })),
                delete: mock(async () => ({})),
            },
        };
        const authorityStatus = mock(async () => ({
            authority: { state: "MODULE", generation: 12 },
        }));
        const moduleCall = mock(async (args: { method: string; body?: unknown }) => {
            expect(args.method).toBe("memory.set_mural_cue");
            const body = args.body as {
                arguments?: { command_id?: unknown; rows?: Array<Record<string, unknown>> };
            };
            expect(typeof body.arguments?.command_id).toBe("string");
            expect(body.arguments?.rows).toEqual([
                {
                    memory_id: 101,
                    content_hash_at_prompt: expect.any(String),
                    cue: "module cue",
                    rejection_count: 0,
                },
            ]);
            const update = body.arguments?.rows?.[0];
            applyMirrorPage({
                db,
                page: {
                    domain: "memories",
                    cursor: 0,
                    next_cursor: 1,
                    has_more: false,
                    rows: [
                        {
                            feed_seq: 1,
                            domain: "memories",
                            op: "update",
                            module_row_id: 101,
                            content_hash: String(update?.content_hash_at_prompt),
                            full_row_snapshot: {
                                id: 101,
                                project_path: project,
                                context_store_uuid: contextStoreUuid,
                                context_row_id: memory.id,
                                mural_cue: update?.cue,
                                mural_cue_hash: update?.content_hash_at_prompt,
                                mural_cue_at: 123,
                                mural_cue_rejection_count: update?.rejection_count,
                            },
                        },
                    ],
                },
            });
            return { result: { accepted: [101], rejected: [] } };
        });
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            mural: { enabled: true },
            moduleClient: { authorityStatus, call: moduleCall } as never,
        });
        const leaseKey = leaseKeyFor("compress-cues", project);
        expect(acquireLease(db, "holder-module-cues", leaseKey)).toBe(true);

        const result = await executor(
            { task: "compress-cues", schedule: "0 7 * * *", timeoutMinutes: 20 },
            { db, projectIdentity: project, holderId: "holder-module-cues", leaseKey },
        );

        expect(result).toEqual({ status: "completed" });
        expect(authorityStatus).toHaveBeenCalledTimes(1);
        expect(client.session.create).toHaveBeenCalledTimes(1);
        expect(client.session.prompt).toHaveBeenCalledTimes(1);
        expect(moduleCall).toHaveBeenCalledTimes(1);
        expect(
            db
                .prepare("SELECT mural_cue, mural_cue_hash FROM memories WHERE id = ?")
                .get(memory.id),
        ).toEqual({
            mural_cue: "module cue",
            mural_cue_hash: expect.any(String),
        });
    });

    test("defers cue mutation while Rust authority is draining", async () => {
        db = freshDb();
        const project = "/repo/draining-cues";
        ensureContextStoreUuid(db);
        const memory = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "A cue candidate must wait for module drain replay.",
        });
        const create = mock(async () => ({ data: { id: "must-not-create" } }));
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create,
            },
        };
        const authorityStatus = mock(async () => ({
            authority: { state: "DRAINING", generation: 12 },
        }));
        const moduleCall = mock(async () => ({ accepted: [], rejected: [] }));
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            mural: { enabled: true },
            moduleClient: { authorityStatus, call: moduleCall } as never,
        });
        const leaseKey = leaseKeyFor("compress-cues", project);
        expect(acquireLease(db, "holder-draining-cues", leaseKey)).toBe(true);

        let thrown: unknown;
        try {
            await executor(
                { task: "compress-cues", schedule: "0 7 * * *", timeoutMinutes: 20 },
                { db, projectIdentity: project, holderId: "holder-draining-cues", leaseKey },
            );
        } catch (error) {
            thrown = error;
        }

        expect(String(thrown)).toContain("dreamer mutation deferred");
        expect(create).not.toHaveBeenCalled();
        expect(moduleCall).not.toHaveBeenCalled();
        expect(db.prepare("SELECT mural_cue FROM memories WHERE id = ?").get(memory.id)).toEqual({
            mural_cue: null,
        });
    });

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
                list: mock(async () => ({ data: [] })),
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
                list: mock(async () => ({ data: [] })),
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

    test("gate returns 'n' → one gate turn, child created+deleted, watermark advances, no deepen", async () => {
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
                list: mock(async () => ({ data: [] })),
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
            { task: "retrospective", schedule: "0 5 * * *", timeoutMinutes: 20 },
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
        expect(client.session.delete).toHaveBeenCalled(); // child always cleaned up
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
                list: mock(async () => ({ data: [] })),
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
            { task: "retrospective", schedule: "0 5 * * *", timeoutMinutes: 20 },
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
                list: mock(async () => ({ data: [] })),
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
            { task: "retrospective", schedule: "0 5 * * *", timeoutMinutes: 20 },
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
            list: mock(async () => ({ data: [] })),
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
