import {
    getLastCompartmentEndMessage,
    getLastCompartmentEndMessageId,
} from "../../features/magic-context/compartment-storage";
import { type ContextDatabase, updateSessionMeta } from "../../features/magic-context/storage";
import type { ContextUsage } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { sessionLog } from "../../shared/logger";
import type { ModelInput } from "../../shared/model-resolution";
import { withoutSqliteTransformPass } from "../../shared/sqlite";
import {
    type ActiveCompartmentRun,
    getActiveCompartmentRun,
    startCompartmentAgent,
} from "./compartment-runner";
import type {
    HiddenCompartmentRunnerDeps,
    HiddenCompletionExecutor,
} from "./compartment-runner-types";
import { BLOCK_UNTIL_DONE_PERCENTAGE } from "./compartment-trigger";
import { isHistorianDrainBudgetSpent } from "./historian-drain-gate";
import {
    type PreparedCompartmentInjection,
    prepareCompartmentInjection,
} from "./inject-compartments";
import {
    getRawHistoryEligibility,
    hasRunnableCompartmentWindow,
    type ProtectedTailBoundarySnapshot,
    resolveOpenCodeProtectedTailBoundary,
} from "./protected-tail-boundary";
import { primeTailRawMessageCache, withRawSessionMessageCache } from "./read-session-chunk";
import { sendStatusNotification } from "./send-session-notification";
import type { MessageLike } from "./transform-operations";

/**
 * A transform blocks the user's turn before provider dispatch, so it may join a historian for at
 * most one minute. The historian keeps running after this foreground budget and can publish for a
 * later pass; the provider-sized historian timeout must never become a silent TUI wait.
 */
export const HISTORIAN_INLINE_JOIN_BUDGET_MS = 60_000;

export function resolveHistorianInlineJoinBudget(configuredTimeoutMs?: number): number {
    const requested = configuredTimeoutMs ?? HISTORIAN_INLINE_JOIN_BUDGET_MS;
    return Math.max(0, Math.min(requested, HISTORIAN_INLINE_JOIN_BUDGET_MS));
}

export function historianJoinFailClosedMessage(input: {
    timedOut: boolean;
    budgetMs: number | null;
    finalWireEstimate?: { tokens: number; trusted: boolean };
    contextLimitTokens: number;
    lastHistorianError?: string | null;
}): string | null {
    if (!input.timedOut) return null;
    const estimate = input.finalWireEstimate;
    if (
        estimate?.trusted === true &&
        Number.isFinite(estimate.tokens) &&
        estimate.tokens > 0 &&
        Number.isFinite(input.contextLimitTokens) &&
        input.contextLimitTokens > 0 &&
        estimate.tokens < input.contextLimitTokens
    ) {
        return null;
    }
    const budgetMs = input.budgetMs ?? HISTORIAN_INLINE_JOIN_BUDGET_MS;
    const seconds = budgetMs / 1000;
    const reason =
        input.lastHistorianError?.replace(/\s+/g, " ").trim() ||
        "background historian is still running";
    return `historian did not complete within ${seconds} s: ${reason}`;
}

interface RunCompartmentPhaseArgs {
    hiddenCompletionExecutor?: HiddenCompletionExecutor;
    compactionMarkerStrategy?: HiddenCompartmentRunnerDeps["compactionMarkerStrategy"];
    canRunCompartments: boolean;
    fullFeatureMode: boolean;
    /** Compaction-off mode (issue #266): no historian start, no 95% block,
     *  no boundary resolution — the phase degrades to a stale-flag cleanup. */
    compactionOff?: boolean;
    /** False when historian.disable=true, blocking historian-backed child agents. */
    historianRunnable?: boolean;
    sessionMeta: { compartmentInProgress: boolean };
    contextUsage: { percentage: number };
    boundaryContextLimit: number;
    boundaryExecuteThresholdPercentage: number;
    boundaryUsage: ContextUsage;
    boundaryUsageSource: "live" | "persisted" | "provisional-zero" | "manual-none";
    client?: PluginContext["client"];
    db: ContextDatabase;
    sessionId: string;
    resolvedSessionId: string;
    historianChunkTokens: number;
    historyBudgetTokens?: number;
    historianTimeoutMs?: number;
    historianModel?: ModelInput;
    historianContextLimit?: number;
    historianMaxOutputTokens?: number;
    fallbackModels?: readonly ModelInput[];
    compartmentDirectory: string;
    messages: MessageLike[];
    pendingCompartmentInjection: PreparedCompartmentInjection | null;
    fallbackModelId?: string;
    ensureProjectRegistered?: (directory: string, db: ContextDatabase) => Promise<void>;
    projectPath?: string;
    injectionBudgetTokens?: number;
    getNotificationParams?: () => import("./send-session-notification").NotificationParams;
    /** True when this pass is already safe for background compression to run. */
    safeForBackgroundCompression?: boolean;
    deferredHistoryRefreshSessions: Set<string>;
    /** Compatibility-only input retained for older callers; urgent pressure always joins before refusal. */
    skipAwaitForThisPass?: boolean;
    /** When true, extract user behavior observations from historian output */
    experimentalUserMemories?: boolean;
    /** When true, inject wall-clock dates on compartments in <session-history>. */
    experimentalTemporalAwareness?: boolean;
    /** When true, run a second editor pass after historian to clean U: lines. */
    historianTwoPass?: boolean;
    historianExpandTools?: Record<string, string | false>;
    /** Cross-session memory feature gate (`memory.enabled`). Issue #44. */
    memoryEnabled?: boolean;
    /** Auto-promotion gate (`memory.auto_promote`). Issue #44. */
    autoPromote?: boolean;
    /** Forwarded to compartment runner — see CompartmentRunnerDeps.onCompartmentStatePublished. */
    onCompartmentStatePublished?: (sessionId: string) => void;
    /**
     * Boundary snapshot already resolved by THIS pass's trigger decision
     * (transform-located trigger). When present and runnable, the phase uses it
     * instead of re-resolving — one boundary resolution per pass, and the
     * historian starts from exactly the snapshot the fire decision saw. The
     * ≥80% emergency re-scale fallback below still re-resolves when this
     * snapshot has no runnable window.
     */
    preResolvedBoundarySnapshot?: ProtectedTailBoundarySnapshot;
}

/**
 * Only urgent (95%) passes resolve raw history inline. Ordinary starts register
 * background work immediately; its own cache scope reads the unmodified host
 * history after the transform returns, never the transform's mutable parts.
 */
export function runCompartmentPhase(
    args: RunCompartmentPhaseArgs,
): ReturnType<typeof runCompartmentPhaseImpl> {
    if (
        args.historianRunnable !== false &&
        !args.compactionOff &&
        args.canRunCompartments &&
        !getActiveCompartmentRun(args.sessionId) &&
        (args.sessionMeta.compartmentInProgress ||
            args.contextUsage.percentage >= BLOCK_UNTIL_DONE_PERCENTAGE) &&
        isHistorianDrainBudgetSpent({
            db: args.db,
            sessionId: args.sessionId,
            contextLimit: args.boundaryContextLimit,
            executeThresholdPercentage: args.boundaryExecuteThresholdPercentage,
            usagePercentage: args.boundaryUsage.percentage,
        })
    ) {
        if (args.sessionMeta.compartmentInProgress) {
            updateSessionMeta(args.db, args.sessionId, { compartmentInProgress: false });
        }
        return runCompartmentPhaseImpl({
            ...args,
            canRunCompartments: false,
            sessionMeta: { compartmentInProgress: false },
        });
    }
    // Only a new urgent run needs foreground raw-history eligibility. An active
    // run already owns its reads, and ordinary starts prime in the background.
    const historianRunnable = args.historianRunnable !== false;
    const willReadRawHistory =
        historianRunnable &&
        !args.compactionOff &&
        args.canRunCompartments &&
        getActiveCompartmentRun(args.sessionId) === undefined &&
        args.contextUsage.percentage >= BLOCK_UNTIL_DONE_PERCENTAGE;

    if (!willReadRawHistory) {
        // No raw reads this pass — skip the prime and its cache scope entirely.
        return runCompartmentPhaseImpl(args);
    }

    return withRawSessionMessageCache(() => {
        try {
            const preResolved = args.preResolvedBoundarySnapshot;
            const hasPreResolvedAnchor = preResolved?.lastCompartmentEndMessageId !== undefined;
            primeTailRawMessageCache({
                sessionId: args.resolvedSessionId,
                lastCompartmentEnd: hasPreResolvedAnchor
                    ? preResolved.offset - 1
                    : getLastCompartmentEndMessage(args.db, args.resolvedSessionId),
                anchorMessageId: hasPreResolvedAnchor
                    ? (preResolved.lastCompartmentEndMessageId ?? null)
                    : getLastCompartmentEndMessageId(args.db, args.resolvedSessionId),
            });
        } catch (error) {
            // Priming is a pure optimization — on any failure the phase falls
            // back to the full read (its prior behavior). Never block the phase.
            sessionLog(args.sessionId, "compartment phase: tail prime failed (non-fatal):", error);
        }
        return runCompartmentPhaseImpl(args);
    });
}

async function runCompartmentPhaseImpl(args: RunCompartmentPhaseArgs): Promise<{
    pendingCompartmentInjection: PreparedCompartmentInjection | null;
    awaitedCompartmentRun: boolean;
    compartmentInProgress: boolean;
    published: boolean;
    justAwaitedPublication: boolean;
    rebuiltHistoryThisPass: boolean;
    historianJoinTimedOut: boolean;
    historianJoinBudgetMs: number | null;
}> {
    let pendingCompartmentInjection = args.pendingCompartmentInjection;
    let compartmentInProgress = args.sessionMeta.compartmentInProgress;
    let published = false;
    let justAwaitedPublication = false;
    let rebuiltHistoryThisPass = false;
    let historianJoinTimedOut = false;
    let historianJoinBudgetMs: number | null = null;
    const historianRunnable = args.historianRunnable !== false;

    // Compaction-off mode (issue #266): the historian/compartment phase is
    // fully gated off — no fires, no boundary resolution, no await. A stale
    // compartmentInProgress flag (a run interrupted before the flip) is
    // cleared so the session state is honest and flip-back starts clean.
    if (args.compactionOff) {
        if (args.sessionMeta.compartmentInProgress) {
            sessionLog(
                args.sessionId,
                "transform: compaction off; clearing stale compartmentInProgress flag",
            );
            updateSessionMeta(args.db, args.sessionId, { compartmentInProgress: false });
            compartmentInProgress = false;
        }
        return {
            pendingCompartmentInjection,
            awaitedCompartmentRun: false,
            compartmentInProgress,
            published,
            justAwaitedPublication,
            rebuiltHistoryThisPass,
            historianJoinTimedOut,
            historianJoinBudgetMs,
        };
    }
    let rawEligibility: ReturnType<typeof getRawHistoryEligibility> | null =
        args.preResolvedBoundarySnapshot
            ? {
                  lastCompartmentEnd: args.preResolvedBoundarySnapshot.offset - 1,
                  offset: args.preResolvedBoundarySnapshot.offset,
                  rawMessageCount: args.preResolvedBoundarySnapshot.rawMessageCountAtTrigger,
                  hasRawBeyondLastCompartment:
                      args.preResolvedBoundarySnapshot.rawMessageCountAtTrigger >=
                      args.preResolvedBoundarySnapshot.offset,
              }
            : null;
    let lastObservedCompartmentEnd = rawEligibility?.lastCompartmentEnd ?? -1;
    let cachedBoundarySnapshot: ProtectedTailBoundarySnapshot | null = null;

    function hasNewRawHistoryForCompartment(): boolean {
        if (!args.fullFeatureMode || !historianRunnable) return false;
        if (rawEligibility === null) {
            rawEligibility = getRawHistoryEligibility(args.db, args.resolvedSessionId);
            lastObservedCompartmentEnd = rawEligibility.lastCompartmentEnd;
        }
        return rawEligibility.hasRawBeyondLastCompartment;
    }

    function resolveBoundarySnapshot(
        emergencyTailScale?: 0.5 | 0.25,
    ): ProtectedTailBoundarySnapshot {
        return resolveOpenCodeProtectedTailBoundary({
            db: args.db,
            sessionId: args.resolvedSessionId,
            mode: "transform-force",
            contextLimit: args.boundaryContextLimit,
            executeThresholdPercentage: args.boundaryExecuteThresholdPercentage,
            usage: args.boundaryUsage,
            usageSource: args.boundaryUsageSource,
            emergencyTailScale,
        });
    }

    function getBoundarySnapshotForCompartment(): ProtectedTailBoundarySnapshot | null {
        if (!hasNewRawHistoryForCompartment()) return null;
        if (cachedBoundarySnapshot === null) {
            let snapshot =
                args.preResolvedBoundarySnapshot &&
                hasRunnableCompartmentWindow(args.preResolvedBoundarySnapshot)
                    ? args.preResolvedBoundarySnapshot
                    : resolveBoundarySnapshot();
            if (!hasRunnableCompartmentWindow(snapshot) && args.contextUsage.percentage >= 80) {
                snapshot = resolveBoundarySnapshot(
                    args.contextUsage.percentage >= BLOCK_UNTIL_DONE_PERCENTAGE ? 0.25 : 0.5,
                );
            }
            cachedBoundarySnapshot = snapshot;
        }
        return cachedBoundarySnapshot;
    }

    function hasEligibleHistoryForCompartment(): boolean {
        const snapshot = getBoundarySnapshotForCompartment();
        return snapshot !== null && hasRunnableCompartmentWindow(snapshot);
    }

    async function awaitCompartmentRun(
        activeRun: ActiveCompartmentRun,
        reason: string,
    ): Promise<"completed" | "timed_out"> {
        sessionLog(args.sessionId, reason);
        const timeoutMs = resolveHistorianInlineJoinBudget(args.historianTimeoutMs);
        historianJoinBudgetMs = timeoutMs;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), timeoutMs);
        });
        let result: "done" | "timeout";
        try {
            result = await Promise.race([activeRun.promise.then(() => "done" as const), timeout]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
        if (result === "timeout") {
            historianJoinTimedOut = true;
            sessionLog(
                args.sessionId,
                `transform: compartment await timed out after ${timeoutMs}ms — proceeding without waiting`,
            );
            return "timed_out";
        }
        sessionLog(
            args.sessionId,
            "transform: compartment agent completed, refreshing compartment coverage",
        );
        justAwaitedPublication = activeRun.published;
        published = published || activeRun.published;
        const historyReprepareShouldBust =
            activeRun.published && args.deferredHistoryRefreshSessions.has(args.sessionId);
        pendingCompartmentInjection = prepareCompartmentInjection(
            args.db,
            args.resolvedSessionId,
            args.messages,
            historyReprepareShouldBust,
            args.projectPath,
            args.injectionBudgetTokens,
            args.experimentalTemporalAwareness,
        );
        if (historyReprepareShouldBust) {
            rebuiltHistoryThisPass = true;
        }
        return "completed";
    }

    if (!historianRunnable && args.sessionMeta.compartmentInProgress) {
        sessionLog(
            args.sessionId,
            "transform: historian disabled; clearing stale compartmentInProgress flag",
        );
        updateSessionMeta(args.db, args.sessionId, { compartmentInProgress: false });
        compartmentInProgress = false;
    }

    if (
        historianRunnable &&
        args.canRunCompartments &&
        args.sessionMeta.compartmentInProgress &&
        !getActiveCompartmentRun(args.sessionId)
    ) {
        if (
            args.contextUsage.percentage >= BLOCK_UNTIL_DONE_PERCENTAGE &&
            !hasEligibleHistoryForCompartment()
        ) {
            sessionLog(
                args.sessionId,
                `transform: skipping compartment start, no eligible history before protected tail (beyond ${lastObservedCompartmentEnd})`,
            );
            updateSessionMeta(args.db, args.sessionId, { compartmentInProgress: false });
            compartmentInProgress = false;
        } else if (!args.client && !args.hiddenCompletionExecutor) {
            sessionLog(args.sessionId, "transform: cannot start compartment agent without client");
            updateSessionMeta(args.db, args.sessionId, { compartmentInProgress: false });
            compartmentInProgress = false;
        } else {
            sessionLog(args.sessionId, "transform: compartmentInProgress flag set, starting agent");
            startCompartmentAgent(
                {
                    client: args.client,
                    hiddenCompletionExecutor: args.hiddenCompletionExecutor,
                    compactionMarkerStrategy: args.compactionMarkerStrategy,
                    db: args.db,
                    sessionId: args.sessionId,
                    historianChunkTokens: args.historianChunkTokens,
                    boundarySnapshot: args.preResolvedBoundarySnapshot,
                    currentContextLimit: args.boundaryContextLimit,
                    historyBudgetTokens: args.historyBudgetTokens,
                    historianTimeoutMs: args.historianTimeoutMs,
                    model: args.historianModel,
                    historianContextLimit: args.historianContextLimit,
                    historianMaxOutputTokens: args.historianMaxOutputTokens,
                    fallbackModels: args.fallbackModels,
                    directory: args.compartmentDirectory,
                    fallbackModelId: args.fallbackModelId,
                    ensureProjectRegistered: args.ensureProjectRegistered,
                    getNotificationParams: args.getNotificationParams,
                    experimentalUserMemories: args.experimentalUserMemories,
                    historianTwoPass: args.historianTwoPass,
                    historianExpandTools: args.historianExpandTools,
                    memoryEnabled: args.memoryEnabled,
                    autoPromote: args.autoPromote,
                    onCompartmentStatePublished: args.onCompartmentStatePublished,
                    preserveInjectionCacheUntilConsumed: true,
                },
                undefined,
                () => {
                    const snapshot = getBoundarySnapshotForCompartment();
                    if (snapshot && hasRunnableCompartmentWindow(snapshot)) return snapshot;
                    sessionLog(
                        args.sessionId,
                        `transform: skipping compartment start, no eligible history before protected tail (beyond ${lastObservedCompartmentEnd})`,
                    );
                    return null;
                },
            );
            compartmentInProgress = true;
        }
    }

    let awaitedCompartmentRun = false;

    // At the derived force band, run aggressive heuristic cleanup (dropAllTools) but do NOT block
    // the transform waiting for historian. Historian runs in the background.
    // Blocking here freezes the session UI at "Thinking" with no LLM call.
    // Only 95% (BLOCK_UNTIL_DONE_PERCENTAGE) should block.

    if (
        historianRunnable &&
        args.canRunCompartments &&
        args.contextUsage.percentage >= BLOCK_UNTIL_DONE_PERCENTAGE
    ) {
        let activeRun = getActiveCompartmentRun(args.sessionId);
        if (
            !activeRun &&
            hasEligibleHistoryForCompartment() &&
            (args.client || args.hiddenCompletionExecutor)
        ) {
            sessionLog(
                args.sessionId,
                `transform: 95% reached (${args.contextUsage.percentage.toFixed(1)}%), force-starting compartment agent and blocking`,
            );
            startCompartmentAgent({
                client: args.client,
                hiddenCompletionExecutor: args.hiddenCompletionExecutor,
                compactionMarkerStrategy: args.compactionMarkerStrategy,
                db: args.db,
                sessionId: args.sessionId,
                historianChunkTokens: args.historianChunkTokens,
                boundarySnapshot: getBoundarySnapshotForCompartment() ?? undefined,
                currentContextLimit: args.boundaryContextLimit,
                historyBudgetTokens: args.historyBudgetTokens,
                historianTimeoutMs: args.historianTimeoutMs,
                model: args.historianModel,
                historianContextLimit: args.historianContextLimit,
                historianMaxOutputTokens: args.historianMaxOutputTokens,
                fallbackModels: args.fallbackModels,
                directory: args.compartmentDirectory,
                fallbackModelId: args.fallbackModelId,
                ensureProjectRegistered: args.ensureProjectRegistered,
                getNotificationParams: args.getNotificationParams,
                experimentalUserMemories: args.experimentalUserMemories,
                historianTwoPass: args.historianTwoPass,
                historianExpandTools: args.historianExpandTools,
                memoryEnabled: args.memoryEnabled,
                autoPromote: args.autoPromote,
                onCompartmentStatePublished: args.onCompartmentStatePublished,
                preserveInjectionCacheUntilConsumed: true,
            });
            activeRun = getActiveCompartmentRun(args.sessionId);
        } else if (!activeRun && hasEligibleHistoryForCompartment()) {
            sessionLog(
                args.sessionId,
                "transform: cannot force-start compartment agent without client",
            );
        }
        if (activeRun) {
            // Notify user before blocking — the session will appear frozen at "Thinking"
            // while historian compacts. Without this, users have no idea what's happening.
            //
            // CRITICAL: This notification creates a user message via session.prompt
            // as an ignored no-reply post. OpenCode PERSISTS it to the session DB,
            // which gives it a higher ID than the latest assistant. OpenCode's
            // runLoop break condition checks `lastUser.id < lastAssistant.id`, and
            // a fresh notification-user-message every transform pass makes that
            // condition stay false → runLoop keeps iterating → mock returns text
            // above-force-band usage → transform fires again → notification fires again
            // → INFINITE LOOP. We've observed this on CI with >1700 requests per turn.
            //
            // Guard: only send the notification ONCE per active compartment run.
            // The flag lives on the activeRun and is cleared when the run completes,
            // so a future compartment run can notify again.
            if (args.client && !activeRun.notificationSent) {
                activeRun.notificationSent = true;
                const notifParams = args.getNotificationParams?.() ?? {};
                void withoutSqliteTransformPass(() =>
                    sendStatusNotification(
                        args.client,
                        args.sessionId,
                        `⏳ Context at ${args.contextUsage.percentage.toFixed(0)}% — Magic Context is comparting history before continuing. This may take up to ${HISTORIAN_INLINE_JOIN_BUDGET_MS / 1000} seconds.`,
                        notifParams,
                    ),
                );
            }
            const awaitResult = await awaitCompartmentRun(
                activeRun,
                `transform: blocking at ${args.contextUsage.percentage.toFixed(1)}% until compartment agent completes`,
            );
            if (awaitResult === "completed") {
                awaitedCompartmentRun = true;
                compartmentInProgress = false;
            } else {
                // Timeout: historian is still running in the background.
                // Keep compartmentInProgress = true so future passes know the run is active.
                // Do NOT set awaitedCompartmentRun — the run hasn't actually completed.
                // The background run will publish when done, and the next pass picks it up.
                sessionLog(
                    args.sessionId,
                    "transform: proceeding after 95% timeout — historian still running in background",
                );
            }
        }
    }

    // v2: no independent compressor — deterministic decay-tier rendering keeps
    // the history block within budget at render time, with no LLM pass.
    return {
        pendingCompartmentInjection,
        awaitedCompartmentRun,
        compartmentInProgress,
        published,
        justAwaitedPublication,
        rebuiltHistoryThisPass,
        historianJoinTimedOut,
        historianJoinBudgetMs,
    };
}
