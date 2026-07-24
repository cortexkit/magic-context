import { DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE } from "../../config/schema/magic-context";
import { getCompartments } from "../../features/magic-context/compartment-storage";
import { parseCacheTtl } from "../../features/magic-context/scheduler";
import { getPendingOps } from "../../features/magic-context/storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import { getTagsBySession } from "../../features/magic-context/storage-tags";
import { getErrorMessage } from "../../shared/error-message";
import { formatThresholdClampNote } from "../../shared/format-threshold";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    getProactiveCompartmentTriggerPercentage,
    POST_DROP_TARGET_RATIO,
} from "./compartment-trigger";
import {
    type ExecuteThresholdDetail,
    MAX_EXECUTE_THRESHOLD,
    resolveExecuteThresholdDetail,
} from "./event-resolvers";
import { formatBytes } from "./format-bytes";
import { estimateTokens } from "./read-session-formatting";

function formatExecuteThreshold(detail: ExecuteThresholdDetail, contextLimit: number): string {
    const { percentage, mode } = detail;
    // Surfaces the silent clamp from issue #241: when the configured value exceeded
    // the 80% safety cap, append a note showing the configured value and the cap so
    // the user sees the math (e.g. "190,000 > 80% of 128,000"). "" when not clamped.
    const clampNote = formatThresholdClampNote({
        clamped: detail.clamped,
        mode,
        configuredValue: detail.configuredValue,
        contextLimit,
        maxPercentage: MAX_EXECUTE_THRESHOLD,
    });
    if (mode === "tokens" && contextLimit > 0) {
        const tokens = Math.floor((percentage / 100) * contextLimit);
        return `${tokens.toLocaleString()} tokens (${percentage.toFixed(1)}% of ${contextLimit.toLocaleString()}) [token-mode]${clampNote}`;
    }
    if (contextLimit > 0) {
        const tokens = Math.floor((percentage / 100) * contextLimit);
        return `${percentage}% (${tokens.toLocaleString()} of ${contextLimit.toLocaleString()})${clampNote}`;
    }
    return `${percentage}%${clampNote}`;
}

export function executeStatus(
    db: Database,
    sessionId: string,
    protectedTags: number,
    executeThresholdPercentageConfig:
        | number
        | { default: number; [modelKey: string]: number } = DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
    liveModelKey?: string,
    historyBudgetPercentage?: number,
    commitClusterTrigger?: { enabled: boolean; min_clusters: number },
    executeThresholdTokens?: { default?: number; [modelKey: string]: number | undefined },
    contextLimit?: number,
): string {
    // Single source of truth — resolver tells us both the effective percentage AND
    // which config source won (tokens vs percentage). Previously /ctx-status
    // reimplemented the token-match check here and missed progressive base-model
    // lookup (e.g. `openai/gpt-5.4-fast` → `openai/gpt-5.4`), causing display drift.
    const thresholdDetail = resolveExecuteThresholdDetail(
        executeThresholdPercentageConfig,
        liveModelKey,
        DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
        {
            tokensConfig: executeThresholdTokens,
            contextLimit,
            sessionId,
        },
    );
    const executeThresholdPercentage = thresholdDetail.percentage;
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

        const proactiveCompartmentTrigger = getProactiveCompartmentTriggerPercentage(
            executeThresholdPercentage,
        );

        const displayContextLimit =
            contextLimit && contextLimit > 0
                ? contextLimit
                : meta.lastContextPercentage > 0
                  ? Math.round(meta.lastInputTokens / (meta.lastContextPercentage / 100))
                  : 0;

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
            `- Remaining: ${cacheExpired ? "expired" : ttlMs === Number.POSITIVE_INFINITY ? "never expires (always-warm lane)" : `${Math.round(remainingMs / 1000)}s`}`,
            `- Queue will auto-execute: ${cacheExpired ? "yes (cache expired)" : ttlMs === Number.POSITIVE_INFINITY ? `when context >= ${executeThresholdPercentage}%` : `when TTL expires or context >= ${executeThresholdPercentage}%`}`,
            "",
            "### Execute Threshold",
            `- Execute threshold: ${formatExecuteThreshold(thresholdDetail, displayContextLimit)}`,
            `- Last input tokens: ${meta.lastInputTokens.toLocaleString()} tokens`,
            "",
            `**Protected tags:** ${protectedTags}`,
            `**Subagent session:** ${meta.isSubagent}`,
        ];

        if (meta.lastContextPercentage > 0 || meta.lastInputTokens > 0) {
            lines.push(
                "",
                "### Context Usage",
                `- Last percentage: ${meta.lastContextPercentage.toFixed(1)}%`,
                `- Last input tokens: ${meta.lastInputTokens.toLocaleString()}`,
                `- Resolved context limit: ${displayContextLimit > 0 ? displayContextLimit.toLocaleString() : "unknown"}`,
                `- Proactive compartment evaluation: ${proactiveCompartmentTrigger}%`,
                `- Post-drop target for historian: ${(executeThresholdPercentage * POST_DROP_TARGET_RATIO).toFixed(0)}% (${executeThresholdPercentage}% * ${POST_DROP_TARGET_RATIO})`,
                `- Commit cluster trigger: ${commitClusterTrigger?.enabled !== false ? `enabled (min ${commitClusterTrigger?.min_clusters ?? 3} clusters)` : "disabled"}, tail-size trigger: > 3x compartment budget`,
            );
        }

        // History Compression section — show current block size vs budget.
        // v2: facts are retired as a render source (they are promoted memories
        // now), so they are NOT counted into the history block or shown as a
        // separate count — doing so would mislead operators into thinking facts
        // still render in <session-history>.
        const compartments = getCompartments(db, sessionId);
        let historyBlockTokens = 0;
        for (const c of compartments) {
            historyBlockTokens += estimateTokens(
                `## ${c.startMessage}-${c.endMessage} · ${c.title}\n${c.content}\n`,
            );
        }

        const budgetTokens =
            historyBudgetPercentage && displayContextLimit > 0
                ? Math.floor(
                      displayContextLimit *
                          (Math.min(executeThresholdPercentage, 80) / 100) *
                          historyBudgetPercentage,
                  )
                : null;
        const budgetUsage = budgetTokens
            ? ((historyBlockTokens / budgetTokens) * 100).toFixed(0)
            : null;

        lines.push(
            "",
            "### History Compression",
            `- Compartments: ${compartments.length}`,
            `- History block: ~${historyBlockTokens.toLocaleString()} tokens`,
            ...(budgetTokens
                ? [
                      `- History budget: ~${budgetTokens.toLocaleString()} tokens (${budgetUsage}% used)`,
                      `- Older compartments demote tiers automatically at render time to fit the budget`,
                  ]
                : [`- History budget: not configured (history_budget_percentage not set)`]),
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
