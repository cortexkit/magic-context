/// <reference types="bun-types" />
// Tests exercise server-side (Desktop) notification behavior — set OPENCODE_CLIENT
// to prevent the TUI toast path from intercepting sendIgnoredMessage calls.
process.env.OPENCODE_CLIENT = "desktop";

import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";
import { createMagicContextHook, type MagicContextDeps } from "./hook";

type PromptMocks = {
    prompt?: ReturnType<typeof mock>;
    promptAsync: ReturnType<typeof mock>;
    createSession: ReturnType<typeof mock>;
    listMessages: ReturnType<typeof mock>;
    deleteSession: ReturnType<typeof mock>;
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
        createSession: mock(async () => ({ data: { id: "dream-child" } })),
        listMessages: mock(async () => ({
            data: [
                {
                    info: { role: "assistant", time: { created: Date.now() } },
                    parts: [{ type: "text", text: "dream complete" }],
                },
            ],
        })),
        deleteSession: mock(async () => ({ data: undefined })),
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
                create: promptMocks.createSession,
                ...(promptMocks.prompt ? { prompt: promptMocks.prompt } : {}),
                promptAsync: promptMocks.promptAsync,
                messages: promptMocks.listMessages,
                delete: promptMocks.deleteSession,
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

async function expectSentinel(promise: Promise<unknown>, sentinel: string): Promise<void> {
    try {
        await promise;
        throw new Error(`Expected sentinel ${sentinel}`);
    } catch (error) {
        expect(String(error)).toContain(sentinel);
    }
}

function formatHm(date: Date): string {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
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

    it("initializes the dream queue table during setup", () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-dream-queue-init-");
        requireHook(createMagicContextHook(createMockDeps()));
        const db = openDatabase();

        const table = db
            .prepare<[], { name: string }>(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dream_queue'",
            )
            .get();

        expect(table?.name).toBe("dream_queue");
    });

    it("disables magic-context and warns when persistent storage is unavailable", () => {
        const dataHome = makeTempDir("hook-storage-disabled-");
        process.env.XDG_DATA_HOME = dataHome;
        // Block mkdirSync at the cortexkit segment of the new shared path so
        // openDatabase() falls into its in-memory fallback. (Plugin v0.16+
        // moved DB to <XDG_DATA_HOME>/cortexkit/magic-context/.)
        writeFileSync(join(dataHome, "cortexkit"), "not-a-directory", "utf-8");

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

        await expectSentinel(
            hook["command.execute.before"]!(
                { command: "ctx-status", sessionID: "ses-status", arguments: "" },
                { parts: [{ type: "text", text: "" }] },
            ),
            "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
        );

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

        await expectSentinel(
            hook["command.execute.before"]!(
                { command: "ctx-status", sessionID: "ses-status-async", arguments: "" },
                { parts: [{ type: "text", text: "" }] },
            ),
            "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
        );

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

        await expectSentinel(
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
            "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
        );

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

        await expectSentinel(
            hook["command.execute.before"]!(
                { command: "ctx-flush", sessionID: "ses-flush", arguments: "" },
                { parts: [{ type: "text", text: "" }] },
            ),
            "__CONTEXT_MANAGEMENT_CTX-FLUSH_HANDLED__",
        );

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

    it("sends dream notifications for ctx-dream and throws the sentinel", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-dream-notification-");
        const promptMocks = createPromptMocks();
        const deps = createMockDeps(promptMocks);
        deps.config = {
            ...deps.config,
            dreamer: {
                enabled: true,
                schedule: "02:00-06:00",
                max_runtime_minutes: 60,
                tasks: ["consolidate"],
                task_timeout_minutes: 10,
                inject_docs: true,
                user_memories: { enabled: true, promotion_threshold: 3 },
                pin_key_files: { enabled: false, token_budget: 10000, min_reads: 4 },
            },
        };
        const hook = requireHook(createMagicContextHook(deps));

        await expectSentinel(
            hook["command.execute.before"]!(
                { command: "ctx-dream", sessionID: "ses-dream", arguments: "" },
                { parts: [{ type: "text", text: "" }] },
            ),
            "__CONTEXT_MANAGEMENT_CTX-DREAM_HANDLED__",
        );

        expect(promptMocks.prompt).toHaveBeenCalledTimes(3);
        expect(promptMocks.createSession).toHaveBeenCalledTimes(1);
        expect(promptMocks.deleteSession).toHaveBeenCalledTimes(1);
        const firstCallArg = promptMocks.prompt?.mock.calls[0]?.[0] as Record<string, unknown>;
        const secondCallArg = promptMocks.prompt?.mock.calls[1]?.[0] as Record<string, unknown>;
        const thirdCallArg = promptMocks.prompt?.mock.calls[2]?.[0] as Record<string, unknown>;
        expect(firstCallArg).toEqual(
            expect.objectContaining({
                path: { id: "ses-dream" },
                body: expect.objectContaining({
                    parts: [
                        expect.objectContaining({
                            text: "Starting dream run...",
                        }),
                    ],
                }),
            }),
        );
        expect(secondCallArg).toEqual(
            expect.objectContaining({
                path: { id: "dream-child" },
                query: { directory: "/tmp" },
                body: expect.objectContaining({
                    agent: "dreamer",
                    system: expect.stringContaining("memory maintenance agent"),
                    parts: expect.arrayContaining([
                        expect.objectContaining({
                            text: expect.stringContaining(
                                "## Task: Consolidate Duplicate Memories",
                            ),
                        }),
                    ]),
                }),
            }),
        );
        expect(thirdCallArg).toEqual(
            expect.objectContaining({
                path: { id: "ses-dream" },
                body: expect.objectContaining({
                    parts: [
                        expect.objectContaining({
                            text: expect.stringContaining("## /ctx-dream"),
                        }),
                    ],
                }),
            }),
        );
    });

    it("runs sidekick for ctx-aug and sends the augmented user prompt", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-sidekick-aug-");
        const promptMocks = createPromptMocks();
        promptMocks.listMessages = mock(async () => ({
            data: [
                {
                    info: { role: "assistant", time: { created: Date.now() } },
                    parts: [{ type: "text", text: "Relevant memory briefing" }],
                },
            ],
        }));
        const deps = createMockDeps(promptMocks);
        deps.config = {
            ...deps.config,
            sidekick: {
                enabled: true,
                timeout_ms: 5_000,
            },
        };
        const hook = requireHook(createMagicContextHook(deps));

        await expectSentinel(
            hook["command.execute.before"]!(
                {
                    command: "ctx-aug",
                    sessionID: "ses-sidekick",
                    arguments: "Implement sidekick migration",
                },
                { parts: [{ type: "text", text: "" }] },
            ),
            "__CONTEXT_MANAGEMENT_CTX-AUG_HANDLED__",
        );

        expect(promptMocks.createSession).toHaveBeenCalledTimes(1);
        expect(promptMocks.prompt).toBeDefined();
        expect(promptMocks.prompt!).toHaveBeenCalledTimes(2);
        expect(promptMocks.prompt!.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({
                path: { id: "ses-sidekick" },
                body: expect.objectContaining({
                    parts: [
                        expect.objectContaining({
                            text: "🔍 Preparing augmentation… this may take 2-10s depending on your sidekick provider.",
                        }),
                    ],
                }),
            }),
        );
        expect(promptMocks.prompt!.mock.calls[1]?.[0]).toEqual(
            expect.objectContaining({
                path: { id: "dream-child" },
                query: { directory: "/tmp" },
                body: expect.objectContaining({
                    agent: "sidekick",
                    system: expect.stringContaining('ctx_search(query="'),
                    parts: [
                        {
                            type: "text",
                            text: "Implement sidekick migration",
                        },
                    ],
                }),
            }),
        );
        expect(promptMocks.promptAsync).toHaveBeenCalledWith(
            expect.objectContaining({
                path: { id: "ses-sidekick" },
                body: {
                    parts: [
                        {
                            type: "text",
                            text: "Implement sidekick migration\n\n<sidekick-augmentation>\nRelevant memory briefing\n</sidekick-augmentation>",
                        },
                    ],
                },
            }),
        );
        expect(promptMocks.deleteSession).toHaveBeenCalledWith({
            path: { id: "dream-child" },
            query: { directory: "/tmp" },
        });
    });

    it("checks the dream schedule in the background after message updates", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-dream-schedule-");
        const promptMocks = createPromptMocks();
        const deps = createMockDeps(promptMocks);
        deps.directory = "/repo/project";
        const nowForSchedule = new Date();
        const scheduleStart = new Date(nowForSchedule.getTime() - 60_000);
        const scheduleEnd = new Date(nowForSchedule.getTime() + 60_000);
        deps.config = {
            ...deps.config,
            dreamer: {
                enabled: true,
                schedule: `${formatHm(scheduleStart)}-${formatHm(scheduleEnd)}`,
                max_runtime_minutes: 60,
                tasks: ["consolidate"],
                task_timeout_minutes: 10,
                inject_docs: true,
                user_memories: { enabled: true, promotion_threshold: 3 },
                pin_key_files: { enabled: false, token_budget: 10000, min_reads: 4 },
            },
        };
        const originalDateNow = Date.now;
        Date.now = () => originalDateNow() + 2 * 60 * 60 * 1000;

        try {
            const hook = requireHook(createMagicContextHook(deps));
            const db = openDatabase();
            const projectPath = resolveProjectIdentity("/repo/project");
            const now = Date.now();

            db.prepare(
                "INSERT INTO memories (project_path, category, content, normalized_hash, source_session_id, source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at, last_retrieved_at, status, expires_at, verification_status, verified_at, superseded_by_memory_id, merged_from, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ).run(
                projectPath,
                "ARCHITECTURE_DECISIONS",
                "Dream me",
                "dream-me",
                "ses-seed",
                "historian",
                1,
                0,
                now,
                now,
                now,
                now,
                null,
                "active",
                null,
                "unverified",
                null,
                null,
                null,
                null,
            );

            await hook.event!({
                event: {
                    type: "message.updated",
                    properties: {
                        info: {
                            role: "assistant",
                            finish: "stop",
                            sessionID: "ses-dream-schedule",
                            providerID: "openai",
                            modelID: "gpt-4o",
                            tokens: {
                                input: 10,
                                output: 10,
                                cache: { read: 0, write: 0 },
                            },
                        },
                    },
                },
            });

            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(promptMocks.createSession).toHaveBeenCalledTimes(1);
            expect(promptMocks.deleteSession).toHaveBeenCalledTimes(1);
        } finally {
            Date.now = originalDateNow;
        }
    });

    it("clears the reasoning watermark when message.updated reports a model change", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-model-change-watermark-");
        const hook = requireHook(createMagicContextHook(createMockDeps()));

        await hook.event!({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-model-change",
                        providerID: "openai",
                        modelID: "gpt-4o",
                        tokens: {
                            input: 20_000,
                            output: 10,
                            cache: { read: 0, write: 0 },
                        },
                    },
                },
            },
        });

        updateSessionMeta(openDatabase(), "ses-model-change", { clearedReasoningThroughTag: 7 });

        await hook.event!({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-model-change",
                        providerID: "opencode-go",
                        modelID: "kimi-k2.6",
                        tokens: {
                            input: 25_000,
                            output: 10,
                            cache: { read: 0, write: 0 },
                        },
                    },
                },
            },
        });

        expect(
            getOrCreateSessionMeta(openDatabase(), "ses-model-change").clearedReasoningThroughTag,
        ).toBe(0);
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

    it("keeps the hidden ctx_reduce reminder when the previous tool-heavy turn did not reduce", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-turn-reminder-queued-reduce-");
        const hook = requireHook(createMagicContextHook(createMockDeps()));

        for (const tool of ["read", "grep", "glob", "bash", "edit"]) {
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
