/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { clearOldReasoning, tagMessages } from "./transform-operations";

type TextPart = { type: "text"; text: string };
type ToolPart = { type: "tool"; callID: string; state: { output: string } };
type ThinkingPart = { type: "thinking"; thinking: string };
type ReasoningPart = { type: "reasoning"; text: string };
type ToolInvocationPart = { type: "tool-invocation"; callID: string };
type FilePart = { type: "file"; url: string; mime?: string; filename?: string };
type TestPart = TextPart | ToolPart | ThinkingPart | ReasoningPart | ToolInvocationPart | FilePart;
type TestMessage = {
    info: { id: string; role: string; sessionID?: string };
    parts: TestPart[];
};

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

describe("tagMessages", () => {
    describe("#given assistant message with thinking + tool_use but no text", () => {
        describe("#when tool output is dropped", () => {
            it("#then clears thinking in the preceding assistant message", () => {
                useTempDataHome("tag-cross-msg-clear-");
                const db = openDatabase();
                const tagger = createTagger();

                const thinkingPart: ThinkingPart = {
                    type: "thinking",
                    thinking: "long reasoning about tool use",
                };
                const messages: TestMessage[] = [
                    {
                        info: { id: "m-user", role: "user", sessionID: "ses-1" },
                        parts: [{ type: "text", text: "run the command" }],
                    },
                    {
                        info: { id: "m-assistant", role: "assistant" },
                        parts: [thinkingPart, { type: "tool-invocation", callID: "call-1" }],
                    },
                    {
                        info: { id: "m-tool", role: "tool" },
                        parts: [
                            { type: "tool", callID: "call-1", state: { output: "command output" } },
                        ],
                    },
                ];

                const { targets } = tagMessages("ses-1", messages, tagger, db);
                const toolTagId = tagger.getTag("ses-1", "call-1")!;
                targets.get(toolTagId)!.setContent("[dropped]");

                expect(thinkingPart.thinking).toBe("[cleared]");
            });
        });
    });

    describe("#given assistant message with thinking + text + tool_use", () => {
        describe("#when tool output is dropped", () => {
            it("#then does NOT clear thinking (text tag owns it)", () => {
                useTempDataHome("tag-text-owns-thinking-");
                const db = openDatabase();
                const tagger = createTagger();

                const thinkingPart: ThinkingPart = {
                    type: "thinking",
                    thinking: "reasoning about response",
                };
                const messages: TestMessage[] = [
                    {
                        info: { id: "m-user", role: "user", sessionID: "ses-1" },
                        parts: [{ type: "text", text: "explain and run" }],
                    },
                    {
                        info: { id: "m-assistant", role: "assistant" },
                        parts: [
                            thinkingPart,
                            { type: "text", text: "here is my explanation" },
                            { type: "tool-invocation", callID: "call-1" },
                        ],
                    },
                    {
                        info: { id: "m-tool", role: "tool" },
                        parts: [
                            { type: "tool", callID: "call-1", state: { output: "tool result" } },
                        ],
                    },
                ];

                const { targets } = tagMessages("ses-1", messages, tagger, db);
                const toolTagId = tagger.getTag("ses-1", "call-1")!;
                targets.get(toolTagId)!.setContent("[dropped]");

                expect(thinkingPart.thinking).toBe("reasoning about response");
            });
        });

        describe("#when text part is dropped", () => {
            it("#then clears thinking via the text tag closure", () => {
                useTempDataHome("tag-text-clears-thinking-");
                const db = openDatabase();
                const tagger = createTagger();

                const thinkingPart: ThinkingPart = {
                    type: "thinking",
                    thinking: "reasoning about response",
                };
                const messages: TestMessage[] = [
                    {
                        info: { id: "m-user", role: "user", sessionID: "ses-1" },
                        parts: [{ type: "text", text: "explain and run" }],
                    },
                    {
                        info: { id: "m-assistant", role: "assistant" },
                        parts: [thinkingPart, { type: "text", text: "here is my explanation" }],
                    },
                ];

                const { targets } = tagMessages("ses-1", messages, tagger, db);
                const textTagId = tagger.getTag("ses-1", "m-assistant:p1")!;
                targets.get(textTagId)!.setContent("[dropped]");

                expect(thinkingPart.thinking).toBe("[cleared]");
            });
        });
    });

    describe("#given multiple tool results from the same assistant turn", () => {
        describe("#when one tool output is dropped", () => {
            it("#then clears shared thinking (idempotent)", () => {
                useTempDataHome("tag-multi-tool-shared-");
                const db = openDatabase();
                const tagger = createTagger();

                const thinkingPart: ThinkingPart = {
                    type: "thinking",
                    thinking: "planning two tool calls",
                };
                const messages: TestMessage[] = [
                    {
                        info: { id: "m-user", role: "user", sessionID: "ses-1" },
                        parts: [{ type: "text", text: "do two things" }],
                    },
                    {
                        info: { id: "m-assistant", role: "assistant" },
                        parts: [
                            thinkingPart,
                            { type: "tool-invocation", callID: "call-1" },
                            { type: "tool-invocation", callID: "call-2" },
                        ],
                    },
                    {
                        info: { id: "m-tool-1", role: "tool" },
                        parts: [{ type: "tool", callID: "call-1", state: { output: "result 1" } }],
                    },
                    {
                        info: { id: "m-tool-2", role: "tool" },
                        parts: [{ type: "tool", callID: "call-2", state: { output: "result 2" } }],
                    },
                ];

                const { targets } = tagMessages("ses-1", messages, tagger, db);

                const toolTag1 = tagger.getTag("ses-1", "call-1")!;
                targets.get(toolTag1)!.setContent("[dropped]");
                expect(thinkingPart.thinking).toBe("[cleared]");

                const toolTag2 = tagger.getTag("ses-1", "call-2")!;
                targets.get(toolTag2)!.setContent("[dropped]");
                expect(thinkingPart.thinking).toBe("[cleared]");
            });
        });
    });

    describe("#given user message between assistant and tool result", () => {
        describe("#when tool output is dropped", () => {
            it("#then does NOT clear thinking from a previous turn (cross-turn leakage prevention)", () => {
                useTempDataHome("tag-cross-turn-leakage-");
                const db = openDatabase();
                const tagger = createTagger();

                const thinkingPart: ThinkingPart = {
                    type: "thinking",
                    thinking: "old turn reasoning",
                };
                const messages: TestMessage[] = [
                    {
                        info: { id: "m-user-1", role: "user", sessionID: "ses-1" },
                        parts: [{ type: "text", text: "first request" }],
                    },
                    {
                        info: { id: "m-assistant-1", role: "assistant" },
                        parts: [thinkingPart, { type: "tool-invocation", callID: "call-old" }],
                    },
                    {
                        info: { id: "m-user-2", role: "user", sessionID: "ses-1" },
                        parts: [{ type: "text", text: "new request" }],
                    },
                    {
                        info: { id: "m-tool", role: "tool" },
                        parts: [
                            { type: "tool", callID: "call-new", state: { output: "new result" } },
                        ],
                    },
                ];

                const { targets } = tagMessages("ses-1", messages, tagger, db);
                const toolTagId = tagger.getTag("ses-1", "call-new")!;
                targets.get(toolTagId)!.setContent("[dropped]");

                expect(thinkingPart.thinking).toBe("old turn reasoning");
            });
        });
    });

    describe("#given assistant message with reasoning type thinking part", () => {
        describe("#when tool output is dropped", () => {
            it("#then clears reasoning-type thinking parts too", () => {
                useTempDataHome("tag-reasoning-type-");
                const db = openDatabase();
                const tagger = createTagger();

                const reasoningPart: ReasoningPart = {
                    type: "reasoning",
                    text: "extended reasoning content",
                };
                const messages: TestMessage[] = [
                    {
                        info: { id: "m-user", role: "user", sessionID: "ses-1" },
                        parts: [{ type: "text", text: "run it" }],
                    },
                    {
                        info: { id: "m-assistant", role: "assistant" },
                        parts: [reasoningPart, { type: "tool-invocation", callID: "call-1" }],
                    },
                    {
                        info: { id: "m-tool", role: "tool" },
                        parts: [{ type: "tool", callID: "call-1", state: { output: "output" } }],
                    },
                ];

                const { targets } = tagMessages("ses-1", messages, tagger, db);
                const toolTagId = tagger.getTag("ses-1", "call-1")!;
                targets.get(toolTagId)!.setContent("[dropped]");

                expect(reasoningPart.text).toBe("[cleared]");
            });
        });
    });

    describe("#given user message with file part", () => {
        it("#when file part is tagged #then assigns tag and tracks byte size of url", () => {
            useTempDataHome("context-tag-file-");
            const db = openDatabase();
            const tagger = createTagger();
            const fileUrl = `data:image/png;base64,${"A".repeat(1000)}`;
            const messages: TestMessage[] = [
                {
                    info: { id: "m-user", role: "user", sessionID: "ses-1" },
                    parts: [
                        { type: "text", text: "see image" },
                        {
                            type: "file",
                            url: fileUrl,
                            mime: "image/png",
                            filename: "screenshot.png",
                        },
                    ],
                },
            ];

            const { targets } = tagMessages("ses-1", messages, tagger, db);

            expect(targets.size).toBe(2);
            const textTagId = tagger.getTag("ses-1", "m-user:p0")!;
            expect(textTagId).toBeDefined();
            const fileTagId = tagger.getTag("ses-1", "m-user:file1")!;
            expect(fileTagId).toBeDefined();
        });

        it("#when file part is dropped #then replaces with text part", () => {
            useTempDataHome("context-tag-file-drop-");
            const db = openDatabase();
            const tagger = createTagger();
            const fileUrl = `data:image/png;base64,${"A".repeat(1000)}`;
            const messages: TestMessage[] = [
                {
                    info: { id: "m-user", role: "user", sessionID: "ses-1" },
                    parts: [
                        { type: "text", text: "see image" },
                        {
                            type: "file",
                            url: fileUrl,
                            mime: "image/png",
                            filename: "screenshot.png",
                        },
                    ],
                },
            ];

            const { targets } = tagMessages("ses-1", messages, tagger, db);
            const fileTagId = tagger.getTag("ses-1", "m-user:file1")!;
            targets.get(fileTagId)!.setContent(`[dropped §${fileTagId}§]`);

            const replacedPart = messages[0].parts[1] as { type: string; text: string };
            expect(replacedPart.type).toBe("text");
            expect(replacedPart.text).toContain("[dropped");
        });
    });
});

describe("clearOldReasoning", () => {
    describe("#given messages with tag numbers older than the age threshold", () => {
        describe("#when reasoning parts exist in old messages", () => {
            it("#then clears all reasoning parts before the age cutoff", () => {
                const thinkingPart1: ThinkingPart = {
                    type: "thinking",
                    thinking: "early reasoning",
                };
                const thinkingPart2: ThinkingPart = {
                    type: "thinking",
                    thinking: "later reasoning",
                };

                const messages: TestMessage[] = [
                    {
                        info: { id: "m-user-1", role: "user", sessionID: "ses-1" },
                        parts: [{ type: "text", text: "first request" }],
                    },
                    {
                        info: { id: "m-assistant-1", role: "assistant" },
                        parts: [thinkingPart1, { type: "text", text: "first response" }],
                    },
                    {
                        info: { id: "m-user-2", role: "user", sessionID: "ses-1" },
                        parts: [{ type: "text", text: "second request" }],
                    },
                    {
                        info: { id: "m-assistant-2", role: "assistant" },
                        parts: [thinkingPart2, { type: "text", text: "recent response" }],
                    },
                ];

                const reasoningByMessage = new Map<TestMessage, ThinkingPart[]>([
                    [messages[1], [thinkingPart1]],
                    [messages[3], [thinkingPart2]],
                ]);

                // maxTag=10, clearReasoningAge=5 => ageCutoff=5; tag 2 is old (cleared), tag 8 is recent (kept)
                const messageTagNumbers = new Map<TestMessage, number>([
                    [messages[1], 2],
                    [messages[3], 8],
                ]);

                const cleared = clearOldReasoning(
                    messages,
                    reasoningByMessage,
                    messageTagNumbers,
                    5,
                );

                expect(thinkingPart1.thinking).toBe("[cleared]");
                expect(thinkingPart2.thinking).toBe("later reasoning");
                expect(cleared).toBe(1);
            });
        });
    });

    describe("#given no messages have tag numbers", () => {
        it("#then does not clear any reasoning parts", () => {
            const thinkingPart: ThinkingPart = { type: "thinking", thinking: "some reasoning" };

            const messages: TestMessage[] = [
                {
                    info: { id: "m-user", role: "user", sessionID: "ses-1" },
                    parts: [{ type: "text", text: "request" }],
                },
                {
                    info: { id: "m-assistant", role: "assistant" },
                    parts: [thinkingPart, { type: "text", text: "response" }],
                },
            ];

            const reasoningByMessage = new Map<TestMessage, ThinkingPart[]>([
                [messages[1], [thinkingPart]],
            ]);

            const cleared = clearOldReasoning(messages, reasoningByMessage, new Map(), 10);

            expect(thinkingPart.thinking).toBe("some reasoning");
            expect(cleared).toBe(0);
        });
    });

    describe("#given already-cleared reasoning parts", () => {
        it("#then skips them (idempotent)", () => {
            const thinkingPart: ThinkingPart = { type: "thinking", thinking: "[cleared]" };

            const messages: TestMessage[] = [
                {
                    info: { id: "m-user", role: "user", sessionID: "ses-1" },
                    parts: [{ type: "text", text: "request" }],
                },
                {
                    info: { id: "m-assistant", role: "assistant" },
                    parts: [thinkingPart, { type: "text", text: "response" }],
                },
            ];

            const reasoningByMessage = new Map<TestMessage, ThinkingPart[]>([
                [messages[1], [thinkingPart]],
            ]);

            // maxTag=10, age=5 => ageCutoff=5, tag 1 is <=5
            const messageTagNumbers = new Map<TestMessage, number>([[messages[1], 1]]);

            const cleared = clearOldReasoning(messages, reasoningByMessage, messageTagNumbers, 5);

            expect(thinkingPart.thinking).toBe("[cleared]");
            expect(cleared).toBe(0);
        });
    });

    describe("#given OpenAI reasoning parts with text field", () => {
        it("#then clears the text field", () => {
            const reasoningPart: ReasoningPart = {
                type: "reasoning",
                text: "encrypted reasoning content",
            };

            const messages: TestMessage[] = [
                {
                    info: { id: "m-user-1", role: "user", sessionID: "ses-1" },
                    parts: [{ type: "text", text: "first request" }],
                },
                {
                    info: { id: "m-assistant-1", role: "assistant" },
                    parts: [reasoningPart, { type: "text", text: "response" }],
                },
                {
                    info: { id: "m-user-2", role: "user", sessionID: "ses-1" },
                    parts: [{ type: "text", text: "second request" }],
                },
                {
                    info: { id: "m-assistant-2", role: "assistant" },
                    parts: [{ type: "text", text: "recent response" }],
                },
            ];

            const reasoningByMessage = new Map<TestMessage, ReasoningPart[]>([
                [messages[1], [reasoningPart]],
            ]);

            // maxTag=10, age=5 => ageCutoff=5; tag 2 is old (cleared); tag 10 is recent (no reasoning map entry)
            const messageTagNumbers = new Map<TestMessage, number>([
                [messages[1], 2],
                [messages[3], 10],
            ]);

            const cleared = clearOldReasoning(messages, reasoningByMessage, messageTagNumbers, 5);

            expect(reasoningPart.text).toBe("[cleared]");
            expect(cleared).toBe(1);
        });
    });

    describe("#given messages where all are recent (none exceed age threshold)", () => {
        it("#then does not clear any reasoning parts", () => {
            const thinkingPart: ThinkingPart = { type: "thinking", thinking: "reasoning" };

            const messages: TestMessage[] = [
                {
                    info: { id: "m-user", role: "user", sessionID: "ses-1" },
                    parts: [{ type: "text", text: "request" }],
                },
                {
                    info: { id: "m-assistant", role: "assistant" },
                    parts: [thinkingPart, { type: "text", text: "response" }],
                },
            ];

            const reasoningByMessage = new Map<TestMessage, ThinkingPart[]>([
                [messages[1], [thinkingPart]],
            ]);

            // maxTag=8, age=5 => ageCutoff=3; tag 7 is >3 (recent — kept)
            const messageTagNumbers = new Map<TestMessage, number>([[messages[1], 7]]);

            const cleared = clearOldReasoning(messages, reasoningByMessage, messageTagNumbers, 5);

            expect(thinkingPart.thinking).toBe("reasoning");
            expect(cleared).toBe(0);
        });
    });
});
