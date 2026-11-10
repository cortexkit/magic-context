/// <reference types="bun-types" />

import { afterEach, expect, test } from "bun:test";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { materializeM0 } from "./inject-compartments";
import { requestPendingMaterialization } from "./pending-materialization";
import type { MessageLike } from "./tag-messages";
import { runPostTransformPhase } from "./transform-postprocess-phase";

// On OpenCode 2 a manual /compact with published history makes the compaction
// hook commit a new history head (m[0]/m[1], the two synthetic messages at the
// start of every request) outside any pass and ask for a `host_compaction`
// materialization. The host can promote a /compact sent as a steering message
// between two steps of a running turn and then continue that turn, so the
// first pass after the compaction can be a step of an open turn with signed
// thinking. On a prefix-bound model that pass is held when one of the turn's
// recent steps reasoned heavily (see signed-thinking-hold.ts). A held pass
// replays the persisted head, which is already the one the hook committed:
// the hold keeps nothing unchanged, and every signed block it keeps behind
// that head no longer matches the bytes before it.

type PostTransformArgs = Parameters<typeof runPostTransformPhase>[0];

let db: Database | undefined;
afterEach(() => {
    db?.close();
    db = undefined;
});

const injection = {
    projectPath: "git:held-host-checkpoint",
    projectDirectory: "/nonexistent",
    memoryEnabled: false,
    injectDocs: false,
    historyBudgetTokens: 1000,
};

function args(
    database: Database,
    sessionId: string,
    messages: MessageLike[],
    overrides: Partial<PostTransformArgs>,
): PostTransformArgs {
    return {
        sessionId,
        db: database,
        messages,
        tags: [],
        targets: new Map(),
        reasoningByMessage: new Map(),
        messageTagNumbers: new Map(),
        tagger: createTagger(),
        ctxReduceAvailability: { callable: true, frozen: true },
        todowriteAvailability: { callable: true, frozen: true },
        batch: null,
        contextUsage: { percentage: 30, inputTokens: 30000 },
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
        sessionMeta: getOrCreateSessionMeta(database, sessionId),
        currentTurnId: null,
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        deferredMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 999,
        protectedTagIds: new Set(),
        protectedTagNumbers: new Set(),
        protectedCutoff: null,
        protectedCount: 0,
        pendingCompartmentInjection: null,
        didMutateFromFlushedStatuses: false,
        watermark: 0,
        forceMaterializationPercentage: 85,
        hasRecentReduceCall: false,
        ...overrides,
    };
}

/** An earlier turn and the open turn, each with a signed thinking block. */
function signedTurns(): MessageLike[] {
    return [
        { info: { id: "u0", role: "user" }, parts: [{ type: "text", text: "start" }] },
        { info: { id: "old-user", role: "user" }, parts: [{ type: "text", text: "old" }] },
        {
            info: { id: "old-thinking", role: "assistant" },
            parts: [
                { type: "reasoning", text: "old signed thought" },
                { type: "text", text: "old answer" },
            ],
        },
        { info: { id: "active-user", role: "user" }, parts: [{ type: "text", text: "continue" }] },
        {
            info: { id: "active-thinking", role: "assistant" },
            parts: [{ type: "reasoning", text: "active signed thought" }],
        },
    ] as MessageLike[];
}

/** Serve a head, then commit a different one outside any pass, as the
 * OpenCode 2 compaction hook does for a manual /compact with history. */
async function headCommittedOutsideAPass(sessionId: string) {
    const database = new Database(":memory:");
    db = database;
    initializeDatabase(database);
    const pending = new Set<string>();
    const warm: MessageLike[] = [
        { info: { id: "u0", role: "user" }, parts: [{ type: "text", text: "start" }] },
    ];
    await runPostTransformPhase(
        args(database, sessionId, warm, {
            m0M1: injection,
            pendingMaterializationSessions: pending,
        }),
    );
    const servedHead = JSON.stringify(warm.slice(0, 2));
    appendCompartments(database, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 1,
            startMessageId: "u0",
            endMessageId: "u0",
            title: "Published history",
            content: "The session started.",
            p1: "The session started.",
            p2: "The session started.",
            p3: "Started.",
            p4: "Started.",
        },
    ]);
    materializeM0({
        db: database,
        sessionId,
        state: getOrCreateSessionMeta(database, sessionId),
        ...injection,
    });
    requestPendingMaterialization(pending, sessionId, "host_compaction");
    return { database, pending, servedHead };
}

const heldPass = {
    activeThinkingTurn: true,
    activeThinkingPrefixHold: true,
    freezeM0M1: true,
    resolvedProviderID: "anthropic",
    resolvedModelID: "claude-opus-5-5",
    thinkingBindingRecoveryEnabledForModel: true,
    m0M1: injection,
} satisfies Partial<PostTransformArgs>;

const servedReasoning = (messages: MessageLike[]) =>
    messages
        .flatMap((message) => message.parts)
        .filter((part) => (part as { type?: string }).type === "reasoning");

test.failing("a held pass that serves a head committed outside a pass keeps no signed thinking behind it", async () => {
    const sessionId = "held-host-checkpoint-thinking";
    const { database, pending, servedHead } = await headCommittedOutsideAPass(sessionId);
    const messages = signedTurns();
    await runPostTransformPhase(
        args(database, sessionId, messages, {
            ...heldPass,
            pendingMaterializationSessions: pending,
        }),
    );
    // The held pass serves the head the hook committed, not the one the
    // previous request served: the bytes before every signed block changed.
    expect(JSON.stringify(messages.slice(0, 2))).not.toBe(servedHead);
    expect(JSON.stringify(messages.slice(0, 2))).toContain("Published history");
    // The pass keeps both signed blocks behind the new head, which a
    // prefix-bound model rejects or silently drops. The hold protects bytes
    // that are already gone, so this pass has to strip them as a first render
    // does when it serves a new head under a hold.
    expect(servedReasoning(messages)).toHaveLength(0);
});
