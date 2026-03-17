/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scheduler } from "../../features/magic-context/scheduler";
import { closeDatabase } from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";
import { createMagicContextHook, type MagicContextDeps } from "./hook";

type PromptMocks = {
    prompt?: ReturnType<typeof mock>;
    promptAsync: ReturnType<typeof mock>;
    showToast: ReturnType<typeof mock>;
};

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function createPromptMocks(withSyncPrompt = true): PromptMocks {
    return {
        prompt: withSyncPrompt ? mock(() => undefined) : undefined,
        promptAsync: mock(async () => undefined),
        showToast: mock(async () => undefined),
    };
}

function createMockDeps(promptMocks: PromptMocks = createPromptMocks()): MagicContextDeps {
    const tagger: Tagger = {
        assignTag: mock(() => 1),
        bindTag: mock(() => {}),
        getTag: mock(() => undefined),
        getAssignments: mock(() => new Map()),
        resetCounter: mock(() => {}),
        getCounter: mock(() => 0),
        initFromDb: mock(() => {}),
        cleanup: mock(() => {}),
    };

    const scheduler: Scheduler = {
        shouldExecute: mock(() => "defer" as const),
    };

    const compactionHandler = {
        onCompacted: mock(() => {}),
    };

    return {
        client: {
            session: {
                ...(promptMocks.prompt ? { prompt: promptMocks.prompt } : {}),
                promptAsync: promptMocks.promptAsync,
            },
            tui: {
                showToast: promptMocks.showToast,
            },
        } as unknown as MagicContextDeps["client"],
        tagger,
        scheduler,
        compactionHandler,
        directory: "/tmp",
        config: { protected_tags: 3, cache_ttl: "5m" },
    };
}

function requireHook(
    hook: ReturnType<typeof createMagicContextHook>,
): NonNullable<ReturnType<typeof createMagicContextHook>> {
    expect(hook).not.toBeNull();
    return hook!;
}

describe("magic-context hook", () => {
    it("returns the expected hook keys", () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-test-");
        const hook = requireHook(createMagicContextHook(createMockDeps()));

        expect("experimental.chat.messages.transform" in hook).toBe(true);
        expect("experimental.text.complete" in hook).toBe(true);
        expect(hook).toHaveProperty("event");
        expect("command.execute.before" in hook).toBe(true);
    });

    it("returns functions for every hook entry", () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-fns-");
        const hook = requireHook(createMagicContextHook(createMockDeps()));

        expect(typeof hook["experimental.chat.messages.transform"]).toBe("function");
        expect(typeof hook["experimental.text.complete"]).toBe("function");
        expect(typeof hook.event).toBe("function");
        expect(typeof hook["command.execute.before"]).toBe("function");
        expect(typeof hook["tool.execute.after"]).toBe("function");
    });

    it("disables magic-context and warns when persistent storage is unavailable", () => {
        const dataHome = makeTempDir("hook-storage-disabled-");
        process.env.XDG_DATA_HOME = dataHome;
        writeFileSync(join(dataHome, "opencode"), "not-a-directory", "utf-8");

        const promptMocks = createPromptMocks();
        const hook = createMagicContextHook(createMockDeps(promptMocks));

        expect(hook).toBeNull();
        expect(promptMocks.showToast).toHaveBeenCalledTimes(1);
        expect(promptMocks.showToast.mock.calls[0]?.[0]).toEqual({
            body: expect.objectContaining({
                title: "Magic Context Disabled",
                message: expect.stringContaining("Persistent storage is unavailable"),
                variant: "warning",
            }),
        });
    });

    it("sends a notification for ctx-status and throws the sentinel", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-status-notification-");
        const promptMocks = createPromptMocks();
        const hook = requireHook(createMagicContextHook(createMockDeps(promptMocks)));

        await expect(
            hook["command.execute.before"]!(
                { command: "ctx-status", sessionID: "ses-status", arguments: "" },
                { parts: [{ type: "text", text: "" }] },
            ),
        ).rejects.toThrow("__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__");

        expect(promptMocks.prompt).toHaveBeenCalledTimes(1);
        const callArg = promptMocks.prompt?.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(callArg).toEqual(
            expect.objectContaining({
                path: { id: "ses-status" },
                body: expect.objectContaining({
                    noReply: true,
                    parts: [
                        {
                            type: "text",
                            text: expect.stringContaining("## Magic Status"),
                            ignored: true,
                        },
                    ],
                }),
            }),
        );
    });

    it("preserves live model and variant when ignored notifications fall back to promptAsync", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-status-promptasync-live-selection-");
        const promptMocks = createPromptMocks(false);
        const hook = requireHook(createMagicContextHook(createMockDeps(promptMocks)));

        await hook["chat.message"]!({ sessionID: "ses-status-async", variant: "thinking" });
        await hook.event!({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-status-async",
                        providerID: "openai",
                        modelID: "gpt-4o",
                        tokens: {
                            input: 40_000,
                            output: 10,
                            cache: { read: 0, write: 0 },
                        },
                    },
                },
            },
        });

        await expect(
            hook["command.execute.before"]!(
                { command: "ctx-status", sessionID: "ses-status-async", arguments: "" },
                { parts: [{ type: "text", text: "" }] },
            ),
        ).rejects.toThrow("__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__");

        expect(promptMocks.prompt).toBeUndefined();
        expect(promptMocks.promptAsync).toHaveBeenCalledTimes(1);
        const callArg = promptMocks.promptAsync.mock.calls[0]?.[0] as {
            body?: Record<string, unknown>;
        };
        expect(callArg.body?.model).toEqual({ providerID: "openai", modelID: "gpt-4o" });
        expect(callArg.body?.variant).toBe("thinking");
    });

    it("does not forward stale model selection when sending ctx-status notification", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-status-no-model-reset-");
        const promptMocks = createPromptMocks();
        const hook = requireHook(createMagicContextHook(createMockDeps(promptMocks)));

        await expect(
            hook["command.execute.before"]!(
                {
                    command: "ctx-status",
                    sessionID: "ses-status-model",
                    arguments: "",
                    agent: "oracle",
                    variant: "fast",
                    providerID: "anthropic",
                    modelID: "claude-sonnet-4-6",
                },
                { parts: [{ type: "text", text: "" }] },
            ),
        ).rejects.toThrow("__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__");

        const callArg = promptMocks.prompt?.mock.calls[0]?.[0] as {
            body?: Record<string, unknown>;
        };
        expect(callArg.body).toBeDefined();
        expect(callArg.body?.agent).toBeUndefined();
        expect(callArg.body?.variant).toBeUndefined();
        expect(callArg.body?.model).toBeUndefined();
    });

    it("sends a notification for ctx-flush and throws the sentinel", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-flush-notification-");
        const promptMocks = createPromptMocks();
        const hook = requireHook(createMagicContextHook(createMockDeps(promptMocks)));

        await expect(
            hook["command.execute.before"]!(
                { command: "ctx-flush", sessionID: "ses-flush", arguments: "" },
                { parts: [{ type: "text", text: "" }] },
            ),
        ).rejects.toThrow("__CONTEXT_MANAGEMENT_CTX-FLUSH_HANDLED__");

        expect(promptMocks.prompt).toHaveBeenCalledTimes(1);
        const callArg = promptMocks.prompt?.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(callArg).toEqual(
            expect.objectContaining({
                path: { id: "ses-flush" },
                body: expect.objectContaining({
                    noReply: true,
                    parts: [
                        {
                            type: "text",
                            text: expect.stringContaining("No pending operations to flush."),
                            ignored: true,
                        },
                    ],
                }),
            }),
        );
    });

    it("sends the 80% emergency nudge with the current live model and variant via promptAsync", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-emergency-live-model-");
        const promptMocks = createPromptMocks();
        const hook = requireHook(createMagicContextHook(createMockDeps(promptMocks)));

        await hook["chat.message"]!({ sessionID: "ses-emergency-live-model", variant: "thinking" });
        await hook["tool.execute.after"]?.({
            tool: "ctx_reduce",
            sessionID: "ses-emergency-live-model",
        });

        await hook.event!({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-emergency-live-model",
                        providerID: "openai",
                        modelID: "gpt-4o",
                        tokens: {
                            input: 170_000,
                            output: 10,
                            cache: { read: 0, write: 0 },
                        },
                    },
                },
            },
        });

        expect(promptMocks.promptAsync).toHaveBeenCalledTimes(1);
        const callArg = promptMocks.promptAsync.mock.calls[0]?.[0] as {
            path?: unknown;
            body?: Record<string, unknown>;
        };
        expect(callArg.path).toEqual({ id: "ses-emergency-live-model" });
        expect(callArg.body?.model).toEqual({ providerID: "openai", modelID: "gpt-4o" });
        expect(callArg.body?.variant).toBe("thinking");
        expect(callArg.body?.parts).toEqual([
            expect.objectContaining({
                type: "text",
                text: expect.stringContaining("CONTEXT EMERGENCY"),
            }),
        ]);
        expect(callArg.body?.noReply).toBeUndefined();
    });

    it("allows the 80% emergency nudge to fire again after session.deleted cleanup", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-emergency-session-deleted-");
        const promptMocks = createPromptMocks();
        const hook = requireHook(createMagicContextHook(createMockDeps(promptMocks)));

        await hook["chat.message"]!({ sessionID: "ses-emergency-reset", variant: "thinking" });

        await hook.event!({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-emergency-reset",
                        providerID: "openai",
                        modelID: "gpt-4o",
                        tokens: {
                            input: 170_000,
                            output: 10,
                            cache: { read: 0, write: 0 },
                        },
                    },
                },
            },
        });

        await hook.event!({
            event: {
                type: "session.deleted",
                properties: {
                    sessionID: "ses-emergency-reset",
                },
            },
        });

        await hook["chat.message"]!({ sessionID: "ses-emergency-reset", variant: "thinking" });
        await hook.event!({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-emergency-reset",
                        providerID: "openai",
                        modelID: "gpt-4o",
                        tokens: {
                            input: 171_000,
                            output: 10,
                            cache: { read: 0, write: 0 },
                        },
                    },
                },
            },
        });

        expect(promptMocks.promptAsync).toHaveBeenCalledTimes(2);
    });

    it("injects a hidden ctx_reduce reminder on the next user turn after a tool-heavy turn without ctx_reduce", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-turn-reminder-positive-");
        const hook = requireHook(createMagicContextHook(createMockDeps()));

        for (const tool of ["read", "grep", "glob", "bash", "task"]) {
            await hook["tool.execute.after"]?.({ tool, sessionID: "ses-turn-reminder" });
        }

        await hook["chat.message"]?.({ sessionID: "ses-turn-reminder", variant: "default" });
        const messages = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-turn-reminder" },
                parts: [{ type: "text", text: "Continue" }],
            },
        ];

        await hook["experimental.chat.messages.transform"]?.({}, { messages });

        expect(messages[0]?.parts).toEqual([
            expect.objectContaining({
                type: "text",
                text: expect.stringContaining(
                    "Also drop via `ctx_reduce` things you don't need anymore from the last turn",
                ),
            }),
        ]);
    });

    it("keeps the hidden ctx_reduce reminder when the previous tool-heavy turn only queued ctx_reduce", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-turn-reminder-queued-reduce-");
        const hook = requireHook(createMagicContextHook(createMockDeps()));

        for (const tool of ["read", "grep", "glob", "bash", "ctx_reduce"]) {
            await hook["tool.execute.after"]?.({ tool, sessionID: "ses-turn-reminder-suppressed" });
        }

        await hook["chat.message"]?.({
            sessionID: "ses-turn-reminder-suppressed",
            variant: "default",
        });
        const messages = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-turn-reminder-suppressed" },
                parts: [{ type: "text", text: "Continue" }],
            },
        ];

        await hook["experimental.chat.messages.transform"]?.({}, { messages });

        expect(messages[0]?.parts).toEqual([
            expect.objectContaining({
                type: "text",
                text: expect.stringContaining(
                    "Also drop via `ctx_reduce` things you don't need anymore from the last turn",
                ),
            }),
        ]);
    });
});
