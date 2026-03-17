/// <reference types="bun-types" />

import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
    clearOldReasoning,
    stripClearedReasoning,
    stripInlineThinking,
    stripProcessedImages,
    truncateErroredTools,
} from "./strip-content";
import type { MessageLike, ThinkingLikePart } from "./tag-messages";

function message(id: string, role: string, parts: unknown[]): MessageLike {
    return {
        info: { id, role, sessionID: "ses-1" },
        parts,
    };
}

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
                    const msg = message("m-1", "assistant", [{ type: "text", text: "response" }]);
                    const reasoningPart: ThinkingLikePart = {
                        type: "thinking",
                        thinking: "[cleared]",
                        text: "[cleared]",
                    };
                    const reasoningByMessage = new Map<MessageLike, ThinkingLikePart[]>([
                        [msg, [reasoningPart]],
                    ]);
                    const messageTagNumbers = new Map<MessageLike, number>([[msg, 1]]);

                    // maxTag=10, age=5 => ageCutoff=5, tag 1 is <=5 so it should try to clear
                    const cleared = clearOldReasoning(
                        [msg],
                        reasoningByMessage,
                        messageTagNumbers,
                        5,
                    );

                    expect(cleared).toBe(0);
                    expect(reasoningPart.thinking).toBe("[cleared]");
                });
            });
        });
    });

    describe("stripClearedReasoning", () => {
        describe("#given assistant messages with cleared and live reasoning parts", () => {
            describe("#when stripping cleared reasoning", () => {
                it("#then removes only parts where thinking or text is [cleared]", () => {
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
                    expect(msg.parts).toHaveLength(2);
                    expect(msg.parts[0]).toBe(livePart);
                    expect(msg.parts[1]).toBe(textPart);
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
                        { type: "text", text: "<think>recent thought</think>\nRecent response" },
                    ]);

                    // maxTag=10, age=5 => ageCutoff=5; tag 2 is old, tag 8 is recent
                    const messageTagNumbers = new Map<MessageLike, number>([
                        [oldMsg, 2],
                        [recentMsg, 8],
                    ]);

                    const stripped = stripInlineThinking([oldMsg, recentMsg], messageTagNumbers, 5);

                    expect(stripped).toBe(1);
                    expect((oldMsg.parts[0] as { text: string }).text).toBe("Actual response");
                    expect((recentMsg.parts[0] as { text: string }).text).toBe(
                        "<think>recent thought</think>\nRecent response",
                    );
                });
            });
        });

        describe("#given no messages have tag numbers", () => {
            describe("#when stripping inline thinking", () => {
                it("#then returns zero", () => {
                    const msg = message("m-1", "assistant", [
                        { type: "text", text: "<thinking>ignored</thinking>" },
                    ]);

                    const stripped = stripInlineThinking([msg], new Map(), 10);

                    expect(stripped).toBe(0);
                });
            });
        });
    });

    describe("truncateErroredTools", () => {
        describe("#given tool error parts above and below a watermark", () => {
            describe("#when truncating errored tools", () => {
                it("#then it truncates only long errors at or below the watermark", () => {
                    const longError = "x".repeat(120);
                    const exactBoundaryError = "y".repeat(100);

                    const belowWatermarkPart = {
                        type: "tool",
                        callID: "call-1",
                        state: { status: "error", error: longError },
                    };
                    const atWatermarkPart = {
                        type: "tool",
                        callID: "call-2",
                        state: { status: "error", error: longError },
                    };
                    const aboveWatermarkPart = {
                        type: "tool",
                        callID: "call-3",
                        state: { status: "error", error: longError },
                    };
                    const boundaryLengthPart = {
                        type: "tool",
                        callID: "call-4",
                        state: { status: "error", error: exactBoundaryError },
                    };
                    const okStatusPart = {
                        type: "tool",
                        callID: "call-5",
                        state: { status: "ok", error: longError },
                    };

                    const m1 = message("m-1", "assistant", [belowWatermarkPart]);
                    const m2 = message("m-2", "assistant", [atWatermarkPart]);
                    const m3 = message("m-3", "assistant", [
                        aboveWatermarkPart,
                        boundaryLengthPart,
                        okStatusPart,
                    ]);
                    const messages = [m1, m2, m3];

                    const messageTagNumbers = new Map<MessageLike, number>([
                        [m1, 3],
                        [m2, 5],
                        [m3, 6],
                    ]);

                    const truncated = truncateErroredTools(messages, 5, messageTagNumbers);

                    expect(truncated).toBe(2);
                    expect(belowWatermarkPart.state.error).toBe(
                        `${longError.slice(0, 100)}... [truncated]`,
                    );
                    expect(atWatermarkPart.state.error).toBe(
                        `${longError.slice(0, 100)}... [truncated]`,
                    );
                    expect(aboveWatermarkPart.state.error).toBe(longError);
                    expect(boundaryLengthPart.state.error).toBe(exactBoundaryError);
                    expect(okStatusPart.state.error).toBe(longError);
                });
            });
        });

        describe("#given empty messages", () => {
            describe("#when truncating errored tools", () => {
                it("#then it returns zero", () => {
                    expect(truncateErroredTools([], 10, new Map())).toBe(0);
                });
            });
        });
    });

    describe("stripProcessedImages", () => {
        describe("#given user image uploads around assistant responses and watermark boundaries", () => {
            describe("#when stripping processed images", () => {
                it("#then it strips only eligible processed data URLs at or below the watermark", () => {
                    const processedUser = message("m-1", "user", [
                        {
                            type: "file",
                            mime: "image/png",
                            url: buildDataUrl(250),
                            name: "remove-me",
                        },
                        {
                            type: "file",
                            mime: "image/png",
                            url: buildDataUrl(30),
                            name: "too-short",
                        },
                        {
                            type: "file",
                            mime: "text/plain",
                            url: buildDataUrl(250),
                            name: "not-image",
                        },
                    ]);
                    const assistantAfterProcessed = message("m-2", "assistant", [
                        { type: "text", text: "processed" },
                    ]);
                    const aboveWatermarkUser = message("m-3", "user", [
                        {
                            type: "file",
                            mime: "image/jpeg",
                            url: buildDataUrl(250),
                            name: "keep-watermark",
                        },
                    ]);
                    const assistantAfterAbove = message("m-4", "assistant", [
                        { type: "text", text: "also processed" },
                    ]);
                    const unprocessedTailUser = message("m-5", "user", [
                        {
                            type: "file",
                            mime: "image/webp",
                            url: buildDataUrl(250),
                            name: "no-assistant-after",
                        },
                    ]);
                    const messages = [
                        processedUser,
                        assistantAfterProcessed,
                        aboveWatermarkUser,
                        assistantAfterAbove,
                        unprocessedTailUser,
                    ];

                    const messageTagNumbers = new Map<MessageLike, number>([
                        [processedUser, 5],
                        [aboveWatermarkUser, 7],
                        [unprocessedTailUser, 4],
                    ]);

                    const stripped = stripProcessedImages(messages, 5, messageTagNumbers);

                    expect(stripped).toBe(1);
                    expect(buildDataUrl).toHaveBeenCalled();
                    expect(processedUser.parts).toHaveLength(2);
                    expect((processedUser.parts[0] as { name?: string }).name).toBe("too-short");
                    expect((processedUser.parts[1] as { name?: string }).name).toBe("not-image");
                    expect(aboveWatermarkUser.parts).toHaveLength(1);
                    expect(unprocessedTailUser.parts).toHaveLength(1);
                });
            });
        });

        describe("#given empty messages", () => {
            describe("#when stripping processed images", () => {
                it("#then it returns zero", () => {
                    expect(stripProcessedImages([], 5, new Map())).toBe(0);
                });
            });
        });
    });
});
