import { expect, spyOn, test } from "bun:test";
import { updateSessionMeta } from "../../features/magic-context/storage";
import { markProtectedTailPolicyV3Seeded } from "../../features/magic-context/storage-meta-persisted";
import * as incremental from "../../hooks/magic-context/compartment-runner-incremental";
import type { V2Message } from "../types";
import { oc2ContextFixture as fixture, prose } from "./__tests__/oc2-context.fixture";

// A long-lived OpenCode 2 session where the part of the request the emergency
// tool drop cannot reduce (its "fixed floor") already sits above the
// execute-threshold ceiling, and one user turn runs many shell steps a few
// seconds apart. Every reply reports usage in the force band, so:
//   - every pass is an execute pass and the emergency drop skips it ("fixed
//     floor ... already exceeds ceiling");
//   - the force-band trigger fires whenever one or two messages have left the
//     protected tail since the last summary, and the historian summarizes just
//     those;
//   - the next pass consumes each such publication as a history refresh: the
//     new summary is rendered into m[1] (the session-history delta message)
//     and the raw messages it covers are cut, so the served prefix changes
//     every other step.
// Each of those rebuilds makes the provider read everything after m[0] again,
// for a reclaim of a few hundred tokens.
//
// The test drives that loop through the real OpenCode 2 context hook. The
// historian's model call is replaced by a stub that publishes exactly the range
// the trigger handed it, as the real runner does on success.

/** Steady-state steps measured once the historian has caught up with the turn. */
const STEPS = 12;
/** 87% of the fixture's 1,000,000-token window: inside the force band (85%). */
const INPUT_TOKENS = 870_000;
/** Shell steps already in the turn when measuring starts. */
const EARLIER_STEPS = 90;

/** One shell step of the batch turn, with a few hundred tokens of output. */
const shellStep = (n: number) => ({
    name: "shell",
    input: { command: `sed -n '1,40p' records/record-${n}.json` },
    output: prose.repeat(10),
});

interface LoopResult {
    /** Summarizer runs, as [first, last] message ordinals each one covered. */
    runs: Array<[number, number]>;
    /** Measured steps whose served messages did not start with the previous step's. */
    rebuilds: number;
    /** For each rebuild, the share of the served request (by characters) from the first changed message on. */
    rewrittenShares: number[];
    floorSkips: number;
    forceBandFires: number;
    executePasses: number;
}

function firstChangedIndex(previous: V2Message[], current: V2Message[]): number | null {
    for (let index = 0; index < previous.length; index++) {
        if (JSON.stringify(previous[index]) !== JSON.stringify(current[index])) return index;
    }
    return null;
}

async function driveActiveTurn(): Promise<LoopResult> {
    const f = await fixture(886, {
        area: "issue-886",
        historian: true,
        instructions: false,
        protectedTokens: 16_000,
    });
    const runs: Array<[number, number]> = [];
    const agent = spyOn(incremental, "runCompartmentAgent").mockImplementation(async (deps) => {
        try {
            const endId = deps.boundarySnapshot?.eligibleEndMessageId;
            const end = f.rows.findIndex((row) => row.id === endId);
            if (end <= f.coveredThrough) return;
            runs.push([f.coveredThrough + 2, end + 1]);
            f.compartment(end);
            deps.onCompartmentStatePublished?.(deps.sessionId);
        } finally {
            // The real runner clears the in-progress flag when it ends.
            updateSessionMeta(f.db, deps.sessionId, { compartmentInProgress: false });
        }
    });
    const runSettled = async () => {
        for (let attempt = 0; attempt < 200; attempt++) {
            const row = f.db
                .prepare(
                    "SELECT compartment_in_progress AS busy FROM session_meta WHERE session_id = ?",
                )
                .get(f.session) as { busy: number } | null;
            if (!row?.busy) return;
            await Bun.sleep(5);
        }
        throw new Error("the stubbed historian run did not finish");
    };
    const previousNodeEnv = process.env.NODE_ENV;
    try {
        // The trigger resolves the real protected-tail boundary only outside the
        // test environment; under NODE_ENV=test it uses a canned snapshot. Every
        // store is already open under the fixture's isolated root.
        process.env.NODE_ENV = "production";
        // A session this old has long had its protected-tail policy seeded; the
        // seed's one-time full read is not part of the loop.
        markProtectedTailPolicyV3Seeded(f.db, f.session, 1);
        // Earlier batches are already summarized; this batch's turn starts now.
        f.compartment(f.rows.length - 1);
        f.user("Process the next batch of records, following the playbook.", 60_000);
        for (let step = 0; step < EARLIER_STEPS; step++) f.respondWithTool(shellStep(step));
        // Warm-up: the first render, then the catch-up run over the turn so far.
        let previous = await f.pass();
        for (let step = 0; step < 4; step++) {
            await runSettled();
            f.respondWithTool(shellStep(EARLIER_STEPS + step), INPUT_TOKENS);
            previous = await f.pass();
        }
        await runSettled();
        const warmupRuns = runs.length;

        let rebuilds = 0;
        const rewrittenShares: number[] = [];
        const logs: string[] = [];
        for (let step = 0; step < STEPS; step++) {
            f.respondWithTool(shellStep(EARLIER_STEPS + 4 + step), INPUT_TOKENS);
            const current = await f.pass();
            await runSettled();
            logs.push(...current.logs);
            const changed = firstChangedIndex(previous.draft.messages, current.draft.messages);
            if (
                changed !== null ||
                JSON.stringify(current.draft.system) !== JSON.stringify(previous.draft.system)
            ) {
                rebuilds++;
                const total = JSON.stringify(current.draft.messages).length;
                const rewritten = JSON.stringify(current.draft.messages.slice(changed ?? 0)).length;
                rewrittenShares.push(Math.round((rewritten / total) * 100) / 100);
            }
            previous = current;
        }
        const count = (pattern: RegExp) => logs.filter((line) => pattern.test(line)).length;
        return {
            runs: runs.slice(warmupRuns),
            rebuilds,
            rewrittenShares,
            floorSkips: count(
                /emergency tiered drop skipped: fixed floor ≈\d+ already exceeds ceiling/,
            ),
            forceBandFires: count(/compartment trigger: firing \(reason=force_band\)/),
            executePasses: count(/transform scheduler: .*decision=execute/),
        };
    } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
        agent.mockRestore();
        await f.cleanup();
    }
}

let loop: Promise<LoopResult> | undefined;
const steadyState = () => {
    loop ??= driveActiveTurn();
    return loop;
};

test("force band with the fixed floor over the ceiling: the conditions of the loop hold", async () => {
    const result = await steadyState();
    console.log(`ISSUE886 ${JSON.stringify(result)}`);
    // Every measured pass executes in the force band, and the emergency drop
    // cannot help because the fixed floor is above the ceiling.
    expect(result.executePasses).toBe(STEPS);
    expect(result.floorSkips).toBeGreaterThan(0);
}, 120_000);

test("force band with the fixed floor over the ceiling: tiny summaries do not rebuild the prefix every few steps", async () => {
    const result = await steadyState();
    // At most one rebuild over the measured steps: the accumulated summaries may
    // land together in one rebuild, not in a rebuild every other step.
    expect(result.rebuilds).toBeLessThanOrEqual(1);
}, 120_000);
