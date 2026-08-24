/// <reference types="bun-types" />

import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
    clearOldReasoning,
    findLatestAssistantReasoningMutationExemptMessage,
    findMergedReasoningStripCandidateIds,
    replayStrippedInlineThinking,
    stripClearedReasoning,
    stripDroppedPlaceholderMessages,
    stripInlineThinking,
    stripProcessedImages,
    stripReasoningFromMergedAssistants,
    stripSystemInjectedMessages,
} from "./strip-content";
import type { MessageLike, ThinkingLikePart } from "./tag-messages";

function message(id: string, role: string, parts: unknown[]): MessageLike {
    return {
        info: { id, role, sessionID: "ses-1" },
        parts,
    };
}

const SENTINEL = { type: "text", text: "" };
// Whole-message sentinel: defaults to "[dropped]" because `providerID` is
// not passed in these tests. Anthropic-only optimization (text="") is
// covered by dedicated provider-aware tests below.
const WHOLE_MESSAGE_SENTINEL = { type: "text", text: "[dropped]" };

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

                    const result = stripProcessedImages(
                        [user1, assistant1, user2, assistant2, user3NoImage],
                        new Set(),
                        { detect: true, watermark: 3, messageTagNumbers: tags },
                    );

                    expect(result.stripped).toBe(2);
                    expect(result.newlyStrippedIds.sort()).toEqual(["m-1", "m-3"]);
                    // Array lengths preserved
                    expect(user1.parts).toHaveLength(1);
                    expect(user2.parts).toHaveLength(1);
                    expect(user1.parts[0]).toEqual(SENTINEL);
                    expect(user2.parts[0]).toEqual(SENTINEL);
                });

                it("#then a DEFER pass (detect=false) does NOT first-strip an aged image, but a frozen id does", () => {
                    // This is the regression: an aged, processed image must never
                    // be first-removed on a defer pass (Anthropic cache bust). It
                    // only strips once its id was frozen on a cache-busting pass.
                    const user = message("m-1", "user", [
                        { type: "file", mime: "image/png", url: buildDataUrl(2000) },
                    ]);
                    const assistant = message("m-2", "assistant", [
                        { type: "text", text: "processed" },
                    ]);
                    const tags = new Map<MessageLike, number>([
                        [user, 1],
                        [assistant, 2],
                    ]);

                    // Defer pass, nothing frozen → image survives untouched.
                    const deferResult = stripProcessedImages([user, assistant], new Set(), {
                        detect: false,
                        watermark: 5,
                        messageTagNumbers: tags,
                    });
                    expect(deferResult.stripped).toBe(0);
                    expect((user.parts[0] as { type: string }).type).toBe("file");

                    // Same defer pass but the id is frozen → replayed strip fires.
                    const replayResult = stripProcessedImages([user, assistant], new Set(["m-1"]), {
                        detect: false,
                        watermark: 5,
                        messageTagNumbers: tags,
                    });
                    expect(replayResult.stripped).toBe(1);
                    expect(replayResult.newlyStrippedIds).toEqual([]);
                    expect(user.parts[0]).toEqual(SENTINEL);
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

                    const result = stripProcessedImages(
                        [user1, assistant1, recentUser, recentAssistant],
                        new Set(),
                        { detect: true, watermark: 5, messageTagNumbers: tags },
                    );

                    expect(result.stripped).toBe(1);
                    expect(user1.parts[0]).toEqual(SENTINEL);
                    // Recent user's image survives
                    expect((recentUser.parts[0] as { type: string }).type).toBe("file");
                });
            });
        });

        describe("#given an already sentineled processed image", () => {
            describe("#when stripping processed images again", () => {
                it("#then it is byte-identical after the second pass", () => {
                    const user = message("m-1", "user", [
                        {
                            type: "file",
                            mime: "image/png",
                            url: buildDataUrl(2000),
                        },
                    ]);
                    const assistant = message("m-2", "assistant", [
                        { type: "text", text: "processed" },
                    ]);
                    const tags = new Map<MessageLike, number>([
                        [user, 1],
                        [assistant, 2],
                    ]);

                    const opts = { detect: true, watermark: 5, messageTagNumbers: tags };
                    stripProcessedImages([user, assistant], new Set(), opts);
                    const firstPass = JSON.stringify([user, assistant]);
                    stripProcessedImages([user, assistant], new Set(["m-1"]), {
                        ...opts,
                        detect: false,
                    });

                    expect(JSON.stringify([user, assistant])).toBe(firstPass);
                });
            });
        });

        describe("#given empty messages", () => {
            describe("#when stripping processed images", () => {
                it("#then it returns zero", () => {
                    const tags = new Map<MessageLike, number>();
                    expect(
                        stripProcessedImages([], new Set(), {
                            detect: true,
                            watermark: 5,
                            messageTagNumbers: tags,
                        }).stripped,
                    ).toBe(0);
                });
            });
        });
    });

    describe("stripSystemInjectedMessages (sentinel-based)", () => {
        describe("#given a user message matching a system-injection pattern", () => {
            it("#then it keeps the user message shell unchanged (turn boundary preserved)", () => {
                const user = message("m-user", "user", [
                    {
                        type: "text",
                        text: "<system-reminder>do not strip user turns</system-reminder>",
                    },
                ]);

                const result = stripSystemInjectedMessages([user], 1);

                expect(result.stripped).toBe(0);
                expect(result.sentineledIds).toEqual([]);
                expect(user.parts).toEqual([
                    {
                        type: "text",
                        text: "<system-reminder>do not strip user turns</system-reminder>",
                    },
                ]);
            });
        });

        describe("#given an assistant message matching a system-injection pattern", () => {
            it("#then it neutralizes the assistant message with a sentinel", () => {
                const assistant = message("m-assistant", "assistant", [
                    { type: "text", text: "[SYSTEM DIRECTIVE: internal-only]" },
                ]);

                const result = stripSystemInjectedMessages([assistant], 1);

                expect(result.stripped).toBe(1);
                expect(result.sentineledIds).toEqual(["m-assistant"]);
                expect(assistant.parts).toEqual([WHOLE_MESSAGE_SENTINEL]);
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
                // Default (no providerID): non-empty `[dropped]` placeholder
                // so providers that don't filter empties (Kimi, openai-compat)
                // don't get a 400 "must not be empty" rejection.
                expect(assistant.parts).toEqual([WHOLE_MESSAGE_SENTINEL]);
            });
        });

        describe("#given an assistant message with dropped text AND providerID=anthropic", () => {
            it("#then it neutralizes with empty-text sentinel (Anthropic-only optimization)", () => {
                const assistant = message("m-a", "assistant", [
                    { type: "text", text: "[dropped §8§]" },
                ]);

                const result = stripDroppedPlaceholderMessages([assistant], "anthropic");

                expect(result.stripped).toBe(1);
                expect(assistant.parts).toEqual([SENTINEL]);
            });
        });

        describe("#given an assistant message with dropped text AND providerID=opencode-go", () => {
            it("#then it neutralizes with [dropped] sentinel (non-Anthropic safe default)", () => {
                const assistant = message("m-a", "assistant", [
                    { type: "text", text: "[dropped §8§]" },
                ]);

                const result = stripDroppedPlaceholderMessages([assistant], "opencode-go");

                expect(result.stripped).toBe(1);
                expect(assistant.parts).toEqual([WHOLE_MESSAGE_SENTINEL]);
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

        describe("#given an assistant message whose text merely contains a [truncated] word", () => {
            it("#then it does NOT neutralize (only the exact [dropped §N§] placeholder matches)", () => {
                // The strip pattern must match ONLY our canonical placeholder,
                // never arbitrary content that happens to contain the word
                // "truncated" (e.g. a model quoting tool output).
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
        it("keeps a completed tool step exempt behind a metadata-only request shell", () => {
            const completed = message("completed-step", "assistant", [
                { type: "step-start" },
                { type: "reasoning", text: "signed thinking", signature: "sig" },
                { type: "text", text: "status before tool" },
                {
                    type: "tool",
                    callID: "call-live",
                    tool: "bash",
                    state: { status: "completed", input: {}, output: "done" },
                },
                { type: "step-finish" },
            ]);
            const requestShell = message("request-shell", "assistant", [{ type: "step-start" }]);

            expect(
                findLatestAssistantReasoningMutationExemptMessage([completed, requestShell]),
            ).toBe(completed);
        });

        describe("#given a leading whitespace-only text block before the reasoning", () => {
            it("#then keeps the reasoning — whitespace text is sentinel-invisible to the keep-rule", () => {
                // Regression shape after OpenCode's Anthropic adapter normalizes
                // structural sentinels: [" ", thinking, tool_use, " "]. Treating
                // the leading " " as content made the keep-rule skip the
                // thinking block, so the assistant kept reasoning while newest
                // (exempt) and lost it on the first pass after — a byte change at
                // a new position every turn, re-creating the provider cache from
                // that point on every pass.
                const u = message("m-u", "user", [{ type: "text", text: "hi" }]);
                const a1 = message("m-a", "assistant", [
                    { type: "text", text: " " },
                    { type: "reasoning", text: "thinking body" },
                    { type: "tool", callID: "c1", tool: "bash", state: { status: "completed" } },
                    { type: "text", text: " " },
                ]);
                const u2 = message("m-u2", "user", [{ type: "text", text: "next" }]);
                const newest = message("m-a2", "assistant", [
                    { type: "text", text: " " },
                    { type: "reasoning", text: "newer thinking" },
                    { type: "tool", callID: "c2", tool: "bash", state: { status: "completed" } },
                ]);

                // Not exempt: a1 is no longer the newest assistant — the exact
                // transition that previously stripped it.
                const stripped = stripReasoningFromMergedAssistants(
                    [u, a1, u2, newest],
                    "anthropic",
                    {
                        mutationExemptMessage: newest,
                    },
                );

                expect(stripped).toBe(0);
                expect(a1.parts[1]).toMatchObject({ type: "reasoning", text: "thinking body" });
            });

            it("#then still strips reasoning behind REAL leading text (merge rule intact)", () => {
                const u = message("m-u", "user", [{ type: "text", text: "hi" }]);
                const a1 = message("m-a", "assistant", [
                    { type: "text", text: "real prose first" },
                    { type: "reasoning", text: "thinking body" },
                ]);
                const a2 = message("m-a2", "assistant", [{ type: "text", text: "second in run" }]);

                const stripped = stripReasoningFromMergedAssistants([u, a1, a2], "anthropic");

                expect(stripped).toBe(1);
                expect(a1.parts[1]).toMatchObject({ type: "text", text: "" });
            });
        });

        describe("#given a single assistant with reasoning", () => {
            it("#then leaves it untouched (no merge risk — standalone assistant)", () => {
                const u = message("m-u", "user", [{ type: "text", text: "hi" }]);
                const a1 = message("m-a", "assistant", [
                    { type: "reasoning", text: "thinking about it" },
                    { type: "text", text: "response" },
                ]);

                const stripped = stripReasoningFromMergedAssistants([u, a1], "anthropic");

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

                const stripped = stripReasoningFromMergedAssistants([u, a1, a2], "anthropic");

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

        describe("#given cache control on reasoning that would otherwise be stripped", () => {
            it("#then excludes that reasoning from first-application candidates", () => {
                const first = message("m-first", "assistant", [
                    { type: "text", text: "first response" },
                ]);
                const cached = message("m-cached", "assistant", [
                    {
                        type: "reasoning",
                        text: "cached reasoning",
                        cache_control: { type: "ephemeral" },
                    },
                    { type: "text", text: "cached response" },
                ]);
                const newest = message("m-newest", "assistant", [
                    { type: "text", text: "newest response" },
                ]);
                const messages = [first, cached, newest];

                expect(findMergedReasoningStripCandidateIds(messages, "anthropic")).toEqual([]);
                expect(stripReasoningFromMergedAssistants(messages, "anthropic")).toBe(0);
                expect(cached.parts[0]).toEqual({
                    type: "reasoning",
                    text: "cached reasoning",
                    cache_control: { type: "ephemeral" },
                });
            });
        });

        describe("#given the newest in-flight assistant is not first in its run", () => {
            it("#then strips older merged reasoning but preserves newest thinking blocks byte-identically", () => {
                const buildFixture = () => {
                    const latest = message("m-latest", "assistant", [
                        {
                            type: "thinking",
                            thinking: "latest signed thinking",
                            signature: "latest-signature",
                        },
                        {
                            type: "redacted_thinking",
                            data: "latest-redacted-data",
                        },
                        { type: "text", text: "latest tool-use continuation" },
                    ]);
                    return {
                        latest,
                        messages: [
                            message("m-u", "user", [{ type: "text", text: "continue" }]),
                            message("m-first", "assistant", [
                                { type: "reasoning", text: "first reasoning" },
                                { type: "text", text: "first step" },
                            ]),
                            message("m-older", "assistant", [
                                { type: "thinking", thinking: "older merged reasoning" },
                                { type: "text", text: "older step" },
                            ]),
                            latest,
                        ],
                    };
                };

                const unprotected = buildFixture();
                const unprotectedLatestBefore = JSON.stringify(
                    unprotected.latest.parts.slice(0, 2),
                );
                stripReasoningFromMergedAssistants(unprotected.messages, "anthropic");
                expect(JSON.stringify(unprotected.latest.parts.slice(0, 2))).not.toBe(
                    unprotectedLatestBefore,
                );

                const protectedFixture = buildFixture();
                const latestBefore = JSON.stringify(protectedFixture.latest.parts.slice(0, 2));
                const stripped = stripReasoningFromMergedAssistants(
                    protectedFixture.messages,
                    "anthropic",
                    { mutationExemptMessage: protectedFixture.latest },
                );

                expect(stripped).toBe(1);
                expect(protectedFixture.messages[2]?.parts[0]).toEqual(SENTINEL);
                expect(JSON.stringify(protectedFixture.latest.parts.slice(0, 2))).toBe(
                    latestBefore,
                );
            });
        });

        describe("#given a frozen message-id replay set", () => {
            it("#then neutralizes only set members across fresh message objects", () => {
                const buildFixture = () => {
                    const newest = message("m-newest", "assistant", [
                        { type: "reasoning", text: "newest remains exempt" },
                    ]);
                    return {
                        newest,
                        messages: [
                            message("m-u", "user", [{ type: "text", text: "continue" }]),
                            message("m-first", "assistant", [{ type: "text", text: "first" }]),
                            message("m-frozen", "assistant", [
                                { type: "thinking", thinking: "frozen reasoning" },
                                { type: "text", text: "frozen continuation" },
                            ]),
                            message("m-unfrozen", "assistant", [
                                { type: "thinking", thinking: "not frozen yet" },
                                { type: "text", text: "unfrozen continuation" },
                            ]),
                            newest,
                        ],
                    };
                };

                const first = buildFixture();
                expect(
                    stripReasoningFromMergedAssistants(first.messages, "anthropic", {
                        frozenMessageIds: new Set(["m-frozen"]),
                        mutationExemptMessage: first.newest,
                    }),
                ).toBe(1);
                expect(first.messages[2]?.parts[0]).toEqual(SENTINEL);
                expect(first.messages[3]?.parts[0]).toEqual({
                    type: "thinking",
                    thinking: "not frozen yet",
                });

                const rebuilt = buildFixture();
                expect(
                    stripReasoningFromMergedAssistants(rebuilt.messages, "anthropic", {
                        frozenMessageIds: new Set(["m-frozen"]),
                        mutationExemptMessage: rebuilt.newest,
                    }),
                ).toBe(1);
                expect(rebuilt.messages[2]?.parts[0]).toEqual(SENTINEL);
                expect(rebuilt.messages[3]?.parts[0]).toEqual({
                    type: "thinking",
                    thinking: "not frozen yet",
                });
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

                const stripped = stripReasoningFromMergedAssistants([u, a1, a2, a3], "anthropic");

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

                const stripped = stripReasoningFromMergedAssistants([u1, a1, u2, a2], "anthropic");

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

                const stripped = stripReasoningFromMergedAssistants([u, a1, t, a2], "anthropic");

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

                const stripped = stripReasoningFromMergedAssistants([u, a1], "anthropic");

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

                const stripped = stripReasoningFromMergedAssistants([u, a1], "anthropic");

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

                const stripped = stripReasoningFromMergedAssistants([u, a1], "anthropic");

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

                const stripped = stripReasoningFromMergedAssistants([u, a1], "anthropic");

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

                const stripped = stripReasoningFromMergedAssistants([u, a1, a2], "anthropic");

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

                const stripped = stripReasoningFromMergedAssistants([u, a1, a2], "anthropic");

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

                const stripped = stripReasoningFromMergedAssistants([u, a1, a2], "anthropic");

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

                const stripped = stripReasoningFromMergedAssistants([u, a1, a2], "anthropic");

                expect(stripped).toBe(2);
                expect(a1.parts.map((p) => (p as { type: string }).type)).toEqual(["text", "text"]);
                expect(a1.parts[0]).toEqual({ type: "text", text: "intro" });
                expect(a1.parts[1]).toEqual(SENTINEL);
                expect(a2.parts[0]).toEqual(SENTINEL);
                expect(a2.parts[1]).toEqual({ type: "text", text: "final" });
            });
        });

        describe("#given providerID gate (anthropic-only workaround)", () => {
            // Verifies the Kimi/Moonshot fix: stripReasoningFromMergedAssistants
            // is an Anthropic-AI-SDK-specific workaround for groupIntoBlocks.
            // For openai-compatible providers like Kimi, stripping reasoning
            // from non-first merged assistants triggers
            // "thinking is enabled but reasoning_content is missing in
            // assistant tool call message at index N". The function MUST be a
            // no-op for non-anthropic providers.

            it("#then is a no-op when providerID is undefined", () => {
                const u = message("m-u", "user", [{ type: "text", text: "hi" }]);
                const a1 = message("m-a1", "assistant", [
                    { type: "reasoning", text: "first reasoning" },
                    { type: "tool", tool: "edit", id: "edit:1" },
                ]);
                const a2 = message("m-a2", "assistant", [
                    { type: "reasoning", text: "second reasoning" },
                    { type: "tool", tool: "bash", id: "bash:2" },
                ]);

                const stripped = stripReasoningFromMergedAssistants([u, a1, a2]);

                expect(stripped).toBe(0);
                // Both reasoning parts preserved
                expect(a1.parts[0]).toEqual({ type: "reasoning", text: "first reasoning" });
                expect(a2.parts[0]).toEqual({ type: "reasoning", text: "second reasoning" });
            });

            it("#then is a no-op for opencode-go (Kimi/Moonshot)", () => {
                const u = message("m-u", "user", [{ type: "text", text: "hi" }]);
                const a1 = message("m-a1", "assistant", [
                    { type: "reasoning", text: "first reasoning" },
                    { type: "tool", tool: "edit", id: "edit:1" },
                ]);
                const a2 = message("m-a2", "assistant", [
                    { type: "reasoning", text: "second reasoning" },
                    { type: "tool", tool: "bash", id: "bash:2" },
                ]);

                const stripped = stripReasoningFromMergedAssistants([u, a1, a2], "opencode-go");

                expect(stripped).toBe(0);
                expect(a1.parts[0]).toEqual({ type: "reasoning", text: "first reasoning" });
                expect(a2.parts[0]).toEqual({ type: "reasoning", text: "second reasoning" });
            });

            it("#then is a no-op for github-copilot", () => {
                const u = message("m-u", "user", [{ type: "text", text: "hi" }]);
                const a1 = message("m-a1", "assistant", [{ type: "reasoning", text: "first" }]);
                const a2 = message("m-a2", "assistant", [{ type: "reasoning", text: "second" }]);

                const stripped = stripReasoningFromMergedAssistants([u, a1, a2], "github-copilot");

                expect(stripped).toBe(0);
            });

            it("#then runs normally for providerID === 'anthropic'", () => {
                const u = message("m-u", "user", [{ type: "text", text: "hi" }]);
                const a1 = message("m-a1", "assistant", [
                    { type: "reasoning", text: "first reasoning" },
                ]);
                const a2 = message("m-a2", "assistant", [
                    { type: "reasoning", text: "second reasoning" },
                ]);

                const stripped = stripReasoningFromMergedAssistants([u, a1, a2], "anthropic");

                expect(stripped).toBe(1);
                // First kept, second sentineled
                expect(a1.parts[0]).toEqual({ type: "reasoning", text: "first reasoning" });
                expect(a2.parts[0]).toEqual(SENTINEL);
            });
        });
    });

    it("matches the pre-guard replay and placeholder output on a mixed fixture", () => {
        const fixture = [
            message("user-placeholder", "user", [{ type: "text", text: "[dropped §1§]" }]),
            message("reasoning-image", "assistant", [
                { type: "reasoning", text: "signed reasoning", signature: "sig" },
                { type: "text", text: "clean answer without inline tags" },
                { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" },
            ]),
            message("dropped", "assistant", [
                { type: "text", text: "[dropped §2§]\n[dropped §3§]" },
            ]),
            message("merged-a", "assistant", [
                { type: "text", text: "<thinking>hidden</thinking>visible" },
            ]),
            message("merged-b", "assistant", [{ type: "text", text: "<think>brief</think>tail" }]),
        ];
        const before = structuredClone(fixture) as MessageLike[];
        const guarded = structuredClone(fixture) as MessageLike[];
        const tagMap = (messages: MessageLike[]) =>
            new Map(messages.map((entry, index) => [entry, index + 1] as const));
        const inlinePattern = /<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>\s*/g;

        let oldInlineCount = 0;
        for (const entry of before) {
            if (entry.info.role !== "assistant") continue;
            for (const part of entry.parts) {
                if (
                    typeof part !== "object" ||
                    part === null ||
                    (part as { type?: unknown }).type !== "text" ||
                    typeof (part as { text?: unknown }).text !== "string"
                ) {
                    continue;
                }
                const textPart = part as { text: string };
                const cleaned = textPart.text.replace(inlinePattern, "");
                if (cleaned !== textPart.text) {
                    textPart.text = cleaned;
                    oldInlineCount += 1;
                }
            }
        }
        const droppedPattern = /^\[dropped §\d+§\](?:\s*\[dropped §\d+§\])*$/;
        let oldDroppedCount = 0;
        for (const entry of before) {
            if (entry.info.role === "user") continue;
            let hasContent = false;
            let hasNonDropped = false;
            for (const part of entry.parts) {
                if (typeof part !== "object" || part === null) continue;
                const record = part as { type?: unknown; text?: unknown };
                if (
                    (record.type === "text" || record.type === "reasoning") &&
                    typeof record.text === "string"
                ) {
                    hasContent = true;
                    const trimmed = record.text.trim();
                    if (trimmed.length > 0 && !droppedPattern.test(trimmed)) {
                        hasNonDropped = true;
                        break;
                    }
                } else {
                    hasNonDropped = true;
                    break;
                }
            }
            if (hasContent && !hasNonDropped) {
                entry.parts = [{ type: "text", text: "" }];
                oldDroppedCount += 1;
            }
        }

        const guardedInlineCount = replayStrippedInlineThinking(guarded, tagMap(guarded), 99);
        const guardedDropped = stripDroppedPlaceholderMessages(guarded, "anthropic");

        expect(guardedInlineCount).toBe(oldInlineCount);
        expect(guardedDropped.stripped).toBe(oldDroppedCount);
        expect(JSON.stringify(guarded)).toBe(JSON.stringify(before));
    });
});
