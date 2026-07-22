/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import {
    addProcessedImageStrippedIds,
    addStaleReduceStrippedIds,
    getActiveTagsBySession,
    getOrCreateSessionMeta,
    getPendingCompactionMarkerState,
    getProcessedImageStrippedIds,
    getTagsBySession,
    insertTag,
    queueM0Mutation,
    queuePendingOp,
    setPendingCompactionMarkerState,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getPersistedCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { MARKER_SUMMARY_TEXT } from "./compaction-marker-manager";
import { registerActiveCompartmentRun } from "./compartment-runner";
import { estimateMessageTokens } from "./final-wire-token-estimate";
import { injectM0M1, type M0HardSignals } from "./inject-compartments";
import {
    type MessageLike,
    type TagTarget,
    type ThinkingLikePart,
    tagMessages,
} from "./tag-messages";
import { isSyntheticTodoPart } from "./todo-view";
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
    process.env.XDG_DATA_HOME = originalXdgDataHome;
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
        batch: null,
        contextUsage: { percentage: 20, inputTokens: 1000 },
        schedulerDecision: "defer",
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

describe("explicit-only tool reclaim", () => {
    function tagStatuses(sessionId: string): Map<number, string> {
        return new Map(getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]));
    }

    it("does not use a legacy watermark to drop an unrequested tool on execute", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-explicit-only-execute";
        const first = makeToolMessage("tool-1");
        const second = makeToolMessage("tool-2");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        insertTag(db, sessionId, "tool-2", "tool", 4000, 2, 0, "read");
        queuePendingOp(db, sessionId, 1, "drop", 1);
        updateSessionMeta(db, sessionId, { toolReclaimWatermark: 2 });

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
        expect(statuses.get(2)).toBe("active");
        expect((second.parts[0] as { state?: { output?: string } }).state?.output).not.toBe(
            "[dropped]",
        );
        expect(getOrCreateSessionMeta(db, sessionId).toolReclaimWatermark).toBe(2);
    });
});

describe("smart-drops supersession reclaim (flag-gated)", () => {
    function tagStatuses(sessionId: string): Map<number, string> {
        return new Map(getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]));
    }

    // tag 1 performs a real drop, which enables the smart-drops block this pass;
    // tags 2 & 3 are todowrite where the older (2) is superseded by the newer
    // (3), so only the independently configured supersession rule can touch it.
    function seedTodowriteSession(sessionId: string): {
        trigger: MessageLike;
        older: MessageLike;
        newer: MessageLike;
    } {
        const trigger = makeToolMessage("tool-1");
        const older = makeToolMessage("tool-2");
        const newer = makeToolMessage("tool-3");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "edit");
        insertTag(db, sessionId, "tool-2", "tool", 4000, 2, 0, "todowrite");
        insertTag(db, sessionId, "tool-3", "tool", 4000, 3, 0, "todowrite");
        queuePendingOp(db, sessionId, 1, "drop", 1);
        return { trigger, older, newer };
    }

    it("OFF (default): superseded todowrite is NOT dropped even on a mutating execute pass", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-smart-off";
        const { trigger, older, newer } = seedTodowriteSession(sessionId);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [trigger, older, newer], {
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
        const { trigger, older, newer } = seedTodowriteSession(sessionId);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [trigger, older, newer], {
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

    it("ON but plain DEFER pass: nothing is dropped (reclaim block requires a known bust)", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-smart-defer";
        const { trigger, older, newer } = seedTodowriteSession(sessionId);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [trigger, older, newer], {
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

describe("known m[0] hard-fold folds the execute pass in", () => {
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

    it("does not use a legacy watermark to drop an unrequested tool when m[0] HARD-folds", async () => {
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
        updateSessionMeta(db, sessionId, { toolReclaimWatermark: 2 });
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
                        modelKey: "anthropic/sonnet",
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
    it("serializes a late explicit reclaim clear identically on execute and defer", async () => {
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
        queuePendingOp(db, sessionId, 2, "drop", 2);

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
        queuePendingOp(db, sessionId, 2, "drop", 2);

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
});
