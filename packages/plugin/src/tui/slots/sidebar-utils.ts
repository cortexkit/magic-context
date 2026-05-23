import type { SidebarSnapshot } from "../../shared/rpc-types"

// ---------------------------------------------------------------------------
// Compact bar configuration (from magic-context.jsonc → compact_bar)
// ---------------------------------------------------------------------------

/** User-configurable options for the collapsed sidebar token usage bar. */
export interface CompactBarOptions {
    /** Minimum segment share (0-1) to show the short token-count label on
     * non-Free segments. Higher values reduce label clutter on narrow bars.
     * Default: 0.10 */
    labelThreshold?: number
    /** Minimum segment share (0-1) to show the full "XXK Free" label on the
     * last (free-context) segment. Below this threshold only the number is
     * shown. Default: 0.25 */
    freeLabelThreshold?: number
    /** Whether to append " Free" to the last segment's label. When false,
     * only the token count is shown regardless of segment width.
     * Default: true */
    showFreeLabel?: boolean
}

export const DEFAULT_COMPACT_BAR_OPTIONS: Required<CompactBarOptions> = {
    labelThreshold: 0.10,
    freeLabelThreshold: 0.25,
    showFreeLabel: true,
}

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
