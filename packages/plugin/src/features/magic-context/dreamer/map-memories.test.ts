/// <reference types="bun-types" />

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HiddenCompletionExecutor } from "../../../hooks/magic-context/compartment-runner-types";
import * as logger from "../../../shared/logger";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { insertMemory } from "../memory";
import {
    getMemoryVerifications,
    getUnmappedMemoryIds,
    recordMemoryMapping,
} from "../memory/storage-memory-verifications";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { getSubagentInvocations } from "../storage-subagent-invocations";
import { acquireLease, renewLease } from "./lease";
import {
    applyBatchMappings,
    computeMapBatchSliceMs,
    MAP_BATCH_FLOOR_MS,
    type MapMemoriesArgs,
    mapMemories,
    parseMapMemoriesCompletion,
    selectMapMemoryInputs,
    shouldRequeueIndependentMapping,
    validateClientMapMemories,
} from "./map-memories";
import { DreamTokenBudgetExceeded, TOKEN_BUDGET_FINALIZE_MESSAGE } from "./token-budget";

const tempDirs: string[] = [];

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function tempProject(): string {
    const dir = createTestTempDirFromPath(path.join(tmpdir(), "mc-map-memories-"));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "fact.ts"), "export const fact = true;", "utf8");
    return dir;
}

function mapArgs(db: Database, sessionDirectory: string, projectIdentity: string): MapMemoriesArgs {
    const holderId = "map-holder";
    const leaseKey = `map-${Math.random()}`;
    expect(acquireLease(db, holderId, leaseKey)).toBe(true);
    return {
        db,
        client: {} as never,
        projectIdentity,
        parentSessionId: "ses-parent",
        sessionDirectory,
        holderId,
        leaseKey,
        // Every direct mapping test that reaches the loop needs enough budget to
        // clear the production floor; deadline-stop fixtures override this value.
        deadline: Date.now() + MAP_BATCH_FLOOR_MS + 60_000,
    };
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

function assistantMessages(text: string) {
    return [
        {
            info: { role: "assistant", time: { created: Date.now() } },
            parts: [{ type: "text", text }],
        },
    ];
}

function scriptedMapClient(manifestFor: (promptCall: number, ids: number[]) => string): {
    client: unknown;
    promptCalls: () => number;
    promptIds: () => number[][];
} {
    let promptCalls = 0;
    let lastIds: number[] = [];
    const promptedIds: number[][] = [];
    return {
        client: {
            session: {
                create: async () => ({ data: { id: "map-child" } }),
                prompt: async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                    promptCalls += 1;
                    const prompt = args.body?.parts?.[0]?.text ?? "";
                    lastIds = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
                    promptedIds.push(lastIds);
                    return {};
                },
                messages: async () => ({
                    data: assistantMessages(manifestFor(promptCalls, lastIds)),
                }),
                delete: async () => ({}),
            },
        },
        promptCalls: () => promptCalls,
        promptIds: () => promptedIds,
    };
}

function successfulMapClient(onPrompt?: () => void) {
    let manifest = "";
    return {
        session: {
            create: async () => ({ data: { id: "map-child" } }),
            prompt: async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                const prompt = args.body?.parts?.[0]?.text ?? "";
                const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
                manifest = `<mappings>${ids.map((id) => `<memory id="${id}" independent="true"/>`).join("")}</mappings>`;
                onPrompt?.();
                return {};
            },
            messages: async () => ({ data: assistantMessages(manifest) }),
            delete: async () => ({}),
        },
    };
}

/** The exact timeout-class error from the shared prompt helper. */
function timeoutMapClient(
    onPrompt?: () => void,
    timeoutError: () => unknown = () => new Error("prompt timed out after 99997ms"),
) {
    return {
        session: {
            create: async () => ({ data: { id: "map-child" } }),
            prompt: async () => {
                onPrompt?.();
                throw timeoutError();
            },
            abort: async () => ({}),
            messages: async () => ({ data: [] }),
            delete: async () => ({}),
        },
    };
}

/** Model elapsed time without waiting minutes for the real batch timers. */
function timedMapExecutor(
    args: MapMemoriesArgs,
    advanceClock: (elapsedMs: number) => void,
    durationFor: (ids: number[]) => number,
    partialFor: (ids: number[]) => number[] = () => [],
) {
    const calls: Array<{ ids: number[]; sliceMs: number }> = [];
    let sliceMs = 0;
    let text = "";
    const executor: HiddenCompletionExecutor = {
        capabilities: { tools: true, harness: "pi" },
        open: async (run) => {
            sliceMs = run.timeoutMs;
            return { id: `timed-map-${calls.length}` };
        },
        attempt: async (_handle, request) => {
            const prompt = request.body.parts.map((part) => part.text ?? "").join("");
            const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
            calls.push({ ids, sliceMs });
            const durationMs = durationFor(ids);
            const timedOut = durationMs > sliceMs;
            const committedIds = timedOut ? partialFor(ids) : ids;
            text = `<mappings>${committedIds.map((id) => `<memory id="${id}" independent="true"/>`).join("")}${timedOut ? "" : "</mappings>"}`;
            let elapsedMs = Math.min(durationMs, sliceMs);
            // Simulate the heartbeat that would renew the lease during real work.
            while (elapsedMs > 0) {
                const step = Math.min(60_000, elapsedMs);
                advanceClock(step);
                elapsedMs -= step;
                expect(renewLease(args.db, args.holderId, args.leaseKey)).toBe(true);
            }
            if (timedOut) throw new Error(`prompt timed out after ${sliceMs}ms`);
        },
        collect: async () => ({
            text,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            lengthCapped: false,
        }),
        close: async () => {},
    };
    return { executor, calls };
}

describe("mapMemories disposition", () => {
    test("banks a completed batch and reports the deadline remainder", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-deadline";
            const dir = tempProject();
            for (let index = 0; index < 21; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Independent fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = mapArgs(db, dir, projectIdentity);
            args.client = successfulMapClient(() => {
                args.deadline = Date.now() - 1;
            }) as never;

            const result = await mapMemories(args);

            expect(result).toEqual({
                mapped: 0,
                independent: 5,
                batches: 1,
                remaining: 16,
                complete: false,
                stopReason: "deadline",
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("floors a large default-deadline backfill and banks its first completed batch", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-floor-primary";
            const dir = tempProject();
            // Even a large backlog must retain the four-minute floor.
            // Smaller batches change throughput, not the latency allowance.
            const defaultDeadlineMs = 20 * 60 * 1000;
            expect(Math.floor(defaultDeadlineMs / 12)).toBe(100_000);
            expect(computeMapBatchSliceMs(defaultDeadlineMs, 12)).toBe(MAP_BATCH_FLOOR_MS);
            for (let index = 0; index < 221; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Large-backlog mapping fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = mapArgs(db, dir, projectIdentity);
            args.deadline = Date.now() + defaultDeadlineMs;
            let promptCalls = 0;
            args.client = successfulMapClient(() => {
                promptCalls += 1;
                // One full floor-sized batch completed; no fair slice remains for
                // batch two, so its untouched inputs must stay banked for resume.
                args.deadline = Date.now() + 60_000;
            }) as never;

            const result = await mapMemories(args);

            expect(promptCalls).toBe(1);
            expect(result).toEqual({
                mapped: 0,
                independent: 5,
                batches: 1,
                remaining: 216,
                complete: false,
                stopReason: "deadline",
            });
            expect(selectMapMemoryInputs(db, projectIdentity, dir)).toHaveLength(216);
        } finally {
            closeQuietly(db);
        }
    });

    test("stops before the next batch when the remaining deadline cannot fit the floor", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-floor-stop";
            const dir = tempProject();
            for (let index = 0; index < 21; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Floor-boundary mapping fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = mapArgs(db, dir, projectIdentity);
            let promptCalls = 0;
            args.client = successfulMapClient(() => {
                promptCalls += 1;
                args.deadline = Date.now() + 60_000;
            }) as never;

            const result = await mapMemories(args);

            expect(promptCalls).toBe(1);
            expect(result).toEqual({
                mapped: 0,
                independent: 5,
                batches: 1,
                remaining: 16,
                complete: false,
                stopReason: "deadline",
            });
            expect(selectMapMemoryInputs(db, projectIdentity, dir)).toHaveLength(16);
        } finally {
            closeQuietly(db);
        }
    });

    test("size-dependent mapper drains the backlog by splitting timed-out batches", async () => {
        const db = freshDb();
        let now = Date.now();
        const clock = spyOn(Date, "now").mockImplementation(() => now);
        const logs = spyOn(logger, "log").mockImplementation(() => {});
        try {
            const projectIdentity = "git:map-size-dependent-timeout";
            const dir = tempProject();
            const ids = Array.from(
                { length: 26 },
                (_, index) =>
                    insertMemory(db, {
                        projectPath: projectIdentity,
                        category: "ARCHITECTURE",
                        content: `Batch-size mapping fact ${index}.`,
                        sourceSessionId: "ses",
                    }).id,
            );
            const args = mapArgs(db, dir, projectIdentity);
            args.deadline = now + 7 * MAP_BATCH_FLOOR_MS;
            // Large batches exhaust their slice; small batches avoid that investigation cost.
            const mapper = timedMapExecutor(
                args,
                (elapsedMs) => (now += elapsedMs),
                (batch) => (batch.length === 5 ? 300_000 : batch.length * 1_000),
            );
            args.hiddenCompletionExecutor = mapper.executor;

            const result = await mapMemories(args);

            expect(result).toMatchObject({ independent: 26, remaining: 0, complete: true });
            expect(result.stopReason).toBeUndefined();
            expect(mapper.calls.map((call) => call.ids.length)).toEqual([
                ...Array.from({ length: 5 }, () => [5, 2, 2, 1]).flat(),
                1,
            ]);
            expect(mapper.calls[0]?.sliceMs).toBe(280_000);
            expect(mapper.calls[1]?.sliceMs).toBe(MAP_BATCH_FLOOR_MS);
            expect(now).toBeLessThanOrEqual(args.deadline);
            expect(getUnmappedMemoryIds(db, ids)).toEqual([]);
            expect(selectMapMemoryInputs(db, projectIdentity, dir)).toEqual([]);
            const splitLogs = logs.mock.calls
                .map(([message]) => message)
                .filter((message) => message.includes("splitting"));
            expect(splitLogs).toHaveLength(5);
            expect(splitLogs[0]).toContain(ids.slice(0, 5).join(","));
            expect(splitLogs[0]).toContain("2+2+1");
            expect(splitLogs[0]).toContain("timeout");
        } finally {
            logs.mockRestore();
            clock.mockRestore();
            closeQuietly(db);
        }
    });

    test("a timed-out partial commit splits only unmapped memories", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-partial-timeout-split";
            const dir = tempProject();
            const ids = Array.from(
                { length: 5 },
                (_, index) =>
                    insertMemory(db, {
                        projectPath: projectIdentity,
                        category: "ARCHITECTURE",
                        content: `Partial timeout mapping fact ${index}.`,
                        sourceSessionId: "ses",
                    }).id,
            );
            const args = mapArgs(db, dir, projectIdentity);
            const orderedIds = selectMapMemoryInputs(db, projectIdentity, dir).map(
                (memory) => memory.id,
            );
            const mapper = timedMapExecutor(
                args,
                () => {},
                (batch) => (batch.length === 5 ? 1_000_000 : 1_000),
                (batch) => batch.slice(0, 2),
            );
            args.hiddenCompletionExecutor = mapper.executor;

            const result = await mapMemories(args);

            expect(mapper.calls.map((call) => call.ids)).toEqual([
                orderedIds,
                orderedIds.slice(2, 4),
                orderedIds.slice(4),
            ]);
            expect(result).toMatchObject({ independent: 5, remaining: 0, complete: true });
            expect(getMemoryVerifications(db, ids).size).toBe(5);
        } finally {
            closeQuietly(db);
        }
    });

    test("timeout splitting stops before a child cannot fit its floor in the task deadline", async () => {
        const db = freshDb();
        let now = Date.now();
        const clock = spyOn(Date, "now").mockImplementation(() => now);
        try {
            const projectIdentity = "git:map-split-deadline";
            const dir = tempProject();
            for (let index = 0; index < 11; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Split deadline mapping fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = mapArgs(db, dir, projectIdentity);
            const ids = selectMapMemoryInputs(db, projectIdentity, dir).map((memory) => memory.id);
            args.deadline = now + 2 * MAP_BATCH_FLOOR_MS;
            const mapper = timedMapExecutor(
                args,
                (elapsedMs) => (now += elapsedMs),
                (batch) => (batch.length > 2 ? 1_000_000 : 60_000),
            );
            args.hiddenCompletionExecutor = mapper.executor;

            const result = await mapMemories(args);

            expect(mapper.calls.map((call) => call.ids.length)).toEqual([5, 2]);
            expect(mapper.calls.map((call) => call.sliceMs)).toEqual([
                MAP_BATCH_FLOOR_MS,
                MAP_BATCH_FLOOR_MS,
            ]);
            expect(result).toMatchObject({
                independent: 2,
                remaining: 9,
                complete: false,
                stopReason: "deadline",
            });
            expect(now).toBe(args.deadline - 180_000);
            expect(getUnmappedMemoryIds(db, ids)).toHaveLength(9);
        } finally {
            clock.mockRestore();
            closeQuietly(db);
        }
    });

    test("two consecutive singleton timeouts trip the breaker and defer the failed memories", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-timeout-breaker";
            const dir = tempProject();
            // Multi-memory batches split; two consecutive singleton timeouts with
            // no committed mappings stop the remaining work.
            for (let index = 0; index < 61; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Timeout mapping fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = mapArgs(db, dir, projectIdentity);
            const initialIds = selectMapMemoryInputs(db, projectIdentity, dir).map(
                (memory) => memory.id,
            );
            let promptCalls = 0;
            args.client = timeoutMapClient(() => {
                promptCalls += 1;
            }) as never;

            const result = await mapMemories(args);

            expect(promptCalls).toBe(4); // 5 -> 2 -> 1, 1; no unbounded singleton retry.
            expect(result).toEqual({
                mapped: 0,
                independent: 0,
                batches: 0,
                remaining: 61,
                complete: false,
                stopReason: "timeout-circuit-breaker",
                failure: expect.any(Error),
                failureStage: "prompt",
            });
            const selectable = selectMapMemoryInputs(db, projectIdentity, dir).map(
                (memory) => memory.id,
            );
            expect(selectable).toEqual(initialIds.slice(2));
            expect(selectMapMemoryInputs(db, projectIdentity, dir, true)).toHaveLength(61);
        } finally {
            closeQuietly(db);
        }
    });

    test("two consecutive singleton host request timeouts also trip the starvation circuit breaker", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-host-timeout-breaker";
            const dir = tempProject();
            for (let index = 0; index < 61; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Host timeout mapping fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = mapArgs(db, dir, projectIdentity);
            let promptCalls = 0;
            // Bun's fetch rejects with this DOMException when the host client's own
            // request timer fires on a long synchronous prompt.
            args.client = timeoutMapClient(
                () => {
                    promptCalls += 1;
                },
                () => new DOMException("The operation timed out.", "TimeoutError"),
            ) as never;

            const result = await mapMemories(args);

            expect(promptCalls).toBe(4);
            expect(result.stopReason).toBe("timeout-circuit-breaker");
            expect(result.complete).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("a failed batch row records the child's tokens and model", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-failed-row-evidence";
            const dir = tempProject();
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Evidence mapping fact.",
                sourceSessionId: "ses",
            });
            const args = mapArgs(db, dir, projectIdentity);
            args.parentSessionId = "ses-parent-map";
            // A step-capped loop ends with prose instead of a manifest.
            args.client = {
                session: {
                    create: async () => ({ data: { id: "map-child" } }),
                    prompt: async () => ({}),
                    messages: async () => ({
                        data: [
                            {
                                info: {
                                    role: "assistant",
                                    providerID: "openai",
                                    modelID: "gpt-map",
                                    time: { created: 1, completed: 2 },
                                    finish: "stop",
                                    tokens: {
                                        input: 900,
                                        output: 120,
                                        cache: { read: 0, write: 0 },
                                    },
                                },
                                parts: [{ type: "text", text: "I mapped most of them." }],
                            },
                        ],
                    }),
                    delete: async () => ({}),
                },
            } as never;

            await mapMemories(args);

            const [row] = getSubagentInvocations(db, "ses-parent-map", { subagent: "dreamer" });
            expect(row).toMatchObject({
                task: "map-memories",
                status: "failed",
                providerId: "openai",
                modelId: "gpt-map",
                inputTokens: 900,
                outputTokens: 120,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("a later run resumes the durable remainder after a floored partial run", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-floor-resume";
            const dir = tempProject();
            for (let index = 0; index < 41; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Resumable mapping fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = mapArgs(db, dir, projectIdentity);
            args.client = successfulMapClient(() => {
                args.deadline = Date.now() + 60_000;
            }) as never;

            const first = await mapMemories(args);
            expect(first).toMatchObject({ independent: 5, batches: 1, remaining: 36 });
            expect(selectMapMemoryInputs(db, projectIdentity, dir)).toHaveLength(36);

            args.deadline = Date.now() + 2 * MAP_BATCH_FLOOR_MS;
            args.client = successfulMapClient() as never;
            const second = await mapMemories(args);

            expect(second).toEqual({
                mapped: 0,
                independent: 36,
                batches: 8,
                remaining: 0,
                complete: true,
            });
            expect(selectMapMemoryInputs(db, projectIdentity, dir)).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("commits a 4/5 closed subset and retries only its omitted id", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-omission-retry";
            const dir = tempProject();
            const memoryIds: number[] = [];
            for (let index = 0; index < 5; index += 1) {
                memoryIds.push(
                    insertMemory(db, {
                        projectPath: projectIdentity,
                        category: "ARCHITECTURE",
                        content: `Mapping omission fact ${index}.`,
                        sourceSessionId: "ses",
                    }).id,
                );
            }
            const progress: number[] = [];
            const args = mapArgs(db, dir, projectIdentity);
            const scripted = scriptedMapClient((call, ids) => {
                if (call === 2) {
                    // The closing root makes the first response complete rather than
                    // truncated, so its returned mappings can commit immediately. Only
                    // its one absent id is present in the retry prompt.
                    expect(ids).toHaveLength(1);
                    expect(getMemoryVerifications(db, memoryIds).size).toBe(4);
                    expect(getMemoryVerifications(db, ids).has(ids[0] as number)).toBe(false);
                }
                const returnedIds = call === 1 ? ids.slice(0, -1) : ids;
                return `<mappings>${returnedIds.map((id) => `<memory id="${id}" independent="true"/>`).join("")}</mappings>`;
            });
            args.client = scripted.client as never;
            args.onProgress = (processed) => progress.push(processed);

            const result = await mapMemories(args);

            expect(scripted.promptCalls()).toBe(2);
            const promptIds = scripted.promptIds();
            const initialPrompt = promptIds[0];
            const retryPrompt = promptIds[1];
            if (!initialPrompt || !retryPrompt) throw new Error("missing prompt fixture");
            expect(initialPrompt).toHaveLength(5);
            expect([...initialPrompt].sort((a, b) => a - b)).toEqual(
                [...memoryIds].sort((a, b) => a - b),
            );
            expect(retryPrompt).toEqual([initialPrompt[initialPrompt.length - 1]]);
            expect(progress).toEqual([4, 5]);
            expect(result).toEqual({
                mapped: 0,
                independent: 5,
                batches: 2,
                remaining: 0,
                complete: true,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("defers an id omitted twice and resumes after backoff", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-omission-resume";
            const dir = tempProject();
            const first = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "First resumable fact.",
                sourceSessionId: "ses",
            });
            const second = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Second resumable fact.",
                sourceSessionId: "ses",
            });
            const firstRun = mapArgs(db, dir, projectIdentity);
            const partial = scriptedMapClient((call) =>
                call === 1
                    ? `<mappings><memory id="${first.id}" independent="true"/></mappings>`
                    : "<mappings></mappings>",
            );
            firstRun.client = partial.client as never;

            const firstResult = await mapMemories(firstRun);

            const [initialPrompt, retryPrompt] = partial.promptIds();
            if (!initialPrompt || !retryPrompt) throw new Error("missing prompt fixture");
            expect(initialPrompt).toHaveLength(2);
            expect([...initialPrompt].sort((a, b) => a - b)).toEqual([first.id, second.id]);
            // Only the unreturned id is retried. After two omissions it waits
            // for backoff rather than immediately blocking the next scheduled run.
            expect(retryPrompt).toEqual([second.id]);
            expect(firstResult).toEqual({
                failure: expect.any(Error),
                failureStage: "prompt",
                mapped: 0,
                independent: 1,
                batches: 1,
                remaining: 1,
                complete: false,
            });
            expect(
                selectMapMemoryInputs(db, projectIdentity, dir).map((memory) => memory.id),
            ).toEqual([]);
            expect(
                selectMapMemoryInputs(db, projectIdentity, dir, true).map((memory) => memory.id),
            ).toEqual([second.id]);

            const resumed = mapArgs(db, dir, projectIdentity);
            const complete = scriptedMapClient(
                (_call, ids) =>
                    `<mappings>${ids.map((id) => `<memory id="${id}" independent="true"/>`).join("")}</mappings>`,
            );
            resumed.client = complete.client as never;

            const realNow = Date.now;
            Date.now = () => realNow() + 3_600_001;
            resumed.deadline = Date.now() + 300_000;
            let resumedResult: Awaited<ReturnType<typeof mapMemories>>;
            try {
                resumedResult = await mapMemories(resumed);
            } finally {
                Date.now = realNow;
            }

            expect(complete.promptIds()).toEqual([[second.id]]);
            expect(resumedResult).toEqual({
                mapped: 0,
                independent: 1,
                batches: 1,
                remaining: 0,
                complete: true,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("converges all-rejected paths into a marked fallback across consecutive runs", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-rejected-fallback";
            const dir = tempProject();
            // The host rejects both in-repo untracked paths and paths outside the
            // repository. The mixed manifest proves the fallback is all-rejected,
            // not a special case for only one rejection reason.
            execFileSync("git", ["init", "-q"], { windowsHide: true, cwd: dir });
            execFileSync("git", ["add", "src/fact.ts"], { windowsHide: true, cwd: dir });
            writeFileSync(
                path.join(dir, "src", "untracked.ts"),
                "export const draft = true;",
                "utf8",
            );
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Fact lives in src/untracked.ts.",
                sourceSessionId: "ses",
            });
            const args = mapArgs(db, dir, projectIdentity);
            const scripted = scriptedMapClient(
                (_call, ids) =>
                    `<mappings>${ids.map((id) => `<memory id="${id}" files="src/untracked.ts,/outside-project/fact.ts"/>`).join("")}</mappings>`,
            );
            args.client = scripted.client as never;

            const first = await mapMemories(args);

            expect(first).toEqual({
                mapped: 0,
                independent: 1,
                batches: 1,
                remaining: 0,
                complete: true,
            });
            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state).toMatchObject({
                files: [],
                hasSentinel: true,
                mappingOrigin: "host_rejected_fallback",
            });
            expect(getUnmappedMemoryIds(db, [memory.id])).toEqual([]);
            expect(selectMapMemoryInputs(db, projectIdentity, dir)).toEqual([]);

            const second = await mapMemories(args);
            expect(second).toEqual({
                mapped: 0,
                independent: 0,
                batches: 0,
                remaining: 0,
                complete: true,
            });
            expect(scripted.promptCalls()).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("reports complete after fully draining the selected set", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-complete";
            const dir = tempProject();
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Independent fact.",
                sourceSessionId: "ses",
            });
            const args = mapArgs(db, dir, projectIdentity);
            args.client = successfulMapClient() as never;

            expect(await mapMemories(args)).toEqual({
                mapped: 0,
                independent: 1,
                batches: 1,
                remaining: 0,
                complete: true,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("reports a swallowed batch failure as incomplete", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-failure";
            const dir = tempProject();
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Independent fact.",
                sourceSessionId: "ses",
            });
            const args = mapArgs(db, dir, projectIdentity);
            args.client = {
                session: {
                    create: async () => {
                        throw new Error("provider unavailable");
                    },
                },
            } as never;

            const result = await mapMemories(args);
            expect(result.complete).toBe(false);
            expect(result.remaining).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("mapMemories retry-time validation", () => {
    test("wrong-but-rooted empty parse fires the fallback model", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-retry-empty";
            const dir = tempProject();
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Independent fact.",
                sourceSessionId: "ses",
            });
            const args = mapArgs(db, dir, projectIdentity);
            const scripted = scriptedMapClient((call, ids) =>
                call === 1
                    ? `<mappings>\n<map id="1">\nsrc/fact.ts\n</map>\n</mappings>`
                    : `<mappings>${ids.map((id) => `<memory id="${id}" independent="true"/>`).join("")}</mappings>`,
            );
            args.client = scripted.client as never;
            args.fallbackModels = ["anthropic/claude-sonnet-4-6"];

            const result = await mapMemories(args);
            expect(scripted.promptCalls()).toBe(2);
            expect(result).toEqual({
                mapped: 0,
                independent: 1,
                batches: 1,
                remaining: 0,
                complete: true,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("an unclosed subset rejects the full batch before the fallback retry", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-retry-coverage";
            const dir = tempProject();
            const first = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "First fact.",
                sourceSessionId: "ses",
            });
            const second = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Second fact.",
                sourceSessionId: "ses",
            });
            const args = mapArgs(db, dir, projectIdentity);
            const scripted = scriptedMapClient((call, ids) =>
                call === 1
                    ? `<mappings><memory id="${first.id}" independent="true"/>`
                    : `<mappings>${ids.map((id) => `<memory id="${id}" independent="true"/>`).join("")}</mappings>`,
            );
            args.client = scripted.client as never;
            args.fallbackModels = ["anthropic/claude-sonnet-4-6"];

            const result = await mapMemories(args);
            expect(scripted.promptCalls()).toBe(2);
            const promptIds = scripted.promptIds();
            expect(promptIds[0]).toEqual(promptIds[1]);
            expect([...new Set(promptIds[0])].sort((a, b) => a - b)).toEqual(
                [first.id, second.id].sort((a, b) => a - b),
            );
            expect(result.independent).toBe(2);
            expect(result.complete).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("applyBatchMappings", () => {
    test("complete manifest writes the mapping", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Fact lives in src/fact.ts.",
                sourceSessionId: "ses",
            });

            const result = await applyBatchMappings(
                mapArgs(db, dir, projectIdentity),
                [
                    {
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        candidates: [],
                    },
                ],
                `<mappings><memory id="${memory.id}" files="src/fact.ts"/></mappings>`,
            );

            expect(result).toEqual({ mapped: 1, independent: 0 });
            expect(getMemoryVerifications(db, [memory.id]).get(memory.id)?.files).toEqual([
                "src/fact.ts",
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("overrides a directive-shaped PROJECT_RULES file mapping to independent", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:directive-map-safety";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "PROJECT_RULES",
                content:
                    "When told to check a cache bust, run src/fact.ts first and never reason by hand.",
                sourceSessionId: "ses",
            });

            const result = await applyBatchMappings(
                mapArgs(db, dir, projectIdentity),
                [
                    {
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        candidates: ["src/fact.ts"],
                    },
                ],
                `<mappings><memory id="${memory.id}" files="src/fact.ts"/></mappings>`,
            );

            expect(result).toEqual({ mapped: 0, independent: 1 });
            expect(getMemoryVerifications(db, [memory.id]).get(memory.id)).toMatchObject({
                files: [],
                hasSentinel: true,
                mappingOrigin: "host_rejected_fallback",
            });
            expect(selectMapMemoryInputs(db, projectIdentity, dir)).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("preserves mapper-authored independent as distinct from the host fallback", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test-mapper-independent";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Fact lives in src/fact.ts.",
                sourceSessionId: "ses",
            });

            const result = await applyBatchMappings(
                mapArgs(db, dir, projectIdentity),
                [
                    {
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        candidates: [],
                    },
                ],
                `<mappings><memory id="${memory.id}" independent="true"/></mappings>`,
            );

            expect(result).toEqual({ mapped: 0, independent: 1 });
            expect(getMemoryVerifications(db, [memory.id]).get(memory.id)?.mappingOrigin).toBe(
                "mapper",
            );
            expect(selectMapMemoryInputs(db, projectIdentity, dir).map(({ id }) => id)).toEqual([
                memory.id,
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("keeps accepted paths when a manifest only partially fails normalization", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test-partial-rejection";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Fact lives in src/fact.ts.",
                sourceSessionId: "ses",
            });

            const result = await applyBatchMappings(
                mapArgs(db, dir, projectIdentity),
                [
                    {
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        candidates: [],
                    },
                ],
                `<mappings><memory id="${memory.id}" files="src/fact.ts,/outside-project/fact.ts"/></mappings>`,
            );

            expect(result).toEqual({ mapped: 1, independent: 0 });
            expect(getMemoryVerifications(db, [memory.id]).get(memory.id)).toMatchObject({
                files: ["src/fact.ts"],
                hasSentinel: false,
                mappingOrigin: "mapper",
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("truncated manifest rejects before replacing an existing mapping", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Fact lives in src/fact.ts.",
                sourceSessionId: "ses",
            });
            recordMemoryMapping(db, memory.id, [], 1_000);

            await expect(
                applyBatchMappings(
                    mapArgs(db, dir, projectIdentity),
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            candidates: [],
                        },
                    ],
                    `<mappings><memory id="${memory.id}" files="src/fact.ts"/>`,
                ),
            ).rejects.toThrow(/closing root/);

            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state?.files).toEqual([]);
            expect(state?.hasSentinel).toBe(true);
            expect(state?.mappedAt).toBe(1_000);
        } finally {
            closeQuietly(db);
        }
    });

    test("drops unknown ids and commits the valid remainder", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test-unknown";
            const dir = tempProject();
            const mapped = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Mapped fact.",
                sourceSessionId: "ses",
            });
            const omitted = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Omitted fact.",
                sourceSessionId: "ses",
            });
            const unknown = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Wrong-batch fact.",
                sourceSessionId: "ses",
            });
            const batch = [mapped, omitted].map((memory) => ({
                id: memory.id,
                category: memory.category,
                content: memory.content,
                candidates: [] as string[],
            }));

            const result = await applyBatchMappings(
                mapArgs(db, dir, projectIdentity),
                batch,
                `<mappings><memory id="${mapped.id}" independent="true"/><memory id="${unknown.id}" independent="true"/></mappings>`,
            );

            expect(result).toEqual({ mapped: 0, independent: 1 });
            const states = getMemoryVerifications(db, [mapped.id, omitted.id, unknown.id]);
            expect(states.has(mapped.id)).toBe(true);
            expect(states.has(omitted.id)).toBe(false);
            expect(states.has(unknown.id)).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("rejects a manifest covering less than half of the batch", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test-mostly-wrong";
            const dir = tempProject();
            const batchMemories = ["First", "Second", "Third"].map((content) =>
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content,
                    sourceSessionId: "ses",
                }),
            );
            const unknown = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Wrong-batch fact.",
                sourceSessionId: "ses",
            });
            const batch = batchMemories.map((memory) => ({
                id: memory.id,
                category: memory.category,
                content: memory.content,
                candidates: [] as string[],
            }));

            await expect(
                applyBatchMappings(
                    mapArgs(db, dir, projectIdentity),
                    batch,
                    `<mappings><memory id="${batchMemories[0]?.id}" independent="true"/><memory id="${unknown.id}" independent="true"/></mappings>`,
                ),
            ).rejects.toThrow(/mostly-wrong manifest/);
            expect(
                getMemoryVerifications(
                    db,
                    batch.map((memory) => memory.id),
                ).size,
            ).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("nested file children persist as a real mapping, not independent", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test-nested";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Fact lives in src/fact.ts.",
                sourceSessionId: "ses",
            });

            const result = await applyBatchMappings(
                mapArgs(db, dir, projectIdentity),
                [
                    {
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        candidates: [],
                    },
                ],
                `<mappings><memory id="${memory.id}"><file path="src/fact.ts"/></memory></mappings>`,
            );

            expect(result).toEqual({ mapped: 1, independent: 0 });
            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state?.files).toEqual(["src/fact.ts"]);
            expect(state?.hasSentinel).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("independent re-queue heal", () => {
    test("predicate selects a path-seeded independent and skips a conceptual bystander", () => {
        const dir = tempProject();
        expect(
            shouldRequeueIndependentMapping(
                { hasSentinel: true, files: [] },
                "Fact lives in src/fact.ts.",
                dir,
            ),
        ).toBe(true);
        expect(
            shouldRequeueIndependentMapping(
                { hasSentinel: true, files: [] },
                "Anthropic returns 400 on empty content.",
                dir,
            ),
        ).toBe(false);
        expect(
            shouldRequeueIndependentMapping(
                { hasSentinel: false, files: ["src/fact.ts"] },
                "Fact lives in src/fact.ts.",
                dir,
            ),
        ).toBe(false);
    });

    test("selectMapMemoryInputs re-queues the corrupted row and leaves the bystander mapped", () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-requeue";
            const dir = tempProject();
            const corrupted = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Fact lives in src/fact.ts.",
                sourceSessionId: "ses",
            });
            const bystander = insertMemory(db, {
                projectPath: projectIdentity,
                category: "CONSTRAINTS",
                content: "Anthropic returns 400 on empty content.",
                sourceSessionId: "ses",
            });
            recordMemoryMapping(db, corrupted.id, [], 1_000);
            recordMemoryMapping(db, bystander.id, [], 1_000);

            const selected = selectMapMemoryInputs(db, projectIdentity, dir);
            expect(selected.map((row) => row.id)).toEqual([corrupted.id]);
            expect(selected[0]?.candidates).toEqual(["src/fact.ts"]);

            const bystanderState = getMemoryVerifications(db, [bystander.id]).get(bystander.id);
            expect(bystanderState?.hasSentinel).toBe(true);
            expect(bystanderState?.files).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("map-memories module applier", () => {
    test("writes through memory.set_mapping using shared context row ids", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:module-map";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "The module owns this mapped memory.",
            });
            const calls: Array<{ method: string; body: unknown }> = [];
            const args = mapArgs(db, dir, projectIdentity);
            args.moduleRoute = {
                moduleClient: {
                    call: async (request) => {
                        calls.push(request);
                        return { accepted: [memory.id], rejected: [] };
                    },
                },
                moduleSessionId: "ses-module-map",
                moduleProjectRoot: dir,
                moduleCommandId: "map-command",
            };

            expect(
                await applyBatchMappings(
                    args,
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            candidates: [],
                        },
                    ],
                    `<mappings><memory id="${memory.id}" independent="true"/></mappings>`,
                ),
            ).toEqual({ mapped: 0, independent: 1 });
            expect(calls).toHaveLength(1);
            expect(calls[0]).toMatchObject({
                method: "memory.set_mapping",
                body: {
                    arguments: {
                        memory_project: projectIdentity,
                        rows: [
                            {
                                memory_id: memory.id,
                                content_hash_at_prompt: memory.normalizedHash,
                                mapped_files: null,
                            },
                        ],
                    },
                },
            });
            expect(getMemoryVerifications(db, [memory.id]).size).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("preserves host-rejected fallback origin through a MODULE mapping call", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:module-map-fallback";
            const dir = tempProject();
            execFileSync("git", ["init", "-q"], { windowsHide: true, cwd: dir });
            execFileSync("git", ["add", "src/fact.ts"], { windowsHide: true, cwd: dir });
            writeFileSync(
                path.join(dir, "src", "untracked.ts"),
                "export const draft = true;",
                "utf8",
            );
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "The module-owned fact references a rejected path.",
            });
            const calls: Array<{ method: string; body: unknown }> = [];
            const args = mapArgs(db, dir, projectIdentity);
            args.moduleRoute = {
                moduleClient: {
                    call: async (request) => {
                        calls.push(request);
                        return { accepted: [memory.id], rejected: [] };
                    },
                },
                moduleSessionId: "ses-module-map-fallback",
                moduleProjectRoot: dir,
                moduleCommandId: "map-fallback-command",
            };

            expect(
                await applyBatchMappings(
                    args,
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            candidates: [],
                        },
                    ],
                    `<mappings><memory id="${memory.id}" files="src/untracked.ts,/outside-project/fact.ts"/></mappings>`,
                ),
            ).toEqual({ mapped: 0, independent: 1 });
            expect(calls).toHaveLength(1);
            expect(calls[0]).toMatchObject({
                method: "memory.set_mapping",
                body: {
                    arguments: {
                        memory_project: projectIdentity,
                        rows: [
                            {
                                memory_id: memory.id,
                                content_hash_at_prompt: memory.normalizedHash,
                                mapped_files: null,
                                mapping_origin: "host_rejected_fallback",
                            },
                        ],
                    },
                },
            });
            expect(getMemoryVerifications(db, [memory.id]).size).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });
    test("overrides directive file mappings before a MODULE mapping call", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:module-map-directive";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "PROJECT_RULES",
                content: "When told to inspect a fact, run src/fact.ts first.",
            });
            const calls: Array<{ method: string; body: unknown }> = [];
            const args = mapArgs(db, dir, projectIdentity);
            args.moduleRoute = {
                moduleClient: {
                    call: async (request) => {
                        calls.push(request);
                        return { accepted: [memory.id], rejected: [] };
                    },
                },
                moduleSessionId: "ses-module-map-directive",
                moduleProjectRoot: dir,
                moduleCommandId: "map-directive-command",
            };

            expect(
                await applyBatchMappings(
                    args,
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            candidates: ["src/fact.ts"],
                        },
                    ],
                    `<mappings><memory id="${memory.id}" files="src/fact.ts"/></mappings>`,
                ),
            ).toEqual({ mapped: 0, independent: 1 });
            expect(calls[0]).toMatchObject({
                method: "memory.set_mapping",
                body: {
                    arguments: {
                        rows: [
                            {
                                memory_id: memory.id,
                                mapped_files: null,
                                mapping_origin: "host_rejected_fallback",
                            },
                        ],
                    },
                },
            });
        } finally {
            closeQuietly(db);
        }
    });
});
test("a budget-finalized mapping manifest banks its closed subset", async () => {
    const db = freshDb();
    try {
        const projectIdentity = "git:budget-map";
        const dir = tempProject();
        const memory = insertMemory(db, {
            projectPath: projectIdentity,
            category: "ARCHITECTURE",
            content: "Budgeted mapping fact.",
        });
        const others = Array.from({ length: 51 }, (_, index) =>
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: `Another mapping fact ${index} for the next run.`,
            }),
        );
        const covered = selectMapMemoryInputs(db, projectIdentity, dir).slice(0, 2);
        const messages: unknown[] = [];
        let sends = 0;
        let aborted = false;
        const args = mapArgs(db, dir, projectIdentity);
        args.tokenBudget = 100;
        args.deadline = Date.now() + MAP_BATCH_FLOOR_MS + 500;
        args.parentSessionId = "ses-parent-map";
        args.client = {
            session: {
                create: async () => ({ data: { id: "map-budget-child" } }),
                messages: async () => ({ data: [...messages] }),
                abort: async () => {
                    aborted = true;
                    return { data: true };
                },
                status: async () => {
                    if (sends === 1 && !aborted) {
                        if (messages.length === 1)
                            messages.push({
                                info: {
                                    id: "step",
                                    role: "assistant",
                                    finish: "tool-calls",
                                    tokens: { input: 81 },
                                    time: { created: 1, completed: 2 },
                                },
                                parts: [{ type: "tool" }],
                            });
                        return { data: { "map-budget-child": { type: "busy" } } };
                    }
                    if (sends === 2 && messages.length === 3)
                        messages.push({
                            info: {
                                id: "final",
                                role: "assistant",
                                finish: "stop",
                                tokens: { input: 25 },
                                time: { created: 3, completed: 4 },
                            },
                            parts: [
                                {
                                    type: "text",
                                    text: `<mappings>${covered.map((item) => `<memory id="${item.id}" files="src/fact.ts"/>`).join("")}</mappings>`,
                                },
                            ],
                        });
                    return { data: {} };
                },
                promptAsync: async (request: { body: { parts: Array<{ text: string }> } }) => {
                    sends++;
                    messages.push({
                        info: { id: `user-${sends}`, role: "user" },
                        parts: request.body.parts,
                    });
                    return { data: undefined };
                },
                delete: async () => ({}),
            },
        } as never;
        const result = await mapMemories(args);
        expect(sends).toBe(2);
        expect(result.mapped).toBe(2);
        expect(result.remaining).toBe(50);
        expect(result.complete).toBe(false);
        expect(
            selectMapMemoryInputs(db, projectIdentity, dir)
                .map((item) => item.id)
                .sort((a, b) => a - b),
        ).toEqual(
            [memory, ...others]
                .filter((item) => !covered.some((entry) => entry.id === item.id))
                .map((item) => item.id)
                .sort((a, b) => a - b),
        );
        for (const item of covered) {
            expect(getMemoryVerifications(db, [item.id]).get(item.id)?.files).toEqual([
                "src/fact.ts",
            ]);
        }
    } finally {
        closeQuietly(db);
    }
});

test("a wrong-root finalize refuses fallback without claiming a retry and preserves earlier mappings", async () => {
    const db = freshDb();
    const log = spyOn(logger, "log").mockImplementation(() => {});
    try {
        const projectIdentity = "git:wrong-root-budget-map";
        const dir = tempProject();
        for (let index = 0; index < 15; index++)
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: `Mapping fact ${index}.`,
            });
        const inputs = selectMapMemoryInputs(db, projectIdentity, dir);
        const messages: unknown[] = [];
        const models: unknown[] = [];
        const states: Array<{ spent: number; finalizeFired: boolean }> = [];
        let children = 0;
        let sends = 0;
        let aborted = false;
        let batchIds: number[] = [];
        const args = mapArgs(db, dir, projectIdentity);
        args.tokenBudget = 2_500_000;
        args.model = "nvidia/nemotron";
        args.fallbackModels = ["other/fallback"];
        args.onBudgetUpdate = (state) => states.push(state);
        args.client = {
            session: {
                create: async () => {
                    children++;
                    sends = 0;
                    aborted = false;
                    messages.length = 0;
                    return { data: { id: `map-budget-child-${children}` } };
                },
                messages: async () => ({ data: [...messages] }),
                abort: async () => {
                    aborted = true;
                    return { data: true };
                },
                status: async () => {
                    if (sends === 1 && !aborted) {
                        if (messages.length === 1)
                            messages.push({
                                info: {
                                    id: "step",
                                    role: "assistant",
                                    finish: "tool-calls",
                                    tokens: { input: children === 1 ? 2_035_462 : 2_055_519 },
                                    time: { completed: 1 },
                                },
                                parts: [{ type: "tool" }],
                            });
                        return { data: { [`map-budget-child-${children}`]: { type: "busy" } } };
                    }
                    if (sends === 2 && messages.length === 3) {
                        const root = children === 1 ? "mappings" : "branch";
                        messages.push({
                            info: {
                                id: "final",
                                role: "assistant",
                                finish: "stop",
                                tokens: { input: children === 1 ? 100_000 : 110_593 },
                                time: { completed: 2 },
                            },
                            parts: [
                                {
                                    type: "text",
                                    text: `<${root}>${batchIds.map((id) => `<memory id="${id}" files="src/fact.ts"/>`).join("")}</${root}>`,
                                },
                            ],
                        });
                    }
                    return { data: {} };
                },
                promptAsync: async (request: {
                    body: { model: unknown; parts: Array<{ text: string }> };
                }) => {
                    sends++;
                    models.push(request.body.model);
                    const text = request.body.parts[0]?.text ?? "";
                    if (sends === 1)
                        batchIds = [...text.matchAll(/^\[(\d+)\]/gm)].map((match) =>
                            Number(match[1]),
                        );
                    else expect(text).toBe(TOKEN_BUDGET_FINALIZE_MESSAGE);
                    messages.push({
                        info: { id: `user-${sends}`, role: "user" },
                        parts: request.body.parts,
                    });
                    return { data: undefined };
                },
                delete: async () => ({}),
            },
        } as never;

        let failure: unknown;
        try {
            await mapMemories(args);
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(DreamTokenBudgetExceeded);
        expect(failure).toMatchObject({ sessionId: "map-budget-child-2", spent: 2_166_112 });
        expect(states.at(-1)).toMatchObject({
            spent: 2_166_112,
            finalizeFired: true,
            hardStopped: false,
        });
        // Finalization closes the child to retries even below the numeric hard cap.
        expect(children).toBe(2);
        expect(models).toEqual(Array(4).fill({ providerID: "nvidia", modelID: "nemotron" }));
        const logs = log.mock.calls.map(([message]) => message);
        expect(logs).toContain(
            "[dreamer:map-memories] primary (nvidia/nemotron) failed validation/prompt: root <branch> unrecognized; expected <mappings> with <memory> entries; 1 fallback(s) configured, subject to remaining budget",
        );
        expect(logs.some((message) => message.includes("trying 1 fallback(s)"))).toBe(false);
        expect(logs).toContain(
            "[dreamer] map-memories: accepted partial manifest after token budget: 0/5",
        );
        const verifications = getMemoryVerifications(
            db,
            inputs.map((memory) => memory.id),
        );
        for (const memory of inputs.slice(0, 5))
            expect(verifications.get(memory.id)?.files).toEqual(["src/fact.ts"]);
        for (const memory of inputs.slice(5)) expect(verifications.has(memory.id)).toBe(false);
        expect(selectMapMemoryInputs(db, projectIdentity, dir).map((memory) => memory.id)).toEqual(
            inputs.slice(5).map((memory) => memory.id),
        );
    } finally {
        log.mockRestore();
        closeQuietly(db);
    }
}, 15_000);

test("non-budget mapping rejects a 10/52 manifest without writes", async () => {
    const db = freshDb();
    try {
        const project = "git:non-budget-map";
        const dir = tempProject();
        const items = Array.from({ length: 52 }, (_, index) =>
            insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: `Fact ${index}.`,
            }),
        );
        const args = mapArgs(db, dir, project);
        await expect(
            applyBatchMappings(
                args,
                selectMapMemoryInputs(db, project, dir),
                `<mappings>${items
                    .slice(0, 10)
                    .map((item) => `<memory id="${item.id}" files="src/fact.ts"/>`)
                    .join("")}</mappings>`,
            ),
        ).rejects.toThrow("rejecting mostly-wrong manifest");
        expect(selectMapMemoryInputs(db, project, dir)).toHaveLength(52);
    } finally {
        closeQuietly(db);
    }
});

describe("map-memories whitespace-only output (regression: whitespace must not defeat validation)", () => {
    const VALID = `<mappings><memory id="1" independent="true"/><memory id="2" files="src/fact.ts"/></mappings>`;
    const IDS = new Set([1, 2]);
    const wsMsg = {
        info: { role: "assistant" },
        parts: [{ type: "text", text: "\n\n\n\n\n\n\n" }],
    };
    const manifestMsg = { info: { role: "assistant" }, parts: [{ type: "text", text: VALID }] };
    const toolMsg = {
        info: { role: "assistant" },
        parts: [{ type: "tool", tool: "grep", state: { status: "completed", input: {} } }],
    };
    const ids = (parsed: { id: number }[]) => parsed.map((entry) => entry.id);

    // Hidden completion path: final documents stand alone; fragments use the transcript.
    test("falls back to completion.text when messages are whitespace-only (the fix)", () => {
        expect(ids(parseMapMemoriesCompletion(VALID, { messages: [wsMsg] }, IDS))).toEqual([1, 2]);
    });
    test("falls back to completion.text when messages are empty", () => {
        expect(ids(parseMapMemoriesCompletion(VALID, { messages: [] }, IDS))).toEqual([1, 2]);
    });
    test("falls back to completion.text for tool-loop messages that carry no text part", () => {
        expect(ids(parseMapMemoriesCompletion(VALID, { messages: [toolMsg] }, IDS))).toEqual([
            1, 2,
        ]);
    });
    test("a complete final manifest wins over stale nonempty transcript text", () => {
        const stale = {
            info: { role: "assistant" },
            parts: [
                { type: "text", text: '<mappings><memory id="99" independent="true"/></mappings>' },
            ],
        };
        expect(ids(parseMapMemoriesCompletion(VALID, { messages: [stale] }, IDS))).toEqual([1, 2]);
    });
    test("an incomplete replacement is not rescued by an earlier complete manifest", () => {
        expect(() =>
            parseMapMemoriesCompletion("<mappings>", { messages: [manifestMsg] }, IDS),
        ).toThrow("missing closing root tag");
    });
    test("prefers a real manifest carried by messages over completion.text (priority preserved)", () => {
        const fromMessages = `<mappings><memory id="3" independent="true"/></mappings>`;
        const parsed = parseMapMemoriesCompletion(
            "ignored-text",
            {
                messages: [
                    { info: { role: "assistant" }, parts: [{ type: "text", text: fromMessages }] },
                ],
            },
            new Set([3]),
        );
        expect(ids(parsed)).toEqual([3]);
    });
    test("still rejects when neither messages nor completion.text carry a manifest", () => {
        expect(() => parseMapMemoriesCompletion("", { messages: [wsMsg] }, IDS)).toThrow();
    });

    // Client path (validateOutput: assistantText(messages), no completion.text fallback).
    test("rejects whitespace-only output as 'no output' rather than 'missing complete root' (the fix)", () => {
        expect(() => validateClientMapMemories([wsMsg], IDS)).toThrow(
            "map-memories returned no output",
        );
    });
    test("rejects empty output as 'no output'", () => {
        expect(() => validateClientMapMemories([], IDS)).toThrow("map-memories returned no output");
    });
    test("rejects tool-only output as 'no output' (client path has no fallback)", () => {
        expect(() => validateClientMapMemories([toolMsg], IDS)).toThrow(
            "map-memories returned no output",
        );
    });
    test("accepts a valid manifest from messages", () => {
        expect(ids(validateClientMapMemories([manifestMsg], IDS))).toEqual([1, 2]);
    });
    test("falls back to completion.text when completion carries no messages field (undefined, not [])", () => {
        expect(ids(parseMapMemoriesCompletion(VALID, {}, IDS))).toEqual([1, 2]);
    });
    test("concatenates multiple text parts and still validates the manifest (un-trimmed join preserved)", () => {
        const mixed = {
            info: { role: "assistant" },
            parts: [
                { type: "text", text: "\n\n" },
                { type: "text", text: VALID },
            ],
        };
        expect(ids(parseMapMemoriesCompletion("ignored", { messages: [mixed] }, IDS))).toEqual([
            1, 2,
        ]);
    });
    test("client path rejects length-capped output before parsing (preserved guard)", () => {
        const capped = {
            info: { role: "assistant" },
            parts: [{ type: "text", text: VALID }],
            lengthCapped: true,
        };
        expect(() => validateClientMapMemories([capped], IDS)).toThrow(
            "map-memories returned length-capped output",
        );
    });
});
