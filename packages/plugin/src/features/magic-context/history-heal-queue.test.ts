import { afterEach, beforeEach, expect, it } from "bun:test";
import { promoteRecompStagingWithM0Mutation } from "../../hooks/magic-context/compartment-runner-recomp";
import { Database } from "../../shared/sqlite";
import {
    clearSessionMetaFixtureFault,
    rejectSessionRenderCacheWrites,
} from "./__tests__/session-meta-faults";
import { acquireCompartmentLease } from "./compartment-lease";
import { saveRecompStagingPass } from "./compartment-storage";
import {
    drainHistoryHealQueue,
    getHistoryHealQueue,
    setHistoryHealQueue,
} from "./history-heal-queue";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { getM0MutationsBySession } from "./storage-m0-mutation-log";
import { clearSession, getOrCreateSessionMeta } from "./storage-meta";
import { clearCachedM0M1 } from "./storage-meta-shared";
import { writeSessionRenderCache } from "./storage-session-cache";

let db: Database;
const sessionId = "heal-queue";
const work = { start: 1, end: 4, sequence: 0, gapStart: 4, gapEnd: 4 };
beforeEach(() => {
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    getOrCreateSessionMeta(db, sessionId);
});
afterEach(() => db.close());

it("retains unpublished repair work, resumes in order and acknowledges only published ranges", async () => {
    setHistoryHealQueue(db, sessionId, [
        work,
        { ...work, start: 5, end: 8, gapStart: 8, gapEnd: 8, sequence: 1 },
    ]);
    const calls: number[] = [];
    expect(
        await drainHistoryHealQueue(db, sessionId, async (r) => {
            calls.push(r.start);
            return false;
        }),
    ).toBe(false);
    expect(getHistoryHealQueue(db, sessionId)).toHaveLength(2);
    expect(
        await drainHistoryHealQueue(db, sessionId, async (r) => {
            calls.push(r.start);
            return true;
        }),
    ).toBe(true);
    expect(calls).toEqual([1, 1, 5]);
    expect(getHistoryHealQueue(db, sessionId)).toEqual([]);
});

it("keeps repair work through cache eviction but removes it with the session", () => {
    setHistoryHealQueue(db, sessionId, [work]);
    clearCachedM0M1(db, sessionId);
    expect(getHistoryHealQueue(db, sessionId)).toEqual([work]);
    clearSession(db, sessionId);
    expect(getHistoryHealQueue(db, sessionId)).toEqual([]);
});

it("queued partial publication preserves cache bytes and records the existing structural mutation", async () => {
    writeSessionRenderCache(db, sessionId, "cached_m0_bytes", Buffer.from("frozen m0"));
    writeSessionRenderCache(db, sessionId, "cached_m1_bytes", Buffer.from("frozen m1"));
    setHistoryHealQueue(db, sessionId, [work]);
    expect(acquireCompartmentLease(db, sessionId, "holder")).not.toBeNull();
    expect(
        await drainHistoryHealQueue(db, sessionId, async (range) => {
            saveRecompStagingPass(
                db,
                sessionId,
                1,
                [
                    {
                        sequence: 0,
                        startMessage: range.start,
                        endMessage: range.end,
                        startMessageId: "m1",
                        endMessageId: "m4",
                        title: "repaired",
                        content: "now includes the gap",
                    },
                ],
                [],
            );
            return (
                promoteRecompStagingWithM0Mutation(db, sessionId, "holder", {
                    preserveCachedM0M1: true,
                }) !== null
            );
        }),
    ).toBe(true);
    expect(getM0MutationsBySession(db, sessionId).map((m) => m.mutationType)).toEqual([
        "recomp_boundary_change",
    ]);
    const state = getOrCreateSessionMeta(db, sessionId);
    expect(Buffer.from(state.cachedM0Bytes!).toString()).toBe("frozen m0");
    expect(Buffer.from(state.cachedM1Bytes!).toString()).toBe("frozen m1");
});

it("does not repeat a committed heal publication after interruption before acknowledgement", async () => {
    setHistoryHealQueue(db, sessionId, [work]);
    expect(acquireCompartmentLease(db, sessionId, "holder")).not.toBeNull();
    let publications = 0;
    const publish = async () => {
        saveRecompStagingPass(
            db,
            sessionId,
            1,
            [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 4,
                    startMessageId: "m1",
                    endMessageId: "m4",
                    title: "rebuilt",
                    content: "prose",
                },
            ],
            [],
        );
        expect(
            promoteRecompStagingWithM0Mutation(db, sessionId, "holder", {
                preserveCachedM0M1: true,
            }),
        ).not.toBeNull();
        publications++;
        return true;
    };
    await expect(
        drainHistoryHealQueue(db, sessionId, async () => {
            await publish();
            // The compartment swap has committed, but the durable queue still contains its head.
            throw new Error("interrupted after publication commit");
        }),
    ).rejects.toThrow("interrupted after publication commit");
    expect(await drainHistoryHealQueue(db, sessionId, publish)).toBe(true);
    expect(getHistoryHealQueue(db, sessionId)).toEqual([]);
    expect(publications).toBe(1);
});

it("rolls back prose, structural mutation and queue acknowledgement together", async () => {
    setHistoryHealQueue(db, sessionId, [work]);
    expect(acquireCompartmentLease(db, sessionId, "holder")).not.toBeNull();
    const publish = async () => {
        saveRecompStagingPass(
            db,
            sessionId,
            1,
            [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 4,
                    startMessageId: "m1",
                    endMessageId: "m4",
                    title: "rebuilt",
                    content: "prose",
                },
            ],
            [],
        );
        return (
            promoteRecompStagingWithM0Mutation(db, sessionId, "holder", {
                preserveCachedM0M1: true,
            }) !== null
        );
    };
    db.exec(
        "CREATE TRIGGER abort_queue_ack BEFORE DELETE ON session_render_cache WHEN OLD.cache_key='history_heal_recomp_queue' BEGIN SELECT RAISE(ABORT,'interrupted inside publication'); END",
    );
    await expect(drainHistoryHealQueue(db, sessionId, publish)).rejects.toThrow(
        "interrupted inside publication",
    );
    expect(db.prepare("SELECT * FROM compartments WHERE session_id=?").all(sessionId)).toEqual([]);
    expect(getM0MutationsBySession(db, sessionId)).toEqual([]);
    expect(getHistoryHealQueue(db, sessionId)).toEqual([work]);
    db.exec("DROP TRIGGER abort_queue_ack");
    expect(await drainHistoryHealQueue(db, sessionId, publish)).toBe(true);
    expect(getHistoryHealQueue(db, sessionId)).toEqual([]);
    expect(getM0MutationsBySession(db, sessionId)).toHaveLength(1);
});

it("ordinary recomp publication cannot acknowledge a queue item it does not own", () => {
    setHistoryHealQueue(db, sessionId, [work]);
    expect(acquireCompartmentLease(db, sessionId, "holder")).not.toBeNull();
    saveRecompStagingPass(
        db,
        sessionId,
        1,
        [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 4,
                startMessageId: "m1",
                endMessageId: "m4",
                title: "ordinary",
                content: "prose",
            },
        ],
        [],
    );
    expect(
        promoteRecompStagingWithM0Mutation(db, sessionId, "holder", { preserveCachedM0M1: true }),
    ).not.toBeNull();
    expect(getHistoryHealQueue(db, sessionId)).toEqual([work]);
});

it("late async descendants cannot acknowledge work after the drain scope closes", async () => {
    setHistoryHealQueue(db, sessionId, [work]);
    expect(acquireCompartmentLease(db, sessionId, "holder")).not.toBeNull();
    let release: () => void = () => {
        throw new Error("gate not initialized");
    };
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let detached: Promise<unknown> = Promise.resolve(null);
    expect(
        await drainHistoryHealQueue(db, sessionId, async () => {
            detached = gate.then(() => {
                saveRecompStagingPass(
                    db,
                    sessionId,
                    1,
                    [
                        {
                            sequence: 0,
                            startMessage: 1,
                            endMessage: 4,
                            startMessageId: "m1",
                            endMessageId: "m4",
                            title: "ordinary",
                            content: "prose",
                        },
                    ],
                    [],
                );
                return promoteRecompStagingWithM0Mutation(db, sessionId, "holder", {
                    preserveCachedM0M1: true,
                });
            });
            return false;
        }),
    ).toBe(false);
    release();
    expect(await detached).not.toBeNull();
    expect(getHistoryHealQueue(db, sessionId)).toEqual([work]);
});

it("publication authority cannot acknowledge another session during a live drain", async () => {
    const other = "other-session";
    getOrCreateSessionMeta(db, other);
    setHistoryHealQueue(db, sessionId, [work]);
    setHistoryHealQueue(db, other, [work]);
    expect(acquireCompartmentLease(db, other, "other-holder")).not.toBeNull();
    expect(
        await drainHistoryHealQueue(db, sessionId, async () => {
            saveRecompStagingPass(
                db,
                other,
                1,
                [
                    {
                        sequence: 0,
                        startMessage: 1,
                        endMessage: 4,
                        startMessageId: "m1",
                        endMessageId: "m4",
                        title: "ordinary",
                        content: "other prose",
                    },
                ],
                [],
            );
            expect(promoteRecompStagingWithM0Mutation(db, other, "other-holder")).not.toBeNull();
            return false;
        }),
    ).toBe(false);
    expect(getHistoryHealQueue(db, other)).toEqual([work]);
    expect(getHistoryHealQueue(db, sessionId)).toEqual([work]);
});

it("a replaced queue head rolls back a racing historian publication", async () => {
    setHistoryHealQueue(db, sessionId, [work]);
    expect(acquireCompartmentLease(db, sessionId, "holder")).not.toBeNull();
    const replacement = { start: 5, end: 8, sequence: 1, gapStart: 7, gapEnd: 7 };
    await expect(
        drainHistoryHealQueue(db, sessionId, async () => {
            saveRecompStagingPass(
                db,
                sessionId,
                1,
                [
                    {
                        sequence: 0,
                        startMessage: 1,
                        endMessage: 4,
                        startMessageId: "m1",
                        endMessageId: "m4",
                        title: "racing",
                        content: "must roll back",
                    },
                ],
                [],
            );
            setHistoryHealQueue(db, sessionId, [replacement]);
            return promoteRecompStagingWithM0Mutation(db, sessionId, "holder") !== null;
        }),
    ).rejects.toThrow("history_heal_queue_changed");
    expect(getHistoryHealQueue(db, sessionId)).toEqual([replacement]);
    expect(getM0MutationsBySession(db, sessionId)).toEqual([]);
    expect(db.prepare("SELECT * FROM compartments WHERE session_id=?").all(sessionId)).toEqual([]);
});

it("a failed drain revokes detached publication authority while the next drain is open", async () => {
    setHistoryHealQueue(db, sessionId, [work]);
    expect(acquireCompartmentLease(db, sessionId, "holder")).not.toBeNull();
    let release: () => void = () => {
        throw new Error("gate not initialized");
    };
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let detached: Promise<unknown> = Promise.resolve(null);
    await expect(
        drainHistoryHealQueue(db, sessionId, async () => {
            detached = gate.then(() => {
                saveRecompStagingPass(
                    db,
                    sessionId,
                    1,
                    [
                        {
                            sequence: 0,
                            startMessage: 1,
                            endMessage: 4,
                            startMessageId: "m1",
                            endMessageId: "m4",
                            title: "late",
                            content: "ordinary prose",
                        },
                    ],
                    [],
                );
                return promoteRecompStagingWithM0Mutation(db, sessionId, "holder");
            });
            throw new Error("failed publisher");
        }),
    ).rejects.toThrow("failed publisher");
    expect(
        await drainHistoryHealQueue(db, sessionId, async () => {
            release();
            expect(await detached).not.toBeNull();
            expect(getHistoryHealQueue(db, sessionId)).toEqual([work]);
            return false;
        }),
    ).toBe(false);
    expect(getHistoryHealQueue(db, sessionId)).toEqual([work]);
});

it("cache eviction preserves its payload failure boundary and rolls back without dropping repair work", () => {
    writeSessionRenderCache(db, sessionId, "cached_m0_bytes", Buffer.from("frozen m0"));
    writeSessionRenderCache(db, sessionId, "cached_m1_bytes", Buffer.from("frozen m1"));
    setHistoryHealQueue(db, sessionId, [work]);
    rejectSessionRenderCacheWrites(db, "cached_m1_bytes", "refuse_payload_clear", {
        error: "cache clear refused",
    });
    expect(() => clearCachedM0M1(db, sessionId)).toThrow("cache clear refused");
    const state = getOrCreateSessionMeta(db, sessionId);
    expect(Buffer.from(state.cachedM0Bytes!).toString()).toBe("frozen m0");
    expect(Buffer.from(state.cachedM1Bytes!).toString()).toBe("frozen m1");
    expect(getHistoryHealQueue(db, sessionId)).toEqual([work]);
    clearSessionMetaFixtureFault(db, "refuse_payload_clear");
    clearCachedM0M1(db, sessionId);
    const cleared = getOrCreateSessionMeta(db, sessionId);
    expect(cleared.cachedM0Bytes).toBeNull();
    expect(cleared.cachedM1Bytes).toBeNull();
    expect(getHistoryHealQueue(db, sessionId)).toEqual([work]);
});
