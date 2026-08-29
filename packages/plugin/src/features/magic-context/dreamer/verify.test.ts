/// <reference types="bun-types" />

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as logger from "../../../shared/logger";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import {
    getProjectEmbeddings,
    insertMemory,
    loadAllEmbeddings,
    peekProjectEmbeddings,
    resetEmbeddingCacheForTests,
    saveEmbedding,
} from "../memory";
import { getMemoryById } from "../memory/storage-memory";
import {
    getMemoryVerifications,
    recordMemoryVerifications,
} from "../memory/storage-memory-verifications";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { acquireLease } from "./lease";
import { DreamerProviderOutputFailureError } from "./provider-output-failure";
import { getTaskScheduleState, seedTaskScheduleState } from "./storage-task-schedule";
import { applyVerifyManifest, runVerify, type VerifyArgs } from "./verify";

const tempDirs: string[] = [];

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function tempProject(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "mc-verify-"));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "old.ts"), "export const oldValue = 1;", "utf8");
    writeFileSync(path.join(dir, "src", "new.ts"), "export const newValue = 2;", "utf8");
    return dir;
}

function gitProject(): string {
    const dir = tempProject();
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync(
        "git",
        [
            "-c",
            "user.name=Magic Context Tests",
            "-c",
            "user.email=tests@example.com",
            "commit",
            "--quiet",
            "-m",
            "Initial source",
        ],
        {
            cwd: dir,
            env: {
                ...process.env,
                GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
                GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
            },
        },
    );
    return dir;
}

function verifyArgs(db: Database, sessionDirectory: string, projectIdentity: string): VerifyArgs {
    const holderId = "verify-holder";
    const leaseKey = `verify-${Math.random()}`;
    expect(acquireLease(db, holderId, leaseKey)).toBe(true);
    return {
        db,
        client: {} as never,
        projectIdentity,
        parentSessionId: undefined,
        sessionDirectory,
        holderId,
        leaseKey,
        deadline: Date.now() + 60_000,
    };
}

afterEach(() => {
    resetEmbeddingCacheForTests();
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

function tokenizedAssistantMessages(
    text: string,
    created: number,
    tokens: { output: number; reasoning: number },
) {
    return [
        {
            info: {
                role: "assistant",
                time: { created },
                finish: "stop",
                error: null,
                tokens,
            },
            parts: [{ type: "text", text }],
        },
    ];
}

type ScriptedVerifyResponse =
    | { kind: "manifest" }
    | { kind: "provider-failure"; text: string }
    | { kind: "text"; text: string; tokens?: { output: number; reasoning: number } };

function scriptedVerifyClient(
    responseFor: (promptCall: number, ids: number[]) => ScriptedVerifyResponse,
): {
    client: unknown;
    promptCalls: () => number;
    promptIds: () => number[][];
} {
    let promptCalls = 0;
    let childCount = 0;
    const promptedIds: number[][] = [];
    const messages = new Map<string, unknown[]>();
    return {
        client: {
            session: {
                create: async () => ({ data: { id: `verify-child-${++childCount}` } }),
                prompt: async (args: {
                    path?: { id?: string };
                    body?: { parts?: Array<{ text?: string }> };
                }) => {
                    promptCalls += 1;
                    const prompt = args.body?.parts?.[0]?.text ?? "";
                    const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) =>
                        Number(match[1]),
                    );
                    promptedIds.push(ids);
                    const response = responseFor(promptCalls, ids);
                    const text =
                        response.kind === "manifest"
                            ? `<verify>${ids.map((id) => `<verified id="${id}"/>`).join("")}</verify>`
                            : response.text;
                    const tokens =
                        response.kind === "manifest"
                            ? { output: Math.max(40, ids.length * 4), reasoning: 100 }
                            : response.kind === "provider-failure"
                              ? { output: 8, reasoning: 0 }
                              : (response.tokens ?? { output: 40, reasoning: 100 });
                    messages.set(
                        args.path?.id ?? "",
                        tokenizedAssistantMessages(text, promptCalls, tokens),
                    );
                    return {};
                },
                messages: async (args: { path?: { id?: string } }) => ({
                    data: messages.get(args.path?.id ?? "") ?? [],
                }),
                delete: async () => ({}),
            },
        },
        promptCalls: () => promptCalls,
        promptIds: () => promptedIds,
    };
}

function successfulVerifyClient(onPrompt?: () => void) {
    let manifest = "";
    return {
        session: {
            create: async () => ({ data: { id: "verify-child" } }),
            prompt: async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                const prompt = args.body?.parts?.[0]?.text ?? "";
                const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
                // Omit files from the synthetic manifest to avoid filesystem/Git
                // normalization; mappings recorded before the run still select each batch.
                manifest = `<verify>${ids.map((id) => `<verified id="${id}"/>`).join("")}</verify>`;
                onPrompt?.();
                return {};
            },
            messages: async () => ({ data: assistantMessages(manifest) }),
            delete: async () => ({}),
        },
    };
}

function addMappedMemories(db: Database, projectIdentity: string, count: number): void {
    for (let index = 0; index < count; index += 1) {
        const memory = insertMemory(db, {
            projectPath: projectIdentity,
            category: "ARCHITECTURE",
            content: `Mapped fact ${index}.`,
            sourceSessionId: "ses",
        });
        recordMemoryVerifications(db, memory.id, ["src/old.ts"], 1_000);
    }
}

describe("verify authority applier", () => {
    test("writes through memory.set_verification under MODULE authority without mutating the mirror", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:module-verify";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "The module owns this verified memory.",
            });
            db.prepare(
                "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', ?, 202, ?)",
            ).run(projectIdentity, memory.id);
            db.prepare(
                "INSERT INTO mirror_live_memory_rows(module_project, module_row_id, category, normalized_hash) VALUES (?, 202, ?, ?)",
            ).run(projectIdentity, memory.category, memory.normalizedHash);
            const calls: Array<{ method: string; body: unknown }> = [];
            const args = verifyArgs(db, dir, projectIdentity);
            args.moduleRoute = {
                moduleClient: {
                    call: async (request) => {
                        calls.push(request);
                        return { accepted: [202], rejected: [] };
                    },
                },
                moduleSessionId: "ses-module-verify",
                moduleProjectRoot: dir,
                moduleContextStoreUuid: "store-fixture",
                moduleAuthorityGeneration: 9,
                moduleCommandId: "verify-command",
            };

            expect(
                await applyVerifyManifest(
                    args,
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            mappedFiles: ["src/old.ts"],
                        },
                    ],
                    `<verify><verified id="${memory.id}" files="src/old.ts"/></verify>`,
                ),
            ).toEqual({ verified: 1, updated: 0, archived: 0, skipped: 0, refused: 0 });
            expect(calls).toHaveLength(1);
            expect(calls[0]).toMatchObject({
                method: "memory.set_verification",
                body: {
                    arguments: {
                        memory_project: projectIdentity,
                        authority_generation: 9,
                        rows: [
                            {
                                memory_id: 202,
                                content_hash_at_prompt: memory.normalizedHash,
                                verification_status: "verified",
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

    test("refuses a directive archive before the MODULE authority call", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:module-verify-directive";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "PROJECT_RULES",
                content: "Never archive workflow rules because a named file omits them.",
            });
            const calls: unknown[] = [];
            const args = verifyArgs(db, dir, projectIdentity);
            args.moduleRoute = {
                moduleClient: {
                    call: async (request) => {
                        calls.push(request);
                        return { accepted: [], rejected: [] };
                    },
                },
                moduleSessionId: "ses-module-verify-directive",
                moduleProjectRoot: dir,
                moduleContextStoreUuid: "store-fixture",
                moduleAuthorityGeneration: 10,
                moduleCommandId: "verify-directive-command",
            };

            expect(
                await applyVerifyManifest(
                    args,
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            mappedFiles: ["src/old.ts"],
                        },
                    ],
                    `<verify><archive id="${memory.id}" reason="file does not corroborate it"/></verify>`,
                ),
            ).toEqual({ verified: 0, updated: 0, archived: 0, skipped: 0, refused: 1 });
            expect(calls).toEqual([]);
            expect(getMemoryById(db, memory.id)?.status).toBe("active");
        } finally {
            closeQuietly(db);
        }
    });
});

describe("runVerify disposition", () => {
    test("banks a completed batch and reports the deadline remainder", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-deadline";
            const dir = tempProject();
            addMappedMemories(db, projectIdentity, 51);
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = successfulVerifyClient(() => {
                args.deadline = Date.now() - 1;
            }) as never;

            const result = await runVerify(args);

            expect(result.verified).toBe(50);
            expect(result.remaining).toBe(1);
            expect(result.complete).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("reports complete after fully draining the selected set", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-complete";
            const dir = tempProject();
            addMappedMemories(db, projectIdentity, 1);
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = successfulVerifyClient() as never;

            const result = await runVerify(args);
            expect(result.verified).toBe(1);
            expect(result.remaining).toBe(0);
            expect(result.complete).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test("refuses a directive archive, logs it, and completes the run as a skip", async () => {
        const db = freshDb();
        const logSpy = spyOn(logger, "log").mockImplementation(() => {});
        try {
            const projectIdentity = "git:verify-directive-refusal";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "PROJECT_RULES",
                content:
                    "When told to check a cache bust, run src/old.ts first and never reason by hand.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, memory.id, ["src/old.ts"], 1_000);
            const scripted = scriptedVerifyClient(() => ({
                kind: "text",
                text: `<verify><archive id="${memory.id}" reason="file does not corroborate the rule"/></verify>`,
            }));
            const progress: Array<{ processed: number; refused: number }> = [];
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = scripted.client as never;
            args.onProgress = (processed, refused) => progress.push({ processed, refused });

            const result = await runVerify(args);

            expect(result).toMatchObject({
                archived: 0,
                refused: 1,
                remaining: 0,
                complete: true,
            });
            expect(progress).toEqual([{ processed: 1, refused: 1 }]);
            expect(getMemoryById(db, memory.id)?.status).toBe("active");
            expect(getMemoryVerifications(db, [memory.id]).get(memory.id)?.verifiedAt).toBe(1_000);
            expect(
                logSpy.mock.calls.some(
                    ([message]) =>
                        typeof message === "string" &&
                        message.includes(`memory_id=${memory.id} verdict=archive`) &&
                        message.includes("reason=directive-shaped-project-rule"),
                ),
            ).toBe(true);
        } finally {
            logSpy.mockRestore();
            closeQuietly(db);
        }
    });

    test("still archives changed-file code facts, including the PROJECT_RULES boundary", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-code-fact-archive";
            const dir = gitProject();
            const constraint = insertMemory(db, {
                projectPath: projectIdentity,
                category: "CONSTRAINTS",
                content: "oldValue is exported as 1 from src/old.ts.",
                sourceSessionId: "ses",
            });
            const projectRuleCodeFact = insertMemory(db, {
                projectPath: projectIdentity,
                category: "PROJECT_RULES",
                content: "binds use spread args when invoking registered callbacks.",
                sourceSessionId: "ses",
            });
            for (const memory of [constraint, projectRuleCodeFact]) {
                recordMemoryVerifications(db, memory.id, ["src/old.ts"], Date.now());
            }
            writeFileSync(path.join(dir, "src", "old.ts"), "export const replacement = 2;", "utf8");
            const scripted = scriptedVerifyClient((_call, ids) => ({
                kind: "text",
                text: `<verify>${ids
                    .map(
                        (id) => `<archive id="${id}" reason="the mapped export no longer exists"/>`,
                    )
                    .join("")}</verify>`,
            }));
            const args = verifyArgs(db, dir, projectIdentity);
            args.client = scripted.client as never;

            const result = await runVerify(args);

            expect(scripted.promptIds()).toEqual([[constraint.id, projectRuleCodeFact.id]]);
            expect(result).toMatchObject({
                archived: 2,
                refused: 0,
                remaining: 0,
                complete: true,
            });
            expect(getMemoryById(db, constraint.id)?.status).toBe("archived");
            expect(getMemoryById(db, projectRuleCodeFact.id)?.status).toBe("archived");
        } finally {
            closeQuietly(db);
        }
    });

    test("commits a closed subset and re-selects only its silent id on the next verify run", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-partial-resume";
            const dir = gitProject();
            const first = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "First verified fact.",
                sourceSessionId: "ses",
            });
            const silent = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Silent verified fact.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, first.id, ["src/old.ts"], 1_000);
            recordMemoryVerifications(db, silent.id, ["src/old.ts"], 1_000);

            const args = verifyArgs(db, dir, projectIdentity);
            const partial = scriptedVerifyClient((_call, ids) => {
                expect([...ids].sort((a, b) => a - b)).toEqual(
                    [first.id, silent.id].sort((a, b) => a - b),
                );
                return {
                    kind: "text",
                    text: `<verify><verified id="${first.id}" files="src/old.ts"/></verify>`,
                };
            });
            args.client = partial.client as never;

            const firstRun = await runVerify(args);

            expect(firstRun).toMatchObject({ verified: 1, remaining: 1, complete: false });
            const afterFirst = getMemoryVerifications(db, [first.id, silent.id]);
            expect(afterFirst.get(first.id)?.verifiedAt).toBeGreaterThan(1_000);
            expect(afterFirst.get(silent.id)?.verifiedAt).toBe(1_000);

            const resumed = scriptedVerifyClient((_call, ids) => {
                expect(ids).toEqual([silent.id]);
                return {
                    kind: "text",
                    text: `<verify><verified id="${silent.id}" files="src/old.ts"/></verify>`,
                };
            });
            args.client = resumed.client as never;

            const secondRun = await runVerify(args);

            expect(resumed.promptIds()).toEqual([[silent.id]]);
            expect(secondRun).toMatchObject({
                inScope: 1,
                verified: 1,
                remaining: 0,
                complete: true,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("commits a closed subset and re-selects only its silent id in verify-broad", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-broad-partial-resume";
            const dir = tempProject();
            const first = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "First broad fact.",
                sourceSessionId: "ses",
            });
            const silent = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Silent broad fact.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, first.id, ["src/old.ts"], 1_000);
            recordMemoryVerifications(db, silent.id, ["src/old.ts"], 1_000);
            seedTaskScheduleState(db, projectIdentity, "verify-broad", null, null, "0 3 * * 0");

            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            const partial = scriptedVerifyClient((_call, ids) => {
                expect([...ids].sort((a, b) => a - b)).toEqual(
                    [first.id, silent.id].sort((a, b) => a - b),
                );
                return {
                    kind: "text",
                    text: `<verify><verified id="${first.id}" files="src/old.ts"/></verify>`,
                };
            });
            args.client = partial.client as never;

            const firstRun = await runVerify(args);

            expect(firstRun).toMatchObject({
                mode: "broad",
                verified: 1,
                remaining: 1,
                complete: false,
            });
            expect(getMemoryVerifications(db, [silent.id]).get(silent.id)?.verifiedAt).toBe(1_000);

            const resumed = scriptedVerifyClient((_call, ids) => {
                expect(ids).toEqual([silent.id]);
                return {
                    kind: "text",
                    text: `<verify><verified id="${silent.id}" files="src/old.ts"/></verify>`,
                };
            });
            args.client = resumed.client as never;

            const secondRun = await runVerify(args);

            expect(resumed.promptIds()).toEqual([[silent.id]]);
            expect(secondRun).toMatchObject({
                mode: "broad",
                inScope: 1,
                verified: 1,
                complete: true,
            });
            expect(
                getTaskScheduleState(db, projectIdentity, "verify-broad")?.lastBroadRunAt,
            ).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("continues a broad cycle across deadlines and closes it on the final run", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-broad-cycle";
            const dir = tempProject();
            addMappedMemories(db, projectIdentity, 51);
            seedTaskScheduleState(db, projectIdentity, "verify-broad", null, null, "0 3 * * 0");
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = successfulVerifyClient(() => {
                args.deadline = Date.now() - 1;
            }) as never;

            const first = await runVerify(args);
            expect(first.verified).toBe(50);
            expect(first.remaining).toBe(1);
            expect(first.complete).toBe(false);
            const cycleStart = getTaskScheduleState(
                db,
                projectIdentity,
                "verify-broad",
            )?.lastBroadRunAt;
            expect(cycleStart).toBeGreaterThan(0);

            args.deadline = Date.now() + 60_000;
            args.client = successfulVerifyClient() as never;
            const second = await runVerify(args);
            expect(second.verified).toBe(1);
            expect(second.remaining).toBe(0);
            expect(second.complete).toBe(true);
            expect(
                getTaskScheduleState(db, projectIdentity, "verify-broad")?.lastBroadRunAt,
            ).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("classifies outage text before manifest parsing and retries every fallback model", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-provider-outage";
            const dir = tempProject();
            addMappedMemories(db, projectIdentity, 1);
            seedTaskScheduleState(db, projectIdentity, "verify-broad", null, null, "0 3 * * 0");
            const scripted = scriptedVerifyClient(() => ({
                kind: "provider-failure",
                text: "All Antigravity endpoints failed",
            }));
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.model = "antigravity/primary";
            args.fallbackModels = ["antigravity/fallback-a", "antigravity/fallback-b"];
            args.client = scripted.client as never;

            let failure: unknown;
            try {
                await runVerify(args);
            } catch (error) {
                failure = error;
            }

            expect(failure).toBeInstanceOf(DreamerProviderOutputFailureError);
            expect(String(failure)).toContain("provider-outage completion");
            expect(String(failure)).not.toContain("manifest missing");
            expect(scripted.promptCalls()).toBe(3);
            expect(
                getTaskScheduleState(db, projectIdentity, "verify-broad")?.lastBroadRunAt,
            ).toBeGreaterThan(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("classifies a closed partial outage fragment before it can apply", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-partial-provider-outage";
            const dir = tempProject();
            const first = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "First outage fact.",
                sourceSessionId: "ses",
            });
            const silent = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Silent outage fact.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, first.id, ["src/old.ts"], 1_000);
            recordMemoryVerifications(db, silent.id, ["src/old.ts"], 1_000);
            const scripted = scriptedVerifyClient(() => ({
                kind: "provider-failure",
                text: `<verify><verified id="${first.id}" files="src/old.ts"/></verify>`,
            }));
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = scripted.client as never;

            await expect(runVerify(args)).rejects.toBeInstanceOf(DreamerProviderOutputFailureError);

            expect(scripted.promptCalls()).toBe(1);
            expect(getMemoryById(db, first.id)?.status).toBe("active");
            expect(getMemoryVerifications(db, [first.id]).get(first.id)?.verifiedAt).toBe(1_000);
            expect(getMemoryVerifications(db, [silent.id]).get(silent.id)?.verifiedAt).toBe(1_000);
        } finally {
            closeQuietly(db);
        }
    });

    test("aborts after two identical provider-failure batches", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-provider-circuit";
            const dir = tempProject();
            addMappedMemories(db, projectIdentity, 101);
            seedTaskScheduleState(db, projectIdentity, "verify-broad", null, null, "0 3 * * 0");
            const scripted = scriptedVerifyClient(() => ({
                kind: "provider-failure",
                text: "All Antigravity endpoints failed",
            }));
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = scripted.client as never;

            await expect(runVerify(args)).rejects.toBeInstanceOf(DreamerProviderOutputFailureError);
            expect(scripted.promptCalls()).toBe(2);
        } finally {
            closeQuietly(db);
        }
    });

    test("banks completed batches before an outage and resumes the open broad cycle", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-provider-resume";
            const dir = tempProject();
            addMappedMemories(db, projectIdentity, 51);
            seedTaskScheduleState(db, projectIdentity, "verify-broad", null, null, "0 3 * * 0");
            const scripted = scriptedVerifyClient((promptCall) =>
                promptCall === 1
                    ? { kind: "manifest" }
                    : {
                          kind: "provider-failure",
                          text: "All Antigravity endpoints failed",
                      },
            );
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = scripted.client as never;

            await expect(runVerify(args)).rejects.toBeInstanceOf(DreamerProviderOutputFailureError);
            expect(scripted.promptCalls()).toBe(2);
            const cycleStart = getTaskScheduleState(
                db,
                projectIdentity,
                "verify-broad",
            )?.lastBroadRunAt;
            expect(cycleStart).toBeGreaterThan(0);

            args.client = successfulVerifyClient() as never;
            args.deadline = Date.now() + 60_000;
            const resumed = await runVerify(args);
            expect(resumed.inScope).toBe(1);
            expect(resumed.verified).toBe(1);
            expect(resumed.remaining).toBe(0);
            expect(resumed.complete).toBe(true);
            expect(
                getTaskScheduleState(db, projectIdentity, "verify-broad")?.lastBroadRunAt,
            ).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("reports a swallowed batch failure as incomplete", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-failure";
            const dir = tempProject();
            addMappedMemories(db, projectIdentity, 1);
            seedTaskScheduleState(db, projectIdentity, "verify-broad", null, null, "0 3 * * 0");
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = {
                session: {
                    create: async () => {
                        throw new Error("provider unavailable");
                    },
                },
            } as never;

            const result = await runVerify(args);
            expect(result.complete).toBe(false);
            expect(result.remaining).toBe(1);
            expect(
                getTaskScheduleState(db, projectIdentity, "verify-broad")?.lastBroadRunAt,
            ).toBeGreaterThan(0);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("applyVerifyManifest", () => {
    test("treats an absent batch id as silence rather than verify or archive", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-silence";
            const dir = tempProject();
            const archived = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Archived fact.",
                sourceSessionId: "ses",
            });
            const silent = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Silent fact.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, archived.id, ["src/old.ts"], 1_000);
            recordMemoryVerifications(db, silent.id, ["src/old.ts"], 1_000);

            const result = await applyVerifyManifest(
                verifyArgs(db, dir, projectIdentity),
                [archived, silent].map((memory) => ({
                    id: memory.id,
                    category: memory.category,
                    content: memory.content,
                    mappedFiles: ["src/old.ts"],
                })),
                `<verify><archive id="${archived.id}" reason="positive contradiction"/></verify>`,
            );

            expect(result).toEqual({
                verified: 0,
                updated: 0,
                archived: 1,
                skipped: 0,
                refused: 0,
            });
            expect(getMemoryById(db, archived.id)?.status).toBe("archived");
            expect(getMemoryById(db, silent.id)?.status).toBe("active");
            const silentState = getMemoryVerifications(db, [silent.id]).get(silent.id);
            expect(silentState?.files).toEqual(["src/old.ts"]);
            expect(silentState?.verifiedAt).toBe(1_000);
        } finally {
            closeQuietly(db);
        }
    });

    test("drops unknown ids and commits the valid verification remainder", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-unknown";
            const dir = tempProject();
            const verified = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Verified fact.",
                sourceSessionId: "ses",
            });
            const silent = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Silent fact.",
                sourceSessionId: "ses",
            });
            const unknown = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Wrong batch fact.",
                sourceSessionId: "ses",
            });
            for (const memory of [verified, silent, unknown]) {
                recordMemoryVerifications(db, memory.id, ["src/old.ts"], 1_000);
            }

            const result = await applyVerifyManifest(
                verifyArgs(db, dir, projectIdentity),
                [verified, silent].map((memory) => ({
                    id: memory.id,
                    category: memory.category,
                    content: memory.content,
                    mappedFiles: ["src/old.ts"],
                })),
                `<verify><verified id="${verified.id}" files="src/old.ts"/><archive id="${unknown.id}" reason="wrong batch"/></verify>`,
            );

            expect(result).toEqual({
                verified: 1,
                updated: 0,
                archived: 0,
                skipped: 0,
                refused: 0,
            });
            expect(
                getMemoryVerifications(db, [verified.id]).get(verified.id)?.verifiedAt,
            ).toBeGreaterThan(1_000);
            expect(getMemoryVerifications(db, [silent.id]).get(silent.id)?.verifiedAt).toBe(1_000);
            expect(getMemoryById(db, unknown.id)?.status).toBe("active");
            expect(getMemoryVerifications(db, [unknown.id]).get(unknown.id)?.verifiedAt).toBe(
                1_000,
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("rejects a mostly-wrong manifest before any verification or archive writes", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-mostly-wrong";
            const dir = tempProject();
            const batch = ["First", "Second", "Third"].map((content) =>
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
                content: "Wrong batch fact.",
                sourceSessionId: "ses",
            });
            for (const memory of [...batch, unknown]) {
                recordMemoryVerifications(db, memory.id, ["src/old.ts"], 1_000);
            }

            await expect(
                applyVerifyManifest(
                    verifyArgs(db, dir, projectIdentity),
                    batch.map((memory) => ({
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        mappedFiles: ["src/old.ts"],
                    })),
                    `<verify><archive id="${batch[0]?.id}" reason="stale"/><verified id="${unknown.id}" files="src/old.ts"/></verify>`,
                ),
            ).rejects.toThrow(/mostly-wrong manifest/);

            for (const memory of [...batch, unknown]) {
                expect(getMemoryById(db, memory.id)?.status).toBe("active");
                expect(getMemoryVerifications(db, [memory.id]).get(memory.id)?.verifiedAt).toBe(
                    1_000,
                );
            }
        } finally {
            closeQuietly(db);
        }
    });

    test("refuses directive-shaped PROJECT_RULES updates before content rewrite", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-directive-update";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "PROJECT_RULES",
                content: "Always run src/old.ts first and brief workers with the complete result.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, memory.id, ["src/old.ts"], 1_000);

            const result = await applyVerifyManifest(
                verifyArgs(db, dir, projectIdentity),
                [
                    {
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        mappedFiles: ["src/old.ts"],
                    },
                ],
                `<verify><update id="${memory.id}" files="src/new.ts">The analyzer in src/new.ts returns a complete cache-bust result to every worker.</update></verify>`,
            );

            expect(result).toEqual({
                verified: 0,
                updated: 0,
                archived: 0,
                skipped: 0,
                refused: 1,
            });
            expect(getMemoryById(db, memory.id)?.content).toBe(memory.content);
            expect(getMemoryVerifications(db, [memory.id]).get(memory.id)?.verifiedAt).toBe(1_000);
        } finally {
            closeQuietly(db);
        }
    });

    test("refuses and audits a rewrite that drops more than half the original content", async () => {
        const db = freshDb();
        const logSpy = spyOn(logger, "log").mockImplementation(() => {});
        try {
            const projectIdentity = "git:verify-content-loss";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content:
                    "The cache verifier reads src/old.ts, compares every stored key, preserves the invalidation reason, and reports the complete mismatch before changing state.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, memory.id, ["src/old.ts"], 1_000);

            const result = await applyVerifyManifest(
                verifyArgs(db, dir, projectIdentity),
                [
                    {
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        mappedFiles: ["src/old.ts"],
                    },
                ],
                `<verify><update id="${memory.id}" files="src/new.ts">Uses src/new.ts.</update></verify>`,
            );

            expect(result).toEqual({
                verified: 0,
                updated: 0,
                archived: 0,
                skipped: 0,
                refused: 1,
            });
            expect(getMemoryById(db, memory.id)?.content).toBe(memory.content);
            expect(getMemoryVerifications(db, [memory.id]).get(memory.id)).toMatchObject({
                files: ["src/old.ts"],
                verifiedAt: 1_000,
            });
            expect(
                logSpy.mock.calls.some(
                    ([message]) =>
                        typeof message === "string" &&
                        message.includes(`memory_id=${memory.id} verdict=update`) &&
                        message.includes("reason=content-loss"),
                ),
            ).toBe(true);
        } finally {
            logSpy.mockRestore();
            closeQuietly(db);
        }
    });

    test("allows an explicitly marked consolidation to cross the content-loss belt", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-consolidation";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content:
                    "The cache verifier reads src/old.ts, compares every stored key, preserves the invalidation reason, and reports the complete mismatch before changing state.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, memory.id, ["src/old.ts"], 1_000);

            const result = await applyVerifyManifest(
                verifyArgs(db, dir, projectIdentity),
                [
                    {
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        mappedFiles: ["src/old.ts"],
                    },
                ],
                `<verify><update id="${memory.id}" files="src/new.ts" consolidation="true">Uses src/new.ts.</update></verify>`,
            );

            expect(result).toEqual({
                verified: 0,
                updated: 1,
                archived: 0,
                skipped: 0,
                refused: 0,
            });
            expect(getMemoryById(db, memory.id)?.content).toBe("Uses src/new.ts.");
        } finally {
            closeQuietly(db);
        }
    });

    test("content rewrites clear stale file mappings and embedding cache", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Old value lives in src/old.ts.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, memory.id, ["src/old.ts"], 1_000);
            saveEmbedding(db, memory.id, new Float32Array([1, 2, 3, 4]), "model-a");
            expect(getProjectEmbeddings(db, projectIdentity, "model-a").has(memory.id)).toBe(true);

            const result = await applyVerifyManifest(
                verifyArgs(db, dir, projectIdentity),
                [
                    {
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        mappedFiles: ["src/old.ts"],
                    },
                ],
                `<verify><update id="${memory.id}" files="src/new.ts">New value lives in src/new.ts.</update></verify>`,
            );

            expect(result).toEqual({
                verified: 0,
                updated: 1,
                archived: 0,
                skipped: 0,
                refused: 0,
            });
            expect(getMemoryById(db, memory.id)?.content).toBe("New value lives in src/new.ts.");
            expect(getMemoryVerifications(db, [memory.id]).has(memory.id)).toBe(false);
            expect(loadAllEmbeddings(db, projectIdentity, "model-a").has(memory.id)).toBe(false);
            expect(peekProjectEmbeddings(projectIdentity, "model-a")?.has(memory.id)).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("rejects conflicting terminal verdicts for the same memory id", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Old value lives in src/old.ts.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, memory.id, ["src/old.ts"], 1_000);

            await expect(
                applyVerifyManifest(
                    verifyArgs(db, dir, projectIdentity),
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            mappedFiles: ["src/old.ts"],
                        },
                    ],
                    `<verify><verified id="${memory.id}" files="src/old.ts"/><archive id="${memory.id}" reason="stale"/></verify>`,
                ),
            ).rejects.toThrow(/duplicate id/);

            expect(getMemoryById(db, memory.id)?.status).toBe("active");
            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state?.files).toEqual(["src/old.ts"]);
            expect(state?.verifiedAt).toBe(1_000);
        } finally {
            closeQuietly(db);
        }
    });

    test("rejects a missing root before any DB write", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-missing-root";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Old value lives in src/old.ts.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, memory.id, ["src/old.ts"], 1_000);

            await expect(
                applyVerifyManifest(
                    verifyArgs(db, dir, projectIdentity),
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            mappedFiles: ["src/old.ts"],
                        },
                    ],
                    `<archive id="${memory.id}" reason="stale"/>`,
                ),
            ).rejects.toThrow(/root <archive> unrecognized/);

            expect(getMemoryById(db, memory.id)?.status).toBe("active");
            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state?.files).toEqual(["src/old.ts"]);
            expect(state?.verifiedAt).toBe(1_000);
        } finally {
            closeQuietly(db);
        }
    });

    test("rejects a truncated manifest before any DB write", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Old value lives in src/old.ts.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, memory.id, ["src/old.ts"], 1_000);

            await expect(
                applyVerifyManifest(
                    verifyArgs(db, dir, projectIdentity),
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            mappedFiles: ["src/old.ts"],
                        },
                    ],
                    `<verify><archive id="${memory.id}" reason="stale"/>`,
                ),
            ).rejects.toThrow(/closing root/);

            expect(getMemoryById(db, memory.id)?.status).toBe("active");
            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state?.files).toEqual(["src/old.ts"]);
            expect(state?.verifiedAt).toBe(1_000);
        } finally {
            closeQuietly(db);
        }
    });
});
