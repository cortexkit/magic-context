/// <reference types="bun-types" />

import { openTestDb } from "../src/test-db";
import { afterAll, beforeAll, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

    // The reported turn ran three tool steps and then a fourth call that hit the
    // model window (prompt plus output one token over the limit), so it ended on
    // `length`. Its usage was stored by the host but never appeared in the plugin
    // log. The plugin writes an `event message.updated` line for every assistant
    // update it receives, so this checks that the fourth step's update is both
    // received (log line with its exact numbers) and applied (pressure state).
    it("logs and records the fourth step's usage when it ends on the output limit", async () => {
        h.mock.reset();
        let toolSteps = 0;
        h.mock.addMatcher((body) => {
            if (toolSteps >= 3) return null;
            const tools = Array.isArray(body.tools) ? body.tools : [];
            const bash = tools
                .map((t) => (t && typeof t === "object" ? (t as { name?: unknown }).name : null))
                .find((n) => typeof n === "string" && /(^|_)bash$/.test(n)) as string | undefined;
            if (!bash) return null;
            toolSteps += 1;
            return {
                content: [
                    {
                        type: "tool_use",
                        id: `toolu_length_step_${toolSteps}`,
                        name: bash,
                        input: { command: `echo step ${toolSteps}`, description: "print a line" },
                    },
                ],
                stop_reason: "tool_use" as const,
                usage: TOOL_STEP_USAGE,
            };
        });
        h.mock.setDefault({
            text: "cut off",
            stop_reason: "max_tokens",
            usage: { ...FINAL_STEP_USAGE, output_tokens: 262_144 - FINAL_STEP_PROMPT + 1 },
        });

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "run three things", { timeoutMs: 90_000 });
        await h.waitForMockQuiescence({ label: "four-step turn settles" });
        expect(toolSteps).toBe(3);

        const hostDb = openTestDb(join(h.dataDir, "opencode", "opencode.db"), {
            readonly: true,
        });
        const finalRow = await h.waitFor(
            () => {
                const rows = hostDb
                    .prepare(
                        "SELECT id, json_extract(data, '$.finish') AS finish, json_extract(data, '$.tokens.input') AS input FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created DESC, id DESC LIMIT 1",
                    )
                    .all(sessionId) as Array<{ id: string; finish: string | null; input: number }>;
                const row = rows[0];
                return row && row.input === FINAL_STEP_USAGE.input_tokens ? row : null;
            },
            { timeoutMs: 10_000, label: "fourth step stored by the host" },
        );
        hostDb.close();
        expect(finalRow?.finish).toBe("length");

        const logPath = join(h.dataDir, "cortexkit", "magic-context-e2e.log");
        const finalLine = `[${sessionId}] event message.updated: provider=mock-anthropic model=mock-sonnet hasUsageTokens=true tokens.input=${FINAL_STEP_USAGE.input_tokens} cache.read=${FINAL_STEP_USAGE.cache_read_input_tokens} cache.write=${FINAL_STEP_USAGE.cache_creation_input_tokens} message.id=${finalRow?.id} session.id=${sessionId}`;
        const logged = await h.waitFor(
            () => {
                if (!existsSync(logPath)) return null;
                const lines = readFileSync(logPath, "utf8")
                    .split("\n")
                    .filter((line) => line.includes(finalLine));
                return lines.length > 0 ? lines : null;
            },
            { timeoutMs: 10_000, label: "fourth step's message.updated logged" },
        );
        expect(logged?.length).toBeGreaterThan(0);

        const meta = h
            .contextDb()
            .prepare("SELECT last_input_tokens FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { last_input_tokens: number } | null;
        expect(meta?.last_input_tokens).toBe(FINAL_STEP_PROMPT);
    }, 150_000);
});
