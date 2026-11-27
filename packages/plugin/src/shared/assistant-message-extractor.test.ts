import { describe, expect, test } from "bun:test";
import {
    describeAssistantSettlement,
    extractLatestAssistantText,
    hasLengthCappedOutput,
    isLatestAssistantLengthCapped,
} from "./assistant-message-extractor";

test("reasoning-only and tool-only turns stay out of manifest text and retain finish diagnostics", () => {
    for (const [type, finish] of [
        ["reasoning", "stop"],
        ["tool", "tool-calls"],
    ]) {
        const messages = [
            {
                info: { role: "assistant", finish },
                parts: [{ type, text: "private or tool data" }],
            },
        ];
        expect(extractLatestAssistantText(messages)).toBeNull();
        expect(describeAssistantSettlement(messages)).toContain(`finish=${finish}`);
    }
    expect(
        describeAssistantSettlement({
            tokenLog: { finish_reason: "length" },
            reasoning: "private",
        }),
    ).toBe("finish=length, reasoning=true");
});

describe("hasLengthCappedOutput", () => {
    test("detects OpenCode assistant info.finish", () => {
        expect(hasLengthCappedOutput([{ info: { role: "assistant", finish: "length" } }])).toBe(
            true,
        );
    });

    test("detects OpenCode step-finish reason", () => {
        expect(
            hasLengthCappedOutput([{ parts: [{ type: "step-finish", reason: "length" }] }]),
        ).toBe(true);
        expect(hasLengthCappedOutput({ type: "text", reason: "length" })).toBe(false);
    });

    test("detects Pi stopReason length", () => {
        expect(hasLengthCappedOutput({ role: "assistant", stopReason: "length" })).toBe(true);
    });
});

test("only the latest assistant's settlement counts on a reused child", () => {
    const capped = {
        info: { role: "assistant", time: { created: 1 }, finish: "length" },
        parts: [],
    };
    const stopped = {
        info: { role: "assistant", time: { created: 2 }, finish: "stop" },
        parts: [{ type: "tool", state: { input: { finish: "length" } } }],
    };
    expect(isLatestAssistantLengthCapped([capped, stopped])).toBe(false);
    expect(isLatestAssistantLengthCapped([capped])).toBe(true);
    expect(
        isLatestAssistantLengthCapped([
            {
                ...stopped,
                parts: [{ type: "step-finish", reason: "max_tokens" }],
            },
        ]),
    ).toBe(true);
});
