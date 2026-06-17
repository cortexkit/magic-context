/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { insertSkillMemoryNote } from "../../features/magic-context/skill-memory/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import {
    getOverflowState,
    recordOverflowDetected,
} from "../../features/magic-context/storage-meta-persisted";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    createChatMessageHook,
    createEventHook,
    createToolExecuteAfterHook,
    maybeInjectSkillMemory,
} from "./hook-handlers";

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

const CFG = {
    enabled: true as const,
    max_tokens: 1500,
    max_pinned_tokens: 4000,
    dedup_threshold: 0.92,
};

function createTestHook(db: Database): ReturnType<typeof createToolExecuteAfterHook> {
    return createToolExecuteAfterHook({
        db,
        channel1StateBySession: new Map(),
        skillLoadRegistry: new Map(),
        sessionDirectoryBySession: new Map(),
        defaultDirectory: "/tmp/test",
        intentByCallId: new Map(),
    });
}

describe("createToolExecuteAfterHook todo snapshots", () => {
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

    test("foreign todowrite statuses leave state unchanged", async () => {
        const db = createTestDb();
        try {
            const hook = createTestHook(db);
            updateSessionMeta(db, "ses-foreign", { lastTodoState: "[]" });

            await hook({
                tool: "todowrite",
                sessionID: "ses-foreign",
                args: { todos: [{ content: "Third-party", status: "done" }] },
            });

            expect(getOrCreateSessionMeta(db, "ses-foreign").lastTodoState).toBe("[]");
        } finally {
            closeQuietly(db);
        }
    });

    test("missing or non-array todowrite todos leave state unchanged", async () => {
        const db = createTestDb();
        try {
            const hook = createTestHook(db);
            updateSessionMeta(db, "ses-malformed", { lastTodoState: "[]" });

            await hook({
                tool: "todowrite",
                sessionID: "ses-malformed",
                args: {},
            });
            await hook({
                tool: "todowrite",
                sessionID: "ses-malformed",
                args: { todos: { content: "Not an array", status: "pending" } },
            });

            expect(getOrCreateSessionMeta(db, "ses-malformed").lastTodoState).toBe("[]");
        } finally {
            closeQuietly(db);
        }
    });

    test("malformed todowrite args leave state unchanged", async () => {
        const db = createTestDb();
        try {
            const hook = createTestHook(db);
            updateSessionMeta(db, "ses-malformed", { lastTodoState: "[]" });

            await hook({
                tool: "todowrite",
                sessionID: "ses-malformed",
                args: { todos: [{ content: "Missing status" }] },
            });

            expect(getOrCreateSessionMeta(db, "ses-malformed").lastTodoState).toBe("[]");
        } finally {
            closeQuietly(db);
        }
    });
});

describe("createEventHook mid-session model switch clears overflow state", () => {
    function makeAssistantEvent(sessionID: string, providerID: string, modelID: string) {
        return {
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        sessionID,
                        id: `msg-${Math.random().toString(36).slice(2)}`,
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
                protectedTags: 5,
            });

            // First assistant response on the small-context model.
            await hook(makeAssistantEvent(sessionId, "anthropic", "claude-small"));
            // Session overflowed on the small model → records a detected limit + arms recovery.
            recordOverflowDetected(db, sessionId, 120_000);
            let overflow = getOverflowState(db, sessionId);
            expect(overflow.detectedContextLimit).toBe(120_000);
            expect(overflow.needsEmergencyRecovery).toBe(true);

            // User switches to a 1M-context model mid-session — next assistant event
            // carries the new model. The handler must clear BOTH the stale detected
            // limit and the recovery flag so the new model's pressure math is clean.
            await hook(makeAssistantEvent(sessionId, "anthropic", "claude-large"));
            overflow = getOverflowState(db, sessionId);
            expect(overflow.detectedContextLimit).toBe(0);
            expect(overflow.needsEmergencyRecovery).toBe(false);
        } finally {
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
                protectedTags: 5,
            });

            await hook(makeAssistantEvent(sessionId, "anthropic", "claude-small"));
            recordOverflowDetected(db, sessionId, 120_000);
            // Same model again — detected limit must persist (authoritative on this model).
            await hook(makeAssistantEvent(sessionId, "anthropic", "claude-small"));
            const overflow = getOverflowState(db, sessionId);
            expect(overflow.detectedContextLimit).toBe(120_000);
            expect(overflow.needsEmergencyRecovery).toBe(true);
        } finally {
            closeQuietly(db);
        }
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

    // Unknown provider (no model info on the hook input) takes the
    // conservative TRUE arm = today's behavior.
    test("unknown provider (no model info): variant flip takes the TRUE arm (all three sets signaled)", async () => {
        const sets = freshSets();
        const { hook, db } = makeHook(sets);
        try {
            await hook({ sessionID: "ses", variant: "low" });
            await hook({ sessionID: "ses", variant: "high" });

            expect(sets.historyRefreshSessions.has("ses")).toBe(true);
            expect(sets.systemPromptRefreshSessions.has("ses")).toBe(true);
            expect(sets.pendingMaterializationSessions.has("ses")).toBe(true);
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

describe("maybeInjectSkillMemory intent threading", () => {
    test("maybeInjectSkillMemory threads intent → FTS rung (vs no-intent without it)", async () => {
        const db = createTestDb();
        try {
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p/SKILL.md",
                tier: "global",
                skillSource: "opencode-global",
                projectIdentity: "git:abc",
                intent: "fix the auth flake",
                kind: "fix",
                delta: "stub the clock",
                normalizedHash: "h1",
                createdAt: Date.now(),
            });
            const withIntent = { output: "# tool result" };
            await maybeInjectSkillMemory(db, "tdd", "global", "git:abc", CFG, withIntent, "auth");
            expect(withIntent.output).toContain('mode="fts5-fallback"');
            const noIntent = { output: "# tool result" };
            await maybeInjectSkillMemory(db, "tdd", "global", "git:abc", CFG, noIntent, undefined);
            expect(noIntent.output).toContain('mode="no-intent"');
        } finally {
            closeQuietly(db);
        }
    });
});
