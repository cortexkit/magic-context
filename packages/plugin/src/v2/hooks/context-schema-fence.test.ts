import { expect, spyOn, test } from "bun:test";
import { FAIL_CLOSED_REPROBE_EVERY_N } from "../../features/magic-context/fail-closed-block";
import {
    __resetSchemaFenceStateForTests,
    getSchemaFenceRejection,
    LATEST_SUPPORTED_VERSION,
} from "../../features/magic-context/storage-db";
import { installBusyAdmission, oc2ContextFixture } from "./__tests__/oc2-context.fixture";

const fenceEnv = "MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION";

function restoreFence(previous: string | undefined) {
    if (previous === undefined) delete process.env[fenceEnv];
    else process.env[fenceEnv] = previous;
    __resetSchemaFenceStateForTests();
}

test("a warm OpenCode 2 schema fence interrupts every blocked turn and preserves side-question history", async () => {
    const f = await oc2ContextFixture(9814, {
        area: "context-schema-fence",
        mockStorageBoot: false,
    });
    const interrupt = spyOn(f.hostSession, "interrupt");
    const previous = process.env[fenceEnv];
    try {
        const served = await f.pass();
        expect(served.draft.messages).not.toEqual(served.input);
        expect((await f.pass()).bytes).toBe(served.bytes);

        // Model a newer schema appearing after the serving database handle was cached.
        process.env[fenceEnv] = String(LATEST_SUPPORTED_VERSION - 1);
        const first = await f.attempt();
        expect(getSchemaFenceRejection()).toEqual({
            persistedVersion: LATEST_SUPPORTED_VERSION,
            supportedVersion: LATEST_SUPPORTED_VERSION - 1,
        });
        expect(first.error).toBeUndefined();
        expect(interrupt).toHaveBeenCalledTimes(1);
        expect(first.logs).toContainEqual(expect.stringContaining("arm=storage-unavailable"));
        expect(first.logs).toContainEqual(
            expect.stringContaining(
                "Magic Context build is older than the database; upgrade/restart",
            ),
        );
        const second = await f.attempt();
        expect(second.error).toBeUndefined();
        expect(interrupt).toHaveBeenCalledTimes(2);
        expect(second.logs).toContainEqual(expect.stringContaining("arm=storage-unavailable"));

        const question = "Which history did you get for this side question?";
        expect((await f.generate(question)).messages).toEqual([
            ...served.draft.messages,
            { role: "user", content: [{ type: "text", text: question }] },
        ]);

        // The reprobe must check the store rather than trusting the cached handle.
        restoreFence(previous);
        for (let turn = 3; turn < FAIL_CLOSED_REPROBE_EVERY_N; turn++) {
            expect((await f.attempt()).logs).toContainEqual(
                expect.stringContaining("arm=storage-unavailable"),
            );
        }
        expect(interrupt).toHaveBeenCalledTimes(FAIL_CLOSED_REPROBE_EVERY_N - 1);
        expect((await f.pass()).bytes).toBe(served.bytes);
        expect(interrupt).toHaveBeenCalledTimes(FAIL_CLOSED_REPROBE_EVERY_N - 1);
    } finally {
        restoreFence(previous);
        interrupt.mockRestore();
        await f.cleanup();
    }
});

test("a newly detected schema fence also blocks direct last-good replay on busy admission", async () => {
    const f = await oc2ContextFixture(9817, {
        area: "context-schema-fence",
        mockStorageBoot: false,
    });
    const interrupt = spyOn(f.hostSession, "interrupt");
    const admission = installBusyAdmission();
    const previous = process.env[fenceEnv];
    try {
        const served = await f.pass();
        expect(served.draft.messages).not.toEqual(served.input);
        process.env[fenceEnv] = String(LATEST_SUPPORTED_VERSION - 1);
        admission.state.exhaustNext = true;
        const turn = await f.attempt();
        expect(turn.error).toBeUndefined();
        expect(interrupt).toHaveBeenCalledTimes(1);
        expect(turn.logs).toContainEqual(expect.stringContaining("arm=storage-unavailable"));
        expect(turn.logs).not.toContainEqual(expect.stringContaining("lkg_replay_served"));
    } finally {
        restoreFence(previous);
        admission.restore();
        interrupt.mockRestore();
        await f.cleanup();
    }
});

test("a schema fence at OpenCode 2 startup is refused by the storage gate", async () => {
    const f = await oc2ContextFixture(9818, {
        area: "context-schema-fence",
        mockStorageBoot: false,
    });
    const interrupt = spyOn(f.hostSession, "interrupt");
    const previous = process.env[fenceEnv];
    try {
        process.env[fenceEnv] = String(LATEST_SUPPORTED_VERSION - 1);
        await f.restart();
        const turn = await f.attempt();
        expect(turn.error).toBeUndefined();
        expect(interrupt).toHaveBeenCalledTimes(1);
        expect(turn.logs).toContainEqual(expect.stringContaining("arm=storage-unavailable"));
    } finally {
        restoreFence(previous);
        interrupt.mockRestore();
        await f.cleanup();
    }
});

test.each([
    { seed: 9815, overrides: { compaction: { enabled: false } } },
    { seed: 9816, overrides: { fail_closed_blocking: false } },
])("a schema fence passes host messages through when blocking is disabled ($seed)", async ({
    seed,
    overrides,
}) => {
    const f = await oc2ContextFixture(seed, {
        area: "context-schema-fence",
        configOverrides: overrides,
    });
    const interrupt = spyOn(f.hostSession, "interrupt");
    const previous = process.env[fenceEnv];
    try {
        await f.pass();
        process.env[fenceEnv] = String(LATEST_SUPPORTED_VERSION - 1);
        const turn = await f.attempt();
        expect(getSchemaFenceRejection()).not.toBeNull();
        expect(turn.error).toBeUndefined();
        expect(interrupt).not.toHaveBeenCalled();
        expect(turn.draft.messages).toEqual(turn.input);
    } finally {
        restoreFence(previous);
        interrupt.mockRestore();
        await f.cleanup();
    }
});

test("the OpenCode native title agent remains exempt from schema-fence blocking", async () => {
    const f = await oc2ContextFixture(9819, { area: "context-schema-fence" });
    const interrupt = spyOn(f.hostSession, "interrupt");
    const previous = process.env[fenceEnv];
    try {
        await f.pass();
        process.env[fenceEnv] = String(LATEST_SUPPORTED_VERSION - 1);
        const title = await f.pass((draft) => {
            draft.agent = "title";
        });
        expect(getSchemaFenceRejection()).not.toBeNull();
        expect(interrupt).not.toHaveBeenCalled();
        expect(title.draft.messages).toEqual(title.input);
    } finally {
        restoreFence(previous);
        interrupt.mockRestore();
        await f.cleanup();
    }
});
