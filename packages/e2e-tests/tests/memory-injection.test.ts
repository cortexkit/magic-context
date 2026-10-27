/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import { inspectHostOpenFiles } from "../src/host-open-files";
import { PiTestHarness } from "../src/pi-harness";
import {
    createFreshSession,
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";

/**
 * Memory injection — regression test for v0.9.1.
 *
 * Before v0.9.1, if a session had no compartments yet, prepareCompartmentInjection
 * returned null and <session-history> was never built. Memories were therefore not
 * injected until historian published its first compartment.
 *
 * This test writes a project-scoped memory through ctx_memory before any
 * compartment exists, then opens a fresh session and asserts that its first
 * request contains <session-history> with <project-memory> carrying the saved
 * directive — proving injection works even with zero compartments.
 */

let h: ScenarioHarness;

function emitMemoryWriteOnce(content: string): void {
    let emitted = false;
    h.mock.addMatcher((body) => {
        if (emitted || !JSON.stringify(body.system ?? "").includes("## Magic Context")) return null;
        const tools = body.tools;
        if (!Array.isArray(tools)) return null;
        const memoryTool = tools.find(
            (tool) =>
                tool !== null &&
                typeof tool === "object" &&
                ["ctx_memory", "_ctx_memory"].includes(String((tool as { name?: unknown }).name)),
        ) as { name: string } | undefined;
        if (!memoryTool) return null;
        emitted = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: `toolu_memory_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
                    name: memoryTool.name,
                    input: { action: "write", category: "PROJECT_RULES", content, ids: [] },
                },
            ],
            stop_reason: "tool_use",
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 0,
            },
        };
    });
}

forEachHost(import.meta.url, "memory injection", (host) => {
    beforeAll(async () => {
        h = await createScenarioHarness(host);
    });

    afterAll(async () => {
        try {
            if (h instanceof PiTestHarness) {
                const pid = h.hostPid;
                if (pid === undefined) throw new Error("Host PID unavailable for isolation audit");
                const proof = inspectHostOpenFiles(pid, h.env.baseDir, h.contextDbPath());
                console.log("[host isolation]", JSON.stringify({ host, pid, databases: proof.databases }));
            }
        } finally {
            await h.dispose();
        }
    });

    it("injects <project-memory> on first turn even with no compartments", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "ack",
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 0,
            },
        });

        // Write through the public tool so each mode commits to its own authority
        // store. A fresh session then proves first-turn project-memory injection.
        const directive = "test seeded directive: always prefer bun over npm for running scripts";
        const writerSessionId = await h.createSession();
        emitMemoryWriteOnce(directive);
        await h.sendPrompt(writerSessionId, "remember the project package-manager rule");
        expect(JSON.stringify(h.mock.lastRequest()?.body)).toContain("Saved memory [ID:");

        const memorySessionId = await createFreshSession(h);

        // Clear captured requests so the assertion targets only the fresh session.
        h.mock.reset();
        h.mock.setDefault({
            text: "ack 2",
            usage: {
                input_tokens: 150,
                output_tokens: 10,
                cache_creation_input_tokens: 150,
                cache_read_input_tokens: 0,
            },
        });

        await h.sendPrompt(memorySessionId, "first turn after seeded memory");

        const req = h.mock.lastRequest();
        expect(req).not.toBeNull();

        // The <session-history> block is prepended to the first user message in
        // the visible array. Flatten everything and assert on the whole payload
        // — this way the test survives cosmetic ordering changes.
        const fullBody = JSON.stringify(req!.body);
        expect(fullBody).toContain("<session-history>");
        expect(fullBody).toContain("<project-memory>");
        expect(fullBody).toContain(directive);
        expect(fullBody).not.toContain("<summary");
    }, 60_000);
});
