import { formatCacheTtlDisplay } from "./cache-ttl-display";
import type { RunnerStatus, StatusDetail } from "./rpc-types";
import { renderUserFacingFailure, type UserFacingFailureKey } from "./user-facing-codes";

export type StatusCompressionState = "off" | "compressing" | "ready" | "waiting";
export type StatusEmbeddingState = "off" | "running" | "paused" | "stopped" | "ready" | "waiting";

export interface UserStatusSummary {
    inputTokens: number;
    usableContextTokens: number;
    usagePercentage: number;
    cacheLifetime: string;
    automaticCompressionThreshold: number | null;
    compression: {
        state: StatusCompressionState;
        historyBlockCount: number;
    };
    reclaimable: {
        toolOutputCount: number;
        tokens: number;
    };
    memoryCount: number;
    noteCount: number;
    embedding: {
        state: StatusEmbeddingState;
        indexed: number;
        total: number;
    };
    historianRefusal?: {
        stage: string;
        canonicalCause: string;
        detail: string;
    };
    compactionMarker?: StatusDetail["compactionMarker"];
    historianRunner?: RunnerStatus;
    dreamerRunner?: RunnerStatus;
    warnings: UserFacingFailureKey[];
    hiddenVariantWarnings?: string[];
}

export function statusSummaryFromDetail(detail: StatusDetail): UserStatusSummary {
    const compressionState: StatusCompressionState =
        detail.compaction_enabled === false
            ? "off"
            : detail.historianRunning ||
                detail.compartmentInProgress ||
                (detail.recompProgress?.phase === "recomp" &&
                    detail.recompProgress.kind !== "embed")
              ? "compressing"
              : detail.compartmentCount > 0
                ? "ready"
                : "waiting";
    const warnings: UserFacingFailureKey[] = [];
    if (detail.lastTransformError) warnings.push("transform_update_failed");
    if ((detail.historianFailureCount ?? 0) > 0) warnings.push("historian_unavailable");
    if ((detail.configParseFailures?.length ?? 0) > 0) warnings.push("configuration_warning");
    if (detail.embedding?.state === "stopped") warnings.push("embedding_unavailable");
    if ((detail.loggerDiagnostics?.swallowedWriteCount ?? 0) > 0) {
        warnings.push("status_log_unavailable");
    }
    if (detail.memoryMirror?.stalled) warnings.push("memory_mirror_stalled");
    if (detail.compactionMarker?.code) warnings.push("compaction_marker_missing");
    if (detail.memoryAuthorityMismatch) warnings.push("memory_authority_mismatch");
    if ((detail.dreamerFailures?.length ?? 0) > 0) warnings.push("dreamer_task_failing");
    // A whole maintenance pass that never reached its work is a different
    // problem from an individual task that keeps failing, so it gets its own
    // warning rather than sharing that one.
    if (detail.dreamerTickFailure) warnings.push("dreamer_tick_blocked");
    // Host limitations are not failures of this turn, but they belong in the
    // same list: the user needs to see that something they configured or asked
    // for is not running here.
    warnings.push(...(detail.hostLimitations ?? []));

    return {
        inputTokens: detail.inputTokens,
        usableContextTokens: detail.contextLimit,
        usagePercentage: detail.usagePercentage,
        cacheLifetime: formatCacheTtlDisplay({
            value: detail.cacheTtl,
            source: detail.cacheTtlSource ?? "session",
            modelKey: detail.cacheTtlModelKey,
        }).replace(/^Cache TTL:\s*/, ""),
        automaticCompressionThreshold:
            detail.compaction_enabled === false ? null : detail.executeThreshold,
        compression: {
            state: compressionState,
            historyBlockCount: detail.compartmentCount,
        },
        reclaimable: {
            toolOutputCount: detail.tailHygiene?.reclaimableToolOutputCount ?? 0,
            tokens: detail.tailHygiene?.u ?? 0,
        },
        memoryCount: detail.memoryCount,
        noteCount: (detail.sessionNoteCount ?? 0) + (detail.readySmartNoteCount ?? 0),
        embedding: detail.embedding ?? {
            state: "waiting",
            indexed: 0,
            total: 0,
        },
        historianRefusal: detail.historianRefusal,
        historianRunner: detail.historianRunner,
        dreamerRunner: detail.dreamerRunner,
        compactionMarker: detail.compactionMarker,
        warnings: [...new Set(warnings)],
        hiddenVariantWarnings: detail.hiddenVariantWarnings ?? [],
    };
}

function formatCount(value: number): string {
    return Math.round(value).toLocaleString();
}

function compressionText(summary: UserStatusSummary): string {
    const historyBlocks = `${summary.compression.historyBlockCount} history block${
        summary.compression.historyBlockCount === 1 ? "" : "s"
    }`;
    switch (summary.compression.state) {
        case "off":
            return "Off";
        case "compressing":
            return `Compressing history · ${historyBlocks}`;
        case "ready":
            return `Ready · ${historyBlocks}`;
        case "waiting":
            return "Waiting for enough conversation history";
    }
}

/**
 * `host (default for harness opencode)` or `broca (configured)`, plus a note when
 * no completion has run yet in the module's current process and the value is
 * only what the session's route resolves to.
 */
export function runnerText(status: RunnerStatus): string {
    const why =
        status.source === "configured"
            ? "configured"
            : `default for harness ${status.harness || "unknown"}`;
    const observed = status.observed === "last_completion" ? "" : " · no completion yet";
    return `${status.runner} (${why})${observed}`;
}

function reclaimableText(summary: UserStatusSummary): string {
    const count = Math.max(0, Math.floor(summary.reclaimable.toolOutputCount));
    if (count === 0) return "none";
    const outputs = `${count} spent tool output${count === 1 ? "" : "s"}`;
    return `${outputs} (~${Math.round(Math.max(0, summary.reclaimable.tokens) / 1000)}k tokens)`;
}

function embeddingText(summary: UserStatusSummary): string {
    if (summary.embedding.state === "off") return "Off";
    const coverage = `${formatCount(summary.embedding.indexed)} / ${formatCount(summary.embedding.total)} history blocks indexed`;
    switch (summary.embedding.state) {
        case "running":
            return `Running · ${coverage}`;
        case "paused":
            return `Paused · ${coverage}`;
        case "stopped":
            return `Paused after an issue · ${coverage}`;
        case "ready":
            return `Ready · ${coverage}`;
        case "waiting":
            return `Waiting · ${coverage}`;
    }
}

export function renderUserStatusSummary(
    summary: UserStatusSummary,
    style: "markdown" | "plain",
): string {
    const context = `${summary.usagePercentage.toFixed(1)}% of usable context (${formatCount(summary.inputTokens)} / ${
        summary.usableContextTokens > 0 ? formatCount(summary.usableContextTokens) : "?"
    } tokens)`;
    const values: Array<readonly [string, string]> = [
        ["Context", context],
        ["Cache lifetime", summary.cacheLifetime],
        [
            "Automatic compression",
            summary.automaticCompressionThreshold === null
                ? "Off"
                : `at ${summary.automaticCompressionThreshold.toFixed(1)}% of usable context`,
        ],
        ["History compression", compressionText(summary)],
        ["Reclaimable", reclaimableText(summary)],
        [
            "Memory",
            `${formatCount(summary.memoryCount)} memories · ${formatCount(summary.noteCount)} notes`,
        ],
        ["Search indexing", embeddingText(summary)],
    ];
    if (summary.historianRunner) {
        values.push(["Historian runner", runnerText(summary.historianRunner)]);
    }
    if (summary.dreamerRunner) {
        values.push(["Dreamer runner", runnerText(summary.dreamerRunner)]);
    }
    if (summary.historianRefusal) {
        values.push([
            "Historian refusal",
            `${summary.historianRefusal.stage} (${summary.historianRefusal.canonicalCause}) — ${summary.historianRefusal.detail}`,
        ]);
    }
    if (summary.compactionMarker?.code) {
        values.push([
            "History boundary marker",
            `${summary.compactionMarker.code} · ${summary.compactionMarker.attempts} attempts · last error: ${summary.compactionMarker.lastError ?? "unknown"}`,
        ]);
    }
    const lines =
        style === "markdown"
            ? [
                  "## Magic Context Status",
                  "",
                  ...values.map(([label, value]) => `- **${label}:** ${value}`),
              ]
            : ["Magic Context Status", ...values.map(([label, value]) => `${label}: ${value}`)];
    for (const warning of summary.hiddenVariantWarnings ?? []) {
        lines.push(style === "markdown" ? `- **Warning:** ${warning}` : `Warning: ${warning}`);
    }
    for (const warning of summary.warnings) {
        lines.push(
            style === "markdown"
                ? `- **Warning:** ${renderUserFacingFailure(warning)}`
                : `Warning: ${renderUserFacingFailure(warning)}`,
        );
    }
    return lines.join("\n");
}
