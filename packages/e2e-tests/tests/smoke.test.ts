/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import { isTitleRequest } from "../src/provider-system-text";
import {
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";

/**
 * Phase 1 smoke — verifies the harness is wired correctly:
 *   mock server reachable where the host exposes one, the real host process runs,
 *   the plugin loads from source, a prompt reaches the mock, and SQLite initializes.
 */

let h: ScenarioHarness;

const options = {
    mockDefault: {
        text: "response from mock",
        usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 0,
        },
    },
};

forEachHost(import.meta.url, "opencode e2e smoke", (host) => {
    beforeAll(async () => {
        h = await createScenarioHarness(host, options);
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it("sends a prompt, mock captures it, plugin initializes its DB", async () => {
        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "hi there");

        // Internal small-model requests do not carry Magic Context. Select the
        // main request by excluding each host's title/summary/compaction prompts.
        const mainRequest = () => h.requests().find(({ body }) => {
            const wire = JSON.stringify(body);
            return wire.includes("hi there") && !isTitleRequest(body) &&
                !wire.includes("Generate a title for this conversation:") &&
                !wire.includes("Generate a summary of the conversation") &&
                !wire.includes("Compress the conversation history");
        });
        await h.waitFor(() => mainRequest() !== undefined, {
            timeoutMs: 10_000, label: "main-agent request captured",
        });

        const requests = h.requests();
        expect(requests.length).toBeGreaterThanOrEqual(1);

        const mainAgentBody = JSON.stringify(mainRequest()?.body);
        expect(mainAgentBody, "main-agent request not captured").toBeDefined();
        expect(mainAgentBody).toMatch(/Magic Context|<session-history>/);

        await h.waitFor(() => h.hasContextDb(), { timeoutMs: 5000, label: "context.db created" });
        await h.waitFor(() => h.countTags(sessionId) > 0, {
            timeoutMs: 5000,
            label: "tags persisted",
        });
        expect(h.countTags(sessionId)).toBeGreaterThan(0);
    }, 60_000);
});
