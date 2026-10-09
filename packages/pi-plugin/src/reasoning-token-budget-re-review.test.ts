import { expect, it } from "bun:test";
import { piReasoningClearCutoff } from "./reasoning-replay-pi";

it("re-review: Pi charges positive reported reasoning even when its ordinary summary is empty", () => {
	const messages = [0, 1, 2].map((index) => ({
		id: `a${index}`,
		role: "assistant",
		usage: { reasoning: 100 },
		content: [
			{ type: "thinking", thinking: "" },
			{ type: "text", text: "answer" },
		],
	}));
	expect(
		piReasoningClearCutoff({
			messages,
			messageIdToMaxTag: new Map(
				messages.map((message, index) => [message.id, index + 2]),
			),
			piMessageStableId: (message) => (message as { id: string }).id,
			keepReasoningTokens: 200,
			prefixBound: false,
		}),
	).toBe(2);
});
