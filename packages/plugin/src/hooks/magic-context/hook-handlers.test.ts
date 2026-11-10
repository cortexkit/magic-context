/// <reference types="bun-types" />

import { describe, expect, mock, spyOn, test } from "bun:test";

import { __resetMessageIndexAsyncForTests } from "../../features/magic-context/message-index-async";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import {
    captureChannel1PostReduceGraceBaseline,
    getOverflowState,
    recordOverflowDetected,
} from "../../features/magic-context/storage-meta-persisted";
import * as loggerModule from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import type { Channel1State } from "./ctx-reduce-nudge";
import { EMPTY_TASK_OUTPUT_SENTINEL } from "./empty-task-output";
import {
    createChatMessageHook,
    createCommandExecuteBeforeHook,
    createEventHook,
    createToolExecuteAfterHook,
} from "./hook-handlers";
import { registerLkgPersistence } from "./lkg-slot";
import { setRawMessageProvider } from "./read-session-chunk";
import type { MessageLike } from "./tag-messages";
import { countRealUserMessages } from "./tail-hygiene-walk";

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function createTestHook(db: Database): ReturnType<typeof createToolExecuteAfterHook> {
    return createToolExecuteAfterHook({
        db,
        channel1StateBySession: new Map(),
    });
}

describe("createToolExecuteAfterHook todo snapshots", () => {
    const PREVIOUS_TODO_STATE = '[{"content":"Older plan","status":"pending","priority":"medium"}]';
    test("native task hook surfaces an empty completed child result", async () => {
        const db = createTestDb();
        try {
            const output = {
                output: '<task id="ses-child" state="completed">\n<task_result>\n\n</task_result>\n</task>',
            };

            await createTestHook(db)({ tool: "task", sessionID: "ses-parent" }, output);

            expect(output.output).toContain(EMPTY_TASK_OUTPUT_SENTINEL);
        } finally {
            closeQuietly(db);
        }
    });

    test("rust mode forwards todo state to the module without changing TS capture", async () => {
        const db = createTestDb();
        try {
            const calls: Array<{ sessionId: string; stateJson: string; ownerMessageId: string }> =
                [];
            const hook = createToolExecuteAfterHook({
                db,
                channel1StateBySession: new Map(),
                transformMode: "rust",
                todoStateSet: async (input) => {
                    calls.push(input);
                },
            });
            await hook({
                tool: "todowrite",
                sessionID: "ses-rust-todo",
                args: {
                    todos: [{ status: "pending", priority: "high", content: "Forward me" }],
                    owner_message_id: "msg-owner",
                },
            });
            expect(calls).toEqual([
                {
                    sessionId: "ses-rust-todo",
                    stateJson: '[{"content":"Forward me","status":"pending","priority":"high"}]',
                    ownerMessageId: "msg-owner",
                },
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("permission-denied todowrite capture is refused, including lookalike calls", async () => {
        const db = createTestDb();
        try {
            let denied = true;
            const client = {
                app: {
                    agents: async () => ({
                        data: [
                            {
                                name: "build",
                                permission: { todowrite: denied ? "deny" : "allow" },
                            },
                        ],
                    }),
                },
                session: {
                    get: async () => ({ data: { agent: "build" } }),
                },
            } as never;
            const hook = createToolExecuteAfterHook({
                db,
                channel1StateBySession: new Map(),
                client,
            });

            await hook({
                tool: "todowrite",
                sessionID: "ses-denied-capture",
                args: {
                    todos: [{ status: "pending", priority: "high", content: "Must not capture" }],
                },
            });
            expect(getOrCreateSessionMeta(db, "ses-denied-capture").lastTodoState).toBe("");

            // A third-party lookalike is never accepted as a native todowrite capture.
            denied = false;
            await hook({
                tool: "mcp_Todowrite",
                sessionID: "ses-denied-capture",
                args: {
                    todos: [{ status: "pending", priority: "high", content: "Still refuse" }],
                },
            });
            expect(getOrCreateSessionMeta(db, "ses-denied-capture").lastTodoState).toBe("");

            await hook({
                tool: "todowrite",
                sessionID: "ses-denied-capture",
                args: {
                    todos: [{ status: "pending", priority: "high", content: "Capture now" }],
                },
            });
            expect(getOrCreateSessionMeta(db, "ses-denied-capture").lastTodoState).toContain(
                "Capture now",
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("todowrite persists the latest todo state", async () => {
        const db = createTestDb();
        try {
            const hook = createTestHook(db);

            await hook({
                tool: "todowrite",
                sessionID: "ses-todo",
                args: {
                    todos: [
                        {
                            status: "pending",
                            priority: "high",
                            content: "Review audit",
                            extra: true,
                        },
                    ],
                },
            });

            expect(getOrCreateSessionMeta(db, "ses-todo").lastTodoState).toBe(
                '[{"content":"Review audit","status":"pending","priority":"high"}]',
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("multiple todowrite calls replace the snapshot", async () => {
        const db = createTestDb();
        try {
            const hook = createTestHook(db);

            await hook({
                tool: "todowrite",
                sessionID: "ses-todo",
                args: { todos: [{ content: "First", status: "pending", priority: "low" }] },
            });
            await hook({
                tool: "todowrite",
                sessionID: "ses-todo",
                args: { todos: [{ content: "Second", status: "in_progress", priority: "high" }] },
            });

            expect(getOrCreateSessionMeta(db, "ses-todo").lastTodoState).toBe(
                '[{"content":"Second","status":"in_progress","priority":"high"}]',
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("non-todowrite tools do not update todo state", async () => {
        const db = createTestDb();
        try {
            const hook = createTestHook(db);
            updateSessionMeta(db, "ses-other", { lastTodoState: "[]" });

            await hook({
                tool: "read",
                sessionID: "ses-other",
                args: { todos: [{ content: "Nope", status: "pending", priority: "high" }] },
            });

            expect(getOrCreateSessionMeta(db, "ses-other").lastTodoState).toBe("[]");
        } finally {
            closeQuietly(db);
        }
    });

    test("subagent sessions skip todo snapshot updates", async () => {
        const db = createTestDb();
        try {
            const hook = createTestHook(db);
            updateSessionMeta(db, "ses-sub", { isSubagent: true });

            await hook({
                tool: "todowrite",
                sessionID: "ses-sub",
                args: { todos: [{ content: "Sub work", status: "pending", priority: "high" }] },
            });

            expect(getOrCreateSessionMeta(db, "ses-sub").lastTodoState).toBe("");
        } finally {
            closeQuietly(db);
        }
    });

    test("a custom status such as blocked replaces the snapshot", async () => {
        const db = createTestDb();
        try {
            const hook = createTestHook(db);
            updateSessionMeta(db, "ses-blocked", { lastTodoState: PREVIOUS_TODO_STATE });

            await hook({
                tool: "todowrite",
                sessionID: "ses-blocked",
                args: {
                    todos: [
                        { content: "Wait for review", status: "blocked", priority: "high" },
                        { content: "Third-party", status: "done" },
                    ],
                },
            });

            expect(getOrCreateSessionMeta(db, "ses-blocked").lastTodoState).toBe(
                '[{"content":"Wait for review","status":"blocked","priority":"high"},' +
                    '{"content":"Third-party","status":"done","priority":"medium"}]',
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("a custom priority replaces the snapshot", async () => {
        const db = createTestDb();
        try {
            const hook = createTestHook(db);
            updateSessionMeta(db, "ses-priority", { lastTodoState: PREVIOUS_TODO_STATE });

            await hook({
                tool: "todowrite",
                sessionID: "ses-priority",
                args: { todos: [{ content: "Hotfix", status: "pending", priority: "urgent" }] },
            });

            expect(getOrCreateSessionMeta(db, "ses-priority").lastTodoState).toBe(
                '[{"content":"Hotfix","status":"pending","priority":"urgent"}]',
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("todowrite lists that can't be read clear the snapshot", async () => {
        const unreadableArgs: Array<{ label: string; args: Record<string, unknown> }> = [
            { label: "missing todos", args: {} },
            { label: "non-array todos", args: { todos: { content: "Not an array" } } },
            { label: "missing status", args: { todos: [{ content: "Missing status" }] } },
            { label: "empty status", args: { todos: [{ content: "Empty", status: "" }] } },
            { label: "non-string content", args: { todos: [{ content: 7, status: "pending" }] } },
        ];
        for (const { label, args } of unreadableArgs) {
            const db = createTestDb();
            try {
                const hook = createTestHook(db);
                updateSessionMeta(db, "ses-unreadable", { lastTodoState: PREVIOUS_TODO_STATE });

                await hook({ tool: "todowrite", sessionID: "ses-unreadable", args });

                expect({
                    label,
                    state: getOrCreateSessionMeta(db, "ses-unreadable").lastTodoState,
                }).toEqual({ label, state: "[]" });
            } finally {
                closeQuietly(db);
            }
        }
    });

    test("rust mode forwards a cleared snapshot to the module", async () => {
        const db = createTestDb();
        try {
            const calls: Array<{ sessionId: string; stateJson: string; ownerMessageId: string }> =
                [];
            const hook = createToolExecuteAfterHook({
                db,
                channel1StateBySession: new Map(),
                transformMode: "rust",
                todoStateSet: async (input) => {
                    calls.push(input);
                },
            });
            updateSessionMeta(db, "ses-rust-clear", { lastTodoState: PREVIOUS_TODO_STATE });

            await hook({
                tool: "todowrite",
                sessionID: "ses-rust-clear",
                args: { todos: [{ content: "Empty", status: "" }], owner_message_id: "msg-owner" },
            });

            expect(calls).toEqual([
                { sessionId: "ses-rust-clear", stateJson: "[]", ownerMessageId: "msg-owner" },
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("createEventHook incremental indexing", () => {
    test("coalesces streaming message.updated events into one settled part read", async () => {
        __resetMessageIndexAsyncForTests();
        const db = createTestDb();
        const sessionId = "ses-streaming-index";
        let partReads = 0;
        const rawMessage = {
            id: "msg-streaming",
            ordinal: 1,
            role: "assistant",
            parts: [{ type: "text", text: "settled response" }],
            version: 1,
        };
        const clearProvider = setRawMessageProvider(sessionId, {
            readMessages: () => [rawMessage],
        });
        const hook = createEventHook({
            eventHandler: async () => {},
            contextUsageMap: new Map(),
            db,
            liveModelBySession: new Map(),
            variantBySession: new Map(),
            agentBySession: new Map(),
            sessionDirectoryBySession: new Map(),
            historyRefreshSessions: new Set(),
            deferredHistoryRefreshSessions: new Set(),
            systemPromptRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            deferredMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            readIncrementalMessage: () => {
                partReads += 1;
                return rawMessage;
            },
            client: undefined as never,
        });

        try {
            for (let index = 0; index < 8; index += 1) {
                await hook({
                    event: {
                        type: "message.updated",
                        properties: {
                            info: {
                                id: rawMessage.id,
                                role: "assistant",
                                sessionID: sessionId,
                                finish: "stop",
                            },
                        },
                    },
                });
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            await new Promise((resolve) => setTimeout(resolve, 140));

            expect(partReads).toBe(1);
        } finally {
            clearProvider();
            __resetMessageIndexAsyncForTests();
            closeQuietly(db);
        }
    });
});

describe("createEventHook mid-session model switch clears overflow state", () => {
    function makeAssistantEvent(
        sessionID: string,
        providerID: string,
        modelID: string,
        messageID = `msg-${Math.random().toString(36).slice(2)}`,
    ) {
        return {
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        sessionID,
                        id: messageID,
                        providerID,
                        modelID,
                        finish: "stop",
                        tokens: { input: 1000, cache: { read: 0, write: 0 } },
                    },
                },
            },
        };
    }

    test("clears detected_context_limit + needs_emergency_recovery on model change", async () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-model-switch";
            const liveModelBySession = new Map<string, { providerID: string; modelID: string }>();
            const hook = createEventHook({
                eventHandler: async () => {},
                contextUsageMap: new Map(),
                db,
                liveModelBySession,
                variantBySession: new Map(),
                agentBySession: new Map(),
                sessionDirectoryBySession: new Map(),
                historyRefreshSessions: new Set(),
                deferredHistoryRefreshSessions: new Set(),
                systemPromptRefreshSessions: new Set(),
                pendingMaterializationSessions: new Set(),
                deferredMaterializationSessions: new Set(),
                lastHeuristicsTurnId: new Map(),
                client: undefined as never,
            });

            // First assistant response on the small-context model.
            await hook(makeAssistantEvent(sessionId, "anthropic", "claude-small", "msg-000001"));
            // Session overflowed on the small model → records a detected limit + arms recovery.
            recordOverflowDetected(db, sessionId, 120_000);
            let overflow = getOverflowState(db, sessionId);
            expect(overflow.detectedContextLimit).toBe(120_000);
            expect(overflow.needsEmergencyRecovery).toBe(true);

            // User switches to a 1M-context model mid-session — next assistant event
            // carries the new model. The handler must clear BOTH the stale detected
            // limit and the recovery flag so the new model's pressure math is clean.
            await hook(makeAssistantEvent(sessionId, "anthropic", "claude-large", "msg-000002"));
            overflow = getOverflowState(db, sessionId);
            expect(overflow.detectedContextLimit).toBe(0);
            expect(overflow.needsEmergencyRecovery).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("ignores late updates from an older assistant after a model switch", async () => {
        const db = createTestDb();
        let dropCount = 0;
        registerLkgPersistence({
            load: () => undefined,
            clear: () => {
                dropCount++;
            },
        });
        try {
            const sessionId = "ses-interleaved-model-switch";
            const liveModelBySession = new Map<string, { providerID: string; modelID: string }>();
            const latestAssistantMessageIdBySession = new Map<string, string>();
            const hook = createEventHook({
                eventHandler: async () => {},
                contextUsageMap: new Map(),
                db,
                liveModelBySession,
                latestAssistantMessageIdBySession,
                variantBySession: new Map(),
                agentBySession: new Map(),
                sessionDirectoryBySession: new Map(),
                historyRefreshSessions: new Set(),
                deferredHistoryRefreshSessions: new Set(),
                systemPromptRefreshSessions: new Set(),
                pendingMaterializationSessions: new Set(),
                deferredMaterializationSessions: new Set(),
                lastHeuristicsTurnId: new Map(),
                client: undefined as never,
            });

            // The newer assistant shell arrives between two updates for the older row.
            await hook(makeAssistantEvent(sessionId, "fable", "fable-5", "msg-000001"));
            await hook(makeAssistantEvent(sessionId, "fable", "fable-5-1", "msg-000002"));
            await hook(makeAssistantEvent(sessionId, "fable", "fable-5", "msg-000001"));

            expect(dropCount).toBe(1);
            expect(liveModelBySession.get(sessionId)).toEqual({
                providerID: "fable",
                modelID: "fable-5-1",
            });
            expect(latestAssistantMessageIdBySession.get(sessionId)).toBe("msg-000002");
        } finally {
            registerLkgPersistence(undefined);
            closeQuietly(db);
        }
    });

    test("accepts newer assistants for a genuine A-to-B-to-A model sequence", async () => {
        const db = createTestDb();
        let dropCount = 0;
        registerLkgPersistence({
            load: () => undefined,
            clear: () => {
                dropCount++;
            },
        });
        try {
            const sessionId = "ses-newer-model-switches";
            const liveModelBySession = new Map([
                [sessionId, { providerID: "fable", modelID: "fable-4" }],
            ]);
            const latestAssistantMessageIdBySession = new Map<string, string>();
            const hook = createEventHook({
                eventHandler: async () => {},
                contextUsageMap: new Map(),
                db,
                liveModelBySession,
                latestAssistantMessageIdBySession,
                variantBySession: new Map(),
                agentBySession: new Map(),
                sessionDirectoryBySession: new Map(),
                historyRefreshSessions: new Set(),
                deferredHistoryRefreshSessions: new Set(),
                systemPromptRefreshSessions: new Set(),
                pendingMaterializationSessions: new Set(),
                deferredMaterializationSessions: new Set(),
                lastHeuristicsTurnId: new Map(),
                client: undefined as never,
            });

            await hook(makeAssistantEvent(sessionId, "fable", "fable-5", "msg-000001"));
            await hook(makeAssistantEvent(sessionId, "fable", "fable-5-1", "msg-000002"));
            await hook(makeAssistantEvent(sessionId, "fable", "fable-5", "msg-000003"));

            expect(dropCount).toBe(3);
            expect(liveModelBySession.get(sessionId)).toEqual({
                providerID: "fable",
                modelID: "fable-5",
            });
            expect(latestAssistantMessageIdBySession.get(sessionId)).toBe("msg-000003");
        } finally {
            registerLkgPersistence(undefined);
            closeQuietly(db);
        }
    });

    test("does NOT clear overflow state when the model is unchanged", async () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-same-model";
            const liveModelBySession = new Map<string, { providerID: string; modelID: string }>();
            const hook = createEventHook({
                eventHandler: async () => {},
                contextUsageMap: new Map(),
                db,
                liveModelBySession,
                variantBySession: new Map(),
                agentBySession: new Map(),
                sessionDirectoryBySession: new Map(),
                historyRefreshSessions: new Set(),
                deferredHistoryRefreshSessions: new Set(),
                systemPromptRefreshSessions: new Set(),
                pendingMaterializationSessions: new Set(),
                deferredMaterializationSessions: new Set(),
                lastHeuristicsTurnId: new Map(),
                client: undefined as never,
            });

            await hook(makeAssistantEvent(sessionId, "anthropic", "claude-small", "msg-000001"));
            recordOverflowDetected(db, sessionId, 120_000);
            // Same model again — detected limit must persist (authoritative on this model).
            await hook(makeAssistantEvent(sessionId, "anthropic", "claude-small", "msg-000002"));
            const overflow = getOverflowState(db, sessionId);
            expect(overflow.detectedContextLimit).toBe(120_000);
            expect(overflow.needsEmergencyRecovery).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("createChatMessageHook cache TTL seeding", () => {
    test("seeds config TTL on the first model-bearing user message without marking it synced", async () => {
        const db = createTestDb();
        const sessionId = "ses-cache-ttl-seed";
        const hook = createChatMessageHook({
            db,
            liveModelBySession: new Map(),
            variantBySession: new Map(),
            agentBySession: new Map(),
            historyRefreshSessions: new Set(),
            systemPromptRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            cacheTtlConfig: {
                default: "5m",
                "anthropic/claude-opus-5": "1h",
            },
        });
        try {
            await hook({
                sessionID: sessionId,
                model: { providerID: "anthropic", modelID: "claude-opus-5" },
            });

            const meta = getOrCreateSessionMeta(db, sessionId);
            expect(meta.cacheTtl).toBe("1h");
            expect(meta.lastObservedModelKey).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});

describe("Desktop stripped-command interception", () => {
    function createCommandHook(commandHandler: {
        "command.execute.before": (
            input: { command: string; sessionID: string; arguments: string },
            output: { parts: Array<{ type: string; text?: string }> },
            params: Record<string, unknown>,
        ) => Promise<unknown>;
    }) {
        const db = createTestDb();
        const hook = createChatMessageHook({
            db,
            liveModelBySession: new Map(),
            variantBySession: new Map(),
            agentBySession: new Map(),
            historyRefreshSessions: new Set(),
            systemPromptRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            commandHandler,
        });
        return { db, hook };
    }

    test("routes accepted wrapup arguments through the native command handler", async () => {
        const execute = mock(async () => undefined);
        const { db, hook } = createCommandHook({ "command.execute.before": execute });
        try {
            await hook(
                {
                    sessionID: "ses-wrapup",
                    agent: "build",
                    variant: "high",
                    model: { providerID: "anthropic", modelID: "claude" },
                },
                { parts: [{ type: "text", text: "ctx-wrapup 2" }] },
            );

            expect(execute).toHaveBeenCalledTimes(1);
            expect(execute.mock.calls[0]?.[0]).toEqual({
                command: "ctx-wrapup",
                sessionID: "ses-wrapup",
                arguments: "2",
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("does not route trailing or surrounding prose", async () => {
        const execute = mock(async () => undefined);
        const { db, hook } = createCommandHook({ "command.execute.before": execute });
        try {
            for (const text of [
                "ctx-status extra prose sentence",
                "Please run ctx-status before continuing.",
            ]) {
                await hook({ sessionID: "ses-prose" }, { parts: [{ type: "text", text }] });
            }

            expect(execute).not.toHaveBeenCalled();
        } finally {
            closeQuietly(db);
        }
    });

    test("leaves native slash dispatch on the same handler adapter", async () => {
        const execute = mock(async () => undefined);
        const nativeHook = createCommandExecuteBeforeHook({ "command.execute.before": execute });
        const output = { parts: [{ type: "text", text: "" }] };

        await nativeHook(
            {
                command: "ctx-status",
                sessionID: "ses-native-command",
                arguments: "",
                agent: "build",
                variant: "high",
                providerID: "anthropic",
                modelID: "claude",
            },
            output,
        );

        expect(execute).toHaveBeenCalledWith(
            {
                command: "ctx-status",
                sessionID: "ses-native-command",
                arguments: "",
                agent: "build",
                variant: "high",
                providerID: "anthropic",
                modelID: "claude",
            },
            output,
            {
                agent: "build",
                variant: "high",
                providerId: "anthropic",
                modelId: "claude",
            },
        );
    });
});

// Variant-change flush must be provider-aware (#257). On providers whose wire
// renders the thinking config into the prompt (Anthropic family), the
// provider itself invalidates message blocks on a variant flip, so our flush
// rides a bust that happens regardless. On implicit-prefix-caching providers
// (OpenAI-compatible et al.), reasoning_effort/budget is a request parameter
// outside the cache key, so a variant flip is a full cache HIT and our flush
// would be the ONLY bust — a gratuitous one that drains queued ops for no
// provider-side reason. The gate defers the flush on the latter.
describe("createChatMessageHook variant-change flush is provider-aware", () => {
    type Sets = {
        historyRefreshSessions: Set<string>;
        systemPromptRefreshSessions: Set<string>;
        pendingMaterializationSessions: Set<string>;
        lastHeuristicsTurnId: Map<string, string>;
    };

    function makeHook(
        sets: Sets,
        liveModelBySession = new Map<string, { providerID: string; modelID: string }>(),
    ) {
        const db = createTestDb();
        const hook = createChatMessageHook({
            db,
            liveModelBySession,
            variantBySession: new Map<string, string | undefined>(),
            agentBySession: new Map<string, string>(),
            historyRefreshSessions: sets.historyRefreshSessions,
            systemPromptRefreshSessions: sets.systemPromptRefreshSessions,
            pendingMaterializationSessions: sets.pendingMaterializationSessions,
            lastHeuristicsTurnId: sets.lastHeuristicsTurnId,
        });
        return { hook, db };
    }

    function freshSets(): Sets {
        return {
            historyRefreshSessions: new Set<string>(),
            systemPromptRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
        };
    }

    // Pins current behavior on the Anthropic family. Deleting the predicate
    // call (so the gate always takes the TRUE arm) must leave this test green.
    test("anthropic provider: variant flip signals all three sets + clears lastHeuristicsTurnId", async () => {
        const sets = freshSets();
        sets.lastHeuristicsTurnId.set("ses", "turn-1");
        const { hook, db } = makeHook(sets);
        try {
            await hook({
                sessionID: "ses",
                variant: "low",
                model: { providerID: "anthropic", modelID: "claude" },
            });
            await hook({
                sessionID: "ses",
                variant: "high",
                model: { providerID: "anthropic", modelID: "claude" },
            });

            expect(sets.historyRefreshSessions.has("ses")).toBe(true);
            expect(sets.systemPromptRefreshSessions.has("ses")).toBe(true);
            expect(sets.pendingMaterializationSessions.has("ses")).toBe(true);
            expect(sets.lastHeuristicsTurnId.has("ses")).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("Fable 5.1 variant flip signals nothing and leaves pending materialization untouched", async () => {
        const sets = freshSets();
        sets.lastHeuristicsTurnId.set("ses", "turn-1");
        const { hook, db } = makeHook(sets);
        try {
            await hook({
                sessionID: "ses",
                variant: "high",
                model: { providerID: "anthropic", modelID: "claude-fable-5-1" },
            });
            await hook({
                sessionID: "ses",
                variant: "medium",
                model: { providerID: "anthropic", modelID: "claude-fable-5-1" },
            });

            expect(sets.historyRefreshSessions.size).toBe(0);
            expect(sets.systemPromptRefreshSessions.size).toBe(0);
            expect(sets.pendingMaterializationSessions.size).toBe(0);
            expect(sets.lastHeuristicsTurnId.get("ses")).toBe("turn-1");
        } finally {
            closeQuietly(db);
        }
    });

    test("bedrock provider: variant flip signals all three sets (thinking config rendered into prompt)", async () => {
        const sets = freshSets();
        const { hook, db } = makeHook(sets);
        try {
            await hook({
                sessionID: "ses",
                variant: "low",
                model: { providerID: "bedrock", modelID: "claude" },
            });
            await hook({
                sessionID: "ses",
                variant: "high",
                model: { providerID: "bedrock", modelID: "claude" },
            });

            expect(sets.historyRefreshSessions.has("ses")).toBe(true);
            expect(sets.systemPromptRefreshSessions.has("ses")).toBe(true);
            expect(sets.pendingMaterializationSessions.has("ses")).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test("google-vertex-anthropic provider: variant flip signals all three sets", async () => {
        const sets = freshSets();
        const { hook, db } = makeHook(sets);
        try {
            await hook({
                sessionID: "ses",
                variant: "low",
                model: { providerID: "google-vertex-anthropic", modelID: "claude" },
            });
            await hook({
                sessionID: "ses",
                variant: "high",
                model: { providerID: "google-vertex-anthropic", modelID: "claude" },
            });

            expect(sets.historyRefreshSessions.has("ses")).toBe(true);
            expect(sets.systemPromptRefreshSessions.has("ses")).toBe(true);
            expect(sets.pendingMaterializationSessions.has("ses")).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    // Mutation-sensitive: this test MUST FAIL if the predicate is hardcoded
    // true or the gate is removed. We assert the sets are EMPTY (not merely
    // "not containing extra members") to kill the deleted-effect mutant.
    test("openai provider: variant flip signals NOTHING and leaves lastHeuristicsTurnId untouched", async () => {
        const sets = freshSets();
        sets.lastHeuristicsTurnId.set("ses", "turn-1");
        const { hook, db } = makeHook(sets);
        try {
            await hook({
                sessionID: "ses",
                variant: "low",
                model: { providerID: "openai", modelID: "gpt-4o" },
            });
            await hook({
                sessionID: "ses",
                variant: "high",
                model: { providerID: "openai", modelID: "gpt-4o" },
            });

            expect(sets.historyRefreshSessions.size).toBe(0);
            expect(sets.systemPromptRefreshSessions.size).toBe(0);
            expect(sets.pendingMaterializationSessions.size).toBe(0);
            expect(sets.lastHeuristicsTurnId.get("ses")).toBe("turn-1");
        } finally {
            closeQuietly(db);
        }
    });

    test("fireworks provider: variant flip signals NOTHING (implicit-prefix cache, request param outside cache key)", async () => {
        const sets = freshSets();
        const { hook, db } = makeHook(sets);
        try {
            await hook({
                sessionID: "ses",
                variant: "low",
                model: { providerID: "fireworks", modelID: "fwm" },
            });
            await hook({
                sessionID: "ses",
                variant: "high",
                model: { providerID: "fireworks", modelID: "fwm" },
            });

            expect(sets.historyRefreshSessions.size).toBe(0);
            expect(sets.systemPromptRefreshSessions.size).toBe(0);
            expect(sets.pendingMaterializationSessions.size).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("unknown model tuple: variant flip defers rather than manufacturing a bust", async () => {
        const sets = freshSets();
        const { hook, db } = makeHook(sets);
        try {
            await hook({ sessionID: "ses", variant: "low" });
            await hook({ sessionID: "ses", variant: "high" });

            expect(sets.historyRefreshSessions.size).toBe(0);
            expect(sets.systemPromptRefreshSessions.size).toBe(0);
            expect(sets.pendingMaterializationSessions.size).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    // The liveModelBySession fallback: when the hook input has no model but a
    // prior event recorded the provider, the fallback providerID governs the
    // gate. An OpenAI-compatible provider recorded earlier must still defer.
    test("liveModelBySession fallback: openai recorded earlier, no model on input → defer (FALSE arm)", async () => {
        const sets = freshSets();
        const liveModelBySession = new Map<string, { providerID: string; modelID: string }>([
            ["ses", { providerID: "openai", modelID: "gpt-4o" }],
        ]);
        const { hook, db } = makeHook(sets, liveModelBySession);
        try {
            await hook({ sessionID: "ses", variant: "low" });
            await hook({ sessionID: "ses", variant: "high" });

            expect(sets.historyRefreshSessions.size).toBe(0);
            expect(sets.systemPromptRefreshSessions.size).toBe(0);
            expect(sets.pendingMaterializationSessions.size).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("no variant change: no sets signaled regardless of provider", async () => {
        const sets = freshSets();
        const { hook, db } = makeHook(sets);
        try {
            await hook({
                sessionID: "ses",
                variant: "high",
                model: { providerID: "openai", modelID: "gpt-4o" },
            });
            await hook({
                sessionID: "ses",
                variant: "high",
                model: { providerID: "openai", modelID: "gpt-4o" },
            });

            expect(sets.historyRefreshSessions.size).toBe(0);
            expect(sets.systemPromptRefreshSessions.size).toBe(0);
            expect(sets.pendingMaterializationSessions.size).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("createToolExecuteAfterHook Channel-1 dampening", () => {
    test("keeps the post-reduce specimen quiet until U regrows by a full delta", async () => {
        const db = createTestDb();
        const sessionId = "ses-channel1-drop-grace";
        const state: Channel1State = {
            baselineU: 30_000,
            baselineT: 72_000,
            turnDeltaU: 0,
            turnDeltaT: 0,
            usableWindow: 128_000,
            realUserTurnCount: 0,
            baselineGeneration: 2,
            computedAt: 1,
            evaluable: true,
            generationInvalidated: false,
            baselineParts: [],
            contentSignature: "pre-drop",
            reducedSinceRefresh: false,
            agentDropsAppliedThisPass: false,
            oldestReclaimableToolTags: [],
        };
        const hook = createToolExecuteAfterHook({
            db,
            channel1StateBySession: new Map([[sessionId, state]]),
        });
        const sessionLog = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});

        try {
            const first = { output: "first output" };
            await hook({ tool: "bash", sessionID: sessionId }, first);
            expect(first.output).toContain("Make a ctx_reduce pass now");
            expect(first.output).not.toContain("Still unstamped:");

            await hook({ tool: "ctx_reduce", sessionID: sessionId }, { output: "queued drops" });
            captureChannel1PostReduceGraceBaseline(db, sessionId, 60_000);
            Object.assign(state, {
                baselineU: 60_000,
                baselineT: 145_000,
                turnDeltaU: 0,
                turnDeltaT: 0,
                realUserTurnCount: 0,
                evaluable: true,
                generationInvalidated: false,
                reducedSinceRefresh: false,
                agentDropsAppliedThisPass: false,
                contentSignature: "post-drop",
            });
            const immediate = { output: "immediate next output" };
            await hook({ tool: "bash", sessionID: sessionId }, immediate);
            expect(immediate.output).toBe("immediate next output");

            Object.assign(state, { baselineU: 84_999, realUserTurnCount: 5, turnDeltaT: 0 });
            const almost = { output: "almost regrown" };
            await hook({ tool: "bash", sessionID: sessionId }, almost);
            expect(almost.output).toBe("almost regrown");

            Object.assign(state, { baselineU: 85_000, turnDeltaT: 0 });
            const regrown = { output: "regrown" };
            await hook({ tool: "bash", sessionID: sessionId }, regrown);
            expect(regrown.output).toContain("Still unstamped:");
            expect(regrown.output).not.toContain("before your next tool call");
            const evaluations = sessionLog.mock.calls
                .filter(
                    (call) =>
                        call[0] === sessionId && String(call[1]).startsWith("channel1 evaluation:"),
                )
                .map((call) => String(call[1]));
            expect(evaluations).toHaveLength(3);
            for (const evaluation of evaluations) {
                expect(evaluation).toContain(" U=");
                expect(evaluation).toContain(" T=");
                expect(evaluation).toContain(" ratio=");
                expect(evaluation).toContain(" band=");
                expect(evaluation).toContain(" growth_threshold=");
                expect(evaluation).toContain(" sticky_floor_turns_remaining=");
                expect(evaluation).toContain(" dampening=");
                expect(evaluation).toContain(" verdict=");
                expect(evaluation).toContain(" reason=");
            }
        } finally {
            sessionLog.mockRestore();
            closeQuietly(db);
        }
    });

    test("uses real user turns for sticky refires, expiration, and escalation", async () => {
        const db = createTestDb();
        const sessionId = "ses-channel1-dampening";
        const state = (
            baselineU: number,
            baselineT: number,
            realUserTurnCount: number,
        ): Channel1State => ({
            baselineU,
            baselineT,
            turnDeltaU: 0,
            turnDeltaT: 0,
            usableWindow: 128_000,
            realUserTurnCount,
            baselineGeneration: 1,
            computedAt: 1,
            evaluable: true,
            generationInvalidated: false,
            baselineParts: [],
            contentSignature: `baseline-${realUserTurnCount}`,
            reducedSinceRefresh: false,
            oldestReclaimableToolTags: [],
        });
        const realTurn = {
            info: { id: "real-user", role: "user" },
            parts: [{ type: "text", text: "continue working" }],
        } as unknown as MessageLike;
        const sameTurnWithSyntheticRows = [
            realTurn,
            {
                info: { id: "reminder", role: "user", summary: true },
                parts: [{ type: "text", text: "<system-reminder>stale board</system-reminder>" }],
            },
            {
                info: { role: "user" },
                parts: [{ type: "text", text: "channel two", synthetic: true }],
            },
        ] as unknown as MessageLike[];
        const firstTurnCount = countRealUserMessages([realTurn]);
        const channel1StateBySession = new Map<string, Channel1State>([
            [sessionId, state(50_000, 120_000, firstTurnCount)],
        ]);
        const hook = createToolExecuteAfterHook({ db, channel1StateBySession });

        try {
            const first = { output: "first output" };
            await hook({ tool: "bash", sessionID: sessionId }, first);
            expect(first.output).toContain(
                "spent tool outputs (~50k tokens) are reclaimable. Make a ctx_reduce pass now",
            );
            const frozenFirst = first.output;
            await hook({ tool: "bash", sessionID: sessionId }, first);
            expect(first.output).toBe(frozenFirst);

            // Live repro: two injected user rows arrive before a same-turn refire.
            const sameTurnCount = countRealUserMessages(sameTurnWithSyntheticRows);
            expect(sameTurnCount).toBe(firstTurnCount);
            channel1StateBySession.set(sessionId, state(80_000, 180_000, sameTurnCount));
            const sameTurn = { output: "second output" };
            await hook({ tool: "bash", sessionID: sessionId }, sameTurn);
            expect(sameTurn.output).toBe("second output");

            const threeLater = Array.from({ length: 4 }, (_, index) => ({
                info: { id: `real-user-${index}`, role: "user" },
                parts: [{ type: "text", text: "continue" }],
            })) as unknown as MessageLike[];
            channel1StateBySession.set(
                sessionId,
                state(110_000, 240_000, countRealUserMessages(threeLater)),
            );
            const beforeFiveTurns = { output: "third output" };
            await hook({ tool: "bash", sessionID: sessionId }, beforeFiveTurns);
            expect(beforeFiveTurns.output).toBe("third output");

            channel1StateBySession.set(sessionId, state(110_000, 240_000, 6));
            const sticky = { output: "five turns later" };
            await hook({ tool: "bash", sessionID: sessionId }, sticky);
            expect(sticky.output).toContain(
                "Still unstamped: spent tool outputs (~110k tokens). Stamp the ones you've used",
            );
            expect(sticky.output).not.toContain("before your next tool call");

            channel1StateBySession.set(sessionId, state(120_000, 180_000, 6));
            const escalation = { output: "fourth output" };
            await hook({ tool: "bash", sessionID: sessionId }, escalation);
            expect(escalation.output).toContain(
                "spent tool outputs (~120k tokens) are still unstamped. Call ctx_reduce now, before your next tool call",
            );
            expect(escalation.output).not.toContain("Still unstamped: spent tool outputs");
        } finally {
            closeQuietly(db);
        }
    });

    test("expires a legacy raw ordinal before writing the real-user counter", async () => {
        const db = createTestDb();
        const sessionId = "ses-channel1-legacy-ordinal";
        const state: Channel1State = {
            baselineU: 80_000,
            baselineT: 180_000,
            turnDeltaU: 0,
            turnDeltaT: 0,
            usableWindow: 128_000,
            realUserTurnCount: 1,
            baselineGeneration: 1,
            computedAt: 1,
            evaluable: true,
            generationInvalidated: false,
            baselineParts: [],
            contentSignature: "legacy",
            reducedSinceRefresh: false,
            oldestReclaimableToolTags: [],
        };
        getOrCreateSessionMeta(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET last_nudge_undropped = ?, last_nudge_level = ? WHERE session_id = ?",
        ).run(50_000, '{"level":"firm","ordinal":160750}', sessionId);
        const hook = createToolExecuteAfterHook({
            db,
            channel1StateBySession: new Map([[sessionId, state]]),
        });

        try {
            const output = { output: "legacy output" };
            await hook({ tool: "bash", sessionID: sessionId }, output);
            expect(output.output).toContain(
                "Still unstamped: spent tool outputs (~80k tokens). Stamp the ones you've used",
            );
            expect(
                db
                    .prepare("SELECT last_nudge_level FROM session_meta WHERE session_id = ?")
                    .get(sessionId),
            ).toEqual({ last_nudge_level: '{"level":"firm","ordinal":1}' });
        } finally {
            closeQuietly(db);
        }
    });
});
