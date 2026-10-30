/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import { OpenCode2TestHarness } from "../src/opencode2-harness";
import { expectNativeAdmission, summaryHeads } from "./opencode2/helpers/native-admission";
import {
    createScenarioHarness,
    forEachHost,
    isPiFamily,
    type ScenarioHarness,
} from "../src/scenario-hosts";

/**
 * When OpenCode 1 has auto-compaction enabled, or a conflicting plugin is
 * installed, magic-context MUST self-disable. OpenCode 2 instead exposes a
 * compaction hook that Magic Context answers without a competing model call. This prevents double-compaction
 * behavior and guarantees that the plugin is a no-op in environments where
 * another system owns history management.
 *
 * We force conflict by setting `compaction: { auto: true }` in opencode.json.
 * Then we send a normal turn and verify the plugin never created its DB —
 * the cleanest proof that no plugin machinery ran for this session.
 */

forEachHost(import.meta.url, "conflict detection", (host) => {
    let h: ScenarioHarness;

    beforeAll(async () => {
        h = await createScenarioHarness(
            host,
            isPiFamily(host)
                ? { magicContextConfig: { enabled: false } }
                : {
                    expectMagicContext: false,
                    // Magic Context disables on v1, but answers the native compaction hook on v2.
                    openCodeConfigExtra: {
                        compaction: { auto: true, prune: false },
                    },
                },
        );
    });

    afterAll(async () => {
        await h.dispose();
    });
    it(
        host === "opencode2" ? "answers native compaction without a competing model request" : "plugin disables itself when opencode auto-compaction is active",
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

            if (h instanceof OpenCode2TestHarness) {
                expect(h.countTags(sessionId)).toBeGreaterThan(0);
                const requests = h.mock.requests().length;
                const before = structuredClone(h.mock.lastRequest()!.body);
                await h.compactSession(sessionId);
                expect(h.mock.requests().length).toBe(requests);
                expectNativeAdmission(h, sessionId);
                await h.sendPrompt(sessionId, "after native compaction");
                const after = h.mock.lastRequest()!.body;
                // The new turn extends the conversation; the frozen summary
                // heads and system prompt must not change just because it folded.
                expect(summaryHeads(after)).toEqual(summaryHeads(before));
                expect(after.system).toEqual(before.system);
                const sent = JSON.stringify(after);
                expect(sent).toContain("hello — should not be tagged.");
                expect(sent).toContain("after native compaction");
                expect(sent).not.toContain("<conversation-checkpoint>");
                expect(sent).not.toContain("<recent-context>");
                return;
            }

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
