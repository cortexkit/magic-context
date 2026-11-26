import { expect, spyOn, test } from "bun:test";
import { V2StoreReader } from "../store-reader";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

test("an interrupted main turn cannot replace the managed prefix for a side question", async () => {
    const f = await oc2ContextFixture(981, { area: "generate-refusal" });
    const interrupt = spyOn(f.hostSession, "interrupt");
    const latest = spyOn(V2StoreReader.prototype, "latestAssistant");
    const sideQuestion = "One quick side question.";
    const sideMessage = { role: "user", content: [{ type: "text", text: sideQuestion }] };
    try {
        const served = await f.pass();
        expect(served.draft.messages).not.toEqual(served.input);
        const matchingPrefix = [...served.draft.messages, sideMessage];
        expect((await f.generate(sideQuestion)).messages).toEqual(matchingPrefix);

        latest.mockImplementation(() => {
            throw new Error("cannot read latest usage");
        });
        const refused = await f.attempt();
        expect(refused.error).toBeUndefined();
        expect(refused.logs).toContainEqual(expect.stringContaining("arm=usage-unavailable"));
        expect(interrupt).toHaveBeenCalledWith({ sessionID: f.session });
        expect(refused.draft.messages).toEqual(refused.input);
        expect((await f.generate(sideQuestion)).messages).toEqual(matchingPrefix);

        f.edit(f.rows[0]!.id, "The host history no longer matches the managed prefix.");
        f.user("This new turn does not reach the provider either.", 1000);
        const changed = await f.attempt();
        expect(changed.error).toBeUndefined();
        expect(interrupt).toHaveBeenCalledTimes(2);
        const unmatched = await f.generate(sideQuestion);
        expect(unmatched.messages).toEqual([...changed.input, sideMessage]);
        expect(f.sessionLogs().at(-1)).toContain("generate replay apply skipped:");
    } finally {
        latest.mockRestore();
        interrupt.mockRestore();
        await f.cleanup();
    }
});
