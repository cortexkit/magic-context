import { describe, expect, test } from "bun:test";
import { inspectCurateMemoryOperations } from "../features/magic-context/dreamer/task-executor";
import {
    HiddenCompletionRefusal,
    type HiddenRunIdentity,
} from "../hooks/magic-context/compartment-runner-types";
import {
    getPromptFailureDetail,
    promptSyncWithValidatedOutputRetry,
} from "../shared/model-suggestion-retry";
import { Database } from "../shared/sqlite";
import {
    createV2HiddenCompletionExecutor,
    type HiddenChildHost,
    toolLoopMessages,
} from "./hidden-completion";
import {
    HIDDEN_CURATE_AGENT,
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

const dreamerRun: HiddenRunIdentity = {
    ...run,
    agent: HIDDEN_DREAMER_AGENT,
    kind: "dreamer-task",
};

test("host unknown terminal error retains the hook's typed local refusal", async () => {
    const f = await setup();
    const handle = await f.executor.open(dreamerRun);
    f.setReadableSessionError({ type: "unknown", message: "host serialized hook failure" });
    f.host.prompt = async (input) => {
        try {
            f.hook.apply({
                sessionID: input.sessionID,
                model: { providerID: "mock", id: "cheap" },
                agent: "dreamer",
                system: [],
                tools: {},
                options: {},
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "extra instruction before marker" },
                            { type: "text", text: input.text },
                        ],
                    },
                ],
            });
        } catch {
            f.rows.appendIdle(input.sessionID, "failed");
        }
    };
    let caught: unknown;
    try {
        await promptSyncWithValidatedOutputRetry(undefined, request(), {
            transport: (args) => f.executor.attempt(handle, args),
            fetchOutput: async () => "unreachable",
            validateOutput: (value) => value,
        });
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(HiddenCompletionRefusal);
    expect((caught as HiddenCompletionRefusal).code).toBe("hidden_prompt_unrecognized");
    expect((caught as Error).message).toContain("Refusing an unregistered prompt");
    expect(getPromptFailureDetail(caught)?.failureClass).toBe("local_refusal");
    await f.executor.close(handle, {
        promptSettled: false,
        privacySensitive: false,
        context: "test",
        log() {},
    });
    f.db.close();
});

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
    private readonly idle = new Map<string, StoreRow<"idle">[]>();
    private seq = 0;
    latestAssistantCalls = 0;
    latestIdleCalls = 0;

    latestSequence(sessionID: string): number {
        return Math.max(
            this.rows.get(sessionID)?.at(-1)?.seq ?? -1,
            this.idle.get(sessionID)?.at(-1)?.seq ?? -1,
        );
    }

    assistantSince(sessionID: string, afterSeq: number): StoreRow<"assistant">[] {
        return (this.rows.get(sessionID) ?? []).filter((row) => row.seq > afterSeq);
    }

    latestAssistant(sessionID: string): StoreRow<"assistant"> | undefined {
        this.latestAssistantCalls += 1;
        return this.rows.get(sessionID)?.at(-1);
    }

    latestIdle(sessionID: string): StoreRow<"idle"> | undefined {
        this.latestIdleCalls += 1;
        return this.idle.get(sessionID)?.at(-1);
    }

    appendIdle(sessionID: string, outcome: "succeeded" | "failed" | "interrupted") {
        const row: StoreRow<"idle"> = {
            id: `message-${++this.seq}`,
            session_id: sessionID,
            type: "idle",
            seq: this.seq,
            data: { outcome, time: { created: Date.now() } },
        };
        const current = this.idle.get(sessionID) ?? [];
        current.push(row);
        this.idle.set(sessionID, current);
        return row;
    }

    append(
        sessionID: string,
        text: string,
        options: {
            modelID?: string;
            usage?: boolean;
            cache?: boolean;
            rawTokens?: boolean;
            error?: unknown;
            finish?: string;
            outcome?: "succeeded" | "failed" | "interrupted";
            omitFinish?: boolean;
        } = {},
    ): StoreRow<"assistant"> {
        const row: StoreRow<"assistant"> = {
            id: `message-${++this.seq}`,
            session_id: sessionID,
            type: "assistant",
            seq: this.seq,
            data: {
                content: [{ type: "text", text }],
                ...(options.omitFinish ? {} : { finish: options.finish ?? "stop" }),
                ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
                ...(options.error === undefined ? {} : { error: options.error }),
                model: { providerID: "mock", id: options.modelID ?? "cheap" },
                ...(options.usage === false
                    ? {}
                    : {
                          // Deliberately exercise corrupt and older rows with incomplete token data.
                          tokens: (options.rawTokens
                              ? { input: null, output: "not-a-number", reasoning: 3 }
                              : {
                                    input: 101,
                                    output: 11,
                                    reasoning: 3,
                                    ...(options.cache === false
                                        ? {}
                                        : { cache: { read: 7, write: 5 } }),
                                }) as StoreRow<"assistant">["data"]["tokens"],
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

/**
 * Waits for work the executor deliberately does not make its callers wait on: session removal is
 * queued so a hidden run never blocks on host cleanup.
 */
async function eventually(check: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for queued cleanup");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

async function setup(
    generation = "host-generation-1",
    capabilities: {
        remove?: boolean;
        modelCatalog?: () => Promise<unknown>;
        logs?: string[];
        /**
         * Which registration, if any, the fake host would report as its own. Undefined stands for
         * a host that registered no service at all (`--standalone`, or a plain `serve`).
         */
        owner?: unknown;
        keepSubagents?: boolean;
    } = {},
) {
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
    const removed: string[] = [];
    const removals: Array<{ sessionID: string; owner?: unknown; directory?: string }> = [];
    let nextID = 0;
    let failPrompt = false;
    let promptError: Error | undefined;
    let providerError: unknown;
    let providerErrorUnsettled = false;
    let terminalOutcome: "succeeded" | "failed" | "interrupted" | undefined;
    let terminalRowType: "assistant" | "idle" = "assistant";
    let readableSessionError: unknown;
    let eventSessionError: unknown;
    let removeError: Error | undefined;
    let delayRowMs = 0;
    let omitUsage = false;
    let omitCache = false;
    let rawTokens = false;
    let completion = "editor completion";
    let reasoningOnly = false;

    const host: HiddenChildHost = {
        async create(input) {
            creates.push(structuredClone(input));
            const id = `child-${++nextID}`;
            children.set(id, { model: structuredClone(input.model) });
            return { id };
        },
        async get() {
            return {
                model: { providerID: "mock", id: "user" },
                ...(readableSessionError === undefined ? {} : { error: readableSessionError }),
            };
        },
        async terminalError() {
            return eventSessionError;
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
            if (promptError) throw promptError;
            if (providerError !== undefined) {
                rows.append(input.sessionID, "", {
                    error: providerError,
                    usage: false,
                    ...(providerErrorUnsettled ? { omitFinish: true } : { finish: "error" }),
                });
                return;
            }
            if (terminalOutcome !== undefined) {
                if (terminalRowType === "idle") rows.appendIdle(input.sessionID, terminalOutcome);
                else
                    rows.append(input.sessionID, "", {
                        outcome: terminalOutcome,
                        usage: false,
                        omitFinish: true,
                    });
                return;
            }
            const write = () => {
                const row = rows.append(input.sessionID, completion, {
                    usage: !omitUsage,
                    cache: !omitCache,
                    rawTokens,
                    modelID: child.model.id,
                    ...(reasoningOnly ? { finish: "length" } : {}),
                });
                if (reasoningOnly)
                    row.data.content = [{ type: "reasoning", text: "private reasoning" }];
            };
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
        async removeSession(input) {
            if (removeError) throw removeError;
            removed.push(input.sessionID);
        },
    };
    const create = (hostGeneration = generation) =>
        createV2HiddenCompletionExecutor(host, {
            db,
            projectIdentity: "/project",
            directory: "/project",
            hook,
            openReader: () => rows,
            generation: hostGeneration,
            ...(capabilities.keepSubagents ? { keepSubagents: true } : {}),
            log: (message) => capabilities.logs?.push(message),
            ...(capabilities.modelCatalog ? { modelCatalog: capabilities.modelCatalog } : {}),
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
        removed,
        removals,
        setFailPrompt(value: boolean) {
            failPrompt = value;
        },
        setPromptError(value: Error | undefined) {
            promptError = value;
        },
        setProviderError(value: unknown) {
            providerError = value;
        },
        setProviderErrorUnsettled(value: boolean) {
            providerErrorUnsettled = value;
        },
        setTerminalOutcome(value: "succeeded" | "failed" | "interrupted" | undefined) {
            terminalOutcome = value;
        },
        setTerminalRowType(value: "assistant" | "idle") {
            terminalRowType = value;
        },
        setReadableSessionError(value: unknown) {
            readableSessionError = value;
        },
        setEventSessionError(value: unknown) {
            eventSessionError = value;
        },
        setRemoveError(value: Error | undefined) {
            removeError = value;
        },
        setDelayRow(value: number) {
            delayRowMs = value;
        },
        setOmitUsage(value: boolean) {
            omitUsage = value;
        },
        setOmitCache(value: boolean) {
            omitCache = value;
        },
        setRawTokens(value: boolean) {
            rawTokens = value;
        },
        setCompletion(value: string) {
            completion = value;
        },
        setReasoningOnly(value: boolean) {
            reasoningOnly = value;
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
    test.each([
        "historian",
        "dreamer-task",
    ] as const)("retains length-capped reasoning for %s", async (kind) => {
        const state = await setup();
        try {
            state.setReasoningOnly(true);
            const handle = await state.executor.open({
                ...run,
                kind,
                agent: kind === "historian" ? "historian" : "dreamer-classifier",
            });
            await state.executor.attempt(handle, request("cheap"));
            const completion = await state.executor.collect(handle, 50);
            expect(completion).toMatchObject({
                text: null,
                reasoning: "private reasoning",
                lengthCapped: true,
                tokenLog: { max_tokens: null, finish_reason: "length", reasoning: 3 },
            });
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });
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
                    parentID: "user-session",
                    metadata: { magic_context: "hidden-run", role: "historian" },
                    // The historian has no tools: the session rules deny everything,
                    // and the host evaluates them after the user's own rules.
                    permissions: [{ action: "*", resource: "*", effect: "deny" }],
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
            // This run configured no output cap, so the request carries only the
            // temperature the caller asked for — and none of the host defaults.
            expect(state.requests[0]?.options).toEqual({ temperature: 0.25 });
            expect(completion).toMatchObject({
                text: "editor completion",
                usage: { input: 101, output: 11, cacheRead: 7, cacheWrite: 5 },
                tokenLog: {
                    input: 101,
                    output: 11,
                    reasoning: 3,
                    cache_read: 7,
                    cache_write: 5,
                    max_tokens: null,
                },
                providerId: "mock",
                modelId: "cheap",
            });
            expect(state.updates).toEqual([]);
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });

    test("sends an output cap only when the run configured one", async () => {
        const state = await setup();
        try {
            const uncapped = await state.executor.open(run);
            await state.executor.attempt(uncapped, request());
            await close(state.executor, uncapped, true);

            const capped = await state.executor.open({ ...run, maxOutputTokens: 4096 });
            await state.executor.attempt(capped, request());
            await close(state.executor, capped, true);

            expect(state.requests.map((draft) => draft.options)).toEqual([
                {},
                { maxOutputTokens: 4096, maxTokens: 4096 },
            ]);
        } finally {
            state.db.close();
        }
    });

    test("creates a fresh successful child for each run without rewriting its title", async () => {
        const state = await setup();
        try {
            for (const text of ["first", "second"]) {
                state.setCompletion(text);
                const handle = await state.executor.open(run);
                await state.executor.attempt(handle, request());
                expect((await state.executor.collect(handle, 50)).text).toBe(text);
                await close(state.executor, handle, true);
            }
            expect(state.creates).toHaveLength(2);
            expect(state.requests).toHaveLength(2);
            expect(state.updates).toHaveLength(0);
        } finally {
            state.db.close();
        }
    });

    test("does not reuse a child after a settled provider error", async () => {
        const state = await setup();
        try {
            state.setProviderError({ message: "Go usage limit exceeded" });
            for (let i = 0; i < 5; i++) {
                const handle = await state.executor.open(run);
                expect(handle.id).toBe(`child-${i + 1}`);
                await expect(state.executor.attempt(handle, request("cheap"))).rejects.toThrow(
                    "Hidden completion provider error: ",
                );
                await close(state.executor, handle, false);
            }
            state.setProviderError(undefined);
            const recovered = await state.executor.open(run);
            expect(recovered.id).toBe("child-6");
            await state.executor.attempt(recovered, request());
            await close(state.executor, recovered, true);
            expect(state.creates).toHaveLength(6);
            expect(state.removed).toHaveLength(6);
        } finally {
            state.db.close();
        }
    });

    test("retires a child immediately after a settled provider failure", async () => {
        const state = await setup();
        try {
            state.setProviderError({ message: "Go usage limit exceeded" });
            const handle = await state.executor.open(run);
            await expect(state.executor.attempt(handle, request())).rejects.toThrow(
                "Hidden completion provider error: ",
            );
            await close(state.executor, handle, false);

            // After a provider failure the child is stopped and retired, so a pending host step
            // (such as a scheduled retry) cannot run on it after the run's marker is released.
            expect(state.interrupts).toEqual(["child-1"]);
            expect(state.removed).toEqual(["child-1"]);

            state.setProviderError(undefined);
            const recovered = await state.executor.open(run);
            expect(recovered.id).toBe("child-2");
            await state.executor.attempt(recovered, request());
            await close(state.executor, recovered, true);
        } finally {
            state.db.close();
        }
    });

    test("reopens a fresh child when a fallback retries a retired run", async () => {
        const state = await setup();
        try {
            state.setProviderError({ message: "Go usage limit exceeded" });
            const handle = await state.executor.open(run);
            await expect(state.executor.attempt(handle, request("cheap"))).rejects.toThrow(
                "Hidden completion provider error: ",
            );

            state.setProviderError(undefined);
            await state.executor.attempt(handle, request("fallback"));
            expect(handle.id).toBe("child-2");
            expect(state.creates[1]?.model).toEqual({ providerID: "mock", id: "fallback" });
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });

    test("interrupts and retires a failed child while its attempt marker is still registered", async () => {
        const state = await setup();
        try {
            const events: string[] = [];
            const release = state.hook.releaseAttempt.bind(state.hook);
            state.hook.releaseAttempt = (marker: string) => {
                events.push("release");
                release(marker);
            };
            const interrupt = state.host.interrupt.bind(state.host);
            state.host.interrupt = async (input) => {
                events.push(`interrupt ${input.sessionID}`);
                return interrupt(input);
            };
            state.setProviderError({ message: "Go usage limit exceeded" });
            const handle = await state.executor.open(run);
            await expect(state.executor.attempt(handle, request())).rejects.toThrow(
                "Hidden completion provider error: ",
            );
            // Until the marker is released the hook still recognises this run's prompt, so
            // stopping the child first leaves no window in which a host step on it is refused.
            expect(events).toEqual(["interrupt child-1", "release"]);
            await close(state.executor, handle, false);
        } finally {
            state.db.close();
        }
    });

    test("fails an outcome-only failed assistant in one poll with persisted host detail", async () => {
        const state = await setup();
        try {
            state.setTerminalOutcome("failed");
            state.setEventSessionError({
                type: "ProviderModelNotFoundError",
                message: "ollama-cloud/deepseek-v4.1-flash is unavailable",
            });
            const handle = await state.executor.open({ ...run, timeoutMs: 40 });
            const pollsBefore = state.rows.latestAssistantCalls;
            const failure = state.executor.attempt(handle, request());
            await expect(failure).rejects.toThrow("outcome=failed");
            await expect(failure).rejects.toThrow("ProviderModelNotFoundError");
            await expect(failure).rejects.toThrow(
                "ollama-cloud/deepseek-v4.1-flash is unavailable",
            );
            expect(state.rows.latestAssistantCalls - pollsBefore).toBe(1);
            await close(state.executor, handle, false);
        } finally {
            state.db.close();
        }
    });

    test("fails an outcome-only idle row in one poll", async () => {
        const state = await setup();
        try {
            state.setTerminalRowType("idle");
            state.setTerminalOutcome("failed");
            const handle = await state.executor.open({ ...run, timeoutMs: 40 });
            const pollsBefore = state.rows.latestIdleCalls;
            const failure = state.executor.attempt(handle, request());
            await expect(failure).rejects.toThrow("outcome=failed");
            await expect(failure).rejects.toThrow('"type":"idle"');
            expect(state.rows.latestIdleCalls - pollsBefore).toBe(1);
            await close(state.executor, handle, false);

            state.setTerminalOutcome(undefined);
            state.setTerminalRowType("assistant");
            const recovered = await state.executor.open(run);
            expect(recovered.id).toBe("child-2");
            await state.executor.attempt(recovered, request());
            await close(state.executor, recovered, true);
        } finally {
            state.db.close();
        }
    });

    test("treats every OpenCode 2.0.12 assistant outcome as terminal", async () => {
        const state = await setup();
        try {
            state.setTerminalOutcome("interrupted");
            const interrupted = await state.executor.open({ ...run, timeoutMs: 40 });
            await expect(state.executor.attempt(interrupted, request())).rejects.toThrow(
                "outcome=interrupted",
            );
            await close(state.executor, interrupted, false);

            state.setTerminalOutcome("succeeded");
            const succeeded = await state.executor.open({ ...run, timeoutMs: 40 });
            await state.executor.attempt(succeeded, request());
            expect((await state.executor.collect(succeeded, 50)).text).toBeNull();
            await close(state.executor, succeeded, true);
        } finally {
            state.db.close();
        }
    });

    test("retires a child whose newest assistant error row never settled", async () => {
        const state = await setup();
        try {
            // An error recorded on a row the host has not finished says a failure happened, not
            // that the message is over, so the child may still be mid-write and is not reusable.
            state.setProviderError({ message: "The usage limit has been reached" });
            state.setProviderErrorUnsettled(true);
            const handle = await state.executor.open(run);
            expect(handle.id).toBe("child-1");
            await expect(state.executor.attempt(handle, request())).rejects.toThrow();
            await close(state.executor, handle, false);

            state.setProviderError(undefined);
            state.setProviderErrorUnsettled(false);
            const next = await state.executor.open(run);
            expect(next.id).toBe("child-2");
            await state.executor.attempt(next, request());
            await close(state.executor, next, true);
            expect(state.removed).toEqual(["child-1", "child-2"]);
        } finally {
            state.db.close();
        }
    });

    test("retires the child when a dispatch failure only reads like a provider error", async () => {
        const state = await setup();
        try {
            // Whether the child survives is decided by the kind of failure, never by how the
            // failure happens to be worded.
            state.setPromptError(new Error("Hidden completion provider error: dispatch refused"));
            const handle = await state.executor.open(run);
            expect(handle.id).toBe("child-1");
            await expect(state.executor.attempt(handle, request())).rejects.toThrow();
            await close(state.executor, handle, false);

            state.setPromptError(undefined);
            const next = await state.executor.open(run);
            expect(next.id).toBe("child-2");
            await state.executor.attempt(next, request());
            await close(state.executor, next, true);
            expect(state.removed).toEqual(["child-1", "child-2"]);
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

    test("falls back to the local meter when token fields are non-numeric", async () => {
        const state = await setup();
        try {
            state.setRawTokens(true);
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

    test("preserves partial provider usage without dereferencing a missing cache", async () => {
        const state = await setup();
        try {
            state.setOmitCache(true);
            const handle = await state.executor.open(run);
            await state.executor.attempt(handle, request());
            const completion = await state.executor.collect(handle, 50);
            expect(completion.usage).toEqual({
                input: 101,
                output: 11,
                cacheRead: 0,
                cacheWrite: 0,
            });
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
        expect([...agents.keys()]).toEqual([
            HIDDEN_HISTORIAN_AGENT,
            HIDDEN_DREAMER_AGENT,
            HIDDEN_CURATE_AGENT,
            "dreamer-memory-mapper",
            "dreamer-primer-investigator",
            "dreamer-retrospective",
        ]);
        for (const [id, agent] of agents) {
            expect(agent.hidden).toBe(true);
            const tools: Record<string, string[]> = {
                [HIDDEN_CURATE_AGENT]: ["ctx_memory"],
                "dreamer-memory-mapper": ["read", "grep", "glob"],
                "dreamer-primer-investigator": ["read", "grep", "glob", "ctx_search"],
                "dreamer-retrospective": ["ctx_search"],
            };
            expect(agent.permissions).toEqual([
                { action: "*", resource: "*", effect: "deny" },
                ...(tools[id] ?? []).map((tool) => ({
                    action: tool,
                    resource: "*",
                    effect: "allow" as const,
                })),
            ]);
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

    test("drops and warns once for an undeclared hidden-run variant", async () => {
        const logs: string[] = [];
        const state = await setup("host-generation-1", {
            logs,
            modelCatalog: async () => [{ id: "cheap", providerID: "mock", variants: { high: {} } }],
        });
        const identity = { ...run, model: { model: "mock/cheap", qualifier: "medium" } };
        try {
            const handle = await state.executor.open(identity);
            expect(state.creates[0]?.model).toEqual({ providerID: "mock", id: "cheap" });
            await state.executor.attempt(handle, request("cheap"));
            await state.executor.attempt(handle, request("cheap"));
            expect(state.creates[0]?.model).toEqual({ providerID: "mock", id: "cheap" });
            expect(logs.filter((line) => line.includes("variant 'medium'")).length).toBe(1);
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });

    test("passes a declared hidden-run variant through unchanged", async () => {
        const state = await setup("host-generation-1", {
            modelCatalog: async () => [
                { id: "cheap", providerID: "mock", variants: { medium: {} } },
            ],
        });
        const identity = { ...run, model: { model: "mock/cheap", qualifier: "medium" } };
        try {
            const handle = await state.executor.open(identity);
            expect(state.creates[0]?.model).toEqual({
                providerID: "mock",
                id: "cheap",
                variant: "medium",
            });
            await close(state.executor, handle, true);
        } finally {
            state.db.close();
        }
    });
});

test("hidden tool-loop hard-stops at soft prompt budget when the host has no pre-tool hook", async () => {
    const fixture = await setup();
    fixture.setDelayRow(1200);
    const executor = fixture.executor;
    let finalized: boolean | undefined;
    const handle = await executor.open({
        ...dreamerRun,
        agent: HIDDEN_CURATE_AGENT,
        timeoutMs: 3000,
        metadata: {
            tokenBudget: 130,
            onBudgetUpdate: (state: { finalizeFired: boolean }) => {
                finalized = state.finalizeFired;
            },
        },
    });
    const attempt = executor.attempt(handle, request());
    await eventually(() => fixture.requests.length > 0);
    // The fixture's assistant reports 101 input, 7 cache read and 5 cache write tokens.
    fixture.rows.append(handle.id, "", { finish: "tool-calls" });
    await expect(attempt).rejects.toMatchObject({ name: "DreamTokenBudgetExceeded" });
    expect(fixture.interrupts).toContain(handle.id);
    expect(fixture.requests).toHaveLength(1);
    expect(finalized).toBe(false);
    await executor.close(handle, {
        promptSettled: false,
        privacySensitive: true,
        context: "test",
        log: () => {},
    });
});

describe("curate validation over the OpenCode 2 tool-loop transcript", () => {
    // These tool results use the shapes `v2/fold/restore.ts` builds when it restores a
    // child's transcript into provider messages, which is what toolLoopMessages reads.
    const call = (id: string, action: string) => ({
        role: "assistant",
        content: [{ type: "tool-call", id, name: "ctx_memory", input: { action, ids: [1] } }],
    });
    const transcript = (results: unknown[]) =>
        toolLoopMessages({ observedMessages: results } as never);

    test("counts an applied operation from a single text result", () => {
        const messages = transcript([
            call("c1", "archive"),
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: "c1",
                        result: { type: "text", value: "Archived memory [ID: 1]." },
                    },
                ],
            },
        ]);
        expect(inspectCurateMemoryOperations(messages)).toEqual({
            totalCalls: 1,
            completedActions: ["archive"],
        });
    });

    test("counts an applied operation from a multi-part content result", () => {
        const messages = transcript([
            call("c1", "merge"),
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: "c1",
                        result: {
                            type: "content",
                            value: [{ type: "text", text: "Merged memories [1, 2] into [3]." }],
                        },
                    },
                ],
            },
        ]);
        expect(inspectCurateMemoryOperations(messages).completedActions).toEqual(["merge"]);
    });

    test("never counts a failed call, even when its content reads like success", () => {
        const messages = transcript([
            call("c1", "archive"),
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: "c1",
                        resultType: "error",
                        result: {
                            error: "refused",
                            content: [{ type: "text", text: "Archived memory [ID: 1]." }],
                        },
                    },
                ],
            },
            call("c2", "update"),
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: "c2",
                        result: { type: "text", value: "Error: unsafe target" },
                    },
                ],
            },
        ]);
        expect(inspectCurateMemoryOperations(messages)).toEqual({
            totalCalls: 2,
            completedActions: [],
        });
        const [refused] = messages as { parts: { state: { status: string } }[] }[];
        expect(refused?.parts[0]?.state.status).toBe("error");
    });
});
