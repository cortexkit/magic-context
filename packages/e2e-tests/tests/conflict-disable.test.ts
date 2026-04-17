/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";

/**
 * When OpenCode has auto-compaction enabled, or a conflicting plugin is
 * installed, magic-context MUST self-disable. This prevents double-compaction
 * behavior and guarantees that the plugin is a no-op in environments where
 * another system owns history management.
 *
 * We force conflict by setting `compaction: { auto: true }` in opencode.json.
 * Then we send a normal turn and verify the plugin never created its DB —
 * the cleanest proof that no plugin machinery ran for this session.
 */

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        // Override the usual safe compaction config. Setting auto: true should
        // trip conflict-detection inside the plugin.
        openCodeConfigExtra: {
            compaction: { auto: true, prune: false },
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("conflict detection", () => {
    it(
        "plugin disables itself when opencode auto-compaction is active",
        async () => {
            h.mock.reset();
            h.mock.setDefault({
                text: "ok",
                usage: {
                    input_tokens: 100,
                    output_tokens: 10,
                    cache_creation_input_tokens: 50,
                    cache_read_input_tokens: 50,
                },
            });

            const sessionId = await h.createSession();
            await h.sendPrompt(sessionId, "hello — should not be tagged.");

            // Give any async init a beat; 500ms is plenty because the
            // disabled path never awaits any DB creation.
            await Bun.sleep(500);

            // Invariant: context.db was never created. The plugin bailed out
            // before tagger/scheduler setup.
            expect(h.hasContextDb()).toBe(false);
        },
        60_000,
    );
});
