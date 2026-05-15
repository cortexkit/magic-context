/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";

/**
 * Pi parity port of `thinking-block-safety.test.ts`.
 *
 * OpenCode protects Anthropic signed thinking blocks from three mutation
 * classes that previously caused provider 400s. Pi differs architecturally:
 * it receives typed `AgentMessage[]` in `pi.on("context")`, adapts them through
 * `transcript-pi.ts`, and returns a replacement array. The mock provider and
 * request inspection are shared with OpenCode, so the assertions below inspect
 * the exact Anthropic wire payload Pi sends.
 *
 * Bug A — Pi nudges are inserted by `nudge-injector.ts` as a separate synthetic
 * assistant message before the latest user, instead of mutating/re-anchoring an
 * existing assistant. A thinking-bearing assistant must stay byte-identical.
 *
 * Bug B — Pi uses the shared `apply-operations.ts` drop/truncate path plus
 * Pi-specific `strip-placeholders-pi.ts`. User turn boundaries between signed
 * assistant messages must survive as a `[truncated §N§]` user shell so provider
 * adapters cannot merge adjacent assistants or change thinking block layout.
 *
 * Bug C — Pi image prompts arrive as typed `image` parts. Dropping the companion
 * text tag must not delete the image part or remove the user message carrying it.
 */

let h: PiTestHarness;

beforeAll(async () => {
    h = await PiTestHarness.create({
        modelContextLimit: 50_000,
        magicContextConfig: {
            execute_threshold_percentage: 80,
            compaction_markers: false,
            dreamer: { enabled: false },
            sidekick: { enabled: false },
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

interface AnthropicContentBlock {
    type: string;
    text?: string;
    thinking?: string;
    signature?: string;
}

interface AnthropicMessage {
    role: string;
    content: AnthropicContentBlock[] | string;
}

interface RequestWithMessages {
    body: { messages?: AnthropicMessage[]; system?: unknown };
}

function openWritableDb(): Database {
    return new Database(h.contextDbPath(), { readwrite: true });
}

function asAnthropic(req: { body: { messages?: Array<{ role: string; content: unknown }> } }): RequestWithMessages {
    return req as unknown as RequestWithMessages;
}

function isMagicContextRequest(req: { body: { system?: unknown } }): boolean {
    const sys = req.body.system;
    if (sys === undefined || sys === null) return false;
    const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
    return asString.includes("## Magic Context");
}

function mainRequests(): Array<{ body: Record<string, unknown> }> {
    return h.mock.requests().filter(isMagicContextRequest);
}

function capturedAssistants(req: RequestWithMessages): AnthropicMessage[] {
    return (req.body.messages ?? []).filter((m) => m.role === "assistant");
}

function capturedUsers(req: RequestWithMessages): AnthropicMessage[] {
    return (req.body.messages ?? []).filter((m) => m.role === "user");
}

function contentBlocks(message: AnthropicMessage): AnthropicContentBlock[] {
    return Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
}

function findThinkingBlocks(req: RequestWithMessages): AnthropicContentBlock[] {
    return (req.body.messages ?? []).flatMap((message) =>
        contentBlocks(message).filter((block) => block.type === "thinking" || block.type === "redacted_thinking"),
    );
}

describe("pi thinking-block safety (Anthropic 400 regression)", () => {
    describe("Bug A: nudge insertion must not mutate thinking-bearing assistants", () => {
        it("keeps signed thinking assistant content byte-identical when Pi rolling nudge fires", async () => {
            h.mock.reset();
            const signedThinking = "Pi signed thinking must remain unchanged.";
            const signature = "pi-sig-bug-a";

            h.mock.setDefault({
                content: [
                    { type: "thinking", thinking: signedThinking, signature },
                    { type: "text", text: "Here is the Pi answer." },
                ],
                usage: {
                    input_tokens: 23_000,
                    output_tokens: 200,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            });

            await h.newSession();
            await h.sendPrompt("turn 1 — establish Pi thinking block", { timeoutMs: 90_000 });
            await h.sendPrompt("turn 2 — let Pi nudge logic observe pressure", { timeoutMs: 90_000, continueSession: true });
            await h.sendPrompt("turn 3 — Pi must not mutate signed history", { timeoutMs: 90_000, continueSession: true });

            const requests = mainRequests();
            expect(requests.length).toBeGreaterThanOrEqual(3);
            const lastReq = asAnthropic(requests.at(-1)! as { body: { messages?: Array<{ role: string; content: unknown }> } });

            let inspected = 0;
            for (const assistant of capturedAssistants(lastReq)) {
                const blocks = contentBlocks(assistant);
                if (!blocks.some((block) => block.type === "thinking" && block.signature === signature)) continue;
                inspected++;
                const thinking = blocks.find((block) => block.type === "thinking");
                expect(thinking?.thinking).toBe(signedThinking);
                expect(thinking?.signature).toBe(signature);
                for (const block of blocks) {
                    if (block.type !== "text") continue;
                    expect(block.text ?? "").not.toContain("<instruction name=\"context_");
                    expect(block.text ?? "").not.toContain("context_iteration");
                    expect(block.text ?? "").not.toContain("context_warning");
                    expect(block.text ?? "").not.toContain("context_critical");
                }
            }
            expect(inspected).toBeGreaterThan(0);
        }, 120_000);
    });

    describe("Bug B: dropped user text between assistants preserves turn boundary", () => {
        it("keeps the user shell as [truncated §N§] so signed assistants stay separated", async () => {
            h.mock.reset();
            const signedThinkingA = "Pi first signed thinking.";
            const signedThinkingB = "Pi second signed thinking.";
            const sigA = "pi-sig-bug-b-a";
            const sigB = "pi-sig-bug-b-b";

            h.mock.script([
                {
                    content: [
                        { type: "thinking", thinking: signedThinkingA, signature: sigA },
                        { type: "text", text: "Response to Pi turn 1." },
                    ],
                    usage: { input_tokens: 15_000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
                },
                {
                    content: [
                        { type: "thinking", thinking: signedThinkingB, signature: sigB },
                        { type: "text", text: "Response to Pi turn 2." },
                    ],
                    usage: { input_tokens: 18_000, output_tokens: 100, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 5_000 },
                },
            ]);
            h.mock.setDefault({
                content: [{ type: "text", text: "follow-up" }],
                usage: { input_tokens: 19_000, output_tokens: 50, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 9_000 },
            });

            await h.newSession();
            const first = await h.sendPrompt("please explain how Pi drop logic works", { timeoutMs: 90_000 });
            expect(first.sessionId).toBeTruthy();
            const sessionId = first.sessionId!;
            const paste = `Here is a Pi log of the failing session:\n${"ERROR: pi call_failed at line 42.\n".repeat(60)}`;
            await h.sendPrompt(paste, { timeoutMs: 90_000, continueSession: true });
            await h.waitFor(() => h.countTags(sessionId) >= 2, { label: "Pi tags ready" });

            const db = openWritableDb();
            try {
                const rows = db
                    .prepare(
                        `SELECT tag_number, byte_size
                         FROM tags
                         WHERE session_id = ? AND type = 'message' AND harness = 'pi'
                         ORDER BY byte_size DESC`,
                    )
                    .all(sessionId) as Array<{ tag_number: number; byte_size: number }>;
                expect(rows[0]?.byte_size ?? 0).toBeGreaterThan(500);
                db.prepare("UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = ?").run(
                    sessionId,
                    rows[0]!.tag_number,
                );
            } finally {
                db.close();
            }

            await h.sendPrompt("what do you think?", { timeoutMs: 90_000, continueSession: true });
            const lastReq = asAnthropic(mainRequests().at(-1)! as { body: { messages?: Array<{ role: string; content: unknown }> } });
            const users = capturedUsers(lastReq);
            const allUserText = users
                .flatMap(contentBlocks)
                .filter((block) => block.type === "text")
                .map((block) => block.text ?? "")
                .join("\n");
            expect(allUserText).toMatch(/\[truncated §\d+§\]/);
            expect(allUserText).toContain("Here is a Pi log of the failing session");

            const signatures = new Set(findThinkingBlocks(lastReq).map((block) => block.signature));
            expect(signatures.has(sigA) || signatures.has(sigB)).toBe(true);
            for (const block of findThinkingBlocks(lastReq)) {
                if (block.signature === sigA) expect(block.thinking).toBe(signedThinkingA);
                if (block.signature === sigB) expect(block.thinking).toBe(signedThinkingB);
            }

            const transitions = (lastReq.body.messages ?? []).slice(1).filter((message, index, arr) => {
                const prev = (lastReq.body.messages ?? [])[index];
                return prev?.role === "user" && message.role === "assistant";
            });
            expect(transitions.length).toBeGreaterThanOrEqual(2);
        }, 120_000);
    });

    describe("Bug C: image part survives when companion text is dropped", () => {
        it("keeps a Pi user image part after the user text tag is dropped", async () => {
            h.mock.reset();
            h.mock.setDefault({
                content: [{ type: "text", text: "I see the Pi screenshot." }],
                usage: { input_tokens: 22_000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            });

            await h.newSession();
            const first = await h.sendPrompt("see this Pi screenshot for the bug", {
                timeoutMs: 90_000,
                images: [
                    {
                        type: "image",
                        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
                        mimeType: "image/png",
                    },
                ],
            });
            expect(first.sessionId).toBeTruthy();
            const sessionId = first.sessionId!;
            await h.waitFor(() => h.countTags(sessionId) > 0, { label: "Pi image prompt tag ready" });

            const db = openWritableDb();
            try {
                const rows = db
                    .prepare(
                        `SELECT tag_number
                         FROM tags
                         WHERE session_id = ? AND type = 'message' AND harness = 'pi'
                         ORDER BY tag_number DESC`,
                    )
                    .all(sessionId) as Array<{ tag_number: number }>;
                expect(rows.length).toBeGreaterThan(0);
                db.prepare("UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = ?").run(
                    sessionId,
                    rows[0]!.tag_number,
                );
            } finally {
                db.close();
            }

            await h.sendPrompt("what do you see in the image?", { timeoutMs: 90_000, continueSession: true });
            const lastReq = asAnthropic(mainRequests().at(-1)! as { body: { messages?: Array<{ role: string; content: unknown }> } });
            const userBlocks = capturedUsers(lastReq).flatMap(contentBlocks);
            const imageBlocks = userBlocks.filter((block) => block.type === "image");
            expect(imageBlocks.length).toBeGreaterThan(0);
        }, 120_000);
    });
});
