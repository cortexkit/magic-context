import { describe, expect, it } from "bun:test"
import {
    COLLAPSED_KV_KEY,
    COLLAPSED_USER_SET_KV_KEY,
    compactTokens,
    collapsedStatusLine,
    collapsedUsageLine,
    collapsedUsagePercentSegment,
    collapsedUsageTokensSegment,
    parseTuiSidebarSettings,
    persistSidebarCollapsed,
    resolveInitialSidebarCollapsed,
} from "./sidebar-utils"
import type { SidebarSnapshot } from "../../shared/rpc-types"

// ---------------------------------------------------------------------------
// compactTokens
// ---------------------------------------------------------------------------
describe("compactTokens", () => {
    it("returns the number as-is below 1000", () => {
        expect(compactTokens(0)).toBe("0")
        expect(compactTokens(1)).toBe("1")
        expect(compactTokens(500)).toBe("500")
        expect(compactTokens(999)).toBe("999")
    })

    it("formats thousands with K suffix (no decimal)", () => {
        expect(compactTokens(1_000)).toBe("1K")
        expect(compactTokens(10_000)).toBe("10K")
        expect(compactTokens(999_999)).toBe("999K")
    })

    it("formats millions with M suffix (one decimal)", () => {
        expect(compactTokens(1_000_000)).toBe("1.0M")
        expect(compactTokens(1_200_000)).toBe("1.2M")
        expect(compactTokens(100_000_000)).toBe("100.0M")
    })

    it("handles very small values correctly", () => {
        expect(compactTokens(0)).toBe("0")
        expect(compactTokens(1)).toBe("1")
        expect(compactTokens(99)).toBe("99")
    })

    it("handles boundary between K and M", () => {
        expect(compactTokens(999_999)).toBe("999K")
        expect(compactTokens(1_000_000)).toBe("1.0M")
    })
})

// ---------------------------------------------------------------------------
// parseTuiSidebarSettings
// ---------------------------------------------------------------------------
describe("parseTuiSidebarSettings", () => {
    it("returns defaults for missing config", () => {
        expect(parseTuiSidebarSettings(null)).toEqual({ collapseDefault: false })
        expect(parseTuiSidebarSettings({})).toEqual({ collapseDefault: false })
    })

    it("reads collapse_default from tui.sidebar", () => {
        expect(
            parseTuiSidebarSettings({
                tui: { sidebar: { collapse_default: true } },
            }),
        ).toEqual({ collapseDefault: true })
    })

    it("reads and clamps compact_bar thresholds", () => {
        expect(
            parseTuiSidebarSettings({
                tui: {
                    compact_bar: {
                        label_threshold: 0.99,
                        free_label_threshold: 0.01,
                        show_free_label: false,
                    },
                },
            }),
        ).toEqual({
            collapseDefault: false,
            compactBarOptions: {
                labelThreshold: 0.5,
                freeLabelThreshold: 0.1,
                showFreeLabel: false,
            },
        })
    })
})

// ---------------------------------------------------------------------------
// resolveInitialSidebarCollapsed
// ---------------------------------------------------------------------------
describe("resolveInitialSidebarCollapsed", () => {
    it("uses collapse_default when user has not toggled", () => {
        const kv = new Map<string, unknown>()
        const api = {
            get: (key: string, def: unknown) => kv.get(key) ?? def,
            set: (key: string, val: unknown) => {
                kv.set(key, val)
            },
        }
        expect(resolveInitialSidebarCollapsed(api, true)).toBe(true)
        expect(resolveInitialSidebarCollapsed(api, false)).toBe(false)
        expect(kv.has(COLLAPSED_KV_KEY)).toBe(false)
    })

    it("uses KV when user has toggled", () => {
        const kv = new Map<string, unknown>([
            [COLLAPSED_USER_SET_KV_KEY, true],
            [COLLAPSED_KV_KEY, false],
        ])
        const api = {
            get: (key: string, def: unknown) => kv.get(key) ?? def,
            set: (key: string, val: unknown) => {
                kv.set(key, val)
            },
        }
        expect(resolveInitialSidebarCollapsed(api, true)).toBe(false)
    })

    it("persistSidebarCollapsed marks user-set and stores value", () => {
        const kv = new Map<string, unknown>()
        const api = {
            get: (key: string, def: unknown) => kv.get(key) ?? def,
            set: (key: string, val: unknown) => {
                kv.set(key, val)
            },
        }
        persistSidebarCollapsed(api, true)
        expect(kv.get(COLLAPSED_KV_KEY)).toBe(true)
        expect(kv.get(COLLAPSED_USER_SET_KV_KEY)).toBe(true)
        expect(resolveInitialSidebarCollapsed(api, false)).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// collapsedStatusLine
// ---------------------------------------------------------------------------
describe("collapsedStatusLine", () => {
    const baseSnapshot = (overrides: Partial<SidebarSnapshot> = {}): SidebarSnapshot => ({
        usagePercentage: 0,
        inputTokens: 0,
        limitTokens: 0,
        executeThreshold: 65,
        contextLimit: 200_000,
        systemPromptTokens: 0,
        compartmentTokens: 0,
        factTokens: 0,
        memoryTokens: 0,
        conversationTokens: 0,
        toolCallTokens: 0,
        toolDefinitionTokens: 0,
        historianRunning: false,
        compartmentInProgress: false,
        lastDreamerRunAt: null,
        pendingOpsCount: 0,
        compartmentCount: 3,
        factCount: 5,
        memoryCount: 5,
        memoryBlockCount: 0,
        sessionNoteCount: 0,
        readySmartNoteCount: 0,
        ...overrides,
    })

    it("returns empty string for null snapshot", () => {
        expect(collapsedStatusLine(null)).toBe("")
    })

    it("reports historian compacting when historianRunning is true", () => {
        const result = collapsedStatusLine(baseSnapshot({ historianRunning: true }))
        expect(result).toContain("compacting")
        expect(result).toContain("⟳")
    })

    it("reports historian compacting when compartmentInProgress is true", () => {
        const result = collapsedStatusLine(baseSnapshot({ compartmentInProgress: true }))
        expect(result).toContain("compacting")
        expect(result).toContain("⟳")
    })

    it("prefers historian/compaction over dreamer", () => {
        const result = collapsedStatusLine(
            baseSnapshot({
                historianRunning: true,
                lastDreamerRunAt: Date.now() - 10_000,
            }),
        )
        expect(result).toContain("compacting")
    })

    it("reports dreamer active when recently run", () => {
        const result = collapsedStatusLine(
            baseSnapshot({ lastDreamerRunAt: Date.now() - 30_000 }),
        )
        expect(result).toContain("Dreamer")
        expect(result).toContain("⟳")
    })

    it("reports pending queue when ops are waiting", () => {
        const result = collapsedStatusLine(baseSnapshot({ pendingOpsCount: 3 }))
        expect(result).toContain("Queue")
        expect(result).toContain("3 pending")
    })

    it("reports session notes when idle but notes exist", () => {
        const result = collapsedStatusLine(
            baseSnapshot({ sessionNoteCount: 2, readySmartNoteCount: 1 }),
        )
        expect(result).toBe("2 Notes · 1 Smart")
    })

    it("shows static counts when nothing is active", () => {
        const result = collapsedStatusLine(baseSnapshot())
        expect(result).toBe("3 Comp · 5 Fact · 5 Memory")
    })

    it("shows zero counts correctly", () => {
        const result = collapsedStatusLine(
            baseSnapshot({
                historianRunning: false,
                lastDreamerRunAt: null,
                pendingOpsCount: 0,
                compartmentCount: 0,
                factCount: 0,
                memoryCount: 0,
            }),
        )
        expect(result).toBe("0 Comp · 0 Fact · 0 Memory")
    })
})

// ---------------------------------------------------------------------------
// collapsedUsageLine
// ---------------------------------------------------------------------------
describe("collapsedUsageLine", () => {
    it("renders integer threshold without decimals", () => {
        const line = collapsedUsageLine(47.5, 65, 111_000, 180_000)
        expect(line).toBe("47.5% / 65%  111K / 180K")
    })

    it("renders fractional threshold with one decimal via formatThresholdPercent", () => {
        const line = collapsedUsageLine(47.5, 14.099, 111_000, 180_000)
        expect(line).toBe("47.5% / 14.1%  111K / 180K")
    })

    it("shows em-dash for missing threshold", () => {
        const line = collapsedUsageLine(10, null, 1000, 2000)
        expect(line).toBe("10.0% / —%  1K / 2K")
    })

    it("shows em-dash for missing context limit", () => {
        const line = collapsedUsageLine(10, 65, 1000, 0)
        expect(line).toBe("10.0% / 65%  1K / —")
    })

    it("shows em-dash when both threshold and limit are missing", () => {
        const line = collapsedUsageLine(0, undefined, 0, null)
        expect(line).toBe("0.0% / —%  0 / —")
    })

    it("handles small token counts without suffix", () => {
        const line = collapsedUsageLine(0.5, 65, 500, 2000)
        expect(line).toBe("0.5% / 65%  500 / 2K")
    })

    it("accepts a custom compactTokens function", () => {
        const customCompact = (v: number) => `[${v}]`
        const line = collapsedUsageLine(50, 65, 1000, 2000, customCompact)
        expect(line).toBe("50.0% / 65%  [1000] / [2000]")
    })
})

describe("collapsedUsagePercentSegment", () => {
    it("matches formatThresholdPercent for fractional thresholds", () => {
        expect(collapsedUsagePercentSegment(47.5, 14.099)).toBe("47.5% / 14.1%")
    })
})

describe("collapsedUsageTokensSegment", () => {
    it("formats token pair", () => {
        expect(collapsedUsageTokensSegment(111_000, 180_000)).toBe("111K / 180K")
    })
})
