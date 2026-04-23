/// <reference types="bun-types" />

import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
    clearOldReasoning,
    replayClearedReasoning,
    stripClearedReasoning,
    stripDroppedPlaceholderMessages,
    stripInlineThinking,
    stripProcessedImages,
    stripReasoningFromMergedAssistants,
    truncateErroredTools,
} from "./strip-content";
import type { MessageLike, ThinkingLikePart } from "./tag-messages";

function message(id: string, role: string, parts: unknown[]): MessageLike {
    return {
        info: { id, role, sessionID: "ses-1" },
        parts,
    };
}

const SENTINEL = { type: "text", text: "" };

describe("strip-content", () => {
    let buildDataUrl: ReturnType<typeof mock<(payloadSize: number) => string>>;

    beforeEach(() => {
        buildDataUrl = mock(
            (payloadSize: number) => `data:image/png;base64,${"a".repeat(payloadSize)}`,
        );
    });

    describe("clearOldReasoning", () => {
        describe("#given messages with tag numbers and a clearReasoningAge threshold", () => {
            describe("#when reasoning is older than the age threshold", () => {
                it("#then clears reasoning parts in old messages and returns mutation count", () => {
                    const first = message("m-1", "assistant", [{ type: "text", text: "intro" }]);
                    const second = message("m-2", "assistant", [{ type: "text", text: "details" }]);
                    const third = message("m-3", "assistant", [{ type: "text", text: "recent" }]);
                    const messages: MessageLike[] = [first, second, third];

                    const firstReasoning: ThinkingLikePart[] = [
                        { type: "thinking", thinking: "old reasoning", text: "old trace" },
                    ];
                    const secondReasoning: ThinkingLikePart[] = [
                        { type: "reasoning", thinking: "also old", text: "also old text" },
                    ];
                    const thirdReasoning: ThinkingLikePart[] = [
                        { type: "thinking", thinking: "keep me", text: "keep trace" },
                    ];

                    const reasoningByMessage = new Map<MessageLike, ThinkingLikePart[]>([
                        [first, firstReasoning],
                        [second, secondReasoning],
                        [third, thirdReasoning],
                    ]);

                    // maxTag=10, clearReasoningAge=5 => ageCutoff=5 => tags 1,3 are <=5 (cleared), tag 8 is >5 (kept)
                    const messageTagNumbers = new Map<MessageLike, number>([
                        [first, 1],
                        [second, 3],
                        [third, 8],
                    ]);

                    const cleared = clearOldReasoning(
                        messages,
                        reasoningByMessage,
                        messageTagNumbers,
                        5,
                    );

                    expect(cleared).toBe(4);
                    expect(firstReasoning[0]?.thinking).toBe("[cleared]");
                    expect(firstReasoning[0]?.text).toBe("[cleared]");
                    expect(secondReasoning[0]?.thinking).toBe("[cleared]");
                    expect(secondReasoning[0]?.text).toBe("[cleared]");
                    expect(thirdReasoning[0]?.thinking).toBe("keep me");
                    expect(thirdReasoning[0]?.text).toBe("keep trace");
                });
            });
        });

        describe("#given no messages have tag numbers", () => {
            describe("#when clearing reasoning", () => {
                it("#then returns zero and leaves reasoning untouched", () => {
                    const only = message("m-1", "assistant", [{ type: "text", text: "no tags" }]);
                    const reasoningPart: ThinkingLikePart = {
                        type: "thinking",
                        thinking: "keep me",
                    };
                    const reasoningByMessage = new Map<MessageLike, ThinkingLikePart[]>([
                        [only, [reasoningPart]],
                    ]);
                    const messageTagNumbers = new Map<MessageLike, number>();

                    const cleared = clearOldReasoning(
                        [only],
                        reasoningByMessage,
                        messageTagNumbers,
                        10,
                    );

                    expect(cleared).toBe(0);
                    expect(reasoningPart.thinking).toBe("keep me");
                });
            });
        });

        describe("#given already-cleared reasoning parts", () => {
            describe("#when clearing reasoning (idempotent)", () => {
                it("#then skips already-cleared parts and returns zero", () => {
                    const first = message("m-1", "assistant", []);
                    const alreadyCleared: ThinkingLikePart = {
                        type: "thinking",
                        thinking: "[cleared]",
                        text: "[cleared]",
                    };
                    const reasoningByMessage = new Map<MessageLike, ThinkingLikePart[]>([
                        [first, [alreadyCleared]],
                    ]);
                    const messageTagNumbers = new Map<MessageLike, number>([[first, 1]]);

                    const cleared = clearOldReasoning(
                        [first],
                        reasoningByMessage,
                        messageTagNumbers,
                        5,
                    );

                    expect(cleared).toBe(0);
                    expect(alreadyCleared.thinking).toBe("[cleared]");
                    expect(alreadyCleared.text).toBe("[cleared]");
                });
            });
        });

        describe("#given a provider that requires typed reasoning preservation", () => {
            describe("#when the skip gate is enabled", () => {
                it("#then returns zero and leaves reasoning untouched", () => {
                    const msg = message("m-1", "assistant", []);
                    const reasoningPart: ThinkingLikePart = {
                        type: "reasoning",
                        text: "preserve me — Kimi needs this",
                    };
                    const reasoningByMessage = new Map<MessageLike, ThinkingLikePart[]>([
                        [msg, [reasoningPart]],
                    ]);
                    const messageTagNumbers = new Map<MessageLike, number>([[msg, 1]]);

                    const cleared = clearOldReasoning(
                        [msg],
                        reasoningByMessage,
                        messageTagNumbers,
                        5,
                        true,
                    );

                    expect(cleared).toBe(0);
                    expect(reasoningPart.text).toBe("preserve me — Kimi needs this");
                });
            });
        });
    });

    describe("replayClearedReasoning", () => {
        describe("#given a persisted watermark on a reasoning-preserving model", () => {
            describe("#when the skip gate is enabled", () => {
                it("#then replays nothing and leaves typed reasoning untouched", () => {
                    const msg = message("m-1", "assistant", []);
                    const reasoningPart: ThinkingLikePart = {
                        type: "reasoning",
                        text: "untouched",
                    };
                    const reasoningByMessage = new Map<MessageLike, ThinkingLikePart[]>([
                        [msg, [reasoningPart]],
                    ]);
                    const messageTagNumbers = new Map<MessageLike, number>([[msg, 1]]);

                    const cleared = replayClearedReasoning(
                        [msg],
                        reasoningByMessage,
                        messageTagNumbers,
                        5,
                        true,
                    );

                    expect(cleared).toBe(0);
                    expect(reasoningPart.text).toBe("untouched");
                });
            });
        });
    });

    describe("stripClearedReasoning (sentinel-based)", () => {
        describe("#given assistant messages with cleared and live reasoning parts", () => {
            describe("#when stripping cleared reasoning", () => {
                it("#then replaces cleared parts with sentinels and preserves array length", () => {
                    const clearedPart = {
                        type: "thinking",
                        thinking: "[cleared]",
                        text: "[cleared]",
                    };
                    const livePart = {
                        type: "thinking",
                        thinking: "real thought",
                        text: "real trace",
                    };
                    const textPart = { type: "text", text: "visible response" };
                    const msg = message("m-1", "assistant", [clearedPart, livePart, textPart]);

                    const stripped = stripClearedReasoning([msg]);

                    expect(stripped).toBe(1);
                    expect(msg.parts).toHaveLength(3);
                    expect(msg.parts[0]).toEqual(SENTINEL);
                    expect(msg.parts[1]).toBe(livePart);
                    expect(msg.parts[2]).toBe(textPart);
                });
            });
        });

        describe("#given message with text-only cleared (thinking is live)", () => {
            describe("#when stripping cleared reasoning", () => {
                it("#then keeps the part because thinking field is not cleared", () => {
                    const partialPart = {
                        type: "reasoning",
                        thinking: "live reasoning",
                        text: "[cleared]",
                    };
                    const msg = message("m-1", "assistant", [partialPart]);

                    const stripped = stripClearedReasoning([msg]);

                    expect(stripped).toBe(0);
                    expect(msg.parts).toHaveLength(1);
                    expect(msg.parts[0]).toBe(partialPart);
                });
            });
        });

        describe("#given user messages with thinking parts", () => {
            describe("#when stripping cleared reasoning", () => {
                it("#then skips non-assistant messages entirely", () => {
                    const clearedPart = {
                        type: "thinking",
                        thinking: "[cleared]",
                        text: "[cleared]",
                    };
                    const userMsg = message("m-1", "user", [clearedPart]);

                    const stripped = stripClearedReasoning([userMsg]);

                    expect(stripped).toBe(0);
                    expect(userMsg.parts).toHaveLength(1);
                    expect(userMsg.parts[0]).toBe(clearedPart);
                });
            });
        });

        describe("#given assistant messages with redacted thinking parts", () => {
            describe("#when stripping cleared reasoning", () => {
                it("#then preserves redacted thinking blocks unchanged", () => {
                    const redactedPart = {
                        type: "redacted_thinking",
                        data: "opaque-provider-payload",
                    };
                    const textPart = { type: "text", text: "visible response" };
                    const msg = message("m-1", "assistant", [redactedPart, textPart]);

                    const stripped = stripClearedReasoning([msg]);

                    expect(stripped).toBe(0);
                    expect(msg.parts).toHaveLength(2);
                    expect(msg.parts[0]).toBe(redactedPart);
                    expect(msg.parts[1]).toBe(textPart);
                });
            });
        });

        describe("#given a thinking part with no thinking or text fields", () => {
            describe("#when stripping cleared reasoning", () => {
                it("#then preserves it defensively — undefined fields are not a cleared shell", () => {
                    // Edge-case shape: a future provider (or upstream bug) could
                    // emit a thinking-type part carrying only non-standard fields
                    // like `data` or `signature`, with neither `thinking` nor
                    // `text` set. Must preserve — we cannot prove it is cleared.
                    const undefinedFieldsPart = {
                        type: "thinking",
                        signature: "opaque-provider-signature",
                    };
                    const textPart = { type: "text", text: "latest response" };
                    const msg = message("m-latest", "assistant", [undefinedFieldsPart, textPart]);

                    const stripped = stripClearedReasoning([msg]);

                    expect(stripped).toBe(0);
                    expect(msg.parts).toHaveLength(2);
                    expect(msg.parts[0]).toBe(undefinedFieldsPart);
                    expect(msg.parts[1]).toBe(textPart);
                });
            });
        });

        describe("#given cleared reasoning on a model that requires reasoning_content", () => {
            describe("#when the skip gate is enabled", () => {
                it("#then it keeps the typed reasoning parts untouched (not sentineled)", () => {
                    const clearedPart = {
                        type: "reasoning",
                        text: "[cleared]",
                    };
                    const msg = message("m-1", "assistant", [clearedPart]);

                    const stripped = stripClearedReasoning([msg], true);

                    expect(stripped).toBe(0);
                    expect(msg.parts).toHaveLength(1);
                    expect(msg.parts[0]).toBe(clearedPart);
                });
            });
        });

        describe("#given already-sentineled reasoning parts (idempotent)", () => {
            describe("#when stripping cleared reasoning again", () => {
                it("#then skips sentinels (no re-mutation, zero count)", () => {
                    const msg = message("m-1", "assistant", [
                        { type: "text", text: "" },
                        { type: "text", text: "response" },
                    ]);

                    const stripped = stripClearedReasoning([msg]);

                    expect(stripped).toBe(0);
                    expect(msg.parts).toHaveLength(2);
                });
            });
        });
    });

    describe("stripInlineThinking", () => {
        describe("#given assistant messages older than the age threshold with inline thinking", () => {
            describe("#when stripping inline thinking", () => {
                it("#then removes <thinking> and <think> blocks from old message text parts", () => {
                    const oldMsg = message("m-1", "assistant", [
                        {
                            type: "text",
                            text: "<thinking>\nsome private reasoning\n</thinking>\nActual response",
                        },
                    ]);
                    const recentMsg = message("m-2", "assistant", [
                        {
                            type: "text",
                            text: "<thinking>\nkeep me\n</thinking>\nRecent actual response",
                        },
                    ]);
                    const tags = new Map<MessageLike, number>([
                        [oldMsg, 1],
                        [recentMsg, 10],
                    ]);

                    const stripped = stripInlineThinking([oldMsg, recentMsg], tags, 5);

                    expect(stripped).toBe(1);
                    expect((oldMsg.parts[0] as { text: string }).text).toBe("Actual response");
                    expect((recentMsg.parts[0] as { text: string }).text).toContain("<thinking>");
                });
            });
        });

        describe("#given no messages have tag numbers", () => {
            describe("#when stripping inline thinking", () => {
                it("#then returns zero", () => {
                    const msg = message("m-1", "assistant", [{ type: "text", text: "hi" }]);
                    const tags = new Map<MessageLike, number>();

                    expect(stripInlineThinking([msg], tags, 5)).toBe(0);
                });
            });
        });
    });

    describe("truncateErroredTools", () => {
        describe("#given tool error parts above and below a watermark", () => {
            describe("#when truncating errored tools", () => {
                it("#then it truncates only long errors at or below the watermark", () => {
                    const below = message("m-1", "assistant", [
                        {
                            type: "tool",
                            state: {
                                status: "error",
                                error: "e".repeat(200),
                            },
                        },
                    ]);
                    const above = message("m-2", "assistant", [
                        {
                            type: "tool",
                            state: {
                                status: "error",
                                error: "f".repeat(200),
                            },
                        },
                    ]);
                    const shortError = message("m-3", "assistant", [
                        {
                            type: "tool",
                            state: {
                                status: "error",
                                error: "short",
                            },
                        },
                    ]);
                    const success = message("m-4", "assistant", [
                        {
                            type: "tool",
                            state: {
                                status: "completed",
                                output: "done",
                            },
                        },
                    ]);
                    const tags = new Map<MessageLike, number>([
                        [below, 1],
                        [above, 10],
                        [shortError, 2],
                        [success, 3],
                    ]);

                    const truncated = truncateErroredTools(
                        [below, above, shortError, success],
                        5,
                        tags,
                    );

                    expect(truncated).toBe(1);
                    const belowPart = below.parts[0] as {
                        state: { error: string };
                    };
                    const abovePart = above.parts[0] as {
                        state: { error: string };
                    };
                    expect(belowPart.state.error.endsWith("[truncated]")).toBe(true);
                    expect(abovePart.state.error.length).toBe(200);
                });
            });
        });

        describe("#given empty messages", () => {
            describe("#when truncating errored tools", () => {
                it("#then it returns zero", () => {
                    const tags = new Map<MessageLike, number>();
                    expect(truncateErroredTools([], 5, tags)).toBe(0);
                });
            });
        });
    });

    describe("stripProcessedImages (sentinel-based)", () => {
        describe("#given user image uploads around assistant responses and watermark boundaries", () => {
            describe("#when stripping processed images", () => {
                it("#then replaces eligible images with sentinels at or below the watermark", () => {
                    const user1 = message("m-1", "user", [
                        {
                            type: "file",
                            mime: "image/png",
                            url: buildDataUrl(2000),
                        },
                    ]);
                    const assistant1 = message("m-2", "assistant", [
                        { type: "text", text: "processed" },
                    ]);
                    const user2 = message("m-3", "user", [
                        {
                            type: "file",
                            mime: "image/png",
                            url: buildDataUrl(2000),
                        },
                    ]);
                    const assistant2 = message("m-4", "assistant", [
                        { type: "text", text: "responded" },
                    ]);
                    const user3NoImage = message("m-5", "user", [
                        { type: "text", text: "no image here" },
                    ]);
                    const tags = new Map<MessageLike, number>([
                        [user1, 1],
                        [assistant1, 2],
                        [user2, 3],
                        [assistant2, 4],
                        [user3NoImage, 5],
                    ]);

                    const stripped = stripProcessedImages(
                        [user1, assistant1, user2, assistant2, user3NoImage],
                        3,
                        tags,
                    );

                    expect(stripped).toBe(2);
                    // Array lengths preserved
                    expect(user1.parts).toHaveLength(1);
                    expect(user2.parts).toHaveLength(1);
                    expect(user1.parts[0]).toEqual(SENTINEL);
                    expect(user2.parts[0]).toEqual(SENTINEL);
                });

                it("#then leaves images above the watermark untouched", () => {
                    const user1 = message("m-1", "user", [
                        {
                            type: "file",
                            mime: "image/png",
                            url: buildDataUrl(2000),
                        },
                    ]);
                    const assistant1 = message("m-2", "assistant", [
                        { type: "text", text: "processed" },
                    ]);
                    const recentUser = message("m-3", "user", [
                        {
                            type: "file",
                            mime: "image/png",
                            url: buildDataUrl(2000),
                        },
                    ]);
                    const recentAssistant = message("m-4", "assistant", [
                        { type: "text", text: "recent" },
                    ]);
                    const tags = new Map<MessageLike, number>([
                        [user1, 1],
                        [assistant1, 2],
                        [recentUser, 10],
                        [recentAssistant, 11],
                    ]);

                    const stripped = stripProcessedImages(
                        [user1, assistant1, recentUser, recentAssistant],
                        5,
                        tags,
                    );

                    expect(stripped).toBe(1);
                    expect(user1.parts[0]).toEqual(SENTINEL);
                    // Recent user's image survives
                    expect((recentUser.parts[0] as { type: string }).type).toBe("file");
                });
            });
        });

        describe("#given empty messages", () => {
            describe("#when stripping processed images", () => {
                it("#then it returns zero", () => {
                    const tags = new Map<MessageLike, number>();
                    expect(stripProcessedImages([], 5, tags)).toBe(0);
                });
            });
        });
    });

    describe("stripDroppedPlaceholderMessages (sentinel-based)", () => {
        describe("#given a user message whose only text is a dropped placeholder", () => {
            it("#then it keeps the user message shell UNCHANGED (turn boundary preserved)", () => {
                const user = message("m-u", "user", [{ type: "text", text: "[dropped §5§]" }]);
                const assistantBefore = message("m-before", "assistant", [
                    { type: "text", text: "hello" },
                ]);
                const assistantAfter = message("m-after", "assistant", [
                    { type: "text", text: "world" },
                ]);

                const result = stripDroppedPlaceholderMessages([
                    assistantBefore,
                    user,
                    assistantAfter,
                ]);

                expect(result.stripped).toBe(0);
                expect(result.sentineledIds).toEqual([]);
                // User message preserved exactly
                expect(user.parts).toEqual([{ type: "text", text: "[dropped §5§]" }]);
            });
        });

        describe("#given an assistant message whose only text is a dropped placeholder", () => {
            it("#then it neutralizes the assistant message with a sentinel", () => {
                const assistant = message("m-a", "assistant", [
                    { type: "text", text: "[dropped §8§]" },
                ]);

                const result = stripDroppedPlaceholderMessages([assistant]);

                expect(result.stripped).toBe(1);
                expect(result.sentineledIds).toEqual(["m-a"]);
                expect(assistant.parts).toEqual([SENTINEL]);
            });
        });

        describe("#given a user message with dropped text AND a file/image part", () => {
            it("#then it keeps the message (file content must survive, role protection)", () => {
                const user = message("m-u", "user", [
                    { type: "text", text: "[dropped §3§]" },
                    { type: "file", mime: "image/png", url: "data:image/png;base64,xxx" },
                ]);

                const result = stripDroppedPlaceholderMessages([user]);

                expect(result.stripped).toBe(0);
                expect(user.parts).toHaveLength(2);
            });
        });

        describe("#given an assistant message with dropped text AND a file part", () => {
            it("#then it keeps the message (file is not treated as metadata)", () => {
                const assistant = message("m-a", "assistant", [
                    { type: "text", text: "[dropped §3§]" },
                    { type: "file", mime: "image/png", url: "data:image/png;base64,xxx" },
                ]);

                const result = stripDroppedPlaceholderMessages([assistant]);

                expect(result.stripped).toBe(0);
                expect(assistant.parts).toHaveLength(2);
            });
        });

        describe("#given a user message with only dropped placeholder and step metadata", () => {
            it("#then it still keeps the user message (role protection)", () => {
                const user = message("m-u", "user", [
                    { type: "text", text: "[dropped §3§]" },
                    { type: "step-start" },
                ]);

                const result = stripDroppedPlaceholderMessages([user]);

                expect(result.stripped).toBe(0);
                expect(user.parts).toHaveLength(2);
            });
        });

        describe("#given an assistant message with [truncated §N§] text", () => {
            it("#then it does NOT neutralize (truncated marker is distinct from dropped)", () => {
                const assistant = message("m-a", "assistant", [
                    { type: "text", text: "[truncated §3§] ..." },
                ]);

                const result = stripDroppedPlaceholderMessages([assistant]);

                expect(result.stripped).toBe(0);
                expect(assistant.parts).toHaveLength(1);
            });
        });

        describe("#given an assistant that is already sentinel (idempotent replay)", () => {
            it("#then skips it entirely (zero count, unchanged)", () => {
                const assistant = message("m-a", "assistant", [{ type: "text", text: "" }]);

                const result = stripDroppedPlaceholderMessages([assistant]);

                expect(result.stripped).toBe(0);
                expect(result.sentineledIds).toEqual([]);
                expect(assistant.parts).toEqual([{ type: "text", text: "" }]);
            });
        });
    });

    describe("stripReasoningFromMergedAssistants (sentinel-based groupIntoBlocks workaround)", () => {
        describe("#given a single assistant with reasoning", () => {
            it("#then leaves it untouched (no merge risk — standalone assistant)", () => {
                const u = message("m-u", "user", [{ type: "text", text: "hi" }]);
                const a1 = message("m-a", "assistant", [
                    { type: "reasoning", text: "thinking about it" },
                    { type: "text", text: "response" },
                ]);

                const stripped = stripReasoningFromMergedAssistants([u, a1]);

                expect(stripped).toBe(0);
                expect(a1.parts).toEqual([
                    { type: "reasoning", text: "thinking about it" },
                    { type: "text", text: "response" },
                ]);
            });
        });

        describe("#given two consecutive assistants each with reasoning", () => {
            it("#then keeps reasoning on the first and sentinels from the second (length preserved)", () => {
                const u = message("m-u", "user", [{ type: "text", text: "hi" }]);
                const a1 = message("m-a1", "assistant", [
                    { type: "reasoning", text: "first reasoning" },
                    { type: "text", text: "first response" },
                ]);
                const a2 = message("m-a2", "assistant", [
                    { type: "reasoning", text: "second reasoning" },
                    { type: "text", text: "second response" },
                ]);

                const stripped = stripReasoningFromMergedAssistants([u, a1, a2]);

                expect(stripped).toBe(1);
                expect(a1.parts).toEqual([
                    { type: "reasoning", text: "first reasoning" },
                    { type: "text", text: "first response" },
                ]);
                expect(a2.parts).toHaveLength(2);
                expect(a2.parts[0]).toEqual(SENTINEL);
                expect(a2.parts[1]).toEqual({ type: "text", text: "second response" });
            });
        });

        describe("#given a long consecutive assistant run with tool calls and reasoning", () => {
            it("#then keeps only the first reasoning; intermediate reasoning becomes sentinels", () => {
                const u = message("m-u", "user", [{ type: "text", text: "do it" }]);
                const a1 = message("m-a1", "assistant", [
                    { type: "reasoning", text: "plan" },
                    { type: "tool", state: { status: "completed" } },
                ]);
                const a2 = message("m-a2", "assistant", [
                    { type: "reasoning", text: "next" },
                    { type: "tool", state: { status: "completed" } },
                ]);
                const a3 = message("m-a3", "assistant", [
                    { type: "reasoning", text: "done" },
                    { type: "text", text: "finished" },
                ]);

                const stripped = stripReasoningFromMergedAssistants([u, a1, a2, a3]);

                expect(stripped).toBe(2);
                expect(a1.parts[0]).toEqual({ type: "reasoning", text: "plan" });
                expect(a2.parts[0]).toEqual(SENTINEL);
                expect(a3.parts[0]).toEqual(SENTINEL);
            });
        });

        describe("#given two separate assistant runs broken by a user or tool message", () => {
            it("#then each run's first assistant keeps its reasoning", () => {
                const u1 = message("m-u1", "user", [{ type: "text", text: "first" }]);
                const a1 = message("m-a1", "assistant", [
                    { type: "reasoning", text: "r1" },
                    { type: "text", text: "reply 1" },
                ]);
                const u2 = message("m-u2", "user", [{ type: "text", text: "second" }]);
                const a2 = message("m-a2", "assistant", [
                    { type: "reasoning", text: "r2" },
                    { type: "text", text: "reply 2" },
                ]);

                const stripped = stripReasoningFromMergedAssistants([u1, a1, u2, a2]);

                expect(stripped).toBe(0);
                expect(a1.parts[0]).toEqual({ type: "reasoning", text: "r1" });
                expect(a2.parts[0]).toEqual({ type: "reasoning", text: "r2" });
            });
        });

        describe("#given a tool-role message between two assistants", () => {
            it("#then the second assistant keeps its reasoning (not a consecutive run)", () => {
                const u = message("m-u", "user", [{ type: "text", text: "go" }]);
                const a1 = message("m-a1", "assistant", [
                    { type: "reasoning", text: "r1" },
                    { type: "tool", state: { status: "completed" } },
                ]);
                const t = message("m-t", "tool", [{ type: "tool-result", output: "ok" }]);
                const a2 = message("m-a2", "assistant", [
                    { type: "reasoning", text: "r2" },
                    { type: "text", text: "done" },
                ]);

                const stripped = stripReasoningFromMergedAssistants([u, a1, t, a2]);

                expect(stripped).toBe(0);
                expect(a1.parts[0]).toEqual({ type: "reasoning", text: "r1" });
                expect(a2.parts[0]).toEqual({ type: "reasoning", text: "r2" });
            });
        });

        describe("#given an assistant with no reasoning at all", () => {
            it("#then strips nothing (no-op)", () => {
                const u = message("m-u", "user", [{ type: "text", text: "hi" }]);
                const a1 = message("m-a", "assistant", [
                    { type: "text", text: "just text, no reasoning" },
                ]);

                const stripped = stripReasoningFromMergedAssistants([u, a1]);

                expect(stripped).toBe(0);
                expect(a1.parts).toHaveLength(1);
            });
        });

        describe("#given a single assistant with reasoning NOT at content position 0", () => {
            it("#then sentinels the reasoning (would land at non-zero in merged block)", () => {
                const u = message("m-u", "user", [{ type: "text", text: "hi" }]);
                const a1 = message("m-a", "assistant", [
                    { type: "text", text: "preamble" },
                    { type: "reasoning", text: "r" },
                    { type: "text", text: "final" },
                ]);

                const stripped = stripReasoningFromMergedAssistants([u, a1]);

                expect(stripped).toBe(1);
                expect(a1.parts[0]).toEqual({ type: "text", text: "preamble" });
                expect(a1.parts[1]).toEqual(SENTINEL);
                expect(a1.parts[2]).toEqual({ type: "text", text: "final" });
            });
        });

        describe("#given a single assistant with step-start before reasoning", () => {
            it("#then keeps the reasoning (step-start is metadata AI SDK ignores)", () => {
                const u = message("m-u", "user", [{ type: "text", text: "hi" }]);
                const a1 = message("m-a", "assistant", [
                    { type: "step-start" },
                    { type: "reasoning", text: "reasoning here" },
                    { type: "text", text: "output" },
                ]);

                const stripped = stripReasoningFromMergedAssistants([u, a1]);

                expect(stripped).toBe(0);
                expect(a1.parts[1]).toEqual({ type: "reasoning", text: "reasoning here" });
            });
        });

        describe("#given a single assistant with many interleaved reasoning parts", () => {
            it("#then keeps only the first reasoning and sentinels the rest", () => {
                const u = message("m-u", "user", [{ type: "text", text: "go" }]);
                const a1 = message("m-a", "assistant", [
                    { type: "reasoning", text: "r1" },
                    { type: "text", text: "t1" },
                    { type: "reasoning", text: "r2" },
                    { type: "text", text: "t2" },
                    { type: "reasoning", text: "r3" },
                ]);

                const stripped = stripReasoningFromMergedAssistants([u, a1]);

                expect(stripped).toBe(2);
                expect(a1.parts).toHaveLength(5);
                expect(a1.parts[0]).toEqual({ type: "reasoning", text: "r1" });
                expect(a1.parts[1]).toEqual({ type: "text", text: "t1" });
                expect(a1.parts[2]).toEqual(SENTINEL);
                expect(a1.parts[3]).toEqual({ type: "text", text: "t2" });
                expect(a1.parts[4]).toEqual(SENTINEL);
            });
        });

        describe("#given first assistant has text before reasoning, second has reasoning at pos 0", () => {
            it("#then sentinels reasoning from BOTH (can't repair the run)", () => {
                const u = message("m-u", "user", [{ type: "text", text: "hi" }]);
                const a1 = message("m-a1", "assistant", [
                    { type: "text", text: "preamble" },
                    { type: "reasoning", text: "r1" },
                ]);
                const a2 = message("m-a2", "assistant", [
                    { type: "reasoning", text: "r2" },
                    { type: "text", text: "t2" },
                ]);

                const stripped = stripReasoningFromMergedAssistants([u, a1, a2]);

                expect(stripped).toBe(2);
                expect(a1.parts[0]).toEqual({ type: "text", text: "preamble" });
                expect(a1.parts[1]).toEqual(SENTINEL);
                expect(a2.parts[0]).toEqual(SENTINEL);
                expect(a2.parts[1]).toEqual({ type: "text", text: "t2" });
            });
        });

        describe("#given two consecutive assistants each with 'thinking' (wire-format) parts", () => {
            it("#then keeps thinking on the first and sentinels from the second", () => {
                const u = message("m-u", "user", [{ type: "text", text: "go" }]);
                const a1 = message("m-a1", "assistant", [
                    { type: "thinking", thinking: "thought 1" },
                    { type: "text", text: "reply 1" },
                ]);
                const a2 = message("m-a2", "assistant", [
                    { type: "thinking", thinking: "thought 2" },
                    { type: "text", text: "reply 2" },
                ]);

                const stripped = stripReasoningFromMergedAssistants([u, a1, a2]);

                expect(stripped).toBe(1);
                expect(a1.parts[0]).toEqual({ type: "thinking", thinking: "thought 1" });
                expect(a2.parts[0]).toEqual(SENTINEL);
            });
        });

        describe("#given mixed reasoning/thinking/redacted_thinking types across a run", () => {
            it("#then treats all three as reasoning-like (keep first, sentinel rest)", () => {
                const u = message("m-u", "user", [{ type: "text", text: "go" }]);
                const a1 = message("m-a1", "assistant", [
                    { type: "reasoning", text: "r" },
                    { type: "text", text: "t1" },
                ]);
                const a2 = message("m-a2", "assistant", [
                    { type: "thinking", thinking: "th" },
                    { type: "redacted_thinking", data: "opaque" },
                ]);

                const stripped = stripReasoningFromMergedAssistants([u, a1, a2]);

                expect(stripped).toBe(2);
                expect(a1.parts[0]).toEqual({ type: "reasoning", text: "r" });
                expect(a2.parts[0]).toEqual(SENTINEL);
                expect(a2.parts[1]).toEqual(SENTINEL);
            });
        });

        describe("#given first assistant has text before a thinking-typed block", () => {
            it("#then sentinels the thinking block from first AND second assistant", () => {
                const u = message("m-u", "user", [{ type: "text", text: "hi" }]);
                const a1 = message("m-a1", "assistant", [
                    { type: "text", text: "intro" },
                    { type: "thinking", thinking: "mid-thought" },
                ]);
                const a2 = message("m-a2", "assistant", [
                    { type: "reasoning", text: "r" },
                    { type: "text", text: "final" },
                ]);

                const stripped = stripReasoningFromMergedAssistants([u, a1, a2]);

                expect(stripped).toBe(2);
                expect(a1.parts.map((p) => (p as { type: string }).type)).toEqual(["text", "text"]);
                expect(a1.parts[0]).toEqual({ type: "text", text: "intro" });
                expect(a1.parts[1]).toEqual(SENTINEL);
                expect(a2.parts[0]).toEqual(SENTINEL);
                expect(a2.parts[1]).toEqual({ type: "text", text: "final" });
            });
        });
    });
});
