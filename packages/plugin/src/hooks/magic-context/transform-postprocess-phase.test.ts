/// <reference types="bun-types" />

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendCompartments } from "../../features/magic-context/compartment-storage";
import {
    addProcessedImageStrippedIds,
    addStaleReduceStrippedIds,
    advanceToolReclaimWatermark,
    applyStrippedPlaceholderDelta,
    getActiveTagsBySession,
    getChannel2NudgeState,
    getOrCreateSessionMeta,
    getPendingCompactionMarkerState,
    getProcessedImageStrippedIds,
    getStrippedPlaceholderIds,
    getTagsBySession,
    insertTag,
    queueM0Mutation,
    queuePendingOp,
    saveSourceContent,
    setChannel2NudgeState,
    setPendingCompactionMarkerState,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    addMergedReasoningStrippedIds,
    addTrailingBlankDecisions,
    armThinkingBindingRecovery,
    clearThinkingBindingRecoveryIf,
    getMergedReasoningStrippedIds,
    getPersistedCompactionMarkerState,
    getPersistedTodoPermissionDenied,
    getPersistedTodoSyntheticAnchor,
    getThinkingBindingRecoveryTarget,
    getTrailingBlankDecisions,
    setPersistedCompactionMarkerState,
    setPersistedTodoPermissionDenied,
    setPersistedTodoSyntheticAnchor,
} from "../../features/magic-context/storage-meta-persisted";
import {
    markWhitespaceAssistantTagInert,
    updateTagStatus,
} from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import * as loggerModule from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { MARKER_SUMMARY_TEXT } from "./compaction-marker-manager";
import { registerActiveCompartmentRun } from "./compartment-runner";
import { clearToolPermissionDenied } from "./ctx-reduce-availability";
import type { Channel1State } from "./ctx-reduce-nudge";
import { estimateMessageTokens } from "./final-wire-token-estimate";
import { injectM0M1, type M0HardSignals } from "./inject-compartments";
import { snapshotTrailingBlankSourceDecisions } from "./strip-content";
import { stripStructuralNoise } from "./strip-structural-noise";
import {
    type MessageLike,
    type TagTarget,
    type ThinkingLikePart,
    tagMessages,
} from "./tag-messages";
import { buildSyntheticTodoPart, computeSyntheticCallId, isSyntheticTodoPart } from "./todo-view";
import {
    createToolDropTarget,
    extractToolCallObservation,
    type ToolCallIndex,
    ToolMutationBatch,
} from "./tool-drop-target";
import { applyFlushedStatuses } from "./transform-operations";
import {
    abortSessionFailClosed,
    checkM0MutationDriftAndSignal,
    clearPendingCompactionMarkerAfterSuccessfulDrain,
    evaluateEmergencyFailClosed,
    finalizeMessageRepresentation,
    reconcileMarkerRepresentation,
    runPostTransformPhase,
    runRustModePostprocess,
} from "./transform-postprocess-phase";

const SESSION_ID = "ses-postprocess-drift";
const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
let db: Database;

function createOpenCodeDbWithoutMessages(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    mkdirSync(join(dir, "opencode"), { recursive: true });
    const opencodeDb = new Database(join(dir, "opencode", "opencode.db"));
    opencodeDb.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    opencodeDb.exec(
        "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    opencodeDb.close();
}

afterEach(() => {
    if (db) db.close();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

describe("m[0] mutation drift watcher", () => {
    it("schedules next-pass materialization when m0_mutation_log gets a newer id", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const pendingMaterializationSessions = new Set<string>();
        const historyRefreshSessions = new Set<string>();

        queueM0Mutation(db, {
            sessionId: SESSION_ID,
            mutationType: "compartment_merge",
            queuedAt: 1,
        });

        const scheduled = checkM0MutationDriftAndSignal({
            db,
            sessionId: SESSION_ID,
            cachedM0MaxMutationId: 0,
            pendingMaterializationSessions,
            historyRefreshSessions,
        });

        expect(scheduled).toBe(true);
        expect(pendingMaterializationSessions.has(SESSION_ID)).toBe(true);
        expect(historyRefreshSessions.has(SESSION_ID)).toBe(true);
    });

    it("does not schedule when the cached monotonic mutation id is current", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const mutation = queueM0Mutation(db, {
            sessionId: SESSION_ID,
            mutationType: "compartment_merge",
        });
        const pendingMaterializationSessions = new Set<string>();

        const scheduled = checkM0MutationDriftAndSignal({
            db,
            sessionId: SESSION_ID,
            cachedM0MaxMutationId: mutation.id,
            pendingMaterializationSessions,
        });

        expect(scheduled).toBe(false);
        expect(pendingMaterializationSessions.has(SESSION_ID)).toBe(false);
    });
});

function makeToolMessage(id: string): MessageLike {
    return {
        info: { id, role: "assistant" },
        parts: [
            {
                type: "tool",
                tool: "bash",
                state: { output: "x".repeat(4000), status: "completed" },
            },
        ],
    } as unknown as MessageLike;
}

function makeDropTarget(message: MessageLike): TagTarget {
    return {
        message,
        setContent: () => false,
        drop: () => {
            const index = message.parts.findIndex(
                (part) => (part as { type?: string }).type === "tool",
            );
            if (index < 0) return "absent";
            message.parts.splice(index, 1);
            return "removed";
        },
        truncate: () => {
            const part = message.parts.find(
                (candidate) => (candidate as { type?: string }).type === "tool",
            ) as { state?: { output?: string } } | undefined;
            if (!part?.state) return "absent";
            // Skeleton-drop renders the one canonical placeholder (the real
            // target uses `[dropped §N§]`); this mock mirrors the word.
            part.state.output = "[dropped]";
            return "truncated";
        },
        canDrop: () => message.parts.some((part) => (part as { type?: string }).type === "tool"),
    };
}

type PostTransformArgs = Parameters<typeof runPostTransformPhase>[0];

function basePostTransformArgs(
    db: Database,
    sessionId: string,
    messages: MessageLike[],
    overrides: Partial<PostTransformArgs> = {},
): PostTransformArgs {
    return {
        sessionId,
        db,
        messages,
        tags: [],
        targets: new Map(),
        reasoningByMessage: new Map(),
        messageTagNumbers: new Map(),
        tagger: createTagger(),
        ctxReduceAvailability: { callable: true, frozen: true },
        // Default to todowrite available so existing tests keep their behavior;
        // the disabled-tool gate tests override this per case.
        todowriteAvailability: { callable: true, frozen: true },
        batch: null,
        contextUsage: { percentage: 20, inputTokens: 1000 },
        usableWindow: 128_000,
        schedulerDecision: "defer",
        schedulerDeferReason: "scheduler_defer",
        fullFeatureMode: true,
        canRunCompartments: false,
        awaitedCompartmentRun: false,
        phaseJustAwaitedPublication: false,
        compartmentInProgress: false,
        historyRefreshExplicitBeforePrepare: false,
        deferredHistoryWasPendingAtPassStart: false,
        compartmentInjectionRebuiltFromDb: false,
        rebuiltHistoryFromInitialPrepare: false,
        historyRebuiltThisPass: false,
        canConsumeDeferredLate: false,
        sessionMeta: getOrCreateSessionMeta(db, sessionId),
        currentTurnId: null,
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        deferredMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 999,
        protectedTags: 0,
        pendingCompartmentInjection: null,
        didMutateFromFlushedStatuses: false,
        watermark: 0,
        forceMaterializationPercentage: 85,
        hasRecentReduceCall: false,
        ...overrides,
    };
}

function cloneMessages(messages: MessageLike[]): MessageLike[] {
    return structuredClone(messages);
}

describe("tail hygiene last-writer guard", () => {
    it("logs a production structural mismatch after a post-walk mutation without throwing", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-tail-hygiene-last-writer";
        const messages = [
            {
                info: { id: "tail-user", role: "user" },
                parts: [{ type: "text", text: "baseline tail" }],
            },
        ] as unknown as MessageLike[];
        const channel1StateBySession = new Map<string, Channel1State>();
        const originalSet = channel1StateBySession.set;
        channel1StateBySession.set = function (key, state) {
            const result = originalSet.call(this, key, state);
            if (key === sessionId) {
                messages[0].parts.push({
                    type: "text",
                    text: "deliberate post-walk mutation",
                } as MessageLike["parts"][number]);
            }
            return result;
        };
        const originalNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        const sessionLog = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});

        try {
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, { channel1StateBySession }),
            );

            expect(
                sessionLog.mock.calls.some(
                    (call) =>
                        call[0] === sessionId &&
                        typeof call[1] === "string" &&
                        call[1].includes("ERROR [tail-hygiene-last-writer-mismatch]"),
                ),
            ).toBe(true);
        } finally {
            sessionLog.mockRestore();
            if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = originalNodeEnv;
        }
    });
});

describe("Channel-2 measured-collapse cycle reset", () => {
    it("CAS-rearms delivered at the baseline-refresh site when measured U falls below 25k", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-channel2-u-collapse";
        setChannel2NudgeState(db, sessionId, "delivered");
        const channel1StateBySession = new Map<string, Channel1State>([
            [
                sessionId,
                {
                    baselineU: 60_000,
                    baselineT: 100_000,
                    turnDeltaU: 0,
                    turnDeltaT: 0,
                    usableWindow: 128_000,
                    realUserTurnCount: 1,
                    baselineGeneration: 1,
                    computedAt: 1,
                    evaluable: true,
                    generationInvalidated: false,
                    baselineParts: [],
                    contentSignature: "prior",
                    reducedSinceRefresh: true,
                    oldestReclaimableToolTags: [],
                },
            ],
        ]);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [], {
                channel1StateBySession,
                didMutateFromFlushedStatuses: true,
            }),
        );

        expect(channel1StateBySession.get(sessionId)?.baselineU).toBe(0);
        expect(getChannel2NudgeState(db, sessionId)).toBe("");
    });
});

function buildToolCallIndex(messages: MessageLike[]): ToolCallIndex {
    const index: ToolCallIndex = new Map();
    for (const message of messages) {
        for (const part of message.parts) {
            const observation = extractToolCallObservation(part);
            if (!observation) continue;
            const entry = index.get(observation.callId) ?? {
                occurrences: [],
                hasResult: false,
            };
            entry.occurrences.push({ message, part, kind: observation.kind });
            if (observation.kind === "result") entry.hasResult = true;
            index.set(observation.callId, entry);
        }
    }
    return index;
}

function findMessage(messages: MessageLike[], id: string): MessageLike {
    const message = messages.find((candidate) => candidate.info.id === id);
    if (!message) throw new Error(`missing fixture message ${id}`);
    return message;
}

function thinkingParts(message: MessageLike): ThinkingLikePart[] {
    return message.parts.filter((part): part is ThinkingLikePart => {
        if (part === null || typeof part !== "object") return false;
        const type = (part as { type?: unknown }).type;
        return type === "thinking" || type === "reasoning";
    });
}

function makeMessageTarget(message: MessageLike): TagTarget {
    return {
        message,
        getContent: () => {
            const part = message.parts[0] as { text?: unknown } | undefined;
            return typeof part?.text === "string" ? part.text : null;
        },
        setContent: (content: string) => {
            const part = message.parts[0] as { text?: string } | undefined;
            if (part?.text === content) return false;
            message.parts[0] = { type: "text", text: content } as MessageLike["parts"][number];
            return true;
        },
    };
}

function addToolTarget(args: {
    targets: Map<number, TagTarget>;
    index: ToolCallIndex;
    batch: ToolMutationBatch;
    callId: string;
    tagNumber: number;
    thinking?: ThinkingLikePart[];
}): void {
    args.targets.set(
        args.tagNumber,
        createToolDropTarget(
            args.callId,
            args.thinking ?? [],
            args.index,
            args.batch,
            args.tagNumber,
        ),
    );
}

function padRecentToolSkeletonWindow(sessionId: string, afterTagNumber: number): void {
    for (let offset = 1; offset <= 20; offset += 1) {
        insertTag(
            db,
            sessionId,
            `pad-call-${afterTagNumber + offset}`,
            "tool",
            10,
            afterTagNumber + offset,
        );
    }
}

function serializeAnthropicWirePrefix(messages: MessageLike[]): string {
    return JSON.stringify(
        messages.map((message) => ({
            role: message.info.role,
            content: message.parts.filter((part) => {
                if (part === null || typeof part !== "object") return true;
                const candidate = part as { type?: unknown; text?: unknown };
                return candidate.type !== "text" || candidate.text !== "";
            }),
        })),
    );
}

function serializeAnthropicWireWithAdjacentAssistantMerge(messages: MessageLike[]): string {
    const merged: MessageLike[] = [];
    for (const message of messages) {
        const previous = merged.at(-1);
        if (previous?.info.role === "assistant" && message.info.role === "assistant") {
            previous.parts.push(...message.parts);
        } else {
            merged.push(structuredClone(message));
        }
    }
    return serializeAnthropicWirePrefix(merged);
}

function serializeAnthropicVisibleRoleGroups(messages: MessageLike[]): string {
    const merged: Array<{ role: string | undefined; parts: MessageLike["parts"] }> = [];
    for (const message of messages) {
        const parts = message.parts.filter((part) => {
            if (part === null || typeof part !== "object") return true;
            const candidate = part as { type?: unknown; text?: unknown };
            return candidate.type !== "text" || candidate.text !== "";
        });
        if (parts.length === 0) continue;
        const previous = merged.at(-1);
        if (previous?.role === message.info.role) previous.parts.push(...structuredClone(parts));
        else merged.push({ role: message.info.role, parts: structuredClone(parts) });
    }
    return JSON.stringify(merged);
}

describe("stripped placeholder replay across temporary marker windows", () => {
    for (const [missingPassDecision, replayPassDecision] of [
        ["execute", "defer"],
        ["defer", "execute"],
    ] as const) {
        it(`keeps frozen assistant bytes across ${missingPassDecision}→${replayPassDecision} passes`, async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = `ses-placeholder-marker-${missingPassDecision}`;
            const assistantId = "assistant-at-marker-seam";
            applyStrippedPlaceholderDelta(db, sessionId, { add: [assistantId] });

            // A marker-applying pass can temporarily omit an older assistant even
            // though adjacent retained user rows remain in the provider projection.
            const missingAssistantPass = [
                {
                    info: { id: "user-before", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "retained-before" }],
                },
                {
                    info: { id: "user-after", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "retained-after" }],
                },
            ] as unknown as MessageLike[];
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, missingAssistantPass, {
                    schedulerDecision: missingPassDecision,
                    resolvedProviderID: "anthropic",
                }),
            );
            const foldWire = serializeAnthropicVisibleRoleGroups(missingAssistantPass);
            expect(getStrippedPlaceholderIds(db, sessionId).has(assistantId)).toBe(true);

            const replayPass = [
                {
                    info: { id: "user-before", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "retained-before" }],
                },
                {
                    info: { id: assistantId, role: "assistant", sessionID: sessionId },
                    parts: [{ type: "text", text: "[dropped §70730§]" }],
                },
                {
                    info: { id: "user-after", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "retained-after" }],
                },
            ] as unknown as MessageLike[];
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, replayPass, {
                    schedulerDecision: replayPassDecision,
                    resolvedProviderID: "anthropic",
                }),
            );

            expect(replayPass[1]?.parts).toEqual([{ type: "text", text: "" }]);
            expect(serializeAnthropicVisibleRoleGroups(replayPass)).toBe(foldWire);
        });
    }

    it("retains frozen ids while compaction is off and replays them when it resumes", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-placeholder-compaction-off";
        const assistantId = "assistant-across-compaction-toggle";
        applyStrippedPlaceholderDelta(db, sessionId, { add: [assistantId] });
        const buildMessages = () =>
            [
                {
                    info: { id: assistantId, role: "assistant", sessionID: sessionId },
                    parts: [{ type: "text", text: "[dropped §70731§]" }],
                },
            ] as unknown as MessageLike[];

        const compactionOffMessages = buildMessages();
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, compactionOffMessages, {
                compactionOff: true,
                schedulerDecision: "execute",
                resolvedProviderID: "anthropic",
            }),
        );
        expect(compactionOffMessages[0]?.parts).toEqual([
            { type: "text", text: "[dropped §70731§]" },
        ]);
        expect(getStrippedPlaceholderIds(db, sessionId).has(assistantId)).toBe(true);

        const resumedMessages = buildMessages();
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, resumedMessages, {
                compactionOff: false,
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
            }),
        );
        expect(resumedMessages[0]?.parts).toEqual([{ type: "text", text: "" }]);
        expect(getStrippedPlaceholderIds(db, sessionId).has(assistantId)).toBe(true);
    });

    it("pre-freezes hidden assistant separators before a marker advance", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-placeholder-marker-hidden-separators";
        const user = (id: string, tag: number): MessageLike =>
            ({
                info: { id, role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: `[dropped §${tag}§]` }],
            }) as unknown as MessageLike;
        const assistant = (id: string, tag: number): MessageLike =>
            ({
                info: { id, role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: `[dropped §${tag}§]` }],
            }) as unknown as MessageLike;

        const foldMessages = [user("user-a", 74389), user("user-b", 74398), user("user-c", 74407)];
        const hiddenAssistants = [assistant("assistant-a", 74393), assistant("assistant-b", 74400)];
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, foldMessages, {
                schedulerDecision: "execute",
                schedulerDeferReason: null,
                resolvedProviderID: "anthropic",
                hiddenMessagesAtCompactionSeam: hiddenAssistants,
            }),
        );
        const foldWire = serializeAnthropicVisibleRoleGroups(foldMessages);
        expect(JSON.parse(foldWire)).toEqual([
            {
                role: "user",
                parts: [
                    { type: "text", text: "[dropped §74389§]" },
                    { type: "text", text: "[dropped §74398§]" },
                    { type: "text", text: "[dropped §74407§]" },
                ],
            },
        ]);
        expect(getStrippedPlaceholderIds(db, sessionId)).toEqual(
            new Set(["assistant-a", "assistant-b"]),
        );

        const replayMessages = [
            user("user-a", 74389),
            assistant("assistant-a", 74393),
            user("user-b", 74398),
            assistant("assistant-b", 74400),
            user("user-c", 74407),
        ];
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, replayMessages, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
            }),
        );

        expect(replayMessages[1]?.parts).toEqual([{ type: "text", text: "" }]);
        expect(replayMessages[3]?.parts).toEqual([{ type: "text", text: "" }]);
        expect(serializeAnthropicVisibleRoleGroups(replayMessages)).toBe(foldWire);
    });
});

describe("deferred compaction marker representation", () => {
    it("ignores a persisted message that carries a forged syntheticHead flag", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-marker-forged-head";
        const state = {
            boundaryMessageId: "boundary",
            summaryMessageId: "summary",
            compactionPartId: "compaction",
            summaryPartId: "summary-part",
            boundaryOrdinal: 10,
            targetEndMessageId: "boundary",
        };
        setPersistedCompactionMarkerState(db, sessionId, state);
        const messages = [
            {
                info: { role: "user", sessionID: sessionId, syntheticHead: true },
                parts: [{ type: "text", text: "m0", synthetic: true }],
            },
            {
                // A persisted row (it carries an id) claiming head membership
                // through metadata alone. It must stay in the retained tail,
                // AFTER the summary.
                info: {
                    id: "msg_persisted_forged",
                    role: "user",
                    sessionID: sessionId,
                    syntheticHead: true,
                },
                parts: [{ type: "text", text: "real turn", synthetic: true }],
            },
        ] as unknown as MessageLike[];
        const options = {
            db,
            sessionId,
            tagger: createTagger(),
            ctxReduceAvailability: { callable: true, frozen: true },
        };

        reconcileMarkerRepresentation(messages, state, options);
        expect(messages.map((message) => message.info.id)).toEqual([
            undefined,
            "summary",
            "msg_persisted_forged",
        ]);
    });

    it("uses only marked m[0]/m[1] slots as the synthetic head", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-marker-synthetic-tail";
        const state = {
            boundaryMessageId: "boundary",
            summaryMessageId: "summary",
            compactionPartId: "compaction",
            summaryPartId: "summary-part",
            boundaryOrdinal: 10,
            targetEndMessageId: "boundary",
        };
        setPersistedCompactionMarkerState(db, sessionId, state);
        const messages = [
            {
                info: { role: "user", sessionID: sessionId, syntheticHead: true },
                parts: [{ type: "text", text: "m0", synthetic: true }],
            },
            {
                info: { role: "user", sessionID: sessionId, syntheticHead: true },
                parts: [{ type: "text", text: "m1", synthetic: true }],
            },
            {
                info: { id: "channel2-nudge", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "compact now", synthetic: true }],
            },
            {
                info: { id: "tail-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "new turn" }],
            },
        ] as unknown as MessageLike[];
        const options = {
            db,
            sessionId,
            tagger: createTagger(),
            ctxReduceAvailability: { callable: true, frozen: true },
        };

        reconcileMarkerRepresentation(messages, state, options);
        expect(messages.map((message) => message.info.id)).toEqual([
            undefined,
            undefined,
            "summary",
            "channel2-nudge",
            "tail-user",
        ]);
        const firstWire = serializeAnthropicWireWithAdjacentAssistantMerge(messages);

        const replay = structuredClone(messages);
        reconcileMarkerRepresentation(replay, state, options);
        expect(serializeAnthropicWireWithAdjacentAssistantMerge(replay)).toBe(firstWire);
        expect(replay).toEqual(messages);
    });

    it("rebuilds byte-identical summary rows in TypeScript and Rust lanes", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-marker-rust-parity";
        const state = {
            boundaryMessageId: "boundary",
            summaryMessageId: "summary",
            compactionPartId: "compaction",
            summaryPartId: "summary-part",
            boundaryOrdinal: 10,
            targetEndMessageId: "boundary",
        };
        setPersistedCompactionMarkerState(db, sessionId, state);
        const source = [
            {
                info: { role: "user", sessionID: sessionId, syntheticHead: true },
                parts: [{ type: "text", text: "m0", synthetic: true }],
            },
            {
                info: { role: "user", sessionID: sessionId, syntheticHead: true },
                parts: [{ type: "text", text: "m1", synthetic: true }],
            },
            {
                info: { id: "tail", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "new turn" }],
            },
        ] as unknown as MessageLike[];
        const ctxReduceAvailability = { callable: true, frozen: true };
        const tsMessages = structuredClone(source);
        reconcileMarkerRepresentation(tsMessages, state, {
            db,
            sessionId,
            tagger: createTagger(),
            ctxReduceAvailability,
        });

        const rustMessages = structuredClone(source);
        runRustModePostprocess({
            db,
            sessionId,
            messages: rustMessages,
            fullFeatureMode: true,
            tagger: createTagger(),
            ctxReduceAvailability,
        });

        const tsIndex = tsMessages.findIndex((message) => message.info.summary === true);
        const rustIndex = rustMessages.findIndex((message) => message.info.summary === true);
        expect(tsIndex).toBe(2);
        expect(rustIndex).toBe(tsIndex);
        expect(JSON.stringify(rustMessages[rustIndex])).toBe(JSON.stringify(tsMessages[tsIndex]));
        expect(rustMessages).toEqual(tsMessages);
    });

    it("applies a Rust materialized boundary on its serving pass and replays identical bytes", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-rust-marker-reverse-edge";
        createOpenCodeDbWithoutMessages("postprocess-rust-marker-");
        const opencodeDb = new Database(
            join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db"),
        );
        opencodeDb
            .prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
                "msg-boundary",
                sessionId,
                1_000,
                1_000,
                JSON.stringify({ role: "user", time: { created: 1_000 } }),
            );
        opencodeDb.close();
        const source = [
            {
                info: { role: "user", sessionID: sessionId, syntheticHead: true },
                parts: [
                    {
                        type: "text",
                        text: "<session-history>stable</session-history>",
                        synthetic: true,
                    },
                ],
            },
            {
                info: { id: "tail", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "new turn" }],
            },
        ] as unknown as MessageLike[];
        const first = structuredClone(source);
        const applied = runRustModePostprocess({
            db,
            sessionId,
            messages: first,
            sessionDirectory: process.env.XDG_DATA_HOME,
            materializedBoundary: {
                rowVersion: 7,
                ordinal: 10,
                endMessageId: "msg-boundary",
            },
            fullFeatureMode: true,
            tagger: createTagger(),
            ctxReduceAvailability: { callable: false, frozen: true },
        });

        expect(applied.markerAt).toBe("msg-boundary");
        expect(getPendingCompactionMarkerState(db, sessionId)).toBeNull();
        const marker = getPersistedCompactionMarkerState(db, sessionId);
        expect(marker?.targetEndMessageId).toBe("msg-boundary");
        expect(first.find((message) => message.info.summary === true)?.info).toMatchObject({
            summary: true,
            finish: "stop",
        });
        const firstBytes = JSON.stringify(first);

        const replay = structuredClone(source);
        runRustModePostprocess({
            db,
            sessionId,
            messages: replay,
            fullFeatureMode: true,
            tagger: createTagger(),
            ctxReduceAvailability: { callable: false, frozen: true },
        });
        expect(JSON.stringify(replay)).toBe(firstBytes);
    });

    it("keeps a provisional marker untagged and freezes the callable tag choice", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-marker-provisional-availability";
        const state = {
            boundaryMessageId: "boundary",
            summaryMessageId: "summary",
            compactionPartId: "compaction",
            summaryPartId: "summary-part",
            boundaryOrdinal: 10,
            targetEndMessageId: "boundary",
        };
        setPersistedCompactionMarkerState(db, sessionId, state);
        const options = {
            db,
            sessionId,
            tagger: createTagger(),
            ctxReduceAvailability: { callable: true, frozen: false },
        };
        const provisional = [
            {
                info: { role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "turn" }],
            },
        ] as unknown as MessageLike[];
        reconcileMarkerRepresentation(provisional, state, options);
        expect(provisional[0]?.parts[0]).toEqual({ type: "text", text: MARKER_SUMMARY_TEXT });

        const frozen = [
            {
                info: { role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "turn" }],
            },
        ] as unknown as MessageLike[];
        reconcileMarkerRepresentation(frozen, state, {
            ...options,
            ctxReduceAvailability: { callable: true, frozen: true },
        });
        const taggedText = (frozen[0]?.parts[0] as { text?: string }).text;
        expect(taggedText).toMatch(/^§\d+§ /);
        const stable = structuredClone(frozen);
        reconcileMarkerRepresentation(stable, state, {
            ...options,
            ctxReduceAvailability: { callable: true, frozen: true },
        });
        expect(stable).toEqual(frozen);
    });

    it("keeps todo synthesis at the head when the only assistant is a summary", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-marker-todo-head";
        const state = {
            boundaryMessageId: "boundary",
            summaryMessageId: "summary",
            compactionPartId: "compaction",
            summaryPartId: "summary-part",
            boundaryOrdinal: 10,
            targetEndMessageId: "boundary",
        };
        setPersistedCompactionMarkerState(db, sessionId, state);
        updateSessionMeta(db, sessionId, {
            lastTodoState:
                '[{"content":"finish marker work","status":"pending","priority":"high"}]',
        });
        const makeMessages = (): MessageLike[] =>
            [
                {
                    info: { role: "user", sessionID: sessionId, syntheticHead: true },
                    parts: [{ type: "text", text: "m0", synthetic: true }],
                },
                {
                    info: { role: "user", sessionID: sessionId, syntheticHead: true },
                    parts: [{ type: "text", text: "m1", synthetic: true }],
                },
                {
                    info: {
                        id: "summary",
                        role: "assistant",
                        sessionID: sessionId,
                        summary: true,
                        finish: "stop",
                    },
                    parts: [{ type: "text", text: MARKER_SUMMARY_TEXT }],
                },
                {
                    info: { id: "new-user", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "continue" }],
                },
            ] as unknown as MessageLike[];
        const firstMessages = makeMessages();
        const firstTagger = createTagger();
        const firstTagged = tagMessages(sessionId, firstMessages, firstTagger, db);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, firstMessages, {
                schedulerDecision: "execute",
                tagger: firstTagger,
                targets: firstTagged.targets,
                reasoningByMessage: firstTagged.reasoningByMessage,
                messageTagNumbers: firstTagged.messageTagNumbers,
                batch: firstTagged.batch,
            }),
        );
        const firstTodoIndex = firstMessages.findIndex((message) =>
            message.parts.some((part) => isSyntheticTodoPart(part)),
        );
        expect(firstTodoIndex).toBe(2);
        const firstWire = serializeAnthropicWireWithAdjacentAssistantMerge(firstMessages);

        const secondMessages = makeMessages();
        const secondTagger = createTagger();
        secondTagger.initFromDb(sessionId, db);
        const secondTagged = tagMessages(sessionId, secondMessages, secondTagger, db);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, secondMessages, {
                tagger: secondTagger,
                targets: secondTagged.targets,
                reasoningByMessage: secondTagged.reasoningByMessage,
                messageTagNumbers: secondTagged.messageTagNumbers,
                batch: secondTagged.batch,
            }),
        );
        expect(
            secondMessages.findIndex((message) =>
                message.parts.some((part) => isSyntheticTodoPart(part)),
            ),
        ).toBe(2);
        expect(serializeAnthropicWireWithAdjacentAssistantMerge(secondMessages)).toBe(firstWire);
    });

    it("keeps the marker-consuming fold byte-identical with the rebuilt defer wire", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-marker-wire-stability";
        const dataHome = mkdtempSync(join(tmpdir(), "postprocess-marker-wire-"));
        tempDirs.push(dataHome);
        process.env.XDG_DATA_HOME = dataHome;
        mkdirSync(join(dataHome, "opencode"), { recursive: true });
        const opencodeDb = new Database(join(dataHome, "opencode", "opencode.db"));
        opencodeDb.exec(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
        );
        opencodeDb.exec(
            "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
        );
        const insertMessage = opencodeDb.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        insertMessage.run(
            "msg-boundary",
            sessionId,
            1_000,
            1_000,
            JSON.stringify({ role: "user" }),
        );
        insertMessage.run(
            "msg-tail-assistant",
            sessionId,
            2_000,
            2_000,
            JSON.stringify({ role: "assistant" }),
        );
        opencodeDb.close();

        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 10,
                startMessageId: "msg-boundary",
                endMessageId: "msg-boundary",
                title: "wire stability",
                content: "test content",
            },
        ]);
        setPendingCompactionMarkerState(db, sessionId, {
            ordinal: 10,
            endMessageId: "msg-boundary",
            publishedAt: 1,
        });

        const tagger = createTagger();
        const foldMessages = [
            {
                info: {
                    id: "msg-tail-user",
                    role: "user",
                    sessionID: sessionId,
                },
                parts: [{ type: "text", text: "retained user turn" }],
            },
            {
                info: {
                    id: "msg-tail-assistant",
                    role: "assistant",
                    sessionID: sessionId,
                    finish: "stop",
                },
                parts: [
                    {
                        type: "tool_use",
                        id: "toolu-tail",
                        name: "read",
                        input: { path: "README.md" },
                    },
                ],
            },
        ] as unknown as MessageLike[];
        const taggedFold = tagMessages(sessionId, foldMessages, tagger, db);
        const deferredHistoryRefreshSessions = new Set<string>([sessionId]);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, foldMessages, {
                tagger,
                targets: taggedFold.targets,
                reasoningByMessage: taggedFold.reasoningByMessage,
                messageTagNumbers: taggedFold.messageTagNumbers,
                batch: taggedFold.batch,
                deferredHistoryWasPendingAtPassStart: true,
                historyRebuiltThisPass: true,
                canConsumeDeferredLate: true,
                deferredHistoryRefreshSessions,
                pendingCompartmentInjection: {
                    block: "",
                    compartmentEndMessage: 10,
                    compartmentEndMessageId: "msg-boundary",
                    compartmentCount: 1,
                    skippedVisibleMessages: 0,
                    factCount: 0,
                    memoryCount: 0,
                    rebuiltFromDb: true,
                },
                m0M1: {
                    projectDirectory: dataHome,
                    injectDocs: false,
                },
            }),
        );

        const marker = getPersistedCompactionMarkerState(db, sessionId);
        expect(marker?.summaryMessageId).toBeString();
        expect(foldMessages.map((message) => message.info.id)).toEqual([
            undefined,
            undefined,
            marker?.summaryMessageId,
            "msg-tail-user",
            "msg-tail-assistant",
        ]);
        expect(foldMessages[2]?.parts).toEqual([
            expect.objectContaining({
                type: "text",
                text: expect.stringContaining(MARKER_SUMMARY_TEXT),
            }),
        ]);

        const foldWire = serializeAnthropicWireWithAdjacentAssistantMerge(foldMessages);
        const rebuiltMessages = [
            ...cloneMessages(foldMessages.slice(0, 2)),
            {
                info: {
                    id: marker?.summaryMessageId,
                    role: "assistant",
                    sessionID: sessionId,
                    summary: true,
                    finish: "stop",
                },
                parts: [{ type: "text", text: MARKER_SUMMARY_TEXT }],
            },
            {
                info: {
                    id: "msg-tail-user",
                    role: "user",
                    sessionID: sessionId,
                },
                parts: [{ type: "text", text: "retained user turn" }],
            },
            {
                info: {
                    id: "msg-tail-assistant",
                    role: "assistant",
                    sessionID: sessionId,
                    finish: "stop",
                },
                parts: [
                    {
                        type: "tool_use",
                        id: "toolu-tail",
                        name: "read",
                        input: { path: "README.md" },
                    },
                ],
            },
        ] as unknown as MessageLike[];
        tagger.initFromDb(sessionId, db);
        // The next pass rebuilds its input from the database projection (raw
        // summary row included), tags it, and runs the SAME postprocess order
        // the production defer pass runs, so any mutator that fires after
        // reconciliation is exercised on both sides of the comparison.
        const deferInput = rebuiltMessages.slice(2);
        const taggedDefer = tagMessages(sessionId, deferInput, tagger, db);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, deferInput, {
                tagger,
                targets: taggedDefer.targets,
                reasoningByMessage: taggedDefer.reasoningByMessage,
                messageTagNumbers: taggedDefer.messageTagNumbers,
                batch: taggedDefer.batch,
                m0M1: {
                    projectDirectory: dataHome,
                    injectDocs: false,
                },
            }),
        );
        const deferWire = serializeAnthropicWireWithAdjacentAssistantMerge(deferInput);

        expect(deferWire).toBe(foldWire);
        expect(JSON.parse(foldWire)).toMatchObject([
            {},
            {},
            {
                role: "assistant",
                content: [{ type: "text", text: expect.stringContaining(MARKER_SUMMARY_TEXT) }],
            },
            { role: "user", content: [{ type: "text", text: expect.any(String) }] },
            {
                role: "assistant",
                content: [{ type: "tool_use", id: "toolu-tail" }],
            },
        ]);
    });

    it("reconciles duplicate summaries at the synthetic-prefix boundary and is idempotent", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-marker-reconcile-idempotent";
        setPersistedCompactionMarkerState(db, sessionId, {
            boundaryMessageId: "boundary",
            summaryMessageId: "current-summary",
            compactionPartId: "current-compaction",
            summaryPartId: "current-summary-part",
            boundaryOrdinal: 10,
            targetEndMessageId: "boundary",
        });
        const summary = (id: string): MessageLike =>
            ({
                info: {
                    id,
                    role: "assistant",
                    sessionID: sessionId,
                    summary: true,
                    finish: "stop",
                },
                parts: [{ type: "text", text: MARKER_SUMMARY_TEXT }],
            }) as MessageLike;
        const messages = [
            {
                info: { role: "user", sessionID: sessionId, syntheticHead: true },
                parts: [{ type: "text", text: "m0", synthetic: true }],
            },
            {
                info: { role: "user", sessionID: sessionId, syntheticHead: true },
                parts: [{ type: "text", text: "m1", synthetic: true }],
            },
            summary("stale-summary"),
            summary("current-summary"),
            summary("current-summary"),
            {
                info: { id: "tail-assistant", role: "assistant", sessionID: sessionId },
                parts: [
                    {
                        type: "tool_use",
                        id: "toolu-tail",
                        name: "read",
                        input: { path: "README.md" },
                    },
                ],
            },
        ] as MessageLike[];
        const tagger = createTagger();
        tagMessages(sessionId, messages, tagger, db);

        await runPostTransformPhase(basePostTransformArgs(db, sessionId, messages, { tagger }));

        expect(messages.map((message) => message.info.id)).toEqual([
            undefined,
            undefined,
            "current-summary",
            "tail-assistant",
        ]);
        expect(
            JSON.parse(serializeAnthropicWireWithAdjacentAssistantMerge(messages)),
        ).toMatchObject([
            {},
            {},
            {
                role: "assistant",
                content: [
                    { type: "text", text: expect.stringContaining(MARKER_SUMMARY_TEXT) },
                    { type: "tool_use", id: "toolu-tail" },
                ],
            },
        ]);
        expect(
            getTagsBySession(db, sessionId).find((tag) => tag.messageId === "stale-summary:p0")
                ?.status,
        ).toBe("dropped");

        const onceReconciled = structuredClone(messages);
        await runPostTransformPhase(basePostTransformArgs(db, sessionId, messages, { tagger }));
        expect(messages).toEqual(onceReconciled);
    });

    it("leaves a marker-free session byte-identical across repeated passes", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-without-marker";
        const messages = [
            {
                info: { id: "real-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "unchanged" }],
            },
        ] as MessageLike[];
        const original = structuredClone(messages);

        await runPostTransformPhase(basePostTransformArgs(db, sessionId, messages));
        await runPostTransformPhase(basePostTransformArgs(db, sessionId, messages));

        expect(messages).toEqual(original);
    });
});

describe("deferred compaction marker advance representation", () => {
    it("keeps the advance drain byte-identical with the next pass after removing the old marker", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-marker-advance-wire-stability";
        const dataHome = mkdtempSync(join(tmpdir(), "postprocess-marker-advance-wire-"));
        tempDirs.push(dataHome);
        process.env.XDG_DATA_HOME = dataHome;
        mkdirSync(join(dataHome, "opencode"), { recursive: true });
        const opencodeDb = new Database(join(dataHome, "opencode", "opencode.db"));
        opencodeDb.exec(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
        );
        opencodeDb.exec(
            "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
        );
        const insertMessage = opencodeDb.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        insertMessage.run(
            "old-boundary",
            sessionId,
            1_000,
            1_000,
            JSON.stringify({ role: "user" }),
        );
        insertMessage.run(
            "new-boundary",
            sessionId,
            2_000,
            2_000,
            JSON.stringify({ role: "user" }),
        );
        insertMessage.run(
            "new-end",
            sessionId,
            3_000,
            3_000,
            JSON.stringify({ role: "assistant", finish: "stop" }),
        );
        insertMessage.run(
            "old-summary",
            sessionId,
            1_001,
            1_001,
            JSON.stringify({ role: "assistant", summary: true, finish: "stop" }),
        );
        opencodeDb
            .prepare(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(
                "old-compaction",
                "old-boundary",
                sessionId,
                1_000,
                1_000,
                JSON.stringify({ type: "compaction", auto: true }),
            );
        opencodeDb
            .prepare(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(
                "old-summary-part",
                "old-summary",
                sessionId,
                1_001,
                1_001,
                JSON.stringify({ type: "text", text: MARKER_SUMMARY_TEXT }),
            );
        opencodeDb.close();

        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 20,
                startMessageId: "old-boundary",
                endMessageId: "new-end",
                title: "marker advance",
                content: "test content",
            },
        ]);
        setPersistedCompactionMarkerState(db, sessionId, {
            boundaryMessageId: "old-boundary",
            summaryMessageId: "old-summary",
            compactionPartId: "old-compaction",
            summaryPartId: "old-summary-part",
            boundaryOrdinal: 10,
            targetEndMessageId: "old-end",
        });
        setPendingCompactionMarkerState(db, sessionId, {
            ordinal: 20,
            endMessageId: "new-end",
            publishedAt: 2,
        });

        const tagger = createTagger();
        const drainMessages = [
            {
                info: { role: "user", sessionID: sessionId, syntheticHead: true },
                parts: [
                    {
                        type: "text",
                        text: "<session-history>\\n\\n</session-history>",
                        synthetic: true,
                    },
                ],
            },
            {
                info: {
                    id: "old-summary",
                    role: "assistant",
                    sessionID: sessionId,
                    summary: true,
                    finish: "stop",
                },
                parts: [{ type: "text", text: MARKER_SUMMARY_TEXT }],
            },
            {
                info: { id: "retained-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "retained user content" }],
            },
            {
                info: { id: "new-end", role: "assistant", sessionID: sessionId, finish: "stop" },
                parts: [{ type: "text", text: "tail content" }],
            },
        ] as unknown as MessageLike[];
        const loserMessages = cloneMessages(drainMessages);
        const taggedDrain = tagMessages(sessionId, drainMessages, tagger, db);
        const loserTagger = createTagger();
        loserTagger.initFromDb(sessionId, db);
        const taggedLoser = tagMessages(sessionId, loserMessages, loserTagger, db);
        const deferredHistoryRefreshSessions = new Set<string>([sessionId]);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, drainMessages, {
                fullFeatureMode: false,
                tagger,
                targets: taggedDrain.targets,
                reasoningByMessage: taggedDrain.reasoningByMessage,
                messageTagNumbers: taggedDrain.messageTagNumbers,
                batch: taggedDrain.batch,
                deferredHistoryWasPendingAtPassStart: true,
                historyRebuiltThisPass: true,
                canConsumeDeferredLate: true,
                deferredHistoryRefreshSessions,
                pendingCompartmentInjection: {
                    block: "",
                    compartmentEndMessage: 20,
                    compartmentEndMessageId: "new-end",
                    compartmentCount: 1,
                    skippedVisibleMessages: 0,
                    factCount: 0,
                    memoryCount: 0,
                    rebuiltFromDb: true,
                },
            }),
        );

        const marker = getPersistedCompactionMarkerState(db, sessionId);
        expect(marker?.summaryMessageId).toBeString();
        expect(drainMessages.some((message) => message.info.id === "old-summary")).toBe(false);

        const rebuiltMessages = [
            {
                info: { role: "user", sessionID: sessionId, syntheticHead: true },
                parts: [
                    {
                        type: "text",
                        text: "<session-history>\\n\\n</session-history>",
                        synthetic: true,
                    },
                ],
            },
            {
                info: {
                    id: marker?.summaryMessageId,
                    role: "assistant",
                    sessionID: sessionId,
                    summary: true,
                    finish: "stop",
                },
                parts: [{ type: "text", text: MARKER_SUMMARY_TEXT }],
            },
            {
                info: { id: "retained-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "retained user content" }],
            },
            {
                info: { id: "new-end", role: "assistant", sessionID: sessionId, finish: "stop" },
                parts: [{ type: "text", text: "tail content" }],
            },
        ] as unknown as MessageLike[];
        tagger.initFromDb(sessionId, db);
        tagMessages(sessionId, rebuiltMessages, tagger, db);
        const expectedWire = serializeAnthropicWireWithAdjacentAssistantMerge(rebuiltMessages);

        expect(serializeAnthropicWireWithAdjacentAssistantMerge(drainMessages)).toBe(expectedWire);
        expect(
            getTagsBySession(db, sessionId).find((tag) => tag.messageId === "old-summary:p0")
                ?.status,
        ).toBe("dropped");

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, loserMessages, {
                fullFeatureMode: false,
                tagger: loserTagger,
                targets: taggedLoser.targets,
                reasoningByMessage: taggedLoser.reasoningByMessage,
                messageTagNumbers: taggedLoser.messageTagNumbers,
                batch: taggedLoser.batch,
                deferredHistoryWasPendingAtPassStart: true,
                historyRebuiltThisPass: true,
                canConsumeDeferredLate: true,
                deferredHistoryRefreshSessions: new Set([sessionId]),
                pendingCompartmentInjection: {
                    block: "",
                    compartmentEndMessage: 20,
                    compartmentEndMessageId: "new-end",
                    compartmentCount: 1,
                    skippedVisibleMessages: 0,
                    factCount: 0,
                    memoryCount: 0,
                    rebuiltFromDb: true,
                },
            }),
        );
        expect(serializeAnthropicWireWithAdjacentAssistantMerge(loserMessages)).toBe(expectedWire);

        const onceReconciled = structuredClone(loserMessages);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, loserMessages, {
                fullFeatureMode: false,
                tagger: loserTagger,
            }),
        );
        expect(loserMessages).toEqual(onceReconciled);
    });
});

describe("deferred compaction marker CAS drain", () => {
    it("preserves the deferred-history signal when a newer pending blob exists", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-marker-cas-newer";
        const expected = { ordinal: 10, endMessageId: "msg-old", publishedAt: 1 };
        const newer = { ordinal: 11, endMessageId: "msg-new", publishedAt: 2 };
        setPendingCompactionMarkerState(db, sessionId, newer);
        const deferredHistoryRefreshSessions = new Set<string>();

        const outcome = clearPendingCompactionMarkerAfterSuccessfulDrain({
            db,
            sessionId,
            pending: expected,
            deferredHistoryRefreshSessions,
        });

        expect(outcome).toBe("cas-lost-newer-pending");
        expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(true);
    });

    it("does not re-add the signal when the pending blob was already cleared", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-marker-cas-cleared";
        const expected = { ordinal: 10, endMessageId: "msg-old", publishedAt: 1 };
        const deferredHistoryRefreshSessions = new Set<string>();

        const outcome = clearPendingCompactionMarkerAfterSuccessfulDrain({
            db,
            sessionId,
            pending: expected,
            deferredHistoryRefreshSessions,
        });

        expect(outcome).toBe("cas-lost-already-cleared");
        expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(false);
    });

    it("preserves a pending marker newer than the consumed compartment boundary", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-marker-newer-than-consumed";
        const newer = { ordinal: 12, endMessageId: "msg-12", publishedAt: 2 };
        setPendingCompactionMarkerState(db, sessionId, newer);
        const deferredHistoryRefreshSessions = new Set<string>([sessionId]);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [], {
                deferredHistoryWasPendingAtPassStart: true,
                historyRebuiltThisPass: true,
                canConsumeDeferredLate: true,
                deferredHistoryRefreshSessions,
                pendingCompartmentInjection: {
                    block: "",
                    compartmentEndMessage: 10,
                    compartmentEndMessageId: "msg-10",
                    compartmentCount: 1,
                    skippedVisibleMessages: 0,
                    factCount: 0,
                    memoryCount: 0,
                    rebuiltFromDb: true,
                },
            }),
        );

        expect(getPendingCompactionMarkerState(db, sessionId)).toEqual(newer);
        expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(true);
    });

    it("drains a pending marker covered by the consumed compartment boundary", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-marker-covered-by-consumed";
        createOpenCodeDbWithoutMessages("postprocess-covered-marker-");
        const covered = { ordinal: 10, endMessageId: "msg-10", publishedAt: 1 };
        setPendingCompactionMarkerState(db, sessionId, covered);
        const deferredHistoryRefreshSessions = new Set<string>([sessionId]);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [], {
                deferredHistoryWasPendingAtPassStart: true,
                historyRebuiltThisPass: true,
                canConsumeDeferredLate: true,
                deferredHistoryRefreshSessions,
                pendingCompartmentInjection: {
                    block: "",
                    compartmentEndMessage: 10,
                    compartmentEndMessageId: "msg-10",
                    compartmentCount: 1,
                    skippedVisibleMessages: 0,
                    factCount: 0,
                    memoryCount: 0,
                    rebuiltFromDb: true,
                },
            }),
        );

        expect(getPendingCompactionMarkerState(db, sessionId)).toBeNull();
        expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(false);
    });
});

describe("emergency fail-closed decision", () => {
    it("aborts provider-proven overflow in the emergency band when no fold landed", () => {
        expect(
            evaluateEmergencyFailClosed({
                usagePercentage: 95,
                emergencyRecoveryArmed: true,
                emergencyRecoveryOrigin: "provider_overflow",
                foldMaterializedThisPass: false,
            }),
        ).toEqual({ shouldAbort: true, reason: "provider-overflow-abort" });
    });

    it("allows provider-proven recovery when a historian fold materialized this pass", () => {
        expect(
            evaluateEmergencyFailClosed({
                usagePercentage: 108,
                emergencyRecoveryArmed: true,
                emergencyRecoveryOrigin: "provider_overflow",
                foldMaterializedThisPass: true,
            }),
        ).toEqual({ shouldAbort: false, reason: "proceed" });
    });

    it("never aborts proactive model-shrink recovery", () => {
        expect(
            evaluateEmergencyFailClosed({
                usagePercentage: 112,
                emergencyRecoveryArmed: true,
                emergencyRecoveryOrigin: "proactive_model_shrink",
                foldMaterializedThisPass: false,
            }),
        ).toEqual({ shouldAbort: false, reason: "proceed" });
    });

    it("does not abort below the emergency band", () => {
        expect(
            evaluateEmergencyFailClosed({
                usagePercentage: 94.9,
                emergencyRecoveryArmed: true,
                emergencyRecoveryOrigin: "provider_overflow",
                foldMaterializedThisPass: false,
            }),
        ).toEqual({ shouldAbort: false, reason: "below-emergency-band" });
    });

    it("disarms an armed latch when a trusted final wire is safely below the proven limit", () => {
        expect(
            evaluateEmergencyFailClosed({
                usagePercentage: 95,
                emergencyRecoveryArmed: true,
                emergencyRecoveryOrigin: "provider_overflow",
                foldMaterializedThisPass: false,
                finalWireEstimate: { tokens: 14_000, trusted: true },
                providerProvenLimitTokens: 100_000,
            }),
        ).toEqual({
            shouldAbort: false,
            reason: "trusted-final-wire-disarm",
            disarm: { finalWireTokens: 14_000, provenLimitTokens: 100_000 },
        });
    });

    it("does not disarm from a catalog-only limit", () => {
        expect(
            evaluateEmergencyFailClosed({
                usagePercentage: 95,
                emergencyRecoveryArmed: true,
                emergencyRecoveryOrigin: "provider_overflow",
                foldMaterializedThisPass: false,
                finalWireEstimate: { tokens: 14_000, trusted: true },
            }),
        ).toEqual({ shouldAbort: true, reason: "provider-overflow-abort" });
    });

    it("keeps provider-overflow blocking when the final-wire estimate is untrusted", () => {
        expect(
            evaluateEmergencyFailClosed({
                usagePercentage: 95,
                emergencyRecoveryArmed: true,
                emergencyRecoveryOrigin: "provider_overflow",
                foldMaterializedThisPass: false,
                finalWireEstimate: { tokens: 14_000, trusted: false },
                providerProvenLimitTokens: 100_000,
            }),
        ).toEqual({ shouldAbort: true, reason: "provider-overflow-abort" });
    });
});

describe("confirmed emergency abort", () => {
    it("rejects an SDK error response instead of accepting a failed abort", async () => {
        await expect(
            abortSessionFailClosed(
                {
                    session: {
                        abort: async () => ({ error: { status: 500 } }),
                    },
                },
                "ses-abort-error",
            ),
        ).rejects.toThrow("was not confirmed");
    });

    it("rejects data false instead of returning a sendable prompt", async () => {
        await expect(
            abortSessionFailClosed(
                {
                    session: {
                        abort: async () => ({ data: false }),
                    },
                },
                "ses-abort-false",
            ),
        ).rejects.toThrow("was not confirmed");
    });
});

describe("postprocess emergency drop accounting", () => {
    it("plans emergency floor from tags that remain active after pending ops", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-postprocess-floor";
        const messages = [1, 2, 3, 4].map((tag) => makeToolMessage(`tool-${tag}`));
        const targets = new Map<number, TagTarget>();

        for (let tag = 1; tag <= 4; tag++) {
            insertTag(db, sessionId, `tool-${tag}`, "tool", 4000, tag, 0, "bash");
            targets.set(tag, makeDropTarget(messages[tag - 1]!));
        }
        queuePendingOp(db, sessionId, 1, "drop", 1);
        queuePendingOp(db, sessionId, 2, "drop", 2);

        // This is the stale pre-pending snapshot the transform caller has at pass
        // start. The postprocess phase must refresh it after applyPendingOperations.
        const staleActiveTags = getActiveTagsBySession(db, sessionId);

        await runPostTransformPhase({
            sessionId,
            db,
            messages,
            tags: staleActiveTags,
            targets,
            reasoningByMessage: new Map(),
            messageTagNumbers: new Map(),
            batch: { finalize: () => {} },
            contextUsage: { percentage: 90, inputTokens: 7000 },
            schedulerDecision: "execute",
            ctxReduceAvailability: { callable: true, frozen: true },
            todowriteAvailability: { callable: true, frozen: true },
            fullFeatureMode: true,
            canRunCompartments: false,
            awaitedCompartmentRun: false,
            phaseJustAwaitedPublication: false,
            compartmentInProgress: false,
            historyRefreshExplicitBeforePrepare: false,
            deferredHistoryWasPendingAtPassStart: false,
            compartmentInjectionRebuiltFromDb: false,
            rebuiltHistoryFromInitialPrepare: false,
            historyRebuiltThisPass: false,
            canConsumeDeferredLate: false,
            sessionMeta: getOrCreateSessionMeta(db, sessionId),
            currentTurnId: "turn-floor",
            pendingMaterializationSessions: new Set(),
            deferredHistoryRefreshSessions: new Set(),
            deferredMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            clearReasoningAge: 999,
            protectedTags: 0,
            emergencyCeilingTokens: 6000,
            pendingCompartmentInjection: null,
            didMutateFromFlushedStatuses: false,
            watermark: 0,
            forceMaterializationPercentage: 85,
            hasRecentReduceCall: false,
        });

        const statuses = getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]);
        expect(statuses).toEqual([
            [1, "dropped"],
            [2, "dropped"],
            [3, "active"],
            [4, "active"],
        ]);
        const finalMessageTokens = messages.reduce((total, message) => {
            const estimate = estimateMessageTokens(message);
            return total + estimate.conversation + estimate.toolCall;
        }, 0);
        expect(finalMessageTokens).toBeGreaterThan(0);
    });

    it("reports estimated tokens reclaimed by successful emergency tool drops", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-postprocess-reclaim";
        const messages = [1, 2, 3, 4].map((tag) => makeToolMessage(`tool-${tag}`));
        const targets = new Map<number, TagTarget>();
        for (let tag = 1; tag <= 4; tag++) {
            insertTag(db, sessionId, `tool-${tag}`, "tool", 8000, tag, 0, "bash");
            targets.set(tag, makeDropTarget(messages[tag - 1]!));
        }

        const result = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                tags: getActiveTagsBySession(db, sessionId),
                targets,
                contextUsage: { percentage: 110, inputTokens: 20_000 },
                emergencyCeilingTokens: 10_000,
                currentTurnId: "turn-reclaim",
            }),
        );

        expect(result.emergencyReclaimedTokens).toBeGreaterThan(0);
        expect(result.emergency).toBe(true);
    });
});

describe("two-pass tool reclaim", () => {
    function tagStatuses(sessionId: string): Map<number, string> {
        return new Map(getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]));
    }

    it("does not auto-drop on an execute pass with no confirmed wire mutation", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-reclaim-noop";
        const message = makeToolMessage("tool-1");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        advanceToolReclaimWatermark(db, sessionId, 1);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [message], {
                schedulerDecision: "execute",
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([[1, makeDropTarget(message)]]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        expect(tagStatuses(sessionId).get(1)).toBe("active");
        expect((message.parts[0] as { state?: { output?: string } }).state?.output).not.toBe(
            "[dropped]",
        );
    });

    it("auto-drops eligible old visible tools only when another confirmed mutation already happened", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-reclaim-mutating";
        const first = makeToolMessage("tool-1");
        const second = makeToolMessage("tool-2");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        insertTag(db, sessionId, "tool-2", "tool", 4000, 2, 0, "read");
        queuePendingOp(db, sessionId, 1, "drop", 1);
        advanceToolReclaimWatermark(db, sessionId, 2);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [first, second], {
                schedulerDecision: "execute",
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([
                    [1, makeDropTarget(first)],
                    [2, makeDropTarget(second)],
                ]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        const statuses = tagStatuses(sessionId);
        expect(statuses.get(1)).toBe("dropped");
        expect(statuses.get(2)).toBe("dropped");
        expect((second.parts[0] as { state?: { output?: string } }).state?.output).toBe(
            "[dropped]",
        );
    });

    it("keeps sub-floor arcs while reclaiming a larger sibling", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-reclaim-size-floor";
        const trigger = makeToolMessage("tool-1");
        const small = makeToolMessage("tool-2");
        const large = makeToolMessage("tool-3");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "edit");
        insertTag(db, sessionId, "tool-2", "tool", 4000, 2, 0, "bash", 0, null, null, {
            tokenCount: 249,
            inputTokenCount: 0,
            reasoningTokenCount: 0,
        });
        insertTag(db, sessionId, "tool-3", "tool", 4000, 3, 0, "read", 0, null, null, {
            tokenCount: 250,
            inputTokenCount: 0,
            reasoningTokenCount: 0,
        });
        queuePendingOp(db, sessionId, 1, "drop", 1);
        advanceToolReclaimWatermark(db, sessionId, 3);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [trigger, small, large], {
                schedulerDecision: "execute",
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([
                    [1, makeDropTarget(trigger)],
                    [2, makeDropTarget(small)],
                    [3, makeDropTarget(large)],
                ]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        const statuses = tagStatuses(sessionId);
        expect(statuses.get(1)).toBe("dropped");
        expect(statuses.get(2)).toBe("active");
        expect(statuses.get(3)).toBe("dropped");
    });

    it("keeps the newest todowrite arc while reclaiming an older one", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-reclaim-newest-todowrite";
        const trigger = makeToolMessage("tool-1");
        const older = makeToolMessage("tool-2");
        const newest = makeToolMessage("tool-3");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "edit");
        insertTag(db, sessionId, "tool-2", "tool", 4000, 2, 0, "todowrite", 0, null, null, {
            tokenCount: 300,
            inputTokenCount: 0,
            reasoningTokenCount: 0,
        });
        insertTag(db, sessionId, "tool-3", "tool", 4000, 3, 0, "todowrite", 0, null, null, {
            tokenCount: 300,
            inputTokenCount: 0,
            reasoningTokenCount: 0,
        });
        queuePendingOp(db, sessionId, 1, "drop", 1);
        advanceToolReclaimWatermark(db, sessionId, 3);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [trigger, older, newest], {
                schedulerDecision: "execute",
                smartDrops: false,
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([
                    [1, makeDropTarget(trigger)],
                    [2, makeDropTarget(older)],
                    [3, makeDropTarget(newest)],
                ]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        const statuses = tagStatuses(sessionId);
        expect(statuses.get(1)).toBe("dropped");
        expect(statuses.get(2)).toBe("dropped");
        expect(statuses.get(3)).toBe("active");
    });

    it("does not persist a synthetic drop for an absent old DB tag", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-reclaim-absent";
        const visible = makeToolMessage("tool-2");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        insertTag(db, sessionId, "tool-2", "tool", 4000, 2, 0, "bash");
        queuePendingOp(db, sessionId, 2, "drop", 1);
        advanceToolReclaimWatermark(db, sessionId, 1);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [visible], {
                schedulerDecision: "execute",
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([[2, makeDropTarget(visible)]]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        const statuses = tagStatuses(sessionId);
        expect(statuses.get(1)).toBe("active");
        expect(statuses.get(2)).toBe("dropped");
    });

    it("suppresses two-pass reclaim in the emergency band but still advances the watermark on execute", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-reclaim-emergency";
        const first = makeToolMessage("tool-1");
        const second = makeToolMessage("tool-2");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        insertTag(db, sessionId, "tool-2", "tool", 4000, 2, 0, "read");
        queuePendingOp(db, sessionId, 1, "drop", 1);
        advanceToolReclaimWatermark(db, sessionId, 2);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [first, second], {
                schedulerDecision: "execute",
                contextUsage: { percentage: 90, inputTokens: 9000 },
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([
                    [1, makeDropTarget(first)],
                    [2, makeDropTarget(second)],
                ]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        const statuses = tagStatuses(sessionId);
        expect(statuses.get(1)).toBe("dropped");
        expect(statuses.get(2)).toBe("active");
        expect(getOrCreateSessionMeta(db, sessionId).toolReclaimWatermark).toBe(2);
    });

    it("freezes the watermark on execute when no reclaim application opportunity exists", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-reclaim-advance";
        const message = makeToolMessage("tool-1");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [message], {
                schedulerDecision: "execute",
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([[1, makeDropTarget(message)]]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        expect(getOrCreateSessionMeta(db, sessionId).toolReclaimWatermark).toBe(0);
        expect(tagStatuses(sessionId).get(1)).toBe("active");
    });

    it("does not advance the watermark on a non-execute force-materialization pass", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-reclaim-force-defer";
        const message = makeToolMessage("tool-1");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [message], {
                schedulerDecision: "defer",
                contextUsage: { percentage: 90, inputTokens: 9000 },
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([[1, makeDropTarget(message)]]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        expect(getOrCreateSessionMeta(db, sessionId).toolReclaimWatermark).toBe(0);
    });
});

describe("issue #386 sustained execute-pressure batching", () => {
    it("keeps caveman bytes stable on consecutive force passes after this turn already ran", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-386-caveman-pressure";
        const turnId = "turn-386";
        const longText =
            "I just really basically wanted to clearly explain the stable cache prefix while pressure remains high. ".repeat(
                6,
            );
        const messages: MessageLike[] = [];
        const targets = new Map<number, TagTarget>();
        const messageTagNumbers = new Map<MessageLike, number>();
        for (let tagNumber = 1; tagNumber <= 35; tagNumber += 1) {
            const message = {
                info: {
                    id: `text-${tagNumber}`,
                    role: tagNumber % 2 === 0 ? "assistant" : "user",
                },
                parts: [{ type: "text", text: longText }],
            } as MessageLike;
            messages.push(message);
            insertTag(db, sessionId, `text-${tagNumber}`, "message", longText.length, tagNumber);
            saveSourceContent(db, sessionId, tagNumber, longText);
            targets.set(tagNumber, makeMessageTarget(message));
            messageTagNumbers.set(message, tagNumber);
        }
        updateSessionMeta(db, sessionId, { cacheTtl: "5m" });
        const lastHeuristicsTurnId = new Map([[sessionId, turnId]]);
        const executeThresholdPercentage = 50;
        const contextLimit = 100_000;
        const exactConfig = {
            schedulerDecision: "execute" as const,
            contextUsage: { percentage: 90, inputTokens: 90_000 },
            emergencyCeilingTokens: Math.floor(contextLimit * (executeThresholdPercentage / 100)),
            forceMaterializationPercentage: 85,
            protectedTags: 12,
            clearReasoningAge: 30,
            smartDrops: true,
            cavemanTextCompression: { enabled: true, minChars: 300 },
            resolvedProviderID: "anthropic",
            currentTurnId: turnId,
            lastHeuristicsTurnId,
        };
        const baseline = JSON.stringify(messages);

        for (const [passIndex, inputTokens] of [90_000, 91_000].entries()) {
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    ...exactConfig,
                    currentTurnId: passIndex === 0 ? turnId : `${turnId}-next`,
                    contextUsage: { percentage: 90, inputTokens },
                    tags: getActiveTagsBySession(db, sessionId),
                    targets,
                    messageTagNumbers,
                    sessionMeta: getOrCreateSessionMeta(db, sessionId),
                }),
            );
            expect(JSON.stringify(messages)).toBe(baseline);
        }

        expect(getOrCreateSessionMeta(db, sessionId).cacheTtl).toBe("5m");
        expect(getOrCreateSessionMeta(db, sessionId).lastTransformError).toBeNull();
        expect(getTagsBySession(db, sessionId).every((tag) => tag.cavemanDepth === 0)).toBe(true);
    });

    it("batches force reclaim once, stays byte-stable, then rides the next independent bust", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-386-emergency-pressure";
        const turnId = "turn-386";
        const messages: MessageLike[] = [];
        const targets = new Map<number, TagTarget>();
        for (let tagNumber = 1; tagNumber <= 30; tagNumber += 1) {
            const message = makeToolMessage(`tool-${tagNumber}`);
            messages.push(message);
            targets.set(tagNumber, makeDropTarget(message));
            insertTag(
                db,
                sessionId,
                `call-${tagNumber}`,
                "tool",
                4_000,
                tagNumber,
                0,
                "bash",
                0,
                `tool-${tagNumber}`,
            );
        }
        updateSessionMeta(db, sessionId, { cacheTtl: "5m" });
        const lastHeuristicsTurnId = new Map([[sessionId, turnId]]);
        const executeThresholdPercentage = 50;
        const contextLimit = 100_000;
        const runPressurePass = async (inputTokens: number) =>
            runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    schedulerDecision: "execute",
                    contextUsage: { percentage: 90, inputTokens },
                    emergencyCeilingTokens: Math.floor(
                        contextLimit * (executeThresholdPercentage / 100),
                    ),
                    forceMaterializationPercentage: 85,
                    protectedTags: 12,
                    clearReasoningAge: 30,
                    smartDrops: true,
                    cavemanTextCompression: { enabled: true, minChars: 300 },
                    resolvedProviderID: "anthropic",
                    currentTurnId: turnId,
                    lastHeuristicsTurnId,
                    tags: getActiveTagsBySession(db, sessionId),
                    targets,
                    sessionMeta: getOrCreateSessionMeta(db, sessionId),
                }),
            );

        await runPressurePass(90_000);
        const firstStatuses = new Map(
            getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]),
        );
        for (let tagNumber = 1; tagNumber <= 18; tagNumber += 1) {
            expect(firstStatuses.get(tagNumber)).toBe("dropped");
        }
        const pricedPrefix = JSON.stringify(messages.slice(0, 30));

        for (let tagNumber = 31; tagNumber <= 32; tagNumber += 1) {
            const message = makeToolMessage(`tool-${tagNumber}`);
            messages.push(message);
            targets.set(tagNumber, makeDropTarget(message));
            insertTag(
                db,
                sessionId,
                `call-${tagNumber}`,
                "tool",
                4_000,
                tagNumber,
                0,
                "bash",
                0,
                `tool-${tagNumber}`,
            );
        }

        await runPressurePass(91_000);
        const secondStatuses = new Map(
            getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]),
        );
        expect(secondStatuses.get(19)).toBe("active");
        expect(secondStatuses.get(20)).toBe("active");
        expect(JSON.stringify(messages.slice(0, 30))).toBe(pricedPrefix);

        queuePendingOp(db, sessionId, 19, "drop", 1);
        await runPressurePass(92_000);
        const ridingStatuses = new Map(
            getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]),
        );
        expect(ridingStatuses.get(19)).toBe("dropped");
        expect(ridingStatuses.get(20)).toBe("dropped");
        expect(getOrCreateSessionMeta(db, sessionId).cacheTtl).toBe("5m");
    });
});

describe("smart-drops supersession reclaim (flag-gated)", () => {
    function tagStatuses(sessionId: string): Map<number, string> {
        return new Map(getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]));
    }

    // tag 1 performs a real drop, which enables the reclaim block this pass;
    // tags 2 & 3 are todowrite where the older (2) is superseded by the newer
    // (3). watermark=1 makes the age-based sweep skip tags 2/3, so only the
    // smart-drops supersession path can touch them.
    function seedTodowriteSession(sessionId: string): {
        trigger: MessageLike;
        older: MessageLike;
        newer: MessageLike;
        recentTail: MessageLike[];
    } {
        const trigger = makeToolMessage("tool-1");
        const older = makeToolMessage("tool-2");
        const newer = makeToolMessage("tool-3");
        const recentTail = Array.from({ length: 20 }, (_, index) => ({
            info: { id: `recent-${index + 1}`, role: index % 2 === 0 ? "user" : "assistant" },
            parts: [{ type: "text", text: `recent message ${index + 1}` }],
        })) as MessageLike[];
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "edit", 0, "tool-1");
        insertTag(db, sessionId, "tool-2", "tool", 4000, 2, 0, "todowrite", 0, "tool-2");
        insertTag(db, sessionId, "tool-3", "tool", 4000, 3, 0, "todowrite", 0, "tool-3");
        for (const [index, message] of recentTail.entries()) {
            insertTag(db, sessionId, message.info.id, "message", 50, index + 4);
        }
        queuePendingOp(db, sessionId, 1, "drop", 1);
        advanceToolReclaimWatermark(db, sessionId, 1);
        return { trigger, older, newer, recentTail };
    }

    it("OFF (default): superseded todowrite is NOT dropped even on a mutating execute pass", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-smart-off";
        const { trigger, older, newer, recentTail } = seedTodowriteSession(sessionId);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [trigger, older, newer, ...recentTail], {
                schedulerDecision: "execute",
                smartDrops: false,
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([
                    [1, makeDropTarget(trigger)],
                    [2, makeDropTarget(older)],
                    [3, makeDropTarget(newer)],
                ]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        const statuses = tagStatuses(sessionId);
        expect(statuses.get(1)).toBe("dropped"); // dropped by its own queued drop, not smart-drops
        expect(statuses.get(2)).toBe("active"); // untouched: flag off
        expect(statuses.get(3)).toBe("active");
    });

    it("ON: superseded todowrite is dropped, newest kept, on a mutating execute pass", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-smart-on";
        const { trigger, older, newer, recentTail } = seedTodowriteSession(sessionId);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [trigger, older, newer, ...recentTail], {
                schedulerDecision: "execute",
                smartDrops: true,
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([
                    [1, makeDropTarget(trigger)],
                    [2, makeDropTarget(older)],
                    [3, makeDropTarget(newer)],
                ]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        const statuses = tagStatuses(sessionId);
        expect(statuses.get(1)).toBe("dropped");
        expect(statuses.get(2)).toBe("dropped"); // superseded todowrite
        expect(statuses.get(3)).toBe("active"); // newest todowrite kept
    });

    for (const shape of ["head", "tail"] as const) {
        it(`keeps the newest-20 owner floor stable across ${shape} contraction and re-expansion`, async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = `ses-smart-${shape}-contraction`;
            const trigger = makeToolMessage("priced-trigger");
            const owners = Array.from({ length: 22 }, (_, index) =>
                makeToolMessage(`owner-${index + 1}`),
            );
            insertTag(
                db,
                sessionId,
                "priced-trigger",
                "tool",
                100,
                1,
                0,
                "bash",
                0,
                "priced-trigger",
            );
            const targets = new Map<number, TagTarget>([[1, makeDropTarget(trigger)]]);
            for (const [index, owner] of owners.entries()) {
                const tagNumber = index + 2;
                insertTag(
                    db,
                    sessionId,
                    `status-${index + 1}`,
                    "tool",
                    100,
                    tagNumber,
                    0,
                    "bash_status",
                    0,
                    owner.info.id,
                );
                targets.set(tagNumber, makeDropTarget(owner));
            }
            queuePendingOp(db, sessionId, 1, "drop", 1);
            advanceToolReclaimWatermark(db, sessionId, 1);

            const absentOwnerId = shape === "head" ? "owner-3" : "owner-22";
            const contractedOwners =
                shape === "head"
                    ? owners.filter(
                          (owner) => !["owner-1", "owner-2", "owner-3"].includes(owner.info.id),
                      )
                    : owners.filter((owner) => owner.info.id !== absentOwnerId);
            const contractedMessages = [trigger, ...contractedOwners];

            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, contractedMessages, {
                    schedulerDecision: "execute",
                    smartDrops: true,
                    tags: getActiveTagsBySession(db, sessionId),
                    targets,
                    sessionMeta: getOrCreateSessionMeta(db, sessionId),
                }),
            );

            const absentTagNumber = Number(absentOwnerId.split("-")[1]) + 1;
            expect(
                getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === absentTagNumber)
                    ?.status,
            ).toBe("active");

            const replayOwners = Array.from({ length: 22 }, (_, index) =>
                makeToolMessage(`owner-${index + 1}`),
            );
            const replayTargets = new Map<number, TagTarget>();
            for (const [index, owner] of replayOwners.entries()) {
                replayTargets.set(index + 2, makeDropTarget(owner));
            }
            const replayTarget = replayOwners.find((owner) => owner.info.id === absentOwnerId);
            if (!replayTarget) throw new Error("expected replay owner");
            const originalBytes = JSON.stringify(replayTarget);

            applyFlushedStatuses(sessionId, db, replayTargets, getTagsBySession(db, sessionId));

            expect(JSON.stringify(replayTarget)).toBe(originalBytes);
        });
    }

    it("ON but plain DEFER pass: nothing is dropped (reclaim block requires a known bust)", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-smart-defer";
        const { trigger, older, newer, recentTail } = seedTodowriteSession(sessionId);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [trigger, older, newer, ...recentTail], {
                schedulerDecision: "defer",
                smartDrops: true,
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([
                    [1, makeDropTarget(trigger)],
                    [2, makeDropTarget(older)],
                    [3, makeDropTarget(newer)],
                ]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        const statuses = tagStatuses(sessionId);
        expect(statuses.get(2)).toBe("active");
        expect(statuses.get(3)).toBe("active");
    });
});

describe("executed m[0] hard-fold folds the execute pass in", () => {
    const FOLD_PROJECT = "/tmp/test-hardfold-project";
    const BASE_HARD: M0HardSignals = {
        systemHash: "sys-v1",
        modelKey: "anthropic/opus",
        cacheExpired: false,
        lastResponseTime: 0,
    };

    function materializeBaseline(sessionId: string) {
        // Fold a baseline m[0] so the session is past first_render and markers are
        // captured; subsequent passes only HARD-fold on a real marker change.
        injectM0M1({
            db,
            sessionId,
            state: getOrCreateSessionMeta(db, sessionId),
            projectPath: FOLD_PROJECT,
            projectDirectory: FOLD_PROJECT,
            historyBudgetTokens: 98_000,
            isCacheBustingPass: true,
            hardSignals: BASE_HARD,
        });
    }

    it("keeps OpenCode final bytes identical to a one-shot executed fold", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const directSession = "ses-hardfold-byte-direct";
        const postprocessSession = "ses-hardfold-byte-postprocess";
        materializeBaseline(directSession);
        materializeBaseline(postprocessSession);
        const hardSignals = { ...BASE_HARD, modelKey: "anthropic/sonnet" };

        const directMessages: MessageLike[] = [];
        const direct = injectM0M1({
            db,
            sessionId: directSession,
            messages: directMessages,
            state: getOrCreateSessionMeta(db, directSession),
            projectPath: FOLD_PROJECT,
            projectDirectory: FOLD_PROJECT,
            historyBudgetTokens: 98_000,
            isCacheBustingPass: true,
            hardSignals,
        });
        const postprocessMessages: MessageLike[] = [];
        const postprocess = await runPostTransformPhase(
            basePostTransformArgs(db, postprocessSession, postprocessMessages, {
                schedulerDecision: "defer",
                contextUsage: { percentage: 40, inputTokens: 4000 },
                m0M1: {
                    projectPath: FOLD_PROJECT,
                    projectDirectory: FOLD_PROJECT,
                    historyBudgetTokens: 98_000,
                    hardSignals,
                },
            }),
        );

        expect(direct.m0RematerializedThisPass).toBe(true);
        expect(postprocess.materialized).toBe(true);
        expect(JSON.stringify(postprocessMessages.map((message) => message.parts))).toBe(
            JSON.stringify(directMessages.map((message) => message.parts)),
        );
    });

    it("preserves a pre-deploy whitespace prefix through a HARD fold and rebuilt defer tail", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-hardfold-inert-whitespace";
        const dataHome = mkdtempSync(join(tmpdir(), "postprocess-hardfold-whitespace-"));
        tempDirs.push(dataHome);
        process.env.XDG_DATA_HOME = dataHome;
        mkdirSync(join(dataHome, "opencode"), { recursive: true });
        const opencodeDb = new Database(join(dataHome, "opencode", "opencode.db"));
        opencodeDb.exec(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
        );
        opencodeDb.exec(
            "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
        );
        opencodeDb
            .prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            )
            .run("msg-fold-boundary", sessionId, 1_000, 1_000, JSON.stringify({ role: "user" }));
        opencodeDb.close();

        materializeBaseline(sessionId);
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 10,
                startMessageId: "msg-fold-boundary",
                endMessageId: "msg-fold-boundary",
                title: "hard fold whitespace",
                content: "folded content",
            },
        ]);
        setPendingCompactionMarkerState(db, sessionId, {
            ordinal: 10,
            endMessageId: "msg-fold-boundary",
            publishedAt: 1,
        });
        insertTag(db, sessionId, "assistant-framing:p0", "message", 1, 1);
        markWhitespaceAssistantTagInert(db, sessionId, 1, "assistant-framing:p0");
        const previousServe = "§1§  ";
        const makeTail = () =>
            [
                {
                    info: { id: "msg-tail-user", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "retained user turn" }],
                },
                {
                    info: { id: "assistant-framing", role: "assistant", sessionID: sessionId },
                    parts: [{ type: "text", text: " " }],
                },
            ] as unknown as MessageLike[];

        const tagger = createTagger();
        tagger.initFromDb(sessionId, db);
        const hardMessages = makeTail();
        const hardTagged = tagMessages(sessionId, hardMessages, tagger, db);
        const deferredHistoryRefreshSessions = new Set<string>([sessionId]);
        const hardResult = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, hardMessages, {
                tagger,
                targets: hardTagged.targets,
                reasoningByMessage: hardTagged.reasoningByMessage,
                messageTagNumbers: hardTagged.messageTagNumbers,
                batch: hardTagged.batch,
                deferredHistoryWasPendingAtPassStart: true,
                historyRebuiltThisPass: true,
                canConsumeDeferredLate: true,
                deferredHistoryRefreshSessions,
                pendingCompartmentInjection: {
                    block: "",
                    compartmentEndMessage: 10,
                    compartmentEndMessageId: "msg-fold-boundary",
                    compartmentCount: 1,
                    skippedVisibleMessages: 0,
                    factCount: 0,
                    memoryCount: 0,
                    rebuiltFromDb: true,
                },
                m0M1: {
                    projectPath: FOLD_PROJECT,
                    projectDirectory: FOLD_PROJECT,
                    historyBudgetTokens: 98_000,
                    hardSignals: { ...BASE_HARD, modelKey: "anthropic/sonnet" },
                },
            }),
        );

        const marker = getPersistedCompactionMarkerState(db, sessionId);
        const hardWhitespace = hardMessages.find(
            (message) => message.info.id === "assistant-framing",
        );
        expect(hardResult.materialized).toBe(true);
        expect(marker?.boundaryOrdinal).toBe(10);
        expect(hardWhitespace?.parts).toEqual([{ type: "text", text: previousServe }]);
        const hardWire = JSON.stringify(hardMessages);

        const deferMessages = [
            {
                info: {
                    id: marker?.summaryMessageId,
                    role: "assistant",
                    sessionID: sessionId,
                    summary: true,
                    finish: "stop",
                },
                parts: [{ type: "text", text: MARKER_SUMMARY_TEXT }],
            },
            ...makeTail(),
        ] as unknown as MessageLike[];
        const deferTagger = createTagger();
        deferTagger.initFromDb(sessionId, db);
        const deferTagged = tagMessages(sessionId, deferMessages, deferTagger, db);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, deferMessages, {
                tagger: deferTagger,
                targets: deferTagged.targets,
                reasoningByMessage: deferTagged.reasoningByMessage,
                messageTagNumbers: deferTagged.messageTagNumbers,
                batch: deferTagged.batch,
                m0M1: {
                    projectPath: FOLD_PROJECT,
                    projectDirectory: FOLD_PROJECT,
                    historyBudgetTokens: 98_000,
                    hardSignals: { ...BASE_HARD, modelKey: "anthropic/sonnet" },
                },
            }),
        );

        const deferWhitespace = deferMessages.find(
            (message) => message.info.id === "assistant-framing",
        );
        expect(deferWhitespace?.parts).toEqual([{ type: "text", text: previousServe }]);
        expect(JSON.stringify(deferMessages)).toBe(hardWire);
    });

    it("observes a tool-set comparison without turning it into an m[0] fold", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-hardfold-tool-observation";
        const baselineSignals = { ...BASE_HARD, toolSetHash: "tools-before" };
        injectM0M1({
            db,
            sessionId,
            state: getOrCreateSessionMeta(db, sessionId),
            projectPath: FOLD_PROJECT,
            projectDirectory: FOLD_PROJECT,
            historyBudgetTokens: 98_000,
            isCacheBustingPass: true,
            hardSignals: baselineSignals,
        });

        const result = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [], {
                schedulerDecision: "defer",
                contextUsage: { percentage: 40, inputTokens: 4000 },
                m0M1: {
                    projectPath: FOLD_PROJECT,
                    projectDirectory: FOLD_PROJECT,
                    historyBudgetTokens: 98_000,
                    hardSignals: { ...baselineSignals, toolSetHash: "tools-after" },
                },
            }),
        );

        expect(result.materialized).toBe(false);
        expect(result.materializeReason).toBeNull();
        expect(result.m0ToolSetHashPrev).toBe("tools-before");
        expect(result.m0ToolSetHashNew).toBe("tools-after");
    });

    it("re-arms Channel 2 when a HARD fold advances m0 compartment coverage", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-hardfold-channel2-cycle";
        materializeBaseline(sessionId);
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 10,
                startMessageId: "start",
                endMessageId: "end",
                title: "new folded coverage",
                content: "compartment content",
            },
        ]);
        setChannel2NudgeState(db, sessionId, "delivered");

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [], {
                m0M1: {
                    projectPath: FOLD_PROJECT,
                    projectDirectory: FOLD_PROJECT,
                    historyBudgetTokens: 98_000,
                    hardSignals: { ...BASE_HARD, modelKey: "anthropic/sonnet" },
                },
            }),
        );

        expect(getChannel2NudgeState(db, sessionId)).toBe("");
    });

    it("drains queued pending ops on a DEFER scheduler pass when m[0] HARD-folds", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-hardfold-drain";
        materializeBaseline(sessionId);

        // A tool tag + a queued drop for it, exactly as a prior execute pass left.
        const message = makeToolMessage("tool-1");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        queuePendingOp(db, sessionId, 1, "drop", 1);
        const targets = new Map<number, TagTarget>([[1, makeDropTarget(message)]]);

        // Scheduler says DEFER (below execute threshold), but the model key changed
        // → m[0] will HARD-fold this pass. The fold should pull the queued drop in.
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [message], {
                schedulerDecision: "defer",
                contextUsage: { percentage: 40, inputTokens: 4000 },
                targets,
                currentTurnId: "turn-hardfold",
                m0M1: {
                    projectPath: FOLD_PROJECT,
                    projectDirectory: FOLD_PROJECT,
                    historyBudgetTokens: 98_000,
                    hardSignals: {
                        ...BASE_HARD,
                        modelKey: "anthropic/sonnet", // ← the HARD trigger
                    },
                },
            }),
        );

        // The queued drop materialized on the (otherwise-defer) hard-fold pass.
        expect(getTagsBySession(db, sessionId).find((t) => t.tagNumber === 1)?.status).toBe(
            "dropped",
        );
    });

    it("drains queued pending ops on an m[0] HARD-fold pass EVEN WHILE the historian runs", async () => {
        // The double-bust fix: a HARD fold (e.g. system-prompt change) re-caches
        // m[0] this pass, so the prefix is busting regardless. If the historian is
        // mid-run, the compartmentRunning veto USED to block the drain → it spilled
        // into a second bust ~a turn later. The fold-fold bypass must drain into
        // the one unavoidable bust instead. canRunCompartments=true + a registered
        // active run makes compartmentRunning=true.
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-hardfold-drain-while-historian";
        materializeBaseline(sessionId);

        const message = makeToolMessage("tool-1");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        queuePendingOp(db, sessionId, 1, "drop", 1);
        const targets = new Map<number, TagTarget>([[1, makeDropTarget(message)]]);

        // Historian in progress for this session (never resolves during the test).
        registerActiveCompartmentRun(sessionId, new Promise<void>(() => {}));

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [message], {
                schedulerDecision: "defer",
                contextUsage: { percentage: 40, inputTokens: 4000 },
                targets,
                currentTurnId: "turn-hardfold-historian",
                canRunCompartments: true,
                m0M1: {
                    projectPath: FOLD_PROJECT,
                    projectDirectory: FOLD_PROJECT,
                    historyBudgetTokens: 98_000,
                    hardSignals: {
                        ...BASE_HARD,
                        modelKey: "anthropic/sonnet", // ← the HARD trigger
                    },
                },
            }),
        );

        // Despite the historian running, the hard fold drained the queued drop
        // into this pass (no second bust later).
        expect(getTagsBySession(db, sessionId).find((t) => t.tagNumber === 1)?.status).toBe(
            "dropped",
        );
    });

    it("drains pending ops but not two-pass reclaim or its watermark on a low-usage TTL fold", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-hardfold-reclaim-drain";
        materializeBaseline(sessionId);

        const trigger = makeToolMessage("tool-1");
        const reclaimable = makeToolMessage("tool-2");
        const newer = makeToolMessage("tool-3");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "edit");
        insertTag(db, sessionId, "tool-2", "tool", 4000, 2, 0, "bash");
        insertTag(db, sessionId, "tool-3", "tool", 4000, 3, 0, "read");
        queuePendingOp(db, sessionId, 1, "drop", 1);
        advanceToolReclaimWatermark(db, sessionId, 2);
        const messages = [trigger, reclaimable, newer];
        const targets = new Map<number, TagTarget>([
            [1, makeDropTarget(trigger)],
            [2, makeDropTarget(reclaimable)],
            [3, makeDropTarget(newer)],
        ]);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "defer",
                contextUsage: { percentage: 40, inputTokens: 4000 },
                tags: getActiveTagsBySession(db, sessionId),
                targets,
                currentTurnId: "turn-hardfold-reclaim",
                m0M1: {
                    projectPath: FOLD_PROJECT,
                    projectDirectory: FOLD_PROJECT,
                    historyBudgetTokens: 98_000,
                    hardSignals: {
                        ...BASE_HARD,
                        cacheExpired: true,
                        lastResponseTime: Number.MAX_SAFE_INTEGER,
                    },
                },
            }),
        );

        const statuses = new Map(
            getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]),
        );
        expect(statuses.get(1)).toBe("dropped");
        expect(statuses.get(2)).toBe("active");
        expect(statuses.get(3)).toBe("active");
        expect(getOrCreateSessionMeta(db, sessionId).toolReclaimWatermark).toBe(2);

        const deferReplayBytes = JSON.stringify(messages);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "defer",
                contextUsage: { percentage: 40, inputTokens: 4000 },
                tags: getActiveTagsBySession(db, sessionId),
                targets,
                currentTurnId: "turn-hardfold-reclaim-replay",
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        expect(JSON.stringify(messages)).toBe(deferReplayBytes);
        expect(getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === 3)?.status).toBe(
            "active",
        );
    });

    it("does NOT drain while the historian runs on a NON-busting defer pass", async () => {
        // Counterpart: same historian-running condition, but NO hard fold and NOT
        // an execute pass → the compartmentRunning veto still holds (don't mutate
        // the bytes the historian is reading on a pass that isn't busting anyway).
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-nofold-historian-novdrain";
        materializeBaseline(sessionId);

        const message = makeToolMessage("tool-1");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        queuePendingOp(db, sessionId, 1, "drop", 1);
        const targets = new Map<number, TagTarget>([[1, makeDropTarget(message)]]);

        registerActiveCompartmentRun(sessionId, new Promise<void>(() => {}));

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [message], {
                schedulerDecision: "defer",
                contextUsage: { percentage: 40, inputTokens: 4000 },
                targets,
                currentTurnId: "turn-nofold-historian",
                canRunCompartments: true,
                m0M1: {
                    projectPath: FOLD_PROJECT,
                    projectDirectory: FOLD_PROJECT,
                    historyBudgetTokens: 98_000,
                    hardSignals: BASE_HARD,
                },
            }),
        );

        expect(getTagsBySession(db, sessionId).find((t) => t.tagNumber === 1)?.status).toBe(
            "active",
        );
    });

    it("does NOT drain on a plain DEFER pass with no hard fold (baseline behavior)", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-nofold-nodrain";
        materializeBaseline(sessionId);

        const message = makeToolMessage("tool-1");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        queuePendingOp(db, sessionId, 1, "drop", 1);
        const targets = new Map<number, TagTarget>([[1, makeDropTarget(message)]]);

        // Same defer pass but markers UNCHANGED → no hard fold → drop stays queued.
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [message], {
                schedulerDecision: "defer",
                contextUsage: { percentage: 40, inputTokens: 4000 },
                targets,
                currentTurnId: "turn-nofold",
                m0M1: {
                    projectPath: FOLD_PROJECT,
                    projectDirectory: FOLD_PROJECT,
                    historyBudgetTokens: 98_000,
                    hardSignals: BASE_HARD,
                },
            }),
        );

        expect(getTagsBySession(db, sessionId).find((t) => t.tagNumber === 1)?.status).toBe(
            "active",
        );
    });
});

describe("postprocess empty-sentinel provider gate", () => {
    it("does not sentinelize cleared reasoning on github-copilot execute passes", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-copilot-cleared-reasoning";
        const messages: MessageLike[] = [
            {
                info: { id: "m-cleared", role: "assistant" },
                parts: [{ type: "thinking", thinking: "[cleared]" }],
            } as unknown as MessageLike,
        ];

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "execute",
                contextUsage: { percentage: 60, inputTokens: 6000 },
                currentTurnId: "turn-cleared",
                resolvedProviderID: "github-copilot",
            }),
        );

        expect(messages[0].parts).toEqual([{ type: "thinking", thinking: "[cleared]" }]);
    });

    it("does not WRITE [cleared] into old reasoning on github-copilot (clearOldReasoning gated)", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-copilot-clear-write";
        const oldThinking = { type: "thinking", thinking: "real reasoning content" };
        const oldMsg = {
            info: { id: "m-old", role: "assistant" },
            parts: [oldThinking],
        } as unknown as MessageLike;
        const recentMsg = {
            info: { id: "m-recent", role: "assistant" },
            parts: [{ type: "text", text: "hi" }],
        } as unknown as MessageLike;
        const messages: MessageLike[] = [oldMsg, recentMsg];

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "execute",
                contextUsage: { percentage: 60, inputTokens: 6000 },
                currentTurnId: "turn-clear-write",
                resolvedProviderID: "github-copilot",
                clearReasoningAge: 1,
                reasoningByMessage: new Map([[oldMsg, [oldThinking]]]) as never,
                messageTagNumbers: new Map([
                    [oldMsg, 1],
                    [recentMsg, 3],
                ]),
            }),
        );

        // Non-canonical provider: reasoning must stay intact (no "[cleared]"
        // string reaching a wire that won't sentinelize it).
        expect(oldThinking.thinking).toBe("real reasoning content");
    });

    it("still clears + sentinelizes old reasoning on anthropic execute passes", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-anthropic-clear-write";
        const oldThinking = { type: "thinking", thinking: "real reasoning content" };
        const oldMsg = {
            info: { id: "m-old", role: "assistant" },
            parts: [oldThinking],
        } as unknown as MessageLike;
        const recentMsg = {
            info: { id: "m-recent", role: "assistant" },
            parts: [{ type: "text", text: "hi" }],
        } as unknown as MessageLike;
        const messages: MessageLike[] = [oldMsg, recentMsg];

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "execute",
                contextUsage: { percentage: 60, inputTokens: 6000 },
                currentTurnId: "turn-clear-write-anthropic",
                resolvedProviderID: "anthropic",
                clearReasoningAge: 1,
                reasoningByMessage: new Map([[oldMsg, [oldThinking]]]) as never,
                messageTagNumbers: new Map([
                    [oldMsg, 1],
                    [recentMsg, 3],
                ]),
            }),
        );

        // Canonical anthropic: cleared to "[cleared]" then sentinelized to empty
        // text (OpenCode drops empty text before the wire).
        expect(oldMsg.parts).toEqual([{ type: "text", text: "" }]);
    });

    it("leaves processed image file parts native for github-copilot", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-copilot-processed-image";
        const userMessage = {
            info: { id: "m-image", role: "user" },
            parts: [
                {
                    type: "file",
                    mime: "image/png",
                    url: `data:image/png;base64,${"a".repeat(220)}`,
                },
            ],
        } as unknown as MessageLike;
        const messages: MessageLike[] = [
            userMessage,
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "text", text: "seen" }],
            },
        ] as unknown as MessageLike[];

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                watermark: 1,
                messageTagNumbers: new Map([[userMessage, 1]]),
                resolvedProviderID: "github-copilot",
            }),
        );

        expect(userMessage.parts[0]).toMatchObject({ type: "file", mime: "image/png" });
        expect(userMessage.parts).not.toContainEqual({ type: "text", text: "" });
    });

    it("still sentinelizes processed image file parts for anthropic", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-anthropic-processed-image";
        const userMessage = {
            info: { id: "m-image", role: "user" },
            parts: [
                {
                    type: "file",
                    mime: "image/png",
                    url: `data:image/png;base64,${"a".repeat(220)}`,
                },
            ],
        } as unknown as MessageLike;
        const messages: MessageLike[] = [
            userMessage,
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "text", text: "seen" }],
            },
        ] as unknown as MessageLike[];

        // First-strip now requires a cache-busting (execute) pass; the id is
        // then frozen so it replays on later defer passes.
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                watermark: 1,
                messageTagNumbers: new Map([[userMessage, 1]]),
                resolvedProviderID: "anthropic",
                schedulerDecision: "execute",
                contextUsage: { percentage: 60, inputTokens: 6000 },
                currentTurnId: "turn-img",
            }),
        );

        expect(userMessage.parts).toEqual([{ type: "text", text: "" }]);
        expect([...getProcessedImageStrippedIds(db, sessionId)]).toEqual(["m-image"]);
    });

    it("replays frozen processed image strips on defer passes even when the watermark is zero", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-anthropic-processed-image-zero-watermark";
        addProcessedImageStrippedIds(db, sessionId, ["m-image-frozen"]);
        const userMessage = {
            info: { id: "m-image-frozen", role: "user" },
            parts: [
                {
                    type: "file",
                    mime: "image/png",
                    url: `data:image/png;base64,${"a".repeat(220)}`,
                },
            ],
        } as unknown as MessageLike;
        const messages: MessageLike[] = [
            userMessage,
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "text", text: "seen" }],
            },
        ] as unknown as MessageLike[];

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "defer",
                watermark: 0,
                messageTagNumbers: new Map([[userMessage, 1]]),
                resolvedProviderID: "anthropic",
            }),
        );

        expect(userMessage.parts).toEqual([{ type: "text", text: "" }]);
        expect([...getProcessedImageStrippedIds(db, sessionId)]).toEqual(["m-image-frozen"]);
    });

    it("does not replay stale ctx_reduce frozen ids as empty sentinels for github-copilot", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-copilot-stale-reduce";
        addStaleReduceStrippedIds(db, sessionId, ["reduce-1"]);
        const messages: MessageLike[] = [
            {
                info: { id: "reduce-1", role: "tool" },
                parts: [
                    {
                        type: "tool",
                        tool: "ctx_reduce",
                        callID: "call-reduce",
                        state: { output: "Queued: drop §1§", status: "completed" },
                    },
                ],
            } as unknown as MessageLike,
        ];

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "defer",
                resolvedProviderID: "github-copilot",
            }),
        );

        expect(messages[0].parts[0]).toMatchObject({ type: "tool", tool: "ctx_reduce" });
    });
});

describe("final message representation", () => {
    it("serializes a late auto-reclaim clear identically on execute and defer", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-final-representation-late-clear";
        const template = [
            {
                info: { id: "trigger", role: "user" },
                parts: [{ type: "text", text: "drop trigger" }],
            },
            {
                info: { id: "target", role: "assistant" },
                parts: [
                    { type: "text", text: "" },
                    {
                        type: "reasoning",
                        text: "reasoning cleared with the old tool",
                        metadata: { anthropic: { signature: "signature-cleared-with-old-tool" } },
                    },
                    {
                        type: "tool",
                        callID: "call-old",
                        tool: "read",
                        state: { output: "old output", status: "completed" },
                    },
                    {
                        type: "tool",
                        callID: "call-survivor",
                        tool: "read",
                        state: { output: "surviving output", status: "completed" },
                    },
                    { type: "text", text: "" },
                ],
            },
        ] as unknown as MessageLike[];

        insertTag(db, sessionId, "trigger", "message", 100, 1);
        insertTag(db, sessionId, "call-old", "tool", 100, 2, 0, "read");
        insertTag(db, sessionId, "call-survivor", "tool", 100, 3, 0, "read");
        padRecentToolSkeletonWindow(sessionId, 3);
        queuePendingOp(db, sessionId, 1, "drop", 1);
        advanceToolReclaimWatermark(db, sessionId, 2);

        const foldMessages = cloneMessages(template);
        const foldBatch = new ToolMutationBatch(foldMessages);
        const foldTargets = new Map<number, TagTarget>([
            [1, makeMessageTarget(findMessage(foldMessages, "trigger"))],
        ]);
        const foldIndex = buildToolCallIndex(foldMessages);
        addToolTarget({
            targets: foldTargets,
            index: foldIndex,
            batch: foldBatch,
            callId: "call-old",
            tagNumber: 2,
            thinking: thinkingParts(findMessage(foldMessages, "target")),
        });
        addToolTarget({
            targets: foldTargets,
            index: foldIndex,
            batch: foldBatch,
            callId: "call-survivor",
            tagNumber: 3,
        });

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, foldMessages, {
                schedulerDecision: "execute",
                contextUsage: { percentage: 60, inputTokens: 6000 },
                currentTurnId: "turn-late-clear",
                resolvedProviderID: "anthropic",
                tags: getActiveTagsBySession(db, sessionId),
                targets: foldTargets,
                batch: foldBatch,
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        const statuses = new Map(
            getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]),
        );
        expect(statuses.get(1)).toBe("dropped");
        expect(statuses.get(2)).toBe("dropped");
        expect(statuses.get(3)).toBe("active");
        const foldTarget = findMessage(foldMessages, "target");
        expect(
            foldTarget.parts.some(
                (part) =>
                    typeof part === "object" &&
                    part !== null &&
                    (part as { callID?: unknown }).callID === "call-old",
            ),
        ).toBe(false);
        expect(foldTarget.parts).toContainEqual({
            type: "tool",
            callID: "call-survivor",
            tool: "read",
            state: { output: "surviving output", status: "completed" },
        });

        const deferMessages = cloneMessages(template);
        const deferBatch = new ToolMutationBatch(deferMessages);
        const deferTargets = new Map<number, TagTarget>([
            [1, makeMessageTarget(findMessage(deferMessages, "trigger"))],
        ]);
        const deferIndex = buildToolCallIndex(deferMessages);
        addToolTarget({
            targets: deferTargets,
            index: deferIndex,
            batch: deferBatch,
            callId: "call-old",
            tagNumber: 2,
            thinking: thinkingParts(findMessage(deferMessages, "target")),
        });
        addToolTarget({
            targets: deferTargets,
            index: deferIndex,
            batch: deferBatch,
            callId: "call-survivor",
            tagNumber: 3,
        });
        expect(
            applyFlushedStatuses(sessionId, db, deferTargets, getTagsBySession(db, sessionId)),
        ).toBe(true);
        deferBatch.finalize();
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, deferMessages, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
                tags: getActiveTagsBySession(db, sessionId),
                targets: deferTargets,
                batch: deferBatch,
                didMutateFromFlushedStatuses: true,
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        const foldWire = serializeAnthropicWirePrefix(foldMessages);
        const deferWire = serializeAnthropicWirePrefix(deferMessages);
        expect(deferWire).toBe(foldWire);
        expect(foldWire).not.toContain("[cleared]");
        expect(foldWire).not.toContain("reasoning cleared with the old tool");
        expect(foldWire).not.toContain("signature-cleared-with-old-tool");
    });

    it("preserves leading signed reasoning after a predecessor is reclaimed and pruned", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-final-representation-preserve-reasoning";
        const preservedReasoning = {
            type: "reasoning",
            text: "real reasoning that must survive",
            metadata: { anthropic: { signature: "signature-that-must-survive" } },
        };
        const template = [
            {
                info: { id: "user", role: "user" },
                parts: [{ type: "text", text: "drop trigger" }],
            },
            {
                info: { id: "drop-only", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        callID: "call-predecessor",
                        tool: "read",
                        state: { output: "spent output", status: "completed" },
                    },
                ],
            },
            {
                info: { id: "target", role: "assistant" },
                parts: [
                    { type: "text", text: "" },
                    preservedReasoning,
                    { type: "tool_use", id: "call-live", name: "read", input: { path: "x" } },
                    { type: "text", text: "" },
                ],
            },
        ] as unknown as MessageLike[];

        insertTag(db, sessionId, "user", "message", 100, 1);
        insertTag(db, sessionId, "call-predecessor", "tool", 100, 2, 0, "read");
        padRecentToolSkeletonWindow(sessionId, 2);
        queuePendingOp(db, sessionId, 1, "drop", 1);
        advanceToolReclaimWatermark(db, sessionId, 2);

        const foldMessages = cloneMessages(template);
        const foldBatch = new ToolMutationBatch(foldMessages);
        const foldTargets = new Map<number, TagTarget>([
            [1, makeMessageTarget(findMessage(foldMessages, "user"))],
        ]);
        addToolTarget({
            targets: foldTargets,
            index: buildToolCallIndex(foldMessages),
            batch: foldBatch,
            callId: "call-predecessor",
            tagNumber: 2,
        });
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, foldMessages, {
                schedulerDecision: "execute",
                contextUsage: { percentage: 60, inputTokens: 6000 },
                currentTurnId: "turn-preserve-reasoning",
                resolvedProviderID: "anthropic",
                tags: getActiveTagsBySession(db, sessionId),
                targets: foldTargets,
                batch: foldBatch,
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        expect(foldMessages.some((message) => message.info.id === "drop-only")).toBe(false);
        expect(getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === 2)?.status).toBe(
            "dropped",
        );
        expect(findMessage(foldMessages, "target").parts).toContainEqual(preservedReasoning);

        const deferMessages = cloneMessages(template);
        const deferBatch = new ToolMutationBatch(deferMessages);
        const deferTargets = new Map<number, TagTarget>([
            [1, makeMessageTarget(findMessage(deferMessages, "user"))],
        ]);
        addToolTarget({
            targets: deferTargets,
            index: buildToolCallIndex(deferMessages),
            batch: deferBatch,
            callId: "call-predecessor",
            tagNumber: 2,
        });
        expect(
            applyFlushedStatuses(sessionId, db, deferTargets, getTagsBySession(db, sessionId)),
        ).toBe(true);
        deferBatch.finalize();
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, deferMessages, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
                tags: getActiveTagsBySession(db, sessionId),
                targets: deferTargets,
                batch: deferBatch,
                didMutateFromFlushedStatuses: true,
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        const foldWire = serializeAnthropicWirePrefix(foldMessages);
        const deferWire = serializeAnthropicWirePrefix(deferMessages);
        expect(deferWire).toBe(foldWire);
        expect(foldWire).toContain("real reasoning that must survive");
        expect(foldWire).toContain("signature-that-must-survive");
        expect(findMessage(deferMessages, "target").parts).toContainEqual(preservedReasoning);
    });

    it("strips reasoning created by final adjacency, stays idempotent, and gates non-Anthropic providers", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-final-representation-adjacency";
        const template = [
            {
                info: { id: "assistant-first", role: "assistant" },
                parts: [{ type: "text", text: "first assistant content" }],
            },
            {
                info: { id: "drop-only", role: "tool" },
                parts: [
                    {
                        type: "tool",
                        callID: "call-between",
                        tool: "read",
                        state: { output: "spent output", status: "completed" },
                    },
                ],
            },
            {
                info: { id: "assistant-second", role: "assistant" },
                parts: [
                    {
                        type: "reasoning",
                        text: "reasoning invalid after merge",
                        metadata: { anthropic: { signature: "signature-invalid-after-merge" } },
                    },
                    { type: "tool_use", id: "call-live", name: "read", input: {} },
                ],
            },
            {
                info: { id: "assistant-latest", role: "assistant" },
                parts: [{ type: "text", text: "newest assistant remains the mutation boundary" }],
            },
        ] as unknown as MessageLike[];

        insertTag(db, sessionId, "call-between", "tool", 100, 1, 0, "read");
        padRecentToolSkeletonWindow(sessionId, 1);
        queuePendingOp(db, sessionId, 1, "drop", 1);

        const foldMessages = cloneMessages(template);
        const foldBatch = new ToolMutationBatch(foldMessages);
        const foldTargets = new Map<number, TagTarget>();
        addToolTarget({
            targets: foldTargets,
            index: buildToolCallIndex(foldMessages),
            batch: foldBatch,
            callId: "call-between",
            tagNumber: 1,
        });
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, foldMessages, {
                schedulerDecision: "execute",
                contextUsage: { percentage: 60, inputTokens: 6000 },
                currentTurnId: "turn-final-adjacency",
                resolvedProviderID: "anthropic",
                tags: getActiveTagsBySession(db, sessionId),
                targets: foldTargets,
                batch: foldBatch,
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );
        expect(foldMessages.some((message) => message.info.id === "drop-only")).toBe(false);
        expect(getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === 1)?.status).toBe(
            "dropped",
        );

        const deferMessages = cloneMessages(template);
        const deferBatch = new ToolMutationBatch(deferMessages);
        const deferTargets = new Map<number, TagTarget>();
        addToolTarget({
            targets: deferTargets,
            index: buildToolCallIndex(deferMessages),
            batch: deferBatch,
            callId: "call-between",
            tagNumber: 1,
        });
        expect(
            applyFlushedStatuses(sessionId, db, deferTargets, getTagsBySession(db, sessionId)),
        ).toBe(true);
        deferBatch.finalize();
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, deferMessages, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
                tags: getActiveTagsBySession(db, sessionId),
                targets: deferTargets,
                batch: deferBatch,
                didMutateFromFlushedStatuses: true,
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );

        const foldWire = serializeAnthropicWirePrefix(foldMessages);
        expect(serializeAnthropicWirePrefix(deferMessages)).toBe(foldWire);
        expect(foldWire).not.toContain("reasoning invalid after merge");
        expect(foldWire).not.toContain("signature-invalid-after-merge");

        const beforeSecondFinalization = JSON.stringify(foldMessages);
        expect(finalizeMessageRepresentation(foldMessages, "anthropic")).toEqual({
            clearedParts: 0,
            mergedReasoningParts: 0,
        });
        expect(JSON.stringify(foldMessages)).toBe(beforeSecondFinalization);

        const nonAnthropicMessages = cloneMessages([
            {
                info: { id: "first", role: "assistant" },
                parts: [{ type: "text", text: "first" }],
            },
            {
                info: { id: "second", role: "assistant" },
                parts: [
                    { type: "thinking", thinking: "[cleared]", signature: "keep-cleared-shell" },
                    {
                        type: "reasoning",
                        text: "provider-specific reasoning",
                        metadata: { anthropic: { signature: "keep-provider-signature" } },
                    },
                ],
            },
        ] as unknown as MessageLike[]);
        const nonAnthropicBefore = JSON.stringify(nonAnthropicMessages);
        expect(finalizeMessageRepresentation(nonAnthropicMessages, "github-copilot")).toEqual({
            clearedParts: 0,
            mergedReasoningParts: 0,
        });
        expect(JSON.stringify(nonAnthropicMessages)).toBe(nonAnthropicBefore);
    });

    it("recovers a bound newest thinking block once and replays the sentinel byte-stably", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-fable-binding-recovery";
        const buildMessages = () =>
            [
                {
                    info: { id: "user-prefix", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "mutated prefix" }],
                },
                {
                    info: { id: "assistant-bound", role: "assistant", sessionID: sessionId },
                    parts: [
                        {
                            type: "thinking",
                            thinking: "signed thinking bound to the old prefix",
                            signature: "bound-signature",
                        },
                        { type: "text", text: "completed answer" },
                    ],
                },
                {
                    info: { id: "retry-user", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "continue" }],
                },
            ] as unknown as MessageLike[];

        armThinkingBindingRecovery(db, sessionId);
        const recoveryMessages = buildMessages();
        const recovery = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, recoveryMessages, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
                thinkingBindingRecoveryEnabledForModel: true,
            }),
        );

        expect(recovery.thinkingBindingRecovery).toEqual({
            flagTarget: "newest_reasoning_bearing_assistant",
            messageId: "assistant-bound",
        });
        expect(findMessage(recoveryMessages, "assistant-bound").parts[0]).toEqual({
            type: "text",
            text: "",
        });
        // Postprocessing does not consume the recovery flag. Only a successful live
        // transform clears it, so a last-known-good fallback cannot clear recovery
        // for an output that was not successfully transformed.
        expect(getThinkingBindingRecoveryTarget(db, sessionId)).toBe(
            "newest_reasoning_bearing_assistant",
        );
        expect(
            clearThinkingBindingRecoveryIf(
                db,
                sessionId,
                recovery.thinkingBindingRecovery.flagTarget,
            ),
        ).toBe(true);
        expect(getThinkingBindingRecoveryTarget(db, sessionId)).toBeNull();

        const replayMessages = buildMessages();
        const replay = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, replayMessages, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
                thinkingBindingRecoveryEnabledForModel: true,
            }),
        );
        expect(replay.thinkingBindingRecovery).toBeNull();
        expect(serializeAnthropicWirePrefix(replayMessages)).toBe(
            serializeAnthropicWirePrefix(recoveryMessages),
        );
    });

    it("recovers a bound thinking block through Rust-mode host postprocess", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-fable-binding-recovery-rust";
        const buildMessages = () =>
            [
                {
                    info: { id: "assistant-bound", role: "assistant", sessionID: sessionId },
                    parts: [
                        {
                            type: "thinking",
                            thinking: "signed thinking bound to the rejected prefix",
                            signature: "bound-signature",
                        },
                        { type: "text", text: "completed answer" },
                    ],
                },
                {
                    info: { id: "retry-user", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "continue" }],
                },
            ] as unknown as MessageLike[];
        const postprocess = (messages: MessageLike[]) =>
            runRustModePostprocess({
                db,
                sessionId,
                messages,
                fullFeatureMode: true,
                resolvedProviderID: "anthropic",
                thinkingBindingRecoveryEnabledForModel: true,
                tagger: createTagger(),
                ctxReduceAvailability: { callable: true, frozen: true },
            });

        armThinkingBindingRecovery(db, sessionId);
        const recoveryMessages = buildMessages();
        const recovery = postprocess(recoveryMessages);

        expect(recovery.thinkingBindingRecovery).toEqual({
            flagTarget: "newest_reasoning_bearing_assistant",
            messageId: "assistant-bound",
        });
        expect(findMessage(recoveryMessages, "assistant-bound").parts[0]).toEqual({
            type: "text",
            text: "",
        });
        expect(getThinkingBindingRecoveryTarget(db, sessionId)).toBe(
            "newest_reasoning_bearing_assistant",
        );
        expect(
            clearThinkingBindingRecoveryIf(
                db,
                sessionId,
                recovery.thinkingBindingRecovery.flagTarget,
            ),
        ).toBe(true);

        const replayMessages = buildMessages();
        const replay = postprocess(replayMessages);
        expect(replay.thinkingBindingRecovery).toBeNull();
        expect(serializeAnthropicWirePrefix(replayMessages)).toBe(
            serializeAnthropicWirePrefix(recoveryMessages),
        );
    });

    it("lets Rust module trailing-blank output outrank host keep decisions", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-rust-trailing-blank-authority";
        addTrailingBlankDecisions(db, sessionId, [
            ["assistant-stripped", "keep"],
            ["assistant-kept", "keep:2"],
            ["assistant-absorbing", "strip"],
        ]);
        const messages = [
            {
                info: { id: "assistant-stripped", role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: "module stripped suffix" }],
            },
            {
                info: { id: "assistant-kept", role: "assistant", sessionID: sessionId },
                parts: [
                    { type: "text", text: "module kept suffix" },
                    { type: "text", text: " " },
                ],
            },
            {
                info: { id: "assistant-absorbing", role: "assistant", sessionID: sessionId },
                parts: [
                    { type: "text", text: "strip stays absorbing" },
                    { type: "text", text: "" },
                ],
            },
        ] as unknown as MessageLike[];
        const beforeStripped = JSON.stringify(messages[0]?.parts);
        const beforeKept = JSON.stringify(messages[1]?.parts);

        runRustModePostprocess({
            db,
            sessionId,
            messages,
            fullFeatureMode: true,
            resolvedProviderID: "anthropic",
            trailingBlankSourceDecisions: new Map([
                ["assistant-stripped", "strip"],
                ["assistant-kept", "keep:2"],
                ["assistant-absorbing", "keep"],
            ]),
            trailingBlankNewestAssistantId: "assistant-absorbing",
            tagger: createTagger(),
            ctxReduceAvailability: { callable: true, frozen: true },
        });

        expect(JSON.stringify(messages[0]?.parts)).toBe(beforeStripped);
        expect(JSON.stringify(messages[1]?.parts)).toBe(beforeKept);
        expect(messages[2]?.parts).toEqual([{ type: "text", text: "strip stays absorbing" }]);
        expect(getTrailingBlankDecisions(db, sessionId).get("assistant-absorbing")).toBe("strip");
    });

    it("leaves newest thinking byte-identical when no binding recovery was classified", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-fable-binding-inert";
        const messages = [
            {
                info: { id: "assistant-newest", role: "assistant", sessionID: sessionId },
                parts: [
                    { type: "thinking", thinking: "keep me", signature: "keep-signature" },
                    { type: "text", text: "answer" },
                ],
            },
        ] as unknown as MessageLike[];
        const before = JSON.stringify(messages);

        const result = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
            }),
        );

        expect(result.thinkingBindingRecovery).toBeNull();
        expect(JSON.stringify(messages)).toBe(before);
        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(new Set());
    });

    it("freezes first merged-strip application onto a bust and replays it across fresh rebuilds", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-merged-reasoning-transition";
        const buildMessages = (includeNewest: boolean): MessageLike[] => {
            const messages = [
                {
                    info: { id: "user", role: "user" },
                    parts: [{ type: "text", text: "continue" }],
                },
                {
                    info: { id: "assistant-first", role: "assistant" },
                    parts: [{ type: "text", text: "first assistant content" }],
                },
                {
                    info: { id: "assistant-transitioned", role: "assistant" },
                    parts: [
                        {
                            type: "thinking",
                            thinking: "accepted while newest",
                            signature: "accepted-signature",
                        },
                        { type: "text", text: "tool-use continuation" },
                    ],
                },
            ] as unknown as MessageLike[];
            if (includeNewest) {
                messages.push({
                    info: { id: "assistant-newest", role: "assistant" },
                    parts: [{ type: "text", text: "new newest assistant" }],
                } as unknown as MessageLike);
            }
            return messages;
        };

        const acceptedPass = buildMessages(false);
        const acceptedTarget = findMessage(acceptedPass, "assistant-transitioned");
        const acceptedBytes = JSON.stringify(acceptedTarget.parts);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, acceptedPass, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
            }),
        );
        expect(JSON.stringify(acceptedTarget.parts)).toBe(acceptedBytes);

        // Pass N: the same persisted assistant is no longer newest, but a defer
        // cannot alter bytes that Anthropic already accepted while it was exempt.
        const transitionedDefer = buildMessages(true);
        const deferTarget = findMessage(transitionedDefer, "assistant-transitioned");
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, transitionedDefer, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
            }),
        );
        expect(JSON.stringify(deferTarget.parts)).toBe(acceptedBytes);
        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(new Set());

        // Pass N+1: execute is the existing cache-busting gate, so first
        // application and persistence happen together.
        const bustMessages = buildMessages(true);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, bustMessages, {
                schedulerDecision: "execute",
                resolvedProviderID: "anthropic",
            }),
        );
        const bustTarget = findMessage(bustMessages, "assistant-transitioned");
        expect(bustTarget.parts[0]).toEqual({ type: "text", text: "" });
        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(
            new Set([
                "assistant-transitioned",
                '__merged_reasoning_parts_v1__:["assistant-transitioned",[0]]',
            ]),
        );
        expect(getMergedReasoningStrippedIds(db, sessionId).has("assistant-newest")).toBe(false);

        // Pass N+2: OpenCode rebuilt every object, but id-keyed replay reproduces
        // the stripped wire exactly without opening detection on the defer.
        const replayMessages = buildMessages(true);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, replayMessages, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
            }),
        );
        expect(serializeAnthropicWirePrefix(replayMessages)).toBe(
            serializeAnthropicWirePrefix(bustMessages),
        );
        expect(findMessage(replayMessages, "assistant-transitioned").parts[0]).toEqual({
            type: "text",
            text: "",
        });
    });

    it("mints from the raw store shape instead of a composed trailing sentinel", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-trailing-blank-artifact-observation";
        const rawStoreMessages = [
            {
                info: { id: "assistant-sibling", role: "assistant" },
                parts: [{ type: "text", text: "leading sibling text" }],
            },
            {
                info: { id: "assistant-target", role: "assistant" },
                parts: [
                    { type: "step-start", snapshot: "raw-store-step" },
                    { type: "reasoning", text: "merged reasoning", signature: "sig" },
                    { type: "tool", callID: "call-1", state: { status: "completed" } },
                    { type: "step-finish", reason: "tool-calls" },
                ],
            },
            {
                info: { id: "assistant-newest", role: "assistant" },
                parts: [{ type: "text", text: "newest" }],
            },
        ] as unknown as MessageLike[];
        const trailingBlankSourceDecisions = snapshotTrailingBlankSourceDecisions(rawStoreMessages);
        const messages = cloneMessages(rawStoreMessages);
        stripStructuralNoise(messages);
        expect(findMessage(messages, "assistant-target").parts.at(-1)).toEqual({
            type: "text",
            text: "",
        });
        addMergedReasoningStrippedIds(db, sessionId, ["assistant-target"]);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "execute",
                resolvedProviderID: "anthropic",
                trailingBlankSourceDecisions,
            }),
        );

        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(
            new Set(["assistant-target", '__merged_reasoning_parts_v1__:["assistant-target",[1]]']),
        );
        expect(getTrailingBlankDecisions(db, sessionId).get("assistant-target")).toBe("strip");
        expect(findMessage(messages, "assistant-target").parts.at(-1)).toMatchObject({
            type: "tool",
            callID: "call-1",
        });
    });

    it("heals poisoned keeps only on a bust and replays the healed strip byte-stably", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-trailing-blank-poison-heal";
        const buildPass = () => {
            const rawStoreMessages = [
                {
                    info: { id: "assistant-sibling", role: "assistant" },
                    parts: [{ type: "text", text: "leading sibling text" }],
                },
                {
                    info: { id: "assistant-poisoned", role: "assistant" },
                    parts: [
                        { type: "step-start", snapshot: "raw-store-step" },
                        { type: "reasoning", text: "merged reasoning", signature: "sig" },
                        { type: "tool", callID: "call-poisoned", state: { status: "completed" } },
                        { type: "step-finish", reason: "tool-calls" },
                    ],
                },
                {
                    info: { id: "assistant-newest", role: "assistant" },
                    parts: [{ type: "text", text: "newest" }],
                },
            ] as unknown as MessageLike[];
            const trailingBlankSourceDecisions =
                snapshotTrailingBlankSourceDecisions(rawStoreMessages);
            const messages = cloneMessages(rawStoreMessages);
            stripStructuralNoise(messages);
            return { messages, trailingBlankSourceDecisions };
        };
        addMergedReasoningStrippedIds(db, sessionId, ["assistant-poisoned"]);
        addTrailingBlankDecisions(db, sessionId, [["assistant-poisoned", "keep"]]);

        const preBustDefer = buildPass();
        const expectedPreBustTargetParts = structuredClone(
            findMessage(preBustDefer.messages, "assistant-poisoned").parts,
        );
        expectedPreBustTargetParts[1] = { type: "text", text: "" };
        const expectedPreBustBytes = JSON.stringify(expectedPreBustTargetParts);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, preBustDefer.messages, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
                trailingBlankSourceDecisions: preBustDefer.trailingBlankSourceDecisions,
            }),
        );
        expect(JSON.stringify(findMessage(preBustDefer.messages, "assistant-poisoned").parts)).toBe(
            expectedPreBustBytes,
        );
        expect(getTrailingBlankDecisions(db, sessionId).get("assistant-poisoned")).toBe("keep");

        const sessionLog = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
        let bustBytes = "";
        try {
            const bust = buildPass();
            const result = await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, bust.messages, {
                    schedulerDecision: "execute",
                    resolvedProviderID: "anthropic",
                    trailingBlankSourceDecisions: bust.trailingBlankSourceDecisions,
                }),
            );
            const bustTarget = findMessage(bust.messages, "assistant-poisoned");
            bustBytes = JSON.stringify(bustTarget.parts);

            expect(result.bustedThisPass).toBe(true);
            expect(getTrailingBlankDecisions(db, sessionId).get("assistant-poisoned")).toBe(
                "strip",
            );
            expect(bustTarget.parts.at(-1)).toMatchObject({
                type: "tool",
                callID: "call-poisoned",
            });
            expect(
                sessionLog.mock.calls.filter(
                    (call) =>
                        call[0] === sessionId &&
                        typeof call[1] === "string" &&
                        call[1].includes("demoted message assistant-poisoned from keep to strip"),
                ),
            ).toHaveLength(1);
        } finally {
            sessionLog.mockRestore();
        }

        for (let replayIndex = 0; replayIndex < 2; replayIndex += 1) {
            const replay = buildPass();
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, replay.messages, {
                    schedulerDecision: "defer",
                    resolvedProviderID: "anthropic",
                    trailingBlankSourceDecisions: replay.trailingBlankSourceDecisions,
                }),
            );
            expect(JSON.stringify(findMessage(replay.messages, "assistant-poisoned").parts)).toBe(
                bustBytes,
            );
        }
    });

    it("does not first-apply a marker-absent poison heal when the id returns on defer", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-trailing-blank-marker-absence";
        const buildPass = () => {
            const rawStoreMessages = [
                {
                    info: { id: "assistant-poisoned", role: "assistant" },
                    parts: [
                        { type: "text", text: "answer before structural marker" },
                        { type: "step-finish", reason: "tool-calls" },
                    ],
                },
                {
                    info: { id: "assistant-newest", role: "assistant" },
                    parts: [{ type: "text", text: "newest" }],
                },
            ] as unknown as MessageLike[];
            const trailingBlankSourceDecisions =
                snapshotTrailingBlankSourceDecisions(rawStoreMessages);
            const messages = cloneMessages(rawStoreMessages);
            stripStructuralNoise(messages);
            return { messages, trailingBlankSourceDecisions };
        };
        addTrailingBlankDecisions(db, sessionId, [["assistant-poisoned", "keep"]]);

        const markerAbsent = buildPass();
        markerAbsent.messages.splice(0, 1);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, markerAbsent.messages, {
                schedulerDecision: "execute",
                resolvedProviderID: "anthropic",
                trailingBlankSourceDecisions: markerAbsent.trailingBlankSourceDecisions,
            }),
        );
        expect(getTrailingBlankDecisions(db, sessionId).get("assistant-poisoned")).toBe("keep");

        const defer = buildPass();
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, defer.messages, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
                trailingBlankSourceDecisions: defer.trailingBlankSourceDecisions,
            }),
        );
        const deferBytes = JSON.stringify(findMessage(defer.messages, "assistant-poisoned").parts);
        expect(findMessage(defer.messages, "assistant-poisoned").parts.at(-1)).toEqual({
            type: "text",
            text: "",
        });
        expect(getTrailingBlankDecisions(db, sessionId).get("assistant-poisoned")).toBe("keep");

        const visibleBust = buildPass();
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, visibleBust.messages, {
                schedulerDecision: "execute",
                resolvedProviderID: "anthropic",
                trailingBlankSourceDecisions: visibleBust.trailingBlankSourceDecisions,
            }),
        );
        expect(getTrailingBlankDecisions(db, sessionId).get("assistant-poisoned")).toBe("strip");
        expect(
            JSON.stringify(findMessage(visibleBust.messages, "assistant-poisoned").parts),
        ).not.toBe(deferBytes);
        expect(findMessage(visibleBust.messages, "assistant-poisoned").parts.at(-1)).toEqual({
            type: "text",
            text: "answer before structural marker",
        });
    });

    it("preserves a legitimate provider blank without triggering the poison heal", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-trailing-blank-legitimate-keep";
        const buildPass = () => {
            const rawStoreMessages = [
                {
                    info: { id: "assistant-sibling", role: "assistant" },
                    parts: [{ type: "text", text: "leading sibling text" }],
                },
                {
                    info: { id: "assistant-legitimate", role: "assistant" },
                    parts: [
                        { type: "reasoning", text: "merged reasoning", signature: "sig" },
                        { type: "tool", callID: "call-legitimate", state: { status: "completed" } },
                        { type: "text", text: " " },
                    ],
                },
                {
                    info: { id: "assistant-newest", role: "assistant" },
                    parts: [{ type: "text", text: "newest" }],
                },
            ] as unknown as MessageLike[];
            return {
                messages: cloneMessages(rawStoreMessages),
                trailingBlankSourceDecisions:
                    snapshotTrailingBlankSourceDecisions(rawStoreMessages),
            };
        };
        addMergedReasoningStrippedIds(db, sessionId, ["assistant-legitimate"]);
        addTrailingBlankDecisions(db, sessionId, [["assistant-legitimate", "keep"]]);

        const bust = buildPass();
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, bust.messages, {
                schedulerDecision: "execute",
                resolvedProviderID: "anthropic",
                trailingBlankSourceDecisions: bust.trailingBlankSourceDecisions,
            }),
        );
        const bustBytes = JSON.stringify(findMessage(bust.messages, "assistant-legitimate").parts);
        expect(getTrailingBlankDecisions(db, sessionId).get("assistant-legitimate")).toBe("keep");

        const replay = buildPass();
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, replay.messages, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
                trailingBlankSourceDecisions: replay.trailingBlankSourceDecisions,
            }),
        );
        expect(JSON.stringify(findMessage(replay.messages, "assistant-legitimate").parts)).toBe(
            bustBytes,
        );
        expect(getTrailingBlankDecisions(db, sessionId).get("assistant-legitimate")).toBe("keep");
    });

    it("skips merged-assistant reasoning persistence and stripping in compaction-off mode", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-merged-reasoning-compaction-off";
        const messages = [
            {
                info: { id: "assistant-first", role: "assistant" },
                parts: [{ type: "text", text: "first" }],
            },
            {
                info: { id: "assistant-target", role: "assistant" },
                parts: [{ type: "thinking", thinking: "must remain", signature: "sig" }],
            },
            {
                info: { id: "assistant-newest", role: "assistant" },
                parts: [{ type: "text", text: "newest" }],
            },
        ] as unknown as MessageLike[];
        const before = JSON.stringify(messages);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                compactionOff: true,
                schedulerDecision: "execute",
                resolvedProviderID: "anthropic",
            }),
        );

        expect(JSON.stringify(messages)).toBe(before);
        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(new Set());
    });

    it("strips only historical trailing whitespace while preserving leading and newest blocks", () => {
        const older = {
            info: { id: "assistant-older-whitespace", role: "assistant" },
            parts: [
                { type: "text", text: " " },
                { type: "reasoning", text: "signed thinking" },
                { type: "tool", callID: "call-older", state: { status: "completed" } },
                { type: "text", text: "\t\n" },
            ],
        } as unknown as MessageLike;
        const newest = {
            info: { id: "assistant-newest-whitespace", role: "assistant" },
            parts: [
                { type: "text", text: " " },
                { type: "reasoning", text: "latest signed thinking" },
                { type: "tool", callID: "call-newest", state: { status: "completed" } },
                { type: "text", text: " " },
            ],
        } as unknown as MessageLike;

        const messages = [older, newest];
        finalizeMessageRepresentation(messages, "anthropic", {
            reasoningMutationExemptMessage: newest,
            trailingBlankDecisions: new Map([
                ["assistant-older-whitespace", "strip"],
                ["assistant-newest-whitespace", "keep"],
            ]),
            skipMergedReasoningStrip: true,
        });

        expect(messages[0].parts.map((part) => part.type)).toEqual(["text", "reasoning", "tool"]);
        expect(messages[0].parts[0]).toEqual({ type: "text", text: " " });
        expect(messages[1].parts.at(-1)).toEqual({ type: "text", text: "" });
        expect(older.parts).toHaveLength(4);
    });

    it("retains an Anthropic separator for lone and adjacent terminal reasoning", () => {
        const lone = {
            info: { id: "assistant-lone-reasoning", role: "assistant" },
            parts: [
                { type: "thinking", thinking: "signed", signature: "sig" },
                { type: "text", text: "" },
            ],
        } as unknown as MessageLike;
        const adjacent = {
            info: { id: "assistant-adjacent-reasoning", role: "assistant" },
            parts: [
                { type: "thinking", thinking: "signed", signature: "sig" },
                { type: "redacted_thinking", data: "redacted" },
                { type: "text", text: "" },
            ],
        } as unknown as MessageLike;
        const answered = {
            info: { id: "assistant-answered", role: "assistant" },
            parts: [
                { type: "thinking", thinking: "signed", signature: "sig" },
                { type: "text", text: "answer" },
                { type: "text", text: "" },
            ],
        } as unknown as MessageLike;
        const newest = {
            info: { id: "assistant-newest", role: "assistant" },
            parts: [{ type: "text", text: "newest" }],
        } as unknown as MessageLike;
        const messages = [lone, adjacent, answered, newest];

        finalizeMessageRepresentation(messages, "anthropic", {
            reasoningMutationExemptMessage: newest,
            trailingBlankDecisions: new Map([
                ["assistant-lone-reasoning", "strip"],
                ["assistant-adjacent-reasoning", "strip"],
                ["assistant-answered", "strip"],
            ]),
            skipMergedReasoningStrip: true,
        });

        const providerShape = (message: MessageLike) => {
            const hasSignedReasoning = message.parts.some(
                (part) =>
                    part !== null &&
                    typeof part === "object" &&
                    (part.type === "thinking" || part.type === "redacted_thinking"),
            );
            return message.parts.map((part) => {
                if (
                    hasSignedReasoning &&
                    part !== null &&
                    typeof part === "object" &&
                    part.type === "text" &&
                    part.text === ""
                ) {
                    return "text:space";
                }
                return part !== null && typeof part === "object" ? part.type : typeof part;
            });
        };

        expect(providerShape(messages[0])).toEqual(["thinking", "text:space"]);
        expect(providerShape(messages[1])).toEqual(["thinking", "redacted_thinking", "text:space"]);
        expect(providerShape(messages[2])).toEqual(["thinking", "text"]);
    });

    it("freezes both trailing-blank race outcomes and replays them on defer", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);

        const buildTarget = (includeTrailing: boolean) =>
            ({
                info: { id: "assistant-target", role: "assistant" },
                parts: [
                    { type: "reasoning", text: "signed thinking" },
                    { type: "tool", callID: "call-1", state: { status: "completed" } },
                    ...(includeTrailing ? [{ type: "text", text: " \t" }] : []),
                ],
            }) as unknown as MessageLike;
        const buildNewest = () =>
            ({
                info: { id: "assistant-newest", role: "assistant" },
                parts: [{ type: "text", text: "next" }],
            }) as unknown as MessageLike;

        for (const scenario of [
            {
                sessionId: "ses-trailing-present-first",
                first: true,
                replay: true,
                decision: "keep",
            },
            { sessionId: "ses-trailing-late", first: false, replay: true, decision: "strip" },
        ] as const) {
            const firstMessages = [buildTarget(scenario.first)];
            await runPostTransformPhase(
                basePostTransformArgs(db, scenario.sessionId, firstMessages, {
                    schedulerDecision: "execute",
                    resolvedProviderID: "anthropic",
                }),
            );
            const firstBytes = JSON.stringify(firstMessages[0].parts);
            expect(getTrailingBlankDecisions(db, scenario.sessionId)).toEqual(
                new Map([["assistant-target", scenario.decision]]),
            );

            const replayTarget = buildTarget(scenario.replay);
            const replayMessages = [replayTarget, buildNewest()];
            await runPostTransformPhase(
                basePostTransformArgs(db, scenario.sessionId, replayMessages, {
                    schedulerDecision: "defer",
                    resolvedProviderID: "anthropic",
                }),
            );
            expect(JSON.stringify(replayMessages[0].parts)).toBe(firstBytes);
        }
    });

    it("bounds a decisionless historical late blank at the next bust", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-trailing-blank-decisionless-late";
        const buildMessages = () =>
            [
                {
                    info: { id: "assistant-late", role: "assistant" },
                    parts: [
                        { type: "text", text: "historical answer" },
                        { type: "text", text: " \t" },
                    ],
                },
                {
                    info: { id: "assistant-newest", role: "assistant" },
                    parts: [{ type: "text", text: "newest answer" }],
                },
            ] as unknown as MessageLike[];

        const deferMessages = buildMessages();
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, deferMessages, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
            }),
        );
        const deferBytes = JSON.stringify(findMessage(deferMessages, "assistant-late").parts);
        expect(getTrailingBlankDecisions(db, sessionId).has("assistant-late")).toBe(false);
        expect(findMessage(deferMessages, "assistant-late").parts.at(-1)).toEqual({
            type: "text",
            text: " \t",
        });

        const bustMessages = buildMessages();
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, bustMessages, {
                schedulerDecision: "execute",
                resolvedProviderID: "anthropic",
            }),
        );
        expect(getTrailingBlankDecisions(db, sessionId).get("assistant-late")).toBe("keep");
        expect(findMessage(bustMessages, "assistant-late").parts.at(-1)).toEqual({
            type: "text",
            text: "",
        });
        const bustBytes = JSON.stringify(findMessage(bustMessages, "assistant-late").parts);
        expect(bustBytes).not.toBe(deferBytes);

        const replayMessages = buildMessages();
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, replayMessages, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
            }),
        );
        expect(JSON.stringify(findMessage(replayMessages, "assistant-late").parts)).toBe(bustBytes);
    });

    it("freezes defer-served trailing shapes before late provider blanks arrive", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);

        const fixtures = [
            {
                name: "tool-use-terminal",
                firstParts: [
                    {
                        type: "reasoning",
                        text: "signed thinking from the evidence turn",
                        metadata: { anthropic: { signature: "sig-tool-use" } },
                    },
                    {
                        type: "tool",
                        callID: "call-terminal",
                        tool: "TERMINAL",
                        state: { status: "completed", input: { command: "pwd" }, output: "" },
                    },
                ],
                decision: "strip",
            },
            {
                name: "reasoning-terminal",
                firstParts: [
                    {
                        type: "reasoning",
                        text: "signed terminal thinking",
                        metadata: { anthropic: { signature: "sig-reasoning" } },
                    },
                    { type: "text", text: "" },
                ],
                decision: "keep",
            },
            {
                name: "text-terminal",
                firstParts: [{ type: "text", text: "visible answer" }],
                decision: "strip",
            },
            {
                name: "structural-suffix",
                firstParts: [
                    { type: "text", text: "visible answer" },
                    { type: "text", text: "" },
                    { type: "text", text: "" },
                ],
                decision: "keep:2",
            },
            {
                name: "wholly-blank",
                firstParts: [{ type: "text", text: "" }],
                decision: "keep",
            },
        ] as const;

        for (const fixture of fixtures) {
            const sessionId = `ses-defer-trailing-${fixture.name}`;
            const targetId = `assistant-${fixture.name}`;
            const firstMessages = [
                {
                    info: { id: targetId, role: "assistant" },
                    parts: structuredClone(fixture.firstParts),
                },
            ] as unknown as MessageLike[];
            const first = await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, firstMessages, {
                    schedulerDecision: "defer",
                    resolvedProviderID: "anthropic",
                }),
            );
            const firstBytes = JSON.stringify(firstMessages[0].parts);

            expect(first.bustedThisPass).toBe(false);
            expect(getTrailingBlankDecisions(db, sessionId)).toEqual(
                new Map([[targetId, fixture.decision]]),
            );

            const replayMessages = [
                {
                    info: { id: targetId, role: "assistant" },
                    parts: [...structuredClone(fixture.firstParts), { type: "text", text: " " }],
                },
                {
                    info: { id: `${targetId}-newest`, role: "assistant" },
                    parts: [{ type: "text", text: "next turn" }],
                },
            ] as unknown as MessageLike[];
            const replay = await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, replayMessages, {
                    schedulerDecision: "defer",
                    resolvedProviderID: "anthropic",
                }),
            );

            expect(replay.bustedThisPass).toBe(false);
            expect(JSON.stringify(replayMessages[0].parts)).toBe(firstBytes);
        }
    });

    it("keeps an established strip absorbing while its assistant remains newest", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-trailing-live-newest";
        const buildTarget = (includeTrailing: boolean) =>
            ({
                info: { id: "assistant-target", role: "assistant" },
                parts: [
                    {
                        type: "reasoning",
                        text: "signed thinking",
                        metadata: { anthropic: { signature: "sig-live-newest" } },
                    },
                    { type: "tool", callID: "call-live", state: { status: "completed" } },
                    ...(includeTrailing ? [{ type: "text", text: "" }] : []),
                ],
            }) as unknown as MessageLike;

        const firstMessages = [buildTarget(false)];
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, firstMessages, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
            }),
        );
        const firstBytes = JSON.stringify(firstMessages[0].parts);
        expect(getTrailingBlankDecisions(db, sessionId)).toEqual(
            new Map([["assistant-target", "strip"]]),
        );

        for (const includeTrailing of [true, false, true]) {
            const replayMessages = [buildTarget(includeTrailing)];
            const replay = await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, replayMessages, {
                    schedulerDecision: "defer",
                    resolvedProviderID: "anthropic",
                }),
            );
            expect(replay.bustedThisPass).toBe(false);
            expect(JSON.stringify(replayMessages[0].parts)).toBe(firstBytes);
            expect(getTrailingBlankDecisions(db, sessionId)).toEqual(
                new Map([["assistant-target", "strip"]]),
            );
        }
    });

    it("demotes a live keep to an absorbing strip when its source suffix disappears", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-trailing-live-demotion";
        const buildTarget = (trailingCount: number) =>
            [
                {
                    info: { id: "assistant-target", role: "assistant" },
                    parts: [
                        { type: "text", text: "answer" },
                        ...Array.from({ length: trailingCount }, () => ({
                            type: "text",
                            text: "",
                        })),
                    ],
                },
            ] as unknown as MessageLike[];

        const first = buildTarget(1);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, first, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
            }),
        );
        expect(getTrailingBlankDecisions(db, sessionId).get("assistant-target")).toBe("keep");

        const recounted = buildTarget(3);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, recounted, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
            }),
        );
        expect(getTrailingBlankDecisions(db, sessionId).get("assistant-target")).toBe("keep:3");
        expect(recounted[0].parts).toHaveLength(4);

        const demoted = buildTarget(0);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, demoted, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
            }),
        );
        expect(getTrailingBlankDecisions(db, sessionId).get("assistant-target")).toBe("strip");

        const replay = buildTarget(1);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, replay, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
            }),
        );
        expect(replay[0].parts).toEqual([{ type: "text", text: "answer" }]);
        expect(getTrailingBlankDecisions(db, sessionId).get("assistant-target")).toBe("strip");
    });

    it("serves the frozen keep count when a live refresh loses its persistence race", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-trailing-refresh-cas-failure";
        addTrailingBlankDecisions(db, sessionId, [["assistant-target", "keep:3"]]);
        db.exec(`
            CREATE TRIGGER reject_trailing_blank_refresh
            BEFORE UPDATE OF trailing_blank_decisions ON session_meta
            WHEN NEW.session_id = '${sessionId}'
            BEGIN
                SELECT RAISE(IGNORE);
            END
        `);
        const messages = [
            {
                info: { id: "assistant-target", role: "assistant" },
                parts: [
                    { type: "text", text: "answer" },
                    { type: "text", text: "" },
                ],
            },
        ] as unknown as MessageLike[];

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
            }),
        );

        expect(messages[0].parts).toEqual([
            { type: "text", text: "answer" },
            { type: "text", text: "" },
            { type: "text", text: "" },
            { type: "text", text: "" },
        ]);
        expect(getTrailingBlankDecisions(db, sessionId).get("assistant-target")).toBe("keep:3");
    });

    it("keeps incident-geometry history stable across a metadata shell and late blank", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-trailing-incident-geometry";
        const targetParts = (includeFinish: boolean, includeLateBlank: boolean) => [
            {
                type: "reasoning",
                text: "signed thinking",
                metadata: { anthropic: { signature: "sig-incident" } },
            },
            { type: "tool", callID: "call-incident", state: { status: "completed" } },
            ...(includeFinish ? [{ type: "step-finish", reason: "tool-calls" }] : []),
            ...(includeLateBlank ? [{ type: "text", text: "" }] : []),
        ];
        const rawPass = (
            includeFinish: boolean,
            nextParts?: MessageLike["parts"],
            includeLateBlank = false,
        ) =>
            [
                {
                    info: { id: "assistant-target", role: "assistant" },
                    parts: targetParts(includeFinish, includeLateBlank),
                },
                ...(nextParts
                    ? [
                          {
                              info: { id: "assistant-next", role: "assistant" },
                              parts: nextParts,
                          },
                      ]
                    : []),
            ] as unknown as MessageLike[];
        const serve = async (rawMessages: MessageLike[]) => {
            const sourceDecisions = snapshotTrailingBlankSourceDecisions(rawMessages);
            const messages = cloneMessages(rawMessages);
            stripStructuralNoise(messages);
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    schedulerDecision: "defer",
                    resolvedProviderID: "anthropic",
                    trailingBlankSourceDecisions: sourceDecisions,
                }),
            );
            return messages;
        };

        await serve(rawPass(false));
        const streaming = await serve(rawPass(false));
        const passOne = await serve(rawPass(true, [{ type: "meta", trace: "shell" }]));
        // The metadata-only shell is transient: the next ingress snapshot can expose the
        // previous assistant as newest while the harness appends its late blank.
        const lateBlank = await serve(rawPass(true, undefined, true));
        const passTwo = await serve(rawPass(true, [{ type: "text", text: "next" }]));
        const targetBytes = [streaming, passOne, lateBlank, passTwo].map((messages) =>
            JSON.stringify(findMessage(messages, "assistant-target").parts),
        );

        expect(new Set(targetBytes).size).toBe(1);
        expect(getTrailingBlankDecisions(db, sessionId).get("assistant-target")).toBe("strip");
    });

    it("migrates only a newest frozen-strip suffix on the first deployment pass", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-trailing-deployment-regression";
        const messages = [
            {
                info: { id: "historical-strip", role: "assistant" },
                parts: [
                    { type: "reasoning", text: "terminal reasoning", signature: "sig" },
                    { type: "text", text: "" },
                ],
            },
            {
                info: { id: "historical-keep", role: "assistant" },
                parts: [
                    { type: "text", text: "kept" },
                    { type: "text", text: "" },
                ],
            },
            {
                info: { id: "historical-keep-three", role: "assistant" },
                parts: [
                    { type: "text", text: "kept three" },
                    { type: "text", text: "" },
                    { type: "text", text: "" },
                    { type: "text", text: "" },
                ],
            },
            {
                info: { id: "newest-strip", role: "assistant" },
                parts: [
                    { type: "text", text: "newest answer" },
                    { type: "text", text: "" },
                ],
            },
        ] as unknown as MessageLike[];
        addTrailingBlankDecisions(db, sessionId, [
            ["historical-strip", "strip"],
            ["historical-keep", "keep"],
            ["historical-keep-three", "keep:3"],
            ["newest-strip", "strip"],
        ]);
        const before = new Map(
            messages.map((message) => [message.info.id, JSON.stringify(message.parts)]),
        );

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
            }),
        );

        for (const id of ["historical-strip", "historical-keep", "historical-keep-three"]) {
            expect(JSON.stringify(findMessage(messages, id).parts)).toBe(before.get(id));
        }
        expect(JSON.stringify(findMessage(messages, "newest-strip").parts)).not.toBe(
            before.get("newest-strip"),
        );
        expect(findMessage(messages, "historical-strip").parts.at(-1)).toEqual({
            type: "text",
            text: "",
        });
        expect(findMessage(messages, "newest-strip").parts.at(-1)).toEqual({
            type: "text",
            text: "newest answer",
        });
        expect(getTrailingBlankDecisions(db, sessionId)).toEqual(
            new Map([
                ["historical-strip", "strip"],
                ["historical-keep", "keep"],
                ["historical-keep-three", "keep:3"],
                ["newest-strip", "strip"],
            ]),
        );
    });

    it("prevents a three-turn late-blank storm without opening the defer gate", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-three-turn-late-blank-storm";
        const firstServedBytes = new Map<string, string>();
        const buildAssistant = (turn: number, includeTrailing: boolean): MessageLike =>
            ({
                info: { id: `assistant-turn-${turn}`, role: "assistant" },
                parts: [
                    {
                        type: "reasoning",
                        text: `signed thinking ${turn}`,
                        metadata: { anthropic: { signature: `sig-${turn}` } },
                    },
                    {
                        type: "tool",
                        callID: `call-${turn}`,
                        tool: "TERMINAL",
                        state: { status: "completed", input: {}, output: "" },
                    },
                    ...(includeTrailing ? [{ type: "text", text: " " }] : []),
                ],
            }) as unknown as MessageLike;

        for (let currentTurn = 0; currentTurn <= 3; currentTurn += 1) {
            const messages: MessageLike[] = [];
            for (let turn = 0; turn <= currentTurn; turn += 1) {
                messages.push(buildAssistant(turn, turn < currentTurn));
                if (turn < currentTurn) {
                    messages.push({
                        info: { id: `user-turn-${turn + 1}`, role: "user" },
                        parts: [{ type: "text", text: `continue ${turn + 1}` }],
                    } as unknown as MessageLike);
                }
            }

            const result = await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    schedulerDecision: "defer",
                    resolvedProviderID: "anthropic",
                }),
            );
            expect(result.bustedThisPass).toBe(false);

            for (let turn = 0; turn <= currentTurn; turn += 1) {
                const assistant = messages.find(
                    (candidate) => candidate.info.id === `assistant-turn-${turn}`,
                );
                expect(assistant).toBeDefined();
                const bytes = JSON.stringify(assistant?.parts);
                const firstBytes = firstServedBytes.get(`assistant-turn-${turn}`);
                if (firstBytes === undefined) {
                    firstServedBytes.set(`assistant-turn-${turn}`, bytes);
                } else {
                    expect(bytes).toBe(firstBytes);
                }
            }
        }

        expect(getTrailingBlankDecisions(db, sessionId)).toEqual(
            new Map([
                ["assistant-turn-0", "strip"],
                ["assistant-turn-1", "strip"],
                ["assistant-turn-2", "strip"],
                ["assistant-turn-3", "strip"],
            ]),
        );
    });

    it("preserves the newest assistant reasoning through final representation", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-final-representation-newest-reasoning";
        const latest = {
            info: { id: "assistant-latest", role: "assistant" },
            parts: [
                {
                    type: "thinking",
                    thinking: "latest signed thinking",
                    signature: "latest-signature",
                },
                { type: "redacted_thinking", data: "latest-redacted-data" },
                { type: "text", text: "latest continuation" },
            ],
        } as unknown as MessageLike;
        const messages = [
            {
                info: { id: "user", role: "user" },
                parts: [{ type: "text", text: "continue the tool-use turn" }],
            },
            {
                info: { id: "assistant-first", role: "assistant" },
                parts: [
                    { type: "reasoning", text: "first reasoning" },
                    { type: "text", text: "first step" },
                ],
            },
            {
                info: { id: "assistant-older", role: "assistant" },
                parts: [
                    { type: "thinking", thinking: "older merged reasoning" },
                    { type: "text", text: "older step" },
                ],
            },
            latest,
        ] as unknown as MessageLike[];
        const latestBefore = JSON.stringify(latest.parts.slice(0, 2));

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
            }),
        );

        expect(messages[2]?.parts[0]).toEqual({
            type: "thinking",
            thinking: "older merged reasoning",
        });
        expect(JSON.stringify(latest.parts.slice(0, 2))).toBe(latestBefore);
    });

    it("matches the former full cleared-reasoning walk on a mixed final fixture", () => {
        const fixture = [
            {
                info: { role: "user", syntheticHead: true },
                parts: [
                    {
                        type: "text",
                        text: "<session-history>cached history</session-history>",
                        synthetic: true,
                    },
                ],
            },
            {
                info: { id: "synthetic-carrier", role: "assistant" },
                parts: [
                    { type: "reasoning", text: "[cleared]", signature: "new-head-signature" },
                    { type: "tool", callID: "todo", state: { input: { todos: [] }, output: "ok" } },
                ],
            },
            {
                info: { id: "placeholder", role: "assistant" },
                parts: [{ type: "text", text: "[dropped §3§]" }],
            },
            {
                info: { id: "merged-a", role: "assistant" },
                parts: [
                    { type: "reasoning", text: "signed reasoning", signature: "keep-signature" },
                    { type: "text", text: "<thinking>inline trace</thinking>answer" },
                    { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" },
                ],
            },
            {
                info: { id: "merged-b", role: "assistant" },
                parts: [
                    { type: "thinking", thinking: "[cleared]", signature: "late-drop-signature" },
                    { type: "text", text: "merged assistant tail" },
                ],
            },
        ] as unknown as MessageLike[];
        const fullWalk = cloneMessages(fixture);
        const targeted = cloneMessages(fixture);
        const targetedLateMutation = targeted.find((message) => message.info.id === "merged-b")!;

        const oldResult = finalizeMessageRepresentation(fullWalk, "anthropic");
        const targetedResult = finalizeMessageRepresentation(targeted, "anthropic", {
            prependedMessageCount: 2,
            reasoningMutatedMessages: [targetedLateMutation],
        });

        expect(targetedResult).toEqual(oldResult);
        expect(JSON.stringify(targeted)).toBe(JSON.stringify(fullWalk));
    });
});

const TODO_ACTIVE_STATE = JSON.stringify([
    { content: "Build feature", status: "in_progress", priority: "high" },
    { content: "Write tests", status: "pending", priority: "medium" },
]);

/**
 * Drive the REAL runPostTransformPhase todo-synthesis block (B7) with an
 * explicit todowrite-availability verdict and scheduler decision, so the
 * disabled-tool gate is exercised against production code rather than a mirror.
 * `schedulerDecision: "execute"` is a cache-busting pass; `"defer"` replays.
 */
async function runTodoGatePass(args: {
    sessionId: string;
    messages: MessageLike[];
    schedulerDecision: "execute" | "defer";
    todowriteAvailability: { callable: boolean; frozen: boolean };
    client?: PostTransformArgs["client"];
}): Promise<void> {
    const tagger = createTagger();
    const tagged = tagMessages(args.sessionId, args.messages, tagger, db);
    await runPostTransformPhase(
        basePostTransformArgs(db, args.sessionId, args.messages, {
            schedulerDecision: args.schedulerDecision,
            tagger,
            targets: tagged.targets,
            reasoningByMessage: tagged.reasoningByMessage,
            messageTagNumbers: tagged.messageTagNumbers,
            batch: tagged.batch,
            todowriteAvailability: args.todowriteAvailability,
            client: args.client,
        }),
    );
}

function buildTodoGateMessages(sessionId: string): MessageLike[] {
    return [
        {
            info: { id: "u1", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "please help" }],
        },
        {
            info: { id: "a1", role: "assistant", sessionID: sessionId, finish: "stop" },
            parts: [{ type: "text", text: "on it" }],
        },
    ] as unknown as MessageLike[];
}

function findTodoPart(messages: MessageLike[]): unknown | null {
    for (const message of messages) {
        for (const part of message.parts) {
            if (isSyntheticTodoPart(part)) return part;
        }
    }
    return null;
}

describe("todo synthesis — disabled todowrite tool gate", () => {
    const UNAVAILABLE = { callable: false, frozen: true };
    const AVAILABLE = { callable: true, frozen: true };

    it("(a) busting pass with todowrite filtered out injects nothing and clears the persisted anchor", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-todo-gate-bust";
        // Stale state + anchor persisted from before the tool was disabled.
        updateSessionMeta(db, sessionId, { lastTodoState: TODO_ACTIVE_STATE });
        setPersistedTodoSyntheticAnchor(
            db,
            sessionId,
            "mc_synthetic_todo_stale",
            "a1",
            TODO_ACTIVE_STATE,
        );

        const messages = buildTodoGateMessages(sessionId);
        await runTodoGatePass({
            sessionId,
            messages,
            schedulerDecision: "execute",
            todowriteAvailability: UNAVAILABLE,
        });

        // No synthetic pair for a tool the session does not have...
        expect(findTodoPart(messages)).toBeNull();
        // ...and the anchor is gone so later defers have nothing to replay.
        expect(getPersistedTodoSyntheticAnchor(db, sessionId)).toBeNull();
    });

    it("(b) unavailable defer keeps replaying the persisted pair byte-identically, then the next bust removes it", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-todo-gate-defer";
        updateSessionMeta(db, sessionId, { lastTodoState: TODO_ACTIVE_STATE });
        const callId = computeSyntheticCallId(TODO_ACTIVE_STATE);
        setPersistedTodoSyntheticAnchor(db, sessionId, callId, "a1", TODO_ACTIVE_STATE);

        // Defer pass while unavailable: the persisted pair is still replayed
        // (removal only rides a busting pass, so the cached prefix stays warm).
        const deferMessages = buildTodoGateMessages(sessionId);
        await runTodoGatePass({
            sessionId,
            messages: deferMessages,
            schedulerDecision: "defer",
            todowriteAvailability: UNAVAILABLE,
        });

        // Exact part bytes: the replayed part equals a fresh build from the
        // PERSISTED snapshot, anchored at the persisted message.
        const replayed = findTodoPart(deferMessages);
        expect(replayed).not.toBeNull();
        const expectedPart = buildSyntheticTodoPart(TODO_ACTIVE_STATE);
        expect(JSON.stringify(replayed)).toBe(JSON.stringify(expectedPart));
        const anchoredMessage = deferMessages.find((message) =>
            message.parts.some((part) => isSyntheticTodoPart(part)),
        );
        expect(anchoredMessage?.info.id).toBe("a1");
        // Anchor survives the defer pass untouched.
        expect(getPersistedTodoSyntheticAnchor(db, sessionId)).toEqual({
            callId,
            messageId: "a1",
            stateJson: TODO_ACTIVE_STATE,
        });

        // Next cache-busting pass detects the unavailable verdict and removes
        // the pair: nothing injected and the anchor is cleared.
        const bustMessages = buildTodoGateMessages(sessionId);
        await runTodoGatePass({
            sessionId,
            messages: bustMessages,
            schedulerDecision: "execute",
            todowriteAvailability: UNAVAILABLE,
        });
        expect(findTodoPart(bustMessages)).toBeNull();
        expect(getPersistedTodoSyntheticAnchor(db, sessionId)).toBeNull();
    });

    it("(c) busting pass with todowrite available keeps the existing injection behavior", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-todo-gate-available";
        updateSessionMeta(db, sessionId, { lastTodoState: TODO_ACTIVE_STATE });

        const messages = buildTodoGateMessages(sessionId);
        await runTodoGatePass({
            sessionId,
            messages,
            schedulerDecision: "execute",
            todowriteAvailability: AVAILABLE,
        });

        const part = findTodoPart(messages);
        expect(part).not.toBeNull();
        expect(JSON.stringify(part)).toBe(
            JSON.stringify(buildSyntheticTodoPart(TODO_ACTIVE_STATE)),
        );
        // Anchor persisted for later defer replays, as before.
        const anchor = getPersistedTodoSyntheticAnchor(db, sessionId);
        expect(anchor?.messageId).toBe("a1");
        expect(anchor?.stateJson).toBe(TODO_ACTIVE_STATE);
    });

    it("retains a persisted denial after restart when the SDK permission read fails", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-todo-gate-cold-cache";
        updateSessionMeta(db, sessionId, { lastTodoState: TODO_ACTIVE_STATE });
        setPersistedTodoPermissionDenied(db, sessionId, true);
        clearToolPermissionDenied(sessionId, "todowrite");
        const failingClient = {
            app: {
                agents: async () => {
                    throw new Error("permission service unavailable");
                },
            },
            session: {
                get: async () => {
                    throw new Error("permission service unavailable");
                },
            },
        } as never;

        const messages = buildTodoGateMessages(sessionId);
        await runTodoGatePass({
            sessionId,
            messages,
            schedulerDecision: "execute",
            todowriteAvailability: AVAILABLE,
            client: failingClient,
        });

        expect(findTodoPart(messages)).toBeNull();
        expect(getPersistedTodoSyntheticAnchor(db, sessionId)).toBeNull();
        expect(getPersistedTodoPermissionDenied(db, sessionId)).toBe(true);
    });

    it("(d) a provisional (not yet frozen) verdict fails open and still injects", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-todo-gate-provisional";
        updateSessionMeta(db, sessionId, { lastTodoState: TODO_ACTIVE_STATE });

        const messages = buildTodoGateMessages(sessionId);
        await runTodoGatePass({
            sessionId,
            messages,
            schedulerDecision: "execute",
            // No first user message processed yet → provisional fail-open verdict.
            todowriteAvailability: { callable: true, frozen: false },
        });

        // Fail-open: injection proceeds exactly as the available case.
        expect(findTodoPart(messages)).not.toBeNull();
        expect(getPersistedTodoSyntheticAnchor(db, sessionId)?.stateJson).toBe(TODO_ACTIVE_STATE);
    });
});

describe("reconcileMarkerRepresentation on rust-mode output heads", () => {
    it("#then inserts the summary after the module-encoded m0/m1 head, never ahead of m0", () => {
        // The Rust module's m0/m1 encode produces ID-less synthetic user
        // messages WITHOUT the TS lane's info.syntheticHead flag. The head
        // walk must still recognize them: requiring the flag spliced the
        // compaction summary in at index 0 — an assistant ahead of m0 —
        // which fails the rust-mode m0 wire invariant on every pass for
        // sessions carrying persisted marker state.
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-marker-rust-head";
        const state = {
            boundaryMessageId: "boundary",
            summaryMessageId: "summary",
            compactionPartId: "compaction",
            summaryPartId: "summary-part",
            boundaryOrdinal: 10,
            targetEndMessageId: "boundary",
        };
        const rustM0 = {
            info: { role: "user", sessionID: sessionId },
            parts: [
                { type: "text", text: "<session-history>…</session-history>", synthetic: true },
            ],
        };
        const rustM1 = {
            info: { role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "(no new history)", synthetic: true }],
        };
        const tail = {
            info: { id: "msg_real1", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "hello" }],
        };
        const messages = [rustM0, rustM1, tail] as unknown as MessageLike[];

        const changed = reconcileMarkerRepresentation(messages, state, {
            db,
            sessionId,
            tagger: createTagger(),
            ctxReduceAvailability: { callable: true, frozen: true },
        });
        expect(changed).toBe(true);
        expect(messages.map((message) => message.info.id)).toEqual([
            undefined,
            undefined,
            "summary",
            "msg_real1",
        ]);
        expect(messages[2]?.info.role).toBe("assistant");
    });
});

describe("marker-drain reasoning representation", () => {
    it("freezes the applying marker-drain strip when the defer batch removes empty predecessors", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-marker-drain-reasoning";
        createOpenCodeDbWithoutMessages("marker-drain-reasoning-");
        const hostDb = new Database(join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db"));
        hostDb
            .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
            .run("boundary", sessionId, 1000, 1000, JSON.stringify({ role: "user" }));
        hostDb.close();
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 10,
                startMessageId: "boundary",
                endMessageId: "boundary",
                title: "history",
                content: "covered",
            },
        ]);
        setPendingCompactionMarkerState(db, sessionId, {
            ordinal: 10,
            endMessageId: "boundary",
            publishedAt: 1,
        });
        const source = (): MessageLike[] =>
            [
                {
                    info: { id: "boundary", role: "user" },
                    parts: [{ type: "text", text: "covered" }],
                },
                {
                    info: { id: "hidden", role: "assistant" },
                    parts: [{ type: "text", text: "[dropped §1§]" }],
                },
                {
                    info: { id: "turn", role: "user" },
                    parts: [{ type: "text", text: "retained turn" }],
                },
                {
                    info: { id: "predecessor", role: "assistant" },
                    parts: [
                        { type: "step-start" },
                        {
                            type: "tool",
                            tool: "read",
                            callID: "read-call",
                            state: { status: "completed", input: {}, output: "old output" },
                        },
                        { type: "step-finish" },
                    ],
                },
                {
                    info: { id: "error-assistant", role: "assistant" },
                    parts: [
                        { type: "step-start" },
                        {
                            id: "signed-part",
                            type: "reasoning",
                            text: "signed reasoning",
                            metadata: { anthropic: { signature: "sig" } },
                        },
                        { type: "text", text: "" },
                        {
                            type: "tool",
                            tool: "aft_zoom",
                            callID: "error-call",
                            state: { status: "error", input: {}, error: "symbol not found" },
                        },
                        { type: "step-finish" },
                    ],
                },
                {
                    info: { id: "newest", role: "assistant" },
                    parts: [{ type: "text", text: "latest response" }],
                },
            ] as MessageLike[];
        const applyingRaw = source();
        const applying = applyingRaw.slice(2);
        const tagger = createTagger();
        // The transform tags applyingRaw so rows hidden by compaction can retain
        // their drop decisions if the host later exposes them again. Tool removal
        // then prunes applyingRaw, leaving empty assistant objects in applying.
        const first = tagMessages(sessionId, applyingRaw, tagger, db);
        expect(first.messageTagNumbers.has(applyingRaw[4])).toBe(false);
        addMergedReasoningStrippedIds(db, sessionId, ["error-assistant"]);
        const readTag = getTagsBySession(db, sessionId).find(
            (tag) => tag.messageId === "read-call",
        )!.tagNumber;
        updateTagStatus(db, sessionId, readTag, "dropped");
        applyFlushedStatuses(sessionId, db, first.targets);
        first.batch.finalize();
        stripStructuralNoise(applying);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, applying, {
                ...first,
                tagger,
                resolvedProviderID: "anthropic",
                deferredMaterializationSessions: new Set([sessionId]),
                hiddenMessagesAtCompactionSeam: [applyingRaw[1]],
                deferredHistoryWasPendingAtPassStart: true,
                historyRebuiltThisPass: true,
                canConsumeDeferredLate: true,
                deferredHistoryRefreshSessions: new Set([sessionId]),
                pendingCompartmentInjection: {
                    block: "",
                    compartmentEndMessage: 10,
                    compartmentEndMessageId: "boundary",
                    compartmentCount: 1,
                    skippedVisibleMessages: 2,
                    factCount: 0,
                    memoryCount: 0,
                    rebuiltFromDb: true,
                },
            }),
        );
        expect(getPersistedCompactionMarkerState(db, sessionId)?.boundaryOrdinal).toBe(10);
        expect(getPendingCompactionMarkerState(db, sessionId)).toBeNull();
        expect(applying.some((m) => m.info.id === "predecessor")).toBe(true);
        const firstAssistant = applying.find((m) => m.info.id === "error-assistant")!;
        expect(firstAssistant.parts.some((p) => (p as { type: string }).type === "reasoning")).toBe(
            false,
        );
        const appliedBytes = JSON.stringify(firstAssistant.parts);
        const frozenBeforeServe = getMergedReasoningStrippedIds(db, sessionId);
        expect(frozenBeforeServe).toEqual(
            new Set([
                "error-assistant",
                '__merged_reasoning_parts_v1__:["error-assistant",["signed-part"]]',
            ]),
        );

        const deferred = source().slice(2);
        const freshTagger = createTagger();
        freshTagger.initFromDb(sessionId, db);
        const second = tagMessages(sessionId, deferred, freshTagger, db);
        applyFlushedStatuses(sessionId, db, second.targets);
        second.batch.finalize();
        stripStructuralNoise(deferred);
        expect(deferred.some((m) => m.info.id === "predecessor")).toBe(false);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, deferred, {
                ...second,
                tagger: freshTagger,
                resolvedProviderID: "anthropic",
            }),
        );
        expect(JSON.stringify(deferred.find((m) => m.info.id === "error-assistant")!.parts)).toBe(
            appliedBytes,
        );
        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(frozenBeforeServe);
    });
});
