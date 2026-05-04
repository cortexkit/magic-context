/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";

let h: PiTestHarness;

beforeAll(async () => {
    // Pi pipeline now gates pending_ops application to execute/force passes
    // (mirrors OpenCode's transform-postprocess-phase.ts:172-186 gating: only
    // mutate tag state on execute / flush / force-materialization, never on
    // plain defer passes — mutation otherwise busts provider prompt cache on
    // every tool call once we cross threshold).
    //
    // To make this test reliably trigger execute on the second turn, shrink
    // the context window to 200 tokens and lower threshold to 20%. The mock
    // returns 110 input tokens, so 110/200 = 55% > 20% execute threshold.
    h = await PiTestHarness.create({
        modelContextLimit: 200,
        magicContextConfig: { protected_tags: 1, execute_threshold_percentage: 20 },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("pi drops", () => {
    it("drains pending_ops when drops are queued", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "first response",
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100 },
        });

        const first = await h.sendPrompt("first pi drop target", { timeoutMs: 60_000 });
        expect(first.sessionId).toBeTruthy();
        await h.waitFor(() => h.countTags(first.sessionId!) > 0, { label: "tag ready" });

        const writable = new Database(h.contextDbPath());
        try {
            writable
                .prepare(
                    "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, 1, 'drop', ?, 'pi')",
                )
                .run(first.sessionId!, Date.now());
        } finally {
            writable.close();
        }

        h.mock.reset();
        h.mock.setDefault({
            text: "second response",
            usage: { input_tokens: 110, output_tokens: 10, cache_creation_input_tokens: 110 },
        });
        const second = await h.sendPrompt("second pi turn drains pending ops", {
            timeoutMs: 60_000,
            continueSession: true,
        });
        expect(second.exitCode).toBe(0);

        expect(h.countPendingOps(first.sessionId!)).toBe(0);
        expect(h.countDroppedTags(first.sessionId!)).toBeGreaterThan(0);
        expect(JSON.stringify(h.mock.lastRequest()!.body)).toContain("truncated §1§");
    }, 60_000);
});
