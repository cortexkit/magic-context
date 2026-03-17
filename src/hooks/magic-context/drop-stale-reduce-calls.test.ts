/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { dropStaleReduceCalls } from "./drop-stale-reduce-calls";
import type { MessageLike } from "./tag-messages";

function makeMessage(role: string, parts: unknown[]): MessageLike {
    return { info: { role }, parts };
}

function makeToolPart(toolName: string, output: string, callId = "call-1") {
    return { type: "tool", tool: toolName, callID: callId, state: { output, status: "completed" } };
}

function makeTextPart(text: string) {
    return { type: "text", text };
}

describe("dropStaleReduceCalls", () => {
    describe("#given messages with ctx_reduce tool results", () => {
        describe("#when dropping stale calls", () => {
            it("#then removes ctx_reduce tool parts", () => {
                //#given
                const messages = [
                    makeMessage("user", [makeTextPart("hello")]),
                    makeMessage("assistant", [makeTextPart("thinking...")]),
                    makeMessage("tool", [makeToolPart("ctx_reduce", "Queued: drop §1§")]),
                    makeMessage("user", [makeTextPart("continue")]),
                ];

                //#when
                const didDrop = dropStaleReduceCalls(messages);

                //#then
                expect(didDrop).toBe(true);
                expect(messages).toHaveLength(3);
                expect(messages[0].parts[0]).toEqual(makeTextPart("hello"));
                expect(messages[1].parts[0]).toEqual(makeTextPart("thinking..."));
                expect(messages[2].parts[0]).toEqual(makeTextPart("continue"));
            });
        });
    });

    describe("#given messages with non-reduce tool results", () => {
        describe("#when dropping stale calls", () => {
            it("#then leaves other tool results untouched", () => {
                //#given
                const messages = [
                    makeMessage("tool", [makeToolPart("grep", "found 3 matches")]),
                    makeMessage("tool", [makeToolPart("bash", "exit code 0")]),
                ];

                //#when
                const didDrop = dropStaleReduceCalls(messages);

                //#then
                expect(didDrop).toBe(false);
                expect(messages).toHaveLength(2);
            });
        });
    });

    describe("#given no messages", () => {
        describe("#when dropping stale calls", () => {
            it("#then returns false", () => {
                const messages: MessageLike[] = [];
                expect(dropStaleReduceCalls(messages)).toBe(false);
            });
        });
    });

    describe("#given message with mixed tool parts including ctx_reduce", () => {
        describe("#when one part is ctx_reduce and another is a different tool", () => {
            it("#then removes only the ctx_reduce part and keeps the message", () => {
                //#given
                const messages = [
                    makeMessage("tool", [
                        makeToolPart("bash", "exit code 0", "call-a"),
                        makeToolPart("ctx_reduce", "Queued: drop §5§", "call-b"),
                    ]),
                ];

                //#when
                const didDrop = dropStaleReduceCalls(messages);

                //#then
                expect(didDrop).toBe(true);
                expect(messages).toHaveLength(1);
                expect(messages[0].parts).toHaveLength(1);
                expect((messages[0].parts[0] as { tool: string }).tool).toBe("bash");
            });
        });
    });

    describe("#given messages within protected range", () => {
        describe("#when protectedCount covers the reduce call", () => {
            it("#then skips protected messages and keeps their reduce calls", () => {
                //#given
                const messages = [
                    makeMessage("user", [makeTextPart("old message")]),
                    makeMessage("tool", [makeToolPart("ctx_reduce", "Queued: drop §1§")]),
                    makeMessage("user", [makeTextPart("recent message")]),
                    makeMessage("tool", [makeToolPart("ctx_reduce", "Queued: drop §5§")]),
                ];

                //#when — protect last 2 messages
                const didDrop = dropStaleReduceCalls(messages, 2);

                //#then — only the old reduce call (index 1) is removed
                expect(didDrop).toBe(true);
                expect(messages).toHaveLength(3);
                expect(messages[0].parts[0]).toEqual(makeTextPart("old message"));
                expect(messages[1].parts[0]).toEqual(makeTextPart("recent message"));
                expect((messages[2].parts[0] as { tool: string }).tool).toBe("ctx_reduce");
            });
        });
    });

    describe("#given all messages within protected range", () => {
        describe("#when protectedCount covers everything", () => {
            it("#then drops nothing", () => {
                //#given
                const messages = [
                    makeMessage("tool", [makeToolPart("ctx_reduce", "Queued: drop §1§")]),
                    makeMessage("user", [makeTextPart("hello")]),
                ];

                //#when — protect all messages
                const didDrop = dropStaleReduceCalls(messages, 10);

                //#then
                expect(didDrop).toBe(false);
                expect(messages).toHaveLength(2);
            });
        });
    });
});
