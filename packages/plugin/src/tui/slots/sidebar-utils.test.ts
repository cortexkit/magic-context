import { describe, expect, it } from "bun:test"
import { compactTokens, collapsedStatusLine, collapsedUsageLine } from "./sidebar-utils"
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
        expect(compactTokens(999_999)).toBe("1000K") // 999999/1000 = 999.999 → "1000K"
    })

    it("formats millions with M suffix (one decimal)", () => {
        expect(compactTokens(1_000_000)).toBe("1.0M")
        expect(compactTokens(1_200_000)).toBe("1.2M")
        expect(compactTokens(100_000_000)).toBe("100.0M")
    })

    it("handles very small values correctly", () => {
        // Below 1000 — no suffix
        expect(compactTokens(0)).toBe("0")
        expect(compactTokens(1)).toBe("1")
        expect(compactTokens(99)).toBe("99")
    })

    it("handles boundary between K and M", () => {
        // Exactly at the threshold
        expect(compactTokens(999_999)).toBe("1000K") // rounds up
        expect(compactTokens(1_000_000)).toBe("1.0M")
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
        // Both active — historian wins
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

    it("renders fractional threshold with one decimal", () => {
        const line = collapsedUsageLine(47.5, 14.099, 111_000, 180_000)
        expect(line).toBe("47.5% / 14%  111K / 180K")
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
