import { expect, spyOn, test } from "bun:test";
import * as persisted from "../../features/magic-context/storage-meta-persisted";
import { retiredLiveInstructionIDs } from "../fold/instruction-supersession";
import { replaceCodeModeCatalog } from "./__tests__/code-mode-catalog.fixture";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

test("a retirement whose signed-thinking persistence failed must account for its first served removal on retry", async () => {
    const f = await oc2ContextFixture(32879, {
        area: "issue-879-review",
        instructions: false,
        temporal: false,
        cacheTtl: "never",
        provider: "anthropic",
        model: "claude-opus-5-5",
    });
    const real = persisted.addMergedReasoningStrippedIds;
    let failStrip = false;
    const strip = spyOn(persisted, "addMergedReasoningStrippedIds").mockImplementation(
        (...args: Parameters<typeof real>) => (failStrip ? false : real(...args)),
    );
    try {
        await f.pass();
        const metadata = { instructionSources: ["core/codemode"] };
        f.instruction(replaceCodeModeCatalog(["OLD_BEFORE_SIGNED"]), metadata);
        const oldID = f.rows.at(-1)!.id;
        f.respond();
        const signedID = f.rows.at(-1)!.id;
        const thinking = (draft: Parameters<NonNullable<Parameters<typeof f.pass>[0]>>[0]) => {
            draft.messages
                .find((message) => message.id === signedID)!
                .content.unshift({
                    type: "reasoning",
                    text: "SIGNED_AGAINST_OLD_INSTRUCTION",
                    native: { anthropic: { signature: "signed-block" } },
                });
        };
        expect((await f.pass(thinking)).bytes).toContain("SIGNED_AGAINST_OLD_INSTRUCTION");
        f.instruction(replaceCodeModeCatalog(["NEW_AFTER_SIGNED"]), metadata);
        f.user("Continue after the completed signed turn.", 1000);
        f.respond(1, 900000);
        // Retirement is recorded before the thinking omission. If the omission
        // cannot be saved, the retry must still remove thinking signed against
        // the old instruction.
        failStrip = true;
        const failed = await f.pass(thinking);
        failStrip = false;
        expect(
            failed.logs.some((line) =>
                line.includes("proactive-thinking-strip-persistence-failure"),
            ),
        ).toBe(true);
        expect(failed.logs.some((line) => line.endsWith("lkg_replay_served"))).toBe(true);
        expect(failed.bytes.includes("OLD_BEFORE_SIGNED")).toBe(true);
        expect(failed.bytes.includes("SIGNED_AGAINST_OLD_INSTRUCTION")).toBe(true);
        expect(retiredLiveInstructionIDs(f.db, f.session).has(oldID)).toBe(true);
        const retry = await f.pass(thinking);
        expect(retry.bytes.includes("OLD_BEFORE_SIGNED")).toBe(false);
        expect(retry.bytes.includes("SIGNED_AGAINST_OLD_INSTRUCTION")).toBe(false);
    } finally {
        strip.mockRestore();
        await f.cleanup();
    }
}, 60000);
