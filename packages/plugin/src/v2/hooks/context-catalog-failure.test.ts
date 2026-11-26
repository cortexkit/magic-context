import { expect, spyOn, test } from "bun:test";
import { readSessionMeta } from "../../features/magic-context/storage-meta-session";
import { refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";
import { V2ContextRefusal } from "./refusal";

const listModels = () => Promise.reject(new Error("host model catalog unavailable"));

test("two turns are managed using the selected model window while its catalog rejects", async () => {
    const f = await oc2ContextFixture(980, {
        area: "catalog-failure",
        provider: "custom",
        model: "catalog-down-small-turns",
        limit: { context: 80_000, input: 20_000, output: 8000 },
        listModels,
    });
    const interrupt = spyOn(f.hostSession, "interrupt");
    try {
        const first = await f.pass();
        expect(interrupt).not.toHaveBeenCalled();
        expect(first.draft.messages).not.toEqual(first.input);

        f.respond(1, 4000);
        f.user("Continue after the last reply.", 1000);
        const second = await f.pass();
        expect(interrupt).not.toHaveBeenCalled();
        expect(second.draft.messages).not.toEqual(second.input);
        expect(readSessionMeta(f.db, f.session).lastUsageContextLimit).toBe(20_000);
        expect(
            f.sessionLogs().filter((line) => line.includes("using selected model limits")),
        ).toHaveLength(1);
    } finally {
        interrupt.mockRestore();
        await f.cleanup();
    }
});

test("a catalog failure still refuses a turn without a valid model window", async () => {
    const f = await oc2ContextFixture(9801, {
        area: "catalog-failure",
        provider: "custom",
        model: "catalog-down-unknown-limit",
        limit: { context: 0 },
        listModels,
    });
    const interrupt = spyOn(f.hostSession, "interrupt");
    try {
        const turn = await f.attempt();
        expect(turn.logs).toContainEqual(expect.stringContaining("arm=usage-unavailable"));
        expect(interrupt).toHaveBeenCalledTimes(1);
    } finally {
        interrupt.mockRestore();
        await f.cleanup();
    }
});

test("the selected model window still refuses a clearly oversized first turn during a catalog failure", async () => {
    const f = await oc2ContextFixture(9802, {
        area: "catalog-failure",
        provider: "custom",
        model: "catalog-down-oversized-turn",
        limit: { context: 800_000, input: 20_000 },
        listModels,
    });
    const interrupt = spyOn(f.hostSession, "interrupt");
    try {
        f.user("A long user message with no reclaimable tool results. ".repeat(15_000), 1000);
        const turn = await f.attempt();
        expect(turn.error).toBeInstanceOf(V2ContextRefusal);
        expect(turn.logs).toContainEqual(expect.stringContaining("over the 20000-token window"));
        expect(turn.logs).toContainEqual(expect.stringContaining("arm=blocking-transform-error"));
        expect(interrupt).toHaveBeenCalledTimes(1);
    } finally {
        interrupt.mockRestore();
        await f.cleanup();
    }
});

test.each([
    { seed: 9803, draftInput: 30_000, cacheInput: 40_000, refused: true },
    { seed: 9804, draftInput: 40_000, cacheInput: 30_000, refused: false },
])("a catalog outage honors a cached cap of $cacheInput against the draft's $draftInput", async ({
    seed,
    draftInput,
    cacheInput,
    refused,
}) => {
    const model = `cached-catalog-down-${seed}`;
    const f = await oc2ContextFixture(seed, {
        area: "catalog-failure",
        provider: "custom",
        model,
        limit: { context: 80_000, input: draftInput, output: 8000 },
        listModels,
    });
    const interrupt = spyOn(f.hostSession, "interrupt");
    try {
        await refreshModelLimitsFromApi({
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: "custom",
                                models: {
                                    [model]: {
                                        limit: { context: 80_000, input: cacheInput, output: 8000 },
                                    },
                                },
                            },
                        ],
                    },
                }),
            },
        });
        const turn = await f.pass();
        if (refused) {
            expect(interrupt).toHaveBeenCalledTimes(1);
            expect(turn.logs).toContainEqual(expect.stringContaining("arm=usage-unavailable"));
        } else {
            expect(interrupt).not.toHaveBeenCalled();
            expect(turn.draft.messages).not.toEqual(turn.input);
            expect(readSessionMeta(f.db, f.session).lastUsageContextLimit).toBe(cacheInput);
        }
    } finally {
        interrupt.mockRestore();
        await f.cleanup();
    }
});
