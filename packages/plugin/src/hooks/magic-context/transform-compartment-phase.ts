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
import type { RecoveryFitProjection } from "./recovery-fit";
import { sendStatusNotification } from "./send-session-notification";
import type { MessageLike } from "./transform-operations";

/**
 * A transform blocks the user's turn before provider dispatch, so it may join a historian for at
 * most one minute. The historian keeps running after this foreground budget and can publish for a
 * later pass; the provider-sized historian timeout must never become a silent TUI wait.
 */
export const HISTORIAN_INLINE_JOIN_BUDGET_MS = 60_000;

/**
 * The least of the inline join budget a recovery pass must have left to start
 * one more chained historian run (see chainRecoveryRuns).
 */
export const CHAINED_RECOVERY_RUN_MIN_BUDGET_MS = 15_000;

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
    /**
     * The pass's list of covered id-less instruction rows set aside by the history
     * trim. A re-preparation after a historian join cuts again and must add to the
     * same list, so the rows it cuts are served or dropped like the first cut's.
     */
    coveredInstructions: MessageLike[];
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
    /** False when the dreamer is not runnable; the historian then skips user observations. */
    userObservationsRequested?: boolean;
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
    /**
     * Supplied only on a pass in overflow or model-shrink recovery: counts the
     * request a fold on this pass would send after the publications joined so
     * far, with the line it must stay under. A blocking join then keeps the
     * historian running on the next eligible chunk while the request does not
     * fit (see chainRecoveryRuns).
     */
    projectRecoveryRequest?: () => RecoveryFitProjection | undefined;
    /** The host's protected-tail resolver, for the chunks a recovery chain reads. */
    resolveRecoveryBoundary?: (emergencyTailScale?: 0.5 | 0.25) => ProtectedTailBoundarySnapshot;
}

/** How long one join may wait, and the whole budget it belongs to (for refusal messages). */
interface InlineJoinWindow {
    timeoutMs: number;
    budgetMs: number;
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
    /** Historian runs a recovery pass started after its first join (see chainRecoveryRuns). */
    chainedRecoveryRuns: number;
    /**
     * On a recovery pass, whether the historian can still summarize older
     * history after this pass's joins (see recoveryHistoryRemainsAfterJoins).
     * False on any other pass.
     */
    recoveryHistoryRemains: boolean;
}> {
    let pendingCompartmentInjection = args.pendingCompartmentInjection;
    let compartmentInProgress = args.sessionMeta.compartmentInProgress;
    let published = false;
    let justAwaitedPublication = false;
    let rebuiltHistoryThisPass = false;
    let historianJoinTimedOut = false;
    let historianJoinBudgetMs: number | null = null;
    let chainedRecoveryRuns = 0;
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
            chainedRecoveryRuns,
            recoveryHistoryRemains: false,
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
            recovery: args.projectRecoveryRequest !== undefined,
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
        join: InlineJoinWindow = fullInlineJoinWindow(),
    ): Promise<"completed" | "timed_out"> {
        // Let a just-completed run settle before deciding whether its exhausted
        // foreground budget should leave this pass on the background-only path.
        await Promise.resolve();
        if (activeRun.inlineJoinTimedOutBudgetMs !== undefined && !activeRun.settled) {
            historianJoinTimedOut = true;
            historianJoinBudgetMs = activeRun.inlineJoinTimedOutBudgetMs;
            sessionLog(
                args.sessionId,
                "transform: compartment inline join budget already exhausted for this run — not waiting again",
            );
            return "timed_out";
        }
        sessionLog(args.sessionId, reason);
        const timeoutMs = join.timeoutMs;
        historianJoinBudgetMs = join.budgetMs;
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
            activeRun.inlineJoinTimedOutBudgetMs = join.budgetMs;
            historianJoinTimedOut = true;
            sessionLog(
                args.sessionId,
                `transform: compartment await timed out after ${timeoutMs}ms — proceeding without waiting`,
            );
            return "timed_out";
        }
        justAwaitedPublication = justAwaitedPublication || activeRun.published;
        published = published || activeRun.published;
        return "completed";
    }

    /** Re-prepare the history injection once the blocking join has finished. */
    function refreshCompartmentCoverage(): void {
        sessionLog(
            args.sessionId,
            "transform: compartment agent completed, refreshing compartment coverage",
        );
        const historyReprepareShouldBust =
            published && args.deferredHistoryRefreshSessions.has(args.sessionId);
        pendingCompartmentInjection = prepareCompartmentInjection(
            args.db,
            args.resolvedSessionId,
            args.messages,
            historyReprepareShouldBust,
            args.coveredInstructions,
            args.projectPath,
            args.injectionBudgetTokens,
            args.experimentalTemporalAwareness,
        );
        if (historyReprepareShouldBust) {
            rebuiltHistoryThisPass = true;
        }
    }

    function fullInlineJoinWindow(): InlineJoinWindow {
        const budgetMs = resolveHistorianInlineJoinBudget(args.historianTimeoutMs);
        return { timeoutMs: budgetMs, budgetMs };
    }

    function historianRunDeps(
        boundarySnapshot: ProtectedTailBoundarySnapshot | undefined,
    ): Parameters<typeof startCompartmentAgent>[0] {
        return {
            client: args.client,
            hiddenCompletionExecutor: args.hiddenCompletionExecutor,
            compactionMarkerStrategy: args.compactionMarkerStrategy,
            db: args.db,
            sessionId: args.sessionId,
            historianChunkTokens: args.historianChunkTokens,
            boundarySnapshot,
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
            userObservationsRequested: args.userObservationsRequested,
            historianTwoPass: args.historianTwoPass,
            historianExpandTools: args.historianExpandTools,
            memoryEnabled: args.memoryEnabled,
            autoPromote: args.autoPromote,
            onCompartmentStatePublished: args.onCompartmentStatePublished,
            preserveInjectionCacheUntilConsumed: true,
        };
    }

    /**
     * The next eligible chunk after the publications this pass has already
     * joined. The boundary read at the start of the pass predates them, so it
     * is resolved again from the stored compartments.
     */
    function resolveNextRecoveryBoundary(): ProtectedTailBoundarySnapshot | null {
        rawEligibility = null;
        cachedBoundarySnapshot = null;
        if (!hasNewRawHistoryForCompartment()) return null;
        const resolve = args.resolveRecoveryBoundary ?? resolveBoundarySnapshot;
        let snapshot = { ...resolve(), recovery: true };
        if (!hasRunnableCompartmentWindow(snapshot)) {
            snapshot = {
                ...resolve(
                    args.contextUsage.percentage >= BLOCK_UNTIL_DONE_PERCENTAGE ? 0.25 : 0.5,
                ),
                recovery: true,
            };
        }
        cachedBoundarySnapshot = snapshot;
        return hasRunnableCompartmentWindow(snapshot) ? snapshot : null;
    }

    /**
     * Overflow or model-shrink recovery: one historian run can leave the request
     * far over the window (after a switch to a much smaller model each run
     * summarizes one chunk). While the request a fold would now send is still
     * over the line, keep the historian running on the next eligible chunk,
     * inside the same inline join budget the first run had. Stops when the
     * request fits, a run publishes nothing, no eligible history is left, the
     * historian's drain budget (the tokens of raw history it may summarize per
     * time window, see isHistorianDrainBudgetSpent) is spent, or the inline
     * join budget runs out. The fold happens once, after this returns.
     */
    async function chainRecoveryRuns(
        firstRun: ActiveCompartmentRun,
        project: () => RecoveryFitProjection | undefined,
        deadline: number,
        budgetMs: number,
    ): Promise<"timed_out" | "stopped"> {
        let lastRun = firstRun;
        // A chained run started with little budget left would most likely
        // outlive it, and a pass whose join times out is refused. Start one only
        // with at least this much of the budget left: 15 s of the default 60 s
        // budget, and a quarter of a shorter configured one.
        const minimumRunBudgetMs = Math.min(CHAINED_RECOVERY_RUN_MIN_BUDGET_MS, budgetMs / 4);
        for (;;) {
            if (!lastRun.published) {
                sessionLog(
                    args.sessionId,
                    `transform: recovery chain stops: the last historian run published nothing (${chainedRecoveryRuns} chained runs)`,
                );
                return "stopped";
            }
            let fit: RecoveryFitProjection | undefined;
            try {
                fit = project();
            } catch (error) {
                sessionLog(
                    args.sessionId,
                    "transform: recovery chain stops: the request could not be counted:",
                    error,
                );
                return "stopped";
            }
            if (!fit) return "stopped";
            if (Number.isFinite(fit.tokens) && fit.tokens <= fit.lineTokens) {
                sessionLog(
                    args.sessionId,
                    `transform: recovery chain done: the request is about ${fit.tokens} tokens, under the 95% line ${fit.lineTokens} (${chainedRecoveryRuns} chained runs)`,
                );
                return "stopped";
            }
            const remainingMs = deadline - Date.now();
            if (remainingMs < minimumRunBudgetMs) {
                sessionLog(
                    args.sessionId,
                    `transform: recovery chain stops: ${Math.max(0, remainingMs)}ms of the ${budgetMs}ms inline join budget is left, under the ${minimumRunBudgetMs}ms a chained run needs; the request is still about ${fit.tokens} tokens, over the 95% line ${fit.lineTokens}`,
                );
                return "stopped";
            }
            const boundary = resolveNextRecoveryBoundary();
            if (!boundary) {
                sessionLog(
                    args.sessionId,
                    `transform: recovery chain stops: no eligible history before the protected tail; the request is still about ${fit.tokens} tokens, over the 95% line ${fit.lineTokens}`,
                );
                return "stopped";
            }
            if (
                isHistorianDrainBudgetSpent({
                    db: args.db,
                    sessionId: args.sessionId,
                    contextLimit: args.boundaryContextLimit,
                    executeThresholdPercentage: args.boundaryExecuteThresholdPercentage,
                    usagePercentage: args.boundaryUsage.percentage,
                })
            ) {
                sessionLog(
                    args.sessionId,
                    `transform: recovery chain stops: the historian's drain budget is spent; the request is still about ${fit.tokens} tokens, over the 95% line ${fit.lineTokens}`,
                );
                return "stopped";
            }
            startCompartmentAgent(historianRunDeps(boundary));
            const nextRun = getActiveCompartmentRun(args.sessionId);
            if (!nextRun || nextRun === lastRun) {
                sessionLog(
                    args.sessionId,
                    "transform: recovery chain stops: the next historian run did not start",
                );
                return "stopped";
            }
            chainedRecoveryRuns += 1;
            const result = await awaitCompartmentRun(
                nextRun,
                `transform: recovery request still about ${fit.tokens} tokens, over the 95% line ${fit.lineTokens}; blocking for historian run ${chainedRecoveryRuns + 1} on the next chunk`,
                { timeoutMs: remainingMs, budgetMs },
            );
            if (result === "timed_out") return "timed_out";
            lastRun = nextRun;
        }
    }

    /**
     * On a recovery pass, after the joins: whether the historian can still
     * summarize older history, because a run is still active or the next
     * eligible chunk could start one. The transform's final check holds a
     * recovery request to the 95% line only while it can; with nothing left to
     * summarize, the line could never be reached.
     */
    function recoveryHistoryRemainsAfterJoins(): boolean {
        if (!historianRunnable || !args.canRunCompartments) return false;
        if (getActiveCompartmentRun(args.sessionId)) return true;
        if (!args.client && !args.hiddenCompletionExecutor) return false;
        try {
            if (resolveNextRecoveryBoundary() === null) return false;
        } catch (error) {
            // Unknown: keep the 95% line, which the next turn checks again.
            sessionLog(
                args.sessionId,
                "transform: recovery history check failed; keeping the 95% line:",
                error,
            );
            return true;
        }
        return !isHistorianDrainBudgetSpent({
            db: args.db,
            sessionId: args.sessionId,
            contextLimit: args.boundaryContextLimit,
            executeThresholdPercentage: args.boundaryExecuteThresholdPercentage,
            usagePercentage: args.boundaryUsage.percentage,
        });
    }

    // A saved flag cannot publish a summary without an executor or a live run.
    if (
        (!historianRunnable ||
            (!args.canRunCompartments && !getActiveCompartmentRun(args.sessionId))) &&
        args.sessionMeta.compartmentInProgress
    ) {
        sessionLog(
            args.sessionId,
            "transform: historian unavailable; clearing stale compartmentInProgress flag",
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
                    userObservationsRequested: args.userObservationsRequested,
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
            startCompartmentAgent(
                historianRunDeps(getBoundarySnapshotForCompartment() ?? undefined),
            );
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
            const join = fullInlineJoinWindow();
            const joinDeadline = Date.now() + join.budgetMs;
            const awaitResult = await awaitCompartmentRun(
                activeRun,
                `transform: blocking at ${args.contextUsage.percentage.toFixed(1)}% until compartment agent completes`,
                join,
            );
            if (awaitResult === "completed") {
                awaitedCompartmentRun = true;
                compartmentInProgress = false;
                if (args.projectRecoveryRequest) {
                    const chain = await chainRecoveryRuns(
                        activeRun,
                        args.projectRecoveryRequest,
                        joinDeadline,
                        join.budgetMs,
                    );
                    // A chained run that outlived the budget keeps running in
                    // the background, so the rest of this pass sees one active.
                    if (chain === "timed_out") compartmentInProgress = true;
                }
                refreshCompartmentCoverage();
            } else {
                // Timeout: historian is still running in the background.
                // Keep compartmentInProgress = true so future passes know the run is active.
                // Do NOT set awaitedCompartmentRun — the run hasn't actually completed.
                // The background run will publish when done, and the next pass picks it up.
                sessionLog(
                    args.sessionId,
                    "transform: historian join timed out — reclaim and final fit checks continue; historian keeps running in the background",
                );
            }
        }
    }

    // v2: no independent compressor — deterministic decay-tier rendering keeps
    // the history block within budget at render time, with no LLM pass.
    const recoveryHistoryRemains =
        args.projectRecoveryRequest !== undefined && recoveryHistoryRemainsAfterJoins();
    return {
        pendingCompartmentInjection,
        awaitedCompartmentRun,
        compartmentInProgress,
        published,
        justAwaitedPublication,
        rebuiltHistoryThisPass,
        historianJoinTimedOut,
        historianJoinBudgetMs,
        chainedRecoveryRuns,
        recoveryHistoryRemains,
    };
}
