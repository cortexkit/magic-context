import { expect, test } from "bun:test";
import { getPendingOps, updateSessionMeta } from "../../features/magic-context/storage";
import { openCodeRideHarness } from "./deferred-ride-evidence.test";
import {
    clearExecuteReclaimState,
    originateExecuteReclaim,
    readExecuteReclaimState,
} from "./execute-reclaim";

for (const host of ["opencode", "opencode2"] as const) {
    test(`${host} floor stall marks, holds, fires next pass and drains in one publication rebuild`, async () => {
        const h = openCodeRideHarness(host, false, "floor");
        try {
            const warm = await h.pass(40);
            const initialBusts = h.rebuilds;
            h.queue();
            expect(await h.pass(76)).toEqual(warm);
            expect(h.lastTrigger?.shouldFire).toBe(false);
            expect(readExecuteReclaimState(h.db, h.id).floorPromptId).toBe("msg_0002");
            expect(getPendingOps(h.db, h.id)).toHaveLength(1);
            expect(await h.pass(79)).toEqual(warm);
            expect(h.lastTrigger?.shouldFire).toBe(true);
            expect(readExecuteReclaimState(h.db, h.id).floorOrdinal).toBeNull();
            expect(h.lastTrigger?.boundarySnapshot?.eligibleEndOrdinal).toBeGreaterThan(3);
            // The fired snapshot carries the one-pass lift to its own run only.
            expect(h.lastTrigger?.boundarySnapshot?.liftLivePromptFloor).toBe(true);
            expect(h.rebuilds).toBe(initialBusts);
            h.publish();
            const published = await h.pass(82);
            // The mark was spent, so the next evaluation resolves without the lift.
            expect(h.lastTrigger?.boundarySnapshot?.liftLivePromptFloor).toBeUndefined();
            expect(published).not.toEqual(warm);
            expect(getPendingOps(h.db, h.id)).toHaveLength(0);
            expect(h.rebuilds - initialBusts).toBe(1);
            expect(await h.pass(40)).toEqual(published);
            expect(readExecuteReclaimState(h.db, h.id).heldPasses).toBe(0);
        } finally {
            h.close();
        }
    });

    test(`${host} worth bound holds tiny queue twice then reclaims once`, async () => {
        const h = openCodeRideHarness(host, false, "small");
        try {
            const warm = await h.pass(40);
            const initialBusts = h.rebuilds;
            h.queue();
            expect(await h.pass(76)).toEqual(warm);
            expect(await h.pass(78)).toEqual(warm);
            expect(readExecuteReclaimState(h.db, h.id).floorOrdinal).toBeNull();
            expect(getPendingOps(h.db, h.id)).toHaveLength(1);
            h.reopen();
            const reclaimed = await h.pass(82);
            expect(reclaimed).not.toEqual(warm);
            expect(getPendingOps(h.db, h.id)).toHaveLength(0);
            expect(h.rebuilds - initialBusts).toBe(1);
            expect(await h.pass(84)).toEqual(reclaimed);
            expect(h.rebuilds - initialBusts).toBe(1);
        } finally {
            h.close();
        }
    });
}

test("holding while a summary can come denies even worthwhile execute reclaim", () => {
    const h = openCodeRideHarness("opencode");
    try {
        for (let i = 0; i < 5; i++)
            expect(
                originateExecuteReclaim({
                    db: h.db,
                    sessionId: h.id,
                    primaryExecute: true,
                    summaryCanCome: true,
                    alreadyBusting: false,
                    reclaimableTokens: 30_000,
                    usableWindow: 100_000,
                }),
            ).toBe(false);
        expect(
            originateExecuteReclaim({
                db: h.db,
                sessionId: h.id,
                primaryExecute: true,
                summaryCanCome: false,
                alreadyBusting: false,
                reclaimableTokens: 30_000,
                usableWindow: 100_000,
            }),
        ).toBe(true);
    } finally {
        h.close();
    }
});

test("floor mark is set only when removing the floor yields a meaningful head", async () => {
    const h = openCodeRideHarness("opencode", false, "small");
    try {
        // Keep the live prompt at the unsummarized offset, but do not give the
        // size walk enough material to expose a meaningful head without it.
        h.source.splice(10);
        h.setBoundaryLimit(16_000);
        for (let i = 4; i < h.source.length; i += 2)
            h.source[i]!.parts[0]!.text = "<system-reminder>wake</system-reminder>";
        for (let i = 3; i < h.source.length; i += 2)
            h.source[i]!.parts[0]!.text = "Measured work ".repeat(500);
        await h.pass(40);
        const unfloored = h.inspectUnflooredBoundary();
        expect(unfloored.protectedTailStart).toBeGreaterThan(unfloored.offset);
        expect(unfloored.trueRawEligibleTokens).toBeLessThan(6_000);
        expect(unfloored.eligibleEndOrdinal - unfloored.offset).toBeLessThan(12);
        await h.pass(76);
        expect(h.lastTrigger?.shouldFire).toBe(false);
        expect(readExecuteReclaimState(h.db, h.id).floorOrdinal).toBeNull();
    } finally {
        h.close();
    }
});

test("floor mark is consumed once even when the next run has no meaningful head", async () => {
    const h = openCodeRideHarness("opencode", false, "floor");
    try {
        await h.pass(40);
        await h.pass(76);
        expect(readExecuteReclaimState(h.db, h.id).floorOrdinal).toBe(3);
        // The raw source shrank before evaluation; consuming the mark must not
        // re-arm it merely because the newly admitted run cannot start.
        h.source.splice(4);
        await h.pass(78);
        expect(readExecuteReclaimState(h.db, h.id).floorOrdinal).toBeNull();
        expect(h.lastTrigger?.shouldFire).toBe(false);
    } finally {
        h.close();
    }
});

test("floor mark clears on a new meaningful prompt rather than lifting its floor", async () => {
    const h = openCodeRideHarness("opencode", false, "floor");
    try {
        await h.pass(40);
        await h.pass(76);
        expect(readExecuteReclaimState(h.db, h.id).floorOrdinal).toBe(3);
        h.source[8]!.parts[0]!.text = "A genuinely new instruction";
        await h.pass(78);
        expect(readExecuteReclaimState(h.db, h.id).floorPromptId).toBeNull();
        expect(h.lastTrigger?.shouldFire).toBe(true);
        expect(h.lastTrigger!.boundarySnapshot!.protectedTailStart).toBeLessThanOrEqual(9);
    } finally {
        h.close();
    }
});

test("execute state survives reopen and clears on bust, defer, empty and protected queues", () => {
    const h = openCodeRideHarness("opencode");
    try {
        const args = {
            db: h.db,
            sessionId: h.id,
            primaryExecute: true,
            summaryCanCome: false,
            alreadyBusting: false,
            reclaimableTokens: 100,
            usableWindow: 100_000,
        };
        expect(originateExecuteReclaim(args)).toBe(false);
        expect(originateExecuteReclaim(args)).toBe(false);
        // There is no process-local episode cache: a fresh metadata read sees both holds.
        h.reopen();
        args.db = h.db;
        updateSessionMeta(h.db, h.id, { lastResponseTime: 1 });
        expect(readExecuteReclaimState(h.db, h.id).heldPasses).toBe(2);
        expect(originateExecuteReclaim(args)).toBe(true);
        clearExecuteReclaimState(h.db, h.id);
        expect(readExecuteReclaimState(h.db, h.id).heldPasses).toBe(0);
        expect(originateExecuteReclaim({ ...args, alreadyBusting: true })).toBe(false);
        expect(originateExecuteReclaim({ ...args, reclaimableTokens: 0 })).toBe(false);
        expect(originateExecuteReclaim({ ...args, primaryExecute: false })).toBe(false);
    } finally {
        h.close();
    }
});

for (const host of ["opencode", "opencode2"] as const) {
    test(`${host} two percent eligible reclaim can originate immediately`, async () => {
        const h = openCodeRideHarness(host, false, "small");
        try {
            h.source[7]!.parts[0]!.text = "large reclaim output ".repeat(1200);
            const warm = await h.pass(40);
            h.queue();
            expect(await h.pass(76)).not.toEqual(warm);
            expect(h.lastTrigger?.shouldFire).toBe(false);
            expect(getPendingOps(h.db, h.id)).toHaveLength(0);
        } finally {
            h.close();
        }
    });
    test(`${host} fully protected queue cannot originate or age an execute rebuild`, async () => {
        const h = openCodeRideHarness(host, false, "small");
        try {
            const warm = await h.pass(40);
            const initialBusts = h.rebuilds;
            h.queue();
            h.protectQueue(true);
            for (let i = 0; i < 5; i++) expect(await h.pass(76 + i)).toEqual(warm);
            expect(h.rebuilds).toBe(initialBusts);
            expect(readExecuteReclaimState(h.db, h.id).heldPasses).toBe(0);
            expect(getPendingOps(h.db, h.id)).toHaveLength(1);
        } finally {
            h.close();
        }
    });
}
