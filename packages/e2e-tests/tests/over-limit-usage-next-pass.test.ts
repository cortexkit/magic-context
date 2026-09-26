/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestHarness } from "../src/harness";
import type { MockResponse } from "../src/mock-provider/server";
import { forEachHost } from "../src/scenario-hosts";

/**
 * An over-limit usage reading must reach the very next transform pass.
 *
 * The mock model has a 20k window, which Magic Context turns into a usable
 * limit of 15,000 after reserving room for output. A step that reports 19,500
 * input tokens is past that limit, which is also when the plugin asks the host
 * for fresh model limits. OpenCode 1.18.31 and later run the next step's
 * transform without waiting for the plugin's message.updated handler, so the
 * reading must be recorded before that round trip, not after it. The pass that
 * serves the tool result of the over-limit step must plan with 19,500 tokens and
 * execute; with the reading recorded late it planned with the previous 6.7%
 * reading and deferred.
 */

const LOW = {
    input_tokens: 1_000,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
};
const HIGH = {
    input_tokens: 19_500,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
};

// OpenCode 1 only: its message.updated delivery order is the subject.
forEachHost(import.meta.url, null, () => {
    let h: TestHarness;

    beforeAll(async () => {
        h = await TestHarness.create({
            modelContextLimit: 20_000,
            magicContextConfig: {
                execute_threshold_percentage: 20,
                historian: { disable: true },
            },
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it("plans the pass after an over-limit step with that step's usage", async () => {
        const toolNamed = (body: Record<string, unknown>) =>
            (Array.isArray(body.tools) ? body.tools : [])
                .map((tool) => (tool as { name?: unknown }).name)
                .find((name): name is string => typeof name === "string" && /(^|_)bash$/.test(name));

        h.mock.reset();
        h.mock.setDefault({ text: "turn one done", usage: LOW });
        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "say hello", { timeoutMs: 90_000 });
        await h.waitForMockQuiescence({ label: "turn one settles" });

        // Turn 2: one tool step that reports the over-limit usage, then text.
        let toolEmitted = false;
        h.mock.addMatcher((body): MockResponse | null => {
            if (toolEmitted) return null;
            const bash = toolNamed(body);
            if (!bash) return null;
            toolEmitted = true;
            return {
                content: [
                    {
                        type: "tool_use",
                        id: "toolu_over_limit_step",
                        name: bash,
                        input: { command: "echo over", description: "print a line" },
                    },
                ],
                stop_reason: "tool_use",
                usage: HIGH,
            };
        });
        h.mock.setDefault({ text: "turn two done", usage: LOW });
        await h.sendPrompt(sessionId, "run one command", { timeoutMs: 90_000 });
        await h.waitForMockQuiescence({ label: "turn two settles" });
        expect(toolEmitted).toBe(true);

        const logPath = join(h.dataDir, "cortexkit", "magic-context-e2e.log");
        const sessionLines = await h.waitFor(
            () => {
                if (!existsSync(logPath)) return null;
                const lines = readFileSync(logPath, "utf8")
                    .split("\n")
                    .filter((line) => line.includes(`[${sessionId}]`));
                const highEvent = lines.findIndex(
                    (line) =>
                        line.includes("event message.updated: provider=") &&
                        line.includes(`tokens.input=${HIGH.input_tokens}`),
                );
                if (highEvent < 0) return null;
                const after = lines.slice(highEvent + 1);
                return after.some((line) => line.includes("transform scheduler:")) ? after : null;
            },
            { timeoutMs: 10_000, label: "scheduler line after the over-limit event" },
        );

        // No prompt follows turn two, so the only transform after the over-limit
        // step's event is the one serving its tool result.
        const schedulerLines = (sessionLines ?? []).filter((line) =>
            line.includes("transform scheduler:"),
        );
        expect(schedulerLines).toHaveLength(1);
        const scheduler = schedulerLines[0] ?? "";
        expect(scheduler).toContain(`inputTokens=${HIGH.input_tokens}`);
        expect(scheduler).toContain("decision=execute");
        const percentage = Number(/percentage=([\d.]+)%/.exec(scheduler)?.[1]);
        // 95% of the usable limit or more: the band where queued work is applied
        // even inside the protected window and the emergency path can fire.
        expect(percentage).toBeGreaterThanOrEqual(95);

        // The tool-result request really went out after that pass.
        const toolResultRequest = h.requests().find((request) => {
            const messages = (request.body.messages ?? []) as Array<{ content?: unknown }>;
            const last = messages.at(-1)?.content;
            return (
                Array.isArray(last) &&
                last.some(
                    (block) =>
                        (block as { tool_use_id?: unknown }).tool_use_id ===
                        "toolu_over_limit_step",
                )
            );
        });
        expect(toolResultRequest).toBeDefined();

        // With MC_OVER_LIMIT_NEXT_PASS_EVIDENCE set, write the scheduler line and
        // the database files the OpenCode process holds open (from lsof) to that
        // directory. They show the run used the harness's temporary data
        // directories and never a real user store.
        const evidenceDir = process.env.MC_OVER_LIMIT_NEXT_PASS_EVIDENCE;
        if (evidenceDir) {
            mkdirSync(evidenceDir, { recursive: true });
            writeFileSync(join(evidenceDir, "scheduler-line.txt"), `${scheduler}\n`);
            const lsof = execFileSync("lsof", ["-p", String(h.opencode.pid)], {
                encoding: "utf8",
            });
            writeFileSync(
                join(evidenceDir, "opencode1-lsof-db.txt"),
                lsof
                    .split("\n")
                    .filter((line) => /\.db(-wal|-shm)?$/.test(line))
                    .join("\n"),
            );
        }
    }, 240_000);
});
