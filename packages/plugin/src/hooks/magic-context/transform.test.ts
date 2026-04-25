/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    replaceAllCompartmentState,
    replaceAllCompartments,
} from "../../features/magic-context/compartment-storage";
import { insertMemory } from "../../features/magic-context/memory";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    clearPendingOps,
    closeDatabase,
    getHistorianFailureState,
    getOrCreateSessionMeta,
    getPendingOps,
    getTagById,
    getTagsBySession,
    incrementHistorianFailure,
    openDatabase,
    queuePendingOp,
    updateSessionMeta,
    updateTagStatus,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { clearModelsDevCache } from "../../shared/models-dev-cache";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createNudgePlacementStore, createTransform } from "./transform";

type TextPart = { type: "text"; text: string };
type ToolPart = { type: "tool"; callID: string; state: { output: string } };
type ThinkingPart = { type: "thinking"; thinking: string };
type MetaPart = { type: "meta"; text: string };
type StepStartPart = { type: "step-start"; text: string };
type StepFinishPart = { type: "step-finish"; text: string };
type ReasoningPart = { type: "reasoning"; text: string };
type TestPart =
    | TextPart
    | ToolPart
    | ThinkingPart
    | MetaPart
    | StepStartPart
    | StepFinishPart
    | ReasoningPart;
type TestMessage = {
    info: {
        id?: string;
        role: string;
        sessionID?: string;
        providerID?: string;
        modelID?: string;
    };
    parts: TestPart[];
};

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

afterEach(() => {
    closeDatabase();
    clearModelsDevCache();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdgCacheHome;

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

// Points both XDG_DATA_HOME (plugin storage) and XDG_CACHE_HOME (OpenCode's
// models.json cache read by `models-dev-cache.ts`) at the same temp directory.
// Tests that only touch plugin storage don't care about the cache isolation;
// tests that exercise model-capability lookup (e.g., interleaved.field gating)
// can write a synthetic models.json into <temp>/opencode/models.json and have
// models-dev-cache read it.
function useTempDataHome(prefix: string): void {
    const dir = makeTempDir(prefix);
    process.env.XDG_DATA_HOME = dir;
    process.env.XDG_CACHE_HOME = dir;
}

function text(message: TestMessage, index: number): string {
    const part = message.parts[index];
    return part.type === "text" ? part.text : "";
}

function toolOutput(message: TestMessage, index: number): string {
    const part = message.parts[index];
    if (!part) return "";
    return part.type === "tool" ? part.state.output : "";
}

describe("createTransform", () => {
    it("tags text/tool content and appends nudge to the latest non-tool assistant message", async () => {
        //#given
        useTempDataHome("context-transform-tag-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const nudger = mock(() => ({
            type: "assistant" as const,
            text: "Context at ~45%. Consider dropping old output.",
        }));
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>([
            ["ses-1", { usage: { percentage: 46, inputTokens: 92_000 }, updatedAt: Date.now() }],
        ]);
        const db = openDatabase();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap,
            nudger,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "Plan this change" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [
                    { type: "text", text: "Implemented" },
                    { type: "tool", callID: "call-1", state: { output: "tool output" } },
                ],
            },
            {
                info: { id: "m-assistant-safe", role: "assistant" },
                parts: [{ type: "text", text: "Plain follow-up" }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then
        expect(text(messages[1], 0)).not.toContain("Context at ~45%");
        expect(text(messages[2], 0)).toContain("Context at ~45%");
        expect(text(messages[0], 0)).toStartWith("§1§ ");
        expect(text(messages[1], 0)).toContain("§2§ ");
        expect(toolOutput(messages[1], 1)).toStartWith("§3§ ");
        expect(nudger).toHaveBeenCalledTimes(1);
    });

    it("does not inject user messages for emergency nudges (handled by promptAsync)", async () => {
        //#given
        useTempDataHome("context-transform-no-user-nudge-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-no-user-nudge",
                    { usage: { percentage: 81, inputTokens: 162_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-no-user-nudge" },
                parts: [{ type: "text", text: "Please continue" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "text", text: "Working on it" }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then — no user message pushed (80% nudge handled by promptAsync in hook.ts)
        expect(messages).toHaveLength(2);
    });

    it("skips visible messages already covered by injected compartments before tagging", async () => {
        //#given
        useTempDataHome("context-transform-compartment-skip-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        replaceAllCompartments(db, "ses-compartment-skip", [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 3,
                startMessageId: "m-1",
                endMessageId: "m-3",
                title: "Earlier work",
                content: "Summarized earlier work.",
            },
        ]);
        replaceAllCompartmentState(
            db,
            "ses-compartment-skip",
            [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 3,
                    startMessageId: "m-1",
                    endMessageId: "m-3",
                    title: "Earlier work",
                    content: "Summarized earlier work.",
                },
            ],
            [{ category: "WORKFLOW_RULES", content: "Commit to feat first." }],
        );
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-compartment-skip",
                    { usage: { percentage: 30, inputTokens: 60_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-1", role: "user", sessionID: "ses-compartment-skip" },
                parts: [{ type: "text", text: "old 1" }],
            },
            { info: { id: "m-2", role: "assistant" }, parts: [{ type: "text", text: "old 2" }] },
            {
                info: { id: "m-3", role: "user", sessionID: "ses-compartment-skip" },
                parts: [{ type: "text", text: "old 3" }],
            },
            { info: { id: "m-4", role: "assistant" }, parts: [{ type: "text", text: "new 4" }] },
            {
                info: { id: "m-5", role: "user", sessionID: "ses-compartment-skip" },
                parts: [{ type: "text", text: "new 5" }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then
        expect(messages).toHaveLength(2);
        expect(messages[0]?.info.id).toBe("m-4");
        expect(messages[1]?.info.id).toBe("m-5");
        expect(text(messages[0]!, 0)).toContain("<session-history>");
        expect(text(messages[0]!, 0)).toContain("Summarized earlier work.");
        expect(text(messages[0]!, 0)).toContain("new 4");
        expect(text(messages[1]!, 0)).toContain("new 5");
        const tags = getTagsBySession(db, "ses-compartment-skip");
        expect(tags.map((tag) => tag.messageId)).not.toContain("m-1");
        expect(tags.map((tag) => tag.messageId)).not.toContain("m-2");
        expect(tags.map((tag) => tag.messageId)).not.toContain("m-3");
    });

    it("keeps compartment history visible when the first uncovered message is already dropped", async () => {
        //#given
        useTempDataHome("context-transform-compartment-dropped-carrier-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        const tagger = createTagger();
        const baselineTransform = createTransform({
            tagger,
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-compartment-dropped-carrier",
                    { usage: { percentage: 25, inputTokens: 50_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        await baselineTransform(
            {},
            {
                messages: [
                    {
                        info: { id: "m-4", role: "assistant" },
                        parts: [{ type: "text", text: "new 4" }],
                    },
                    {
                        info: {
                            id: "m-5",
                            role: "user",
                            sessionID: "ses-compartment-dropped-carrier",
                        },
                        parts: [{ type: "text", text: "new 5" }],
                    },
                ],
            },
        );
        const droppedCarrierTag = getTagsBySession(db, "ses-compartment-dropped-carrier").find(
            (tag) => tag.messageId === "m-4:p0",
        );
        expect(droppedCarrierTag).toBeDefined();
        updateTagStatus(
            db,
            "ses-compartment-dropped-carrier",
            droppedCarrierTag!.tagNumber,
            "dropped",
        );
        // Placeholder stripping now requires a cache-busting pass to detect new
        // empty shells. After the three-set refactor, an explicit-flush
        // simulation seeds `pendingMaterializationSessions` (read by
        // postprocess `isExplicitFlush`) — that's what gates heuristic
        // execution and `isCacheBustingPass`.
        const flushedHistory = new Set<string>(["ses-compartment-dropped-carrier"]);
        const flushedMaterialization = new Set<string>(["ses-compartment-dropped-carrier"]);
        replaceAllCompartments(db, "ses-compartment-dropped-carrier", [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 3,
                startMessageId: "m-1",
                endMessageId: "m-3",
                title: "Earlier work",
                content: "Summarized earlier work.",
            },
        ]);

        const transform = createTransform({
            tagger,
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-compartment-dropped-carrier",
                    { usage: { percentage: 30, inputTokens: 60_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: flushedHistory,
            pendingMaterializationSessions: flushedMaterialization,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-1", role: "user", sessionID: "ses-compartment-dropped-carrier" },
                parts: [{ type: "text", text: "old 1" }],
            },
            { info: { id: "m-2", role: "assistant" }, parts: [{ type: "text", text: "old 2" }] },
            {
                info: { id: "m-3", role: "user", sessionID: "ses-compartment-dropped-carrier" },
                parts: [{ type: "text", text: "old 3" }],
            },
            { info: { id: "m-4", role: "assistant" }, parts: [{ type: "text", text: "new 4" }] },
            {
                info: { id: "m-5", role: "user", sessionID: "ses-compartment-dropped-carrier" },
                parts: [{ type: "text", text: "new 5" }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then — with sentinel stripping, the carrier + 2 uncovered messages survive:
        // [synthetic-history-carrier, m-4 (sentineled because it was dropped), m-5].
        expect(text(messages[0]!, 0)).toContain("<session-history>");
        expect(text(messages[0]!, 0)).toContain("Summarized earlier work.");
        expect(messages[0]?.info.id).toBeUndefined();
        expect(messages).toHaveLength(3);
        // m-4 was dropped; its assistant text now carries the sentinel shape.
        expect(messages[1]?.info.id).toBe("m-4");
        expect(messages[1]?.parts).toEqual([{ type: "text", text: "" }]);
        expect(text(messages[2]!, 0)).toContain("new 5");
    });

    it("creates a synthetic history carrier when all visible messages are already covered", async () => {
        //#given
        useTempDataHome("context-transform-compartment-all-covered-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        replaceAllCompartments(db, "ses-compartment-all-covered", [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "m-1",
                endMessageId: "m-2",
                title: "Earlier work",
                content: "Everything is already summarized.",
            },
        ]);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-compartment-all-covered",
                    { usage: { percentage: 20, inputTokens: 40_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-1", role: "user", sessionID: "ses-compartment-all-covered" },
                parts: [{ type: "text", text: "old 1" }],
            },
            { info: { id: "m-2", role: "assistant" }, parts: [{ type: "text", text: "old 2" }] },
        ];

        //#when
        await transform({}, { messages });

        //#then
        expect(messages).toHaveLength(1);
        expect(messages[0]?.info.id).toBeUndefined();
        expect(text(messages[0]!, 0)).toContain("<session-history>");
        expect(text(messages[0]!, 0)).toContain("Everything is already summarized.");
    });

    it("injects legacy compartments even when the latest stored compartment has no end message id", async () => {
        //#given
        useTempDataHome("context-transform-legacy-compartment-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        replaceAllCompartments(db, "ses-legacy-compartment", [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "m-1",
                endMessageId: "",
                title: "Legacy compartment",
                content: "Legacy summary",
            },
        ]);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-legacy-compartment",
                    { usage: { percentage: 20, inputTokens: 40_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-1", role: "user", sessionID: "ses-legacy-compartment" },
                parts: [{ type: "text", text: "current 1" }],
            },
            {
                info: { id: "m-2", role: "assistant" },
                parts: [{ type: "text", text: "current 2" }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then
        expect(text(messages[0]!, 0)).toContain("<session-history>");
        expect(text(messages[0]!, 0)).toContain("Legacy summary");
        expect(text(messages[0]!, 0)).toContain("current 1");
        expect(text(messages[1]!, 0)).toContain("current 2");
        expect(messages).toHaveLength(2);
    });

    it("forces tool dropping at 85% even without pending ops", async () => {
        //#given
        useTempDataHome("context-transform-force-materialize-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-force-materialize",
                    { usage: { percentage: 86, inputTokens: 172_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-force-materialize" },
                parts: [{ type: "text", text: "continue" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "tool", callID: "call-1", state: { output: "tool output" } }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then — with dropToolStructure: true, tool parts are fully removed
        expect(messages).toHaveLength(1);
        expect(messages[0]?.info.id).toBe("m-user");
        const tags = getTagsBySession(db, "ses-force-materialize");
        expect(tags.find((tag) => tag.type === "tool")?.status).toBe("dropped");
    });

    it("skips nudge injection when the latest assistant message only contains tool content", async () => {
        //#given
        useTempDataHome("context-transform-tool-only-nudge-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const nudgeText = "Context at ~55%. Use ctx_reduce.";
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-tool-only",
                    { usage: { percentage: 55, inputTokens: 110_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => ({ type: "assistant", text: nudgeText }),
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user-1", role: "user", sessionID: "ses-tool-only" },
                parts: [{ type: "text", text: "First prompt" }],
            },
            {
                info: { id: "m-assistant-safe", role: "assistant" },
                parts: [{ type: "text", text: "Earlier plain answer" }],
            },
            {
                info: { id: "m-user-2", role: "user", sessionID: "ses-tool-only" },
                parts: [{ type: "text", text: "Run the command" }],
            },
            {
                info: { id: "m-assistant-tool", role: "assistant" },
                parts: [{ type: "tool", callID: "call-1", state: { output: "tool output" } }],
            },
            {
                info: { id: "m-user-3", role: "user", sessionID: "ses-tool-only" },
                parts: [{ type: "text", text: "Continue" }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then
        // Nudge IS appended to the earlier plain assistant message (walks backwards past tool-only)
        expect(text(messages[1], 0)).toContain(nudgeText);
        expect(toolOutput(messages[3], 0)).toStartWith("§4§ ");
        expect(messages[3].parts).toHaveLength(1);
    });

    it("strips structural noise even when scheduler defers", async () => {
        //#given
        useTempDataHome("context-transform-structural-noise-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-structural",
                    { usage: { percentage: 20, inputTokens: 40_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 10,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-structural" },
                parts: [{ type: "text", text: "continue" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [
                    { type: "text", text: "visible answer" },
                    { type: "step-start", text: "start" },
                    { type: "meta", text: "meta" },
                    { type: "reasoning", text: "[cleared]" },
                    { type: "step-finish", text: "finish" },
                ],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then — sentinel replacement preserves array length;
        // empty-text sentinels are dropped at the wire by OpenCode's provider/transform.
        expect(messages[1].parts).toHaveLength(5);
        // The live text part survives unchanged
        expect(text(messages[1], 0)).toContain("visible answer");
        // Structural noise parts are replaced with empty-text sentinels
        const sentineledParts = (
            messages[1].parts as Array<{ type: string; text?: string }>
        ).filter((p) => p.type === "text" && p.text === "");
        expect(sentineledParts).toHaveLength(4);
    });

    it("applies pending drop operations when scheduler executes", async () => {
        //#given
        useTempDataHome("context-transform-ops-");
        const shouldExecute = mock<Scheduler["shouldExecute"]>(() => "defer");
        const scheduler: Scheduler = { shouldExecute };
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-1",
                    { usage: { percentage: 60, inputTokens: 120_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });

        const firstPass: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "initial user text" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "tool", callID: "call-1", state: { output: "very long output" } }],
            },
        ];
        await transform({}, { messages: firstPass });

        const db = openDatabase();
        queuePendingOp(db, "ses-1", 1, "drop");
        queuePendingOp(db, "ses-1", 2, "drop");
        shouldExecute.mockImplementation(() => "execute");

        const secondPass: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "initial user text" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "tool", callID: "call-1", state: { output: "very long output" } }],
            },
        ];

        //#when
        await transform({}, { messages: secondPass });

        //#then — user message shell is preserved (turn boundary) with truncated
        // preview; tool-only assistant is fully dropped and its shell stripped.
        expect(secondPass).toHaveLength(1);
        expect(secondPass[0]?.info.role).toBe("user");
        const userShellText = (secondPass[0]?.parts[0] as { text: string }).text;
        expect(userShellText.startsWith("[truncated \u00a71\u00a7]")).toBe(true);
        expect(userShellText.includes("initial user text")).toBe(true);
        expect(getTagById(db, "ses-1", 1)?.status).toBe("dropped");
        expect(getTagById(db, "ses-1", 2)?.status).toBe("dropped");
        expect(clearPendingOps(db, "ses-1")).toBeUndefined();
    });

    it("applies content replacement for flushed tags even when pending queue is empty", async () => {
        //#given
        useTempDataHome("context-transform-flushed-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        // Placeholder stripping requires a cache-busting pass. After the
        // three-set refactor, an explicit-flush simulation seeds
        // `pendingMaterializationSessions` (postprocess `isExplicitFlush`).
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-1",
                    { usage: { percentage: 30, inputTokens: 60_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });

        const firstPass: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "user prompt" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "text", text: "long assistant response that should be dropped" }],
            },
        ];
        await transform({}, { messages: firstPass });

        const db = openDatabase();
        updateTagStatus(db, "ses-1", 2, "dropped");
        const pendingOps = getPendingOps(db, "ses-1");
        expect(pendingOps).toHaveLength(0);
        // Three-set refactor: flush simulation now seeds the persistent
        // pending-materialization signal (read by postprocess as
        // isExplicitFlush) plus history-refresh (consumed by transform).
        pendingMaterializationSessions.add("ses-1");
        historyRefreshSessions.add("ses-1");

        const secondPass: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "user prompt" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "text", text: "long assistant response that should be dropped" }],
            },
        ];

        //#when
        await transform({}, { messages: secondPass });

        //#then — sentinel replacement preserves array length;
        // the user message stays, assistant message neutralized to an empty sentinel.
        expect(secondPass).toHaveLength(2);
        expect(text(secondPass[0], 0)).toStartWith("\u00a71\u00a7 ");
        // Assistant message (previously dropped) now carries a single sentinel part.
        expect(secondPass[1].parts).toEqual([{ type: "text", text: "" }]);
    });

    it("keeps reduced magic-context support for subagent sessions", async () => {
        //#given
        useTempDataHome("context-transform-subagent-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "execute" as const) };
        const nudger = mock(() => ({
            type: "assistant" as const,
            text: "do not inject this nudge",
        }));
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-sub",
                    { usage: { percentage: 61, inputTokens: 122_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger,
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });

        const db = openDatabase();
        updateSessionMeta(db, "ses-sub", { isSubagent: true });

        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-sub" },
                parts: [{ type: "text", text: "do not touch" }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then
        // Subagents: DB tag records still exist so drops/heuristics work,
        // but agent-visible §N§ prefix is skipped (subagents are treated as
        // ctx_reduce_enabled=false since they have no nudge to act on tags).
        expect(text(messages[0], 0)).toBe("do not touch");
        expect(text(messages[0], 0)).not.toContain("do not inject this nudge");
        expect(getTagsBySession(db, "ses-sub")).toHaveLength(1);
        expect(scheduler.shouldExecute).toHaveBeenCalled();
        expect(nudger).not.toHaveBeenCalled();
    });

    it("injects project memory inside session-history when compartments exist", async () => {
        //#given
        useTempDataHome("context-transform-memory-compartment-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        const projectPath = resolveProjectIdentity("/repo/project");
        insertMemory(db, {
            projectPath,
            category: "USER_DIRECTIVES",
            content: "Always use Bun",
        });
        replaceAllCompartments(db, "ses-memory", [
            {
                sequence: 0,
                startMessage: 0,
                endMessage: 0,
                startMessageId: "",
                endMessageId: "",
                title: "Setup",
                content: "Initial setup work.",
            },
        ]);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-memory",
                    { usage: { percentage: 25, inputTokens: 50_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            directory: "/repo/project",
            memoryConfig: { enabled: true, injectionBudgetTokens: 500, autoPromote: true },
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user-1", role: "user", sessionID: "ses-memory" },
                parts: [{ type: "text", text: "continue" }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then — memory block appears inside session-history alongside compartments
        const injected = text(messages[0]!, 0);
        expect(injected).toContain("<session-history>");
        expect(injected).toContain("<project-memory>");
        expect(injected).toContain("Always use Bun");
        expect(injected).toContain('title="Setup"');
        expect(injected).toMatch(/<compartment start="\d+" end="\d+" title="Setup">/);
    });

    it("skips project memory injection for subagent sessions", async () => {
        //#given
        useTempDataHome("context-transform-memory-subagent-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        insertMemory(db, {
            projectPath: resolveProjectIdentity("/repo/project"),
            category: "USER_DIRECTIVES",
            content: "Always use Bun",
        });
        updateSessionMeta(db, "ses-sub-memory", { isSubagent: true });
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-sub-memory",
                    { usage: { percentage: 25, inputTokens: 50_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            directory: "/repo/project",
            memoryConfig: { enabled: true, injectionBudgetTokens: 500, autoPromote: true },
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user-1", role: "user", sessionID: "ses-sub-memory" },
                parts: [{ type: "text", text: "continue" }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then
        expect(text(messages[0]!, 0)).not.toContain("<project-memory>");
    });

    it("applies queued drops for subagent sessions", async () => {
        useTempDataHome("context-transform-subagent-drop-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "execute" as const) };
        const db = openDatabase();
        updateSessionMeta(db, "ses-sub-drop", { isSubagent: true });
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-sub-drop",
                    { usage: { percentage: 52, inputTokens: 104_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: mock(() => null),
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });

        const firstPass: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-sub-drop" },
                parts: [{ type: "text", text: "keep this" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "text", text: "drop this" }],
            },
        ];

        await transform({}, { messages: firstPass });
        queuePendingOp(db, "ses-sub-drop", 2, "drop", Date.now());

        const secondPass: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-sub-drop" },
                parts: [{ type: "text", text: "keep this" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "text", text: "drop this" }],
            },
        ];

        await transform({}, { messages: secondPass });

        // Sentinel replacement preserves array length. Subagent sessions
        // skip §N§ prefix injection, so user text appears verbatim.
        expect(secondPass).toHaveLength(2);
        expect(text(secondPass[0], 0)).toBe("keep this");
        expect(secondPass[1].parts).toEqual([{ type: "text", text: "" }]);
        expect(getPendingOps(db, "ses-sub-drop")).toHaveLength(0);
    });

    it("tags content that was injected before the transform runs, verifying injector-before-tagger ordering", async () => {
        //#given
        // This test documents the required hook ordering:
        // contextInjectorMessagesTransform must run BEFORE magicContext so that
        // injected content (AGENTS.md, README.md) is included in the tagging pass.
        useTempDataHome("context-transform-ordering-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-order",
                    { usage: { percentage: 30, inputTokens: 60_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });

        // Simulate content that context-injector would have prepended before this transform runs
        const injectedPrefix = "[AGENTS.md context injected by context-injector]\n";
        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-order" },
                parts: [{ type: "text", text: `${injectedPrefix}original user message` }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then
        // The injected prefix must be present inside the tagged content, proving that
        // tagging happened AFTER injection (i.e. injector ran first, tagger ran second).
        const taggedText = text(messages[0], 0);
        expect(taggedText).toStartWith("\u00a71\u00a7 ");
        expect(taggedText).toContain(injectedPrefix);
    });

    it("assigns separate tags to multiple text parts in the same message to prevent synthetic content collision", async () => {
        //#given
        useTempDataHome("context-transform-multipart-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "execute" as const) };
        const tagger = createTagger();
        const transform = createTransform({
            tagger,
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-multi",
                    { usage: { percentage: 50, inputTokens: 100_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });

        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-multi" },
                parts: [
                    { type: "text", text: "[synthetic injected content]" },
                    { type: "text", text: "actual user message" },
                ],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then
        const firstPart = text(messages[0], 0);
        const secondPart = text(messages[0], 1);
        expect(firstPart).toStartWith("\u00a71\u00a7 ");
        expect(secondPart).toStartWith("\u00a72\u00a7 ");
        expect(firstPart).toContain("[synthetic injected content]");
        expect(secondPart).toContain("actual user message");

        const db = openDatabase();
        queuePendingOp(db, "ses-multi", 1, "drop");

        const secondPass: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-multi" },
                parts: [
                    { type: "text", text: "[synthetic injected content]" },
                    { type: "text", text: "actual user message" },
                ],
            },
        ];
        await transform({}, { messages: secondPass });

        // User messages get a truncated preview (not a full drop) so the turn
        // boundary survives for AI SDK's Anthropic adapter. The first part is
        // a text-only synthetic content — it remains marked as truncated while
        // preserving its original text (which is under the preview window).
        expect(text(secondPass[0], 0)).toBe(
            "[truncated \u00a71\u00a7]\n[synthetic injected content]",
        );
        expect(text(secondPass[0], 1)).toStartWith("\u00a72\u00a7 ");
        expect(text(secondPass[0], 1)).toContain("actual user message");
    });

    it("clears thinking parts when a text part in the same message is dropped", async () => {
        //#given
        useTempDataHome("context-transform-thinking-");
        const shouldExecute = mock<Scheduler["shouldExecute"]>(() => "defer");
        const scheduler: Scheduler = { shouldExecute };
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-think",
                    { usage: { percentage: 60, inputTokens: 120_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });

        const firstPass: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-think" },
                parts: [{ type: "text", text: "user prompt" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [
                    { type: "thinking", thinking: "long internal reasoning that eats context" },
                    { type: "text", text: "short answer" },
                ],
            },
        ];
        await transform({}, { messages: firstPass });

        const db = openDatabase();
        const assistantTextTag = 2;
        queuePendingOp(db, "ses-think", assistantTextTag, "drop");
        shouldExecute.mockImplementation(() => "execute");

        const secondPass: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-think" },
                parts: [{ type: "text", text: "user prompt" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [
                    { type: "thinking", thinking: "long internal reasoning that eats context" },
                    { type: "text", text: "short answer" },
                ],
            },
        ];

        //#when
        await transform({}, { messages: secondPass });

        //#then — thinking part becomes sentinel; text becomes [dropped §2§];
        // assistant message neutralized to a lone sentinel (array length preserved).
        expect(secondPass).toHaveLength(2);
        expect(text(secondPass[0], 0)).toContain("user prompt");
        expect(secondPass[1].parts).toEqual([{ type: "text", text: "" }]);
    });

    it("fails open when session meta lookup throws", async () => {
        //#given
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const tagger = createTagger();
        const nudger = mock(() => null);
        const failingDb = {
            prepare: mock(() => {
                throw new Error("session_meta unavailable");
            }),
            transaction: mock((callback: () => void) => () => callback()),
        } as unknown as ReturnType<typeof openDatabase>;
        const transform = createTransform({
            tagger,
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>(),
            nudger,
            db: failingDb,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-meta-fail" },
                parts: [{ type: "text", text: "keep" }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then
        expect(text(messages[0], 0)).toBe("keep");
        expect(nudger).not.toHaveBeenCalled();
    });

    it("fails open when tagger init fails", async () => {
        //#given
        useTempDataHome("context-transform-tagger-error-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const nudger = mock(() => null);
        const db = openDatabase();
        const tagger = {
            ...createTagger(),
            initFromDb: mock(() => {
                throw new Error("tagger broken");
            }),
        };
        const transform = createTransform({
            tagger,
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-tagger-fail",
                    { usage: { percentage: 40, inputTokens: 80_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-tagger-fail" },
                parts: [{ type: "text", text: "still works" }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then
        expect(text(messages[0], 0)).toBe("still works");
        expect(nudger).toHaveBeenCalledTimes(1);
    });

    it("fails open when scheduler throws and still appends nudge to assistant", async () => {
        //#given
        useTempDataHome("context-transform-scheduler-error-");
        const scheduler: Scheduler = {
            shouldExecute: mock(() => {
                throw new Error("scheduler failed");
            }),
        };
        const nudgeText = "Use ctx_reduce now";
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-scheduler-fail",
                    { usage: { percentage: 66, inputTokens: 132_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => ({ type: "assistant", text: nudgeText }),
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-scheduler-fail" },
                parts: [{ type: "text", text: "hello" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "text", text: "answer" }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then
        expect(text(messages[1], 0)).toContain(nudgeText);
    });

    it("resets persisted usage on first pass then lazy-loads on second pass", async () => {
        //#given
        useTempDataHome("context-transform-lazy-load-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const nudger = mock(() => ({
            type: "assistant" as const,
            text: "Your context is at ~50%.",
        }));
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>();
        const db = openDatabase();

        updateSessionMeta(db, "ses-lazy", {
            lastContextPercentage: 50,
            lastInputTokens: 100_000,
        });

        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap,
            nudger,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-lazy" },
                parts: [{ type: "text", text: "after restart" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "text", text: "response" }],
            },
        ];

        //#when — first pass resets stale percentage to 0
        await transform({}, { messages });

        //#then — first pass resets persisted usage; 0/0 is not cached in the map
        // (loadPersistedUsage returns null for 0/0 values)
        expect(contextUsageMap.has("ses-lazy")).toBe(false);

        //#when — simulate message.updated setting real usage, then second pass loads it
        contextUsageMap.delete("ses-lazy");
        updateSessionMeta(db, "ses-lazy", {
            lastContextPercentage: 50,
            lastInputTokens: 100_000,
        });
        await transform({}, { messages });

        //#then — second pass lazy-loads from DB
        const entry2 = contextUsageMap.get("ses-lazy");
        expect(entry2?.usage.percentage).toBe(50);
        expect(entry2?.usage.inputTokens).toBe(100_000);
    });

    it("applies persisted drops even without contextUsageMap entry or persisted usage", async () => {
        //#given
        useTempDataHome("context-transform-drops-no-usage-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const nudger = mock(() => null);
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>();
        const db = openDatabase();

        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap,
            nudger,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });

        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-no-usage" },
                parts: [{ type: "text", text: "user message" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [
                    { type: "text", text: "response text" },
                    { type: "tool", callID: "call-1", state: { output: "big tool output" } },
                ],
            },
        ];

        //#when — first pass to tag
        await transform({}, { messages });

        //#then — tags created, content tagged
        const tags = getTagsBySession(db, "ses-no-usage");
        expect(tags.length).toBe(3);

        //#when — mark a tag as dropped and run second pass
        const toolTag = tags.find((t) => t.type === "tool");
        if (toolTag) updateTagStatus(db, "ses-no-usage", toolTag.tagNumber, "dropped");

        await transform({}, { messages });

        //#then — dropped tag's content is replaced even without usage data
        expect(toolOutput(messages[1], 1)).toBe("");
        expect(nudger).toHaveBeenCalledTimes(2);
    });

    it("preserves typed reasoning parts across transform passes for interleaved-reasoning models", async () => {
        useTempDataHome("context-transform-interleaved-reasoning-");
        // useTempDataHome points XDG_CACHE_HOME at the temp dir; write a
        // synthetic models.json so `models-dev-cache.ts` sees that Kimi
        // declares `interleaved.field = "reasoning_content"` without needing
        // live provider data.
        const cacheHome = process.env.XDG_CACHE_HOME as string;
        const opencodeDir = join(cacheHome, "opencode");
        mkdirSync(opencodeDir, { recursive: true });
        writeFileSync(
            join(opencodeDir, "models.json"),
            JSON.stringify({
                "opencode-go": {
                    models: {
                        "kimi-k2.6": {
                            limit: { context: 262144, output: 65536 },
                            interleaved: { field: "reasoning_content" },
                        },
                    },
                },
            }),
        );
        clearModelsDevCache();

        const scheduler: Scheduler = { shouldExecute: mock(() => "execute" as const) };
        const db = openDatabase();
        // Three-set refactor: pre-seed both sets to simulate active flush.
        const historyRefreshSessions = new Set<string>(["ses-kimi"]);
        const pendingMaterializationSessions = new Set<string>(["ses-kimi"]);
        const liveModelBySession = new Map<string, { providerID: string; modelID: string }>([
            ["ses-kimi", { providerID: "opencode-go", modelID: "kimi-k2.6" }],
        ]);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-kimi",
                    { usage: { percentage: 70, inputTokens: 180_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 0,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
            liveModelBySession,
        });

        const firstPass: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-kimi" },
                parts: [{ type: "text", text: "run the tool" }],
            },
            {
                info: {
                    id: "m-assistant",
                    role: "assistant",
                    sessionID: "ses-kimi",
                    providerID: "opencode-go",
                    modelID: "kimi-k2.6",
                },
                parts: [
                    { type: "reasoning", text: "must survive" },
                    { type: "text", text: "tool call follows" },
                ],
            },
        ];

        await transform({}, { messages: firstPass });

        expect(firstPass[1]?.parts.filter((part) => part.type === "reasoning")).toHaveLength(1);
        expect(getOrCreateSessionMeta(db, "ses-kimi").clearedReasoningThroughTag).toBe(0);

        updateSessionMeta(db, "ses-kimi", { clearedReasoningThroughTag: 99 });
        // Three-set refactor: re-add to history-refresh after first pass
        // drained it. Pending-materialization persists until heuristics run,
        // so it's still set from the initial seeding.
        historyRefreshSessions.add("ses-kimi");
        pendingMaterializationSessions.add("ses-kimi");
        const secondPass: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-kimi" },
                parts: [{ type: "text", text: "run the tool" }],
            },
            {
                info: {
                    id: "m-assistant",
                    role: "assistant",
                    sessionID: "ses-kimi",
                    providerID: "opencode-go",
                    modelID: "kimi-k2.6",
                },
                parts: [
                    { type: "reasoning", text: "must survive" },
                    { type: "text", text: "tool call follows" },
                ],
            },
        ];

        await transform({}, { messages: secondPass });

        const reasoningParts =
            secondPass[1]?.parts.filter((part) => part.type === "reasoning") ?? [];
        expect(reasoningParts).toHaveLength(1);
        expect(secondPass[1]?.parts).toHaveLength(2);
        expect((reasoningParts[0] as ReasoningPart).text).toBe("must survive");
    });

    it("preserves reasoning across consecutive assistants for interleaved-reasoning models", async () => {
        // The Anthropic groupIntoBlocks workaround
        // (`stripReasoningFromMergedAssistants`) strips reasoning from
        // non-first assistants in a consecutive run. That workaround is
        // Anthropic-specific and actively breaks Moonshot/Kimi because
        // OpenCode needs every reasoning part on tool-call messages to emit
        // `reasoning_content`. This test documents that the gate keeps
        // reasoning on BOTH assistants in a consecutive run when the live
        // model uses interleaved reasoning.
        useTempDataHome("context-transform-interleaved-merged-");
        const cacheHome = process.env.XDG_CACHE_HOME as string;
        const opencodeDir = join(cacheHome, "opencode");
        mkdirSync(opencodeDir, { recursive: true });
        writeFileSync(
            join(opencodeDir, "models.json"),
            JSON.stringify({
                "opencode-go": {
                    models: {
                        "kimi-k2.6": {
                            limit: { context: 262144, output: 65536 },
                            interleaved: { field: "reasoning_content" },
                        },
                    },
                },
            }),
        );
        clearModelsDevCache();

        const scheduler: Scheduler = { shouldExecute: mock(() => "execute" as const) };
        const db = openDatabase();
        const historyRefreshSessions = new Set<string>(["ses-kimi-run"]);
        const pendingMaterializationSessions = new Set<string>(["ses-kimi-run"]);
        const liveModelBySession = new Map<string, { providerID: string; modelID: string }>([
            ["ses-kimi-run", { providerID: "opencode-go", modelID: "kimi-k2.6" }],
        ]);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-kimi-run",
                    { usage: { percentage: 70, inputTokens: 180_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 0,
            protectedTags: 0,
            autoDropToolAge: 1000,
            dropToolStructure: true,
            liveModelBySession,
        });

        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-kimi-run" },
                parts: [{ type: "text", text: "do a multi-step task" }],
            },
            {
                info: {
                    id: "m-assistant-1",
                    role: "assistant",
                    sessionID: "ses-kimi-run",
                    providerID: "opencode-go",
                    modelID: "kimi-k2.6",
                },
                parts: [
                    { type: "reasoning", text: "step 1 reasoning" },
                    { type: "text", text: "step 1 output" },
                ],
            },
            {
                info: {
                    id: "m-assistant-2",
                    role: "assistant",
                    sessionID: "ses-kimi-run",
                    providerID: "opencode-go",
                    modelID: "kimi-k2.6",
                },
                parts: [
                    { type: "reasoning", text: "step 2 reasoning" },
                    { type: "text", text: "step 2 output" },
                ],
            },
        ];

        await transform({}, { messages });

        // BOTH assistants must keep their reasoning parts. The Anthropic
        // merged-assistants workaround would have stripped reasoning from
        // the second assistant.
        const assistant1Reasoning = messages[1]?.parts.filter((p) => p.type === "reasoning") ?? [];
        const assistant2Reasoning = messages[2]?.parts.filter((p) => p.type === "reasoning") ?? [];
        expect(assistant1Reasoning).toHaveLength(1);
        expect(assistant2Reasoning).toHaveLength(1);
        expect((assistant1Reasoning[0] as ReasoningPart).text).toBe("step 1 reasoning");
        expect((assistant2Reasoning[0] as ReasoningPart).text).toBe("step 2 reasoning");
    });
});

function createOpenCodeDbForTransform(
    sessionId: string,
    messages: Array<{ id: string; role: string; text: string }>,
): void {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
      CREATE TABLE IF NOT EXISTS message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS part (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
        const insertMessage = db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        const insertPart = db.prepare(
            "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        messages.forEach((message, index) => {
            const timestamp = index + 1;
            insertMessage.run(
                message.id,
                sessionId,
                timestamp,
                timestamp,
                JSON.stringify({ id: message.id, role: message.role, sessionID: sessionId }),
            );
            insertPart.run(
                message.id,
                sessionId,
                timestamp,
                timestamp,
                JSON.stringify({ type: "text", text: message.text }),
            );
        });
    } finally {
        closeQuietly(db);
    }
}

describe("createTransform protected tail", () => {
    it("clears compartmentInProgress without starting historian when only protected-tail history exists", async () => {
        //#given
        useTempDataHome("transform-protected-tail-flag-");
        createOpenCodeDbForTransform("ses-pt-flag", [
            { id: "m-raw-1", role: "user", text: "recent 1" },
            { id: "m-raw-2", role: "user", text: "recent 2" },
            { id: "m-raw-3", role: "user", text: "recent 3" },
        ]);
        const db = openDatabase();
        updateSessionMeta(db, "ses-pt-flag", { compartmentInProgress: true });

        const createSession = mock(async () => ({ data: { id: "ses-agent" } }));
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp" } })),
                create: createSession,
                prompt: mock(async () => ({})),
                messages: mock(async () => ({ data: [] })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                [
                    "ses-pt-flag",
                    { usage: { percentage: 20, inputTokens: 40_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            client,
            directory: "/tmp",
        });

        const messages: TestMessage[] = [
            {
                info: { id: "m-1", role: "user", sessionID: "ses-pt-flag" },
                parts: [{ type: "text", text: "recent 1" }],
            },
            { info: { id: "m-2", role: "assistant" }, parts: [{ type: "text", text: "done" }] },
        ];

        //#when
        await transform({}, { messages });

        //#then: no historian session created and flag was cleared
        expect(createSession).not.toHaveBeenCalled();
        const meta = getOrCreateSessionMeta(db, "ses-pt-flag");
        expect(meta.compartmentInProgress).toBe(false);
    });

    it("does not force-start historian at 95% when only protected-tail history exists", async () => {
        //#given
        useTempDataHome("transform-protected-tail-95-");
        createOpenCodeDbForTransform("ses-pt-95", [
            { id: "m-raw-1", role: "user", text: "recent 1" },
            { id: "m-raw-2", role: "user", text: "recent 2" },
            { id: "m-raw-3", role: "user", text: "recent 3" },
        ]);
        const db = openDatabase();

        const createSession = mock(async () => ({ data: { id: "ses-agent" } }));
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp" } })),
                create: createSession,
                prompt: mock(async () => ({})),
                messages: mock(async () => ({ data: [] })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                [
                    "ses-pt-95",
                    { usage: { percentage: 96, inputTokens: 192_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            client,
            directory: "/tmp",
        });

        const messages: TestMessage[] = [
            {
                info: { id: "m-1", role: "user", sessionID: "ses-pt-95" },
                parts: [{ type: "text", text: "recent 1" }],
            },
            { info: { id: "m-2", role: "assistant" }, parts: [{ type: "text", text: "done" }] },
        ];

        //#when
        await transform({}, { messages });

        //#then: historian was not started despite being at 95%
        expect(createSession).not.toHaveBeenCalled();
    });

    it("clears stale compartmentInProgress when no eligible history exists", async () => {
        //#given — stale compartmentInProgress with no raw history to resume
        useTempDataHome("transform-protected-tail-pending-");
        createOpenCodeDbForTransform("ses-pt-pending", []);
        const db = openDatabase();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: () => "defer" },
            contextUsageMap: new Map([
                [
                    "ses-pt-pending",
                    { usage: { percentage: 60, inputTokens: 120_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 10,
            autoDropToolAge: 1000,
            client: {
                session: {
                    get: mock(async () => ({ data: { directory: "/tmp" } })),
                    create: mock(async () => ({ data: { id: "ses-agent" } })),
                    prompt: mock(async () => ({})),
                    messages: mock(async () => ({ data: [] })),
                    delete: mock(async () => ({})),
                },
            } as unknown as PluginContext["client"],
            directory: "/tmp",
        });

        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-pt-pending" },
                parts: [{ type: "text", text: "hello" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "text", text: "world" }],
            },
        ];

        //#when — first pass initializes session, then set stale flag
        await transform({}, { messages });
        updateSessionMeta(db, "ses-pt-pending", { compartmentInProgress: true });
        expect(getOrCreateSessionMeta(db, "ses-pt-pending").compartmentInProgress).toBe(true);

        //#when — second pass detects stale flag, clears it (no eligible history to resume)
        await transform({}, { messages });

        //#then
        expect(getOrCreateSessionMeta(db, "ses-pt-pending").compartmentInProgress).toBe(false);
    });
});

describe("createTransform historian failure handling", () => {
    it("aborts at 95% and only sends the emergency notification once per failure count", async () => {
        useTempDataHome("transform-historian-emergency-");
        createOpenCodeDbForTransform("ses-emergency", [
            { id: "m-raw-1", role: "user", text: "recent 1" },
            { id: "m-raw-2", role: "assistant", text: "recent 2" },
            { id: "m-raw-3", role: "user", text: "recent 3" },
        ]);
        const db = openDatabase();
        incrementHistorianFailure(db, "ses-emergency", "429 rate limit from historian provider");

        const abort = mock(async () => ({}));
        const prompt = mock(async () => ({}));
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                [
                    "ses-emergency",
                    { usage: { percentage: 96, inputTokens: 192_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            client: { session: { abort, prompt } } as unknown as PluginContext["client"],
            directory: "/tmp",
        });

        const firstPass: TestMessage[] = [
            {
                info: { id: "m-user-1", role: "user", sessionID: "ses-emergency" },
                parts: [{ type: "text", text: "continue" }],
            },
            {
                info: { id: "m-assistant-1", role: "assistant" },
                parts: [{ type: "text", text: "ok" }],
            },
        ];
        const secondPass: TestMessage[] = [
            {
                info: { id: "m-user-2", role: "user", sessionID: "ses-emergency" },
                parts: [{ type: "text", text: "continue" }],
            },
            {
                info: { id: "m-assistant-2", role: "assistant" },
                parts: [{ type: "text", text: "ok" }],
            },
        ];
        const thirdPass: TestMessage[] = [
            {
                info: { id: "m-user-3", role: "user", sessionID: "ses-emergency" },
                parts: [{ type: "text", text: "continue" }],
            },
            {
                info: { id: "m-assistant-3", role: "assistant" },
                parts: [{ type: "text", text: "ok" }],
            },
        ];

        await transform({}, { messages: firstPass });
        await transform({}, { messages: secondPass });
        incrementHistorianFailure(db, "ses-emergency", "503 overloaded");
        await transform({}, { messages: thirdPass });

        const emergencyNotifications = (
            prompt.mock.calls as unknown as Array<
                [{ body?: { noReply?: boolean; parts?: Array<{ text?: string }> } }]
            >
        )
            .map((call) => call[0])
            .filter(
                (input) =>
                    input.body?.noReply === true &&
                    (input.body?.parts?.[0]?.text ?? "").includes("Context Emergency"),
            );

        expect(abort).toHaveBeenCalledTimes(3);
        expect(emergencyNotifications).toHaveLength(2);
        expect(emergencyNotifications[0]?.body?.parts?.[0]?.text).toContain("96.0%");
        expect(emergencyNotifications[0]?.body?.parts?.[0]?.text).toContain(
            "429 rate limit from historian provider",
        );
        expect(emergencyNotifications[1]?.body?.parts?.[0]?.text).toContain("503 overloaded");
    });

    it("starts historian recovery on the first transform pass after restart and clears failure state on success", async () => {
        useTempDataHome("transform-historian-recovery-");
        createOpenCodeDbForTransform("ses-recovery", [
            { id: "m-1", role: "user", text: "eligible one" },
            { id: "m-2", role: "assistant", text: "eligible two" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        incrementHistorianFailure(db, "ses-recovery", "503 overloaded");

        const createSession = mock(async () => ({ data: { id: "ses-recovery-child" } }));
        const prompt = mock(async () => ({}));
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                [
                    "ses-recovery",
                    { usage: { percentage: 70, inputTokens: 140_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
            client: {
                session: {
                    get: mock(async () => ({ data: { directory: "/tmp/recovery" } })),
                    create: createSession,
                    prompt,
                    messages: mock(async () => ({
                        data: [
                            {
                                info: { role: "assistant", time: { created: 1 } },
                                parts: [
                                    {
                                        type: "text",
                                        text: `<compartment start="1" end="2" title="Recovered">Summary</compartment>`,
                                    },
                                ],
                            },
                        ],
                    })),
                    delete: mock(async () => ({})),
                },
            } as unknown as PluginContext["client"],
            directory: "/tmp",
        });

        const firstPass: TestMessage[] = [
            {
                info: { id: "m-user-1", role: "user", sessionID: "ses-recovery" },
                parts: [{ type: "text", text: "continue" }],
            },
            {
                info: { id: "m-assistant-1", role: "assistant" },
                parts: [{ type: "text", text: "ok" }],
            },
        ];
        const secondPass: TestMessage[] = [
            {
                info: { id: "m-user-2", role: "user", sessionID: "ses-recovery" },
                parts: [{ type: "text", text: "continue" }],
            },
            {
                info: { id: "m-assistant-2", role: "assistant" },
                parts: [{ type: "text", text: "ok" }],
            },
        ];

        await transform({}, { messages: firstPass });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(createSession).toHaveBeenCalledTimes(1);
        expect(
            (
                prompt.mock.calls as unknown as Array<
                    [{ body?: { noReply?: boolean; parts?: Array<{ text?: string }> } }]
                >
            ).some((call) => {
                const input = call[0];
                return (
                    input.body?.noReply === true &&
                    (input.body?.parts?.[0]?.text ?? "").includes("Historian recovery")
                );
            }),
        ).toBe(true);
        expect(getHistorianFailureState(db, "ses-recovery")).toEqual({
            failureCount: 0,
            lastError: null,
            lastFailureAt: null,
        });

        await transform({}, { messages: secondPass });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(createSession).toHaveBeenCalledTimes(1);
    });
});
