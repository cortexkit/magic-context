/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";

const HISTORIAN_SYSTEM_MARKER = "You condense long AI coding sessions";
const HISTORIAN_DELAY_MS = 8_000;

function isHistorianRequest(body: Record<string, unknown>): boolean {
    const system = body.system;
    if (system === undefined || system === null) return false;
    const asString = typeof system === "string" ? system : JSON.stringify(system);
    return asString.includes(HISTORIAN_SYSTEM_MARKER);
}

let h: PiTestHarness;

beforeAll(async () => {
    h = await PiTestHarness.create({
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

describe("pi slow historian vs fast main", () => {
    it(
        "main turns stay responsive while pi historian hangs in background",
        async () => {
            h.mock.reset();
            h.mock.addMatcher((body) => {
                if (!isHistorianRequest(body)) return null;
                return {
                    text:
                        "<output>" +
                        "<compartments></compartments>" +
                        "<facts></facts>" +
                        "<unprocessed_from>99</unprocessed_from>" +
                        "</output>",
                    usage: {
                        input_tokens: 500,
                        output_tokens: 50,
                        cache_creation_input_tokens: 500,
                        cache_read_input_tokens: 0,
                    },
                    delayMs: HISTORIAN_DELAY_MS,
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
                await h.sendPrompt(
                    `turn ${i}: meaningful pi prompt carrying durable signal about build step ${i}.`,
                );
            }

            h.mock.setDefault({
                text: "big",
                usage: {
                    input_tokens: 90_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 90_000,
                    cache_read_input_tokens: 0,
                },
            });
            const trigger = await h.sendPrompt("turn 11: trigger pi historian with meaningful content.");
            const sessionId = trigger.sessionId;
            expect(sessionId).toBeTruthy();

            h.mock.setDefault({
                text: "fast",
                usage: {
                    input_tokens: 500,
                    output_tokens: 10,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 500,
                },
            });

            const historianReqCountBeforeT12 = h.mock
                .requests()
                .filter((r) => isHistorianRequest(r.body)).length;
            expect(historianReqCountBeforeT12).toBe(0);

            const turn12Promise = h.sendPrompt("turn 12: should be fast even with historian running.", {
                continueSession: true,
            });

            const t0 = Date.now();
            await h.waitFor(
                () => {
                    const reqs = h.mock.requests();
                    return reqs.find(
                        (r) =>
                            !isHistorianRequest(r.body) &&
                            JSON.stringify(r.body).includes("turn 12:"),
                    );
                },
                { timeoutMs: 3_000, label: "pi main turn 12 request arrives at mock" },
            );
            const t12RequestArrivedAfterMs = Date.now() - t0;

            console.log(
                `[TEST] pi main turn 12 request arrived at mock after ${t12RequestArrivedAfterMs}ms ` +
                    `(historian has ${HISTORIAN_DELAY_MS}ms delay)`,
            );
            expect(t12RequestArrivedAfterMs).toBeLessThan(HISTORIAN_DELAY_MS - 2_000);

            const historianReqCountAtT12 = h.mock
                .requests()
                .filter((r) => isHistorianRequest(r.body)).length;
            expect(historianReqCountAtT12).toBeGreaterThanOrEqual(historianReqCountBeforeT12);

            await turn12Promise;
            await h.sendPrompt("turn 13: additional pi turn while historian pending.", {
                continueSession: true,
            });
            await h.sendPrompt("turn 14: more pi activity while historian pending.", {
                continueSession: true,
            });

            await h.waitFor(
                () => h.mock.requests().filter((r) => isHistorianRequest(r.body)).length >= 1,
                { timeoutMs: 10_000, label: "pi historian request captured" },
            );

            const historianRequests = h.mock.requests().filter((r) => isHistorianRequest(r.body));
            console.log(`[TEST] pi historian requests observed: ${historianRequests.length}`);
            expect(historianRequests.length).toBe(1);
        },
        120_000,
    );
});
