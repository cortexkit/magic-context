/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getTagsBySession,
    insertTag,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import type { ContextUsage } from "../../features/magic-context/types";
import { createEventHandler } from "./event-handler";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
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
    const oneMillionContextEnabled =
        process.env.ANTHROPIC_1M_CONTEXT === "true" ||
        process.env.VERTEX_ANTHROPIC_1M_CONTEXT === "true";
    return oneMillionContextEnabled ? 1_000_000 : 200_000;
}

function createDeps(contextUsageMap: Map<string, { usage: ContextUsage; updatedAt: number }>) {
    return {
        contextUsageMap,
        compactionHandler: { onCompacted: mock(() => {}) },
        nudgePlacements: { set: mock(() => {}), get: mock(() => null), clear: mock(() => {}) },
        config: {
            protected_tags: 5,
            cache_ttl: "5m" as string | Record<string, string>,
            modelContextLimitsCache: undefined as Map<string, number> | undefined,
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
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>();
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

    it("uses provider/model-specific context limits and cache ttl", async () => {
        useTempDataHome("context-event-provider-model-");
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>();
        const deps = createDeps(contextUsageMap);
        deps.config.cache_ttl = { default: "5m", "gpt-4o": "1m" };
        deps.config.modelContextLimitsCache = new Map([["openai/gpt-4o", 400_000]]);
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

        const usage = contextUsageMap.get("ses-model");
        expect(usage?.usage.percentage).toBeCloseTo(50, 5);
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
        expect(getOrCreateSessionMeta(openDatabase(), "ses-clean").isSubagent).toBe(false);
    });
});
