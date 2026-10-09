import {
    DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
    type MagicContextConfig,
} from "../../config/schema/magic-context";
import { getCompartments } from "../../features/magic-context/compartment-storage";
import type {
    DreamTaskBacklogMap,
    DreamTaskFailureState,
    DreamTaskProgress,
} from "../../features/magic-context/dreamer/task-registry";
import {
    formatDreamTaskBacklogs,
    formatDreamTaskFailures,
} from "../../features/magic-context/dreamer/task-registry";
import { getProtectionWindowForSession } from "../../features/magic-context/protection-window";
import { parseCacheTtl } from "../../features/magic-context/scheduler";
import { readSessionCacheTtl } from "../../features/magic-context/session-cache-ttl";
import { getPendingOps } from "../../features/magic-context/storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import { getTagsBySession } from "../../features/magic-context/storage-tags";
import {
    formatCoordinateRebaseNotice,
    readCoordinateRebaseNotice,
} from "../../features/magic-context/store-generation-rebase";
import { formatCacheTtlDisplay, resolveCacheTtlDisplay } from "../../shared/cache-ttl-display";
import {
    type ConfigParseFailure,
    formatConfigParseStatusLine,
} from "../../shared/config-diagnostics";
import { getMagicContextStorageResolution } from "../../shared/data-path";
import { getErrorMessage } from "../../shared/error-message";
import { formatThresholdClampNote } from "../../shared/format-threshold";
import { sessionLog } from "../../shared/logger";
import {
    formatOpenCodeDbMissingStatusLine,
    formatOpenCodeDbReadFailureStatusLine,
    getOpenCodeDbReadFailure,
    openCodeDbPathExists,
    resolveOpenCodeDbPath,
} from "../../shared/opencode-db-path";
import type { TailHygieneStatus } from "../../shared/rpc-types";
import { RUST_MODE_HOST_PATHS_LINE } from "../../shared/rust-mode-status";
import type { Database } from "../../shared/sqlite";
import { renderUserStatusSummary } from "../../shared/status-summary";
import { formatTailHygiene } from "../../shared/tail-hygiene-status";
import { renderUserFacingFailure, userFacingFailureCode } from "../../shared/user-facing-codes";
import {
    formatWindowDerivationLine,
    type WindowGeometryResult,
} from "../../shared/window-geometry";
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
import { reasoningBudgetStatusLine } from "./reasoning-budget-status";

function formatExecuteThreshold(detail: ExecuteThresholdDetail, contextLimit: number): string {
    const { percentage, mode } = detail;
    // Surfaces the silent clamp from issue #241: when the configured value exceeded
    // the 90% safety cap, append a note showing the configured value and the cap so
    // the user sees the math (e.g. "190,000 > 90% of 128,000"). "" when not clamped.
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
    executeThresholdPercentageConfig:
        | number
        | { default: number; [modelKey: string]: number } = DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
    liveModelKey?: string,
    historyBudgetPercentage?: number,
    commitClusterTrigger?: { enabled: boolean; min_clusters: number },
    executeThresholdTokens?: { default?: number; [modelKey: string]: number | undefined },
    contextLimit?: number,
    dreamer?: {
        backlog?: DreamTaskBacklogMap;
        progress?: DreamTaskProgress | null;
        failures?: DreamTaskFailureState[];
        skipped?: string[];
    },
    windowGeometry?: WindowGeometryResult,
    tailHygiene?: TailHygieneStatus,
    contextUsage?: { inputTokens: number; percentage: number },
    rustMode = false,
    display?: {
        cacheTtlConfig: MagicContextConfig["cache_ttl"];
        cacheTtlConfigured: boolean;
        configParseFailures: ConfigParseFailure[];
        diagnostics?: boolean;
        compactionEnabled?: boolean;
    },
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
    const openCodeDbResolution = resolveOpenCodeDbPath();
    const openCodeDbReadFailure = getOpenCodeDbReadFailure();
    const openCodeDbStatusLine = !openCodeDbPathExists(openCodeDbResolution)
        ? formatOpenCodeDbMissingStatusLine(openCodeDbResolution)
        : openCodeDbReadFailure?.path === openCodeDbResolution.path
          ? formatOpenCodeDbReadFailureStatusLine(openCodeDbReadFailure)
          : null;
    try {
        const meta = getOrCreateSessionMeta(db, sessionId);
        const tags = getTagsBySession(db, sessionId);
        const pendingOps = getPendingOps(db, sessionId);
        const protectionWindow = getProtectionWindowForSession(db, sessionId);

        const activeTags = tags.filter((t) => t.status === "active");
        const droppedTags = tags.filter((t) => t.status === "dropped");
        const totalBytes = activeTags.reduce((sum, t) => sum + t.byteSize, 0);

        const ttlDisplay = resolveCacheTtlDisplay({
            frozen: readSessionCacheTtl(db, sessionId),
            configured: display?.cacheTtlConfig ?? "5m",
            configuredExplicitly: display?.cacheTtlConfigured === true,
            modelKey: liveModelKey,
            sessionValue: meta.cacheTtl,
            sessionModelKey: meta.lastObservedModelKey,
        });
        let ttlMs: number;
        try {
            ttlMs = parseCacheTtl(ttlDisplay.value);
        } catch (error) {
            sessionLog(
                sessionId,
                `invalid cache_ttl "${ttlDisplay.value}" in ctx-status; falling back to default 5m`,
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

        const displayInputTokens = contextUsage?.inputTokens ?? meta.lastInputTokens;
        const displayPercentage = contextUsage?.percentage ?? meta.lastContextPercentage;
        const displayContextLimit =
            contextLimit && contextLimit > 0
                ? contextLimit
                : displayPercentage > 0
                  ? Math.round(displayInputTokens / (displayPercentage / 100))
                  : 0;

        const parseFailureLines = (display?.configParseFailures ?? []).map(
            formatConfigParseStatusLine,
        );
        const reasoningLine = reasoningBudgetStatusLine(sessionId);
        const lines: string[] = [
            ...(reasoningLine ? [reasoningLine, ""] : []),
            ...(openCodeDbStatusLine ? [openCodeDbStatusLine, ""] : []),
            ...parseFailureLines,
            ...(parseFailureLines.length > 0 ? [""] : []),
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
                ? ["### Warning", `- ${renderUserFacingFailure("transform_update_failed")}`, ""]
                : []),
            "### Cache TTL",
            `- ${formatCacheTtlDisplay(ttlDisplay)}`,
            `- Last response: ${meta.lastResponseTime > 0 ? `${Math.round(elapsed / 1000)}s ago` : "never"}`,
            `- Remaining: ${cacheExpired ? "expired" : ttlMs === Number.POSITIVE_INFINITY ? "never (MC never assumes expiry — external cache-keep)" : `${Math.round(remainingMs / 1000)}s`}`,
            `- Queue will auto-execute: ${cacheExpired ? "yes (cache expired)" : ttlMs === Number.POSITIVE_INFINITY ? `when context >= ${executeThresholdPercentage}%` : `when TTL expires or context >= ${executeThresholdPercentage}%`}`,
            "",
            "### Execute Threshold",
            `- Execute threshold: ${formatExecuteThreshold(thresholdDetail, displayContextLimit)}`,
            `- Last input tokens: ${displayInputTokens.toLocaleString()} tokens`,
            "",
            `**Protected tool tags:** ${protectionWindow.status.protectedCount} (${protectionWindow.status.protectedMass.toLocaleString()} tokens)`,
            `**Protection floor:** ${protectionWindow.status.floor.toLocaleString()} tokens`,
            `**Subagent session:** ${meta.isSubagent}`,
        ];

        const storage = getMagicContextStorageResolution();
        lines.push("", `**Storage:** ${storage.path} (${storage.source})`);

        if (rustMode) lines.push("", "### Rust Mode", `- ${RUST_MODE_HOST_PATHS_LINE}`);

        if (tailHygiene !== undefined) {
            lines.push(
                "",
                "### Tail Hygiene",
                `- Reclaimable / eligible: ${formatTailHygiene(tailHygiene)}`,
                "- Reasoning is excluded from both terms.",
            );
        }

        if (
            (dreamer?.backlog && Object.keys(dreamer.backlog).length > 0) ||
            (dreamer?.skipped?.length ?? 0) > 0 ||
            (dreamer?.failures?.length ?? 0) > 0
        ) {
            lines.push(
                "",
                "### Dreamer",
                ...(dreamer?.skipped ?? []).map((reason) => `- Skipped: ${reason}`),
                ...(dreamer?.progress
                    ? [
                          `- Running: ${dreamer.progress.task} — ${dreamer.progress.processed}/${dreamer.progress.total} processed`,
                      ]
                    : []),
                // A failing scheduled task shows only as a backlog that never falls unless
                // the scheduler's own failure text is rendered beside the counts.
                ...((dreamer?.failures?.length ?? 0) > 0
                    ? formatDreamTaskFailures(dreamer?.failures ?? []).split("\n")
                    : []),
                ...(dreamer?.backlog ? formatDreamTaskBacklogs(dreamer.backlog).split("\\n") : []),
            );
        }

        if (displayPercentage > 0 || displayInputTokens > 0) {
            lines.push(
                "",
                "### Context Usage",
                `- Last percentage: ${displayPercentage.toFixed(1)}%`,
                `- Last input tokens: ${displayInputTokens.toLocaleString()}`,
                `- Resolved context limit: ${displayContextLimit > 0 ? displayContextLimit.toLocaleString() : "unknown"}`,
                ...(windowGeometry
                    ? [`- ${formatWindowDerivationLine(displayInputTokens, windowGeometry)}`]
                    : []),
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

        if (display?.diagnostics === false) {
            return renderUserStatusSummary(
                {
                    inputTokens: displayInputTokens,
                    usableContextTokens: displayContextLimit,
                    usagePercentage: displayPercentage,
                    cacheLifetime: formatCacheTtlDisplay(ttlDisplay).replace(/^Cache TTL:\s*/, ""),
                    automaticCompressionThreshold:
                        display?.compactionEnabled === false ? null : thresholdDetail.percentage,
                    compression: {
                        state: meta.compartmentInProgress
                            ? "compressing"
                            : compartments.length > 0
                              ? "ready"
                              : "waiting",
                        historyBlockCount: compartments.length,
                    },
                    reclaimable: {
                        toolOutputCount: tailHygiene?.reclaimableToolOutputCount ?? 0,
                        tokens: tailHygiene?.u ?? 0,
                    },
                    memoryCount: 0,
                    noteCount: 0,
                    embedding: { state: "waiting", indexed: 0, total: 0 },
                    warnings: [
                        ...(meta.lastTransformError ? (["transform_update_failed"] as const) : []),
                        ...(parseFailureLines.length > 0
                            ? (["configuration_warning"] as const)
                            : []),
                    ],
                },
                "markdown",
            );
        }

        // What the last store-projection change cost this session. Shown once it
        // has happened and left until the session ends, because a user whose
        // queued reduction was discarded has no other way to find that out.
        const rebaseNotice = readCoordinateRebaseNotice(db, sessionId);
        const rebaseNoticeLine = rebaseNotice ? formatCoordinateRebaseNotice(rebaseNotice) : null;
        if (rebaseNotice && rebaseNoticeLine) {
            lines.push(
                "",
                "### Store Conversion",
                `- The host changed how it stores this conversation (${rebaseNotice.previousGeneration ?? "unrecorded"} → ${rebaseNotice.generation}); saved positions were re-derived from message ids.`,
                `- ${rebaseNoticeLine}.`,
            );
        }

        lines.push(
            "",
            "### History Compression",
            `- Compartments: ${compartments.length}`,
            ...(rebaseNotice && rebaseNotice.unresolvedCompartments > 0
                ? [
                      `- Excluded from range recovery: ${rebaseNotice.unresolvedCompartments} (endpoint message no longer in this host's history)`,
                  ]
                : []),
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

        if (dreamer?.backlog && Object.keys(dreamer.backlog).length > 0) {
            lines.push("", "### Dreamer Backlog", formatDreamTaskBacklogs(dreamer.backlog));
        }
        if (dreamer?.progress) {
            lines.push(
                "",
                "### Dreamer Progress",
                `- ${dreamer.progress.task}: ${dreamer.progress.processed}/${dreamer.progress.total} processed this run`,
            );
        }

        return lines.join("\n");
    } catch (error) {
        sessionLog(
            sessionId,
            `ctx-status failed code=${userFacingFailureCode("status_unavailable")}: ${getErrorMessage(error)}`,
        );
        return `Error: ${renderUserFacingFailure("status_unavailable")}`;
    }
}
