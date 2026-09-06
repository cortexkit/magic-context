/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordMessageFtsRowid } from "../../features/magic-context/message-fts-rowid-map";
import {
    __resetMessageIndexAsyncForTests,
    isSessionReconciled,
} from "../../features/magic-context/message-index-async";
import { recordSessionProjectIdentity } from "../../features/magic-context/session-project-storage";
import {
    applyStrippedPlaceholderDelta,
    closeDatabase,
    getHiddenSeamPlaceholderIds,
    getHistorianFailureState,
    getMaxCompressionDepth,
    getOrCreateSessionMeta,
    getStrippedPlaceholderIds,
    getTagsBySession,
    incrementCompressionDepth,
    incrementHistorianFailure,
    insertTag,
    markSessionCleanupPending,
    openDatabase,
    retryPendingRustSessionCleanupsForProject,
    retryPendingSessionCleanups,
    setStrippedPlaceholderIds,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    appendAutoSearchHintDecision,
    appendNoteNudgeAnchor,
    getAutoSearchHintDecisions,
    getNoteNudgeAnchors,
    getPersistedNoteNudge,
    getThinkingBindingRecoveryTarget,
} from "../../features/magic-context/storage-meta-persisted";
import {
    normalizeMaterializeReason,
    recordPendingPiTransformDecision,
    recordPendingTransformDecision,
    schedulePiTransformDecisionResolve,
    __test as transformDecisionLogTest,
} from "../../features/magic-context/transform-decision-log";
import type { ContextUsage } from "../../features/magic-context/types";
import { getWindowReportsPath } from "../../features/magic-context/window-report-ledger";
import { createEventHandler as createPluginEventHandler } from "../../plugin/event";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { createEventHandler } from "./event-handler";

type ContextUsageCacheEntry = {
    usage: ContextUsage;
    updatedAt: number;
    lastResponseTime?: number;
    hasUsageTokens?: boolean;
};

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    __resetMessageIndexAsyncForTests();
    transformDecisionLogTest.reset();
    closeDatabase();
    clearModelsDevCache();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    }
    tempDirs.length = 0;
});

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function useTempDataHome(prefix: string): void {
    process.env.XDG_DATA_HOME = makeTempDir(prefix);
}

function resolveContextLimit(): number {
    // Tests don't specify providerID/modelID in most events, so the real
    // resolveContextLimit falls through to DEFAULT_CONTEXT_LIMIT = 200_000.
    return 200_000;
}

function countIndexedMessages(sessionId: string, messageId: string): number {
    const row = openDatabase()
        .prepare(
            "SELECT COUNT(*) AS count FROM message_history_fts WHERE session_id = ? AND message_id = ?",
        )
        .get(sessionId, messageId) as { count?: number } | null;

    return typeof row?.count === "number" ? row.count : 0;
}

function countSessionMetaRows(sessionId: string): number {
    const row = openDatabase()
        .prepare("SELECT COUNT(*) AS count FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { count?: number } | null;

    return typeof row?.count === "number" ? row.count : 0;
}

function countMessageIndexRows(sessionId: string): number {
    const row = openDatabase()
        .prepare("SELECT COUNT(*) AS count FROM message_history_index WHERE session_id = ?")
        .get(sessionId) as { count?: number } | null;

    return typeof row?.count === "number" ? row.count : 0;
}

function waitForTimers(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T = void>(): {
    promise: Promise<T>;
    resolve: (value?: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
} {
    let resolve!: (value?: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = (value) => res(value as T | PromiseLike<T>);
        reject = rej;
    });
    return { promise, resolve, reject };
}

function createDeps(contextUsageMap: Map<string, ContextUsageCacheEntry>) {
    return {
        contextUsageMap,
        compactionHandler: { onCompacted: mock(() => {}) },
        config: {
            protected_tags: 5,
            cache_ttl: "5m" as string | Record<string, string>,
        },
        tagger: {
            assignTag: mock(() => 0),
            bindTag: mock(() => {}),
            getTag: mock(() => undefined),
            getAssignments: mock(() => new Map()),
            resetCounter: mock(() => {}),
            getCounter: mock(() => 0),
            initFromDb: mock(() => {}),
            cleanup: mock(() => {}),
        },
        db: openDatabase(),
        client: {},
    };
}

function providersClient(limit: number, prompt?: ReturnType<typeof mock>) {
    return {
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: "test-provider",
                            models: {
                                "test-model": { limit: { context: limit } },
                            },
                        },
                    ],
                },
            }),
        },
        session: prompt ? { prompt } : undefined,
    };
}

describe("createEventHandler", () => {
    it("arms documented Fable 5.1 binding mismatch recovery and ignores other models", async () => {
        useTempDataHome("context-event-thinking-binding-");
        const deps = createDeps(new Map());
        const handler = createEventHandler(deps);
        const error = {
            status: 400,
            error: {
                type: "invalid_request_error",
                message:
                    'messages.4.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".',
            },
        };

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        id: "failed-shell",
                        role: "assistant",
                        sessionID: "ses-fable-51",
                        providerID: "anthropic",
                        modelID: "fable-5-1-20260831",
                        error,
                    },
                },
            },
        });
        expect(getThinkingBindingRecoveryTarget(deps.db, "ses-fable-51")).toBe(
            "newest_reasoning_bearing_assistant",
        );

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        id: "other-failed-shell",
                        role: "assistant",
                        sessionID: "ses-other-model",
                        providerID: "anthropic",
                        modelID: "fable-5-0",
                        error,
                    },
                },
            },
        });
        expect(getThinkingBindingRecoveryTarget(deps.db, "ses-other-model")).toBeNull();
    });

    it("normalizes transform decision reasons across harnesses", () => {
        expect(normalizeMaterializeReason("opencode", "system_hash", true)).toBe("system_hash");
        expect(normalizeMaterializeReason("opencode", null, true)).toBe("pressure_refold");
        expect(normalizeMaterializeReason("pi", "project_memory_change", true)).toBe(
            "project_memory_epoch",
        );
        expect(normalizeMaterializeReason("pi", "pending_mutations", true)).toBe("max_mutation_id");
        expect(normalizeMaterializeReason("pi", "renderer_upgrade", true)).toBe("upgrade_state");
        expect(normalizeMaterializeReason("pi", "cache_invalid", true)).toBe("cached_m1_missing");
        expect(normalizeMaterializeReason("pi", "drift", true)).toBe("pressure_refold");
        expect(normalizeMaterializeReason("opencode", "comparting", true)).toBeNull();
    });

    it("records pending transform decisions only for busted passes", () => {
        recordPendingTransformDecision("ses-decision", {
            tsMs: 1,
            decision: "defer",
            materialized: false,
            materializeReason: null,
            systemHashPrev: null,
            systemHashNew: null,
            m0ModelKeyPrev: null,
            m0ModelKeyNew: null,
            emergency: false,
            droppedTokens: 0,
            droppedCount: 0,
            inputTokens: 0,
            bustedThisPass: false,
        });
        expect(transformDecisionLogTest.getPending("ses-decision")).toBeUndefined();

        recordPendingTransformDecision("ses-decision", {
            tsMs: 2,
            decision: "execute",
            materialized: true,
            materializeReason: "ttl_idle",
            systemHashPrev: null,
            systemHashNew: null,
            m0ModelKeyPrev: null,
            m0ModelKeyNew: null,
            emergency: false,
            droppedTokens: 0,
            droppedCount: 1,
            inputTokens: 100,
            bustedThisPass: true,
        });
        expect(transformDecisionLogTest.getPending("ses-decision")?.materializeReason).toBe(
            "ttl_idle",
        );

        recordPendingTransformDecision("ses-decision", {
            tsMs: 3,
            decision: "defer",
            materialized: false,
            materializeReason: null,
            systemHashPrev: null,
            systemHashNew: null,
            m0ModelKeyPrev: null,
            m0ModelKeyNew: null,
            emergency: false,
            droppedTokens: 0,
            droppedCount: 0,
            inputTokens: 0,
            bustedThisPass: false,
        });
        expect(transformDecisionLogTest.getPending("ses-decision")).toBeUndefined();
    });

    it("writes a terminal assistant transform decision under the message id", async () => {
        useTempDataHome("context-event-transform-decision-write-");
        const deps = createDeps(new Map());
        const handler = createEventHandler(deps);
        recordPendingTransformDecision("ses-decision-write", {
            tsMs: 123,
            decision: "execute",
            materialized: true,
            materializeReason: "explicit_flush",
            systemHashPrev: null,
            systemHashNew: null,
            m0ModelKeyPrev: null,
            m0ModelKeyNew: null,
            emergency: false,
            droppedTokens: 0,
            droppedCount: 2,
            inputTokens: 1,
            bustedThisPass: true,
        });

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        id: "msg-decision-write",
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-decision-write",
                        tokens: { input: 100, cache: { read: 10, write: 5 } },
                    },
                },
            },
        });
        await waitForTimers();

        const row = openDatabase()
            .prepare(
                "SELECT session_id, harness, message_id, decision, materialize_reason, dropped_count, input_tokens FROM transform_decisions WHERE session_id = ?",
            )
            .get("ses-decision-write");
        expect(row).toEqual({
            session_id: "ses-decision-write",
            harness: "opencode",
            message_id: "msg-decision-write",
            decision: "execute",
            materialize_reason: "explicit_flush",
            dropped_count: 2,
            input_tokens: 115,
        });
    });

    it("does not write a transform decision for a defer/cache-hit pass", async () => {
        useTempDataHome("context-event-transform-decision-defer-");
        const handler = createEventHandler(createDeps(new Map()));
        recordPendingTransformDecision("ses-decision-defer", {
            tsMs: 1,
            decision: "defer",
            materialized: false,
            materializeReason: null,
            systemHashPrev: null,
            systemHashNew: null,
            m0ModelKeyPrev: null,
            m0ModelKeyNew: null,
            emergency: false,
            droppedTokens: 0,
            droppedCount: 0,
            inputTokens: 0,
            bustedThisPass: false,
        });

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        id: "msg-decision-defer",
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-decision-defer",
                        tokens: { input: 100, cache: { read: 10, write: 0 } },
                    },
                },
            },
        });
        await waitForTimers();

        const row = openDatabase()
            .prepare("SELECT COUNT(*) AS count FROM transform_decisions WHERE session_id = ?")
            .get("ses-decision-defer") as { count: number };
        expect(row.count).toBe(0);
    });

    it("swallows transform decision insert errors", async () => {
        useTempDataHome("context-event-transform-decision-error-");
        const handler = createEventHandler(createDeps(new Map()));
        transformDecisionLogTest.setWriterForTests(() => {
            throw new Error("forced insert failure");
        });
        recordPendingTransformDecision("ses-decision-error", {
            tsMs: 1,
            decision: "execute",
            materialized: false,
            materializeReason: null,
            emergency: true,
            droppedTokens: 0,
            droppedCount: 1,
            inputTokens: 0,
            bustedThisPass: true,
        });

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        id: "msg-decision-error",
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-decision-error",
                        tokens: { input: 1, cache: { read: 0, write: 0 } },
                    },
                },
            },
        });
        await waitForTimers();

        expect(transformDecisionLogTest.getPending("ses-decision-error")).toBeUndefined();
    });

    it("resolves a Pi transform decision on the next pass using SessionEntry ids", async () => {
        useTempDataHome("context-event-transform-decision-pi-");
        const db = openDatabase();
        recordPendingPiTransformDecision(
            "ses-pi-decision",
            {
                tsMs: 1,
                decision: "execute",
                materialized: true,
                materializeReason: "pressure_refold",
                systemHashPrev: null,
                systemHashNew: null,
                m0ModelKeyPrev: null,
                m0ModelKeyNew: null,
                emergency: false,
                droppedTokens: 0,
                droppedCount: 3,
                inputTokens: 456,
                bustedThisPass: true,
            },
            "entry-before",
        );

        schedulePiTransformDecisionResolve({
            db,
            sessionId: "ses-pi-decision",
            branchEntries: [
                { id: "entry-user", type: "message", message: { role: "user" } },
                { id: "entry-before", type: "message", message: { role: "assistant" } },
                { id: "entry-after", type: "message", message: { role: "assistant" } },
            ],
        });
        await waitForTimers();

        const row = db
            .prepare(
                "SELECT harness, message_id, materialize_reason, dropped_count, input_tokens FROM transform_decisions WHERE session_id = ?",
            )
            .get("ses-pi-decision");
        expect(row).toEqual({
            harness: "pi",
            message_id: "entry-after",
            materialize_reason: "pressure_refold",
            dropped_count: 3,
            input_tokens: 456,
        });
    });

    it("keeps root sessions out of reduced mode", async () => {
        useTempDataHome("context-event-root-session-");
        const handler = createEventHandler(createDeps(new Map()));

        await handler({
            event: {
                type: "session.created",
                properties: { info: { id: "ses-root", parentID: "" } },
            },
        });

        expect(getOrCreateSessionMeta(openDatabase(), "ses-root").isSubagent).toBe(false);
    });

    it("marks child sessions as subagents", async () => {
        useTempDataHome("context-event-created-");
        const handler = createEventHandler(createDeps(new Map()));

        await handler({
            event: {
                type: "session.created",
                properties: { info: { id: "ses-child", parentID: "ses-parent" } },
            },
        });

        expect(getOrCreateSessionMeta(openDatabase(), "ses-child").isSubagent).toBe(true);
    });

    it("flags our own hidden children by the magic-context- title prefix", async () => {
        useTempDataHome("context-event-internal-child-");
        const internalChildSessions = new Set<string>();
        const handler = createEventHandler({
            ...createDeps(new Map()),
            internalChildSessions,
        });

        // A magic-context child (historian/dreamer/sidekick/migration title).
        await handler({
            event: {
                type: "session.created",
                properties: {
                    info: {
                        id: "ses-hist",
                        parentID: "ses-parent",
                        title: "magic-context-compartment",
                    },
                },
            },
        });
        // A generic OpenCode subagent (task() child) — NOT ours.
        await handler({
            event: {
                type: "session.created",
                properties: {
                    info: { id: "ses-task", parentID: "ses-parent", title: "Explore the codebase" },
                },
            },
        });
        // A root session — never flagged.
        await handler({
            event: {
                type: "session.created",
                properties: {
                    info: { id: "ses-root2", parentID: "", title: "magic-context-compartment" },
                },
            },
        });

        expect(internalChildSessions.has("ses-hist")).toBe(true);
        expect(internalChildSessions.has("ses-task")).toBe(false);
        // parentID empty → not a child, never flagged even with our title.
        expect(internalChildSessions.has("ses-root2")).toBe(false);
    });

    it("tracks assistant token usage and updates lastResponseTime", async () => {
        useTempDataHome("context-event-message-updated-");
        const contextUsageMap = new Map<string, ContextUsageCacheEntry>();
        const handler = createEventHandler(createDeps(contextUsageMap));
        const before = Date.now();

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-usage",
                        tokens: {
                            input: 120_000,
                            output: 900,
                            reasoning: 0,
                            cache: { read: 15_000, write: 0 },
                        },
                    },
                },
            },
        });

        const usageEntry = contextUsageMap.get("ses-usage");
        const expectedPercentage = ((120_000 + 15_000) / resolveContextLimit()) * 100;
        expect(usageEntry?.usage.inputTokens).toBe(135_000);
        expect(usageEntry?.usage.percentage).toBeCloseTo(expectedPercentage, 5);
        expect(usageEntry?.hasUsageTokens).toBe(true);
        expect(usageEntry?.lastResponseTime).toBeGreaterThanOrEqual(before);
        expect(
            getOrCreateSessionMeta(openDatabase(), "ses-usage").lastResponseTime,
        ).toBeGreaterThanOrEqual(before);
        expect(getOrCreateSessionMeta(openDatabase(), "ses-usage").observedSafeInputTokens).toBe(
            135_000,
        );
    });

    it("recovers silently when a cache-regressed context limit is fixed by refresh", async () => {
        useTempDataHome("context-event-cache-regression-recovered-");
        const contextUsageMap = new Map<string, ContextUsageCacheEntry>();
        await refreshModelLimitsFromApi(providersClient(100_000));
        const deps = createDeps(contextUsageMap);
        deps.client = providersClient(100_000);
        const handler = createEventHandler(deps);

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-regression-recovered",
                        providerID: "test-provider",
                        modelID: "test-model",
                        tokens: { input: 80_000, cache: { read: 0, write: 0 } },
                    },
                },
            },
        });
        // Regress to a smaller (wrong) but still SANE limit — a sub-20k value is
        // now rejected outright by the limit resolver's sanity floor, so the
        // regression scenario must use a value inside [20k, 3M].
        await refreshModelLimitsFromApi(providersClient(30_000));

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-regression-recovered",
                        providerID: "test-provider",
                        modelID: "test-model",
                        tokens: { input: 90_000, cache: { read: 0, write: 0 } },
                    },
                },
            },
        });

        const meta = getOrCreateSessionMeta(openDatabase(), "ses-regression-recovered");
        expect(meta.lastContextPercentage).toBe(90);
        expect(meta.observedSafeInputTokens).toBe(90_000);
        expect(meta.cacheAlertSent).toBe(false);
        expect(contextUsageMap.get("ses-regression-recovered")?.usage.percentage).toBe(90);
    });

    it("alerts once when a cache-regressed context limit stays wrong after refresh", async () => {
        useTempDataHome("context-event-cache-regression-alert-");
        const contextUsageMap = new Map<string, ContextUsageCacheEntry>();
        await refreshModelLimitsFromApi(providersClient(100_000));
        const prompt = mock(async () => ({}));
        const deps = createDeps(contextUsageMap);
        // A wrong-but-still-SANE small limit (30k): sub-20k values are now rejected
        // by the resolver's sanity floor, so the "stays wrong after refresh"
        // scenario uses a limit inside [20k, 3M] that is still smaller than the
        // tokens the model successfully accepted.
        deps.client = providersClient(30_000, prompt);
        const handler = createEventHandler(deps);

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-regression-alert",
                        providerID: "test-provider",
                        modelID: "test-model",
                        tokens: { input: 80_000, cache: { read: 0, write: 0 } },
                    },
                },
            },
        });
        await refreshModelLimitsFromApi(providersClient(30_000));

        for (const inputTokens of [90_000, 120_000]) {
            await handler({
                event: {
                    type: "message.updated",
                    properties: {
                        info: {
                            role: "assistant",
                            finish: "stop",
                            sessionID: "ses-regression-alert",
                            providerID: "test-provider",
                            modelID: "test-model",
                            tokens: { input: inputTokens, cache: { read: 0, write: 0 } },
                        },
                    },
                },
            });
        }

        const meta = getOrCreateSessionMeta(openDatabase(), "ses-regression-alert");
        expect(meta.cacheAlertSent).toBe(true);
        expect(meta.lastContextPercentage).toBe(400);
        expect(prompt).toHaveBeenCalledTimes(1);
        const call = prompt.mock.calls[0]?.[0] as { body?: { parts?: Array<{ text?: string }> } };
        expect(call.body?.parts?.[0]?.text).toContain("context limit of 30,000 tokens");
        expect(call.body?.parts?.[0]?.text).toContain("successfully sent 90,000 tokens");
    });

    it("does not mark the cache alert sent when notification delivery fails", async () => {
        useTempDataHome("context-event-cache-regression-alert-failed-");
        const contextUsageMap = new Map<string, ContextUsageCacheEntry>();
        await refreshModelLimitsFromApi(providersClient(100_000));
        const prompt = mock(async () => {
            throw new Error("notification transport down");
        });
        const deps = createDeps(contextUsageMap);
        deps.client = providersClient(30_000, prompt);
        const handler = createEventHandler(deps);

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-regression-alert-failed",
                        providerID: "test-provider",
                        modelID: "test-model",
                        tokens: { input: 80_000, cache: { read: 0, write: 0 } },
                    },
                },
            },
        });
        await refreshModelLimitsFromApi(providersClient(30_000));

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-regression-alert-failed",
                        providerID: "test-provider",
                        modelID: "test-model",
                        tokens: { input: 90_000, cache: { read: 0, write: 0 } },
                    },
                },
            },
        });

        const meta = getOrCreateSessionMeta(openDatabase(), "ses-regression-alert-failed");
        expect(prompt).toHaveBeenCalledTimes(1);
        expect(meta.cacheAlertSent).toBe(false);
    });

    it("refreshes ttl for tokenless assistant updates when prior usage exists", async () => {
        useTempDataHome("context-event-partial-update-");
        const preservedUpdatedAt = Date.now();
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>([
            [
                "ses-partial",
                { usage: { percentage: 61, inputTokens: 122_000 }, updatedAt: preservedUpdatedAt },
            ],
        ]);
        const deps = createDeps(contextUsageMap);
        updateSessionMeta(deps.db, "ses-partial", {
            lastResponseTime: 5_000,
            cacheTtl: "1m",
            lastContextPercentage: 61,
            lastInputTokens: 122_000,
        });
        deps.config.cache_ttl = { default: "5m", "openai/gpt-4o": "1m" };
        const handler = createEventHandler(deps);

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        sessionID: "ses-partial",
                        modelID: "gpt-4o",
                    },
                },
            },
        });

        const meta = getOrCreateSessionMeta(openDatabase(), "ses-partial");
        expect(meta.cacheTtl).toBe("1m");
        expect(meta.lastContextPercentage).toBe(61);
        expect(meta.lastInputTokens).toBe(122_000);
        expect(contextUsageMap.get("ses-partial")).toEqual({
            usage: { percentage: 61, inputTokens: 122_000 },
            updatedAt: preservedUpdatedAt,
        });
    });

    it("ignores tokenless assistant updates when no prior usage exists", async () => {
        useTempDataHome("context-event-no-finish-");
        const handler = createEventHandler(createDeps(new Map()));

        await handler({
            event: {
                type: "message.updated",
                properties: { info: { role: "assistant", sessionID: "ses-no-finish" } },
            },
        });

        expect(getOrCreateSessionMeta(openDatabase(), "ses-no-finish").lastResponseTime).toBe(0);
    });

    it("ignores all-zero token events that would overwrite valid usage", async () => {
        useTempDataHome("context-event-zero-tokens-");
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>([
            [
                "ses-zero",
                { usage: { percentage: 62, inputTokens: 124_000 }, updatedAt: Date.now() },
            ],
        ]);
        const handler = createEventHandler(createDeps(contextUsageMap));

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        sessionID: "ses-zero",
                        tokens: { input: 0, cache: { read: 0, write: 0 } },
                    },
                },
            },
        });

        const entry = contextUsageMap.get("ses-zero");
        expect(entry?.usage.percentage).toBe(62);
        expect(entry?.usage.inputTokens).toBe(124_000);
    });

    it("resolves model-specific cache ttl via per-model config", async () => {
        useTempDataHome("context-event-provider-model-");
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>();
        const deps = createDeps(contextUsageMap);
        deps.config.cache_ttl = { default: "5m", "gpt-4o": "1m" };
        const handler = createEventHandler(deps);

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-model",
                        providerID: "openai",
                        modelID: "gpt-4o",
                        tokens: { input: 100_000, cache: { read: 100_000, write: 0 } },
                    },
                },
            },
        });

        // Context-limit resolution is covered by event-resolvers.test.ts; here we
        // validate that per-model cache_ttl is applied via the shared event path.
        expect(getOrCreateSessionMeta(openDatabase(), "ses-model").cacheTtl).toBe("1m");
    });

    it("does not arm compartmenting for subagent sessions", async () => {
        useTempDataHome("context-event-subagent-no-compartment-");
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>();
        const deps = createDeps(contextUsageMap);
        updateSessionMeta(deps.db, "ses-bg", {
            isSubagent: true,
            lastContextPercentage: 64,
            timesExecuteThresholdReached: 2,
        });
        const handler = createEventHandler(deps);

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        sessionID: "ses-bg",
                        tokens: { input: 120_000, cache: { read: 12_000, write: 0 } },
                    },
                },
            },
        });

        const meta = getOrCreateSessionMeta(openDatabase(), "ses-bg");
        expect(meta.compartmentInProgress).toBe(false);
        expect(meta.timesExecuteThresholdReached).toBe(2);
        expect(meta.lastContextPercentage).toBeGreaterThan(65);
    });

    it("clears historian failure state once usage drops below 90%", async () => {
        useTempDataHome("context-event-clear-historian-failure-");
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>();
        const deps = createDeps(contextUsageMap);
        incrementHistorianFailure(deps.db, "ses-historian-failure", "429 rate limit");
        const handler = createEventHandler(deps);

        // Use tokens that put usage well below 90% of 128K default context limit
        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-historian-failure",
                        tokens: {
                            input: 80_000,
                            output: 0,
                            reasoning: 0,
                            cache: { read: 0, write: 0 },
                        },
                    },
                },
            },
        });

        expect(getHistorianFailureState(openDatabase(), "ses-historian-failure")).toEqual({
            failureCount: 0,
            lastError: null,
            lastFailureAt: null,
        });
    });

    it("handles compaction and session cleanup lifecycle events", async () => {
        useTempDataHome("context-event-lifecycle-");
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>([
            [
                "ses-clean",
                { usage: { percentage: 70, inputTokens: 140_000 }, updatedAt: Date.now() },
            ],
        ]);
        const deps = createDeps(contextUsageMap);
        const onCompacted = deps.compactionHandler.onCompacted;
        const taggerCleanup = deps.tagger.cleanup;
        const onSessionDeleted = mock(() => {});
        const handler = createEventHandler({ ...deps, onSessionDeleted });

        insertTag(deps.db, "ses-clean", "m-1", "message", 100, 1);
        incrementCompressionDepth(deps.db, "ses-clean", 1, 3);
        updateSessionMeta(deps.db, "ses-clean", { lastNudgeTokens: 20_000, isSubagent: true });

        await handler({
            event: {
                type: "session.compacted",
                properties: { sessionID: "ses-clean" },
            },
        });
        await handler({
            event: {
                type: "session.deleted",
                properties: { info: { id: "ses-clean" } },
            },
        });

        expect(onCompacted).toHaveBeenCalledWith("ses-clean", expect.anything());
        expect(contextUsageMap.has("ses-clean")).toBe(false);
        expect(taggerCleanup).toHaveBeenCalledWith("ses-clean");
        expect(onSessionDeleted).toHaveBeenCalledWith("ses-clean");
        expect(getTagsBySession(openDatabase(), "ses-clean")).toHaveLength(0);
        expect(getMaxCompressionDepth(openDatabase(), "ses-clean")).toBe(0);
        expect(getOrCreateSessionMeta(openDatabase(), "ses-clean").isSubagent).toBe(false);
    });

    it("retries a failed deleted-session cleanup from its durable marker", async () => {
        useTempDataHome("context-event-delete-retry-");
        const deps = createDeps(new Map());
        const handler = createEventHandler(deps);
        insertTag(deps.db, "ses-delete-retry", "m-1", "message", 100, 1);
        const privateRow = deps.db
            .prepare(
                "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, 1, 'm-1', 'user', 'private bytes')",
            )
            .run("ses-delete-retry") as { lastInsertRowid: number | bigint };
        recordMessageFtsRowid(deps.db, "ses-delete-retry", 1, privateRow.lastInsertRowid);
        deps.db
            .prepare(
                "INSERT INTO message_history_index (session_id, last_indexed_ordinal, updated_at) VALUES (?, 1, ?)",
            )
            .run("ses-delete-retry", Date.now());

        const originalPrepare = deps.db.prepare.bind(deps.db);
        let failCleanup = true;
        (deps.db as unknown as { prepare: typeof deps.db.prepare }).prepare = ((sql: string) => {
            if (failCleanup && sql === "DELETE FROM source_contents WHERE session_id IN (?)") {
                failCleanup = false;
                throw new Error("synthetic session cleanup failure");
            }
            return originalPrepare(sql);
        }) as typeof deps.db.prepare;

        await handler({
            event: {
                type: "session.deleted",
                properties: { info: { id: "ses-delete-retry" } },
            },
        });

        expect(
            deps.db
                .prepare(
                    "SELECT COUNT(*) AS count FROM pending_session_cleanup WHERE session_id = ?",
                )
                .get("ses-delete-retry"),
        ).toEqual({ count: 1 });
        expect(countIndexedMessages("ses-delete-retry", "m-1")).toBe(1);

        (deps.db as unknown as { prepare: typeof deps.db.prepare }).prepare = originalPrepare;
        expect(retryPendingSessionCleanups(deps.db)).toEqual({
            attempted: 1,
            cleared: 1,
            failedSessionIds: [],
        });
        expect(countIndexedMessages("ses-delete-retry", "m-1")).toBe(0);
        expect(getTagsBySession(deps.db, "ses-delete-retry")).toHaveLength(0);
        expect(
            deps.db
                .prepare(
                    "SELECT COUNT(*) AS count FROM pending_session_cleanup WHERE session_id = ?",
                )
                .get("ses-delete-retry"),
        ).toEqual({ count: 0 });
    });

    it("keeps a failed Rust deletion durable until a project-scoped retry succeeds", async () => {
        useTempDataHome("context-event-rust-delete-retry-");
        const deps = createDeps(new Map());
        const sessionId = "ses-rust-delete-retry";
        const projectPath = "git:rust-delete-retry";
        insertTag(deps.db, sessionId, "m-1", "message", 100, 1);
        recordSessionProjectIdentity(deps.db, sessionId, projectPath);
        const onSessionDeleted = mock(async () => {
            throw new Error("module unavailable");
        });
        const handler = createEventHandler({
            ...deps,
            onSessionDeleted,
            rustSessionCleanup: true,
        });

        await handler({
            event: {
                type: "session.deleted",
                properties: { info: { id: sessionId } },
            },
        });

        expect(onSessionDeleted).toHaveBeenCalledWith(sessionId);
        expect(getTagsBySession(deps.db, sessionId)).toHaveLength(1);
        expect(
            deps.db
                .prepare("SELECT harness FROM pending_session_cleanup WHERE session_id = ?")
                .get(sessionId),
        ).toEqual({ harness: "opencode:rust" });
        expect(retryPendingSessionCleanups(deps.db)).toEqual({
            attempted: 0,
            cleared: 0,
            failedSessionIds: [],
        });

        // A replay after cleanup switches to TypeScript must preserve the pending
        // Rust marker and host rows until module-owned state is deleted.
        const flippedHandler = createEventHandler({
            ...deps,
            onSessionDeleted: mock(() => {}),
            rustSessionCleanup: false,
        });
        await flippedHandler({
            event: {
                type: "session.deleted",
                properties: { info: { id: sessionId } },
            },
        });
        expect(
            deps.db
                .prepare("SELECT harness FROM pending_session_cleanup WHERE session_id = ?")
                .get(sessionId),
        ).toEqual({ harness: "opencode:rust" });
        expect(getTagsBySession(deps.db, sessionId)).toHaveLength(1);

        const deleteSession = mock(async () => {});
        await expect(
            retryPendingRustSessionCleanupsForProject(deps.db, projectPath, deleteSession),
        ).resolves.toEqual({ attempted: 1, cleared: 1, failedSessionIds: [] });
        expect(deleteSession).toHaveBeenCalledWith(sessionId);
        expect(getTagsBySession(deps.db, sessionId)).toHaveLength(0);
        expect(
            deps.db
                .prepare(
                    "SELECT COUNT(*) AS count FROM pending_session_cleanup WHERE session_id = ?",
                )
                .get(sessionId),
        ).toEqual({ count: 0 });
    });

    it("preserves a failed Rust cleanup across TS → Rust → TS double flips", async () => {
        useTempDataHome("context-event-rust-delete-double-flip-ts-");
        const deps = createDeps(new Map());
        const sessionId = "ses-rust-double-flip-ts";
        const projectPath = "git:rust-double-flip-ts";
        insertTag(deps.db, sessionId, "m-1", "message", 100, 1);
        recordSessionProjectIdentity(deps.db, sessionId, projectPath);
        markSessionCleanupPending(deps.db, sessionId, true);
        const event = {
            event: { type: "session.deleted", properties: { info: { id: sessionId } } },
        } as const;

        await createEventHandler({
            ...deps,
            onSessionDeleted: mock(() => {}),
            rustSessionCleanup: false,
        })(event);
        await createEventHandler({
            ...deps,
            onSessionDeleted: mock(async () => {
                throw new Error("module unavailable");
            }),
            rustSessionCleanup: true,
        })(event);
        await createEventHandler({
            ...deps,
            onSessionDeleted: mock(() => {}),
            rustSessionCleanup: false,
        })(event);

        expect(
            deps.db
                .prepare("SELECT harness FROM pending_session_cleanup WHERE session_id = ?")
                .get(sessionId),
        ).toEqual({ harness: "opencode:rust" });
        expect(getTagsBySession(deps.db, sessionId)).toHaveLength(1);
        await retryPendingRustSessionCleanupsForProject(deps.db, projectPath, async () => {});
        expect(getTagsBySession(deps.db, sessionId)).toHaveLength(0);
    });

    it("preserves a failed Rust cleanup across Rust → TS → Rust double flips", async () => {
        useTempDataHome("context-event-rust-delete-double-flip-rust-");
        const deps = createDeps(new Map());
        const sessionId = "ses-rust-double-flip-rust";
        const projectPath = "git:rust-double-flip-rust";
        insertTag(deps.db, sessionId, "m-1", "message", 100, 1);
        recordSessionProjectIdentity(deps.db, sessionId, projectPath);
        const event = {
            event: { type: "session.deleted", properties: { info: { id: sessionId } } },
        } as const;
        const failRustDelete = () =>
            createEventHandler({
                ...deps,
                onSessionDeleted: mock(async () => {
                    throw new Error("module unavailable");
                }),
                rustSessionCleanup: true,
            })(event);

        await failRustDelete();
        await createEventHandler({
            ...deps,
            onSessionDeleted: mock(() => {}),
            rustSessionCleanup: false,
        })(event);
        await failRustDelete();

        expect(
            deps.db
                .prepare("SELECT harness FROM pending_session_cleanup WHERE session_id = ?")
                .get(sessionId),
        ).toEqual({ harness: "opencode:rust" });
        expect(getTagsBySession(deps.db, sessionId)).toHaveLength(1);
        await retryPendingRustSessionCleanupsForProject(deps.db, projectPath, async () => {});
        expect(getTagsBySession(deps.db, sessionId)).toHaveLength(0);
    });

    it("serializes the durable outcome of two concurrent session.deleted deliveries", async () => {
        useTempDataHome("context-event-rust-delete-concurrent-");
        const deps = createDeps(new Map());
        const sessionId = "ses-rust-delete-concurrent";
        insertTag(deps.db, sessionId, "m-1", "message", 100, 1);
        const first = deferred<void>();
        const second = deferred<void>();
        let calls = 0;
        const handler = createEventHandler({
            ...deps,
            rustSessionCleanup: true,
            onSessionDeleted: mock(() => (calls++ === 0 ? first.promise : second.promise)),
        });
        const event = {
            event: { type: "session.deleted", properties: { info: { id: sessionId } } },
        } as const;

        const firstDelivery = handler(event);
        const secondDelivery = handler(event);
        await Promise.resolve();
        expect(calls).toBe(2);
        expect(getTagsBySession(deps.db, sessionId)).toHaveLength(1);
        first.reject(new Error("first module delete failed"));
        second.resolve();
        await Promise.all([firstDelivery, secondDelivery]);

        expect(getTagsBySession(deps.db, sessionId)).toHaveLength(0);
        expect(
            deps.db
                .prepare(
                    "SELECT COUNT(*) AS count FROM pending_session_cleanup WHERE session_id = ?",
                )
                .get(sessionId),
        ).toEqual({ count: 0 });
    });

    it("serializes two same-tick session.deleted events through the plugin event bus", async () => {
        useTempDataHome("context-event-bus-rust-delete-concurrent-");
        const deps = createDeps(new Map());
        const sessionId = "ses-rust-delete-event-bus-concurrent";
        insertTag(deps.db, sessionId, "m-1", "message", 100, 1);
        const first = deferred<void>();
        const second = deferred<void>();
        let calls = 0;
        const magicEvent = createEventHandler({
            ...deps,
            rustSessionCleanup: true,
            onSessionDeleted: mock(() => (calls++ === 0 ? first.promise : second.promise)),
        });
        const eventBus = createPluginEventHandler({
            magicContext: { event: magicEvent as never },
        });
        const event = {
            event: { type: "session.deleted", properties: { info: { id: sessionId } } },
        } as const;

        const firstDelivery = eventBus(event as never);
        const secondDelivery = eventBus(event as never);
        await Promise.resolve();
        expect(calls).toBe(2);
        expect(getTagsBySession(deps.db, sessionId)).toHaveLength(1);
        first.reject(new Error("first module delete failed"));
        second.resolve();
        await Promise.all([firstDelivery, secondDelivery]);

        expect(getTagsBySession(deps.db, sessionId)).toHaveLength(0);
        expect(
            deps.db
                .prepare(
                    "SELECT COUNT(*) AS count FROM pending_session_cleanup WHERE session_id = ?",
                )
                .get(sessionId),
        ).toEqual({ count: 0 });
    });

    it("keeps host rows while a delete races the project-scoped Rust retry", async () => {
        useTempDataHome("context-event-rust-delete-timer-race-");
        const deps = createDeps(new Map());
        const sessionId = "ses-rust-delete-timer-race";
        const projectPath = "git:rust-delete-timer-race";
        insertTag(deps.db, sessionId, "m-1", "message", 100, 1);
        recordSessionProjectIdentity(deps.db, sessionId, projectPath);
        markSessionCleanupPending(deps.db, sessionId, true);
        const retryDelete = deferred<void>();
        const retry = retryPendingRustSessionCleanupsForProject(
            deps.db,
            projectPath,
            () => retryDelete.promise,
        );
        await Promise.resolve();

        await createEventHandler({
            ...deps,
            onSessionDeleted: mock(() => {}),
            rustSessionCleanup: false,
        })({
            event: { type: "session.deleted", properties: { info: { id: sessionId } } },
        });
        expect(getTagsBySession(deps.db, sessionId)).toHaveLength(1);

        retryDelete.resolve();
        await expect(retry).resolves.toEqual({ attempted: 1, cleared: 1, failedSessionIds: [] });
        expect(getTagsBySession(deps.db, sessionId)).toHaveLength(0);
    });

    it("cleans up removed-message tags and indexed content", async () => {
        useTempDataHome("context-event-message-removed-tags-");
        const deps = createDeps(new Map());
        const onRustWireInvalidated = mock(() => {});
        const handler = createEventHandler({ ...deps, onRustWireInvalidated });
        insertTag(deps.db, "ses-removed", "msg-removed:p0", "message", 32, 1);
        insertTag(deps.db, "ses-removed", "msg-removed:file1", "file", 48, 2);
        insertTag(deps.db, "ses-removed", "msg-keep:p0", "message", 64, 3);
        const removedRow = deps.db
            .prepare(
                "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
            )
            .run("ses-removed", 1, "msg-removed", "assistant", "removed") as {
            lastInsertRowid: number | bigint;
        };
        recordMessageFtsRowid(deps.db, "ses-removed", 1, removedRow.lastInsertRowid);
        const keptRow = deps.db
            .prepare(
                "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
            )
            .run("ses-removed", 2, "msg-keep", "assistant", "keep") as {
            lastInsertRowid: number | bigint;
        };
        recordMessageFtsRowid(deps.db, "ses-removed", 2, keptRow.lastInsertRowid);
        deps.db
            .prepare(
                "INSERT INTO message_history_index (session_id, last_indexed_ordinal, updated_at) VALUES (?, ?, ?)",
            )
            .run("ses-removed", 2, Date.now());

        await handler({
            event: {
                type: "message.removed",
                properties: { sessionID: "ses-removed", messageID: "msg-removed" },
            },
        });

        expect(getTagsBySession(openDatabase(), "ses-removed")).toEqual([
            {
                id: 3,
                tagNumber: 3,
                messageId: "msg-keep:p0",
                type: "message",
                status: "active",
                dropMode: "full",
                toolName: null,
                inputByteSize: 0,
                byteSize: 64,
                reasoningByteSize: 0,
                sessionId: "ses-removed",
                cavemanDepth: 0,
                toolOwnerMessageId: null,
                tokenCount: null,
            },
        ]);
        // The removal path clears synchronously. Async reconciliation is scheduled
        // separately, so searches during this tiny rebuild window see no message hits.
        expect(countIndexedMessages("ses-removed", "msg-removed")).toBe(0);
        expect(countIndexedMessages("ses-removed", "msg-keep")).toBe(0);
        expect(countMessageIndexRows("ses-removed")).toBe(0);
        expect(isSessionReconciled("ses-removed")).toBe(false);
        expect(deps.tagger.cleanup).toHaveBeenCalledWith("ses-removed");
        expect(onRustWireInvalidated).toHaveBeenCalledWith("ses-removed");
    });

    it("resets the reasoning watermark when removed tags exceed the remaining max tag", async () => {
        useTempDataHome("context-event-message-removed-watermark-");
        const deps = createDeps(new Map());
        const handler = createEventHandler(deps);

        insertTag(deps.db, "ses-watermark", "msg-keep:p0", "message", 32, 1);
        insertTag(deps.db, "ses-watermark", "msg-removed:p0", "message", 32, 5);
        updateSessionMeta(deps.db, "ses-watermark", { clearedReasoningThroughTag: 7 });

        await handler({
            event: {
                type: "message.removed",
                properties: { sessionID: "ses-watermark", messageID: "msg-removed" },
            },
        });

        expect(
            getOrCreateSessionMeta(openDatabase(), "ses-watermark").clearedReasoningThroughTag,
        ).toBe(1);
    });

    it("prunes only sticky-injection anchors for the removed message", async () => {
        useTempDataHome("context-event-message-removed-note-");
        const deps = createDeps(new Map());
        const handler = createEventHandler(deps);

        appendNoteNudgeAnchor(deps.db, "ses-note", "msg-note", "Remember this");
        appendNoteNudgeAnchor(deps.db, "ses-note", "msg-other", "Keep this");
        appendAutoSearchHintDecision(deps.db, "ses-note", {
            messageId: "msg-note",
            decision: "hint",
            text: "auto hint",
        });
        appendAutoSearchHintDecision(deps.db, "ses-note", {
            messageId: "msg-other",
            decision: "no-hint",
            reason: "empty",
        });

        await handler({
            event: {
                type: "message.removed",
                properties: { sessionID: "ses-note", messageID: "msg-note" },
            },
        });

        expect(getNoteNudgeAnchors(openDatabase(), "ses-note")).toEqual([
            { messageId: "msg-other", text: "Keep this" },
        ]);
        expect(getAutoSearchHintDecisions(openDatabase(), "ses-note")).toEqual([
            { messageId: "msg-other", decision: "no-hint", reason: "empty" },
        ]);
    });

    it("clears note nudge trigger only when the removed message is the trigger", async () => {
        useTempDataHome("context-event-message-removed-note-trigger-");
        const deps = createDeps(new Map());
        const handler = createEventHandler(deps);

        deps.db
            .prepare(
                "INSERT INTO session_meta (session_id, note_nudge_trigger_pending, note_nudge_trigger_message_id) VALUES (?, ?, ?)",
            )
            .run("ses-note-trigger", 1, "msg-trigger");
        appendNoteNudgeAnchor(deps.db, "ses-note-trigger", "msg-anchor", "Keep anchor");

        await handler({
            event: {
                type: "message.removed",
                properties: { sessionID: "ses-note-trigger", messageID: "msg-trigger" },
            },
        });

        expect(getPersistedNoteNudge(openDatabase(), "ses-note-trigger")).toEqual({
            triggerPending: false,
            triggerMessageId: null,
            stickyText: null,
            stickyMessageId: null,
        });
        expect(getNoteNudgeAnchors(openDatabase(), "ses-note-trigger")).toEqual([
            { messageId: "msg-anchor", text: "Keep anchor" },
        ]);
    });

    it("removes deleted message ids from stripped placeholder state", async () => {
        useTempDataHome("context-event-message-removed-stripped-");
        const deps = createDeps(new Map());
        const handler = createEventHandler(deps);

        setStrippedPlaceholderIds(deps.db, "ses-stripped", new Set(["msg-keep"]));
        applyStrippedPlaceholderDelta(deps.db, "ses-stripped", {
            hiddenSeamAdd: ["msg-removed"],
        });

        await handler({
            event: {
                type: "message.removed",
                properties: { sessionID: "ses-stripped", messageID: "msg-removed" },
            },
        });

        expect(getStrippedPlaceholderIds(openDatabase(), "ses-stripped")).toEqual(
            new Set(["msg-keep"]),
        );
        expect(getHiddenSeamPlaceholderIds(openDatabase(), "ses-stripped")).toEqual(new Set());
    });

    it("is a no-op for removed messages with no persisted references", async () => {
        useTempDataHome("context-event-message-removed-noop-");
        const deps = createDeps(new Map());
        const handler = createEventHandler(deps);

        await handler({
            event: {
                type: "message.removed",
                properties: { sessionID: "ses-noop", messageID: "msg-missing" },
            },
        });

        expect(getTagsBySession(openDatabase(), "ses-noop")).toHaveLength(0);
        expect(countIndexedMessages("ses-noop", "msg-missing")).toBe(0);
        expect(countSessionMetaRows("ses-noop")).toBe(0);
    });
});

describe("createEventHandler — compaction-off overflow gating (issue #266 S3)", () => {
    const OVERFLOW_ERROR =
        "This model's maximum context length is 120000 tokens. Please reduce the length of the messages.";

    function readOverflowState(sessionId: string): {
        needsEmergencyRecovery: number;
        detectedContextLimit: number;
    } {
        const row = openDatabase()
            .prepare(
                "SELECT needs_emergency_recovery, detected_context_limit FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as
            | { needs_emergency_recovery: number | null; detected_context_limit: number | null }
            | undefined;
        return {
            needsEmergencyRecovery: row?.needs_emergency_recovery ?? 0,
            detectedContextLimit: row?.detected_context_limit ?? 0,
        };
    }

    it("compaction ON: a provider overflow arms emergency recovery (regression baseline)", async () => {
        useTempDataHome("context-event-overflow-on-");
        const deps = createDeps(new Map());
        const handler = createEventHandler(deps);

        await handler({
            event: {
                type: "session.error",
                properties: { sessionID: "ses-on", error: OVERFLOW_ERROR },
            },
        });

        const state = readOverflowState("ses-on");
        expect(state.needsEmergencyRecovery).toBe(1);
        expect(state.detectedContextLimit).toBe(120000);
    });

    it("compaction OFF: overflow never arms recovery, but the provider limit is still recorded for raw-usage math", async () => {
        useTempDataHome("context-event-overflow-off-");
        const deps = { ...createDeps(new Map()), compactionOff: true };
        const handler = createEventHandler(deps);

        await handler({
            event: {
                type: "session.error",
                properties: { sessionID: "ses-off", error: OVERFLOW_ERROR },
            },
        });

        const state = readOverflowState("ses-off");
        // The latch machinery is gated off — native compaction owns recovery.
        expect(state.needsEmergencyRecovery).toBe(0);
        // The provider-reported limit stays useful for the raw-usage % the
        // sidebar renders in this mode.
        expect(state.detectedContextLimit).toBe(120000);
    });

    it("captures session.error overflow without guessing provider metadata", async () => {
        useTempDataHome("context-event-window-report-session-error-");
        const deps = createDeps(new Map());
        updateSessionMeta(deps.db, "ses-session-error-report", {
            lastObservedModelKey: "anthropic/claude-sonnet-4-5",
        });
        const handler = createEventHandler(deps);

        await handler({
            event: {
                type: "session.error",
                properties: { sessionID: "ses-session-error-report", error: OVERFLOW_ERROR },
            },
        });

        const report = JSON.parse(readFileSync(getWindowReportsPath(), "utf8")) as Record<
            string,
            unknown
        >;
        expect(report).toMatchObject({
            access_path: "api",
            extracted_limit: 120000,
            extracted_limit_units: "provider",
            geometry: "combined",
        });
        // Session errors lack a model identity. A stale session value is not evidence.
        expect("provider_id" in report).toBe(false);
        expect("model_id" in report).toBe(false);
        // Absent = unknown routing (refuses promotion); the reporter never
        // asserts false — an explicit false would PERMIT promotion, a claim
        // the one-directional forwarder detector cannot support.
        expect("path_may_forward" in report).toBe(false);
    });

    it("captures message.updated overflow with observed model, token, and routing facts", async () => {
        useTempDataHome("context-event-window-report-message-updated-");
        const deps = createDeps(new Map());
        updateSessionMeta(deps.db, "ses-message-report", {
            lastObservedModelKey: "openrouter/anthropic/claude-sonnet-4-5",
            observedSafeInputTokens: 150,
        });
        const handler = createEventHandler(deps);

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        id: "msg-window-report",
                        sessionID: "ses-message-report",
                        role: "assistant",
                        providerID: "openrouter",
                        modelID: "anthropic/claude-sonnet-4-5",
                        error: { message: OVERFLOW_ERROR, status: 400 },
                        finish: "stop",
                        tokens: { input: 100, cache: { read: 50, write: 0 } },
                        time: { completed: Date.now() },
                    },
                },
            },
        });

        const report = JSON.parse(readFileSync(getWindowReportsPath(), "utf8")) as Record<
            string,
            unknown
        >;
        expect(report).toMatchObject({
            provider_id: "openrouter",
            model_id: "anthropic/claude-sonnet-4-5",
            status: 400,
            attempted_tokens: 150,
            attempted_tokens_units: "estimate",
            largest_success: 150,
            largest_success_units: "estimate",
            path_may_forward: true,
            served_by_hint: "anthropic",
        });
    });

    it("does not append reports for non-overflow errors", async () => {
        useTempDataHome("context-event-window-report-non-overflow-");
        const handler = createEventHandler(createDeps(new Map()));

        await handler({
            event: {
                type: "session.error",
                properties: { sessionID: "ses-non-overflow", error: "connection timed out" },
            },
        });

        expect(existsSync(getWindowReportsPath())).toBe(false);
    });

    it("compaction OFF: message.updated overflow also records limit only, never arms", async () => {
        useTempDataHome("context-event-overflow-off-mu-");
        const deps = { ...createDeps(new Map()), compactionOff: true };
        const handler = createEventHandler(deps);

        await handler({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        id: "msg-1",
                        sessionID: "ses-off-mu",
                        role: "assistant",
                        error: OVERFLOW_ERROR,
                        finish: "stop",
                        tokens: { input: 100, cache: { read: 0, write: 0 } },
                        time: { completed: Date.now() },
                    },
                },
            },
        });

        const state = readOverflowState("ses-off-mu");
        expect(state.needsEmergencyRecovery).toBe(0);
        expect(state.detectedContextLimit).toBe(120000);
    });
});
