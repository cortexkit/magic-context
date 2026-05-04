import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import { getPendingOps, getTagsBySession } from "../../features/magic-context/storage";
import type { ContextUsage, SessionMeta } from "../../features/magic-context/types";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    getProtectedTailStartOrdinal,
    getRawSessionMessageCount,
    readSessionChunk,
    withRawSessionMessageCache,
} from "./read-session-chunk";

const PROACTIVE_TRIGGER_OFFSET_PERCENTAGE = 2;
const POST_DROP_TARGET_RATIO = 0.75;
const MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE = 6_000;
const MIN_PROACTIVE_TAIL_MESSAGE_COUNT = 12;
const DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER = 3;
const TAIL_SIZE_TRIGGER_MULTIPLIER = 3;
const FORCE_COMPARTMENT_PERCENTAGE = 80;
const BLOCK_UNTIL_DONE_PERCENTAGE = 95;
const FORCE_MATERIALIZE_PERCENTAGE = 85;

export {
    BLOCK_UNTIL_DONE_PERCENTAGE,
    FORCE_COMPARTMENT_PERCENTAGE,
    FORCE_MATERIALIZE_PERCENTAGE,
    POST_DROP_TARGET_RATIO,
};

export interface CompartmentTriggerResult {
    shouldFire: boolean;
    reason?: "projected_headroom" | "force_80" | "commit_clusters" | "tail_size";
}

export function getProactiveCompartmentTriggerPercentage(
    executeThresholdPercentage: number,
): number {
    return Math.max(0, executeThresholdPercentage - PROACTIVE_TRIGGER_OFFSET_PERCENTAGE);
}

function estimateProjectedPostDropPercentage(
    db: Database,
    sessionId: string,
    usage: ContextUsage,
    autoDropToolAge?: number,
    protectedTags?: number,
    clearReasoningAge?: number,
    clearedReasoningThroughTag?: number,
    dropToolStructure = true,
): number | null {
    const activeTags = getTagsBySession(db, sessionId).filter((tag) => tag.status === "active");
    // Denominator must include both text/tool bytes and reasoning bytes to match the numerator
    const totalActiveBytes = activeTags.reduce(
        (sum, tag) => sum + tag.byteSize + tag.reasoningByteSize,
        0,
    );
    if (totalActiveBytes === 0) return null;

    let droppableBytes = 0;

    // 1. Pending user-queued drops (from ctx_reduce) — include both text and reasoning bytes
    //    because dropping a message tag also clears its associated reasoning parts
    const pendingDrops = getPendingOps(db, sessionId).filter((op) => op.operation === "drop");
    const pendingDropTagIds = new Set(pendingDrops.map((op) => op.tagId));
    if (pendingDrops.length > 0) {
        droppableBytes += activeTags
            .filter((tag) => pendingDropTagIds.has(tag.tagNumber))
            .reduce((sum, tag) => sum + tag.byteSize + tag.reasoningByteSize, 0);
    }

    // 2. Heuristic auto-drop: old tool outputs outside protected tail
    // 3. Reasoning clearing: reasoning bytes on message tags between watermark and age cutoff
    const maxTag = activeTags.reduce((max, t) => Math.max(max, t.tagNumber), 0);
    if (autoDropToolAge !== undefined && protectedTags !== undefined) {
        const toolAgeCutoff = maxTag - autoDropToolAge;
        const protectedCutoff = maxTag - protectedTags;

        for (const tag of activeTags) {
            // Skip already counted pending drops
            if (pendingDropTagIds.has(tag.tagNumber)) continue;
            if (tag.tagNumber > protectedCutoff) continue;
            if (tag.type === "tool" && tag.tagNumber <= toolAgeCutoff) {
                droppableBytes += estimateToolDropSavings(tag, dropToolStructure);
            }
        }
    }

    if (clearReasoningAge !== undefined && clearedReasoningThroughTag !== undefined) {
        const reasoningAgeCutoff = maxTag - clearReasoningAge;
        for (const tag of activeTags) {
            if (tag.type !== "message") continue;
            // Skip tags already fully counted in pending drops (text + reasoning)
            if (pendingDropTagIds.has(tag.tagNumber)) continue;
            // Only count reasoning not yet cleared (between watermark and age cutoff)
            if (tag.tagNumber <= clearedReasoningThroughTag) continue;
            if (tag.tagNumber > reasoningAgeCutoff) continue;
            if (tag.reasoningByteSize > 0) {
                droppableBytes += tag.reasoningByteSize;
            }
        }
    }

    if (droppableBytes === 0) return null;

    const dropRatio = Math.min(droppableBytes / totalActiveBytes, 1);
    return usage.percentage * (1 - dropRatio);
}

function estimateToolDropSavings(
    tag: { byteSize: number; reasoningByteSize: number; inputByteSize: number },
    dropToolStructure: boolean,
): number {
    const fullDropBytes = tag.byteSize + tag.reasoningByteSize;
    if (dropToolStructure) {
        return fullDropBytes;
    }

    const truncatedStubEstimate = tag.inputByteSize > 500 ? 100 : tag.inputByteSize + 50;
    return Math.max(fullDropBytes - truncatedStubEstimate, 0);
}

interface TailInfo {
    nextStartOrdinal: number;
    hasNewRawHistory: boolean;
    isMeaningful: boolean;
    tokenEstimate: number;
    commitClusterCount: number;
}

const TAIL_INFO_DEFAULTS: TailInfo = {
    nextStartOrdinal: 1,
    hasNewRawHistory: false,
    isMeaningful: false,
    tokenEstimate: 0,
    commitClusterCount: 0,
};

function getUnsummarizedTailInfo(db: Database, sessionId: string, triggerBudget: number): TailInfo {
    return withRawSessionMessageCache(() => {
        try {
            const lastCompartmentEnd = getLastCompartmentEndMessage(db, sessionId);
            const nextStartOrdinal = Math.max(1, lastCompartmentEnd + 1);
            const rawMessageCount = getRawSessionMessageCount(sessionId);
            const protectedTailStart = getProtectedTailStartOrdinal(sessionId);
            const hasEligibleHistory =
                rawMessageCount >= nextStartOrdinal && nextStartOrdinal < protectedTailStart;

            if (!hasEligibleHistory) {
                return { ...TAIL_INFO_DEFAULTS, nextStartOrdinal };
            }

            // Read a large enough window to capture commit clusters and tail size.
            // Use 3x the trigger budget so we can detect the tail-size trigger.
            const scanBudget = Math.max(
                MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE,
                triggerBudget * TAIL_SIZE_TRIGGER_MULTIPLIER,
            );
            const chunk = readSessionChunk(
                sessionId,
                scanBudget,
                nextStartOrdinal,
                protectedTailStart,
            );
            const isMeaningful =
                chunk.hasMore ||
                chunk.tokenEstimate >= MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE ||
                chunk.messageCount >= MIN_PROACTIVE_TAIL_MESSAGE_COUNT;

            return {
                nextStartOrdinal,
                hasNewRawHistory: true,
                isMeaningful,
                tokenEstimate: chunk.tokenEstimate,
                commitClusterCount: chunk.commitClusterCount,
            };
        } catch (error) {
            sessionLog(sessionId, "compartment trigger: raw tail inspection failed:", error);
            return TAIL_INFO_DEFAULTS;
        }
    });
}

export function checkCompartmentTrigger(
    db: Database,
    sessionId: string,
    sessionMeta: SessionMeta,
    usage: ContextUsage,
    _previousPercentage: number,
    executeThresholdPercentage: number,
    triggerBudget: number,
    autoDropToolAge?: number,
    protectedTagCount?: number,
    clearReasoningAge?: number,
    dropToolStructure = true,
    commitClusterTrigger?: { enabled: boolean; min_clusters: number },
): CompartmentTriggerResult {
    if (sessionMeta.compartmentInProgress) {
        return { shouldFire: false };
    }

    const tailInfo = getUnsummarizedTailInfo(db, sessionId, triggerBudget);
    if (!tailInfo.hasNewRawHistory) {
        return { shouldFire: false };
    }

    const projectedPostDropPercentage = estimateProjectedPostDropPercentage(
        db,
        sessionId,
        usage,
        autoDropToolAge,
        protectedTagCount,
        clearReasoningAge,
        sessionMeta.clearedReasoningThroughTag,
        dropToolStructure,
    );
    const relativePostDropTarget = executeThresholdPercentage * POST_DROP_TARGET_RATIO;

    // Force at 80% — only skip if drops alone bring usage well below the relative target
    if (usage.percentage >= FORCE_COMPARTMENT_PERCENTAGE) {
        if (
            projectedPostDropPercentage !== null &&
            projectedPostDropPercentage <= relativePostDropTarget
        ) {
            sessionLog(
                sessionId,
                `compartment trigger: skipping force-${FORCE_COMPARTMENT_PERCENTAGE} because projected post-drop usage is ${projectedPostDropPercentage.toFixed(1)}% (target ${relativePostDropTarget.toFixed(1)}%)`,
            );
            return { shouldFire: false };
        }

        sessionLog(
            sessionId,
            `compartment trigger: force-firing at ${usage.percentage.toFixed(1)}% (projected post-drop ${projectedPostDropPercentage?.toFixed(1) ?? "none"}%)`,
        );
        return { shouldFire: true, reason: "force_80" };
    }

    // Commit-cluster trigger: N+ distinct work phases with commits, enough token volume
    const clusterEnabled = commitClusterTrigger?.enabled ?? true;
    const minClusters =
        commitClusterTrigger?.min_clusters ?? DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER;
    if (
        clusterEnabled &&
        tailInfo.commitClusterCount >= minClusters &&
        tailInfo.tokenEstimate >= triggerBudget
    ) {
        sessionLog(
            sessionId,
            `compartment trigger: commit-cluster fire — ${tailInfo.commitClusterCount} clusters (min=${minClusters}), ~${tailInfo.tokenEstimate} tokens in eligible prefix`,
        );
        return { shouldFire: true, reason: "commit_clusters" };
    }

    // Tail-size trigger: eligible prefix is very large regardless of pressure or commits
    if (tailInfo.tokenEstimate >= triggerBudget * TAIL_SIZE_TRIGGER_MULTIPLIER) {
        sessionLog(
            sessionId,
            `compartment trigger: tail-size fire — ~${tailInfo.tokenEstimate} tokens exceeds ${triggerBudget * TAIL_SIZE_TRIGGER_MULTIPLIER} budget threshold`,
        );
        return { shouldFire: true, reason: "tail_size" };
    }

    // Pressure-driven trigger: context is near threshold and drops aren't enough
    const proactiveTriggerPercentage = getProactiveCompartmentTriggerPercentage(
        executeThresholdPercentage,
    );
    if (usage.percentage < proactiveTriggerPercentage) {
        return { shouldFire: false };
    }

    if (
        projectedPostDropPercentage !== null &&
        projectedPostDropPercentage <= relativePostDropTarget
    ) {
        sessionLog(
            sessionId,
            `compartment trigger: not firing at ${usage.percentage.toFixed(1)}% because projected post-drop usage is ${projectedPostDropPercentage.toFixed(1)}% (target ${relativePostDropTarget.toFixed(1)}%)`,
        );
        return { shouldFire: false };
    }

    if (!tailInfo.isMeaningful) {
        sessionLog(
            sessionId,
            `compartment trigger: not firing at ${usage.percentage.toFixed(1)}% because unsummarized tail from ${tailInfo.nextStartOrdinal} is too small`,
        );
        return { shouldFire: false };
    }

    sessionLog(
        sessionId,
        `compartment trigger: proactive fire at ${usage.percentage.toFixed(1)}% (floor=${proactiveTriggerPercentage}% projected post-drop=${projectedPostDropPercentage?.toFixed(1) ?? "none"}% target=${relativePostDropTarget.toFixed(1)}%)`,
    );
    return { shouldFire: true, reason: "projected_headroom" };
}
