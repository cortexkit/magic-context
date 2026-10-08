import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { RustModeModuleClient } from "../rust-mode-transform";
import { StoreAheadOfBinaryError } from "../store-ahead-refusal";
import {
    decodeProviderRequest,
    encodeProviderRequest,
    freezeProviderPlan,
    type PageResult,
    ProviderClient,
    type ProviderClientOptions,
    type ProviderMethod,
    type StepInputs,
} from "./provider-client";
import {
    acknowledgeStatus,
    applyCompaction,
    assemble,
    type Compaction,
    commitNonViewAnswer,
    createRecord,
    descend,
    encodedBytes,
    issueRequest,
    MAX_REQUEST_BYTES,
} from "./record";

// This suite asserts the reviewed contract, not the behavior of the delivered client.
// Finding tests deliberately fail on b3f735824a5b5aeb70071dc1144bb9fe5eb6f356.
const plan = freezeProviderPlan(
    {
        subscriptions: [
            { hook: "pre_user", ops: ["prepend"], on_unavailable: "pass", budget_ms: 1000 },
            {
                hook: "post_tool",
                ops: ["prepend"],
                on_unavailable: "pass",
                budget_ms: 1000,
            },
        ],
    },
    { preset: "head", params: { serializer_profile: "opencode-aisdk", observation: "answer" } },
);
type Message = { info: { id: string }; parts: { type: string; text: string }[] };
function record() {
    return createRecord<Message, typeof plan>({
        lineage_id: "L",
        plan,
        initial: {
            compaction_id: "initial",
            version: 0,
            range: { from: 0, to: 0 },
            replacement: [],
        },
    });
}
type State = ReturnType<typeof record>;
function append(state: State, id: string, text: string, ingested = false) {
    const message = { info: { id }, parts: [{ type: "text", text }] };
    const ordinal = state.next_ordinal++;
    state.entries.push({
        id,
        ordinal,
        ingest: JSON.stringify(message),
        served: message,
        op_version: 1,
        hook: { answers: [] },
        ingested,
        race: false,
    });
    state.ids.set(id, ordinal);
    state.served_through_ordinal = ordinal;
    if (ingested) state.after_ordinal = ordinal;
}
const step: StepInputs = {
    step_id: "step",
    step_kind: "user_turn",
    model: "m",
    estimate: { request_tokens: 100 },
};
const user = { hook: "pre_user" as const, subject_mid: "m1", subject_ordinal: 1, blocks: ["hi"] };
const tool = {
    hook: "post_tool" as const,
    subject_mid: "m1",
    subject_ordinal: 1,
    step_id: "step",
    tool: "read",
    tool_call_id: "call",
    blocks: ["result"],
    is_error: false,
};
type Call = Parameters<RustModeModuleClient["call"]>[0];
type Wire = { method: ProviderMethod; params: Record<string, unknown> };
function harness(
    reply: (wire: Wire, call: Call) => unknown | Promise<unknown>,
    overrides: Partial<ProviderClientOptions> = {},
) {
    const calls: { wire: Wire; encoded: string; call: Call }[] = [];
    let id = 0;
    const client = new ProviderClient({
        moduleClient: {
            async call(call) {
                const encoded = new TextDecoder().decode(call.body as Uint8Array);
                const wire: Wire = JSON.parse(encoded);
                calls.push({ wire, encoded, call });
                return reply(wire, call);
            },
        },
        sessionId: "s",
        projectRoot: "root",
        harness: "opencode",
        newRequestId: () => `review-${++id}`,
        persistFence: async () => {},
        ...overrides,
    });
    return { client, calls };
}
function twoPages(state: State) {
    // Each entry fits on its own, including controls, but the pair does not.
    append(state, "m1", "x".repeat(1_600_000));
    append(state, "m2", "y".repeat(1_600_000));
}
function continuation({ params }: Wire) {
    return params.more
        ? {
              answer: "wait",
              request_id: params.request_id,
              reason: "next page",
              bound_ms: 3_600_000,
          }
        : { answer: "noop", request_id: params.request_id };
}
async function acknowledge(state: State, result: PageResult) {
    if (result.status !== "answered") throw new Error("Expected an answered page");
    const answer = result.answer.answer;
    if (answer !== "wait" && answer !== "noop") throw new Error("Expected a non-view answer");
    expect(
        commitNonViewAnswer(state, result.request_id, result.arrived_ms, answer),
    ).toBeUndefined();
    acknowledgeStatus(state, new Set(result.page.messages.map((entry) => entry.id)));
}

describe("H3 review findings", () => {
    test("R1: a continuation-page view cannot reach durable application", async () => {
        const state = record();
        twoPages(state);
        const h = harness(({ params }) => ({
            answer: "compaction_message",
            request_id: params.request_id,
            compaction: {
                compaction_id: "premature",
                version: 1,
                range: { from: 0, to: 3 },
                replacement: [{ info: { id: "summary" }, parts: [{ type: "text", text: "fold" }] }],
            },
        }));
        const applications: unknown[] = [];
        await h.client.bootstrap(
            state,
            { ...step, newest: { ordinal: 2, mid: "m2" } },
            async (result) => {
                if (result.status === "answered" && result.answer.answer === "compaction_message") {
                    applications.push(
                        applyCompaction(
                            state,
                            {
                                request_id: result.request_id,
                                arrived_ms: result.arrived_ms,
                                compaction: result.answer.compaction as Compaction<Message>,
                            },
                            () => true,
                        ),
                    );
                }
            },
        );
        // The first request actually has a continuation; this is not a final-page test.
        expect(h.calls[0].wire.params.more).toBe(true);
        expect(h.calls[0].wire.params.messages).toHaveLength(1);
        expect(applications).toEqual([]);
        expect(state.view.compaction_id).toBe("initial");
    });

    test("R2: pipeline_switch is reserved for the final bootstrap page", async () => {
        const state = record();
        twoPages(state);
        const h = harness(continuation);
        await h.client.bootstrap(
            state,
            {
                ...step,
                newest: { ordinal: 2, mid: "m2" },
                prefix_rebuilding: { reason: "pipeline_switch" },
            },
            (result) => acknowledge(state, result),
        );
        expect(h.calls.map(({ wire }) => wire.params.more)).toEqual([true, undefined]);
        expect(h.calls.map(({ wire }) => wire.params.prefix_rebuilding)).toEqual([
            undefined,
            { reason: "pipeline_switch" },
        ]);
    });

    for (const operation of ["hook", "step"] as const) {
        test(`R3: ${operation} omits an empty unserved_subjects list`, async () => {
            const state = record();
            const h = harness(({ params }) => ({
                answer: operation === "hook" ? "pass" : "noop",
                request_id: params.request_id,
            }));
            if (operation === "hook") await h.client.hook(state, user, "{}");
            else await h.client.step(state, step);
            expect(h.calls).toHaveLength(1);
            expect(Object.hasOwn(h.calls[0].wire.params, "unserved_subjects")).toBe(false);
        });
    }

    for (const [label, part] of [
        ["empty", ""],
        ["258 UTF-8 bytes", "漢".repeat(86)],
    ] as const) {
        test(`R4: hook does not send a subject_part that is ${label}`, async () => {
            const h = harness(() => ({ answer: "pass" }));
            // A local throw or an unavailable result is acceptable; dispatch is not.
            await h.client.hook(record(), { ...tool, subject_part: part }, "{}").catch(() => {});
            expect(h.calls).toHaveLength(0);
        });
        test(`R4: step does not send an unserved subject_part that is ${label}`, async () => {
            const state = record();
            state.unserved_subjects = [
                { subject_mid: "m0", hook: "post_tool", subject_part: part },
            ];
            const h = harness(({ params }) => ({ answer: "noop", request_id: params.request_id }));
            await h.client.step(state, step).catch(() => {});
            expect(h.calls).toHaveLength(0);
        });
    }

    test("R5: the exactly representable value 2^64 is not a wire u64", () => {
        expect(() =>
            decodeProviderRequest("transform.hook", {
                session: "s",
                harness: "opencode",
                hook: "pre_user",
                blocks: [],
                subject_mid: "m1",
                subject_ordinal: 2 ** 64,
                message: {},
            }),
        ).toThrow();
    });
});

describe("H3 review controls", () => {
    test("final wait and all-continuation waits terminate without same-page retry", async () => {
        const state = record();
        twoPages(state);
        const h = harness(({ params }) => ({
            answer: "wait",
            request_id: params.request_id,
            reason: "wait forever",
            bound_ms: 0,
        }));
        const callbacks: string[] = [];
        const result = await h.client.bootstrap(state, step, async (page) => {
            callbacks.push(page.status);
            if (page.status === "answered") await acknowledge(state, page);
        });
        expect(result).toMatchObject({ status: "unavailable", reason: "unexpected_wait" });
        expect(h.calls).toHaveLength(2);
        expect(callbacks).toEqual(["answered", "unavailable"]);
        expect(new Set(h.calls.map(({ wire }) => wire.params.request_id)).size).toBe(2);
    });

    test("late transport resolution is not delivered to bootstrap's application callback", async () => {
        const state = record();
        append(state, "m1", "raw");
        let resolve!: (answer: unknown) => void;
        const pending = new Promise<unknown>((done) => {
            resolve = done;
        });
        const h = harness(() => pending, { engineBudgetMs: 10 });
        const received: string[] = [];
        const result = await h.client.bootstrap(state, step, async (page) => {
            received.push(page.status);
        });
        expect(result).toMatchObject({ status: "unavailable", reason: "timeout" });
        resolve({ answer: "noop", request_id: "review-1" });
        await pending;
        await Promise.resolve();
        expect(received).toEqual(["unavailable"]);
        expect(state.view.compaction_id).toBe("initial");
        expect(h.calls).toHaveLength(1);
    });

    test("mismatched, superseded and duplicate step answers cannot apply a view", async () => {
        for (const mode of ["mismatched", "superseded", "duplicate"] as const) {
            const state = record();
            append(state, "m1", "raw");
            const h = harness(({ params }) => {
                if (mode === "superseded") issueRequest(state, "other", Date.now() + 2000);
                return {
                    answer: "compaction_message",
                    request_id: mode === "mismatched" ? "other" : params.request_id,
                    compaction: {
                        compaction_id: "view",
                        version: 1,
                        range: { from: 0, to: 2 },
                        replacement: [],
                    },
                };
            });
            const result = await h.client.step(state, step);
            if (mode !== "duplicate") {
                expect(result).toMatchObject({
                    status: "unavailable",
                    reason: "superseded_request",
                });
                expect(state.view.compaction_id).toBe("initial");
            } else {
                if (result.status !== "answered" || result.answer.answer !== "compaction_message") {
                    throw new Error("Expected one valid view");
                }
                const input = {
                    request_id: result.request_id,
                    arrived_ms: result.arrived_ms,
                    compaction: result.answer.compaction as Compaction<Message>,
                };
                expect(applyCompaction(state, input, () => true)).toEqual({ applied: true });
                expect(applyCompaction(state, input, () => true)).toEqual({
                    applied: false,
                    reason: "superseded_request",
                });
            }
        }
    });

    test("encoded pages include escaped ids, non-ASCII, burn lists, cursors and more within 3 MiB", async () => {
        const state = record();
        const first = 'first漢"\\\n';
        const second = 'second漢"\\\n';
        append(state, first, '漢"\\\n'.repeat(220_000));
        append(state, second, '漢"\\\n'.repeat(220_000));
        state.unserved_subjects = [
            { subject_mid: first, hook: "post_tool", subject_part: "part漢" },
        ];
        const ids = ['id漢"\\\n-1', 'id漢"\\\n-2'];
        const h = harness(continuation, {
            newRequestId: () => ids.shift()!,
            requestIdBytes: 64,
        });
        await h.client.bootstrap(
            state,
            { ...step, newest: { ordinal: 2, mid: second } },
            (result) => acknowledge(state, result),
        );
        expect(h.calls).toHaveLength(2);
        for (const { encoded, wire } of h.calls) {
            expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(
                MAX_REQUEST_BYTES,
            );
            expect(wire.params.unserved_subjects).toEqual(state.unserved_subjects);
        }
        expect(h.calls.map(({ wire }) => wire.params.after_ordinal)).toEqual([0, 1]);
        expect(h.calls.map(({ wire }) => wire.params.more)).toEqual([true, undefined]);
    });

    test("ordinary status neither reads nor reserializes ingested known messages", async () => {
        const state = record();
        append(state, "known", "frozen", true);
        const entry = state.entries[0];
        const served = entry.served;
        Object.defineProperty(entry, "ingest", {
            get: () => {
                throw new Error("known ingest read");
            },
        });
        Object.defineProperty(served, "toJSON", {
            value: () => {
                throw new Error("known serialization");
            },
        });
        const h = harness(({ params }) => ({ answer: "noop", request_id: params.request_id }));
        expect((await h.client.step(state, step)).status).toBe("answered");
        expect(h.calls[0].wire.params.messages).toEqual([]);
        expect(h.calls[0].wire.params.after_ordinal).toBe(1);
        expect(assemble(state)[0]).toBe(served);
        expect(state.counters.content_reads).toBe(0);
        expect(state.counters.message_serializations).toBe(0);
    });

    test("hook watermark stays at the prior durable commit and descends with the revert clamp", async () => {
        const state = record();
        append(state, "m1", "one", true);
        append(state, "m2", "two", true);
        const h = harness(() => ({ answer: "pass" }));
        await h.client.hook(state, { ...user, subject_mid: "m3", subject_ordinal: 3 }, "{}");
        await h.client.hook(state, { ...user, subject_mid: "m4", subject_ordinal: 4 }, "{}");
        descend(state, 1, "child");
        await h.client.hook(state, { ...user, subject_mid: "retry", subject_ordinal: 2 }, "{}");
        expect(h.calls.map(({ wire }) => wire.params.served_through_ordinal)).toEqual([2, 2, 1]);
        expect(h.calls.map(({ wire }) => wire.params.lineage_id)).toEqual(["L", "L", "child"]);
        expect(h.calls[2].wire.params.descends_from).toEqual({
            lineage_id: "L",
            through_ordinal: 1,
        });
        expect(state.served_through_ordinal).toBe(1);
    });

    test("transport failures and generation changes are unavailable, with recovery evidence retained", async () => {
        const error = new StoreAheadOfBinaryError({ dbVersion: 99, binaryMax: 66 });
        const refused = harness(() => {
            throw error;
        });
        const result = await refused.client.hook(record(), user, "{}");
        // H4 must recognize this error before applying on_unavailable: pass.
        expect(result).toMatchObject({ status: "unavailable", reason: "transport", error });
        if (result.status !== "unavailable") throw new Error("Expected unavailability");
        expect(result.error).toBe(error);
        const changed = harness(() => ({
            transport_status: "connection_generation_changed",
            previous_generation: 1,
            current_generation: 2,
        }));
        expect(await changed.client.step(record(), step)).toMatchObject({
            status: "unavailable",
            reason: "invalid_answer",
        });
        expect(changed.calls).toHaveLength(1);
        expect(changed.calls[0].call.generationSensitive).toBe(true);
    });

    test("runner-principal host-plan refusal remains visible and is not retried as declaration", async () => {
        // Admission belongs to ck-mc; this only proves the client's handling of its refusal.
        for (const field of ["params.observation", "params.serializer_profile"]) {
            const refusal = {
                code: "invalid_params",
                message: "host params on runner",
                detail: { field },
            };
            const h = harness(() => {
                throw refusal;
            });
            expect(await h.client.declare({ preset: "head", params: plan.params })).toMatchObject({
                status: "unavailable",
                reason: "transport",
                error: refusal,
            });
            expect(h.calls).toHaveLength(1);
        }
    });

    test("copied commons request payloads survive compact encoding byte for byte without schema reordering", () => {
        let checked = 0;
        for (const [method, lane, file] of [
            ["transform.declare", "step-transform", "declare"],
            ["transform.hook", "step-transform", "hook-requests"],
            ["compaction.setup", "compaction", "setup"],
            ["compaction.step", "compaction", "status"],
        ] as const) {
            const data = JSON.parse(
                readFileSync(
                    new URL(
                        `./__fixtures__/commons-85c105df/${lane}-provider-v1/${file}.json`,
                        import.meta.url,
                    ),
                    "utf8",
                ),
            ) as { requests: { request: Parameters<typeof encodeProviderRequest>[1] }[] };
            for (const { request } of data.requests) {
                // Expected bytes are fixture compact JSON, not client-decoded output.
                const expected = `{"method":"${method}","params":${JSON.stringify(request)}}`;
                expect(encodeProviderRequest(method, request)).toBe(expected);
                checked++;
            }
        }
        expect(checked).toBe(19);
    });

    test("256 UTF-8 byte subject_part is transmitted unchanged", async () => {
        const part = `${"漢".repeat(85)}a`;
        expect(encodedBytes(part)).toBe(256);
        const h = harness(() => ({ answer: "pass" }));
        expect((await h.client.hook(record(), { ...tool, subject_part: part }, "{}")).status).toBe(
            "answered",
        );
        expect(h.calls[0].wire.params.subject_part).toBe(part);
    });
});
