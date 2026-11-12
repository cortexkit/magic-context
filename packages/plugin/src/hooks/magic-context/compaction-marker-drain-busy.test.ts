/// <reference types="bun-types" />

/**
 * A pass that rebuilds the cached prefix (a published summary re-renders m[1], a
 * queued drop lands and the turn's signed thinking is stripped) saves those
 * decisions before it tries to move OpenCode's compaction marker. When the host
 * store's writer stays busy and the marker provably did not move, the pass must
 * serve its own rebuild. Refusing it makes the wrapper replay the previous
 * request, and the next step then serves the saved rebuild anyway: two rewrites
 * of the provider's cached prefix for one decision. The postponed move is retried
 * only on a later pass that may rewrite the prefix, because the moved marker's
 * summary row is served right after the history head.
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
    clearPendingOps,
    closeDatabase,
    getOrCreateSessionMeta,
    getPendingCompactionMarkerState,
    getPendingOps,
    getTagsBySession,
    openDatabase,
    queuePendingOp,
    setPendingCompactionMarkerState,
} from "../../features/magic-context/storage";
import {
    getMergedReasoningStrippedIds,
    setPersistedCompactionMarkerState,
    thinkingBindingRecoveryFrozenId,
} from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { __test as transformDecisionTest } from "../../features/magic-context/transform-decision-log";
import type { ContextUsage } from "../../features/magic-context/types";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import * as loggerModule from "../../shared/logger";
import { SqliteAcquisitionBusyError } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { MARKER_SUMMARY_TEXT, type MarkerUpdateOutcome } from "./compaction-marker-manager";
import { readExecuteReclaimState } from "./execute-reclaim";
import { clearInjectionCache, injectM0M1 } from "./inject-compartments";
import * as lkgRecoveryPrefix from "./lkg-recovery-prefix";
import { getSlot, resetLkgSlotsForTest } from "./lkg-slot";
import { rearmPendingCompactionMarkerSignals } from "./pending-marker-rearm";
import { requestPendingMaterialization } from "./pending-materialization";
import {
    beginSystemDateRequest,
    bindSystemDateRequestIdentity,
    waitForSystemDateRefresh,
} from "./system-date-refresh";
import { createTransform } from "./transform";
import { reconcileMarkerRepresentation } from "./transform-postprocess-phase";

type Message = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };
type Output = Parameters<ReturnType<typeof createMessagesTransformHandler>>[1];

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
 * A model whose signed thinking is bound to every byte in front of it. On such a
 * model the transform saves the whole served request as the last-good request
 * on every pass, so a failed step can be replayed in the middle of a tool loop.
 */
const MODEL = { providerID: "anthropic", modelID: "claude-opus-5-5" };

/**
 * The model that wrote the session's assistant messages and which of the tool
 * loop's steps thought before calling their tool.
 */
interface HostShape {
    model: { providerID: string; modelID: string };
    thinks: (step: number) => boolean;
}

/** The first four steps think before their call, later ones do not. */
const DEFAULT_SHAPE: HostShape = { model: MODEL, thinks: (step) => step <= 4 };

/**
 * The host's array at the start of a turn, while its compaction marker still
 * sits at the old boundary: it keeps loading `middle` and `assistant-boundary`,
 * which the summary published later covers. The transform removes them itself
 * once that summary is in m[1].
 */
function turnStart(sessionId: string, model: HostShape["model"]): Message[] {
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
                ...model,
            },
            parts: [{ type: "text", text: "assistant boundary" }],
        },
        {
            info: { id: "question", role: "user", sessionID: sessionId, time: { created: 4 } },
            parts: [{ type: "text", text: "next question" }],
        },
    ];
}

/**
 * One finished step of the turn's tool loop, created at time `step + 4`: a
 * completed tool call, preceded by signed thinking when the model thought
 * before calling it. OpenCode hands the transform the array again before each
 * step, ending with the newest finished step.
 */
function toolStep(
    sessionId: string,
    step: number,
    output: string,
    thinking: boolean,
    model: HostShape["model"],
): Message {
    return {
        info: {
            id: `step-${step}`,
            role: "assistant",
            sessionID: sessionId,
            time: { created: step + 4 },
            finish: "tool-calls",
            ...model,
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

/**
 * The host array before step `count + 1`: the turn start and `count` finished
 * steps.
 */
function hostArray(sessionId: string, count: number, shape = DEFAULT_SHAPE): Message[] {
    return [
        ...turnStart(sessionId, shape.model),
        ...Array.from({ length: count }, (_, index) =>
            toolStep(
                sessionId,
                index + 1,
                index === 0 ? BULKY : `step ${index + 1} output line\n`.repeat(400),
                shape.thinks(index + 1),
                shape.model,
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

/**
 * The marker row ids a successful move records. The boundary is `middle`, the
 * nearest user message at or before the summarized end `assistant-boundary`.
 */
const MOVED_MARKER = {
    boundaryMessageId: "middle",
    summaryMessageId: "msg-mc-summary-moved",
    compactionPartId: "prt-mc-compaction-moved",
    summaryPartId: "prt-mc-summary-moved",
    boundaryOrdinal: 3,
    targetEndMessageId: "assistant-boundary",
};

/**
 * The host array once the moved marker is in OpenCode's store: OpenCode loads
 * from the boundary user message, which now carries the compaction part, with
 * the marker's summary right after it. Everything before the boundary is gone.
 */
function hostArrayAfterMove(sessionId: string, count: number, shape = DEFAULT_SHAPE): Message[] {
    const [, middle, ...rest] = hostArray(sessionId, count, shape);
    return [
        {
            ...middle,
            parts: [
                ...middle.parts,
                { id: MOVED_MARKER.compactionPartId, type: "compaction", auto: true },
            ],
        },
        {
            info: {
                id: MOVED_MARKER.summaryMessageId,
                role: "assistant",
                sessionID: sessionId,
                parentID: MOVED_MARKER.boundaryMessageId,
                time: { created: 2 },
                summary: true,
                finish: "stop",
            },
            parts: [{ id: MOVED_MARKER.summaryPartId, type: "text", text: MARKER_SUMMARY_TEXT }],
        },
        ...rest,
    ];
}

/**
 * One session served through the OpenCode 1 wrapper, so a refused pass takes the
 * same last-good replay path as production. The first pass serves the tool
 * loop's first three steps, the first with a large output, and saves that
 * request as the last-good one. Then the historian publishes a summary (pending
 * marker plus deferred history refresh) and the agent queues a drop of that
 * output. The newest tool results are protected from drops up to a token floor,
 * so the drop can land once three larger steps follow it.
 */
async function sessionInToolLoop(name: string, shape = DEFAULT_SHAPE) {
    process.env.XDG_DATA_HOME = makeTempDir(`marker-drain-busy-${name}-`);
    process.env.XDG_CACHE_HOME = process.env.XDG_DATA_HOME;
    const sessionId = `ses-marker-drain-busy-${name}`;
    const directory = makeTempDir(`marker-drain-busy-project-${name}-`);
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
    const onLkgReplay = mock(() => undefined);
    // The process's in-memory signals; a restart starts them empty.
    let deferredHistoryRefreshSessions = new Set<string>();
    let deferredMaterializationSessions = new Set<string>();
    let historyRefreshSessions = new Set<string>();
    let pendingMaterializationSessions = new Set<string>();
    // The provider's last reported usage, which the next pass reads.
    const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>([
        [sessionId, { usage: { percentage: 30, inputTokens: 60_000 }, updatedAt: Date.now() }],
    ]);
    const createHandler = () =>
        createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": createTransform({
                    tagger: createTagger(),
                    scheduler: { shouldExecute: () => decision },
                    contextUsageMap,
                    liveModelBySession: new Map([[sessionId, shape.model]]),
                    db,
                    directory,
                    injectDocs: false,
                    memoryConfig: { enabled: false, injectionBudgetTokens: 0, autoPromote: false },
                    historyRefreshSessions,
                    deferredHistoryRefreshSessions,
                    deferredMaterializationSessions,
                    pendingMaterializationSessions,
                    lastHeuristicsTurnId: new Map(),
                    clearReasoningAge: 1000,
                    // The smallest explicit floor the configuration accepts. The three
                    // newest steps' outputs exceed it, so the oldest one may be dropped.
                    protectedTokens: 4000,
                    historianRunnable: false,
                    // Only the host-store move is replaced; the marker's wire
                    // representation is the production one.
                    compactionMarkerStrategy: {
                        applyDeferred,
                        reconcile: reconcileMarkerRepresentation,
                    },
                }),
            },
            onLkgReplay,
        });
    let handler = createHandler();
    /**
     * One pass: the served request (or the refusal), the session log lines it
     * wrote, whether it counted as a rebuild (it staged a cache-rewrite decision
     * row), and whether it let a queued system-date refresh ride along.
     */
    const serve = async (
        messages: Message[],
    ): Promise<{
        messages: Message[] | Error;
        logs: string[];
        busted: boolean;
        dateRefreshGranted: boolean | undefined;
    }> => {
        const output = { messages: structuredClone(messages) } as unknown as Output;
        // The system hook's half of this request, so the pass reports whether a
        // date refresh may ride it.
        const identity = {};
        bindSystemDateRequestIdentity(output, identity);
        let dateRefreshGranted: boolean | undefined;
        waitForSystemDateRefresh(
            historyRefreshSessions,
            beginSystemDateRequest(
                historyRefreshSessions,
                sessionId,
                "system",
                undefined,
                identity,
            ),
            (permitted) => {
                dateRefreshGranted = permitted;
            },
        );
        transformDecisionTest.reset();
        const logs = spyOn(loggerModule, "sessionLog");
        const result = (messages: Message[] | Error) => ({
            messages,
            logs: logs.mock.calls.map(([, line]) => String(line)),
            busted: transformDecisionTest.getPending(sessionId) !== undefined,
            dateRefreshGranted,
        });
        try {
            await handler({}, output);
            return result(output.messages as unknown as Message[]);
        } catch (error) {
            return result(error instanceof Error ? error : new Error(String(error)));
        } finally {
            logs.mockRestore();
            // A healthy pass saves its last-good request from a deferred
            // callback. Real steps are seconds apart, so let it run before the
            // next pass, as it would on a real host.
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
    };
    const toolTagOf = (step: number) => {
        const tag = getTagsBySession(db, sessionId).find(
            (candidate) => candidate.type === "tool" && candidate.messageId === `read-${step}`,
        );
        if (!tag) throw new Error(`step ${step}'s tool output was never tagged`);
        return tag.tagNumber;
    };

    const first = await serve(hostArray(sessionId, 3, shape));
    if (first.messages instanceof Error) throw first.messages;
    if (shape.model.modelID === MODEL.modelID)
        expect(getSlot(sessionId)?.lastInputMessageId).toBe("step-3");
    const toolTagNumber = toolTagOf(1);

    appendCompartments(db, sessionId, [PUBLISHED_COMPARTMENT]);
    setPendingCompactionMarkerState(db, sessionId, {
        ordinal: 3,
        endMessageId: "assistant-boundary",
        publishedAt: 1,
    });
    deferredHistoryRefreshSessions.add(sessionId);
    deferredMaterializationSessions.add(sessionId);
    queuePendingOp(db, sessionId, toolTagNumber, "drop");

    return {
        db,
        sessionId,
        first: first.messages,
        serve,
        applyDeferred,
        onLkgReplay,
        get deferredHistoryRefreshSessions() {
            return deferredHistoryRefreshSessions;
        },
        get deferredMaterializationSessions() {
            return deferredMaterializationSessions;
        },
        get historyRefreshSessions() {
            return historyRefreshSessions;
        },
        toolTagNumber,
        toolTagOf,
        /** The agent queues drops of these steps' tool outputs. */
        queueDrops: (steps: number[]) => {
            const tagNumbers = steps.map(toolTagOf);
            for (const tagNumber of tagNumbers) queuePendingOp(db, sessionId, tagNumber, "drop");
            return tagNumbers;
        },
        /** The provider reports this share of the context window as used. */
        setUsage: (percentage: number) => {
            contextUsageMap.set(sessionId, {
                usage: { percentage, inputTokens: percentage * 2_000 },
                updatedAt: Date.now(),
            });
        },
        setDecision: (next: "execute" | "defer") => {
            decision = next;
        },
        setMarkerOutcome: (next: () => MarkerUpdateOutcome) => {
            markerOutcome = next;
        },
        /** What `/ctx-flush` signals: a history rebuild and a user-requested materialization. */
        flush: () => {
            historyRefreshSessions.add(sessionId);
            requestPendingMaterialization(pendingMaterializationSessions, sessionId, "user_flush");
        },
        /** The move succeeds: the drain records the new marker as the real publication does. */
        moveSucceeds: () => {
            markerOutcome = () => {
                setPersistedCompactionMarkerState(db, sessionId, MOVED_MARKER);
                return { kind: "applied", markerOrdinal: 3 };
            };
        },
        /**
         * A plugin restart: the in-memory signals and the history injection
         * cache start empty, a new transform serves the session, and the hook's
         * start-up step restores the signals a pending marker needs.
         */
        restart: () => {
            deferredHistoryRefreshSessions = new Set();
            deferredMaterializationSessions = new Set();
            historyRefreshSessions = new Set();
            pendingMaterializationSessions = new Set();
            clearInjectionCache(sessionId);
            rearmPendingCompactionMarkerSignals(
                db,
                deferredHistoryRefreshSessions,
                deferredMaterializationSessions,
            );
            handler = createHandler();
        },
    };
}

function busyWriter(cut: "definitely-no-cut" | "uncertain"): MarkerUpdateOutcome {
    return {
        kind: "retryable-failure",
        cut,
        error: new SqliteAcquisitionBusyError(
            Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
        ),
    };
}

/** The request a pass served; fails the test when the pass was refused instead. */
function served(pass: { messages: Message[] | Error }): Message[] {
    if (pass.messages instanceof Error) throw pass.messages;
    return pass.messages;
}

const permissionLine = (logs: string[]): string =>
    logs.find((line) => line.startsWith("rewrite permission:")) ?? "";

/** The host array with a new user message right before step 5, which then opens a new turn. */
const newTurnAtStep5 = (messages: Message[], sessionId: string): Message[] => {
    const index = messages.findIndex((message) => message.info.id === "step-5");
    if (index < 0) return messages;
    return [
        ...messages.slice(0, index),
        {
            info: {
                id: "carry-on",
                role: "user",
                sessionID: sessionId,
                time: { created: 8.5 },
            },
            parts: [{ type: "text", text: "carry on" }],
        },
        ...messages.slice(index),
    ];
};

describe("compaction-marker drain with a busy host writer", () => {
    it("serves the rebuilt request when the marker definitely did not move, and the next step's defer pass replays it byte for byte", async () => {
        const session = await sessionInToolLoop("no-cut");
        // A rebuild that consumes the published history: m[1] re-renders,
        // the turn's signed thinking is stripped in front of it, the queued
        // drop applies, the trim moves past the summarized messages, and
        // the host-store marker cannot move because its writer stays busy.
        session.setDecision("execute");
        session.setMarkerOutcome(() => busyWriter("definitely-no-cut"));
        const rebuildPass = await session.serve(hostArray(session.sessionId, 4));

        // The next step of the tool loop. The host never moved its marker,
        // so it still loads the summarized messages, the dropped output and
        // the stripped thinking as it stored them; only the newest step is new.
        session.setDecision("defer");
        const deferPass = await session.serve(hostArray(session.sessionId, 5));

        const rebuilt = served(rebuildPass);
        const deferred = served(deferPass);
        // m[0], m[1] and every earlier message are byte-identical; the defer
        // pass only appends the new step.
        expect(JSON.stringify(deferred.slice(0, rebuilt.length))).toBe(JSON.stringify(rebuilt));
        expect(deferred).toHaveLength(rebuilt.length + 1);

        // The served rebuild is this pass's own decision, not a replay of the
        // earlier request: it carries the new summary and the queued drop, and
        // no longer carries the summarized messages.
        const wire = JSON.stringify(rebuilt);
        expect(session.onLkgReplay).not.toHaveBeenCalled();
        expect(wire).toContain("Advanced history published while the marker was pending");
        expect(wire).not.toContain("BULKY-TOOL-OUTPUT");
        expect(wire).toContain(`[dropped §${session.toolTagNumber}§]`);
        expect(wire).not.toContain("assistant boundary");
        expect(JSON.stringify(session.first)).toContain("assistant boundary");
        expect(getPendingOps(session.db, session.sessionId)).toEqual([]);

        // The move is retried later: the pending target survives and the defer
        // pass does not retry it. The history the rebuild consumed was served,
        // so its refresh signal is released as on any consuming pass.
        expect(session.applyDeferred).toHaveBeenCalledTimes(1);
        expect(getPendingCompactionMarkerState(session.db, session.sessionId)).toMatchObject({
            ordinal: 3,
            endMessageId: "assistant-boundary",
        });
        expect(session.deferredHistoryRefreshSessions.has(session.sessionId)).toBe(false);
        expect(
            rebuildPass.logs.some((line) => line.includes("transform refused degraded pass")),
        ).toBe(false);
        expect(
            rebuildPass.logs.filter((line) =>
                line.includes("compaction-marker drain: marker unchanged (reason=busy-writer)"),
            ),
        ).toHaveLength(1);
    });

    it("after a postponed move, an execute pass with nothing to rewrite changes no byte and counts as no rebuild", async () => {
        const session = await sessionInToolLoop("idle");
        session.setDecision("execute");
        session.setMarkerOutcome(() => busyWriter("definitely-no-cut"));
        served(await session.serve(hostArray(session.sessionId, 4)));
        session.setDecision("defer");
        const deferred = served(await session.serve(hostArray(session.sessionId, 5)));

        // No history refresh is left for the next execute pass to consume
        // again. Those two signals are also all the historian trigger reads
        // when it credits a pass with a published-history rewrite.
        expect(session.deferredHistoryRefreshSessions.has(session.sessionId)).toBe(false);
        expect(session.historyRefreshSessions.has(session.sessionId)).toBe(false);

        session.setDecision("execute");
        session.moveSucceeds();
        const idlePass = await session.serve(hostArray(session.sessionId, 6));
        const idle = served(idlePass);
        expect(permissionLine(idlePass.logs)).toContain("allowed=false");
        expect(JSON.stringify(idle.slice(0, deferred.length))).toBe(JSON.stringify(deferred));
        expect(idle).toHaveLength(deferred.length + 1);
        // Not a rebuild: no cache-rewrite decision row is staged and no queued
        // system-date refresh may ride the request.
        expect(idlePass.busted).toBe(false);
        expect(idlePass.dateRefreshGranted).toBe(false);
        expect(session.applyDeferred).toHaveBeenCalledTimes(1);
        expect(getPendingCompactionMarkerState(session.db, session.sessionId)).not.toBeNull();
    });

    it("after a postponed move, the execute rebuild for queued drops moves the marker in that same rebuild, and the next step replays it byte for byte", async () => {
        const session = await sessionInToolLoop("reclaim");
        session.setDecision("execute");
        session.setMarkerOutcome(() => busyWriter("definitely-no-cut"));
        served(await session.serve(hostArray(session.sessionId, 4)));
        session.setDecision("defer");
        let previous = served(await session.serve(hostArray(session.sessionId, 5)));

        // The agent queues drops of three older outputs and the host writer is
        // free again. An execute pass rebuilds for queued drops on its own once
        // they are worth 2% of the window or have waited through two execute
        // passes (execute-reclaim.ts); this session's window is unknown, so the
        // two passes before that rebuild change no byte and leave the marker.
        const dropped = session.queueDrops([2, 3, 4]);
        session.setDecision("execute");
        session.moveSucceeds();
        for (const steps of [6, 7]) {
            const heldPass = await session.serve(hostArray(session.sessionId, steps));
            const held = served(heldPass);
            expect(permissionLine(heldPass.logs)).toContain("allowed=false");
            expect(JSON.stringify(held.slice(0, previous.length))).toBe(JSON.stringify(previous));
            expect(held).toHaveLength(previous.length + 1);
            expect(heldPass.busted).toBe(false);
            expect(session.applyDeferred).toHaveBeenCalledTimes(1);
            previous = held;
        }
        const deferred = previous;
        const reclaimPass = await session.serve(hostArray(session.sessionId, 8));
        const reclaim = served(reclaimPass);
        const permission = permissionLine(reclaimPass.logs);
        expect(permission).toContain("allowed=true");
        expect(permission).toContain("executeReclaim");
        expect(session.applyDeferred).toHaveBeenCalledTimes(2);
        expect(getPendingCompactionMarkerState(session.db, session.sessionId)).toBeNull();
        const wire = JSON.stringify(reclaim);
        for (const tagNumber of dropped) expect(wire).toContain(`[dropped §${tagNumber}§]`);

        // One rebuild carries both: the history head is unchanged and the
        // moved marker's summary row follows it, where the previous request had
        // its first real message.
        const head = (messages: Message[]) => messages.slice(0, 2);
        expect(head(reclaim).every((message) => message.info.syntheticHead === true)).toBe(true);
        expect(JSON.stringify(head(reclaim))).toBe(JSON.stringify(head(deferred)));
        expect(deferred.some((message) => message.info.id === MOVED_MARKER.summaryMessageId)).toBe(
            false,
        );
        expect(reclaim[2]?.info).toMatchObject({
            id: MOVED_MARKER.summaryMessageId,
            role: "assistant",
            summary: true,
        });
        expect(reclaim[3]?.info.id).toBe(deferred[2]?.info.id);

        // The next step loads from the moved marker and only appends itself.
        session.setDecision("defer");
        const after = served(await session.serve(hostArrayAfterMove(session.sessionId, 9)));
        expect(JSON.stringify(after.slice(0, reclaim.length))).toBe(JSON.stringify(reclaim));
        expect(after).toHaveLength(reclaim.length + 1);
        expect(session.onLkgReplay).not.toHaveBeenCalled();
    });

    it("retries the postponed move only on a pass with rewrite permission, and the next step replays the moved marker byte for byte", async () => {
        const session = await sessionInToolLoop("retry");
        session.setDecision("execute");
        session.setMarkerOutcome(() => busyWriter("definitely-no-cut"));
        served(await session.serve(hostArray(session.sessionId, 4)));
        session.setDecision("defer");
        const deferred = served(await session.serve(hostArray(session.sessionId, 5)));

        // An execute pass with nothing to rewrite: no ride gives it rewrite
        // permission, so the move waits; moving the marker would change the
        // served prefix.
        session.setDecision("execute");
        session.moveSucceeds();
        const idlePass = await session.serve(hostArray(session.sessionId, 6));
        const idle = served(idlePass);
        expect(permissionLine(idlePass.logs)).toContain("allowed=false");
        expect(idlePass.logs.some((line) => line.includes("compaction-marker drain:"))).toBe(false);
        expect(session.applyDeferred).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(idle.slice(0, deferred.length))).toBe(JSON.stringify(deferred));
        expect(idle).toHaveLength(deferred.length + 1);
        expect(getPendingCompactionMarkerState(session.db, session.sessionId)).not.toBeNull();
        expect(session.deferredHistoryRefreshSessions.has(session.sessionId)).toBe(false);

        // The agent queues drops and the user runs /ctx-flush, a rewrite the
        // session pays for anyway; the postponed move is made on that pass.
        const dropped = session.queueDrops([2, 3, 4]);
        session.flush();
        const landingPass = await session.serve(hostArray(session.sessionId, 7));
        const landing = served(landingPass);
        const permission = permissionLine(landingPass.logs);
        expect(permission).toContain("allowed=true");
        expect(permission).toContain("explicitFlush");
        expect(session.applyDeferred).toHaveBeenCalledTimes(2);
        expect(getPendingCompactionMarkerState(session.db, session.sessionId)).toBeNull();
        expect(session.deferredHistoryRefreshSessions.has(session.sessionId)).toBe(false);

        // The history head is unchanged and the moved marker's summary row now
        // follows it, where the previous request had its first real message.
        const head = (messages: Message[]) => messages.slice(0, 2);
        expect(head(landing).every((message) => message.info.syntheticHead === true)).toBe(true);
        expect(JSON.stringify(head(landing))).toBe(JSON.stringify(head(idle)));
        expect(idle.some((message) => message.info.id === MOVED_MARKER.summaryMessageId)).toBe(
            false,
        );
        expect(landing[2]?.info).toMatchObject({
            id: MOVED_MARKER.summaryMessageId,
            role: "assistant",
            summary: true,
        });
        expect(JSON.stringify(landing[2]?.parts)).toContain(MARKER_SUMMARY_TEXT);
        expect(landing[3]?.info.id).toBe(idle[2]?.info.id);
        const landingWire = JSON.stringify(landing);
        for (const tagNumber of dropped) {
            expect(landingWire).toContain(`[dropped §${tagNumber}§]`);
        }

        // The next step: OpenCode now loads from the moved marker, so the
        // summarized messages are gone from its array and the marker's
        // summary arrives after the boundary user. The served request only
        // appends the new step.
        session.setDecision("defer");
        const after = served(await session.serve(hostArrayAfterMove(session.sessionId, 8)));
        expect(JSON.stringify(after.slice(0, landing.length))).toBe(JSON.stringify(landing));
        expect(after).toHaveLength(landing.length + 1);
        expect(session.onLkgReplay).not.toHaveBeenCalled();
    });

    it("after a restart, a postponed move whose history is already served changes nothing until the first pass with rewrite permission", async () => {
        const session = await sessionInToolLoop("restart");
        session.setDecision("execute");
        session.setMarkerOutcome(() => busyWriter("definitely-no-cut"));
        served(await session.serve(hostArray(session.sessionId, 4)));
        session.setDecision("defer");
        served(await session.serve(hostArray(session.sessionId, 5)));
        const beforeRestart = served(await session.serve(hostArray(session.sessionId, 6)));

        // The cached head already renders the published summary, so start-up
        // restores no refresh signal; the pending marker is all that is left.
        session.restart();
        expect(session.deferredHistoryRefreshSessions.has(session.sessionId)).toBe(false);
        expect(getPendingCompactionMarkerState(session.db, session.sessionId)).not.toBeNull();

        // The first pass after the restart: an execute pass with three older
        // outputs queued for drops. It has no rewrite permission: the execute
        // rebuild for queued drops waits through two execute passes in this
        // session (its window is unknown), so this is the first of them.
        const dropped = session.queueDrops([2, 3, 4]);
        session.setDecision("execute");
        session.moveSucceeds();
        const firstPass = await session.serve(hostArray(session.sessionId, 7));
        const first = served(firstPass);
        expect(permissionLine(firstPass.logs)).toContain("allowed=false");
        expect(JSON.stringify(first.slice(0, beforeRestart.length))).toBe(
            JSON.stringify(beforeRestart),
        );
        expect(first).toHaveLength(beforeRestart.length + 1);
        expect(firstPass.busted).toBe(false);
        expect(firstPass.dateRefreshGranted).toBe(false);
        // The execute rebuild for queued drops is not held back by a restored
        // history refresh: this pass counts toward the passes it waits for.
        expect(readExecuteReclaimState(session.db, session.sessionId).heldPasses).toBe(1);
        expect(session.applyDeferred).toHaveBeenCalledTimes(1);
        expect(getPendingCompactionMarkerState(session.db, session.sessionId)).not.toBeNull();

        const secondPass = await session.serve(hostArray(session.sessionId, 8));
        const second = served(secondPass);
        expect(permissionLine(secondPass.logs)).toContain("allowed=false");
        expect(JSON.stringify(second.slice(0, first.length))).toBe(JSON.stringify(first));
        expect(second).toHaveLength(first.length + 1);
        expect(session.applyDeferred).toHaveBeenCalledTimes(1);

        // The third execute pass rebuilds for the drops, and the marker moves
        // in that rebuild.
        const landingPass = await session.serve(hostArray(session.sessionId, 9));
        const landing = served(landingPass);
        const permission = permissionLine(landingPass.logs);
        expect(permission).toContain("allowed=true");
        expect(permission).toContain("executeReclaim");
        expect(session.applyDeferred).toHaveBeenCalledTimes(2);
        expect(getPendingCompactionMarkerState(session.db, session.sessionId)).toBeNull();
        const wire = JSON.stringify(landing);
        for (const tagNumber of dropped) expect(wire).toContain(`[dropped §${tagNumber}§]`);
        expect(JSON.stringify(landing.slice(0, 2))).toBe(JSON.stringify(second.slice(0, 2)));
        expect(landing[2]?.info).toMatchObject({
            id: MOVED_MARKER.summaryMessageId,
            role: "assistant",
            summary: true,
        });
        expect(landing[3]?.info.id).toBe(second[2]?.info.id);

        session.setDecision("defer");
        const after = served(await session.serve(hostArrayAfterMove(session.sessionId, 10)));
        expect(JSON.stringify(after.slice(0, landing.length))).toBe(JSON.stringify(landing));
        expect(after).toHaveLength(landing.length + 1);
        expect(session.onLkgReplay).not.toHaveBeenCalled();
    });

    // A marker move changes the row served right after the history head. On a
    // pass whose only prefix change is that move, a model that binds signed
    // thinking to every byte in front of it must still lose the thinking kept
    // after the row, and the pass is a rebuild. The user starts a new turn after
    // step 4, and step 5 answers it with signed thinking, which is served after
    // the head when the move lands. Step 5 is the first assistant message after
    // a user message and step 6 does not think; otherwise the strip that merges
    // adjacent assistants' reasoning would edit the prefix on the same pass and
    // the move would not be its only prefix change.
    for (const ride of ["flush", "force"] as const) {
        for (const binds of [true, false]) {
            it(`a marker move on a ${ride} pass with nothing else to do ${binds ? "strips the signed thinking after it on a prefix-bound model" : "keeps the thinking of a model that does not bind it"}, counts as a rebuild, and the next step replays it byte for byte`, async () => {
                const shape: HostShape = {
                    model: binds
                        ? MODEL
                        : { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
                    thinks: (step) => step === 5,
                };
                const session = await sessionInToolLoop(
                    `thinking-${ride}-${binds ? "bound" : "unbound"}`,
                    shape,
                );
                session.setDecision("execute");
                session.setMarkerOutcome(() => busyWriter("definitely-no-cut"));
                served(await session.serve(hostArray(session.sessionId, 4, shape)));
                session.setDecision("defer");
                const host = (steps: number) =>
                    newTurnAtStep5(hostArray(session.sessionId, steps, shape), session.sessionId);
                const before = served(await session.serve(host(5)));
                expect(JSON.stringify(before)).toContain("sig-5");
                expect(before[2]?.info.id).not.toBe(MOVED_MARKER.summaryMessageId);

                // `/ctx-flush` with nothing queued and no new summary, or a
                // usage reading in the force band (90%, where a pass may rebuild
                // to relieve pressure) with nothing eligible: the pass may
                // rewrite, and the marker move is all it has to do.
                session.moveSucceeds();
                if (ride === "flush") session.flush();
                else session.setUsage(90);
                const landingPass = await session.serve(host(6));
                const landing = served(landingPass);
                expect(permissionLine(landingPass.logs)).toContain("allowed=true");
                expect(session.applyDeferred).toHaveBeenCalledTimes(2);
                expect(landing[2]?.info).toMatchObject({
                    id: MOVED_MARKER.summaryMessageId,
                    summary: true,
                });
                expect(landingPass.busted).toBe(true);
                const afterRow = JSON.stringify(landing.slice(3));
                const frozen = getMergedReasoningStrippedIds(session.db, session.sessionId);
                if (binds) {
                    expect(afterRow).not.toContain("sig-5");
                    expect(frozen).toContain(thinkingBindingRecoveryFrozenId("step-5"));
                } else {
                    expect(afterRow).toContain("sig-5");
                    expect(frozen).not.toContain(thinkingBindingRecoveryFrozenId("step-5"));
                }

                session.setUsage(30);
                const after = served(
                    await session.serve(
                        newTurnAtStep5(
                            hostArrayAfterMove(session.sessionId, 7, shape),
                            session.sessionId,
                        ),
                    ),
                );
                expect(JSON.stringify(after.slice(0, landing.length))).toBe(
                    JSON.stringify(landing),
                );
                expect(after).toHaveLength(landing.length + 1);
                expect(session.onLkgReplay).not.toHaveBeenCalled();
            });
        }
    }

    it("still refuses the pass when the host marker may have moved", async () => {
        const session = await sessionInToolLoop("uncertain");
        session.setDecision("execute");
        session.setMarkerOutcome(() => busyWriter("uncertain"));
        const pass = await session.serve(hostArray(session.sessionId, 4));
        expect(session.applyDeferred).toHaveBeenCalledTimes(1);
        expect(
            pass.logs.some((line) =>
                line.includes(
                    "transform refused degraded pass site=compaction-marker-drain-failure",
                ),
            ),
        ).toBe(true);
        expect(getPendingCompactionMarkerState(session.db, session.sessionId)).not.toBeNull();
        expect(session.deferredHistoryRefreshSessions.has(session.sessionId)).toBe(true);
    });
});

/**
 * A refused rebuild leaves part of its work saved (the new m[1], the stripped
 * thinking, a landed drop) while the wrapper serves the previous request in its
 * place. That replay applies the saved strips and drops to the newest messages
 * and is then served as the frozen recovery request.
 */
describe("the last-good replay of a refused rebuild", () => {
    it("stays frozen on the next step, because it records the host's messages as the host sends them, not as the replay edited them", async () => {
        const session = await sessionInToolLoop("refused-replay");
        // The rebuild saves its new m[1] and strips the turn's signed thinking,
        // then fails at a marker move whose outcome is unknown, so the wrapper
        // replays the previous request with the saved strips applied.
        session.setDecision("execute");
        session.setMarkerOutcome(() => busyWriter("uncertain"));
        const replay = served(await session.serve(hostArray(session.sessionId, 4)));
        expect(session.onLkgReplay).toHaveBeenCalledTimes(1);
        // The replay edited the newest step: its thinking is gone, while the
        // host still stores and resends it.
        expect(JSON.stringify(replay)).not.toContain("sig-4");
        expect(JSON.stringify(hostArray(session.sessionId, 4))).toContain("sig-4");

        // The next step: the host resends the same messages plus one. The
        // replay goes out again byte for byte and only the new step is added;
        // the saved rebuild waits for a pass that may rewrite the prefix.
        session.setDecision("defer");
        const nextPass = await session.serve(hostArray(session.sessionId, 5));
        const next = served(nextPass);
        expect(JSON.stringify(next.slice(0, replay.length))).toBe(JSON.stringify(replay));
        expect(next).toHaveLength(replay.length + 1);
        expect(nextPass.busted).toBe(false);
        expect(JSON.stringify(next)).not.toContain(
            "Advanced history published while the marker was pending",
        );
    });

    it("a pass that releases it with nothing else to rewrite strips the thinking produced since, because the history head it serves is the saved one", async () => {
        // Only step 5 thinks. Earlier thinking would leave a strip of merged
        // reasoning runs that the refused pass never reached, and the releasing
        // pass would apply it as an edit of its own.
        const shape: HostShape = { model: MODEL, thinks: (step) => step === 5 };
        const session = await sessionInToolLoop("refused-replay-release", shape);
        // From step 5 on, a new user message precedes step 5, so step 5's
        // thinking opens a run of its own and no strip that merges adjacent
        // assistants' reasoning reaches it.
        const host = (steps: number) =>
            newTurnAtStep5(hostArray(session.sessionId, steps, shape), session.sessionId);
        session.setDecision("execute");
        session.setMarkerOutcome(() => busyWriter("uncertain"));
        const replay = served(await session.serve(host(4)));
        expect(session.onLkgReplay).toHaveBeenCalledTimes(1);

        // Step 5 thinks after the replay went out, so its signature is bound to
        // the replay's history head.
        session.setDecision("defer");
        const frozen = served(await session.serve(host(5)));
        expect(JSON.stringify(frozen.slice(0, replay.length))).toBe(JSON.stringify(replay));
        expect(JSON.stringify(frozen)).toContain("sig-5");
        const savedHistory = "Advanced history published while the marker was pending";
        expect(JSON.stringify(frozen.slice(0, 2))).not.toContain(savedHistory);

        // A pass in the force band may rewrite the prefix and has nothing to
        // do: no history refresh or materialization is left, no drop is
        // queued and the marker provably stays where it is. Releasing the
        // replay is its only change in front of step 5's thinking.
        session.deferredHistoryRefreshSessions.delete(session.sessionId);
        session.deferredMaterializationSessions.delete(session.sessionId);
        session.setMarkerOutcome(() => busyWriter("definitely-no-cut"));
        session.setUsage(90);
        const releasePass = await session.serve(host(6));
        const released = served(releasePass);
        expect(permissionLine(releasePass.logs)).toContain("allowed=true");
        expect(releasePass.logs).toContain(
            "frozen replay release: the history head differs from the replay's; counting it as a head change",
        );
        expect(JSON.stringify(released.slice(0, 2))).toContain(savedHistory);
        expect(JSON.stringify(released)).not.toContain("sig-5");
        expect(getMergedReasoningStrippedIds(session.db, session.sessionId)).toContain(
            thinkingBindingRecoveryFrozenId("step-5"),
        );

        // The next step serves the released request byte for byte.
        session.setUsage(30);
        const after = served(await session.serve(host(7)));
        expect(JSON.stringify(after.slice(0, released.length))).toBe(JSON.stringify(released));
        expect(after).toHaveLength(released.length + 1);
    });

    // A release that serves the replay's own head changes nothing in front of
    // the thinking produced since, so that thinking stays.
    it("a pass that releases it with the history head unchanged keeps the thinking produced since", async () => {
        const shape: HostShape = { model: MODEL, thinks: (step) => step === 5 };
        const session = await sessionInToolLoop("refused-replay-same-head", shape);
        const host = (steps: number) =>
            newTurnAtStep5(hostArray(session.sessionId, steps, shape), session.sessionId);
        // A rebuild consumes the published history and moves the marker, so
        // no history is left for the releasing pass to add to the head.
        session.setDecision("execute");
        await session.serve(host(3));
        session.setDecision("defer");
        // No queued drop either: the releasing pass would apply it in front of
        // the new thinking, which strips that thinking for a reason of its own.
        clearPendingOps(session.db, session.sessionId);
        // The next pass changes nothing in the head and is refused because the
        // record of untagged messages cannot be saved, so the wrapper replays
        // the previous request.
        const spies = [
            spyOn(lkgRecoveryPrefix, "readPersistedLkgUntaggedInputIds").mockReturnValue([
                "untagged-row-no-longer-served",
            ]),
            spyOn(lkgRecoveryPrefix, "persistLkgUntaggedInputIds").mockReturnValue(false),
        ];
        let replay: Message[];
        try {
            replay = served(await session.serve(host(4)));
        } finally {
            for (const spy of spies) spy.mockRestore();
        }
        expect(session.onLkgReplay).toHaveBeenCalledTimes(1);
        const frozen = served(await session.serve(host(5)));
        expect(JSON.stringify(frozen.slice(0, replay.length))).toBe(JSON.stringify(replay));
        expect(JSON.stringify(frozen)).toContain("sig-5");

        // A pass at 90% usage (the force band, which may rewrite the prefix)
        // releases the replay with nothing else to do; the head it serves is
        // the replay's.
        session.deferredMaterializationSessions.delete(session.sessionId);
        session.setMarkerOutcome(() => busyWriter("definitely-no-cut"));
        session.setUsage(90);
        const releasePass = await session.serve(host(6));
        const released = served(releasePass);
        expect(permissionLine(releasePass.logs)).toContain("allowed=true");
        expect(JSON.stringify(released.slice(0, 2))).toBe(JSON.stringify(frozen.slice(0, 2)));
        expect(releasePass.logs).not.toContain(
            "frozen replay release: the history head differs from the replay's; counting it as a head change",
        );
        expect(JSON.stringify(released)).toContain("sig-5");
    });
});
