/// <reference types="bun-types" />

/**
 * Per-pass walkers of the transform input must not walk tool metadata the
 * provider never receives (edit/write workspace diagnostics are hundreds of MiB
 * in long coding sessions), and a change to it must not read as a change.
 */

import { describe, expect, it } from "bun:test";
import type { TagEntry } from "../../features/magic-context/types";
import { lkgContentDigest } from "./lkg-slot";
import { buildTrueRawTokenIndex } from "./read-session-true-raw-tokens";
import { refreshTailHygieneBaseline, tailHygieneStructuralSignature } from "./tail-hygiene-walk";
import type { MessageLike } from "./transform-operations";
import { firstServedDivergenceIndex } from "./transform-postprocess-phase";

/** A tool part whose metadata counts every read of its contents. */
function watchedSession(counter: { reads: number }, label = "a"): MessageLike[] {
    const metadata: Record<string, unknown> = {};
    Object.defineProperty(metadata, "diagnostics", {
        enumerable: true,
        get: () => {
            counter.reads += 1;
            return { "/repo/a.ts": [{ message: `diagnostic ${label}` }] };
        },
    });
    return [
        {
            info: { id: "u1", role: "user", time: { created: 1 } } as never,
            parts: [{ type: "text", text: "edit a.ts" }],
        },
        {
            info: { id: "a1", role: "assistant", time: { created: 2 }, finish: "stop" } as never,
            parts: [
                {
                    type: "tool",
                    callID: "call-1",
                    tool: "edit",
                    state: {
                        status: "completed",
                        input: { filePath: "/repo/a.ts" },
                        output: "Edit applied successfully.",
                        title: "a.ts",
                        time: { start: 3, end: 4 },
                        metadata,
                    },
                },
            ],
        },
    ];
}

const TAGS: TagEntry[] = [
    {
        tagNumber: 1,
        messageId: "call-1",
        type: "tool",
        status: "active",
        dropMode: "full",
        toolName: "edit",
        inputByteSize: 0,
        byteSize: 26,
        reasoningByteSize: 0,
        sessionId: "s",
        cavemanDepth: 0,
        toolOwnerMessageId: "a1",
    },
];

describe("walkers of provider-invisible tool metadata", () => {
    it("never read tool metadata", () => {
        const counter = { reads: 0 };
        const messages = watchedSession(counter);
        lkgContentDigest(messages[1] as MessageLike);
        tailHygieneStructuralSignature(messages);
        const first = refreshTailHygieneBaseline({
            messages,
            tags: TAGS,
            protectedTagNumbers: new Set(),
            cacheBusting: true,
        });
        refreshTailHygieneBaseline({
            messages,
            tags: TAGS,
            protectedTagNumbers: new Set(),
            cacheBusting: false,
            previous: first,
        });
        buildTrueRawTokenIndex(
            "s",
            messages.map((message, index) => ({
                ordinal: index + 1,
                id: message.info.id as string,
                role: message.info.role as string,
                parts: message.parts,
            })) as never,
            { cacheNamespace: "walkers-test", providerShapeVersion: "opencode-v1" } as never,
        );
        expect(firstServedDivergenceIndex(messages, watchedSession(counter, "b"))).toBeNull();
        expect(counter.reads).toBe(0);
    });

    it("treat a tool-metadata-only change as no change", () => {
        const counter = { reads: 0 };
        const before = watchedSession(counter, "before");
        const after = watchedSession(counter, "after");
        expect(lkgContentDigest(after[1] as MessageLike)).toBe(
            lkgContentDigest(before[1] as MessageLike),
        );
        expect(tailHygieneStructuralSignature(after)).toEqual(
            tailHygieneStructuralSignature(before),
        );
        expect(firstServedDivergenceIndex(after, before)).toBeNull();
        // A provider-visible change still differs.
        const output = structuredClone(before.map((m) => ({ ...m, parts: [] })));
        expect(firstServedDivergenceIndex(output, before)).toBe(0);
    });
});
