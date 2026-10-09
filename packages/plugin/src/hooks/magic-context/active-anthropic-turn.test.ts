import { expect, it } from "bun:test";
import { isInActiveAnthropicTurn } from "./active-anthropic-turn";

it("the Anthropic budget boundary ignores synthesized context and tool-result user carriers", () => {
    const history = [
        { role: "user", content: [{ type: "text", text: "real request" }] },
        { role: "assistant" },
        { role: "user", content: [{ type: "tool_result" }] },
        { role: "user", synthetic: true, content: [{ type: "text", text: "context" }] },
        { role: "assistant" },
    ];
    expect(isInActiveAnthropicTurn(history, 1, true)).toBe(true);
    expect(isInActiveAnthropicTurn(history, 4, true)).toBe(true);
    expect(isInActiveAnthropicTurn(history, 4, false)).toBe(false);
    history.push({ role: "user", content: [{ type: "text", text: "next real request" }] });
    expect(isInActiveAnthropicTurn(history, 4, true)).toBe(false);
    expect(isInActiveAnthropicTurn([{ role: "assistant" }], 0, true)).toBe(false);
});
