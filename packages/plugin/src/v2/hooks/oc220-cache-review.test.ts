import { expect, spyOn, test } from "bun:test";
import { getSlot } from "../../hooks/magic-context/lkg-slot";
import * as models from "../../shared/models-dev-cache";
import {
    installBusyAdmission,
    installTransientFailure,
    lkgEvents,
    oc2ContextFixture,
} from "./__tests__/oc2-context.fixture";

test("cache review: an announcement appended after capture stays pristine across busy replay and defer", async () => {
    const f = await oc2ContextFixture(8820, { area: "oc220-cache-review", instructions: false });
    const admission = installBusyAdmission();
    const limit = spyOn(models, "getSdkContextLimit").mockReturnValue(1_000_000);
    try {
        f.compartment(4);
        f.instruction("Use context A.");
        f.user("Review A.", 1000);
        const saved = await f.pass();
        expect(getSlot(f.session)?.lastInputMessageId).toBe(saved.input.at(-1)!.id);
        f.respond();
        f.instruction("Context A no longer applies.");
        f.user("Continue without A.", 1000);
        admission.state.exhaustNext = true;
        const replay = await f.attempt();
        expect(replay.error).toBeUndefined();
        expect(lkgEvents(replay.logs)).toContain("lkg_replay_served");
        const expected = [...saved.draft.messages, ...replay.input.slice(saved.input.length)];
        expect(JSON.stringify(replay.draft.messages)).toBe(JSON.stringify(expected));
        expect(JSON.stringify(replay.draft.system)).toBe(JSON.stringify(saved.draft.system));
        expect(JSON.stringify(replay.draft.tools)).toBe(JSON.stringify(saved.draft.tools));
        const deferred = await f.pass();
        expect(JSON.stringify(deferred.draft.messages)).toBe(JSON.stringify(expected));
        expect(JSON.stringify(deferred.draft.system)).toBe(JSON.stringify(saved.draft.system));
        expect(deferred.logs.join("\n")).not.toContain("lkg_recovery_input_rebuild");
    } finally {
        limit.mockRestore();
        admission.restore();
        await f.cleanup();
    }
}, 60_000);

test("cache review: recovery defer preserves an instruction appended after the replay", async () => {
    const f = await oc2ContextFixture(8823, { area: "oc220-cache-review", instructions: false });
    const admission = installBusyAdmission();
    const limit = spyOn(models, "getSdkContextLimit").mockReturnValue(1_000_000);
    try {
        f.compartment(4);
        await f.pass();
        f.respond();
        f.user("The busy turn.", 1000);
        admission.state.exhaustNext = true;
        const replay = await f.attempt();
        expect(replay.error).toBeUndefined();
        expect(lkgEvents(replay.logs)).toContain("lkg_replay_served");
        f.respond();
        f.instruction("New instructions after recovery.");
        f.user("Use the new instructions.", 1000);
        const deferred = await f.pass();
        console.log(
            "OC220_RECOVERY_DEFER",
            deferred.logs.find((line) => line.includes("transform scheduler:")),
        );
        expect(deferred.input).toContainEqual({
            role: "system",
            content: [{ type: "text", text: "New instructions after recovery." }],
        });
        expect(deferred.logs.some((line) => line.includes("decision=defer"))).toBe(true);
        expect(deferred.draft.messages.filter((message) => message.role === "system")).toEqual([
            {
                role: "system",
                content: [{ type: "text", text: "New instructions after recovery." }],
            },
        ]);
    } finally {
        limit.mockRestore();
        admission.restore();
        await f.cleanup();
    }
}, 60_000);

test("cache review: busy replay refuses a changed instruction restored before the checkpoint", async () => {
    const f = await oc2ContextFixture(8824, { area: "oc220-cache-review", instructions: true });
    const admission = installBusyAdmission();
    const limit = spyOn(models, "getSdkContextLimit").mockReturnValue(1_000_000);
    try {
        f.compartment(14);
        const covered = f.rows.find((row) => row.type === "system")!;
        const oldText = covered.text;
        expect(f.rows.indexOf(covered)).toBeLessThan(f.coveredThrough);
        await f.pass();
        f.respond();
        await f.pass();
        await f.fold();
        f.user("After the checkpoint.", 120000);
        const saved = await f.pass();
        expect(getSlot(f.session)).toBeDefined();
        expect(JSON.stringify(saved.input)).not.toContain(oldText);
        expect(saved.draft.messages).toContainEqual({
            role: "system",
            content: [{ type: "text", text: oldText }],
        });
        f.edit(covered.id, "Changed covered instruction.");
        f.respond();
        f.user("The busy turn after the covered edit.", 1000);
        admission.state.exhaustNext = true;
        const refused = await f.attempt();
        console.log(
            "OC220_COVERED_EDIT",
            JSON.stringify({
                events: lkgEvents(refused.logs),
                system: refused.draft.messages.filter((message) => message.role === "system"),
            }),
        );
        expect(refused.error).toBeDefined();
        expect(lkgEvents(refused.logs)).not.toContain("lkg_replay_served");
    } finally {
        limit.mockRestore();
        admission.restore();
        await f.cleanup();
    }
}, 60_000);

for (const fault of ["admission-exhausted", "transform"] as const) {
    test(`cache review: ${fault} refuses an edited instruction instead of serving the stale prefix`, async () => {
        const f = await oc2ContextFixture(8821, {
            area: "oc220-cache-review",
            instructions: false,
        });
        const admission = installBusyAdmission();
        const failure = installTransientFailure();
        const limit = spyOn(models, "getSdkContextLimit").mockReturnValue(1_000_000);
        try {
            f.compartment(4);
            f.instruction("Original instructions.");
            const instructionId = f.rows.at(-1)!.id;
            f.user("Use the instructions.", 1000);
            await f.pass();
            expect(getSlot(f.session)).toBeDefined();
            f.edit(instructionId, "Replaced instructions.");
            f.respond();
            f.user("Continue.", 1000);
            if (fault === "transform") failure.state.failNext = true;
            else admission.state.exhaustNext = true;
            const refused = await f.attempt();
            expect(refused.error).toBeDefined();
            expect(lkgEvents(refused.logs)).not.toContain("lkg_replay_served");
            expect(JSON.stringify(refused.draft.messages)).toBe(JSON.stringify(refused.input));
        } finally {
            limit.mockRestore();
            failure.restore();
            admission.restore();
            await f.cleanup();
        }
    }, 60_000);
}

test("cache review: revert refuses the old slot, then a rebuilt baseline can replay", async () => {
    const f = await oc2ContextFixture(8822, { area: "oc220-cache-review", instructions: false });
    const admission = installBusyAdmission();
    const limit = spyOn(models, "getSdkContextLimit").mockReturnValue(1_000_000);
    try {
        f.compartment(4);
        f.instruction("Discarded instructions.");
        const revertId = f.rows.at(-1)!.id;
        f.user("Discarded turn.", 1000);
        await f.pass();
        expect(getSlot(f.session)).toBeDefined();
        f.revertBefore(revertId);
        admission.state.exhaustNext = true;
        const refused = await f.attempt();
        expect(refused.error).toBeDefined();
        expect(lkgEvents(refused.logs)).not.toContain("lkg_replay_served");
        expect(JSON.stringify(refused.draft.messages)).toBe(JSON.stringify(refused.input));

        f.instruction("Replacement instructions.");
        f.user("Replacement turn.", 1000);
        const rebuilt = await f.pass();
        expect(JSON.stringify(rebuilt.draft.messages)).not.toContain("Discarded instructions.");
        expect(JSON.stringify(rebuilt.draft.messages)).toContain("Replacement instructions.");
        expect(getSlot(f.session)?.lastInputMessageId).toBe(rebuilt.input.at(-1)!.id);
        f.respond();
        f.user("Next turn after revert.", 1000);
        admission.state.exhaustNext = true;
        const replay = await f.attempt();
        expect(replay.error).toBeUndefined();
        expect(lkgEvents(replay.logs)).toContain("lkg_replay_served");
        expect(JSON.stringify(replay.draft.messages)).toBe(
            JSON.stringify([
                ...rebuilt.draft.messages,
                ...replay.input.slice(rebuilt.input.length),
            ]),
        );
    } finally {
        limit.mockRestore();
        admission.restore();
        await f.cleanup();
    }
}, 60_000);
