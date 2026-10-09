import { drainNotifications, registerNotificationSink } from "../../shared/rpc-notifications";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
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
import { createScheduler, type Scheduler } from "../../features/magic-context/scheduler";
import { readSessionCacheTtl } from "../../features/magic-context/session-cache-ttl";
import {
    clearPendingOps,
    closeDatabase,
    getChannel1NudgeState,
    getDroppedTagsByNumbers,
    getHistorianFailureState,
    getLastNudgeUndropped,
    getOrCreateSessionMeta,
    getOverflowState,
    getPendingCompactionMarkerState,
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
    setPendingCompactionMarkerState,
    updateCavemanDepth,
    updateSessionMeta,
    updateTagDropMode,
    updateTagStatus,
} from "../../features/magic-context/storage";
import {
    getEmergencyInputSample,
    type getPersistedCompactionMarkerState,
    setEmergencyDropSample,
    setPersistedCompactionMarkerState,
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
import * as loggerModule from "../../shared/logger";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import type { MarkerUpdateOutcome } from "./compaction-marker-manager";
import { getActiveCompartmentRun, registerActiveCompartmentRun } from "./compartment-runner";
import { createToolExecuteAfterHook } from "./hook-handlers";
import { injectM0M1 } from "./inject-compartments";
import { captureSlot, getSlot, resetLkgSlotsForTest } from "./lkg-slot";
import { __ignoredNotificationTest } from "./send-session-notification";
import { clearMessageTokensCache, createTransform } from "./transform";

type TextPart = { type: "text"; text: string };
type ToolPart = {
    type: "tool";
    tool?: string;
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
        finish?: string;
        time?: { created: number; completed: number };
        summary?: boolean;
    };
    parts: TestPart[];
};

const tempDirs: string[] = [];

for (const generation of ["v1", "v2"] as const) {
    for (const configured of [true, false]) {
        it(`${generation} pass ${configured ? "applies live user TTL edits without a prompt or model change" : "keeps built-in TTL changes frozen"}`, async () => {
            useTempDataHome(`ttl-${generation}-`);
            const db = openDatabase()!;
            const sessionId = `ttl-${generation}-${configured}`;
            let ttl = configured ? "1h" : "5m";
            const scheduler = createScheduler({ executeThresholdPercentage: 65 });
            const decide = spyOn(scheduler, "shouldExecute");
            const refresh = new Set<string>();
            const materialize = new Set<string>();
            const transform = createTransform({
                db,
                storeGeneration: generation,
                tagger: createTagger(),
                scheduler,
                cacheTtlConfig: ttl,
                cacheTtlConfigured: configured,
                sampleCacheTtlConfig: () => ({ cache_ttl: ttl, cacheTtlConfigured: configured }),
                liveModelBySession: new Map([
                    [sessionId, { providerID: "anthropic", modelID: "opus" }],
                ]),
                contextUsageMap: new Map(),
                historyRefreshSessions: refresh,
                pendingMaterializationSessions: materialize,
                lastHeuristicsTurnId: new Map(),
                clearReasoningAge: 50,
                protectedTokens: 0,
            });
            const raw: TestMessage[] = [
                {
                    info: { id: "u1", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "unchanged question" }],
                },
            ];
            const pass = async () => {
                const messages = structuredClone(raw);
                await transform({}, { messages });
                return JSON.stringify(messages);
            };
            try {
                await pass();
                updateSessionMeta(db, sessionId, {
                    lastResponseTime: Date.now() - 2 * 60 * 60 * 1000,
                });
                ttl = configured ? "13h" : "10m";
                const served = await pass();
                expect(getOrCreateSessionMeta(db, sessionId).cacheTtl).toBe(
                    configured ? "13h" : "5m",
                );
                expect(readSessionCacheTtl(db, sessionId)?.source).toBe(
                    configured ? "config" : "default",
                );
                expect(decide.mock.results.at(-1)?.value).toBe(configured ? "defer" : "execute");
                expect(refresh.size).toBe(0);
                expect(materialize.size).toBe(0);
                updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() });
                if (configured) {
                    ttl = "1m";
                    expect(await pass()).toBe(served);
                    expect(decide.mock.results.at(-1)?.value).toBe("defer");
                    updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() - 120_000 });
                    await pass();
                    expect(decide.mock.results.at(-1)?.value).toBe("execute");
                }
            } finally {
                decide.mockRestore();
            }
        });
    }
}
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

beforeEach(() => {
    __ignoredNotificationTest.setHoldDetector(() => false);
});

afterEach(() => {
    __ignoredNotificationTest.reset();
    __resetMessageIndexAsyncForTests();
    transformDecisionTest.reset();
    resetLkgSlotsForTest();
    closeDatabase();
    clearModelsDevCache();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdgCacheHome;

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
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
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
    it.each([
        "soft-execute",
        "explicit-flush",
        "force-band",
        "published-history",
    ])("adopts scoped tool sweeping only on a priced pass and preserves reasoning-only replay (%s)", async (kind) => {
        useTempDataHome("context-transform-scoped-sweep-");
        const sessionId = "ses-scoped-sweep";
        const db = openDatabase();
        const historyRefreshSessions = new Set<string>();
        const deferredHistoryRefreshSessions = new Set<string>();
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>();
        let decision: "execute" | "defer" = "defer";
        const makeTransform = () =>
            createTransform({
                tagger: createTagger(),
                scheduler: { shouldExecute: () => decision },
                contextUsageMap,
                db,
                historyRefreshSessions,
                deferredHistoryRefreshSessions,
                pendingMaterializationSessions: new Set(),
                lastHeuristicsTurnId: new Map(),
                clearReasoningAge: 1000,
                protectedTokens: 0,
                historianRunnable: false,
                liveModelBySession: new Map([
                    [sessionId, { providerID: "anthropic", modelID: "claude-opus-5" }],
                ]),
            });
        let transform = makeTransform();
        const source: TestMessage[] = [
            {
                info: { id: "sweep-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "start" }],
            },
            {
                info: { id: "sweep-tool", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        tool: "bash",
                        callID: "sweep-call",
                        state: { status: "completed", output: "spent result" },
                    },
                ],
            },
            ...Array.from(
                { length: 24 },
                (_, index): TestMessage => ({
                    info: { id: `sweep-filler-${index}`, role: index % 2 ? "assistant" : "user" },
                    parts: [{ type: "text", text: `unchanged ${index}` }],
                }),
            ),
            {
                info: {
                    id: "sweep-thinking",
                    role: "assistant",
                    finish: "stop",
                    time: { created: 1, completed: 2 },
                },
                parts: [
                    { type: "step-start", text: "" },
                    { type: "reasoning", text: "signed reasoning only" },
                    { type: "step-finish", text: "" },
                ],
            },
            {
                info: { id: "sweep-notice", role: "user" },
                parts: [
                    {
                        type: "text",
                        text: "<system-reminder>[BACKGROUND BASH COMPLETED]</system-reminder>",
                    },
                ],
            },
        ];
        const run = async () => {
            const output = { messages: structuredClone(source) };
            await transform({}, output);
            return output.messages;
        };
        await run();
        const tool = getTagsBySession(db, sessionId).find((tag) => tag.type === "tool");
        expect(tool).toBeDefined();
        updateTagStatus(db, sessionId, tool!.tagNumber, "dropped");
        updateTagDropMode(db, sessionId, tool!.tagNumber, "full");
        const legacy = await run();
        expect(legacy.some((message) => message.info.id === "sweep-thinking")).toBe(false);
        const sha = (value: unknown) =>
            createHash("sha256").update(JSON.stringify(value)).digest("hex");
        const capture = (label: string, messages: TestMessage[], previous: TestMessage[]) => {
            const index =
                Array.from(
                    { length: Math.max(messages.length, previous.length) },
                    (_, i) => i,
                ).find((i) => JSON.stringify(messages[i]) !== JSON.stringify(previous[i])) ?? -1;
            console.log(`SCOPED_GATE ${label} sha256=${sha(messages)} first_divergence=${index}`);
        };
        capture("legacy-1", legacy, legacy);
        for (let pass = 2; pass <= 3; pass++) {
            const replay = await run();
            capture(`legacy-${pass}`, replay, legacy);
            expect(sha(replay)).toBe(sha(legacy));
        }
        const marker = () =>
            String(
                (
                    db
                        .prepare(
                            "SELECT merged_reasoning_stripped_ids AS ids FROM session_meta WHERE session_id = ?",
                        )
                        .get(sessionId) as { ids: string }
                ).ids,
            ).includes("@tool-sweep-scoped");
        expect(marker()).toBe(false);
        if (kind === "soft-execute") decision = "execute";
        if (kind === "explicit-flush") historyRefreshSessions.add(sessionId);
        if (kind === "force-band")
            contextUsageMap.set(sessionId, {
                usage: { percentage: 99, inputTokens: 190000 },
                updatedAt: Date.now(),
            });
        if (kind === "published-history") {
            // A published compartment plus a pending deferred-history signal:
            // the next pass rebuilds the injected history head (m[0]) from that
            // compartment. That rebuild changes bytes the session already paid
            // to cache, which is what makes the pass cache-busting even though
            // the scheduler is still deferring.
            replaceAllCompartments(db, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "sweep-user",
                    endMessageId: "sweep-tool",
                    title: "Published history",
                    content: "Historian published the opening of this session.",
                },
            ]);
            deferredHistoryRefreshSessions.add(sessionId);
            contextUsageMap.set(sessionId, {
                usage: { percentage: 95, inputTokens: 190000 },
                updatedAt: Date.now(),
            });
        }
        const priced = await run();
        capture(kind, priced, legacy);
        if (kind === "published-history") {
            // The publication is the fold this pass pays for: the covered
            // opening is gone and the rendered compartment leads the array.
            expect(JSON.stringify(priced[0])).toContain("<session-history>");
            expect(priced.some((message) => message.info.id === "sweep-user")).toBe(false);
            expect(priced.some((message) => message.info.id === "sweep-tool")).toBe(false);
            // The dropped owner is spliced from the array that is SERVED, not
            // only from the copy the tagger walked, so the following defer
            // passes (which sweep the served array directly) replay it.
            expect(priced.filter((message) => message.parts.length === 0)).toEqual([]);
            console.log(
                `SCOPED_GATE hard fold rematerialized m0; served rows=${priced.length}; empty shells=0`,
            );
        }
        expect(
            priced
                .find((message) => message.info.id === "sweep-thinking")
                ?.parts.some((part) => part.type === "reasoning"),
        ).toBe(true);
        expect(marker()).toBe(true);
        decision = "defer";
        historyRefreshSessions.clear();
        deferredHistoryRefreshSessions.clear();
        contextUsageMap.clear();
        transform = makeTransform();
        for (let pass = 1; pass <= 3; pass++) {
            const replay = await run();
            capture(`adopted-defer-${pass}`, replay, priced);
            expect(sha(replay)).toBe(sha(priced));
        }
        source.push({
            info: { id: "sweep-newest", role: "assistant" },
            parts: [
                { type: "reasoning", text: "new thinking" },
                { type: "text", text: "new answer" },
            ],
        });
        const replay = await run();
        expect(sha(replay.slice(0, priced.length))).toBe(sha(priced));
        expect(replay.some((message) => message.info.id === "sweep-tool")).toBe(false);
    });
    it("pre-adoption defer serves the sweep variant each session was last served", async () => {
        useTempDataHome("context-transform-sweep-lkg-");
        const db = openDatabase();
        const makeTransform = (sessionId: string) =>
            createTransform({
                tagger: createTagger(),
                scheduler: { shouldExecute: () => "defer" as const },
                contextUsageMap: new Map(),
                db,
                historyRefreshSessions: new Set(),
                pendingMaterializationSessions: new Set(),
                lastHeuristicsTurnId: new Map(),
                clearReasoningAge: 1000,
                protectedTokens: 0,
                historianRunnable: false,
                liveModelBySession: new Map([
                    [sessionId, { providerID: "anthropic", modelID: "claude-opus-5" }],
                ]),
            });
        const sourceFor = (sessionId: string): TestMessage[] => [
            {
                info: { id: "lkg-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "start" }],
            },
            {
                info: { id: "lkg-tool", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        tool: "bash",
                        callID: "lkg-call",
                        state: { status: "completed", output: "spent result" },
                    },
                ],
            },
            ...Array.from(
                { length: 24 },
                (_, index): TestMessage => ({
                    info: { id: `lkg-filler-${index}`, role: index % 2 ? "assistant" : "user" },
                    parts: [{ type: "text", text: `unchanged ${index}` }],
                }),
            ),
            {
                info: {
                    id: "lkg-thinking",
                    role: "assistant",
                    finish: "stop",
                    time: { created: 1, completed: 2 },
                },
                parts: [
                    { type: "step-start", text: "" },
                    { type: "reasoning", text: "signed reasoning only" },
                    { type: "step-finish", text: "" },
                ],
            },
            {
                info: { id: "lkg-notice", role: "user" },
                parts: [
                    {
                        type: "text",
                        text: "<system-reminder>[BACKGROUND BASH COMPLETED]</system-reminder>",
                    },
                ],
            },
        ];
        const sha = (value: unknown) =>
            createHash("sha256").update(JSON.stringify(value)).digest("hex");
        const marker = (sessionId: string) =>
            String(
                (
                    db
                        .prepare(
                            "SELECT merged_reasoning_stripped_ids AS ids FROM session_meta WHERE session_id = ?",
                        )
                        .get(sessionId) as { ids: string }
                ).ids,
            ).includes("@tool-sweep-scoped");
        // Both arms replay the same history on a pass that may not change bytes.
        // They differ only in what the durable snapshot says was served last.
        const runArm = async (sessionId: string, lastServedKeepsReasoning: boolean) => {
            const source = sourceFor(sessionId);
            const transform = makeTransform(sessionId);
            const run = async () => {
                const output = { messages: structuredClone(source) };
                await transform({}, output);
                return output.messages;
            };
            await run();
            const tool = getTagsBySession(db, sessionId).find((tag) => tag.type === "tool");
            expect(tool).toBeDefined();
            updateTagStatus(db, sessionId, tool!.tagNumber, "dropped");
            updateTagDropMode(db, sessionId, tool!.tagNumber, "full");
            const legacy = await run();
            expect(legacy.some((message) => message.info.id === "lkg-thinking")).toBe(false);
            expect(marker(sessionId)).toBe(false);
            const lastServed = lastServedKeepsReasoning
                ? legacy.flatMap((message) =>
                      message.info.id === "lkg-notice"
                          ? [
                                {
                                    info: { id: "lkg-thinking", role: "assistant" },
                                    parts: [{ type: "reasoning", text: "signed reasoning only" }],
                                },
                                message,
                            ]
                          : [message],
                  )
                : legacy;
            expect(
                captureSlot(sessionId, {
                    jsonPrefix: JSON.stringify(lastServed),
                    inputIdSeq: ["lkg-user"],
                    inputContentDigests: ["seeded-last-served"],
                    lastInputMessageId: "lkg-user",
                    modelKey: "anthropic/claude-opus-5",
                    providerKey: "anthropic",
                    capturedAt: Date.now(),
                }),
            ).toBe(true);
            return { legacy, replay: await run() };
        };

        const old = await runArm("ses-sweep-lkg-old", false);
        const scoped = await runArm("ses-sweep-lkg-scoped", true);
        console.log(`SCOPED_GATE lkg replay old=${sha(old.replay)} scoped=${sha(scoped.replay)}`);
        // Served-under-legacy session keeps being served the legacy array.
        expect(sha(old.replay)).toBe(sha(old.legacy));
        expect(old.replay.some((message) => message.info.id === "lkg-thinking")).toBe(false);
        expect(marker("ses-sweep-lkg-old")).toBe(false);
        // Served-under-scoped session gets its reasoning-only turn back — that
        // is a replay of its own bytes — and records the adoption.
        expect(
            scoped.replay
                .find((message) => message.info.id === "lkg-thinking")
                ?.parts.some((part) => part.type === "reasoning"),
        ).toBe(true);
        expect(marker("ses-sweep-lkg-scoped")).toBe(true);
        expect(sha(old.replay)).not.toBe(sha(scoped.replay));
    });
    async function runMarkerBoundaryFixture(options: {
        name: string;
        deleteBoundary?: boolean;
        sourceAlreadyHostTrimmed?: boolean;
        sourceBoundaryMissing?: boolean;
        applyOutcome?: "applied" | "retryable-failure" | "concurrent-winner";
    }) {
        useTempDataHome(`context-transform-marker-boundary-${options.name}-`);
        const sessionId = `ses-marker-boundary-${options.name}`;
        const directory = makeTempDir(`marker-boundary-project-${options.name}-`);
        const db = openDatabase();
        const baseCompartment = {
            sequence: 0,
            startMessage: 1,
            endMessage: 1,
            startMessageId: "base",
            endMessageId: "base",
            title: "Baseline",
            content: "Baseline history",
        };
        const targetCompartment = {
            sequence: 1,
            startMessage: 2,
            endMessage: 3,
            startMessageId: "middle",
            endMessageId: "assistant-boundary",
            title: "Advanced",
            content: "Advanced history",
        };
        const startsAlreadyCovered =
            options.sourceAlreadyHostTrimmed === true || options.sourceBoundaryMissing === true;
        replaceAllCompartments(
            db,
            sessionId,
            startsAlreadyCovered ? [baseCompartment, targetCompartment] : [baseCompartment],
        );
        injectM0M1({
            db,
            sessionId,
            state: getOrCreateSessionMeta(db, sessionId),
            projectDirectory: directory,
            injectDocs: false,
            memoryEnabled: false,
        });

        let decision: "execute" | "defer" = "defer";
        const deferredHistoryRefreshSessions = new Set<string>();
        const reconciledStates: Array<ReturnType<typeof getPersistedCompactionMarkerState>> = [];
        const applyDeferred = mock(
            (
                markerDb: typeof db,
                markerSessionId: string,
                pending: { ordinal: number; endMessageId: string; publishedAt: number },
            ): MarkerUpdateOutcome => {
                if (options.applyOutcome === "retryable-failure") {
                    return { kind: "retryable-failure", error: new Error("persist failed") };
                }
                if (options.applyOutcome === "concurrent-winner") {
                    setPersistedCompactionMarkerState(markerDb, markerSessionId, {
                        boundaryMessageId: "winner-user",
                        summaryMessageId: "winner-summary",
                        compactionPartId: "winner-compaction",
                        summaryPartId: "winner-part",
                        boundaryOrdinal: pending.ordinal + 1,
                        targetEndMessageId: "winner-target",
                    });
                    return { kind: "already-current" };
                }
                return { kind: "applied", markerOrdinal: pending.ordinal };
            },
        );
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: () => decision },
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 60_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            directory,
            injectDocs: false,
            memoryConfig: { enabled: false, injectionBudgetTokens: 0, autoPromote: false },
            historyRefreshSessions: new Set(),
            deferredHistoryRefreshSessions,
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            clearReasoningAge: 1000,
            protectedTokens: 0,
            historianRunnable: false,
            compactionMarkerStrategy: {
                applyDeferred,
                reconcile: (_messages, state) => {
                    reconciledStates.push(state);
                    return false;
                },
            },
        });
        const source = (): TestMessage[] => [
            {
                info: { id: "base", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "base" }],
            },
            {
                info: { id: "middle", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "middle" }],
            },
            {
                info: { id: "assistant-boundary", role: "assistant" },
                parts: options.deleteBoundary
                    ? [
                          {
                              type: "tool",
                              tool: "bash",
                              callID: "boundary-call",
                              state: { status: "completed", output: "spent" },
                          },
                      ]
                    : [{ type: "text", text: "assistant boundary" }],
            },
            {
                info: { id: "tail", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "retained tail" }],
            },
        ];

        if (options.deleteBoundary) {
            await transform({}, { messages: structuredClone(source()) });
            const boundaryTag = getTagsBySession(db, sessionId).find(
                (tag) => tag.messageId === "boundary-call",
            );
            expect(boundaryTag).toBeDefined();
            updateTagStatus(db, sessionId, boundaryTag!.tagNumber, "dropped");
            updateTagDropMode(db, sessionId, boundaryTag!.tagNumber, "full");
        }
        if (!startsAlreadyCovered) {
            replaceAllCompartments(db, sessionId, [baseCompartment, targetCompartment]);
        }
        if (options.sourceAlreadyHostTrimmed) {
            setPersistedCompactionMarkerState(db, sessionId, {
                boundaryMessageId: "marker-user",
                summaryMessageId: "marker-summary",
                compactionPartId: "marker-compaction",
                summaryPartId: "marker-summary-part",
                boundaryOrdinal: 3,
                targetEndMessageId: "assistant-boundary",
            });
        }
        setPendingCompactionMarkerState(db, sessionId, {
            ordinal: 3,
            endMessageId: "assistant-boundary",
            publishedAt: 1,
        });
        deferredHistoryRefreshSessions.add(sessionId);
        decision = "execute";
        const messages = options.sourceAlreadyHostTrimmed
            ? [
                  {
                      info: {
                          id: "marker-summary",
                          role: "assistant",
                          sessionID: sessionId,
                          summary: true,
                      },
                      parts: [{ type: "text", text: "marker" }],
                  },
                  source()[3]!,
              ]
            : options.sourceBoundaryMissing
              ? [source()[3]!]
              : source();
        const refusal = await transform({}, { messages }).then(
            () => null,
            (error: unknown) => {
                if (options.applyOutcome !== "retryable-failure") throw error;
                return error;
            },
        );
        return {
            refusal,
            applyDeferred,
            db,
            deferredHistoryRefreshSessions,
            messages,
            reconciledStates,
            sessionId,
        };
    }

    it("trims through a boundary deleted by tool replay before draining the marker", async () => {
        const result = await runMarkerBoundaryFixture({ name: "deleted", deleteBoundary: true });
        expect(result.applyDeferred).toHaveBeenCalledTimes(1);
        expect(result.messages.map((message) => message.info.id).filter(Boolean)).toEqual(["tail"]);
        expect(getPendingCompactionMarkerState(result.db, result.sessionId)).toBeNull();
        expect(result.deferredHistoryRefreshSessions.has(result.sessionId)).toBe(false);
    });

    it("accepts an already host-trimmed boundary only when the source carries its marker", async () => {
        const result = await runMarkerBoundaryFixture({
            name: "already-host-trimmed",
            sourceAlreadyHostTrimmed: true,
        });
        expect(result.applyDeferred).toHaveBeenCalledTimes(1);
        expect(getPendingCompactionMarkerState(result.db, result.sessionId)).toBeNull();
        expect(result.messages.some((message) => message.info.id === "assistant-boundary")).toBe(
            false,
        );
    });

    it("refuses marker drain when the immutable source lacks the pending boundary", async () => {
        const result = await runMarkerBoundaryFixture({
            name: "missing-source",
            sourceBoundaryMissing: true,
        });
        expect(result.applyDeferred).not.toHaveBeenCalled();
        expect(getPendingCompactionMarkerState(result.db, result.sessionId)).not.toBeNull();
        expect(result.deferredHistoryRefreshSessions.has(result.sessionId)).toBe(true);
    });

    it("trims an assistant-ended seam in canonical source order", async () => {
        const result = await runMarkerBoundaryFixture({ name: "assistant-seam" });
        expect(result.applyDeferred).toHaveBeenCalledTimes(1);
        expect(result.messages.map((message) => message.info.id).filter(Boolean)).toEqual(["tail"]);
    });

    it("reconciles the concurrent marker winner after a proven trim", async () => {
        const result = await runMarkerBoundaryFixture({
            name: "concurrent-winner",
            applyOutcome: "concurrent-winner",
        });
        expect(result.applyDeferred).toHaveBeenCalledTimes(1);
        expect(result.reconciledStates.at(-1)?.boundaryOrdinal).toBe(4);
        expect(getPendingCompactionMarkerState(result.db, result.sessionId)).toBeNull();
    });

    it("preserves marker and refresh signals when persistence fails after a proven trim", async () => {
        const result = await runMarkerBoundaryFixture({
            name: "persistence-failure",
            applyOutcome: "retryable-failure",
        });
        expect(result.refusal).toMatchObject({
            name: "DegradedPassRefusalError",
            site: "compaction-marker-drain-failure",
        });
        expect(result.applyDeferred).toHaveBeenCalledTimes(1);
        expect(getPendingCompactionMarkerState(result.db, result.sessionId)).not.toBeNull();
        expect(result.deferredHistoryRefreshSessions.has(result.sessionId)).toBe(true);
    });

    it("holds completed reasoning-only assistants after demotion on defer", async () => {
        useTempDataHome("context-transform-reasoning-only-demotion-");
        const sessionId = "ses-reasoning-only-demotion";
        let decision: "execute" | "defer" = "execute";
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: () => decision },
            liveModelBySession: new Map([
                [sessionId, { providerID: "anthropic", modelID: "claude-opus-5" }],
            ]),
            contextUsageMap: new Map(),
            db: openDatabase(),
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            clearReasoningAge: 50,
            protectedTokens: 0,
            historianRunnable: false,
        });
        const messages: TestMessage[] = [
            {
                info: {
                    id: "user",
                    role: "user",
                    sessionID: sessionId,
                    providerID: "anthropic",
                    modelID: "claude-opus-5",
                },
                parts: [{ type: "text", text: "start" }],
            },
            {
                info: { id: "previous", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        tool: "bash",
                        callID: "previous-call",
                        state: { status: "completed", output: "done" },
                    },
                ],
            },
            {
                info: {
                    id: "msg_0bedb7d8f001FvFOQdZoGqywkr",
                    role: "assistant",
                    providerID: "anthropic",
                    modelID: "claude-opus-5",
                    finish: "stop",
                    time: { created: 1789908450703, completed: 1789908461333 },
                },
                parts: [
                    { type: "step-start", text: "" },
                    { type: "reasoning", text: "signed reasoning only" },
                    { type: "step-finish", text: "" },
                ],
            },
            {
                info: { id: "notice", role: "user" },
                parts: [
                    {
                        type: "text",
                        text: "<system-reminder>[BACKGROUND BASH COMPLETED]</system-reminder>",
                    },
                ],
            },
        ];
        const a = { messages: structuredClone(messages) };
        await transform({}, a);
        decision = "defer";
        messages.push({
            info: { id: "newest", role: "assistant" },
            parts: [
                { type: "reasoning", text: "new thinking" },
                {
                    type: "tool",
                    tool: "bash",
                    callID: "new-call",
                    state: { status: "completed", output: "done" },
                },
            ],
        });
        const b = { messages: structuredClone(messages) };
        await transform({}, b);
        const target = (output: typeof a) =>
            output.messages.find((m) => m.info.id === "msg_0bedb7d8f001FvFOQdZoGqywkr");
        expect(target(a)?.parts.some((p) => p.type === "reasoning")).toBe(true);
        expect(target(b)).toEqual(target(a));
        expect(target(b)?.parts).toEqual([
            { type: "text", text: "" },
            { type: "reasoning", text: "signed reasoning only" },
            { type: "text", text: "" },
        ]);
        const sha = (value: unknown) =>
            createHash("sha256").update(JSON.stringify(value)).digest("hex");
        expect(sha(b.messages.slice(0, a.messages.length))).toBe(sha(a.messages));
        expect(b.messages.findIndex((m) => m.info.id === "notice")).toBe(
            b.messages.findIndex((m) => m.info.id === "msg_0bedb7d8f001FvFOQdZoGqywkr") + 1,
        );
    });
    it("logs both nudge gate verdicts on every evaluable TypeScript pass", async () => {
        useTempDataHome("context-transform-nudge-observability-");
        const sessionId = "ses-nudge-observability";
        const sessionLog = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: () => "defer" },
            contextUsageMap: new Map(),
            db: openDatabase(),
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            clearReasoningAge: 50,
            protectedTokens: 0,
            historianRunnable: false,
            channel1StateBySession: new Map(),
        });
        const messages: TestMessage[] = [
            {
                info: { id: "nudge-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "inspect the gates" }],
            },
            {
                info: { id: "nudge-assistant", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        tool: "read",
                        callID: "call-nudge",
                        state: { output: "spent output" },
                    },
                ],
            },
        ];

        try {
            await transform({}, { messages: structuredClone(messages) });
            await transform({}, { messages: structuredClone(messages) });

            const lines = sessionLog.mock.calls
                .filter((call) => call[0] === sessionId)
                .map((call) => String(call[1]));
            const channel1 = lines.filter((line) => line.startsWith("channel1 evaluation:"));
            const channel2 = lines.filter((line) => line.startsWith("channel2 evaluation:"));
            expect(channel1).toHaveLength(2);
            expect(channel2).toHaveLength(2);
            for (const line of [...channel1, ...channel2]) {
                expect(line).toContain(" U=");
                expect(line).toContain(" T=");
                expect(line).toContain(" ratio=");
                expect(line).toContain(" band=");
                expect(line).toContain(" verdict=");
                expect(line).toContain(" reason=");
            }
            expect(channel1.every((line) => line.includes("growth_threshold="))).toBe(true);
            expect(channel1.every((line) => line.includes("sticky_floor_turns_remaining="))).toBe(
                true,
            );
            expect(channel1.every((line) => line.includes("dampening="))).toBe(true);
            expect(channel2.every((line) => line.includes("lease="))).toBe(true);
        } finally {
            sessionLog.mockRestore();
        }
    });

    it("hydrates only dropped rows for visible-target replay with 98% active tags", () => {
        useTempDataHome("context-transform-replay-rows-");
        const realDb = openDatabase();
        const replayRows: Array<{ status: string }> = [];
        const replayChunkSizes: number[] = [];
        const db = new Proxy(realDb, {
            get(target, prop, receiver) {
                if (prop === "prepare") {
                    return (sql: string) => {
                        const statement = target.prepare(sql);
                        if (
                            !/FROM tags WHERE session_id = \? AND (?:status = 'dropped' AND )?tag_number IN \(/.test(
                                sql,
                            )
                        ) {
                            return statement;
                        }
                        return new Proxy(statement, {
                            get(stmt, key) {
                                if (key === "all") {
                                    return (...params: Parameters<typeof stmt.all>) => {
                                        const rows = stmt.all(...params);
                                        replayRows.push(...(rows as Array<{ status: string }>));
                                        // Count requested ids, not SQLite binds: the cached
                                        // statement carries each unchanged chunk as JSON.
                                        replayChunkSizes.push(
                                            sql.includes("json_each")
                                                ? JSON.parse(String(params[1])).length
                                                : params.length - 1,
                                        );
                                        return rows;
                                    };
                                }
                                const value = Reflect.get(stmt, key);
                                return typeof value === "function" ? value.bind(stmt) : value;
                            },
                        });
                    };
                }
                const value = Reflect.get(target, prop, receiver);
                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as typeof realDb;
        const sessionId = "ses-replay-row-count";
        // Only the visible-target lookup needs 2,000 tags; two full transforms add unrelated work.
        realDb.transaction(() => {
            for (let number = 1; number <= 2000; number++) {
                insertTag(realDb, sessionId, `replay-${number}`, "message", 20, number);
                if (number % 50 === 0) updateTagStatus(realDb, sessionId, number, "dropped");
            }
        })();
        const tags = getTagsBySession(realDb, sessionId);
        expect(tags).toHaveLength(2000);
        expect(
            tags.filter((tag) => tag.status === "active" && tag.cavemanDepth === 0),
        ).toHaveLength(1960);

        const hydrated = getDroppedTagsByNumbers(
            db,
            sessionId,
            tags.map((tag) => tag.tagNumber),
        );
        expect(replayChunkSizes).toEqual([900, 900, 200]);
        expect(replayRows).toHaveLength(40);
        expect(hydrated).toHaveLength(40);
        expect(replayRows.every((row) => row.status === "dropped")).toBe(true);
    });

    it("preserves the pre-optimization served-wire digest for mixed replay states", async () => {
        useTempDataHome("context-transform-replay-wire-");
        const db = openDatabase();
        const sessionId = "ses-replay-wire";
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: () => "defer" },
            contextUsageMap: new Map(),
            db,
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            clearReasoningAge: 50,
            protectedTokens: 0,
            historianRunnable: false,
            cavemanTextCompression: { enabled: true, minChars: 50 },
        });
        const original =
            "I just wanted to basically clearly explain that the implementation is actually quite complex because the historian and compartment machinery work together. ".repeat(
                4,
            );
        const input: TestMessage[] = [
            {
                info: {
                    id: "request",
                    role: "user",
                    sessionID: sessionId,
                    tools: { ctx_reduce: true },
                },
                parts: [{ type: "text", text: "Please inspect the changes." }],
            },
            ...(["full", "truncated", "edit_marker"] as const).map((mode) => ({
                info: { id: `tool-${mode}`, role: "assistant", sessionID: sessionId },
                parts: [
                    {
                        type: "tool" as const,
                        tool: "edit",
                        callID: `call-${mode}`,
                        state: {
                            status: "completed",
                            input: {
                                filePath: "src/example.ts",
                                oldString: "old value",
                                newString: "new value",
                            },
                            output: `Original output for ${mode}`,
                        },
                    },
                ],
            })),
            {
                info: { id: "compressed", role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: original }],
            },
            {
                info: { id: "depth-zero", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "Keep the uncompressed explanation." }],
            },
            {
                info: { id: "compacted", role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: "Previously compacted message still visible." }],
            },
            {
                info: { id: "tail", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "Continue the review." }],
            },
        ];
        await transform({}, { messages: structuredClone(input) });
        const tags = getTagsBySession(db, sessionId);
        for (const mode of ["full", "truncated", "edit_marker"] as const) {
            const tag = tags.find((tag) => tag.type === "tool" && tag.messageId === `call-${mode}`);
            expect(tag).toBeDefined();
            updateTagStatus(db, sessionId, tag!.tagNumber, "dropped");
            updateTagDropMode(db, sessionId, tag!.tagNumber, mode);
        }
        const compressedTag = tags.find((tag) => tag.messageId === "compressed:p0");
        const compactedTag = tags.find((tag) => tag.messageId === "compacted:p0");
        expect(compressedTag).toBeDefined();
        expect(compactedTag).toBeDefined();
        updateCavemanDepth(db, sessionId, compressedTag!.tagNumber, 1);
        updateTagStatus(db, sessionId, compactedTag!.tagNumber, "compacted");
        const served = structuredClone(input);
        await transform({}, { messages: served });
        expect(served.some((message) => message.info.id === "tool-full")).toBe(false);
        for (const mode of ["truncated", "edit_marker"]) {
            const message = served.find((message) => message.info.id === `tool-${mode}`);
            expect(message).toBeDefined();
            expect(toolOutput(message!, 0)).toContain("[dropped");
        }
        const compressed = served.find((message) => message.info.id === "compressed");
        expect(compressed).toBeDefined();
        expect(text(compressed!, 0)).not.toContain("I just wanted");
        expect(text(compressed!, 0).length).toBeGreaterThan(0);
        const digest = createHash("sha256").update(JSON.stringify(served)).digest("hex");
        // Pinned from the full-target reader before narrowing the replay query:
        // the optimization must retain every served byte, including caveman text.
        expect(digest).toBe("0e3b74f2fc4379eeb93244788f0eb21920ac7892570303858c64cd2a19d810b0");
    });

    it("serves byte-identical hot passes while coalescing state and skipping all-hit token SQL", async () => {
        useTempDataHome("context-transform-hotpath-snapshot-");
        const realDb = openDatabase();
        const preparedSql: string[] = [];
        const tokenQueryIds: string[][] = [];
        const db = new Proxy(realDb, {
            get(target, prop, receiver) {
                if (prop === "prepare") {
                    return (sql: string) => {
                        preparedSql.push(sql);
                        const statement = target.prepare.call(target, sql);
                        if (
                            !sql.includes("tags.reasoning_token_count") ||
                            !sql.includes("status = 'active'")
                        )
                            return statement;
                        // Observe executions rather than compiles: the prepared
                        // exact-owner statement survives between transform passes.
                        return new Proxy(statement, {
                            get(stmt, key) {
                                if (key === "all")
                                    return (...params: Parameters<typeof stmt.all>) => {
                                        tokenQueryIds.push(JSON.parse(String(params[0])));
                                        return stmt.all(...params);
                                    };
                                const value = Reflect.get(stmt, key);
                                return typeof value === "function" ? value.bind(stmt) : value;
                            },
                        });
                    };
                }
                const value = Reflect.get(target, prop, receiver);
                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as typeof realDb;
        const sessionId = "ses-hotpath-snapshot";
        const contextUsageMap = new Map([
            [
                sessionId,
                {
                    usage: { percentage: 20, inputTokens: 20_000 },
                    updatedAt: 1_000,
                    lastResponseTime: 1_000,
                    hasUsageTokens: true,
                },
            ],
        ]);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap,
            db,
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            clearReasoningAge: 50,
            protectedTokens: 0,
            directory: makeTempDir("context-transform-hotpath-project-"),
            historianRunnable: false,
            liveModelBySession: new Map([
                [sessionId, { providerID: "anthropic", modelID: "claude-test" }],
            ]),
        });
        const input = Array.from({ length: 20 }, (_, index): TestMessage => {
            const user = index % 2 === 0;
            return {
                info: {
                    id: `hotpath-${index}`,
                    role: user ? "user" : "assistant",
                    sessionID: sessionId,
                    ...(user
                        ? { tools: { ctx_reduce: true, todowrite: true } }
                        : { providerID: "anthropic", modelID: "claude-test" }),
                },
                parts: [{ type: "text", text: `stable ${index}` }],
            };
        });
        const digest = (messages: TestMessage[]) =>
            createHash("sha256").update(JSON.stringify(messages)).digest("hex");

        const first = structuredClone(input);
        await transform({}, { messages: first });
        expect(tokenQueryIds).toHaveLength(1);
        tokenQueryIds.length = 0;
        preparedSql.length = 0;
        const second = structuredClone(input);
        await transform({}, { messages: second });

        expect(digest(second)).toBe(digest(first));
        expect(
            preparedSql.filter((sql) => sql.includes("SELECT historian_failure_count")).length,
        ).toBe(1);
        expect(
            preparedSql.filter((sql) => sql.includes("SELECT stale_reduce_stripped_ids")).length,
        ).toBe(1);
        expect(preparedSql.some((sql) => sql.includes("SELECT last_response_time FROM"))).toBe(
            false,
        );
        expect(tokenQueryIds).toHaveLength(0);

        clearMessageTokensCache(sessionId, "hotpath-0");
        preparedSql.length = 0;
        const afterRemovalInvalidation = structuredClone(input);
        await transform({}, { messages: afterRemovalInvalidation });
        expect(digest(afterRemovalInvalidation)).toBe(digest(second));
        expect(tokenQueryIds).toEqual([["hotpath-0"]]);
    });

    it("refuses the pass and leaves the raw array untouched when session metadata is unreadable", async () => {
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
            protectedTokens: 0,
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

        // Returning would serve these raw messages without the session's
        // reductions; the pass stops so the wrapper replays or refuses.
        await expect(transform({}, output)).rejects.toMatchObject({
            name: "DegradedPassRefusalError",
            site: "session-meta-early-return",
        });

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
            protectedTokens: 0,
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
                `SELECT message_id, decision, materialize_reason
                   FROM transform_decisions
                  WHERE session_id = ?
                  ORDER BY rowid`,
            )
            .all(sessionId) as Array<{
            message_id: string;
            decision: string;
            materialize_reason: string | null;
        }>;
        expect(rows).toEqual([
            {
                message_id: "decision-response-a",
                decision: "execute",
                materialize_reason: "first_render",
            },
            {
                message_id: "decision-response-b",
                decision: "execute",
                materialize_reason: "model_change",
            },
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
            protectedTokens: 0,
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
            protectedTokens: 0,
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
            protectedTokens: 0,
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
            protectedTokens: 0,
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
            protectedTokens: 0,
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
            protectedTokens: 0,
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
            protectedTokens: 0,
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
            protectedTokens: 0,
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
            protectedTokens: 0,
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

    it("yields the protected token window at absolute emergency pressure", async () => {
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
                    { usage: { percentage: 96, inputTokens: 192_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 0,
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
            // A later prompt, so this call does not end the conversation (drop()
            // keeps that one as a skeleton instead of removing it).
            {
                info: { id: "m-next", role: "user", sessionID: "ses-force-materialize" },
                parts: [{ type: "text", text: "next prompt" }],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then — absolute emergency pressure yields the token window, so the
        // tool-only assistant shell is removed by the full-drop path.
        expect(messages.map((message) => message.info.id)).toEqual(["m-user", "m-next"]);
        const tags = getTagsBySession(db, "ses-force-materialize");
        expect(tags.find((tag) => tag.type === "tool")?.status).toBe("dropped");
        expect(tags.find((tag) => tag.type === "tool")?.dropMode).toBe("full");
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
            protectedTokens: 10,
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
                    { type: "step-start", text: "start" },
                    { type: "meta", text: "meta" },
                    { type: "reasoning", text: "[cleared]" },
                    { type: "text", text: "visible answer" },
                    { type: "step-finish", text: "finish" },
                ],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then — leading structural parts preserve their positions as sentinels, while
        // the frozen strip removes the completion sentinel before it can change in history.
        expect(messages[1].parts).toHaveLength(4);
        expect(text(messages[1], 3)).toContain("visible answer");
        const sentineledParts = (
            messages[1].parts as Array<{ type: string; text?: string }>
        ).filter((p) => p.type === "text" && p.text === "");
        expect(sentineledParts).toHaveLength(3);
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
            protectedTokens: 10,
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
                protectedTokens: 10,
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
            protectedTokens: 10,
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
            pendingMaterializationSessions: new Set<string>([sessionId]),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 0,
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

        //#then — main transform strips the step-start with the recovered provider.
        // The raw suffix decision is `strip`, so postprocess also removes that
        // Magic Context sentinel instead of freezing it as a provider blank.
        expect(messages[1].parts).toHaveLength(1);
        expect(messages[1].parts[0]).toMatchObject({ type: "text" });
        expect(messages[1].parts[0]?.text).toContain("visible");
        expect(messages[2].parts).toEqual([{ type: "text", text: "" }]);
    });

    it("applies pending drop operations on an explicit flush", async () => {
        //#given
        useTempDataHome("context-transform-ops-");
        const shouldExecute = mock<Scheduler["shouldExecute"]>(() => "defer");
        const scheduler: Scheduler = { shouldExecute };
        const channel1StateBySession = new Map<
            string,
            import("./ctx-reduce-nudge").Channel1State
        >();
        const pendingMaterializationSessions = new Set<string>();
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
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 0,
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
            // A later prompt, so the tool call does not end the conversation (drop()
            // keeps that one as a skeleton instead of removing it).
            {
                info: { id: "m-next", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "next prompt" }],
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
            insertTag(db, "ses-1", `call-pad-${i}`, "tool", 10, 3 + i, 0, null, 0, null, null, {
                tokenCount: 1_000,
                inputTokenCount: 0,
                reasoningTokenCount: 0,
            });
        }
        queuePendingOp(db, "ses-1", 1, "drop");
        pendingMaterializationSessions.add("ses-1");
        queuePendingOp(db, "ses-1", 2, "drop");
        pendingMaterializationSessions.add("ses-1");
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
            // A later prompt, so the tool call does not end the conversation (drop()
            // keeps that one as a skeleton instead of removing it).
            {
                info: { id: "m-next", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "next prompt" }],
            },
        ];

        //#when
        await transform({}, { messages: secondPass });

        //#then — user message shell is preserved (turn boundary) as the canonical
        // [dropped §N§] placeholder; the tool tag is padded OUT of the newest-20
        // skeleton window above, so the tool-only assistant takes the legacy
        // FULL-removal path and its shell is stripped. (The in-window skeleton path
        // is covered in apply-operations.tool-drop.test.ts.)
        expect(secondPass.map((message) => message.info.id)).toEqual(["m-user", "m-next"]);
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
            protectedTokens: 0,
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
            protectedTokens: 0,
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
        // migration). Unlike a generic subagent, these get ZERO
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
            protectedTokens: 0,
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
            protectedTokens: 0,
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
            protectedTokens: 0,
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
            protectedTokens: 0,
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
        const pendingMaterializationSessions = new Set<string>();
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
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 0,
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
        pendingMaterializationSessions.add("ses-sub-drop");

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

    it("yields the protected token window for subagents at >=95%", async () => {
        // Subagents retain the same absolute-emergency escape as primary
        // sessions: at >=95%, the token window yields so recovery can reclaim.
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
                    { usage: { percentage: 96, inputTokens: 192_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId,
            clearReasoningAge: 50,
            protectedTokens: 4_000,
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

        // The oldest large tool output is dropped after the window yields.
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
            protectedTokens: 0,
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

    it("preserves Channel 1 crossing state when a baseline refresh sees a smaller tail", async () => {
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
            protectedTokens: 0,
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

        // The next tool-output decision observes a lower band and rearms it.
        // Clearing here would turn the same post-reduce band into a full crossing.
        expect(getLastNudgeUndropped(db, sessionId)).toBe(80_000);
        expect(getChannel1NudgeState(db, sessionId)).toEqual({ level: "urgent", ordinal: 12 });
        expect(
            db
                .prepare("SELECT last_nudge_level FROM session_meta WHERE session_id = ?")
                .get(sessionId),
        ).toEqual({ last_nudge_level: '{"level":"urgent","ordinal":12}' });
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
            protectedTokens: 0,
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
        const pendingMaterializationSessions = new Set<string>();
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
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 0,
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
        pendingMaterializationSessions.add(sessionId);

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
            pendingMaterializationSessions: new Set<string>(["ses-primary-once"]),
            lastHeuristicsTurnId,
            clearReasoningAge: 50,
            protectedTokens: 0,
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
            protectedTokens: 0,
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
        const pendingMaterializationSessions = new Set<string>();
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
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 0,
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
        pendingMaterializationSessions.add("ses-multi");

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

    it("clears thinking with a text drop only after a real user ends the thinking turn", async () => {
        //#given
        useTempDataHome("context-transform-thinking-");
        const shouldExecute = mock<Scheduler["shouldExecute"]>(() => "defer");
        const scheduler: Scheduler = { shouldExecute };
        const pendingMaterializationSessions = new Set<string>();
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
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 0,
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
        pendingMaterializationSessions.add("ses-think");
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

        expect(secondPass[1].parts[0]).toEqual({
            type: "thinking",
            thinking: "long internal reasoning that eats context",
        });
        expect(getPendingOps(db, "ses-think").map((op) => op.tagId)).toContain(assistantTextTag);
        secondPass.push({
            info: { id: "next-user", role: "user", sessionID: "ses-think" },
            parts: [{ type: "text", text: "Next turn" }],
        });
        await transform({}, { messages: secondPass });

        //#then — outside the active turn the existing representation still clears
        // thinking with its dropped text and keeps the canonical empty sentinel.
        expect(secondPass).toHaveLength(3);
        expect(text(secondPass[0], 0)).toContain("user prompt");
        expect(secondPass[1].parts).toEqual([{ type: "text", text: "" }]);
    });

    it("refuses the pass when session meta lookup throws", async () => {
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
            protectedTokens: 0,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-meta-fail" },
                parts: [{ type: "text", text: "keep" }],
            },
        ];

        //#when / #then: an unreadable session meta stops the pass; the messages
        // wrapper then replays the last good request or refuses the turn.
        await expect(transform({}, { messages })).rejects.toMatchObject({
            name: "DegradedPassRefusalError",
            site: "session-meta-early-return",
        });
        expect(text(messages[0], 0)).toBe("keep");
    });

    it("refuses the pass and resets tagger state when tagger init fails", async () => {
        //#given
        useTempDataHome("context-transform-tagger-error-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        const baseTagger = createTagger();
        const tagger = {
            ...baseTagger,
            initFromDb: mock(() => {
                throw new Error("tagger broken");
            }),
            cleanup: mock((sessionId: string) => baseTagger.cleanup(sessionId)),
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
            protectedTokens: 0,
        });
        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-tagger-fail" },
                parts: [{ type: "text", text: "still works" }],
            },
        ];

        //#when / #then: without tag targets the session's persisted drops
        // cannot be replayed, so the pass is not served. The tagger is reset
        // so the next pass reloads it from the database.
        await expect(transform({}, { messages })).rejects.toMatchObject({
            name: "DegradedPassRefusalError",
            site: "tagging-persistence-failure",
        });
        expect(tagger.cleanup).toHaveBeenCalledWith("ses-tagger-fail");
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
            protectedTokens: 0,
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
            protectedTokens: 0,
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
            protectedTokens: 0,
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

        //#then — dropped tag's content is replaced even without usage data. The
        // tool ends the conversation, so the drop keeps its skeleton: removing it
        // would leave a text-only assistant as the last message, which providers
        // without assistant prefill support reject.
        expect(toolOutput(messages[1], 1)).toBe(`[dropped \u00a7${toolTag?.tagNumber}\u00a7]`);
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
            protectedTokens: 0,
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

        // Eligibility now runs after the pass; the no-op still clears its intent.
        await getActiveCompartmentRun("ses-pt-flag")?.promise;
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
            protectedTokens: 0,
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
            protectedTokens: 10,
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
        await getActiveCompartmentRun("ses-pt-pending")?.promise;

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
            protectedTokens: 0,
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

    it("preserves a provider limit detected for the outgoing model when stored usage is stale", async () => {
        useTempDataHome("transform-switch-preserve-detected-");
        const sessionId = "ses-preserve-detected";
        createOpenCodeDbForTransform(sessionId, [
            { id: "m-raw-1", role: "user", text: "recent 1" },
            { id: "m-raw-2", role: "assistant", text: "recent 2" },
        ]);
        const db = openDatabase();
        updateSessionMeta(db, sessionId, {
            lastContextPercentage: 0.6,
            lastInputTokens: 1_200,
            lastObservedModelKey: OLD_KEY,
            lastUsageContextLimit: 200_000,
        });
        recordOverflowDetected(db, sessionId, 1_048_576, NEW_KEY, "provider_overflow");
        await seedNewModelLimit(1_200_000);

        const { transform } = makeTransform(db, sessionId, NEW_MODEL, {
            percentage: 0.6,
            inputTokens: 1_200,
        });
        await transform({}, { messages: switchTurnMessages(sessionId) });

        const overflow = getOverflowState(db, sessionId, NEW_KEY);
        expect(overflow.detectedContextLimit).toBe(1_048_576);
        expect(overflow.detectedContextLimitModelKey).toBe(NEW_KEY);
        expect(overflow.needsEmergencyRecovery).toBe(true);
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
            protectedTokens: 0,
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
            protectedTokens: 0,
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

    it("fails closed with a visible reason when a bounded historian join cannot prove fit", async () => {
        useTempDataHome("transform-bounded-historian-fail-closed-");
        const sessionId = "ses-bounded-historian-fail-closed";
        createOpenCodeDbForTransform(sessionId, [
            { id: "m-raw-1", role: "user", text: "recent history" },
        ]);
        await refreshModelLimitsFromApi({
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: "test-provider",
                                models: { "join-100k": { limit: { input: 100_000 } } },
                            },
                        ],
                    },
                }),
            },
        });
        recordToolDefinition("test-provider", "join-100k", "build", "read", "Read a file", {
            type: "object",
        });
        const db = openDatabase();
        updateSessionMeta(db, sessionId, { systemPromptTokens: 110_000 });
        let finishHistorian!: () => void;
        registerActiveCompartmentRun(
            sessionId,
            new Promise<void>((resolve) => {
                finishHistorian = resolve;
            }),
        );
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 96, inputTokens: 96_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 0,
            historianTimeoutMs: 5,
            client: {
                session: {
                    get: mock(async () => ({ data: { directory: "/tmp", title: "Join" } })),
                    prompt: mock(async () => ({})),
                },
            } as unknown as PluginContext["client"],
            directory: "/tmp",
            liveModelBySession: new Map([
                [sessionId, { providerID: "test-provider", modelID: "join-100k" }],
            ]),
            getModelKey: () => "test-provider/join-100k",
            getNotificationParams: () => ({
                agent: "build",
                providerId: "test-provider",
                modelId: "join-100k",
            }),
        });

        try {
            await expect(
                transform(
                    {},
                    {
                        messages: [
                            {
                                info: { id: "m-user", role: "user", sessionID: sessionId },
                                parts: [{ type: "text", text: "continue" }],
                            },
                        ],
                    },
                ),
            ).rejects.toThrow(
                "historian did not complete within 0.005 s: background historian is still running",
            );
        } finally {
            finishHistorian();
        }
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
            protectedTokens: 0,
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

    it("escalates a latched force-pressure episode to provider-overflow fail-closed recovery", async () => {
        useTempDataHome("transform-latched-episode-liveness-");
        const sessionId = "ses-latched-episode-liveness";
        createOpenCodeDbForTransform(sessionId, [
            { id: "m-raw-1", role: "user", text: "recent protected history" },
        ]);
        await refreshModelLimitsFromApi({
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: "test-provider",
                                models: { "episode-100k": { limit: { input: 100_000 } } },
                            },
                        ],
                    },
                }),
            },
        });
        const db = openDatabase();
        const abort = mock(async () => ({ data: true }));
        const prompt = mock(async () => ({}));
        const usage = new Map<string, { usage: ContextUsage; updatedAt: number }>();
        const setUsage = (percentage: number, inputTokens: number) => {
            usage.set(sessionId, {
                usage: { percentage, inputTokens },
                updatedAt: Date.now(),
            });
        };
        const buildMessages = () => {
            const toolParts = Array.from({ length: 30 }, (_, index) => ({
                type: "tool" as const,
                tool: "bash",
                callID: `call-${index + 1}`,
                state: {
                    status: "completed",
                    output: "x".repeat(12_000),
                },
            }));
            return [
                {
                    info: {
                        id: "m-user",
                        role: "user",
                        sessionID: sessionId,
                    },
                    parts: [{ type: "text" as const, text: "continue" }],
                },
                {
                    info: {
                        id: "m-assistant",
                        role: "assistant",
                        providerID: "test-provider",
                        modelID: "episode-100k",
                    },
                    parts: toolParts,
                },
            ];
        };
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: usage,
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 0,
            client: {
                session: {
                    get: mock(async () => ({ data: { directory: "/tmp", title: "Episode" } })),
                    prompt,
                    abort,
                },
            } as unknown as PluginContext["client"],
            directory: "/tmp",
            liveModelBySession: new Map([
                [sessionId, { providerID: "test-provider", modelID: "episode-100k" }],
            ]),
            getModelKey: () => "test-provider/episode-100k",
        });
        const droppedToolCount = () =>
            getTagsBySession(db, sessionId).filter(
                (tag) => tag.type === "tool" && tag.status === "dropped",
            ).length;

        setUsage(10, 10_000);
        await transform({}, { messages: buildMessages() });
        setEmergencyDropSample(db, sessionId, 90_000);
        setUsage(90, 90_000);
        await transform({}, { messages: buildMessages() });
        expect(droppedToolCount()).toBe(0);
        expect(getEmergencyInputSample(db, sessionId)).toBeGreaterThan(0);

        setUsage(94, 94_000);
        await transform({}, { messages: buildMessages() });
        expect(droppedToolCount()).toBe(0);
        expect(abort).not.toHaveBeenCalled();

        recordOverflowDetected(
            db,
            sessionId,
            100_000,
            "test-provider/episode-100k",
            "provider_overflow",
        );
        setUsage(96, 96_000);
        await transform({}, { messages: buildMessages() });

        expect(abort).toHaveBeenCalledTimes(1);
        expect(getEmergencyInputSample(db, sessionId)).toBe(0);
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
        const removeSink = registerNotificationSink({
            sessionId,
            send: () => {
                order.push("notify");
            },
        });
        const prompt = mock(async () => ({}));
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
            protectedTokens: 0,
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

        removeSink();
        expect(order).toEqual(["notify", "abort"]);
        expect(prompt).not.toHaveBeenCalled();
        expect(abort).toHaveBeenCalledWith({
            path: { id: sessionId },
            throwOnError: true,
        });
        expect(getEmergencyInputSample(db, sessionId)).toBe(0);
        expect(drainNotifications(0, sessionId)[0]?.payload.message).toBe(
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

        await refreshModelLimitsFromApi({
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: "test",
                                models: {
                                    "recovery-producer": {
                                        limit: { context: 200_000, output: 32000 },
                                    },
                                },
                            },
                        ],
                    },
                }),
            },
        });
        const createSession = mock(async () => ({ data: { id: "ses-recovery-child" } }));
        const prompt = mock(async () => ({}));
        const transform = createTransform({
            historianModel: "test/recovery-producer",
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
            protectedTokens: 0,
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
            drainNotifications(0, "ses-recovery").some((notice) =>
                String(notice.payload.message).includes("Historian recovery"),
            ),
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

describe("live transform protected-token window", () => {
    async function runMassWindowFixture(options: {
        sessionId: string;
        protectedTokens?: number;
        deprecatedProtectedTagCount?: number;
    }): Promise<number[]> {
        useTempDataHome(`context-transform-protected-window-${options.sessionId}-`);
        await refreshModelLimitsFromApi({
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: "window-provider",
                                models: { "window-200k": { limit: { input: 200_000 } } },
                            },
                        ],
                    },
                }),
            },
        });

        const db = openDatabase();
        const ownerMessageId = `${options.sessionId}-assistant`;
        for (let tagNumber = 1; tagNumber <= 30; tagNumber += 1) {
            insertTag(
                db,
                options.sessionId,
                `call-${tagNumber}`,
                "tool",
                4_000,
                tagNumber,
                0,
                "read",
                0,
                ownerMessageId,
                null,
                { tokenCount: 1_000, inputTokenCount: 0, reasoningTokenCount: 0 },
            );
            queuePendingOp(db, options.sessionId, tagNumber, "drop");
        }

        const messages: TestMessage[] = [
            {
                info: {
                    id: `${options.sessionId}-user`,
                    role: "user",
                    sessionID: options.sessionId,
                },
                parts: [{ type: "text", text: "apply queued cleanup" }],
            },
            {
                info: {
                    id: ownerMessageId,
                    role: "assistant",
                    providerID: "window-provider",
                    modelID: "window-200k",
                },
                parts: Array.from({ length: 30 }, (_, index) => ({
                    type: "tool" as const,
                    tool: "read",
                    callID: `call-${index + 1}`,
                    state: { status: "completed", output: "x".repeat(1_000) },
                })),
            },
        ];
        const transformDeps = {
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "execute" as const) },
            contextUsageMap: new Map([
                [
                    options.sessionId,
                    { usage: { percentage: 20, inputTokens: 40_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set([options.sessionId]),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: options.protectedTokens,
            ...(options.deprecatedProtectedTagCount === undefined
                ? {}
                : { protected_tags: options.deprecatedProtectedTagCount }),
            liveModelBySession: new Map([
                [options.sessionId, { providerID: "window-provider", modelID: "window-200k" }],
            ]),
            getModelKey: () => "window-provider/window-200k",
        } as unknown as Parameters<typeof createTransform>[0];

        await createTransform(transformDeps)({}, { messages });

        return getTagsBySession(db, options.sessionId)
            .filter((tag) => tag.type === "tool" && tag.status === "active")
            .map((tag) => tag.tagNumber);
    }

    it("protects the newest 16 one-thousand-token tools at the derived 16k floor for 200k usableSoft", async () => {
        expect(await runMassWindowFixture({ sessionId: "ses-derived-protected-window" })).toEqual(
            Array.from({ length: 16 }, (_, index) => index + 15),
        );
    });

    it("contracts the live window to the newest 8 tools when protected_tokens is 8k", async () => {
        expect(
            await runMassWindowFixture({
                sessionId: "ses-override-protected-window",
                protectedTokens: 8_000,
            }),
        ).toEqual(Array.from({ length: 8 }, (_, index) => index + 23));
    });

    it("ignores deprecated protected_tags instead of changing the live window", async () => {
        expect(
            await runMassWindowFixture({
                sessionId: "ses-deprecated-count-protected-window",
                deprecatedProtectedTagCount: 5,
            }),
        ).toEqual(Array.from({ length: 16 }, (_, index) => index + 15));
    });
});

describe("Channel 1 reminder copy changes", () => {
    // A reminder is appended to the tool output when it fires, and OpenCode stores that
    // output. Every later pass serves the stored bytes, so a reminder worded with the
    // copy of an earlier release must keep replaying verbatim; only a newly fired
    // reminder may carry the current copy.
    const SUPERSEDED_REMINDER =
        "\n\n<system-reminder>\nHousekeeping: 16 spent tool outputs (~90k tokens) are reclaimable — make a ctx_reduce pass at a natural stopping point.\noldest reclaimable: §1§ read.\n</system-reminder>";

    it("replays a reminder served with superseded copy byte-identically and mints new ones with the current copy", async () => {
        useTempDataHome("context-transform-reminder-copy-");
        const sessionId = "ses-reminder-copy";
        const db = openDatabase();
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>();
        let decision: "execute" | "defer" = "execute";
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: () => decision },
            contextUsageMap,
            db,
            historyRefreshSessions: new Set<string>(),
            deferredHistoryRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            clearReasoningAge: 1000,
            protectedTokens: 0,
            historianRunnable: false,
            liveModelBySession: new Map([
                [sessionId, { providerID: "anthropic", modelID: "claude-opus-5" }],
            ]),
        });
        const source: TestMessage[] = [
            {
                info: { id: "copy-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "start" }],
            },
            {
                info: { id: "copy-tool", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        tool: "read",
                        callID: "copy-call",
                        state: {
                            status: "completed",
                            output: `file contents${SUPERSEDED_REMINDER}`,
                        },
                    },
                ],
            },
            {
                info: { id: "copy-reply", role: "assistant" },
                parts: [{ type: "text", text: "read it" }],
            },
        ];
        const run = async () => {
            const output = { messages: structuredClone(source) };
            await transform({}, output);
            return output.messages;
        };
        const sha = (value: unknown) =>
            createHash("sha256").update(JSON.stringify(value)).digest("hex");

        await run();
        decision = "defer";
        const passA = await run();
        const passB = await run();
        expect(toolOutput(passA[1], 0)).toEndWith(SUPERSEDED_REMINDER);
        expect(sha(passB)).toBe(sha(passA));
        expect(toolOutput(passB[1], 0)).toEndWith(SUPERSEDED_REMINDER);

        const channel1State = {
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
            contentSignature: "copy",
            reducedSinceRefresh: false,
            oldestReclaimableToolTags: [],
        };
        const hook = createToolExecuteAfterHook({
            db,
            channel1StateBySession: new Map([[sessionId, channel1State]]),
        });
        // An output that already carries a reminder is never re-worded.
        const replayed = { output: `file contents${SUPERSEDED_REMINDER}` };
        await hook({ tool: "read", sessionID: sessionId }, replayed);
        expect(replayed.output).toBe(`file contents${SUPERSEDED_REMINDER}`);

        const fresh = { output: "next file" };
        await hook({ tool: "read", sessionID: sessionId }, fresh);
        expect(fresh.output).toContain(
            "spent tool outputs (~80k tokens) are reclaimable. Make a ctx_reduce pass now over the outputs you've already used, then continue.",
        );
        expect(fresh.output).not.toContain("natural stopping point");
    });
});

for (const generation of ["v1", "v2"] as const) {
    it(`${generation} Anthropic task queues reductions for the whole thinking turn, including force`, async () => {
        useTempDataHome(`latest-turn-${generation}-`);
        const db = openDatabase()!;
        const sessionId = `latest-turn-${generation}`;
        const usage = new Map<
            string,
            { usage: ContextUsage; updatedAt: number; hasUsageTokens: boolean }
        >();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { isSubagent: true });
        const transform = createTransform({
            db,
            storeGeneration: generation,
            tagger: createTagger(),
            scheduler: createScheduler({ executeThresholdPercentage: 65 }),
            liveModelBySession: new Map([
                [sessionId, { providerID: "anthropic", modelID: "claude-opus-5-5" }],
            ]),
            contextUsageMap: usage,
            clearReasoningAge: 1,
            protectedTokens: 4000,
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
        });
        const raw: TestMessage[] = [
            {
                info: { id: "prompt", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "task" }],
            },
        ];
        for (let n = 1; n <= 3; n++)
            raw.push({
                info: {
                    id: `step-${n}`,
                    role: "assistant",
                    sessionID: sessionId,
                    providerID: "anthropic",
                    modelID: "claude-opus-5-5",
                },
                parts: [
                    { type: "reasoning", text: `signed thinking ${n}` },
                    { type: "text", text: `spent assistant ${n}` },
                    {
                        type: "tool",
                        tool: "read",
                        callID: `call-${n}`,
                        state: { status: "completed", output: `spent-${n} `.repeat(5000) },
                    },
                ],
            });
        const pass = async () => {
            const messages = structuredClone(raw);
            await transform({}, { messages });
            return messages;
        };
        try {
            const baseline = await pass();
            const tag = getTagsBySession(db, sessionId).find(
                (t) => t.type === "message" && t.messageId.startsWith("step-1"),
            )!;
            expect(tag).toBeDefined();
            queuePendingOp(db, sessionId, tag.tagNumber, "drop");
            for (const percentage of [76, 85]) {
                usage.set(sessionId, {
                    usage: { percentage, inputTokens: percentage * 1000 },
                    updatedAt: Date.now(),
                    hasUsageTokens: true,
                });
                expect(JSON.stringify(await pass())).toBe(JSON.stringify(baseline));
                expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toContain(tag.tagNumber);
                expect(
                    getTagsBySession(db, sessionId).find((t) => t.tagNumber === tag.tagNumber)
                        ?.status,
                ).toBe("active");
            }
            usage.set(sessionId, {
                usage: { percentage: 95, inputTokens: 95_000 },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            });
            // The trailing output was legally reclaimable at 95%. A later
            // signed block now freezes that output too, leaving no safe drop.
            // Holding the unsafe drop never refuses the turn on its own: the
            // unchanged turn is served, because only a proven final-wire
            // overflow refuses a request.
            raw.push({
                info: {
                    id: "last-thought",
                    role: "assistant",
                    sessionID: sessionId,
                    providerID: "anthropic",
                    modelID: "claude-opus-5-5",
                },
                parts: [{ type: "reasoning", text: "last immutable thought" }],
            });
            const held = await pass();
            expect(JSON.stringify(held.slice(0, baseline.length))).toBe(JSON.stringify(baseline));
            expect(held.at(-1)?.parts).toEqual(raw.at(-1)?.parts);
            expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toContain(tag.tagNumber);
            raw.push({
                info: { id: "next", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "Next real user" }],
            });
            usage.set(sessionId, {
                usage: { percentage: 76, inputTokens: 76_000 },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            });
            await pass();
            expect(getPendingOps(db, sessionId)).toHaveLength(0);
        } finally {
            closeQuietly(db);
        }
    });
}

for (const { modelID, prefixBound } of [
    { modelID: "claude-sonnet-5", prefixBound: false },
    { modelID: "claude-sonnet-5-5", prefixBound: true },
]) {
    it(`primary ${modelID} tool loop applies queued drops only where active-turn thinking stays byte-identical`, async () => {
        useTempDataHome(`latest-turn-primary-${modelID}-`);
        const db = openDatabase()!;
        const sessionId = `latest-turn-primary-${modelID}`;
        const usage = new Map<
            string,
            { usage: ContextUsage; updatedAt: number; hasUsageTokens: boolean }
        >();
        getOrCreateSessionMeta(db, sessionId);
        const model = { providerID: "anthropic", modelID };
        const pendingMaterializationSessions = new Set<string>();
        const transform = createTransform({
            db,
            tagger: createTagger(),
            scheduler: createScheduler({ executeThresholdPercentage: 65 }),
            liveModelBySession: new Map([[sessionId, model]]),
            contextUsageMap: usage,
            clearReasoningAge: 1000,
            protectedTokens: 0,
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map(),
        });
        const step = (id: string, n: number, output: string): TestMessage => ({
            info: { id, role: "assistant", sessionID: sessionId, ...model },
            parts: [
                { type: "reasoning", text: `signed thinking ${n}` },
                {
                    type: "tool",
                    tool: "read",
                    callID: `call-${n}`,
                    state: { status: "completed", output: `${output} `.repeat(5000) },
                },
            ],
        });
        // A completed earlier turn, then the active tool loop after a real user request.
        const raw: TestMessage[] = [
            {
                info: { id: "prompt-1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "first task" }],
            },
            step("old-step", 1, "OLD-SPENT"),
            {
                info: { id: "old-final", role: "assistant", sessionID: sessionId, ...model },
                parts: [{ type: "text", text: "first task done" }],
            },
            {
                info: { id: "prompt-2", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "second task" }],
            },
            step("active-1", 2, "ACTIVE-SPENT"),
            // The newest three calls form the protected working set.
            step("active-2", 3, "ACTIVE-LATEST"),
            step("active-3", 4, "ACTIVE-LATEST"),
            step("active-4", 5, "ACTIVE-LATEST"),
        ];
        const pass = async () => {
            const messages = structuredClone(raw);
            await transform({}, { messages });
            return messages;
        };
        const activeThinking = (messages: TestMessage[]) =>
            JSON.stringify(
                messages
                    .slice(messages.findIndex((m) => m.info.id === "prompt-2") + 1)
                    .map((m) => m.parts.filter((part) => part.type === "reasoning")),
            );
        const status = (tag: number) =>
            getTagsBySession(db, sessionId).find((t) => t.tagNumber === tag)?.status;
        try {
            const baseline = await pass();
            const tools = getTagsBySession(db, sessionId)
                .filter((t) => t.type === "tool")
                .sort((a, b) => a.tagNumber - b.tagNumber);
            expect(tools).toHaveLength(5);
            const [oldTag, activeTag] = [tools[0]!.tagNumber, tools[1]!.tagNumber];
            queuePendingOp(db, sessionId, oldTag, "drop");
            queuePendingOp(db, sessionId, activeTag, "drop");
            usage.set(sessionId, {
                usage: { percentage: 76, inputTokens: 76_000 },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            });
            // A primary applies queued drops on a cache-busting pass; request one.
            pendingMaterializationSessions.add(sessionId);
            const executed = await pass();
            // Either way, the active turn's thinking reaches the provider unchanged.
            expect(activeThinking(executed)).toBe(activeThinking(baseline));
            if (prefixBound) {
                // Any earlier output edit would invalidate the later signed blocks of
                // the active turn on this model, so every queued drop waits. (The
                // busting pass may still trim the oldest thinking gap-free, which
                // leaves the active blocks valid; that existing behavior is unchanged.)
                expect(JSON.stringify(executed)).toContain("OLD-SPENT");
                expect(JSON.stringify(executed)).toContain("ACTIVE-SPENT");
                expect(
                    getPendingOps(db, sessionId)
                        .map((op) => op.tagId)
                        .sort((a, b) => a - b),
                ).toEqual([oldTag, activeTag]);
                expect([status(oldTag), status(activeTag)]).toEqual(["active", "active"]);
            } else {
                // Neither output edit touches a thinking block on this model: both apply now.
                expect(JSON.stringify(executed)).not.toContain("OLD-SPENT");
                expect(JSON.stringify(executed)).not.toContain("ACTIVE-SPENT");
                expect(getPendingOps(db, sessionId)).toHaveLength(0);
                expect([status(oldTag), status(activeTag)]).toEqual(["dropped", "dropped"]);
            }
            // The next real user request ends the turn and releases deferred drops.
            raw.push({
                info: { id: "prompt-3", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "third task" }],
            });
            pendingMaterializationSessions.add(sessionId);
            const released = await pass();
            expect(JSON.stringify(released)).not.toContain("OLD-SPENT");
            expect(JSON.stringify(released)).not.toContain("ACTIVE-SPENT");
            expect(getPendingOps(db, sessionId)).toHaveLength(0);
        } finally {
            closeQuietly(db);
        }
    });
}

it("OpenCode spent drain budget keeps served defer bytes unchanged without historian startup", async () => {
    useTempDataHome("transform-spent-drain-bytes-");
    const sessionId = "ses-transform-spent-drain-bytes";
    const raw = [
        ...Array.from({ length: 6 }, (_, i) => ({
            id: `m${i + 1}`,
            role: i % 2 ? "assistant" : "user",
            text: i % 2 ? "done" : "history ".repeat(3500),
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
            id: `m${i + 7}`,
            role: "user",
            text: "protected",
        })),
    ];
    createOpenCodeDbForTransform(sessionId, raw);
    const db = openDatabase();
    getOrCreateSessionMeta(db, sessionId);
    for (const [i, id] of ["m1", "m3", "m5"].entries())
        insertTag(db, sessionId, id, "message", 3500, i + 1);
    db.prepare(
        "UPDATE session_meta SET protected_tail_drain_window_started_at = ?, protected_tail_drain_tokens = 500000 WHERE session_id = ?",
    ).run(Date.now(), sessionId);
    const runner = await import("./compartment-runner");
    const start = spyOn(runner, "startCompartmentAgent").mockImplementation(() => {});
    try {
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: () => "defer" },
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 25, inputTokens: 50_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            protectedTokens: 0,
            client: {
                session: { get: mock(async () => ({ data: { directory: "/tmp" } })) },
            } as unknown as PluginContext["client"],
            directory: "/tmp",
        });
        const pass = async () => {
            const messages = raw.map((m) => ({
                info: { id: m.id, role: m.role, sessionID: sessionId },
                parts: [{ type: "text", text: m.text }],
            })) as TestMessage[];
            await transform({}, { messages });
            return JSON.stringify(messages);
        };
        const bytes = await pass();
        expect(await pass()).toBe(bytes);
        expect(await pass()).toBe(bytes);
        expect(start).not.toHaveBeenCalled();
        expect(getOrCreateSessionMeta(db, sessionId).compartmentInProgress).toBe(false);
    } finally {
        start.mockRestore();
    }
});
