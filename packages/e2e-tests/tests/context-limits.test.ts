/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import {
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";

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

forEachHost(import.meta.url, "context-limit resolution", (host) => {
    let h: ScenarioHarness;

    beforeAll(async () => {
        h = await createScenarioHarness(host, {
            magicContextConfig: {
                execute_threshold_percentage: 80,
            },
            modelContextLimit: 50_000,
        });
    });

    afterAll(async () => {
        await h.dispose();
    });

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

        // Mock Anthropic uses a shared context window: resolveLimit reserves
        // min(8,192, 25% of 50,000) = 8,192 output tokens, leaving 41,808
        // usable input tokens. The exact pressure is 20,000 / 41,808 * 100.
        // The host can finish the prompt before the usage event is persisted.
        const usage = h.contextDb().prepare(
            `SELECT last_context_percentage FROM session_meta
             WHERE session_id = ? AND harness = ? AND last_context_percentage > 0`,
        );
        const { last_context_percentage: pct } = await h.waitFor(
            () => usage.get(sessionId, h.harnessId) as { last_context_percentage: number } | null,
            { timeoutMs: 5_000, label: `reported context usage for ${sessionId}` },
        );
        console.log(
            `[TEST] last_context_percentage = ${pct} (expected 47.83773440489858 for 20K/41,808)`,
        );

        // Keep the exact value: a broad range would hide changes to the
        // shared-window output reservation arithmetic.
        expect(pct).toBe(47.83773440489858);
    }, 60_000);
});
