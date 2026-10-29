import { expect, spyOn, test } from "bun:test";
import { loadPersistedLkgSlot } from "../../hooks/magic-context/lkg-persist";
import { getSlot } from "../../hooks/magic-context/lkg-slot";
import * as models from "../../shared/models-dev-cache";
import {
    installBusyAdmission,
    installTransientFailure,
    lkgEvents,
    oc2ContextFixture,
    replayDifference,
} from "./__tests__/oc2-context.fixture";

// Captured @opencode/cli@2.2.0 instruction text. The context hook receives
// only {role: "system", content: [...]}, not the stored message id or metadata
// such as notice and instructionSources.
const update =
    'The context under "k" changed and supersedes the previous value:\n<context key="k">\nv2\n</context>';
const removal = 'The context under "k" no longer applies. Disregard it.';

for (const fault of ["admission", "admission-exhausted", "transform"] as const) {
    test(`OC2 2.2.0 instructions: ${fault} replays the served bytes`, async () => {
        const f = await oc2ContextFixture(7720, {
            area: "oc220-instructions",
            instructions: false,
        });
        const admission = installBusyAdmission();
        const failure = installTransientFailure();
        const limit = spyOn(models, "getSdkContextLimit").mockReturnValue(1_000_000);
        try {
            f.compartment(4);
            f.instruction(update);
            f.user("Use the changed context.", 1000);
            f.instruction(removal);
            f.instruction(update);
            f.user("Continue the review.", 1000);
            const saved = await f.pass();
            const slot = getSlot(f.session);
            expect(slot).toBeDefined();
            // Successful passes publish their saved request in setImmediate.
            for (let tick = 0; tick < 3; tick++)
                await new Promise<void>((resolve) => setImmediate(resolve));
            const persisted = loadPersistedLkgSlot(f.db, f.session);
            expect(persisted?.inputIdSeq).toEqual(slot!.inputIdSeq);
            expect(persisted?.jsonPrefix).toBe(slot!.jsonPrefix);
            const announcements = saved.draft.messages.filter(
                (message) => message.role === "system",
            );
            expect(announcements).toEqual(
                [update, removal, update].map((text) => ({
                    role: "system",
                    content: [{ type: "text", text }],
                })),
            );
            f.respond();
            f.user("Next turn while the database is busy.", 1000);
            if (fault === "transform") failure.state.failNext = true;
            else if (fault === "admission") admission.state.busyNext = true;
            else admission.state.exhaustNext = true;
            const replay = await f.attempt();
            expect(replay.error).toBeUndefined();
            expect(lkgEvents(replay.logs)).toContain("lkg_replay_served");
            expect(replayDifference(replay, saved, slot!.lastInputMessageId)).toBeNull();
            expect(
                JSON.stringify(
                    replay.draft.messages.filter((message) => message.role === "system"),
                ),
            ).toBe(JSON.stringify(announcements));
            const resumed = await f.pass();
            expect(replayDifference(resumed, saved, slot!.lastInputMessageId)).toBeNull();
            expect(resumed.logs.join("\n")).not.toContain("lkg_recovery_input_rebuild");
            const resumedAnchor = getSlot(f.session)!.lastInputMessageId;
            f.respond();
            admission.state.busyNext = true;
            const followUp = await f.attempt();
            expect(followUp.error).toBeUndefined();
            expect(lkgEvents(followUp.logs)).toContain("lkg_replay_served");
            expect(replayDifference(followUp, resumed, resumedAnchor)).toBeNull();
        } finally {
            limit.mockRestore();
            failure.restore();
            admission.restore();
            await f.cleanup();
        }
    }, 60000);
}
