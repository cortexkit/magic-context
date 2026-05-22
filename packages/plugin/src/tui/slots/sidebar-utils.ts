import type { SidebarSnapshot } from "../../shared/rpc-types"

/**
 * Compact byte/token count to a human-readable string.
 * Examples: 999 → "999", 1000 → "1K", 15300 → "15K", 1_200_000 → "1.2M"
 */
export function compactTokens(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`
    return String(value)
}

/**
 * Build a one-line status summary for the collapsed sidebar view.
 * Prioritises active operations (historian, dreamer, pending queue)
 * over static counts.
 */
export function collapsedStatusLine(snap: SidebarSnapshot | null): string {
    if (!snap) return ""
    if (snap.historianRunning || snap.compartmentInProgress) {
        return "Historian compacting ⟳"
    }
    if (snap.lastDreamerRunAt && Date.now() - snap.lastDreamerRunAt < 60_000) {
        return "Dreamer active ⟳"
    }
    if (snap.pendingOpsCount > 0) {
        return `Queue: ${snap.pendingOpsCount} pending`
    }
    return `${snap.compartmentCount} Comp · ${snap.factCount} Fact · ${snap.memoryCount} Memory`
}

/**
 * Summary usage string for the collapsed header line.
 * Returns something like "47.5% / 65%  111K / 180K"
 */
export function collapsedUsageLine(
    usagePercentage: number,
    executeThreshold: number | undefined | null,
    inputTokens: number,
    contextLimit: number | undefined | null,
    compactTokensFn: (v: number) => string = compactTokens,
): string {
    const pct = usagePercentage.toFixed(1)
    const thresh =
        typeof executeThreshold === "number" && Number.isFinite(executeThreshold)
            ? Math.round(executeThreshold).toString()
            : "—"
    const used = compactTokensFn(inputTokens)
    const limit =
        typeof contextLimit === "number" && contextLimit > 0
            ? compactTokensFn(contextLimit)
            : "—"
    return `${pct}% / ${thresh}%  ${used} / ${limit}`
}

export { formatThresholdPercent } from "../../shared/format-threshold"
