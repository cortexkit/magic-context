import { describe, expect, mock, test } from "bun:test";
import { refuseBudgetedToolCall } from "../features/magic-context/dreamer/token-budget";
import { createDroppedInputToolExecuteBeforeHook } from "../hooks/magic-context/dropped-input-guard";
import { promptSyncWithValidatedOutputRetry } from "./model-suggestion-retry";
import {
    createPromptAsyncTransport,
    promptAsyncAndWaitForIdle,
    recordPromptSessionError,
    supportsPromptAsync,
} from "./prompt-async-transport";

type Message = {
    info: {
        id: string;
        role: string;
        time: { created: number; completed?: number };
        finish?: string;
        error?: unknown;
    };
    parts: Array<{ type: string; text?: string; error?: unknown }>;
};

/**
 * A host double for one child session. `plan` describes what each status poll
 * after the prompt sees: a busy tick, or the moment the run settles with a
 * final assistant message.
 */
function asyncHost(options: {
    plan: Array<"busy" | "idle-pending" | "settle">;
    initialMessages?: Message[];
    answer?: string;
}) {
    const messages: Message[] = [...(options.initialMessages ?? [])];
    let polls = 0;
    let prompted = false;
    const promptAsync = mock(async (_request: unknown) => {
        prompted = true;
        messages.push({
            info: { id: `msg_user_${messages.length}`, role: "user", time: { created: 1 } },
            parts: [{ type: "text", text: "go" }],
        });
        return { data: undefined };
    });
    const prompt = mock(async () => ({}));
    const abort = mock(async () => ({ data: true }));
    const status = mock(async () => {
        if (!prompted) return { data: {} };
        const step = options.plan[Math.min(polls, options.plan.length - 1)];
        polls += 1;
        if (step === "busy") {
            // An intermediate tool-call step is already complete while the loop runs.
            messages.push({
                info: {
                    id: `msg_step_${messages.length}`,
                    role: "assistant",
                    time: { created: 2, completed: 3 },
                    finish: "tool-calls",
                },
                parts: [{ type: "tool" }],
            });
            return { data: { "ses-child": { type: "busy" } } };
        }
        if (step === "settle" && messages.at(-1)?.info.finish !== "stop") {
            messages.push({
                info: {
                    id: `msg_final_${messages.length}`,
                    role: "assistant",
                    time: { created: 4, completed: 5 },
                    finish: "stop",
                },
                parts: [{ type: "text", text: options.answer ?? "<done/>" }],
            });
        }
        return { data: {} };
    });
    const list = mock(async () => ({ data: [...messages] }));
    return {
        client: { session: { promptAsync, prompt, abort, status, messages: list } } as never,
        promptAsync,
        prompt,
        abort,
        status,
        list,
        polls: () => polls,
    };
}

function request(signal?: AbortSignal) {
    return {
        path: { id: "ses-child" },
        query: { directory: "/repo" },
        body: { parts: [{ type: "text", text: "go" }] },
        ...(signal ? { signal } : {}),
    };
}

describe("supportsPromptAsync", () => {
    test("requires both prompt_async and session status", () => {
        expect(supportsPromptAsync(asyncHost({ plan: ["settle"] }).client)).toBe(true);
        expect(supportsPromptAsync({ session: { prompt: async () => ({}) } } as never)).toBe(false);
        expect(supportsPromptAsync(undefined)).toBe(false);
        expect(createPromptAsyncTransport({ session: {} } as never, "ses-child")).toBeUndefined();
    });
});

describe("promptAsyncAndWaitForIdle", () => {
    test("returns only after the child is idle with a settled final assistant message", async () => {
        const host = asyncHost({ plan: ["busy", "busy", "busy", "settle"] });

        await promptAsyncAndWaitForIdle(host.client, request(), { pollIntervalMs: 1 });

        expect(host.promptAsync).toHaveBeenCalledTimes(1);
        expect(host.prompt).not.toHaveBeenCalled();
        // Completed tool-call steps during busy polls must not end the wait early.
        expect(host.polls()).toBe(4);
        expect(host.promptAsync.mock.calls[0]?.[0]).toMatchObject({
            path: { id: "ses-child" },
            query: { directory: "/repo" },
        });
    });

    test("keeps waiting through an idle gap before the run starts", async () => {
        const host = asyncHost({ plan: ["idle-pending", "idle-pending", "busy", "settle"] });

        await promptAsyncAndWaitForIdle(host.client, request(), {
            pollIntervalMs: 1,
            startGraceMs: 60_000,
        });

        expect(host.polls()).toBe(4);
    });

    test("ignores an assistant answer left by an earlier attempt in the same child", async () => {
        const earlier: Message = {
            info: {
                id: "msg_old",
                role: "assistant",
                time: { created: 0, completed: 0 },
                finish: "stop",
            },
            parts: [{ type: "text", text: "stale" }],
        };
        const host = asyncHost({
            plan: ["idle-pending", "busy", "settle"],
            initialMessages: [earlier],
        });

        await promptAsyncAndWaitForIdle(host.client, request(), {
            pollIntervalMs: 1,
            startGraceMs: 60_000,
        });

        expect(host.polls()).toBe(3);
    });

    test("fails when no run starts within the start grace", async () => {
        const host = asyncHost({ plan: ["idle-pending"] });
        host.promptAsync.mockImplementation(async () => ({ data: undefined }));

        await expect(
            promptAsyncAndWaitForIdle(host.client, request(), {
                pollIntervalMs: 1,
                startGraceMs: 20,
            }),
        ).rejects.toThrow("did not start a run");
    });

    test("ignores provider errors and retry parts from before the current send", async () => {
        const host = asyncHost({
            plan: ["busy", "settle"],
            initialMessages: [
                {
                    info: {
                        id: "old-error",
                        role: "assistant",
                        time: { created: 0 },
                        error: { name: "APIError" },
                    },
                    parts: [{ type: "retry", error: { name: "APIError" } }],
                },
            ],
        });
        await promptAsyncAndWaitForIdle(host.client, request(), { pollIntervalMs: 1 });
        expect(host.polls()).toBe(2);
        expect(host.abort).not.toHaveBeenCalled();
    });

    test("accepts a successfully settled assistant that retains an earlier retry part", async () => {
        const host = asyncHost({ plan: ["settle"] });
        const read = host.list.getMockImplementation()!;
        host.list.mockImplementation(async () => {
            const result = await read();
            const last = result.data.at(-1);
            if (last?.info.finish === "stop") {
                last.parts.push({ type: "retry", error: { name: "APIError" } });
            }
            return result;
        });
        await promptAsyncAndWaitForIdle(host.client, request(), { pollIntervalMs: 1 });
        expect(host.polls()).toBe(1);
        expect(host.abort).not.toHaveBeenCalled();
    });

    test("surfaces a rejected prompt_async request", async () => {
        const host = asyncHost({ plan: ["settle"] });
        host.promptAsync.mockImplementation(async () => ({
            data: undefined,
            error: { name: "BadRequest", data: { message: "unknown agent" } },
        }));

        await expect(
            promptAsyncAndWaitForIdle(host.client, request(), { pollIntervalMs: 1 }),
        ).rejects.toThrow("prompt_async was rejected");
    });

    test("stops waiting as soon as the caller's signal aborts", async () => {
        const host = asyncHost({ plan: ["busy"] });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);

        await expect(
            promptAsyncAndWaitForIdle(host.client, request(controller.signal), {
                pollIntervalMs: 5,
            }),
        ).rejects.toBeDefined();
    });
});

describe("dreamer budget on an async child", () => {
    test("forwards Pi's finalized per-child budget before manifest application", async () => {
        let ready = false;
        const states: unknown[] = [];
        const client = {
            session: {
                prompt: async () => {
                    ready = true;
                },
            },
            readChildTokenBudget: (id: string) => {
                expect(id).toBe("ses-child");
                if (!ready) return undefined;
                return { spent: 58, finalizeFired: true };
            },
        };
        const transport = createPromptAsyncTransport(client as never, "ses-child", {
            onBudgetUpdate: (state) => states.push(state),
        });
        expect(transport).toBeDefined();
        await transport?.(request());
        expect(states).toEqual([{ spent: 58, finalizeFired: true, sessionId: "ses-child" }]);
    });
    test("finalizes a zero-usage OpenCode mapper at 58 steps, before the hard ceiling", async () => {
        const messages: unknown[] = [];
        let sends = 0;
        let aborted = false;
        const states: unknown[] = [];
        const client = {
            session: {
                messages: async () => ({ data: [...messages] }),
                promptAsync: async (req: { body: { parts: unknown[] } }) => {
                    sends++;
                    if (sends === 2)
                        expect(JSON.stringify(req.body.parts)).toContain("no more tool calls");
                    messages.push({
                        info: { id: `u${sends}`, role: "user" },
                        parts: req.body.parts,
                    });
                },
                abort: async () => {
                    aborted = true;
                },
                status: async () => {
                    if (sends === 1 && messages.length === 1) {
                        for (let step = 1; step <= 58; step++)
                            messages.push({
                                info: {
                                    id: `a${step}`,
                                    role: "assistant",
                                    finish: "tool-calls",
                                    tokens: { input: 0 },
                                    time: { completed: 1 },
                                },
                                parts: [{ type: "tool" }],
                            });
                    }
                    if (sends === 2 && messages.length === 60)
                        messages.push({
                            info: {
                                id: "final",
                                role: "assistant",
                                finish: "stop",
                                tokens: { input: 1 },
                                time: { completed: 2 },
                            },
                            parts: [{ type: "text", text: "<verify/>" }],
                        });
                    return {
                        data: sends === 1 && !aborted ? { "ses-child": { type: "busy" } } : {},
                    };
                },
            },
        };
        await promptAsyncAndWaitForIdle(
            client as never,
            {
                ...request(),
                signal: AbortSignal.timeout(200),
                body: { ...request().body, agent: "dreamer-memory-mapper" },
            },
            {
                tokenBudget: 3_000_000,
                pollIntervalMs: 1,
                startGraceMs: 100,
                onBudgetUpdate: (state) => states.push(state),
            },
        );
        expect(sends).toBe(2);
        expect(states).toContainEqual(expect.objectContaining({ finalizeFired: true, spent: 0 }));
    });
    test("sums prompt usage across validation retries in the same child", async () => {
        const messages: unknown[] = [];
        const states: Array<{ spent: number }> = [];
        let sends = 0;
        let aborted = false;
        const client = {
            session: {
                messages: async () => ({ data: [...messages] }),
                promptAsync: async (req: { body: { parts: unknown[] } }) => {
                    sends++;
                    messages.push({
                        info: { id: `user-${sends}`, role: "user" },
                        parts: req.body.parts,
                    });
                    return { data: undefined };
                },
                abort: async () => {
                    aborted = true;
                    return { data: true };
                },
                status: async () => {
                    const latest = messages.at(-1) as { info?: { id?: string } } | undefined;
                    if (sends === 1 && latest?.info?.id === "user-1")
                        messages.push({
                            info: {
                                id: "a1",
                                role: "assistant",
                                finish: "stop",
                                tokens: { input: 60 },
                                time: { created: 1, completed: 2 },
                            },
                            parts: [{ type: "text", text: "invalid manifest" }],
                        });
                    if (sends === 2 && latest?.info?.id === "user-2")
                        messages.push({
                            info: {
                                id: "a2",
                                role: "assistant",
                                finish: "tool-calls",
                                tokens: { input: 25 },
                                time: { created: 3, completed: 4 },
                            },
                            parts: [{ type: "tool" }],
                        });
                    if (sends === 3 && latest?.info?.id === "user-3")
                        messages.push({
                            info: {
                                id: "a3",
                                role: "assistant",
                                finish: "stop",
                                tokens: { input: 1 },
                                time: { created: 5, completed: 6 },
                            },
                            parts: [{ type: "text", text: "<mappings/>" }],
                        });
                    return {
                        data: sends === 2 && !aborted ? { "ses-child": { type: "busy" } } : {},
                    };
                },
            },
        } as never;
        const transport = createPromptAsyncTransport(client, "ses-child", {
            pollIntervalMs: 1,
            tokenBudget: 100,
            onBudgetUpdate: (state) => states.push(state),
        });
        if (!transport) throw new Error("missing async transport");
        await transport(request());
        await transport(request());
        expect(sends).toBe(3);
        expect(states.at(-1)?.spent).toBe(86);
    });
    test("does not send a finalize turn when the child finishes below budget", async () => {
        const host = asyncHost({ plan: ["busy", "settle"] });
        const originalMessages = host.client.session.messages;
        host.client.session.messages = mock(
            async (...args: Parameters<typeof originalMessages>) => {
                const response = await originalMessages(...args);
                for (const message of response.data) {
                    if (message.info.role === "assistant") message.info.tokens = { input: 39 };
                }
                return response;
            },
        );
        await promptAsyncAndWaitForIdle(host.client as never, request(), {
            pollIntervalMs: 1,
            tokenBudget: 100,
        });
        expect(host.promptAsync).toHaveBeenCalledTimes(1);
        expect(host.abort).not.toHaveBeenCalled();
    });
    test("keeps a completed answer when a poll receives over-budget tool usage and completion together", async () => {
        const host = asyncHost({ plan: ["settle"] });
        const originalMessages = host.client.session.messages;
        host.client.session.messages = mock(
            async (...args: Parameters<typeof originalMessages>) => {
                const response = await originalMessages(...args);
                if (response.data.some((message) => message.info.role === "assistant")) {
                    response.data.unshift({
                        info: {
                            id: "coarse-tool",
                            role: "assistant",
                            finish: "tool-calls",
                            tokens: { input: 120 },
                            time: { created: 1, completed: 2 },
                        },
                        parts: [],
                    } as never);
                }
                return response;
            },
        );
        await promptAsyncAndWaitForIdle(host.client as never, request(), {
            pollIntervalMs: 1,
            tokenBudget: 100,
        });
        expect(host.promptAsync).toHaveBeenCalledTimes(1);
        expect(host.abort).not.toHaveBeenCalled();
    });

    for (const finalUsage of [1, 25]) {
        test(`returns the final manifest after a soft nudge with ${finalUsage} final tokens`, async () => {
            const host = asyncHost({ plan: ["busy", "settle"] });
            const messages: Array<{
                info: {
                    id: string;
                    role: string;
                    tokens?: unknown;
                    time?: { completed: number };
                    finish?: string;
                };
                parts: unknown[];
            }> = [];
            let sends = 0;
            const client = {
                session: {
                    messages: async () => ({ data: [...messages] }),
                    promptAsync: mock(async (_req: unknown) => {
                        sends++;
                        messages.push({ info: { id: `u${sends}`, role: "user" }, parts: [] });
                        return { data: undefined };
                    }),
                    abort: async () => {
                        recordPromptSessionError("ses-child", {
                            name: "MessageAbortedError",
                            data: { message: "Aborted" },
                        });
                        return host.abort();
                    },
                    status: async () => {
                        if (sends === 1 && !messages.some((m) => m.info.id === "a1")) {
                            messages.push({
                                info: {
                                    id: "a1",
                                    role: "assistant",
                                    tokens: { input: 81 },
                                    time: { completed: 1 },
                                    finish: "tool-calls",
                                },
                                parts: [],
                            });
                        }
                        if (sends === 2 && !messages.some((m) => m.info.id === "a2")) {
                            if (finalUsage === 25) {
                                refuseBudgetedToolCall("ses-child");
                                refuseBudgetedToolCall("ses-child");
                            }
                            messages.push({
                                info: {
                                    id: "a2",
                                    role: "assistant",
                                    tokens: { input: finalUsage },
                                    time: { completed: 2 },
                                    finish: "stop",
                                },
                                parts: [{ type: "text", text: "<mappings/>" }],
                            });
                        }
                        return {
                            data:
                                sends === 1 && host.abort.mock.calls.length === 0
                                    ? { "ses-child": { type: "busy" } }
                                    : {},
                        };
                    },
                },
            } as never;
            const body = {
                ...request(),
                body: {
                    agent: "dreamer-memory-mapper",
                    system: "same system",
                    parts: [{ type: "text", text: "work" }],
                },
            };
            await promptAsyncAndWaitForIdle(client, body, { pollIntervalMs: 1, tokenBudget: 100 });
            const prompts = (client as { session: { promptAsync: ReturnType<typeof mock> } })
                .session.promptAsync.mock.calls;
            expect(prompts).toHaveLength(2);
            expect((prompts[1]?.[0] as typeof body).body.agent).toBe(
                (prompts[0]?.[0] as typeof body).body.agent,
            );
            expect(messages.at(-1)?.parts).toEqual([{ type: "text", text: "<mappings/>" }]);
            expect(host.abort).toHaveBeenCalledTimes(1);
        });
    }
    test("finalizes once, refuses two tool calls, and keeps agent and tools unchanged", async () => {
        const messages: Array<{
            info: {
                id: string;
                role: string;
                tokens?: unknown;
                time?: { completed: number };
                finish?: string;
            };
            parts: unknown[];
        }> = [];
        const toolsByAgent: Record<string, unknown[]> = {
            "dreamer-memory-mapper": [{ name: "read", parameters: { type: "object" } }],
        };
        const capturedTools: string[] = [];
        const prompts: unknown[] = [];
        let stage = 0;
        const client = {
            session: {
                messages: async () => ({ data: [...messages] }),
                promptAsync: async (req: unknown) => {
                    prompts.push(req);
                    const agent = (req as { body: { agent: string } }).body.agent;
                    capturedTools.push(JSON.stringify(toolsByAgent[agent] ?? []));
                    if (prompts.length === 1)
                        messages.push({ info: { id: "u1", role: "user" }, parts: [] });
                    else messages.push({ info: { id: "u2", role: "user" }, parts: [] });
                    return { data: undefined };
                },
                abort: mock(async () => ({ data: true })),
                status: async () => {
                    stage++;
                    if (stage === 1)
                        messages.push({
                            info: {
                                id: "a1",
                                role: "assistant",
                                tokens: { input: 10, cache: { read: 71, write: 0 } },
                                time: { completed: 1 },
                                finish: "tool-calls",
                            },
                            parts: [],
                        });
                    if (prompts.length === 2 && !messages.some((m) => m.info.id === "a2"))
                        messages.push({
                            info: {
                                id: "a2",
                                role: "assistant",
                                tokens: { input: 1, cache: { read: 1, write: 0 } },
                                time: { completed: 2 },
                                finish: "tool-calls",
                            },
                            parts: [{ type: "text", text: "<manifest/>" }],
                        });
                    return { data: stage === 1 ? { "ses-child": { type: "busy" } } : {} };
                },
            },
        } as never;
        const run = promptAsyncAndWaitForIdle(
            client,
            {
                ...request(),
                body: { agent: "dreamer-memory-mapper", parts: [{ type: "text", text: "go" }] },
            },
            { pollIntervalMs: 1, tokenBudget: 100 },
        );
        // Wait for the follow-up to be enqueued before simulating the tool hook.
        while (prompts.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
        const before = createDroppedInputToolExecuteBeforeHook();
        await expect(
            before({ sessionID: "ses-child", tool: "read" }, { args: { path: "a" } }),
        ).rejects.toThrow("Out of token budget");
        await expect(
            before({ sessionID: "ses-child", tool: "read" }, { args: { path: "b" } }),
        ).rejects.toThrow("Out of token budget");
        await expect(run).rejects.toThrow("token_budget");
        expect(prompts).toHaveLength(2);
        expect(capturedTools[0]).not.toBe("[]");
        expect(capturedTools[1]).toBe(capturedTools[0]);
        expect(
            (prompts[1] as { body: { parts: Array<{ text: string }> } }).body.parts[0]?.text,
        ).toContain("no more tool calls");
        expect(refuseBudgetedToolCall("ses-child")).toBeNull();
    });
});

describe("prompt_async transport under the retry chain", () => {
    test("our slice stays the only timer and aborts the busy child when it expires", async () => {
        const host = asyncHost({ plan: ["busy"] });
        const transport = createPromptAsyncTransport(host.client, "ses-child", {
            pollIntervalMs: 5,
        });
        expect(transport).toBeDefined();

        let caught: unknown;
        try {
            await promptSyncWithValidatedOutputRetry(host.client, request(), {
                transport,
                timeoutMs: 60,
                fallbackModels: ["anthropic/claude-sonnet-4-6"],
                fetchOutput: async () => "unused",
                validateOutput: (output: string) => output,
            });
        } catch (error) {
            caught = error;
        }

        expect((caught as Error).message).toBe("prompt timed out after 60ms");
        expect(host.promptAsync).toHaveBeenCalledTimes(1);
        expect(host.prompt).not.toHaveBeenCalled();
        expect(host.abort).toHaveBeenCalledWith({ path: { id: "ses-child" } });
    });
});

test("an idle accepted user row is not a no-output completion after 30 seconds", async () => {
    const host = asyncHost({ plan: ["idle-pending"] });
    await expect(
        promptAsyncAndWaitForIdle(host.client, request(), {
            pollIntervalMs: 1,
            startGraceMs: 20,
        }),
    ).rejects.toThrow("settled assistant");
});

test("an early child session error preserves DeepSeek's unsupported-model 400 without waiting for an assistant", async () => {
    const host = asyncHost({ plan: ["idle-pending"] });
    const message =
        "The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4-flash";
    host.promptAsync.mockImplementation(async () => {
        recordPromptSessionError("ses-child", {
            name: "APIError",
            data: { statusCode: 400, message },
        });
        recordPromptSessionError("ses-child", {
            name: "UnknownError",
            data: { message: "duplicate stack" },
        });
        return { data: undefined };
    });
    await expect(
        promptAsyncAndWaitForIdle(host.client, request(), {
            pollIntervalMs: 1,
            startGraceMs: 60000,
        }),
    ).rejects.toThrow(`${message} (status=400)`);
    expect(host.polls()).toBe(0);
});

test("session errors belonging to another child do not fail the run", async () => {
    const host = asyncHost({ plan: ["settle"] });
    const send = host.promptAsync.getMockImplementation()!;
    host.promptAsync.mockImplementation(async (req) => {
        recordPromptSessionError("other-child", "unrelated");
        return send(req);
    });
    await promptAsyncAndWaitForIdle(host.client, request(), { pollIntervalMs: 1 });
    expect(host.polls()).toBe(1);
});

describe("prompt_async transport and the first-output deadline", () => {
    /**
     * A child session where each model answers its own way. "dead" leaves the
     * empty assistant row the host writes before the provider responds and stays
     * busy forever; "partial" streams a text part and then stays busy; "answer"
     * settles with a final assistant message on the next poll.
     */
    function modelHost(
        behaviours: Record<string, "dead" | "partial" | "answer" | "error" | "retry">,
    ) {
        const messages: Message[] = [];
        let current: "dead" | "partial" | "answer" | "error" | "retry" | null = null;
        const sent: string[] = [];
        const promptAsync = mock(
            async (request: { body: { model?: { providerID: string; modelID: string } } }) => {
                const model = request.body.model
                    ? `${request.body.model.providerID}/${request.body.model.modelID}`
                    : "primary";
                sent.push(model);
                current = behaviours[model] ?? "answer";
                messages.push({
                    info: { id: `msg_user_${messages.length}`, role: "user", time: { created: 1 } },
                    parts: [{ type: "text", text: "go" }],
                });
                messages.push({
                    info: {
                        id: `msg_assistant_${messages.length}`,
                        role: "assistant",
                        time: { created: 2 },
                    },
                    parts: current === "partial" ? [{ type: "text", text: "<classify>" }] : [],
                });
                return { data: undefined };
            },
        );
        const abort = mock(async () => {
            current = null;
            return { data: true };
        });
        const status = mock(async () => {
            if (current === "error" || current === "retry") {
                const last = messages.at(-1)!;
                const error = {
                    name: "APIError",
                    data: { statusCode: 429, message: "Free usage limit reached" },
                };
                if (current === "error") last.info.error = error;
                else last.parts = [{ type: "retry", error }];
                return { data: { "ses-child": { type: current === "retry" ? "retry" : "busy" } } };
            }
            if (current === "dead" || current === "partial")
                return { data: { "ses-child": { type: "busy" } } };
            if (current === "answer") {
                const last = messages.at(-1);
                if (last && !last.info.time.completed) {
                    last.info.time.completed = 3;
                    last.info.finish = "stop";
                    last.parts = [{ type: "text", text: "<classify></classify>" }];
                }
            }
            return { data: {} };
        });
        const list = mock(async () => ({ data: messages.map((message) => ({ ...message })) }));
        return {
            client: { session: { promptAsync, abort, status, messages: list } } as never,
            sent,
            abort,
        };
    }

    async function runChain(
        host: ReturnType<typeof modelHost>,
        timeoutMs: number,
        firstOutputTimeoutMs: number,
    ) {
        const transport = createPromptAsyncTransport(host.client, "ses-child", {
            pollIntervalMs: 5,
        });
        return promptSyncWithValidatedOutputRetry(
            host.client,
            {
                ...request(),
                body: {
                    model: { providerID: "opencode", modelID: "free-model" },
                    parts: [{ type: "text", text: "go" }],
                },
            },
            {
                transport,
                timeoutMs,
                firstOutputTimeoutMs,
                fallbackModels: ["anthropic/claude-sonnet-5-5"],
                fetchOutput: async () => "<classify></classify>",
                validateOutput: (output: string) => output,
            },
        );
    }

    test("a model that never answers is cut at the deadline and the fallback completes", async () => {
        const host = modelHost({ "opencode/free-model": "dead" });
        const startedAt = Date.now();

        const run = await runChain(host, 5_000, 60);

        expect(run.attempt.label).toBe("anthropic/claude-sonnet-5-5");
        expect(host.sent).toEqual(["opencode/free-model", "anthropic/claude-sonnet-5-5"]);
        // The dead model's run is stopped on the host before the fallback is sent.
        expect(host.abort).toHaveBeenCalledWith({ path: { id: "ses-child" } });
        expect(Date.now() - startedAt).toBeLessThan(2_000);
    });

    test("a model that streamed part of an answer keeps its timeout and does not fall back", async () => {
        const host = modelHost({ "opencode/free-model": "partial" });

        await expect(runChain(host, 200, 40)).rejects.toThrow("prompt timed out after 200ms");
        expect(host.sent).toEqual(["opencode/free-model"]);
    });

    for (const failure of ["error", "retry"] as const) {
        test(`a recorded provider ${failure} stops the host retry loop and immediately tries the fallback`, async () => {
            const host = modelHost({ "opencode/free-model": failure });
            const startedAt = Date.now();
            const result = await runChain(host, 5_000, 5_000);
            expect(result.attempt.label).toBe("anthropic/claude-sonnet-5-5");
            expect(host.sent).toEqual(["opencode/free-model", "anthropic/claude-sonnet-5-5"]);
            expect(host.abort).toHaveBeenCalledTimes(1);
            expect(host.abort).toHaveBeenCalledWith({ path: { id: "ses-child" } });
            expect(Date.now() - startedAt).toBeLessThan(2_000);
        });
    }
});
