import { describe, expect, it } from "bun:test";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import {
	clearOldReasoningPi,
	piReasoningClearCutoff,
} from "./reasoning-replay-pi";

function messages(texts: string[], reported = 100) {
	return texts.map((thinking, index) => ({
		id: `a${index}`,
		role: "assistant",
		usage: { reasoning: reported },
		content: [
			{ type: "thinking", thinking, thinkingSignature: `sig-${index}` },
			{ type: "text", text: "answer" },
		],
	}));
}

const stableId = (message: unknown) => (message as { id: string }).id;

describe("Pi reasoning budget adversarial review", () => {
	it("review: issue 630 leaves all thinking in the active Anthropic turn unchanged in Pi", () => {
		const steps = messages(["one", "two", "three"]).map((step, index) => ({
			...step,
			content: [
				...step.content,
				{ type: "toolCall", id: `call-${index}`, name: "read", arguments: {} },
			],
		}));
		const history = [
			{ id: "u", role: "user", content: [{ type: "text", text: "work" }] },
			...steps.flatMap((step, index) => [
				step,
				{
					id: `result-${index}`,
					role: "toolResult",
					toolCallId: `call-${index}`,
					toolName: "read",
					content: [{ type: "text", text: "result" }],
				},
			]),
		];
		const messageIdToMaxTag = new Map(
			history.map((message, index) => [message.id, index + 1]),
		);
		const maxCutoff = piReasoningClearCutoff({
			messages: history,
			messageIdToMaxTag,
			keepReasoningTokens: 0,
			piMessageStableId: stableId,
			prefixBound: true,
		});
		const before = JSON.stringify(steps);
		clearOldReasoningPi({
			messages: history,
			messageIdToMaxTag,
			piMessageStableId: stableId,
			maxCutoff,
		});
		expect(JSON.stringify(steps)).toBe(before);
	});

	it("review control: Pi charges each step's own plaintext once", () => {
		const texts = [
			"large old thought ".repeat(100),
			"short thought",
			"new thought",
		];
		const history = messages(texts, 0);
		expect(
			piReasoningClearCutoff({
				messages: history,
				messageIdToMaxTag: new Map(
					history.map((message, index) => [message.id, index + 1]),
				),
				keepReasoningTokens: texts.reduce(
					(total, text) => total + estimateTokens(text),
					0,
				),
				piMessageStableId: stableId,
				prefixBound: false,
			}),
		).toBe(0);
	});
});
