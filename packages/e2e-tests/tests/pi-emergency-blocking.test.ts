/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";

const HISTORIAN_SYSTEM_MARKER = "You condense long AI coding sessions";
const CONTEXT_LIMIT = 50_000;
const SPIKE_INPUT_TOKENS = 48_500;

function isHistorianRequest(body: Record<string, unknown>): boolean {
    const system = body.system;
    if (typeof system === "string") return system.includes(HISTORIAN_SYSTEM_MARKER);
    if (Array.isArray(system)) {
        for (const block of system) {
            if (block && typeof block === "object") {
                const text = (block as { text?: unknown }).text;
                if (typeof text === "string" && text.includes(HISTORIAN_SYSTEM_MARKER)) {
                    return true;
                }
            }
        }
    }
    return false;
}

let h: PiTestHarness;

beforeAll(async () => {
    h = await PiTestHarness.create({
        modelContextLimit: CONTEXT_LIMIT,
        magicContextConfig: {
            execute_threshold_percentage: 40,
            compaction_markers: false,
            historian: { model: "anthropic/claude-haiku-4-5" },
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("pi emergency >=95%", () => {
    it(
        "historian is invoked when pi usage crosses 95%",
        async () => {
            h.mock.reset();
            h.mock.addMatcher((body) => {
                if (!isHistorianRequest(body)) return null;
                return {
                    text:
                        "<output>" +
                        "<compartments></compartments>" +
                        "<facts></facts>" +
                        "<unprocessed_from>1</unprocessed_from>" +
                        "</output>",
                    usage: {
                        input_tokens: 500,
                        output_tokens: 50,
                        cache_creation_input_tokens: 500,
                        cache_read_input_tokens: 0,
                    },
                };
            });
            h.mock.setDefault({
                text: "fill",
                usage: {
                    input_tokens: 1_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1_000,
                    cache_read_input_tokens: 0,
                },
            });

            for (let i = 1; i <= 10; i++) {
                await h.sendPrompt(`turn ${i}: meaningful pi content populating raw history.`);
            }

            h.mock.setDefault({
                text: "big",
                usage: {
                    input_tokens: SPIKE_INPUT_TOKENS,
                    output_tokens: 20,
                    cache_creation_input_tokens: SPIKE_INPUT_TOKENS,
                    cache_read_input_tokens: 0,
                },
            });
            const trigger = await h.sendPrompt(
                "turn 11: meaningful pi spike turn that pushes usage past 95%.",
            );
            const sessionId = trigger.sessionId;
            expect(sessionId).toBeTruthy();

            await h.waitFor(
                () => {
                    const meta = h
                        .contextDb()
                        .prepare("SELECT last_input_tokens FROM session_meta WHERE session_id = ?")
                        .get(sessionId) as { last_input_tokens: number } | null;
                    return (meta?.last_input_tokens ?? 0) >= SPIKE_INPUT_TOKENS;
                },
                { timeoutMs: 15_000, label: "pi last_input_tokens reflects 97% spike" },
            );

            const spikeMeta = h
                .contextDb()
                .prepare("SELECT last_input_tokens FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { last_input_tokens: number } | null;
            console.log(`[TEST] pi session_meta.last_input_tokens spike = ${spikeMeta?.last_input_tokens}`);
            expect(spikeMeta?.last_input_tokens ?? 0).toBeGreaterThanOrEqual(SPIKE_INPUT_TOKENS);

            h.mock.setDefault({
                text: "after",
                usage: {
                    input_tokens: 500,
                    output_tokens: 10,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 500,
                },
            });
            await h
                .sendPrompt("turn 12: post-emergency pi follow-up.", { continueSession: true })
                .catch(() => {
                    // Emergency abort path may cancel the in-flight request; invocation is the invariant.
                });

            await h.waitFor(
                () => h.mock.requests().filter((r) => isHistorianRequest(r.body)).length >= 1,
                { timeoutMs: 15_000, label: "at least one pi historian request" },
            );

            const historianRequests = h.mock.requests().filter((r) => isHistorianRequest(r.body));
            console.log(`[TEST] pi historian requests captured: ${historianRequests.length}`);
            expect(historianRequests.length).toBeGreaterThanOrEqual(1);
        },
        120_000,
    );
});
