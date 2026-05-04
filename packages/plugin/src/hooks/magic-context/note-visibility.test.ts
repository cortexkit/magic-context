/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { hasVisibleNoteReadCall } from "./note-visibility";
import { makeSentinel } from "./sentinel";
import type { MessageLike } from "./tag-messages";

function userMsg(id: string, parts: unknown[]): MessageLike {
    return {
        info: { id, role: "user" },
        parts,
    } as unknown as MessageLike;
}

function assistantMsg(id: string, parts: unknown[]): MessageLike {
    return {
        info: { id, role: "assistant" },
        parts,
    } as unknown as MessageLike;
}

describe("hasVisibleNoteReadCall", () => {
    it("returns false on empty messages", () => {
        expect(hasVisibleNoteReadCall([])).toBe(false);
    });

    it("returns true for OpenCode `tool` part shape with action=read", () => {
        const msgs = [
            assistantMsg("a-1", [
                {
                    type: "tool",
                    tool: "ctx_note",
                    state: { input: { action: "read" } },
                },
            ]),
        ];
        expect(hasVisibleNoteReadCall(msgs)).toBe(true);
    });

    it("returns true for `tool_use` part shape with action=read", () => {
        const msgs = [
            assistantMsg("a-1", [
                {
                    type: "tool_use",
                    name: "ctx_note",
                    input: { action: "read" },
                },
            ]),
        ];
        expect(hasVisibleNoteReadCall(msgs)).toBe(true);
    });

    it("returns true for `tool-invocation` part shape with action=read (args)", () => {
        const msgs = [
            assistantMsg("a-1", [
                {
                    type: "tool-invocation",
                    toolName: "ctx_note",
                    args: { action: "read" },
                },
            ]),
        ];
        expect(hasVisibleNoteReadCall(msgs)).toBe(true);
    });

    it("returns true for `tool-invocation` part shape with action=read (input fallback)", () => {
        const msgs = [
            assistantMsg("a-1", [
                {
                    type: "tool-invocation",
                    toolName: "ctx_note",
                    input: { action: "read" },
                },
            ]),
        ];
        expect(hasVisibleNoteReadCall(msgs)).toBe(true);
    });

    it("returns false when ctx_note action is write/update/dismiss (only read counts)", () => {
        for (const action of ["write", "update", "dismiss"]) {
            const msgs = [
                assistantMsg("a-1", [
                    { type: "tool", tool: "ctx_note", state: { input: { action } } },
                ]),
            ];
            expect(hasVisibleNoteReadCall(msgs)).toBe(false);
        }
    });

    it("returns false when ctx_note read part has been replaced with a sentinel", () => {
        const stripped = makeSentinel({
            type: "tool",
            tool: "ctx_note",
            state: { input: { action: "read" } },
        });
        const msgs = [assistantMsg("a-1", [stripped])];
        expect(hasVisibleNoteReadCall(msgs)).toBe(false);
    });

    it("returns false when no ctx_note tool calls exist", () => {
        const msgs = [
            userMsg("u-1", [{ type: "text", text: "hello" }]),
            assistantMsg("a-1", [
                { type: "text", text: "response" },
                { type: "tool", tool: "read", state: { input: { filePath: "x" } } },
                { type: "tool", tool: "write", state: { input: { filePath: "x" } } },
            ]),
        ];
        expect(hasVisibleNoteReadCall(msgs)).toBe(false);
    });

    it("scans newest-first and returns true on first visible match", () => {
        // Simulate: old read got sentineled, new read is intact — should return true.
        const oldStripped = makeSentinel({
            type: "tool",
            tool: "ctx_note",
            state: { input: { action: "read" } },
        });
        const msgs = [
            assistantMsg("a-1", [oldStripped]),
            userMsg("u-2", [{ type: "text", text: "follow up" }]),
            assistantMsg("a-2", [
                { type: "tool", tool: "ctx_note", state: { input: { action: "read" } } },
            ]),
        ];
        expect(hasVisibleNoteReadCall(msgs)).toBe(true);
    });

    it("returns false when all reads are stripped sentinels", () => {
        const s1 = makeSentinel({
            type: "tool",
            tool: "ctx_note",
            state: { input: { action: "read" } },
        });
        const s2 = makeSentinel({
            type: "tool_use",
            name: "ctx_note",
            input: { action: "read" },
        });
        const msgs = [assistantMsg("a-1", [s1, s2])];
        expect(hasVisibleNoteReadCall(msgs)).toBe(false);
    });

    it("ignores parts without role information / malformed messages", () => {
        const msgs = [
            { info: {}, parts: null } as unknown as MessageLike,
            { info: { role: "user" } } as unknown as MessageLike, // no parts
        ];
        expect(hasVisibleNoteReadCall(msgs)).toBe(false);
    });
});
