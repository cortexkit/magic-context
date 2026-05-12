import { DEFAULT_COMPRESSOR_COOLDOWN_MS } from "../../config/schema/magic-context";
import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import { type ContextDatabase, updateSessionMeta } from "../../features/magic-context/storage";
import type { PluginContext } from "../../plugin/types";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import {
    type ActiveCompartmentRun,
    getActiveCompartmentRun,
    markActiveCompartmentRunPublished,
    registerActiveCompartmentRun,
    startCompartmentAgent,
} from "./compartment-runner";
import { runCompressionPassIfNeeded } from "./compartment-runner-compressor";
import { BLOCK_UNTIL_DONE_PERCENTAGE } from "./compartment-trigger";
import {
    type PreparedCompartmentInjection,
    prepareCompartmentInjection,
} from "./inject-compartments";
import { getProtectedTailStartOrdinal, getRawSessionMessageCount } from "./read-session-chunk";
import { sendIgnoredMessage } from "./send-session-notification";
import type { MessageLike } from "./transform-operations";

const lastCompressorRunBySession = new Map<string, number>();

function isCompressorOnCooldown(sessionId: string, cooldownMs: number): boolean {
    const lastRun = lastCompressorRunBySession.get(sessionId);
    if (!lastRun) return false;
    return Date.now() - lastRun < cooldownMs;
}

function markCompressorRun(sessionId: string): void {
    lastCompressorRunBySession.set(sessionId, Date.now());
}

export function clearCompressorCooldown(sessionId: string): void {
    lastCompressorRunBySession.delete(sessionId);
}

interface RunCompartmentPhaseArgs {
    canRunCompartments: boolean;
    fullFeatureMode: boolean;
    sessionMeta: { compartmentInProgress: boolean };
    contextUsage: { percentage: number };
    client?: PluginContext["client"];
    db: ContextDatabase;
    sessionId: string;
    resolvedSessionId: string;
    historianChunkTokens: number;
    historyBudgetTokens?: number;
    historianTimeoutMs?: number;
    fallbackModels?: readonly string[];
    compartmentDirectory: string;
    messages: MessageLike[];
    pendingCompartmentInjection: PreparedCompartmentInjection | null;
    fallbackModelId?: string;
    projectPath?: string;
    injectionBudgetTokens?: number;
    getNotificationParams?: () => import("./send-session-notification").NotificationParams;
    /** True when this pass is already safe for background compression to run. */
    safeForBackgroundCompression?: boolean;
    /** True when this pass is already rebuilding history; suppress standalone compressor. */
    suppressBackgroundCompressionThisPass?: boolean;
    deferredHistoryRefreshSessions: Set<string>;
    /** True when transform already triggered recovery/emergency historian work this pass. */
    skipAwaitForThisPass?: boolean;
    /** When true, inject compaction markers into OpenCode's DB after historian publication */
    experimentalCompactionMarkers?: boolean;
    /** When true, extract user behavior observations from historian output */
    experimentalUserMemories?: boolean;
    /** When true, inject wall-clock dates on compartments in <session-history>. */
    experimentalTemporalAwareness?: boolean;
    /** When true, run a second editor pass after historian to clean U: lines. */
    historianTwoPass?: boolean;
    /** Compressor floor ratio: floor = ceil(lastEndMessage / minCompartmentRatio). */
    compressorMinCompartmentRatio?: number;
    /** Compressor max merge depth (1-5). Compartments at or above this depth are skipped. */
    compressorMaxMergeDepth?: number;
    /** Compressor cooldown in milliseconds between background runs. */
    compressorCooldownMs?: number;
    /** Cross-session memory feature gate (`memory.enabled`). Issue #44. */
    memoryEnabled?: boolean;
    /** Auto-promotion gate (`memory.auto_promote`). Issue #44. */
    autoPromote?: boolean;
    /** Forwarded to compartment runner — see CompartmentRunnerDeps.onCompartmentStatePublished. */
    onCompartmentStatePublished?: (sessionId: string) => void;
}

export async function runCompartmentPhase(args: RunCompartmentPhaseArgs): Promise<{
    pendingCompartmentInjection: PreparedCompartmentInjection | null;
    awaitedCompartmentRun: boolean;
    compartmentInProgress: boolean;
    published: boolean;
    justAwaitedPublication: boolean;
    rebuiltHistoryThisPass: boolean;
}> {
    let pendingCompartmentInjection = args.pendingCompartmentInjection;
    let compartmentInProgress = args.sessionMeta.compartmentInProgress;
    let published = false;
    let justAwaitedPublication = false;
    let rebuiltHistoryThisPass = false;
    let lastCompartmentEnd: number | null = null;
    let rawMessageCount: number | null = null;
    let cachedProtectedTailStart: number | null = null;

    function hasNewRawHistoryForCompartment(): boolean {
        if (!args.fullFeatureMode) return false;
        if (lastCompartmentEnd === null) {
            lastCompartmentEnd = getLastCompartmentEndMessage(args.db, args.resolvedSessionId);
        }
        if (rawMessageCount === null) {
            rawMessageCount = getRawSessionMessageCount(args.resolvedSessionId);
        }
        return rawMessageCount > lastCompartmentEnd;
    }

    function hasEligibleHistoryForCompartment(): boolean {
        if (!hasNewRawHistoryForCompartment()) return false;
        if (cachedProtectedTailStart === null) {
            cachedProtectedTailStart = getProtectedTailStartOrdinal(args.resolvedSessionId);
        }
        const nextStart = (lastCompartmentEnd ?? 0) + 1;
        return nextStart < cachedProtectedTailStart;
    }

    async function awaitCompartmentRun(
        activeRun: ActiveCompartmentRun,
        reason: string,
    ): Promise<"completed" | "timed_out"> {
        sessionLog(args.sessionId, reason);
        const timeoutMs = args.historianTimeoutMs ?? 120_000; // 2 minutes default
        const timeout = new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), timeoutMs),
        );
        const result = await Promise.race([activeRun.promise.then(() => "done" as const), timeout]);
        if (result === "timeout") {
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

    if (
        args.canRunCompartments &&
        args.sessionMeta.compartmentInProgress &&
        !getActiveCompartmentRun(args.sessionId)
    ) {
        if (!hasEligibleHistoryForCompartment()) {
            sessionLog(
                args.sessionId,
                `transform: skipping compartment start, no eligible history before protected tail (beyond ${lastCompartmentEnd ?? -1})`,
            );
            updateSessionMeta(args.db, args.sessionId, { compartmentInProgress: false });
            compartmentInProgress = false;
        } else if (!args.client) {
            sessionLog(args.sessionId, "transform: cannot start compartment agent without client");
            updateSessionMeta(args.db, args.sessionId, { compartmentInProgress: false });
            compartmentInProgress = false;
        } else {
            sessionLog(args.sessionId, "transform: compartmentInProgress flag set, starting agent");
            startCompartmentAgent({
                client: args.client,
                db: args.db,
                sessionId: args.sessionId,
                historianChunkTokens: args.historianChunkTokens,
                historyBudgetTokens: args.historyBudgetTokens,
                historianTimeoutMs: args.historianTimeoutMs,
                fallbackModels: args.fallbackModels,
                directory: args.compartmentDirectory,
                fallbackModelId: args.fallbackModelId,
                getNotificationParams: args.getNotificationParams,
                experimentalCompactionMarkers: args.experimentalCompactionMarkers,
                experimentalUserMemories: args.experimentalUserMemories,
                historianTwoPass: args.historianTwoPass,
                compressorMinCompartmentRatio: args.compressorMinCompartmentRatio,
                compressorMaxMergeDepth: args.compressorMaxMergeDepth,
                memoryEnabled: args.memoryEnabled,
                autoPromote: args.autoPromote,
                onCompartmentStatePublished: args.onCompartmentStatePublished,
                preserveInjectionCacheUntilConsumed: true,
            });
            compartmentInProgress = true;
        }
    }

    let awaitedCompartmentRun = false;

    // At 85%, run aggressive heuristic cleanup (dropAllTools) but do NOT block
    // the transform waiting for historian. Historian runs in the background.
    // Blocking here freezes the session UI at "Thinking" with no LLM call.
    // Only 95% (BLOCK_UNTIL_DONE_PERCENTAGE) should block.

    if (
        args.canRunCompartments &&
        !args.skipAwaitForThisPass &&
        args.contextUsage.percentage >= BLOCK_UNTIL_DONE_PERCENTAGE
    ) {
        let activeRun = getActiveCompartmentRun(args.sessionId);
        if (!activeRun && hasEligibleHistoryForCompartment() && args.client) {
            sessionLog(
                args.sessionId,
                `transform: 95% reached (${args.contextUsage.percentage.toFixed(1)}%), force-starting compartment agent and blocking`,
            );
            startCompartmentAgent({
                client: args.client,
                db: args.db,
                sessionId: args.sessionId,
                historianChunkTokens: args.historianChunkTokens,
                historyBudgetTokens: args.historyBudgetTokens,
                historianTimeoutMs: args.historianTimeoutMs,
                fallbackModels: args.fallbackModels,
                directory: args.compartmentDirectory,
                fallbackModelId: args.fallbackModelId,
                getNotificationParams: args.getNotificationParams,
                experimentalCompactionMarkers: args.experimentalCompactionMarkers,
                experimentalUserMemories: args.experimentalUserMemories,
                historianTwoPass: args.historianTwoPass,
                compressorMinCompartmentRatio: args.compressorMinCompartmentRatio,
                compressorMaxMergeDepth: args.compressorMaxMergeDepth,
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
            if (args.client) {
                const notifParams = args.getNotificationParams?.() ?? {};
                void sendIgnoredMessage(
                    args.client,
                    args.sessionId,
                    `⏳ Context at ${args.contextUsage.percentage.toFixed(0)}% — Magic Context is compacting history before continuing. This may take up to 2 minutes.`,
                    notifParams,
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

    // ── Independent compressor check (non-blocking) ─────────────────────
    // The compressor normally runs after a successful historian publication.
    // But if historian hasn't fired (e.g., usage stayed low due to aggressive
    // heuristic cleanup from system-prompt flushes), the history block can
    // exceed the budget indefinitely. Fire the compressor in the background
    // (not awaited) so it never blocks the transform. The compressed result
    // lands on the next cache-busting pass via clearInjectionCache.
    //
    // Conditions:
    //   - cache is already busting (flush or scheduler execute)
    //   - budget is configured
    //   - client is available (compressor creates child sessions)
    //   - no historian is currently running
    //   - no historian ran this pass (compressor already fires post-historian)
    //   - cooldown: at least 10 minutes since last independent compressor run
    if (
        args.safeForBackgroundCompression &&
        !args.suppressBackgroundCompressionThisPass &&
        args.historyBudgetTokens &&
        args.historyBudgetTokens > 0 &&
        args.client &&
        !compartmentInProgress &&
        !awaitedCompartmentRun &&
        !isCompressorOnCooldown(
            args.sessionId,
            args.compressorCooldownMs ?? DEFAULT_COMPRESSOR_COOLDOWN_MS,
        )
    ) {
        // Fire-and-forget: compressor runs in background, results land on next
        // cache-busting pass. Register the promise with activeRuns so a later
        // pass that wants to start a historian sees it via
        // getActiveCompartmentRun() and skips starting, preventing concurrent
        // writes to compartments/session_facts tables.
        markCompressorRun(args.sessionId);
        const compressorPromise = runCompressionPassIfNeeded({
            client: args.client,
            db: args.db,
            sessionId: args.sessionId,
            directory: args.compartmentDirectory,
            historyBudgetTokens: args.historyBudgetTokens,
            historianTimeoutMs: args.historianTimeoutMs,
            fallbackModels: args.fallbackModels,
            minCompartmentRatio: args.compressorMinCompartmentRatio,
            maxMergeDepth: args.compressorMaxMergeDepth,
        })
            .then((compressed) => {
                if (compressed) {
                    markActiveCompartmentRunPublished(args.sessionId);
                    published = true;
                    args.deferredHistoryRefreshSessions.add(args.sessionId);
                    sessionLog(
                        args.sessionId,
                        "independent compressor completed in background — compressed history will appear on next cache-busting pass",
                    );
                }
            })
            .catch((error: unknown) => {
                sessionLog(
                    args.sessionId,
                    "independent compressor failed in background:",
                    getErrorMessage(error),
                );
            });
        registerActiveCompartmentRun(args.sessionId, compressorPromise);
    }

    return {
        pendingCompartmentInjection,
        awaitedCompartmentRun,
        compartmentInProgress,
        published,
        justAwaitedPublication,
        rebuiltHistoryThisPass,
    };
}
