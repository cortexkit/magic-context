/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { Database } from "../../shared/sqlite";
import { initializeDatabase } from "./storage-db";
import {
    DRAIN_WINDOW_MS,
    describeProtectedTailDrainBudgetSkip,
    EMERGENCY_DRAIN_FAILURE_BACKOFF_MS,
    EMERGENCY_DRAIN_MAX_LATCH_MS,
    getProtectedTailDrainBudgetSkip,
    loadProtectedTailMeta,
    reserveProtectedTailDrainTokens,
    rollbackProtectedTailDrainReservation,
} from "./storage-meta-persisted";

const USABLE_TOKENS = 100_000;
const PER_RUN_CAP = 20_000;
const USAGE_PERCENTAGE = 78;
const EXECUTE_THRESHOLD_PERCENTAGE = 80;

function reserve(db: Database, sessionId: string, now: number, trueRawTokens = PER_RUN_CAP) {
    return reserveProtectedTailDrainTokens({
        db,
        sessionId,
        runId: `${sessionId}-${now}`,
        trueRawTokens,
        usagePercentage: USAGE_PERCENTAGE,
        usable: USABLE_TOKENS,
        perRunCap: PER_RUN_CAP,
        executeThresholdPercentage: EXECUTE_THRESHOLD_PERCENTAGE,
        now,
    });
}

describe("protected-tail drain budget window", () => {
    let db: Database;

    beforeEach(() => {
        db = new Database(":memory:");
        initializeDatabase(db);
    });
    afterEach(() => db.close());

    it("admission persists latch transitions without changing the budget and matches reservation decisions", () => {
        const now = 10_000_000;
        const cases = [
            { usage: 20, start: now - 1, latch: 0, failure: 0, blocked: true, afterLatch: 0 },
            {
                usage: 20,
                start: now - DRAIN_WINDOW_MS,
                latch: 0,
                failure: 0,
                blocked: false,
                afterLatch: 0,
            },
            { usage: 20, start: now + 1, latch: 0, failure: 0, blocked: false, afterLatch: 0 },
            { usage: 85, start: now - 1, latch: 0, failure: 0, blocked: false, afterLatch: now },
            { usage: 95, start: now - 1, latch: 0, failure: 0, blocked: false, afterLatch: now },
            {
                usage: 70,
                start: now - 1,
                latch: now - 1000,
                failure: 0,
                blocked: false,
                afterLatch: now - 1000,
            },
            {
                usage: 69,
                start: now - 1,
                latch: now - 1000,
                failure: 0,
                blocked: true,
                afterLatch: 0,
            },
            {
                usage: 69,
                start: now - DRAIN_WINDOW_MS,
                latch: now - 1000,
                failure: 0,
                blocked: false,
                afterLatch: 0,
            },
            {
                usage: 69,
                start: now + 1,
                latch: now - 1000,
                failure: 0,
                blocked: false,
                afterLatch: 0,
            },
            {
                usage: 70,
                start: now - 1,
                latch: now - EMERGENCY_DRAIN_MAX_LATCH_MS - 1,
                failure: 0,
                blocked: true,
                afterLatch: 0,
            },
            {
                usage: 95,
                start: now - 1,
                latch: 0,
                failure: now - 1,
                blocked: true,
                afterLatch: now,
            },
            {
                usage: 95,
                start: now - 1,
                latch: 0,
                failure: now - EMERGENCY_DRAIN_FAILURE_BACKOFF_MS,
                blocked: false,
                afterLatch: now,
            },
            {
                usage: 95,
                start: now - 1,
                latch: 0,
                failure: now + 1,
                blocked: false,
                afterLatch: now,
            },
        ];
        cases.forEach((c, i) => {
            const sessionId = `admission-${i}`;
            reserve(db, sessionId, now);
            db.prepare(
                "UPDATE session_meta SET protected_tail_drain_window_started_at = ?, protected_tail_drain_tokens = 1000000, emergency_drain_active = ?, historian_drain_failure_at = ? WHERE session_id = ?",
            ).run(c.start, c.latch, c.failure, sessionId);
            const args = {
                db,
                sessionId,
                usagePercentage: c.usage,
                usable: USABLE_TOKENS,
                perRunCap: PER_RUN_CAP,
                executeThresholdPercentage: 80,
                now,
            };
            const before = loadProtectedTailMeta(db, sessionId);
            const block = getProtectedTailDrainBudgetSkip(args);
            expect(block !== null).toBe(c.blocked);
            if (c.blocked)
                expect(block?.nextEligibleAt).toBe(
                    c.usage === 95
                        ? Math.min(
                              c.start + DRAIN_WINDOW_MS,
                              c.failure + EMERGENCY_DRAIN_FAILURE_BACKOFF_MS,
                          )
                        : c.start + DRAIN_WINDOW_MS,
                );
            expect(loadProtectedTailMeta(db, sessionId)).toEqual({
                ...before,
                emergencyDrainActive: c.afterLatch,
            });
            expect(
                reserveProtectedTailDrainTokens({ ...args, runId: sessionId, trueRawTokens: 100 })
                    .ok,
            ).toBe(!c.blocked);
        });
    });

    it("replenishes by clock time across the reported 17-hour trigger timeline", () => {
        const firstRunAt = Date.parse("2026-08-28T16:41:16.212Z");
        expect(reserve(db, "reported-session", firstRunAt).ok).toBe(true);

        const after57Seconds = reserve(db, "reported-session", firstRunAt + 57_000);
        expect(after57Seconds.ok).toBe(false);

        const admittedMinutes: number[] = [];
        let finalAttempt = after57Seconds;
        for (let minute = 1; minute <= 17 * 60; minute += 1) {
            finalAttempt = reserve(db, "reported-session", firstRunAt + minute * 60_000);
            if (finalAttempt.ok) admittedMinutes.push(minute);
        }

        expect(admittedMinutes[0]).toBe(10);
        expect(admittedMinutes.at(-1)).toBe(17 * 60);
        expect(admittedMinutes).toHaveLength((17 * 60) / 10);
        expect(finalAttempt.ok).toBe(true);
        expect(
            loadProtectedTailMeta(db, "reported-session").protectedTailDrainWindowStartedAt,
        ).toBe(firstRunAt + 17 * 60 * 60_000);
    });

    it("still blocks rapid-fire drains inside one active window", () => {
        const startedAt = 1_000_000;
        expect(reserve(db, "rapid-session", startedAt).ok).toBe(true);

        const firstSkip = reserve(db, "rapid-session", startedAt + 1);
        const secondSkip = reserve(db, "rapid-session", startedAt + DRAIN_WINDOW_MS - 1);
        expect(firstSkip.ok).toBe(false);
        expect(secondSkip.ok).toBe(false);
        expect(firstSkip.budgetState).toEqual({
            windowStartedAt: startedAt,
            resetsAt: startedAt + DRAIN_WINDOW_MS,
            resetInMs: DRAIN_WINDOW_MS - 1,
            spentTokens: PER_RUN_CAP,
            limitTokens: PER_RUN_CAP,
        });
        expect(describeProtectedTailDrainBudgetSkip(firstSkip)).toBe(
            "historian skip: internal drain budget spent (20000/20000 tokens; resets in 10m)",
        );
    });

    it("admits a drain at the exact clock-armed window expiry", () => {
        const startedAt = 2_000_000;
        expect(reserve(db, "exact-expiry", startedAt).ok).toBe(true);
        expect(reserve(db, "exact-expiry", startedAt + DRAIN_WINDOW_MS).ok).toBe(true);
        expect(loadProtectedTailMeta(db, "exact-expiry")).toMatchObject({
            protectedTailDrainWindowStartedAt: startedAt + DRAIN_WINDOW_MS,
            protectedTailDrainTokens: PER_RUN_CAP,
        });
    });

    it("organically heals a persisted window timestamp from the future", () => {
        const now = 3_000_000;
        expect(reserve(db, "future-clock", now).ok).toBe(true);
        db.prepare(
            `UPDATE session_meta
             SET protected_tail_drain_window_started_at = ?, protected_tail_drain_tokens = ?
             WHERE session_id = ?`,
        ).run(now + 7 * 24 * 60 * 60_000, PER_RUN_CAP, "future-clock");

        const healedAt = now + 17 * 60 * 60_000;
        expect(reserve(db, "future-clock", healedAt).ok).toBe(true);
        expect(loadProtectedTailMeta(db, "future-clock")).toMatchObject({
            protectedTailDrainWindowStartedAt: healedAt,
            protectedTailDrainTokens: PER_RUN_CAP,
        });
    });

    it("keeps each session's persisted budget isolated", () => {
        const now = 4_000_000;
        expect(reserve(db, "session-a", now).ok).toBe(true);
        expect(reserve(db, "session-a", now + 1).ok).toBe(false);

        const sessionB = reserve(db, "session-b", now + 1);
        expect(sessionB.ok).toBe(true);
        expect(loadProtectedTailMeta(db, "session-a").protectedTailDrainTokens).toBe(PER_RUN_CAP);
        expect(loadProtectedTailMeta(db, "session-b").protectedTailDrainTokens).toBe(PER_RUN_CAP);
    });

    it("charges reserved source tokens rather than a whole budget per spawn", () => {
        const now = 5_000_000;
        const tiny = reserve(db, "tiny-chunk", now, 102);
        expect(tiny.ok).toBe(true);
        expect(tiny.reservedTokens).toBe(102);
        expect(tiny.budgetState).toMatchObject({
            spentTokens: 102,
            limitTokens: PER_RUN_CAP,
        });

        expect(reserve(db, "tiny-chunk", now + 1, 102).ok).toBe(true);
        expect(loadProtectedTailMeta(db, "tiny-chunk").protectedTailDrainTokens).toBe(204);
    });
});

describe("protected-tail drain reservation rollback", () => {
    it("does not refund a reservation into a later window", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        const firstWindowAt = Date.parse("2026-08-28T16:00:00.000Z");
        const stale = reserve(db, "rollback-session", firstWindowAt);
        expect(stale.ok).toBe(true);

        // The first run is still in flight when a new window opens and a second
        // run spends from it.
        const laterAt = firstWindowAt + DRAIN_WINDOW_MS + 1_000;
        const current = reserve(db, "rollback-session", laterAt, 5_000);
        expect(current.ok).toBe(true);
        expect(loadProtectedTailMeta(db, "rollback-session").protectedTailDrainTokens).toBe(5_000);

        rollbackProtectedTailDrainReservation(db, stale.reservation);

        expect(loadProtectedTailMeta(db, "rollback-session").protectedTailDrainTokens).toBe(5_000);
    });

    it("refunds a reservation into the window it came from", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        const at = Date.parse("2026-08-28T16:00:00.000Z");
        const reservation = reserve(db, "rollback-session", at, 5_000);
        reserve(db, "rollback-session", at + 1_000, 3_000);

        rollbackProtectedTailDrainReservation(db, reservation.reservation);

        expect(loadProtectedTailMeta(db, "rollback-session").protectedTailDrainTokens).toBe(3_000);
    });
});
