import { describe, expect, test } from "bun:test";
import {
    HiddenCompletionRefusal,
    type HiddenRunIdentity,
} from "../hooks/magic-context/compartment-runner-types";
import { Database } from "../shared/sqlite";
import {
    createV2HiddenCompletionExecutor,
    type HiddenChildHost,
    hiddenChildrenMetaKey,
} from "./hidden-completion";
import {
    HIDDEN_DREAMER_AGENT,
    HIDDEN_HISTORIAN_AGENT,
    HiddenChildHook,
    registerHiddenChildAgents,
} from "./hooks/hidden-child";
import type { SessionContext } from "./hooks/types";
import type { StoreRow } from "./store-reader";

const run: HiddenRunIdentity = {
    parentSessionId: "user-session",
    agent: "historian-editor",
    kind: "historian-editor",
    system: "calibrated editor system",
    model: "mock/cheap",
    configuredModels: ["mock/cheap", "mock/fallback"],
    timeoutMs: 1200,
    title: "shared title is replaced by the carrier",
    directory: "/project",
};

const request = (
    modelID = "cheap",
    extra: Record<string, unknown> = {},
): {
    path: { id: string };
    body: Record<string, unknown> & {
        model: { providerID: string; modelID: string };
        parts: Array<{ type: string; text: string; synthetic: boolean }>;
    };
} => ({
    path: { id: "child" },
    body: {
        model: { providerID: "mock", modelID },
        parts: [{ type: "text", text: "calibrated chunk", synthetic: true }],
        ...extra,
    },
});

class Rows {
    private readonly rows = new Map<string, StoreRow<"assistant">[]>();
    private seq = 0;

    latestSequence(sessionID: string): number {
        return this.rows.get(sessionID)?.at(-1)?.seq ?? -1;
    }

    latestAssistant(sessionID: string): StoreRow<"assistant"> | undefined {
        return this.rows.get(sessionID)?.at(-1);
    }

    append(
        sessionID: string,
        text: string,
        options: {
            modelID?: string;
            usage?: boolean;
            error?: unknown;
            finish?: string;
        } = {},
    ): StoreRow<"assistant"> {
        const row: StoreRow<"assistant"> = {
            id: `message-${++this.seq}`,
            session_id: sessionID,
            type: "assistant",
            seq: this.seq,
            data: {
                content: [{ type: "text", text }],
                finish: options.finish ?? "stop",
                ...(options.error === undefined ? {} : { error: options.error }),
                model: { providerID: "mock", id: options.modelID ?? "cheap" },
                ...(options.usage === false
                    ? {}
                    : {
                          tokens: {
                              input: 101,
                              output: 11,
                              reasoning: 3,
                              cache: { read: 7, write: 5 },
                          },
                      }),
                time: { created: Date.now(), completed: Date.now() },
            },
        };
        const current = this.rows.get(sessionID) ?? [];
        current.push(row);
        this.rows.set(sessionID, current);
        return row;
    }
}

async function setup(generation = "host-generation-1") {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const rows = new Rows();
    const hook = new HiddenChildHook();
    const children = new Map<
        string,
        { model: { providerID: string; id: string; variant?: string } }
    >();
    const creates: Parameters<HiddenChildHost["create"]>[0][] = [];
    const switches: Parameters<HiddenChildHost["switchModel"]>[0][] = [];
    const updates: Parameters<HiddenChildHost["update"]>[0][] = [];
    const interrupts: string[] = [];
    const requests: SessionContext[] = [];
    let nextID = 0;
    let failPrompt = false;
    let providerError: unknown;
    let delayRowMs = 0;
    let omitUsage = false;
    let completion = "editor completion";

    const host: HiddenChildHost = {
        async create(input) {
            creates.push(structuredClone(input));
            const id = `child-${++nextID}`;
            children.set(id, { model: structuredClone(input.model) });
            return { id };
        },
        async get() {
            return { model: { providerID: "mock", id: "user" } };
        },
        async switchModel(input) {
            switches.push(structuredClone(input));
            children.set(input.sessionID, { model: structuredClone(input.model) });
        },
        async prompt(input) {
            const child = children.get(input.sessionID);
            if (!child) throw new Error("missing child");
            const draft: SessionContext = {
                sessionID: input.sessionID,
                model: child.model,
                agent: "historian",
                system: [{ type: "text", text: "host system" }],
                tools: { read: { description: "read", input: {} } },
                options: { hostDefault: true },
                messages: [
                    {
                        id: "history",
                        role: "assistant",
                        content: [{ type: "text", text: "private child history" }],
                    },
                    { role: "user", content: [{ type: "text", text: input.text }] },
                ],
            };
            hook.apply(draft);
            requests.push(structuredClone(draft));
            if (failPrompt) throw new Error("provider unavailable");
            if (providerError !== undefined) {
                rows.append(input.sessionID, "", {
                    error: providerError,
                    finish: "error",
                    usage: false,
                });
                return;
            }
            const write = () =>
                rows.append(input.sessionID, completion, {
                    usage: !omitUsage,
                    modelID: child.model.id,
                });
            if (delayRowMs > 0) setTimeout(write, delayRowMs);
            else write();
        },
        async wait() {},
        async interrupt(input) {
            interrupts.push(input.sessionID);
            return { interrupted: true };
        },
        async update(input) {
            updates.push(structuredClone(input));
        },
    };
    const create = (hostGeneration = generation) =>
        createV2HiddenCompletionExecutor(host, {
            db,
            projectIdentity: "/project",
            hook,
            openReader: () => rows,
            generation: hostGeneration,
        });
    const executor = await create();
    return {
        db,
        rows,
        hook,
        host,
        executor,
        create,
        creates,
        switches,
        updates,
        interrupts,
        requests,
        setFailPrompt(value: boolean) {
            failPrompt = value;
        },
        setProviderError(value: unknown) {
            providerError = value;
        },
        setDelayRow(value: number) {
            delayRowMs = value;
        },
        setOmitUsage(value: boolean) {
            omitUsage = value;
        },
        setCompletion(value: string) {
            completion = value;
        },
    };
}

async function close(
    executor: Awaited<ReturnType<typeof createV2HiddenCompletionExecutor>>,
    handle: Awaited<ReturnType<typeof executor.open>>,
    settled: boolean,
): Promise<void> {
    await executor.close(handle, {
        promptSettled: settled,
        privacySensitive: false,
        context: "historian",
        log() {},
    });
}

describe("OpenCode 2 hidden child completion", () => {
    test("sends the exact calibrated pair with options and provider usage", async () => {
        const state = await setup();
        try {
            const handle = await state.executor.open(run);
            await state.executor.attempt(handle, request("cheap", { temperature: 0.25 }));
            const completion = await state.executor.collect(handle, 50);
            expect(state.creates).toEqual([
                {
                    title: "Magic Context historian",
                    agent: "historian",
                    model: { providerID: "mock", id: "cheap" },
                    location: { directory: "/project" },
                    metadata: { magic_context: "hidden-run", role: "historian" },
                },
            ]);
            expect(state.requests).toHaveLength(1);
            expect(state.requests[0]?.system).toEqual([
                { type: "text", text: "calibrated editor system" },
            ]);
            expect(state.requests[0]?.messages).toEqual([
                { role: "user", content: [{ type: "text", text: "calibrated chunk" }] },
            ]);
            expect(state.requests[0]?.tools).toEqual({});
            expect(state.requests[0]?.options).toEqual({
                maxOutputTokens: 32768,
                maxTokens: 32768,
                temperature: 0.25,
            });
            expect(completion).toMatchObject({
                text: "editor completion",
                usage: { input: 101, output: 11, cacheRead: 7, cacheWrite: 5 },
                providerId: "mock",
                modelId: "cheap",
            });
            expect(state.updates).toEqual([
                { sessionID: "child-1", title: "Magic Context historian" },
            ]);
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });

    test("reuses one successful child for a second run and reasserts its title once", async () => {
        const state = await setup();
        try {
            for (const text of ["first", "second"]) {
                state.setCompletion(text);
                const handle = await state.executor.open(run);
                await state.executor.attempt(handle, request());
                expect((await state.executor.collect(handle, 50)).text).toBe(text);
                await close(state.executor, handle, true);
            }
            expect(state.creates).toHaveLength(1);
            expect(state.requests).toHaveLength(2);
            expect(state.updates).toHaveLength(1);
        } finally {
            state.db.close();
        }
    });

    test("retires an overall failed run and creates a fresh child next time", async () => {
        const state = await setup();
        try {
            const first = await state.executor.open(run);
            await state.executor.attempt(first, request());
            await close(state.executor, first, true);

            state.setFailPrompt(true);
            const second = await state.executor.open(run);
            await expect(state.executor.attempt(second, request())).rejects.toThrow(
                "provider unavailable",
            );
            await close(state.executor, second, false);

            state.setFailPrompt(false);
            const third = await state.executor.open(run);
            expect(third.id).toBe("child-2");
            await state.executor.attempt(third, request());
            await close(state.executor, third, true);
            expect(state.creates).toHaveLength(2);
            const meta = JSON.parse(
                (
                    state.db
                        .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
                        .get(hiddenChildrenMetaKey("/project")) as { value: string }
                ).value,
            );
            expect(meta.retired_children).toHaveLength(1);
            expect(meta.retired_children[0]).toMatchObject({
                id: "child-1",
                reason: "hidden-run-failed",
            });
        } finally {
            state.db.close();
        }
    });

    test("keeps the child when a run fails only on settled provider errors", async () => {
        const state = await setup();
        try {
            state.setProviderError({ message: "Go usage limit exceeded" });
            for (let i = 0; i < 5; i++) {
                const handle = await state.executor.open(run);
                expect(handle.id).toBe("child-1");
                await expect(state.executor.attempt(handle, request("cheap"))).rejects.toThrow(
                    "Hidden completion provider error: ",
                );
                await expect(state.executor.attempt(handle, request("fallback"))).rejects.toThrow(
                    "Go usage limit exceeded",
                );
                await close(state.executor, handle, true);
            }
            state.setProviderError(undefined);
            const recovered = await state.executor.open(run);
            expect(recovered.id).toBe("child-1");
            await state.executor.attempt(recovered, request());
            await close(state.executor, recovered, true);
            expect(state.creates).toHaveLength(1);
            const meta = JSON.parse(
                (
                    state.db
                        .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
                        .get(hiddenChildrenMetaKey("/project")) as { value: string }
                ).value,
            );
            expect(meta.retired_children).toHaveLength(0);
        } finally {
            state.db.close();
        }
    });

    test("a restarted executor reuses a child whose newest assistant is a settled provider error", async () => {
        const state = await setup();
        try {
            state.setProviderError({ message: "The usage limit has been reached" });
            const handle = await state.executor.open(run);
            await expect(state.executor.attempt(handle, request())).rejects.toThrow();
            await close(state.executor, handle, true);
            state.setProviderError(undefined);
            const restarted = await state.create();
            const next = await restarted.open(run);
            expect(next.id).toBe("child-1");
            await restarted.attempt(next, request());
            await close(restarted, next, true);
            expect(state.creates).toHaveLength(1);
        } finally {
            state.db.close();
        }
    });

    test("switches the same child for a retry model before re-prompting", async () => {
        const state = await setup();
        try {
            state.setFailPrompt(true);
            const handle = await state.executor.open(run);
            await expect(state.executor.attempt(handle, request("cheap"))).rejects.toThrow();
            state.setFailPrompt(false);
            await state.executor.attempt(handle, request("fallback"));
            expect((await state.executor.collect(handle, 50)).modelId).toBe("fallback");
            expect(state.creates).toHaveLength(1);
            expect(state.switches).toEqual([
                {
                    sessionID: "child-1",
                    model: { providerID: "mock", id: "fallback" },
                },
            ]);
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });

    test("does not treat an old assistant as completion when wait returns immediately", async () => {
        const state = await setup();
        try {
            const first = await state.executor.open(run);
            await state.executor.attempt(first, request());
            await close(state.executor, first, true);

            state.setCompletion("new persisted completion");
            state.setDelayRow(250);
            const second = await state.executor.open(run);
            const started = Date.now();
            await state.executor.attempt(second, request());
            expect(Date.now() - started).toBeGreaterThanOrEqual(180);
            expect((await state.executor.collect(second, 50)).text).toBe(
                "new persisted completion",
            );
            await close(state.executor, second, true);
        } finally {
            state.db.close();
        }
    });

    test("uses the local meter only when a completed row omits usage", async () => {
        const state = await setup();
        try {
            state.setOmitUsage(true);
            const handle = await state.executor.open(run);
            await state.executor.attempt(handle, request());
            const completion = await state.executor.collect(handle, 50);
            expect(completion.usage.input).toBeGreaterThan(0);
            expect(completion.usage.output).toBeGreaterThan(0);
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });

    test("abort interrupts and retires the child before the next open", async () => {
        const state = await setup();
        try {
            state.setDelayRow(1000);
            const handle = await state.executor.open(run);
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 20);
            await expect(
                state.executor.attempt(handle, {
                    ...request(),
                    signal: controller.signal,
                }),
            ).rejects.toThrow("aborted");
            await close(state.executor, handle, false);
            expect(state.interrupts).toEqual(["child-1"]);
            state.setDelayRow(0);
            const fresh = await state.executor.open(run);
            expect(fresh.id).toBe("child-2");
            await close(state.executor, fresh, false);
        } finally {
            state.db.close();
        }
    });

    test("a restarted executor reuses the successful v2 child from persisted project meta", async () => {
        const state = await setup();
        try {
            const first = await state.executor.open(run);
            await state.executor.attempt(first, request());
            await close(state.executor, first);

            const restarted = await createV2HiddenCompletionExecutor(state.host, {
                db: state.db,
                projectIdentity: "/project",
                hook: state.hook,
                openReader: () => state.rows,
                generation: "host-generation-1",
            });
            const reused = await restarted.open(run);
            expect(reused.id).toBe("child-1");
            await restarted.attempt(reused, request("after restart"));
            await close(restarted, reused);
            expect(state.creates).toHaveLength(1);
        } finally {
            state.db.close();
        }
    });

    test("a new host generation retires the previous generation's child", async () => {
        const state = await setup();
        try {
            const first = await state.executor.open(run);
            await state.executor.attempt(first, request());
            await close(state.executor, first, true);

            const restarted = await state.create("host-generation-2");
            const second = await restarted.open(run);
            expect(second.id).toBe("child-2");
            await restarted.attempt(second, request());
            await close(restarted, second, true);
            expect(state.creates).toHaveLength(2);
        } finally {
            state.db.close();
        }
    });

    test("registers fail-closed hidden carrier agents", async () => {
        const agents = new Map<
            string,
            {
                system?: string;
                description?: string;
                mode: "subagent" | "primary" | "all";
                hidden: boolean;
                request: {
                    settings: Record<string, unknown>;
                    headers: Record<string, string>;
                    body: Record<string, unknown>;
                };
                permissions: Array<{
                    action: string;
                    resource: string;
                    effect: "allow" | "deny" | "ask";
                }>;
            }
        >();
        await registerHiddenChildAgents({
            async transform(callback) {
                callback({
                    update(id, update) {
                        const agent = {
                            mode: "primary" as const,
                            hidden: false,
                            request: { settings: {}, headers: {}, body: {} },
                            permissions: [],
                        };
                        update(agent);
                        agents.set(id, agent);
                    },
                });
            },
        });
        expect([...agents.keys()]).toEqual([HIDDEN_HISTORIAN_AGENT, HIDDEN_DREAMER_AGENT]);
        for (const agent of agents.values()) {
            expect(agent.hidden).toBe(true);
            expect(agent.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
        }
    });

    test("ordinary drafts are untouched and unregistered child prompts fail closed", async () => {
        const state = await setup();
        try {
            const ordinary: SessionContext = {
                sessionID: "ordinary",
                model: { providerID: "mock", id: "user" },
                agent: "build",
                system: [],
                tools: {},
                options: {},
                messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
            };
            const bytes = JSON.stringify(ordinary);
            expect(state.hook.apply(ordinary)).toBe(false);
            expect(JSON.stringify(ordinary)).toBe(bytes);

            const handle = await state.executor.open(run);
            const unregistered = { ...ordinary, sessionID: handle.id };
            expect(() => state.hook.apply(unregistered)).toThrow(HiddenCompletionRefusal);
            await close(state.executor, handle, false);
        } finally {
            state.db.close();
        }
    });
});
