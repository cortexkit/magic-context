import type { StatusDetail } from "./rpc-types";

function formatCount(value: number): string {
    return Math.round(value).toLocaleString();
}

function formatCacheLane(detail: StatusDetail): string {
    if (detail.cacheNeverExpires) return `never expires; TTL ${detail.cacheTtl}`;
    if (detail.lastResponseTime <= 0) return `waiting for first response; TTL ${detail.cacheTtl}`;
    if (detail.cacheExpired) return `expired; TTL ${detail.cacheTtl}`;
    return `live (${Math.round(detail.cacheRemainingMs / 1000)}s remaining); TTL ${detail.cacheTtl}`;
}

/** Render the same StatusDetail payload that powers the TUI dialog for chat-only clients. */
export function formatStatusDetailMarkdown(detail: StatusDetail): string {
    const usableLimit =
        detail.contextLimit > 0
            ? `${formatCount(detail.contextLimit)} usable tokens`
            : "? usable tokens";
    const historianState = detail.historianRunning ? "running" : "idle";
    const historianDetails = [
        detail.boundaryPresent === undefined
            ? undefined
            : `boundary ${detail.boundaryPresent ? "present" : "absent"}`,
        detail.coverageOrdinal === undefined
            ? undefined
            : `coverage ${detail.coverageOrdinal === null ? "none" : detail.coverageOrdinal}`,
    ].filter((value): value is string => value !== undefined);
    const mode =
        detail.compaction_enabled === false
            ? "native compaction (Magic Context history compaction disabled)"
            : "Magic Context compaction";

    const lines = [
        "## Magic Context Status",
        "",
        `- **Mode:** ${mode}`,
        `- **Active profile:** ${detail.activeProfile ?? "none"}`,
        `- **Usage:** ${detail.usagePercentage.toFixed(1)}% (${formatCount(detail.inputTokens)} / ${usableLimit})`,
        `- **Cache lane:** ${formatCacheLane(detail)}`,
        `- **Historian:** ${[historianState, ...historianDetails].join("; ")}`,
        `- **Memory:** ${formatCount(detail.memoryCount)} active; ${formatCount(detail.memoryBlockCount)} injected`,
        `- **Tags:** ${formatCount(detail.activeTags)} active, ${formatCount(detail.droppedTags)} dropped; ${formatCount(detail.pendingOpsCount)} pending drops`,
        `- **Execute threshold:** ${detail.executeThreshold.toFixed(1)}%${detail.executeThresholdClamped ? " (clamped)" : ""}`,
    ];

    if (detail.recompProgress?.phase === "recomp") {
        lines.push(
            `- **${detail.recompProgress.kind === "embed" ? "Embed" : "Historian"} progress:** ${formatCount(detail.recompProgress.processedMessages)} / ${formatCount(detail.recompProgress.totalMessages)}`,
        );
    }
    if (detail.lastTransformError) {
        lines.push(`- **Last transform error:** ${detail.lastTransformError}`);
    }

    return lines.join("\n");
}
