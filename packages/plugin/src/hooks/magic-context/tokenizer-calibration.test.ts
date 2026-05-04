import { describe, expect, it } from "bun:test";
import {
    calibrateBuckets,
    type ModelCalibration,
    resolveModelCalibration,
} from "./tokenizer-calibration";

const NEUTRAL: ModelCalibration = { systemRatio: 1.0, toolsRatio: 1.0 };

describe("resolveModelCalibration", () => {
    it("returns neutral ratios for unknown models", () => {
        const calib = resolveModelCalibration("brand-new-provider", "weird-model-99");
        expect(calib.systemRatio).toBe(1.0);
        expect(calib.toolsRatio).toBe(1.0);
    });

    it("returns neutral when provider or model is missing", () => {
        expect(resolveModelCalibration(undefined, "x")).toEqual(NEUTRAL);
        expect(resolveModelCalibration("y", undefined)).toEqual(NEUTRAL);
    });

    it("matches Anthropic Opus 4.7 outlier ratios", () => {
        const calib = resolveModelCalibration("anthropic", "claude-opus-4-7");
        expect(calib.systemRatio).toBeCloseTo(1.51, 2);
        expect(calib.toolsRatio).toBeCloseTo(1.57, 2);
    });

    it("matches Claude 4.5/4.6 family within range", () => {
        const cases = [
            ["anthropic", "claude-opus-4-5"],
            ["anthropic", "claude-sonnet-4-5"],
            ["anthropic", "claude-haiku-4-5"],
            ["anthropic", "claude-sonnet-4-6"],
        ];
        for (const [provider, model] of cases) {
            const calib = resolveModelCalibration(provider, model);
            expect(calib.systemRatio).toBeCloseTo(1.02, 2);
            expect(calib.toolsRatio).toBeGreaterThanOrEqual(1.14);
            expect(calib.toolsRatio).toBeLessThanOrEqual(1.16);
        }
    });

    it("matches GPT-5.x family across all variants", () => {
        const cases = ["gpt-5", "gpt-5.4", "gpt-5.4-codex", "gpt-5.5", "gpt-5.3-codex"];
        for (const model of cases) {
            const calib = resolveModelCalibration("openai", model);
            expect(calib.systemRatio).toBe(1.0);
            expect(calib.toolsRatio).toBeCloseTo(0.84, 2);
        }
    });

    it("is case-insensitive", () => {
        const lower = resolveModelCalibration("anthropic", "claude-opus-4-7");
        const upper = resolveModelCalibration("Anthropic", "Claude-Opus-4-7");
        expect(upper).toEqual(lower);
    });

    it("uses longest prefix match", () => {
        // claude-opus-4-7 should win over a generic anthropic/claude prefix.
        const opus47 = resolveModelCalibration("anthropic", "claude-opus-4-7");
        const opus45 = resolveModelCalibration("anthropic", "claude-opus-4-5");
        expect(opus47.systemRatio).not.toBe(opus45.systemRatio);
    });

    it("matches Opus 4.7 routed via OpenRouter and GitHub Copilot (regression: A2)", () => {
        // Without explicit prefixes for these routes, the longest-prefix
        // matcher fell through to NEUTRAL and the sidebar misattributed
        // ~30K tokens from System+ToolDefs into Conversation/ToolCalls.
        const cases = [
            ["openrouter/anthropic", "claude-opus-4-7"],
            ["openrouter/anthropic", "claude-opus-4.7"],
            ["github-copilot", "claude-opus-4-7"],
            ["github-copilot", "claude-opus-4.7"],
        ];
        for (const [provider, model] of cases) {
            const calib = resolveModelCalibration(provider, model);
            expect(calib.systemRatio).toBeCloseTo(1.51, 2);
            expect(calib.toolsRatio).toBeCloseTo(1.57, 2);
        }
    });
});

describe("calibrateBuckets", () => {
    it("returns all zeros when inputTokens is 0", () => {
        const out = calibrateBuckets({
            inputTokens: 0,
            systemLocal: 1000,
            toolDefsLocal: 500,
            compartmentsLocal: 100,
            factsLocal: 0,
            memoriesLocal: 0,
            conversationLocal: 200,
            toolCallsLocal: 50,
            calibration: NEUTRAL,
        });
        expect(out.systemTokens).toBe(0);
        expect(out.toolDefinitionTokens).toBe(0);
        expect(out.compartmentTokens).toBe(0);
        expect(out.conversationTokens).toBe(0);
        expect(out.toolCallTokens).toBe(0);
    });

    it("sums to exactly inputTokens with neutral calibration", () => {
        const out = calibrateBuckets({
            inputTokens: 100_000,
            systemLocal: 16_000,
            toolDefsLocal: 21_000,
            compartmentsLocal: 80_000,
            factsLocal: 50,
            memoriesLocal: 0,
            conversationLocal: 30_000,
            toolCallsLocal: 60_000,
            calibration: NEUTRAL,
        });
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        expect(sum).toBe(100_000);
    });

    it("applies system_ratio and tools_ratio to calibrated buckets", () => {
        // 2x system multiplier doubles the system bucket; verbatim and residual
        // buckets are untouched. Local 10K system + 0 tools + 0 verbatim + 30K
        // conversation = 40K total raw. After 2x system: stable=20K, residual
        // target = 50K - 20K = 30K → conversation = 30K.
        const out = calibrateBuckets({
            inputTokens: 50_000,
            systemLocal: 10_000,
            toolDefsLocal: 0,
            compartmentsLocal: 0,
            factsLocal: 0,
            memoriesLocal: 0,
            conversationLocal: 30_000,
            toolCallsLocal: 0,
            calibration: { systemRatio: 2.0, toolsRatio: 1.0 },
        });
        expect(out.systemTokens).toBe(20_000);
        expect(out.conversationTokens).toBe(30_000);
        expect(out.systemTokens + out.conversationTokens).toBe(50_000);
    });

    it("keeps verbatim buckets at local count and absorbs residual into conversation/tool calls", () => {
        // System=1000, tools=500 (calibrated, neutral so no scaling).
        // Verbatim: compartments=1000, facts=500, memories=0 → all stay at local count.
        // Stable + verbatim = 3000. Residual target = 10000 - 3000 = 7000.
        // Residual local = 2000 conv + 500 tool = 2500. Scale = 7000/2500 = 2.8x.
        const out = calibrateBuckets({
            inputTokens: 10_000,
            systemLocal: 1_000,
            toolDefsLocal: 500,
            compartmentsLocal: 1_000,
            factsLocal: 500,
            memoriesLocal: 0,
            conversationLocal: 2_000,
            toolCallsLocal: 500,
            calibration: NEUTRAL,
        });
        // Calibrated stays at local raw count (neutral).
        expect(out.systemTokens).toBe(1_000);
        expect(out.toolDefinitionTokens).toBe(500);
        // Verbatim must equal local input exactly. THIS is the property the
        // user asked for: compartments, facts, memories should not drift.
        expect(out.compartmentTokens).toBe(1_000);
        expect(out.factTokens).toBe(500);
        expect(out.memoryTokens).toBe(0);
        // Residual buckets absorb the remainder proportionally.
        // Conv: 2000 * 2.8 = 5600, ToolCalls: 500 * 2.8 = 1400.
        expect(out.conversationTokens).toBeGreaterThanOrEqual(5_590);
        expect(out.conversationTokens).toBeLessThanOrEqual(5_610);
        expect(out.toolCallTokens).toBeGreaterThanOrEqual(1_390);
        expect(out.toolCallTokens).toBeLessThanOrEqual(1_410);
        // Sum still exactly equals inputTokens.
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        expect(sum).toBe(10_000);
    });

    it("parks the full remainder in conversation when residual local sum is 0", () => {
        // Brand-new session: only system+tools have local content.
        // Conversation has nothing yet, so it absorbs the entire remainder.
        const out = calibrateBuckets({
            inputTokens: 50_000,
            systemLocal: 16_000,
            toolDefsLocal: 21_000,
            compartmentsLocal: 0,
            factsLocal: 0,
            memoriesLocal: 0,
            conversationLocal: 0,
            toolCallsLocal: 0,
            calibration: NEUTRAL,
        });
        expect(out.systemTokens).toBe(16_000);
        expect(out.toolDefinitionTokens).toBe(21_000);
        expect(out.compartmentTokens).toBe(0);
        expect(out.factTokens).toBe(0);
        expect(out.memoryTokens).toBe(0);
        expect(out.conversationTokens).toBe(13_000);
        expect(out.toolCallTokens).toBe(0);
    });

    it("clamps non-residual buckets when calibrated + verbatim exceeds inputTokens", () => {
        // Pathological: large system+tools+compartments locally but tiny
        // inputTokens. System*5 + Tools*5 + Compartments(verbatim) far exceed
        // 1000 inputTokens, so they all scale down proportionally and residuals
        // stay 0.
        const out = calibrateBuckets({
            inputTokens: 1_000,
            systemLocal: 800,
            toolDefsLocal: 800,
            compartmentsLocal: 100,
            factsLocal: 0,
            memoriesLocal: 0,
            conversationLocal: 100,
            toolCallsLocal: 0,
            calibration: { systemRatio: 5.0, toolsRatio: 5.0 },
        });
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        expect(sum).toBeLessThanOrEqual(1_000);
        // After rounding correction, sum equals exactly 1000.
        expect(sum).toBe(1_000);
    });

    it("tiny inputTokens with clamp path: still sums exactly (regression: Oracle final review)", () => {
        // Oracle final-review reproducer: with very small inputTokens, the
        // single-bucket fix from the original A1 patch couldn't absorb a
        // residual overshoot that exceeded that bucket's value. The fix
        // loops through non-residual buckets descending until delta=0.
        const out = calibrateBuckets({
            inputTokens: 2,
            systemLocal: 1,
            toolDefsLocal: 1,
            compartmentsLocal: 2,
            factsLocal: 2,
            memoriesLocal: 0,
            conversationLocal: 1,
            toolCallsLocal: 0,
            calibration: { systemRatio: 1.51, toolsRatio: 1.57 },
        });
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        expect(sum).toBe(2);
        // No bucket goes negative.
        for (const v of [
            out.systemTokens,
            out.toolDefinitionTokens,
            out.compartmentTokens,
            out.factTokens,
            out.memoryTokens,
            out.conversationTokens,
            out.toolCallTokens,
        ]) {
            expect(v).toBeGreaterThanOrEqual(0);
        }
    });

    it("clamp + zero residuals: rounding overshoot does NOT exceed inputTokens (regression: A1)", () => {
        // Council A1: with heavy calibration ratios AND zero conversation/tool-call
        // locals, the clamp path's `Math.round(x * ratio)` overshoots and the
        // residual buckets can't absorb the negative delta (Math.max clamps to 0).
        // Pre-fix, this produced sum=inputTokens+1 in pathological cases.
        // Reproducer from the audit:
        //   inputTokens=1000, system=500, toolDefs=500, compartments=500,
        //   conversation=0, toolCalls=0, ratio 5x → all rounded up by ~0.45 → 1001.
        const out = calibrateBuckets({
            inputTokens: 1_000,
            systemLocal: 500,
            toolDefsLocal: 500,
            compartmentsLocal: 500,
            factsLocal: 0,
            memoriesLocal: 0,
            conversationLocal: 0,
            toolCallsLocal: 0,
            calibration: { systemRatio: 5.0, toolsRatio: 5.0 },
        });
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        // Final sum must be EXACTLY inputTokens — never +1.
        expect(sum).toBe(1_000);
        // Residuals stay zero — they have no local content to scale from.
        expect(out.conversationTokens).toBe(0);
        expect(out.toolCallTokens).toBe(0);
        // No bucket goes negative.
        expect(out.systemTokens).toBeGreaterThanOrEqual(0);
        expect(out.toolDefinitionTokens).toBeGreaterThanOrEqual(0);
        expect(out.compartmentTokens).toBeGreaterThanOrEqual(0);
    });

    it("real-world Opus 4.7 example: verbatim history matches /ctx-status, residual absorbs drift", () => {
        // Live session symptom: System=16500 local, Tools=21400 local,
        // Compartments=89000 local, Conversation=40000 local, ToolCalls=68000
        // local. inputTokens=378000 (Anthropic's billed count). After fix:
        //   System (calibrated)         = 16500 * 1.51 ≈ 24915
        //   Tool Defs (calibrated)      = 21400 * 1.57 ≈ 33598
        //   Compartments (verbatim)     = 89000          ← unchanged
        //   Facts (verbatim)            = 50             ← unchanged
        //   Memories (verbatim)         = 8000           ← unchanged
        //   Residual target             = 378000 - 24915 - 33598 - 89000 - 50 - 8000 ≈ 222437
        //   Residual local              = 40000 + 68000 = 108000
        //   Conv = 40000 * (222437/108000) ≈ 82384
        //   Tool calls = 68000 * (222437/108000) ≈ 140053
        const out = calibrateBuckets({
            inputTokens: 378_000,
            systemLocal: 16_500,
            toolDefsLocal: 21_400,
            compartmentsLocal: 89_000,
            factsLocal: 50,
            memoriesLocal: 8_000,
            conversationLocal: 40_000,
            toolCallsLocal: 68_000,
            calibration: { systemRatio: 1.51, toolsRatio: 1.57 },
        });
        // Calibrated buckets.
        expect(out.systemTokens).toBe(Math.round(16_500 * 1.51));
        expect(out.toolDefinitionTokens).toBe(Math.round(21_400 * 1.57));
        // Verbatim buckets — exact local count, NO scaling. This is the
        // property that fixes the sidebar-vs-/ctx-status mismatch.
        expect(out.compartmentTokens).toBe(89_000);
        expect(out.factTokens).toBe(50);
        expect(out.memoryTokens).toBe(8_000);
        // Residual absorbed by conversation + tool calls.
        expect(out.conversationTokens).toBeGreaterThan(70_000);
        expect(out.toolCallTokens).toBeGreaterThan(120_000);
        // Sum equals inputTokens.
        const sum =
            out.systemTokens +
            out.toolDefinitionTokens +
            out.compartmentTokens +
            out.factTokens +
            out.memoryTokens +
            out.conversationTokens +
            out.toolCallTokens;
        expect(sum).toBe(378_000);
    });
});
