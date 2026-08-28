/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    replaceAllCompartmentState,
    replaceAllCompartments,
} from "../../features/magic-context/compartment-storage";
import { insertMemory } from "../../features/magic-context/memory";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import {
    __resetMessageIndexAsyncForTests,
    isSessionReconciled,
} from "../../features/magic-context/message-index-async";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    clearPendingOps,
    closeDatabase,
    getChannel1NudgeState,
    getHistorianFailureState,
    getLastNudgeUndropped,
    getOrCreateSessionMeta,
    getOverflowState,
    getPendingOps,
    getTagById,
    getTagsBySession,
    incrementHistorianFailure,
    insertTag,
    loadProtectedTailMeta,
    openDatabase,
    queuePendingOp,
    recordOverflowDetected,
    setChannel1NudgeState,
    setLastNudgeUndropped,
    updateSessionMeta,
    updateTagStatus,
} from "../../features/magic-context/storage";
import {
    getEmergencyInputSample,
    setEmergencyDropSample,
} from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { recordToolDefinition } from "../../features/magic-context/tool-definition-tokens";
import {
    scheduleOpenCodeTransformDecisionWrite,
    __test as transformDecisionTest,
} from "../../features/magic-context/transform-decision-log";
import type { ContextUsage } from "../../features/magic-context/types";
import { buildSidebarSnapshot } from "../../plugin/rpc-handlers";
import type { PluginContext } from "../../plugin/types";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { getSlot, resetLkgSlotsForTest } from "./lkg-slot";
import { createTransform } from "./transform";

type TextPart = { type: "text"; text: string };
type ToolPart = {
    type: "tool";
    callID: string;
    state: { status?: string; output: string };
};
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
        tools?: Record<string, unknown>;
    };
    parts: TestPart[];
};

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;

afterEach(() => {
    __resetMessageIndexAsyncForTests();
    transformDecisionTest.reset();
    resetLkgSlotsForTest();
    closeDatabase();
    clearModelsDevCache();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;

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
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dir;
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
    it("keeps the raw array untouched when session metadata is unreadable", async () => {
        useTempDataHome("context-transform-meta-fault-");
        const db = openDatabase();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "execute" as const) },
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>(),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "meta-fault-user", role: "user", sessionID: "ses-meta-fault" },
                parts: [{ type: "text", text: "raw must survive" }],
            },
        ];
        const original = structuredClone(messages);
        const output = { messages };
        db.exec("DROP TABLE session_meta");

        await transform({}, output);

        expect(output.messages).toBe(messages);
        expect(messages).toEqual(original);
    });

    it("persists distinct TypeScript transform decision reasons from ordinary passes", async () => {
        useTempDataHome("context-transform-decision-fence-");
        const sessionId = "ses-transform-decision-fence";
        const db = openDatabase();
        const liveModelBySession = new Map([
            [sessionId, { providerID: "test-provider", modelID: "model-a" }],
        ]);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "execute" as const) },
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 40, inputTokens: 40_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            directory: process.cwd(),
            liveModelBySession,
        });
        const messages = (): TestMessage[] => [
            {
                info: { id: "decision-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "record this pass" }],
            },
        ];
        const bindDecision = async (messageId: string): Promise<void> => {
            expect(
                scheduleOpenCodeTransformDecisionWrite({
                    db,
                    sessionId,
                    messageId,
                    inputTokens: 40_000,
                }),
            ).toBe(true);
            await new Promise((resolve) => setTimeout(resolve, 5));
        };

        await transform({}, { messages: messages() });
        await bindDecision("decision-response-a");
        liveModelBySession.set(sessionId, {
            providerID: "test-provider",
            modelID: "model-b",
        });
        await transform({}, { messages: messages() });
        await bindDecision("decision-response-b");

        const rows = db
            .prepare(
                `SELECT message_id, materialize_reason
                   FROM transform_decisions
                  WHERE session_id = ?
                  ORDER BY rowid`,
            )
            .all(sessionId) as Array<{ message_id: string; materialize_reason: string | null }>;
        expect(rows).toEqual([
            { message_id: "decision-response-a", materialize_reason: "first_render" },
            { message_id: "decision-response-b", materialize_reason: "model_change" },
        ]);
        expect(rows[0]?.materialize_reason).not.toBe(rows[1]?.materialize_reason);
    });

    it("captures distinct LKG prefixes and token telemetry consumed by sidebar snapshots", async () => {
        useTempDataHome("context-transform-outcome-fence-");
        const db = openDatabase();
        const shortSession = "ses-outcome-short";
        const longSession = "ses-outcome-long";
        const toolSession = "ses-outcome-tool";
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map(
                [shortSession, longSession, toolSession].map((sessionId) => [
                    sessionId,
                    { usage: { percentage: 10, inputTokens: 10_000 }, updatedAt: Date.now() },
                ]),
            ),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            directory: process.cwd(),
        });
        const shortMessages: TestMessage[] = [
            {
                info: { id: "short-user", role: "user", sessionID: shortSession },
                parts: [{ type: "text", text: "short" }],
            },
        ];
        const longMessages: TestMessage[] = [
            {
                info: { id: "long-user", role: "user", sessionID: longSession },
                parts: [{ type: "text", text: "long conversation ".repeat(200) }],
            },
        ];
        const toolMessages: TestMessage[] = [
            {
                info: { id: "tool-user", role: "user", sessionID: toolSession },
                parts: [{ type: "text", text: "inspect the tool output" }],
            },
            {
                info: { id: "tool-assistant", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        callID: "diagnostic-call",
                        state: {
                            status: "completed",
                            output: "diagnostic tool output ".repeat(100),
                        },
                    },
                ],
            },
        ];

        await transform({}, { messages: shortMessages });
        await transform({}, { messages: longMessages });
        await transform({}, { messages: toolMessages });

        expect(getSlot(shortSession)?.lastInputMessageId).toBe("short-user");
        expect(getSlot(longSession)?.lastInputMessageId).toBe("long-user");
        expect(getSlot(shortSession)?.jsonPrefix).not.toBe(getSlot(longSession)?.jsonPrefix);

        const telemetry = db
            .prepare(
                `SELECT session_id, conversation_tokens, tool_call_tokens
                   FROM session_meta
                  WHERE session_id IN (?, ?, ?)
                  ORDER BY session_id`,
            )
            .all(longSession, shortSession, toolSession) as Array<{
            session_id: string;
            conversation_tokens: number;
            tool_call_tokens: number;
        }>;
        const bySession = new Map(telemetry.map((row) => [row.session_id, row]));
        expect(bySession.get(shortSession)?.conversation_tokens).toBeGreaterThan(0);
        expect(bySession.get(longSession)?.conversation_tokens).toBeGreaterThan(
            bySession.get(shortSession)?.conversation_tokens ?? 0,
        );
        expect(bySession.get(shortSession)?.tool_call_tokens).toBe(0);
        expect(bySession.get(toolSession)?.tool_call_tokens).toBeGreaterThan(0);

        const moduleStatus = {
            usage: { current_total_input_tokens: 10_000, context_limit_tokens: 100_000 },
        };
        const shortSnapshot = buildSidebarSnapshot(
            db,
            shortSession,
            process.cwd(),
            undefined,
            undefined,
            undefined,
            moduleStatus,
        );
        const longSnapshot = buildSidebarSnapshot(
            db,
            longSession,
            process.cwd(),
            undefined,
            undefined,
            undefined,
            moduleStatus,
        );
        const toolSnapshot = buildSidebarSnapshot(
            db,
            toolSession,
            process.cwd(),
            undefined,
            undefined,
            undefined,
            moduleStatus,
        );
        expect(shortSnapshot.toolCallTokens).toBe(0);
        expect(toolSnapshot.toolCallTokens).toBeGreaterThan(0);
        expect(shortSnapshot.conversationTokens).not.toBe(toolSnapshot.conversationTokens);
        expect(longSnapshot.conversationTokens).toBeGreaterThan(0);
    });

    it("schedules first-touch message index reconciliation once per session", async () => {
        useTempDataHome("context-transform-index-reconcile-");
        createOpenCodeDbForTransform("ses-reconcile", [
            { id: "m-user", role: "user", text: "hello" },
        ]);
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>(),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            client: {} as PluginContext["client"],
        });

        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-reconcile" },
                parts: [{ type: "text", text: "hello" }],
            },
        ];

        await transform({}, { messages });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(isSessionReconciled("ses-reconcile")).toBe(true);

        await transform({}, { messages });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(isSessionReconciled("ses-reconcile")).toBe(true);
    });

    it("tags text/tool content without injecting any assistant-anchored nudge", async () => {
        //#given
        useTempDataHome("context-transform-tag-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>([
            ["ses-1", { usage: { percentage: 46, inputTokens: 92_000 }, updatedAt: Date.now() }],
        ]);
        const db = openDatabase();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap,
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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

        //#then — tagging happens, but the deleted rolling-nudge no longer appends.
        expect(text(messages[2], 0)).not.toContain("Context at ~45%");
        expect(text(messages[0], 0)).toStartWith("§1§ ");
        expect(text(messages[1], 0)).toContain("§2§ ");
        expect(toolOutput(messages[1], 1)).toStartWith("§3§ ");
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
            db: openDatabase(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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
            db,
            historyRefreshSessions: flushedHistory,
            pendingMaterializationSessions: flushedMaterialization,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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
        // Default (no providerID set) → `[dropped]` sentinel for non-anthropic
        // safety. Anthropic-only optimization (text="") is covered separately.
        expect(messages[1]?.info.id).toBe("m-4");
        expect(messages[1]?.parts).toEqual([{ type: "text", text: "[dropped]" }]);
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
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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

    it("fires the tiered emergency drop at 85% on a reclaimable tail", async () => {
        //#given a large tool output in the tail so there is something to reclaim.
        // The tiered drop is target-driven: at 85% it reclaims down toward 30% of
        // working space. A tiny tool output (as the old need-blind drop assumed)
        // is correctly NOT dropped now — there must be real tail tokens to free.
        useTempDataHome("context-transform-force-materialize-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        // Realistic ~200KB tool output (~50k tokens). NOT a single repeated char:
        // BPE tokenizes "x".repeat(200k) pathologically slowly (~17s) AND yields
        // only ~6k tokens, so it never matched the "~50k tokens" intent. Real
        // content of the same size tokenizes in ~7ms and hits the real token mass.
        const bigOutput = "const value = compute(input, options); // step output line\n".repeat(
            3400,
        );
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-force-materialize",
                    { usage: { percentage: 86, inputTokens: 172_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-force-materialize" },
                parts: [{ type: "text", text: "continue" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "tool", callID: "call-1", state: { output: bigOutput } }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then — the newest-window emergency arm keeps a structural skeleton.
        expect(messages).toHaveLength(2);
        expect(messages[0]?.info.id).toBe("m-user");
        expect(messages[1]?.info.id).toBe("m-assistant");
        const tags = getTagsBySession(db, "ses-force-materialize");
        expect(tags.find((tag) => tag.type === "tool")?.status).toBe("dropped");
        expect(tags.find((tag) => tag.type === "tool")?.dropMode).toBe("truncated");
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
            db: openDatabase(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 10,
            liveModelBySession: new Map([
                ["ses-structural", { providerID: "anthropic", modelID: "claude-sonnet" }],
            ]),
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

        //#then — Anthropic sentinel replacement preserves array length;
        // empty-text sentinels are dropped at the wire by OpenCode's Anthropic adapter.
        expect(messages[1].parts).toHaveLength(5);
        // The live text part survives unchanged
        expect(text(messages[1], 0)).toContain("visible answer");
        // Structural noise parts are replaced with empty-text sentinels
        const sentineledParts = (
            messages[1].parts as Array<{ type: string; text?: string }>
        ).filter((p) => p.type === "text" && p.text === "");
        expect(sentineledParts).toHaveLength(4);
    });

    it("keeps github-copilot tool-adjacent step-finish native instead of adding an empty sentinel", async () => {
        //#given
        useTempDataHome("context-transform-copilot-step-finish-");
        const sessionId = "ses-copilot-step-finish";
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    sessionId,
                    { usage: { percentage: 20, inputTokens: 40_000 }, updatedAt: Date.now() },
                ],
            ]),
            db: openDatabase(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 10,
            liveModelBySession: new Map([
                [sessionId, { providerID: "github-copilot", modelID: "claude-sonnet" }],
            ]),
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "continue" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [
                    { type: "tool", callID: "call-1", state: { output: "result" } },
                    { type: "step-finish", text: "done" },
                ],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then — copilot's OpenCode path does not filter empty text parts, so no
        // empty sentinel may be inserted between a tool_use and its following result.
        expect(messages[1].parts[1]).toEqual({ type: "step-finish", text: "done" });
        expect(
            (messages[1].parts as Array<{ type?: string; text?: string }>).some(
                (part) => part.type === "text" && part.text === "",
            ),
        ).toBe(false);
    });

    it("keeps step-start native for github-copilot but sentinelizes it for anthropic", async () => {
        //#given
        useTempDataHome("context-transform-provider-step-start-");
        const runForProvider = async (providerID: string, sessionId: string) => {
            const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
            const transform = createTransform({
                tagger: createTagger(),
                scheduler,
                contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                    [
                        sessionId,
                        { usage: { percentage: 20, inputTokens: 40_000 }, updatedAt: Date.now() },
                    ],
                ]),
                db: openDatabase(),
                historyRefreshSessions: new Set<string>(),
                pendingMaterializationSessions: new Set<string>(),
                lastHeuristicsTurnId: new Map<string, string>(),
                clearReasoningAge: 50,
                protectedTags: 10,
                liveModelBySession: new Map([
                    [sessionId, { providerID, modelID: "claude-sonnet" }],
                ]),
            });
            const messages: TestMessage[] = [
                {
                    info: { id: `${sessionId}-user`, role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "continue" }],
                },
                {
                    info: { id: `${sessionId}-assistant`, role: "assistant" },
                    parts: [
                        { type: "tool", callID: "call-1", state: { output: "result" } },
                        { type: "step-start", text: "start" },
                        { type: "text", text: "visible" },
                    ],
                },
            ];
            await transform({}, { messages });
            return messages;
        };

        //#when
        const copilotMessages = await runForProvider("github-copilot", "ses-copilot-step-start");
        const anthropicMessages = await runForProvider("anthropic", "ses-anthropic-step-start");

        //#then
        expect(copilotMessages[1].parts[1]).toEqual({ type: "step-start", text: "start" });
        expect(anthropicMessages[1].parts[1]).toEqual({ type: "text", text: "" });
    });

    it("produces byte-identical structural output on cold DB-recovered and hot anthropic passes", async () => {
        //#given
        useTempDataHome("context-transform-cold-hot-provider-");
        const sessionId = "ses-anthropic-cold-hot";
        createOpenCodeDbForTransform(sessionId, [
            { id: "oc-user", role: "user", text: "hello" },
            {
                id: "oc-assistant",
                role: "assistant",
                text: "hi",
                providerID: "anthropic",
                modelID: "claude-sonnet",
            },
        ]);
        const liveModelBySession = new Map<string, { providerID: string; modelID: string }>();
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    sessionId,
                    { usage: { percentage: 20, inputTokens: 40_000 }, updatedAt: Date.now() },
                ],
            ]),
            db: openDatabase(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 10,
            liveModelBySession,
        });
        const buildMessages = (): TestMessage[] => [
            {
                info: { id: "m-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "continue" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [
                    { type: "text", text: "visible answer" },
                    { type: "step-start", text: "start" },
                    { type: "step-finish", text: "finish" },
                ],
            },
        ];

        //#when — first pass recovers provider from OpenCode DB; second reuses the warmed map.
        const coldMessages = buildMessages();
        await transform({}, { messages: coldMessages });
        expect(liveModelBySession.get(sessionId)?.providerID).toBe("anthropic");
        const hotMessages = buildMessages();
        await transform({}, { messages: hotMessages });

        //#then
        expect(JSON.stringify(hotMessages[1].parts)).toBe(JSON.stringify(coldMessages[1].parts));
    });

    it("uses the DB-recovered provider for both main transform and postprocess in one anthropic pass", async () => {
        //#given
        useTempDataHome("context-transform-single-provider-resolution-");
        const sessionId = "ses-single-provider-resolution";
        createOpenCodeDbForTransform(sessionId, [
            { id: "oc-user", role: "user", text: "hello" },
            {
                id: "oc-assistant",
                role: "assistant",
                text: "hi",
                providerID: "anthropic",
                modelID: "claude-sonnet",
            },
        ]);
        const scheduler: Scheduler = { shouldExecute: mock(() => "execute" as const) };
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    sessionId,
                    { usage: { percentage: 60, inputTokens: 120_000 }, updatedAt: Date.now() },
                ],
            ]),
            db: openDatabase(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            liveModelBySession: new Map(),
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "continue" }],
            },
            {
                info: { id: "m-structural", role: "assistant" },
                parts: [
                    { type: "text", text: "visible" },
                    { type: "step-start", text: "start" },
                ],
            },
            {
                info: { id: "m-system-injected", role: "assistant" },
                parts: [{ type: "text", text: "<system-reminder>internal</system-reminder>" }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then — main transform stripped step-start with the recovered provider,
        // and postprocess used that same provider for the whole-message sentinel.
        expect(messages[1].parts[1]).toEqual({ type: "text", text: "" });
        expect(messages[2].parts).toEqual([{ type: "text", text: "" }]);
    });

    it("applies pending drop operations when scheduler executes", async () => {
        //#given
        useTempDataHome("context-transform-ops-");
        const shouldExecute = mock<Scheduler["shouldExecute"]>(() => "defer");
        const scheduler: Scheduler = { shouldExecute };
        const channel1StateBySession = new Map<
            string,
            import("./ctx-reduce-nudge").Channel1State
        >();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-1",
                    { usage: { percentage: 60, inputTokens: 120_000 }, updatedAt: Date.now() },
                ],
            ]),
            db: openDatabase(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            channel1StateBySession,
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
        // Push the real tool tag out of the newest-20 skeleton window (the
        // db7bc0a tool-skeleton change keeps a truncated tool_use/tool_result
        // pair for drops within that window) so this test keeps exercising
        // the FULL-removal path it documents. Mirrors padSkeletonWindow in
        // apply-operations.tool-drop.test.ts — upstream updated that file's
        // tests for the new behavior but missed this one.
        for (let i = 1; i <= 20; i += 1) {
            insertTag(db, "ses-1", `call-pad-${i}`, "tool", 10, 2 + i);
        }
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

        //#then — user message shell is preserved (turn boundary) as the canonical
        // [dropped §N§] placeholder; the tool tag is padded OUT of the newest-20
        // skeleton window above, so the tool-only assistant takes the legacy
        // FULL-removal path and its shell is stripped. (The in-window skeleton path
        // is covered in apply-operations.tool-drop.test.ts.)
        expect(secondPass).toHaveLength(1);
        expect(secondPass[0]?.info.role).toBe("user");
        const userShellText = (secondPass[0]?.parts[0] as { text: string }).text;
        expect(userShellText).toBe("[dropped \u00a71\u00a7]");
        expect(getTagById(db, "ses-1", 1)?.status).toBe("dropped");
        expect(getTagById(db, "ses-1", 2)?.status).toBe("dropped");
        expect(getTagById(db, "ses-1", 2)?.dropMode).toBe("full");
        expect(channel1StateBySession.get("ses-1")?.agentDropsAppliedThisPass).toBe(true);
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
            db: openDatabase(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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
        // the user message stays, assistant message neutralized to a sentinel.
        expect(secondPass).toHaveLength(2);
        expect(text(secondPass[0], 0)).toStartWith("\u00a71\u00a7 ");
        // Assistant message (previously dropped) now carries a single sentinel
        // part. Test doesn't set providerID → `[dropped]` (safe non-anthropic).
        expect(secondPass[1].parts).toEqual([{ type: "text", text: "[dropped]" }]);
    });

    it("Unit B: subagent with ctx_reduce enabled DOES get §N§ prefix (self-management)", async () => {
        //#given
        useTempDataHome("context-transform-subagent-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "execute" as const) };
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-sub",
                    { usage: { percentage: 61, inputTokens: 122_000 }, updatedAt: Date.now() },
                ],
            ]),
            db: openDatabase(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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
        // Unit B: subagents share the process-global ctx_reduce tool, so with
        // ctx_reduce enabled (the default here) they DO get the §N§ prefix and
        // self-manage tool bloat. DB tag records exist either way.
        expect(text(messages[0], 0)).toStartWith("\u00a71\u00a7 ");
        expect(getTagsBySession(db, "ses-sub")).toHaveLength(1);
        expect(scheduler.shouldExecute).toHaveBeenCalled();
    });

    it("fully skips the transform for Magic Context's own hidden children", async () => {
        //#given — a session flagged as an internal MC child (historian/dreamer/
        // sidekick/migration). Unlike a generic subagent, these get ZERO
        // transform work: no tagging, scheduler never consulted, messages
        // untouched.
        useTempDataHome("context-transform-internal-child-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "execute" as const) };
        const internalChildSessions = new Set<string>(["ses-historian-child"]);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-historian-child",
                    { usage: { percentage: 61, inputTokens: 122_000 }, updatedAt: Date.now() },
                ],
            ]),
            db: openDatabase(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            internalChildSessions,
        });

        const db = openDatabase();
        // isSubagent is also true for these (parentID set), but the
        // internal-child flag must take precedence and skip BEFORE any work.
        updateSessionMeta(db, "ses-historian-child", { isSubagent: true });

        const messages: TestMessage[] = [
            {
                info: { id: "m-hist", role: "user", sessionID: "ses-historian-child" },
                parts: [{ type: "text", text: "historian chunk prompt" }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then — message untouched, NO tags written, scheduler never consulted.
        expect(text(messages[0], 0)).toBe("historian chunk prompt");
        expect(getTagsBySession(db, "ses-historian-child")).toHaveLength(0);
        expect(scheduler.shouldExecute).not.toHaveBeenCalled();
    });

    it("injects empty m[0] and placeholder m[1] for first-pass primary sessions", async () => {
        //#given
        useTempDataHome("context-transform-m0m1-first-pass-");
        const directory = makeTempDir("context-transform-m0m1-project-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-m0m1-first",
                    { usage: { percentage: 10, inputTokens: 1_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            directory,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-m0m1-first" },
                parts: [{ type: "text", text: "hello" }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then
        expect(messages).toHaveLength(3);
        expect(text(messages[0], 0)).toBe("<session-history></session-history>");
        expect(text(messages[1], 0)).toBe(
            "<session-history-since>(no new content since last materialization)</session-history-since>",
        );
        expect(text(messages[2], 0)).toContain("hello");
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
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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
        // A legacy compartment without a U: line decays to a title-only heading.
        expect(injected).toMatch(/## \d+-\d+ · Setup/);
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
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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
        expect(messages).toHaveLength(1);
        expect(text(messages[0]!, 0)).not.toContain("<project-memory>");
        expect(text(messages[0]!, 0)).not.toContain("<session-history-since>");
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
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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

        // Sentinel replacement preserves array length. Unit B: subagents with
        // ctx_reduce enabled DO get the §N§ prefix on user text.
        // Test doesn't set providerID → `[dropped]` sentinel.
        expect(secondPass).toHaveLength(2);
        expect(text(secondPass[0], 0)).toStartWith("\u00a71\u00a7 ");
        expect(secondPass[1].parts).toEqual([{ type: "text", text: "[dropped]" }]);
        expect(getPendingOps(db, "ses-sub-drop")).toHaveLength(0);
    });

    it("fires the tiered emergency floor for subagents at >=85% (Phase 2 CRIT#5)", async () => {
        // Merge-blocking guarantee: Phase 2 removed routine age-based tool drops,
        // so the ONLY tool floor a subagent has is the tiered emergency drop. It
        // must fire for subagents at >=85% (the force-materialize threshold) even
        // though forceMaterialization/m[0] materialization stays primary-only.
        // Without this, a subagent's context would grow unchecked to overflow.
        useTempDataHome("context-transform-subagent-rerun-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "execute" as const) };
        const db = openDatabase();
        updateSessionMeta(db, "ses-sub-rerun", { isSubagent: true });
        const lastHeuristicsTurnId = new Map<string, string>();
        // Realistic ~200KB output (~50k tokens) — see the sibling test's note on
        // why a single repeated char is a tokenizer pathology to avoid here.
        const bigOutput = "const value = compute(input, options); // step output line\n".repeat(
            3400,
        );
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-sub-rerun",
                    { usage: { percentage: 86, inputTokens: 172_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId,
            clearReasoningAge: 50,
            protectedTags: 0,
        });

        const messages: TestMessage[] = [
            {
                info: { id: "m-user-1", role: "user", sessionID: "ses-sub-rerun" },
                parts: [{ type: "text", text: "user prompt" }],
            },
            {
                info: { id: "m-assist-1", role: "assistant" },
                parts: [{ type: "tool", callID: "call-1", state: { output: bigOutput } }],
            },
            {
                info: { id: "m-assist-2", role: "assistant" },
                parts: [{ type: "tool", callID: "call-2", state: { output: bigOutput } }],
            },
        ];
        await transform({}, { messages });

        // The oldest large tool output is dropped by the tiered emergency drop —
        // proves the floor fires for a subagent at 85%.
        const subagentTags = getTagsBySession(db, "ses-sub-rerun");
        const firstToolTag = subagentTags.find((t) => t.messageId === "call-1");
        expect(firstToolTag?.status).toBe("dropped");
    });

    it("Unit B: subagent (ctx_reduce on) gets a Channel 1 baseline snapshot", async () => {
        // Channel 1 (in-turn tool-output nudge) is gated on ctx_reduce being
        // effective, NOT on fullFeatureMode — so subagents that share the
        // process-global ctx_reduce tool DO get a baseline + nudges.
        useTempDataHome("context-transform-sub-ch1-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        updateSessionMeta(db, "ses-sub-ch1", { isSubagent: true });
        const channel1StateBySession = new Map<
            string,
            import("./ctx-reduce-nudge").Channel1State
        >();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-sub-ch1",
                    { usage: { percentage: 50, inputTokens: 100_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            channel1StateBySession,
        });
        await transform(
            {},
            {
                messages: [
                    {
                        info: { id: "m-user", role: "user", sessionID: "ses-sub-ch1" },
                        parts: [{ type: "text", text: "hi" }],
                    },
                ],
            },
        );
        // Baseline recorded → Channel 1 is active for this subagent.
        expect(channel1StateBySession.has("ses-sub-ch1")).toBe(true);
    });

    it("resets the persisted Channel 1 band when baseline refresh sees a smaller tail", async () => {
        useTempDataHome("context-transform-band-reset-");
        const sessionId = "ses-band-reset";
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        setLastNudgeUndropped(db, sessionId, 80_000);
        setChannel1NudgeState(db, sessionId, { level: "urgent", ordinal: 12 });
        const channel1StateBySession = new Map<
            string,
            import("./ctx-reduce-nudge").Channel1State
        >();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    sessionId,
                    { usage: { percentage: 50, inputTokens: 100_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            channel1StateBySession,
        });

        await transform(
            {},
            {
                messages: [
                    {
                        info: { id: "m-user-reset", role: "user", sessionID: sessionId },
                        parts: [{ type: "text", text: "hi" }],
                    },
                ],
            },
        );

        expect(getLastNudgeUndropped(db, sessionId)).toBe(0);
        expect(getChannel1NudgeState(db, sessionId)).toEqual({ level: "", ordinal: 0 });
        expect(
            db
                .prepare("SELECT last_nudge_level FROM session_meta WHERE session_id = ?")
                .get(sessionId),
        ).toEqual({ last_nudge_level: '{"level":"","ordinal":0}' });
    });

    it("Unit B: primary without callable ctx_reduce gets NO Channel 1 baseline (latent-gap fix)", async () => {
        // A primary whose tool allow-list denies ctx_reduce has no §N§ prefix and
        // no tool to act on a nudge — it must NOT get a Channel 1 baseline (which
        // would nudge it to call a tool it lacks). Pre-Unit-B this was gated on
        // fullFeatureMode (true for this primary) and leaked.
        useTempDataHome("context-transform-noreduce-ch1-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        const channel1StateBySession = new Map<
            string,
            import("./ctx-reduce-nudge").Channel1State
        >();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-noreduce-ch1",
                    { usage: { percentage: 50, inputTokens: 100_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            channel1StateBySession,
        });
        await transform(
            {},
            {
                messages: [
                    {
                        info: {
                            id: "m-user",
                            role: "user",
                            sessionID: "ses-noreduce-ch1",
                            tools: { "*": false, read: true },
                        },
                        parts: [{ type: "text", text: "hi" }],
                    },
                ],
            },
        );
        // No baseline → Channel 1 correctly inert when ctx_reduce is unavailable.
        expect(channel1StateBySession.has("ses-noreduce-ch1")).toBe(false);
    });

    it("runs caveman compression for a primary with ctx_reduce available while skipping dropped tags", async () => {
        useTempDataHome("context-transform-caveman-with-reduce-");
        const sessionId = "ses-caveman-with-reduce";
        let decision: "defer" | "execute" = "defer";
        const scheduler: Scheduler = { shouldExecute: mock(() => decision) };
        const db = openDatabase();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    sessionId,
                    { usage: { percentage: 70, inputTokens: 100_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            cavemanTextCompression: { enabled: true, minChars: 50 },
        });
        const droppedOriginal =
            "I just wanted to clearly explain that the first message should be dropped before caveman can rewrite it. ".repeat(
                4,
            );
        const compressibleOriginal =
            "I just wanted to basically clearly explain that the implementation is actually quite complex because the historian and compartment machinery work together. ".repeat(
                4,
            );
        const messages: TestMessage[] = [
            {
                info: {
                    id: "m-drop",
                    role: "user",
                    sessionID: sessionId,
                    tools: { "*": false, ctx_reduce: true },
                },
                parts: [{ type: "text", text: droppedOriginal }],
            },
            {
                info: { id: "m-keep-1", role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: compressibleOriginal }],
            },
            {
                info: { id: "m-keep-2", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: compressibleOriginal }],
            },
            {
                info: { id: "m-keep-3", role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: compressibleOriginal }],
            },
            {
                info: { id: "m-keep-4", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: compressibleOriginal }],
            },
        ];

        // First pass tags only. The first user message explicitly allows ctx_reduce,
        // freezing the availability gate in the reduce-enabled state.
        await transform({}, { messages });
        const firstTag = getTagsBySession(db, sessionId).find(
            (tag) => tag.messageId === "m-drop:p0",
        );
        expect(firstTag?.tagNumber).toBe(1);
        queuePendingOp(db, sessionId, 1, "drop");

        decision = "execute";
        await transform({}, { messages });

        expect(text(messages[0], 0)).toBe("[dropped §1§]");
        expect(text(messages[1], 0)).not.toBe(compressibleOriginal);
        expect(text(messages[1], 0)).not.toContain("[dropped");
        expect(getTagById(db, sessionId, 1)?.cavemanDepth).toBe(0);
        expect(getTagsBySession(db, sessionId).some((tag) => tag.cavemanDepth > 0)).toBe(true);
    });

    it("preserves once-per-turn guard for primary sessions (does NOT re-run heuristics within one turn)", async () => {
        // Cache-stability regression: primary sessions MUST NOT re-run
        // heuristics mid-turn because mid-turn rewrites bust Anthropic prompt
        // cache across the user's tool-call sequence. Symmetric counterpart
        // to the subagent rerun test above.
        useTempDataHome("context-transform-primary-once-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "execute" as const) };
        const db = openDatabase();
        // No isSubagent override — defaults to primary session.
        const lastHeuristicsTurnId = new Map<string, string>();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-primary-once",
                    { usage: { percentage: 70, inputTokens: 140_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId,
            clearReasoningAge: 50,
            protectedTags: 0,
        });

        const firstPass: TestMessage[] = [
            {
                info: { id: "m-user-1", role: "user", sessionID: "ses-primary-once" },
                parts: [{ type: "text", text: "user prompt" }],
            },
            {
                info: { id: "m-assist-1", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        callID: "call-1",
                        state: { output: "first tool output" },
                    },
                ],
            },
        ];
        await transform({}, { messages: firstPass });
        expect(lastHeuristicsTurnId.get("ses-primary-once")).toBe("m-user-1");

        const secondPass: TestMessage[] = [
            {
                info: { id: "m-user-1", role: "user", sessionID: "ses-primary-once" },
                parts: [{ type: "text", text: "user prompt" }],
            },
            {
                info: { id: "m-assist-1", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        callID: "call-1",
                        state: { output: "first tool output" },
                    },
                ],
            },
            {
                info: { id: "m-assist-2", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        callID: "call-2",
                        state: { output: "second tool output" },
                    },
                ],
            },
        ];
        await transform({}, { messages: secondPass });

        // Primary session: once-per-turn guard MUST hold. The first tool's
        // tag stays `active` even though it would be drop-eligible by age.
        // This protects provider cache across the user's tool-call sequence.
        const primaryTags = getTagsBySession(db, "ses-primary-once");
        const firstPrimaryToolTag = primaryTags.find((t) => t.messageId === "call-1");
        expect(firstPrimaryToolTag?.status).toBe("active");
        const secondPrimaryToolTag = primaryTags.find((t) => t.messageId === "call-2");
        expect(secondPrimaryToolTag?.status).toBe("active");
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
            db: openDatabase(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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
            db: openDatabase(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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

        // The dropped part gets the canonical [dropped §N§] placeholder (byte-stable
        // across passes); the user-role message is never whole-message stripped (the
        // role guard in stripDroppedPlaceholderMessages), so the turn boundary
        // survives for AI SDK's Anthropic adapter. The sibling part is untouched.
        expect(text(secondPass[0], 0)).toBe("[dropped \u00a71\u00a7]");
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
            db: openDatabase(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            liveModelBySession: new Map([
                ["ses-think", { providerID: "anthropic", modelID: "claude-sonnet" }],
            ]),
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

        //#then — under Anthropic the cleared thinking becomes an empty sentinel;
        // then the dropped-placeholder-only assistant is neutralized to one empty
        // whole-message sentinel (filtered before the wire by OpenCode).
        expect(secondPass).toHaveLength(2);
        expect(text(secondPass[0], 0)).toContain("user prompt");
        expect(secondPass[1].parts).toEqual([{ type: "text", text: "" }]);
    });

    it("fails open when session meta lookup throws", async () => {
        //#given
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const tagger = createTagger();
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
            db: failingDb,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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
    });

    it("fails open when tagger init fails", async () => {
        //#given
        useTempDataHome("context-transform-tagger-error-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
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
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-tagger-fail" },
                parts: [{ type: "text", text: "still works" }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then — fail-open: message preserved despite tagger init failure.
        expect(text(messages[0], 0)).toBe("still works");
    });

    it("fails open when scheduler throws and still tags messages", async () => {
        //#given
        useTempDataHome("context-transform-scheduler-error-");
        const scheduler: Scheduler = {
            shouldExecute: mock(() => {
                throw new Error("scheduler failed");
            }),
        };
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-scheduler-fail",
                    { usage: { percentage: 66, inputTokens: 132_000 }, updatedAt: Date.now() },
                ],
            ]),
            db: openDatabase(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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

        //#when — must not throw despite the scheduler error.
        await transform({}, { messages });

        //#then — tagging still happened (fail-open).
        expect(text(messages[0], 0)).toStartWith("§1§ ");
    });

    it("resets persisted usage on first pass then lazy-loads on second pass", async () => {
        //#given
        useTempDataHome("context-transform-lazy-load-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
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
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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
            lastResponseTime: 1_000,
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
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>();
        const db = openDatabase();

        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap,
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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
    });
});

function createOpenCodeDbForTransform(
    sessionId: string,
    messages: Array<{
        id: string;
        role: string;
        text: string;
        providerID?: string;
        modelID?: string;
        agent?: string;
    }>,
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
            const data: Record<string, unknown> = {
                id: message.id,
                role: message.role,
                sessionID: sessionId,
            };
            if (message.providerID) data.providerID = message.providerID;
            if (message.modelID) data.modelID = message.modelID;
            if (message.agent) data.agent = message.agent;
            insertMessage.run(message.id, sessionId, timestamp, timestamp, JSON.stringify(data));
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
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 10,
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

describe("createTransform shrinking model-switch overflow pre-arm", () => {
    const OLD_MODEL = { providerID: "anthropic", modelID: "claude-big-512k" };
    const NEW_MODEL = { providerID: "openai", modelID: "gpt-5.5" };
    const NEW_KEY = "openai/gpt-5.5";
    const OLD_KEY = "anthropic/claude-big-512k";

    async function seedNewModelLimit(inputCap: number): Promise<void> {
        clearModelsDevCache();
        await refreshModelLimitsFromApi({
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            { id: "openai", models: { "gpt-5.5": { limit: { input: inputCap } } } },
                        ],
                    },
                }),
            },
        });
    }

    function makeTransform(
        db: ReturnType<typeof openDatabase>,
        sessionId: string,
        liveModel: { providerID: string; modelID: string },
        usage: { percentage: number; inputTokens: number },
    ) {
        const abort = mock(async () => ({ data: true }));
        const prompt = mock(async () => ({}));
        const liveModelBySession = new Map([[sessionId, liveModel]]);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([[sessionId, { usage, updatedAt: Date.now() }]]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            liveModelBySession,
            // Mirror production: getModelKey derives from the live model map.
            getModelKey: (id: string) => {
                const m = liveModelBySession.get(id);
                return m ? `${m.providerID}/${m.modelID}` : undefined;
            },
            client: { session: { abort, prompt } } as unknown as PluginContext["client"],
            directory: "/tmp",
        });
        return { transform, abort, prompt };
    }

    // Production shape on a live switch: the array still ends with the OLD
    // model's assistant response (flat info.providerID/modelID), then the NEW
    // user message carrying the just-selected model nested under info.model.
    // liveModelBySession was already flipped to NEW by chat.message.
    function switchTurnMessages(sessionId: string) {
        return [
            {
                info: { id: "m-user-0", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "earlier" }],
            },
            {
                info: {
                    id: "m-assistant-old",
                    role: "assistant",
                    sessionID: sessionId,
                    providerID: OLD_MODEL.providerID,
                    modelID: OLD_MODEL.modelID,
                },
                parts: [{ type: "text", text: "old model reply" }],
            },
            {
                info: {
                    id: "m-user-1",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: NEW_MODEL.providerID, modelID: NEW_MODEL.modelID },
                },
                parts: [{ type: "text", text: "continue" }],
            },
        ];
    }

    it("arms recovery (flag-only) when last input on the OLD model exceeds the NEW model's cap", async () => {
        useTempDataHome("transform-shrink-switch-arm-");
        createOpenCodeDbForTransform("ses-shrink", [
            { id: "m-raw-1", role: "user", text: "recent 1" },
            { id: "m-raw-2", role: "assistant", text: "recent 2" },
        ]);
        const db = openDatabase();
        // Persisted usage from the PREVIOUS (large, 512k) model: 300k input,
        // ~58%, well under any threshold. lastObservedModelKey = OLD model.
        updateSessionMeta(db, "ses-shrink", {
            lastContextPercentage: 58,
            lastInputTokens: 300_000,
            lastObservedModelKey: OLD_KEY,
            lastUsageContextLimit: 512_000,
        });
        await seedNewModelLimit(272_000);

        const { transform, abort } = makeTransform(db, "ses-shrink", NEW_MODEL, {
            percentage: 58,
            inputTokens: 300_000,
        });
        await transform({}, { messages: switchTurnMessages("ses-shrink") });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const overflow = getOverflowState(db, "ses-shrink");
        // Armed THIS pass so the existing bump-to-95% compacts before the
        // oversized request is sent (not one pass late from the provider error).
        expect(overflow.needsEmergencyRecovery).toBe(true);
        // Flag-only: no catalog/auth limit pinned into detected_context_limit.
        expect(overflow.detectedContextLimit).toBe(0);
        expect(overflow.emergencyRecoveryOrigin).toBe("proactive_model_shrink");
        expect(abort).not.toHaveBeenCalled();
    });

    it("does not abort a stale proactive arm after restart zeroed the input sample", async () => {
        useTempDataHome("transform-shrink-switch-stale-restart-");
        const sessionId = "ses-stale-proactive";
        createOpenCodeDbForTransform(sessionId, [{ id: "m-raw-1", role: "user", text: "recent" }]);
        const db = openDatabase();
        recordOverflowDetected(db, sessionId, undefined, NEW_KEY, "proactive_model_shrink");

        const { transform, abort } = makeTransform(db, sessionId, NEW_MODEL, {
            percentage: 0,
            inputTokens: 0,
        });
        await transform(
            {},
            {
                messages: [
                    {
                        info: {
                            id: "m-user-restart",
                            role: "user",
                            sessionID: sessionId,
                            model: NEW_MODEL,
                        },
                        parts: [{ type: "text", text: "continue" }],
                    },
                ],
            },
        );

        expect(getOverflowState(db, sessionId).emergencyRecoveryOrigin).toBe(
            "proactive_model_shrink",
        );
        expect(abort).not.toHaveBeenCalled();
    });

    it("does not arm on a normal SAME-model turn whose input fits the model", async () => {
        useTempDataHome("transform-shrink-switch-noarm-");
        createOpenCodeDbForTransform("ses-fits", [
            { id: "m-raw-1", role: "user", text: "recent 1" },
        ]);
        const db = openDatabase();
        // Same (new) model, last input under the 272k cap.
        updateSessionMeta(db, "ses-fits", {
            lastContextPercentage: 73,
            lastInputTokens: 200_000,
            lastObservedModelKey: NEW_KEY,
            lastUsageContextLimit: 272_000,
        });
        await seedNewModelLimit(272_000);

        const { transform } = makeTransform(db, "ses-fits", NEW_MODEL, {
            percentage: 73,
            inputTokens: 200_000,
        });
        await transform(
            {},
            {
                messages: [
                    {
                        info: {
                            id: "m-user-1",
                            role: "user",
                            sessionID: "ses-fits",
                            model: NEW_MODEL,
                        },
                        parts: [{ type: "text", text: "continue" }],
                    },
                ],
            },
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getOverflowState(db, "ses-fits").needsEmergencyRecovery).toBe(false);
    });

    it("does NOT arm when last input exceeds the limit but on the SAME model (cache regression, not overflow)", async () => {
        useTempDataHome("transform-shrink-switch-samemodel-");
        createOpenCodeDbForTransform("ses-same", [
            { id: "m-raw-1", role: "user", text: "recent 1" },
        ]);
        const db = openDatabase();
        // The last input (300k) was ACCEPTED by this same model, so a now-lower
        // catalog reading (272k) is a stale/regressed limit, not a real overflow.
        // Arming here would cause a gratuitous compaction + cache bust.
        updateSessionMeta(db, "ses-same", {
            lastContextPercentage: 90,
            lastInputTokens: 300_000,
            lastObservedModelKey: NEW_KEY,
            lastUsageContextLimit: 400_000,
        });
        await seedNewModelLimit(272_000);

        const { transform } = makeTransform(db, "ses-same", NEW_MODEL, {
            percentage: 90,
            inputTokens: 300_000,
        });
        await transform(
            {},
            {
                messages: [
                    {
                        info: {
                            id: "m-user-1",
                            role: "user",
                            sessionID: "ses-same",
                            model: NEW_MODEL,
                        },
                        parts: [{ type: "text", text: "continue" }],
                    },
                ],
            },
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getOverflowState(db, "ses-same").needsEmergencyRecovery).toBe(false);
    });

    it("does not arm for a subagent session", async () => {
        useTempDataHome("transform-shrink-switch-subagent-");
        createOpenCodeDbForTransform("ses-shrink-sub", [
            { id: "m-raw-1", role: "user", text: "recent 1" },
        ]);
        const db = openDatabase();
        updateSessionMeta(db, "ses-shrink-sub", {
            isSubagent: true,
            lastContextPercentage: 58,
            lastInputTokens: 300_000,
            lastObservedModelKey: OLD_KEY,
            lastUsageContextLimit: 512_000,
        });
        await seedNewModelLimit(272_000);

        const { transform } = makeTransform(db, "ses-shrink-sub", NEW_MODEL, {
            percentage: 58,
            inputTokens: 300_000,
        });
        await transform({}, { messages: switchTurnMessages("ses-shrink-sub") });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getOverflowState(db, "ses-shrink-sub").needsEmergencyRecovery).toBe(false);
    });

    it("still arms when the newest user message lacks info.model (falls back to the live map, not the OLD assistant)", async () => {
        useTempDataHome("transform-shrink-switch-nomodel-");
        createOpenCodeDbForTransform("ses-nomodel", [
            { id: "m-raw-1", role: "user", text: "recent 1" },
        ]);
        const db = openDatabase();
        updateSessionMeta(db, "ses-nomodel", {
            lastContextPercentage: 58,
            lastInputTokens: 300_000,
            lastObservedModelKey: OLD_KEY,
            lastUsageContextLimit: 512_000,
        });
        await seedNewModelLimit(272_000);

        // liveModelBySession = NEW (chat.message set it). The newest user message
        // carries NO info.model, so the resolver must fall back to the live map
        // (NEW), NOT the OLD last-assistant. If it fell to the assistant, the
        // detector would mis-resolve to OLD and the arm would not fire.
        const { transform } = makeTransform(db, "ses-nomodel", NEW_MODEL, {
            percentage: 58,
            inputTokens: 300_000,
        });
        await transform(
            {},
            {
                messages: [
                    {
                        info: {
                            id: "m-assistant-old",
                            role: "assistant",
                            sessionID: "ses-nomodel",
                            providerID: OLD_MODEL.providerID,
                            modelID: OLD_MODEL.modelID,
                        },
                        parts: [{ type: "text", text: "old model reply" }],
                    },
                    {
                        // newest user, no info.model
                        info: { id: "m-user-1", role: "user", sessionID: "ses-nomodel" },
                        parts: [{ type: "text", text: "continue" }],
                    },
                ],
            },
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getOverflowState(db, "ses-nomodel").needsEmergencyRecovery).toBe(true);
    });
});

describe("createTransform historian failure handling", () => {
    it("fails closed until the bounded no-head escape lowers synthetic pressure", async () => {
        useTempDataHome("transform-empty-head-escape-");
        createOpenCodeDbForTransform("ses-empty-head-escape", [
            { id: "m-raw-1", role: "user", text: "recent 1" },
            { id: "m-raw-2", role: "user", text: "recent 2" },
            { id: "m-raw-3", role: "user", text: "recent 3" },
        ]);
        const db = openDatabase();
        incrementHistorianFailure(db, "ses-empty-head-escape", "historian failed");
        recordOverflowDetected(db, "ses-empty-head-escape", 8_000);

        const abort = mock(async () => ({ data: true }));
        const prompt = mock(async () => ({}));
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                [
                    "ses-empty-head-escape",
                    { usage: { percentage: 0, inputTokens: 0 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            client: { session: { abort, prompt } } as unknown as PluginContext["client"],
            directory: "/tmp",
        });

        for (const id of ["first", "second", "third"]) {
            await transform(
                {},
                {
                    messages: [
                        {
                            info: {
                                id: `m-user-${id}`,
                                role: "user",
                                sessionID: "ses-empty-head-escape",
                            },
                            parts: [{ type: "text", text: "continue" }],
                        },
                    ],
                },
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(abort).toHaveBeenCalledTimes(2);
        expect(loadProtectedTailMeta(db, "ses-empty-head-escape").recoveryNoEligibleHeadCount).toBe(
            2,
        );
    });

    it("keeps failing closed at real >=95% pressure after the no-head escape", async () => {
        useTempDataHome("transform-empty-head-escape-95-");
        createOpenCodeDbForTransform("ses-empty-head-escape-95", [
            { id: "m-raw-1", role: "user", text: "recent 1" },
            { id: "m-raw-2", role: "user", text: "recent 2" },
            { id: "m-raw-3", role: "user", text: "recent 3" },
        ]);
        const db = openDatabase();
        incrementHistorianFailure(db, "ses-empty-head-escape-95", "historian failed");
        recordOverflowDetected(db, "ses-empty-head-escape-95", 8_000);

        const abort = mock(async () => ({ data: true }));
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                [
                    "ses-empty-head-escape-95",
                    { usage: { percentage: 96, inputTokens: 7_680 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            client: {
                session: { abort, prompt: mock(async () => ({})) },
            } as unknown as PluginContext["client"],
            directory: "/tmp",
        });

        for (const id of ["first", "second", "third"]) {
            await transform(
                {},
                {
                    messages: [
                        {
                            info: {
                                id: `m-user-95-${id}`,
                                role: "user",
                                sessionID: "ses-empty-head-escape-95",
                            },
                            parts: [{ type: "text", text: "continue" }],
                        },
                    ],
                },
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(abort).toHaveBeenCalledTimes(3);
        expect(
            loadProtectedTailMeta(db, "ses-empty-head-escape-95").recoveryNoEligibleHeadCount,
        ).toBe(2);
    });

    it("does not abort solely because historian failures exist at 95%", async () => {
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
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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
        await new Promise((resolve) => setTimeout(resolve, 0));

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

        expect(abort).not.toHaveBeenCalled();
        expect(emergencyNotifications).toHaveLength(0);
    });

    it("notifies before awaiting self-abort for provider-proven overflow", async () => {
        useTempDataHome("transform-fail-closed-order-");
        const sessionId = "ses-fail-closed-order";
        createOpenCodeDbForTransform(sessionId, [{ id: "m-raw-1", role: "user", text: "recent" }]);
        await refreshModelLimitsFromApi({
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: "test-provider",
                                models: { "emergency-100k": { limit: { input: 100_000 } } },
                            },
                        ],
                    },
                }),
            },
        });
        recordToolDefinition("test-provider", "emergency-100k", "build", "read", "Read a file", {
            type: "object",
        });
        const db = openDatabase();
        updateSessionMeta(db, sessionId, { systemPromptTokens: 110_000 });
        recordOverflowDetected(db, sessionId, 100_000, "test-provider/emergency-100k");
        setEmergencyDropSample(db, sessionId, 110_000);
        const order: string[] = [];
        const prompt = mock(async () => {
            order.push("notify");
            return {};
        });
        const abort = mock(async () => {
            order.push("abort");
            return { data: true };
        });
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp", title: "Emergency" } })),
                prompt,
                abort,
            },
        } as unknown as PluginContext["client"];
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                [
                    sessionId,
                    {
                        usage: { percentage: 110, inputTokens: 110_000 },
                        updatedAt: Date.now(),
                    },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            client,
            directory: "/tmp",
            liveModelBySession: new Map([
                [sessionId, { providerID: "test-provider", modelID: "emergency-100k" }],
            ]),
            getModelKey: () => "test-provider/emergency-100k",
            getNotificationParams: () => ({
                agent: "build",
                providerId: "test-provider",
                modelId: "emergency-100k",
                variant: "high",
            }),
        });

        await transform(
            {},
            {
                messages: [
                    {
                        info: {
                            id: "m-user",
                            role: "user",
                            sessionID: sessionId,
                            model: {
                                providerID: "test-provider",
                                modelID: "emergency-100k",
                            },
                        },
                        parts: [{ type: "text", text: "continue" }],
                    },
                ],
            },
        );

        expect(order).toEqual(["notify", "abort"]);
        expect(abort).toHaveBeenCalledWith({
            path: { id: sessionId },
            throwOnError: true,
        });
        expect(getEmergencyInputSample(db, sessionId)).toBe(0);
        const notificationInput = prompt.mock.calls[0]?.[0] as {
            body?: { parts?: Array<{ text?: string }> };
        };
        expect(notificationInput.body?.parts?.[0]?.text).toBe(
            "Context full — /ctx-flush or /clear to continue.",
        );
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
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
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
                                        text: `<compartment start="1" end="2" title="Recovered"><p1>Summary</p1></compartment>`,
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
