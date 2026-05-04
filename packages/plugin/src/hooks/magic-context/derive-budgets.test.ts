/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    deriveHistorianChunkTokens,
    deriveTriggerBudget,
    resolveHistorianContextLimit,
} from "./derive-budgets";

describe("deriveTriggerBudget", () => {
    it("scales with main_context × execute_threshold × 0.05", () => {
        // 1M × 40% × 5% = 20K
        expect(deriveTriggerBudget(1_000_000, 40)).toBe(20_000);
        // 200K × 65% × 5% = 6.5K
        expect(deriveTriggerBudget(200_000, 65)).toBe(6_500);
    });

    it("clamps at max 50K for very large models with high threshold", () => {
        // 1M × 100% × 5% = 50K (exactly at cap)
        expect(deriveTriggerBudget(1_000_000, 100)).toBe(50_000);
        // 2M × 80% × 5% = 80K → clamp to 50K
        expect(deriveTriggerBudget(2_000_000, 80)).toBe(50_000);
    });

    it("clamps at min 5K for small models", () => {
        // 128K × 65% × 5% = 4.16K → clamp to 5K
        expect(deriveTriggerBudget(128_000, 65)).toBe(5_000);
        // 32K × 40% × 5% = 640 → clamp to 5K
        expect(deriveTriggerBudget(32_000, 40)).toBe(5_000);
    });

    it("handles invalid inputs defensively", () => {
        expect(deriveTriggerBudget(0, 40)).toBe(5_000);
        expect(deriveTriggerBudget(-1, 40)).toBe(5_000);
        expect(deriveTriggerBudget(Number.NaN, 40)).toBe(5_000);
        expect(deriveTriggerBudget(128_000, -10)).toBe(5_000);
        // Callers pass executeThresholdPercentage resolved through
        // resolveExecuteThreshold(), which caps at MAX_EXECUTE_THRESHOLD (80).
        // Values above 100 are not clamped here; scaling proceeds. That's
        // acceptable because the surrounding max clamp of 50K caps any overflow.
        expect(deriveTriggerBudget(128_000, 200)).toBe(12_800); // 128K × 200% × 5%
    });

    it("preserves ~15% of usable as tail_size threshold for the workload baseline", () => {
        // tail_size trigger = triggerBudget × 3
        // For 1M × 40% (the baseline 1M workflow) tail_size should be ~60K,
        // matching the legacy static behavior that worked well there.
        const budget = deriveTriggerBudget(1_000_000, 40);
        const tailSize = budget * 3;
        const usable = 1_000_000 * 0.4;
        expect(tailSize).toBe(60_000);
        expect(tailSize / usable).toBeCloseTo(0.15, 2);
    });

    it("fixes the 128K overflow case by lowering tail_size % of usable", () => {
        // Before the refactor: tail_size=60K on 128K×65% (83K usable) = 72% — broken.
        // After: clamp-to-5K × 3 = 15K tail_size ≈ 18% of usable.
        const budget = deriveTriggerBudget(128_000, 65);
        const tailSize = budget * 3;
        const usable = 128_000 * 0.65;
        expect(tailSize / usable).toBeLessThan(0.25);
    });
});

describe("deriveHistorianChunkTokens", () => {
    it("scales with historian_context × 0.25", () => {
        // 128K × 25% = 32K
        expect(deriveHistorianChunkTokens(128_000)).toBe(32_000);
        // 200K × 25% = 50K (at clamp)
        expect(deriveHistorianChunkTokens(200_000)).toBe(50_000);
    });

    it("clamps at max 50K for huge historian models", () => {
        expect(deriveHistorianChunkTokens(400_000)).toBe(50_000);
        expect(deriveHistorianChunkTokens(1_000_000)).toBe(50_000);
    });

    it("clamps at min 8K for very small historian models", () => {
        expect(deriveHistorianChunkTokens(16_000)).toBe(8_000);
    });

    it("handles invalid inputs defensively", () => {
        expect(deriveHistorianChunkTokens(0)).toBe(8_000);
        expect(deriveHistorianChunkTokens(-1)).toBe(8_000);
        expect(deriveHistorianChunkTokens(Number.NaN)).toBe(8_000);
    });
});

describe("resolveHistorianContextLimit", () => {
    it("returns a positive context limit with no override (scans fallback chain)", () => {
        // No override — should traverse the fallback chain and return the minimum
        // known context across entries (or 128K if nothing resolves).
        const limit = resolveHistorianContextLimit();
        expect(limit).toBeGreaterThan(0);
        expect(limit).toBeLessThanOrEqual(1_000_000);
    });

    it("returns a positive context limit for an explicit provider/model override", () => {
        // Explicit override with / form. Whether or not models.dev knows this
        // model, the function should never return 0 or NaN.
        const limit = resolveHistorianContextLimit("anthropic/claude-sonnet-4-6");
        expect(limit).toBeGreaterThan(0);
        expect(Number.isFinite(limit)).toBe(true);
    });

    it("falls through to chain for provider-less override and returns a positive value", () => {
        // Provider-less override should warn and fall through to the chain
        // (rather than silently returning DEFAULT and losing the derivation).
        const originalWarn = console.warn;
        let warnedWith: string | undefined;
        console.warn = (msg: unknown) => {
            warnedWith = typeof msg === "string" ? msg : String(msg);
        };
        try {
            const limit = resolveHistorianContextLimit("llama3-32k");
            expect(limit).toBeGreaterThan(0);
            expect(warnedWith).toContain("llama3-32k");
        } finally {
            console.warn = originalWarn;
        }
    });
});
