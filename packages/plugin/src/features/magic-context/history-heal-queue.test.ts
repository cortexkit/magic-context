import { afterEach, beforeEach, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { initializeDatabase } from "./storage-db";
import { runMigrations } from "./migrations";
import { clearSession, getOrCreateSessionMeta } from "./storage-meta";
import { clearCachedM0M1 } from "./storage-meta-shared";
import { getM0MutationsBySession } from "./storage-m0-mutation-log";
import { acquireCompartmentLease } from "./compartment-lease";
import { saveRecompStagingPass } from "./compartment-storage";
import { promoteRecompStagingWithM0Mutation } from "../../hooks/magic-context/compartment-runner-recomp";
import {
    drainHistoryHealQueue,
    getHistoryHealQueue,
    setHistoryHealQueue,
} from "./history-heal-queue";
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
