import { afterEach, describe, expect, test } from "bun:test";
import { appendCompartments } from "../../../features/magic-context/compartment-storage";
import { runMigrations } from "../../../features/magic-context/migrations";
import { createScheduler } from "../../../features/magic-context/scheduler";
import { resolveSessionCacheTtl } from "../../../features/magic-context/session-cache-ttl";
import { initializeDatabase } from "../../../features/magic-context/storage-db";
import {
    commitHostRunnerPass,
    HostRunnerDurabilityError,
    loadHostRunnerRecord,
} from "../../../features/magic-context/storage-host-runner";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../../features/magic-context/storage-meta";
import { createTagger } from "../../../features/magic-context/tagger";
import { Database } from "../../../shared/sqlite";
import {
    createV2RustCompactionMarkerStrategy,
    trimToRecordedBoundary,
} from "../../../v2/fold/boundary";
import { adaptPayload } from "../../../v2/hooks/payload";
import type { SessionContext } from "../../../v2/hooks/types";
import { EmergencyFailClosedError } from "../emergency-fail-closed";
import type { createRustModeTransform } from "../rust-mode-transform";
import type { TransformDeps } from "../transform";
import type { MessageLike } from "../transform-operations";
import { applyProviderOps, createOpenCodeProviderTransform } from "./opencode-adapter";
import type { HookAnswer } from "./record";

type Wire = { method: string; params: Record<string, any> };
type Host = "v1" | "v2";
const cleanup: (() => void)[] = [];
afterEach(() => {
    for (const dispose of cleanup.splice(0).reverse()) dispose();
});
const bytes = (value: unknown) => JSON.stringify(value);
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

// Record protocol calls and per-message hook operations separately. Bootstrap
// normally returns an empty replacement so tests exercise retained messages,
// rather than replacing those messages with a compacted view.
function fixture(host: Host, covered = false) {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    getOrCreateSessionMeta(db, "session");
    const wires: Wire[] = [],
        barriers: boolean[] = [],
        fallbacks: unknown[] = [];
    const rows = new Map<number, MessageLike>(),
        ops = new Map<number, HookAnswer[]>();
    let version = 1,
        clock = 1000;
    let override: ((w: Wire) => unknown) | undefined;
    const deps: TransformDeps = {
        db,
        transformMode: "rust",
        rustPipeline: "provider",
        storeGeneration: host,
        directory: "/hermetic-h4-review2",
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
                const reply = override?.(w);
                if (reply !== undefined) return reply;
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
                    ops.set(p.subject_ordinal, [
                        ...(ops.get(p.subject_ordinal) ?? []).filter(
                            (a) =>
                                a.subject.hook !== p.hook ||
                                a.subject.subject_part !== p.subject_part,
                        ),
                        answer,
                    ]);
                    return { answer: "ops", ops: answer.ops };
                }
                if (w.method === "compaction.step") {
                    for (const row of p.messages) rows.set(row.ordinal, row.message);
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
                throw new Error(`Unexpected recording-module call: ${w.method}`);
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
            fallbacks.push(namespace ?? "canonical");
            if (input !== out.messages) out.messages.splice(0, out.messages.length, ...input);
        },
    };
    let adapter = createOpenCodeProviderTransform(deps, legacy, seams);
    cleanup.push(() => {
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
        setReply(fn?: (w: Wire) => unknown) {
            override = fn;
        },
        setClock(n: number) {
            clock = n;
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
        steps: () => wires.filter((w) => w.method === "compaction.step"),
        async run(out: { messages: unknown[] }) {
            await adapter.run(
                "session",
                out.messages as MessageLike[],
                out,
                getOrCreateSessionMeta(db, "session"),
            );
        },
        async pass(input: MessageLike[]) {
            const out = { messages: input };
            await this.run(out);
            return out.messages;
        },
    };
}

for (const host of ["v1", "v2"] as const)
    describe(`H4 second review ${host}`, () => {
        test("R2.1: mutating the host-retained served object cannot rewrite recorded prefix bytes", async () => {
            const f = fixture(host);
            const retained = [message("A")];
            const secondReference = retained;
            const out = { messages: retained };
            await f.run(out);
            const first = bytes(retained);
            expect(secondReference).toBe(out.messages);
            (secondReference[0]!.parts[0] as any).text = "HOST MUTATED ALREADY SERVED A";
            retained.push(message("B"));
            await f.run(out);
            expect(bytes(JSON.parse(f.stored().entries[0]!.ingest_json))).toBe(first.slice(1, -1));
            expect(bytes(out.messages.slice(0, 1))).toBe(first);
        });

        for (const failures of ["noop", "transport"] as const)
            test(`control: covered revert retries after two consecutive ${failures} failures`, async () => {
                const f = fixture(host, true);
                await f.pass([message("A"), message("B"), message("C")]);
                f.restart();
                f.setReply((w) => {
                    if (w.method !== "compaction.step") return;
                    if (failures === "transport") throw new Error("offline");
                    return { answer: "noop", request_id: w.params.request_id };
                });
                for (let i = 0; i < 2; i++) {
                    await expect(f.pass([message("A"), message("B")])).rejects.toBeInstanceOf(
                        EmergencyFailClosedError,
                    );
                    expect(f.stored().views[0]!.state).toBe("invalidated");
                }
                f.setReply();
                const count = f.steps().length;
                expect(await f.pass([message("A"), message("B")])).toEqual([
                    message("A"),
                    message("B"),
                ]);
                expect(f.steps()).toHaveLength(count + 1);
                expect(f.steps().at(-1)!.params.prefix_rebuilding).toEqual({ reason: "revert" });
            });

        test("control: SOFT then HARD then SOFT with a TTL edit keeps the HARD clock", async () => {
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
            expect(getOrCreateSessionMeta(f.db, "session").cachedM0MaterializedAt).toBe(1000);
            resolveSessionCacheTtl(f.db, "session", "1m", "openai/gpt-5.6", true);
            f.setClock(62001);
            await f.pass([message("A")]);
            expect(f.steps().at(-1)!.params.prefix_rebuilding).toEqual({ reason: "cold" });
            expect(getOrCreateSessionMeta(f.db, "session").cachedM0MaterializedAt).toBe(62001);
            f.setClock(65000);
            f.deps.historyRefreshSessions.add("session");
            await f.pass([message("A")]);
            expect(getOrCreateSessionMeta(f.db, "session").cachedM0MaterializedAt).toBe(62001);
            const count = f.steps().length;
            f.setClock(500000);
            await f.pass([message("A")]);
            expect(f.steps()).toHaveLength(count);
        });

        test("control: a safety exit stays sticky across settings toggles and restart", async () => {
            const f = fixture(host);
            await f.pass([message("A"), message("B")]);
            await f.pass([message("FOREIGN")]);
            expect(f.stored().state.pipeline_exit_json).toContain("provider_foreign_history");
            const count = f.wires.length;
            const retired = f.stored().state.lineage_id;
            f.deps.rustPipeline = "full_request";
            f.restart();
            await f.pass([message("A"), message("B")]);
            f.deps.rustPipeline = "provider";
            f.restart();
            await f.pass([message("A"), message("B")]);
            expect(f.wires).toHaveLength(count);
            expect(f.stored().state.lineage_id).toBe(retired);
            expect(f.adapter.isProviderSession("session")).toBe(false);
        });

        test("R2.4: an append with no matching subscriptions still completes the historian pass", async () => {
            const f = fixture(host);
            f.setReply((w) =>
                w.method === "transform.declare"
                    ? {
                          subscriptions: [
                              {
                                  hook: "post_tool",
                                  ops: ["prepend"],
                                  budget_ms: 2000,
                                  on_unavailable: "pass",
                              },
                          ],
                      }
                    : undefined,
            );
            await f.pass([message("A")]);
            const barrier = f.barriers.length;
            await f.pass([message("A"), message("B")]);
            expect(f.wires.filter((w) => w.method === "transform.hook")).toHaveLength(0);
            expect(f.barriers.slice(barrier)).toContain(true);
        });
    });

function toolDraft(): SessionContext {
    const host = draft(["A"]);
    host.messages.push(
        {
            id: "T",
            role: "assistant",
            stamp: "call metadata",
            content: [
                { type: "text", text: "reply" },
                {
                    type: "tool-call",
                    id: "call",
                    name: "read",
                    input: { path: "fixture" },
                    providerMetadata: { vendor: { signature: "call-signature" } },
                },
            ],
        },
        {
            role: "tool",
            stamp: "result metadata",
            content: [
                {
                    type: "tool-result",
                    id: "call",
                    name: "read",
                    result: {
                        type: "content",
                        value: [
                            { type: "text", text: "result" },
                            {
                                type: "file",
                                uri: "data:image/png;base64,AQID",
                                mime: "image/png",
                                name: "fixture.png",
                            },
                        ],
                    },
                    providerMetadata: { vendor: { signature: "result-signature" } },
                },
            ],
        } as any,
    );
    return host;
}

test("R2.2 v2: durable restart replays the first-served tool result and attachment bytes", async () => {
    const f = fixture("v2");
    const first = toolDraft();
    const mapped = adaptPayload(first);
    await f.run(mapped);
    mapped.commit();
    const served = bytes(first.messages);
    f.restart();
    expect(f.adapter.isProviderSession("session")).toBe(true);
    const second = toolDraft();
    const replay = adaptPayload(second);
    await f.run(replay);
    replay.commit();
    expect(bytes(second.messages)).toBe(served);
});

test("R2.3 v2: mutating retained host content cannot poison the projection cache", async () => {
    const f = fixture("v2");
    const host = draft(["A"]);
    const mapped = adaptPayload(host);
    await f.run(mapped);
    mapped.commit();
    const served = bytes(host.messages);
    host.messages[0]!.content[0]!.text = "HOST MUTATED PROJECTED A";
    const next = adaptPayload(host);
    await f.run(next);
    expect((next.messages[0]!.parts[0] as any).text).toBe("A");
    next.commit();
    expect(bytes(host.messages)).toBe(served);
});

test("control R7 v2: editing a known id in a fresh host object replays recorded bytes without reading its content", async () => {
    const f = fixture("v2");
    const first = draft(["A"]);
    const mapped = adaptPayload(first);
    await f.run(mapped);
    mapped.commit();
    const served = bytes(first.messages);
    const next = draft(["A"]);
    let reads = 0;
    Object.defineProperty(next.messages[0], "content", {
        get() {
            reads++;
            return [{ type: "text", text: "EDITED A" }];
        },
    });
    const replay = adaptPayload(next);
    await f.run(replay);
    replay.commit();
    expect(reads).toBe(0);
    expect(bytes(next.messages)).toBe(served);
});

for (const where of ["front", "end"] as const)
    test(`control R8 v2: unknown ${where} race survives recorded-boundary trim`, async () => {
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
        createV2RustCompactionMarkerStrategy(() => ({
            id: "C",
            role: "user",
            ordinal: 3,
            parts: [],
        })).applyDeferred(f.db, "session", { ordinal: 3, endMessageId: "C", publishedAt: 1000 });
        const host = draft(where === "front" ? ["X", "A", "B", "C"] : ["A", "B", "C", "X"]);
        const ids = f.adapter.ordinals("session")!;
        for (const m of host.messages) if (m.id) m.ordinal = ids.get(m.id);
        trimToRecordedBoundary(f.db, "session", host.messages);
        const mapped = adaptPayload(host);
        await f.run(mapped);
        mapped.commit();
        expect(host.messages.map((m) => m.id)).toEqual(["A", "B", "C", "X"]);
    });

for (const host of ["v1", "v2"] as const) {
    test(`control ${host}: burns reach the next message before each of its three hooks`, async () => {
        const f = fixture(host);
        await f.pass([message("A")]);
        f.setReply((w) => {
            if (w.method !== "transform.hook") return;
            if (w.params.subject_mid === "B" && w.params.subject_part === "B-2")
                throw new Error("unavailable second tool");
            return { answer: "pass" };
        });
        const terminal = (id: string) => {
            const m = message(id, "assistant");
            for (let i = 1; i <= 2; i++)
                m.parts.push({
                    id: `${id}-${i}`,
                    type: "tool",
                    tool: "read",
                    callID: `call-${id}-${i}`,
                    state: { status: "completed", output: `${id}-${i}`, input: {} },
                });
            return m;
        };
        const b = terminal("B"),
            c = terminal("C");
        const served = await f.pass([message("A"), b, c]);
        expect(bytes(served[1])).toBe(bytes(b));
        const calls = f.wires.filter(
            (w) => w.method === "transform.hook" && w.params.subject_mid === "C",
        );
        expect(calls).toHaveLength(3);
        expect(
            calls[0]!.params.unserved_subjects.map(({ hook, subject_mid, subject_part }: any) => ({
                hook,
                subject_mid,
                ...(subject_part ? { subject_part } : {}),
            })),
        ).toEqual([
            { hook: "post_assistant", subject_mid: "B" },
            { hook: "post_tool", subject_mid: "B", subject_part: "B-1" },
            { hook: "post_tool", subject_mid: "B", subject_part: "B-2" },
        ]);
        expect(calls.slice(1).every((w) => !w.params.unserved_subjects?.length)).toBe(true);
        expect(JSON.parse(f.stored().state.unserved_json)).toEqual([]);
    });

    test(`control ${host}: HARD clock and accepted view roll back together if the final statement fails`, async () => {
        const f = fixture(host);
        await f.pass([message("A")]);
        updateSessionMeta(f.db, "session", {
            cachedM0MaterializedAt: 1000,
            lastResponseTime: 2000,
        });
        resolveSessionCacheTtl(f.db, "session", "1m", "openai/gpt-5.6", true);
        f.setClock(62001);
        const before = bytes(f.stored().views);
        // abort_hard_state rejects the final state-row update after the new view
        // and clock writes. The earlier message and request-fence commits remain
        // intact; only the answer transaction must roll back.
        f.db.exec(`CREATE TEMP TRIGGER abort_hard_state BEFORE UPDATE ON host_runner_state
          WHEN NEW.setup_json LIKE '%"materializedAt":62001%'
          BEGIN SELECT RAISE(ABORT, 'review2 interrupted answer'); END`);
        await expect(f.pass([message("A")])).rejects.toBeInstanceOf(EmergencyFailClosedError);
        expect(bytes(f.stored().views)).toBe(before);
        expect(getOrCreateSessionMeta(f.db, "session").cachedM0MaterializedAt).toBe(1000);
        f.db.exec("DROP TRIGGER abort_hard_state");
        f.restart();
        await f.pass([message("A")]);
        expect(getOrCreateSessionMeta(f.db, "session").cachedM0MaterializedAt).toBe(62001);
    });

    test(`control ${host}: retired rollback replacement is atomic and rejects a safety exit`, async () => {
        const f = fixture(host);
        await f.pass([message("A")]);
        f.deps.rustPipeline = "full_request";
        await f.pass([message("A")]);
        const retired = bytes(f.stored());
        f.db.exec(`CREATE TEMP TRIGGER abort_new_state BEFORE INSERT ON host_runner_state
          BEGIN SELECT RAISE(ABORT, 'review2 interrupted replacement'); END`);
        f.deps.rustPipeline = "provider";
        f.restart();
        await expect(f.pass([message("A")])).rejects.toBeInstanceOf(EmergencyFailClosedError);
        expect(bytes(f.stored())).toBe(retired);
        f.db.exec("DROP TRIGGER abort_new_state");
        f.restart();
        await f.pass([message("A")]);
        expect(f.stored().state.pipeline_exit_json).toBeNull();
        await f.pass([message("FOREIGN")]);
        const safety = f.stored();
        expect(() =>
            commitHostRunnerPass(
                f.db,
                { session_id: "session", harness: host === "v1" ? "opencode" : "opencode2" },
                { state: safety.state, replace_retired_rollback: safety.state.pipeline_exit_json! },
            ),
        ).toThrow(HostRunnerDurabilityError);
        expect(bytes(f.stored())).toBe(bytes(safety));
    });
}

test("control R2 v2: duplicate tool-call identities survive warm re-projection and restart", async () => {
    const f = fixture("v2");
    await f.pass([message("A")]);
    const host = draft(["A"]);
    host.messages.push(
        {
            id: "T",
            role: "assistant",
            content: [
                { type: "tool-call", id: "repeat", name: "read", input: { n: 1 } },
                { type: "tool-call", id: "repeat", name: "read", input: { n: 2 } },
            ],
        },
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: "repeat",
                    name: "read",
                    result: { type: "text", value: "one" },
                },
                {
                    type: "tool-result",
                    id: "repeat",
                    name: "read",
                    result: { type: "text", value: "two" },
                },
            ],
        },
    );
    const projected = adaptPayload(host);
    await f.run(projected);
    projected.commit();
    const first = bytes(host.messages);
    expect(
        f.wires
            .filter((w) => w.method === "transform.hook" && w.params.hook === "post_tool")
            .map((w) => w.params.subject_part),
    ).toEqual(["v2:0:repeat", "v2:1:repeat"]);
    const replay = adaptPayload(host);
    await f.run(replay);
    replay.commit();
    expect(bytes(host.messages)).toBe(first);
    f.restart();
    expect(f.adapter.isProviderSession("session")).toBe(true);
    const restarted = adaptPayload(host);
    await f.run(restarted);
    restarted.commit();
    expect(bytes(host.messages)).toBe(first);
    expect(
        f.wires.filter((w) => w.method === "transform.hook" && w.params.hook === "post_tool"),
    ).toHaveLength(2);
});

for (const host of ["v1", "v2"] as const)
    test(`R2.4 ${host}: a final unhooked append does not strand the earlier hook's pass barrier`, async () => {
        const f = fixture(host);
        f.setReply((w) =>
            w.method === "transform.declare"
                ? {
                      subscriptions: [
                          {
                              hook: "post_assistant",
                              ops: ["prepend"],
                              budget_ms: 2000,
                              on_unavailable: "pass",
                          },
                      ],
                  }
                : undefined,
        );
        await f.pass([message("A")]);
        const barrier = f.barriers.length;
        await f.pass([message("A"), message("B", "assistant"), message("C")]);
        const hooks = f.wires.filter((w) => w.method === "transform.hook");
        expect(hooks).toHaveLength(1);
        expect(
            hooks[0]!.params.pass_complete === true || f.barriers.slice(barrier).includes(true),
        ).toBe(true);
    });

for (const host of ["v1", "v2"] as const)
    test(`control ${host}: replacing host array elements preserves in-place publication and the recorded bytes`, async () => {
        const f = fixture(host, true);
        const out = { messages: [message("A")] };
        const retained = out.messages;
        await f.run(out);
        const served = bytes(out.messages);
        retained[0] = message("A", "user", "fresh object edit");
        retained.push(message("B"));
        await f.run(out);
        expect(out.messages).toBe(retained);
        expect(bytes(retained.slice(0, 1))).toBe(served);
    });
