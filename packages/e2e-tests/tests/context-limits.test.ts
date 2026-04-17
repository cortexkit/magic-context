/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";

/**
 * Context-limit resolution from custom provider config.
 *
 * The plugin's scheduler and thresholds rely on knowing the true context
 * window size for the active model. When a provider is defined in
 * opencode.json with an explicit limit.context, the plugin MUST honor that
 * limit rather than falling back to a default (which historically was
 * 128K for unknown models).
 *
 * This test sets the mock model's context limit to 50_000 tokens, then
 * has the mock return a response worth ~20K tokens. The plugin should
 * record ~40% usage in session_meta (20_000 / 50_000). If the plugin
 * ignored the custom limit and fell back to 128K or 200K, we'd see ~15%
 * or ~10% instead.
 */

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        magicContextConfig: {
            execute_threshold_percentage: 80,
            compaction_markers: false,
        },
        modelContextLimit: 50_000,
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("context-limit resolution", () => {
    it("uses custom provider limit.context when computing percentage", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "ok",
            usage: {
                input_tokens: 20_000,
                output_tokens: 50,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
        });

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "probe turn for context-limit resolution.");

        // Give the event handler a moment to persist last_context_percentage.
        await Bun.sleep(300);

        const row = h
            .contextDb()
            .prepare("SELECT last_context_percentage FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { last_context_percentage: number } | null;

        const pct = row?.last_context_percentage ?? 0;
        console.log(`[TEST] last_context_percentage = ${pct} (expected ~40 for 20K/50K)`);

        // 20_000 / 50_000 = 40%. Tolerate small drift from the exact value since
        // the mock may add a handful of overhead tokens or the plugin may round.
        expect(pct).toBeGreaterThanOrEqual(35);
        expect(pct).toBeLessThanOrEqual(45);
    }, 60_000);
});
