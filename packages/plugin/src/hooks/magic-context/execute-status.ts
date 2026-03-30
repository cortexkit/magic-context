import type { Database } from "bun:sqlite";
import {
    DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
    DEFAULT_NUDGE_INTERVAL_TOKENS,
} from "../../config/schema/magic-context";
import { getCompartments, getSessionFacts } from "../../features/magic-context/compartment-storage";
import { parseCacheTtl } from "../../features/magic-context/scheduler";
import { getPendingOps } from "../../features/magic-context/storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import { getTagsBySession } from "../../features/magic-context/storage-tags";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import {
    getProactiveCompartmentTriggerPercentage,
    POST_DROP_TARGET_RATIO,
} from "./compartment-trigger";
import { resolveExecuteThreshold } from "./event-resolvers";
import { formatBytes } from "./format-bytes";
import {
    formatRollingNudgeBand,
    getRollingNudgeBand,
    getRollingNudgeIntervalTokens,
} from "./nudge-bands";
import { estimateTokens } from "./read-session-formatting";

export function executeStatus(
    db: Database,
    sessionId: string,
    protectedTags: number,
    nudgeIntervalTokens: number = DEFAULT_NUDGE_INTERVAL_TOKENS,
    executeThresholdPercentageConfig:
        | number
        | { default: number; [modelKey: string]: number } = DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
    liveModelKey?: string,
    historyBudgetPercentage?: number,
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
            sessionLog(
                sessionId,
                `invalid cache_ttl "${meta.cacheTtl}" in ctx-status; falling back to default 5m`,
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

        const contextLimit =
            meta.lastContextPercentage > 0
                ? Math.round(meta.lastInputTokens / (meta.lastContextPercentage / 100))
                : 0;

        if (meta.lastContextPercentage > 0 || meta.lastInputTokens > 0) {
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

        // History Compression section — show current block size vs budget
        const compartments = getCompartments(db, sessionId);
        const facts = getSessionFacts(db, sessionId);
        let historyBlockTokens = 0;
        for (const c of compartments) {
            historyBlockTokens += estimateTokens(
                `<compartment start="${c.startMessage}" end="${c.endMessage}" title="${c.title}">\n${c.content}\n</compartment>\n`,
            );
        }
        for (const f of facts) {
            historyBlockTokens += estimateTokens(`* ${f.content}\n`);
        }

        const budgetTokens =
            historyBudgetPercentage && contextLimit > 0
                ? Math.floor(contextLimit * historyBudgetPercentage)
                : null;
        const budgetUsage = budgetTokens
            ? ((historyBlockTokens / budgetTokens) * 100).toFixed(0)
            : null;

        lines.push(
            "",
            "### History Compression",
            `- Compartments: ${compartments.length}`,
            `- Facts: ${facts.length}`,
            `- History block: ~${historyBlockTokens.toLocaleString()} tokens`,
            ...(budgetTokens
                ? [
                      `- Compression budget: ~${budgetTokens.toLocaleString()} tokens (${budgetUsage}% used)`,
                      `- Compressor fires: when history block exceeds budget after historian run`,
                  ]
                : [`- Compression budget: not configured (history_budget_percentage not set)`]),
        );

        if (pendingOps.length > 0) {
            lines.push("", "### Queued Operations");
            for (const op of pendingOps) {
                lines.push(`- §${op.tagId}§ → ${op.operation}`);
            }
        }

        return lines.join("\n");
    } catch (error) {
        sessionLog(sessionId, "ctx-status failed:", error);
        return `Error: Failed to read context status. ${getErrorMessage(error)}`;
    }
}
