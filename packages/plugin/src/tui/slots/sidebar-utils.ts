import type { SidebarSnapshot } from "../../shared/rpc-types"
import { formatThresholdPercent } from "../../shared/format-threshold"

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

export interface TuiSidebarSettings {
    collapseDefault: boolean
    compactBarOptions?: CompactBarOptions
}

export const COLLAPSED_KV_KEY = "mc-sidebar-collapsed"
export const COLLAPSED_USER_SET_KV_KEY = "mc-sidebar-collapsed-user-set"

type SidebarKv = {
    get: (key: string, defaultValue: unknown) => unknown
    set: (key: string, value: unknown) => void
}

function clampThreshold(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min
    return Math.min(max, Math.max(min, value))
}

/** Parse `tui` section from magic-context.jsonc (pure — no file I/O). */
export function parseTuiSidebarSettings(cfg: Record<string, unknown> | null | undefined): TuiSidebarSettings {
    const result: TuiSidebarSettings = { collapseDefault: false }
    if (!cfg || typeof cfg !== "object") return result

    const tuiSection = cfg.tui
    if (!tuiSection || typeof tuiSection !== "object") return result

    const tui = tuiSection as Record<string, unknown>

    const sidebar = tui.sidebar
    if (sidebar && typeof sidebar === "object") {
        const collapseDefault = (sidebar as Record<string, unknown>).collapse_default
        if (typeof collapseDefault === "boolean") {
            result.collapseDefault = collapseDefault
        }
    }

    const compactBar = tui.compact_bar
    if (compactBar && typeof compactBar === "object") {
        const cb = compactBar as Record<string, unknown>
        const opts: CompactBarOptions = {}
        if (typeof cb.label_threshold === "number") {
            opts.labelThreshold = clampThreshold(cb.label_threshold, 0.05, 0.5)
        }
        if (typeof cb.free_label_threshold === "number") {
            opts.freeLabelThreshold = clampThreshold(cb.free_label_threshold, 0.1, 0.5)
        }
        if (typeof cb.show_free_label === "boolean") {
            opts.showFreeLabel = cb.show_free_label
        }
        if (Object.keys(opts).length > 0) {
            result.compactBarOptions = opts
        }
    }

    return result
}

/** Initial collapse: KV after explicit user toggle, else `collapse_default` from config. */
export function resolveInitialSidebarCollapsed(
    kv: SidebarKv,
    collapseDefault: boolean,
): boolean {
    if (kv.get(COLLAPSED_USER_SET_KV_KEY, false) === true) {
        return kv.get(COLLAPSED_KV_KEY, false) === true
    }
    return collapseDefault
}

export function persistSidebarCollapsed(kv: SidebarKv, collapsed: boolean): void {
    kv.set(COLLAPSED_KV_KEY, collapsed)
    kv.set(COLLAPSED_USER_SET_KV_KEY, true)
}

/**
 * Compact byte/token count to a human-readable string.
 * Examples: 999 → "999", 1000 → "1K", 15300 → "15K", 1_200_000 → "1.2M"
 */
export function compactTokens(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${Math.floor(value / 1_000)}K`
    return String(value)
}

/**
 * Build a one-line status summary for the collapsed sidebar view.
 * Prioritises active operations (historian, dreamer, pending queue, notes)
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
    const noteParts: string[] = []
    if (snap.sessionNoteCount > 0) {
        noteParts.push(`${snap.sessionNoteCount} Notes`)
    }
    if (snap.readySmartNoteCount > 0) {
        noteParts.push(`${snap.readySmartNoteCount} Smart`)
    }
    if (noteParts.length > 0) {
        return noteParts.join(" · ")
    }
    return `${snap.compartmentCount} Comp · ${snap.factCount} Fact · ${snap.memoryCount} Memory`
}

/** Left segment of the collapsed usage header, e.g. `47.5% / 65%`. */
export function collapsedUsagePercentSegment(
    usagePercentage: number,
    executeThreshold: number | undefined | null,
): string {
    return `${usagePercentage.toFixed(1)}% / ${formatThresholdPercent(executeThreshold)}%`
}

/** Right segment of the collapsed usage header, e.g. `111K / 180K`. */
export function collapsedUsageTokensSegment(
    inputTokens: number,
    contextLimit: number | undefined | null,
    compactTokensFn: (v: number) => string = compactTokens,
): string {
    const used = compactTokensFn(inputTokens)
    const limit =
        typeof contextLimit === "number" && contextLimit > 0
            ? compactTokensFn(contextLimit)
            : "—"
    return `${used} / ${limit}`
}

/**
 * Summary usage string for the collapsed header line.
 * Returns something like `47.5% / 65%  111K / 180K`
 */
export function collapsedUsageLine(
    usagePercentage: number,
    executeThreshold: number | undefined | null,
    inputTokens: number,
    contextLimit: number | undefined | null,
    compactTokensFn: (v: number) => string = compactTokens,
): string {
    const left = collapsedUsagePercentSegment(usagePercentage, executeThreshold)
    const right = collapsedUsageTokensSegment(inputTokens, contextLimit, compactTokensFn)
    return `${left}  ${right}`
}

export { formatThresholdPercent } from "../../shared/format-threshold"
