import { expect, spyOn, test } from "bun:test";
import * as transformModule from "../../hooks/magic-context/transform";
import { V2StoreReader } from "../store-reader";
import { installTransientFailure, oc2ContextFixture } from "./__tests__/oc2-context.fixture";
import { deliverSynthetic } from "./channel2";
import { STORAGE_NOTICE_PREFIX } from "./storage-notice";

const sideQuestion = "One quick side question.";
const sideMessage = { role: "user", content: [{ type: "text", text: sideQuestion }] };

test("an interrupted main turn cannot replace the managed prefix for a side question", async () => {
    const f = await oc2ContextFixture(981, { area: "generate-refusal" });
    const interrupt = spyOn(f.hostSession, "interrupt");
    const latest = spyOn(V2StoreReader.prototype, "latestAssistant");
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

test("a transform that interrupts and returns cannot replace the side-question prefix", async () => {
    const f = await oc2ContextFixture(9811, { area: "generate-refusal" });
    const interrupt = spyOn(f.hostSession, "interrupt");
    const create = transformModule.createTransform;
    let refuse = false;
    const standIn = spyOn(transformModule, "createTransform").mockImplementation((deps) => {
        const real = create(deps);
        const run: typeof real = Object.assign(async (...args: Parameters<typeof real>) => {
            if (!refuse) return real(...args);
            await deps.hostRefuse!(undefined, f.session);
        }, real);
        return run;
    });
    try {
        const served = await f.pass();
        expect(served.draft.messages).not.toEqual(served.input);
        refuse = true;
        const turn = await f.attempt();
        expect(turn.error).toBeUndefined();
        expect(turn.logs).toContainEqual(expect.stringContaining("arm=transform-fail-closed"));
        expect(interrupt).toHaveBeenCalledTimes(1);
        expect((await f.generate(sideQuestion)).messages).toEqual([
            ...served.draft.messages,
            sideMessage,
        ]);
    } finally {
        standIn.mockRestore();
        interrupt.mockRestore();
        await f.cleanup();
    }
});

test("an interrupted storage-notice turn cannot replace the side-question prefix", async () => {
    const f = await oc2ContextFixture(9812, { area: "generate-refusal" });
    const interrupt = spyOn(f.hostSession, "interrupt");
    try {
        const served = await f.pass();
        const text = `${STORAGE_NOTICE_PREFIX}Storage is unavailable.`;
        const id = await deliverSynthetic(
            {
                storage: f.hostStorage,
                session: { ...f.hostSession, synthetic: async () => ({}) },
            },
            f.session,
            text,
        );
        const turn = await f.pass((draft) => {
            draft.messages.push({ id, role: "user", content: [{ type: "text", text }] });
        });
        expect(turn.logs).toContainEqual(expect.stringContaining("arm=storage-notice-turn"));
        expect(interrupt).toHaveBeenCalledTimes(1);
        expect((await f.generate(sideQuestion)).messages).toEqual([
            ...served.draft.messages,
            sideMessage,
        ]);
    } finally {
        interrupt.mockRestore();
        await f.cleanup();
    }
});

test("a served last-good replay is saved for the next side question", async () => {
    const f = await oc2ContextFixture(9813, { area: "generate-refusal" });
    const failure = installTransientFailure();
    try {
        await f.pass();
        f.respond();
        f.user("Continue from the reply.", 1000);
        failure.state.failNext = true;
        const replay = await f.pass();
        expect(replay.logs).toContainEqual(expect.stringContaining("lkg_replay_served"));
        expect((await f.generate(sideQuestion)).messages).toEqual([
            ...replay.draft.messages,
            sideMessage,
        ]);

        // An edit to the user row appended by the replay must break its anchor.
        // The prior managed request anchored before this row would still match.
        f.edit(f.rows.at(-1)!.id, "The host edited the resumed question.");
        const afterEdit = await f.generate(sideQuestion);
        expect(afterEdit.messages).not.toEqual([...replay.draft.messages, sideMessage]);
        expect(f.sessionLogs().at(-1)).toContain("generate replay apply skipped: history-mismatch");
    } finally {
        failure.restore();
        await f.cleanup();
    }
});
