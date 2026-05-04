/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { dropStaleReduceCalls } from "./drop-stale-reduce-calls";
import { isSentinel } from "./sentinel";
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

describe("dropStaleReduceCalls (sentinel-based)", () => {
    describe("#given messages with ctx_reduce tool results", () => {
        describe("#when dropping stale calls", () => {
            it("#then sentinels ctx_reduce parts but preserves messages.length", () => {
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
                // Array length preserved — proxy cache stability invariant
                expect(messages).toHaveLength(4);
                // Non-sentinel messages unchanged
                expect(messages[0].parts[0]).toEqual(makeTextPart("hello"));
                expect(messages[1].parts[0]).toEqual(makeTextPart("thinking..."));
                expect(messages[3].parts[0]).toEqual(makeTextPart("continue"));
                // The ctx_reduce-only message became a single-sentinel shell
                expect(messages[2].parts).toHaveLength(1);
                expect(isSentinel(messages[2].parts[0])).toBe(true);
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
                // Parts unchanged
                expect((messages[0].parts[0] as { tool: string }).tool).toBe("grep");
                expect((messages[1].parts[0] as { tool: string }).tool).toBe("bash");
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
            it("#then sentinels only the ctx_reduce part and preserves parts.length", () => {
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
                // Parts length preserved
                expect(messages[0].parts).toHaveLength(2);
                // First part untouched
                expect((messages[0].parts[0] as { tool: string }).tool).toBe("bash");
                // Second part is now a sentinel
                expect(isSentinel(messages[0].parts[1])).toBe(true);
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

                //#then — only the old reduce call (index 1) is sentineled
                expect(didDrop).toBe(true);
                expect(messages).toHaveLength(4);
                expect(messages[0].parts[0]).toEqual(makeTextPart("old message"));
                // Index 1 is the neutralized reduce — single-sentinel shell
                expect(messages[1].parts).toHaveLength(1);
                expect(isSentinel(messages[1].parts[0])).toBe(true);
                expect(messages[2].parts[0]).toEqual(makeTextPart("recent message"));
                // Protected reduce call stays untouched
                expect((messages[3].parts[0] as { tool: string }).tool).toBe("ctx_reduce");
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
                // Parts unchanged
                expect((messages[0].parts[0] as { tool: string }).tool).toBe("ctx_reduce");
            });
        });
    });

    describe("#given a message that's already been sentineled on a prior pass", () => {
        describe("#when the sentinel is in the sweep range", () => {
            it("#then skips the sentinel idempotently", () => {
                //#given — message[0] was already sentineled on a previous pass
                const messages = [
                    makeMessage("tool", [{ type: "text", text: "" }]),
                    makeMessage("user", [makeTextPart("hello")]),
                ];

                //#when
                const didDrop = dropStaleReduceCalls(messages);

                //#then — no new mutations, shape identical
                expect(didDrop).toBe(false);
                expect(messages).toHaveLength(2);
                expect(messages[0].parts).toHaveLength(1);
                expect(isSentinel(messages[0].parts[0])).toBe(true);
            });
        });
    });
});
