/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";

const HISTORIAN_SYSTEM_MARKER = "You condense long AI coding sessions";

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

function findOrdinalRange(body: Record<string, unknown>): { start: number; end: number } | null {
    const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
    if (!messages) return null;
    for (const m of messages) {
        const contentArr = Array.isArray(m.content) ? m.content : [];
        for (const block of contentArr) {
            const text = (block as { text?: string }).text;
            if (!text || !text.includes("<new_messages>")) continue;
            const nums: number[] = [];
            for (const match of text.matchAll(/\[(\d+)\]/g)) nums.push(Number(match[1]));
            if (nums.length === 0) continue;
            return { start: Math.min(...nums), end: Math.max(...nums) };
        }
    }
    return null;
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

describe("pi historian success path", () => {
    it(
        "publishes a pi compartment to the DB after a successful run",
        async () => {
            h.mock.reset();
            h.mock.addMatcher((body) => {
                if (!isHistorianRequest(body)) return null;
                const range = findOrdinalRange(body);
                if (!range) {
                    return {
                        text: "<output><compartments></compartments><facts></facts><unprocessed_from>1</unprocessed_from></output>",
                        usage: {
                            input_tokens: 500,
                            output_tokens: 50,
                            cache_creation_input_tokens: 500,
                            cache_read_input_tokens: 0,
                        },
                    };
                }
                return {
                    text: [
                        "<output>",
                        "<compartments>",
                        `<compartment start="${range.start}" end="${range.end}" title="Pi e2e test chunk">`,
                        "Driven by the Pi e2e harness to exercise historian publication.",
                        "</compartment>",
                        "</compartments>",
                        "<facts></facts>",
                        `<unprocessed_from>${range.end + 1}</unprocessed_from>`,
                        "</output>",
                    ].join("\n"),
                    usage: {
                        input_tokens: 500,
                        output_tokens: 200,
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
                await h.sendPrompt(`turn ${i}: meaningful pi prompt carrying durable signal ${i}.`);
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
            const trigger = await h.sendPrompt("turn 11: trigger pi historian with real content.");
            const sessionId = trigger.sessionId;
            expect(sessionId).toBeTruthy();

            h.mock.setDefault({
                text: "after-trigger",
                usage: {
                    input_tokens: 500,
                    output_tokens: 10,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 500,
                },
            });
            await h.sendPrompt("turn 12: post-trigger pi follow-up.", { continueSession: true });

            await Bun.sleep(300);
            await h.waitFor(
                () => {
                    const row = h
                        .contextDb()
                        .prepare(
                            "SELECT COUNT(*) as c FROM compartments WHERE session_id = ? AND harness = 'pi'",
                        )
                        .get(sessionId) as { c: number } | null;
                    return (row?.c ?? 0) >= 1;
                },
                { timeoutMs: 30_000, label: "pi compartment row appears" },
            );

            const compartmentCount = (
                h
                    .contextDb()
                    .prepare(
                        "SELECT COUNT(*) as c FROM compartments WHERE session_id = ? AND harness = 'pi'",
                    )
                    .get(sessionId) as { c: number }
            ).c;
            console.log(`[TEST] pi compartment rows after historian: ${compartmentCount}`);
            expect(compartmentCount).toBeGreaterThanOrEqual(1);

            const historianRequests = h.mock.requests().filter((r) => isHistorianRequest(r.body));
            console.log(`[TEST] pi historian requests: ${historianRequests.length}`);
            expect(historianRequests.length).toBeGreaterThanOrEqual(1);

            const meta = h
                .contextDb()
                .prepare("SELECT compartment_in_progress FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { compartment_in_progress: number } | null;
            console.log(
                `[TEST] pi compartment_in_progress after historian: ${meta?.compartment_in_progress}`,
            );
            expect(meta?.compartment_in_progress ?? 1).toBe(0);
        },
        120_000,
    );
});
