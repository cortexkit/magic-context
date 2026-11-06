/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test";
import {
    buildHiddenAgentConfig,
    buildHiddenAgentRegistrations,
    buildZenReadAgentRegistrations,
} from "../../agents/hidden-agent-registrations";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { shapeV1HiddenMessage } from "../../shared/hidden-zen-read";
import {
    type PromptArgs,
    promptSyncWithModelSuggestionRetry,
    promptSyncWithValidatedOutputRetry,
} from "../../shared/model-suggestion-retry";
import { recordPromptSessionError } from "../../shared/prompt-async-transport";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createV1HiddenCompletionExecutor } from "./compartment-runner-historian";
import type { HiddenRunIdentity } from "./compartment-runner-types";
import { createDroppedInputToolExecuteBeforeHook } from "./dropped-input-guard";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

/** A host whose child finishes on the first status poll after a prompt_async send. */
function host() {
    const messages: unknown[] = [];
    const promptAsync = mock(async () => {
        messages.push(
            { info: { id: "msg_user", role: "user", time: { created: 1 } }, parts: [] },
            {
                info: {
                    id: "msg_final",
                    role: "assistant",
                    time: { created: 2, completed: 3 },
                    finish: "stop",
                },
                parts: [{ type: "text", text: "<classify/>" }],
            },
        );
        return { data: undefined };
    });
    const prompt = mock(async () => ({}));
    const status = mock(async () => ({ data: {} }));
    return {
        client: {
            session: {
                create: async () => ({ data: { id: "ses-child" } }),
                promptAsync,
                prompt,
                status,
                messages: async () => ({ data: [...messages] }),
                delete: async () => ({}),
            },
        } as never,
        promptAsync,
        prompt,
        status,
        messages,
    };
}

function run(kind: HiddenRunIdentity["kind"]): HiddenRunIdentity {
    return {
        agent: "dreamer-classifier",
        kind,
        system: "system",
        timeoutMs: 60_000,
        title: "child",
        directory: "/repo",
    };
}

const request = {
    path: { id: "ses-child" },
    query: { directory: "/repo" },
    body: { parts: [{ type: "text", text: "go" }] },
};

describe("OpenCode 1 hidden executor transport", () => {
    test("a dreamer task child sends with prompt_async instead of a held request", async () => {
        const db = freshDb();
        try {
            const h = host();
            const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
            const handle = await executor.open(run("dreamer-task"));

            await executor.attempt(handle, request);

            expect(h.promptAsync).toHaveBeenCalledTimes(1);
            expect(h.prompt).not.toHaveBeenCalled();
        } finally {
            closeQuietly(db);
        }
    });

    test("a historian child sends with prompt_async instead of a held request", async () => {
        const db = freshDb();
        try {
            const h = host();
            const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
            const handle = await executor.open(run("historian"));

            await executor.attempt(handle, request);

            expect(h.promptAsync).toHaveBeenCalledTimes(1);
            expect(h.prompt).not.toHaveBeenCalled();
        } finally {
            closeQuietly(db);
        }
    });

    test("a dreamer fallback reuses the child without inheriting the failed model's error", async () => {
        const db = freshDb();
        try {
            const h = host();
            const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
            const handle = await executor.open(run("dreamer-task"));
            const attempted: string[] = [];
            h.promptAsync.mockImplementation(async (...args: unknown[]) => {
                const model = (args[0] as PromptArgs).body.model!;
                attempted.push(`${model.providerID}/${model.modelID}`);
                const primary = model.modelID === "free-model";
                h.status.mockImplementation(async () => ({
                    data: primary ? { "ses-child": { type: "retry" } } : {},
                }));
                h.messages.push({
                    info: {
                        id: `msg-${attempted.length}`,
                        role: "assistant",
                        time: { created: attempted.length, ...(primary ? {} : { completed: 3 }) },
                        ...(primary
                            ? {
                                  error: {
                                      name: "APIError",
                                      data: {
                                          statusCode: 429,
                                          message: "Free usage limit reached",
                                      },
                                  },
                              }
                            : { finish: "stop" }),
                    },
                    parts: primary ? [] : [{ type: "text", text: "<classify/>" }],
                });
                return { data: undefined };
            });
            const result = await promptSyncWithValidatedOutputRetry(
                h.client,
                {
                    ...request,
                    body: {
                        ...request.body,
                        model: { providerID: "opencode", modelID: "free-model" },
                    },
                },
                {
                    transport: Object.assign((args: PromptArgs) => executor.attempt(handle, args), {
                        childSessionId: handle.childSessionId,
                    }),
                    timeoutMs: 10_000,
                    fallbackModels: ["provider/fallback"],
                    fetchOutput: () => executor.collect(handle, 50),
                    validateOutput: (completion) => {
                        if (!completion.text) throw new Error("empty output");
                        return completion.text;
                    },
                },
            );
            expect(result.validated).toBe("<classify/>");
            expect(attempted).toEqual(["opencode/free-model", "provider/fallback"]);
        } finally {
            closeQuietly(db);
        }
    });
});

/**
 * A host whose held requests die on a short request timer, standing in for the
 * Bun fetch timer (300-360 s) that some OpenCode 1 builds leave on the plugin's
 * client. The child's run takes `runMs`; `Infinity` never finishes.
 */
function slowHost(options: { runMs: number; hostRequestTimerMs: number }) {
    const messages: unknown[] = [];
    let running = false;
    let finish: ReturnType<typeof setTimeout> | undefined;
    const startRun = () => {
        running = true;
        messages.push({ info: { id: "msg_user", role: "user", time: { created: 1 } }, parts: [] });
        if (Number.isFinite(options.runMs)) {
            finish = setTimeout(() => {
                running = false;
                messages.push({
                    info: {
                        id: "msg_final",
                        role: "assistant",
                        time: { created: 2, completed: 3 },
                        finish: "stop",
                    },
                    parts: [{ type: "text", text: "<output/>" }],
                });
            }, options.runMs);
        }
    };
    const prompt = mock(async () => {
        startRun();
        await Bun.sleep(options.hostRequestTimerMs);
        if (running) throw new DOMException("The operation timed out.", "TimeoutError");
        return {};
    });
    const promptAsync = mock(async () => {
        startRun();
        return { data: undefined };
    });
    const abort = mock(async () => {
        running = false;
        clearTimeout(finish);
        return { data: true };
    });
    return {
        client: {
            session: {
                create: async () => ({ data: { id: "ses-child" } }),
                prompt,
                promptAsync,
                abort,
                status: async () => ({
                    data: running ? { "ses-child": { type: "busy" } } : {},
                }),
                messages: async () => ({ data: [...messages] }),
                delete: async () => ({}),
            },
        } as never,
        prompt,
        promptAsync,
        abort,
        stop: () => clearTimeout(finish),
    };
}

describe("OpenCode 1 historian under a host request timer", () => {
    test("a run that outlasts the host's request timer still completes within the historian timeout", async () => {
        const db = freshDb();
        const h = slowHost({ runMs: 1_500, hostRequestTimerMs: 100 });
        try {
            const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
            const handle = await executor.open(run("historian"));
            // The same wiring runHistorianPrompt uses: the retry chain owns the
            // configured timeout and sends through the executor.
            await promptSyncWithModelSuggestionRetry(h.client, request, {
                transport: Object.assign((args: PromptArgs) => executor.attempt(handle, args), {
                    childSessionId: handle.childSessionId,
                }),
                timeoutMs: 10_000,
                callContext: "historian",
            });
            const completion = await executor.collect(handle, 50);

            expect(completion.text).toBe("<output/>");
            expect(h.abort).not.toHaveBeenCalled();
        } finally {
            h.stop();
            closeQuietly(db);
        }
    });

    test("a run that outlasts the configured historian timeout is aborted", async () => {
        const db = freshDb();
        const h = slowHost({ runMs: Number.POSITIVE_INFINITY, hostRequestTimerMs: 60_000 });
        try {
            const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
            const handle = await executor.open(run("historian"));
            const startedAt = Date.now();

            await expect(
                promptSyncWithModelSuggestionRetry(h.client, request, {
                    transport: Object.assign((args: PromptArgs) => executor.attempt(handle, args), {
                        childSessionId: handle.childSessionId,
                    }),
                    timeoutMs: 400,
                    callContext: "historian",
                }),
            ).rejects.toThrow("prompt timed out after 400ms");

            expect(Date.now() - startedAt).toBeLessThan(5_000);
            expect(h.abort).toHaveBeenCalledWith({ path: { id: "ses-child" } });
        } finally {
            h.stop();
            closeQuietly(db);
        }
    });

    test("a provider error the host records ends a historian attempt without throwing", async () => {
        const db = freshDb();
        const h = slowHost({ runMs: Number.POSITIVE_INFINITY, hostRequestTimerMs: 60_000 });
        try {
            const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
            const handle = await executor.open(run("historian"));
            h.promptAsync.mockImplementationOnce(async () => {
                setTimeout(() => {
                    recordPromptSessionError("ses-child", {
                        name: "APIError",
                        data: { message: "overloaded" },
                    });
                }, 50);
                return { data: undefined };
            });

            // Resolves like the synchronous prompt did, so the historian's retry
            // loop does not send the prompt into this child a second time.
            await executor.attempt(handle, request);
            expect(h.promptAsync).toHaveBeenCalledTimes(1);
            await expect(executor.collect(handle, 50)).rejects.toThrow("overloaded");
        } finally {
            h.stop();
            closeQuietly(db);
        }
    });
});

const toolFreeAgents = [
    "historian",
    "historian-recomp",
    "historian-editor",
    "dreamer-classifier",
    "smart-note-compiler",
    "dreamer-reviewer",
];
const genuineToolAgents = [
    "dreamer",
    "dreamer-docs",
    "dreamer-retrospective",
    "dreamer-primer-investigator",
    "dreamer-memory-mapper",
];

function agentRun(agent: string): HiddenRunIdentity {
    return { ...run(agent.startsWith("historian") ? "historian" : "dreamer-task"), agent };
}

for (const providerID of ["anthropic", "openai", "opencode"]) {
    test(`v1 preserves complete request bytes for unaffected agents on ${providerID}`, async () => {
        const db = freshDb();
        try {
            const h = host();
            const sent: string[] = [];
            delete (h.client as { session: { promptAsync?: unknown } }).session.promptAsync;
            h.prompt.mockImplementation(async (...args: unknown[]) => {
                const shaped = structuredClone(args[0]) as PromptArgs;
                shapeV1HiddenMessage(shaped.path.id, shaped.body);
                sent.push(JSON.stringify(shaped));
                return {} as never;
            });
            const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
            for (const agent of providerID === "opencode"
                ? genuineToolAgents
                : [...toolFreeAgents, ...genuineToolAgents]) {
                const handle = await executor.open(agentRun(agent));
                const original = {
                    ...request,
                    body: {
                        ...request.body,
                        agent,
                        system: "original system\n",
                        temperature: 0.3,
                        model: { providerID, modelID: "fixture" },
                    },
                };
                const bytes = JSON.stringify(original);
                await executor.attempt(handle, original);
                expect(sent.at(-1)).toBe(bytes);
                expect(JSON.stringify(original)).toBe(bytes);
                await executor.close(handle, {
                    promptSettled: true,
                    privacySensitive: false,
                    context: "test",
                    log() {},
                });
            }
        } finally {
            closeQuietly(db);
        }
    });
}

test("v1 Zen operand-only prompts advertise read with exactly one task instruction", async () => {
    const db = freshDb();
    try {
        const h = host();
        const sent: Array<{ body: Record<string, unknown> }> = [];
        delete (h.client as { session: { promptAsync?: unknown } }).session.promptAsync;
        h.prompt.mockImplementation(async (...args: unknown[]) => {
            const shaped = structuredClone(args[0]) as PromptArgs;
            shapeV1HiddenMessage(shaped.path.id, shaped.body);
            sent.push(shaped);
            return {} as never;
        });
        const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
        const registrations = buildHiddenAgentRegistrations({
            dreamerPrompt: "dreamer",
            smartNoteCompilerPrompt: "compiler",
            historianPrompt: "historian",
            historianEditorPrompt: "editor",
            historianDisallowed: [],
        });
        registrations.push(...buildZenReadAgentRegistrations(registrations));
        for (const agent of toolFreeAgents) {
            const handle = await executor.open(agentRun(agent));
            const original = {
                ...request,
                body: {
                    ...request.body,
                    agent,
                    model: { providerID: "opencode", modelID: "free" },
                },
            };
            await executor.attempt(handle, original);
            const body = sent.at(-1)!.body;
            expect(body.agent).toBe(`${agent}-zen-blocked-read`);
            const registration = registrations.find((entry) => entry.id === body.agent)!;
            expect(registration.allowedTools).toEqual(["read"]);
            const config = buildHiddenAgentConfig(
                registration.prompt!,
                registration.allowedTools,
                registration.maxSteps,
                {},
                registration.id,
                true,
            );
            expect(config.permission.read).toBe("allow");
            expect(config.permission.task).toBe("deny");
            expect((body.system as string).match(/Do not call tools\./g)).toHaveLength(1);
            if (agent.startsWith("historian"))
                expect(body.system).toBe(
                    "Summarize only the supplied conversation and memory context. Do not call tools.",
                );
            expect(original.body).not.toHaveProperty("system");
            await executor.close(handle, {
                promptSettled: true,
                privacySensitive: false,
                context: "test",
                log() {},
            });
        }
    } finally {
        closeQuietly(db);
    }
});

test("v1 blocked read refuses before the executor and the task completes", async () => {
    const db = freshDb();
    const execute = mock(() => "filesystem content must never be fetched");
    const before = createDroppedInputToolExecuteBeforeHook();
    let toolError = "";
    const h = host();
    delete (h.client as { session: { promptAsync?: unknown } }).session.promptAsync;
    h.prompt.mockImplementation(async (...args: unknown[]) => {
        const shaped = structuredClone(args[0]) as PromptArgs;
        shapeV1HiddenMessage(shaped.path.id, shaped.body);
        try {
            await before(
                { sessionID: "ses-child", tool: "read" },
                { args: { filePath: "/repo/sentinel" } },
            );
            execute();
        } catch (error) {
            toolError = (error as Error).message;
        }
        return {} as never;
    });
    const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
    const handle = await executor.open(agentRun("historian"));
    try {
        await executor.attempt(handle, {
            ...request,
            body: {
                ...request.body,
                agent: "historian",
                model: { providerID: "opencode", modelID: "free" },
            },
        });
        expect(toolError).toBe("tool use is disabled for this task");
        expect(execute).not.toHaveBeenCalled();
        await expect(
            before(
                { sessionID: "ordinary-user", tool: "read" },
                { args: { filePath: "/repo/sentinel" } },
            ),
        ).resolves.toBeUndefined();
        // The same child can fall back to a non-Zen model without retaining the compatibility surface.
        await executor.attempt(handle, {
            ...request,
            body: {
                ...request.body,
                agent: "historian",
                model: { providerID: "mock", modelID: "fallback" },
            },
        });
        expect(execute).toHaveBeenCalledTimes(1);
    } finally {
        await executor.close(handle, {
            promptSettled: true,
            privacySensitive: false,
            context: "test",
            log() {},
        });
        closeQuietly(db);
    }
    await expect(
        before({ sessionID: "ses-child", tool: "read" }, { args: {} }),
    ).resolves.toBeUndefined();
});
