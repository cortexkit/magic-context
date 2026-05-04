/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { TestHarness } from "../src/harness";

/**
 * E2E regression suite for the Anthropic 400 error family:
 *
 *   "messages.N.content.M: thinking or redacted_thinking blocks in the
 *    latest assistant message cannot be modified. These blocks must remain
 *    as they were in the original response."
 *
 * Three distinct bugs have been observed in production sessions
 * (ses_331acff95fferWZOYF1pG0cjOn is the canonical reproducer). Each bug
 * causes the plugin to mutate content that ultimately becomes part of an
 * assistant block carrying signed thinking. Anthropic re-validates those
 * signatures against the replayed content on every request and rejects the
 * call if anything differs.
 *
 * These tests drive a real `opencode serve` process against a mock Anthropic
 * server that returns thinking blocks with signatures, simulate the plugin-
 * level state that triggered each bug in production, and assert against the
 * exact bytes sent to the mock on the next request.
 *
 *   Bug A — Nudge anchor on a thinking-bearing assistant.
 *           Plugin's reinjectNudgeAtAnchor would append <instruction> text to
 *           the signed assistant's content on every defer pass.
 *           Fix: `hasThinkingBearingParts` guard in nudge-injection.ts.
 *
 *   Bug B — User message shell removal between assistants.
 *           stripDroppedPlaceholderMessages collapsed user turns whose text
 *           became `[dropped §N§]`, causing AI SDK's Anthropic adapter to
 *           merge adjacent assistants and mutate the "latest assistant"
 *           block structure.
 *           Fix: role check in stripDroppedPlaceholderMessages + truncation
 *           path in apply-operations.
 *
 *   Bug C — File/image part stripping when companion text is dropped.
 *           `file` was listed as METADATA in strip-content.ts, so an image-
 *           bearing user message could be stripped entirely when its text
 *           became `[dropped §N§]`, silently deleting the screenshot.
 *           Fix: remove `file` from METADATA_PART_TYPES.
 *
 * All three fixes are verified here end-to-end.
 */

// Shared harness for lightweight tests. Each test resets mock state before
// running so they're independent. One subprocess per file is dramatically
// faster than per-test and still gives full isolation between files.
let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        magicContextConfig: {
            // Keep the nudge band active but not aggressive — tests will
            // inject specific usage percentages via mock responses.
            execute_threshold_percentage: 80,
            compaction_markers: false,
        },
        modelContextLimit: 50_000,
    });
});

afterAll(async () => {
    await h.dispose();
});

/** Open context.db in read-write mode for tests that need to simulate
 * plugin-level state (pending_ops, nudge anchor, etc.). The shared
 * harness exposes only a read-only handle. */
function openContextDbWritable(): Database {
    // Plugin v0.16+ — shared cortexkit/magic-context path.
    const dbPath = join(h.opencode.env.dataDir, "cortexkit", "magic-context", "context.db");
    return new Database(dbPath, { readwrite: true });
}

interface AnthropicContentBlock {
    type: string;
    text?: string;
    thinking?: string;
    signature?: string;
    data?: string;
    source?: { type: string; media_type?: string; data?: string };
}
interface AnthropicMessage {
    role: string;
    content: AnthropicContentBlock[] | string;
}

interface RequestWithMessages {
    body: { messages?: AnthropicMessage[] };
}

/** Cast the loosely-typed `CapturedRequest` to our Anthropic shape. The mock
 * preserves the raw JSON body as-is, so this is safe — it's the same bytes
 * that @ai-sdk/anthropic produced and that the real API would validate. */
function asAnthropic(req: {
    body: { messages?: Array<{ role: string; content: unknown }> };
}): RequestWithMessages {
    return req as unknown as RequestWithMessages;
}

/** Extract assistant messages from captured mock requests. Returns them in
 * the exact order Anthropic received them (which reflects AI SDK's merging).
 */
function capturedAssistants(req: RequestWithMessages): AnthropicMessage[] {
    return (req.body.messages ?? []).filter((m) => m.role === "assistant");
}

function capturedUsers(req: RequestWithMessages): AnthropicMessage[] {
    return (req.body.messages ?? []).filter((m) => m.role === "user");
}

/** Find all thinking/redacted_thinking blocks across all messages in a captured request. */
function findThinkingBlocks(req: RequestWithMessages): AnthropicContentBlock[] {
    const out: AnthropicContentBlock[] = [];
    for (const msg of req.body.messages ?? []) {
        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
            if (block.type === "thinking" || block.type === "redacted_thinking") {
                out.push(block);
            }
        }
    }
    return out;
}

describe("thinking-block safety (Anthropic 400 regression)", () => {
    describe("Bug A: nudge anchor on a thinking-bearing assistant", () => {
        it(
            "does not inject nudge <instruction> text into an assistant that has a thinking block",
            async () => {
                h.mock.reset();

                const signedThinking = "Let me work through this carefully step by step.";
                const signature = "opaque-provider-signature-bug-a";

                // Respond with thinking + text so the assistant message carries
                // a signed thinking block that Anthropic will re-validate.
                h.mock.setDefault({
                    content: [
                        { type: "thinking", thinking: signedThinking, signature },
                        { type: "text", text: "Here is the answer." },
                    ],
                    usage: {
                        // ~46% of 50K — inside the nudge band so the plugin's
                        // reinjectNudgeAtAnchor path is live.
                        input_tokens: 23_000,
                        output_tokens: 200,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                });

                const sessionId = await h.createSession();
                await h.sendPrompt(sessionId, "turn 1 — establish the thinking block");

                // Establish a nudge placement pointing at the latest assistant
                // by running a second turn at the same usage.
                await h.sendPrompt(sessionId, "turn 2 — give nudge logic a chance to anchor");

                // Third turn — the defer pass now sees the anchored placement
                // (if any) and MUST NOT mutate the signed assistant's text.
                await h.sendPrompt(sessionId, "turn 3 — defer pass must not mutate signed msg");

                const mainReqs = h.mock.requests().filter((r) => {
                    const sys = r.body.system;
                    const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
                    return asString.includes("## Magic Context");
                });
                expect(mainReqs.length).toBeGreaterThanOrEqual(3);

                // On the third request, the assistant history contains both
                // prior turns. Find any assistant message whose content
                // contains a thinking block with our signature.
                const lastReq = mainReqs[mainReqs.length - 1]!;
                const assistants = capturedAssistants(asAnthropic(lastReq));
                expect(assistants.length).toBeGreaterThan(0);

                let inspected = 0;
                for (const asst of assistants) {
                    if (!Array.isArray(asst.content)) continue;
                    const hasMatchingSig = asst.content.some(
                        (b) => b.type === "thinking" && b.signature === signature,
                    );
                    if (!hasMatchingSig) continue;
                    inspected++;

                    // Every text block in this assistant must NOT contain the
                    // plugin's nudge instruction markers. Text mutation invalidates
                    // the thinking signature.
                    for (const block of asst.content) {
                        if (block.type !== "text") continue;
                        expect(block.text ?? "").not.toContain("<instruction name=\"context_");
                        expect(block.text ?? "").not.toContain("context_iteration");
                        expect(block.text ?? "").not.toContain("context_warning");
                        expect(block.text ?? "").not.toContain("context_critical");
                    }

                    // Thinking block content must be exactly what the mock
                    // returned — byte-for-byte. This is the strongest invariant.
                    const thinking = asst.content.find((b) => b.type === "thinking");
                    expect(thinking?.thinking).toBe(signedThinking);
                    expect(thinking?.signature).toBe(signature);
                }

                // We must have found at least one signed assistant in the
                // replayed history — otherwise the test didn't actually
                // exercise the regression path.
                expect(inspected).toBeGreaterThan(0);
            },
            90_000,
        );
    });

    describe("Bug B: user-message turn boundary preserved when text tag is dropped", () => {
        it(
            "keeps the user shell as [truncated §N§] so adjacent assistants are not merged",
            async () => {
                h.mock.reset();

                const signedThinkingA = "First thinking block for turn one.";
                const signedThinkingB = "Second thinking block for turn two.";
                const sigA = "sig-bug-b-turn-one";
                const sigB = "sig-bug-b-turn-two";

                h.mock.script([
                    {
                        content: [
                            { type: "thinking", thinking: signedThinkingA, signature: sigA },
                            { type: "text", text: "Response to turn 1." },
                        ],
                        usage: {
                            input_tokens: 15_000,
                            output_tokens: 100,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                        },
                    },
                    {
                        content: [
                            { type: "thinking", thinking: signedThinkingB, signature: sigB },
                            { type: "text", text: "Response to turn 2." },
                        ],
                        usage: {
                            input_tokens: 18_000,
                            output_tokens: 100,
                            cache_creation_input_tokens: 10_000,
                            cache_read_input_tokens: 5_000,
                        },
                    },
                ]);
                h.mock.setDefault({
                    content: [{ type: "text", text: "follow-up" }],
                    usage: {
                        input_tokens: 19_000,
                        output_tokens: 50,
                        cache_creation_input_tokens: 10_000,
                        cache_read_input_tokens: 9_000,
                    },
                });

                const sessionId = await h.createSession();

                // Turn 1 — short user, assistant has thinking.
                await h.sendPrompt(sessionId, "please explain how the drop logic works");

                // Turn 2 — a MASSIVE user paste that we'll drop afterwards.
                const paste = `Here is a log of the failing session:\n${"ERROR: call_failed at line 42.\n".repeat(
                    60,
                )}`;
                await h.sendPrompt(sessionId, paste);

                // Locate the user paste message and its tag. It is uniquely
                // identified by byte_size: the paste is far larger than any
                // other text in this session.
                await Bun.sleep(200);
                const writeDb = openContextDbWritable();
                try {
                    const messageTags = writeDb
                        .prepare(
                            `SELECT tag_number, message_id, byte_size
                             FROM tags
                             WHERE session_id = ? AND type = 'message'
                             ORDER BY byte_size DESC`,
                        )
                        .all(sessionId) as Array<{
                        tag_number: number;
                        message_id: string;
                        byte_size: number;
                    }>;

                    // Largest message-type tag is the user paste.
                    const pasteTag = messageTags[0];
                    expect(pasteTag).toBeDefined();
                    expect(pasteTag!.byte_size).toBeGreaterThan(500);

                    // Mark the tag as dropped directly. This matches what
                    // `/ctx-flush` does internally (updateTagStatus +
                    // removePendingOp) and guarantees the next transform will
                    // materialize the drop without needing an execute-pass
                    // threshold crossing — so we don't have to force high
                    // mock usage that would trigger historian/compartment work.
                    writeDb
                        .prepare(
                            `UPDATE tags SET status = 'dropped'
                             WHERE session_id = ? AND tag_number = ?`,
                        )
                        .run(sessionId, pasteTag!.tag_number);
                } finally {
                    writeDb.close();
                }

                // Turn 3 — triggers transform, applies pending drop, and
                // issues the request we will inspect.
                await h.sendPrompt(sessionId, "what do you think?");

                // Filter to main-agent requests (not historian/sidekick).
                const mainReqs = h.mock.requests().filter((r) => {
                    const sys = r.body.system;
                    const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
                    return asString.includes("## Magic Context");
                });
                expect(mainReqs.length).toBeGreaterThanOrEqual(3);
                const lastReq = mainReqs[mainReqs.length - 1]!;

                // The paste's text must survive as a `[truncated §N§]` shell
                // inside a USER message — NOT a `[dropped §N§]` that strips
                // the turn boundary.
                const users = capturedUsers(asAnthropic(lastReq));
                const allUserText = users
                    .flatMap((u) => (Array.isArray(u.content) ? u.content : []))
                    .filter((b) => b.type === "text")
                    .map((b) => b.text ?? "")
                    .join("\n");

                // Must have the truncation marker (proves shell preservation).
                expect(allUserText).toMatch(/\[truncated \u00a7\d+\u00a7\]/);
                // Must preserve the START of the original paste (intent).
                expect(allUserText).toContain("Here is a log of the failing session");
                // Must NOT have degenerated to a full drop.
                const hasFullDrop = /\[dropped \u00a7\d+\u00a7\]/.test(allUserText);
                if (hasFullDrop) {
                    // Full drops of OTHER tags are fine — we're asserting the
                    // paste's text did NOT get fully dropped.
                    expect(allUserText).toContain("Here is a log of the failing session");
                }

                // Thinking blocks from prior turns must be present and
                // unchanged in the request.
                const thinkings = findThinkingBlocks(asAnthropic(lastReq));
                const signatures = new Set(thinkings.map((t) => t.signature));
                // At least one of our signed thinkings must replay.
                const hasSigA = signatures.has(sigA);
                const hasSigB = signatures.has(sigB);
                expect(hasSigA || hasSigB).toBe(true);

                // For every replayed signed thinking, its text is byte-identical.
                for (const t of thinkings) {
                    if (t.signature === sigA) expect(t.thinking).toBe(signedThinkingA);
                    if (t.signature === sigB) expect(t.thinking).toBe(signedThinkingB);
                }

                // Structural check: the outer message array must contain the
                // user paste shell as a distinct user message — not merged
                // into an assistant block. Count transitions.
                const messages = lastReq.body.messages ?? [];
                const transitions: Array<{ from: string; to: string }> = [];
                for (let i = 1; i < messages.length; i++) {
                    const prev = messages[i - 1]!;
                    const cur = messages[i]!;
                    if (prev.role !== cur.role) {
                        transitions.push({ from: prev.role, to: cur.role });
                    }
                }
                // We must see at least 2 user→assistant transitions in the
                // history, proving the user paste DID act as a boundary.
                const userToAsst = transitions.filter(
                    (t) => t.from === "user" && t.to === "assistant",
                );
                expect(userToAsst.length).toBeGreaterThanOrEqual(2);
            },
            120_000,
        );
    });

    describe("Bug C: file/image part survives when companion text is dropped", () => {
        it(
            "keeps a user message with an image part even after its text tag is dropped",
            async () => {
                h.mock.reset();
                h.mock.setDefault({
                    content: [{ type: "text", text: "I see the screenshot." }],
                    usage: {
                        input_tokens: 22_000,
                        output_tokens: 50,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                });

                const sessionId = await h.createSession();

                // Drive an OpenCode prompt carrying both text + a file part.
                // We bypass the SdkClient helper (text-only) and call the raw
                // client to include a file part.
                const sdk = await import("@opencode-ai/sdk");
                const rawClient = sdk.createOpencodeClient({ baseUrl: h.opencode.url }) as unknown as {
                    session: {
                        prompt: (opts: {
                            path: { id: string };
                            body: {
                                model: { providerID: string; modelID: string };
                                parts: Array<{
                                    type: "text" | "file";
                                    text?: string;
                                    mime?: string;
                                    url?: string;
                                    filename?: string;
                                }>;
                            };
                        }) => Promise<unknown>;
                    };
                };

                // 1x1 transparent PNG data URL.
                const imageDataUrl =
                    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

                await rawClient.session.prompt({
                    path: { id: sessionId },
                    body: {
                        model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
                        parts: [
                            { type: "text", text: "see this screenshot for the bug" },
                            {
                                type: "file",
                                mime: "image/png",
                                url: imageDataUrl,
                                filename: "bug.png",
                            },
                        ],
                    },
                });

                // Drop the user message's TEXT tag. Image part is separate.
                await Bun.sleep(200);
                const writeDb = openContextDbWritable();
                try {
                    const textTags = writeDb
                        .prepare(
                            `SELECT tag_number, message_id
                             FROM tags
                             WHERE session_id = ? AND type = 'message'
                             ORDER BY tag_number DESC`,
                        )
                        .all(sessionId) as Array<{ tag_number: number; message_id: string }>;
                    expect(textTags.length).toBeGreaterThan(0);

                    // The latest message-type tag belongs to the user's text
                    // part (the prompt we just sent). Mark it dropped directly
                    // — equivalent to `/ctx-flush` materialization.
                    const userTextTag = textTags[0]!;
                    writeDb
                        .prepare(
                            `UPDATE tags SET status = 'dropped'
                             WHERE session_id = ? AND tag_number = ?`,
                        )
                        .run(sessionId, userTextTag.tag_number);
                } finally {
                    writeDb.close();
                }

                // Second prompt triggers transform + drop application.
                await h.sendPrompt(sessionId, "what do you see in the image?");

                const mainReqs = h.mock.requests().filter((r) => {
                    const sys = r.body.system;
                    const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
                    return asString.includes("## Magic Context");
                });
                expect(mainReqs.length).toBeGreaterThanOrEqual(2);
                const lastReq = mainReqs[mainReqs.length - 1]!;

                // The image part MUST still be present in the request body —
                // specifically inside a user message's content array. The
                // anthropic adapter serializes data URLs as `source.type:"url"`
                // with no media_type, so we accept either base64 or url shapes.
                const users = capturedUsers(asAnthropic(lastReq));
                const allUserBlocks = users.flatMap((u) =>
                    Array.isArray(u.content) ? u.content : [],
                );
                const imageBlocks = allUserBlocks.filter((b) => b.type === "image");
                expect(imageBlocks.length).toBeGreaterThan(0);

                // The user message carrying the image must also NOT have been
                // removed from the message list (structural presence).
                const userWithImage = users.find(
                    (u) =>
                        Array.isArray(u.content) &&
                        u.content.some((b) => b.type === "image"),
                );
                expect(userWithImage).toBeDefined();
            },
            90_000,
        );
    });
});
