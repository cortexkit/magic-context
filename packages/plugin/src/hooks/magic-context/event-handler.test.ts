/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    __resetMessageIndexAsyncForTests,
    isSessionReconciled,
} from "../../features/magic-context/message-index-async";
import {
    closeDatabase,
    getHistorianFailureState,
    getMaxCompressionDepth,
    getOrCreateSessionMeta,
    getPersistedNudgePlacement,
    getPersistedStickyTurnReminder,
    getStrippedPlaceholderIds,
    getTagsBySession,
    incrementCompressionDepth,
    incrementHistorianFailure,
    insertTag,
    openDatabase,
    setPersistedNudgePlacement,
    setPersistedStickyTurnReminder,
    setStrippedPlaceholderIds,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    getPersistedNoteNudge,
    setPersistedDeliveredNoteNudge,
} from "../../features/magic-context/storage-meta-persisted";
import type { ContextUsage } from "../../features/magic-context/types";
import { createEventHandler } from "./event-handler";

type ContextUsageCacheEntry = {
    usage: ContextUsage;
    updatedAt: number;
    lastResponseTime?: number;
};

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    __resetMessageIndexAsyncForTests();
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
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
    // resolveContextLimit falls through to DEFAULT_CONTEXT_LIMIT = 128_000.
    return 128_000;
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

function createDeps(contextUsageMap: Map<string, ContextUsageCacheEntry>) {
    return {
        contextUsageMap,
        compactionHandler: { onCompacted: mock(() => {}) },
        nudgePlacements: { set: mock(() => {}), get: mock(() => null), clear: mock(() => {}) },
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

describe("createEventHandler", () => {
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
        expect(usageEntry?.lastResponseTime).toBeGreaterThanOrEqual(before);
        expect(
            getOrCreateSessionMeta(openDatabase(), "ses-usage").lastResponseTime,
        ).toBeGreaterThanOrEqual(before);
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
        const clearNudgePlacement = deps.nudgePlacements.clear;
        const taggerCleanup = deps.tagger.cleanup;
        const handler = createEventHandler(deps);

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
        expect(clearNudgePlacement).toHaveBeenCalledWith("ses-clean");
        expect(getTagsBySession(openDatabase(), "ses-clean")).toHaveLength(0);
        expect(getMaxCompressionDepth(openDatabase(), "ses-clean")).toBe(0);
        expect(getOrCreateSessionMeta(openDatabase(), "ses-clean").isSubagent).toBe(false);
    });

    it("cleans up removed-message tags and indexed content", async () => {
        useTempDataHome("context-event-message-removed-tags-");
        const deps = createDeps(new Map());
        const handler = createEventHandler(deps);
        insertTag(deps.db, "ses-removed", "msg-removed:p0", "message", 32, 1);
        insertTag(deps.db, "ses-removed", "msg-removed:file1", "file", 48, 2);
        insertTag(deps.db, "ses-removed", "msg-keep:p0", "message", 64, 3);
        deps.db
            .prepare(
                "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
            )
            .run("ses-removed", 1, "msg-removed", "assistant", "removed");
        deps.db
            .prepare(
                "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
            )
            .run("ses-removed", 2, "msg-keep", "assistant", "keep");
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
            },
        ]);
        // The removal path clears synchronously. Async reconciliation is scheduled
        // separately, so searches during this tiny rebuild window see no message hits.
        expect(countIndexedMessages("ses-removed", "msg-removed")).toBe(0);
        expect(countIndexedMessages("ses-removed", "msg-keep")).toBe(0);
        expect(countMessageIndexRows("ses-removed")).toBe(0);
        expect(isSessionReconciled("ses-removed")).toBe(false);
        expect(deps.tagger.cleanup).toHaveBeenCalledWith("ses-removed");
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

    it("clears the nudge anchor when the removed message was the anchor", async () => {
        useTempDataHome("context-event-message-removed-anchor-");
        const deps = createDeps(new Map());
        const handler = createEventHandler(deps);

        setPersistedNudgePlacement(
            deps.db,
            "ses-anchor",
            "msg-anchor",
            "<instruction>nudge</instruction>",
        );

        await handler({
            event: {
                type: "message.removed",
                properties: { sessionID: "ses-anchor", messageID: "msg-anchor" },
            },
        });

        expect(getPersistedNudgePlacement(openDatabase(), "ses-anchor")).toBeNull();
        expect(deps.nudgePlacements.clear).toHaveBeenCalledWith("ses-anchor", { persist: false });
    });

    it("clears note nudge state when the removed message is referenced", async () => {
        useTempDataHome("context-event-message-removed-note-");
        const deps = createDeps(new Map());
        const handler = createEventHandler(deps);

        setPersistedDeliveredNoteNudge(deps.db, "ses-note", "Remember this", "msg-note");

        await handler({
            event: {
                type: "message.removed",
                properties: { sessionID: "ses-note", messageID: "msg-note" },
            },
        });

        expect(getPersistedNoteNudge(openDatabase(), "ses-note")).toEqual({
            triggerPending: false,
            triggerMessageId: null,
            stickyText: null,
            stickyMessageId: null,
        });
    });

    it("clears sticky turn reminders when the removed message was the reminder anchor", async () => {
        useTempDataHome("context-event-message-removed-sticky-reminder-");
        const deps = createDeps(new Map());
        const handler = createEventHandler(deps);

        setPersistedStickyTurnReminder(
            deps.db,
            "ses-reminder",
            "remember to reduce",
            "msg-reminder",
        );

        await handler({
            event: {
                type: "message.removed",
                properties: { sessionID: "ses-reminder", messageID: "msg-reminder" },
            },
        });

        expect(getPersistedStickyTurnReminder(openDatabase(), "ses-reminder")).toBeNull();
    });

    it("removes deleted message ids from stripped placeholder state", async () => {
        useTempDataHome("context-event-message-removed-stripped-");
        const deps = createDeps(new Map());
        const handler = createEventHandler(deps);

        setStrippedPlaceholderIds(deps.db, "ses-stripped", new Set(["msg-keep", "msg-removed"]));

        await handler({
            event: {
                type: "message.removed",
                properties: { sessionID: "ses-stripped", messageID: "msg-removed" },
            },
        });

        expect(getStrippedPlaceholderIds(openDatabase(), "ses-stripped")).toEqual(
            new Set(["msg-keep"]),
        );
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
