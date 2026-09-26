/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";
import { forEachHost } from "../src/scenario-hosts";

/**
 * The last step of a multi-step turn must reach Magic Context's pressure state.
 *
 * A turn that runs a tool makes two model calls. OpenCode 1 creates one
 * assistant message per call and publishes `message.updated` with that call's
 * usage at `step-finish`. The numbers here are a real report's: the tool step
 * sent 2,398 new + 165,393 cached tokens, then the tool output made the final
 * step's prompt 89,167 new + 169,811 cached = 258,978 tokens. The next pass
 * must see 258,978, not the tool step's 167,791; otherwise the emergency band
 * never arms for a prompt that is already at the model's limit.
 */

const TOOL_STEP_USAGE = {
    input_tokens: 2_398,
    output_tokens: 40,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 165_393,
};
const FINAL_STEP_USAGE = {
    input_tokens: 89_167,
    output_tokens: 741,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 169_811,
};
const FINAL_STEP_PROMPT = 89_167 + 169_811;

// OpenCode 1 only: the step-per-message event shape is the subject.
forEachHost(import.meta.url, null, () => {
    let h: TestHarness;

    beforeAll(async () => {
        h = await TestHarness.create({
            // Keep the tool step below the execute threshold so the turn stays two
            // plain model calls with no historian run in between.
            magicContextConfig: { execute_threshold_percentage: 90 },
            modelContextLimit: 262_144,
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it("records the final step's usage after a tool step, before the next pass", async () => {
        h.mock.reset();
        let toolEmitted = false;
        h.mock.addMatcher((body) => {
            if (toolEmitted) return null;
            const tools = Array.isArray(body.tools) ? body.tools : [];
            const bash = tools
                .map((t) => (t && typeof t === "object" ? (t as { name?: unknown }).name : null))
                .find((n) => typeof n === "string" && /(^|_)bash$/.test(n)) as string | undefined;
            if (!bash) return null;
            toolEmitted = true;
            return {
                content: [
                    {
                        type: "tool_use",
                        id: "toolu_final_step_usage_01",
                        name: bash,
                        // A large real tool output, the shape that made the reported
                        // prompt jump in one step.
                        input: {
                            command: "head -c 200000 /dev/zero | tr '\\0' a",
                            description: "print a large output",
                        },
                    },
                ],
                stop_reason: "tool_use" as const,
                usage: TOOL_STEP_USAGE,
            };
        });
        h.mock.setDefault({ text: "done", usage: FINAL_STEP_USAGE });

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "run the thing", { timeoutMs: 90_000 });
        await h.waitForMockQuiescence({ label: "tool turn settles" });
        expect(toolEmitted).toBe(true);

        const row = await h.waitFor(
            () => {
                const meta = h
                    .contextDb()
                    .prepare("SELECT last_input_tokens FROM session_meta WHERE session_id = ?")
                    .get(sessionId) as { last_input_tokens: number } | null;
                return meta && meta.last_input_tokens === FINAL_STEP_PROMPT ? meta : null;
            },
            { timeoutMs: 10_000, label: "final step usage persisted" },
        );
        expect(row?.last_input_tokens).toBe(FINAL_STEP_PROMPT);
    }, 150_000);
});
