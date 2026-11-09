import { expect, spyOn, test } from "bun:test";
import * as retention from "../../features/magic-context/storage-host-instruction-retention";
import { setHostInstructionRetentionEnabledForTests } from "../../features/magic-context/storage-host-instruction-retention";
import { writeSessionRenderCache } from "../../features/magic-context/storage-session-cache";
import * as incremental from "../../hooks/magic-context/compartment-runner-incremental";
import { getSlot } from "../../hooks/magic-context/lkg-slot";
import * as models from "../../shared/models-dev-cache";
import { scaleTest } from "../../shared/slow-test";
import {
    firstDivergence,
    oc2ContextFixture as fixture,
    installBusyAdmission,
    installTransientFailure,
    instructionTexts,
    lkgEvents,
    prose,
    replayDifference,
} from "./__tests__/oc2-context.fixture";

// OpenCode 2 sends instruction-update rows as id-less system messages. The
// executing pass moves the history boundary past one of them, and the defer
// pass right after must replay the executing pass's bytes. On the base commit
// the executing pass served the covered instruction row (the delivery trim
// keeps every id-less instruction) while the defer pass dropped it: its
// history trim cut it (no checkpoint), or the restore after a host checkpoint
// started at the new boundary. The request diverged right after the two
// leading session-history messages (m[0] and m[1]). Covered instruction rows
// are now served by every pass.
for (const checkpoint of [true, false])
    test(`issue 750 repro: defer pass after an executed fold replays the execute pass bytes (${checkpoint ? "after a host checkpoint" : "no checkpoint"})`, async () => {
        const f = await fixture(checkpoint ? 750 : 751);
        try {
            f.compartment(4);
            const first = await f.pass();
            const firstReplay = await f.pass();
            expect(firstDivergence(first.draft.messages, firstReplay.draft.messages)).toBeNull();
            if (checkpoint) await f.fold();
            const afterFold = await f.pass();
            const afterFoldReplay = await f.pass();
            expect(
                firstDivergence(afterFold.draft.messages, afterFoldReplay.draft.messages),
            ).toBeNull();
            // Rows 5 onward are served, with "day 2" (row 7).
            expect(instructionTexts(afterFold.draft.messages)).toContain(
                "Today's date is now: day 2.",
            );
            // The next compartment covers rows 5..15, across that instruction row.
            // A reply at 70% of the window makes the next pass an execute pass.
            f.compartment(15);
            f.respond(1, 700_000);
            const execute = await f.pass();
            expect(execute.logs.join("\n")).toMatch(/transform scheduler: .*decision=execute/);
            f.respond();
            const defer = await f.pass();
            expect(defer.logs.join("\n")).toMatch(/transform scheduler: .*decision=defer/);
            expect(defer.draft.system).toEqual(execute.draft.system);
            expect(
                firstDivergence(
                    execute.draft.messages,
                    defer.draft.messages.slice(0, execute.draft.messages.length),
                ),
            ).toBeNull();
            // Every instruction row stays, including the one the new boundary covers.
            const instructions = [
                "Today's date is now: day 2.",
                "Today's date is now: day 6.",
                "Today's date is now: day 8.",
            ];
            expect(instructionTexts(execute.draft.messages)).toEqual(instructions);
            expect(instructionTexts(defer.draft.messages)).toEqual(instructions);
        } finally {
            await f.cleanup();
        }
    }, 60000);

const reminder = (n: number) =>
    `<system-reminder>\nTodo continuation ${n}: keep working on the open items.\n</system-reminder>`;

/**
 * Randomized served-byte differential over the real OpenCode 2 hook. Executing
 * passes (a reply at execute-threshold pressure) and defer passes interleave
 * with new turns, temporal gaps, idle cache expiries, instruction rows, injected
 * reminders (heuristic cleanup), published compartments and host checkpoints. A
 * defer pass must start with the exact messages its predecessor served: checked
 * for every tool-loop follow-up, and for each new turn unless a host checkpoint
 * came before it. An idle expiry is no exception: only the provider forgot the
 * cache, so the request replays.
 * Every pass must also serve every instruction row of the session.
 */
async function runDifferential(provider: string, model: string, seeds: number[], steps: number) {
    let passes = 0;
    let deferChecks = 0;
    let executes = 0;
    let boundaryMoves = 0;
    let instructionsCovered = 0;
    let hardFolds = 0;
    let checkpointPasses = 0;
    const failures: string[] = [];
    for (const seed of seeds) {
        const f = await fixture(seed, { provider, model, cacheTtl: "1h" });
        let random = seed;
        const next = (bound: number) => {
            random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
            return random % bound;
        };
        try {
            f.compartment(4);
            let previous = await f.pass();
            passes++;
            let folds = 0;
            for (let step = 0; step < steps; step++) {
                const action = next(10);
                let comparable = true;
                if (action === 0 && folds < 2 && f.rows.length > 20) {
                    await f.fold(3 + next(3));
                    folds++;
                    // A host checkpoint replaces the head; that request is a new prefix.
                    comparable = false;
                } else if (action <= 2) {
                    // Publish a compartment ending a few rows behind the tail.
                    const limit = f.rows.length - 6;
                    let end = Math.min(limit, f.coveredThrough + 3 + next(6));
                    while (end > f.coveredThrough && f.rows[end]?.type === "system") end--;
                    if (end > f.coveredThrough + 1) {
                        const coveredInstructions = f.rows
                            .slice(f.coveredThrough + 1, end + 1)
                            .filter((row) => row.type === "system").length;
                        f.compartment(end);
                        boundaryMoves++;
                        instructionsCovered += coveredInstructions;
                    }
                } else if (action === 3) {
                    f.instruction(`Today's date is now: ${seed} day ${step}.`);
                }
                if (next(4) === 0) f.idle(2);
                const gap = next(3) === 0 ? 120000 : 600000 + next(4) * 900000;
                f.user(
                    `${next(3) === 0 ? `${reminder(step)}\n` : ""}${seed}/${step}: ${prose.repeat(1 + next(3))}`,
                    gap,
                );
                const current = await f.pass();
                passes++;
                const log = current.logs.join("\n");
                if (/HARD fold decision: .*executed=true/.test(log)) hardFolds++;
                if (folds > 0) checkpointPasses += 2;
                // The first render already allowed a prefix rewrite, so this
                // session serves every instruction row it has, covered or not.
                const allInstructions = f.rows
                    .filter((row) => row.type === "system")
                    .map((row) => row.text);
                if (
                    JSON.stringify(instructionTexts(current.draft.messages)) !==
                    JSON.stringify(allInstructions)
                )
                    failures.push(
                        `${provider} seed ${seed} step ${step}: instruction rows ${JSON.stringify(instructionTexts(current.draft.messages))}`,
                    );
                const deferred = /transform scheduler: .*decision=defer/.test(log);
                if (/transform scheduler: .*decision=execute/.test(log)) executes++;
                if (comparable && deferred) {
                    deferChecks++;
                    const divergence = firstDivergence(
                        previous.draft.messages,
                        current.draft.messages.slice(0, previous.draft.messages.length),
                    );
                    if (
                        divergence ||
                        JSON.stringify(current.draft.system) !==
                            JSON.stringify(previous.draft.system)
                    )
                        failures.push(
                            `${provider} seed ${seed} step ${step}: ${divergence ?? "system changed"}`,
                        );
                }
                f.respond(1 + next(2));
                // The tool-loop follow-up: same turn, five seconds later, always a defer.
                const followUp = await f.pass();
                passes++;
                const followLog = followUp.logs.join("\n");
                if (/transform scheduler: .*decision=execute/.test(followLog)) executes++;
                if (/transform scheduler: .*decision=defer/.test(followLog)) {
                    deferChecks++;
                    const divergence = firstDivergence(
                        current.draft.messages,
                        followUp.draft.messages.slice(0, current.draft.messages.length),
                    );
                    if (
                        divergence ||
                        JSON.stringify(followUp.draft.system) !==
                            JSON.stringify(current.draft.system)
                    )
                        failures.push(
                            `${provider} seed ${seed} step ${step} follow-up: ${divergence ?? "system changed"}`,
                        );
                }
                previous = followUp;
                // Now and then the reply reports execute-threshold pressure, so the
                // next turn's pass executes.
                f.respond(1, next(5) === 0 ? 700_000 : undefined);
            }
        } finally {
            await f.cleanup();
        }
    }
    return {
        passes,
        deferChecks,
        executes,
        hardFolds,
        checkpointPasses,
        boundaryMoves,
        instructionsCovered,
        failures,
    };
}

for (const [provider, model] of [
    ["openai", "gpt-4.1"],
    ["anthropic", "claude-opus-4-1"],
] as const) {
    scaleTest(
        `issue 750 differential: ${provider} defer passes replay their predecessor`,
        async (slow) => {
            const result = await runDifferential(
                provider,
                model,
                slow ? [7501, 7502, 7503, 7504] : [7501, 7502],
                30,
            );
            console.log(`ISSUE750 ${provider} ${JSON.stringify(result)}`);
            expect(result.passes).toBeGreaterThanOrEqual(slow ? 200 : 100);
            expect(result.executes).toBeGreaterThan(0);
            expect(result.instructionsCovered).toBeGreaterThan(0);
            expect(result.checkpointPasses).toBeGreaterThan(0);
            expect(result.failures).toEqual([]);
        },
        600000,
    );
}

for (const checkpoint of [true, false]) {
    test(`issue 750 upgrade: covered instructions first return on a rewriting pass (${checkpoint ? "after a host checkpoint" : "no checkpoint"})`, async () => {
        // Serve the session as releases before the switch did: covered
        // instruction rows were cut by the history trim and not restored.
        setHostInstructionRetentionEnabledForTests(false);
        const f = await fixture(checkpoint ? 7510 : 7511);
        try {
            f.compartment(4);
            await f.pass();
            if (checkpoint) await f.fold();
            await f.pass();
            f.compartment(15);
            f.respond(1, 700_000);
            await f.pass();
            f.respond();
            const legacy = await f.pass();
            expect(legacy.logs.join("\n")).toMatch(/transform scheduler: .*decision=defer/);
            expect(instructionTexts(legacy.draft.messages)).not.toContain(
                "Today's date is now: day 2.",
            );
            // Upgrade: a new process with the switch available, then a defer pass.
            setHostInstructionRetentionEnabledForTests(true);
            await f.restart();
            f.respond();
            const upgraded = await f.pass();
            expect(upgraded.logs.join("\n")).toMatch(/transform scheduler: .*decision=defer/);
            expect(upgraded.draft.system).toEqual(legacy.draft.system);
            expect(
                firstDivergence(
                    legacy.draft.messages,
                    upgraded.draft.messages.slice(0, legacy.draft.messages.length),
                ),
            ).toBeNull();
            // The next pass allowed to rewrite the prefix serves the covered row. A
            // changed system prompt is such a pass; an idle expiry no longer is.
            f.setSystem("A changed system prefix rebuilds the request.");
            const rewrite = await f.pass();
            expect(rewrite.logs.join("\n")).toMatch(/rematerialized=true, reason=system_hash/);
            expect(instructionTexts(rewrite.draft.messages)).toEqual([
                "Today's date is now: day 2.",
                "Today's date is now: day 6.",
                "Today's date is now: day 8.",
            ]);
            f.respond();
            const replay = await f.pass();
            expect(replay.logs.join("\n")).toMatch(/transform scheduler: .*decision=defer/);
            expect(
                firstDivergence(
                    rewrite.draft.messages,
                    replay.draft.messages.slice(0, rewrite.draft.messages.length),
                ),
            ).toBeNull();
        } finally {
            setHostInstructionRetentionEnabledForTests(true);
            await f.cleanup();
        }
    }, 60000);
}

// At 95% context and above a pass waits for the historian and, once the run
// publishes, prepares the history a second time at the new boundary. That
// second cut must set covered instruction rows aside exactly like the first
// cut of the next pass, so the pass that joined the historian and the defer
// pass after it serve the same instruction rows. The historian's model call is
// replaced by a stub that publishes one compartment; the join, the publication
// signal and the re-preparation are the real ones. While a session has a cached
// m[0], both preparations trim at its stored boundary, so the re-preparation
// cuts new rows only on a pass without one (here, after a compaction-mode switch).
test("issue 750: a historian join at 97% and the defer pass after it serve the same bytes", async () => {
    const f = await fixture(752, { historian: true });
    let published = 0;
    const agent = spyOn(incremental, "runCompartmentAgent").mockImplementation(async (deps) => {
        if (published++ > 0) return;
        // Covers rows 5..15, across the "day 2" instruction row (row 7).
        f.compartment(15);
        deps.onCompartmentStatePublished?.(deps.sessionId);
    });
    try {
        f.compartment(4);
        await f.pass();
        f.respond();
        await f.pass();
        // A compaction-mode switch clears the cached m[0]/m[1] payloads, as
        // clearCachedM0Baseline does through the storage accessors,
        // so the next trim follows the newest compartment. That pass arrives at
        // 97% of the window: it blocks on the historian, which publishes a
        // compartment across "day 2".
        f.db.transaction(() => {
            for (const column of [
                "cached_m0_bytes",
                "cached_m1_bytes",
                "cached_m0_mural_data_url",
            ] as const)
                writeSessionRenderCache(f.db, f.session, column, null);
        })();
        f.respond(1, 970_000);
        const joined = await f.pass();
        const joinedLog = joined.logs.join("\n");
        expect(joinedLog).toMatch(/blocking at 97\.\d% until compartment agent completes/);
        expect(joinedLog).toContain("compartment agent completed, refreshing compartment coverage");
        expect(published).toBe(1);
        // The usage after the joined request is ordinary again: a defer pass.
        f.respond();
        const defer = await f.pass();
        expect(defer.logs.join("\n")).toMatch(/transform scheduler: .*decision=defer/);
        expect(defer.draft.system).toEqual(joined.draft.system);
        expect(
            firstDivergence(
                joined.draft.messages,
                defer.draft.messages.slice(0, joined.draft.messages.length),
            ),
        ).toBeNull();
        expect(instructionTexts(joined.draft.messages)).toEqual([
            "Today's date is now: day 2.",
            "Today's date is now: day 6.",
            "Today's date is now: day 8.",
        ]);
    } finally {
        agent.mockRestore();
        await f.cleanup();
    }
}, 60000);

// Without a host checkpoint and without any instruction row there are no
// covered rows. A busy database replays the saved copy of the last good
// request, at admission and inside the transform alike, and the replay serves
// that request's bytes. (Before replay rebuilt the transform input at
// admission, the admission entry lacked the stored message times, and the fit
// check inside the transform compared the saved system prompt with one that
// already carried Magic Context's guidance, so neither path replayed.)
for (const where of ["admission", "transform"] as const)
    test(`issue 750: a busy database before any checkpoint replays the saved request (${where})`, async () => {
        const failure = installTransientFailure();
        const busy = installBusyAdmission();
        const limit = spyOn(models, "getSdkContextLimit").mockReturnValue(1_000_000);
        const f = await fixture(754, { instructions: false });
        try {
            f.compartment(4);
            await f.pass();
            f.respond();
            const before = await f.pass();
            f.respond();
            const anchor = getSlot(f.session)?.lastInputMessageId;
            if (where === "admission") busy.state.busyNext = true;
            else failure.state.failNext = true;
            const failed = await f.attempt();
            console.log(
                `ISSUE750_LKG pre-checkpoint ${where} error=${failed.error ? String(failed.error).slice(0, 80) : "none"} lkg=${lkgEvents(failed.logs)}`,
            );
            expect(lkgEvents(failed.logs)).toBe("lkg_replay_served");
            expect(failed.error).toBeUndefined();
            expect(failed.draft.system).toEqual(before.draft.system);
            expect(
                firstDivergence(
                    before.draft.messages,
                    failed.draft.messages.slice(0, before.draft.messages.length),
                ),
            ).toBeNull();
            // The whole served request, byte for byte: the saved request through
            // its anchor, then every host message after the anchor (the tail),
            // with the saved system and tool list.
            expect(anchor).toBeDefined();
            expect(replayDifference(failed, before, anchor!)).toBeNull();
        } finally {
            busy.restore();
            failure.restore();
            limit.mockRestore();
            await f.cleanup();
        }
    }, 60000);

// After a host checkpoint the restored covered instruction rows reach the
// transform handler without ids, and the request serves them. The saved copy
// must still be captured and the entry check must skip those rows, so a busy
// database replays the saved request, covered rows included: at admission the
// entry is built from the same restored input the transform saved its copy
// from. It may never end as lkg_miss (no saved copy at all).
for (const where of ["admission", "transform"] as const)
    test(`issue 750: a busy database after a checkpoint replays the saved request (${where})`, async () => {
        const failure = installTransientFailure();
        const busy = installBusyAdmission();
        const limit = spyOn(models, "getSdkContextLimit").mockReturnValue(1_000_000);
        const f = await fixture(753);
        try {
            f.compartment(4);
            await f.pass();
            // Every instruction row (rows 7, 16, 21) is covered. Before covered
            // rows were served, the trim cut them all and the request had no
            // id-less row.
            // A reply at 70% of the window makes the next pass an execute pass.
            f.compartment(22);
            f.respond(1, 700_000);
            await f.pass();
            f.respond();
            await f.pass();
            await f.fold();
            f.user(`753 after the checkpoint: ${prose}`, 120000);
            await f.pass();
            f.respond();
            const before = await f.pass();
            f.respond();
            const anchor = getSlot(f.session)?.lastInputMessageId;
            if (where === "admission") busy.state.busyNext = true;
            else failure.state.failNext = true;
            const failed = await f.attempt();
            console.log(
                `ISSUE750_LKG after-checkpoint ${where} error=${failed.error ? String(failed.error).slice(0, 80) : "none"} lkg=${lkgEvents(failed.logs)} instructions=${instructionTexts(before.draft.messages).length}`,
            );
            expect(lkgEvents(failed.logs)).toBe("lkg_replay_served");
            expect(failed.error).toBeUndefined();
            expect(failed.draft.system).toEqual(before.draft.system);
            expect(
                firstDivergence(
                    before.draft.messages,
                    failed.draft.messages.slice(0, before.draft.messages.length),
                ),
            ).toBeNull();
            // The whole served request, byte for byte: the saved request through
            // its anchor, then every host message after the anchor (the tail),
            // with the saved system and tool list.
            expect(anchor).toBeDefined();
            expect(replayDifference(failed, before, anchor!)).toBeNull();
        } finally {
            busy.restore();
            failure.restore();
            limit.mockRestore();
            await f.cleanup();
        }
    }, 60000);

// The switch that serves covered instruction rows decides bytes a later pass
// replays, so a pass that cannot read it, or cannot save it on the pass that
// turns it on, must refuse rather than guess.
for (const failure of ["read", "write"] as const)
    test(`issue 750: a pass refuses when the instruction-row switch cannot be ${failure === "read" ? "read" : "saved"}`, async () => {
        const spy =
            failure === "read"
                ? spyOn(retention, "isHostInstructionRetentionOn").mockImplementation(() => {
                      throw new Error("replay document unreadable");
                  })
                : spyOn(retention, "markHostInstructionRetention").mockReturnValue(false);
        const f = await fixture(failure === "read" ? 755 : 756);
        try {
            f.compartment(4);
            // The first pass may rewrite the whole prefix, so it reads (and on
            // first use saves) the switch.
            const first = await f.attempt();
            const site =
                failure === "read"
                    ? "host-instruction-retention-read-failure"
                    : "host-instruction-retention-persistence-failure";
            expect(first.logs.join("\n")).toContain(`transform refused degraded pass site=${site}`);
            expect(first.error).toBeDefined();
        } finally {
            spy.mockRestore();
            await f.cleanup();
        }
    }, 60000);

// A compartment can end after the host checkpoint. Instruction rows between
// the checkpoint and that boundary are still sent by the host in its own
// window, so the restore must stop at the checkpoint, or those rows would be
// served twice.
test("issue 750: an instruction row after the checkpoint is served once when the boundary passes it", async () => {
    const f = await fixture(757);
    try {
        f.compartment(4);
        await f.pass();
        f.respond();
        await f.pass();
        await f.fold();
        f.user(`757 after the checkpoint: ${prose}`, 120000);
        f.respond(3);
        f.instruction("Today's date is now: after the checkpoint.");
        f.user(`757 next turn: ${prose}`, 120000);
        const boundary = f.rows.length;
        f.respond(3);
        f.user(`757 later turn: ${prose}`, 120000);
        f.respond(3);
        f.user(`757 latest turn: ${prose.repeat(2)}`, 120000);
        await f.pass();
        // A reply at 70% of the window makes the next pass an execute pass.
        f.respond(1, 700_000);
        // The new compartment ends after the checkpoint, past the instruction row.
        f.compartment(boundary);
        const execute = await f.pass();
        f.respond();
        const defer = await f.pass();
        expect(defer.logs.join("\n")).toMatch(/transform scheduler: .*decision=defer/);
        for (const served of [execute, defer])
            expect(
                instructionTexts(served.draft.messages).filter(
                    (text) => text === "Today's date is now: after the checkpoint.",
                ),
            ).toHaveLength(1);
        expect(
            firstDivergence(
                execute.draft.messages,
                defer.draft.messages.slice(0, execute.draft.messages.length),
            ),
        ).toBeNull();
    } finally {
        await f.cleanup();
    }
}, 60000);
