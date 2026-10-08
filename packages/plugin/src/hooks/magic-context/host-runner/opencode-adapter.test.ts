import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { MagicContextConfigSchema } from "../../../config/schema/magic-context";
import { resolveTransformMode } from "../../../config/transform-mode";
import { runMigrations } from "../../../features/magic-context/migrations";
import {
    computeHardCacheExpired,
    createScheduler,
} from "../../../features/magic-context/scheduler";
import { resolveSessionCacheTtl } from "../../../features/magic-context/session-cache-ttl";
import { initializeDatabase } from "../../../features/magic-context/storage-db";
import { loadHostRunnerRecord } from "../../../features/magic-context/storage-host-runner";
import { getOrCreateSessionMeta } from "../../../features/magic-context/storage-meta";
import { createTagger } from "../../../features/magic-context/tagger";
import { createMessagesTransformHandler } from "../../../plugin/messages-transform";
import { Database } from "../../../shared/sqlite";
import { deliverSynthetic } from "../../../v2/hooks/channel2";
import { adaptPayload } from "../../../v2/hooks/payload";
import type { V2Context } from "../../../v2/hooks/types";
import { deliverSyntheticUserMessage } from "../channel2-delivery";
import { EmergencyFailClosedError } from "../emergency-fail-closed";
import { createRustModeTransform } from "../rust-mode-transform";
import { StoreAheadOfBinaryError } from "../store-ahead-refusal";
import { createTransform, type TransformDeps } from "../transform";
import type { MessageLike } from "../transform-operations";
import {
    applyProviderOps,
    createOpenCodeProviderTransform,
    type OpenCodeProviderOptions,
    providerCold,
    providerSubjects,
} from "./opencode-adapter";

const databases: Database[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
});
function message(id: string, role = "user", text = id): MessageLike {
    return {
        info: {
            id,
            role,
            sessionID: "session",
            model: { providerID: "openai", modelID: "gpt-5.6" },
        },
        parts: [{ id: `${id}-text`, type: "text", text }],
    } as MessageLike;
}
type Wire = { method: string; params: Record<string, any> };
function fixture(host: "v1" | "v2", options: OpenCodeProviderOptions = {}) {
    const db = new Database(":memory:");
    databases.push(db);
    initializeDatabase(db);
    runMigrations(db);
    const meta = getOrCreateSessionMeta(db, "session");
    const wires: Wire[] = [];
    const order: string[] = [];
    const markers: unknown[] = [];
    const fallbacks: { namespace?: string; input: string }[] = [];
    const rows = new Map<number, MessageLike>();
    let version = 1;
    let reply: ((w: Wire) => unknown) | undefined;
    let resolveCalls = 0;
    const deps: TransformDeps = {
        db,
        transformMode: "rust",
        rustPipeline: "provider",
        storeGeneration: host,
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 90 }),
        contextUsageMap: new Map(),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 50,
        directory: "/project",
        rustModeModuleClient: {
            async call(args) {
                const wire =
                    args.body instanceof Uint8Array
                        ? JSON.parse(new TextDecoder().decode(args.body))
                        : args.body;
                const w = wire as Wire;
                wires.push(w);
                order.push(w.method);
                const override = reply?.(w);
                if (override !== undefined) return override;
                const p = w.params;
                if (w.method === "transform.declare")
                    return {
                        subscriptions: ["pre_user", "post_assistant", "post_tool"].map((hook) => ({
                            hook,
                            ops: ["prepend", "append", "replace"],
                            budget_ms: 2000,
                            on_unavailable: "pass",
                        })),
                    };
                if (w.method === "compaction.setup")
                    return {
                        answer: "ready",
                        request_id: p.request_id,
                        initial: {
                            compaction_id: "initial",
                            version: 1,
                            range: { from: 0, to: 0 },
                            replacement: [],
                        },
                        call_when: { share: 0.9 },
                    };
                if (w.method === "transform.hook") {
                    rows.set(p.subject_ordinal, p.message);
                    return {
                        answer: "ops",
                        ops: p.blocks.map((_: string, block: number) => ({
                            op: "prepend",
                            block,
                            text: `§${p.subject_ordinal}§ `,
                        })),
                    };
                }
                if (w.method === "compaction.step") {
                    for (const m of p.messages) rows.set(m.ordinal, m.message);
                    if (p.more)
                        return {
                            answer: "wait",
                            request_id: p.request_id,
                            bound_ms: 1000,
                            reason: "page",
                        };
                    return {
                        answer: "compaction_message",
                        request_id: p.request_id,
                        compaction: {
                            compaction_id: `view-${version}`,
                            version: ++version,
                            range: { from: 1, to: p.newest.ordinal + 1 },
                            replacement: [...rows]
                                .filter(([ordinal]) => ordinal <= p.newest.ordinal)
                                .map(([, m]) => m),
                        },
                    };
                }
                throw new Error(`Unexpected ${w.method}`);
            },
        },
    };
    const legacyState = {
        moduleGeneration: 0,
        lastAckedSeq: 0,
        lastAckedWatermarks: null,
        idOrdinalMemoGeneration: 0,
        idOrdinalMemo: new Map(),
        ordinalMemoCheckpoints: [],
        ordinalContinuationBase: 40,
    };
    const legacy = {
        getState: () => legacyState,
        run: async (_id: string, input: MessageLike[], out: { messages: unknown[] }) => {
            fallbacks.push({ input: JSON.stringify(input) });
            out.messages = input;
        },
    } as unknown as ReturnType<typeof createRustModeTransform>;
    const seams: OpenCodeProviderOptions = {
        resolveOrdinals: async (args) => {
            resolveCalls++;
            order.push("resolve");
            expect(args.memo).toBe(legacyState.idOrdinalMemo);
            expect(args.memoCheckpoints).toBe(legacyState.ordinalMemoCheckpoints);
            expect(args.provisionalBase).toBe(40);
            return {
                ok: true,
                annotatedInput: args.messages.map((m, i) => ({ ...m, absolute_ordinal: i + 1 })),
                memoGeneration: 0,
                memoAnchor: null,
                memoStoredCount: args.messages.length,
                memoCanonicalCount: args.messages.length,
                normalizations: [],
                stats: { mode: "memo", pages: 0, rowsRead: 0, rewinds: 0 },
            };
        },
        persisted: () => true,
        sync: async (_id, _state, complete) => {
            order.push(`sync:${complete}`);
        },
        historian: {
            pump: async () => {
                order.push("historian");
            },
            stop: async () => {},
        },
        marker: async (_id, coverage) => {
            markers.push(coverage);
        },
        fullRequest: async (_id, input, out, _meta, namespace) => {
            fallbacks.push({ input: JSON.stringify(input), namespace });
            out.messages = input;
        },
        ...options,
    };
    let adapter = createOpenCodeProviderTransform(deps, legacy, seams);
    return {
        db,
        deps,
        meta,
        wires,
        order,
        markers,
        fallbacks,
        rows,
        get adapter() {
            return adapter;
        },
        restart() {
            adapter.dispose();
            adapter = createOpenCodeProviderTransform(deps, legacy, seams);
        },
        setReply(next?: (w: Wire) => unknown) {
            reply = next;
        },
        resolveCalls: () => resolveCalls,
        stored: () =>
            loadHostRunnerRecord(db, {
                session_id: "session",
                harness: host === "v1" ? "opencode" : "opencode2",
            }),
        async pass(messages: MessageLike[]) {
            const out = { messages: messages as unknown[] };
            await adapter.run("session", messages, out, getOrCreateSessionMeta(db, "session"));
            return out.messages as MessageLike[];
        },
    };
}
for (const host of ["v1", "v2"] as const)
    describe(`OpenCode ${host} provider adapter`, () => {
        test("bootstrap adopts canonical ordinals once, omits head rows and syncs before pages", async () => {
            const f = fixture(host);
            const head = {
                info: { role: "user", sessionID: "session" },
                parts: [{ type: "text", text: "m0", synthetic: true }],
            } as MessageLike;
            const output = await f.pass([head, message("A"), message("B")]);
            expect(output.map((m) => m.info.id)).toEqual(["A", "B"]);
            expect(f.stored()!.ids.size).toBe(2);
            expect(f.order.indexOf("sync:true")).toBeLessThan(f.order.indexOf("compaction.step"));
            await f.pass([message("A"), message("B"), message("C")]);
            expect(f.resolveCalls()).toBe(1);
            expect(f.wires.some((w) => w.method === "session.read")).toBe(false);
        });
        test("bootstrap declines an unresolved synthetic between persisted rows without Setup", async () => {
            let persisted = false;
            const f = fixture(host, { persisted: (_sid, id) => id !== "X" || persisted });
            const input = [message("A"), message("X"), message("B")];
            const out = await f.pass(input);
            expect(out).toEqual(input);
            expect(f.wires).toHaveLength(0);
            expect(f.stored()).toBeNull();
            expect(f.adapter.bootstrapDeclines()).toBe(1);
            persisted = true;
            await f.pass(input);
            expect(f.stored()!.ids.size).toBe(3);
        });
        test("id scan precedes sync and multi-part hooks share ingest, with last-hook barrier", async () => {
            const f = fixture(host);
            await f.pass([message("A")]);
            f.order.length = 0;
            const tool = message("T", "assistant", "reply");
            tool.parts.push({
                id: "tool-1",
                type: "tool",
                tool: "read",
                callID: "repeated",
                state: { status: "completed", output: "one", input: { x: 1 } },
            });
            tool.parts.push({
                id: "tool-2",
                type: "tool",
                tool: "read",
                callID: "repeated",
                state: { status: "error", error: "two", input: {} },
            });
            const out = await f.pass([message("A"), tool]);
            const hooks = f.wires.filter((w) => w.method === "transform.hook");
            expect(hooks.map((w) => w.params.hook)).toEqual([
                "post_assistant",
                "post_tool",
                "post_tool",
            ]);
            expect(hooks.map((w) => w.params.subject_part)).toEqual([
                undefined,
                "tool-1",
                "tool-2",
            ]);
            expect(hooks.map((w) => JSON.stringify(w.params.message))).toEqual(
                Array(3).fill(JSON.stringify(tool)),
            );
            expect(hooks.map((w) => w.params.pass_complete)).toEqual([undefined, undefined, true]);
            expect(f.order[0]).toBe("sync:false");
            expect((out[1]!.parts[1] as any).state.output).toBe("§2§ one");
            expect((out[1]!.parts[2] as any).state.error).toBe("§2§ two");
            expect((tool.parts[1] as any).state.output).toBe("one");
        });
        test("race and interior holes append once, retain known bytes and ambiguous suffix exits", async () => {
            const f = fixture(host);
            f.setReply((w) =>
                w.method === "compaction.step"
                    ? {
                          answer: "compaction_message",
                          request_id: w.params.request_id,
                          compaction: {
                              compaction_id: "raw-bootstrap",
                              version: 2,
                              range: { from: 1, to: 1 },
                              replacement: [],
                          },
                      }
                    : undefined,
            );
            const a = await f.pass([message("A"), message("B"), message("C")]);
            f.setReply();
            const b = await f.pass([message("A"), message("X"), message("B"), message("C")]);
            expect(b.slice(0, 3)).toEqual(a);
            expect(b.map((m) => m.info.id)).toEqual(["A", "B", "C", "X"]);
            expect(await f.pass([message("A"), message("X"), message("B"), message("C")])).toEqual(
                b,
            );
            const next = await f.pass([message("A"), message("X"), message("B")]);
            expect(next.some((m) => m.info.id === "C")).toBe(false);
            expect(f.stored()!.state.pipeline_exit_json).toContain("provider_revert_ambiguous");
            expect(f.fallbacks.at(-1)!.namespace).toContain(":full-request:");
            const calls = f.wires.length;
            await f.pass([message("A"), message("X"), message("B"), message("D")]);
            expect(f.wires).toHaveLength(calls);
        });
        test("ordinary known messages are not read or serialized, including changed host content", async () => {
            const f = fixture(host);
            await f.pass([message("A"), message("B")]);
            const known = message("A");
            Object.defineProperty(known, "parts", {
                get() {
                    throw new Error("known content read");
                },
            });
            const before = f.wires.length;
            const out = await f.pass([known, message("B"), message("C")]);
            expect(out.map((m) => m.info.id)).toEqual(["A", "B", "C"]);
            expect(f.wires.length - before).toBe(1);
            f.restart();
            expect(
                await f.pass([message("A", "user", "changed"), message("B"), message("C")]),
            ).toEqual(out);
        });
        test("marker rows have no ordinal, hook or status slot; markers move only on applied views", async () => {
            const f = fixture(host);
            await f.pass([message("A")]);
            const marker = message("marker");
            marker.parts = [{ type: "compaction" }];
            f.setReply((w) =>
                w.method === "compaction.step"
                    ? { answer: "noop", request_id: w.params.request_id }
                    : undefined,
            );
            f.deps.historyRefreshSessions.add("session");
            await f.pass([marker, message("A"), message("B")]);
            expect(f.stored()!.elided.has("marker")).toBe(true);
            expect(f.stored()!.ids.has("marker")).toBe(false);
            expect(f.stored()!.state.ordinal_divergence).toBe(0);
            expect(f.markers).toHaveLength(0);
            f.setReply((w) =>
                w.method === "compaction.step"
                    ? {
                          answer: "compaction_message",
                          request_id: w.params.request_id,
                          compaction: {
                              compaction_id: "coverage",
                              version: 10,
                              range: { from: 1, to: 2 },
                              replacement: [message("A")],
                          },
                          coverage: { end_mid: "A", ordinal: 1 },
                      }
                    : undefined,
            );
            await f.pass([marker, message("A"), message("B")]);
            expect(f.markers).toEqual([{ end_mid: "A", ordinal: 1 }]);
        });
        test("history gap at first retained ordinal resends ingest then repeated refusal exits", async () => {
            const f = fixture(host);
            await f.pass([message("A")]);
            await f.pass([message("A"), message("B")]);
            f.deps.historyRefreshSessions.add("session");
            f.setReply((w) =>
                w.method === "compaction.step"
                    ? {
                          answer: "refuse",
                          request_id: w.params.request_id,
                          code: "history_unreadable",
                          reason: "gap",
                          detail: { history_gap_from: 2 },
                      }
                    : undefined,
            );
            const first = await f.pass([message("A"), message("B")]);
            expect(first).toHaveLength(2);
            expect(f.stored()!.entries[0]!.ingested).toBe(0);
            await f.pass([message("A"), message("B")]);
            const steps = f.wires.filter((w) => w.method === "compaction.step");
            expect(steps.at(-1)!.params.messages.map((m: any) => m.mid)).toEqual(["B"]);
            expect(f.stored()!.state.pipeline_exit_json).toContain("provider_history_lost");
        });
        test("store-ahead hook and step refuse turn with MC-C13, without exit or park", async () => {
            for (const method of ["transform.hook", "compaction.step"]) {
                const f = fixture(host);
                await f.pass([message("A")]);
                f.setReply((w) => {
                    if (w.method === method)
                        throw new StoreAheadOfBinaryError({ dbVersion: 70, binaryMax: 69 });
                });
                if (method === "compaction.step") f.deps.historyRefreshSessions.add("session");
                await expect(f.pass([message("A"), message("B")])).rejects.toThrow("MC-C13");
                expect(f.stored()!.state.pipeline_exit_json).toBeNull();
                expect(f.fallbacks).toHaveLength(0);
            }
        });
        test("non-retryable Setup refuses once across ten passes and restart", async () => {
            const f = fixture(host);
            f.setReply((w) =>
                w.method === "compaction.setup"
                    ? {
                          answer: "refuse",
                          request_id: w.params.request_id,
                          code: "misconfigured",
                          reason: "bad",
                      }
                    : undefined,
            );
            for (let i = 0; i < 10; i++) await f.pass([message("A")]);
            f.restart();
            await f.pass([message("A")]);
            expect(f.wires.filter((w) => w.method === "compaction.setup")).toHaveLength(1);
            expect(f.fallbacks).toHaveLength(11);
        });
        test("bootstrap page failure resumes durable cursor under fresh fences", async () => {
            const f = fixture(host);
            let failed = false;
            f.setReply((w) => {
                if (w.method === "compaction.step" && !w.params.more && !failed) {
                    failed = true;
                    throw new Error("offline");
                }
            });
            const input = [
                message("A", "user", "x".repeat(1_600_000)),
                message("B", "user", "y".repeat(1_600_000)),
            ];
            await f.pass(input);
            expect(f.stored()!.state.bootstrap_cursor).toBe(1);
            expect(f.fallbacks).toHaveLength(1);
            f.restart();
            await f.pass(input);
            expect(f.adapter.isProviderSession("session")).toBe(true);
            const pages = f.wires.filter((w) => w.method === "compaction.step");
            expect(pages.map((w) => w.params.messages.map((m: any) => m.mid))).toEqual([
                ["A"],
                ["B"],
                ["B"],
            ]);
            expect(new Set(pages.map((w) => w.params.request_id)).size).toBe(3);
        });
        test("module-ahead ordinal refusal descends once and retries hooks", async () => {
            const f = fixture(host);
            await f.pass([message("A")]);
            let refused = false;
            f.setReply((w) => {
                if (w.method === "transform.hook" && !refused) {
                    refused = true;
                    return {
                        answer: "refuse",
                        code: "invalid_params",
                        detail: { field: "subject_ordinal" },
                    };
                }
            });
            const out = await f.pass([message("A"), message("B")]);
            const hooks = f.wires.filter((w) => w.method === "transform.hook");
            expect(hooks).toHaveLength(2);
            expect(hooks[1]!.params.descends_from.through_ordinal).toBe(1);
            expect(hooks[1]!.params.lineage_id).not.toBe(hooks[0]!.params.lineage_id);
            expect((out[1]!.parts[0] as any).text).toBe("§2§ B");
        });
        test("rollback zero-divergence is stable; diverged rollback selects fresh namespace once", async () => {
            for (const diverged of [false, true]) {
                const f = fixture(host);
                await f.pass([message("A"), message("B")]);
                if (diverged) await f.pass([message("A"), message("X"), message("B")]);
                f.deps.rustPipeline = "full_request";
                const input = [message("A"), ...(diverged ? [message("X")] : []), message("B")];
                const first = await f.pass(input);
                const next = await f.pass(input);
                expect(next).toEqual(first);
                const namespaces = f.fallbacks.map((f) => f.namespace);
                expect(namespaces[0] !== undefined).toBe(diverged);
                expect(namespaces[1]).toBe(namespaces[0]);
                expect(f.stored()!.state.pipeline_exit_json).toContain("rollback");
            }
        });
    });

test("ops target text and subject_part only, preserve reasoning, images and call inputs", () => {
    const m = message("M", "assistant");
    const image = { type: "file", url: "image" };
    const reasoning = { type: "reasoning", text: "signed", signature: "s" };
    m.parts.push(image, reasoning, {
        type: "tool",
        id: "p",
        callID: "c",
        tool: "read",
        state: { status: "completed", output: "result", input: { x: 1 } },
    });
    const subjects = providerSubjects(m);
    const out = applyProviderOps(
        m,
        subjects.map((subject) => ({
            subject,
            ops: [{ op: "prepend", block: 0, text: "tag " }],
            tags: [],
        })),
    );
    expect(out.parts[1]).toBe(image);
    expect(out.parts[2]).toBe(reasoning);
    expect((out.parts[3] as any).state.input).toBe((m.parts[3] as any).state.input);
    expect((out.parts[3] as any).state.output).toBe("tag result");
});

test("cold decisions equal full-request TTL corpus with frozen model default and live user edit", () => {
    const f = fixture("v1");
    let materialized = 0;
    const decisions: boolean[] = [];
    for (const row of [
        { now: 1_800_001, last: 1, config: "5m", explicit: false },
        { now: 1_800_002, last: 1, config: "5m", explicit: false },
        { now: 1_800_003, last: 1, config: "5m", explicit: false },
        { now: 1_900_000, last: 1_800_003, config: "1m", explicit: true },
        { now: 1_900_001, last: 1_800_003, config: "never", explicit: true },
        { now: 3_700_005, last: 1_900_002, config: "5m", explicit: false },
    ]) {
        const resolved = resolveSessionCacheTtl(
            f.db,
            "session",
            row.config,
            "openai/gpt-5.6",
            row.explicit,
        );
        const meta = {
            cacheTtl: resolved.value,
            lastResponseTime: row.last,
            cachedM0MaterializedAt: materialized,
        };
        const oldDecision =
            computeHardCacheExpired(meta.cacheTtl, row.last, row.now) && row.last > materialized;
        expect(providerCold(meta, row.now)).toBe(oldDecision);
        decisions.push(providerCold(meta, row.now));
        if (oldDecision) materialized = row.now;
    }
    expect(decisions).toEqual([false, true, false, true, false, true]);
});

test("rust provider plus compaction off routes to TS and never calls Setup", async () => {
    const config = MagicContextConfigSchema.parse({
        transform_mode: "rust",
        rust_pipeline: "provider",
        compaction: { enabled: false },
    });
    expect(config.rust_pipeline).toBe("provider");
    expect(MagicContextConfigSchema.parse({}).rust_pipeline).toBe("full_request");
    expect(
        resolveTransformMode({
            configured: config.transform_mode,
            userTierHasSubc: true,
            compactionEnabled: false,
        }).mode,
    ).toBe("ts");
    const f = fixture("v1");
    const transform = createTransform({ ...f.deps, compactionOff: true, historianRunnable: false });
    await transform({}, { messages: [message("A")] });
    expect(f.wires.some((w) => w.method === "compaction.setup")).toBe(false);
    transform.disposeRust();
});

test("wrapper error uses only durable provider assembly and explicit refusal never replays", async () => {
    const f = fixture("v1");
    await f.pass([message("A")]);
    const transform = Object.assign(
        async () => {
            throw new Error("post-pass error");
        },
        {
            isProviderSession: f.adapter.isProviderSession,
            recoverProviderOutput: f.adapter.recoverOutput,
        },
    );
    const handler = createMessagesTransformHandler({
        magicContext: { "experimental.chat.messages.transform": transform },
    });
    const out = { messages: [message("A", "user", "unmanaged changed"), message("B")] } as any;
    await handler({}, out);
    expect(out.messages).toEqual([message("A")]);
    const refuse = Object.assign(
        async () => {
            throw new EmergencyFailClosedError("refuse");
        },
        {
            isProviderSession: () => true,
            recoverProviderOutput: () => {
                throw new Error("must not replay");
            },
        },
    );
    await expect(
        createMessagesTransformHandler({
            magicContext: { "experimental.chat.messages.transform": refuse },
        })({}, out),
    ).rejects.toThrow("refuse");
});

for (const host of ["v1", "v2"] as const) {
    test(`OpenCode ${host} Channel 2 persisted carrier is admitted with synthetic parts and ordinary ordinals`, async () => {
        const stored = new Map<string, MessageLike>();
        let synthetic: MessageLike;
        if (host === "v1") {
            await deliverSyntheticUserMessage("session", {
                text: "nudge",
                client: {
                    session: {
                        promptAsync: async ({ body }: any) => {
                            expect(body.parts).toEqual([
                                { type: "text", text: "nudge", synthetic: true },
                            ]);
                            synthetic = { ...message("nudge"), parts: body.parts };
                            stored.set("nudge", synthetic);
                        },
                    },
                },
            });
        } else {
            const identity = new Map();
            const context = {
                storage: {
                    set: async (k: string, v: unknown) => {
                        identity.set(k, v);
                    },
                },
                session: {
                    synthetic: async ({ id, text, delivery }: any) => {
                        expect(delivery).toBe("steer");
                        const draft = {
                            sessionID: "session",
                            model: { providerID: "openai", id: "gpt-5.6" },
                            messages: [{ id, role: "user", content: [{ type: "text", text }] }],
                            system: [],
                            tools: {},
                            options: {},
                        };
                        synthetic = adaptPayload(draft as any, new Set([id]))
                            .messages[0] as MessageLike;
                        stored.set(id, synthetic);
                    },
                },
            } as unknown as Pick<V2Context, "storage" | "session">;
            const id = await deliverSynthetic(context, "session", "nudge");
            expect(stored.has(id)).toBe(true);
        }
        expect((synthetic!.parts[0] as any).synthetic).toBe(true);
        const f = fixture(host, { persisted: (_sid, id) => id === "A" || stored.has(id) });
        await f.pass([message("A")]);
        await f.pass([message("A"), synthetic!]);
        expect(f.stored()!.ids.get(synthetic!.info.id!)).toBe(2);
        expect(f.stored()!.state.ordinal_divergence).toBe(0);
    });
    test(`OpenCode ${host} provider pass claims and completes a published historian run`, async () => {
        const { HistorianHostRunner } = await import("../historian-host-runner");
        let published = false;
        let resolveComplete!: () => void;
        const completed = new Promise<void>((resolve) => {
            resolveComplete = resolve;
        });
        const methods: string[] = [];
        const loop = new HistorianHostRunner({
            claimantInstanceId: `provider-${host}`,
            enabled: () => true,
            now: () => 1000,
            schedule: () => () => {},
            log: () => {},
            call: async ({ method, body }) => {
                methods.push(method);
                if (method === "historian.pending")
                    return {
                        ok: true,
                        runs: published
                            ? [
                                  {
                                      run_id: "run",
                                      session_id: "session",
                                      chunk_fingerprint: "fp",
                                      prompt_bytes_len: 10,
                                      deadline_ms: 100_000,
                                  },
                              ]
                            : [],
                    };
                if (method === "historian.claim")
                    return {
                        ok: true,
                        run_id: "run",
                        session_id: "session",
                        attempt: 1,
                        token: "token",
                        prompt: { system: "system", user: "user" },
                        model_chain: ["openai/gpt-5.6"],
                        await_budget_ms: 50_000,
                        claim_deadline_ms: 60_000,
                        heartbeat_interval_ms: 30_000,
                    };
                if (method === "historian.complete") {
                    expect(body.token).toBe("token");
                    expect((body.output as { text: string }).text).toBe("published history");
                    resolveComplete();
                    return { ok: true };
                }
                return { ok: true, claim_deadline_ms: 60_000, heartbeat_interval_ms: 30_000 };
            },
            openExecutor: () => ({
                sessionDirectory: "/project",
                executor: {
                    capabilities: {
                        tools: false,
                        harness: host === "v1" ? "opencode" : "opencode2",
                    },
                    open: async () => ({ id: "hidden", childSessionId: "hidden" }),
                    attempt: async () => {},
                    collect: async () => ({
                        text: "published history",
                        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                        lengthCapped: false,
                    }),
                    close: async () => {},
                },
            }),
        });
        const f = fixture(host, { historian: loop });
        await f.pass([message("A")]);
        published = true;
        await f.pass([message("A"), message("B")]);
        await Promise.race([
            completed,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("historian not completed")), 2000),
            ),
        ]);
        expect(methods).toContain("historian.claim");
        expect(methods).toContain("historian.complete");
        await loop.stop();
    });
}

for (const host of ["v1", "v2"] as const)
    test(`OpenCode ${host} setting-off outgoing requests match legacy full-request adapter through wrapper`, async () => {
        const { setRawMessageProvider } = await import("../read-session-chunk");
        const { getSlot, resetLkgSlotsForTest } = await import("../lkg-slot");
        const native = [message("A")];
        const row = { id: "A", timeCreated: 1, contributesOrdinal: true, hasValidInfo: true };
        const unregister = setRawMessageProvider("session", {
            readMessages: () => native as any,
            readMessageOrdinalPage: (anchor) => (anchor ? [] : [row]),
            getStoredMessageCount: () => 1,
            readMessagePartsById: () => ({
                id: "A",
                role: "user",
                parts: native[0]!.parts,
                createdAt: 1,
            }),
        });
        const outputs: string[] = [];
        const calls: string[][] = [];
        try {
            for (const lane of ["legacy", "absent", "full_request"] as const) {
                resetLkgSlotsForTest();
                const f = fixture(host);
                const methods: string[] = [];
                const deps: TransformDeps = {
                    ...f.deps,
                    rustPipeline: lane === "full_request" ? "full_request" : undefined,
                    storeGeneration: undefined,
                    historianRunner: "broca",
                    injectDocs: false,
                    memoryConfig: {
                        enabled: false,
                        injectionBudgetTokens: 1000,
                        autoPromote: false,
                    },
                    rustModeModuleClient: {
                        call: async ({ method }) => {
                            methods.push(method);
                            return method === "transform"
                                ? {
                                      decision: "SOFT+",
                                      prefix_bust_permitted: false,
                                      row_version: 1,
                                      native_messages: structuredClone(native),
                                  }
                                : { ok: true };
                        },
                    },
                };
                let capture = 0;
                const old =
                    lane === "legacy"
                        ? createRustModeTransform(deps, {
                              moduleClient: deps.rustModeModuleClient!,
                              scheduleLkgCapture: (fn) => {
                                  capture++;
                                  fn();
                              },
                          })
                        : undefined;
                const current = old
                    ? Object.assign(
                          async (
                              _input: Record<string, never>,
                              output: { messages: unknown[] },
                          ) => {
                              await old.run(
                                  "session",
                                  output.messages as MessageLike[],
                                  output,
                                  getOrCreateSessionMeta(f.db, "session"),
                              );
                          },
                          {},
                      )
                    : createTransform(deps);
                const out = { messages: structuredClone(native) } as any;
                await createMessagesTransformHandler({
                    magicContext: { "experimental.chat.messages.transform": current },
                })({}, out);
                await new Promise<void>((resolve) => setImmediate(resolve));
                outputs.push(JSON.stringify(out.messages));
                calls.push(
                    methods.filter(
                        (m) =>
                            m === "transform" ||
                            m.startsWith("compaction.") ||
                            m.startsWith("transform."),
                    ),
                );
                expect(methods).toContain("transform");
                expect(getSlot("session")).toBeDefined();
                if (old) {
                    expect(capture).toBeGreaterThan(0);
                    old.dispose();
                } else (current as ReturnType<typeof createTransform>).disposeRust();
            }
            expect(outputs).toEqual(Array(3).fill(JSON.stringify(native)));
            expect(calls).toEqual([["transform"], ["transform"], ["transform"]]);
        } finally {
            unregister();
            resetLkgSlotsForTest();
        }
    });

for (const host of ["v1", "v2"] as const)
    describe(`OpenCode ${host} cold-path safety`, () => {
        test("covered revert cannot serve an invalidated view on noop or module failure", async () => {
            const f = fixture(host);
            await f.pass([message("A"), message("B"), message("C")]);
            f.restart();
            f.setReply((w) =>
                w.method === "compaction.step"
                    ? { answer: "noop", request_id: w.params.request_id }
                    : undefined,
            );
            await expect(f.pass([message("A"), message("B")])).rejects.toBeInstanceOf(
                EmergencyFailClosedError,
            );
            expect(f.stored()!.views[0]!.state).toBe("invalidated");
            expect(f.wires.at(-1)!.params.prefix_rebuilding.reason).toBe("revert");
            f.setReply((w) => {
                if (w.method === "compaction.step") throw new Error("offline");
            });
            await expect(f.pass([message("A"), message("B")])).rejects.toBeInstanceOf(
                EmergencyFailClosedError,
            );
        });
        test("foreign history and lost provider record exit durably without bootstrap loops", async () => {
            const f = fixture(host);
            await f.pass([message("A")]);
            expect(await f.pass([message("foreign")])).toEqual([message("foreign")]);
            expect(f.stored()!.state.pipeline_exit_json).toContain("provider_foreign_history");
            const lost = fixture(host);
            lost.setReply((w) =>
                w.method === "compaction.setup"
                    ? {
                          answer: "ready",
                          request_id: w.params.request_id,
                          initial: {
                              compaction_id: "lost",
                              version: 10,
                              range: { from: 1, to: 2 },
                              replacement: [message("A")],
                          },
                      }
                    : undefined,
            );
            await lost.pass([message("A")]);
            expect(lost.stored()!.state.pipeline_exit_json).toContain("provider_record_lost");
            const count = lost.wires.length;
            lost.restart();
            await lost.pass([message("A")]);
            expect(lost.wires).toHaveLength(count);
        });
        test("single-entry encoded status overflow exits before hooks", async () => {
            const f = fixture(host);
            await f.pass([message("A")]);
            await f.pass([message("A"), message("large", "user", 'é"'.repeat(1_100_000))]);
            expect(f.stored()!.state.pipeline_exit_json).toContain("provider_message_too_large");
            expect(f.wires.filter((w) => w.method === "transform.hook")).toHaveLength(0);
        });
        test("provider wrapper performs no legacy capture or replay on ordinary and unavailable passes", async () => {
            const slots = await import("../lkg-slot");
            const replays = await import("../lkg-replay");
            const f = fixture(host);
            await f.pass([message("A")]);
            expect(
                slots.captureSlot("session", {
                    jsonPrefix: JSON.stringify([message("legacy")]),
                    inputIdSeq: ["A"],
                    inputContentDigests: [slots.lkgContentDigest(message("A")) ?? "digest"],
                    lastInputMessageId: "A",
                    modelKey: "openai/gpt-5.6",
                    providerKey: "openai",
                    capturedAt: Date.now(),
                }),
            ).toBe(true);
            const capture = spyOn(slots, "captureSlot");
            const entry = spyOn(slots, "noteEntry");
            const replay = spyOn(replays, "replayLkg");
            const slotRead = spyOn(slots, "getSlot");
            try {
                const transform = Object.assign(
                    async (_input: Record<string, never>, out: { messages: unknown[] }) => {
                        await f.adapter.run("session", out.messages as MessageLike[], out, f.meta);
                    },
                    {
                        isProviderSession: f.adapter.isProviderSession,
                        recoverProviderOutput: f.adapter.recoverOutput,
                    },
                );
                const handler = createMessagesTransformHandler({
                    magicContext: { "experimental.chat.messages.transform": transform },
                });
                const first = { messages: [message("A"), message("B")] } as any;
                await handler({}, first);
                f.setReply((w) => {
                    if (w.method === "transform.hook") throw new Error("module unavailable");
                });
                const next = { messages: [message("A"), message("B"), message("C")] } as any;
                await handler({}, next);
                expect(next.messages.slice(0, 2)).toEqual(first.messages);
                expect(next.messages[2]).toEqual(message("C"));
                expect(capture).not.toHaveBeenCalled();
                expect(entry).not.toHaveBeenCalled();
                expect(replay).not.toHaveBeenCalled();
                expect(slotRead).not.toHaveBeenCalled();
            } finally {
                capture.mockRestore();
                entry.mockRestore();
                replay.mockRestore();
                slotRead.mockRestore();
                slots.resetLkgSlotsForTest();
            }
        });
    });

test("OpenCode 2 recorded-boundary trim uses runner ordinals after a provider publication", async () => {
    const { createV2RustCompactionMarkerStrategy, trimToRecordedBoundary } = await import(
        "../../../v2/fold/boundary"
    );
    const { appendCompartments } = await import(
        "../../../features/magic-context/compartment-storage"
    );
    const f = fixture("v2");
    await f.pass([message("A"), message("B")]);
    appendCompartments(f.db, "session", [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 1,
            startMessageId: "A",
            endMessageId: "A",
            title: "history",
            content: "published",
            p1: "published",
        },
    ]);
    const strategy = createV2RustCompactionMarkerStrategy(() => ({
        id: "B",
        role: "user",
        ordinal: 2,
        parts: [],
    }));
    strategy.applyDeferred(f.db, "session", {
        ordinal: 2,
        endMessageId: "B",
        publishedAt: Date.now(),
    });
    const ordinals = f.adapter.ordinals("session")!;
    const messages = ["A", "B", "C"].map((id) => ({ id, role: "user", ordinal: ordinals.get(id) }));
    // No raw provider is registered: falling back to canonical store ordinals
    // would return zero rather than trimming this covered runner prefix.
    expect(trimToRecordedBoundary(f.db, "session", messages)).toBe(1);
    expect(messages.map((m) => m.id)).toEqual(["B", "C"]);
});

for (const host of ["v1", "v2"] as const)
    test(`OpenCode ${host} transport ordinal errors and step conflicts retry once on descended lineage`, async () => {
        for (const method of ["transform.hook", "compaction.step"]) {
            const f = fixture(host);
            await f.pass([message("A")]);
            let refused = false;
            f.setReply((w) => {
                if (w.method === method && !refused) {
                    refused = true;
                    throw Object.assign(new Error("ordinal conflict"), {
                        code: "invalid_params",
                        detail: {
                            field: method === "transform.hook" ? "subject_ordinal" : "messages",
                        },
                    });
                }
            });
            if (method === "compaction.step") f.deps.historyRefreshSessions.add("session");
            const output = await f.pass([message("A"), message("B")]);
            expect(output.map((m) => m.info.id)).toEqual(["A", "B"]);
            const hooks = f.wires.filter((w) => w.method === "transform.hook");
            expect(hooks).toHaveLength(2);
            expect(hooks[1]!.params.descends_from.through_ordinal).toBe(1);
            expect(hooks[1]!.params.lineage_id).not.toBe(hooks[0]!.params.lineage_id);
        }
    });

for (const host of ["v1", "v2"] as const)
    test(`OpenCode ${host} bootstrap after full-request revert preserves absolute continuation and existing tags`, async () => {
        const f = fixture(host, {
            resolveOrdinals: async (args) => ({
                ok: true,
                annotatedInput: args.messages.map((m, i) => ({
                    ...m,
                    absolute_ordinal: (args.provisionalBase ?? 0) + i + 1,
                })),
                memoGeneration: 0,
                memoAnchor: null,
                memoStoredCount: 2,
                memoCanonicalCount: 42,
                normalizations: [],
                stats: { mode: "memo", rowsRead: 0, pages: 0, rewinds: 0 },
            }),
        });
        const old = [message("A", "user", "§37§ A"), message("B", "assistant", "§38§ B")];
        expect(await f.pass(old)).toEqual(old);
        expect([...f.stored()!.ids.values()]).toEqual([41, 42]);
        expect(f.wires.filter((w) => w.method === "transform.hook")).toHaveLength(0);
    });
