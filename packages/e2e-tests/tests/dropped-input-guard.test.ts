/**
 * The dropped-input guard must run through the plugin ENTRY the host loads,
 * not just the runtime hook object: in v0.42.0 the guard existed on the runtime
 * object but the entry wrapper never delegated `tool.execute.before`, so a
 * model copying a `[dropped N]` placeholder into a bash call executed it
 * unblocked on every OpenCode surface. This drives a real tool call carrying
 * the placeholder through a live OpenCode and asserts the tool never ran.
 */
import { openTestDb } from "../src/test-db";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TestHarness } from "../src/harness";
import {
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";

const USAGE = { input_tokens: 2_000, output_tokens: 20, cache_creation_input_tokens: 0 };

forEachHost(import.meta.url, "dropped-input guard through the plugin entry", (host) => {
    let h: ScenarioHarness;
    beforeEach(async () => {
        h = await createScenarioHarness(host, { modelContextLimit: 200_000 });
    });
    afterEach(async () => {
        await h.dispose();
    });

    it(host === "opencode2" ? "refuses a native shell call whose command is a copied drop placeholder" : "refuses a bash call whose command is a copied drop placeholder", async () => {
        const sessionId = await h.createSession();
        // A second, harmless argument proves the refusal quotes the call it
        // received, not a canned string: it must be echoed back in the refusal.
        const marker = "hello-from-a-blocked-call";
        let emitted = false;
        h.mock.addMatcher((body) => {
            if (emitted) return null;
            const tools = Array.isArray(body.tools) ? body.tools : [];
            const bash = tools
                .map((t) => (t && typeof t === "object" ? (t as { name?: unknown }).name : null))
                .find((n) => typeof n === "string" && (h.host === "opencode2" ? n === "shell" : /(^|_)bash$/.test(n))) as string | undefined;
            if (!bash) return null;
            emitted = true;
            return {
                content: [
                    {
                        type: "tool_use",
                        id: "toolu_dropped_copy_01",
                        name: bash,
                        input: { command: "[dropped §7§]", description: marker },
                    },
                ],
                stop_reason: "tool_use" as const,
                usage: USAGE,
            };
        });
        h.mock.setDefault({ text: "done", usage: USAGE });

        await h.sendPrompt(sessionId, "run the thing", { timeoutMs: 90_000 });
        await h.waitForMockQuiescence({ label: "guarded tool turn settles" });
        expect(emitted).toBe(true);

        if (h instanceof TestHarness) {
            // OpenCode 1 persists the refusal in its legacy part table.
            const opencodeDbPath = ["opencode.db", "opencode-local.db"]
                .map((f) => join(h.dataDir, "opencode", f))
                .find((p) => existsSync(p));
            expect(opencodeDbPath).toBeDefined();
            const db = openTestDb(opencodeDbPath!, { readonly: true });
            try {
                const rows = db
                    .query(
                        "SELECT data FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.callID') = 'toolu_dropped_copy_01'",
                    )
                    .all(sessionId) as { data: string }[];
                expect(rows.length).toBe(1);
                const state = JSON.parse(rows[0]!.data).state as { status: string; error?: string; output?: string };
                expect(state.status).toBe("error");
                const refusal = String(state.error ?? state.output ?? "");
                expect(refusal).toContain("placeholder Magic Context shows");
                expect(refusal).toContain('"command":"[dropped §7§]"');
                expect(refusal).toContain(marker);
            } finally {
                db.close();
            }
        }
        // The next request to the model carries the refusal, including its
        // instruction to retry the tool call with real parameter values.
        const followUp = h.requests().find((r) => JSON.stringify(r.body).includes("again with real values"));
        expect(followUp).toBeDefined();
    }, 120_000);
});
