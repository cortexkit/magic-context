/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    applyFrozenTrailingBlankDecisions,
    findTrailingBlankDecisionCandidates,
} from "./strip-content";
import { stripStructuralNoise } from "./strip-structural-noise";
import type { MessageLike } from "./tag-messages";

function message(id: string, role: string, parts: unknown[]): MessageLike {
    return {
        info: { id, role, sessionID: "ses-1" },
        parts,
    };
}

describe("stripStructuralNoise", () => {
    it("replaces meta, step markers, and cleared reasoning with empty-text sentinels (length preserved)", () => {
        const msg = message("m-1", "assistant", [
            { type: "meta", data: { trace: true } },
            { type: "step-start", snapshot: "abc" },
            { type: "text", text: "visible response" },
            { type: "reasoning", text: "[cleared]" },
            { type: "step-finish", reason: "done" },
        ]);
        const originalLength = msg.parts.length;

        const stripped = stripStructuralNoise([msg]);

        expect(stripped).toBe(4);
        expect(msg.parts).toHaveLength(originalLength);
        expect(msg.parts).toEqual([
            { type: "text", text: "" },
            { type: "text", text: "" },
            { type: "text", text: "visible response" },
            { type: "text", text: "" },
            { type: "text", text: "" },
        ]);
    });

    it("preserves reasoning with live content", () => {
        const msg = message("m-1", "assistant", [
            { type: "reasoning", text: "live reasoning" },
            { type: "text", text: "visible response" },
        ]);

        const stripped = stripStructuralNoise([msg]);

        expect(stripped).toBe(0);
        expect(msg.parts).toHaveLength(2);
        expect(msg.parts).toEqual([
            { type: "reasoning", text: "live reasoning" },
            { type: "text", text: "visible response" },
        ]);
    });

    it("is idempotent — running twice produces the same array and same mutation count on first run only", () => {
        const msg = message("m-1", "assistant", [
            { type: "meta", data: { trace: true } },
            { type: "step-start", snapshot: "abc" },
            { type: "text", text: "visible response" },
            { type: "reasoning", text: "[cleared]" },
            { type: "step-finish", reason: "done" },
        ]);
        const originalLength = msg.parts.length;

        const strippedFirst = stripStructuralNoise([msg]);
        const firstPass = JSON.parse(JSON.stringify(msg.parts));
        const strippedSecond = stripStructuralNoise([msg]);
        const secondPass = JSON.parse(JSON.stringify(msg.parts));

        expect(strippedFirst).toBe(4);
        expect(strippedSecond).toBe(0);
        expect(msg.parts).toHaveLength(originalLength);
        expect(secondPass).toEqual(firstPass);
    });

    it("inherits cache_control onto the sentinel when the original part had one", () => {
        const msg = message("m-1", "assistant", [
            { type: "meta", data: { trace: true }, cache_control: { type: "ephemeral" } },
            { type: "text", text: "visible response" },
        ]);

        const stripped = stripStructuralNoise([msg]);

        expect(stripped).toBe(1);
        expect(msg.parts[0]).toEqual({
            type: "text",
            text: "",
            cache_control: { type: "ephemeral" },
        });
    });

    it("keeps a late step-finish from changing the next defer representation", () => {
        const buildTarget = (includeLateFinish: boolean) =>
            message("m-target", "assistant", [
                { type: "step-start", snapshot: "abc" },
                { type: "reasoning", text: "signed thinking" },
                { type: "tool", callID: "call-1", state: { status: "completed" } },
                ...(includeLateFinish ? [{ type: "step-finish", reason: "tool-calls" }] : []),
            ]);

        const firstTarget = buildTarget(false);
        stripStructuralNoise([firstTarget]);
        const decisions = new Map(findTrailingBlankDecisionCandidates([firstTarget], new Map()));
        expect(decisions).toEqual(new Map([["m-target", "strip"]]));
        applyFrozenTrailingBlankDecisions([firstTarget], "m-target", decisions);
        const firstBytes = JSON.stringify(firstTarget.parts);

        const replayTarget = buildTarget(true);
        const newest = message("m-newest", "assistant", [{ type: "text", text: "next step" }]);
        const replayMessages = [replayTarget, newest];
        stripStructuralNoise(replayMessages);
        expect(applyFrozenTrailingBlankDecisions(replayMessages, "m-newest", decisions)).toBe(1);

        expect(JSON.stringify(replayMessages[0].parts)).toBe(firstBytes);
        expect(replayMessages[0].parts[0]).toEqual({ type: "text", text: "" });
        expect(replayMessages[0].parts.at(-1)).toMatchObject({ type: "tool", callID: "call-1" });
    });

    it("keeps a newest trailing sentinel byte-identical after it becomes historical", () => {
        const buildTarget = () =>
            message("m-target", "assistant", [
                { type: "reasoning", text: "signed thinking" },
                { type: "tool", callID: "call-1", state: { status: "completed" } },
                { type: "step-finish", reason: "tool-calls" },
            ]);

        const firstTarget = buildTarget();
        stripStructuralNoise([firstTarget]);
        const decisions = new Map(findTrailingBlankDecisionCandidates([firstTarget], new Map()));
        expect(decisions).toEqual(new Map([["m-target", "keep"]]));
        applyFrozenTrailingBlankDecisions([firstTarget], "m-target", decisions);
        const firstBytes = JSON.stringify(firstTarget.parts);

        const replayTarget = buildTarget();
        const newest = message("m-newest", "assistant", [{ type: "text", text: "next" }]);
        stripStructuralNoise([replayTarget, newest]);
        applyFrozenTrailingBlankDecisions([replayTarget, newest], "m-newest", decisions);

        expect(JSON.stringify(replayTarget.parts)).toBe(firstBytes);
        expect(replayTarget.parts.at(-1)).toEqual({ type: "text", text: "" });
    });

    it("does not manufacture a missing blank for a frozen keep decision", () => {
        const providerShaped = message("target", "assistant", [
            { type: "reasoning", text: "signed thinking" },
            { type: "tool", callID: "call-1", state: { status: "completed" } },
        ]);
        const before = JSON.stringify(providerShaped.parts);
        const servedMessages = [providerShaped];

        const mutations = applyFrozenTrailingBlankDecisions(
            servedMessages,
            "newest-other",
            new Map([["target", "keep"]]),
        );

        expect(JSON.stringify(servedMessages[0].parts)).toBe(before);
        expect(mutations).toBe(0);

        const emptyAssistant = message("empty", "assistant", []);
        const emptyMessages = [emptyAssistant];
        expect(
            applyFrozenTrailingBlankDecisions(
                emptyMessages,
                "newest-other",
                new Map([["empty", "keep"]]),
            ),
        ).toBe(0);
        expect(emptyMessages[0].parts).toEqual([]);
    });

    it("matches Rust's newest-only trailing-strip exemption", () => {
        const decisions = new Map([["target", "strip"]] as const);
        const newestMessages = [
            message("target", "assistant", [
                { type: "text", text: "answer" },
                { type: "text", text: "" },
            ]),
        ];
        expect(applyFrozenTrailingBlankDecisions(newestMessages, "target", decisions)).toBe(0);
        expect(newestMessages[0].parts).toHaveLength(2);

        const historicalMessages = [
            message("target", "assistant", [
                { type: "text", text: "answer" },
                { type: "text", text: "" },
            ]),
        ];
        expect(applyFrozenTrailingBlankDecisions(historicalMessages, "other", decisions)).toBe(1);
        expect(historicalMessages[0].parts).toEqual([{ type: "text", text: "answer" }]);
    });

    it("retains one trailing blank after terminal reasoning shapes", () => {
        const cases = [
            [
                { type: "thinking", thinking: "signed", signature: "sig" },
                { type: "text", text: "" },
            ],
            [
                { type: "thinking", thinking: "signed", signature: "sig" },
                { type: "redacted_thinking", data: "redacted" },
                { type: "text", text: "\t" },
                { type: "text", text: "" },
            ],
            [
                { type: "thinking", thinking: "signed", signature: "sig" },
                { type: "text", text: "answer" },
                { type: "text", text: "" },
            ],
        ];

        const messages = cases.map((parts, index) =>
            message(`reasoning-${index}`, "assistant", parts),
        );
        const decisions = new Map(
            messages.map((item) => [item.info.id as string, "strip"] as const),
        );
        applyFrozenTrailingBlankDecisions(messages, undefined, decisions);

        expect(messages[0].parts).toHaveLength(2);
        expect(messages[0].parts.at(-1)).toEqual({ type: "text", text: "" });
        expect(messages[1].parts).toHaveLength(3);
        expect(messages[1].parts.at(-1)).toEqual({ type: "text", text: "" });
        expect(messages[2].parts).toEqual([
            { type: "thinking", thinking: "signed", signature: "sig" },
            { type: "text", text: "answer" },
        ]);
    });

    it("canonicalizes wholly blank assistants to one frozen blank", () => {
        const first = message("blank", "assistant", [
            { type: "text", text: " \t" },
            { type: "text", text: "" },
        ]);
        const decisions = new Map(findTrailingBlankDecisionCandidates([first], new Map()));
        expect(decisions).toEqual(new Map([["blank", "keep"]]));
        const firstMessages = [first];
        applyFrozenTrailingBlankDecisions(firstMessages, "blank", decisions);
        expect(firstMessages[0].parts).toEqual([{ type: "text", text: "" }]);

        const replay = message("blank", "assistant", [
            { type: "text", text: "" },
            { type: "text", text: "\n" },
            { type: "text", text: "" },
        ]);
        const replayMessages = [replay];
        applyFrozenTrailingBlankDecisions(replayMessages, "blank", decisions);
        expect(replayMessages[0].parts).toEqual(firstMessages[0].parts);
    });

    it("keeps messages that would otherwise become all-sentinel", () => {
        const msg = message("m-1", "assistant", [
            { type: "meta", data: { trace: true } },
            { type: "step-start", snapshot: "abc" },
        ]);

        const stripped = stripStructuralNoise([msg]);

        // We now replace parts with sentinels regardless — message isn't emptied.
        // Length stays 2 so array position hashing is stable across passes.
        expect(stripped).toBe(2);
        expect(msg.parts).toHaveLength(2);
        expect(msg.parts).toEqual([
            { type: "text", text: "" },
            { type: "text", text: "" },
        ]);
    });
});
