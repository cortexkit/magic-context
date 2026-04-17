/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";

/**
 * Cache stability across defer passes.
 *
 * The whole point of magic-context is to keep the Anthropic prompt cache alive
 * across turns. That depends on the plugin producing a BYTE-IDENTICAL prefix
 * (system prompt + prior messages) on every defer-pass transform.
 *
 * "Prefix" excludes the tail: OpenCode deliberately moves the
 * `cache_control: { type: "ephemeral" }` mark to the latest message each turn
 * to extend the cache boundary forward. That's expected. We strip it before
 * comparing.
 *
 * This test drives several low-pressure turns (all below execute_threshold so
 * every pass is a defer) and verifies that:
 *
 *   1. The system field text stays byte-identical across turns 2..N.
 *   2. Each message in the prefix (everything except the latest user turn)
 *      stays byte-identical across turns 2..N, after stripping cache_control.
 *
 * If any mutation slips in on a defer pass — a stale date line, a newly
 * stripped placeholder, a drifted hash token — the prefix will differ and
 * this test catches it.
 */

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        magicContextConfig: {
            execute_threshold_percentage: 80,
            compaction_markers: false,
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

/** Remove cache_control fields so only durable content is compared. */
function stripCacheControl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripCacheControl);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            if (k === "cache_control") continue;
            out[k] = stripCacheControl(v);
        }
        return out;
    }
    return value;
}

function serialize(value: unknown): string {
    return JSON.stringify(stripCacheControl(value));
}

describe("cache stability", () => {
    it("system prompt stays stable across defer passes", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "ok",
            usage: {
                input_tokens: 200,
                output_tokens: 10,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 100,
            },
        });

        const sessionId = await h.createSession();

        const turnCount = 5;
        for (let i = 1; i <= turnCount; i++) {
            await h.sendPrompt(sessionId, `turn ${i}: probe message for cache stability.`);
        }

        const mainRequests = h.mock.requests().filter((r) => {
            const sys = r.body.system;
            const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
            return asString.includes("## Magic Context");
        });
        expect(mainRequests.length).toBeGreaterThanOrEqual(turnCount);

        // Compare system fields across turns 2..N (turn 1 establishes the
        // cache). cache_control is moved turn-by-turn by OpenCode, so we strip
        // it before comparison.
        const systems = new Set<string>();
        for (let i = 1; i < mainRequests.length; i++) {
            systems.add(serialize(mainRequests[i]!.body.system));
        }
        if (systems.size !== 1) {
            console.log(`[TEST] ${systems.size} distinct system variants`);
        }
        expect(systems.size).toBe(1);
    }, 60_000);

    it("prefix messages stay stable across defer passes", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "ok",
            usage: {
                input_tokens: 200,
                output_tokens: 10,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 100,
            },
        });

        const sessionId = await h.createSession();

        const turnCount = 5;
        for (let i = 1; i <= turnCount; i++) {
            await h.sendPrompt(sessionId, `turn ${i}: probe message for cache stability.`);
        }

        const mainRequests = h.mock.requests().filter((r) => {
            const sys = r.body.system;
            const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
            return asString.includes("## Magic Context");
        });
        expect(mainRequests.length).toBeGreaterThanOrEqual(turnCount);

        // For each PAIR of adjacent turns, the messages of the earlier turn's
        // request must be a byte-identical prefix of the later turn's messages
        // (after stripping cache_control). If the plugin mutates any earlier
        // message on a defer pass, this prefix-match breaks.
        for (let i = 1; i < mainRequests.length - 1; i++) {
            const earlier = mainRequests[i]!.body.messages as unknown[];
            const later = mainRequests[i + 1]!.body.messages as unknown[];
            expect(earlier.length).toBeLessThanOrEqual(later.length);
            // The earlier array, in full, must appear byte-for-byte at the
            // start of the later array.
            for (let j = 0; j < earlier.length; j++) {
                const earlierMsg = serialize(earlier[j]);
                const laterMsg = serialize(later[j]);
                if (earlierMsg !== laterMsg) {
                    console.log(
                        `[TEST] prefix mismatch at turn pair ${i}/${i + 1} message ${j}:`,
                    );
                    console.log(`  earlier: ${earlierMsg.slice(0, 300)}`);
                    console.log(`  later:   ${laterMsg.slice(0, 300)}`);
                }
                expect(earlierMsg).toBe(laterMsg);
            }
        }
    }, 60_000);
});
