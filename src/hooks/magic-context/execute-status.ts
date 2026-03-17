import type { Database } from "bun:sqlite";
import {
    DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
    DEFAULT_NUDGE_INTERVAL_TOKENS,
} from "../../config/schema/magic-context";
import { parseCacheTtl } from "../../features/magic-context/scheduler";
import { getPendingOps } from "../../features/magic-context/storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import { getTagsBySession } from "../../features/magic-context/storage-tags";
import { log } from "../../shared/logger";
import {
    getProactiveCompartmentTriggerPercentage,
    POST_DROP_TARGET_RATIO,
} from "./compartment-trigger";
import { resolveExecuteThreshold } from "./event-resolvers";
import { formatBytes } from "./format-bytes";
import { getErrorMessage } from "./get-error-message";
import {
    formatRollingNudgeBand,
    getRollingNudgeBand,
    getRollingNudgeIntervalTokens,
} from "./nudge-bands";

export function executeStatus(
    db: Database,
    sessionId: string,
    protectedTags: number,
    nudgeIntervalTokens: number = DEFAULT_NUDGE_INTERVAL_TOKENS,
    executeThresholdPercentageConfig:
        | number
        | { default: number; [modelKey: string]: number } = DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
    liveModelKey?: string,
): string {
    const executeThresholdPercentage = resolveExecuteThreshold(
        executeThresholdPercentageConfig,
        liveModelKey,
        DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
    );
    try {
        const meta = getOrCreateSessionMeta(db, sessionId);
        const tags = getTagsBySession(db, sessionId);
        const pendingOps = getPendingOps(db, sessionId);

        const activeTags = tags.filter((t) => t.status === "active");
        const droppedTags = tags.filter((t) => t.status === "dropped");
        const totalBytes = activeTags.reduce((sum, t) => sum + t.byteSize, 0);

        let ttlMs: number;
        try {
            ttlMs = parseCacheTtl(meta.cacheTtl);
        } catch (error) {
            log(
                `[magic-context] invalid cache_ttl "${meta.cacheTtl}" in ctx-status; falling back to default 5m`,
                error,
            );
            ttlMs = parseCacheTtl("5m");
        }
        const elapsed = Date.now() - meta.lastResponseTime;
        const remainingMs = Math.max(0, ttlMs - elapsed);
        const cacheExpired = remainingMs === 0 && meta.lastResponseTime > 0;

        const currentBand = getRollingNudgeBand(
            meta.lastContextPercentage,
            executeThresholdPercentage,
        );
        const nudgeInterval = getRollingNudgeIntervalTokens(nudgeIntervalTokens, currentBand);
        const proactiveCompartmentTrigger = getProactiveCompartmentTriggerPercentage(
            executeThresholdPercentage,
        );

        const lines: string[] = [
            "## Magic Status",
            "",
            `**Session:** ${sessionId}`,
            `**Tag counter:** ${meta.counter}`,
            "",
            "### Tags",
            `- Active: ${activeTags.length} (~${formatBytes(totalBytes)})`,
            `- Dropped: ${droppedTags.length}`,
            `- Total: ${tags.length}`,
            "",
            "### Pending Queue",
            `- Drops: ${pendingOps.length}`,
            `- Total queued: ${pendingOps.length}`,
            "",
            ...(meta.lastTransformError
                ? ["### Last Transform Error", `- ${meta.lastTransformError}`, ""]
                : []),
            "### Cache TTL",
            `- Configured: ${meta.cacheTtl}`,
            `- Last response: ${meta.lastResponseTime > 0 ? `${Math.round(elapsed / 1000)}s ago` : "never"}`,
            `- Remaining: ${cacheExpired ? "expired" : `${Math.round(remainingMs / 1000)}s`}`,
            `- Queue will auto-execute: ${cacheExpired ? "yes (cache expired)" : `when TTL expires or context >= ${executeThresholdPercentage}%`}`,
            "",
            "### Rolling Nudges",
            `- Execute threshold: ${executeThresholdPercentage}%`,
            `- Rolling anchor: ${meta.lastNudgeTokens.toLocaleString()} tokens`,
            `- Effective interval: ${nudgeInterval.toLocaleString()} tokens`,
            `- Next rolling nudge after: ${(meta.lastNudgeTokens + nudgeInterval).toLocaleString()} tokens`,
            `- Current band: ${formatRollingNudgeBand(currentBand)}`,
            `- Last fired band: ${formatRollingNudgeBand(meta.lastNudgeBand)}`,
            `- Last input tokens: ${meta.lastInputTokens.toLocaleString()} tokens`,
            "",
            `**Protected tags:** ${protectedTags}`,
            `**Subagent session:** ${meta.isSubagent}`,
        ];

        if (meta.lastContextPercentage > 0 || meta.lastInputTokens > 0) {
            const contextLimit =
                meta.lastContextPercentage > 0
                    ? Math.round(meta.lastInputTokens / (meta.lastContextPercentage / 100))
                    : 0;
            lines.push(
                "",
                "### Context Usage",
                `- Last percentage: ${meta.lastContextPercentage.toFixed(1)}%`,
                `- Last input tokens: ${meta.lastInputTokens.toLocaleString()}`,
                `- Resolved context limit: ${contextLimit > 0 ? contextLimit.toLocaleString() : "unknown"}`,
                `- Proactive compartment evaluation: ${proactiveCompartmentTrigger}%`,
                `- Post-drop target for historian: ${(executeThresholdPercentage * POST_DROP_TARGET_RATIO).toFixed(0)}% (${executeThresholdPercentage}% * ${POST_DROP_TARGET_RATIO})`,
                `- Historian also fires on: 2+ commit clusters with sufficient tokens, or tail > ${3}x compartment budget`,
            );
        }

        if (pendingOps.length > 0) {
            lines.push("", "### Queued Operations");
            for (const op of pendingOps) {
                lines.push(`- §${op.tagId}§ → ${op.operation}`);
            }
        }

        return lines.join("\n");
    } catch (error) {
        log("[magic-context] ctx-status failed:", error);
        return `Error: Failed to read context status. ${getErrorMessage(error)}`;
    }
}
