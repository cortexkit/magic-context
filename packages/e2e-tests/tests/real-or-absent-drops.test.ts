/**
 * Dropped tool calls are "real or absent" on the wire of a real OpenCode host.
 *
 * Three drops land on one busting pass:
 *  1. a small call inside the newest-call window keeps its REAL arguments and
 *     only its result becomes `[dropped §N§]`;
 *  2. a large call is removed together with its result;
 *  3. a large call whose result ends the request is kept, with its real
 *     arguments, because removing it would end the request on an assistant turn.
 *
 * The mock provider behaves like Anthropic's validator: every tool_use must be
 * answered by a tool_result in the next message, every tool_result must answer
 * a tool_use in the previous message, and a request may not end on an
 * assistant turn (no prefill). A violating request gets a 400; the test
 * requires zero of them.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestHarness } from "../src/harness";
import type { MockResponse } from "../src/mock-provider/server";
import {
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";
import {
    anthropicViolation,
    blocks,
    findToolResult,
    findToolUse,
    resultText,
    type WireMessage,
} from "../src/anthropic-request-validator";
import { openTestDb } from "../src/test-db";

const LOW = {
    input_tokens: 1_000,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
};
// 98% of the usable limit: the pass after this response is a forced (>=95%) bust,
// which is where queued drops apply even inside the protected window. Magic
// Context reserves part of the 20k model window for output, so the usable limit
// it resolves is 15,000, and pressure is measured against that. The reading
// must stay at or under 15,000: a larger one makes the usage event first ask
// the host for fresh model limits, and on OpenCode 1.18.31 and later the next
// step's transform runs before that round trip ends, so it still sees the
// previous low reading and defers instead of busting.
const HIGH = {
    input_tokens: 14_700,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
};

forEachHost(import.meta.url, "real-or-absent tool drops", (host) => {
    let h: ScenarioHarness;
    const violations: string[] = [];

    beforeAll(async () => {
        h = await createScenarioHarness(host, {
            modelContextLimit: 20_000,
            magicContextConfig: {
                execute_threshold_percentage: 20,
                historian: { disable: true },
            },
        });
    });

    afterAll(async () => {
        await h.dispose();
    });

    it("keeps small and request-ending calls with real arguments, removes large ones, and never trips the Anthropic validator", async () => {
        const tools = (body: Record<string, unknown>) =>
            (Array.isArray(body.tools) ? body.tools : [])
                .map((tool) => (tool as { name?: unknown }).name)
                .filter((name): name is string => typeof name === "string");
        const toolNamed = (body: Record<string, unknown>, suffix: string) =>
            tools(body).find((name) => new RegExp(`(^|_)${suffix}$`).test(name));

        const smallInput = { command: "echo small", description: "small" };
        const midInput = {
            command: `echo ${"M".repeat(3000)} > /dev/null`,
            description: "mid",
        };
        const endInput = {
            command: `echo ${"E".repeat(3000)} > /dev/null`,
            description: "end",
        };

        h.mock.reset();
        // The validator runs first and answers a violating request with a 400.
        h.mock.addMatcher((body): MockResponse | null => {
            const violation = anthropicViolation(body);
            if (!violation) return null;
            violations.push(violation);
            return {
                error: {
                    status: 400,
                    type: "invalid_request_error",
                    message: violation,
                },
            };
        });

        // Turn 1: a small bash call, then a large one, then text.
        let turnOneStep = 0;
        h.mock.addMatcher((body): MockResponse | null => {
            if (turnOneStep >= 2) return null;
            const bash = toolNamed(body, "bash");
            if (!bash) return null;
            turnOneStep += 1;
            return turnOneStep === 1
                ? {
                        content: [
                            {
                                type: "tool_use",
                                id: "toolu_small_bash",
                                name: bash,
                                input: smallInput,
                            },
                        ],
                        stop_reason: "tool_use",
                        usage: LOW,
                    }
                : {
                        content: [
                            {
                                type: "tool_use",
                                id: "toolu_mid_bash",
                                name: bash,
                                input: midInput,
                            },
                        ],
                        stop_reason: "tool_use",
                        usage: LOW,
                    };
        });
        h.mock.setDefault({ text: "turn one done", usage: LOW });

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "run the short command, then the long one", {
            timeoutMs: 120_000,
        });
        await h.waitForMockQuiescence({ label: "turn one settles" });

        const tagOf = (callId: string) =>
            h
                .contextDb()
                .prepare(
                    "SELECT tag_number AS tag, status, drop_mode AS mode FROM tags WHERE session_id = ? AND harness = ? AND type = 'tool' AND message_id = ?",
                )
                .get(sessionId, h.harnessId, callId) as {
                tag: number;
                status: string;
                mode: string;
            } | null;
        const small = tagOf("toolu_small_bash");
        const mid = tagOf("toolu_mid_bash");
        expect(small).not.toBeNull();
        expect(mid).not.toBeNull();

        const queue = (tag: number) => {
            const writable = openTestDb(h.contextDbPath());
            try {
                writable
                    .prepare(
                        "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', ?, ?)",
                    )
                    .run(sessionId, tag, Date.now(), h.harnessId);
            } finally {
                writable.close();
            }
        };
        queue(small!.tag);
        queue(mid!.tag);

        // Turn 2: one large bash call whose result ends the next request. Its tag
        // does not exist yet; tags are sequential, so queue its number now and
        // verify below that it landed on this call. The high usage makes the next
        // pass a forced bust, which drains all three queued drops at once.
        let predictedEndTag = 0;
        let turnTwoStep = 0;
        h.mock.addMatcher((body): MockResponse | null => {
            if (turnOneStep < 2 || turnTwoStep >= 1) return null;
            const bash = toolNamed(body, "bash");
            if (!bash) return null;
            turnTwoStep += 1;
            const maxTag = h
                .contextDb()
                .prepare(
                    "SELECT MAX(tag_number) AS max FROM tags WHERE session_id = ? AND harness = ?",
                )
                .get(sessionId, h.harnessId) as { max: number };
            // The assistant text part is tagged before the call beside it.
            predictedEndTag = maxTag.max + 2;
            queue(predictedEndTag);
            return {
                // Text beside the call: removing the call would leave this assistant
                // text as the last message, which the validator refuses (no prefill).
                content: [
                    { type: "text", text: "Running the final command." },
                    {
                        type: "tool_use",
                        id: "toolu_end_bash",
                        name: bash,
                        input: endInput,
                    },
                ],
                stop_reason: "tool_use",
                usage: HIGH,
            };
        });
        h.mock.setDefault({ text: "turn two done", usage: LOW });
        await h.sendPrompt(sessionId, "run the final long command", {
            timeoutMs: 120_000,
        });
        await h.waitForMockQuiescence({ label: "turn two settles" });

        const end = tagOf("toolu_end_bash");
        expect(end?.tag).toBe(predictedEndTag);
        expect(tagOf("toolu_small_bash")).toMatchObject({
            status: "dropped",
            mode: "skeleton_real",
        });
        expect(tagOf("toolu_mid_bash")).toMatchObject({
            status: "dropped",
            mode: "full",
        });
        expect(tagOf("toolu_end_bash")).toMatchObject({
            status: "dropped",
            mode: "skeleton_real",
        });

        // The busting pass: the request that ends with the end call's result.
        const bustRequest = h.requests().find((request) => {
            const messages = (request.body.messages ?? []) as WireMessage[];
            const lastResult = blocks(messages.at(-1)).find(
                (block) => block.type === "tool_result",
            );
            return lastResult?.tool_use_id === "toolu_end_bash";
        });
        expect(bustRequest).toBeDefined();

        // Turn 3: a defer pass replays the frozen drops.
        await h.sendPrompt(sessionId, "anything else?", { timeoutMs: 120_000 });
        await h.waitForMockQuiescence({ label: "turn three settles" });
        const replayRequest = h.mock.lastRequest()!;

        for (const request of [bustRequest!, replayRequest]) {
            const messages = (request.body.messages ?? []) as WireMessage[];
            expect(findToolUse(messages, "toolu_small_bash")?.input).toEqual(
                smallInput,
            );
            expect(resultText(findToolResult(messages, "toolu_small_bash"))).toBe(
                `[dropped §${small!.tag}§]`,
            );
            expect(findToolUse(messages, "toolu_mid_bash")).toBeUndefined();
            expect(findToolResult(messages, "toolu_mid_bash")).toBeUndefined();
            expect(findToolUse(messages, "toolu_end_bash")?.input).toEqual(endInput);
            expect(resultText(findToolResult(messages, "toolu_end_bash"))).toBe(
                `[dropped §${end!.tag}§]`,
            );
            expect(JSON.stringify(messages)).not.toContain('"dropped":');
        }
        expect(violations).toEqual([]);

        // Evidence for review: the served JSON of each shape, and the host's open
        // database files (throwaway roots only).
        const evidenceDir = process.env.MC_REAL_OR_ABSENT_EVIDENCE;
        if (evidenceDir && h instanceof TestHarness) {
            mkdirSync(evidenceDir, { recursive: true });
            const messages = (replayRequest.body.messages ?? []) as WireMessage[];
            const around = (id: string) =>
                messages.filter((message) =>
                    blocks(message).some(
                        (block) => block.id === id || block.tool_use_id === id,
                    ),
                );
            writeFileSync(
                join(evidenceDir, "opencode1-served.json"),
                JSON.stringify(
                    {
                        small_skeleton: around("toolu_small_bash"),
                        request_ending_exception_at_bust: (
                            bustRequest!.body.messages as WireMessage[]
                        ).slice(-2),
                        request_ending_exception_on_replay: around("toolu_end_bash"),
                        full_removal_mid_call_present: around("toolu_mid_bash").length > 0,
                        request_count: h.requests().length,
                        violations,
                    },
                    null,
                    2,
                ),
            );
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
    }, 360_000);
});
