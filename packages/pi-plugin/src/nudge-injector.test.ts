import { describe, expect, it } from "bun:test";
import { injectPiNudge } from "./nudge-injector";
import { assistantMessage, textOf, userMessage } from "./test-utils.test";

const nudge = {
	type: "assistant" as const,
	text: '\n\n<instruction name="ctx_reduce">Drop old context.</instruction>',
};

describe("injectPiNudge", () => {
	it("inserts the assistant nudge before the latest user message", () => {
		const messages = [
			userMessage("first", 1),
			assistantMessage("answer", 2),
			userMessage("latest", 3),
		];

		const output = injectPiNudge(messages, nudge);

		expect(output).not.toBe(messages);
		expect(output).toHaveLength(4);
		expect(output[2]?.role).toBe("assistant");
		expect(textOf(output[2])).toBe(nudge.text);
		expect(output[3]).toBe(messages[2]);
	});

	it("is idempotent for the same instruction name", () => {
		const messages = [
			assistantMessage(
				'\n\n<instruction name="ctx_reduce">Prior text.</instruction>',
				1,
			),
			userMessage("latest", 2),
		];

		const output = injectPiNudge(messages, nudge);

		expect(output).toBe(messages);
	});

	it("handles an empty message array by appending a synthetic assistant", () => {
		const output = injectPiNudge([], nudge);

		expect(output).toHaveLength(1);
		expect(output[0]?.role).toBe("assistant");
		expect(textOf(output[0])).toBe(nudge.text);
	});

	it("appends when there is no user role", () => {
		const messages = [assistantMessage("answer", 1)];

		const output = injectPiNudge(messages, nudge);

		expect(output).toHaveLength(2);
		expect(output[0]).toBe(messages[0]);
		expect(textOf(output[1])).toBe(nudge.text);
	});

	it("returns the original array when nudge text is empty", () => {
		const messages = [userMessage("prompt", 1)];

		const output = injectPiNudge(messages, { type: "assistant", text: "" });

		expect(output).toBe(messages);
	});
});
