import { afterEach, expect, mock, test } from "bun:test";
import type { RescoreAdmission } from "../../features/magic-context/rescore-service";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import type { HiddenCompletionExecutor, HiddenRunIdentity } from "./compartment-runner-types";
import { createOpenCodeRescoreCarrier, splitModel } from "./rescore-driver";

const dbs: Database[] = [];
afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
});
const request = {
    attempt: { id: "admitted-attempt" },
    prompt: "opaque candidates",
    system: "score-only",
    profile: { model: "mock/score", variant: "low", temperature: 0, maxOutputTokens: 1234 },
} as RescoreAdmission;
function fixture() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    dbs.push(db);
    const open = mock(async (identity: HiddenRunIdentity) => {
        expect(identity.kind).toBe("rescore");
        expect(identity.agent).toBe("rescore");
        expect(identity.configuredModels).toEqual([{ model: "mock/score", qualifier: "low" }]);
        return { id: "score-child" };
    });
    const attempt = mock(async () => {});
    const executor: HiddenCompletionExecutor = {
        capabilities: { tools: false, harness: "opencode" },
        open,
        attempt,
        async collect() {
            return {
                text: "[]",
                usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
                lengthCapped: false,
            };
        },
        async close() {},
    };
    return {
        db,
        open,
        attempt,
        executor,
        carrier: createOpenCodeRescoreCarrier({
            executor,
            db,
            directory: "/project",
            harness: "opencode",
            sessionId: "session",
            timeoutMs: 1000,
        }),
    };
}

test("score completion uses a distinct carrier not historian.complete", async () => {
    const f = fixture();
    let recorded = false;
    expect(
        await f.carrier.complete(request, new AbortController().signal, (id) => {
            expect(id).toBe("score-child");
            recorded = true;
            return true;
        }),
    ).toBe("[]");
    expect(recorded).toBe(true);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.attempt).toHaveBeenCalledTimes(1);
    expect(f.attempt.mock.calls[0]).toMatchObject([
        { id: "score-child" },
        {
            body: {
                agent: "rescore",
                model: { providerID: "mock", modelID: "score" },
                variant: "low",
                temperature: 0,
                maxTokens: 1234,
                system: "score-only",
                tools: {},
            },
        },
    ]);
    expect(f.db.prepare("SELECT subagent, model_id FROM subagent_invocations").all()).toEqual([
        { subagent: "rescore", model_id: "score" },
    ]);
});

test("OpenCode score primary failure places no fallback request", async () => {
    const f = fixture();
    f.executor.attempt = mock(async () => {
        throw new Error("Provider unavailable");
    });
    await expect(
        f.carrier.complete(request, new AbortController().signal, () => true),
    ).rejects.toThrow("Provider unavailable");
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.executor.attempt).toHaveBeenCalledTimes(1);
    expect(f.db.prepare("SELECT subagent, status FROM subagent_invocations").all()).toEqual([
        { subagent: "rescore", status: "failed" },
    ]);
});

test("score carrier never prompts before durable carrier binding", async () => {
    const f = fixture();
    await expect(
        f.carrier.complete(request, new AbortController().signal, () => false),
    ).rejects.toThrow("owner lost");
    expect(f.attempt).not.toHaveBeenCalled();
});

test("score model parsing preserves slash-qualified model ids", () => {
    expect(splitModel("provider/group/model")).toEqual({
        providerID: "provider",
        modelID: "group/model",
    });
    expect(splitModel(null)).toBeUndefined();
    expect(() => splitModel("bare-model")).toThrow("Invalid rescore model");
});
