/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";

// TODO(pi --print mode): add Pi historian-success, dreamer-schedule, and
// sidekick/ctx-aug e2e coverage once async listeners/subagent runs survive
// `agent_end` in single-shot mode. Today `pi --print` exits immediately after
// the parent turn, which makes those async features intentionally out of scope.

let h: PiTestHarness;

beforeAll(async () => {
    h = await PiTestHarness.create();
});

afterAll(async () => {
    await h.dispose();
});

describe("pi smoke", () => {
    it("plugin loads, no crash, and tools are registered", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "pi smoke ok",
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100 },
        });

        const turn = await h.sendPrompt("hello from pi smoke", { timeoutMs: 60_000 });
        expect(turn.exitCode).toBe(0);
        expect(turn.stderr).not.toContain("Failed to load extension");
        expect(turn.sessionId).toBeTruthy();

        const req = h.mock.lastRequest();
        expect(req).not.toBeNull();
        const body = JSON.stringify(req!.body);
        expect(body).toContain("hello from pi smoke");
        expect(body).toContain("ctx_search");
        expect(body).toContain("ctx_memory");
        expect(body).toContain("ctx_note");
        expect(h.countTags(turn.sessionId!)).toBeGreaterThan(0);
    }, 60_000);
});
