/// <reference types="bun-types" />

/**
 * The tail-hygiene measurement tokenizes every rendered tool output it has not
 * measured before. Two sessions served alternately by one process must not
 * evict each other's measurements: with a 64 MiB memo, two sessions of about
 * 20 MB of tool output each re-tokenized everything on every pass (about a
 * second per 50 MB).
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { TagEntry } from "../../features/magic-context/types";
import * as formatting from "./read-session-formatting";
import type { MessageLike } from "./tag-messages";
import { refreshTailHygieneBaseline } from "./tail-hygiene-walk";

const OUTPUT_CHARS = 1_000_000;
const ARCS_PER_SESSION = 20;

function session(name: string): { messages: MessageLike[]; tags: TagEntry[] } {
    const messages: MessageLike[] = [
        { info: { id: `${name}-user`, role: "user" }, parts: [{ type: "text", text: "go" }] },
    ];
    const tags: TagEntry[] = [];
    for (let arc = 1; arc <= ARCS_PER_SESSION; arc += 1) {
        const callId = `${name}-call-${arc}`;
        const owner = `${name}-assistant-${arc}`;
        messages.push({
            info: { id: owner, role: "assistant" },
            parts: [
                {
                    type: "tool",
                    callID: callId,
                    tool: "read",
                    state: {
                        status: "completed",
                        input: { path: `${name}/file-${arc}.ts` },
                        // Distinct content per output, so no two outputs share a memo entry.
                        output: `${name} ${arc} `.padEnd(OUTPUT_CHARS, "source line\n"),
                    },
                },
            ],
        });
        tags.push({
            tagNumber: arc,
            messageId: callId,
            type: "tool",
            status: "active",
            dropMode: "full",
            toolName: "read",
            inputByteSize: 0,
            byteSize: OUTPUT_CHARS,
            reasoningByteSize: 0,
            sessionId: name,
            cavemanDepth: 0,
            toolOwnerMessageId: owner,
        });
    }
    return { messages, tags };
}

/** A copy whose strings are new objects with the same content, as a host reload gives. */
function reloaded(messages: MessageLike[]): MessageLike[] {
    return JSON.parse(JSON.stringify(messages)) as MessageLike[];
}

describe("tail hygiene measurement across two large sessions", () => {
    const restores: Array<() => void> = [];
    afterEach(() => {
        for (const restore of restores.splice(0)) restore();
    });

    it("does not tokenize unchanged tool output again when the sessions alternate", () => {
        const tokenize = spyOn(formatting, "estimateTokens").mockImplementation((text: string) =>
            Math.ceil(text.length / 4),
        );
        restores.push(() => tokenize.mockRestore());
        const sessions = [session("alpha"), session("beta")];
        const callsPerPass: number[] = [];
        for (let pass = 0; pass < 4; pass += 1) {
            for (const [index, current] of sessions.entries()) {
                const name = index === 0 ? "alpha" : "beta";
                // Each pass adds a turn, as an ordinary conversation step does.
                current.messages.push({
                    info: { id: `${name}-turn-${pass}`, role: "user" },
                    parts: [{ type: "text", text: `next step ${pass}` }],
                });
                tokenize.mockClear();
                // No previous baseline: the replay snapshot of whole messages
                // (128 MiB for every session together) holds neither of two
                // sessions this size served in turn, so each pass measures part by
                // part through the content memo, which is what this test bounds.
                refreshTailHygieneBaseline({
                    messages: reloaded(current.messages),
                    tags: current.tags,
                    protectedTagNumbers: new Set(),
                    cacheBusting: false,
                });
                const outputCalls = tokenize.mock.calls.filter(
                    ([text]) => text.length >= OUTPUT_CHARS,
                ).length;
                callsPerPass.push(outputCalls);
            }
        }
        // The first pass of each session measures its outputs; every later pass
        // finds them in the memo.
        expect(callsPerPass.slice(0, 2)).toEqual([ARCS_PER_SESSION, ARCS_PER_SESSION]);
        expect(callsPerPass.slice(2)).toEqual([0, 0, 0, 0, 0, 0]);
    });

    it("reads only the head of each output to recognise a drop sentinel", () => {
        const current = session("gamma");
        const original = String.prototype.toLowerCase;
        let lowercasedChars = 0;
        String.prototype.toLowerCase = function (this: string) {
            lowercasedChars += this.length;
            return original.call(this);
        };
        restores.push(() => {
            String.prototype.toLowerCase = original;
        });
        refreshTailHygieneBaseline({
            messages: reloaded(current.messages),
            tags: current.tags,
            protectedTagNumbers: new Set(),
            cacheBusting: true,
        });
        String.prototype.toLowerCase = original;
        // Twenty 1 MB outputs; whole-text lowercasing would be about 20 million characters.
        expect(lowercasedChars).toBeLessThan(10_000);
    });
});
