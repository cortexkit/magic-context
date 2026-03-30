import { DEFAULT_COMPARTMENT_TOKEN_BUDGET } from "../../config/schema/magic-context";
import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import { type ContextDatabase, updateSessionMeta } from "../../features/magic-context/storage";
import type { PluginContext } from "../../plugin/types";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { getActiveCompartmentRun, startCompartmentAgent } from "./compartment-runner";
import { runCompressionPassIfNeeded } from "./compartment-runner-compressor";
import { BLOCK_UNTIL_DONE_PERCENTAGE, FORCE_MATERIALIZE_PERCENTAGE } from "./compartment-trigger";
import {
    type PreparedCompartmentInjection,
    prepareCompartmentInjection,
} from "./inject-compartments";
import { getProtectedTailStartOrdinal, getRawSessionMessageCount } from "./read-session-chunk";
import type { MessageLike } from "./transform-operations";

interface RunCompartmentPhaseArgs {
    canRunCompartments: boolean;
    fullFeatureMode: boolean;
    sessionMeta: { compartmentInProgress: boolean };
    contextUsage: { percentage: number };
    client?: PluginContext["client"];
    db: ContextDatabase;
    sessionId: string;
    resolvedSessionId: string;
    compartmentTokenBudget?: number;
    historyBudgetTokens?: number;
    historianTimeoutMs?: number;
    compartmentDirectory: string;
    messages: MessageLike[];
    pendingCompartmentInjection: PreparedCompartmentInjection | null;
    projectPath?: string;
    injectionBudgetTokens?: number;
    getNotificationParams?: () => import("./send-session-notification").NotificationParams;
    /** True when this pass is already cache-busting (flush or scheduler execute). */
    cacheAlreadyBusting?: boolean;
}

export async function runCompartmentPhase(args: RunCompartmentPhaseArgs): Promise<{
    pendingCompartmentInjection: PreparedCompartmentInjection | null;
    awaitedCompartmentRun: boolean;
    compartmentInProgress: boolean;
}> {
    let pendingCompartmentInjection = args.pendingCompartmentInjection;
    let compartmentInProgress = args.sessionMeta.compartmentInProgress;
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

    async function awaitCompartmentRun(activeRun: Promise<void>, reason: string): Promise<void> {
        sessionLog(args.sessionId, reason);
        await activeRun;
        sessionLog(
            args.sessionId,
            "transform: compartment agent completed, refreshing compartment coverage",
        );
        pendingCompartmentInjection = prepareCompartmentInjection(
            args.db,
            args.resolvedSessionId,
            args.messages,
            args.cacheAlreadyBusting ?? false,
            args.projectPath,
            args.injectionBudgetTokens,
        );
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
                tokenBudget: args.compartmentTokenBudget ?? DEFAULT_COMPARTMENT_TOKEN_BUDGET,
                historyBudgetTokens: args.historyBudgetTokens,
                historianTimeoutMs: args.historianTimeoutMs,
                directory: args.compartmentDirectory,
                getNotificationParams: args.getNotificationParams,
            });
            compartmentInProgress = true;
        }
    }

    let awaitedCompartmentRun = false;

    if (args.canRunCompartments && args.contextUsage.percentage >= FORCE_MATERIALIZE_PERCENTAGE) {
        const activeRun = getActiveCompartmentRun(args.sessionId);
        if (activeRun) {
            await awaitCompartmentRun(
                activeRun,
                `transform: ${FORCE_MATERIALIZE_PERCENTAGE}% reached (${args.contextUsage.percentage.toFixed(1)}%), waiting for active compartment run before forcing materialization`,
            );
            awaitedCompartmentRun = true;
            compartmentInProgress = false;
        }
    }

    if (args.canRunCompartments && args.contextUsage.percentage >= BLOCK_UNTIL_DONE_PERCENTAGE) {
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
                tokenBudget: args.compartmentTokenBudget ?? DEFAULT_COMPARTMENT_TOKEN_BUDGET,
                historyBudgetTokens: args.historyBudgetTokens,
                historianTimeoutMs: args.historianTimeoutMs,
                directory: args.compartmentDirectory,
                getNotificationParams: args.getNotificationParams,
            });
            activeRun = getActiveCompartmentRun(args.sessionId);
        } else if (!activeRun && hasEligibleHistoryForCompartment()) {
            sessionLog(
                args.sessionId,
                "transform: cannot force-start compartment agent without client",
            );
        }
        if (activeRun) {
            await awaitCompartmentRun(
                activeRun,
                `transform: blocking at ${args.contextUsage.percentage.toFixed(1)}% until compartment agent completes`,
            );
            awaitedCompartmentRun = true;
            compartmentInProgress = false;
        }
    }

    // ── Independent compressor check ──────────────────────────────────────
    // The compressor normally runs after a successful historian publication.
    // But if historian hasn't fired (e.g., usage stayed low due to aggressive
    // heuristic cleanup from system-prompt flushes), the history block can
    // exceed the budget indefinitely. Run the compressor independently when:
    //   - cache is already busting (flush or scheduler execute) — never on
    //     cache-stable passes, as the compressor rewrites message[0]
    //   - budget is configured
    //   - client is available (compressor creates child sessions)
    //   - no historian is currently running
    //   - no historian ran this pass (compressor already fires post-historian)
    if (
        args.cacheAlreadyBusting &&
        args.historyBudgetTokens &&
        args.historyBudgetTokens > 0 &&
        args.client &&
        !compartmentInProgress &&
        !awaitedCompartmentRun
    ) {
        try {
            await runCompressionPassIfNeeded({
                client: args.client,
                db: args.db,
                sessionId: args.sessionId,
                directory: args.compartmentDirectory,
                historyBudgetTokens: args.historyBudgetTokens,
                historianTimeoutMs: args.historianTimeoutMs,
            });
        } catch (error: unknown) {
            sessionLog(
                args.sessionId,
                "transform: independent compressor check failed:",
                getErrorMessage(error),
            );
        }
    }

    return { pendingCompartmentInjection, awaitedCompartmentRun, compartmentInProgress };
}
