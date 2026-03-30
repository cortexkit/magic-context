/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    appendNudgeToAssistant,
    appendSupplementalNudgeToAssistant,
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
});
