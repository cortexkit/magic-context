/// <reference types="bun-types" />

import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { PluginContext } from "../../../plugin/types";
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
const { getDreamState } = await import("./storage-dream-state");

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
    });
});
