import { afterEach, describe, expect, test } from "bun:test";
import { stripUnsafeProjectConfigFields } from "../../../config/project-security";
import { MagicContextConfigSchema } from "../../../config/schema/magic-context";
import { appendCompartments } from "../../../features/magic-context/compartment-storage";
import { runMigrations } from "../../../features/magic-context/migrations";
import {
    computeHardCacheExpired,
    createScheduler,
} from "../../../features/magic-context/scheduler";
import { resolveSessionCacheTtl } from "../../../features/magic-context/session-cache-ttl";
import { initializeDatabase } from "../../../features/magic-context/storage-db";
import { loadHostRunnerRecord } from "../../../features/magic-context/storage-host-runner";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../../features/magic-context/storage-meta";
import { createTagger } from "../../../features/magic-context/tagger";
import { createMessagesTransformHandler } from "../../../plugin/messages-transform";
import { Database } from "../../../shared/sqlite";
import {
    createV2RustCompactionMarkerStrategy,
    trimToRecordedBoundary,
} from "../../../v2/fold/boundary";
import { adaptPayload } from "../../../v2/hooks/payload";
import type { SessionContext } from "../../../v2/hooks/types";
import { EmergencyFailClosedError } from "../emergency-fail-closed";
import { captureSlot, lkgContentDigest, resetLkgSlotsForTest } from "../lkg-slot";
import { setRawMessageProvider } from "../read-session-chunk";
import type { createRustModeTransform } from "../rust-mode-transform";
import { StorageBusyRefusalError } from "../storage-busy-refusal";
import type { TransformDeps } from "../transform";
import type { MessageLike } from "../transform-operations";
import { applyProviderOps, createOpenCodeProviderTransform } from "./opencode-adapter";
import type { HookAnswer } from "./record";

// The package preload redirects both XDG homes and all implicit context DB opens.
// Provider state below lives only in SQLite :memory:; no host store is opened.
const disposals: (() => void)[] = [];
afterEach(() => {
    for (const dispose of disposals.splice(0).reverse()) dispose();
});

type Host = "v1" | "v2";
type Wire = { method: string; params: Record<string, any> };
type WrapperOutput = Parameters<ReturnType<typeof createMessagesTransformHandler>>[1];
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
function draft(ids: string[]): SessionContext {
    return {
        sessionID: "session",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.6" },
        system: [],
        options: {},
        tools: {},
        messages: ids.map((id) => ({ id, role: "user", content: [{ type: "text", text: id }] })),
    } as SessionContext;
}
function text(m: MessageLike): string {
    return (m.parts[0] as { text: string }).text;
}

/** Recording fake: it ingests status bytes and renders held hook ops on rebuilds.
 * The default bootstrap covers no raw messages, so ordinary-pass tests actually
 * exercise the retained tail, rather than hiding it inside a replacement.
 */
function fixture(host: Host, covered = false) {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    getOrCreateSessionMeta(db, "session");
    const wires: Wire[] = [];
    const barriers: boolean[] = [];
    const fallbacks: (string | undefined)[] = [];
    const rows = new Map<number, MessageLike>();
    const ops = new Map<number, HookAnswer[]>();
    let version = 1;
    let clock = 1000;
    let reply: ((w: Wire) => unknown) | undefined;
    let fallbackError: Error | undefined;
    const deps: TransformDeps = {
        db,
        transformMode: "rust",
        rustPipeline: "provider",
        storeGeneration: host,
        directory: "/hermetic-h4-review",
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 90 }),
        contextUsageMap: new Map(),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 50,
        liveModelBySession: new Map([["session", { providerID: "openai", modelID: "gpt-5.6" }]]),
        rustModeModuleClient: {
            async call(args) {
                const w = (
                    args.body instanceof Uint8Array
                        ? JSON.parse(new TextDecoder().decode(args.body))
                        : args.body
                ) as Wire;
                wires.push(w);
                const overridden = reply?.(w);
                if (overridden !== undefined) return overridden;
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
                    const answer: HookAnswer = {
                        subject: {
                            hook: p.hook,
                            subject_mid: p.subject_mid,
                            subject_part: p.subject_part,
                        },
                        ops: p.blocks.map((_: string, block: number) => ({
                            op: "prepend",
                            block,
                            text: `§${p.subject_ordinal}§ `,
                        })),
                        tags: [],
                    };
                    const held = (ops.get(p.subject_ordinal) ?? []).filter(
                        (a) =>
                            a.subject.hook !== p.hook || a.subject.subject_part !== p.subject_part,
                    );
                    ops.set(p.subject_ordinal, [...held, answer]);
                    return { answer: "ops", ops: answer.ops };
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
                    const bootstrap = p.prefix_rebuilding?.reason === "pipeline_switch";
                    return {
                        answer: "compaction_message",
                        request_id: p.request_id,
                        compaction: {
                            compaction_id: `view-${++version}`,
                            version,
                            range: {
                                from: 1,
                                to: bootstrap && !covered ? 1 : p.newest.ordinal + 1,
                            },
                            replacement:
                                bootstrap && !covered
                                    ? []
                                    : [...rows]
                                          .filter(([o]) => o <= p.newest.ordinal)
                                          .sort(([a], [b]) => a - b)
                                          .map(([o, m]) => applyProviderOps(m, ops.get(o) ?? [])),
                        },
                    };
                }
                throw new Error(`Unexpected fake-module request: ${w.method}`);
            },
        },
    };
    const legacyState = {
        moduleGeneration: 0,
        lastAckedSeq: 0,
        lastAckedWatermarks: null,
        idOrdinalMemo: new Map(),
        ordinalMemoCheckpoints: [],
    };
    const legacy = { getState: () => legacyState } as unknown as ReturnType<
        typeof createRustModeTransform
    >;
    const seams = {
        now: () => clock,
        persisted: () => true,
        resolveOrdinals: async (
            args: Parameters<
                NonNullable<import("./opencode-adapter").OpenCodeProviderOptions["resolveOrdinals"]>
            >[0],
        ) => ({
            ok: true as const,
            annotatedInput: args.messages.map((m, i) => ({ ...m, absolute_ordinal: i + 1 })),
            memoGeneration: 0,
            memoAnchor: null,
            memoStoredCount: args.messages.length,
            memoCanonicalCount: args.messages.length,
            normalizations: [],
            stats: { mode: "memo" as const, pages: 0, rowsRead: 0, rewinds: 0 },
        }),
        sync: async (_id: string, _state: unknown, complete: boolean) => {
            barriers.push(complete);
        },
        historian: { pump: async () => {}, stop: async () => {} },
        marker: async () => {},
        fullRequest: async (
            _id: string,
            input: MessageLike[],
            out: { messages: unknown[] },
            _meta: unknown,
            namespace?: string,
        ) => {
            fallbacks.push(namespace);
            if (fallbackError) throw fallbackError;
            // Match the real full-request adapter's in-place publication contract.
            if (out.messages !== input) out.messages.splice(0, out.messages.length, ...input);
        },
    };
    let adapter = createOpenCodeProviderTransform(deps, legacy, seams);
    disposals.push(() => {
        adapter.dispose();
        db.close();
    });
    return {
        db,
        deps,
        wires,
        barriers,
        fallbacks,
        get adapter() {
            return adapter;
        },
        setClock(value: number) {
            clock = value;
        },
        setReply(next?: (w: Wire) => unknown) {
            reply = next;
        },
        setFallbackError(error: Error) {
            fallbackError = error;
        },
        restart() {
            adapter.dispose();
            adapter = createOpenCodeProviderTransform(deps, legacy, seams);
        },
        stored: () =>
            loadHostRunnerRecord(db, {
                session_id: "session",
                harness: host === "v1" ? "opencode" : "opencode2",
            })!,
        async run(out: { messages: unknown[] }) {
            await adapter.run(
                "session",
                out.messages as MessageLike[],
                out,
                getOrCreateSessionMeta(db, "session"),
            );
        },
        async pass(input: MessageLike[]) {
            const out = { messages: input as unknown[] };
            await this.run(out);
            return out.messages as MessageLike[];
        },
        steps: () => wires.filter((w) => w.method === "compaction.step"),
    };
}

test("R1 v1: provider publication updates the array retained by the host", async () => {
    const f = fixture("v1", true);
    await f.pass([message("A")]);
    const retained = [message("A", "user", "host edit"), message("B")];
    const out = { messages: retained };
    const transform = Object.assign(
        async (_: Record<string, never>, output: { messages: unknown[] }) => f.run(output),
        {
            isProviderSession: f.adapter.isProviderSession,
            recoverProviderOutput: f.adapter.recoverOutput,
        },
    );
    await createMessagesTransformHandler({
        magicContext: { "experimental.chat.messages.transform": transform },
    })({}, out as unknown as WrapperOutput);
    // Control: the record and returned property really contain the managed bytes.
    expect(out.messages.map(text)).toEqual(["A", "§2§ B"]);
    expect(JSON.stringify(retained)).toBe(JSON.stringify(out.messages));
});

test("R1 v2: payload commit sends provider bytes, not the pre-transform projection", async () => {
    const f = fixture("v2", true);
    await f.pass([message("A")]);
    const host = draft(["A", "B"]);
    host.messages[0]!.content[0]!.text = "host edit";
    const mapped = adaptPayload(host);
    await f.run(mapped);
    expect(mapped.messages.map(text)).toEqual(["A", "§2§ B"]);
    mapped.commit();
    expect(host.messages.map((m) => m.content[0]!.text)).toEqual(["A", "§2§ B"]);
});

test("R2 v2: a completed projected tool has a usable subject_part and reaches post_tool", async () => {
    const f = fixture("v2");
    await f.pass([message("A")]);
    const host = draft(["A"]);
    host.messages.push(
        {
            id: "T",
            role: "assistant",
            content: [{ type: "tool-call", id: "call", name: "read", input: { path: "fixture" } }],
        },
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: "call",
                    name: "read",
                    result: { type: "text", value: "result" },
                },
            ],
        },
    );
    const mapped = adaptPayload(host);
    expect((mapped.messages[1]!.parts[0] as any).state.status).toBe("completed");
    await f.run(mapped);
    expect(f.wires.filter((w) => w.method === "transform.hook").map((w) => w.params.hook)).toEqual([
        "post_assistant",
        "post_tool",
    ]);
});

for (const host of ["v1", "v2"] as const)
    describe(`H4 review ${host}`, () => {
        for (const outcome of ["noop", "transport error"] as const)
            test(`R3: invalidated covered revert retries on the next pass after ${outcome}`, async () => {
                const f = fixture(host, true);
                await f.pass([message("A"), message("B"), message("C")]);
                f.restart();
                f.setReply((w) => {
                    if (w.method !== "compaction.step") return;
                    if (outcome === "transport error") throw new Error("offline fixture");
                    return { answer: "noop", request_id: w.params.request_id };
                });
                await expect(f.pass([message("A"), message("B")])).rejects.toBeInstanceOf(
                    EmergencyFailClosedError,
                );
                expect(f.stored().views[0]!.state).toBe("invalidated");
                const sent = f.steps().length;
                f.setReply();
                const retry = await f.pass([message("A"), message("B")]).catch((error) => error);
                expect(f.steps().length).toBe(sent + 1);
                expect(f.steps().at(-1)!.params.prefix_rebuilding).toEqual({ reason: "revert" });
                expect(retry).toEqual([message("A"), message("B")]);
            });

        test("R4: a SOFT flush must not consume a later live-TTL cold decision", async () => {
            const f = fixture(host);
            await f.pass([message("A")]);
            updateSessionMeta(f.db, "session", {
                cachedM0MaterializedAt: 1000,
                lastResponseTime: 2000,
            });
            resolveSessionCacheTtl(f.db, "session", "5m", "openai/gpt-5.6", true);
            f.setClock(4000);
            f.deps.historyRefreshSessions.add("session");
            await f.pass([message("A")]);
            expect(f.steps().at(-1)!.params.prefix_rebuilding).toEqual({ reason: "flush" });
            expect(getOrCreateSessionMeta(f.db, "session").cachedM0MaterializedAt).toBe(1000);
            // User TTL overrides may change while a session is active.
            resolveSessionCacheTtl(f.db, "session", "1m", "openai/gpt-5.6", true);
            f.setClock(64001);
            const meta = getOrCreateSessionMeta(f.db, "session");
            expect(
                computeHardCacheExpired(meta.cacheTtl, meta.lastResponseTime, 64001) &&
                    meta.lastResponseTime > meta.cachedM0MaterializedAt!,
            ).toBe(true);
            const sent = f.steps().length;
            await f.pass([message("A")]);
            expect(
                f
                    .steps()
                    .slice(sent)
                    .map((w) => w.params.prefix_rebuilding?.reason),
            ).toEqual(["cold"]);
        });

        test("R5: burn a partially failed message before the next message's cadence decision", async () => {
            const f = fixture(host);
            await f.pass([message("A")]);
            const pending = new Set<string>();
            f.setReply((w) => {
                if (w.method !== "transform.hook") return;
                const p = w.params;
                for (const subject of p.unserved_subjects ?? [])
                    pending.delete(
                        `${subject.subject_mid}/${subject.hook}/${subject.subject_part ?? ""}`,
                    );
                if (p.hook === "post_assistant") return { answer: "pass" };
                if (p.subject_mid === "B" && p.subject_part === "part-B1") {
                    pending.add("B/post_tool/part-B1");
                    return { answer: "ops", ops: [{ op: "prepend", block: 0, text: "§2§ " }] };
                }
                if (p.subject_mid === "B") throw new Error("unavailable tool hook fixture");
                // With a two-tool cadence, the current tool and an unburned B
                // answer fire a reminder; B's discarded answer must not count.
                return {
                    answer: "ops",
                    ops: [{ op: "append", block: 0, text: pending.size ? " [cadence]" : "" }],
                };
            });
            const b = message("B", "assistant", "reply");
            b.parts.push(
                {
                    id: "part-B1",
                    type: "tool",
                    tool: "read",
                    callID: "call-B1",
                    state: { status: "completed", output: "result", input: {} },
                },
                {
                    id: "part-B2",
                    type: "tool",
                    tool: "read",
                    callID: "call-B2",
                    state: { status: "completed", output: "second result", input: {} },
                },
            );
            const c = message("C", "assistant", "next reply");
            c.parts.push({
                id: "part-C",
                type: "tool",
                tool: "read",
                callID: "call-C",
                state: { status: "completed", output: "C-result", input: {} },
            });
            const out = await f.pass([message("A"), b, c]);
            expect(out[1]).toEqual(b); // The whole failed message correctly freezes raw.
            expect((out[2]!.parts[1] as any).state.output).toBe("C-result");
        });

        test("R6: deliberate full_request to provider switch-back bootstraps again", async () => {
            const f = fixture(host);
            await f.pass([message("A")]);
            f.deps.rustPipeline = "full_request";
            f.restart();
            await f.pass([message("A")]);
            expect(f.stored().state.pipeline_exit_json).toContain("rollback");
            f.deps.rustPipeline = "provider";
            f.restart();
            await f.pass([message("A")]);
            expect(f.wires.filter((w) => w.method === "compaction.setup")).toHaveLength(2);
            expect(f.adapter.isProviderSession("session")).toBe(true);
        });
    });

test("R7 v2: ordinary projection does not read the content of a known message", async () => {
    const f = fixture("v2");
    const initial = adaptPayload(draft(["A"]));
    await f.run(initial);
    const host = draft(["A", "B"]);
    const content = host.messages[0]!.content;
    let reads = 0;
    Object.defineProperty(host.messages[0], "content", {
        get() {
            reads++;
            return content;
        },
    });
    const mapped = adaptPayload(host); // This is the unconditional v2 context-hook projection.
    await f.run(mapped);
    expect(f.wires.filter((w) => w.method === "transform.hook")).toHaveLength(1);
    expect(reads).toBe(0);
});

test("R8 v2: front trim cannot discard an unknown race using canonical store ordinals", async () => {
    const f = fixture("v2", true);
    await f.pass([message("A"), message("B"), message("C")]);
    appendCompartments(f.db, "session", [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 3,
            startMessageId: "A",
            endMessageId: "C",
            title: "history",
            content: "history",
            p1: "history",
        },
    ]);
    const strategy = createV2RustCompactionMarkerStrategy(() => ({
        id: "C",
        role: "user",
        ordinal: 3,
        parts: [],
    }));
    strategy.applyDeferred(f.db, "session", { ordinal: 3, endMessageId: "C", publishedAt: 1000 });
    const canonical = new Map([
        ["A", 1],
        ["X", 2],
        ["B", 3],
        ["C", 4],
    ]);
    let storeReads = 0;
    const unregister = setRawMessageProvider("session", {
        readMessages: () => {
            throw new Error("whole history must not be read");
        },
        readMessageOrdinalById: (id) => {
            storeReads++;
            return canonical.get(id) ?? null;
        },
        readMessageIdOrdinalsForRange: (from, to) => {
            storeReads++;
            return new Map([...canonical].filter(([, o]) => o >= from && o <= to));
        },
    });
    try {
        const host = draft(["A", "X", "B", "C"]);
        // Exactly the consumer wiring in v2/hooks/context.ts:1763-1769. No store
        // ordinal is substituted here; the production trim decides to do that.
        const runner = f.adapter.ordinals("session")!;
        for (const m of host.messages) if (m.id) m.ordinal = runner.get(m.id);
        trimToRecordedBoundary(f.db, "session", host.messages);
        const mapped = adaptPayload(host);
        const out = await f.pass(mapped.messages);
        expect(out.map((m) => m.info.id)).toEqual(["A", "B", "C", "X"]);
        expect(storeReads).toBe(0);
    } finally {
        unregister();
    }
});

for (const host of ["v1", "v2"] as const)
    for (const setting of [undefined, "full_request"] as const)
        test(`R9 ${host}: ${setting ?? "absent"} setting preserves legacy BUSY replay for a never-provider session`, async () => {
            const f = fixture(host);
            // A different session's row makes createTransform allocate the adapter even
            // when the provider setting is off (transform.ts:696-702,1048-1049).
            await f.pass([message("A")]);
            f.deps.rustPipeline = setting;
            const busy = new StorageBusyRefusalError(
                new Error("SQLITE_BUSY fixture"),
                "rust-mode-transform",
            );
            f.setFallbackError(busy);
            const raw = message("Q");
            raw.info.sessionID = "full-only";
            const managed = { ...raw, parts: [{ type: "text", text: "MANAGED Q" }] } as MessageLike;
            getOrCreateSessionMeta(f.db, "full-only");
            const outputs: unknown[] = [];
            try {
                for (const lane of ["legacy", "adapter"] as const) {
                    resetLkgSlotsForTest();
                    expect(
                        captureSlot("full-only", {
                            jsonPrefix: JSON.stringify([managed]),
                            inputIdSeq: ["Q"],
                            inputContentDigests: [lkgContentDigest(raw)!],
                            lastInputMessageId: "Q",
                            modelKey: "openai/gpt-5.6",
                            providerKey: "openai",
                            capturedAt: Date.now(),
                        }),
                    ).toBe(true);
                    const transform = Object.assign(
                        async (_: Record<string, never>, out: { messages: unknown[] }) => {
                            if (lane === "legacy") throw busy;
                            await f.adapter.run(
                                "full-only",
                                out.messages as MessageLike[],
                                out,
                                getOrCreateSessionMeta(f.db, "full-only"),
                            );
                        },
                        {
                            isProviderSession: f.adapter.isProviderSession,
                            recoverProviderOutput: f.adapter.recoverOutput,
                        },
                    );
                    const out = { messages: [structuredClone(raw)] };
                    const result = await createMessagesTransformHandler({
                        magicContext: { "experimental.chat.messages.transform": transform },
                    })({}, out as unknown as WrapperOutput).then(
                        () => JSON.stringify(out.messages),
                        (error) => error,
                    );
                    outputs.push(result);
                }
                expect(outputs[0]).toBe(JSON.stringify([managed])); // Legacy really replays.
                expect(outputs[1]).toBe(outputs[0]);
            } finally {
                resetLkgSlotsForTest();
            }
        });

for (const host of ["v1", "v2"] as const)
    test(`R10 ${host}: a zero-append pass never serializes the known Setup head`, async () => {
        const f = fixture(host);
        let serializations = 0;
        const bytes = {
            info: { role: "user", sessionID: "session", syntheticHead: true },
            parts: [{ type: "text", text: "m0".repeat(5000), synthetic: true }],
        };
        const head = {
            ...bytes,
            toJSON() {
                serializations++;
                return bytes;
            },
        };
        f.setReply((w) => {
            if (w.method === "compaction.setup")
                return {
                    answer: "ready",
                    request_id: w.params.request_id,
                    initial: {
                        compaction_id: "head",
                        version: 1,
                        range: { from: 0, to: 0 },
                        replacement: [head],
                    },
                    call_when: { share: 0.9 },
                };
            if (w.method === "compaction.step")
                return {
                    answer: "compaction_message",
                    request_id: w.params.request_id,
                    compaction: {
                        compaction_id: "bootstrapped",
                        version: 2,
                        range: { from: 1, to: 2 },
                        replacement: [head, message("A")],
                    },
                };
        });
        await f.pass([message("A")]);
        serializations = 0;
        const sent = f.wires.length;
        await f.pass([message("A")]);
        expect(f.wires).toHaveLength(sent); // This was an ordinary, zero-hook pass.
        expect(serializations).toBe(0);
    });

for (const host of ["v1", "v2"] as const)
    test(`R11 ${host}: project config cannot opt a user-default full_request session into provider`, async () => {
        const f = fixture(host);
        const project: Record<string, unknown> = { rust_pipeline: "provider" };
        // The real loaders call this guard on raw project settings before merging.
        stripUnsafeProjectConfigFields(project);
        const config = MagicContextConfigSchema.parse({ transform_mode: "rust", ...project });
        f.deps.rustPipeline = config.rust_pipeline;
        await f.pass([message("A")]);
        expect(f.wires.filter((w) => w.method === "compaction.setup")).toHaveLength(0);
        expect(config.rust_pipeline).toBe("full_request");
    });

for (const host of ["v1", "v2"] as const)
    test(`control ${host}: interior races, repeated holes, raw-tail multi-turn revert and durable restart`, async () => {
        const f = fixture(host);
        const first = await f.pass([message("A"), message("B"), message("C"), message("D")]);
        const raced = await f.pass([
            message("A"),
            message("X"),
            message("C"),
            message("D"),
            message("E"),
        ]);
        expect(raced.slice(0, 4)).toEqual(first);
        expect(raced.map((m) => m.info.id)).toEqual(["A", "B", "C", "D", "X", "E"]);
        const next = await f.pass([
            message("A"),
            message("X"),
            message("C"),
            message("D"),
            message("E"),
            message("F"),
        ]);
        expect(next.slice(0, 6)).toEqual(raced);
        expect(f.stored().state.pipeline_exit_json).toBeNull();
        const reverted = await f.pass([message("A"), message("B"), message("Y")]);
        expect(reverted.slice(0, 2)).toEqual(first.slice(0, 2));
        expect(reverted.map((m) => m.info.id)).toEqual(["A", "B", "Y"]);
        expect(f.wires.at(-1)!.params.descends_from.through_ordinal).toBe(2);
        f.restart();
        const known = message("A");
        Object.defineProperty(known, "parts", {
            get() {
                throw new Error("known content read");
            },
        });
        const sent = f.wires.length;
        expect(await f.pass([known, message("B"), message("Y")])).toEqual(reverted);
        expect(f.wires).toHaveLength(sent);
    });

for (const host of ["v1", "v2"] as const)
    test(`control ${host}: bounded bootstrap rejects an early view and final wait without looping`, async () => {
        for (const bad of ["early view", "final wait"] as const) {
            const f = fixture(host);
            f.setReply((w) => {
                if (w.method !== "compaction.step") return;
                return bad === "early view"
                    ? {
                          answer: "compaction_message",
                          request_id: w.params.request_id,
                          compaction: {
                              compaction_id: "early",
                              version: 2,
                              range: { from: 1, to: 3 },
                              replacement: [message("early")],
                          },
                      }
                    : {
                          answer: "wait",
                          request_id: w.params.request_id,
                          reason: "page",
                          bound_ms: 1000,
                      };
            });
            await f.pass([
                message("A", "user", "x".repeat(1_600_000)),
                message("B", "user", "y".repeat(1_600_000)),
            ]);
            expect(f.adapter.isProviderSession("session")).toBe(false);
            expect(f.steps()).toHaveLength(bad === "early view" ? 1 : 2);
            expect(f.fallbacks).toHaveLength(1);
        }
    });

for (const host of ["v1", "v2"] as const)
    test(`control ${host}: cold is strict and self-consuming after a newer response`, async () => {
        const f = fixture(host);
        await f.pass([message("A")]);
        updateSessionMeta(f.db, "session", {
            cachedM0MaterializedAt: 1000,
            lastResponseTime: 2000,
        });
        resolveSessionCacheTtl(f.db, "session", "1m", "openai/gpt-5.6", true);
        f.setClock(62000);
        await f.pass([message("A")]);
        expect(f.steps()).toHaveLength(1);
        f.setClock(62001);
        await f.pass([message("A")]);
        expect(f.steps().at(-1)!.params.prefix_rebuilding).toEqual({ reason: "cold" });
        await f.pass([message("A")]);
        expect(f.steps()).toHaveLength(2);
    });
