/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    appendNudgeToAssistant,
    appendSupplementalNudgeToAssistant,
    canAppendSupplementalNudgeToAssistant,
    reinjectNudgeAtAnchor,
} from "./nudge-injection";
import { createNudgePlacementStore } from "./nudge-placement-store";

describe("nudge-injection", () => {
    it("replaces managed context nudges instead of stacking them", () => {
        const nudgePlacements = createNudgePlacementStore();
        const messages = [
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [
                    {
                        type: "text",
                        text: [
                            "assistant response",
                            "",
                            '<instruction name="context_warning">old warning</instruction>',
                            "",
                            '<instruction name="context_critical">stale critical</instruction>',
                        ].join("\n"),
                    },
                ],
            },
        ];

        appendNudgeToAssistant(
            messages,
            '\n\n<instruction name="context_iteration">fresh iteration</instruction>',
            nudgePlacements,
            "ses-1",
        );

        const text = (messages[0].parts[0] as { text: string }).text;
        expect(text).toContain("assistant response");
        expect(text).toContain("fresh iteration");
        expect(text).not.toContain("old warning");
        expect(text).not.toContain("stale critical");
        expect(text.match(/<instruction name="context_/g)?.length).toBe(1);
    });

    it("reinjects anchored nudges without keeping stale trailing context instructions", () => {
        const nudgePlacements = createNudgePlacementStore();
        nudgePlacements.set("ses-1", "m-assistant", "mismatched cached nudge");
        const messages = [
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [
                    {
                        type: "text",
                        text: [
                            "assistant response",
                            "",
                            '<instruction name="context_warning">old warning</instruction>',
                        ].join("\n"),
                    },
                ],
            },
        ];

        const reinjected = reinjectNudgeAtAnchor(
            messages,
            '\n\n<instruction name="context_warning">fresh warning</instruction>',
            nudgePlacements,
            "ses-1",
        );

        expect(reinjected).toBe(true);
        const text = (messages[0].parts[0] as { text: string }).text;
        expect(text).toContain("fresh warning");
        expect(text).not.toContain("old warning");
        expect(text.match(/<instruction name="context_/g)?.length).toBe(1);
    });

    it("clears persisted anchor when the anchored assistant message is already cleared", () => {
        const nudgePlacements = createNudgePlacementStore();
        nudgePlacements.set("ses-1", "m-assistant", "cached nudge");
        const messages = [
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "text", text: "[cleared]" }],
            },
        ];

        const reinjected = reinjectNudgeAtAnchor(
            messages,
            '\n\n<instruction name="context_warning">fresh warning</instruction>',
            nudgePlacements,
            "ses-1",
        );

        expect(reinjected).toBe(false);
        expect(nudgePlacements.get("ses-1")).toBeNull();
    });

    it("clears persisted anchor when the anchored assistant message contains tool protocol parts", () => {
        const nudgePlacements = createNudgePlacementStore();
        nudgePlacements.set("ses-1", "m-assistant", "cached nudge");
        const messages = [
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [
                    { type: "tool", toolCallId: "call-1" },
                    { type: "text", text: "assistant response" },
                ],
            },
        ];

        const reinjected = reinjectNudgeAtAnchor(
            messages,
            '\n\n<instruction name="context_warning">fresh warning</instruction>',
            nudgePlacements,
            "ses-1",
        );

        expect(reinjected).toBe(false);
        expect(nudgePlacements.get("ses-1")).toBeNull();
    });

    it("appends deferred note nudges to the existing anchored assistant message", () => {
        const nudgePlacements = createNudgePlacementStore();
        const messages = [
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [
                    {
                        type: "text",
                        text: [
                            "assistant response",
                            "",
                            '<instruction name="context_warning">warning</instruction>',
                        ].join("\n"),
                    },
                ],
            },
        ];

        appendNudgeToAssistant(
            messages,
            '\n\n<instruction name="context_warning">warning</instruction>',
            nudgePlacements,
            "ses-1",
        );

        const appended = appendSupplementalNudgeToAssistant(
            messages,
            '\n\n<instruction name="deferred_notes">deferred</instruction>',
            nudgePlacements,
            "ses-1",
        );

        expect(appended).toBe(true);
        const text = (messages[0].parts[0] as { text: string }).text;
        expect(text).toContain("warning");
        expect(text).toContain("deferred");
        expect(text.match(/<instruction name="(?:context_|deferred_notes)/g)?.length).toBe(2);
    });

    // Thinking-bearing message protection
    //
    // When an Anthropic assistant message contains signed thinking/reasoning
    // blocks, any mutation to its content invalidates the signature and
    // Anthropic rejects the request with:
    //   "thinking or redacted_thinking blocks in the latest assistant message
    //    cannot be modified"
    // The nudge injection paths must detect these messages and refuse to
    // mutate them — clearing any stale anchor in the process.

    for (const thinkingType of ["thinking", "reasoning", "redacted_thinking"] as const) {
        it(`refuses to reinject nudge into anchor message with ${thinkingType} parts and clears the anchor`, () => {
            const nudgePlacements = createNudgePlacementStore();
            nudgePlacements.set("ses-1", "m-assistant", "prior nudge");
            const originalText = "prior assistant text";
            const messages = [
                {
                    info: { id: "m-assistant", role: "assistant" },
                    parts: [
                        { type: thinkingType, text: "signed-thinking-content" },
                        { type: "text", text: originalText },
                    ],
                },
            ];

            const reinjected = reinjectNudgeAtAnchor(
                messages,
                '\n\n<instruction name="context_warning">fresh</instruction>',
                nudgePlacements,
                "ses-1",
            );

            expect(reinjected).toBe(false);
            expect(nudgePlacements.get("ses-1")).toBeNull();
            // The text part of the thinking-bearing message MUST remain byte-
            // identical to what Anthropic signed.
            const textPart = messages[0].parts.find(
                (part): part is { type: string; text: string } =>
                    (part as { type: string }).type === "text",
            );
            expect(textPart?.text).toBe(originalText);
        });

        it(`appendNudgeToAssistant skips assistants with ${thinkingType} parts`, () => {
            const nudgePlacements = createNudgePlacementStore();
            const thinkingMessageOriginalText = "latest assistant with thinking";
            const messages = [
                {
                    info: { id: "m-older", role: "assistant" },
                    parts: [{ type: "text", text: "older text-only assistant" }],
                },
                {
                    info: { id: "m-latest", role: "assistant" },
                    parts: [
                        { type: thinkingType, text: "signed-thinking" },
                        { type: "text", text: thinkingMessageOriginalText },
                    ],
                },
            ];

            appendNudgeToAssistant(
                messages,
                '\n\n<instruction name="context_iteration">nudge</instruction>',
                nudgePlacements,
                "ses-1",
            );

            // Nudge must NOT be appended to the latest (thinking-bearing) message.
            const latestText = (
                messages[1].parts.find(
                    (part): part is { type: string; text: string } =>
                        (part as { type: string }).type === "text",
                ) ?? { text: "" }
            ).text;
            expect(latestText).toBe(thinkingMessageOriginalText);

            // Nudge should fall back to the older text-only assistant, which
            // is the next suitable anchor.
            const olderText = (messages[0].parts[0] as { text: string }).text;
            expect(olderText).toContain("older text-only assistant");
            expect(olderText).toContain("nudge");

            const placement = nudgePlacements.get("ses-1");
            expect(placement?.messageId).toBe("m-older");
        });

        it(`appendSupplementalNudgeToAssistant refuses when anchor has ${thinkingType} parts`, () => {
            const nudgePlacements = createNudgePlacementStore();
            nudgePlacements.set("ses-1", "m-assistant", "prior nudge");
            const originalText = "prior assistant text";
            const messages = [
                {
                    info: { id: "m-assistant", role: "assistant" },
                    parts: [
                        { type: thinkingType, text: "signed-thinking" },
                        { type: "text", text: originalText },
                    ],
                },
            ];

            const appended = appendSupplementalNudgeToAssistant(
                messages,
                '\n\n<instruction name="deferred_notes">note</instruction>',
                nudgePlacements,
                "ses-1",
            );

            expect(appended).toBe(false);
            const textPart = messages[0].parts.find(
                (part): part is { type: string; text: string } =>
                    (part as { type: string }).type === "text",
            );
            expect(textPart?.text).toBe(originalText);
        });

        it(`canAppendSupplementalNudgeToAssistant returns false when anchor has ${thinkingType} parts`, () => {
            const nudgePlacements = createNudgePlacementStore();
            nudgePlacements.set("ses-1", "m-assistant", "prior nudge");
            const messages = [
                {
                    info: { id: "m-assistant", role: "assistant" },
                    parts: [
                        { type: thinkingType, text: "signed-thinking" },
                        { type: "text", text: "prior text" },
                    ],
                },
            ];

            expect(canAppendSupplementalNudgeToAssistant(messages, nudgePlacements, "ses-1")).toBe(
                false,
            );
        });
    }

    it("appendNudgeToAssistant logs failure when ALL assistants carry thinking parts", () => {
        const nudgePlacements = createNudgePlacementStore();
        const originalText1 = "first signed assistant";
        const originalText2 = "second signed assistant";
        const messages = [
            {
                info: { id: "m-1", role: "assistant" },
                parts: [
                    { type: "thinking", text: "signed-1" },
                    { type: "text", text: originalText1 },
                ],
            },
            {
                info: { id: "m-2", role: "assistant" },
                parts: [
                    { type: "reasoning", text: "signed-2" },
                    { type: "text", text: originalText2 },
                ],
            },
        ];

        appendNudgeToAssistant(
            messages,
            '\n\n<instruction name="context_iteration">unused</instruction>',
            nudgePlacements,
            "ses-1",
        );

        // No anchor should have been placed, and every text part must be
        // byte-identical to what Anthropic previously signed.
        expect(nudgePlacements.get("ses-1")).toBeNull();
        expect(
            (
                messages[0].parts.find(
                    (part): part is { type: string; text: string } =>
                        (part as { type: string }).type === "text",
                ) ?? { text: "" }
            ).text,
        ).toBe(originalText1);
        expect(
            (
                messages[1].parts.find(
                    (part): part is { type: string; text: string } =>
                        (part as { type: string }).type === "text",
                ) ?? { text: "" }
            ).text,
        ).toBe(originalText2);
    });
});
