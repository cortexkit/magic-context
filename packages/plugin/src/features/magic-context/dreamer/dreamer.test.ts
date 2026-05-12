/// <reference types="bun-types" />

import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";

const { initializeDatabase } = await import("../storage-db");
const { runMigrations } = await import("../migrations");

const { acquireLease, getLeaseHolder, isLeaseActive, releaseLease, renewLease } = await import(
    "./lease"
);
const { ensureDreamQueueTable, enqueueDream } = await import("./queue");
const { processDreamQueue, registerDreamProjectDirectory, runDream } = await import("./runner");
const { getDreamRuns } = await import("./storage-dream-runs");
const { getDreamState, setDreamState } = await import("./storage-dream-state");

let db: Database | null = null;

function createDreamClient(
    args: {
        createdSessionIds?: string[];
        promptOutputsBySession?: Map<string, string>;
        deletedSessionIds?: string[];
    } = {},
): PluginContext["client"] {
    let nextSessionId = 0;
    return {
        session: {
            create: mock(async () => {
                nextSessionId += 1;
                const id = `dream-${nextSessionId}`;
                args.createdSessionIds?.push(id);
                return { data: { id } };
            }),
            prompt: mock(async () => undefined),
            messages: mock(async (input: { path: { id: string } }) => ({
                data: [
                    {
                        info: {
                            role: "assistant",
                            time: { created: Date.now() },
                        },
                        parts: [
                            {
                                type: "text",
                                text:
                                    args.promptOutputsBySession?.get(input.path.id) ??
                                    `completed ${input.path.id}`,
                            },
                        ],
                    },
                ],
            })),
            delete: mock(async (input: { path: { id: string } }) => {
                args.deletedSessionIds?.push(input.path.id);
                return { data: undefined };
            }),
        },
    } as unknown as PluginContext["client"];
}

function createTestDb(): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    runMigrations(database);
    return database;
}

afterEach(() => {
    if (db) {
        try {
            closeQuietly(db);
        } catch {
        } finally {
            db = null;
        }
    }
});

afterAll(() => {
    mock.restore();
});

describe("dreamer", () => {
    describe("lease", () => {
        it("supports acquire, renew, and release cycle", () => {
            db = createTestDb();
            const nowSpy = spyOn(Date, "now");
            nowSpy.mockReturnValue(1_000);

            expect(acquireLease(db, "holder-a")).toBe(true);
            expect(isLeaseActive(db)).toBe(true);
            expect(getLeaseHolder(db)).toBe("holder-a");

            nowSpy.mockReturnValue(2_000);
            expect(renewLease(db, "holder-a")).toBe(true);
            expect(getDreamState(db, "dreaming_lease_heartbeat")).toBe("2000");
            expect(getDreamState(db, "dreaming_lease_expiry")).toBe(String(122_000));

            releaseLease(db, "holder-a");
            expect(isLeaseActive(db)).toBe(false);
            expect(getLeaseHolder(db)).toBeNull();
            nowSpy.mockRestore();
        });

        it("allows stale leases to be overridden", () => {
            db = createTestDb();
            const nowSpy = spyOn(Date, "now");
            nowSpy.mockReturnValue(1_000);
            expect(acquireLease(db, "holder-a")).toBe(true);

            nowSpy.mockReturnValue(122_001);
            expect(acquireLease(db, "holder-b")).toBe(true);
            expect(getLeaseHolder(db)).toBe("holder-b");
            nowSpy.mockRestore();
        });
    });

    describe("dream runner", () => {
        it("does not force-enqueue over an old started row while the lease is active", () => {
            db = createTestDb();
            ensureDreamQueueTable(db);

            expect(enqueueDream(db, "git:repo-1", "manual")).not.toBeNull();
            db.prepare("UPDATE dream_queue SET started_at = ? WHERE project_path = ?").run(
                Date.now() - 3 * 60 * 1000,
                "git:repo-1",
            );
            expect(acquireLease(db, "holder-a")).toBe(true);

            expect(enqueueDream(db, "git:repo-1", "manual", true)).toBeNull();

            const rows = db
                .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM dream_queue")
                .get();
            expect(rows?.count).toBe(1);
        });

        it("aborts remaining dream work when the lease is lost between tasks", async () => {
            db = createTestDb();
            const client = createDreamClient();
            let promptCalls = 0;
            const promptSyncSpy = spyOn(
                shared,
                "promptSyncWithModelSuggestionRetry",
            ).mockImplementation(async () => {
                promptCalls += 1;
                if (promptCalls === 1 && db) {
                    setDreamState(db, "dreaming_lease_holder", "stolen-holder");
                    setDreamState(db, "dreaming_lease_expiry", String(Date.now() + 120_000));
                }
            });

            try {
                const result = await runDream({
                    db,
                    client,
                    projectIdentity: "/repo/project",
                    tasks: ["consolidate", "verify"],
                    taskTimeoutMinutes: 5,
                    maxRuntimeMinutes: 10,
                    parentSessionId: "parent-1",
                    sessionDirectory: "/repo/project",
                });

                expect(promptSyncSpy).toHaveBeenCalledTimes(1);
                expect(result.tasks.map((task) => task.name)).toEqual([
                    "consolidate",
                    "lease-lost",
                ]);
                expect(result.tasks[1]?.error).toContain("Dream lease lost");
                expect(getDreamState(db, "last_dream_at")).toBeNull();
            } finally {
                promptSyncSpy.mockRestore();
            }
        });

        it("orchestrates llm dream tasks in order and releases the lease", async () => {
            db = createTestDb();
            const createdSessionIds: string[] = [];
            const deletedSessionIds: string[] = [];
            const client = createDreamClient({ createdSessionIds, deletedSessionIds });

            const result = await runDream({
                db,
                client,
                projectIdentity: "/repo/project",
                tasks: ["consolidate", "verify"],
                taskTimeoutMinutes: 5,
                maxRuntimeMinutes: 10,
                parentSessionId: "parent-1",
                sessionDirectory: "/repo/project",
            });

            expect(result.tasks.map((task) => task.name)).toEqual(["consolidate", "verify"]);
            expect(result.tasks.every((task) => task.durationMs >= 0)).toBe(true);
            expect(result.tasks.every((task) => typeof task.result === "string")).toBe(true);
            expect(getDreamState(db, "last_dream_at")).not.toBeNull();
            expect(isLeaseActive(db)).toBe(false);
            expect(createdSessionIds).toEqual(["dream-1", "dream-2"]);
            expect(deletedSessionIds).toEqual(["dream-1", "dream-2"]);

            const runs = getDreamRuns(db, "/repo/project");
            expect(runs).toHaveLength(1);
            expect(runs[0]?.tasks_succeeded).toBe(2);
            expect(runs[0]?.tasks_failed).toBe(0);
            expect(runs[0]?.smart_notes_surfaced).toBe(0);
            expect(runs[0]?.smart_notes_pending).toBe(0);
            expect(runs[0]?.memory_changes_json).toBeNull();
            expect(JSON.parse(runs[0]?.tasks_json ?? "[]")).toEqual([
                expect.objectContaining({
                    name: "consolidate",
                    durationMs: expect.any(Number),
                    resultChars: expect.any(Number),
                }),
                expect.objectContaining({
                    name: "verify",
                    durationMs: expect.any(Number),
                    resultChars: expect.any(Number),
                }),
            ]);
        });

        it("trips circuit breaker after three consecutive identical model failures", async () => {
            db = createTestDb();
            const createdSessionIds: string[] = [];
            const deletedSessionIds: string[] = [];
            const client = createDreamClient({ createdSessionIds, deletedSessionIds });

            class ProviderModelNotFoundError extends Error {
                constructor() {
                    super("model not found: github-copilot/claude-sonnet-4.6");
                    this.name = "ProviderModelNotFoundError";
                }
            }

            const promptSyncSpy = spyOn(
                shared,
                "promptSyncWithModelSuggestionRetry",
            ).mockRejectedValue(new ProviderModelNotFoundError());

            try {
                const result = await runDream({
                    db,
                    client,
                    projectIdentity: "/repo/project",
                    tasks: ["consolidate", "verify", "archive-stale", "improve", "maintain-docs"],
                    taskTimeoutMinutes: 5,
                    maxRuntimeMinutes: 10,
                    parentSessionId: "parent-1",
                    sessionDirectory: "/repo/project",
                    experimentalUserMemories: { enabled: true, promotionThreshold: 1 },
                    experimentalPinKeyFiles: { enabled: true, token_budget: 1000, min_reads: 1 },
                });

                expect(promptSyncSpy).toHaveBeenCalledTimes(3);
                expect(result.tasks.map((task) => task.name)).toEqual([
                    "consolidate",
                    "verify",
                    "archive-stale",
                    "circuit-breaker",
                    "post-task-phases",
                ]);
                expect(result.tasks.slice(0, 3).every((task) => task.error)).toBe(true);
                expect(result.tasks[0]?.error).toContain("ProviderModelNotFoundError");
                expect(result.tasks[3]?.error).toContain(
                    "3 consecutive ProviderModelNotFoundError failures",
                );
                expect(result.tasks[4]?.error).toContain("Skipped post-task phases");
                expect(createdSessionIds).toEqual(["dream-1", "dream-2", "dream-3"]);
                expect(deletedSessionIds).toEqual(["dream-1", "dream-2", "dream-3"]);
                expect(getDreamState(db, "last_dream_at")).toBeNull();

                const runs = getDreamRuns(db, "/repo/project");
                expect(runs[0]?.tasks_failed).toBe(5);
                expect(JSON.parse(runs[0]?.tasks_json ?? "[]")[3]).toEqual(
                    expect.objectContaining({
                        name: "circuit-breaker",
                        error: expect.stringContaining("ProviderModelNotFoundError"),
                    }),
                );
            } finally {
                promptSyncSpy.mockRestore();
            }
        });

        it("processes the next queued dream and removes the queue entry", async () => {
            db = createTestDb();
            ensureDreamQueueTable(db);
            registerDreamProjectDirectory("git:repo-1", "/repo/project");
            const client = createDreamClient();

            expect(enqueueDream(db, "git:repo-1", "manual")).not.toBeNull();

            const result = await processDreamQueue({
                db,
                client,
                tasks: ["consolidate"],
                taskTimeoutMinutes: 5,
                maxRuntimeMinutes: 10,
            });

            expect(result?.tasks.map((task) => task.name)).toEqual(["consolidate"]);
            const row = db
                .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM dream_queue")
                .get();
            expect(row?.count).toBe(0);
        });

        /**
         * Cross-project queue isolation regression. The dream_queue is shared
         * across processes (OpenCode + Pi can both write/read). Without this
         * filter, a Pi process running in project A would dequeue a queue
         * entry for project B and try to dream B with Pi's client — failing
         * because Pi has no idea where B is on disk.
         *
         * The user-visible report that triggered this fix: Pi running in
         * `opencode-anthropic-auth` was dreaming `opencode-xtra` every 15
         * minutes and failing every cycle with `posix_spawn 'pi'` ENOENT
         * because `dreamProjectDirectories` for opencode-xtra wasn't
         * registered in Pi's process, so the spawn cwd fell back to the
         * `git:<sha>` identity string itself.
         */
        it("dequeues only entries matching projectIdentity when filter is provided", async () => {
            db = createTestDb();
            ensureDreamQueueTable(db);
            registerDreamProjectDirectory("git:my-repo", "/repo/my-repo");
            registerDreamProjectDirectory("git:other-repo", "/repo/other-repo");
            const client = createDreamClient();

            // Two projects enqueued. We're filtering to my-repo, so the
            // other-repo entry must STAY in the queue untouched.
            expect(enqueueDream(db, "git:other-repo", "scheduled")).not.toBeNull();
            expect(enqueueDream(db, "git:my-repo", "scheduled")).not.toBeNull();

            const result = await processDreamQueue({
                db,
                client,
                tasks: ["consolidate"],
                taskTimeoutMinutes: 5,
                maxRuntimeMinutes: 10,
                projectIdentity: "git:my-repo",
            });

            // We dreamed my-repo (filtered).
            expect(result).not.toBeNull();

            // other-repo's queue entry survives — another host (or a future
            // tick from a process that owns other-repo) must drain it.
            const remaining = db
                .prepare<[], { project_path: string }>(
                    "SELECT project_path FROM dream_queue ORDER BY id",
                )
                .all();
            expect(remaining.map((r) => r.project_path)).toEqual(["git:other-repo"]);
        });

        it("returns null when projectIdentity filter has no matching entries", async () => {
            db = createTestDb();
            ensureDreamQueueTable(db);
            const client = createDreamClient();

            // Queue has entries, but NONE for our project.
            expect(enqueueDream(db, "git:not-mine", "scheduled")).not.toBeNull();
            expect(enqueueDream(db, "git:also-not-mine", "scheduled")).not.toBeNull();

            const result = await processDreamQueue({
                db,
                client,
                tasks: ["consolidate"],
                taskTimeoutMinutes: 5,
                maxRuntimeMinutes: 10,
                projectIdentity: "git:my-repo",
            });

            expect(result).toBeNull();

            // Both other-project entries must still be queued.
            const remaining = db
                .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM dream_queue")
                .get();
            expect(remaining?.count).toBe(2);
        });

        it("legacy behavior preserved when projectIdentity filter is omitted", async () => {
            // Tests that pass `undefined` (or just don't pass the field)
            // continue to drain the queue head — preserves backward compat
            // for any test or future single-host caller that wants the old
            // "dequeue any" behavior.
            db = createTestDb();
            ensureDreamQueueTable(db);
            registerDreamProjectDirectory("git:repo-1", "/repo/project");
            const client = createDreamClient();

            expect(enqueueDream(db, "git:repo-1", "manual")).not.toBeNull();

            const result = await processDreamQueue({
                db,
                client,
                tasks: ["consolidate"],
                taskTimeoutMinutes: 5,
                maxRuntimeMinutes: 10,
                // projectIdentity intentionally omitted
            });

            expect(result?.tasks.map((task) => task.name)).toEqual(["consolidate"]);
            const row = db
                .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM dream_queue")
                .get();
            expect(row?.count).toBe(0);
        });
    });
});
