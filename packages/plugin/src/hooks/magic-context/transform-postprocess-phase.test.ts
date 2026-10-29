/// <reference types="bun-types" />

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import todoRideGolden from "../../../../../crates/mc-module/testdata/todo-ride-only.json";
import {
    clearSessionMetaFixtureFault,
    rejectSessionMetaCollectionWrites,
} from "../../features/magic-context/__tests__/session-meta-faults";
import {
    editCachedUpgradeFixture,
    patchSessionMeta,
} from "../../features/magic-context/__tests__/session-meta-fixture";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import * as embeddingModule from "../../features/magic-context/memory/embedding";
import { runMigrations } from "../../features/magic-context/migrations";
import { isPrefixBoundThinkingModel } from "../../features/magic-context/overflow-detection";
import {
    computeProtectionWindow,
    getProtectionWindowForSession,
} from "../../features/magic-context/protection-window";
import { protectedToolTagNumbers } from "../../features/magic-context/reclaim-protection";
import {
    addNote,
    addProcessedImageStrippedIds,
    addStaleReduceStrippedIds,
    advanceToolReclaimWatermark,
    applyStrippedPlaceholderDelta,
    getActiveTagsBySession,
    getChannel2NudgeState,
    getNoteNudgeAnchors,
    getOrCreateSessionMeta,
    getPendingCompactionMarkerState,
    getPendingOps,
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
    updateTagDropMode,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import * as replayStorage from "../../features/magic-context/storage-meta-persisted";
import {
    addMergedReasoningStrippedIds,
    addTrailingBlankDecisions,
    armThinkingBindingRecovery,
    clearThinkingBindingRecoveryIf,
    getCompactionMarkerHealth,
    getDeferredClearedCompactionMarkerState,
    getEmergencyInputSample,
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
import * as reasoningStorage from "../../features/magic-context/storage-reasoning-removal";
import { getRemovedReasoningIds } from "../../features/magic-context/storage-reasoning-removal";
import { updateSessionMetaCollection } from "../../features/magic-context/storage-session-collections";
import * as storageTags from "../../features/magic-context/storage-tags";
import {
    markWhitespaceAssistantTagInert,
    updateTagStatus,
} from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import * as loggerModule from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { adaptPayload } from "../../v2/hooks/payload";
import type { SessionContext } from "../../v2/hooks/types";
import {
    createAutoSearchReplayFixture,
    replayHint,
    replayPrompt,
} from "./auto-search-replay.fixture";
import * as autoSearchRunner from "./auto-search-runner";
import { autoSearchTestSnapshot } from "./auto-search-snapshot.fixture";
import * as searchModule from "./auto-search-worker-client";
import { MARKER_SUMMARY_TEXT } from "./compaction-marker-manager";
import { registerActiveCompartmentRun } from "./compartment-runner";
import { queueDropsForCompartmentalizedMessages } from "./compartment-runner-drop-queue";
import { clearToolPermissionDenied } from "./ctx-reduce-availability";
import type { Channel1State } from "./ctx-reduce-nudge";
import * as staleReduce from "./drop-stale-reduce-calls";
import { estimateMessageTokens } from "./final-wire-token-estimate";
import * as heuristicCleanup from "./heuristic-cleanup";
import * as compartmentInjection from "./inject-compartments";
import {
    capturePrefixTrimSourceOrder,
    injectM0M1,
    type M0HardSignals,
    materializeM0,
} from "./inject-compartments";
import * as noteNudger from "./note-nudger";
import { createPassOutcome } from "./pass-outcome";
import {
    pendingMaterializationOrigin,
    recordSystemPromptEdit,
    requestPendingMaterialization,
} from "./pending-materialization";
import * as readSessionFormatting from "./read-session-formatting";
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
import { findLastUserMessageId } from "./transform-message-helpers";
import * as operations from "./transform-operations";
import { applyFlushedStatuses } from "./transform-operations";
import {
    abortSessionFailClosed,
    applyRustModeDeferredCompactionMarker,
    checkM0MutationDriftAndSignal,
    clearPendingCompactionMarkerAfterSuccessfulDrain,
    evaluateEmergencyFailClosed,
    finalizeMessageRepresentation,
    reconcileMarkerRepresentation,
    replayRustModeBindingMismatchStrips,
    runRustModePostprocess,
    runPostTransformPhase as runUnfinalizedPostTransformPhase,
} from "./transform-postprocess-phase";

const SESSION_ID = "ses-postprocess-drift";
const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
let db: Database;

/**
 * Grow the global user profile enough that its m[1] delta alone exceeds the m[1]
 * pressure cap of a 500-token history budget. A busting SOFT renders profile
 * changes but reads no memory rows, so this is how the tests produce SOFT pressure.
 */
async function growUserProfile(label: string): Promise<void> {
    const { insertUserMemory } = await import(
        "../../features/magic-context/user-memory/storage-user-memory"
    );
    const { bumpProjectUserProfileVersion } = await import(
        "../../features/magic-context/storage-project-state"
    );
    for (let i = 0; i < 45; i++) insertUserMemory(db, `${label}_${i}: user rule ${i}.`, []);
    bumpProjectUserProfileVersion(db);
}

function createOpenCodeDbWithoutMessages(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    mkdirSync(join(dir, "opencode"), { recursive: true });
    const opencodeDb = new Database(join(dir, "opencode", "opencode.db"));
    // Create the fixture in WAL mode like OpenCode. Schema writes create the
    // -wal/-shm files; without them, macOS SQLite can reject a readonly worker's
    // first read after a late switch from rollback journaling to WAL.
    opencodeDb.exec("PRAGMA journal_mode=WAL");
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
                state: { output: "word ".repeat(999), status: "completed" },
            },
        ],
    } as unknown as MessageLike;
}

function makeDropTarget(message: MessageLike): TagTarget {
    return {
        message,
        measureReclaim(skeleton) {
            const before = estimateMessageTokens(message).toolCall;
            const clone = structuredClone(message);
            const index = clone.parts.findIndex(
                (part) => (part as { type?: string }).type === "tool",
            );
            if (index >= 0) {
                if (skeleton)
                    (clone.parts[index] as { state: { output: string } }).state.output =
                        "[dropped]";
                else clone.parts.splice(index, 1);
            }
            return {
                beforeTools: before,
                afterTools: estimateMessageTokens(clone).toolCall,
                beforeProse: 0,
                afterProse: 0,
            };
        },
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
        // These mock calls carry no input, so a drop inside the newest-call window
        // keeps them as a (real-argument) skeleton with the same placeholder output.
        skeletonReal: () => {
            const part = message.parts.find(
                (candidate) => (candidate as { type?: string }).type === "tool",
            ) as { state?: { output?: string } } | undefined;
            if (!part?.state) return "absent";
            part.state.output = "[dropped]";
            return "truncated";
        },
        inputStringBytes: () => 0,
        canDrop: () => message.parts.some((part) => (part as { type?: string }).type === "tool"),
    };
}

import { prepareCachedM0M1Replay } from "./inject-compartments";
import { prefixTurn, readServedPrefix, writeServedPrefix } from "./served-prefix";

async function runPostTransformPhase(args: Parameters<typeof runUnfinalizedPostTransformPhase>[0]) {
    const result = await runUnfinalizedPostTransformPhase(args);
    // A completed request includes final record publication, which production
    // performs after restoring any recovery prefix.
    if (result.finalizeServedPrefix?.()) result.bustedThisPass = true;
    return result;
}

// Production records the request's model in the provenance, and the first-kept
// digest binds it, so a seeded record must name the model the test passes run on.
const SEEDED_PREFIX_MODEL = { provider: "anthropic", id: "claude-opus-5-5" };

function seedHeldServedPrefix(
    db: Database,
    sessionId: string,
    messages: MessageLike[],
    head?: MessageLike[],
): void {
    writeServedPrefix({
        db,
        sessionId,
        head: head ?? prepareCachedM0M1Replay(db, sessionId)!.preparedMessages!,
        summary: null,
        firstKept: messages[0],
        firstKeptId: messages[0]?.info.id,
        turn: prefixTurn(messages, (message) => message.info.id),
        provenance: {
            host: "opencode-v1",
            id_space: "opencode-v1-message",
            generation: "v1",
            projection: "messages",
            model: SEEDED_PREFIX_MODEL,
        },
    });
}

type PostTransformArgs = Parameters<typeof runPostTransformPhase>[0];

// What the system-prompt hook leaves behind when the host's top-level system
// prompt changes: the system-prompt edit record and, unless the change was
// adopted without a flush, a "system_hash" materialization request.
function hostSystemChanged(
    sessionId: string,
    sessions = new Set<string>(),
    options: { materialize?: boolean } = {},
): Set<string> {
    if (options.materialize !== false)
        requestPendingMaterialization(sessions, sessionId, "system_hash");
    recordSystemPromptEdit(sessions, sessionId);
    return sessions;
}

function basePostTransformArgs(
    db: Database,
    sessionId: string,
    messages: MessageLike[],
    overrides: Partial<PostTransformArgs> = {},
): PostTransformArgs {
    // Raw set membership in these fixtures represents a command request. Use
    // the production API so admission can distinguish it from deferred work.
    if (
        overrides.pendingMaterializationSessions?.has(sessionId) &&
        pendingMaterializationOrigin(overrides.pendingMaterializationSessions, sessionId) ===
            "pending_materialization"
    ) {
        requestPendingMaterialization(
            overrides.pendingMaterializationSessions,
            sessionId,
            "user_flush",
        );
    }
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

function cloneMessages(messages: MessageLike[]): MessageLike[] {
    return structuredClone(messages);
}

it("repairs previously served tag-emptied history through one shared rebuild, then defers identically", async () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const { markServedShapeRepair } = await import("./served-shape-repair");
    const sessionId = "served-shape-recovery";
    const source = (): MessageLike[] => [
        {
            info: { id: "old", role: "assistant", providerID: "openai" },
            parts: [{ type: "text", text: "§58§" }],
        },
        { info: { id: "error-1", role: "assistant", finish: "error" }, parts: [] },
        { info: { id: "error-2", role: "assistant", finish: "error" }, parts: [] },
        { info: { id: "retry", role: "user" }, parts: [{ type: "text", text: "retry" }] },
    ];
    const old = source();
    (old[0].parts[0] as { text: string }).text = "";
    let previous = old;
    for (let pass = 0; pass < 3; pass++) {
        const messages = source();
        markServedShapeRepair(messages[0].info, [{ index: 0, text: "§58§" }]);
        const result = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                readLastServedMessages: () => previous,
                resolvedProviderID: "openai",
            }),
        );
        expect(result.bustedThisPass).toBe(pass === 0);
        expect((messages[0].parts[0] as { text: string }).text).toBe("§58§");
        if (pass > 0) expect(JSON.stringify(messages)).toBe(JSON.stringify(previous));
        previous = structuredClone(messages);
    }
    db.close();
});

for (const host of ["opencode", "opencode2"] as const) {
    describe(`${host} auto-search served decisions`, () => {
        function setup(label: string) {
            const fixture = createAutoSearchReplayFixture(host, label);
            const snapshot = spyOn(embeddingModule, "getProjectEmbeddingSnapshot").mockReturnValue(
                autoSearchTestSnapshot(fixture.projectPath),
            );
            const search = spyOn(searchModule, "searchAutoHint").mockResolvedValue([replayHint]);
            return {
                ...fixture,
                search,
                async invoke(id: string, busting = false) {
                    const user = {
                        info: { id, role: "user" },
                        parts: [{ type: "text", text: replayPrompt }],
                    } as MessageLike;
                    const input = basePostTransformArgs(fixture.db, fixture.sessionId, [user], {
                        currentTurnId: id,
                        schedulerDecision: busting ? "execute" : "defer",
                        projectPath: fixture.projectPath,
                        autoSearch: { enabled: true, scoreThreshold: 0.6, minPromptChars: 12 },
                        m0M1: fixture.renderOptions(
                            busting ? "anthropic/other" : "anthropic/claude",
                        ),
                    });
                    const result = await runPostTransformPhase(input);
                    return { userBytes: JSON.stringify(user), result };
                },
                close() {
                    search.mockRestore();
                    snapshot.mockRestore();
                    fixture.close();
                },
            };
        }

        it("full host processor cannot retry a served search exception", async () => {
            const fixture = setup("host-exception");
            fixture.search.mockImplementationOnce(async () => {
                throw new Error("transient host-search failure");
            });
            try {
                const first = await fixture.invoke("u1");
                expect(first.userBytes).not.toContain("<ctx-search-hint>");
                expect(fixture.search).toHaveBeenCalledTimes(1);
                const second = await fixture.invoke("u1");
                expect(second.userBytes).toBe(first.userBytes);
                expect(fixture.search).toHaveBeenCalledTimes(1);
            } finally {
                fixture.close();
            }
        });

        it("full host processor preserves a served hint when a truncated branch is restored", async () => {
            const fixture = setup("host-restore");
            try {
                const first = await fixture.invoke("u1");
                expect(first.userBytes).toContain("Independent search-only hint");
                const truncated = await fixture.invoke("u2", true);
                expect(truncated.result.materialized).toBe(true);
                expect(truncated.result.bustedThisPass).toBe(true);
                const retained = replayStorage.getAutoSearchHintDecisions(
                    fixture.db,
                    fixture.sessionId,
                );
                expect(retained.some((decision) => decision.messageId === "u1")).toBe(true);
                fixture.search.mockResolvedValue([
                    { ...replayHint, memoryId: 9001, content: "Recomputed changed hint" },
                ]);
                const restored = await fixture.invoke("u1");
                expect(restored.userBytes).toBe(first.userBytes);
                expect(restored.userBytes).not.toContain("Recomputed changed hint");
                expect(fixture.search).toHaveBeenCalledTimes(2);
            } finally {
                fixture.close();
            }
        });

        it("busting host flushes retirement staged by a prior cached cut", async () => {
            const fixture = setup("staged-retirement");
            try {
                expect((await fixture.invoke("u1")).userBytes).toContain(
                    "Independent search-only hint",
                );
                appendCompartments(fixture.db, fixture.sessionId, [
                    {
                        sequence: 0,
                        startMessage: 0,
                        endMessage: 0,
                        startMessageId: "u1",
                        endMessageId: "u1",
                        title: "Covered",
                        content: "Earlier question was answered.",
                    },
                ]);
                materializeM0(fixture.renderOptions());
                const live = ["u1", "u2"].map(
                    (id) =>
                        ({
                            info: { id, role: "user" },
                            parts: [{ type: "text", text: replayPrompt }],
                        }) as MessageLike,
                );
                expect(
                    injectM0M1({
                        ...fixture.renderOptions(),
                        messages: live,
                        isCacheBustingPass: false,
                    }).prefixTrimStatus,
                ).toBe("applied");
                expect(
                    replayStorage
                        .getAutoSearchHintDecisions(fixture.db, fixture.sessionId)
                        .some((entry) => entry.messageId === "u1"),
                ).toBe(true);
                await fixture.invoke("u2", true);
                expect(
                    replayStorage
                        .getAutoSearchHintDecisions(fixture.db, fixture.sessionId)
                        .some((entry) => entry.messageId === "u1"),
                ).toBe(false);
            } finally {
                fixture.close();
            }
        });

        it("ordinary pass preserves visible user bytes at the omission cap boundary", async () => {
            const fixture = setup("visible-cap-boundary");
            const count = replayStorage.AUTO_SEARCH_DECISION_SOFT_LIMIT + 2;
            const visibleIds = Array.from({ length: count }, (_, index) => `visible-${index}`);
            const serve = async () => {
                const messages = visibleIds.map(
                    (id) =>
                        ({
                            info: { id, role: "user" },
                            parts: [{ type: "text", text: replayPrompt }],
                        }) as MessageLike,
                );
                await runPostTransformPhase(
                    basePostTransformArgs(fixture.db, fixture.sessionId, messages),
                );
                return JSON.stringify(messages);
            };
            try {
                // Seed historical decisions once instead of repeatedly parsing
                // and rewriting a growing array. Replay and retirement are the
                // behavior under test; the final append still uses the live API.
                getOrCreateSessionMeta(fixture.db, fixture.sessionId);
                patchSessionMeta(fixture.db, fixture.sessionId, {
                    auto_search_hint_decisions: JSON.stringify(
                        visibleIds.slice(0, -1).map((messageId, index) =>
                            index === 0
                                ? {
                                      messageId,
                                      decision: "hint",
                                      text: "\n\n<ctx-search-hint>stable cap-boundary hint</ctx-search-hint>",
                                  }
                                : { messageId, decision: "no-hint", reason: "error" },
                        ),
                    ),
                });
                expect(
                    replayStorage.appendAutoSearchHintDecision(fixture.db, fixture.sessionId, {
                        messageId: visibleIds[count - 1]!,
                        decision: "no-hint",
                        reason: "error",
                    }),
                ).toMatchObject({ ok: true, kind: "appended" });
                const first = await serve();
                expect(first).toContain("stable cap-boundary hint");
                const retired = replayStorage.flushAutoSearchHintDecisionRetirement(
                    fixture.db,
                    fixture.sessionId,
                    new Set(visibleIds),
                );
                expect(await serve()).toBe(first);
                expect(retired).toBe(0);
                expect(
                    replayStorage.getAutoSearchHintDecisions(fixture.db, fixture.sessionId),
                ).toHaveLength(count);
            } finally {
                fixture.close();
            }
        });
    });
}

describe("postprocess replay-or-refuse", () => {
    const sites = [
        "pending-operation-failure",
        "stale-reduce-strip-exception",
        "image-strip-exception",
        "m0-m1-fold-preexecution-degradation",
        "m0-m1-injection-degradation",
        "compaction-marker-drain-failure",
        "reasoning-removal-persistence-failure",
        "reasoning-removal-committed-read-failure",
        "thinking-binding-recovery-persistence-failure",
        "merged-reasoning-strip-persistence-failure",
        "merged-reasoning-strip-exception",
        "trailing-blank-heal-persistence-failure",
        "trailing-blank-heal-exception",
        "trailing-blank-decision-persistence-failure",
        "trailing-blank-decision-exception",
        "proactive-thinking-strip-persistence-failure",
    ] as const;

    for (const site of sites) {
        it(`refuses an under-limit pass at ${site}`, async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = `ses-refuse-${site}`;
            const messages = [
                { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "question" }] },
                ...["a1", "a2", "a3"].map((id) => ({
                    info: { id, role: "assistant" },
                    parts: [
                        { type: "thinking", thinking: `signed ${id}`, signature: `sig-${id}` },
                        { type: "text", text: `answer ${id}` },
                    ],
                })),
                { info: { id: "u2", role: "user" }, parts: [{ type: "text", text: "next" }] },
            ] as unknown as MessageLike[];
            const passOutcome = createPassOutcome();
            const args = basePostTransformArgs(db, sessionId, messages, {
                resolvedProviderID: "anthropic",
                passOutcome,
            });
            const error = new Error(`injected ${site}`);
            const fail = () => {
                throw error;
            };
            const spies: Array<{ mockRestore(): void }> = [];
            let reached = 0;
            const throwAtSite = () => {
                reached++;
                return fail();
            };
            const falseAtSite = () => {
                reached++;
                return false;
            };
            try {
                switch (site) {
                    case "pending-operation-failure":
                        args.batch = {
                            finalize: () => {
                                // Model a stage that edits some bytes before failing.
                                messages[1].parts.splice(0, 1);
                                throwAtSite();
                            },
                        };
                        break;
                    case "stale-reduce-strip-exception":
                        spies.push(
                            spyOn(staleReduce, "dropStaleReduceCalls").mockImplementation(
                                throwAtSite,
                            ),
                        );
                        break;
                    case "image-strip-exception":
                        spies.push(
                            spyOn(operations, "stripProcessedImages").mockImplementation(
                                throwAtSite,
                            ),
                        );
                        break;
                    case "m0-m1-fold-preexecution-degradation":
                    case "m0-m1-injection-degradation":
                        args.m0M1 = {
                            projectDirectory: "/throwaway-project",
                            injectDocs: false,
                            memoryEnabled: false,
                            historyBudgetTokens: 1000,
                        };
                        if (site === "m0-m1-injection-degradation") {
                            args.pendingCompartmentInjection = {
                                compartmentEndMessage: 1,
                                compartmentEndMessageId: "u1",
                                compartmentCount: 1,
                                renderedText: "history",
                                skippedVisibleMessages: 0,
                            } as PostTransformArgs["pendingCompartmentInjection"];
                            const legacy = spyOn(
                                compartmentInjection,
                                "renderCompartmentInjection",
                            );
                            spies.push(legacy);
                        }
                        spies.push(
                            spyOn(compartmentInjection, "mustMaterialize").mockReturnValue({
                                value: site === "m0-m1-fold-preexecution-degradation",
                                reason: null,
                            }),
                        );
                        spies.push(
                            spyOn(compartmentInjection, "injectM0M1").mockImplementation(
                                throwAtSite,
                            ),
                        );
                        break;
                    case "compaction-marker-drain-failure":
                        setPendingCompactionMarkerState(db, sessionId, {
                            ordinal: 1,
                            endMessageId: "u1",
                            publishedAt: 1,
                        });
                        args.historyRebuiltThisPass = true;
                        args.canConsumeDeferredLate = true;
                        args.deferredHistoryWasPendingAtPassStart = true;
                        args.pendingCompartmentInjection = {
                            compartmentEndMessage: 1,
                            compartmentEndMessageId: "u1",
                            compartmentCount: 1,
                            renderedText: "history",
                            skippedVisibleMessages: 0,
                        } as PostTransformArgs["pendingCompartmentInjection"];
                        args.compactionMarkerStrategy = {
                            applyDeferred: () => {
                                reached++;
                                return { kind: "retryable-failure", error };
                            },
                            reconcile: () => {},
                        };
                        break;
                    case "reasoning-removal-persistence-failure":
                    case "reasoning-removal-committed-read-failure":
                        args.resolvedProviderID = "openai";
                        requestPendingMaterialization(
                            args.pendingMaterializationSessions,
                            sessionId,
                            "user_flush",
                        );
                        args.keepReasoningTokens = 0;
                        messages.forEach((message, index) => {
                            args.messageTagNumbers.set(message, index + 1);
                        });
                        if (site === "reasoning-removal-persistence-failure")
                            spies.push(
                                spyOn(
                                    reasoningStorage,
                                    "addRemovedReasoningIds",
                                ).mockImplementation(falseAtSite),
                            );
                        else {
                            const read = reasoningStorage.getReasoningRemovalState;
                            spies.push(
                                spyOn(reasoningStorage, "getReasoningRemovalState")
                                    .mockImplementationOnce(read)
                                    .mockImplementationOnce(throwAtSite),
                            );
                        }
                        break;
                    case "thinking-binding-recovery-persistence-failure":
                        armThinkingBindingRecovery(db, sessionId);
                        args.thinkingBindingRecoveryEnabledForModel = true;
                        spies.push(
                            spyOn(
                                replayStorage,
                                "addMergedReasoningStrippedIds",
                            ).mockImplementation(falseAtSite),
                        );
                        break;
                    case "merged-reasoning-strip-persistence-failure":
                    case "merged-reasoning-strip-exception":
                        requestPendingMaterialization(
                            args.pendingMaterializationSessions,
                            sessionId,
                            "user_flush",
                        );
                        spies.push(
                            spyOn(
                                replayStorage,
                                "addMergedReasoningStrippedIds",
                            ).mockImplementation(
                                site.endsWith("exception") ? throwAtSite : falseAtSite,
                            ),
                        );
                        break;
                    case "trailing-blank-heal-persistence-failure":
                    case "trailing-blank-heal-exception":
                        expect(addTrailingBlankDecisions(db, sessionId, [["a1", "keep:2"]])).toBe(
                            true,
                        );
                        requestPendingMaterialization(
                            args.pendingMaterializationSessions,
                            sessionId,
                            "user_flush",
                        );
                        args.trailingBlankSourceDecisions = new Map([["a1", "strip"]]);
                        spies.push(
                            spyOn(
                                replayStorage,
                                "demoteTrailingBlankKeepDecisions",
                            ).mockImplementation(() => {
                                reached++;
                                if (site.endsWith("exception")) fail();
                                return null;
                            }),
                        );
                        break;
                    case "trailing-blank-decision-persistence-failure":
                    case "trailing-blank-decision-exception":
                        spies.push(
                            spyOn(replayStorage, "addTrailingBlankDecisions").mockImplementation(
                                site.endsWith("exception") ? throwAtSite : falseAtSite,
                            ),
                        );
                        break;
                    case "proactive-thinking-strip-persistence-failure":
                        hostSystemChanged(sessionId, args.pendingMaterializationSessions);
                        requestPendingMaterialization(
                            args.pendingMaterializationSessions,
                            sessionId,
                            "user_flush",
                        );
                        args.thinkingBindingRecoveryEnabledForModel = true;
                        // Isolate the proactive lane from merged-run detection.
                        messages.splice(2, 0, {
                            info: { id: "separator", role: "user" },
                            parts: [{ type: "text", text: "another question" }],
                        } as unknown as MessageLike);
                        messages.splice(4, 0, {
                            info: { id: "separator2", role: "user" },
                            parts: [{ type: "text", text: "another question" }],
                        } as unknown as MessageLike);
                        spies.push(
                            spyOn(
                                replayStorage,
                                "addMergedReasoningStrippedIds",
                            ).mockImplementation(falseAtSite),
                        );
                        break;
                }
                await expect(runPostTransformPhase(args)).rejects.toMatchObject({
                    name: "DegradedPassRefusalError",
                    site:
                        site === "reasoning-removal-committed-read-failure"
                            ? "reasoning-removal-read-failure"
                            : site,
                });
                expect(reached).toBeGreaterThan(0);
                expect(
                    passOutcome.degradations.some(
                        (degradation) =>
                            degradation.site ===
                            (site === "reasoning-removal-committed-read-failure"
                                ? "reasoning-removal-read-failure"
                                : site),
                    ),
                ).toBe(true);
            } finally {
                for (const spy of spies.reverse()) spy.mockRestore();
            }
        });
    }
});

describe("note nudge first-serve fence", () => {
    const makeNoteDb = (path = ":memory:") => {
        db = new Database(path);
        initializeDatabase(db);
        runMigrations(db);
    };
    const oldId = "msg_0fde60284001HWrjLLMr7NA6U3";
    const newestId = "msg_1132b8f570015eW5juiKW3okXV";
    const source = () =>
        [
            {
                info: { id: oldId, role: "user" },
                parts: [{ type: "text", text: "old real user prompt" }],
            },
            {
                info: { id: "answer", role: "assistant" },
                parts: [{ type: "text", text: "working" }],
            },
            {
                info: { id: newestId, role: "user" },
                parts: [
                    {
                        type: "text",
                        text: '§25124§ <system-reminder><channel-notice room="fleet">Hold launches.</channel-notice></system-reminder>',
                    },
                ],
            },
        ] as MessageLike[];

    it("delivers on the SYNAPSE rebuild to the resolved wire user and replays identically on defer", async () => {
        makeNoteDb();
        const sessionId = "synapse-rebuild-note";
        getOrCreateSessionMeta(db, sessionId);
        // Serve the old user and assistant first, so the observer can prove the
        // later channel notice is an unserved user message at the tail.
        await runPostTransformPhase(basePostTransformArgs(db, sessionId, source().slice(0, 2)));
        addNote(db, "session", { sessionId, content: "Check deferred work" });
        noteNudger.onNoteTrigger(db, sessionId, "historian_complete");
        // The raw meaningful-user resolver skipped the newest channel notice.
        replayStorage.setPersistedNoteNudgeTriggerMessageId(db, sessionId, oldId);
        const raw = source();
        (raw[2].parts[0] as { text: string }).text =
            '<system-reminder><channel-notice room="fleet">Hold launches.</channel-notice></system-reminder>';
        expect(findLastUserMessageId(raw)).toBe(oldId);
        expect(findLastUserMessageId(source())).toBe(newestId);
        const pass = async (bust: boolean) => {
            const messages = source();
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    currentTurnId: bust ? oldId : newestId,
                    pendingMaterializationSessions: new Set(bust ? [sessionId] : []),
                }),
            );
            return messages;
        };
        const rebuild = await pass(true);
        expect(getNoteNudgeAnchors(db, sessionId).map((a) => a.messageId)).toEqual([newestId]);
        expect(JSON.stringify(rebuild[0])).not.toContain("deferred_notes");
        expect(JSON.stringify(rebuild[2])).toContain("deferred_notes");
        expect(await pass(false)).toEqual(rebuild);
        expect(await pass(false)).toEqual(rebuild);
    });

    it("never delivers a late trigger to an already-served user, even when trigger identity differs", async () => {
        makeNoteDb();
        const sessionId = "synapse-late-note";
        const pass = async (next = false) => {
            const messages = source();
            if (next)
                messages.push({
                    info: { id: "next-user", role: "user" },
                    parts: [{ type: "text", text: "New work" }],
                });
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, { currentTurnId: newestId }),
            );
            return messages;
        };
        const served = await pass();
        addNote(db, "session", { sessionId, content: "Late condition check" });
        noteNudger.onNoteTrigger(db, sessionId, "historian_complete");
        replayStorage.setPersistedNoteNudgeTriggerMessageId(db, sessionId, oldId);
        expect(await pass()).toEqual(served);
        expect(getNoteNudgeAnchors(db, sessionId)).toEqual([]);
        const delivered = await pass(true);
        expect(delivered.slice(0, 3)).toEqual(served);
        expect(getNoteNudgeAnchors(db, sessionId).map((a) => a.messageId)).toEqual(["next-user"]);
        expect(await pass(true)).toEqual(delivered);
    });

    it("a restart with a stale trigger cannot append to the previously served newest user", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "note-restart-"));
        const path = join(root, "context.db");
        makeNoteDb(path);
        const sessionId = "note-restart";
        const pass = async (bust = false, fresh = false) => {
            const messages = source();
            if (fresh)
                messages.push({
                    info: { id: "after-restart", role: "user" },
                    parts: [{ type: "text", text: "Next task" }],
                } as MessageLike);
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    currentTurnId: newestId,
                    pendingMaterializationSessions: new Set(bust ? [sessionId] : []),
                }),
            );
            return messages;
        };
        try {
            const served = await pass();
            addNote(db, "session", { sessionId, content: "Survives restart" });
            noteNudger.onNoteTrigger(db, sessionId, "historian_complete");
            replayStorage.setPersistedNoteNudgeTriggerMessageId(db, sessionId, oldId);
            db.close();
            makeNoteDb(path);
            expect(await pass()).toEqual(served);
            expect(await pass()).toEqual(served);
            expect(getNoteNudgeAnchors(db, sessionId)).toEqual([]);
            // A requested materialization with no proven earlier wire edit is
            // not permission to rewrite an already-served user message.
            expect(await pass(true)).toEqual(served);
            const fresh = await pass(false, true);
            expect(JSON.stringify(fresh.at(-1))).toContain("deferred_notes");
            expect(await pass(false, true)).toEqual(fresh);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("the Rust host requires a fresh tail when only bust permission is available", () => {
        makeNoteDb();
        const sessionId = "rust-note-first-serve";
        getOrCreateSessionMeta(db, sessionId);
        const pass = (cacheBustingPass = false, fresh = false) => {
            const messages = source();
            if (fresh)
                messages.push({
                    info: { id: "rust-fresh", role: "user" },
                    parts: [{ type: "text", text: "Next task" }],
                } as MessageLike);
            runRustModePostprocess({
                db,
                sessionId,
                messages,
                fullFeatureMode: true,
                cacheBustingPass,
            });
            return messages;
        };
        const served = pass();
        addNote(db, "session", { sessionId, content: "Rust boundary note" });
        noteNudger.onNoteTrigger(db, sessionId, "historian_complete");
        replayStorage.setPersistedNoteNudgeTriggerMessageId(db, sessionId, oldId);
        expect(pass()).toEqual(served);
        expect(getNoteNudgeAnchors(db, sessionId)).toEqual([]);
        expect(pass(true)).toEqual(served);
        replayStorage.appendAutoSearchHintDecision(db, sessionId, {
            messageId: "rust-fresh",
            decision: "hint",
            text: "\n\n<ctx-search-hint>saved hint</ctx-search-hint>",
        });
        const fresh = pass(false, true);
        expect(JSON.stringify(fresh.at(-1))).toContain("deferred_notes");
        expect(JSON.stringify(fresh.at(-1))).toContain("ctx-search-hint");
        expect(pass(false, true)).toEqual(fresh);
    });
});

describe("optional fresh-tail additions", () => {
    for (const site of ["note-nudge-cas-failure", "auto-search-internal-failure"] as const) {
        it(`serves an under-limit pass at ${site} without changing the historical prefix`, async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = `ses-optional-${site}`;
            const source = [
                {
                    info: { id: "old-user", role: "user" },
                    parts: [{ type: "text", text: "old question" }],
                },
                {
                    info: { id: "old-answer", role: "assistant" },
                    parts: [
                        {
                            type: "thinking",
                            thinking: "persisted reasoning to strip",
                            signature: "old-signature",
                        },
                        { type: "text", text: "old answer" },
                    ],
                },
                {
                    info: { id: "fresh-user", role: "user" },
                    parts: [{ type: "text", text: "new question" }],
                },
            ] as unknown as MessageLike[];
            expect(
                addMergedReasoningStrippedIds(db, sessionId, [
                    replayStorage.thinkingBindingRecoveryFrozenId("old-answer"),
                ]),
            ).toBe(true);
            const savedReminder =
                '\n\n<instruction name="deferred_notes">saved reminder</instruction>';
            const savedHint = "\n\n<ctx-search-hint>saved fragment</ctx-search-hint>";
            expect(
                replayStorage.deliverNoteNudgeAtomic(db, sessionId, "old-user", savedReminder).ok,
            ).toBe(true);
            expect(
                replayStorage.appendAutoSearchHintDecision(db, sessionId, {
                    messageId: "old-user",
                    decision: "hint",
                    text: savedHint,
                }).ok,
            ).toBe(true);
            const argsFor = (messages: MessageLike[], passOutcome = createPassOutcome()) =>
                basePostTransformArgs(db, sessionId, messages, {
                    resolvedProviderID: "anthropic",
                    currentTurnId: "fresh-user",
                    passOutcome,
                    ...(site === "auto-search-internal-failure"
                        ? {
                              projectPath: "/throwaway-project",
                              autoSearch: { enabled: true, scoreThreshold: 0, minPromptChars: 1 },
                          }
                        : {}),
                });
            const spies: Array<{ mockRestore(): void }> = [];
            let failed = false;
            let reached = 0;
            const addition =
                site === "note-nudge-cas-failure"
                    ? '\n\n<instruction name="deferred_notes">optional reminder</instruction>'
                    : "\n\n<ctx-search-hint>optional fragment</ctx-search-hint>";
            try {
                if (site === "note-nudge-cas-failure") {
                    spies.push(
                        spyOn(noteNudger, "peekNoteNudgeText").mockReturnValue("optional reminder"),
                    );
                    spies.push(
                        spyOn(noteNudger, "markNoteNudgeDelivered").mockImplementation(() => {
                            reached++;
                            return failed
                                ? { ok: false, kind: "cas-exhausted" }
                                : { ok: true, kind: "appended" };
                        }),
                    );
                } else {
                    spies.push(
                        spyOn(autoSearchRunner, "runAutoSearchHint").mockImplementation(
                            async ({ messages }) => {
                                reached++;
                                if (failed) throw new Error("optional fresh-tail search failed");
                                const part = messages.at(-1)!.parts[0] as { text: string };
                                part.text += addition;
                                return { ok: true };
                            },
                        ),
                    );
                }
                const healthy = cloneMessages(source);
                const healthyOutcome = createPassOutcome();
                await runPostTransformPhase(argsFor(healthy, healthyOutcome));
                expect(healthyOutcome.degradations).toEqual([]);
                expect((healthy[0].parts[0] as { text: string }).text).toBe(
                    `old question${savedReminder}${savedHint}`,
                );
                expect((healthy.at(-1)!.parts[0] as { text: string }).text).toBe(
                    `new question${addition}`,
                );
                expect(JSON.stringify(healthy)).not.toContain("persisted reasoning to strip");
                // Compare served arrays, not the raw input: the reasoning replay
                // after these optional lanes must still complete on a failed pass.
                const healthyMinusAddition = cloneMessages(healthy);
                (healthyMinusAddition.at(-1)!.parts[0] as { text: string }).text = "new question";
                failed = true;
                for (let pass = 0; pass < 2; pass++) {
                    const messages = cloneMessages(source);
                    const passOutcome = createPassOutcome();
                    await runPostTransformPhase(argsFor(messages, passOutcome));
                    expect(passOutcome.degradations).toEqual([{ site, kind: "degraded" }]);
                    expect(JSON.stringify(messages.slice(0, -1))).toBe(
                        JSON.stringify(healthy.slice(0, -1)),
                    );
                    expect(JSON.stringify(messages)).toBe(JSON.stringify(healthyMinusAddition));
                    expect(JSON.stringify(messages).length).toBeLessThan(
                        JSON.stringify(healthy).length,
                    );
                }
                expect(reached).toBe(3);
            } finally {
                for (const spy of spies.reverse()) spy.mockRestore();
            }
        });
    }
});

describe("postprocess replay snapshot", () => {
    it("preparing an execute request does not refresh the provider response clock", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-prepared-not-served";
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { lastResponseTime: 1_000, cacheTtl: "1h" });
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [], {
                schedulerDecision: "execute",
                schedulerDeferReason: null,
            }),
        );
        expect(getOrCreateSessionMeta(db, sessionId).lastResponseTime).toBe(1_000);
    });
    it("serves byte-identical passes from one cached row and reloads after a database write", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        const sessionId = "ses-replay-snapshot";
        getOrCreateSessionMeta(db, sessionId);
        patchSessionMeta(db, sessionId, {
            note_nudge_anchors: JSON.stringify([
                { messageId: "snapshot-user", text: "\nreplay-v1" },
            ]),
            trailing_blank_decisions: JSON.stringify({ "snapshot-assistant": "strip" }),
        });

        const preparedSql: string[] = [];
        const revisionReads: string[] = [];
        const spiedDb = new Proxy(db, {
            get(target, prop) {
                if (prop !== "prepare") return Reflect.get(target, prop, target);
                return (sql: string) => {
                    preparedSql.push(sql);
                    const statement = target.prepare.call(target, sql);
                    if (!sql.includes("session_meta_collection_revisions AS revisions"))
                        return statement;
                    return new Proxy(statement, {
                        get(stmt, key) {
                            if (key === "get")
                                return (...params: Parameters<typeof stmt.get>) => {
                                    revisionReads.push(String(params[0]));
                                    return stmt.get(...params);
                                };
                            const value = Reflect.get(stmt, key);
                            return typeof value === "function" ? value.bind(stmt) : value;
                        },
                    });
                };
            },
        }) as Database;
        const input = [
            {
                info: { id: "snapshot-user", role: "user" },
                parts: [{ type: "text", text: "same input" }],
            },
            {
                info: { id: "snapshot-assistant", role: "assistant" },
                parts: [{ type: "text", text: "same output" }],
            },
        ] as MessageLike[];
        const run = async (): Promise<MessageLike[]> => {
            const messages = cloneMessages(input);
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    db: spiedDb,
                    resolvedProviderID: "anthropic",
                }),
            );
            return messages;
        };
        const digest = (messages: MessageLike[]) =>
            createHash("sha256").update(JSON.stringify(messages)).digest("hex");

        const first = await run();
        const second = await run();
        expect(digest(second)).toBe(digest(first));
        expect(
            revisionReads.filter((column) => column === "stale_reduce_stripped_ids"),
        ).toHaveLength(2);
        expect(revisionReads.filter((column) => column === "note_nudge_anchors")).toHaveLength(2);
        expect(
            preparedSql.filter((sql) => sql.includes("SELECT todo_permission_denied")),
        ).toHaveLength(1);

        updateSessionMetaCollection(
            db,
            sessionId,
            "note_nudge_anchors",
            JSON.stringify([{ messageId: "snapshot-user", text: "\nreplay-v2" }]),
        );
        const afterPassInvalidation = await run();
        expect(digest(afterPassInvalidation)).not.toBe(digest(second));
        expect(JSON.stringify(afterPassInvalidation)).toContain("replay-v2");
    });
});

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
        const originalDebugAssertions = process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS;
        process.env.NODE_ENV = "production";
        // This control isolates the production structural guard. The separate
        // debug-assertion test deliberately enables the exact-content walk.
        delete process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS;
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
            if (originalDebugAssertions === undefined)
                delete process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS;
            else process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS = originalDebugAssertions;
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
                m0M1: { projectPath: "git:measured-collapse", projectDirectory: "/nonexistent" },
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
    for (const host of ["opencode", "opencode2"] as const) {
        for (let seed = 1; seed <= 120; seed++) {
            it(`${host} randomized trimmed-source differential ${seed}: fold, 4096 sentinels, seam and defer replay`, async () => {
                _resetHarnessForTesting();
                setHarness(host);
                let state = seed;
                const random = () => {
                    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
                    return state;
                };
                const source = ["trim", "a%_\\b", "MiXeD", "源", "nested:p1:file2"][random() % 5];
                const sessionId = `ses-trim-wire-${host}-${seed}`;
                const served = [
                    {
                        info: { id: "tail-user", role: "user", sessionID: sessionId },
                        parts: [{ type: "text", text: "continue" }],
                    },
                    {
                        info: { id: "tail-assistant", role: "assistant", sessionID: sessionId },
                        parts: [{ type: "text", text: `visible answer ${random()}` }],
                    },
                ] as MessageLike[];
                const trimmed = [
                    {
                        info: { id: source, role: "assistant", sessionID: sessionId },
                        parts: [{ type: "text", text: "archived output" }],
                    },
                ] as MessageLike[];
                const historical = Array.from({ length: 12 + (random() % 24) }, (_, index) => ({
                    messageId: [
                        source,
                        `${source}:p${index}`,
                        `${source.toUpperCase()}:FILE${index}`,
                        `old-${random()}:p0`,
                        `${source}:mc-text-v1:${index}`,
                    ][random() % 5],
                    owner: random() % 3 === 0 ? source : null,
                    status: ["active", "dropped", "compacted"][random() % 3] as
                        | "active"
                        | "dropped"
                        | "compacted",
                }));
                const run = async () => {
                    db = new Database(":memory:");
                    initializeDatabase(db);
                    applyStrippedPlaceholderDelta(db, sessionId, {
                        add: Array.from({ length: 4096 }, (_, i) => `persisted-${i}`),
                    });
                    insertTag(db, sessionId, `${source}:p0`, "message", 10, 1);
                    insertTag(db, sessionId, "call-trim", "tool", 10, 2, 0, "read", 0, source);
                    insertTag(db, sessionId, "tail-user:p0", "message", 10, 3);
                    for (const [index, row] of historical.entries()) {
                        const number = index + 4;
                        insertTag(
                            db,
                            sessionId,
                            row.messageId,
                            "tool",
                            10,
                            number,
                            0,
                            "read",
                            0,
                            row.owner,
                        );
                        updateTagStatus(db, sessionId, number, row.status);
                    }
                    const messages = structuredClone(served);
                    const hidden = {
                        info: { id: "hidden-new", role: "assistant", sessionID: sessionId },
                        parts: [{ type: "text", text: "[dropped §4§]" }],
                    } as MessageLike;
                    await runPostTransformPhase(
                        basePostTransformArgs(db, sessionId, messages, {
                            schedulerDecision: "execute",
                            pendingMaterializationSessions: new Set([sessionId]),
                            schedulerDeferReason: null,
                            resolvedProviderID: "anthropic",
                            trimmedMessagesAtCompactionBoundary: structuredClone(trimmed),
                            hiddenMessagesAtCompactionSeam: [structuredClone(hidden)],
                        }),
                    );
                    expect(
                        getTagsBySession(db, sessionId)
                            .slice(0, 3)
                            .map((tag) => tag.status),
                    ).toEqual(["compacted", "compacted", "active"]);
                    const persisted = getStrippedPlaceholderIds(db, sessionId);
                    expect(persisted.size).toBe(4096);
                    expect(persisted.has("hidden-new")).toBe(true);
                    const absent = structuredClone(served);
                    await runPostTransformPhase(
                        basePostTransformArgs(db, sessionId, absent, {
                            schedulerDecision: "defer",
                            resolvedProviderID: "anthropic",
                        }),
                    );
                    const replay = [...structuredClone(served), structuredClone(hidden)];
                    await runPostTransformPhase(
                        basePostTransformArgs(db, sessionId, replay, {
                            schedulerDecision: "defer",
                            resolvedProviderID: "anthropic",
                        }),
                    );
                    expect(replay.at(-1)?.parts).toEqual([{ type: "text", text: "" }]);
                    const bytes = Buffer.from(
                        JSON.stringify({
                            fold: messages,
                            absent,
                            replay,
                            tags: getTagsBySession(db, sessionId).map(
                                ({ tag_number, message_id, tool_owner_message_id, status }) => ({
                                    tag_number,
                                    message_id,
                                    tool_owner_message_id,
                                    status,
                                }),
                            ),
                        }),
                    );
                    db.close();
                    return bytes;
                };
                const linear = await run();
                let legacyCalls = 0;
                const old = spyOn(storageTags, "markTagsCompactedByMessageIds").mockImplementation(
                    (store, session, ids) => {
                        legacyCalls++;
                        const update = store.prepare(`UPDATE tags SET status = 'compacted'
                WHERE session_id = ? AND status IN ('active','dropped')
                AND (message_id = ? OR message_id LIKE ? ESCAPE '\\'
                    OR message_id LIKE ? ESCAPE '\\' OR tool_owner_message_id = ?) RETURNING id`);
                        return store
                            .transaction(() => {
                                let count = 0;
                                for (const id of new Set(ids)) {
                                    const escaped = id.replace(/[\\%_]/g, "\\$&");
                                    count += update.all(
                                        session,
                                        id,
                                        `${escaped}:p%`,
                                        `${escaped}:file%`,
                                        id,
                                    ).length;
                                }
                                return count;
                            })
                            .immediate();
                    },
                );
                try {
                    const legacyBytes = await run();
                    expect(legacyCalls).toBe(1);
                    expect(linear.equals(legacyBytes)).toBe(true);
                    expect(linear.includes("visible answer")).toBe(true);
                    expect(linear.includes("archived output")).toBe(false);
                } finally {
                    old.mockRestore();
                    _resetHarnessForTesting();
                }
            });
        }
    }

    for (const providerID of ["anthropic", "openai-compatible"]) {
        it(`freezes a marker-only final assistant across a priced pass and appended defer (${providerID})`, async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = `ses-marker-only-${providerID}`;
            const makePrefix = (): MessageLike[] =>
                [
                    {
                        info: { id: "user", role: "user", sessionID: sessionId },
                        parts: [{ type: "text", text: "continue" }],
                    },
                    {
                        info: { id: "last", role: "assistant", sessionID: sessionId },
                        parts: [
                            { type: "text", text: "§672§ [dropped §672§]" },
                            { type: "reasoning", text: "[cleared]" },
                        ],
                    },
                ] as unknown as MessageLike[];
            const first = makePrefix();
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, first, {
                    schedulerDecision: "execute",
                    pendingMaterializationSessions: new Set([sessionId]),
                    schedulerDeferReason: null,
                    resolvedProviderID: providerID,
                }),
            );
            expect(getStrippedPlaceholderIds(db, sessionId).has("last")).toBe(true);
            const prefix = JSON.stringify(first);
            expect(first[1]?.parts).toEqual([
                { type: "text", text: providerID === "anthropic" ? "" : "[dropped]" },
            ]);
            const second = [
                ...makePrefix(),
                {
                    info: { id: "new", role: "assistant", sessionID: sessionId },
                    parts: [{ type: "text", text: "§655§ [cleared]" }],
                },
            ] as MessageLike[];
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, second, {
                    schedulerDecision: "defer",
                    resolvedProviderID: providerID,
                }),
            );
            expect(JSON.stringify(second.slice(0, first.length))).toBe(prefix);
            expect(second[2]?.parts).toEqual([{ type: "text", text: "§655§ [cleared]" }]);
            expect(getStrippedPlaceholderIds(db, sessionId).has("new")).toBe(false);
        });
    }

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
                pendingMaterializationSessions: new Set([sessionId]),
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
    it("replays byte-identical arrays after marker state is cleared between defer passes", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-marker-cleared-defer";
        setPersistedCompactionMarkerState(db, sessionId, {
            boundaryMessageId: "boundary",
            summaryMessageId: "summary",
            compactionPartId: "compaction",
            summaryPartId: "summary-part",
            boundaryOrdinal: 10,
            targetEndMessageId: "boundary",
        });
        const source = [
            {
                info: { id: "tail-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "retained user turn" }],
            },
        ] as MessageLike[];
        const first = structuredClone(source);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, first, { schedulerDecision: "defer" }),
        );
        setPersistedCompactionMarkerState(db, sessionId, null);
        expect(getPersistedCompactionMarkerState(db, sessionId)).toBeNull();
        const second = structuredClone(source);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, second, { schedulerDecision: "defer" }),
        );
        const hash = (messages: MessageLike[]) =>
            new Bun.CryptoHasher("sha256").update(JSON.stringify(messages)).digest("hex");
        expect(first.some((message) => message.info.id === "summary")).toBe(true);
        expect(hash(second)).toBe(hash(first));
        // A new tagger simulates restart; replay is durable, not an in-memory pin.
        const third = structuredClone(source);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, third, {
                schedulerDecision: "defer",
                tagger: createTagger(),
            }),
        );
        expect(hash(third)).toBe(hash(first));
        const priced = structuredClone(source);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, priced, {
                schedulerDecision: "execute",
                pendingMaterializationSessions: new Set([sessionId]),
            }),
        );
        expect(priced.some((message) => message.info.id === "summary")).toBe(false);
        const after = structuredClone(source);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, after, { schedulerDecision: "defer" }),
        );
        expect(hash(after)).toBe(hash(priced));
    });
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

    it("applies a Rust materialized boundary on its serving pass and replays identical bytes", async () => {
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
        expect(await prepareCompactionMarkerCandidates(sessionId)).toBe(true);
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
            cacheBustingPass: true,
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

    it("newer pending publication waits until consumed by the served response", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-rust-consumed-coverage";
        createOpenCodeDbWithoutMessages("rust-consumed-coverage-");
        const oc = new Database(join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db"));
        for (const ordinal of [1, 10, 11, 20]) {
            oc.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
                `m${ordinal}`,
                sessionId,
                ordinal,
                ordinal,
                JSON.stringify({ role: "user" }),
            );
        }
        oc.close();
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 10,
                startMessageId: "m1",
                endMessageId: "m10",
                startBlockIndex: 0,
                endBlockIndex: 0,
                title: "first",
                content: "first",
            },
            {
                sequence: 1,
                startMessage: 11,
                endMessage: 20,
                startMessageId: "m11",
                endMessageId: "m20",
                startBlockIndex: 0,
                endBlockIndex: 0,
                title: "later",
                content: "later",
            },
        ]);
        const pending = {
            ordinal: 20,
            endMessageId: "m20",
            publishedAt: 2,
            injectAttempts: 3,
            firstInjectFailedAt: 1,
            lastInjectError: "writer busy",
        };
        setPendingCompactionMarkerState(db, sessionId, pending);
        for (const committed of [true, false]) {
            applyRustModeDeferredCompactionMarker({
                db,
                sessionId,
                cacheBustingPass: true,
                admissionProven: true,
                ...(committed
                    ? { boundary: { rowVersion: 7, ordinal: 10, endMessageId: "m10" } }
                    : {}),
                consumedBoundary: { rowVersion: 7, ordinal: 10, endMessageId: "m10" },
            });
            expect(getPersistedCompactionMarkerState(db, sessionId)).toBeNull();
            expect(getPendingCompactionMarkerState(db, sessionId)).toEqual(pending);
            expect(getCompactionMarkerHealth(db, sessionId).attempts).toBe(3);
        }
        // A noncommitting response can retry, but only with its own consumed coverage.
        expect(await prepareCompactionMarkerCandidates(sessionId)).toBe(true);
        applyRustModeDeferredCompactionMarker({
            db,
            sessionId,
            cacheBustingPass: true,
            admissionProven: true,
            consumedBoundary: { rowVersion: 8, ordinal: 20, endMessageId: "m20" },
        });
        expect(getPersistedCompactionMarkerState(db, sessionId)?.boundaryOrdinal).toBe(20);
        expect(getPendingCompactionMarkerState(db, sessionId)).toBeNull();

        // Pause a legacy publication until the response's target transaction
        // commits, then publish through a different connection before the drain
        // rereads pending. The response still represents only ordinal 10.
        db.close();
        const home = createTestTempDirFromPath(join(tmpdir(), "rust-publication-interleave-"));
        tempDirs.push(home);
        db = new Database(join(home, "context.db"));
        initializeDatabase(db);
        const racingSession = `${sessionId}-paused`;
        createOpenCodeDbWithoutMessages("rust-publication-raw-");
        const raw = new Database(join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db"));
        for (const ordinal of [1, 10, 11, 20])
            raw.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
                `m${ordinal}`,
                racingSession,
                ordinal,
                ordinal,
                JSON.stringify({ role: "user" }),
            );
        raw.close();
        appendCompartments(db, racingSession, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 10,
                startMessageId: "m1",
                endMessageId: "m10",
                startBlockIndex: 0,
                endBlockIndex: 0,
                title: "served",
                content: "served",
            },
        ]);
        const publisher = new Database(join(home, "context.db"));
        const newer = { ...pending, injectAttempts: 4 };
        const prepare = db.prepare.bind(db);
        let pendingReads = 0;
        const publication = spyOn(db, "prepare").mockImplementation((sql) => {
            if (
                String(sql).includes("SELECT pending_compaction_marker_state") &&
                ++pendingReads === 2
            ) {
                publisher
                    .transaction(() => {
                        appendCompartments(publisher, racingSession, [
                            {
                                sequence: 1,
                                startMessage: 11,
                                endMessage: 20,
                                startMessageId: "m11",
                                endMessageId: "m20",
                                startBlockIndex: 0,
                                endBlockIndex: 0,
                                title: "published later",
                                content: "published later",
                            },
                        ]);
                        setPendingCompactionMarkerState(publisher, racingSession, newer);
                    })
                    .immediate();
            }
            return prepare(sql);
        });
        let fences = 0;
        try {
            applyRustModeDeferredCompactionMarker({
                db,
                sessionId: racingSession,
                cacheBustingPass: true,
                admissionProven: true,
                boundary: { rowVersion: 7, ordinal: 10, endMessageId: "m10" },
                beforeApply: () => {
                    fences++;
                },
            });
            expect(pendingReads).toBe(2);
            expect(fences).toBe(0);
            expect(getPersistedCompactionMarkerState(db, racingSession)).toBeNull();
            expect(getPendingCompactionMarkerState(db, racingSession)).toEqual(newer);
            expect(getCompactionMarkerHealth(db, racingSession).attempts).toBe(4);
        } finally {
            publication.mockRestore();
            publisher.close();
        }
    });

    it("genuine rebuild without fresh coordinates retires the cleared marker in the same cycle", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-rust-cleared-marker";
        setPersistedCompactionMarkerState(db, sessionId, {
            boundaryMessageId: "m10",
            targetEndMessageId: "m10",
            boundaryOrdinal: 10,
            summaryMessageId: "summary",
            summaryPartId: "summary-part",
            compactionPartId: "compaction",
        });
        setPersistedCompactionMarkerState(db, sessionId, null);
        const serve = (cacheBustingPass: boolean) => {
            const messages = [
                {
                    info: { id: "tail", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "tail" }],
                },
            ] as MessageLike[];
            runRustModePostprocess({
                db: db!,
                sessionId,
                messages,
                cacheBustingPass,
                fullFeatureMode: true,
                tagger: createTagger(),
                ctxReduceAvailability: { callable: false, frozen: true },
            });
            return messages;
        };
        expect(serve(false).some((message) => message.info.summary === true)).toBe(true);
        expect(getDeferredClearedCompactionMarkerState(db, sessionId)).not.toBeNull();
        expect(serve(true).some((message) => message.info.summary === true)).toBe(false);
        expect(getDeferredClearedCompactionMarkerState(db, sessionId)).toBeNull();
    });

    it("committed scheduler-execute boundary metadata cannot drain a marker without served bust permission", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-metadata-only-marker";
        const pending = {
            ordinal: 10,
            endMessageId: "msg-boundary",
            publishedAt: 1,
            injectAttempts: 3,
        };
        setPendingCompactionMarkerState(db, sessionId, pending);
        const messages = [] as MessageLike[];
        let writes = 0;
        runRustModePostprocess({
            db,
            sessionId,
            messages,
            fullFeatureMode: true,
            tagger: createTagger(),
            materializedBoundary: { rowVersion: 7, ordinal: 10, endMessageId: "msg-boundary" },
            compactionMarkerStrategy: {
                applyDeferred: () => {
                    writes++;
                    return { kind: "applied", markerOrdinal: 10 };
                },
                reconcile: () => {},
            },
        });
        expect(writes).toBe(0);
        expect(getPendingCompactionMarkerState(db, sessionId)).toEqual(pending);
        expect(getPersistedCompactionMarkerState(db, sessionId)).toBeNull();
    });

    it("an upgraded indexed pending waits through byte-identical defers and moves on the next bust", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-upgraded-indexed-pending";
        createOpenCodeDbWithoutMessages("postprocess-indexed-upgrade-");
        const opencodeDb = new Database(
            join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db"),
        );
        for (const [id, role, time] of [
            ["msg-user", "user", 1_000],
            ["msg-partial", "assistant", 1_001],
        ] as const) {
            opencodeDb
                .prepare(
                    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
                )
                .run(id, sessionId, time, time, JSON.stringify({ role }));
        }
        opencodeDb.close();
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 10,
                startMessageId: "msg-user",
                endMessageId: "msg-partial",
                endBlockIndex: 0,
                title: "indexed",
                content: "stable",
            },
        ]);
        const pending = {
            ordinal: 10,
            endMessageId: "msg-partial",
            publishedAt: 1,
            injectAttempts: 3,
            firstInjectFailedAt: 1,
            lastInjectError: "host store was locked",
        };
        setPendingCompactionMarkerState(db, sessionId, pending);
        const source = [
            {
                info: { role: "user", sessionID: sessionId, syntheticHead: true },
                parts: [{ type: "text", text: "<session-history>stable</session-history>" }],
            },
            {
                info: { id: "msg-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "kept tool turn" }],
            },
            {
                info: { id: "msg-partial", role: "assistant", sessionID: sessionId },
                parts: [
                    { type: "text", text: "covered block" },
                    {
                        type: "tool_use",
                        id: "call-kept",
                        name: "read",
                        input: { path: "README.md" },
                    },
                    {
                        type: "tool_result",
                        tool_use_id: "call-kept",
                        content: "unsummarized result",
                    },
                    { type: "text", text: "uncovered block" },
                ],
            },
        ] as unknown as MessageLike[];
        const serve = (cacheBustingPass = false): MessageLike[] => {
            const messages = structuredClone(source);
            runRustModePostprocess({
                db: db!,
                sessionId,
                messages,
                cacheBustingPass,
                consumedBoundary: { rowVersion: 7, ordinal: 10, endMessageId: "msg-partial" },
                fullFeatureMode: true,
                tagger: createTagger(),
                ctxReduceAvailability: { callable: false, frozen: true },
            });
            return messages;
        };
        const before = JSON.stringify(serve());
        for (let pass = 0; pass < 3; pass++) {
            expect(JSON.stringify(serve())).toBe(before);
            expect(getPendingCompactionMarkerState(db, sessionId)).toEqual(pending);
            expect(getPersistedCompactionMarkerState(db, sessionId)).toBeNull();
            expect(getCompactionMarkerHealth(db, sessionId).attempts).toBe(3);
        }
        expect(await prepareCompactionMarkerCandidates(sessionId)).toBe(true);
        const bust = serve(true);
        expect(getPendingCompactionMarkerState(db, sessionId)).toBeNull();
        expect(getPersistedCompactionMarkerState(db, sessionId)?.boundaryMessageId).toBe(
            "msg-user",
        );
        expect(bust.find((message) => message.info.id === "msg-partial")?.parts).toEqual(
            source.at(-1)!.parts,
        );
        for (let pass = 0; pass < 3; pass++)
            expect(JSON.stringify(serve())).toBe(JSON.stringify(bust));
    });

    it("retries a retained marker only on busts and retains retry health on defers", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-rust-marker-retry-every-defer";
        const dataHome = createTestTempDirFromPath(
            join(tmpdir(), "postprocess-rust-marker-retry-"),
        );
        tempDirs.push(dataHome);
        process.env.XDG_DATA_HOME = dataHome;
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 10,
                startMessageId: "msg-start",
                endMessageId: "msg-boundary",
                title: "history",
                content: "stable",
            },
        ]);
        setPendingCompactionMarkerState(db, sessionId, {
            ordinal: 10,
            endMessageId: "msg-boundary",
            publishedAt: Date.now(),
        });
        const source = [
            {
                info: { role: "user", sessionID: sessionId, syntheticHead: true },
                parts: [{ type: "text", text: "<session-history>stable</session-history>" }],
            },
            {
                info: { id: "tail", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "new turn" }],
            },
        ] as unknown as MessageLike[];
        const served: string[] = [];
        for (let pass = 0; pass < 4; pass += 1) {
            const messages = structuredClone(source);
            runRustModePostprocess({
                db,
                sessionId,
                messages,
                sessionDirectory: dataHome,
                cacheBustingPass: true,
                consumedBoundary: { rowVersion: 7, ordinal: 10, endMessageId: "msg-boundary" },
                fullFeatureMode: true,
                tagger: createTagger(),
                ctxReduceAvailability: { callable: false, frozen: true },
            });
            served.push(JSON.stringify(messages));
            if (pass === 2) {
                expect(getCompactionMarkerHealth(db, sessionId)).toMatchObject({
                    code: "MC-C11",
                    attempts: 3,
                });
                expect(getPendingCompactionMarkerState(db, sessionId)?.lastInjectError).toContain(
                    "OpenCode database not found",
                );
            }
        }
        expect(new Set(served).size).toBe(1);
        const pendingBeforeDefer = getPendingCompactionMarkerState(db, sessionId);
        const messages = structuredClone(source);
        runRustModePostprocess({
            db,
            sessionId,
            messages,
            sessionDirectory: dataHome,
            fullFeatureMode: true,
            tagger: createTagger(),
            ctxReduceAvailability: { callable: false, frozen: true },
        });
        expect(getPendingCompactionMarkerState(db, sessionId)).toEqual(pendingBeforeDefer);
        expect(JSON.stringify(messages)).toBe(served[0]);
    });

    it("clears retry health when the next bust retries successfully, not on the intervening defer", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-rust-marker-retry-heals";
        const dataHome = createTestTempDirFromPath(join(tmpdir(), "postprocess-rust-marker-heal-"));
        tempDirs.push(dataHome);
        process.env.XDG_DATA_HOME = dataHome;
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 10,
                startMessageId: "msg-start",
                endMessageId: "msg-boundary",
                title: "history",
                content: "stable",
            },
        ]);
        setPendingCompactionMarkerState(db, sessionId, {
            ordinal: 10,
            endMessageId: "msg-boundary",
            publishedAt: Date.now(),
        });
        setPersistedCompactionMarkerState(db, sessionId, {
            boundaryMessageId: "msg-old-boundary",
            summaryMessageId: "msg-old-summary",
            compactionPartId: "prt-old-compaction",
            summaryPartId: "prt-old-summary",
            boundaryOrdinal: 5,
            targetEndMessageId: "msg-old-boundary",
        });
        const messages = [
            {
                info: { id: "tail", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "new turn" }],
            },
        ] as unknown as MessageLike[];
        const drain = (cacheBustingPass = false): string => {
            const served = structuredClone(messages);
            runRustModePostprocess({
                db,
                sessionId,
                messages: served,
                sessionDirectory: dataHome,
                cacheBustingPass,
                consumedBoundary: { rowVersion: 7, ordinal: 10, endMessageId: "msg-boundary" },
                fullFeatureMode: true,
                tagger: createTagger(),
                ctxReduceAvailability: { callable: false, frozen: true },
            });
            return serializeAnthropicWireWithAdjacentAssistantMerge(served);
        };

        const failedAttemptBytes = drain(true);
        expect(getPendingCompactionMarkerState(db, sessionId)?.injectAttempts).toBe(1);

        mkdirSync(join(dataHome, "opencode"), { recursive: true });
        const opencodeDb = new Database(join(dataHome, "opencode", "opencode.db"));
        opencodeDb.exec("PRAGMA journal_mode=WAL");
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
            .run("msg-boundary", sessionId, 1_000, 1_000, JSON.stringify({ role: "user" }));
        opencodeDb.close();

        expect(drain()).toBe(failedAttemptBytes);
        expect(getPendingCompactionMarkerState(db, sessionId)?.injectAttempts).toBe(1);
        expect(await prepareCompactionMarkerCandidates(sessionId)).toBe(true);
        const healedAttemptBytes = drain(true);
        expect(healedAttemptBytes).toBe(failedAttemptBytes);
        expect(getPendingCompactionMarkerState(db, sessionId)).toBeNull();
        expect(getCompactionMarkerHealth(db, sessionId)).toEqual({
            code: null,
            attempts: 0,
            lastError: null,
            pendingSinceMs: null,
        });
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
                pendingMaterializationSessions: new Set([sessionId]),
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
        const dataHome = createTestTempDirFromPath(join(tmpdir(), "postprocess-marker-wire-"));
        tempDirs.push(dataHome);
        process.env.XDG_DATA_HOME = dataHome;
        mkdirSync(join(dataHome, "opencode"), { recursive: true });
        const opencodeDb = new Database(join(dataHome, "opencode", "opencode.db"));
        opencodeDb.exec("PRAGMA journal_mode=WAL");
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
                prefixTrimSourceOrder: capturePrefixTrimSourceOrder([
                    {
                        info: { id: "msg-boundary", role: "user", sessionID: sessionId },
                        parts: [{ type: "text", text: "covered" }],
                    } as MessageLike,
                    ...foldMessages,
                ]),
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
    it.each([
        false,
        true,
    ])("keeps the advance drain byte-identical with the next pass (cleared=%s)", async (cleared) => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-marker-advance-wire-stability";
        const dataHome = createTestTempDirFromPath(
            join(tmpdir(), "postprocess-marker-advance-wire-"),
        );
        tempDirs.push(dataHome);
        process.env.XDG_DATA_HOME = dataHome;
        mkdirSync(join(dataHome, "opencode"), { recursive: true });
        const opencodeDb = new Database(join(dataHome, "opencode", "opencode.db"));
        opencodeDb.exec("PRAGMA journal_mode=WAL");
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
        if (cleared) {
            const before = cloneMessages(drainMessages);
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, before, { schedulerDecision: "defer" }),
            );
            setPersistedCompactionMarkerState(db, sessionId, null);
            const after = cloneMessages(drainMessages).filter((message) => !message.info.summary);
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, after, { schedulerDecision: "defer" }),
            );
            const hash = (messages: MessageLike[]) =>
                new Bun.CryptoHasher("sha256").update(JSON.stringify(messages)).digest("hex");
            expect(hash(after)).toBe(hash(before));
            expect(getPersistedCompactionMarkerState(db, sessionId)).toBeNull();
            expect(getPendingCompactionMarkerState(db, sessionId)?.ordinal).toBe(20);
        }

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
    for (const unavailableAt of ["preparation", "replacement"] as const) {
        it(`serves rebuilt history when marker candidates are unavailable at ${unavailableAt}`, async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            createOpenCodeDbWithoutMessages("postprocess-deferred-candidates-");
            const sessionId = `ses-marker-candidates-${unavailableAt}`;
            const pending = { ordinal: 1, endMessageId: "u1", publishedAt: 1 };
            setPendingCompactionMarkerState(db, sessionId, pending);
            const messages = [
                {
                    info: { id: "fresh", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "fresh rebuilt turn" }],
                },
            ] as MessageLike[];
            const deferredHistoryRefreshSessions = new Set([sessionId]);
            const passOutcome = createPassOutcome();
            const prepare = spyOn(
                markerCandidates,
                "prepareMarkerCandidateBasis",
            ).mockResolvedValue(false);
            let replacementCalls = 0;
            try {
                await runPostTransformPhase(
                    basePostTransformArgs(db, sessionId, messages, {
                        fullFeatureMode: false,
                        passOutcome,
                        historyRebuiltThisPass: true,
                        canConsumeDeferredLate: true,
                        deferredHistoryWasPendingAtPassStart: true,
                        deferredHistoryRefreshSessions,
                        pendingCompartmentInjection: {
                            compartmentEndMessage: 1,
                            compartmentEndMessageId: "u1",
                            compartmentCount: 1,
                            renderedText: "rebuilt history",
                            skippedVisibleMessages: 0,
                        } as PostTransformArgs["pendingCompartmentInjection"],
                        ...(unavailableAt === "replacement"
                            ? {
                                  compactionMarkerStrategy: {
                                      applyDeferred: () => {
                                          replacementCalls++;
                                          return {
                                              kind: "deferred",
                                              reason: "candidate-preparation",
                                          };
                                      },
                                      reconcile: () => {},
                                  } as PostTransformArgs["compactionMarkerStrategy"],
                              }
                            : {}),
                    }),
                );
                expect(passOutcome.degradations).toEqual([]);
                expect(JSON.stringify(messages)).toContain("fresh rebuilt turn");
                expect(getPendingCompactionMarkerState(db, sessionId)).toEqual(pending);
                expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(true);
                if (unavailableAt === "preparation") expect(prepare).toHaveBeenCalled();
                else expect(replacementCalls).toBe(1);
            } finally {
                prepare.mockRestore();
            }
        });
    }

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
            protectedTagIds: new Set(),
            protectedTagNumbers: new Set(),
            protectedCutoff: null,
            protectedCount: 0,
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
                contextUsage: { percentage: 110, inputTokens: 8_000 },
                emergencyCeilingTokens: 10_000,
                currentTurnId: "turn-reclaim",
            }),
        );

        expect(result.droppedTokens).toBeGreaterThan(0);
        expect(result.emergencyReclaimedTokens).toBeGreaterThan(0);
        expect(result.emergency).toBe(true);
    });
});

describe("dropped-token telemetry", () => {
    const LARGE_ARRAY_THRESHOLD = 9 * 1024 * 1024;

    function largeMessageArray(sessionId: string, droppedMessage: MessageLike): MessageLike[] {
        const payload = "large telemetry fixture ".repeat(70_000);
        return [
            droppedMessage,
            ...Array.from({ length: 7 }, (_, index) => ({
                info: {
                    id: `large-${index}`,
                    role: index % 2 === 0 ? "user" : "assistant",
                    sessionID: sessionId,
                },
                parts: [{ type: "text", text: payload }],
            })),
        ] as MessageLike[];
    }

    function insertKnownToolTag(
        sessionId: string,
        messageId: string,
        tagNumber: number,
        tokenCount: number,
    ): void {
        insertTag(db, sessionId, messageId, "tool", 4000, tagNumber, 0, "bash", 0, null, null, {
            tokenCount,
            inputTokenCount: 0,
            reasoningTokenCount: 0,
        });
    }

    it("sums persisted output token counts for three skeletonized tags", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-dropped-token-sum";
        const counts = [111, 222, 333];
        const messages = counts.map((_, index) => makeToolMessage(`counted-${index + 1}`));
        const targets = new Map<number, TagTarget>();
        for (let index = 0; index < counts.length; index += 1) {
            const tagNumber = index + 1;
            insertKnownToolTag(sessionId, `counted-${tagNumber}`, tagNumber, counts[index]!);
            queuePendingOp(db, sessionId, tagNumber, "drop", tagNumber);
            targets.set(tagNumber, makeDropTarget(messages[index]!));
        }

        const result = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "execute",
                pendingMaterializationSessions: new Set([sessionId]),
                schedulerDeferReason: null,
                tags: getActiveTagsBySession(db, sessionId),
                targets,
            }),
        );

        expect(result.droppedTokens).toBe(666);
        expect(getPendingOps(db, sessionId)).toEqual([]);
    });

    it("never sends a whole multi-megabyte message array to the exact tokenizer seam", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-dropped-token-no-array-tokenize";
        const droppedMessage = makeToolMessage("small-drop");
        const messages = largeMessageArray(sessionId, droppedMessage);
        insertKnownToolTag(sessionId, "small-drop", 1, 41);
        queuePendingOp(db, sessionId, 1, "drop", 1);
        const tokenizerInputSizes: number[] = [];
        const tokenizer = spyOn(readSessionFormatting, "estimateTokens").mockImplementation(
            (text) => {
                tokenizerInputSizes.push(text.length);
                return Math.ceil(text.length / 3.5);
            },
        );

        try {
            expect(JSON.stringify(messages).length).toBeGreaterThan(LARGE_ARRAY_THRESHOLD);
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    schedulerDecision: "execute",
                    schedulerDeferReason: null,
                    tags: getActiveTagsBySession(db, sessionId),
                    targets: new Map([[1, makeDropTarget(droppedMessage)]]),
                }),
            );

            expect(tokenizerInputSizes.filter((size) => size > LARGE_ARRAY_THRESHOLD)).toEqual([]);
        } finally {
            tokenizer.mockRestore();
        }
    });

    it("keeps execute and following defer bytes pinned while draining the same operations", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-dropped-token-wire-parity";
        const counts = [111, 222, 333];
        const buildMessages = () =>
            counts.map((_, index) => makeToolMessage(`parity-${index + 1}`));
        const buildTargets = (messages: MessageLike[]) =>
            new Map<number, TagTarget>(
                messages.map((message, index) => [index + 1, makeDropTarget(message)]),
            );
        for (let index = 0; index < counts.length; index += 1) {
            const tagNumber = index + 1;
            insertKnownToolTag(sessionId, `parity-${tagNumber}`, tagNumber, counts[index]!);
            queuePendingOp(db, sessionId, tagNumber, "drop", tagNumber);
        }

        const executeMessages = buildMessages();
        const executeResult = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, executeMessages, {
                schedulerDecision: "execute",
                pendingMaterializationSessions: new Set([sessionId]),
                schedulerDeferReason: null,
                tags: getActiveTagsBySession(db, sessionId),
                targets: buildTargets(executeMessages),
            }),
        );
        const executeHash = createHash("sha256")
            .update(JSON.stringify(executeMessages))
            .digest("hex");
        expect(getPendingOps(db, sessionId)).toEqual([]);
        expect(executeResult.bustedThisPass).toBe(true);

        const deferMessages = buildMessages();
        const deferTargets = buildTargets(deferMessages);
        expect(applyFlushedStatuses(sessionId, db, deferTargets)).toBe(true);
        const deferResult = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, deferMessages, {
                schedulerDecision: "defer",
                tags: getActiveTagsBySession(db, sessionId),
                targets: deferTargets,
                didMutateFromFlushedStatuses: true,
            }),
        );
        const deferHash = createHash("sha256").update(JSON.stringify(deferMessages)).digest("hex");

        expect(executeHash).toBe(
            "5ae4d6ca0f7871c9c7a0d7f15f342cc6221ca3374ab7c5de1e189d115c3102ae",
        );
        expect(deferHash).toBe(executeHash);
        expect(deferResult.bustedThisPass).toBe(false);
        expect(deferResult.droppedTokens).toBe(0);
    });

    it("keeps the event loop responsive across a 10 MB pending-operation pass", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-dropped-token-responsive";
        const droppedMessage = makeToolMessage("responsive-drop");
        const messages = largeMessageArray(sessionId, droppedMessage);
        insertKnownToolTag(sessionId, "responsive-drop", 1, 41);
        queuePendingOp(db, sessionId, 1, "drop", 1);

        const delayedResponse = async (value: unknown): Promise<unknown> => {
            for (let turn = 0; turn < 4; turn += 1) {
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
            return { data: value };
        };
        const client = {
            app: { agents: () => delayedResponse([{ name: "test-agent", permission: [] }]) },
            session: {
                get: () => delayedResponse({ agent: "test-agent", permission: [] }),
            },
        } as never;
        const tickTimes: number[] = [];
        const timer = setInterval(() => tickTimes.push(performance.now()), 5);
        let loopTurns = 0;
        let counting = true;
        const countTurns = () => {
            if (!counting) return;
            loopTurns += 1;
            setImmediate(countTurns);
        };

        try {
            await new Promise<void>((resolve) => setImmediate(resolve));
            setImmediate(countTurns);
            const passStartedAt = performance.now();
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    schedulerDecision: "execute",
                    pendingMaterializationSessions: new Set([sessionId]),
                    schedulerDeferReason: null,
                    tags: getActiveTagsBySession(db, sessionId),
                    targets: new Map([[1, makeDropTarget(droppedMessage)]]),
                    client,
                    activeAgent: "test-agent",
                }),
            );
            const passFinishedAt = performance.now();
            counting = false;
            await new Promise<void>((resolve) => setImmediate(resolve));

            expect(loopTurns).toBeGreaterThanOrEqual(4);
            const observedTimes = [
                passStartedAt,
                ...tickTimes.filter((time) => time >= passStartedAt && time <= passFinishedAt),
                passFinishedAt,
            ].sort((left, right) => left - right);
            let maxGapMs = 0;
            for (let index = 1; index < observedTimes.length; index += 1) {
                maxGapMs = Math.max(
                    maxGapMs,
                    (observedTimes[index] ?? 0) - (observedTimes[index - 1] ?? 0),
                );
            }
            const passDurationMs = passFinishedAt - passStartedAt;
            // The yield count above is the load-invariant proof that the pass never runs as one
            // synchronous stretch. The timer-gap bound is wall-clock: on a loaded CI runner a 5 ms
            // interval timer is simply not scheduled for tens of milliseconds even while the loop
            // yields (release r1 of 0.42.4 read a 42 ms gap on a 43 ms pass), so it is asserted
            // only under the explicit perf gate and recorded otherwise.
            if (process.env.MC_PERF_GATE === "1") {
                expect(maxGapMs).toBeLessThanOrEqual(Math.max(passDurationMs / 2, 20));
            } else {
                console.log(
                    `dropped-token responsiveness: loopTurns=${loopTurns} maxGapMs=${maxGapMs.toFixed(1)} passMs=${passDurationMs.toFixed(1)} (perf gate off)`,
                );
            }
        } finally {
            counting = false;
            clearInterval(timer);
        }
    }, 30_000);

    it("serves a busting pass without waiting for the log-only ctx_reduce permission read", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-ctx-reduce-permission-background";
        clearToolPermissionDenied(sessionId);
        const message = makeToolMessage("background-drop");
        insertKnownToolTag(sessionId, "background-drop", 1, 41);
        queuePendingOp(db, sessionId, 1, "drop", 1);

        // A host that has not answered yet, like the loaded OpenCode server that
        // held this read for 14 seconds. The ctx_reduce read only feeds a log line.
        let answerHost: (() => void) | undefined;
        const hostAnswered = new Promise<void>((resolve) => {
            answerHost = resolve;
        });
        let hostCalls = 0;
        const slowHost = async (value: unknown): Promise<unknown> => {
            hostCalls += 1;
            await hostAnswered;
            return { data: value };
        };
        const client = {
            app: {
                agents: () =>
                    slowHost([{ name: "test-agent", permission: { ctx_reduce: "deny" } }]),
            },
            session: { get: () => slowHost({ agent: "test-agent", permission: [] }) },
        } as never;
        const logged: string[] = [];
        const logSpy = spyOn(loggerModule, "sessionLog").mockImplementation(
            (_session, ...values) => {
                logged.push(values.map(String).join(" "));
            },
        );
        try {
            const pass = runPostTransformPhase(
                basePostTransformArgs(db, sessionId, [message], {
                    schedulerDecision: "execute",
                    pendingMaterializationSessions: new Set([sessionId]),
                    schedulerDeferReason: null,
                    tags: getActiveTagsBySession(db, sessionId),
                    targets: new Map([[1, makeDropTarget(message)]]),
                    client,
                    activeAgent: "test-agent",
                    // Keep the todowrite read, which does decide served bytes,
                    // out of this pass so only the ctx_reduce read can block it.
                    todowriteAvailability: { callable: false, frozen: true },
                }),
            );
            const outcome = await Promise.race([
                pass.then(() => "served" as const),
                new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
            ]);
            expect(outcome).toBe("served");
            expect(hostCalls).toBe(2);
            expect(getTagsBySession(db, sessionId)[0]?.status).toBe("dropped");
            expect(logged.some((line) => line.includes("ctx_reduce permission is denied"))).toBe(
                false,
            );

            // The read still completes in the background and logs the deny once.
            answerHost?.();
            for (let turn = 0; turn < 10; turn += 1) {
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
            expect(
                logged.filter((line) => line.includes("ctx_reduce permission is denied")),
            ).toHaveLength(1);
        } finally {
            logSpy.mockRestore();
            answerHost?.();
            clearToolPermissionDenied(sessionId);
        }
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
                pendingMaterializationSessions: new Set([sessionId]),
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
                pendingMaterializationSessions: new Set([sessionId]),
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
                pendingMaterializationSessions: new Set([sessionId]),
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
                pendingMaterializationSessions: new Set([sessionId]),
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

    it("does not age the current task on a force-materialization bust without distance", async () => {
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

// A session whose permissions deny ctx_reduce freezes callable=false, so the
// model can never reduce by hand. Automatic reclaim (heuristic drops on an
// execute pass and the emergency tool floor) is then its only relief, so both
// must behave identically whatever the ctx_reduce verdict says.
describe("automatic reclaim ignores the ctx_reduce verdict", () => {
    const verdicts = [
        { callable: true, frozen: true },
        { callable: false, frozen: true },
    ] as const;

    async function emergencyOutcome(callable: boolean) {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = `ses-verdict-emergency-${callable}`;
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
                contextUsage: { percentage: 110, inputTokens: 8_000 },
                emergencyCeilingTokens: 10_000,
                currentTurnId: "turn-verdict-emergency",
                ctxReduceAvailability: { callable, frozen: true },
            }),
        );
        return {
            emergency: result.emergency,
            droppedTokens: result.droppedTokens,
            emergencyReclaimedTokens: result.emergencyReclaimedTokens,
            statuses: getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]),
        };
    }

    async function executeReclaimOutcome(callable: boolean) {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = `ses-verdict-reclaim-${callable}`;
        const first = makeToolMessage("tool-1");
        const second = makeToolMessage("tool-2");
        insertTag(db, sessionId, "tool-1", "tool", 4000, 1, 0, "bash");
        insertTag(db, sessionId, "tool-2", "tool", 4000, 2, 0, "read");
        queuePendingOp(db, sessionId, 1, "drop", 1);
        advanceToolReclaimWatermark(db, sessionId, 2);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [first, second], {
                schedulerDecision: "execute",
                pendingMaterializationSessions: new Set([sessionId]),
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([
                    [1, makeDropTarget(first)],
                    [2, makeDropTarget(second)],
                ]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
                ctxReduceAvailability: { callable, frozen: true },
            }),
        );
        return getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]);
    }

    it("drops the emergency tool floor identically for callable and uncallable ctx_reduce", async () => {
        const [callable, uncallable] = [
            await emergencyOutcome(verdicts[0].callable),
            await emergencyOutcome(verdicts[1].callable),
        ];
        expect(uncallable.emergency).toBe(true);
        expect(uncallable.emergencyReclaimedTokens).toBeGreaterThan(0);
        expect(uncallable).toEqual(callable);
    });

    it("runs execute-pass heuristic reclaim identically for callable and uncallable ctx_reduce", async () => {
        const [callable, uncallable] = [
            await executeReclaimOutcome(verdicts[0].callable),
            await executeReclaimOutcome(verdicts[1].callable),
        ];
        expect(uncallable).toEqual([
            [1, "dropped"],
            [2, "dropped"],
        ]);
        expect(uncallable).toEqual(callable);
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
        // Model an applied earlier batch, not merely an earlier zero-yield evaluation.
        const { setEmergencyDropSample } = await import(
            "../../features/magic-context/storage-meta-persisted"
        );
        setEmergencyDropSample(db, sessionId, 90_000);
        const executeThresholdPercentage = 50;
        const contextLimit = 100_000;
        const exactConfig = {
            schedulerDecision: "execute" as const,
            contextUsage: { percentage: 90, inputTokens: 90_000 },
            emergencyCeilingTokens: Math.floor(contextLimit * (executeThresholdPercentage / 100)),
            forceMaterializationPercentage: 85,
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
                null,
                { tokenCount: 1_000, inputTokenCount: 0, reasoningTokenCount: 0 },
            );
        }
        updateSessionMeta(db, sessionId, { cacheTtl: "5m" });
        const lastHeuristicsTurnId = new Map([[sessionId, turnId]]);
        const executeThresholdPercentage = 50;
        const contextLimit = 100_000;
        // A 12k token floor recreates the old twelve-tag geometry for these 1k-token rows.
        // That keeps the batching assertion focused on the pressure latch rather than changing
        // which historical outputs constitute the working set.
        const protectedTokens = 12_000;
        const runPressurePass = async (inputTokens: number, flush = false) => {
            const protectionWindow = getProtectionWindowForSession(db, sessionId, protectedTokens);
            return runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    schedulerDecision: "execute",
                    contextUsage: { percentage: 90, inputTokens },
                    pendingMaterializationSessions: new Set(flush ? [sessionId] : []),
                    emergencyCeilingTokens: Math.floor(
                        contextLimit * (executeThresholdPercentage / 100),
                    ),
                    forceMaterializationPercentage: 85,
                    protectedTagIds: protectionWindow.protectedTagNumbers,
                    protectedTagNumbers: protectionWindow.protectedTagNumbers,
                    protectedCutoff: protectionWindow.cutoff,
                    protectedCount: protectionWindow.status.protectedCount,
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
        };

        await runPressurePass(60_000);
        const firstStatuses = new Map(
            getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]),
        );
        for (let tagNumber = 1; tagNumber <= 18; tagNumber += 1) {
            expect(firstStatuses.get(tagNumber)).toBe("dropped");
        }
        expect(firstStatuses.get(19)).toBe("active");
        expect(firstStatuses.get(20)).toBe("active");
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
                null,
                { tokenCount: 1_000, inputTokenCount: 0, reasoningTokenCount: 0 },
            );
        }

        await runPressurePass(43_000);
        const secondStatuses = new Map(
            getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]),
        );
        expect(secondStatuses.get(19)).toBe("active");
        expect(secondStatuses.get(20)).toBe("active");
        expect(JSON.stringify(messages.slice(0, 30))).toBe(pricedPrefix);

        queuePendingOp(db, sessionId, 19, "drop", 1);
        await runPressurePass(44_000);
        expect(getPendingOps(db, sessionId)).toHaveLength(1);
        expect(JSON.stringify(messages.slice(0, 30))).toBe(pricedPrefix);
        await runPressurePass(44_000, true);
        const ridingStatuses = new Map(
            getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]),
        );
        expect(ridingStatuses.get(19)).toBe("dropped");
        expect(ridingStatuses.get(20)).toBe("dropped");
        expect(getOrCreateSessionMeta(db, sessionId).cacheTtl).toBe("5m");
    });
});

describe("ride-only supersession reclaim", () => {
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

    it("legacy smart_drops false backlog stays byte-identical on defer and lands on the first rebuilding pass", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-smart-off";
        const { trigger, older, newer, recentTail } = seedTodowriteSession(sessionId);
        const messages = [trigger, older, newer, ...recentTail];
        const before = JSON.stringify(messages);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "defer",
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
        expect(JSON.stringify(messages)).toBe(before);
        expect(tagStatuses(sessionId).get(2)).toBe("active");

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [trigger, older, newer, ...recentTail], {
                schedulerDecision: "execute",
                pendingMaterializationSessions: new Set([sessionId]),
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
        expect(statuses.get(1)).toBe("dropped"); // Its explicit queued drop is applied.
        expect(statuses.get(2)).toBe("dropped"); // The queued older result is also removed during this rebuild.
        expect(statuses.get(3)).toBe("active");

        const afterRebuild = JSON.stringify(messages);
        const args = (schedulerDecision: "defer" | "execute") =>
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision,
                protectedTools: { todowrite: 0 },
                ...(schedulerDecision === "execute"
                    ? { pendingMaterializationSessions: new Set([sessionId]) }
                    : {}),
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([
                    [1, makeDropTarget(trigger)],
                    [2, makeDropTarget(older)],
                    [3, makeDropTarget(newer)],
                ]),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            });
        await runPostTransformPhase(args("defer"));
        expect(JSON.stringify(messages)).toBe(afterRebuild);
        expect(tagStatuses(sessionId).get(3)).toBe("active");
        await runPostTransformPhase(args("execute"));
        expect(tagStatuses(sessionId).get(3)).toBe("dropped");
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "defer",
                protectedTools: { todowrite: 20 },
                tags: getActiveTagsBySession(db, sessionId),
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );
        expect(tagStatuses(sessionId).get(3)).toBe("dropped");
    });

    it("protected tool N+1 rotation never originates a bust", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-protection-rotation";
        const { trigger, older, newer, recentTail } = seedTodowriteSession(sessionId);
        const arriving = structuredClone(newer);
        arriving.info.id = "tool-24";
        insertTag(db, sessionId, "tool-24", "tool", 4000, 24, 0, "todowrite", 0, "tool-24");
        const messages = [trigger, older, newer, ...recentTail, arriving];
        const before = JSON.stringify(messages);
        const targets = new Map([
            [1, makeDropTarget(trigger)],
            [2, makeDropTarget(older)],
            [3, makeDropTarget(newer)],
            [24, makeDropTarget(arriving)],
        ]);
        const result = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "defer",
                tags: getActiveTagsBySession(db, sessionId),
                targets,
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );
        expect(result.bustedThisPass).toBe(false);
        expect(JSON.stringify(messages)).toBe(before);
        expect(tagStatuses(sessionId).get(3)).toBe("active");
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "execute",
                pendingMaterializationSessions: new Set([sessionId]),
                tags: getActiveTagsBySession(db, sessionId),
                targets,
                sessionMeta: getOrCreateSessionMeta(db, sessionId),
            }),
        );
        expect(tagStatuses(sessionId).get(3)).toBe("dropped");
        expect(tagStatuses(sessionId).get(24)).toBe("active");
    });

    it("queued protected tool drop stays held at 95 until rotation and a rebuilding pass", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-held-protected-todo";
        const { trigger, older, newer, recentTail } = seedTodowriteSession(sessionId);
        queuePendingOp(db, sessionId, 3, "drop", 1);
        const messages = [trigger, older, newer, ...recentTail];
        const targets = new Map([
            [1, makeDropTarget(trigger)],
            [2, makeDropTarget(older)],
            [3, makeDropTarget(newer)],
        ]);
        const run = () =>
            runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    schedulerDecision: "execute",
                    pendingMaterializationSessions: new Set([sessionId]),
                    contextUsage: { percentage: 95, inputTokens: 95000 },
                    targets,
                    tags: getActiveTagsBySession(db, sessionId),
                    sessionMeta: getOrCreateSessionMeta(db, sessionId),
                }),
            );
        await run();
        expect(tagStatuses(sessionId).get(3)).toBe("active");
        expect(getPendingOps(db, sessionId).some((op) => op.tagId === 3)).toBe(true);
        await run();
        expect(tagStatuses(sessionId).get(3)).toBe("active");
        const arriving = structuredClone(newer);
        arriving.info.id = "tool-24";
        insertTag(db, sessionId, "tool-24", "tool", 4000, 24, 0, "todowrite", 0, "tool-24");
        messages.push(arriving);
        targets.set(24, makeDropTarget(arriving));
        expect(tagStatuses(sessionId).get(3)).toBe("active");
        await run();
        expect(tagStatuses(sessionId).get(3)).toBe("dropped");
        expect(getPendingOps(db, sessionId).some((op) => op.tagId === 3)).toBe(false);
        await run();
        expect(tagStatuses(sessionId).get(3)).toBe("dropped");
    });

    it("ON: superseded todowrite is dropped, newest kept, on a mutating execute pass", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-smart-on";
        const { trigger, older, newer, recentTail } = seedTodowriteSession(sessionId);

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [trigger, older, newer, ...recentTail], {
                schedulerDecision: "execute",
                pendingMaterializationSessions: new Set([sessionId]),
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
                    pendingMaterializationSessions: new Set([sessionId]),
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

    it("consumes an OpenCode flush on a hard fold and replays the next defer byte-identically", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "oc-fold-flush-defer";
        materializeBaseline(sessionId);
        insertTag(db, sessionId, "drop-call", "tool", 1000, 1, 0, "bash", 0, "drop-owner");
        padRecentToolSkeletonWindow(sessionId, 1);
        queuePendingOp(db, sessionId, 1, "drop");
        const pendingMaterializationSessions = new Set([sessionId]);
        const lines: string[] = [];
        const log = spyOn(loggerModule, "sessionLog").mockImplementation((_id, ...values) => {
            lines.push(values.join(" "));
        });
        const pass = async (currentTurnId: string | null = null) => {
            const message = makeToolMessage("drop-owner");
            const messages = [
                message,
                {
                    info: { id: "live-user", role: "user" },
                    parts: [{ type: "text", text: "retained tail" }],
                } as MessageLike,
            ];
            const targets = new Map([[1, makeDropTarget(message)]]);
            applyFlushedStatuses(sessionId, db, targets, getTagsBySession(db, sessionId));
            const result = await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    currentTurnId,
                    targets,
                    pendingMaterializationSessions,
                    resolvedProviderID: "anthropic",
                    m0M1: {
                        projectPath: FOLD_PROJECT,
                        projectDirectory: FOLD_PROJECT,
                        historyBudgetTokens: 98_000,
                        hardSignals: { ...BASE_HARD, modelKey: "anthropic/sonnet" },
                    },
                }),
            );
            return { result, wire: JSON.stringify(messages) };
        };
        try {
            const fold = await pass();
            expect(fold.result.materialized).toBe(true);
            expect(lines).toContain(
                "heuristics WILL RUN — reason=pending_materialization origin=user_flush, context=20.0%, turn=null",
            );
            expect(getPendingOps(db, sessionId)).toHaveLength(0);
            expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
            lines.length = 0;
            const defer = await pass();
            expect(defer.result.materialized).toBe(false);
            expect(lines).toContain("heuristics WILL NOT RUN — reason=scheduler_defer");
            expect(defer.wire).toBe(fold.wire);
            const repeated = await pass();
            expect(repeated.wire).toBe(defer.wire);
            expect(lines.filter((line) => line.startsWith("heuristics WILL NOT RUN"))).toHaveLength(
                1,
            );
            expect(
                lines.filter((line) => line.startsWith("pending ops WILL NOT APPLY")),
            ).toHaveLength(1);
            lines.length = 0;
            const nextTurn = await pass("next-real-user");
            expect(nextTurn.wire).toBe(defer.wire);
            expect(
                lines.filter((line) => line.startsWith("pending ops WILL NOT APPLY")),
            ).toHaveLength(1);
            await pass("next-real-user");
            expect(
                lines.filter((line) => line.startsWith("pending ops WILL NOT APPLY")),
            ).toHaveLength(1);
        } finally {
            log.mockRestore();
        }
    });

    it("review regression: executed fold must retire the held historian row it actually trims", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        createOpenCodeDbWithoutMessages("postprocess-held-fold-");
        const sessionId = "ses-hardfold-held-retirement";
        materializeBaseline(sessionId);
        const covered = makeToolMessage("covered-owner");
        const live = makeToolMessage("live-owner");
        const messages = [covered, live];
        for (const [index, message] of messages.entries()) {
            const part = message.parts[0] as { tool: string; callID: string };
            part.tool = "todowrite";
            // Reused call IDs must not retire a different, retained owner.
            part.callID = "shared-call";
            insertTag(
                db,
                sessionId,
                "shared-call",
                "tool",
                4000,
                index + 1,
                0,
                "todowrite",
                0,
                message.info.id,
            );
        }
        queueDropsForCompartmentalizedMessages(db, sessionId, 1, {
            messageFileKeys: new Set(),
            toolObservations: new Map([["shared-call", new Set(["covered-owner"])]]),
        });
        queuePendingOp(db, sessionId, 2, "drop");
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 1,
                startMessageId: "covered-owner",
                endMessageId: "covered-owner",
                title: "covered todo",
                content: "The covered todo was recorded.",
            },
        ]);
        const result = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([
                    [1, makeDropTarget(covered)],
                    [2, makeDropTarget(live)],
                ]),
                protectedTools: { todowrite: 2 },
                prefixTrimSourceOrder: capturePrefixTrimSourceOrder(messages),
                m0M1: {
                    projectPath: FOLD_PROJECT,
                    projectDirectory: FOLD_PROJECT,
                    historyBudgetTokens: 98_000,
                    hardSignals: { ...BASE_HARD, modelKey: "anthropic/sonnet" },
                },
            }),
        );
        expect(result.materialized).toBe(true);
        expect(result.prefixTrimStatus).toBe("applied");
        expect(messages.some((message) => message.info.id === "covered-owner")).toBe(false);
        expect(messages.find((message) => message.info.id === "live-owner")).toBe(live);
        expect((live.parts[0] as { state: { output: string } }).state.output).toContain("word ");
        expect(getTagsBySession(db, sessionId).map((tag) => tag.status)).toEqual([
            "compacted",
            "active",
        ]);
        expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toEqual([2]);
    });

    it("folded protected results stay out of N when protection is disabled and restored", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        createOpenCodeDbWithoutMessages("postprocess-rotated-protection-");
        const sessionId = "ses-folded-protection-rotation";
        materializeBaseline(sessionId);
        const messages = [1, 2, 3].map((number) => {
            const message = makeToolMessage(`rotation-owner-${number}`);
            const part = message.parts[0] as { tool: string; callID: string };
            part.tool = "probe";
            part.callID = `rotation-call-${number}`;
            insertTag(
                db,
                sessionId,
                part.callID,
                "tool",
                4000,
                number,
                0,
                "probe",
                0,
                message.info.id,
            );
            return message;
        });
        const channel1StateBySession = new Map<string, Channel1State>();
        const toolMessages = messages.slice();
        const run = (protectedTools: Record<string, number>, rebuilding = false) =>
            runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    tags: getActiveTagsBySession(db, sessionId),
                    targets: new Map(
                        toolMessages.map((message, index) => [index + 1, makeDropTarget(message)]),
                    ),
                    protectedTools,
                    channel1StateBySession,
                    m0M1: {
                        projectPath: FOLD_PROJECT,
                        projectDirectory: FOLD_PROJECT,
                        historyBudgetTokens: 98_000,
                        hardSignals: rebuilding
                            ? { ...BASE_HARD, modelKey: "anthropic/sonnet" }
                            : BASE_HARD,
                    },
                }),
            );
        await run({ probe: 3 });
        queuePendingOp(db, sessionId, 1, "drop");
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "rotation-owner-1",
                endMessageId: "rotation-owner-2",
                title: "folded probes",
                content: "The first two probes were recorded.",
            },
        ]);
        const fold = await run({ probe: 0 }, true);
        expect(fold.materialized).toBe(true);
        expect(getTagsBySession(db, sessionId).map((tag) => tag.status)).toEqual([
            "compacted",
            "compacted",
            "active",
        ]);
        expect(getPendingOps(db, sessionId)).toEqual([]);
        expect([
            ...protectedToolTagNumbers(getActiveTagsBySession(db, sessionId), { probe: 3 }),
        ]).toEqual([3]);
        await run({ probe: 3 });
        expect(getTagsBySession(db, sessionId).map((tag) => tag.status)).toEqual([
            "compacted",
            "compacted",
            "active",
        ]);
    });

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

    it("neutralizes a tag-only assistant on the HARD fold and replays its sentinel on defer", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-hardfold-inert-whitespace";
        const dataHome = createTestTempDirFromPath(
            join(tmpdir(), "postprocess-hardfold-whitespace-"),
        );
        tempDirs.push(dataHome);
        process.env.XDG_DATA_HOME = dataHome;
        mkdirSync(join(dataHome, "opencode"), { recursive: true });
        const opencodeDb = new Database(join(dataHome, "opencode", "opencode.db"));
        opencodeDb.exec("PRAGMA journal_mode=WAL");
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
                prefixTrimSourceOrder: capturePrefixTrimSourceOrder([
                    {
                        info: { id: "msg-fold-boundary", role: "user", sessionID: sessionId },
                        parts: [{ type: "text", text: "covered" }],
                    } as MessageLike,
                    ...hardMessages,
                ]),
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
        // A bare tag is a complete marker; its replacement text is replayed on later passes.
        expect(hardWhitespace?.parts).toEqual([{ type: "text", text: "[dropped]" }]);
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
        expect(deferWhitespace?.parts).toEqual([{ type: "text", text: "[dropped]" }]);
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

    it("replays legacy marker skeletons on defer passes and converts them only on an executed HARD fold", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-hardfold-legacy-skeleton";
        materializeBaseline(sessionId);
        const largeContent = "L".repeat(2000);
        const makeTail = () =>
            [
                {
                    info: { id: "m-small", role: "assistant", sessionID: sessionId },
                    parts: [
                        {
                            type: "tool",
                            tool: "bash",
                            callID: "call-small",
                            state: {
                                status: "completed",
                                input: { command: "ls -la" },
                                output: "small output",
                            },
                        },
                    ],
                },
                {
                    info: { id: "m-large", role: "assistant", sessionID: sessionId },
                    parts: [
                        {
                            type: "tool",
                            tool: "write",
                            callID: "call-large",
                            state: {
                                status: "completed",
                                input: { filePath: "/tmp/a.txt", content: largeContent },
                                output: "wrote file",
                            },
                        },
                    ],
                },
                {
                    info: { id: "m-next", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "next prompt" }],
                },
            ] as unknown as MessageLike[];
        const tailOnly = (messages: MessageLike[]) =>
            JSON.stringify(
                messages.filter((message) => ["m-small", "m-large"].includes(message.info.id)),
            );
        const pass = async (hardSignals?: M0HardSignals) => {
            const messages = makeTail();
            const tagger = createTagger();
            tagger.initFromDb(sessionId, db);
            const tagged = tagMessages(sessionId, messages, tagger, db);
            const replayed = applyFlushedStatuses(sessionId, db, tagged.targets);
            tagged.batch.finalize();
            const result = await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    tagger,
                    targets: tagged.targets,
                    reasoningByMessage: tagged.reasoningByMessage,
                    messageTagNumbers: tagged.messageTagNumbers,
                    batch: tagged.batch,
                    didMutateFromFlushedStatuses: replayed,
                    schedulerDecision: "defer",
                    contextUsage: { percentage: 40, inputTokens: 4000 },
                    m0M1: {
                        projectPath: FOLD_PROJECT,
                        projectDirectory: FOLD_PROJECT,
                        historyBudgetTokens: 98_000,
                        hardSignals: hardSignals ?? BASE_HARD,
                    },
                }),
            );
            return { messages, result };
        };

        // Seed a session that already serves two legacy marker skeletons.
        const first = makeTail();
        const firstTagger = createTagger();
        tagMessages(sessionId, first, firstTagger, db);
        const small = firstTagger.getToolTag(sessionId, "call-small", "m-small")!;
        const large = firstTagger.getToolTag(sessionId, "call-large", "m-large")!;
        for (const tag of [small, large]) {
            updateTagStatus(db, sessionId, tag, "dropped");
            updateTagDropMode(db, sessionId, tag, "truncated");
        }

        // Defer passes replay the marker byte-identically and never convert.
        const deferA = await pass();
        const deferB = await pass();
        const legacyWire = tailOnly(deferA.messages);
        expect(deferA.result.materialized).toBe(false);
        expect(legacyWire).toContain(`{"dropped":"[dropped §${small}§]"}`);
        expect(legacyWire).toContain(`{"dropped":"[dropped §${large}§]"}`);
        expect(tailOnly(deferB.messages)).toBe(legacyWire);
        expect(getTagsBySession(db, sessionId).find((t) => t.tagNumber === small)?.dropMode).toBe(
            "truncated",
        );

        // The HARD fold converts: small keeps its real arguments, large is removed.
        const hardSignals = { ...BASE_HARD, modelKey: "anthropic/sonnet" };
        const hard = await pass(hardSignals);
        expect(hard.result.materialized).toBe(true);
        const tags = getTagsBySession(db, sessionId);
        expect(tags.find((t) => t.tagNumber === small)?.dropMode).toBe("skeleton_real");
        expect(tags.find((t) => t.tagNumber === large)?.dropMode).toBe("full");
        const convertedWire = tailOnly(hard.messages);
        expect(convertedWire).not.toContain('"dropped":');
        expect(convertedWire).not.toContain("call-large");
        const smallPart = hard.messages.find((m) => m.info.id === "m-small")?.parts[0] as {
            state: { input: unknown; output: string };
        };
        expect(smallPart.state.input).toEqual({ command: "ls -la" });
        expect(smallPart.state.output).toBe(`[dropped §${small}§]`);

        // The following defer pass replays the converted bytes identically.
        const after = await pass(hardSignals);
        expect(after.result.materialized).toBe(false);
        expect(tailOnly(after.messages)).toBe(convertedWire);
    });

    // Adversarial gate reproductions for legacy marker conversion (real-or-absent).
    // Each trigger gets its own session so a conversion can only come from it.
    const ADV_TRIGGERS: Array<{ name: string; signals: (base: M0HardSignals) => M0HardSignals }> = [
        { name: "model change", signals: (b) => ({ ...b, modelKey: "anthropic/sonnet" }) },
        { name: "system hash", signals: (b) => ({ ...b, systemHash: "sys-v2" }) },
        {
            name: "TTL idle",
            signals: (b) => ({ ...b, cacheExpired: true, lastResponseTime: Date.now() + 60_000 }),
        },
    ];
    function advTail(sessionId: string, newer: number): MessageLike[] {
        const tool = (id: string, callID: string, name: string, input: unknown) => ({
            info: { id, role: "assistant", sessionID: sessionId },
            parts: [
                {
                    type: "tool",
                    tool: name,
                    callID,
                    state: { status: "completed", input, output: `${id} output` },
                },
            ],
        });
        const user = (id: string, text: string) => ({
            info: { id, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text }],
        });
        return [
            user("m-u0", "start"),
            tool("m-small", "c-small", "bash", { command: "ls -la" }),
            // 512 x "é" = 1024 UTF-8 bytes: small; plus one byte: large.
            tool("m-mb1024", "c-mb1024", "write", { content: "\u00e9".repeat(512) }),
            tool("m-mb1025", "c-mb1025", "write", { content: `${"\u00e9".repeat(512)}a` }),
            tool("m-a1024", "c-a1024", "write", {
                nested: [{ c: "a".repeat(1000) }, "b".repeat(24)],
            }),
            tool("m-large", "c-large", "write", { content: "L".repeat(4000) }),
            user("m-next", "next prompt"),
            ...Array.from({ length: newer }, (_, i) => user(`m-newer-${i}`, `newer ${i}`)),
        ] as unknown as MessageLike[];
    }
    const ADV_CALLS: Array<[string, string]> = [
        ["c-small", "m-small"],
        ["c-mb1024", "m-mb1024"],
        ["c-mb1025", "m-mb1025"],
        ["c-a1024", "m-a1024"],
        ["c-large", "m-large"],
    ];
    async function advPass(
        sessionId: string,
        opts: {
            hard?: M0HardSignals;
            newer?: number;
            scheduler?: "defer" | "execute";
            budget?: number;
        },
    ) {
        const messages = advTail(sessionId, opts.newer ?? 0);
        const tagger = createTagger();
        tagger.initFromDb(sessionId, db);
        const tagged = tagMessages(sessionId, messages, tagger, db);
        const replayed = applyFlushedStatuses(sessionId, db, tagged.targets);
        tagged.batch.finalize();
        const result = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                tagger,
                targets: tagged.targets,
                reasoningByMessage: tagged.reasoningByMessage,
                messageTagNumbers: tagged.messageTagNumbers,
                batch: tagged.batch,
                didMutateFromFlushedStatuses: replayed,
                schedulerDecision: opts.scheduler ?? "defer",
                contextUsage: { percentage: 40, inputTokens: 4000 },
                m0M1: {
                    projectPath: FOLD_PROJECT,
                    projectDirectory: FOLD_PROJECT,
                    historyBudgetTokens: opts.budget ?? 98_000,
                    hardSignals: opts.hard ?? BASE_HARD,
                },
            }),
        );
        return { messages, result };
    }
    function advSeedLegacy(sessionId: string): Map<string, number> {
        const tagger = createTagger();
        tagMessages(sessionId, advTail(sessionId, 0), tagger, db);
        const tags = new Map<string, number>();
        for (const [call, owner] of ADV_CALLS) {
            const tag = tagger.getToolTag(sessionId, call, owner)!;
            tags.set(call, tag);
            updateTagStatus(db, sessionId, tag, "dropped");
            updateTagDropMode(db, sessionId, tag, "truncated");
        }
        return tags;
    }
    const advModes = (sessionId: string, tags: Map<string, number>) =>
        Object.fromEntries(
            [...tags].map(([call, tag]) => [
                call,
                getTagsBySession(db, sessionId).find((t) => t.tagNumber === tag)?.dropMode,
            ]),
        );
    const advSha = (messages: MessageLike[]) =>
        createHash("sha256").update(JSON.stringify(messages)).digest("hex");

    it("ADV: an execute (SOFT) pass without a HARD fold never converts legacy markers", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-adv-soft";
        materializeBaseline(sessionId);
        const tags = advSeedLegacy(sessionId);
        const defer = await advPass(sessionId, {});
        const soft = await advPass(sessionId, { scheduler: "execute" });
        const deferAgain = await advPass(sessionId, {});
        console.log(
            "ADV_SOFT",
            JSON.stringify({
                softMaterialized: soft.result.materialized,
                modes: advModes(sessionId, tags),
                deferSha: advSha(defer.messages),
                softTailEqualsDefer:
                    JSON.stringify(soft.messages.slice(-7)) ===
                    JSON.stringify(defer.messages.slice(-7)),
                deferAgainSha: advSha(deferAgain.messages),
            }),
        );
        expect(soft.result.materialized).toBe(false);
        for (const mode of Object.values(advModes(sessionId, tags))) expect(mode).toBe("truncated");
        expect(JSON.stringify(soft.messages.slice(-7))).toBe(
            JSON.stringify(defer.messages.slice(-7)),
        );
        expect(advSha(deferAgain.messages)).toBe(advSha(defer.messages));
    });

    it("ADV: a pressure refold (an oversized m[1] on an execute pass) converts legacy markers", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        // The user-profile tables come from migrations.
        runMigrations(db);
        const sessionId = "ses-adv-pressure";
        injectM0M1({
            db,
            sessionId,
            state: getOrCreateSessionMeta(db, sessionId),
            projectPath: FOLD_PROJECT,
            projectDirectory: FOLD_PROJECT,
            historyBudgetTokens: 500,
            isCacheBustingPass: true,
            hardSignals: BASE_HARD,
        });
        const tags = advSeedLegacy(sessionId);
        const d1 = await advPass(sessionId, { budget: 500 });
        // A busting SOFT reads no memory rows, so new memories can no longer grow
        // m[1]. A large user-profile change still does, which is the pressure source.
        await growUserProfile("ADV_PRESSURE_PROFILE");
        const d2 = await advPass(sessionId, { budget: 500 });
        const exec = await advPass(sessionId, { scheduler: "execute", budget: 500 });
        const modes = advModes(sessionId, tags);
        const after = await advPass(sessionId, { newer: 1, budget: 500 });
        const shared = after.messages.slice(0, exec.messages.length);
        console.log(
            "ADV_PRESSURE",
            JSON.stringify({
                d1EqD2Tail:
                    JSON.stringify(d1.messages.slice(-7)) === JSON.stringify(d2.messages.slice(-7)),
                execMaterialized: exec.result.materialized,
                execResult: Object.fromEntries(
                    Object.entries(exec.result).filter(([k]) =>
                        /reason|decision|materializ/i.test(k),
                    ),
                ),
                modes,
                execSha: advSha(exec.messages),
                afterSharedSha: advSha(shared),
                oldMarkerLeft: JSON.stringify(exec.messages).includes('"dropped":'),
            }),
        );
        expect(exec.result.materialized).toBe(true);
        expect(modes["c-small"]).toBe("skeleton_real");
        expect(modes["c-large"]).toBe("full");
        expect(advSha(shared)).toBe(advSha(exec.messages));
    });

    it("ADV: a project_memory_epoch bump with byte-identical m[0] does not convert legacy markers", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-adv-epoch-identical";
        materializeBaseline(sessionId);
        const tags = advSeedLegacy(sessionId);
        const defer = await advPass(sessionId, {});
        const { bumpEpochsForWorkspaceMembers } = await import(
            "../../features/magic-context/workspaces"
        );
        // An epoch bump with no memory content change (e.g. an external write that
        // does not alter the rendered m[0]).
        bumpEpochsForWorkspaceMembers(db, FOLD_PROJECT);
        const hard = await advPass(sessionId, {});
        const firstDiff = (() => {
            const n = Math.min(defer.messages.length, hard.messages.length);
            for (let i = 0; i < n; i++) {
                if (JSON.stringify(defer.messages[i]) !== JSON.stringify(hard.messages[i])) {
                    return { index: i, id: hard.messages[i]?.info.id ?? null };
                }
            }
            return null;
        })();
        console.log(
            "ADV_EPOCH_IDENTICAL",
            JSON.stringify({
                hardMaterialized: hard.result.materialized,
                reason: (hard.result as { materializeReason?: unknown }).materializeReason,
                modes: advModes(sessionId, tags),
                m0m1Identical:
                    JSON.stringify(defer.messages.slice(0, 2)) ===
                    JSON.stringify(hard.messages.slice(0, 2)),
                firstDiff,
            }),
        );
        expect(hard.result.materialized).toBe(false);
        // The fold re-rendered m[0]/m[1] byte-identically, so the prefix stays
        // cached. The conversion only rides a bust that already rewrites the
        // prefix: here it must not happen, and the served bytes stay identical.
        expect(JSON.stringify(hard.messages.slice(0, 2))).toBe(
            JSON.stringify(defer.messages.slice(0, 2)),
        );
        expect(firstDiff).toBeNull();
        expect(Object.values(advModes(sessionId, tags))).toEqual(
            Array(ADV_CALLS.length).fill("truncated"),
        );

        // A later HARD whose trigger loses the provider cache (a model change)
        // converts them.
        const changed = await advPass(sessionId, {
            hard: { ...BASE_HARD, modelKey: "anthropic/sonnet" },
        });
        expect(changed.result.materialized).toBe(true);
        expect(advModes(sessionId, tags)["c-small"]).toBe("skeleton_real");
        expect(advModes(sessionId, tags)["c-large"]).toBe("full");
    });

    it("ADV: same-pass re-clamp: parallel legacy calls in one message plus a pending drop drained on the HARD pass", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-adv-parallel-reclamp";
        materializeBaseline(sessionId);
        const part = (callID: string, input: unknown) => ({
            type: "tool",
            tool: "bash",
            callID,
            state: { status: "completed", input, output: `${callID} output` },
        });
        const build = (newer: boolean) =>
            [
                {
                    info: { id: "m-u0", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "go" }],
                },
                {
                    info: { id: "m-par", role: "assistant", sessionID: sessionId },
                    parts: [
                        { type: "text", text: "three at once" },
                        part("p-small", { command: "ls" }),
                        part("p-large", { command: "L".repeat(3000) }),
                        part("p-new", { command: "N".repeat(2000) }),
                        part("p-keep", { command: "pwd" }),
                    ],
                },
                {
                    info: { id: "m-next", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "next" }],
                },
                ...(newer
                    ? [
                          {
                              info: { id: "m-newer", role: "user", sessionID: sessionId },
                              parts: [{ type: "text", text: "newer" }],
                          },
                      ]
                    : []),
            ] as unknown as MessageLike[];
        const pass = async (hard: M0HardSignals, newer: boolean) => {
            const messages = build(newer);
            const tagger = createTagger();
            tagger.initFromDb(sessionId, db);
            const tagged = tagMessages(sessionId, messages, tagger, db);
            const replayed = applyFlushedStatuses(sessionId, db, tagged.targets);
            tagged.batch.finalize();
            const result = await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    tagger,
                    targets: tagged.targets,
                    reasoningByMessage: tagged.reasoningByMessage,
                    messageTagNumbers: tagged.messageTagNumbers,
                    batch: tagged.batch,
                    didMutateFromFlushedStatuses: replayed,
                    schedulerDecision: "defer",
                    contextUsage: { percentage: 40, inputTokens: 4000 },
                    m0M1: {
                        projectPath: FOLD_PROJECT,
                        projectDirectory: FOLD_PROJECT,
                        historyBudgetTokens: 98_000,
                        hardSignals: hard,
                    },
                }),
            );
            return { messages, result };
        };
        const seedTagger = createTagger();
        tagMessages(sessionId, build(false), seedTagger, db);
        const tagOf = (call: string) => seedTagger.getToolTag(sessionId, call, "m-par")!;
        for (const call of ["p-small", "p-large"]) {
            updateTagStatus(db, sessionId, tagOf(call), "dropped");
            updateTagDropMode(db, sessionId, tagOf(call), "truncated");
        }
        const defer = await pass(BASE_HARD, false);
        queuePendingOp(db, sessionId, tagOf("p-new"), "drop");
        const hardSignals = { ...BASE_HARD, modelKey: "anthropic/sonnet" };
        const hard = await pass(hardSignals, false);
        const after = await pass(hardSignals, true);
        const par = (messages: MessageLike[]) =>
            JSON.stringify(messages.find((m) => m.info.id === "m-par")?.parts);
        const modes = Object.fromEntries(
            ["p-small", "p-large", "p-new", "p-keep"].map((call) => [
                call,
                getTagsBySession(db, sessionId).find((t) => t.tagNumber === tagOf(call))?.dropMode +
                    "/" +
                    getTagsBySession(db, sessionId).find((t) => t.tagNumber === tagOf(call))
                        ?.status,
            ]),
        );
        console.log(
            "ADV_PARALLEL",
            JSON.stringify({
                hardMaterialized: hard.result.materialized,
                modes,
                deferPar: par(defer.messages).slice(0, 400),
                hardPar: par(hard.messages),
                afterEqualsHard: par(after.messages) === par(hard.messages),
                prefixShaEqual:
                    advSha(after.messages.slice(0, hard.messages.length)) === advSha(hard.messages),
            }),
        );
        expect(hard.result.materialized).toBe(true);
        expect(par(hard.messages)).not.toContain('"dropped":');
        expect(advSha(after.messages.slice(0, hard.messages.length))).toBe(advSha(hard.messages));
    });

    for (const trigger of ADV_TRIGGERS) {
        it(`ADV: legacy markers replay on defer, convert on a HARD fold from ${trigger.name}, then replay byte-identically with newer messages`, async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = `ses-adv-${trigger.name.replace(/\W+/g, "-")}`;
            materializeBaseline(sessionId);
            const tags = advSeedLegacy(sessionId);
            const d1 = await advPass(sessionId, {});
            const d2 = await advPass(sessionId, {});
            const d3 = await advPass(sessionId, {});
            expect(advSha(d2.messages)).toBe(advSha(d1.messages));
            expect(advSha(d3.messages)).toBe(advSha(d1.messages));
            const hardSignals = trigger.signals(BASE_HARD);
            const hard = await advPass(sessionId, { hard: hardSignals });
            const modes = advModes(sessionId, tags);
            const hardJson = JSON.stringify(hard.messages);
            // Defer pass B: one newer message appended; compare over the shared prefix.
            const after = await advPass(sessionId, {
                hard: { ...hardSignals, cacheExpired: false },
                newer: 1,
            });
            const shared = after.messages.slice(0, hard.messages.length);
            console.log(
                "ADV_HARD",
                trigger.name,
                JSON.stringify({
                    hardMaterialized: hard.result.materialized,
                    afterMaterialized: after.result.materialized,
                    modes,
                    hardSha: advSha(hard.messages),
                    afterSharedSha: advSha(shared),
                    lengths: [hard.messages.length, after.messages.length],
                    oldMarkerLeft: hardJson.includes('"dropped":'),
                }),
            );
            expect(hard.result.materialized).toBe(true);
            expect(modes).toEqual({
                "c-small": "skeleton_real",
                "c-mb1024": "skeleton_real",
                "c-mb1025": "full",
                "c-a1024": "skeleton_real",
                "c-large": "full",
            });
            expect(hardJson).not.toContain('"dropped":');
            expect(after.result.materialized).toBe(false);
            expect(after.messages.length).toBe(hard.messages.length + 1);
            expect(advSha(shared)).toBe(advSha(hard.messages));
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

    it.each([
        2, 3, 5,
    ])("OpenCode 1/2 distance bookmark keeps the current task through %i TTL rebuilds and a model switch", async (rebuilds) => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = `ses-distance-idle-${rebuilds}`;
        materializeBaseline(sessionId);
        const tools = Array.from({ length: 8 }, (_, index) => makeToolMessage(`tool-${index + 1}`));
        const messages: MessageLike[] = [
            {
                info: { id: "task", role: "user" },
                parts: [{ type: "text", text: "implement the feature" }],
            },
            ...tools,
        ];
        const targets = new Map(
            tools.map((message, index) => {
                insertTag(db, sessionId, message.info.id, "tool", 4000, index + 1, 0, "bash");
                return [
                    index + 1,
                    {
                        ...makeDropTarget(message),
                        mutationParts: [{ message, part: message.parts[0] }],
                    },
                ] as const;
            }),
        );
        for (let pass = 0; pass <= rebuilds; pass++) {
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    tags: getActiveTagsBySession(db, sessionId),
                    targets,
                    contextUsage: { percentage: 2, inputTokens: 4000 },
                    usableWindow: 200_000,
                    m0M1: {
                        projectPath: FOLD_PROJECT,
                        projectDirectory: FOLD_PROJECT,
                        historyBudgetTokens: 98_000,
                        hardSignals: {
                            ...BASE_HARD,
                            cacheExpired: pass < rebuilds,
                            lastResponseTime: Number.MAX_SAFE_INTEGER,
                            modelKey: pass === rebuilds ? "other/model" : BASE_HARD.modelKey,
                        },
                    },
                }),
            );
            expect(getOrCreateSessionMeta(db, sessionId).toolReclaimWatermark).toBe(0);
            expect(
                getTagsBySession(db, sessionId).filter((tag) => tag.status === "active"),
            ).toHaveLength(8);
        }
        queuePendingOp(db, sessionId, 1, "drop", 1);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                tags: getActiveTagsBySession(db, sessionId),
                targets,
                pendingMaterializationSessions: new Set([sessionId]),
            }),
        );
        expect(
            getTagsBySession(db, sessionId)
                .filter((tag) => tag.status === "dropped")
                .map((tag) => tag.tagNumber),
        ).toEqual([1]);
    });

    it("OpenCode 1/2 single-user tool loop ages by a quarter-window of newer tokens", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-oc-token-distance";
        const tools = Array.from({ length: 4 }, (_, index) => makeToolMessage(`loop-${index}`));
        const targets = new Map<number, TagTarget>();
        for (const [index, message] of tools.entries()) {
            (message.parts[0] as { state: { output: string } }).state.output =
                `unique ${index} ${"payload ".repeat(index === 0 ? 500 : 17_000)}`;
            insertTag(db, sessionId, message.info.id, "tool", 4000, index + 1, 0, "bash");
            targets.set(index + 1, {
                ...makeDropTarget(message),
                mutationParts: [{ message, part: message.parts[0] }],
            });
        }
        const messages: MessageLike[] = [
            {
                info: { id: "task", role: "user" },
                parts: [{ type: "text", text: "one coding task" }],
            },
            ...tools,
        ];
        const pass = () =>
            runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    tags: getActiveTagsBySession(db, sessionId),
                    targets,
                    usableWindow: 200_000,
                    pendingMaterializationSessions: new Set([sessionId]),
                }),
            );
        await pass();
        expect(getOrCreateSessionMeta(db, sessionId).toolReclaimWatermark).toBe(1);
        expect(getTagsBySession(db, sessionId).map((tag) => tag.status)).toEqual(
            Array(4).fill("active"),
        );
        await pass();
        expect(getTagsBySession(db, sessionId).map((tag) => tag.status)).toEqual([
            "dropped",
            "active",
            "active",
            "active",
        ]);
    });

    it("OpenCode 1/2 distant outputs and edits survive one free rebuild, then reclaim at low usage", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-distance-edit";
        materializeBaseline(sessionId);
        const tools = [
            makeToolMessage("old-edit"),
            makeToolMessage("new-edit"),
            makeToolMessage("old-bash"),
        ];
        const tail: MessageLike[] = Array.from({ length: 24 }, (_, index) => ({
            info: { id: `tail-${index}`, role: index < 3 ? "user" : "assistant" },
            parts: [
                {
                    type: "text",
                    text:
                        index < 3
                            ? "<system-reminder>Background task finished.</system-reminder>"
                            : `continuation ${index}`,
                },
            ],
        }));
        const messages = [...tools, ...tail];
        const targets = new Map<number, TagTarget>();
        for (const [index, message] of tools.entries()) {
            const tag = index + 1;
            if (index < 2)
                (message.parts[0] as { state: { output: string } }).state.output = "edited";
            insertTag(
                db,
                sessionId,
                message.info.id,
                "tool",
                index < 2 ? 24 : 4000,
                tag,
                0,
                index < 2 ? "edit" : "bash",
                0,
                message.info.id,
                null,
                { tokenCount: index < 2 ? 100 : 1000, inputTokenCount: 0, reasoningTokenCount: 0 },
            );
            const target = makeDropTarget(message);
            targets.set(tag, {
                ...target,
                mutationParts: [{ message, part: message.parts[0] }],
                readInput: () => ({ filePath: "/feature.ts", oldString: "a", newString: "b" }),
                editMarker: target.truncate,
            });
        }
        tail.forEach((message, index) => {
            insertTag(db, sessionId, message.info.id, "message", 50, index + 4);
        });
        const pass = (bust: boolean) =>
            runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    tags: getActiveTagsBySession(db, sessionId),
                    targets,
                    contextUsage: { percentage: 2, inputTokens: 4000 },
                    usableWindow: 200_000,
                    pendingMaterializationSessions: new Set(bust ? [sessionId] : []),
                }),
            );
        await pass(true);
        expect(getOrCreateSessionMeta(db, sessionId).toolReclaimWatermark).toBe(3);
        expect(
            getTagsBySession(db, sessionId)
                .slice(0, 3)
                .map((tag) => tag.status),
        ).toEqual(["active", "active", "active"]);
        const replay = JSON.stringify(messages);
        await pass(false);
        expect(JSON.stringify(messages)).toBe(replay);
        expect(getOrCreateSessionMeta(db, sessionId).toolReclaimWatermark).toBe(3);
        await pass(true);
        expect(
            getTagsBySession(db, sessionId)
                .slice(0, 3)
                .map((tag) => tag.status),
        ).toEqual(["dropped", "active", "dropped"]);
    });

    it("drains pending ops and previously bookmarked age reclaim on the same low-usage TTL fold", async () => {
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
        expect(statuses.get(2)).toBe("dropped");
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

    // A HARD fold whose re-render reproduces the served m[0]/m[1] bytes leaves
    // the provider's cached prefix alive. Such a fold must not hand the mutation
    // lanes a bust permission, or a lane would originate the only bust itself.
    describe("identical-bytes HARD fold does not open the mutation lanes", () => {
        const sha = (messages: MessageLike[]) =>
            createHash("sha256").update(JSON.stringify(messages)).digest("hex");
        const head = (messages: MessageLike[]) => JSON.stringify(messages.slice(0, 2));

        function tail(sessionId: string, newer = 0): MessageLike[] {
            const tool = (id: string, callID: string, input: unknown, output: string) => ({
                info: { id, role: "assistant", sessionID: sessionId },
                parts: [
                    {
                        type: "tool",
                        tool: "bash",
                        callID,
                        state: { status: "completed", input, output },
                    },
                ],
            });
            const user = (id: string, text: string) => ({
                info: { id, role: "user", sessionID: sessionId },
                parts: [{ type: "text", text }],
            });
            return [
                user("m-u0", "start"),
                tool("m-old", "c-old", { command: "cat big" }, "O".repeat(3000)),
                tool("m-mid", "c-mid", { command: "cat mid" }, "M".repeat(3000)),
                tool("m-new", "c-new", { command: "ls" }, "new output"),
                user("m-next", "next prompt"),
                ...Array.from({ length: newer }, (_, i) => user(`m-newer-${i}`, `newer ${i}`)),
            ] as unknown as MessageLike[];
        }

        async function pass(
            sessionId: string,
            opts: {
                hard?: M0HardSignals;
                newer?: number;
                scheduler?: "defer" | "execute";
                budget?: number;
                turn?: string;
            } = {},
        ) {
            const messages = tail(sessionId, opts.newer ?? 0);
            const tagger = createTagger();
            tagger.initFromDb(sessionId, db);
            const tagged = tagMessages(sessionId, messages, tagger, db);
            const replayed = applyFlushedStatuses(sessionId, db, tagged.targets);
            tagged.batch.finalize();
            const result = await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    tagger,
                    tags: getActiveTagsBySession(db, sessionId),
                    targets: tagged.targets,
                    reasoningByMessage: tagged.reasoningByMessage,
                    messageTagNumbers: tagged.messageTagNumbers,
                    batch: tagged.batch,
                    didMutateFromFlushedStatuses: replayed,
                    schedulerDecision: opts.scheduler ?? "defer",
                    currentTurnId: opts.turn ?? null,
                    contextUsage: { percentage: 40, inputTokens: 4000 },
                    m0M1: {
                        projectPath: FOLD_PROJECT,
                        projectDirectory: FOLD_PROJECT,
                        historyBudgetTokens: opts.budget ?? 98_000,
                        hardSignals: opts.hard ?? BASE_HARD,
                    },
                }),
            );
            return { messages, result };
        }

        function toolTag(sessionId: string, callID: string, owner: string): number {
            const tagger = createTagger();
            tagger.initFromDb(sessionId, db);
            const tag = tagger.getToolTag(sessionId, callID, owner);
            if (tag === undefined || tag === null) throw new Error(`no tag for ${callID}`);
            return tag;
        }
        const statusOf = (sessionId: string, tag: number) =>
            getTagsBySession(db, sessionId).find((row) => row.tagNumber === tag)?.status;

        const bumpStructuralMutation = async () => {
            for (const row of db.prepare("SELECT session_id FROM session_meta").all() as Array<{
                session_id: string;
            }>)
                queueM0Mutation(db, {
                    sessionId: row.session_id,
                    mutationType: "compartment_delete",
                });
        };
        const setCachedUpgradeState = (sessionId: string, from: string, to: string) => {
            editCachedUpgradeFixture(db, sessionId, (value) =>
                value === null ? null : from.length > 0 ? value.replaceAll(from, to) : value,
            );
        };

        // Each HARD trigger listed below is armed alone on a session whose
        // rendered content is unchanged; `identical` records whether the fold
        // reproduces the previously served m[0]/m[1] bytes.
        const TRIGGERS: Array<{
            reason: string;
            arm: (sessionId: string) => Promise<M0HardSignals | undefined>;
            identical: boolean;
        }> = [
            {
                reason: "upgrade_state",
                arm: async (sessionId) => {
                    setCachedUpgradeState(sessionId, "ready", "legacy");
                    return undefined;
                },
                identical: true,
            },
            {
                reason: "compartment_render_epoch",
                arm: async (sessionId) => {
                    setCachedUpgradeState(
                        sessionId,
                        "|compartment-render:cre",
                        "|compartment-render:old",
                    );
                    return undefined;
                },
                identical: true,
            },
            {
                reason: "max_mutation_id",
                arm: async (sessionId) => {
                    queueM0Mutation(db, { sessionId, mutationType: "compartment_delete" });
                    return undefined;
                },
                identical: true,
            },
            {
                reason: "model_change",
                arm: async () => ({ ...BASE_HARD, modelKey: "anthropic/sonnet" }),
                identical: true,
            },
            {
                reason: "system_hash",
                arm: async () => ({ ...BASE_HARD, systemHash: "sys-v2" }),
                identical: true,
            },
            {
                reason: "ttl_idle",
                arm: async () => ({
                    ...BASE_HARD,
                    cacheExpired: true,
                    lastResponseTime: Date.now() + 60_000,
                }),
                identical: true,
            },
        ];

        for (const trigger of TRIGGERS) {
            it(`${trigger.reason}: HARD fold executes and ${trigger.identical ? "re-renders m[0]/m[1] byte-identically" : "changes m[0]/m[1]"}`, async () => {
                db = new Database(":memory:");
                initializeDatabase(db);
                const sessionId = `ses-identical-${trigger.reason}`;
                materializeBaseline(sessionId);
                const defer = await pass(sessionId);
                const hardSignals = await trigger.arm(sessionId);
                const hard = await pass(sessionId, { hard: hardSignals });
                expect(hard.result.materialized).toBe(true);
                expect(hard.result.materializeReason).toBe(trigger.reason);
                expect(head(hard.messages) === head(defer.messages)).toBe(trigger.identical);
            });
        }

        it("cached_m1_missing: HARD fold executes; the missing pair already counts as a first-render bust", async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = "ses-identical-cached-m1-missing";
            materializeBaseline(sessionId);
            const defer = await pass(sessionId);
            db.prepare(
                "DELETE FROM session_render_cache WHERE cache_key = 'cached_m1_bytes' AND session_id = ?",
            ).run(sessionId);
            const hard = await pass(sessionId);
            expect(hard.result.materialized).toBe(true);
            expect(hard.result.materializeReason).toBe("cached_m1_missing");
            // The re-render reproduces the old pair, but with no complete cached
            // pair on record the pass cannot prove what the provider holds.
            expect(head(hard.messages)).toBe(head(defer.messages));
        });

        it("pressure refold: absorbing a large m[1] into m[0] changes the served pair", async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            // The user-profile tables come from migrations.
            runMigrations(db);
            const sessionId = "ses-identical-pressure";
            injectM0M1({
                db,
                sessionId,
                state: getOrCreateSessionMeta(db, sessionId),
                projectPath: FOLD_PROJECT,
                projectDirectory: FOLD_PROJECT,
                historyBudgetTokens: 500,
                isCacheBustingPass: true,
                hardSignals: BASE_HARD,
            });
            await growUserProfile("PRESSURE_PROFILE");
            const defer = await pass(sessionId, { budget: 500 });
            const exec = await pass(sessionId, { scheduler: "execute", budget: 500 });
            expect(exec.result.materialized).toBe(true);
            expect(head(exec.messages)).not.toBe(head(defer.messages));
        });

        it("holds a queued ctx_reduce drop on an identical-bytes max_mutation_id HARD; the served bytes stay identical", async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = "ses-identical-epoch-drain";
            materializeBaseline(sessionId);
            const defer = await pass(sessionId);
            const target = toolTag(sessionId, "c-mid", "m-mid");
            queuePendingOp(db, sessionId, target, "drop");
            // A queued drop alone never busts: the next defer pass holds it.
            const held = await pass(sessionId);
            expect(sha(held.messages)).toBe(sha(defer.messages));

            await bumpStructuralMutation();
            const hard = await pass(sessionId, { turn: "turn-epoch" });
            expect(hard.result.materialized).toBe(true);
            expect(head(hard.messages)).toBe(head(defer.messages));
            // The fold reproduced the served pair, so nothing may change the wire.
            expect(statusOf(sessionId, target)).toBe("active");
            expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toEqual([target]);
            expect(sha(hard.messages)).toBe(sha(defer.messages));

            // The pass after it is a plain defer and replays the same bytes.
            const after = await pass(sessionId);
            expect(after.result.materialized).toBe(false);
            expect(sha(after.messages)).toBe(sha(defer.messages));
        });

        it("holds age reclaim on an identical-bytes max_mutation_id HARD; the served bytes stay identical", async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = "ses-identical-mutation-reclaim";
            materializeBaseline(sessionId);
            const defer = await pass(sessionId);
            const old = toolTag(sessionId, "c-old", "m-old");
            const mid = toolTag(sessionId, "c-mid", "m-mid");
            advanceToolReclaimWatermark(db, sessionId, mid);

            queueM0Mutation(db, { sessionId, mutationType: "compartment_delete" });
            const hard = await pass(sessionId, { turn: "turn-mutation" });
            expect(hard.result.materialized).toBe(true);
            expect(hard.result.materializeReason).toBe("max_mutation_id");
            expect(statusOf(sessionId, old)).toBe("active");
            expect(statusOf(sessionId, mid)).toBe("active");
            expect(sha(hard.messages)).toBe(sha(defer.messages));

            const after = await pass(sessionId);
            expect(sha(after.messages)).toBe(sha(defer.messages));
        });

        it("still drains on a provider-dead model change even though m[0]/m[1] re-render identically", async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = "ses-identical-model-drain";
            materializeBaseline(sessionId);
            const defer = await pass(sessionId);
            const target = toolTag(sessionId, "c-mid", "m-mid");
            queuePendingOp(db, sessionId, target, "drop");
            const hardSignals = { ...BASE_HARD, modelKey: "anthropic/sonnet" };
            const hard = await pass(sessionId, { hard: hardSignals, turn: "turn-model" });
            expect(hard.result.materialized).toBe(true);
            expect(head(hard.messages)).toBe(head(defer.messages));
            expect(statusOf(sessionId, target)).toBe("dropped");
            expect(sha(hard.messages)).not.toBe(sha(defer.messages));

            // The priced pass and the defer pass after it serve the same prefix.
            const after = await pass(sessionId, { hard: hardSignals, newer: 1 });
            expect(after.result.materialized).toBe(false);
            expect(sha(after.messages.slice(0, hard.messages.length))).toBe(sha(hard.messages));
        });

        it("still drains on a max_mutation_id HARD that changes m[0]", async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = "ses-changed-epoch-drain";
            materializeBaseline(sessionId);
            const defer = await pass(sessionId);
            const target = toolTag(sessionId, "c-mid", "m-mid");
            queuePendingOp(db, sessionId, target, "drop");
            const { insertMemory } = await import(
                "../../features/magic-context/memory/storage-memory"
            );
            insertMemory(db, {
                projectPath: FOLD_PROJECT,
                category: "PROJECT_RULES",
                content: "EPOCH_CONTENT_CHANGE: new rule.",
                importance: 50,
            });
            await bumpStructuralMutation();
            const hard = await pass(sessionId, { turn: "turn-epoch-changed" });
            expect(hard.result.materialized).toBe(true);
            expect(hard.result.materializeReason).toBe("max_mutation_id");
            expect(head(hard.messages)).not.toBe(head(defer.messages));
            expect(statusOf(sessionId, target)).toBe("dropped");

            const after = await pass(sessionId, { newer: 1 });
            expect(after.result.materialized).toBe(false);
            expect(sha(after.messages.slice(0, hard.messages.length))).toBe(sha(hard.messages));
        });
    });

    // Adversarial gate reproductions for the shared fold bust permission. Each case
    // records what the lanes did so the gate report can quote executed evidence.
    describe("ADV gate: identical-bytes HARD lane permission", () => {
        const sha = (messages: MessageLike[]) =>
            createHash("sha256").update(JSON.stringify(messages)).digest("hex");
        const head = (messages: MessageLike[]) => JSON.stringify(messages.slice(0, 2));

        function tail(sessionId: string, newer = 0): MessageLike[] {
            const tool = (id: string, callID: string, input: unknown, output: string) => ({
                info: { id, role: "assistant", sessionID: sessionId },
                parts: [
                    {
                        type: "tool",
                        tool: "bash",
                        callID,
                        state: { status: "completed", input, output },
                    },
                ],
            });
            const user = (id: string, text: string) => ({
                info: { id, role: "user", sessionID: sessionId },
                parts: [{ type: "text", text }],
            });
            return [
                user("m-u0", "start"),
                tool("m-old", "c-old", { command: "cat big" }, "O".repeat(3000)),
                tool("m-mid", "c-mid", { command: "cat mid" }, "M".repeat(3000)),
                tool("m-new", "c-new", { command: "ls" }, "new output"),
                user("m-next", "next prompt"),
                ...Array.from({ length: newer }, (_, i) => user(`m-newer-${i}`, `newer ${i}`)),
            ] as unknown as MessageLike[];
        }

        async function pass(
            sessionId: string,
            opts: {
                hard?: M0HardSignals;
                newer?: number;
                scheduler?: "defer" | "execute";
                pct?: number;
                flush?: boolean;
                turn?: string;
                mural?: boolean;
                // Serve the pass from a session state that never loaded the
                // persisted mural image (the field is undefined, not null).
                leanMural?: boolean;
            } = {},
        ) {
            const messages = tail(sessionId, opts.newer ?? 0);
            const tagger = createTagger();
            tagger.initFromDb(sessionId, db);
            const tagged = tagMessages(sessionId, messages, tagger, db);
            const replayed = applyFlushedStatuses(sessionId, db, tagged.targets);
            tagged.batch.finalize();
            const pct = opts.pct ?? 40;
            const result = await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    tagger,
                    tags: getActiveTagsBySession(db, sessionId),
                    targets: tagged.targets,
                    reasoningByMessage: tagged.reasoningByMessage,
                    messageTagNumbers: tagged.messageTagNumbers,
                    batch: tagged.batch,
                    didMutateFromFlushedStatuses: replayed,
                    schedulerDecision: opts.scheduler ?? "defer",
                    currentTurnId: opts.turn ?? null,
                    contextUsage: { percentage: pct, inputTokens: pct * 100 },
                    pendingMaterializationSessions: opts.flush ? new Set([sessionId]) : new Set(),
                    ...(opts.leanMural
                        ? {
                              sessionMeta: {
                                  ...getOrCreateSessionMeta(db, sessionId),
                                  cachedM0MuralDataUrl: undefined,
                              } as never,
                          }
                        : {}),
                    m0M1: {
                        projectPath: FOLD_PROJECT,
                        projectDirectory: FOLD_PROJECT,
                        historyBudgetTokens: 98_000,
                        hardSignals: opts.hard ?? BASE_HARD,
                        ...(opts.mural
                            ? { muralEnabled: true, memoryInjectionBudgetTokens: 400 }
                            : {}),
                    },
                }),
            );
            return { messages, result };
        }

        // Re-gate: an identical-bytes structural HARD on a session that serves a mural
        // image. The fold re-renders the same text and the same image, so the
        // queued drop must stay held. The lean variant starts the pass from a
        // state whose mural field was never loaded (undefined rather than null):
        // the pre-fold snapshot must load the persisted image first, or it reads
        // the missing field as "no image served" and the unchanged image counts
        // as a change.
        for (const lean of [false, true]) {
            it(`REGATE mural unchanged (${lean ? "lean" : "hydrated"} state): an identical-bytes structural HARD holds the drop`, async () => {
                const xdg = createTestTempDirFromPath(join(tmpdir(), "mc-regate-oc-mural-"));
                tempDirs.push(xdg);
                process.env.XDG_DATA_HOME = xdg;
                const modelsDev = await import("../../shared/models-dev-cache");
                modelsDev.clearModelsDevCache();
                try {
                    await modelsDev.refreshModelLimitsFromApi({
                        config: {
                            providers: async () => ({
                                data: {
                                    providers: [
                                        {
                                            id: "anthropic",
                                            models: {
                                                opus: {
                                                    limit: { context: 200_000, input: 200_000 },
                                                    modalities: { input: ["text", "image"] },
                                                },
                                            },
                                        },
                                    ],
                                },
                            }),
                        },
                    } as never);
                    db = new Database(":memory:");
                    initializeDatabase(db);
                    (await import("../../features/magic-context/migrations")).runMigrations(db);
                    const sessionId = `ses-regate-oc-mural-${lean ? "lean" : "hydrated"}`;
                    materializeBaseline(sessionId);
                    const { insertMemory } = await import(
                        "../../features/magic-context/memory/storage-memory"
                    );
                    const cues = await import(
                        "../../features/magic-context/mural/storage-mural-cues"
                    );
                    for (let i = 0; i < 24; i++) {
                        const content = `REGATE_MURAL_MEMORY_${i}: ${"rule text ".repeat(20)}`;
                        const memory = insertMemory(db, {
                            projectPath: FOLD_PROJECT,
                            category: "PROJECT_RULES",
                            content,
                            importance: 50,
                        });
                        db.prepare(
                            "UPDATE memories SET mural_cue = ?, mural_cue_hash = ? WHERE id = ?",
                        ).run(`cue-${i}`, cues.computeCueContentHash(content), memory.id);
                    }
                    await bumpStructuralMutation();
                    await pass(sessionId, { mural: true });
                    const defer = await pass(sessionId, { mural: true });
                    const muralA = getOrCreateSessionMeta(db, sessionId).cachedM0MuralDataUrl;
                    const target = toolTag(sessionId, "c-mid", "m-mid");
                    queuePendingOp(db, sessionId, target, "drop");
                    await bumpStructuralMutation();
                    const hard = await pass(sessionId, { mural: true, leanMural: lean });
                    const muralB = getOrCreateSessionMeta(db, sessionId).cachedM0MuralDataUrl;
                    const after = await pass(sessionId, { mural: true });
                    console.log(
                        `REGATE_OC_MURAL lean=${lean} reason=${hard.result.materializeReason} materialized=${hard.result.materialized} muralPresent=${muralA !== null} muralChanged=${muralA !== muralB} headIdentical=${head(hard.messages) === head(defer.messages)} wireIdentical=${sha(hard.messages) === sha(defer.messages)} status=${statusOf(sessionId, target)} afterEqualsDefer=${sha(after.messages) === sha(defer.messages)}`,
                    );
                    expect(muralA).not.toBeNull();
                    expect(muralB).toBe(muralA);
                    expect(hard.result.materialized).toBe(true);
                    expect(head(hard.messages)).toBe(head(defer.messages));
                    expect(statusOf(sessionId, target)).toBe("active");
                    expect(sha(hard.messages)).toBe(sha(defer.messages));
                    expect(sha(after.messages)).toBe(sha(defer.messages));
                } finally {
                    modelsDev.clearModelsDevCache();
                }
            });
        }

        function toolTag(sessionId: string, callID: string, owner: string): number {
            const tagger = createTagger();
            tagger.initFromDb(sessionId, db);
            const tag = tagger.getToolTag(sessionId, callID, owner);
            if (tag === undefined || tag === null) throw new Error(`no tag for ${callID}`);
            return tag;
        }
        const statusOf = (sessionId: string, tag: number) =>
            getTagsBySession(db, sessionId).find((row) => row.tagNumber === tag)?.status;

        it("mural-only change: an OpenCode HARD that swaps only the mural image opens the lanes", async () => {
            const xdg = createTestTempDirFromPath(join(tmpdir(), "mc-adv-oc-mural-"));
            tempDirs.push(xdg);
            process.env.XDG_DATA_HOME = xdg;
            const modelsDev = await import("../../shared/models-dev-cache");
            modelsDev.clearModelsDevCache();
            try {
                await modelsDev.refreshModelLimitsFromApi({
                    config: {
                        providers: async () => ({
                            data: {
                                providers: [
                                    {
                                        id: "anthropic",
                                        models: {
                                            opus: {
                                                limit: { context: 200_000, input: 200_000 },
                                                modalities: { input: ["text", "image"] },
                                            },
                                        },
                                    },
                                ],
                            },
                        }),
                    },
                } as never);
                db = new Database(":memory:");
                initializeDatabase(db);
                // The mural manifest and cue columns come from the migrations.
                (await import("../../features/magic-context/migrations")).runMigrations(db);
                const sessionId = "ses-adv-oc-mural-only";
                materializeBaseline(sessionId);
                const { insertMemory } = await import(
                    "../../features/magic-context/memory/storage-memory"
                );
                const cues = await import("../../features/magic-context/mural/storage-mural-cues");
                // This in-memory schema has no privileged-writer table, so write the
                // derived cue columns directly (the same columns setMuralCue writes).
                const setCue = (id: number, cue: string, hash: string) =>
                    db
                        .prepare(
                            "UPDATE memories SET mural_cue = ?, mural_cue_hash = ? WHERE id = ?",
                        )
                        .run(cue, hash, id);
                for (let i = 0; i < 24; i++) {
                    const content = `ADV_MURAL_MEMORY_${i}: ${"rule text ".repeat(20)}`;
                    const memory = insertMemory(db, {
                        projectPath: FOLD_PROJECT,
                        category: "PROJECT_RULES",
                        content,
                        importance: 50,
                    });
                    setCue(memory.id, `cue-a-${i}`, cues.computeCueContentHash(content));
                }
                await bumpStructuralMutation();
                await pass(sessionId, { mural: true });
                const withMural = await pass(sessionId, { mural: true });
                const muralA = getOrCreateSessionMeta(db, sessionId).cachedM0MuralDataUrl;
                console.log(
                    `ADV_OC_MURAL_DEBUG vision=${(await import("../../features/magic-context/mural/render-trigger")).modelKeyAcceptsImages("anthropic/opus")} upgrade=${getOrCreateSessionMeta(db, sessionId).cachedM0UpgradeState} withMuralReason=${withMural.result.materializeReason} manifest=${JSON.stringify(db.prepare("SELECT project_path, length(image) AS n FROM mural_manifest").all())} cued=${JSON.stringify(db.prepare("SELECT count(*) AS c FROM memories WHERE mural_cue IS NOT NULL").get())}`,
                );
                const target = toolTag(sessionId, "c-mid", "m-mid");
                queuePendingOp(db, sessionId, target, "drop");
                const rows = db
                    .prepare("SELECT id, content FROM memories WHERE project_path = ?")
                    .all(FOLD_PROJECT) as Array<{ id: number; content: string }>;
                for (const row of rows) {
                    setCue(row.id, `cue-b-${row.id}`, cues.computeCueContentHash(row.content));
                }
                queueM0Mutation(db, { sessionId, mutationType: "compartment_delete" });
                const hard = await pass(sessionId, { mural: true });
                const muralB = getOrCreateSessionMeta(db, sessionId).cachedM0MuralDataUrl;
                console.log(
                    `ADV_OC_MURAL_ONLY reason=${hard.result.materializeReason} muralPresent=${muralA !== null} muralChanged=${muralA !== muralB} headTextIdentical=${head(hard.messages) === head(withMural.messages)} status=${statusOf(sessionId, target)}`,
                );
                expect(muralA).not.toBeNull();
                expect(muralA).not.toBe(muralB);
                expect(statusOf(sessionId, target)).toBe("dropped");
            } finally {
                modelsDev.clearModelsDevCache();
            }
        });
        const bumpStructuralMutation = async () => {
            for (const row of db.prepare("SELECT session_id FROM session_meta").all() as Array<{
                session_id: string;
            }>)
                queueM0Mutation(db, {
                    sessionId: row.session_id,
                    mutationType: "compartment_delete",
                });
        };

        // Baseline, then a queued drop, then an identical-bytes structural HARD that
        // must hold the drop. Returns the pre-HARD defer bytes and the target.
        async function heldAfterIdenticalHard(sessionId: string) {
            db = new Database(":memory:");
            initializeDatabase(db);
            materializeBaseline(sessionId);
            const defer = await pass(sessionId);
            const target = toolTag(sessionId, "c-mid", "m-mid");
            queuePendingOp(db, sessionId, target, "drop");
            await bumpStructuralMutation();
            const hard = await pass(sessionId, { turn: "t-hard" });
            expect(hard.result.materialized).toBe(true);
            expect(hard.result.materializeReason).toBe("max_mutation_id");
            expect(head(hard.messages)).toBe(head(defer.messages));
            expect(statusOf(sessionId, target)).toBe("active");
            expect(sha(hard.messages)).toBe(sha(defer.messages));
            const d1 = await pass(sessionId);
            const d2 = await pass(sessionId);
            expect(sha(d1.messages)).toBe(sha(defer.messages));
            expect(sha(d2.messages)).toBe(sha(defer.messages));
            expect(statusOf(sessionId, target)).toBe("active");
            return { defer, target };
        }

        it("starvation: a held drop lands on the next execute pass that publishes m[1]; the defer after replays it", async () => {
            const sessionId = "ses-adv-starve-execute";
            const { defer, target } = await heldAfterIdenticalHard(sessionId);
            // This session's own agent save surfaces through m[1] on the next execute
            // pass, which is the published-history bust queued drops wait for.
            const { applyMemoryAdmission } = await import(
                "../../features/magic-context/memory/lifecycle-applier"
            );
            applyMemoryAdmission(db, {
                key: "adv-execute-publish",
                operation: "agent_save",
                input: {
                    projectPath: FOLD_PROJECT,
                    category: "PROJECT_RULES",
                    content: "ADV_EXECUTE_PUBLISH: new rule.",
                    importance: 50,
                    sourceSessionId: sessionId,
                    sourceType: "agent",
                },
            });
            const exec = await pass(sessionId, { scheduler: "execute", turn: "t-exec" });
            console.log(
                `ADV_EXEC materialized=${exec.result.materialized} reason=${exec.result.materializeReason} status=${statusOf(sessionId, target)} pending=${getPendingOps(db, sessionId).length} changed=${sha(exec.messages) !== sha(defer.messages)}`,
            );
            expect(statusOf(sessionId, target)).toBe("dropped");
            expect(getPendingOps(db, sessionId)).toHaveLength(0);
            expect(sha(exec.messages)).not.toBe(sha(defer.messages));
            const after = await pass(sessionId, { turn: "t-exec" });
            expect(sha(after.messages)).toBe(sha(exec.messages));
        });

        it("control: a queued drop on a plain execute pass with no HARD and no m[1] change", async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = "ses-adv-control-execute";
            materializeBaseline(sessionId);
            const defer = await pass(sessionId);
            const target = toolTag(sessionId, "c-mid", "m-mid");
            queuePendingOp(db, sessionId, target, "drop");
            const exec = await pass(sessionId, { scheduler: "execute", turn: "t-exec" });
            console.log(
                `ADV_CONTROL_EXEC materialized=${exec.result.materialized} status=${statusOf(sessionId, target)} changed=${sha(exec.messages) !== sha(defer.messages)}`,
            );
        });

        it("starvation: a held drop lands on the next explicit /ctx-flush pass", async () => {
            const sessionId = "ses-adv-starve-flush";
            const { defer, target } = await heldAfterIdenticalHard(sessionId);
            const flush = await pass(sessionId, { flush: true });
            expect(statusOf(sessionId, target)).toBe("dropped");
            expect(sha(flush.messages)).not.toBe(sha(defer.messages));
            const after = await pass(sessionId);
            expect(sha(after.messages)).toBe(sha(flush.messages));
        });

        it("starvation: a held drop lands when usage enters the >=85% force band", async () => {
            const sessionId = "ses-adv-starve-force";
            const { target } = await heldAfterIdenticalHard(sessionId);
            const force = await pass(sessionId, { pct: 86 });
            expect(statusOf(sessionId, target)).toBe("dropped");
            const after = await pass(sessionId, { pct: 86 });
            expect(sha(after.messages)).toBe(sha(force.messages));
        });

        it("starvation: a held drop lands on a later genuine HARD (model change)", async () => {
            const sessionId = "ses-adv-starve-model";
            const { target } = await heldAfterIdenticalHard(sessionId);
            const hardSignals = { ...BASE_HARD, modelKey: "anthropic/sonnet" };
            const hard = await pass(sessionId, { hard: hardSignals });
            expect(hard.result.materializeReason).toBe("model_change");
            expect(statusOf(sessionId, target)).toBe("dropped");
            const after = await pass(sessionId, { hard: hardSignals });
            expect(sha(after.messages)).toBe(sha(hard.messages));
        });

        for (const pct of [86, 96]) {
            it(`emergency: an identical-bytes HARD at ${pct}% still drains the queued drop on the same pass`, async () => {
                db = new Database(":memory:");
                initializeDatabase(db);
                const sessionId = `ses-adv-emergency-${pct}`;
                materializeBaseline(sessionId);
                await pass(sessionId);
                const target = toolTag(sessionId, "c-mid", "m-mid");
                queuePendingOp(db, sessionId, target, "drop");
                await bumpStructuralMutation();
                const hard = await pass(sessionId, { pct });
                expect(hard.result.materialized).toBe(true);
                expect(statusOf(sessionId, target)).toBe("dropped");
                const after = await pass(sessionId, { pct });
                expect(sha(after.messages)).toBe(sha(hard.messages));
            });
        }

        // Every cache-losing or byte-changing trigger must still open the lanes.
        const OPENING: Array<{
            reason: string;
            arm: (sessionId: string) => Promise<M0HardSignals | undefined>;
        }> = [
            { reason: "system_hash", arm: async () => ({ ...BASE_HARD, systemHash: "sys-v2" }) },
            {
                reason: "ttl_idle",
                arm: async () => ({
                    ...BASE_HARD,
                    cacheExpired: true,
                    lastResponseTime: Date.now() + 60_000,
                }),
            },
            {
                reason: "cached_m1_missing",
                arm: async (sessionId) => {
                    db.prepare(
                        "DELETE FROM session_render_cache WHERE cache_key = 'cached_m1_bytes' AND session_id = ?",
                    ).run(sessionId);
                    return undefined;
                },
            },
            {
                reason: "max_mutation_id",
                arm: async (sessionId) => {
                    appendCompartments(db, sessionId, [
                        {
                            sequence: 0,
                            startMessage: 1,
                            endMessage: 1,
                            startMessageId: "m-u0",
                            endMessageId: "m-u0",
                            title: "Real mutation",
                            content: "U: start (compartment the mutation log surfaces)",
                        },
                    ] as never);
                    db.prepare(
                        "UPDATE session_meta SET cached_m0_max_compartment_seq = 0 WHERE session_id = ?",
                    ).run(sessionId);
                    queueM0Mutation(db, { sessionId, mutationType: "compartment_upgrade" });
                    return undefined;
                },
            },
        ];
        for (const trigger of OPENING) {
            it(`${trigger.reason}: a HARD that busts still drains the queued drop on a defer pass`, async () => {
                db = new Database(":memory:");
                initializeDatabase(db);
                const sessionId = `ses-adv-open-${trigger.reason}`;
                materializeBaseline(sessionId);
                const defer = await pass(sessionId);
                const target = toolTag(sessionId, "c-mid", "m-mid");
                queuePendingOp(db, sessionId, target, "drop");
                const hardSignals = await trigger.arm(sessionId);
                const hard = await pass(sessionId, { hard: hardSignals });
                console.log(
                    `ADV_OPEN reason=${hard.result.materializeReason} materialized=${hard.result.materialized} headChanged=${head(hard.messages) !== head(defer.messages)} status=${statusOf(sessionId, target)}`,
                );
                expect(hard.result.materialized).toBe(true);
                expect(hard.result.materializeReason).toBe(trigger.reason);
                expect(statusOf(sessionId, target)).toBe("dropped");
                // A ttl_idle signal stays armed while cacheExpired is true, so the
                // follow-up pass uses the settled signals the provider would send.
                const after = await pass(sessionId, {
                    hard: trigger.reason === "ttl_idle" ? BASE_HARD : hardSignals,
                });
                console.log(
                    `ADV_OPEN_AFTER reason=${trigger.reason} afterMaterialized=${after.result.materialized} afterReason=${after.result.materializeReason} identical=${sha(after.messages) === sha(hard.messages)}`,
                );
                if (sha(after.messages) !== sha(hard.messages)) {
                    for (
                        let i = 0;
                        i < Math.max(after.messages.length, hard.messages.length);
                        i++
                    ) {
                        const a = JSON.stringify(hard.messages[i]);
                        const b = JSON.stringify(after.messages[i]);
                        if (a !== b)
                            console.log(
                                `ADV_DIFF idx=${i}\n HARD =${a?.slice(0, 600)}\n AFTER=${b?.slice(0, 600)}`,
                            );
                    }
                }
                expect(sha(after.messages)).toBe(sha(hard.messages));
            });
        }
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
                keepReasoningTokens: 0,
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
                pendingMaterializationSessions: new Set([sessionId]),
                contextUsage: { percentage: 60, inputTokens: 6000 },
                currentTurnId: "turn-clear-write-anthropic",
                resolvedProviderID: "anthropic",
                keepReasoningTokens: 0,
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

    it("leaves processed image file parts native for github-copilot on defer without frozen ids", async () => {
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
                pendingMaterializationSessions: new Set([sessionId]),
                contextUsage: { percentage: 60, inputTokens: 6000 },
                currentTurnId: "turn-img",
            }),
        );

        expect(userMessage.parts).toEqual([{ type: "text", text: "" }]);
        expect([...getProcessedImageStrippedIds(db, sessionId)]).toEqual(["m-image"]);
    });

    it("keeps processed image bytes stable after failed freeze persistence and retries only on a bust", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-anthropic-processed-image-persistence-failure";
        const nativeMessages: MessageLike[] = [
            {
                info: { id: "m-image", role: "user" },
                parts: [
                    {
                        type: "file",
                        mime: "image/png",
                        url: `data:image/png;base64,${"a".repeat(220)}`,
                    },
                ],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "text", text: "seen" }],
            },
        ] as unknown as MessageLike[];
        const runPass = async (bust: boolean, turn: string) => {
            const messages = cloneMessages(nativeMessages);
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    watermark: 1,
                    messageTagNumbers: new Map([[messages[0], 1]]),
                    resolvedProviderID: "anthropic",
                    schedulerDecision: bust ? "execute" : "defer",
                    pendingMaterializationSessions: new Set(bust ? [sessionId] : []),
                    contextUsage: { percentage: 60, inputTokens: 6000 },
                    currentTurnId: turn,
                }),
            );
            return messages;
        };

        const persist = spyOn(replayStorage, "addProcessedImageStrippedIds").mockReturnValue(false);
        let first: MessageLike[];
        let deferred: MessageLike[];
        try {
            first = await runPass(true, "turn-img-failed");
            expect(persist).toHaveBeenCalledTimes(1);
            expect([...getProcessedImageStrippedIds(db, sessionId)]).toEqual([]);
            deferred = await runPass(false, "turn-img-deferred");
            expect(persist).toHaveBeenCalledTimes(1);
        } finally {
            persist.mockRestore();
        }
        expect(JSON.stringify(deferred[0].parts)).toBe(JSON.stringify(first[0].parts));
        expect(first[0].parts).toEqual(nativeMessages[0].parts);

        const retried = await runPass(true, "turn-img-retry");
        expect(retried[0].parts).toEqual([{ type: "text", text: "" }]);
        expect([...getProcessedImageStrippedIds(db, sessionId)]).toEqual(["m-image"]);
        const replayed = await runPass(false, "turn-img-replay");
        expect(JSON.stringify(replayed[0].parts)).toBe(JSON.stringify(retried[0].parts));
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
                pendingMaterializationSessions: new Set([sessionId]),
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
                pendingMaterializationSessions: new Set([sessionId]),
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
                pendingMaterializationSessions: new Set([sessionId]),
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
            flagTarget: "all_reasoning_bearing_assistants",
            messageIds: ["assistant-bound"],
        });
        expect(findMessage(recoveryMessages, "assistant-bound").parts[0]).toEqual({
            type: "text",
            text: "",
        });
        // Postprocessing does not consume the recovery flag. Only a successful live
        // transform clears it, so a last-known-good fallback cannot clear recovery
        // for an output that was not successfully transformed.
        expect(getThinkingBindingRecoveryTarget(db, sessionId)).toBe(
            "all_reasoning_bearing_assistants",
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
            flagTarget: "all_reasoning_bearing_assistants",
            messageIds: ["assistant-bound"],
        });
        expect(findMessage(recoveryMessages, "assistant-bound").parts[0]).toEqual({
            type: "text",
            text: "",
        });
        expect(getThinkingBindingRecoveryTarget(db, sessionId)).toBe(
            "all_reasoning_bearing_assistants",
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

    // Anthropic invalidates every signed thinking block after the first changed
    // position, and its 400 names only a wire path, never a host message id. The
    // fixture models three reasoning-bearing assistants whose blocks all became
    // invalid after one prefix edit; the newest one is an open tool round whose
    // tool_result the model has not answered yet.
    const buildBoundMultiAssistantSession = (sessionId: string): MessageLike[] =>
        [
            {
                info: { id: "user-prefix", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "re-rendered first user message" }],
            },
            {
                info: { id: "assistant-one", role: "assistant", sessionID: sessionId },
                parts: [
                    { type: "thinking", thinking: "bound one", signature: "sig-one" },
                    { type: "text", text: "answer one" },
                ],
            },
            {
                info: { id: "user-two", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "second question" }],
            },
            {
                info: { id: "assistant-two", role: "assistant", sessionID: sessionId },
                parts: [
                    {
                        type: "reasoning",
                        text: "bound two",
                        metadata: { anthropic: { signature: "sig-two" } },
                    },
                    { type: "text", text: "answer two" },
                ],
            },
            {
                info: { id: "user-three", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "run the tool" }],
            },
            {
                info: { id: "assistant-open-tool", role: "assistant", sessionID: sessionId },
                parts: [
                    { type: "thinking", thinking: "bound three", signature: "sig-three" },
                    {
                        type: "tool",
                        callID: "call-open",
                        tool: "bash",
                        state: { status: "completed", input: {}, output: "tool output" },
                    },
                ],
            },
        ] as unknown as MessageLike[];
    const BOUND_ASSISTANT_IDS = ["assistant-one", "assistant-two", "assistant-open-tool"];
    const REASONING_TYPES = new Set(["thinking", "reasoning", "redacted_thinking"]);
    // Stand-in for Anthropic's prefix check on an enforced account: the request
    // is rejected while any block signed against the old prefix is still sent.
    const anthropicRejectsForBinding = (messages: MessageLike[]): boolean =>
        messages.some(
            (message) =>
                BOUND_ASSISTANT_IDS.includes(String(message.info.id)) &&
                message.parts.some(
                    (part) =>
                        part !== null &&
                        typeof part === "object" &&
                        REASONING_TYPES.has(String((part as { type?: unknown }).type)),
                ),
        );

    it("converges after exactly one binding failure by stripping every reasoning-bearing assistant", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-binding-converges-once";
        let failures = 0;
        let acceptedWire: MessageLike[] | null = null;
        for (let attempt = 0; attempt < 6; attempt += 1) {
            const wire = buildBoundMultiAssistantSession(sessionId);
            const result = await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, wire, {
                    schedulerDecision: "defer",
                    resolvedProviderID: "anthropic",
                    thinkingBindingRecoveryEnabledForModel: true,
                }),
            );
            if (result.thinkingBindingRecovery) {
                clearThinkingBindingRecoveryIf(
                    db,
                    sessionId,
                    result.thinkingBindingRecovery.flagTarget,
                );
            }
            if (!anthropicRejectsForBinding(wire)) {
                acceptedWire = wire;
                break;
            }
            failures += 1;
            armThinkingBindingRecovery(db, sessionId);
        }

        expect(failures).toBe(1);
        if (!acceptedWire) throw new Error("recovery never produced an accepted request");
        // The open tool round loses its invalid thinking too; its tool call stays.
        const openTool = findMessage(acceptedWire, "assistant-open-tool");
        expect(openTool.parts[0]).toEqual({ type: "text", text: "" });
        expect(openTool.parts[1]).toMatchObject({ type: "tool", callID: "call-open" });
        expect(getThinkingBindingRecoveryTarget(db, sessionId)).toBeNull();
    });

    it("replays an all-assistant binding recovery byte-identically and never restores a stripped block", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-binding-all-replay";
        armThinkingBindingRecovery(db, sessionId);
        const armedTarget = getThinkingBindingRecoveryTarget(db, sessionId);
        const recoveryWire = buildBoundMultiAssistantSession(sessionId);
        const recovery = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, recoveryWire, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
                thinkingBindingRecoveryEnabledForModel: true,
            }),
        );
        expect(recovery.thinkingBindingRecovery).toEqual({
            flagTarget: armedTarget,
            messageIds: BOUND_ASSISTANT_IDS,
        });
        expect(anthropicRejectsForBinding(recoveryWire)).toBe(false);
        clearThinkingBindingRecoveryIf(db, sessionId, recovery.thinkingBindingRecovery.flagTarget);

        const replayWire = buildBoundMultiAssistantSession(sessionId);
        const replay = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, replayWire, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
                thinkingBindingRecoveryEnabledForModel: true,
            }),
        );
        expect(replay.thinkingBindingRecovery).toBeNull();
        expect(JSON.stringify(replayWire)).toBe(JSON.stringify(recoveryWire));

        // A block produced after the recovery was signed against the edited
        // prefix, so it stays; the recovered blocks stay out.
        const laterWire = [
            ...buildBoundMultiAssistantSession(sessionId),
            {
                info: { id: "user-four", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "next" }],
            },
            {
                info: { id: "assistant-fresh", role: "assistant", sessionID: sessionId },
                parts: [
                    { type: "thinking", thinking: "fresh", signature: "sig-fresh" },
                    { type: "text", text: "fresh answer" },
                ],
            },
        ] as unknown as MessageLike[];
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, laterWire, {
                schedulerDecision: "defer",
                resolvedProviderID: "anthropic",
                thinkingBindingRecoveryEnabledForModel: true,
            }),
        );
        expect(JSON.stringify(laterWire.slice(0, recoveryWire.length))).toBe(
            JSON.stringify(recoveryWire),
        );
        expect(thinkingParts(findMessage(laterWire, "assistant-fresh"))).toHaveLength(1);
    });

    it("converges after exactly one binding failure through Rust-mode host postprocess", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-binding-converges-once-rust";
        let failures = 0;
        let accepted = false;
        let replayBytes: string | null = null;
        for (let attempt = 0; attempt < 6; attempt += 1) {
            const wire = buildBoundMultiAssistantSession(sessionId);
            const result = runRustModePostprocess({
                db,
                sessionId,
                messages: wire,
                fullFeatureMode: true,
                resolvedProviderID: "anthropic",
                thinkingBindingRecoveryEnabledForModel: true,
                tagger: createTagger(),
                ctxReduceAvailability: { callable: true, frozen: true },
            });
            if (result.thinkingBindingRecovery) {
                clearThinkingBindingRecoveryIf(
                    db,
                    sessionId,
                    result.thinkingBindingRecovery.flagTarget,
                );
            }
            if (!anthropicRejectsForBinding(wire)) {
                accepted = true;
                replayBytes = JSON.stringify(wire);
                break;
            }
            failures += 1;
            armThinkingBindingRecovery(db, sessionId);
        }
        expect(failures).toBe(1);
        expect(accepted).toBe(true);

        // The Rust last-known-good replay path applies the same persisted set.
        const lkgReplay = buildBoundMultiAssistantSession(sessionId);
        replayRustModeBindingMismatchStrips({
            db,
            sessionId,
            messages: lkgReplay,
            resolvedProviderID: "anthropic",
        });
        expect(JSON.stringify(lkgReplay)).toBe(replayBytes);
    });

    it("supported false permission captures the newest-tail decision while unsupported permission holds it", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        for (const permission of [false, undefined, null, "true", 1, {}]) {
            const sessionId = `ses-newest-tail-${String(permission)}`;
            const messages = [
                {
                    info: { id: "newest", role: "assistant", sessionID: sessionId },
                    parts: [{ type: "text", text: "already served tail" }],
                },
            ] as MessageLike[];
            runRustModePostprocess({
                db,
                sessionId,
                messages,
                cacheBustingPass: false,
                prefixPermissionSupported: typeof permission === "boolean",
                fullFeatureMode: true,
                resolvedProviderID: "anthropic",
                trailingBlankSourceDecisions: new Map([["newest", "strip"]]),
                trailingBlankNewestAssistantId: "newest",
                tagger: createTagger(),
                ctxReduceAvailability: { callable: false, frozen: true },
            });
            expect(getTrailingBlankDecisions(db, sessionId).get("newest")).toBe(
                permission === false ? "strip" : undefined,
            );
            expect(messages[0]!.parts).toEqual([{ type: "text", text: "already served tail" }]);
        }
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

    // Holding the merged-reasoning strip behind kept current-turn thinking applies
    // only when that thinking is bound to the bytes before it. Other Anthropic
    // models report the same thinking boundary but hold no edit behind it, so
    // their merged-reasoning strip still lands on a busting pass, as before.
    it("a non-prefix-bound model keeps its merged-reasoning strip while current-turn thinking is kept", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-merged-reasoning-not-prefix-bound";
        const messages = [
            { info: { id: "user-old", role: "user" }, parts: [{ type: "text", text: "start" }] },
            {
                info: { id: "assistant-first", role: "assistant" },
                parts: [{ type: "text", text: "first assistant content" }],
            },
            {
                info: { id: "assistant-merged", role: "assistant" },
                parts: [
                    { type: "thinking", thinking: "merged reasoning", signature: "merged-sig" },
                    { type: "text", text: "tool-use continuation" },
                ],
            },
            { info: { id: "user", role: "user" }, parts: [{ type: "text", text: "continue" }] },
            {
                info: { id: "assistant-current", role: "assistant" },
                parts: [
                    { type: "thinking", thinking: "current reasoning", signature: "current-sig" },
                    { type: "text", text: "current step" },
                ],
            },
        ] as unknown as MessageLike[];
        const current = JSON.stringify(findMessage(messages, "assistant-current").parts);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "execute",
                pendingMaterializationSessions: new Set([sessionId]),
                resolvedProviderID: "anthropic",
                resolvedModelID: "claude-opus-4-6",
                thinkingBindingRecoveryEnabledForModel: false,
                signedThinkingHold: "on",
                activeThinkingTurn: true,
            }),
        );
        expect(findMessage(messages, "assistant-merged").parts[0]).toEqual({
            type: "text",
            text: "",
        });
        expect(getMergedReasoningStrippedIds(db, sessionId).has("assistant-merged")).toBe(true);
        expect(JSON.stringify(findMessage(messages, "assistant-current").parts)).toBe(current);
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

        // This explicit flush performs the first strip and persists it in the same pass.
        const bustMessages = buildMessages(true);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, bustMessages, {
                schedulerDecision: "execute",
                pendingMaterializationSessions: new Set([sessionId]),
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
                pendingMaterializationSessions: new Set([sessionId]),
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
                    pendingMaterializationSessions: new Set([sessionId]),
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
                pendingMaterializationSessions: new Set([sessionId]),
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
                pendingMaterializationSessions: new Set([sessionId]),
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
                pendingMaterializationSessions: new Set([sessionId]),
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

    it("refuses when a live trailing-blank refresh loses its persistence race", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-trailing-refresh-cas-failure";
        addTrailingBlankDecisions(db, sessionId, [["assistant-target", "keep:3"]]);
        // Each decision is its own row, updated only while it still holds the value
        // the writer read. Ignoring the update leaves zero changed rows, which the
        // writer treats as a lost race on every retry.
        db.exec(`
            CREATE TRIGGER reject_trailing_blank_refresh
            BEFORE UPDATE ON session_replay_decisions
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

        await expect(
            runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    schedulerDecision: "defer",
                    resolvedProviderID: "anthropic",
                }),
            ),
        ).rejects.toMatchObject({
            name: "DegradedPassRefusalError",
            site: "trailing-blank-decision-persistence-failure",
        });
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
            // These are todo rendering tests: execute represents an explicit bust.
            pendingMaterializationSessions:
                args.schedulerDecision === "execute" ? new Set([args.sessionId]) : new Set(),
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
                readLastServedMessages: () => source(),
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

it("age and heuristic candidates alone at 75 percent cannot originate a bust", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "ses-age-ride-only";
    const messages = [makeToolMessage("old-a"), makeToolMessage("old-b")];
    const targets = new Map<number, TagTarget>();
    for (let index = 0; index < messages.length; index++) {
        insertTag(
            db,
            sessionId,
            `old-${index}`,
            "tool",
            4000,
            index + 1,
            0,
            "bash",
            0,
            `old-owner-${index}`,
            null,
            { tokenCount: 1000, inputTokenCount: 0, reasoningTokenCount: 0 },
        );
        targets.set(index + 1, makeDropTarget(messages[index]!));
    }
    padRecentToolSkeletonWindow(sessionId, 2);
    advanceToolReclaimWatermark(db, sessionId, 2);
    const before = JSON.stringify(messages);
    const result = await runPostTransformPhase(
        basePostTransformArgs(db, sessionId, messages, {
            schedulerDecision: "execute",
            contextUsage: { percentage: 75.02, inputTokens: 654172 },
            // Replaying a previously frozen drop is not an independent new bust.
            didMutateFromFlushedStatuses: true,
            tags: getActiveTagsBySession(db, sessionId),
            targets,
            sessionMeta: getOrCreateSessionMeta(db, sessionId),
        }),
    );
    expect(JSON.stringify(messages)).toBe(before);
    expect(result.bustedThisPass).toBe(false);
    expect(result.droppedTokens).toBe(0);
    expect(
        getTagsBySession(db, sessionId)
            .filter((t) => t.tagNumber <= 2)
            .every((t) => t.status === "active"),
    ).toBe(true);
});

describe("prefix preflight persistence pins", () => {
    it.each([
        "cached",
        "fresh",
        "partial",
        "force",
    ])("%s contention fallback follows cached replay or unavoidable bust", async (cacheShape) => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = `ses-preflight-${cacheShape}`;
        const projectPath = "git:preflight-pin";
        appendCompartments(db, sessionId, [
            {
                sequence: 1,
                startMessage: 1,
                endMessage: 1,
                startMessageId: "covered",
                endMessageId: "covered",
                title: "Published",
                content: "Published history",
            },
        ]);
        const state = getOrCreateSessionMeta(db, sessionId);
        const m0M1 = { projectPath, projectDirectory: "/nonexistent" };
        if (cacheShape === "cached" || cacheShape === "force")
            injectM0M1({ db, sessionId, state, ...m0M1 });
        if (cacheShape === "force")
            appendCompartments(db, sessionId, [
                {
                    sequence: 2,
                    startMessage: 2,
                    endMessage: 2,
                    startMessageId: "new-covered",
                    endMessageId: "new-covered",
                    title: "FORCE_FRESH",
                    content: "FORCE_FRESH",
                },
            ]);
        if (cacheShape === "partial")
            state.cachedM0Bytes = Buffer.from("<session-history>partial</session-history>");
        queueM0Mutation(db, { sessionId, mutationType: "compartment_merge" });
        const message = makeToolMessage("old-tool");
        insertTag(db, sessionId, "old-tool", "tool", 4000, 1, 0, "bash", 0, "old-owner", null, {
            tokenCount: 1000,
            inputTokenCount: 0,
            reasoningTokenCount: 0,
        });
        padRecentToolSkeletonWindow(sessionId, 1);
        advanceToolReclaimWatermark(db, sessionId, 1);
        state.toolReclaimWatermark = 1;
        if (cacheShape === "cached" || cacheShape === "force")
            queuePendingOp(db, sessionId, 1, "drop");
        const served: compartmentInjection.InjectM0M1Result[] = [];
        const original = compartmentInjection.injectM0M1;
        const injection = spyOn(compartmentInjection, "injectM0M1").mockImplementation(
            (options) => {
                const result = original({
                    ...options,
                    beforePhase3ForTest: () => {
                        queueM0Mutation(db, { sessionId, mutationType: "compartment_merge" });
                    },
                });
                served.push(result);
                return result;
            },
        );
        try {
            const messages = [message];
            const result = await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    contextUsage: {
                        percentage: cacheShape === "force" ? 90 : 20,
                        inputTokens: 1000,
                    },
                    sessionMeta: state,
                    m0M1,
                    targets: new Map([[1, makeDropTarget(message)]]),
                    tags: getActiveTagsBySession(db, sessionId),
                    pendingCompartmentInjection:
                        cacheShape === "cached"
                            ? null
                            : {
                                  block: "published",
                                  compartmentEndMessage: 1,
                                  compartmentEndMessageId: "covered",
                                  compartmentCount: 1,
                                  skippedVisibleMessages: 0,
                                  factCount: 0,
                                  memoryCount: 0,
                                  rebuiltFromDb: true,
                              },
                    rebuiltHistoryFromInitialPrepare: cacheShape !== "cached",
                }),
            );
            expect(served).toHaveLength(2);
            expect(
                served.every(
                    (call) =>
                        call.decision.value &&
                        !call.m0RematerializedThisPass &&
                        call.materializationContentionRetryExhausted,
                ),
            ).toBe(true);
            expect(result.materialized).toBe(false);
            if (cacheShape === "cached") {
                expect(
                    getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === 1)?.status,
                ).toBe("active");
                expect(result.droppedTokens).toBe(0);
                expect(getPendingOps(db, sessionId)).toHaveLength(1);
            } else {
                expect(
                    getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === 1)?.status,
                ).toBe("dropped");
                expect(result.droppedTokens).toBeGreaterThan(0);
                expect(result.bustedThisPass).toBe(true);
                if (cacheShape === "force")
                    expect(JSON.stringify(messages.slice(0, 2))).toContain("FORCE_FRESH");
                else expect(getOrCreateSessionMeta(db, sessionId).cachedM1Bytes).toBeNull();
            }
        } finally {
            injection.mockRestore();
        }
    });

    it("served m1 replays the persisted off-wire preflight bytes", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-preflight-persisted";
        const state = getOrCreateSessionMeta(db, sessionId);
        const m0M1 = { projectPath: "git:preflight-persisted", projectDirectory: "/nonexistent" };
        appendCompartments(db, sessionId, [
            {
                sequence: 1,
                startMessage: 1,
                endMessage: 1,
                startMessageId: "covered",
                endMessageId: "covered",
                title: "BASELINE",
                content: "BASELINE",
            },
        ]);
        injectM0M1({ db, sessionId, state, ...m0M1 });
        appendCompartments(db, sessionId, [
            {
                sequence: 2,
                startMessage: 2,
                endMessage: 2,
                startMessageId: "next-covered",
                endMessageId: "next-covered",
                title: "PERSISTED_A",
                content: "PERSISTED_A",
            },
        ]);
        let persistedPreflight: string | null = null;
        const original = compartmentInjection.injectM0M1;
        const injection = spyOn(compartmentInjection, "injectM0M1").mockImplementation(
            (options) => {
                const result = original(options);
                if (!options.messages)
                    persistedPreflight =
                        getOrCreateSessionMeta(db, sessionId).cachedM1Bytes?.toString("utf8") ??
                        null;
                return result;
            },
        );
        const messages = [makeToolMessage("tail")];
        try {
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    sessionMeta: state,
                    m0M1,
                    schedulerDecision: "execute",
                }),
            );
            expect(persistedPreflight).toContain("PERSISTED_A");
            expect((messages[1].parts[0] as { text: string }).text).toBe(persistedPreflight!);
        } finally {
            injection.mockRestore();
        }
    });
});

it("off-wire m1 preflight on 2000-message execute reports p50 and p95", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "ses-preflight-benchmark";
    const m0M1 = { projectPath: "git:preflight-benchmark", projectDirectory: "/nonexistent" };
    const state = getOrCreateSessionMeta(db, sessionId);
    appendCompartments(
        db,
        sessionId,
        Array.from({ length: 20 }, (_, i) => ({
            sequence: i + 1,
            startMessage: i + 1,
            endMessage: i + 1,
            startMessageId: `covered-${i}`,
            endMessageId: `covered-${i}`,
            title: `Baseline ${i}`,
            content: "Historical summary ".repeat(200),
        })),
    );
    injectM0M1({ db, sessionId, state, ...m0M1 });
    appendCompartments(db, sessionId, [
        {
            sequence: 21,
            startMessage: 21,
            endMessage: 21,
            startMessageId: "delta",
            endMessageId: "delta",
            title: "Published delta",
            content: "New published detail ".repeat(100),
        },
    ]);
    const samples: number[] = [];
    const original = compartmentInjection.injectM0M1;
    const injection = spyOn(compartmentInjection, "injectM0M1").mockImplementation((options) => {
        const start = performance.now();
        const result = original(options);
        if (!options.messages) samples.push(performance.now() - start);
        return result;
    });
    try {
        for (let pass = 0; pass < 30; pass++) {
            const messages: MessageLike[] = Array.from({ length: 2000 }, (_, index) => ({
                info: { id: `message-${index}`, role: index % 2 ? "assistant" : "user" },
                parts: [{ type: "text", text: `Message ${index}: ${"raw tail text ".repeat(40)}` }],
            }));
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    m0M1,
                    sessionMeta: state,
                    schedulerDecision: "execute",
                }),
            );
        }
        expect(samples).toHaveLength(30);
        const sorted = samples.slice(5).sort((a, b) => a - b);
        const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
        const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
        console.log(
            `m1-preflight 2000-message execute p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms samples=${sorted.length} baselineCompartments=20 deltaCompartments=1`,
        );
        expect(p50).toBeGreaterThan(0);
        expect(p95).toBeGreaterThanOrEqual(p50);
    } finally {
        injection.mockRestore();
    }
});

describe("ride-only configuration table", () => {
    async function runBands(
        config: "historian-disabled" | "no_models" | "wrapup-only" | "compaction-off",
    ) {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = `ses-ride-config-${config}`;
        const messages = [1, 2, 3, 4].map((tag) => makeToolMessage(`tool-${tag}`));
        const targets = new Map<number, TagTarget>();
        for (let tag = 1; tag <= 4; tag++) {
            insertTag(db, sessionId, `tool-${tag}`, "tool", 8000, tag, 0, "bash");
            targets.set(tag, makeDropTarget(messages[tag - 1]!));
        }
        advanceToolReclaimWatermark(db, sessionId, 4);
        // These are post-producer states, not invented configuration keys:
        // disabled has no runnable historian; no_models and wrapup-only have no
        // automatic publication to carry the waiting routine reductions.
        const options = {
            compactionOff: config === "compaction-off",
            canRunCompartments: config === "no_models" || config === "wrapup-only",
            schedulerDecision: "execute" as const,
            targets,
            tags: getActiveTagsBySession(db, sessionId),
            sessionMeta: getOrCreateSessionMeta(db, sessionId),
            emergencyCeilingTokens: 18_000,
        };
        const before = JSON.stringify(messages);
        const routine = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                ...options,
                contextUsage: { percentage: 75, inputTokens: 20_000 },
            }),
        );
        expect(JSON.stringify(messages)).toBe(before);
        expect(routine.droppedTokens).toBe(0);
        expect(getTagsBySession(db, sessionId).every((tag) => tag.status === "active")).toBe(true);
        const force = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                ...options,
                contextUsage: { percentage: 90, inputTokens: 20_000 },
            }),
        );
        if (config === "compaction-off") {
            for (const percentage of [20, 85, 95]) {
                const unchanged = await runPostTransformPhase(
                    basePostTransformArgs(db, sessionId, messages, {
                        ...options,
                        contextUsage: { percentage, inputTokens: 20_000 },
                    }),
                );
                expect(unchanged.droppedTokens).toBe(0);
                expect(JSON.stringify(messages)).toBe(before);
            }
            expect(JSON.stringify(messages)).toBe(before);
            expect(force.droppedTokens).toBe(0);
            expect(getTagsBySession(db, sessionId).every((tag) => tag.status === "active")).toBe(
                true,
            );
        } else {
            expect(force.emergencyReclaimedTokens).toBeGreaterThan(0);
            expect(force.droppedTokens).toBeGreaterThan(0);
            expect(JSON.stringify(messages)).not.toBe(before);
        }
    }
    it.each(["historian-disabled", "no_models", "wrapup-only"] as const)(
        "ride-only defers routine reclaim to force band under %s",
        runBands,
    );
    it("compaction-off performs no reclaim at any band", () => runBands("compaction-off"));
});

it("synthetic todo ride-only differential golden matches Rust", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "ses-todo-ride-golden";
    let previous = "";
    for (const step of todoRideGolden.steps) {
        if (step.state)
            updateSessionMeta(db, sessionId, { lastTodoState: JSON.stringify(step.state) });
        const messages = buildTodoGateMessages(sessionId);
        const tagger = createTagger();
        const tagged = tagMessages(sessionId, messages, tagger, db);
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: step.execute ? "execute" : "defer",
                pendingMaterializationSessions: step.flush ? new Set([sessionId]) : new Set(),
                m0M1: { projectPath: "git:todo-golden", projectDirectory: "/nonexistent" },
                tagger,
                targets: tagged.targets,
                reasoningByMessage: tagged.reasoningByMessage,
                messageTagNumbers: tagged.messageTagNumbers,
                batch: tagged.batch,
            }),
        );
        const todo = findTodoPart(messages) as { state: { input: { todos: unknown } } } | null;
        expect(todo?.state.input.todos ?? null).toEqual(step.expectedTodo);
        const wire = JSON.stringify(messages);
        if (step.replay) expect(wire).toBe(previous);
        else expect(wire).not.toBe(previous);
        previous = wire;
    }
});

it("competing persisted pair cannot replace the previously served TypeScript prefix", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "ses-competing-prefix-snapshot";
    const m0M1 = { projectPath: "git:competing-prefix", projectDirectory: "/nonexistent" };
    appendCompartments(db, sessionId, [
        {
            sequence: 1,
            startMessage: 1,
            endMessage: 1,
            startMessageId: "covered-a",
            endMessageId: "covered-a",
            title: "PAIR_A",
            content: "PAIR_A",
        },
    ]);
    const initialState = getOrCreateSessionMeta(db, sessionId);
    injectM0M1({ db, sessionId, state: initialState, ...m0M1 });
    const pairA = compartmentInjection.prepareCachedM0M1Replay(db, sessionId);
    expect(pairA).toBeDefined();

    appendCompartments(db, sessionId, [
        {
            sequence: 2,
            startMessage: 2,
            endMessage: 2,
            startMessageId: "covered-b",
            endMessageId: "covered-b",
            title: "PUBLISHED_AFTER_A",
            content: "PUBLISHED_AFTER_A",
        },
    ]);
    insertTag(db, sessionId, "old-tool", "tool", 4000, 1, 0, "bash", 0, "old-owner", null, {
        tokenCount: 1000,
        inputTokenCount: 0,
        reasoningTokenCount: 0,
    });
    padRecentToolSkeletonWindow(sessionId, 1);
    advanceToolReclaimWatermark(db, sessionId, 1);
    queueM0Mutation(db, { sessionId, mutationType: "compartment_merge" });

    const rawMessages = (): MessageLike[] => [
        {
            info: { id: "covered-a", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "covered by pair A" }],
        } as MessageLike,
        {
            info: { id: "covered-b", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "must remain raw with pair A" }],
        } as MessageLike,
        makeToolMessage("old-tool"),
    ];
    const expected = rawMessages();
    injectM0M1({
        db,
        sessionId,
        state: getOrCreateSessionMeta(db, sessionId),
        messages: expected,
        preparedPrefix: pairA,
        ...m0M1,
    });

    let competingWrites = 0;
    const original = compartmentInjection.injectM0M1;
    const injection = spyOn(compartmentInjection, "injectM0M1").mockImplementation((options) =>
        original({
            ...options,
            beforePhase3ForTest: !options.messages
                ? () => {
                      competingWrites += 1;
                      patchSessionMeta(db, sessionId, {
                          cached_m0_bytes: Buffer.from(
                              "<session-history>PAIR_B</session-history>",
                              "utf8",
                          ),
                          cached_m1_bytes: Buffer.from(pairA!.m1Text!, "utf8"),
                          cached_m0_max_compartment_seq: 2,
                          cached_m0_last_baseline_end_message_id: "covered-b",
                      });
                      queueM0Mutation(db, {
                          sessionId,
                          mutationType: "compartment_merge",
                      });
                  }
                : undefined,
        }),
    );
    try {
        const messages = rawMessages();
        const state = getOrCreateSessionMeta(db, sessionId);
        const toolMessage = messages[2];
        const result = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                m0M1,
                sessionMeta: state,
                schedulerDecision: "execute",
                tags: getActiveTagsBySession(db, sessionId),
                targets: new Map([[1, makeDropTarget(toolMessage)]]),
            }),
        );

        expect(competingWrites).toBe(3);
        expect(JSON.stringify(messages)).toBe(JSON.stringify(expected));
        expect(messages.some((message) => message.info.id === "covered-b")).toBe(true);
        expect(result.droppedTokens).toBe(0);
        expect(getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === 1)?.status).toBe(
            "active",
        );
    } finally {
        injection.mockRestore();
    }
});

it("contended partial cache replays persisted prefix until one uncontended drain", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "ses-persist-before-serve";
    const m0M1 = { projectPath: "git:persist-before-serve", projectDirectory: "/nonexistent" };
    appendCompartments(db, sessionId, [
        {
            sequence: 1,
            startMessage: 1,
            endMessage: 1,
            startMessageId: "covered",
            endMessageId: "covered",
            title: "OLD_BASELINE",
            content: "OLD_BASELINE",
        },
    ]);
    const cached: MessageLike[] = [];
    injectM0M1({
        db,
        sessionId,
        state: getOrCreateSessionMeta(db, sessionId),
        messages: cached,
        ...m0M1,
    });
    const cachedBytes = JSON.stringify(cached);
    appendCompartments(db, sessionId, [
        {
            sequence: 2,
            startMessage: 2,
            endMessage: 2,
            startMessageId: "new-covered",
            endMessageId: "new-covered",
            title: "PUBLISHED_A",
            content: "PUBLISHED_A",
        },
    ]);
    insertTag(db, sessionId, "old-tool", "tool", 4000, 1, 0, "bash", 0, "old-owner", null, {
        tokenCount: 1000,
        inputTokenCount: 0,
        reasoningTokenCount: 0,
    });
    padRecentToolSkeletonWindow(sessionId, 1);
    advanceToolReclaimWatermark(db, sessionId, 1);
    let contend = true;
    const original = compartmentInjection.injectM0M1;
    const injection = spyOn(compartmentInjection, "injectM0M1").mockImplementation((options) =>
        original({
            ...options,
            beforePhase3ForTest:
                contend && !options.messages
                    ? () => {
                          queueM0Mutation(db, { sessionId, mutationType: "compartment_merge" });
                      }
                    : undefined,
        }),
    );
    try {
        for (let pass = 0; pass < 3; pass++) {
            contend = pass < 2;
            const state = getOrCreateSessionMeta(db, sessionId);
            if (contend) state.cachedM1Bytes = null;
            const message = makeToolMessage("old-tool");
            const messages = [message];
            const result = await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    m0M1,
                    sessionMeta: state,
                    schedulerDecision: "execute",
                    tags: getActiveTagsBySession(db, sessionId),
                    targets: new Map([[1, makeDropTarget(message)]]),
                }),
            );
            if (contend) {
                expect(JSON.stringify(messages.slice(0, 2))).toBe(cachedBytes);
                expect(result.droppedTokens).toBe(0);
                expect(getTagsBySession(db, sessionId).find((t) => t.tagNumber === 1)?.status).toBe(
                    "active",
                );
            } else {
                expect(JSON.stringify(messages.slice(0, 2))).toContain("PUBLISHED_A");
                expect(result.droppedTokens).toBeGreaterThan(0);
                expect(getTagsBySession(db, sessionId).find((t) => t.tagNumber === 1)?.status).toBe(
                    "dropped",
                );
            }
        }
    } finally {
        injection.mockRestore();
    }
});

it("force soft-refresh contention serves fresh recovery bytes", () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "ses-force-soft-contention";
    const state = getOrCreateSessionMeta(db, sessionId);
    const options = {
        db,
        sessionId,
        state,
        projectPath: "git:force-soft",
        projectDirectory: "/nonexistent",
    };
    appendCompartments(db, sessionId, [
        {
            sequence: 1,
            startMessage: 1,
            endMessage: 1,
            startMessageId: "old",
            endMessageId: "old",
            title: "BASELINE",
            content: "BASELINE",
        },
    ]);
    injectM0M1(options);
    appendCompartments(db, sessionId, [
        {
            sequence: 2,
            startMessage: 2,
            endMessage: 2,
            startMessageId: "new",
            endMessageId: "new",
            title: "FORCE_SOFT_FRESH",
            content: "FORCE_SOFT_FRESH",
        },
    ]);
    expect(compartmentInjection.mustMaterialize(options).value).toBe(false);
    const exec = db.exec.bind(db);
    const blocker = spyOn(db, "exec").mockImplementation((sql) => {
        if (sql === "BEGIN IMMEDIATE")
            throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        return exec(sql);
    });
    try {
        const result = injectM0M1({
            ...options,
            isCacheBustingPass: true,
            allowFreshContentionFallback: true,
        });
        expect(result.materializationContentionRetryExhausted).toBe(true);
        expect(JSON.stringify(result.preparedMessages)).toContain("FORCE_SOFT_FRESH");
    } finally {
        blocker.mockRestore();
    }
});

describe("contract adversarial cache sequences", () => {
    it("contract protected queued drop survives reopen and geometry move until aged", async () => {
        const { resolveEpochFloorForPass, resetEpochFloorRegistryForTest } = await import(
            "../../features/magic-context/storage-meta-persisted"
        );
        const dir = createTestTempDirFromPath(join(tmpdir(), "audit-floor-"));
        tempDirs.push(dir);
        const path = join(dir, "context.db");
        db = new Database(path);
        initializeDatabase(db);
        const sessionId = "audit-protected-queue";
        const messages: MessageLike[] = [];
        const targets = new Map<number, TagTarget>();
        const seed = (n: number) => {
            const message = makeToolMessage(`audit-tool-${n}`);
            messages.push(message);
            targets.set(n, makeDropTarget(message));
            insertTag(
                db,
                sessionId,
                `call-${n}`,
                "tool",
                8000,
                n,
                0,
                "bash",
                0,
                message.info.id,
                null,
                { tokenCount: 2000, inputTokenCount: 0, reasoningTokenCount: 0 },
            );
        };
        for (let n = 1; n <= 10; n++) seed(n);
        const firstFloor = resolveEpochFloorForPass(db, sessionId, {
            usableSoft: 100_000,
            isCacheBustingPass: false,
        });
        expect(firstFloor.floor).toBe(8000);
        queuePendingOp(db, sessionId, 9, "drop", 1);
        db.close();
        resetEpochFloorRegistryForTest();
        db = new Database(path);
        initializeDatabase(db);
        const moved = resolveEpochFloorForPass(db, sessionId, {
            usableSoft: 200_000,
            isCacheBustingPass: false,
        });
        expect(moved.floor).toBe(8000);
        expect(moved.preSnapshotInputChanged).toBe(true);
        const pass = async (decision: "execute" | "defer", flush = false) => {
            const window = getProtectionWindowForSession(db, sessionId, moved.floor);
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    schedulerDecision: decision,
                    pendingMaterializationSessions: new Set(flush ? [sessionId] : []),
                    targets,
                    tags: getActiveTagsBySession(db, sessionId),
                    protectedTagIds: window.protectedTagNumbers,
                    protectedTagNumbers: window.protectedTagNumbers,
                    protectedCutoff: window.cutoff,
                    protectedCount: window.status.protectedCount,
                }),
            );
        };
        const before = JSON.stringify(messages);
        await pass("execute");
        console.log("CONTRACT OC protected execute pending", getPendingOps(db, sessionId).length);
        expect(getPendingOps(db, sessionId)).toHaveLength(1);
        expect(JSON.stringify(messages)).toBe(before);
        for (let n = 11; n <= 14; n++) seed(n);
        await pass("defer");
        expect(getPendingOps(db, sessionId)).toHaveLength(1);
        await pass("execute", true);
        expect(getPendingOps(db, sessionId)).toHaveLength(0);
        expect(getTagsBySession(db, sessionId).find((t) => t.tagNumber === 9)?.status).toBe(
            "dropped",
        );
        const frozen = resolveEpochFloorForPass(db, sessionId, {
            usableSoft: 200_000,
            isCacheBustingPass: true,
        });
        expect(frozen.floor).toBe(16000);
        console.log(
            "CONTRACT OC floor 8000 -> reopen/geometry DEFER 8000 -> priced 16000; queued drop drains only after aging",
        );
    });

    it("contract marker contraction reopen reexpansion keeps frozen visible bytes", async () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "audit-marker-"));
        tempDirs.push(dir);
        const path = join(dir, "context.db");
        db = new Database(path);
        initializeDatabase(db);
        const sessionId = "audit-marker-reopen";
        const user = (id: string): MessageLike =>
            ({
                info: { id, role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: id }],
            }) as MessageLike;
        const assistant = (): MessageLike =>
            ({
                info: { id: "seam", role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: "[dropped §9§]" }],
            }) as MessageLike;
        const contracted = [user("before"), user("after")];
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, contracted, {
                schedulerDecision: "execute",
                pendingMaterializationSessions: new Set([sessionId]),
                resolvedProviderID: "anthropic",
                hiddenMessagesAtCompactionSeam: [assistant()],
            }),
        );
        expect(getStrippedPlaceholderIds(db, sessionId).has("seam")).toBe(true);
        const wire = serializeAnthropicVisibleRoleGroups(contracted);
        db.close();
        db = new Database(path);
        initializeDatabase(db);
        for (const expanded of [false, true, false, true]) {
            const messages = expanded
                ? [user("before"), assistant(), user("after")]
                : [user("before"), user("after")];
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    schedulerDecision: "defer",
                    resolvedProviderID: "anthropic",
                }),
            );
            expect(serializeAnthropicVisibleRoleGroups(messages)).toBe(wire);
        }
        console.log(
            "CONTRACT OC marker contracted -> reopen -> expanded -> contracted -> expanded: four DEFER visible-byte comparisons equal",
        );
    });

    it("contract force tool batch then submargin dip cannot rearm routine text lane", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "audit-oc-cross-lane";
        const messages: MessageLike[] = [];
        const targets = new Map<number, TagTarget>();
        const messageTagNumbers = new Map<MessageLike, number>();
        const text =
            "I just really basically wanted to clearly explain the stable cache prefix while pressure remains high. ".repeat(
                8,
            );
        for (let n = 1; n <= 35; n++) {
            const message = {
                info: { id: `text-${n}`, role: n % 2 ? "user" : "assistant" },
                parts: [{ type: "text", text }],
            } as MessageLike;
            messages.push(message);
            targets.set(n, makeMessageTarget(message));
            messageTagNumbers.set(message, n);
            insertTag(db, sessionId, message.info.id, "message", text.length, n);
            saveSourceContent(db, sessionId, n, text);
        }
        for (let n = 36; n <= 45; n++) {
            const message = makeToolMessage(`tool-${n}`);
            messages.push(message);
            targets.set(n, makeDropTarget(message));
            insertTag(
                db,
                sessionId,
                `call-${n}`,
                "tool",
                4000,
                n,
                0,
                "bash",
                0,
                message.info.id,
                null,
                { tokenCount: 1000, inputTokenCount: 0, reasoningTokenCount: 0 },
            );
        }
        const turns = new Map<string, string>();
        const pass = async (percentage: number, decision: "execute" | "defer") => {
            const window = getProtectionWindowForSession(db, sessionId, 4000);
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    schedulerDecision: decision,
                    contextUsage: { percentage, inputTokens: percentage * 1000 },
                    emergencyCeilingTokens: 65000,
                    targets,
                    messageTagNumbers,
                    tags: getActiveTagsBySession(db, sessionId),
                    currentTurnId: `turn-${percentage}`,
                    lastHeuristicsTurnId: turns,
                    cavemanTextCompression: { enabled: true, minChars: 1 },
                    resolvedProviderID: "anthropic",
                    protectedTagIds: window.protectedTagNumbers,
                    protectedTagNumbers: window.protectedTagNumbers,
                    protectedCutoff: window.cutoff,
                    protectedCount: window.status.protectedCount,
                }),
            );
        };
        await pass(90, "execute");
        const { getEmergencyInputSample } = await import(
            "../../features/magic-context/storage-meta-persisted"
        );
        expect(getEmergencyInputSample(db, sessionId)).toBe(90000);
        for (let n = 46; n <= 65; n++) {
            const message = {
                info: { id: `text-${n}`, role: n % 2 ? "user" : "assistant" },
                parts: [{ type: "text", text }],
            } as MessageLike;
            messages.push(message);
            targets.set(n, makeMessageTarget(message));
            messageTagNumbers.set(message, n);
            insertTag(db, sessionId, message.info.id, "message", text.length, n);
            saveSourceContent(db, sessionId, n, text);
        }
        for (let n = 66; n <= 75; n++) {
            const message = makeToolMessage(`tool-${n}`);
            messages.push(message);
            targets.set(n, makeDropTarget(message));
            insertTag(
                db,
                sessionId,
                `call-${n}`,
                "tool",
                4000,
                n,
                0,
                "bash",
                0,
                message.info.id,
                null,
                { tokenCount: 1000, inputTokenCount: 0, reasoningTokenCount: 0 },
            );
        }
        const before = JSON.stringify(messages);
        const depths = getTagsBySession(db, sessionId).map((t) => t.cavemanDepth);
        await pass(82, "defer");
        expect(JSON.stringify(messages)).toBe(before);
        await pass(90.1, "defer");
        expect(getEmergencyInputSample(db, sessionId)).toBe(90000);
        console.log(
            "CONTRACT OC cross lane emergency latch=90000 stable",
            JSON.stringify(messages) === before,
            "depths before/after",
            depths,
            getTagsBySession(db, sessionId).map((t) => t.cavemanDepth),
        );
        expect(JSON.stringify(messages)).toBe(before);
    });
});

it("contract OC 95 backstop bypasses consumed tool latch", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "audit-oc-95";
    const messages: MessageLike[] = [];
    const targets = new Map<number, TagTarget>();
    for (let n = 1; n <= 30; n++) {
        const message = makeToolMessage(`tool-${n}`);
        messages.push(message);
        targets.set(n, makeDropTarget(message));
        insertTag(
            db,
            sessionId,
            `call-${n}`,
            "tool",
            4000,
            n,
            0,
            "bash",
            0,
            message.info.id,
            null,
            { tokenCount: 1000, inputTokenCount: 0, reasoningTokenCount: 0 },
        );
    }
    const pass = (percentage: number) => {
        const window = getProtectionWindowForSession(db, sessionId, 12000);
        return runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "execute",
                contextUsage: {
                    percentage,
                    // Follow the served tail after the first batch rather than
                    // treating removed output as irreducible overhead.
                    inputTokens:
                        60_000 +
                        messages.reduce(
                            (sum, message) => sum + estimateMessageTokens(message).toolCall,
                            0,
                        ),
                },
                emergencyCeilingTokens: 65000,
                targets,
                tags: getActiveTagsBySession(db, sessionId),
                protectedTagIds: window.protectedTagNumbers,
                protectedTagNumbers: window.protectedTagNumbers,
                protectedCutoff: window.cutoff,
                protectedCount: window.status.protectedCount,
            }),
        );
    };
    const count = () =>
        getTagsBySession(db, sessionId).filter((t) => t.status === "dropped").length;
    await pass(90);
    const first = count();
    expect(first).toBeGreaterThan(0);
    const bytes = JSON.stringify(messages);
    await pass(96);
    const latched = count();
    console.log(
        "CONTRACT OC 90 -> 96 dropped",
        first,
        latched,
        "bytesEqual",
        JSON.stringify(messages) === bytes,
    );
    queuePendingOp(db, sessionId, 19, "drop", 1);
    await pass(96.1);
    console.log(
        "CONTRACT OC protected agent-drop control pending",
        getPendingOps(db, sessionId).length,
        "dropped",
        count(),
    );
    const { clearEmergencyDropSample } = await import(
        "../../features/magic-context/storage-meta-persisted"
    );
    clearEmergencyDropSample(db, sessionId);
    await pass(96.2);
    console.log("CONTRACT OC cleared-latch 95 control dropped", count());
    expect(count()).toBeGreaterThan(first);
    expect(latched).toBeGreaterThan(first);
});

it("contract OC explicit protected drop applies at 95 without aging", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "contract-oc-explicit95";
    const message = makeToolMessage("protected-tool");
    const messages = [message];
    insertTag(db, sessionId, "protected-call", "tool", 12, 1, 0, "bash", 0, message.info.id, null, {
        tokenCount: 3,
        inputTokenCount: 0,
        reasoningTokenCount: 0,
    });
    queuePendingOp(db, sessionId, 1, "drop", 1);
    const pass = (percentage: number) =>
        runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "execute",
                contextUsage: { percentage, inputTokens: percentage * 1000 },
                targets: new Map([[1, makeDropTarget(message)]]),
                tags: getActiveTagsBySession(db, sessionId),
                protectedTagIds: new Set([1]),
                protectedTagNumbers: new Set([1]),
                protectedCutoff: 1,
                protectedCount: 1,
            }),
        );
    await pass(70);
    expect(getPendingOps(db, sessionId)).toHaveLength(1);
    await pass(96);
    expect(getPendingOps(db, sessionId)).toHaveLength(0);
    expect(getTagsBySession(db, sessionId)[0]?.status).toBe("dropped");
});

it("contract OC zero yield stays armed and text-only reclaim consumes the shared episode", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "contract-oc-text-only";
    const messages: MessageLike[] = [];
    const targets = new Map<number, TagTarget>();
    const messageTagNumbers = new Map<MessageLike, number>();
    const { getEmergencyInputSample } = await import(
        "../../features/magic-context/storage-meta-persisted"
    );
    const pass = (percentage: number) =>
        runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "defer",
                contextUsage: { percentage, inputTokens: percentage * 1000 },
                emergencyCeilingTokens: 65000,
                targets,
                messageTagNumbers,
                tags: getActiveTagsBySession(db, sessionId),
                cavemanTextCompression: { enabled: true, minChars: 1 },
                resolvedProviderID: "anthropic",
                protectedTagIds: new Set(),
                protectedTagNumbers: new Set(),
                protectedCutoff: null,
                protectedCount: 0,
            }),
        );
    await pass(90);
    expect(getEmergencyInputSample(db, sessionId)).toBe(0);
    const text =
        "I just really basically wanted to clearly explain the stable cache prefix while pressure remains high. ".repeat(
            8,
        );
    for (let n = 1; n <= 35; n++) {
        const message = {
            info: { id: `text-${n}`, role: n % 2 ? "user" : "assistant" },
            parts: [{ type: "text", text }],
        } as MessageLike;
        messages.push(message);
        targets.set(n, makeMessageTarget(message));
        messageTagNumbers.set(message, n);
        insertTag(db, sessionId, message.info.id, "message", text.length, n);
        saveSourceContent(db, sessionId, n, text);
    }
    await pass(90.1);
    expect(getTagsBySession(db, sessionId).some((t) => (t.cavemanDepth ?? 0) > 0)).toBe(true);
    expect(getEmergencyInputSample(db, sessionId)).toBe(90100);
    const bytes = JSON.stringify(messages);
    await pass(82);
    await pass(90.2);
    expect(JSON.stringify(messages)).toBe(bytes);
    expect(getEmergencyInputSample(db, sessionId)).toBe(90100);
});

describe("ride-only queued drops", () => {
    for (const [name, fullFeatureMode, schedulerDecision, queued, applies] of [
        ["subagent execute drains queued drops", false, "execute", true, true],
        ["primary execute holds queued drops", true, "execute", true, false],
        ["subagent defer holds queued drops", false, "defer", true, false],
        ["subagent empty execute is byte-identical", false, "execute", false, false],
    ] as const) {
        it(`issue 619 ${name}`, async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = `issue-619-${name}`;
            const message = makeToolMessage("issue-619-tool");
            insertTag(
                db,
                sessionId,
                "issue-619-call",
                "tool",
                1000,
                1,
                0,
                "bash",
                0,
                message.info.id,
            );
            if (queued) padRecentToolSkeletonWindow(sessionId, 1);
            const args = basePostTransformArgs(db, sessionId, [message], {
                fullFeatureMode,
                schedulerDecision: "defer",
                schedulerDeferReason: undefined,
                contextUsage: { percentage: 40, inputTokens: 40000 },
                targets: new Map([[1, makeDropTarget(message)]]),
                protectedTagIds: new Set(queued ? [] : [1]),
            });
            await runPostTransformPhase(args);
            if (applies) {
                const aged = makeToolMessage("issue-619-aged-tool");
                insertTag(
                    db,
                    sessionId,
                    "issue-619-aged-call",
                    "tool",
                    1000,
                    22,
                    0,
                    "bash",
                    0,
                    aged.info.id,
                );
                args.messages.push(aged);
                args.targets.set(22, makeDropTarget(aged));
                // The queued drop and a distinct eligible age candidate must
                // consume the same permission, not bust on successive passes.
                args.sessionMeta.toolReclaimWatermark = 22;
            }
            const baseline = JSON.stringify(args.messages);
            if (queued) queuePendingOp(db, sessionId, 1, "drop");
            await runPostTransformPhase({ ...args, schedulerDecision });
            expect(getPendingOps(db, sessionId)).toHaveLength(queued && !applies ? 1 : 0);
            if (applies) {
                expect(JSON.stringify(args.messages)).not.toBe(baseline);
                expect(
                    getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === 22)?.status,
                ).toBe("dropped");
            } else expect(JSON.stringify(args.messages)).toBe(baseline);
            const appliedBytes = JSON.stringify(args.messages);
            for (let pass = 0; pass < 3; pass++) {
                await runPostTransformPhase({ ...args, schedulerDecision });
                expect(JSON.stringify(args.messages)).toBe(appliedBytes);
            }
        });
    }

    for (const historianRunning of [false, true]) {
        it(`holds execute-only queued drops with historian=${historianRunning}`, async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = `ride-only-${historianRunning}`;
            const message = makeToolMessage("ride-only-tool");
            insertTag(
                db,
                sessionId,
                "ride-only-call",
                "tool",
                1000,
                1,
                0,
                "bash",
                0,
                message.info.id,
            );
            padRecentToolSkeletonWindow(sessionId, 1);
            if (historianRunning)
                registerActiveCompartmentRun(sessionId, new Promise<void>(() => {}));
            const args = basePostTransformArgs(db, sessionId, [message], {
                canRunCompartments: historianRunning,
                schedulerDecision: "execute",
                schedulerDeferReason: undefined,
                contextUsage: { percentage: 65, inputTokens: 65000 },
                compartmentInProgress: historianRunning,
                targets: new Map([[1, makeDropTarget(message)]]),
            });
            await runPostTransformPhase(args);
            const baseline = JSON.stringify(args.messages);
            queuePendingOp(db, sessionId, 1, "drop");
            const log = spyOn(loggerModule, "sessionLog");
            try {
                await runPostTransformPhase(args);
                expect(JSON.stringify(args.messages)).toBe(baseline);
                expect(getPendingOps(db, sessionId)).toHaveLength(1);
                expect(
                    log.mock.calls.some(
                        (call) =>
                            String(call[1]).includes(
                                "held — reason=no originating cache-bust opportunity",
                            ) && String(call[1]).includes(`historianRunning=${historianRunning}`),
                    ),
                ).toBe(true);
                for (let pass = 0; pass < 4; pass++) {
                    await runPostTransformPhase({ ...args, schedulerDecision: "defer" });
                    expect(JSON.stringify(args.messages)).toBe(baseline);
                }
                requestPendingMaterialization(
                    args.pendingMaterializationSessions,
                    sessionId,
                    "user_flush",
                );
                await runPostTransformPhase(args);
                expect(getPendingOps(db, sessionId)).toHaveLength(0);
            } finally {
                log.mockRestore();
            }
        });
    }
});

it("queued agent batches consume only one force episode", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "ride-force-batches";
    const first = makeToolMessage("force-first");
    const second = makeToolMessage("force-second");
    for (const [index, message] of [first, second].entries()) {
        insertTag(
            db,
            sessionId,
            `force-call-${index}`,
            "tool",
            1000,
            index + 1,
            0,
            "bash",
            0,
            message.info.id,
        );
    }
    padRecentToolSkeletonWindow(sessionId, 2);
    const args = basePostTransformArgs(db, sessionId, [first, second], {
        schedulerDecision: "execute",
        contextUsage: { percentage: 90, inputTokens: 90000 },
        targets: new Map([
            [1, makeDropTarget(first)],
            [2, makeDropTarget(second)],
        ]),
    });
    queuePendingOp(db, sessionId, 1, "drop");
    await runPostTransformPhase(args);
    expect(getPendingOps(db, sessionId)).toHaveLength(0);
    const frozen = JSON.stringify(args.messages);
    queuePendingOp(db, sessionId, 2, "drop");
    await runPostTransformPhase(args);
    expect(getPendingOps(db, sessionId)).toHaveLength(1);
    expect(JSON.stringify(args.messages)).toBe(frozen);
    requestPendingMaterialization(args.pendingMaterializationSessions, sessionId, "user_flush");
    await runPostTransformPhase(args);
    expect(getPendingOps(db, sessionId)).toHaveLength(0);
});

it("four pure defer passes preserve served bytes and durable drop state", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "four-defer-replay";
    const snapshots: string[] = [];
    insertTag(db, sessionId, "replay-call", "tool", 1000, 1, 0, "bash", 0, "replay-tool");
    padRecentToolSkeletonWindow(sessionId, 1);
    queuePendingOp(db, sessionId, 1, "drop", 1);
    const pass = async (flush: boolean) => {
        const message = makeToolMessage("replay-tool");
        const messages = [message];
        applyFlushedStatuses(
            sessionId,
            db,
            new Map([[1, makeDropTarget(message)]]),
            getTagsBySession(db, sessionId),
        );
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                pendingMaterializationSessions: new Set(flush ? [sessionId] : []),
                targets: new Map([[1, makeDropTarget(message)]]),
            }),
        );
        return JSON.stringify({
            messages,
            status: getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]),
            pending: getPendingOps(db, sessionId).length,
        });
    };
    await pass(true);
    const baseline = await pass(false);
    for (let index = 0; index < 4; index++) {
        const snapshot = await pass(false);
        expect(snapshot).toBe(baseline);
        snapshots.push(snapshot);
    }
    console.log(
        "RIDE_REPLAY_OC",
        createHash("sha256").update(JSON.stringify(snapshots)).digest("hex"),
    );
});

describe("postprocess defer instrumentation and scaling", () => {
    it("reports measured postprocess substages once per defer pass", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const logs: string[] = [];
        const log = spyOn(loggerModule, "sessionLog").mockImplementation((_id, ...values) => {
            logs.push(values.join(" "));
        });
        let clock = 0;
        let step = 7;
        const now = spyOn(performance, "now").mockImplementation(() => (clock += step));
        try {
            for (const increment of [7, 13]) {
                step = increment;
                logs.length = 0;
                await withTransformTimingSummary(() =>
                    runPostTransformPhase(
                        basePostTransformArgs(db, "timed-defer", [], {
                            channel1StateBySession: new Map(),
                            resolvedProviderID: "anthropic",
                        }),
                    ),
                );
                const summary = logs.filter((line) => line.startsWith("transform stages:"));
                expect(summary).toHaveLength(1);
                for (const stage of [
                    "setupAndOperations",
                    "replaySnapshot",
                    "placeholderNeutralize",
                    "nudgeAndSticky",
                    "markerReconcile",
                    "noteAndTodoSynthesis",
                    "frozenDecisions",
                    "tailReads",
                    "tailMeasure",
                    "tailState",
                    "tailBaseline",
                    "tailGuard",
                ]) {
                    const records = [
                        ...summary[0].matchAll(new RegExp(`pp\\.${stage}=([\\d.]+)ms`, "g")),
                    ];
                    expect(records).toHaveLength(1);
                    const elapsed = Number(records[0][1]);
                    expect(elapsed).toBeGreaterThanOrEqual(increment);
                    if (stage === "tailReads") expect(elapsed).toBe(increment);
                }
            }
        } finally {
            now.mockRestore();
            log.mockRestore();
        }
    });

    it("keeps defer per-message cost load-invariant between 200 and 2000 messages", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const log = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
        const previousEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        try {
            const medians: number[] = [];
            for (const count of [200, 2000]) {
                const input = Array.from({ length: count }, (_, index) => ({
                    info: { id: `load-${index}`, role: index % 2 ? "assistant" : "user" },
                    parts: [
                        { type: "text", text: `Actual payload ${index}: ${"sample ".repeat(100)}` },
                    ],
                })) as MessageLike[];
                const state = new Map<string, Channel1State>();
                const args = basePostTransformArgs(db, `load-${count}`, [], {
                    channel1StateBySession: state,
                    resolvedProviderID: "anthropic",
                });
                const times: number[] = [];
                for (let pass = 0; pass < 25; pass += 1) {
                    args.messages = cloneMessages(input);
                    const start = performance.now();
                    await runPostTransformPhase(args);
                    if (pass >= 5) times.push(performance.now() - start);
                }
                times.sort((a, b) => a - b);
                medians.push(times[Math.floor(times.length / 2)]);
            }
            expect(medians[1] / 2000 / (medians[0] / 200)).toBeLessThan(3);
            if (process.env.MC_PERF_GATE === "1") expect(medians[1]).toBeLessThan(10);
        } finally {
            if (previousEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = previousEnv;
            log.mockRestore();
        }
    });
});

describe("pending-ops and heuristics permission labels", () => {
    // The permission these two logs announce is the reclaim ride, not the
    // scheduler decision. Both fall-throughs used to print "scheduler_execute"
    // even on passes where the scheduler had deferred, so an operator reading
    // the log could not tell a published-history drain from a force-band drain.
    async function permissionLines(
        sessionId: string,
        overrides: Partial<Parameters<typeof runPostTransformPhase>[0]>,
    ): Promise<string[]> {
        const logs: string[] = [];
        const log = spyOn(loggerModule, "sessionLog").mockImplementation((_id, ...values) => {
            logs.push(values.join(" "));
        });
        try {
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, [], {
                    resolvedProviderID: "anthropic",
                    ...overrides,
                }),
            );
        } finally {
            log.mockRestore();
        }
        return logs.filter(
            (line) => line.includes("WILL APPLY — reason=") || line.includes("WILL RUN — reason="),
        );
    }

    it("names the ride that granted the pass, and names a different one on a different ride", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);

        const publishedHistory = await permissionLines("ses-ride-published-history", {
            readLastServedMessages: () => [
                { info: { role: "user" }, parts: [{ type: "text", text: "previous history" }] },
            ],
            contextUsage: { percentage: 20, inputTokens: 1_000 },
            historyRebuiltThisPass: true,
            pendingCompartmentInjection: {
                block: "",
                compartmentEndMessage: 2,
                compartmentEndMessageId: "ride-end",
                compartmentCount: 1,
                skippedVisibleMessages: 0,
                factCount: 0,
                memoryCount: 0,
                rebuiltFromDb: true,
            },
        });
        // At this emergency-level context usage the force band is the only ride
        // that is true, so the pass must be labelled differently from the one above.
        const forceBand = await permissionLines("ses-ride-force-band", {
            fullFeatureMode: false,
            contextUsage: { percentage: 96, inputTokens: 1_000 },
        });

        expect(publishedHistory).toEqual([
            "heuristics WILL RUN — reason=ride=publishedHistory (pendingOps=0, scheduler=defer), context=20.0%, turn=null",
            "pending ops WILL APPLY — reason=ride=publishedHistory (scheduler=defer), pendingOps=0, context=20.0%",
        ]);
        expect(forceBand).toEqual([
            "heuristics WILL RUN — reason=ride=force (pendingOps=0, scheduler=defer), context=96.0%, turn=null",
            "pending ops WILL APPLY — reason=ride=force (scheduler=defer), pendingOps=0, context=96.0%",
        ]);
        expect(publishedHistory).not.toEqual(forceBand);
    });
});

// Claude Fable 5.1, Opus 5.5 and Sonnet 5.5 bind each signed thinking block to every
// byte served before it, so a pass that busts the cache removes every thinking
// block still on the wire (the provider would drop it or reject the request).
// Every later pass replays the removal byte-identically; a defer pass never
// starts one.
describe("proactive strip of thinking on busting passes", () => {
    const sha256 = (value: unknown): string =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const REASONING = new Set(["thinking", "reasoning", "redacted_thinking"]);
    const reasoningCount = (message: MessageLike): number =>
        message.parts.filter(
            (part) =>
                part !== null &&
                typeof part === "object" &&
                REASONING.has(String((part as { type?: unknown }).type)),
        ).length;
    const ALL_ASSISTANTS = ["assistant-one", "assistant-two", "assistant-open-tool"];

    // user-prefix stands in for the served head (m0/m1 or the first user turn).
    // The newest assistant holds an open tool round.
    const buildSession = (sessionId: string, prefix = "original first user message") =>
        [
            {
                info: { id: "user-prefix", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: prefix }],
            },
            {
                info: { id: "assistant-one", role: "assistant", sessionID: sessionId },
                parts: [
                    { type: "thinking", thinking: "signed one", signature: "sig-one" },
                    { type: "text", text: "answer one" },
                ],
            },
            {
                info: { id: "user-two", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "second question" }],
            },
            {
                info: { id: "assistant-two", role: "assistant", sessionID: sessionId },
                parts: [
                    {
                        type: "reasoning",
                        text: "signed two",
                        metadata: { anthropic: { signature: "sig-two" } },
                    },
                    { type: "text", text: "answer two" },
                ],
            },
            {
                info: { id: "user-three", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "run the tool" }],
            },
            {
                info: { id: "assistant-open-tool", role: "assistant", sessionID: sessionId },
                parts: [
                    { type: "thinking", thinking: "signed three", signature: "sig-three" },
                    {
                        type: "tool",
                        callID: "call-open",
                        tool: "bash",
                        state: { status: "completed", input: {}, output: "tool output" },
                    },
                ],
            },
        ] as unknown as MessageLike[];

    const appendTurn = (
        messages: MessageLike[],
        sessionId: string,
        suffix: string,
    ): MessageLike[] =>
        [
            ...messages,
            {
                info: { id: `user-${suffix}`, role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: `question ${suffix}` }],
            },
            {
                info: { id: `assistant-${suffix}`, role: "assistant", sessionID: sessionId },
                parts: [
                    { type: "thinking", thinking: `fresh ${suffix}`, signature: `sig-${suffix}` },
                    { type: "text", text: `answer ${suffix}` },
                ],
            },
        ] as unknown as MessageLike[];

    // The host owns the top-level system string; each session keeps one
    // pending set across passes, as the plugin's live session state does.
    const hostSystems = new Map<string, string>();
    const pendingBySession = new Map<string, Set<string>>();
    const servedRequests = new Map<string, { system: string; messages: MessageLike[] }[]>();
    const serve = async (
        sessionId: string,
        messages: MessageLike[],
        options: { busting: boolean; boundModel?: boolean; fullFeatureMode?: boolean },
    ) => {
        const pending = pendingBySession.get(sessionId) ?? new Set<string>();
        pendingBySession.set(sessionId, pending);
        if (options.busting) {
            hostSystems.set(
                sessionId,
                `${hostSystems.get(sessionId) ?? "Original system prompt"}\nNext system revision`,
            );
            hostSystemChanged(sessionId, pending);
        }
        const result = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                resolvedProviderID: "anthropic",
                thinkingBindingRecoveryEnabledForModel: options.boundModel ?? true,
                fullFeatureMode: options.fullFeatureMode ?? true,
                pendingMaterializationSessions: pending,
                ...(options.busting ? {} : { schedulerDecision: "defer" as const }),
            }),
        );
        const requests = servedRequests.get(sessionId) ?? [];
        requests.push({
            system: hostSystems.get(sessionId) ?? "Original system prompt",
            messages: structuredClone(messages),
        });
        servedRequests.set(sessionId, requests);
        return result;
    };

    const openDb = () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        hostSystems.clear();
        pendingBySession.clear();
        servedRequests.clear();
    };

    it("a host system change strips older thinking with it; a failed strip refuses and the next pass retries", async () => {
        openDb();
        const sessionId = "ses-paired-system-request";
        await serve(sessionId, buildSession(sessionId), { busting: false });
        expect(servedRequests.get(sessionId)?.[0].system).toBe("Original system prompt");
        const changed = await serve(sessionId, buildSession(sessionId), { busting: true });
        expect(servedRequests.get(sessionId)?.[1].system).toBe(
            "Original system prompt\nNext system revision",
        );
        expect(changed.proactiveThinkingStrip?.messageIds).toEqual(ALL_ASSISTANTS);
        await serve(sessionId, buildSession(sessionId), { busting: false });
        expect(servedRequests.get(sessionId)?.[2]).toEqual(servedRequests.get(sessionId)?.[1]);
        await serve(sessionId, appendTurn(buildSession(sessionId), sessionId, "four"), {
            busting: false,
        });
        expect(
            reasoningCount(
                findMessage(servedRequests.get(sessionId)![3].messages, "assistant-four"),
            ),
        ).toBe(1);
        rejectSessionMetaCollectionWrites(
            db,
            "merged_reasoning_stripped_ids",
            "reject_system_companion",
            { error: "reject companion" },
        );
        await expect(
            serve(sessionId, appendTurn(buildSession(sessionId), sessionId, "four"), {
                busting: true,
            }),
        ).rejects.toMatchObject({ site: "proactive-thinking-strip-persistence-failure" });
        expect(servedRequests.get(sessionId)?.length).toBe(4);
        clearSessionMetaFixtureFault(db, "reject_system_companion");
        // The host already serves the new system, so the next pass owes the strip.
        const retried = await serve(
            sessionId,
            appendTurn(buildSession(sessionId), sessionId, "four"),
            {
                busting: false,
            },
        );
        expect(retried.proactiveThinkingStrip?.messageIds).toEqual(["assistant-four"]);
        const served = servedRequests.get(sessionId)![4];
        expect(served.system).toBe(
            "Original system prompt\nNext system revision\nNext system revision",
        );
        expect(reasoningCount(findMessage(served.messages, "assistant-four"))).toBe(0);
        await serve(sessionId, appendTurn(buildSession(sessionId), sessionId, "four"), {
            busting: false,
        });
        expect(servedRequests.get(sessionId)?.[5]).toEqual(served);
    });

    it("a budget-shrink HARD strips thinking on the resizing pass and not the next replay", async () => {
        openDb();
        const sessionId = "ses-proactive-budget-shrink";
        appendCompartments(db, sessionId, [
            {
                sequence: 1,
                startMessage: 1,
                endMessage: 1,
                startMessageId: "user-prefix",
                endMessageId: "user-prefix",
                title: "large history",
                content: "",
                p1: "history bytes ".repeat(500),
                p2: "dense",
                p3: "brief",
                p4: "anchor",
                importance: 100,
            },
        ]);
        const pass = (messages: MessageLike[], historyBudgetTokens: number) =>
            runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    resolvedProviderID: "anthropic",
                    thinkingBindingRecoveryEnabledForModel: true,
                    fullFeatureMode: true,
                    schedulerDecision: "defer",
                    m0M1: {
                        projectPath: "git:budget-shrink",
                        projectDirectory: "/nonexistent",
                        historyBudgetTokens,
                        historyBudgetPolicyIdentity: "p0.15:percentage:40",
                    },
                }),
            );
        await pass(buildSession(sessionId), 12000);
        const shrinking = appendTurn(buildSession(sessionId), sessionId, "shrink");
        const result = await pass(shrinking, 1);
        expect(result.materializeReason).toContain("render_config:budget_shrink(");
        expect(result.bustedThisPass).toBe(true);
        expect(result.proactiveThinkingStrip?.messageIds).toContain("assistant-shrink");
        expect(reasoningCount(findMessage(shrinking, "assistant-shrink"))).toBe(0);
        const replay = appendTurn(shrinking, sessionId, "after-shrink");
        const next = await pass(replay, 1);
        expect(next.materialized).toBe(false);
        expect(next.proactiveThinkingStrip).toBeNull();
        expect(reasoningCount(findMessage(replay, "assistant-after-shrink"))).toBe(1);
    });

    it("strips every thinking block on a busting pass; the next defer pass keeps the shared prefix hash", async () => {
        openDb();
        const sessionId = "ses-proactive-bust";
        await serve(sessionId, buildSession(sessionId), { busting: false });

        const passA = buildSession(sessionId, "re-rendered first user message");
        const resultA = await serve(sessionId, passA, { busting: true });
        expect(resultA.bustedThisPass).toBe(true);
        expect(resultA.proactiveThinkingStrip).toEqual({ messageIds: ALL_ASSISTANTS });
        for (const id of ALL_ASSISTANTS) expect(reasoningCount(findMessage(passA, id))).toBe(0);
        // The open tool round keeps its tool call.
        expect(findMessage(passA, "assistant-open-tool").parts[1]).toMatchObject({
            type: "tool",
            callID: "call-open",
        });
        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(
            new Set(ALL_ASSISTANTS.map((id) => `binding_mismatch:${id}`)),
        );

        const passB = appendTurn(
            buildSession(sessionId, "re-rendered first user message"),
            sessionId,
            "four",
        );
        const resultB = await serve(sessionId, passB, { busting: false });
        expect(resultB.proactiveThinkingStrip).toBeNull();
        expect(sha256(passB.slice(0, passA.length))).toBe(sha256(passA));
        expect(reasoningCount(findMessage(passB, "assistant-four"))).toBe(1);
    });

    for (const [providerID, modelID] of [
        ["google-vertex-anthropic", "claude-sonnet-5-5@20260930"],
        ["vertex-eu-anthropic", "claude-opus-5-5"],
        ["amazon-bedrock", "us.anthropic.claude-fable-5-1-v1:0"],
    ]) {
        it(`TS and Rust-mode host strip/replay parity for ${providerID}/${modelID}`, async () => {
            openDb();
            const outputs: MessageLike[][] = [];
            for (const rustMode of [false, true]) {
                const sessionId = `ses-cloud-parity-${rustMode}`;
                const postprocess = async (messages: MessageLike[], busting: boolean) => {
                    const enabled = isPrefixBoundThinkingModel(providerID, modelID);
                    if (rustMode) {
                        return runRustModePostprocess({
                            db,
                            sessionId,
                            messages,
                            fullFeatureMode: true,
                            resolvedProviderID: providerID,
                            thinkingBindingRecoveryEnabledForModel: enabled,
                            cacheBustingPass: busting,
                            tagger: createTagger(),
                            ctxReduceAvailability: { callable: true, frozen: true },
                        });
                    }
                    return runPostTransformPhase(
                        basePostTransformArgs(db, sessionId, messages, {
                            resolvedProviderID: providerID,
                            thinkingBindingRecoveryEnabledForModel: enabled,
                            ...(busting
                                ? { pendingMaterializationSessions: hostSystemChanged(sessionId) }
                                : { schedulerDecision: "defer" as const }),
                        }),
                    );
                };
                const cloudSession = () => {
                    const messages = buildSession(sessionId, "rebuilt prefix");
                    messages.push({
                        info: { id: "reasoning-only", role: "assistant", sessionID: sessionId },
                        parts: [{ type: "redacted_thinking", data: "signed-redacted" }],
                    } as unknown as MessageLike);
                    return messages;
                };
                const cloudAssistants = [...ALL_ASSISTANTS, "reasoning-only"];
                const initial = cloudSession();
                const original = JSON.stringify(initial);
                expect((await postprocess(initial, false)).proactiveThinkingStrip).toBeNull();
                expect(JSON.stringify(initial)).toBe(original);
                const bust = cloudSession();
                expect((await postprocess(bust, true)).proactiveThinkingStrip).toEqual({
                    messageIds: cloudAssistants,
                });
                expect(findMessage(bust, "reasoning-only").parts).toEqual([
                    { type: "text", text: "[dropped]" },
                ]);
                for (const id of cloudAssistants) {
                    expect(reasoningCount(findMessage(bust, id))).toBe(0);
                }
                for (let pass = 0; pass < 2; pass++) {
                    const replay = appendTurn(cloudSession(), sessionId, "four");
                    expect((await postprocess(replay, false)).proactiveThinkingStrip).toBeNull();
                    expect(JSON.stringify(replay.slice(0, bust.length))).toBe(JSON.stringify(bust));
                    expect(reasoningCount(findMessage(replay, "assistant-four"))).toBe(1);
                }
                const lkg = cloudSession();
                replayRustModeBindingMismatchStrips({
                    db,
                    sessionId,
                    messages: lkg,
                    resolvedProviderID: providerID,
                });
                expect(JSON.stringify(lkg)).toBe(JSON.stringify(bust));
                const recovery = appendTurn(cloudSession(), sessionId, "recovery");
                armThinkingBindingRecovery(db, sessionId, "all_reasoning_bearing_assistants");
                expect(
                    (await postprocess(recovery, false)).thinkingBindingRecovery?.messageIds,
                ).toContain("assistant-recovery");
                expect(reasoningCount(findMessage(recovery, "assistant-recovery"))).toBe(0);
                outputs.push(bust);
            }
            // Session routing metadata differs; provider-facing parts must not.
            expect(outputs[0].map((message) => message.parts)).toEqual(
                outputs[1].map((message) => message.parts),
            );
        });
    }

    it("replays a strip byte-identically on a reasoning-only assistant with a trailing blank", async () => {
        openDb();
        const sessionId = "ses-proactive-trailing-blank";
        // The trailing-blank normalization treats a message whose last content is
        // reasoning differently from one whose reasoning became an empty sentinel,
        // so the pass that first strips must finalize exactly as a replay does.
        const build = (withTail: boolean): MessageLike[] => {
            const messages = buildSession(sessionId).slice(0, 3);
            messages.splice(1, 1, {
                info: { id: "assistant-one", role: "assistant", sessionID: sessionId },
                parts: [
                    { type: "thinking", thinking: "signed one", signature: "sig-one" },
                    { type: "text", text: " " },
                ],
            } as unknown as MessageLike);
            return withTail ? appendTurn(messages, sessionId, "four") : messages;
        };
        const passA = build(false);
        const resultA = await serve(sessionId, passA, { busting: true });
        expect(resultA.proactiveThinkingStrip?.messageIds).toEqual(["assistant-one"]);
        const passB = build(true);
        await serve(sessionId, passB, { busting: false });
        expect(sha256(passB.slice(0, passA.length))).toBe(sha256(passA));
    });

    it("never strips on a defer pass, even when the served bytes changed", async () => {
        openDb();
        const sessionId = "ses-proactive-defer";
        await serve(sessionId, buildSession(sessionId), { busting: false });
        const deferPass = buildSession(sessionId, "changed without a bust");
        const before = JSON.stringify(deferPass);
        const result = await serve(sessionId, deferPass, { busting: false });
        expect(result.proactiveThinkingStrip).toBeNull();
        expect(JSON.stringify(deferPass)).toBe(before);
        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(new Set());
    });

    it("keeps thinking produced after a strip through defer passes until the next busting pass", async () => {
        openDb();
        const sessionId = "ses-proactive-multi-pass";
        const stripped = await serve(sessionId, buildSession(sessionId), { busting: true });
        expect(stripped.proactiveThinkingStrip?.messageIds).toEqual(ALL_ASSISTANTS);

        // Thinking produced after the strip survives two defer passes unchanged.
        const deferOne = appendTurn(buildSession(sessionId), sessionId, "four");
        await serve(sessionId, deferOne, { busting: false });
        const deferTwo = appendTurn(buildSession(sessionId), sessionId, "four");
        const deferTwoResult = await serve(sessionId, deferTwo, { busting: false });
        expect(deferTwoResult.proactiveThinkingStrip).toBeNull();
        expect(reasoningCount(findMessage(deferTwo, "assistant-four"))).toBe(1);
        expect(sha256(deferTwo)).toBe(sha256(deferOne));

        // The next busting pass strips it, and only it is new.
        const nextBust = appendTurn(buildSession(sessionId), sessionId, "four");
        const nextResult = await serve(sessionId, nextBust, { busting: true });
        expect(nextResult.proactiveThinkingStrip).toEqual({ messageIds: ["assistant-four"] });
        expect(reasoningCount(findMessage(nextBust, "assistant-four"))).toBe(0);
        expect(sha256(nextBust.slice(0, deferOne.length - 1))).toBe(
            sha256(deferOne.slice(0, deferOne.length - 1)),
        );
    });

    it("refuses and persists no strip decision when the frozen set cannot be written; the owed strip lands on the next pass", async () => {
        openDb();
        const sessionId = "ses-proactive-persist-failure";
        await serve(sessionId, buildSession(sessionId), { busting: false });
        rejectSessionMetaCollectionWrites(db, "merged_reasoning_stripped_ids", "refuse_freeze", {
            error: "transient freeze write failure",
        });
        const failed = buildSession(sessionId, "re-rendered first user message");
        const before = JSON.stringify(failed);
        await expect(serve(sessionId, failed, { busting: true })).rejects.toMatchObject({
            name: "DegradedPassRefusalError",
            site: "proactive-thinking-strip-persistence-failure",
        });
        expect(JSON.stringify(failed)).toBe(before);
        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(new Set());

        // With the store writable again, the failed pass left no strip decision
        // behind, but the host still serves the changed system prompt, so the
        // next pass owes the strip and lands it.
        clearSessionMetaFixtureFault(db, "refuse_freeze");
        const retry = buildSession(sessionId, "re-rendered first user message");
        const retryResult = await serve(sessionId, retry, { busting: false });
        expect(retryResult.proactiveThinkingStrip).toEqual({ messageIds: ALL_ASSISTANTS });
        const replay = buildSession(sessionId, "re-rendered first user message");
        expect(
            (await serve(sessionId, replay, { busting: false })).proactiveThinkingStrip,
        ).toBeNull();
        expect(JSON.stringify(replay)).toBe(JSON.stringify(retry));
    });

    it("leaves sessions on other models byte-identical on a busting pass", async () => {
        openDb();
        const sessionId = "ses-proactive-other-model";
        const pass = buildSession(sessionId, "re-rendered first user message");
        const before = JSON.stringify(pass);
        const result = await serve(sessionId, pass, { busting: true, boundModel: false });
        expect(result.proactiveThinkingStrip).toBeNull();
        expect(JSON.stringify(pass)).toBe(before);
        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(new Set());
    });

    // Subagents used to be left out. The age lane no longer removes reasoning on
    // prefix-bound models (an older removal invalidates every newer signed
    // block), so a busting pass strips subagents' thinking the same way.
    it("strips subagent sessions on a busting pass too", async () => {
        openDb();
        const sessionId = "ses-proactive-subagent";
        const pass = buildSession(sessionId, "re-rendered first user message");
        const result = await serve(sessionId, pass, { busting: true, fullFeatureMode: false });
        expect(result.proactiveThinkingStrip).toEqual({ messageIds: ALL_ASSISTANTS });
        for (const id of ALL_ASSISTANTS) expect(reasoningCount(findMessage(pass, id))).toBe(0);
    });

    it("strips Rust-mode subagents on a busting pass and replays it on defer", () => {
        openDb();
        const sessionId = "ses-proactive-rust-subagent";
        const postprocess = (messages: MessageLike[], cacheBustingPass: boolean) =>
            runRustModePostprocess({
                db,
                sessionId,
                messages,
                fullFeatureMode: false,
                resolvedProviderID: "anthropic",
                thinkingBindingRecoveryEnabledForModel: true,
                cacheBustingPass,
                tagger: createTagger(),
                ctxReduceAvailability: { callable: true, frozen: true },
            });
        const busting = buildSession(sessionId, "re-rendered first user message");
        expect(postprocess(busting, true).proactiveThinkingStrip).toEqual({
            messageIds: ALL_ASSISTANTS,
        });
        for (const id of ALL_ASSISTANTS) expect(reasoningCount(findMessage(busting, id))).toBe(0);
        const defer = buildSession(sessionId, "re-rendered first user message");
        expect(postprocess(defer, false).proactiveThinkingStrip).toBeNull();
        expect(sha256(defer)).toBe(sha256(busting));
    });

    it("strips through Rust-mode host postprocess only on a busting pass and replays it", () => {
        openDb();
        const sessionId = "ses-proactive-rust";
        const postprocess = (messages: MessageLike[], cacheBustingPass: boolean) =>
            runRustModePostprocess({
                db,
                sessionId,
                messages,
                fullFeatureMode: true,
                resolvedProviderID: "anthropic",
                thinkingBindingRecoveryEnabledForModel: true,
                cacheBustingPass,
                tagger: createTagger(),
                ctxReduceAvailability: { callable: true, frozen: true },
            });

        const deferChange = buildSession(sessionId, "re-rendered first user message");
        const deferBefore = JSON.stringify(deferChange);
        expect(postprocess(deferChange, false).proactiveThinkingStrip).toBeNull();
        expect(JSON.stringify(deferChange)).toBe(deferBefore);

        const busting = buildSession(sessionId, "re-rendered first user message");
        expect(postprocess(busting, true).proactiveThinkingStrip).toEqual({
            messageIds: ALL_ASSISTANTS,
        });
        expect(findMessage(busting, "assistant-open-tool").parts[1]).toMatchObject({
            type: "tool",
            callID: "call-open",
        });

        const defer = appendTurn(
            buildSession(sessionId, "re-rendered first user message"),
            sessionId,
            "four",
        );
        expect(postprocess(defer, false).proactiveThinkingStrip).toBeNull();
        expect(sha256(defer.slice(0, busting.length))).toBe(sha256(busting));
        expect(reasoningCount(findMessage(defer, "assistant-four"))).toBe(1);

        // The last-known-good replay applies the same persisted set.
        const lkgReplay = buildSession(sessionId, "re-rendered first user message");
        replayRustModeBindingMismatchStrips({
            db,
            sessionId,
            messages: lkgReplay,
            resolvedProviderID: "anthropic",
        });
        expect(sha256(lkgReplay)).toBe(sha256(busting));
    });

    it("strips nothing through Rust-mode host postprocess when the frozen set cannot be written", () => {
        openDb();
        const sessionId = "ses-proactive-rust-persist-failure";
        getOrCreateSessionMeta(db, sessionId);
        rejectSessionMetaCollectionWrites(db, "merged_reasoning_stripped_ids", "refuse_freeze", {
            error: "transient freeze write failure",
        });
        const busting = buildSession(sessionId);
        const before = JSON.stringify(busting);
        const result = runRustModePostprocess({
            db,
            sessionId,
            messages: busting,
            fullFeatureMode: true,
            resolvedProviderID: "anthropic",
            thinkingBindingRecoveryEnabledForModel: true,
            cacheBustingPass: true,
            tagger: createTagger(),
            ctxReduceAvailability: { callable: true, frozen: true },
        });
        expect(result.proactiveThinkingStrip).toBeNull();
        expect(JSON.stringify(busting)).toBe(before);
    });
});

// Each test is named after the row of Anthropic's "What counts as an edit" table
// (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking) that
// the behavior relies on.
describe("issue 619 first-application thinking accounting", () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]) {
        for (const lane of ["image", "stale reduce", "sentinel"] as const) {
            it(`${lane} alone invalidates later signed thinking on ${model}`, async () => {
                db = new Database(":memory:");
                initializeDatabase(db);
                const sessionId = `accounting-${lane}-${model}`;
                getOrCreateSessionMeta(db, sessionId);
                updateSessionMeta(db, sessionId, { isSubagent: true });
                const raw = [
                    {
                        info: { id: "head-user", role: "user" },
                        parts: [{ type: "text", text: "first request" }],
                    },
                    {
                        info: { id: "edit-owner", role: lane === "image" ? "user" : "assistant" },
                        parts:
                            lane === "image"
                                ? [
                                      {
                                          type: "file",
                                          mime: "image/png",
                                          url: `data:image/png;base64,${"a".repeat(220)}`,
                                      },
                                  ]
                                : lane === "stale reduce"
                                  ? [
                                        {
                                            type: "tool",
                                            tool: "ctx_reduce",
                                            callID: "old-reduce",
                                            state: {
                                                status: "completed",
                                                input: { drop: "1" },
                                                output: "Queued",
                                            },
                                        },
                                    ]
                                  : [{ type: "text", text: "[dropped §1§]" }],
                    },
                    {
                        info: { id: "middle-user", role: "user" },
                        parts: [{ type: "text", text: "next request" }],
                    },
                    {
                        info: { id: "a1", role: "assistant" },
                        parts: [
                            {
                                type: "reasoning",
                                text: "signed one",
                                metadata: { anthropic: { signature: "sig-one" } },
                            },
                            { type: "text", text: "answer one" },
                        ],
                    },
                    {
                        info: { id: "later-user", role: "user" },
                        parts: [{ type: "text", text: "last request" }],
                    },
                    {
                        info: { id: "a2", role: "assistant" },
                        parts: [
                            {
                                type: "reasoning",
                                text: "signed two",
                                metadata: { anthropic: { signature: "sig-two" } },
                            },
                            { type: "text", text: "answer two" },
                        ],
                    },
                ] as MessageLike[];
                addTrailingBlankDecisions(db, sessionId, [
                    ["edit-owner", "strip"],
                    ["a1", "strip"],
                    ["a2", "strip"],
                ]);
                const serve = async (decision: "execute" | "defer") => {
                    const messages = structuredClone(raw);
                    const result = await runPostTransformPhase(
                        basePostTransformArgs(db, sessionId, messages, {
                            fullFeatureMode: false,
                            resolvedProviderID: "anthropic",
                            thinkingBindingRecoveryEnabledForModel: isPrefixBoundThinkingModel(
                                "anthropic",
                                model,
                            ),
                            schedulerDecision: decision,
                            schedulerDeferReason: undefined,
                            contextUsage: { percentage: 70, inputTokens: 70000 },
                            watermark: lane === "image" ? 1 : 0,
                            messageTagNumbers: new Map([[messages[1], 1]]),
                        }),
                    );
                    return { messages, result };
                };
                const baseline = await serve("defer");
                const applied = await serve("execute");
                expect(JSON.stringify(applied.messages)).not.toBe(
                    JSON.stringify(baseline.messages),
                );
                expect(applied.result.bustedThisPass).toBe(true);
                expect(applied.result.proactiveThinkingStrip?.messageIds).toEqual(["a1", "a2"]);
                expect(
                    applied.messages
                        .flatMap((message) => message.parts)
                        .some((part) => part.type === "reasoning"),
                ).toBe(false);
                for (const decision of ["defer", "execute"] as const) {
                    const replay = await serve(decision);
                    expect(JSON.stringify(replay.messages)).toBe(JSON.stringify(applied.messages));
                    expect(replay.result.bustedThisPass).toBe(false);
                    expect(replay.result.proactiveThinkingStrip).toBeNull();
                }
            });
        }
    }
});

describe("issue 619 metadata-only trailing decisions", () => {
    for (const [name, isSubagent, model] of [
        ["primary bound", false, "claude-sonnet-5-5"],
        ["subagent unbound", true, "claude-sonnet-4-5"],
        ["subagent bound", true, "claude-sonnet-5-5"],
    ] as const) {
        it(`${name} keeps bytes and reports no bust when a historical strip already matches`, async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = `metadata-only-${name}`;
            getOrCreateSessionMeta(db, sessionId);
            updateSessionMeta(db, sessionId, { isSubagent });
            const raw = [
                { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "one" }] },
                {
                    info: { id: "a1", role: "assistant" },
                    parts: [
                        {
                            type: "reasoning",
                            text: "signed one",
                            metadata: { anthropic: { signature: "sig-one" } },
                        },
                        { type: "text", text: "answer one" },
                    ],
                },
                { info: { id: "u2", role: "user" }, parts: [{ type: "text", text: "two" }] },
                {
                    info: { id: "a2", role: "assistant" },
                    parts: [
                        {
                            type: "reasoning",
                            text: "signed two",
                            metadata: { anthropic: { signature: "sig-two" } },
                        },
                        { type: "text", text: "answer two" },
                    ],
                },
            ] as MessageLike[];
            const pass = async (schedulerDecision: "defer" | "execute") => {
                const messages = structuredClone(raw);
                const result = await runPostTransformPhase(
                    basePostTransformArgs(db, sessionId, messages, {
                        fullFeatureMode: !isSubagent,
                        resolvedProviderID: "anthropic",
                        thinkingBindingRecoveryEnabledForModel: isPrefixBoundThinkingModel(
                            "anthropic",
                            model,
                        ),
                        schedulerDecision,
                        schedulerDeferReason: undefined,
                        contextUsage: { percentage: 70, inputTokens: 70000 },
                    }),
                );
                return { messages, result };
            };
            const baseline = await pass("defer");
            expect(getTrailingBlankDecisions(db, sessionId).has("a1")).toBe(false);
            for (let index = 0; index < 3; index++) {
                const execute = await pass("execute");
                expect(JSON.stringify(execute.messages)).toBe(JSON.stringify(baseline.messages));
                expect(execute.result.bustedThisPass).toBe(false);
                expect(execute.result.proactiveThinkingStrip).toBeNull();
            }
            expect(getTrailingBlankDecisions(db, sessionId).has("a1")).toBe(isSubagent);
        });
    }
});

describe("issue 619 terminal first edits", () => {
    for (const [lane, placement, name] of [
        [
            "image",
            "terminal",
            "primary terminal image edit preserves thinking whose preceding prefix is unchanged",
        ],
        [
            "stale",
            "terminal",
            "primary terminal stale edit preserves thinking whose preceding prefix is unchanged",
        ],
        [
            "sentinel",
            "terminal",
            "primary terminal sentinel edit preserves thinking whose preceding prefix is unchanged",
        ],
        [
            "stale",
            "same-message",
            "terminal stale part after its own signed block preserves the untouched prefix",
        ],
        [
            "image",
            "frozen-later",
            "terminal image edit ignores later thinking already frozen for removal",
        ],
    ] as const) {
        it(name, async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = `terminal-${lane}`;
            getOrCreateSessionMeta(db, sessionId);
            updateSessionMeta(db, sessionId, { isSubagent: false });
            const raw = [
                { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "one" }] },
                {
                    info: { id: "a1", role: "assistant" },
                    parts: [
                        {
                            type: "reasoning",
                            text: "signed one",
                            metadata: { anthropic: { signature: "sig-one" } },
                        },
                        { type: "text", text: "answer one" },
                    ],
                },
                { info: { id: "u2", role: "user" }, parts: [{ type: "text", text: "two" }] },
                {
                    info: { id: "edit", role: lane === "image" ? "user" : "assistant" },
                    parts:
                        lane === "image"
                            ? [
                                  {
                                      type: "file",
                                      mime: "image/png",
                                      url: `data:image/png;base64,${"a".repeat(220)}`,
                                  },
                              ]
                            : lane === "stale"
                              ? [
                                    {
                                        type: "tool",
                                        tool: "ctx_reduce",
                                        callID: "terminal-reduce",
                                        state: {
                                            status: "completed",
                                            input: { drop: "1" },
                                            output: "Queued",
                                        },
                                    },
                                ]
                              : [{ type: "text", text: "[dropped §1§]" }],
                },
                { info: { id: "u3", role: "user" }, parts: [{ type: "text", text: "three" }] },
                {
                    info: { id: "a2", role: "assistant" },
                    parts: [{ type: "text", text: "plain answer" }],
                },
            ] as MessageLike[];
            if (placement === "same-message") {
                raw[1].parts.push(raw[3].parts[0]);
                raw.splice(3, 1);
            }
            if (placement === "frozen-later") {
                raw[5].parts.unshift({
                    type: "reasoning",
                    text: "already frozen",
                    metadata: { anthropic: { signature: "sig-two" } },
                });
                addMergedReasoningStrippedIds(db, sessionId, ["binding_mismatch:a2"]);
            }
            addTrailingBlankDecisions(db, sessionId, [
                ["a1", "strip"],
                ["edit", "strip"],
                ["a2", "strip"],
            ]);
            const pass = async (force: boolean) => {
                const messages = structuredClone(raw);
                const result = await runPostTransformPhase(
                    basePostTransformArgs(db, sessionId, messages, {
                        resolvedProviderID: "anthropic",
                        thinkingBindingRecoveryEnabledForModel: isPrefixBoundThinkingModel(
                            "anthropic",
                            "claude-sonnet-5-5",
                        ),
                        contextUsage: {
                            percentage: force ? 96 : 20,
                            inputTokens: force ? 96000 : 20000,
                        },
                        watermark: lane === "image" ? 1 : 0,
                        messageTagNumbers: new Map([[messages[3], 1]]),
                    }),
                );
                return { messages, result };
            };
            const baseline = await pass(false);
            const edited = await pass(true);
            expect(
                edited.messages
                    .flatMap((message) => message.parts)
                    .filter((part) => part.type === "reasoning"),
            ).toHaveLength(1);
            if (placement === "same-message")
                expect(JSON.stringify(edited.messages[1].parts[0])).toBe(
                    JSON.stringify(baseline.messages[1].parts[0]),
                );
            else
                expect(JSON.stringify(edited.messages.slice(0, 3))).toBe(
                    JSON.stringify(baseline.messages.slice(0, 3)),
                );
            expect(JSON.stringify(edited.messages)).not.toBe(JSON.stringify(baseline.messages));
            expect(edited.result.bustedThisPass).toBe(true);
            expect(edited.result.proactiveThinkingStrip).toBeNull();
            expect(edited.result.materialized).toBe(false);
            for (const force of [false, true]) {
                const replay = await pass(force);
                expect(JSON.stringify(replay.messages)).toBe(JSON.stringify(edited.messages));
                expect(replay.result.bustedThisPass).toBe(false);
                expect(replay.result.proactiveThinkingStrip).toBeNull();
            }
        });
    }
});

describe("prefix-bound all-or-none reasoning", () => {
    const PROVIDER = "google-vertex-anthropic";
    const sha256 = (value: unknown): string =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const reasoningCount = (message: MessageLike): number =>
        message.parts.filter((part) => (part as { type?: unknown }).type === "reasoning").length;

    /**
     * One user message (tag 1) and `steps` assistant steps; step i carries a
     * signed reasoning part and a completed tool call and owns tag i + 2.
     */
    const boundLoop = (sessionId: string, steps: number, options: { untagged?: number } = {}) => {
        const messages: MessageLike[] = [
            {
                // A historical context carrier, not the active real-user request.
                info: { id: "user-0", role: "user", sessionID: sessionId, synthetic: true },
                parts: [{ type: "text", text: "do the work" }],
            } as unknown as MessageLike,
        ];
        const tags = new Map<MessageLike, number>([[messages[0], 1]]);
        for (let step = 0; step < steps; step += 1) {
            const message = {
                info: {
                    id: `assistant-${step}`,
                    role: "assistant",
                    sessionID: sessionId,
                    tokens: { reasoning: 100 },
                },
                parts: [
                    {
                        type: "reasoning",
                        text: `signed ${step}`,
                        metadata: { anthropic: { signature: `sig-${step}` } },
                    },
                    {
                        type: "tool",
                        tool: "bash",
                        callID: `call-${step}`,
                        state: {
                            status: "completed",
                            input: {},
                            output: `out ${step} `.repeat(200),
                        },
                    },
                ],
            } as unknown as MessageLike;
            messages.push(message);
            if (options.untagged !== step) tags.set(message, step + 2);
        }
        return { messages, tags };
    };

    const serve = (
        sessionId: string,
        session: ReturnType<typeof boundLoop>,
        options: {
            /** A force-band pass: busting, with no drop, fold or materialization of its own. */
            force?: boolean;
            /** A requested materialization, which also busts. */
            flush?: boolean;
            fullFeatureMode?: boolean;
            clearReasoningAge?: number;
            overrides?: Partial<PostTransformArgs>;
        } = {},
    ) =>
        runPostTransformPhase(
            basePostTransformArgs(db, sessionId, session.messages, {
                resolvedProviderID: PROVIDER,
                thinkingBindingRecoveryEnabledForModel: true,
                messageTagNumbers: session.tags,
                keepReasoningTokens: options.clearReasoningAge === 999 ? 100_000 : 300,
                fullFeatureMode: options.fullFeatureMode ?? true,
                contextUsage: options.force
                    ? { percentage: 96, inputTokens: 96_000 }
                    : { percentage: 20, inputTokens: 1000 },
                ...(options.flush
                    ? { pendingMaterializationSessions: hostSystemChanged(sessionId) }
                    : {}),
                ...options.overrides,
            }),
        );

    const openDb = () => {
        db = new Database(":memory:");
        initializeDatabase(db);
    };
    const message = (session: ReturnType<typeof boundLoop>, id: string) =>
        findMessage(session.messages, id);
    const AGED = [0, 1, 2, 3, 4].map((step) => `assistant-${step}`);
    const NEWER = [5, 6, 7].map((step) => `assistant-${step}`);

    for (const fullFeatureMode of [true, false]) {
        const who = fullFeatureMode ? "primary" : "subagent";
        it(`${who}: a pressure opportunity alone keeps every signed block byte-identical instead of trimming an older prefix`, async () => {
            openDb();
            const sessionId = `ses-bound-trim-only-${who}`;
            const served = boundLoop(sessionId, 8);
            await serve(sessionId, served, { fullFeatureMode });
            expect(served.messages.slice(1).every((m) => reasoningCount(m) === 1)).toBe(true);

            const trim = boundLoop(sessionId, 8);
            const result = await serve(sessionId, trim, { force: true, fullFeatureMode });
            expect(getRemovedReasoningIds(db, sessionId)).toEqual(new Set());
            for (const id of AGED) expect(reasoningCount(message(trim, id))).toBe(1);
            // Nothing else changed, so no newer block is stripped.
            expect(result.proactiveThinkingStrip).toBeNull();
            expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(new Set());
            for (const id of NEWER) {
                expect(JSON.stringify(message(trim, id))).toBe(JSON.stringify(message(served, id)));
            }

            for (const steps of [8, 10]) {
                const defer = boundLoop(sessionId, steps);
                const deferResult = await serve(sessionId, defer, { fullFeatureMode });
                expect(deferResult.proactiveThinkingStrip).toBeNull();
                expect(sha256(defer.messages.slice(0, trim.messages.length))).toBe(
                    sha256(trim.messages),
                );
            }
        });
    }

    it('"Clear or shorten an earlier `tool_result`" invalidates every later block, so a pass that trims and also applies a drop strips every signed block', async () => {
        openDb();
        const sessionId = "ses-bound-trim-and-drop";
        await serve(sessionId, boundLoop(sessionId, 8));
        const pass = boundLoop(sessionId, 8);
        const dropped = message(pass, "assistant-6");
        insertTag(db, sessionId, "call-6", "tool", 1000, 8, 0, "bash", 0, "assistant-6");
        padRecentToolSkeletonWindow(sessionId, 9);
        queuePendingOp(db, sessionId, 8, "drop");
        const result = await serve(sessionId, pass, {
            force: true,
            overrides: { targets: new Map([[8, makeDropTarget(dropped)]]) },
        });
        expect(getPendingOps(db, sessionId)).toHaveLength(0);
        expect(getRemovedReasoningIds(db, sessionId)).toEqual(new Set());
        expect(result.proactiveThinkingStrip?.messageIds).toEqual(
            expect.arrayContaining([...AGED, ...NEWER]),
        );
        for (const m of pass.messages.slice(1)) expect(reasoningCount(m)).toBe(0);
    });

    it("a durable top-level system edit strips every signed block without changing the shared message prefix", async () => {
        openDb();
        const sessionId = "ses-bound-trim-and-flush";
        await serve(sessionId, boundLoop(sessionId, 8));
        const pass = boundLoop(sessionId, 8);
        const result = await serve(sessionId, pass, { flush: true });
        expect(getRemovedReasoningIds(db, sessionId)).toEqual(new Set());
        expect(result.proactiveThinkingStrip?.messageIds).toEqual(expect.arrayContaining(NEWER));
        for (const m of pass.messages.slice(1)) expect(reasoningCount(m)).toBe(0);
    });

    it("a missing tag cannot authorize partial stripping before kept signed thinking", async () => {
        openDb();
        const sessionId = "ses-bound-gap";
        await serve(sessionId, boundLoop(sessionId, 8, { untagged: 2 }));
        const pass = boundLoop(sessionId, 8, { untagged: 2 });
        const result = await serve(sessionId, pass, { force: true });
        expect(result.proactiveThinkingStrip).toBeNull();
        expect(getRemovedReasoningIds(db, sessionId)).toEqual(new Set());
        for (const step of [0, 1, 2, 3, 4, 5, 6, 7]) {
            expect(reasoningCount(message(pass, `assistant-${step}`))).toBe(1);
        }
    });

    it("full-bust omissions never return and newer blocks are not partially stripped", async () => {
        openDb();
        const sessionId = "ses-bound-never-restore";
        await serve(sessionId, boundLoop(sessionId, 8));
        await serve(sessionId, boundLoop(sessionId, 8), { force: true });
        expect(getRemovedReasoningIds(db, sessionId)).toEqual(new Set());

        // A later busting pass that selects nothing new still serves the removal.
        const quiet = boundLoop(sessionId, 8);
        await serve(sessionId, quiet, { force: true, clearReasoningAge: 999 });
        for (const id of AGED) expect(reasoningCount(message(quiet, id))).toBe(1);

        // A materializing pass strips everything; the strip set is replayed.
        const flush = boundLoop(sessionId, 8);
        await serve(sessionId, flush, { flush: true });
        for (const m of flush.messages.slice(1)) expect(reasoningCount(m)).toBe(0);

        // New steps arrive. The trim passes over the stripped messages and
        // removes the newly aged steps, without stripping the newest ones.
        const grown = boundLoop(sessionId, 14);
        const result = await serve(sessionId, grown, { force: true });
        expect(result.proactiveThinkingStrip).toBeNull();
        for (const step of [0, 1, 2, 3, 4, 5, 6, 7]) {
            expect(reasoningCount(message(grown, `assistant-${step}`))).toBe(0);
        }
        for (const step of [8, 9, 10, 11, 12, 13]) {
            expect(reasoningCount(message(grown, `assistant-${step}`))).toBe(1);
        }
        expect(getRemovedReasoningIds(db, sessionId)).toEqual(new Set());
    });

    it("timeout skips do not treat provisional hint rows as served prefix edits", async () => {
        openDb();
        let provisional = false;
        const spy = spyOn(autoSearchRunner, "runAutoSearchHint").mockImplementation(
            async ({ sessionId }) => {
                if (provisional)
                    replayStorage.appendAutoSearchHintDecision(db, sessionId, {
                        messageId: "fresh-user",
                        decision: "hint",
                        text: "\n\n<ctx-search-hint>unserved row</ctx-search-hint>",
                    });
                return { ok: false, kind: "timeout" };
            },
        );
        try {
            const outputs: string[] = [];
            for (const writeRow of [false, true]) {
                provisional = writeRow;
                const sessionId = `ses-skip-provisional-${writeRow}`;
                const warm = boundLoop(sessionId, 8);
                warm.messages.push({
                    info: { id: "fresh-user", role: "user" },
                    parts: [{ type: "text", text: "new question" }],
                } as unknown as MessageLike);
                await serve(sessionId, warm, { clearReasoningAge: 999 });
                const pass = boundLoop(sessionId, 8);
                pass.messages.push({
                    info: { id: "fresh-user", role: "user" },
                    parts: [{ type: "text", text: "new question" }],
                } as unknown as MessageLike);
                const result = await serve(sessionId, pass, {
                    force: true,
                    clearReasoningAge: 999,
                    overrides: {
                        projectPath: "git:throwaway",
                        autoSearch: { enabled: true, scoreThreshold: 0, minPromptChars: 1 },
                    },
                });
                expect(result.proactiveThinkingStrip).toBeNull();
                outputs.push(
                    JSON.stringify(
                        pass.messages.map((message) => ({
                            role: message.info.role,
                            parts: message.parts,
                        })),
                    ),
                );
            }
            expect(outputs[1]).toBe(outputs[0]);
            expect(outputs[1]).toContain("signed 7");
        } finally {
            spy.mockRestore();
        }
    });

    it("a served hint rides a durable system edit and its defer replay is byte-identical", async () => {
        openDb();
        const embedding = await import("../../features/magic-context/memory/embedding");
        const worker = await import("./auto-search-worker-client");
        const { autoSearchTestSnapshot } = await import("./auto-search-snapshot.fixture");
        const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(
            autoSearchTestSnapshot("git:review-healthy"),
        );
        const search = spyOn(worker, "searchAutoHint").mockResolvedValue([
            {
                source: "memory",
                content: "historian cache wiring details",
                score: 1,
                memoryId: 1,
                category: "ARCHITECTURE_DECISIONS",
                matchType: "fts",
            },
        ]);
        const sessionId = "review-healthy-thinking";
        const fresh = () =>
            ({
                info: { id: "fresh-user", role: "user" },
                parts: [{ type: "text", text: "historian cache wiring details" }],
            }) as MessageLike;
        try {
            const warm = boundLoop(sessionId, 8);
            warm.messages.push(fresh());
            await serve(sessionId, warm, { clearReasoningAge: 999 });
            const pass = boundLoop(sessionId, 8);
            pass.messages.push(fresh());
            const result = await serve(sessionId, pass, {
                force: true,
                clearReasoningAge: 999,
                overrides: {
                    pendingMaterializationSessions: hostSystemChanged(sessionId, new Set(), {
                        materialize: false,
                    }),
                    projectPath: "git:review-healthy",
                    autoSearch: { enabled: true, scoreThreshold: 0, minPromptChars: 1 },
                },
            });
            expect(search).toHaveBeenCalledTimes(1);
            expect(JSON.stringify(pass.messages)).toContain("<ctx-search-hint>");
            expect(result.proactiveThinkingStrip?.messageIds).toHaveLength(8);
            expect(JSON.stringify(pass.messages)).not.toContain("signed 7");
            const defer = boundLoop(sessionId, 8);
            defer.messages.push(fresh());
            const replay = await serve(sessionId, defer, {
                clearReasoningAge: 999,
                overrides: {
                    projectPath: "git:review-healthy",
                    autoSearch: { enabled: true, scoreThreshold: 0, minPromptChars: 1 },
                },
            });
            expect(replay.proactiveThinkingStrip).toBeNull();
            const bytes = (messages: MessageLike[]) =>
                JSON.stringify(
                    messages.map((message) => ({ role: message.info.role, parts: message.parts })),
                );
            expect(bytes(defer.messages)).toBe(bytes(pass.messages));
        } finally {
            search.mockRestore();
            snapshot.mockRestore();
        }
    });

    it("Rust-mode host keeps newer blocks on a module bust whose only edit is the oldest-prefix trim, and strips them otherwise", () => {
        openDb();
        const postprocess = (
            sessionId: string,
            messages: MessageLike[],
            moduleReasoningTrimOnly: boolean,
        ) =>
            runRustModePostprocess({
                db,
                sessionId,
                messages,
                fullFeatureMode: true,
                resolvedProviderID: PROVIDER,
                thinkingBindingRecoveryEnabledForModel: true,
                cacheBustingPass: true,
                moduleReasoningTrimOnly,
                tagger: createTagger(),
                ctxReduceAvailability: { callable: true, frozen: true },
            });
        const kept = boundLoop("ses-rust-trim-only", 8).messages;
        const before = JSON.stringify(kept);
        expect(postprocess("ses-rust-trim-only", kept, true).proactiveThinkingStrip).toBeNull();
        expect(JSON.stringify(kept)).toBe(before);

        const stripped = boundLoop("ses-rust-other-edit", 8).messages;
        expect(
            postprocess("ses-rust-other-edit", stripped, false).proactiveThinkingStrip?.messageIds,
        ).toHaveLength(8);
        for (const m of stripped.slice(1)) expect(reasoningCount(m)).toBe(0);
    });
});
function seedProtectedReviewSession(id: string, tool = "probe", repeats = 3000) {
    db = new Database(":memory:");
    initializeDatabase(db);
    const add = (number: number): MessageLike => {
        insertTag(
            db,
            id,
            `call-${number}`,
            "tool",
            repeats * 5,
            number,
            0,
            tool,
            0,
            `owner-${number}`,
            null,
            { tokenCount: repeats, inputTokenCount: 0, reasoningTokenCount: 0 },
        );
        return {
            info: { id: `owner-${number}`, role: "assistant" },
            parts: [
                {
                    type: "tool",
                    tool,
                    callID: `call-${number}`,
                    state: { status: "completed", input: {}, output: "word ".repeat(repeats) },
                },
            ],
        } as MessageLike;
    };
    return { add };
}

it("impossible protected reclaim refuses an over-limit wire before provider rejection", async () => {
    const id = "protected-impossible-reclaim";
    const { add } = seedProtectedReviewSession(id, "probe", 12000);
    const messages = Array.from({ length: 8 }, (_, index) => add(index + 1));
    const total = estimateMessageTokens(messages[0]).toolCall * messages.length;
    expect(total).toBeGreaterThan(16000);
    const result = await runPostTransformPhase(
        basePostTransformArgs(db, id, messages, {
            tags: getActiveTagsBySession(db, id),
            protectedTools: { probe: 8 },
            targets: new Map(
                messages.map((message, index) => [index + 1, makeDropTarget(message)]),
            ),
            schedulerDecision: "execute",
            contextUsage: { percentage: 100, inputTokens: total },
            usableWindow: 16000,
            emergencyCeilingTokens: 16000,
        }),
    );
    expect(result.emergencyReclaimedTokens).toBe(0);
    expect(getTagsBySession(db, id).every((tag) => tag.status === "active")).toBe(true);
    expect(
        messages.reduce((sum, message) => sum + estimateMessageTokens(message).toolCall, 0),
    ).toBeGreaterThan(16000);
    expect(
        evaluateEmergencyFailClosed({
            usagePercentage: 100,
            emergencyRecoveryArmed: false,
            emergencyRecoveryOrigin: null,
            foldMaterializedThisPass: false,
            finalWireEstimate: {
                tokens: total,
                trusted: true,
                refusalGrade: true,
                refusalTokens: total,
            },
            providerProvenLimitTokens: 16000,
            protectedToolTokens: total,
        }).shouldAbort,
    ).toBe(true);
});
it("newest protected ctx_reduce results survive automatic stale stripping", async () => {
    const id = "protected-stale-reduce";
    const { add } = seedProtectedReviewSession(id, "ctx_reduce");
    const messages = [
        add(1),
        add(2),
        add(3),
        ...Array.from(
            { length: 30 },
            (_, n) =>
                ({
                    info: { id: `later-${n}`, role: n % 2 ? "assistant" : "user" },
                    parts: [{ type: "text", text: `later unrelated message ${n}` }],
                }) as MessageLike,
        ),
    ];
    const before = JSON.stringify(messages.slice(0, 3));
    await runPostTransformPhase(
        basePostTransformArgs(db, id, messages, {
            tags: getActiveTagsBySession(db, id),
            schedulerDecision: "execute",
            pendingMaterializationSessions: new Set([id]),
            protectedCount: 20,
            resolvedProviderID: "anthropic",
        }),
    );
    expect(getTagsBySession(db, id).every((tag) => tag.status === "active")).toBe(true);
    expect(JSON.stringify(messages.slice(0, 3))).toBe(before);
});
it("protected map edits on SOFT+ leave U and the Channel 2 lease unchanged until rebuilding", async () => {
    const id = "protected-map-nudge";
    const { add } = seedProtectedReviewSession(id, "probe", 12000);
    const messages = [
        add(1),
        {
            info: { id: "tail", role: "user" },
            parts: [{ type: "text", text: "continue" }],
        } as MessageLike,
    ];
    const state = new Map<string, Channel1State>();
    const run = (overrides: Partial<PostTransformArgs> = {}) =>
        runPostTransformPhase(
            basePostTransformArgs(db, id, messages, {
                tags: getActiveTagsBySession(db, id),
                channel1StateBySession: state,
                ...overrides,
            }),
        );
    await run();
    const before = JSON.stringify(messages);
    const previousU = effectiveTailHygiene(state.get(id)!).u;
    expect(previousU).toBeGreaterThan(6000);
    setChannel2NudgeState(db, id, "delivered");
    const deferred = await run({ protectedTools: { probe: 1 } });
    expect(deferred.bustedThisPass).toBe(false);
    expect(JSON.stringify(messages)).toBe(before);
    expect({
        u: effectiveTailHygiene(state.get(id)!).u,
        lease: getChannel2NudgeState(db, id),
    }).toEqual({ u: previousU, lease: "delivered" });
    // This queued drop changes the request bytes, unlike replaying an unchanged baseline.
    const trigger = makeToolMessage("flush-trigger");
    messages.splice(1, 0, trigger);
    insertTag(db, id, "flush-call", "tool", 4000, 2, 0, "bash", 0, "flush-trigger");
    queuePendingOp(db, id, 2, "drop");
    const rebuilt = await run({
        protectedTools: { probe: 1 },
        targets: new Map([[2, makeDropTarget(trigger)]]),
        pendingMaterializationSessions: new Set([id]),
    });
    expect(rebuilt.bustedThisPass).toBe(true);
    expect(effectiveTailHygiene(state.get(id)!).u).toBeLessThanOrEqual(6000);
    expect(getChannel2NudgeState(db, id)).toBe("");
});

it("legacy default-only upgrade does not rearm Channel 2 on SOFT+", async () => {
    const id = "protected-default-upgrade";
    const { add } = seedProtectedReviewSession(id, "todowrite", 12000);
    const messages = [
        add(1),
        {
            info: { id: "tail", role: "user" },
            parts: [{ type: "text", text: "continue" }],
        } as MessageLike,
    ];
    const previous = refreshTailHygieneBaseline({
        messages,
        tags: getActiveTagsBySession(db, id),
        protectedTagNumbers: new Set(),
        protectedTools: { todowrite: 0 },
        cacheBusting: true,
    });
    // Legacy baselines have no saved policy; they protect three ctx_reduce results
    // but do not protect todowrite results.
    delete previous.protectedToolsPolicy;
    expect(effectiveTailHygiene(previous).u).toBeGreaterThan(6000);
    const state = new Map<string, Channel1State>([
        [
            id,
            {
                ...previous,
                usableWindow: 128000,
                realUserTurnCount: 1,
                reducedSinceRefresh: false,
                oldestReclaimableToolTags: [],
            },
        ],
    ]);
    setChannel2NudgeState(db, id, "delivered");
    const before = JSON.stringify(messages);
    const result = await runPostTransformPhase(
        basePostTransformArgs(db, id, messages, {
            tags: getActiveTagsBySession(db, id),
            channel1StateBySession: state,
        }),
    );
    expect(result.bustedThisPass).toBe(false);
    expect(JSON.stringify(messages)).toBe(before);
    expect(effectiveTailHygiene(state.get(id)!).u).toBe(effectiveTailHygiene(previous).u);
    expect(getChannel2NudgeState(db, id)).toBe("delivered");
});

it("rotation on SOFT+ preserves served bytes and keeps queued mass out of U", async () => {
    const id = "protected-nudge-rotation";
    const { add } = seedProtectedReviewSession(id);
    const first = add(1);
    const messages = [
        first,
        {
            info: { id: "tail", role: "user" },
            parts: [{ type: "text", text: "continue" }],
        } as MessageLike,
    ];
    const state = new Map<string, Channel1State>();
    queuePendingOp(db, id, 1, "drop");
    const run = () =>
        runPostTransformPhase(
            basePostTransformArgs(db, id, messages, {
                tags: getActiveTagsBySession(db, id),
                protectedTools: { probe: 1 },
                channel1StateBySession: state,
                targets: new Map([[1, makeDropTarget(first)]]),
            }),
        );
    await run();
    const before = JSON.stringify(messages);
    const beforeU = effectiveTailHygiene(state.get(id)!).u;
    messages.push(add(2));
    const result = await run();
    expect(result.bustedThisPass).toBe(false);
    expect(JSON.stringify(messages.slice(0, 2))).toBe(before);
    expect(getPendingOps(db, id)).toHaveLength(1);
    expect(effectiveTailHygiene(state.get(id)!).u).toBe(beforeU);
});

import { effectiveTailHygiene, refreshTailHygieneBaseline } from "./tail-hygiene-walk";

it("unchanged defaults do not imply identical emergency selection on a rebuilding upgrade", () => {
    const id = "protected-upgrade-emergency";
    const { add } = seedProtectedReviewSession(id, "todowrite", 12000);
    for (let n = 1; n <= 8; n++) add(n);
    const tags = getActiveTagsBySession(db, id).map((tag) => ({
        ...tag,
        servedTokens: 12000,
        reclaimableTokens: 12000,
    }));
    const input = {
        tags,
        floorTags: tags,
        maxTag: 8,
        protectedCutoff: null,
        usagePercentage: 95,
        currentTotalInputTokens: 96000,
        ceilingTokens: 16000,
        priorInputSample: 0,
        hasPriorDrop: false,
    };
    // Under the old policy, one todowrite result was not exempt from emergency removal.
    expect(planEmergencyDrop({ ...input, protectedTools: { todowrite: 0 } }).tagNumbers).toContain(
        8,
    );
    expect(planEmergencyDrop(input).tagNumbers).not.toContain(8);
});

it("a rotated held drop strips newer signed reasoning on its priced application", async () => {
    const id = "protected-held-thinking";
    const { add } = seedProtectedReviewSession(id);
    const first = add(1);
    const signed = {
        info: { id: "signed", role: "assistant" },
        parts: [
            {
                type: "reasoning",
                text: "signed thinking",
                metadata: { anthropic: { signature: "opaque" } },
            },
            { type: "text", text: "answer" },
        ],
    } as MessageLike;
    const messages = [
        first,
        signed,
        {
            info: { id: "tail", role: "user" },
            parts: [{ type: "text", text: "continue" }],
        } as MessageLike,
    ];
    queuePendingOp(db, id, 1, "drop");
    const run = (overrides: Partial<PostTransformArgs> = {}) =>
        runPostTransformPhase(
            basePostTransformArgs(db, id, messages, {
                tags: getActiveTagsBySession(db, id),
                protectedTools: { probe: 1 },
                resolvedProviderID: "anthropic",
                thinkingBindingRecoveryEnabledForModel: true,
                targets: new Map([[1, makeDropTarget(first)]]),
                ...overrides,
            }),
        );
    await run();
    expect(signed.parts.some((part) => part.type === "reasoning")).toBe(true);
    messages.push(add(2));
    const result = await run({
        schedulerDecision: "execute",
        pendingMaterializationSessions: new Set([id]),
    });
    expect(getTagsBySession(db, id)[0].status).toBe("dropped");
    expect(result.proactiveThinkingStrip?.messageIds).toContain("signed");
    expect(
        signed.parts.some(
            (part) =>
                part.type === "reasoning" && (part as { text?: string }).text === "signed thinking",
        ),
    ).toBe(false);
});

import { planEmergencyDrop } from "./emergency-drop";

it("logs the executed pressure fold reason instead of the earlier soft decision", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "ses-fold-log-reason";
    const projectPath = "git:fold-log-reason";
    const state = getOrCreateSessionMeta(db, sessionId);
    const m0M1 = {
        projectPath,
        projectDirectory: "/missing-fold-log-project",
        injectDocs: false,
        historyBudgetTokens: 1000,
    };
    injectM0M1({ db, sessionId, state, ...m0M1 });
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 0,
            endMessage: 1,
            startMessageId: "fold-log-start",
            endMessageId: "fold-log-end",
            title: "Large delta",
            content: "Large delta",
            p1: "substantive history ".repeat(600),
            p2: "summary",
            p3: "outcome",
            p4: "anchor",
            importance: 70,
            legacy: 0,
        },
    ]);
    const log = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
    try {
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [], { schedulerDecision: "execute", m0M1 }),
        );
        const lines = log.mock.calls.map((call) => call[1]);
        expect(lines).toContain(
            "m[0] HARD fold decision: reason=drift executed=true bustsServedPrefix=true",
        );
        expect(lines.some((line) => line.includes("reason=unknown"))).toBe(false);
    } finally {
        log.mockRestore();
    }
});

it("fold preparation retries rather than overwriting a changed legacy tool tag", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "ses-fold-tag-snapshot";
    getOrCreateSessionMeta(db, sessionId);
    db.prepare(
        "INSERT INTO tags (session_id, tag_number, type, status, drop_mode) VALUES (?, 1, 'tool', 'dropped', 'truncated')",
    ).run(sessionId);
    const targets = new Map<number, TagTarget>([
        [
            1,
            {
                canDrop: () => true,
                inputStringBytes: () => 10,
                cannotRemove: () => false,
                wouldStrandConversationEnd: () => false,
                drop: () => "absent",
                skeletonReal: () => "absent",
            } as TagTarget,
        ],
    ]);
    const original = compartmentInjection.injectM0M1;
    let attempts = 0;
    const inject = spyOn(compartmentInjection, "injectM0M1").mockImplementation((options) =>
        original({
            ...options,
            beforeCacheCommitForTest: () => {
                attempts++;
                if (attempts === 1)
                    db.prepare(
                        "UPDATE tags SET status = 'active', drop_mode = 'full' WHERE session_id = ? AND tag_number = 1",
                    ).run(sessionId);
            },
        }),
    );
    try {
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, [], {
                targets,
                m0M1: {
                    projectPath: "git:fold-tag-snapshot",
                    projectDirectory: "/missing-fold-tag-project",
                    injectDocs: false,
                },
            }),
        );
        expect(attempts).toBe(2);
        expect(
            db
                .prepare(
                    "SELECT status, drop_mode FROM tags WHERE session_id = ? AND tag_number = 1",
                )
                .get(sessionId),
        ).toEqual({ status: "active", drop_mode: "full" });
    } finally {
        inject.mockRestore();
    }
});

// Observe each named edit's admission or persisted decision, plus served bytes.
// A tool loop held for recent heavy reasoning must retain queued work while the
// hold lasts, even when usage crosses the execute threshold.
describe("active-thinking shared bust permission", () => {
    for (const lane of [
        "pending drain",
        "heuristics",
        "caveman",
        "age sweep",
        "synthetic todo",
        "thinking strip",
    ] as const) {
        it(`held execute denies ${lane}`, async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = `hold-${lane}`;
            const source = [
                {
                    info: { id: "old-user", role: "user" },
                    parts: [{ type: "text", text: "old task" }],
                },
                {
                    info: { id: "old-answer", role: "assistant" },
                    parts: [
                        { type: "reasoning", text: "old signed thought" },
                        {
                            type: "text",
                            text: "The project is in the directory and it is the important file.".repeat(
                                20,
                            ),
                        },
                    ],
                },
                {
                    info: { id: "active-user", role: "user" },
                    parts: [{ type: "text", text: "continue" }],
                },
                {
                    info: { id: "active-answer", role: "assistant" },
                    parts: [
                        { type: "reasoning", text: "active signed thought" },
                        {
                            type: "text",
                            text: "The current task is in the directory and it is the important file.".repeat(
                                20,
                            ),
                        },
                    ],
                },
            ] as MessageLike[];
            const pending = new Set([sessionId]);
            const pass = async (execute: boolean) => {
                const messages = structuredClone(source);
                const tagger = createTagger();
                tagger.initFromDb(sessionId, db);
                const tagged = tagMessages(sessionId, messages, tagger, db);
                const result = await runPostTransformPhase(
                    basePostTransformArgs(db, sessionId, messages, {
                        tagger,
                        ...tagged,
                        tags: getActiveTagsBySession(db, sessionId),
                        freezeM0M1: true,
                        activeThinkingTurn: true,
                        // The transform's bounded hold verdict: recent heavy reasoning
                        // below the cap (66% < 75%).
                        activeThinkingPrefixHold: true,
                        resolvedProviderID: "anthropic",
                        resolvedModelID: "claude-opus-5-5",
                        thinkingBindingRecoveryEnabledForModel: true,
                        schedulerDecision: execute ? "execute" : "defer",
                        contextUsage: { percentage: execute ? 66 : 20, inputTokens: 66_000 },
                        pendingMaterializationSessions: execute ? pending : new Set(),
                        cavemanTextCompression: { enabled: true, minChars: 10 },
                        currentTurnId: "active-user",
                    }),
                );
                return { messages, result };
            };
            const baseline = await pass(false);
            const tag = getTagsBySession(db, sessionId).find((row) =>
                row.messageId.startsWith("old-answer"),
            )!;
            expect(tag).toBeDefined();
            queuePendingOp(db, sessionId, tag.tagNumber, "drop");
            updateSessionMeta(db, sessionId, {
                lastTodoState: JSON.stringify([
                    {
                        id: "held-todo",
                        content: "deferred todo",
                        status: "pending",
                        priority: "medium",
                    },
                ]),
            });
            const drain = spyOn(operations, "applyPendingOperations");
            const cleanup = spyOn(heuristicCleanup, "applyHeuristicCleanup");
            try {
                const held = await pass(true);
                if (lane === "pending drain") expect(drain).not.toHaveBeenCalled();
                if (lane === "heuristics" || lane === "caveman")
                    expect(cleanup).not.toHaveBeenCalled();
                if (lane === "age sweep")
                    expect(getOrCreateSessionMeta(db, sessionId).toolReclaimWatermark).toBe(0);
                if (lane === "synthetic todo")
                    expect(getPersistedTodoSyntheticAnchor(db, sessionId)).toBeNull();
                if (lane === "thinking strip")
                    expect(held.result.proactiveThinkingStrip).toBeNull();
                expect(JSON.stringify(held.messages)).toBe(JSON.stringify(baseline.messages));
                expect(getPendingOps(db, sessionId)).toHaveLength(1);
                expect(pending.has(sessionId)).toBe(true);
            } finally {
                drain.mockRestore();
                cleanup.mockRestore();
            }
        });
    }
});

// Signed-prefix hold invariants: the hold must never outrank
// pressure relief at the absolute 95% wall, and a whole randomized tool loop of
// held passes must serve one byte sequence until the next real user turn.
describe("signed-prefix hold review", () => {
    const heldSource = (): MessageLike[] =>
        [
            { info: { id: "old-user", role: "user" }, parts: [{ type: "text", text: "old task" }] },
            {
                info: { id: "old-answer", role: "assistant" },
                parts: [
                    { type: "reasoning", text: "old signed thought" },
                    { type: "text", text: "Old answer about the important file. ".repeat(40) },
                ],
            },
            {
                info: { id: "old-followup", role: "assistant" },
                parts: [{ type: "text", text: "Old follow-up about the directory. ".repeat(40) }],
            },
            {
                info: { id: "active-user", role: "user" },
                parts: [{ type: "text", text: "continue" }],
            },
            {
                info: { id: "active-answer", role: "assistant" },
                parts: [
                    { type: "reasoning", text: "active signed thought" },
                    { type: "text", text: "Current answer about the important file. ".repeat(40) },
                ],
            },
        ] as MessageLike[];

    const runHeld = async (
        sessionId: string,
        options: {
            held: boolean;
            percentage: number;
            execute: boolean;
            flush: Set<string>;
            deferred?: Set<string>;
        },
    ) => {
        const messages = heldSource();
        const tagger = createTagger();
        tagger.initFromDb(sessionId, db);
        const tagged = tagMessages(sessionId, messages, tagger, db);
        const result = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                tagger,
                ...tagged,
                tags: getActiveTagsBySession(db, sessionId),
                freezeM0M1: options.held,
                activeThinkingTurn: options.held,
                activeThinkingPrefixHold: options.held,
                resolvedProviderID: "anthropic",
                resolvedModelID: "claude-opus-5-5",
                thinkingBindingRecoveryEnabledForModel: true,
                schedulerDecision: options.execute ? "execute" : "defer",
                contextUsage: {
                    percentage: options.percentage,
                    inputTokens: options.percentage * 1000,
                },
                emergencyCeilingTokens: 65_000,
                pendingMaterializationSessions: options.flush,
                deferredMaterializationSessions: options.deferred ?? new Set(),
                canConsumeDeferredLate: options.execute,
                currentTurnId: options.held ? "active-user" : "next-user",
            }),
        );
        return { messages: JSON.stringify(messages), result };
    };

    const oldTags = (sessionId: string) =>
        getTagsBySession(db, sessionId).filter(
            (row) =>
                row.messageId.startsWith("old-answer") || row.messageId.startsWith("old-followup"),
        );

    it("a held pass at the 95% wall still admits the shared drain", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "hold-review-wall";
        await runHeld(sessionId, { held: true, percentage: 20, execute: false, flush: new Set() });
        for (const tag of oldTags(sessionId)) queuePendingOp(db, sessionId, tag.tagNumber, "drop");
        expect(getPendingOps(db, sessionId).length).toBeGreaterThan(0);
        const drain = spyOn(operations, "applyPendingOperations");
        try {
            await runHeld(sessionId, {
                held: true,
                percentage: 96,
                execute: true,
                flush: new Set([sessionId]),
            });
            // At 95% or more the emergency ("force") reclaim permission lifts the
            // hold, so the queued drain runs once. Individual drops may still be
            // refused by per-target thinking protection, which is a separate gate.
            expect(drain).toHaveBeenCalledTimes(1);
        } finally {
            drain.mockRestore();
        }
    });

    it("a held pass at the 85% force band still admits the shared drain", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "hold-review-force-band";
        await runHeld(sessionId, { held: true, percentage: 20, execute: false, flush: new Set() });
        for (const tag of oldTags(sessionId)) queuePendingOp(db, sessionId, tag.tagNumber, "drop");
        const drain = spyOn(operations, "applyPendingOperations");
        try {
            await runHeld(sessionId, {
                held: true,
                percentage: 85,
                execute: true,
                flush: new Set([sessionId]),
            });
            expect(drain).toHaveBeenCalledTimes(1);
        } finally {
            drain.mockRestore();
        }
    });

    it("a randomized held tool loop serves one byte sequence, then one release applies the queue", async () => {
        // Small deterministic generator so a failure names a reproducible seed.
        let seed = 0x6650_0001;
        const random = () => {
            seed = (seed * 1_103_515_245 + 12_345) >>> 0;
            return seed / 0x1_0000_0000;
        };
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "hold-review-loop";
        const flush = new Set<string>();
        const deferred = new Set<string>();
        const baseline = await runHeld(sessionId, {
            held: true,
            percentage: 20,
            execute: false,
            flush,
        });
        const queueable = oldTags(sessionId).map((tag) => tag.tagNumber);
        expect(queueable.length).toBeGreaterThan(0);
        let queued = 0;
        for (let step = 0; step < 24; step++) {
            const roll = random();
            if (roll < 0.3 && queued < queueable.length) {
                queuePendingOp(db, sessionId, queueable[queued++]!, "drop");
            } else if (roll < 0.45) {
                flush.add(sessionId);
            } else if (roll < 0.55) {
                deferred.add(sessionId);
            }
            // Usage 20-74%: always below the 75% hold cap (execute threshold plus
            // 10 points), randomly crossing the 65% execute threshold.
            const percentage = 20 + Math.floor(random() * 55);
            const held = await runHeld(sessionId, {
                held: true,
                percentage,
                execute: percentage >= 65,
                flush,
                deferred,
            });
            expect({ step, seed, bytes: held.messages }).toEqual({
                step,
                seed,
                bytes: baseline.messages,
            });
            expect(held.result.proactiveThinkingStrip).toBeNull();
            expect(getPendingOps(db, sessionId)).toHaveLength(queued);
        }
        while (queued < queueable.length)
            queuePendingOp(db, sessionId, queueable[queued++]!, "drop");
        flush.add(sessionId);
        const released = await runHeld(sessionId, {
            held: false,
            percentage: 61,
            execute: false,
            flush,
        });
        expect(released.messages).not.toBe(baseline.messages);
        expect(getPendingOps(db, sessionId)).toHaveLength(0);
    });
});

describe("signed-prefix riders on unavoidable busts", () => {
    for (const cause of ["first render", "idle expiry"] as const) {
        it(
            cause === "first render"
                ? "a rewriting first render strips every signed block and admits queued work"
                : "idle expiry admits suffix work while keeping every signed block",
            async () => {
                db = new Database(":memory:");
                initializeDatabase(db);
                const sessionId = `held-priced-${cause}`;
                const injection = {
                    projectPath: "git:held-priced",
                    projectDirectory: "/nonexistent",
                    memoryEnabled: false,
                    injectDocs: false,
                    historyBudgetTokens: 1000,
                };
                if (cause === "idle expiry")
                    injectM0M1({
                        db,
                        sessionId,
                        state: getOrCreateSessionMeta(db, sessionId),
                        ...injection,
                        isCacheBustingPass: true,
                    });
                insertTag(db, sessionId, "late-call", "tool", 4000, 1, 0, "bash");
                queuePendingOp(db, sessionId, 1, "drop");
                const pass = async (cold: boolean) => {
                    const late = makeToolMessage("late-tool");
                    const source: MessageLike[] = [
                        {
                            info: { id: "old-user", role: "user" },
                            parts: [{ type: "text", text: "old task" }],
                        },
                        {
                            info: { id: "old-thought", role: "assistant" },
                            parts: [
                                { type: "reasoning", text: "old signed thought" },
                                { type: "text", text: "old answer" },
                            ],
                        },
                        {
                            info: { id: "active-user", role: "user" },
                            parts: [{ type: "text", text: "continue" }],
                        },
                        {
                            info: { id: "active-thought", role: "assistant" },
                            parts: [
                                { type: "reasoning", text: "active signed thought" },
                                { type: "text", text: "tool loop" },
                            ],
                        },
                        late,
                    ];
                    const target = {
                        ...makeDropTarget(late),
                        mutationParts: [{ message: late, part: late.parts[0] }],
                        dropReasoningParts: [],
                    };
                    const targets = new Map([[1, target]]);
                    const replayed = applyFlushedStatuses(sessionId, db, targets);
                    if (cold && cause === "idle expiry")
                        seedHeldServedPrefix(db, sessionId, source);
                    const result = await runPostTransformPhase(
                        basePostTransformArgs(db, sessionId, source, {
                            activeThinkingTurn: true,
                            activeThinkingPrefixHold: true,
                            freezeM0M1: true,
                            resolvedProviderID: "anthropic",
                            resolvedModelID: "claude-opus-5-5",
                            thinkingBindingRecoveryEnabledForModel: true,
                            contextUsage: { percentage: 66, inputTokens: 66_000 },
                            schedulerDecision: cold ? "execute" : "defer",
                            tags: getActiveTagsBySession(db, sessionId),
                            targets,
                            protectedTools: { bash: 0 },
                            didMutateFromFlushedStatuses: replayed,
                            m0M1: {
                                ...injection,
                                hardSignals: {
                                    systemHash: "",
                                    modelKey: "anthropic/claude-opus-5-5",
                                    cacheExpired: cold && cause === "idle expiry",
                                    lastResponseTime: Date.now(),
                                },
                            },
                        }),
                    );
                    return { messages: source, result };
                };
                const priced = await pass(true);
                expect(getPendingOps(db, sessionId)).toHaveLength(0);
                expect(
                    getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === 1)?.status,
                ).toBe("dropped");
                expect(priced.result.proactiveThinkingStrip).toBeNull();
                if (cause === "first render") {
                    expect(getMergedReasoningStrippedIds(db, sessionId)).toContain(
                        "binding_mismatch:old-thought",
                    );
                    expect(getMergedReasoningStrippedIds(db, sessionId)).toContain(
                        "binding_mismatch:active-thought",
                    );
                    expect(
                        priced.messages
                            .flatMap((message) => message.parts)
                            .filter((part) => (part as { type?: string }).type === "reasoning"),
                    ).toHaveLength(0);
                } else {
                    expect(
                        priced.messages.find((message) => message.info.id === "old-thought")
                            ?.parts[0],
                    ).toEqual({ type: "reasoning", text: "old signed thought" });
                    expect(
                        priced.messages.find((message) => message.info.id === "active-thought")
                            ?.parts[0],
                    ).toEqual({ type: "reasoning", text: "active signed thought" });
                }
                const replay = await pass(false);
                expect(replay.result.proactiveThinkingStrip).toBeNull();
                expect(replay.result.bustedThisPass).toBe(false);
                expect(JSON.stringify(replay.messages)).toBe(JSON.stringify(priced.messages));
            },
        );
    }
});

it("an already-cold held pass runs safe routine cleanup without stripping thinking before a kept block", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "held-cold-protected-only";
    const injection = {
        projectPath: "git:held-cold",
        projectDirectory: "/nonexistent",
        memoryEnabled: false,
        injectDocs: false,
        historyBudgetTokens: 1000,
    };
    injectM0M1({
        db,
        sessionId,
        state: getOrCreateSessionMeta(db, sessionId),
        ...injection,
        isCacheBustingPass: true,
    });
    const old = makeToolMessage("old-tool");
    old.parts.unshift({ type: "reasoning", text: "old signed thought" });
    const active: MessageLike = {
        info: { id: "active-thought", role: "assistant" },
        parts: [{ type: "reasoning", text: "active signed thought" }],
    };
    const messages: MessageLike[] = [
        old,
        { info: { id: "active-user", role: "user" }, parts: [{ type: "text", text: "continue" }] },
        active,
    ];
    insertTag(db, sessionId, "old-call", "tool", 4000, 1, 0, "bash");
    queuePendingOp(db, sessionId, 1, "drop");
    const target = {
        ...makeDropTarget(old),
        mutationParts: [{ message: old, part: old.parts[1] }],
        dropReasoningParts: [],
    };
    seedHeldServedPrefix(db, sessionId, messages);
    const cleanup = spyOn(heuristicCleanup, "applyHeuristicCleanup");
    try {
        const result = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                freezeM0M1: true,
                activeThinkingPrefixHold: true,
                activeThinkingTurn: true,
                resolvedProviderID: "anthropic",
                resolvedModelID: "claude-opus-5-5",
                thinkingBindingRecoveryEnabledForModel: true,
                contextUsage: { percentage: 66, inputTokens: 66000 },
                schedulerDecision: "execute",
                currentTurnId: "active-user",
                lastHeuristicsTurnId: new Map([[sessionId, "active-user"]]),
                targets: new Map([[1, target]]),
                tags: getActiveTagsBySession(db, sessionId),
                protectedTools: { bash: 0 },
                messageTagNumbers: new Map([
                    [old, 2],
                    [active, 4],
                ]),
                keepReasoningTokens: 10000,
                m0M1: {
                    ...injection,
                    hardSignals: {
                        systemHash: "",
                        modelKey: "",
                        cacheExpired: true,
                        lastResponseTime: 1,
                    },
                },
            }),
        );
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(cleanup.mock.calls[0]?.[4].routine).toBe(true);
        expect(getPendingOps(db, sessionId)).toHaveLength(1);
        expect(result.proactiveThinkingStrip).toBeNull();
        expect(old.parts[0]).toEqual({ type: "reasoning", text: "old signed thought" });
        expect(active.parts).toEqual([{ type: "reasoning", text: "active signed thought" }]);
    } finally {
        cleanup.mockRestore();
    }
});

it("a cleared cache replays the served record and keeps all signed thinking", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "first-render-same-binding-prefix";
    const injection = {
        projectPath: "git:same-pair",
        projectDirectory: "/nonexistent",
        memoryEnabled: false,
        injectDocs: false,
        historyBudgetTokens: 1000,
    };
    const warm: MessageLike[] = [
        { info: { id: "u0", role: "user" }, parts: [{ type: "text", text: "start" }] },
    ];
    await runPostTransformPhase(basePostTransformArgs(db, sessionId, warm, { m0M1: injection }));
    const heads = structuredClone(warm.slice(0, 2));
    updateSessionMeta(db, sessionId, { cachedM0Bytes: null, cachedM1Bytes: null });
    const messages: MessageLike[] = [
        { info: { id: "old-user", role: "user" }, parts: [{ type: "text", text: "old" }] },
        {
            info: { id: "old-thinking", role: "assistant" },
            parts: [
                { type: "reasoning", text: "old signed" },
                { type: "text", text: "old answer" },
            ],
        },
        { info: { id: "active-user", role: "user" }, parts: [{ type: "text", text: "new" }] },
        {
            info: { id: "active-thinking", role: "assistant" },
            parts: [{ type: "reasoning", text: "active signed" }],
        },
    ];
    seedHeldServedPrefix(db, sessionId, messages, heads);
    const result = await runPostTransformPhase(
        basePostTransformArgs(db, sessionId, messages, {
            activeThinkingTurn: true,
            activeThinkingPrefixHold: true,
            freezeM0M1: true,
            resolvedProviderID: "anthropic",
            resolvedModelID: "claude-opus-5-5",
            thinkingBindingRecoveryEnabledForModel: true,
            m0M1: injection,
            readLastServedMessages: () => heads,
            schedulerDecision: "execute",
            contextUsage: { percentage: 66, inputTokens: 66000 },
        }),
    );
    expect(messages.slice(0, 2)).toEqual(heads);
    expect(
        messages
            .flatMap((message) => message.parts)
            .filter((part) => (part as { type?: string }).type === "reasoning"),
    ).toHaveLength(2);
    expect(result.proactiveThinkingStrip).toBeNull();
});

import { prepareCompactionMarkerCandidates } from "../../features/magic-context/compaction-marker";
import * as markerCandidates from "../../features/magic-context/compaction-marker-candidates";
import { withTransformTimingSummary } from "./transform-stage-logger";

describe("issue 699 processed-image provider replay", () => {
    const image = () => ({
        type: "file",
        mime: "image/png",
        url: `data:image/png;base64,${"a".repeat(300)}`,
    });
    const source = (): MessageLike[] =>
        [
            { info: { id: "old-image", role: "user" }, parts: [image()] },
            {
                info: { id: "tool-image", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        callID: "image-read",
                        tool: "read",
                        state: {
                            status: "completed",
                            input: {},
                            output: "read",
                            attachments: [image()],
                        },
                    },
                ],
            },
            { info: { id: "answer", role: "assistant" }, parts: [{ type: "text", text: "seen" }] },
            { info: { id: "recent-image", role: "user" }, parts: [image()] },
        ] as unknown as MessageLike[];
    const serve = async (
        sessionId: string,
        provider: string,
        bust: boolean,
        overrides: Partial<PostTransformArgs> = {},
    ) => {
        const messages = source();
        if (overrides.activeThinkingPrefixHold)
            messages[2].parts.unshift({
                type: "reasoning",
                text: "retained signed thinking",
                metadata: { anthropic: { signature: "retained-signature" } },
            });
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                watermark: 2,
                messageTagNumbers: new Map(messages.map((msg, i) => [msg, i + 1])),
                resolvedProviderID: provider,
                schedulerDecision: bust ? "execute" : "defer",
                pendingMaterializationSessions: new Set(bust ? [sessionId] : []),
                contextUsage: { percentage: 60, inputTokens: 6000 },
                currentTurnId: "image-turn",
                ...overrides,
            }),
        );
        return messages;
    };
    const open = () => {
        db = new Database(":memory:");
        initializeDatabase(db);
    };

    it("issue 699 OpenAI rewrite strips answered aged images and defer only replays frozen bytes", async () => {
        open();
        const sessionId = "image-openai";
        const deferFirst = await serve(sessionId, "openai", false);
        expect(deferFirst[0].parts).toEqual(source()[0].parts);
        expect(deferFirst[1].parts).toEqual(source()[1].parts);
        expect([...getProcessedImageStrippedIds(db, sessionId)]).toEqual([]);
        const rewritten = await serve(sessionId, "openai", true);
        expect(rewritten[0].parts).toEqual([{ type: "text", text: "[image stripped]" }]);
        expect(JSON.stringify(rewritten[1].parts)).not.toContain("data:image");
        expect(JSON.stringify(rewritten[1].parts)).toContain("[image stripped]");
        expect(rewritten[3].parts).toEqual(source()[3].parts);
        const replayed = await serve(sessionId, "openai", false, { watermark: 100 });
        expect(JSON.stringify(replayed.slice(0, 2))).toBe(JSON.stringify(rewritten.slice(0, 2)));
        expect(replayed[3].parts).toEqual(source()[3].parts);
    });

    it("issue 699 provider switches retain each frozen marker form including legacy Anthropic ids", async () => {
        open();
        const sessionId = "image-switch";
        const anthropic = await serve(sessionId, "anthropic", true);
        expect(anthropic[0].parts).toEqual([{ type: "text", text: "" }]);
        expect(JSON.stringify(anthropic[1].parts)).toContain("[image stripped]");
        const openai = await serve(sessionId, "openai", false);
        expect(JSON.stringify(openai.slice(0, 2))).toBe(JSON.stringify(anthropic.slice(0, 2)));
        const other = await serve("image-switch-reverse", "openai", true);
        const back = await serve("image-switch-reverse", "anthropic", false);
        expect(JSON.stringify(back.slice(0, 2))).toBe(JSON.stringify(other.slice(0, 2)));
        addProcessedImageStrippedIds(db, "legacy-switch", ["old-image"]);
        const legacy = await serve("legacy-switch", "openai", false);
        expect(legacy[0].parts).toEqual([{ type: "text", text: "" }]);
    });

    it("issue 699 a protected signed prefix prevents new user and tool image detection", async () => {
        open();
        const messages = await serve("image-signed", "anthropic", true, {
            activeThinkingPrefixHold: true,
        });
        expect(messages[0].parts).toEqual(source()[0].parts);
        expect(messages[1].parts).toEqual(source()[1].parts);
        expect(messages[2].parts[0]).toEqual({
            type: "reasoning",
            text: "retained signed thinking",
            metadata: { anthropic: { signature: "retained-signature" } },
        });
        expect([...getProcessedImageStrippedIds(db, "image-signed")]).toEqual([]);
    });

    it("issue 699 protected newest tags keep answered tool images despite a later dropped tag", async () => {
        open();
        const sessionId = "image-protected";
        const window = computeProtectionWindow(
            [{ tag_number: 2, type: "tool", token_count: 50 }],
            4000,
        );
        expect(window.protectedTagNumbers.has(2)).toBe(true);
        const messages = await serve(sessionId, "openai", true, {
            watermark: 100,
            protectedTagNumbers: window.protectedTagNumbers,
            protectedCutoff: window.cutoff,
        });
        expect(messages[0].parts).toEqual([{ type: "text", text: "[image stripped]" }]);
        expect(messages[1].parts).toEqual(source()[1].parts);
        expect([...getProcessedImageStrippedIds(db, sessionId)]).toEqual(["old-image"]);
    });

    it("issue 699 emergency window bypass retains independent protected-tool images", async () => {
        open();
        const sessionId = "image-emergency-exemplar";
        insertTag(db, sessionId, "image-read", "tool", 100, 2, 0, "read", 0, "tool-image");
        const messages = await serve(sessionId, "openai", true, {
            watermark: 100,
            protectedCutoff: 1,
            protectedTagNumbers: new Set([2]),
            tags: getActiveTagsBySession(db, sessionId),
            protectedTools: { read: 1 },
            contextUsage: { percentage: 95, inputTokens: 1000 },
        });
        expect(messages[0].parts).toEqual([{ type: "text", text: "[image stripped]" }]);
        expect(messages[1].parts).toEqual(source()[1].parts);
    });

    it("issue 699 compaction off disables detection and frozen replay", async () => {
        open();
        await serve("image-off", "openai", true);
        const messages = await serve("image-off", "openai", true, { compactionOff: true });
        expect(messages[0].parts).toEqual(source()[0].parts);
        expect(messages[1].parts).toEqual(source()[1].parts);
    });
});

describe("issue 699 post-drain image watermark", () => {
    it("issue 699 uses newly drained drops for image discovery on the same admitted bust, never defer", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "image-post-drain";
        insertTag(db, sessionId, "drop-tool", "tool", 4000, 5, 0, "bash");
        queuePendingOp(db, sessionId, 5, "drop", 1);
        const source = (): MessageLike[] =>
            [
                {
                    info: { id: "aged-image", role: "user" },
                    parts: [
                        {
                            type: "file",
                            mime: "image/png",
                            url: `data:image/png;base64,${"a".repeat(300)}`,
                        },
                    ],
                },
                makeToolMessage("drop-tool"),
                {
                    info: { id: "answer", role: "assistant" },
                    parts: [{ type: "text", text: "seen" }],
                },
            ] as MessageLike[];
        const pass = async (bust: boolean) => {
            const messages = source();
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    resolvedProviderID: "openai",
                    watermark: 0,
                    tags: getActiveTagsBySession(db, sessionId),
                    targets: new Map([[5, makeDropTarget(messages[1])]]),
                    messageTagNumbers: new Map([
                        [messages[0], 1],
                        [messages[1], 5],
                    ]),
                    batch: { finalize: () => {} } as PostTransformArgs["batch"],
                    pendingMaterializationSessions: new Set(bust ? [sessionId] : []),
                    schedulerDecision: bust ? "execute" : "defer",
                    contextUsage: { percentage: 60, inputTokens: 1000 },
                }),
            );
            return messages;
        };
        const deferred = await pass(false);
        expect(deferred[0].parts).toEqual(source()[0].parts);
        expect(getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === 5)?.status).toBe(
            "active",
        );
        const rewritten = await pass(true);
        expect(getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === 5)?.status).toBe(
            "dropped",
        );
        expect(rewritten[0].parts).toEqual([{ type: "text", text: "[image stripped]" }]);
        const replay = await pass(false);
        expect(replay[0].parts).toEqual(rewritten[0].parts);
    });
});

describe("issue 699 position-based recent-image retention", () => {
    const image = (native: boolean) =>
        native
            ? {
                  type: "media",
                  media: {
                      mediaType: "image/png",
                      source: { type: "base64", data: "a".repeat(300) },
                  },
              }
            : { type: "file", mime: "image/png", url: `data:image/png;base64,${"a".repeat(300)}` };
    const pass = async (
        sessionId: string,
        native: boolean,
        options: { nextTag: number; watermark: number; percentage?: number; bust?: boolean },
    ) => {
        const messages = [
            { info: { id: "position-image", role: "user" }, parts: [image(native)] },
            {
                info: { id: "position-answer", role: "assistant" },
                parts: [{ type: "text", text: "seen" }],
            },
        ] as MessageLike[];
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                resolvedProviderID: "openai",
                watermark: options.watermark,
                messageTagNumbers: new Map([[messages[1], options.nextTag]]),
                protectedCutoff: 5,
                protectedTagNumbers: new Set([5, 6, 7, 8]),
                pendingMaterializationSessions: new Set(options.bust === false ? [] : [sessionId]),
                schedulerDecision: options.bust === false ? "defer" : "execute",
                contextUsage: { percentage: options.percentage ?? 60, inputTokens: 1000 },
            }),
        );
        return messages;
    };
    for (const native of [false, true]) {
        it(`issue 699 answered image-only ${native ? "native media" : "file"} stays recent, ages outside the window, and yields only at emergency`, async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const recent = await pass(`image-position-recent-${native}`, native, {
                nextTag: 6,
                watermark: 1,
            });
            expect(recent[0].parts).toEqual([image(native)]);
            const crossed = await pass(`image-position-protected-${native}`, native, {
                nextTag: 6,
                watermark: 8,
                percentage: 94.99,
            });
            expect(crossed[0].parts).toEqual([image(native)]);
            const emergency = await pass(`image-position-emergency-${native}`, native, {
                nextTag: 6,
                watermark: 8,
                percentage: 95,
            });
            expect(emergency[0].parts).toEqual([{ type: "text", text: "[image stripped]" }]);
            const sessionId = `image-position-old-${native}`;
            const deferred = await pass(sessionId, native, {
                nextTag: 3,
                watermark: 4,
                bust: false,
            });
            expect(deferred[0].parts).toEqual([image(native)]);
            const aged = await pass(sessionId, native, { nextTag: 3, watermark: 4 });
            expect(aged[0].parts).toEqual([{ type: "text", text: "[image stripped]" }]);
            const replay = await pass(sessionId, native, {
                nextTag: 100,
                watermark: 0,
                bust: false,
            });
            expect(replay[0].parts).toEqual(aged[0].parts);
        });
    }
});

describe("independent image cache safety through both host projections", () => {
    for (const host of ["oc1", "oc2-base64", "oc2-bytes"] as const) {
        function project(provider: string, signed = false, precedingAssistant = false) {
            const file = {
                type: "file",
                mime: "image/png",
                url: `data:image/png;base64,${"a".repeat(300)}`,
            };
            const signature = {
                type: "reasoning",
                text: "kept signed thinking",
                metadata: { anthropic: { signature: "sig-independent" } },
            };
            if (host === "oc1") {
                const messages: MessageLike[] = [
                    { info: { id: "independent-image", role: "user" }, parts: [file] },
                    {
                        info: { id: "independent-tool", role: "assistant" },
                        parts: [
                            {
                                type: "tool",
                                callID: "independent-read",
                                tool: "read",
                                state: {
                                    status: "completed",
                                    input: {},
                                    output: "read",
                                    attachments: [file],
                                },
                            },
                        ],
                    },
                    {
                        info: { id: "independent-answer", role: "assistant" },
                        parts: [...(signed ? [signature] : []), { type: "text", text: "seen" }],
                    },
                ];
                if (precedingAssistant)
                    messages.unshift({
                        info: { id: "before-image", role: "assistant" },
                        parts: [{ type: "text", text: "before" }],
                    });
                return { messages, commit: () => {}, bytes: () => JSON.stringify(messages) };
            }
            class NativeAsset {
                readonly mediaType = "image/png";
                readonly source =
                    host === "oc2-bytes"
                        ? { type: "bytes", data: new Uint8Array(300) }
                        : { type: "base64", data: "a".repeat(300) };
            }
            const draft: SessionContext = {
                sessionID: "independent-host-projection",
                model: { providerID: provider, id: "model" },
                agent: "build",
                system: [],
                tools: {},
                options: {},
                messages: [
                    {
                        id: "independent-image",
                        role: "user",
                        content: [{ type: "media", media: new NativeAsset() }],
                    },
                    {
                        id: "independent-tool",
                        role: "assistant",
                        content: [
                            { type: "tool-call", id: "independent-read", name: "read", input: {} },
                        ],
                    },
                    {
                        role: "tool",
                        content: [
                            {
                                type: "tool-result",
                                id: "independent-read",
                                name: "read",
                                result: {
                                    type: "content",
                                    value: [
                                        { type: "text", text: "read" },
                                        { type: "file", mime: file.mime, uri: file.url },
                                    ],
                                },
                            },
                        ],
                    },
                    {
                        id: "independent-answer",
                        role: "assistant",
                        content: [...(signed ? [signature] : []), { type: "text", text: "seen" }],
                    },
                ],
            };
            if (precedingAssistant)
                draft.messages.unshift({
                    id: "before-image",
                    role: "assistant",
                    content: [{ type: "text", text: "before" }],
                });
            return { ...adaptPayload(draft), bytes: () => JSON.stringify(draft.messages) };
        }

        async function serve(
            sessionId: string,
            bust: boolean,
            provider = "openai",
            signed = false,
            precedingAssistant = false,
        ) {
            const projected = project(provider, signed, precedingAssistant);
            const before = projected.bytes();
            await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, projected.messages, {
                    resolvedProviderID: provider,
                    resolvedModelID: "claude-opus-5-5",
                    watermark: 5,
                    messageTagNumbers: new Map(
                        projected.messages.map((message, i) => [message, i + 1]),
                    ),
                    protectedCutoff: 4,
                    pendingMaterializationSessions: new Set(bust ? [sessionId] : []),
                    schedulerDecision: bust ? "execute" : "defer",
                    activeThinkingPrefixHold: signed,
                    contextUsage: { percentage: 60, inputTokens: 1000 },
                }),
            );
            projected.commit();
            return { ...projected, before };
        }

        it(`independent ${host}: signed hold preserves image-only and tool-result images before kept thinking`, async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = `independent-signed-${host}`;
            const result = await serve(sessionId, true, "anthropic", true);
            expect(result.bytes()).toBe(result.before);
            expect(result.bytes()).toContain("sig-independent");
            expect([...getProcessedImageStrippedIds(db, sessionId)]).toEqual([]);
        });

        it(`independent ${host}: failed durable freeze leaves both image carriers native and defer cannot retry`, async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = `independent-fault-${host}`;
            getOrCreateSessionMeta(db, sessionId);
            rejectSessionMetaCollectionWrites(
                db,
                "processed_image_stripped_ids",
                "fail_independent_image_freeze",
                { error: "independent image persistence fault" },
            );
            const projected = project("openai");
            const before = projected.bytes();
            await expect(
                runPostTransformPhase(
                    basePostTransformArgs(db, sessionId, projected.messages, {
                        resolvedProviderID: "openai",
                        watermark: 5,
                        messageTagNumbers: new Map(
                            projected.messages.map((message, i) => [message, i + 1]),
                        ),
                        pendingMaterializationSessions: new Set([sessionId]),
                        schedulerDecision: "execute",
                    }),
                ),
            ).rejects.toThrow();
            projected.commit();
            expect(projected.bytes()).toBe(before);
            expect([...getProcessedImageStrippedIds(db, sessionId)]).toEqual([]);
            clearSessionMetaFixtureFault(db, "fail_independent_image_freeze");
            const deferred = await serve(sessionId, false);
            expect(deferred.bytes()).toBe(deferred.before);
            const retry = await serve(sessionId, true);
            expect(retry.bytes()).not.toContain("data:image");
            expect(retry.bytes()).not.toContain('"type":"media"');
            expect([...getProcessedImageStrippedIds(db, sessionId)].sort()).toEqual([
                "independent-image",
                "independent-tool",
            ]);
        });

        it(`independent ${host}: post-drain watermark admits both carriers on the same rewrite, never on defer`, async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = `independent-post-drain-${host}`;
            insertTag(db, sessionId, "independent-drop", "tool", 4000, 8, 0, "bash");
            queuePendingOp(db, sessionId, 8, "drop", 1);
            const pass = async (bust: boolean) => {
                const projected = project("openai");
                const before = projected.bytes();
                const drop = makeToolMessage("independent-drop");
                projected.messages.push(drop);
                await runPostTransformPhase(
                    basePostTransformArgs(db, sessionId, projected.messages, {
                        resolvedProviderID: "openai",
                        watermark: 0,
                        tags: getActiveTagsBySession(db, sessionId),
                        targets: new Map([[8, makeDropTarget(drop)]]),
                        messageTagNumbers: new Map(
                            projected.messages.map((message, i) => [message, i === 3 ? 8 : i + 1]),
                        ),
                        batch: { finalize: () => {} } as PostTransformArgs["batch"],
                        pendingMaterializationSessions: new Set(bust ? [sessionId] : []),
                        schedulerDecision: bust ? "execute" : "defer",
                        contextUsage: { percentage: 60, inputTokens: 1000 },
                    }),
                );
                // Inspect only the original image carriers; the separate drop
                // target is a fixture for advancing the persisted watermark.
                projected.messages.splice(3);
                projected.commit();
                return { bytes: projected.bytes(), before };
            };
            const deferred = await pass(false);
            expect(deferred.bytes).toBe(deferred.before);
            expect(getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === 8)?.status).toBe(
                "active",
            );
            const rewritten = await pass(true);
            expect(getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === 8)?.status).toBe(
                "dropped",
            );
            expect(rewritten.bytes).not.toContain("data:image");
            expect(rewritten.bytes).not.toContain('"type":"media"');
            expect([...getProcessedImageStrippedIds(db, sessionId)].sort()).toEqual([
                "independent-image",
                "independent-tool",
            ]);
            expect((await pass(false)).bytes).toBe(rewritten.bytes);
        });

        it(`independent ${host}: reopen reconstructs frozen output before and after both provider switches`, async () => {
            const dir = createTestTempDirFromPath(
                join(tmpdir(), `independent-image-restart-${host}-`),
            );
            tempDirs.push(dir);
            const path = join(dir, "review.sqlite");
            db = new Database(path);
            initializeDatabase(db);
            for (const initialProvider of ["openai", "anthropic"]) {
                const sessionId = `independent-restart-${host}-${initialProvider}`;
                const firstDefer = await serve(sessionId, false, initialProvider);
                expect(firstDefer.bytes()).toBe(firstDefer.before);
                const first = await serve(sessionId, true, initialProvider);
                const bytes = first.bytes();
                db.close();
                db = new Database(path);
                expect((await serve(sessionId, false, initialProvider)).bytes()).toBe(bytes);
                const otherProvider = initialProvider === "openai" ? "anthropic" : "openai";
                const switched = (await serve(sessionId, false, otherProvider)).bytes();
                expect(switched).toBe(bytes);
                expect((await serve(sessionId, false, initialProvider)).bytes()).toBe(bytes);
            }
        });

        it(`independent ${host}: structural image marker persists across reopen and provider switch`, async () => {
            const dir = createTestTempDirFromPath(join(tmpdir(), `image-separator-${host}-`));
            tempDirs.push(dir);
            const path = join(dir, "separator.sqlite");
            db = new Database(path);
            initializeDatabase(db);
            const sessionId = `image-separator-${host}`;
            const frozen = await serve(sessionId, true, "anthropic", false, true);
            expect(frozen.messages[1].parts).toEqual([{ type: "text", text: "[image stripped]" }]);
            expect(
                replayStorage.getProcessedImageMarkers(db, sessionId).get("independent-image"),
            ).toBe("[image stripped]");
            const bytes = frozen.bytes();
            db.close();
            db = new Database(path);
            expect((await serve(sessionId, false, "anthropic", false, true)).bytes()).toBe(bytes);
            expect((await serve(sessionId, false, "openai", false, true)).bytes()).toBe(bytes);
            expect(
                replayStorage.getProcessedImageMarkers(db, sessionId).get("independent-image"),
            ).toBe("[image stripped]");
        });
    }
});

it("served prefix replay keeps the summary and does not consume a pending marker", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "record-marker-replay";
    const injection = {
        projectPath: "git:record-marker",
        projectDirectory: "/nonexistent",
        memoryEnabled: false,
        injectDocs: false,
    };
    injectM0M1({
        db,
        sessionId,
        state: getOrCreateSessionMeta(db, sessionId),
        ...injection,
        isCacheBustingPass: true,
    });
    const head = prepareCachedM0M1Replay(db, sessionId)!.preparedMessages!;
    const first: MessageLike = {
        info: { id: "turn", role: "user" },
        parts: [{ type: "text", text: "Continue" }],
    };
    const summary: MessageLike = {
        info: { id: "old-summary", role: "assistant", summary: true },
        parts: [{ type: "text", text: "Frozen summary" }],
    };
    const marker = {
        boundaryMessageId: "covered",
        summaryMessageId: "old-summary",
        compactionPartId: "old-compaction",
        summaryPartId: "old-summary-part",
        boundaryOrdinal: 1,
        targetEndMessageId: "covered",
    };
    setPersistedCompactionMarkerState(db, sessionId, marker);
    const pending = { ordinal: 1, endMessageId: "covered", publishedAt: 1 };
    setPendingCompactionMarkerState(db, sessionId, pending);
    const record = writeServedPrefix({
        db,
        sessionId,
        head,
        summary,
        firstKept: first,
        firstKeptId: "turn",
        turn: "turn",
        provenance: {
            host: "opencode-v1",
            id_space: "opencode-v1-message",
            generation: "v1",
            projection: "messages",
            model: SEEDED_PREFIX_MODEL,
        },
        cut: { mode: "inclusive", id: "covered" },
    });
    setPersistedCompactionMarkerState(db, sessionId, null);
    let drains = 0;
    const deferred = new Set([sessionId]);
    const messages: MessageLike[] = [
        { info: { id: "covered", role: "user" }, parts: [{ type: "text", text: "Earlier work" }] },
        structuredClone(first),
        {
            info: { id: "thinking", role: "assistant" },
            parts: [
                {
                    type: "reasoning",
                    text: "Current thought",
                    metadata: { anthropic: { signature: "signed" } },
                },
            ],
        },
    ];
    const result = await runPostTransformPhase(
        basePostTransformArgs(db, sessionId, messages, {
            m0M1: {
                ...injection,
                hardSignals: {
                    cacheExpired: true,
                    systemHash: "",
                    modelKey: "",
                    lastResponseTime: 1,
                },
            },
            activeThinkingTurn: true,
            activeThinkingPrefixHold: true,
            freezeM0M1: true,
            signedThinkingHold: "on",
            resolvedProviderID: "anthropic",
            resolvedModelID: "claude-opus-5-5",
            thinkingBindingRecoveryEnabledForModel: true,
            historyRebuiltThisPass: true,
            canConsumeDeferredLate: true,
            deferredHistoryWasPendingAtPassStart: true,
            deferredHistoryRefreshSessions: deferred,
            prefixTrimSourceOrder: capturePrefixTrimSourceOrder(messages),
            pendingCompartmentInjection: {
                block: "",
                compartmentEndMessage: 1,
                compartmentEndMessageId: "covered",
                compartmentCount: 1,
                skippedVisibleMessages: 0,
                factCount: 0,
                memoryCount: 0,
                rebuiltFromDb: true,
            },
            compactionMarkerStrategy: {
                reconcile: reconcileMarkerRepresentation,
                applyDeferred: () => {
                    drains++;
                    setPersistedCompactionMarkerState(db!, sessionId, {
                        ...marker,
                        summaryMessageId: "moved-summary",
                    });
                    return { kind: "applied", markerOrdinal: 1 };
                },
            },
        }),
    );
    expect(drains).toBe(0);
    expect(result.historianFoldMaterializedThisPass).toBe(false);
    expect(deferred.has(sessionId)).toBe(true);
    expect(getPendingCompactionMarkerState(db, sessionId)).toEqual(pending);
    expect(getPersistedCompactionMarkerState(db, sessionId)).toBeNull();
    expect(getDeferredClearedCompactionMarkerState(db, sessionId)).toEqual(marker);
    expect(messages.find((message) => message.info.summary === true)).toEqual(summary);
    expect(readServedPrefix(db, sessionId)).toEqual(record);
});

it("compaction-off late digest failure serves the complete cached head, not raw input", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "late-off-record";
    const injection = {
        projectPath: "git:off-record",
        projectDirectory: "/nonexistent",
        memoryEnabled: false,
        injectDocs: false,
    };
    const first: MessageLike = {
        info: { id: "turn", role: "user" },
        parts: [{ type: "text", text: "Task" }],
    };
    const base = () =>
        basePostTransformArgs(db!, sessionId, [structuredClone(first)], {
            compactionOff: true,
            signedThinkingHold: "on",
            m0M1: injection,
            resolvedProviderID: "anthropic",
            resolvedModelID: "claude-opus-5-5",
            thinkingBindingRecoveryEnabledForModel: true,
        });
    await runPostTransformPhase(base());
    const record = readServedPrefix(db, sessionId);
    const args = base();
    args.messages.push({
        info: { id: "current", role: "assistant" },
        parts: [
            {
                type: "reasoning",
                text: "Active thought",
                metadata: { anthropic: { signature: "active" } },
            },
        ],
    });
    args.activeThinkingTurn = true;
    args.activeThinkingPrefixHold = true;
    const result = await runUnfinalizedPostTransformPhase(args);
    const raw = args.messages.find((message) => message.info.id === "turn")!;
    (raw.parts[0] as { text: string }).text = "Changed after replay";
    updateSessionMeta(db, sessionId, {
        cachedM0Bytes: Buffer.from("<session-history>cached fallback</session-history>"),
    });
    expect(() => result.finalizeServedPrefix?.()).not.toThrow();
    expect(args.messages[0].parts[0]).toMatchObject({
        text: "<session-history>cached fallback</session-history>",
    });
    expect(args.messages).toContain(raw);
    expect(readServedPrefix(db, sessionId)).toEqual(record);
});

for (const visible of [true, false])
    it(
        visible
            ? "applying a marker alone pairs its new prefix with older-thinking omissions"
            : "retiring an unserved marker does not strip thinking or originate a bust",
        async () => {
            db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = "record-marker-first-apply";
            const injection = {
                projectPath: "git:record-marker-apply",
                projectDirectory: "/nonexistent",
                memoryEnabled: false,
                injectDocs: false,
                hardSignals: {
                    systemHash: "stable-system",
                    modelKey: "anthropic/claude-opus-5-5",
                    cacheExpired: false,
                    lastResponseTime: Date.now(),
                },
            };
            injectM0M1({
                db,
                sessionId,
                state: getOrCreateSessionMeta(db, sessionId),
                ...injection,
                isCacheBustingPass: true,
            });
            const head = prepareCachedM0M1Replay(db, sessionId)!.preparedMessages!;
            const first: MessageLike = {
                info: { id: "old-user", role: "user" },
                parts: [{ type: "text", text: "Earlier task" }],
            };
            writeServedPrefix({
                db,
                sessionId,
                head,
                summary: null,
                firstKept: first,
                firstKeptId: "old-user",
                turn: "current-user",
                provenance: {
                    host: "opencode-v1",
                    id_space: "opencode-v1-message",
                    generation: "v1",
                    projection: "messages",
                },
            });
            setPersistedCompactionMarkerState(db, sessionId, {
                boundaryMessageId: "old-user",
                summaryMessageId: "new-summary",
                compactionPartId: "compaction",
                summaryPartId: "summary-part",
                boundaryOrdinal: 1,
                targetEndMessageId: null,
            });
            if (!visible) setPersistedCompactionMarkerState(db, sessionId, null);
            const messages: MessageLike[] = [
                structuredClone(first),
                {
                    info: { id: "old-thinking", role: "assistant" },
                    parts: [
                        {
                            type: "reasoning",
                            text: "Older signed thought",
                            metadata: { anthropic: { signature: "old-signature" } },
                        },
                        { type: "text", text: "Earlier answer" },
                    ],
                },
                {
                    info: { id: "current-user", role: "user" },
                    parts: [{ type: "text", text: "Next task" }],
                },
            ];
            const result = await runPostTransformPhase(
                basePostTransformArgs(db, sessionId, messages, {
                    m0M1: injection,
                    signedThinkingHold: "on",
                    resolvedProviderID: "anthropic",
                    resolvedModelID: "claude-opus-5-5",
                    thinkingBindingRecoveryEnabledForModel: true,
                    pendingMaterializationSessions: new Set([sessionId]),
                }),
            );
            expect(messages.slice(0, head.length)).toEqual(head);
            expect(messages.some((message) => message.info.summary === true)).toBe(visible);
            expect(
                messages
                    .flatMap((message) => message.parts)
                    .some((part) => (part as { type?: string }).type === "reasoning"),
            ).toBe(!visible);
            if (visible)
                expect(getMergedReasoningStrippedIds(db, sessionId)).toContain(
                    "binding_mismatch:old-thinking",
                );
            else
                expect(getMergedReasoningStrippedIds(db, sessionId)).not.toContain(
                    "binding_mismatch:old-thinking",
                );
            expect(result.bustedThisPass).toBe(visible);
            expect(readServedPrefix(db, sessionId)?.summary).toEqual(
                messages.find((message) => message.info.summary === true) ?? null,
            );
        },
    );
// Subagents have no historian prefix to trade for their current working results.
it("issue 731 small subagent preserves results when fixed overhead exceeds the ceiling", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    for (const percentage of [72.3, 95]) {
        const sessionId = `issue731-subagent-${percentage}`;
        const messages = [makeToolMessage("old"), makeToolMessage("latest")];
        const targets = new Map<number, TagTarget>();
        for (let tag = 1; tag <= 2; tag++) {
            insertTag(db, sessionId, `tool-${tag}`, "tool", 4000, tag, 0, "bash");
            targets.set(tag, makeDropTarget(messages[tag - 1]!));
        }
        const before = JSON.stringify(messages);
        const pending = new Set<string>();
        requestPendingMaterialization(pending, sessionId, "fit_retry");
        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                fullFeatureMode: false,
                schedulerDecision: "execute",
                contextUsage: { percentage, inputTokens: 144_520 },
                usableWindow: 200_000,
                emergencyCeilingTokens: 93_938,
                forceSignedRebuildForFit: true,
                pendingMaterializationSessions: pending,
                tags: getActiveTagsBySession(db, sessionId),
                targets,
            }),
        );
        expect(getTagsBySession(db, sessionId).map((tag) => tag.status)).toEqual([
            "active",
            "active",
        ]);
        expect(JSON.stringify(messages)).toBe(before);
        expect(getEmergencyInputSample(db, sessionId)).toBe(0);
    }
});

it("inline thinking replay does not leave an empty strict-provider slot after full postprocess", async () => {
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const sessionId = "review775-inline-postprocess";
    const messages: MessageLike[] = [
        { info: { id: "first", role: "user" }, parts: [{ type: "text", text: "first" }] },
        {
            info: { id: "thinking-only", role: "assistant", providerID: "openai" },
            parts: [{ type: "text", text: "<think>private reasoning</think>" }],
        },
        { info: { id: "next", role: "user" }, parts: [{ type: "text", text: "continue" }] },
    ];
    const tagger = createTagger();
    const tagged = tagMessages(sessionId, messages, tagger, db, { skipPrefixInjection: true });
    const tag = tagged.messageTagNumbers.get(messages[1]);
    expect(tag).toBeGreaterThan(0);
    updateSessionMeta(db, sessionId, { clearedReasoningThroughTag: tag });
    await runPostTransformPhase(
        basePostTransformArgs(db, sessionId, messages, {
            ...tagged,
            tagger,
            resolvedProviderID: "openai",
            fullFeatureMode: false,
            schedulerDecision: "execute",
        }),
    );
    console.log("inline thinking after full postprocess", JSON.stringify(messages));
    const assistant = messages.find((message) => message.info.id === "thinking-only");
    expect(assistant).toBeDefined();
    expect((assistant!.parts[0] as { text: string }).text).not.toBe("");
});

it("an unseen copied-tag suffix with unavailable replay evidence does not originate a prefix bust", async () => {
    const { loadPersistedLkgSlot } = await import("./lkg-persist");
    const root = createTestTempDirFromPath(join(tmpdir(), "review775-no-lkg-"));
    tempDirs.push(root);
    const path = join(root, "context.db");
    db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    const sessionId = "review775-unseen-no-lkg";
    const project = join(root, "project");
    const m0M1 = {
        projectPath: project,
        projectDirectory: project,
        injectDocs: false,
        memoryEnabled: false,
        historyBudgetTokens: 98000,
        hardSignals: {
            systemHash: "stable",
            modelKey: "openai/mock",
            cacheExpired: false,
            lastResponseTime: 0,
        },
    };
    const raw = [
        {
            id: "old-tool",
            role: "assistant",
            content: [
                {
                    type: "tool",
                    tool: "bash",
                    callID: "old-call",
                    state: {
                        status: "completed",
                        input: { command: "echo stable" },
                        output: "stable original output ".repeat(200),
                    },
                },
            ],
        },
        { id: "old-user", role: "user", content: [{ type: "text", text: "continue" }] },
    ];
    const source = (suffix = false): SessionContext =>
        ({
            sessionID: sessionId,
            model: { providerID: "openai", id: "mock" },
            agent: "build",
            messages: structuredClone(
                suffix
                    ? [
                          ...raw,
                          {
                              id: "new-copy",
                              role: "assistant",
                              content: [{ type: "text", text: "§58§" }],
                          },
                          {
                              id: "new-user",
                              role: "user",
                              content: [{ type: "text", text: "continue again" }],
                          },
                      ]
                    : raw,
            ),
            system: [],
            tools: {},
            options: {},
        }) as SessionContext;
    const warm = adaptPayload(source());
    let tagger = createTagger();
    const tagged = tagMessages(sessionId, warm.messages, tagger, db);
    await runPostTransformPhase(
        basePostTransformArgs(db, sessionId, warm.messages, {
            ...tagged,
            tagger,
            tags: getTagsBySession(db, sessionId),
            resolvedProviderID: "openai",
            m0M1,
        }),
    );
    expect(JSON.stringify(warm.messages)).not.toContain('"text":""');
    const oldTag = getTagsBySession(db, sessionId).find((tag) => tag.type === "tool")!;
    expect(oldTag).toBeDefined();
    expect(oldTag.status).toBe("active");
    padRecentToolSkeletonWindow(
        sessionId,
        Math.max(...getTagsBySession(db, sessionId).map((tag) => tag.tagNumber)),
    );
    db.close();
    db = new Database(path);
    initializeDatabase(db);
    expect(getOrCreateSessionMeta(db, sessionId).cachedM0Bytes).not.toBeNull();
    expect(loadPersistedLkgSlot(db, sessionId)).toBeUndefined();
    queuePendingOp(db, sessionId, oldTag.tagNumber, "drop");
    tagger = createTagger();
    const next = adaptPayload(source(true));
    const nextTagged = tagMessages(sessionId, next.messages, tagger, db);
    const result = await runPostTransformPhase(
        basePostTransformArgs(db, sessionId, next.messages, {
            ...nextTagged,
            tagger,
            tags: getTagsBySession(db, sessionId),
            resolvedProviderID: "openai",
            m0M1,
            readLastServedMessages: () => {
                const slot = loadPersistedLkgSlot(db, sessionId);
                return slot ? JSON.parse(slot.jsonPrefix) : null;
            },
        }),
    );
    console.log(
        "unseen suffix after missing replay evidence",
        JSON.stringify({
            busted: result.bustedThisPass,
            reason: result.materializeReason,
            pending: getPendingOps(db, sessionId).length,
            oldStatus: getTagsBySession(db, sessionId).find(
                (tag) => tag.tagNumber === oldTag.tagNumber,
            )?.status,
        }),
    );
    expect(result.bustedThisPass).toBe(false);
    expect(getPendingOps(db, sessionId)).toHaveLength(1);
    expect(
        getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === oldTag.tagNumber)?.status,
    ).toBe("active");
});

it("repairs a served inline-thinking empty slot exactly once through the shared rebuild", async () => {
    const { replayStrippedInlineThinking } = await import("./strip-content");
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const sessionId = "inline-empty-repair";
    let previous: MessageLike[] = [
        { info: { id: "inline", role: "assistant" }, parts: [{ type: "text", text: "" }] },
        { info: { id: "next", role: "user" }, parts: [{ type: "text", text: "continue" }] },
    ];
    for (let pass = 0; pass < 4; pass++) {
        const messages: MessageLike[] = [
            {
                info: { id: "inline", role: "assistant" },
                parts: [{ type: "text", text: "<think>private</think>" }],
            },
            { info: { id: "next", role: "user" }, parts: [{ type: "text", text: "continue" }] },
        ];
        const tagger = createTagger();
        const tagged = tagMessages(sessionId, messages, tagger, db, { skipPrefixInjection: true });
        const tag = tagged.messageTagNumbers.get(messages[0])!;
        updateSessionMeta(db, sessionId, { clearedReasoningThroughTag: tag });
        // Match transform's early persisted replay before entering shared postprocess.
        if (pass > 0) replayStrippedInlineThinking(messages, tagged.messageTagNumbers, tag, true);
        const result = await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                ...tagged,
                tagger,
                resolvedProviderID: "openai",
                readLastServedMessages: () => previous,
            }),
        );
        expect(result.bustedThisPass).toBe(pass === 0);
        expect(messages[0].parts).toEqual([{ type: "text", text: "[cleared]" }]);
        if (pass) expect(messages).toEqual(previous);
        previous = structuredClone(messages);
    }
});

it("defers an unproven inline-empty repair without freezing or changing previously served bytes", async () => {
    const { replayStrippedInlineThinking } = await import("./strip-content");
    const { readReplayEnvelope } = await import(
        "../../features/magic-context/storage-replay-document"
    );
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const sessionId = "inline-unknown-repair";
    const messages: MessageLike[] = [
        {
            info: { id: "inline", role: "assistant" },
            parts: [{ type: "text", text: "<think>private</think>" }],
        },
        { info: { id: "next", role: "user" }, parts: [{ type: "text", text: "continue" }] },
    ];
    const tagger = createTagger();
    const tagged = tagMessages(sessionId, messages, tagger, db, { skipPrefixInjection: true });
    const tag = tagged.messageTagNumbers.get(messages[0])!;
    updateSessionMeta(db, sessionId, { clearedReasoningThroughTag: tag });
    replayStrippedInlineThinking(messages, tagged.messageTagNumbers, tag, true);
    const previous = structuredClone(messages);
    const result = await runPostTransformPhase(
        basePostTransformArgs(db, sessionId, messages, {
            ...tagged,
            tagger,
            resolvedProviderID: "openai",
            readLastServedMessages: () => null,
        }),
    );
    expect(result.bustedThisPass).toBe(false);
    expect(messages).toEqual(previous);
    expect(readReplayEnvelope(db, sessionId).servedShapeRepair).toBeUndefined();
});
