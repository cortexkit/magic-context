import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { RustModeModuleClient } from "../rust-mode-transform";
import {
    decodeProviderAnswer,
    decodeProviderRequest,
    encodeProviderRequest,
    type FrozenProviderPlan,
    freezeProviderPlan,
    ProviderClient,
    type ProviderClientOptions,
    type ProviderFence,
    type ProviderMethod,
    type StepInputs,
} from "./provider-client";
import {
    acknowledgeStatus,
    applyCompaction,
    assemble,
    commitNonViewAnswer,
    createRecord,
    descendModuleAhead,
    encodedBytes,
    issueRequest,
    MAX_REQUEST_BYTES,
    type RunnerRecord,
} from "./record";

type Vector = {
    name: string;
    request: Record<string, unknown>;
    answer: Record<string, unknown>;
    declaration: Record<string, unknown>;
};
function vectors(lane: string, file: string): Record<string, Vector[]> {
    return JSON.parse(
        readFileSync(
            new URL(
                `./__fixtures__/commons-c1591d4a/${lane}-provider-v1/${file}.json`,
                import.meta.url,
            ),
            "utf8",
        ),
    );
}

// These fixtures are copied verbatim from commons c1591d4a76fa3d3a7367237922b0bca5214dbf11.
// Expectations come from the fixtures, not from the client or its schemas.
for (const [method, lane, file, answerField] of [
    ["transform.declare", "step-transform", "declare", "declaration"],
    ["transform.hook", "step-transform", "hook-requests", "answer"],
    ["compaction.setup", "compaction", "setup", "answer"],
    ["compaction.step", "compaction", "status", "answer"],
] as const) {
    const data = vectors(lane, file);
    describe(`commons request vectors: ${method}`, () => {
        for (const vector of [
            ...data.requests,
            ...(data.tolerated ?? []).filter((v) => v.request),
        ]) {
            test(vector.name, () => {
                const expected =
                    method === "compaction.step"
                        ? vector.request
                        : { params: {}, ...vector.request };
                const decoded = decodeProviderRequest(method, vector.request);
                expect<unknown>(decoded).toEqual(expected);
                expect(JSON.parse(encodeProviderRequest(method, decoded))).toEqual({
                    method,
                    params: expected,
                });
                expect(encodeProviderRequest(method, decoded)).toBe(
                    JSON.stringify({ method, params: decoded }),
                );
            });
        }
        for (const vector of (data.undecodable ?? []).filter((v) => v.request)) {
            test(`rejects ${vector.name}`, () => {
                expect(() => decodeProviderRequest(method, vector.request)).toThrow();
            });
        }
    });
    if (method !== "transform.hook" && method !== "compaction.step") {
        describe(`commons answer vectors: ${method}`, () => {
            for (const vector of [
                ...(data.declarations ?? data.answers),
                ...(data.tolerated ?? []).filter((v) => v[answerField]),
            ]) {
                test(vector.name, () =>
                    expect<unknown>(decodeProviderAnswer(method, vector[answerField])).toEqual(
                        vector[answerField],
                    ),
                );
            }
            for (const vector of (data.undecodable ?? []).filter((v) => v[answerField])) {
                test(`rejects ${vector.name}`, () =>
                    expect(() => decodeProviderAnswer(method, vector[answerField])).toThrow());
            }
        });
    }
}
for (const [method, lane, file] of [
    ["transform.hook", "step-transform", "hook-answers"],
    ["compaction.step", "compaction", "answers"],
] as const) {
    const data = vectors(lane, file);
    describe(`commons answer vectors: ${method}`, () => {
        for (const vector of [...data.answers, ...data.tolerated]) {
            test(vector.name, () =>
                expect<unknown>(decodeProviderAnswer(method, vector.answer)).toEqual(vector.answer),
            );
        }
        for (const vector of data.undecodable) {
            test(`rejects ${vector.name}`, () =>
                expect(() => decodeProviderAnswer(method, vector.answer)).toThrow());
        }
    });
}
for (const [method, lane] of [
    ["transform.hook", "step-transform"],
    ["compaction.step", "compaction"],
] as const) {
    const data = vectors(lane, "host-runner");
    describe(`commons host vectors: ${method}`, () => {
        for (const vector of [...data.requests, ...(data.invalid_pairs ?? [])]) {
            test(vector.name, () => {
                const decoded = decodeProviderRequest(method, vector.request);
                expect<unknown>(decoded).toEqual(
                    method === "compaction.step"
                        ? vector.request
                        : { params: {}, ...vector.request },
                );
                expect(JSON.parse(encodeProviderRequest(method, decoded))).toEqual({
                    method,
                    params: decoded,
                });
            });
        }
        for (const vector of data.undecodable_requests ?? data.undecodable) {
            test(`rejects ${vector.name}`, () =>
                expect(() => decodeProviderRequest(method, vector.request)).toThrow());
        }
        for (const vector of [
            ...(data.summaries ?? []),
            ...(data.refusals ?? []).filter((v) => v.answer),
        ]) {
            test(vector.name, () =>
                expect<unknown>(decodeProviderAnswer(method, vector.answer)).toEqual(vector.answer),
            );
        }
        for (const vector of data.undecodable_answers ?? []) {
            test(`rejects ${vector.name}`, () =>
                expect(() => decodeProviderAnswer(method, vector.answer)).toThrow());
        }
    });
}

const plan = freezeProviderPlan(
    {
        subscriptions: [
            {
                hook: "pre_user",
                ops: ["prepend", "append"],
                on_unavailable: "pass",
                budget_ms: 1500,
            },
            { hook: "post_assistant", ops: ["prepend"], budget_ms: 500 },
            {
                hook: "post_tool",
                ops: ["prepend", "append", "replace"],
                tools: ["read"],
                on_unavailable: "pass",
                budget_ms: 500,
            },
        ],
    },
    { preset: "head", params: { serializer_profile: "opencode-aisdk", observation: "answer" } },
);
type Message = { info: { id: string }; parts: { type: string; text: string }[] };
function record(): RunnerRecord<Message, FrozenProviderPlan> {
    return createRecord({
        lineage_id: "L",
        plan,
        initial: { compaction_id: "setup", version: 0, range: { from: 0, to: 0 }, replacement: [] },
    });
}
function append(
    state: RunnerRecord<Message, FrozenProviderPlan>,
    id: string,
    text: string,
    ingested = false,
): string {
    const message = { info: { id }, parts: [{ type: "text", text }] };
    const ingest = JSON.stringify(message);
    const ordinal = state.next_ordinal++;
    state.entries.push({
        id,
        ordinal,
        ingest,
        served: message,
        op_version: 1,
        hook: { answers: [] },
        ingested,
        race: false,
    });
    state.ids.set(id, ordinal);
    state.served_through_ordinal = ordinal;
    return ingest;
}
const step: StepInputs = {
    step_id: "step",
    step_kind: "user_turn",
    model: "m",
    estimate: { request_tokens: 100 },
};
const hook = {
    hook: "pre_user" as const,
    subject_mid: "m1",
    subject_ordinal: 1,
    blocks: ["hello"],
};
type CallArgs = Parameters<RustModeModuleClient["call"]>[0];
function harness(
    reply: (
        wire: { method: ProviderMethod; params: Record<string, unknown> },
        args: CallArgs,
    ) => Promise<unknown> | unknown,
    overrides: Partial<ProviderClientOptions> = {},
) {
    const calls: {
        args: CallArgs;
        encoded: string;
        wire: { method: ProviderMethod; params: Record<string, unknown> };
    }[] = [];
    const fences: ProviderFence[] = [];
    const events: string[] = [];
    let nextId = 0;
    const receiver = {
        routeRoot: "root",
        async call(args: CallArgs): Promise<unknown> {
            expect(this.routeRoot).toBe("root");
            expect(args.body).toBeInstanceOf(Uint8Array);
            const encoded = new TextDecoder().decode(args.body as Uint8Array);
            const wire = JSON.parse(encoded);
            calls.push({ args, encoded, wire });
            expect(encodedBytes(encoded)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
            expect(Object.keys(wire)).toEqual(["method", "params"]);
            events.push(`send:${wire.params.request_id ?? wire.method}`);
            return reply(wire, args);
        },
    };
    const options: ProviderClientOptions = {
        moduleClient: receiver,
        sessionId: "s",
        projectRoot: "root",
        harness: "opencode",
        newRequestId: () => `r${++nextId}`,
        persistFence: async (fence) => {
            events.push(`fence:${fence.request_id}`);
            fences.push({ ...fence });
        },
        ...overrides,
    };
    return { client: new ProviderClient(options), calls, fences, events };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { resolve, promise };
}

describe("host provider transport", () => {
    test("declaration is pure config, setup persists its fence before sending on either host", async () => {
        for (const host of ["opencode", "opencode2"] as const) {
            const state = record();
            const h = harness(
                ({ method, params }) =>
                    method === "transform.declare"
                        ? { subscriptions: plan.subscriptions }
                        : {
                              answer: "ready",
                              request_id: params.request_id,
                              initial: state.view,
                          },
                { harness: host, now: () => 10 },
            );
            expect((await h.client.declare({ preset: "head", params: plan.params })).status).toBe(
                "answered",
            );
            expect(h.calls[0].wire).toEqual({
                method: "transform.declare",
                params: { preset: "head", params: plan.params },
            });
            expect(h.fences).toHaveLength(0);
            const result = await h.client.setup(state, {
                composition: {},
                model: "m",
                variant: "v",
                context_window: 1000,
                output_limit: 100,
            });
            expect(result.status).toBe("answered");
            expect(h.events).toEqual(["send:transform.declare", "fence:r2", "send:r2"]);
            expect(h.calls[1].wire.params).toEqual({
                session: "s",
                harness: host,
                request_id: "r2",
                lineage_id: "L",
                preset: "head",
                params: plan.params,
                composition: {},
                model: "m",
                variant: "v",
                context_window: 1000,
                output_limit: 100,
                now: 10,
            });
            expect(state.issued).toMatchObject({
                request_id: "r2",
                newest: 0,
                lineage_id: "L",
                deadline_ms: 2010,
            });
            expect(state.view.compaction_id).toBe("setup");
        }
    });
    test("hooks carry committed high-water, burn list, part identity and final pass barrier with verbatim ingest", async () => {
        const state = record();
        state.served_through_ordinal = 90;
        state.next_ordinal = 91;
        state.descends_from = { lineage_id: "parent", through_ordinal: 90 };
        state.unserved_subjects = [
            { subject_mid: "old", hook: "post_tool", subject_part: "part0" },
        ];
        const h = harness(
            () => ({ answer: "ops", ops: [{ op: "prepend", block: 0, text: "§1§ " }] }),
            { now: () => 1, engineBudgetMs: 300 },
        );
        const ingest = '{"parts":[{"text":"héllo\\n\\"","type":"text"}],"info":{"id":"m1"}}';
        const subject = {
            hook: "post_tool" as const,
            subject_mid: "m1",
            subject_ordinal: 91,
            subject_part: "part1",
            step_id: "step",
            tool: "read",
            tool_call_id: "duplicate",
            blocks: ["hello"],
            is_error: false,
        };
        const result = await h.client.hook(state, subject, ingest, true);
        expect(result.status).toBe("answered");
        expect(h.calls[0].encoded).toContain(`"message":${ingest}`);
        expect(h.calls[0].wire.params).toMatchObject({
            ...subject,
            request_id: "r1",
            preset: "head",
            params: plan.params,
            served_through_ordinal: 90,
            unserved_subjects: state.unserved_subjects,
            descends_from: state.descends_from,
            pass_complete: true,
            budget_ms: 300,
            on_unavailable: "pass",
        });
        expect(h.fences[0]).toEqual({
            request_id: "r1",
            newest: 90,
            lineage_id: "L",
            deadline_ms: 301,
        });
        expect(h.calls[0].args.timeoutMs).toBe(300);
        expect(h.calls[0].args.generationSensitive).toBe(true);
        expect(state.served_through_ordinal).toBe(90);
        expect(state.unserved_subjects).toHaveLength(1);
    });
    test("ordinary status sends only un-ingested content and never advances a durable cursor by itself", async () => {
        const state = record();
        append(state, "m1", "tagged", true);
        append(state, "m2", "raw");
        state.after_ordinal = 1;
        state.unserved_subjects = [{ subject_mid: "m2", hook: "pre_user" }];
        const h = harness(({ params }) => ({ answer: "noop", request_id: params.request_id }), {
            now: () => 10,
        });
        const before = assemble(state);
        const result = await h.client.step(state, {
            ...step,
            newest: { ordinal: 2, mid: "m2" },
            prefix_rebuilding: { reason: "flush" },
        });
        expect(result.status).toBe("answered");
        expect(h.calls[0].wire.params).toMatchObject({
            request_id: "r1",
            lineage_id: "L",
            served_through_ordinal: 2,
            after_ordinal: 1,
            last_applied: { compaction_id: "setup", version: 0 },
            unserved_subjects: state.unserved_subjects,
        });
        expect(h.calls[0].wire.params.more).toBeUndefined();
        expect(h.calls[0].wire.params.messages).toEqual([
            { ordinal: 2, mid: "m2", message: state.entries[1].served },
        ]);
        expect(state.after_ordinal).toBe(1);
        expect(state.entries[1].ingested).toBe(false);
        expect(assemble(state)[0]).toBe(before[0]);
    });
    test("wait without more is unavailable and is never re-issued", async () => {
        const state = record();
        append(state, "m1", "raw");
        const h = harness(({ params }) => ({
            answer: "wait",
            request_id: params.request_id,
            reason: "scan",
            bound_ms: 0,
        }));
        const result = await h.client.step(state, step);
        expect(result).toMatchObject({ status: "unavailable", reason: "unexpected_wait" });
        expect(h.calls).toHaveLength(1);
        expect(state.after_ordinal).toBe(0);
        expect(state.entries[0].ingested).toBe(false);
    });
    test("bootstrap continuation wait sends the next encoded page immediately, after durable acknowledgement", async () => {
        const state = record();
        for (let i = 1; i <= 3; i++) append(state, `m${i}`, '漢"\\\n'.repeat(200_000));
        const h = harness(({ params }) => ({
            answer: params.more ? "wait" : "noop",
            request_id: params.request_id,
            reason: "more",
            bound_ms: 3_600_000,
        }));
        const before = assemble(state);
        const result = await h.client.bootstrap(
            state,
            { ...step, newest: { ordinal: 3, mid: "m3" } },
            async (result) => {
                if (result.status !== "answered") throw new Error("unexpected failure");
                h.events.push(`ack:${result.request_id}`);
                expect(
                    commitNonViewAnswer(
                        state,
                        result.request_id,
                        result.arrived_ms,
                        result.answer.answer as "wait" | "noop",
                    ),
                ).toBeUndefined();
                acknowledgeStatus(state, new Set(result.page.messages.map((entry) => entry.id)));
            },
        );
        expect(result.status).toBe("answered");
        expect(h.calls).toHaveLength(3);
        expect(h.events).toEqual([
            "fence:r1",
            "send:r1",
            "ack:r1",
            "fence:r2",
            "send:r2",
            "ack:r2",
            "fence:r3",
            "send:r3",
            "ack:r3",
        ]);
        expect(h.calls.map((call) => call.wire.params.after_ordinal)).toEqual([0, 1, 2]);
        expect(h.calls.map((call) => call.wire.params.more)).toEqual([true, true, undefined]);
        expect(h.calls.map((call) => call.wire.params.served_through_ordinal)).toEqual([3, 3, 3]);
        expect(state.after_ordinal).toBe(3);
        expect(assemble(state)).toEqual(before);
        expect(assemble(state)[0]).toBe(before[0]);
    });
    test("bootstrap stops on a final wait or refusal and never replays a page", async () => {
        for (const answer of ["wait", "refuse"] as const) {
            const state = record();
            append(state, "m1", "hello");
            const h = harness(({ params }) => ({
                answer,
                request_id: params.request_id,
                reason: "busy",
                code: "provider_busy",
                bound_ms: 0,
            }));
            let acknowledgements = 0;
            const result = await h.client.bootstrap(state, step, async () => {
                acknowledgements++;
            });
            expect(result.status).toBe(answer === "wait" ? "unavailable" : "answered");
            expect(h.calls).toHaveLength(1);
            expect(acknowledgements).toBe(1);
        }
    });
    test("durable fence or page acknowledgement failure refuses the turn rather than sending more", async () => {
        const state = record();
        const h = harness(() => ({ answer: "pass" }), {
            persistFence: async () => {
                throw new Error("disk full");
            },
        });
        await expect(h.client.hook(state, hook, "{}")).rejects.toThrow("disk full");
        expect(h.calls).toHaveLength(0);
        expect(state.issued).toBeUndefined();
        for (let i = 1; i <= 2; i++) append(state, `m${i}`, "x".repeat(2_000_000));
        const pages = harness(({ params }) => ({
            answer: "wait",
            request_id: params.request_id,
            reason: "more",
            bound_ms: 1,
        }));
        await expect(
            pages.client.bootstrap(state, step, async () => {
                throw new Error("answer write failed");
            }),
        ).rejects.toThrow("answer write failed");
        expect(pages.calls).toHaveLength(1);
    });
    test("timeout abandons every operation even when the transport ignores cancellation", async () => {
        for (const operation of ["declare", "setup", "hook", "step"] as const) {
            const state = record();
            append(state, "m1", "raw");
            const late = deferred<unknown>();
            const h = harness(() => late.promise, { engineBudgetMs: 5 });
            const pending =
                operation === "declare"
                    ? h.client.declare({ params: {} })
                    : operation === "setup"
                      ? h.client.setup(state, { model: "m", composition: {} })
                      : operation === "hook"
                        ? h.client.hook(state, hook, state.entries[0].ingest)
                        : h.client.step(state, step);
            const result = await pending;
            expect(result).toMatchObject({ status: "unavailable", reason: "timeout" });
            expect(h.calls[0].args.signal?.aborted).toBe(true);
            const view = state.view;
            late.resolve({
                answer: "compaction_message",
                request_id: "r1",
                compaction: {
                    compaction_id: "late",
                    version: 99,
                    range: { from: 0, to: 2 },
                    replacement: [],
                },
            });
            await Promise.resolve();
            expect(state.view).toBe(view);
            expect(state.after_ordinal).toBe(0);
            expect(h.calls).toHaveLength(1);
        }
    });
    test("a response at the deadline is unavailable even before the timeout task fires", async () => {
        let now = 1;
        const state = record();
        const h = harness(
            ({ params }) => {
                now = 11;
                return { answer: "noop", request_id: params.request_id };
            },
            { now: () => now, engineBudgetMs: 10 },
        );
        expect(await h.client.step(state, step)).toMatchObject({
            status: "unavailable",
            reason: "late",
        });
        expect(state.after_ordinal).toBe(0);
    });
    test("superseded answers and mismatched response ids never reach application", async () => {
        for (const changeFence of [false, true]) {
            const state = record();
            const h = harness(({ params }) => {
                if (changeFence) issueRequest(state, "newer", Date.now() + 2000);
                return {
                    answer: "compaction_message",
                    request_id: changeFence ? params.request_id : "wrong",
                    compaction: {
                        compaction_id: "bad",
                        version: 99,
                        range: { from: 0, to: 0 },
                        replacement: [],
                    },
                };
            });
            const result = await h.client.step(state, step);
            expect(result).toMatchObject({ status: "unavailable", reason: "superseded_request" });
            expect(state.view.compaction_id).toBe("setup");
        }
    });
    test("unknown answers, transport errors and generation changes are unavailable, never noop", async () => {
        for (const response of [
            { answer: "NOOP", request_id: "r1" },
            { transport_status: "connection_generation_changed" },
            new Error("offline"),
        ]) {
            const h = harness(() => {
                if (response instanceof Error) throw response;
                return response;
            });
            const result = await h.client.step(record(), step);
            expect(result.status).toBe("unavailable");
            expect(h.calls).toHaveLength(1);
        }
    });
    test("hook refusal retains the error for descent/store-ahead recovery", async () => {
        const error = {
            code: "invalid_params",
            message: "module ahead",
            detail: { field: "subject_ordinal" },
        };
        const h = harness(() => {
            throw error;
        });
        expect(await h.client.hook(record(), hook, "{}")).toMatchObject({
            status: "unavailable",
            reason: "transport",
            error,
            on_unavailable: "pass",
        });
    });
    test("disallowed operations or answer kinds are unavailable under the frozen policy", async () => {
        for (const answer of [
            { answer: "ops", ops: [{ op: "replace", block: 0, value: "x" }] },
            { answer: "ops", ops: [{ op: "append", block: 1, text: "x" }] },
            { answer: "deny", text: "no" },
        ]) {
            const h = harness(() => answer);
            expect(await h.client.hook(record(), hook, "{}")).toMatchObject({
                status: "unavailable",
                reason: "invalid_answer",
                on_unavailable: "pass",
            });
        }
    });
    test("frozen plan data and default policies cannot drift after admission", async () => {
        const declaration = {
            subscriptions: [
                { hook: "post_assistant" as const, ops: ["prepend" as const], budget_ms: 70 },
            ],
        };
        const params = { observation: "answer" };
        const frozen = freezeProviderPlan(declaration, { params });
        declaration.subscriptions[0].budget_ms = 999;
        params.observation = "read";
        expect(frozen.subscriptions[0].budget_ms).toBe(70);
        expect(frozen.params.observation).toBe("answer");
        expect(Object.isFrozen(frozen.subscriptions[0])).toBe(true);
        const state = record();
        state.plan = frozen;
        const h = harness(() => ({ answer: "pass" }), { now: () => 1 });
        expect(
            (await h.client.hook(state, { ...hook, hook: "post_assistant", step_id: "step" }, "{}"))
                .status,
        ).toBe("answered");
        expect(h.calls[0].wire.params).toMatchObject({ on_unavailable: "pass", budget_ms: 70 });
    });
    test("encoded hook cap includes blocks and escaped/non-ASCII bytes, not just ingest", async () => {
        const state = record();
        const ingest = JSON.stringify({ text: "x".repeat(MAX_REQUEST_BYTES - 200) });
        expect(encodedBytes(ingest)).toBeLessThan(MAX_REQUEST_BYTES);
        const h = harness(() => ({ answer: "pass" }));
        const result = await h.client.hook(
            state,
            { ...hook, blocks: ['漢"\\\n'.repeat(100)] },
            ingest,
        );
        expect(result).toMatchObject({
            status: "unavailable",
            reason: "oversize",
            on_unavailable: "pass",
        });
        expect(h.calls).toHaveLength(0);
        expect(h.fences).toHaveLength(0);
        expect(state.issued).toBeUndefined();
    });
    test("a hook exactly at 3 MiB is sent; one encoded byte more is not", async () => {
        const state = record();
        const h = harness(() => ({ answer: "pass" }), { now: () => 1 });
        await h.client.hook(state, hook, '""');
        const overhead = encodedBytes(h.calls[0].encoded) - 2;
        const fitting = `"${"x".repeat(MAX_REQUEST_BYTES - overhead - 2)}"`;
        expect((await h.client.hook(state, hook, fitting)).status).toBe("answered");
        expect(encodedBytes(h.calls[1].encoded)).toBe(MAX_REQUEST_BYTES);
        expect(await h.client.hook(state, hook, fitting.replace('"', '"x'))).toMatchObject({
            status: "unavailable",
            reason: "oversize",
        });
        expect(h.calls).toHaveLength(2);
    });
    test("a single-entry encoded status over the cap is never sent", async () => {
        const state = record();
        append(state, "m1", "漢".repeat(1_049_000));
        const h = harness(() => ({ answer: "noop", request_id: "r1" }));
        expect(await h.client.step(state, step)).toMatchObject({
            status: "unavailable",
            reason: "oversize",
            exit_reason: "provider_message_too_large",
        });
        expect(h.calls).toHaveLength(0);
        expect(h.fences).toHaveLength(0);
    });
    test("oversize declaration and setup envelopes are not sent", async () => {
        const h = harness(() => ({ subscriptions: [] }));
        const params = { huge: "x".repeat(MAX_REQUEST_BYTES) };
        expect(await h.client.declare({ params })).toMatchObject({
            status: "unavailable",
            reason: "oversize",
        });
        const state = record();
        state.plan = freezeProviderPlan({ subscriptions: [] }, { params });
        expect(await h.client.setup(state, { model: "m", composition: {} })).toMatchObject({
            status: "unavailable",
            reason: "oversize",
        });
        expect(h.calls).toHaveLength(0);
    });
    test("an expired persisted fence, cancellation and overlapping calls cannot dispatch", async () => {
        let now = 1;
        const h = harness(() => ({ answer: "pass" }), {
            now: () => now,
            persistFence: async () => {
                now += 2000;
            },
        });
        expect(await h.client.hook(record(), hook, "{}")).toMatchObject({
            status: "unavailable",
            reason: "timeout",
        });
        expect(h.calls).toHaveLength(0);
        const controller = new AbortController();
        controller.abort();
        const cancelled = harness(() => ({ answer: "pass" }));
        expect(
            await cancelled.client.hook(record(), hook, "{}", undefined, controller.signal),
        ).toMatchObject({ status: "unavailable", reason: "aborted" });
        expect(cancelled.calls).toHaveLength(0);
        const pending = deferred<unknown>();
        const busy = harness(() => pending.promise);
        const first = busy.client.declare({ params: {} });
        expect(await busy.client.declare({ params: {} })).toMatchObject({
            status: "unavailable",
            reason: "in_flight",
        });
        pending.resolve({ subscriptions: [] });
        expect((await first).status).toBe("answered");
        expect(busy.calls).toHaveLength(1);
    });
    test("record changes during fence persistence fail closed before dispatch", async () => {
        for (const change of ["newest", "lineage", "fence"] as const) {
            const state = record();
            const h = harness(() => ({ answer: "pass" }), {
                persistFence: async () => {
                    if (change === "newest") append(state, "race", "new");
                    if (change === "lineage") state.lineage_id = "different";
                    if (change === "fence") issueRequest(state, "outside", Date.now() + 2000);
                },
            });
            await expect(h.client.hook(state, hook, "{}")).rejects.toThrow(
                "Runner changed while persisting fence",
            );
            expect(h.calls).toHaveLength(0);
        }
    });
    test("a timed-out bootstrap page resumes with a new fence and does not skip missing ingest", async () => {
        const state = record();
        append(state, "m1", "x".repeat(2_000_000));
        append(state, "m2", "x".repeat(2_000_000));
        let attempts = 0;
        const late = deferred<unknown>();
        const h = harness(
            ({ params }) => {
                attempts++;
                if (attempts === 1) return late.promise;
                return {
                    answer: params.more ? "wait" : "noop",
                    request_id: params.request_id,
                    reason: "more",
                    bound_ms: 0,
                };
            },
            { engineBudgetMs: 100 },
        );
        const first = await h.client.bootstrap(state, step, async () => {});
        expect(first).toMatchObject({ status: "unavailable", reason: "timeout" });
        expect(state.after_ordinal).toBe(0);
        late.resolve({ answer: "noop", request_id: "r1" });
        const resumed = await h.client.bootstrap(state, step, async (result) => {
            if (result.status !== "answered") throw new Error("unexpected failure");
            acknowledgeStatus(state, new Set(result.page.messages.map((entry) => entry.id)));
        });
        expect(resumed.status).toBe("answered");
        expect(h.calls.map((call) => call.wire.params.request_id)).toEqual(["r1", "r2", "r3"]);
        expect(h.calls.map((call) => call.wire.params.after_ordinal)).toEqual([0, 0, 1]);
        expect(state.after_ordinal).toBe(2);
    });
    test("descent after conflict, restart and exit preserve the record's byte/apply authority", async () => {
        const state = record();
        append(state, "m1", "frozen", true);
        const frozen = assemble(state)[0];
        descendModuleAhead(state, "child");
        const h = harness(({ params }) => ({ answer: "noop", request_id: params.request_id }));
        expect((await h.client.step(state, step)).status).toBe("answered");
        expect(h.calls[0].wire.params.descends_from).toEqual({
            lineage_id: "L",
            through_ordinal: 1,
        });
        expect(h.calls[0].wire.params.served_through_ordinal).toBe(1);
        expect(assemble(state)[0]).toBe(frozen);
        const restarted = record();
        restarted.issued = {
            request_id: "previous-host",
            deadline_ms: 0,
            newest: 0,
            lineage_id: "L",
        };
        const reboot = harness(({ params }) => ({ answer: "noop", request_id: params.request_id }));
        expect((await reboot.client.step(restarted, step)).status).toBe("answered");
        expect(restarted.issued?.request_id).not.toBe("previous-host");
        restarted.pipeline_exit = { reason: "provider_record_lost", reseed_full_request: false };
        await expect(reboot.client.step(restarted, step)).rejects.toThrow("Invalid provider fence");
        expect(reboot.calls).toHaveLength(1);
    });
    test("execute/fold returns a candidate, but only durable H1 application can replace bytes", async () => {
        const state = record();
        append(state, "m1", "frozen", true);
        const previous = assemble(state)[0];
        const h = harness(({ params }) => ({
            answer: "compaction_message",
            request_id: params.request_id,
            compaction: {
                compaction_id: "fold",
                version: 1,
                range: { from: 0, to: 2 },
                replacement: [{ info: { id: "fold" }, parts: [{ type: "text", text: "summary" }] }],
            },
        }));
        const result = await h.client.step(state, {
            ...step,
            prefix_rebuilding: { reason: "model_switch" },
        });
        expect(assemble(state)[0]).toBe(previous);
        if (result.status !== "answered" || result.answer.answer !== "compaction_message")
            throw new Error("missing compaction");
        const answer = result.answer.compaction as unknown as typeof state.view;
        expect(
            applyCompaction(
                state,
                {
                    request_id: result.request_id,
                    arrived_ms: result.arrived_ms,
                    compaction: answer,
                },
                () => true,
            ),
        ).toEqual({ applied: true });
        expect(assemble(state)[0].parts[0].text).toBe("summary");
    });
});
