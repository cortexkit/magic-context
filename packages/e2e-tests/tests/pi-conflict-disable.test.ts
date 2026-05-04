/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";

let h: PiTestHarness;

beforeAll(async () => {
    h = await PiTestHarness.create({ magicContextConfig: { enabled: false } });
});

afterAll(async () => {
    await h.dispose();
});

describe("pi conflict disable", () => {
    it("disables the plugin when env/config conflict detection trips", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "disabled response",
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100 },
        });

        const turn = await h.sendPrompt("this should not get magic context", { timeoutMs: 60_000 });
        expect(turn.exitCode).toBe(0);
        expect(turn.stderr).not.toContain("Failed to load extension");

        const body = JSON.stringify(h.mock.lastRequest()!.body);
        expect(body).not.toContain("ctx_search");
        expect(body).not.toContain("§1§");
        expect(h.countTags(turn.sessionId ?? "missing")).toBe(0);
    }, 60_000);
});
