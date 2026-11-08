import type { Scheduler } from "../../features/magic-context/scheduler";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { loadPersistedUsage, type PersistedUsageState } from "../../features/magic-context/storage";
import type { ContextUsage, SessionMeta } from "../../features/magic-context/types";
import { getHarness } from "../../shared/harness";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import { sessionLog } from "../../shared/logger";

type ContextUsageCacheEntry = {
    usage: ContextUsage;
    updatedAt: number;
    lastResponseTime?: number;
    hasUsageTokens?: boolean;
};

// Refused turns never reach the provider, so their last reading cannot refresh.
// Keep only the first refusal for that reading; retries must not move the boundary
// past a summary or fold that could let the blocked session continue.
const usageRefusals = new WeakMap<ContextDatabase, Map<string, number>>();

export function recordUsageRefusal(
    db: ContextDatabase,
    sessionId: string,
    refusedAt = Date.now(),
): void {
    let sessions = usageRefusals.get(db);
    if (!sessions) {
        sessions = new Map();
        usageRefusals.set(db, sessions);
    }
    if (!sessions.has(sessionId)) sessions.set(sessionId, refusedAt);
}

/** Reset a pre-refusal reading only when history changes after that refusal. */
export function shouldResetRefusedUsage(
    db: ContextDatabase,
    sessionId: string,
    meta: Pick<SessionMeta, "lastResponseTime" | "cachedM0MaterializedAt">,
    liveReading?: ContextUsageCacheEntry,
): boolean {
    const refusals = usageRefusals.get(db);
    const refusedAt = refusals?.get(sessionId);
    if (refusedAt === undefined) return false;

    // A real new reading ends the blocked epoch. The idle clock may lag a
    // newly delivered OpenCode measurement, so prefer its own timestamp.
    const readingAt = liveReading?.hasUsageTokens ? liveReading.updatedAt : meta.lastResponseTime;
    if (readingAt > refusedAt) {
        refusals?.delete(sessionId);
        return false;
    }
    const now = Date.now();
    const foldedAt = meta.cachedM0MaterializedAt ?? 0;
    // A future timestamp cannot establish event order after a clock rewind.
    if (foldedAt > refusedAt && foldedAt <= now) return true;
    return !!db
        .prepare(
            "SELECT 1 FROM compartments WHERE session_id = ? AND harness = ? AND created_at > ? AND created_at <= ? LIMIT 1",
        )
        .get(sessionId, getHarness(), refusedAt, now);
}

function loadPersistedUsageWatermark(db: ContextDatabase, sessionId: string): number | null {
    const result = db
        .prepare("SELECT last_response_time FROM session_meta WHERE session_id = ?")
        .get(sessionId);

    if (result === null || typeof result !== "object") return null;
    const lastResponseTime = (result as { last_response_time?: unknown }).last_response_time;
    return typeof lastResponseTime === "number" ? lastResponseTime : null;
}

export interface ContextUsagePassSnapshot {
    lastResponseTime: number;
    persistedUsage: PersistedUsageState | null;
}

export function contextUsagePassSnapshot(sessionMeta: SessionMeta): ContextUsagePassSnapshot {
    const hasPersistedUsage =
        sessionMeta.lastContextPercentage !== 0 || sessionMeta.lastInputTokens !== 0;
    return {
        lastResponseTime: sessionMeta.lastResponseTime,
        persistedUsage: hasPersistedUsage
            ? {
                  usage: {
                      percentage: sessionMeta.lastContextPercentage,
                      inputTokens: sessionMeta.lastInputTokens,
                  },
                  updatedAt: sessionMeta.lastResponseTime || Date.now(),
                  lastObservedModelKey: sessionMeta.lastObservedModelKey,
                  lastUsageContextLimit: sessionMeta.lastUsageContextLimit,
              }
            : null,
    };
}

/**
 * The provider's last usage reading, saved in session_meta, when it still
 * describes this pass's request: the same model, the same context limit, and a
 * last response recent enough that the provider cache is still warm. A pass
 * whose in-memory reading was reset (the first pass after a process restart)
 * reads its pressure from this before falling back to a local estimate.
 *
 * Both the model key and the limit must be known and equal. A reading taken
 * on another model or against another limit is a different percentage basis,
 * so it is not used. The TTL check mirrors the scheduler's idle clock: once the
 * TTL has elapsed the prefix is rebuilt anyway and the reading may be stale.
 */
export function savedProviderReadingForPass(input: {
    persisted: PersistedUsageState | null | undefined;
    currentModelKey: string | undefined;
    contextLimit: number | undefined;
    lastResponseTime: number;
    cacheExpired: boolean;
}): ContextUsage | null {
    const persisted = input.persisted;
    if (!persisted) return null;
    const { percentage, inputTokens } = persisted.usage;
    if (
        !Number.isFinite(percentage) ||
        percentage <= 0 ||
        !Number.isFinite(inputTokens) ||
        inputTokens <= 0
    ) {
        return null;
    }
    if (!(input.lastResponseTime > 0) || input.cacheExpired) return null;
    if (
        persisted.lastObservedModelKey === null ||
        input.currentModelKey === undefined ||
        input.currentModelKey.length === 0 ||
        piModelRefToCanonical(persisted.lastObservedModelKey) !==
            piModelRefToCanonical(input.currentModelKey)
    ) {
        return null;
    }
    if (
        typeof input.contextLimit !== "number" ||
        !(input.contextLimit > 0) ||
        persisted.lastUsageContextLimit !== input.contextLimit
    ) {
        return null;
    }
    return { percentage, inputTokens };
}

/**
 * The saved provider reading that the first pass after a process restart uses
 * for its scheduler decision, and for nothing else.
 *
 * That pass clears the saved reading, so the force band, overflow recovery,
 * the 95% emergency, refusals and nudges never act on a measurement taken
 * before the restart. Clearing it for the execute decision too would only
 * delay work the session already owes: a reading at or above the execute
 * threshold means the next measured pass decides "execute" anyway. When the
 * provider cache went cold while the host was down, that one-pass delay costs
 * a second full prefix write.
 *
 * The reading counts only when it still describes this request (same model,
 * same limit, cache not expired; see savedProviderReadingForPass), is at or
 * above the threshold, and the pass's own reading is below it. Otherwise this
 * returns null and the scheduler sees the cleared reading, as before.
 */
export function firstPassExecuteReading(input: {
    persisted: PersistedUsageState | null | undefined;
    currentModelKey: string | undefined;
    contextLimit: number | undefined;
    lastResponseTime: number;
    cacheExpired: boolean;
    executeThresholdPercentage: number;
    passPercentage: number;
}): ContextUsage | null {
    if (!(input.passPercentage < input.executeThresholdPercentage)) return null;
    const saved = savedProviderReadingForPass(input);
    if (!saved || saved.percentage < input.executeThresholdPercentage) return null;
    return saved;
}

export function resolveUnknownUsageFromWireEstimate(input: {
    usage: ContextUsage;
    pricedPass: boolean;
    wireEstimateTokens: number | undefined;
    wireEstimateTrusted?: boolean;
    providerProvenInputTokens?: number;
    providerProvenLimitTokens?: number;
    usableHardLimit: number | undefined;
}): ContextUsage {
    if (input.usage.inputTokens > 0 || !input.pricedPass) return input.usage;
    const wireTokens = input.wireEstimateTokens;
    if (typeof wireTokens !== "number" || !Number.isFinite(wireTokens) || wireTokens <= 0) {
        return input.usage;
    }
    const providerTokens = input.providerProvenInputTokens;
    const providerLimit = input.providerProvenLimitTokens;
    const canUseProviderMass =
        input.wireEstimateTrusted === false &&
        typeof providerTokens === "number" &&
        Number.isFinite(providerTokens) &&
        providerTokens > 0 &&
        typeof providerLimit === "number" &&
        Number.isFinite(providerLimit) &&
        providerLimit > 0;
    const tokens = canUseProviderMass ? Math.max(wireTokens, providerTokens) : wireTokens;
    const limit = input.usableHardLimit;
    const estimatedPercentage =
        typeof limit === "number" && Number.isFinite(limit) && limit > 0
            ? (tokens / limit) * 100
            : input.usage.percentage;
    return {
        inputTokens: tokens,
        percentage: Math.max(input.usage.percentage, estimatedPercentage),
    };
}

export function loadContextUsage(
    contextUsageMap: Map<string, ContextUsageCacheEntry>,
    db: ContextDatabase,
    sessionId: string,
    passSnapshot?: ContextUsagePassSnapshot,
): ContextUsage {
    const contextUsageEntry = contextUsageMap.get(sessionId);
    // message.updated owns the live map entry and replaces it whenever provider
    // usage changes. That event is the cache's invalidation signal, so a live
    // token-bearing entry needs no validating SELECT on each transform pass.
    if (contextUsageEntry?.hasUsageTokens === true) return contextUsageEntry.usage;
    try {
        const persistedLastResponseTime =
            passSnapshot?.lastResponseTime ?? loadPersistedUsageWatermark(db, sessionId);
        const cachedLastResponseTime =
            contextUsageEntry?.lastResponseTime ?? contextUsageEntry?.updatedAt;
        if (
            contextUsageEntry &&
            contextUsageEntry.lastResponseTime === undefined &&
            (persistedLastResponseTime === null || persistedLastResponseTime === 0)
        ) {
            return contextUsageEntry.usage;
        }
        if (contextUsageEntry && cachedLastResponseTime === persistedLastResponseTime) {
            return contextUsageEntry.usage;
        }

        const persisted = passSnapshot
            ? passSnapshot.persistedUsage
            : loadPersistedUsage(db, sessionId);
        if (persisted) {
            contextUsageMap.set(sessionId, {
                ...persisted,
                lastResponseTime: persistedLastResponseTime ?? persisted.updatedAt,
                // last_response_time also advances on provider errors that carry no usage.
                // A persisted percentage therefore has no process-local freshness proof.
                hasUsageTokens: false,
            });
            return persisted.usage;
        }

        contextUsageMap.delete(sessionId);
    } catch (error) {
        sessionLog(sessionId, "transform failed loading persisted usage:", error);
        return contextUsageEntry?.usage ?? { percentage: 0, inputTokens: 0 };
    }
    return { percentage: 0, inputTokens: 0 };
}

export function resolveSchedulerDecision(
    scheduler: Scheduler,
    sessionMeta: SessionMeta,
    contextUsage: ContextUsage,
    sessionId: string,
    modelKey?: string,
    contextLimit?: number,
): "execute" | "defer" {
    try {
        const schedulerDecision = scheduler.shouldExecute(
            sessionMeta,
            contextUsage,
            undefined,
            sessionId,
            modelKey,
            contextLimit,
        );
        sessionLog(
            sessionId,
            `transform scheduler: percentage=${contextUsage.percentage.toFixed(1)}% inputTokens=${contextUsage.inputTokens} cacheTtl=${sessionMeta.cacheTtl} lastResponseTime=${sessionMeta.lastResponseTime} decision=${schedulerDecision}`,
        );
        return schedulerDecision;
    } catch (error) {
        sessionLog(sessionId, "transform scheduler failed; defaulting to defer:", error);
        return "defer";
    }
}
