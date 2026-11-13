/// <reference types="bun-types" />

/**
 * Review witnesses for a compaction-marker move that a rebuilding pass could
 * not make (the host store's writer was busy, or summary discovery deferred the
 * move). That pass serves its own rebuild with the old marker representation
 * and keeps the pending marker plus the deferred history-refresh signal, so a
 * later pass retries the move.
 *
 * The kept signal makes the next execute pass consume the deferred history
 * again, and the marker drain runs on every pass that consumes history. When
 * the move then succeeds, `reconcileMarkerRepresentation` serves the new
 * marker's summary row right after m[1], on a pass whose own rewrite
 * permission is false: nothing else on it may change the cached prefix. Every
 * other lane asks that one permission; the marker drain does not.
 *
 * Each test drives one session through the OpenCode 1 wrapper and compares the
 * bytes of consecutive served requests.
 */

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    appendCompartments,
    replaceAllCompartments,
} from "../../features/magic-context/compartment-storage";
import { __resetMessageIndexAsyncForTests } from "../../features/magic-context/message-index-async";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getTagsBySession,
    openDatabase,
    queuePendingOp,
    setPendingCompactionMarkerState,
} from "../../features/magic-context/storage";
import { setPersistedCompactionMarkerState } from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { __test as transformDecisionTest } from "../../features/magic-context/transform-decision-log";
import type { ContextUsage } from "../../features/magic-context/types";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import * as loggerModule from "../../shared/logger";
import { SqliteAcquisitionBusyError } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import type { MarkerUpdateOutcome } from "./compaction-marker-manager";
import { injectM0M1 } from "./inject-compartments";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { createTransform } from "./transform";
import { reconcileMarkerRepresentation } from "./transform-postprocess-phase";

type Message = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };
type Output = Parameters<ReturnType<typeof createMessagesTransformHandler>>[1];

/** A model whose signed thinking is bound to every byte in front of it. */
const MODEL = { providerID: "anthropic", modelID: "claude-opus-5-5" };
/**
 * Witnesses for defects that are still open run only with
 * MC_SIGNED_THINKING_OPEN_DEFECTS=1; each names its defect.
 */
const OPEN_DEFECTS = process.env.MC_SIGNED_THINKING_OPEN_DEFECTS === "1";
const BULKY = "BULKY-TOOL-OUTPUT const value = compute(input, options); // line\n".repeat(200);

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

afterEach(() => {
    __resetMessageIndexAsyncForTests();
    transformDecisionTest.reset();
    resetLkgSlotsForTest();
    closeDatabase();
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

/**
 * The host's array at the start of a turn while its compaction marker still sits
 * at the old boundary: it keeps loading `middle` and `assistant-boundary`, which
 * the summary published later covers.
 */
function turnStart(sessionId: string): Message[] {
    return [
        {
            info: { id: "base", role: "user", sessionID: sessionId, time: { created: 1 } },
            parts: [{ type: "text", text: "base" }],
        },
        {
            info: { id: "middle", role: "user", sessionID: sessionId, time: { created: 2 } },
            parts: [{ type: "text", text: "middle" }],
        },
        {
            info: {
                id: "assistant-boundary",
                role: "assistant",
                sessionID: sessionId,
                time: { created: 3 },
                finish: "stop",
                ...MODEL,
            },
            parts: [{ type: "text", text: "assistant boundary" }],
        },
        {
            info: { id: "question", role: "user", sessionID: sessionId, time: { created: 4 } },
            parts: [{ type: "text", text: "next question" }],
        },
    ];
}

/** One finished step of the turn's tool loop, optionally thinking before its call. */
function toolStep(sessionId: string, step: number, output: string, thinking: boolean): Message {
    return {
        info: {
            id: `step-${step}`,
            role: "assistant",
            sessionID: sessionId,
            time: { created: step + 4 },
            finish: "tool-calls",
            ...MODEL,
            tokens: { input: 0, output: 300, reasoning: 0 },
        },
        parts: [
            ...(thinking
                ? [
                      {
                          type: "reasoning",
                          text: `step ${step}: read the next file`,
                          metadata: { anthropic: { signature: `sig-${step}` } },
                      },
                  ]
                : []),
            {
                type: "tool",
                tool: "read",
                callID: `read-${step}`,
                state: { status: "completed", input: { path: `${step}.ts` }, output },
            },
        ],
    };
}

function hostArray(sessionId: string, count: number, thinking: boolean): Message[] {
    return [
        ...turnStart(sessionId),
        ...Array.from({ length: count }, (_, index) =>
            toolStep(
                sessionId,
                index + 1,
                index === 0 ? BULKY : `step ${index + 1} output line\n`.repeat(400),
                thinking,
            ),
        ),
    ];
}

const BASE_COMPARTMENT = {
    sequence: 0,
    startMessage: 1,
    endMessage: 1,
    startMessageId: "base",
    endMessageId: "base",
    title: "Baseline",
    content: "Baseline history",
};
const PUBLISHED_COMPARTMENT = {
    sequence: 1,
    startMessage: 2,
    endMessage: 3,
    startMessageId: "middle",
    endMessageId: "assistant-boundary",
    title: "Advanced",
    content: "Advanced history published while the marker was pending",
};

/** The marker row ids a successful move records, as the real publication persists them. */
const MOVED_MARKER = {
    boundaryMessageId: "middle",
    summaryMessageId: "msg-mc-summary-moved",
    compactionPartId: "prt-mc-compaction-moved",
    summaryPartId: "prt-mc-summary-moved",
    boundaryOrdinal: 3,
    targetEndMessageId: "assistant-boundary",
};

/** What the real drain returns when BEGIN IMMEDIATE on the host store stays busy. */
const busyWriter = (): MarkerUpdateOutcome => ({
    kind: "retryable-failure",
    cut: "definitely-no-cut",
    error: new SqliteAcquisitionBusyError(
        Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
    ),
});
/** What the real drain returns while summary discovery has not finished. */
const discoveryPending = (): MarkerUpdateOutcome => ({
    kind: "deferred",
    reason: "candidate-preparation",
});

/**
 * One session served through the OpenCode 1 wrapper, with the real marker
 * representation. The first pass serves three tool steps. Then the historian
 * publishes a summary (pending marker plus deferred history refresh) and the
 * agent queues a drop of the first step's large output. The tool results
 * protected from drops stay under a token floor, so the drop can land once
 * three larger steps follow it.
 */
async function sessionInToolLoop(name: string, thinking: boolean) {
    process.env.XDG_DATA_HOME = makeTempDir(`marker-busy-review-${name}-`);
    process.env.XDG_CACHE_HOME = process.env.XDG_DATA_HOME;
    const sessionId = `ses-marker-busy-review-${name}`;
    const directory = makeTempDir(`marker-busy-review-project-${name}-`);
    const db = openDatabase();
    replaceAllCompartments(db, sessionId, [BASE_COMPARTMENT]);
    injectM0M1({
        db,
        sessionId,
        state: getOrCreateSessionMeta(db, sessionId),
        projectDirectory: directory,
        injectDocs: false,
        memoryEnabled: false,
    });

    let decision: "execute" | "defer" = "defer";
    let markerOutcome: () => MarkerUpdateOutcome = () => ({ kind: "applied", markerOrdinal: 3 });
    const applyDeferred = mock((): MarkerUpdateOutcome => markerOutcome());
    const deferredHistoryRefreshSessions = new Set<string>();
    const transform = createTransform({
        tagger: createTagger(),
        scheduler: { shouldExecute: () => decision },
        contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
            [sessionId, { usage: { percentage: 30, inputTokens: 60_000 }, updatedAt: Date.now() }],
        ]),
        liveModelBySession: new Map([[sessionId, MODEL]]),
        db,
        directory,
        injectDocs: false,
        memoryConfig: { enabled: false, injectionBudgetTokens: 0, autoPromote: false },
        historyRefreshSessions: new Set(),
        deferredHistoryRefreshSessions,
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 1000,
        protectedTokens: 4000,
        historianRunnable: false,
        // Only the host-store move is replaced. The wire representation of the
        // marker is the production one.
        compactionMarkerStrategy: { applyDeferred, reconcile: reconcileMarkerRepresentation },
    });
    const onLkgReplay = mock(() => undefined);
    const handler = createMessagesTransformHandler({
        magicContext: { "experimental.chat.messages.transform": transform },
        onLkgReplay,
    });
    const serve = async (count: number): Promise<{ messages: Message[]; logs: string[] }> => {
        const output = {
            messages: hostArray(sessionId, count, thinking),
        } as unknown as Output;
        const logs = spyOn(loggerModule, "sessionLog");
        try {
            await handler({}, output);
            return {
                messages: output.messages as unknown as Message[],
                logs: logs.mock.calls.map(([, line]) => String(line)),
            };
        } finally {
            logs.mockRestore();
            // A healthy pass saves its last-good request from a deferred callback.
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
    };

    await serve(3);
    const toolTag = getTagsBySession(db, sessionId).find(
        (tag) => tag.type === "tool" && tag.messageId === "read-1",
    );
    if (!toolTag) throw new Error("the healthy pass did not tag the first step's tool output");
    appendCompartments(db, sessionId, [PUBLISHED_COMPARTMENT]);
    setPendingCompactionMarkerState(db, sessionId, {
        ordinal: 3,
        endMessageId: "assistant-boundary",
        publishedAt: 1,
    });
    deferredHistoryRefreshSessions.add(sessionId);
    queuePendingOp(db, sessionId, toolTag.tagNumber, "drop");

    return {
        serve,
        applyDeferred,
        onLkgReplay,
        setDecision: (next: "execute" | "defer") => {
            decision = next;
        },
        setMarkerOutcome: (next: () => MarkerUpdateOutcome) => {
            markerOutcome = next;
        },
        /** The move succeeds: the drain records the new marker as the real one does. */
        moveSucceeds: () => {
            markerOutcome = () => {
                setPersistedCompactionMarkerState(db, sessionId, MOVED_MARKER);
                return { kind: "applied", markerOrdinal: 3 };
            };
        },
    };
}

/**
 * The rebuild whose move cannot be made, the next step's defer pass, and the
 * step after it on an execute pass where the move finally succeeds.
 */
async function postponedMoveThenRetry(
    name: string,
    firstAttempt: () => MarkerUpdateOutcome,
    thinking: boolean,
) {
    const session = await sessionInToolLoop(name, thinking);
    session.setDecision("execute");
    session.setMarkerOutcome(firstAttempt);
    const rebuilt = await session.serve(4);
    session.setDecision("defer");
    const deferred = await session.serve(5);
    session.setDecision("execute");
    session.moveSucceeds();
    const retried = await session.serve(6);
    // Preconditions: the rebuild was served (not replayed), the defer pass
    // replayed it byte for byte, and the move was not attempted on the third
    // pass, which has no rewrite permission.
    expect(session.onLkgReplay).not.toHaveBeenCalled();
    expect(JSON.stringify(deferred.messages.slice(0, rebuilt.messages.length))).toBe(
        JSON.stringify(rebuilt.messages),
    );
    expect(session.applyDeferred).toHaveBeenCalledTimes(1);
    const permission = retried.logs.find((line) => line.startsWith("rewrite permission:"));
    return { rebuilt, deferred, retried, permission };
}

const servedPrefixUnchanged = (later: Message[], earlier: Message[]): boolean =>
    JSON.stringify(later.slice(0, earlier.length)) === JSON.stringify(earlier);

describe("review witness: a postponed compaction-marker move lands on a pass without rewrite permission", () => {
    for (const [attempt, firstAttempt] of [
        ["a busy host writer that provably did not move the marker", busyWriter],
        ["pending summary discovery", discoveryPending],
    ] as const) {
        it(`a retried marker move changes the served prefix on a later execute pass whose own rewrite permission is false (first attempt: ${attempt})`, async () => {
            const { deferred, retried, permission } = await postponedMoveThenRetry(
                `no-permission-${firstAttempt === busyWriter ? "busy" : "deferred"}`,
                firstAttempt,
                false,
            );
            // The third pass has no rebuild of its own: m[1] re-renders to the
            // same bytes, nothing new is queued, and the pass says so.
            expect(permission).toContain("allowed=false");
            expect(permission).toContain("ride=none");
            // So it must replay the previous request and only append the new
            // step. It inserts the moved marker's summary row after m[1] instead.
            expect(
                retried.messages.some(
                    (message) => message.info.id === MOVED_MARKER.summaryMessageId,
                ),
            ).toBe(false);
            expect(servedPrefixUnchanged(retried.messages, deferred.messages)).toBe(true);
        });
    }

    it("on a prefix-bound thinking model the retried marker move edits the prefix in front of the open turn's kept signed thinking", async () => {
        const { deferred, retried } = await postponedMoveThenRetry(
            "kept-thinking",
            busyWriter,
            true,
        );
        // Step 5's signed thinking was served on the defer pass and is still
        // bound to every byte in front of it.
        expect(JSON.stringify(deferred.messages)).toContain('"signature":"sig-5"');
        const editedBeforeThinking = !servedPrefixUnchanged(retried.messages, deferred.messages);
        const keptThinking = JSON.stringify(retried.messages).includes('"signature":"sig-5"');
        // An edit in front of kept signed thinking invalidates it: either the
        // prefix stays as served, or the pass strips that thinking with the edit.
        expect({ editedBeforeThinking, keptThinking }).not.toEqual({
            editedBeforeThinking: true,
            keptThinking: true,
        });
    });
});

/**
 * One finished tool step whose thinking is heavy (recorded reasoning above the
 * signed-thinking hold's threshold) when `heavy` is set, light otherwise.
 */
function reasoningStep(sessionId: string, step: number, output: string, heavy: boolean): Message {
    const message = toolStep(sessionId, step, output, true);
    message.info.tokens = { input: 0, output: 300, reasoning: heavy ? 2_000 : 0 };
    return message;
}

/** The turn start and `count` steps; steps from `heavyFrom` on think heavily. */
function pressureHost(sessionId: string, count: number, heavyFrom: number): Message[] {
    return [
        ...turnStart(sessionId),
        ...Array.from({ length: count }, (_, index) =>
            reasoningStep(
                sessionId,
                index + 1,
                index === 0 ? BULKY : `step ${index + 1} output line\n`.repeat(400),
                index + 1 >= heavyFrom,
            ),
        ),
    ];
}

/**
 * The same session as `sessionInToolLoop`, with a provider usage reading the
 * test sets before each pass and an optional execute threshold.
 */
async function sessionUnderPressure(name: string, executeThresholdPercentage?: number) {
    process.env.XDG_DATA_HOME = makeTempDir(`marker-busy-second-${name}-`);
    process.env.XDG_CACHE_HOME = process.env.XDG_DATA_HOME;
    const sessionId = `ses-marker-busy-second-${name}`;
    const directory = makeTempDir(`marker-busy-second-project-${name}-`);
    const db = openDatabase();
    replaceAllCompartments(db, sessionId, [BASE_COMPARTMENT]);
    injectM0M1({
        db,
        sessionId,
        state: getOrCreateSessionMeta(db, sessionId),
        projectDirectory: directory,
        injectDocs: false,
        memoryEnabled: false,
    });

    let decision: "execute" | "defer" = "defer";
    let markerOutcome: () => MarkerUpdateOutcome = () => ({ kind: "applied", markerOrdinal: 3 });
    const applyDeferred = mock((): MarkerUpdateOutcome => markerOutcome());
    const deferredHistoryRefreshSessions = new Set<string>();
    const deferredMaterializationSessions = new Set<string>();
    const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>();
    const setUsage = (percentage: number) =>
        contextUsageMap.set(sessionId, {
            usage: { percentage, inputTokens: percentage * 2_000 },
            updatedAt: Date.now(),
        });
    setUsage(30);
    const onLkgReplay = mock(() => undefined);
    const build = () => {
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: () => decision },
            contextUsageMap,
            liveModelBySession: new Map([[sessionId, MODEL]]),
            db,
            directory,
            injectDocs: false,
            memoryConfig: { enabled: false, injectionBudgetTokens: 0, autoPromote: false },
            historyRefreshSessions: new Set(),
            deferredHistoryRefreshSessions,
            deferredMaterializationSessions,
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            clearReasoningAge: 1000,
            protectedTokens: 4000,
            historianRunnable: false,
            ...(executeThresholdPercentage === undefined ? {} : { executeThresholdPercentage }),
            compactionMarkerStrategy: { applyDeferred, reconcile: reconcileMarkerRepresentation },
        });
        return createMessagesTransformHandler({
            magicContext: { "experimental.chat.messages.transform": transform },
            onLkgReplay,
        });
    };
    const handler = build();
    const serve = async (
        count: number,
        heavyFrom: number,
    ): Promise<{ messages: Message[]; logs: string[] }> => {
        const output = { messages: pressureHost(sessionId, count, heavyFrom) } as unknown as Output;
        const logs = spyOn(loggerModule, "sessionLog");
        try {
            await handler({}, output);
            return {
                messages: output.messages as unknown as Message[],
                logs: logs.mock.calls.map(([, line]) => String(line)),
            };
        } finally {
            logs.mockRestore();
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
    };

    await serve(3, Number.POSITIVE_INFINITY);
    const toolTag = getTagsBySession(db, sessionId).find(
        (tag) => tag.type === "tool" && tag.messageId === "read-1",
    );
    if (!toolTag) throw new Error("the healthy pass did not tag the first step's tool output");
    appendCompartments(db, sessionId, [PUBLISHED_COMPARTMENT]);
    setPendingCompactionMarkerState(db, sessionId, {
        ordinal: 3,
        endMessageId: "assistant-boundary",
        publishedAt: 1,
    });
    deferredHistoryRefreshSessions.add(sessionId);
    queuePendingOp(db, sessionId, toolTag.tagNumber, "drop");

    return {
        db: () => db,
        sessionId,
        serve,
        applyDeferred,
        onLkgReplay,
        setUsage,
        /** A history refresh queued for a reason other than a publication. */
        queueHistoryRefresh: () => deferredHistoryRefreshSessions.add(sessionId),
        signals: () => ({
            history: deferredHistoryRefreshSessions.has(sessionId),
            materialization: deferredMaterializationSessions.has(sessionId),
        }),
        setDecision: (next: "execute" | "defer") => {
            decision = next;
        },
        setMarkerOutcome: (next: () => MarkerUpdateOutcome) => {
            markerOutcome = next;
        },
        moveSucceeds: () => {
            markerOutcome = () => {
                setPersistedCompactionMarkerState(db, sessionId, MOVED_MARKER);
                return { kind: "applied", markerOrdinal: 3 };
            };
        },
    };
}

/** Ids of the summary rows a request serves. */
const summaryRowIds = (messages: Message[]): string[] =>
    messages.filter((message) => message.info.summary === true).map((m) => String(m.info.id));

describe("review witness (second look): a marker moved outside this process changes the served row on a pass without rewrite permission", () => {
    // Open defect: every pass rebuilds the summary row from the marker state in
    // the shared store, so a move another process records changes this
    // process's next request even when that pass may not rewrite the prefix.
    // The deferred-clear tombstone cannot carry it: that state is shared too,
    // and the moving process retires it on the same pass. Closing this needs a
    // record, per process, of the request it last served, and replaying that
    // request's summary row (and anything else the move changes in the host's
    // input) until a pass that may rewrite the prefix.
    it.skipIf(!OPEN_DEFECTS)(
        "a marker another process moved replaces the summary row on this process's next defer pass, in front of the turn's kept signed thinking",
        async () => {
            const session = await sessionUnderPressure("concurrent-move");
            // The rebuild consumes the published history; its move is postponed.
            session.setDecision("execute");
            session.setMarkerOutcome(busyWriter);
            await session.serve(4, Number.POSITIVE_INFINITY);
            session.setDecision("defer");
            const deferred = await session.serve(5, Number.POSITIVE_INFINITY);
            expect(summaryRowIds(deferred.messages)).toEqual([]);
            expect(JSON.stringify(deferred.messages)).toContain('"signature":"sig-5"');

            // Another process serving this session moves the pending marker on one of
            // its own passes and records it, as the drain does when it succeeds.
            setPersistedCompactionMarkerState(session.db(), session.sessionId, MOVED_MARKER);
            setPendingCompactionMarkerState(session.db(), session.sessionId, null);

            const next = await session.serve(6, Number.POSITIVE_INFINITY);
            // Precondition: this pass may not change the cached prefix.
            expect(next.logs.find((line) => line.startsWith("rewrite permission:"))).toContain(
                "allowed=false",
            );
            // It must replay the previous request and append the new step. It
            // serves the moved marker's summary row after m[1] instead, while the
            // turn's signed thinking after that row stays on the wire.
            expect(summaryRowIds(next.messages)).toEqual([]);
            expect(JSON.stringify(next.messages.slice(0, deferred.messages.length))).toBe(
                JSON.stringify(deferred.messages),
            );
        },
    );
});

describe("served check: the marker another process moved", () => {
    // The served check (served-check.ts) sees the open defect above. It only
    // measures: the pass is served exactly as before, and the check logs that
    // it changed the served request without rebuild permission, in front of
    // the turn's kept signed thinking, which it did not strip.
    it("logs a change without rebuild permission in front of kept signed thinking on the pass that serves the moved marker's summary row", async () => {
        const session = await sessionUnderPressure("concurrent-move-served-check");
        session.setDecision("execute");
        session.setMarkerOutcome(busyWriter);
        await session.serve(4, Number.POSITIVE_INFINITY);
        session.setDecision("defer");
        const deferred = await session.serve(5, Number.POSITIVE_INFINITY);
        // The defer pass only appends to the rebuild served before it.
        expect(deferred.logs.filter((line) => line.startsWith("served check: "))).toEqual([]);

        setPersistedCompactionMarkerState(session.db(), session.sessionId, MOVED_MARKER);
        setPendingCompactionMarkerState(session.db(), session.sessionId, null);

        const next = await session.serve(6, Number.POSITIVE_INFINITY);
        expect(next.logs.find((line) => line.startsWith("rewrite permission:"))).toContain(
            "allowed=false",
        );
        const events = next.logs.filter((line) => line.startsWith("served check: "));
        expect(
            events.some(
                (line) =>
                    line.startsWith(
                        "served check: a pass without rebuild permission changed served messages ",
                    ) && line.includes("permitted=false"),
            ),
        ).toBe(true);
        expect(
            events.some(
                (line) =>
                    line.startsWith(
                        "served check: a change in front of kept signed thinking on a prefix-bound model ",
                    ) && line.includes("thinking_stripped=false"),
            ),
        ).toBe(true);
    });
});

describe("review guard (second look): the rewrite-permission gate of the marker drain", () => {
    it("a pass that consumes a queued history refresh without rewrite permission leaves a pending marker where it is", async () => {
        const session = await sessionUnderPressure("gate");
        session.setDecision("execute");
        session.setMarkerOutcome(busyWriter);
        await session.serve(4, Number.POSITIVE_INFINITY);
        session.setDecision("defer");
        const deferred = await session.serve(5, Number.POSITIVE_INFINITY);
        // A history refresh queued for another reason (a deferred system-prompt
        // refresh can hand one over) makes the next execute pass consume history
        // again. The history is already served, so its head re-renders to the
        // same bytes and the pass has no rewrite permission.
        session.queueHistoryRefresh();
        session.setDecision("execute");
        session.moveSucceeds();
        const next = await session.serve(6, Number.POSITIVE_INFINITY);
        expect(next.logs.find((line) => line.startsWith("rewrite permission:"))).toContain(
            "allowed=false",
        );
        expect(
            next.logs.some((line) =>
                line.includes("compaction-marker drain: pass has no rewrite permission"),
            ),
        ).toBe(true);
        expect(session.applyDeferred).toHaveBeenCalledTimes(1);
        expect(summaryRowIds(next.messages)).toEqual([]);
        expect(JSON.stringify(next.messages.slice(0, deferred.messages.length))).toBe(
            JSON.stringify(deferred.messages),
        );
    });
});
