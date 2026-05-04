import { describe, expect, it } from "bun:test";
import {
	assistantMessage,
	assistantToolCall,
	textOf,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

describe("createPiTranscript", () => {
	it("round-trips Pi messages through transcript mutation and commit", () => {
		const messages = [userMessage("hello", 10), assistantMessage("world", 11)];
		const transcript = createPiTranscript(messages, "ses-transcript");

		expect(transcript.messages[0]?.parts[0]?.setText("hello tagged")).toBe(
			true,
		);
		transcript.commit();
		const output = transcript.getOutputMessages();

		// commit() now syncs mutations from `working` back into source so
		// downstream callers (e.g. `<session-history>` injection) can splice
		// or unshift on the same array Pi sent us. Output is therefore the
		// SAME reference as the source input, with mutations applied in
		// place at the dirty indices.
		expect(output).toBe(messages);
		expect(textOf(output[0] as never)).toBe("hello tagged");
		expect(textOf(output[1] as never)).toBe("world");
	});

	it("preserves source identity when there are no mutations", () => {
		const messages = [
			userMessage("unchanged", 10),
			assistantMessage("same", 11),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");

		transcript.commit();

		expect(transcript.getOutputMessages()).toBe(messages);
	});

	it("injects tag prefixes into user, assistant, and folded tool-result text", () => {
		const messages = [
			userMessage("user text", 10),
			assistantMessage("assistant text", 11),
			toolResultMessage("call-1", "tool output", 12),
			userMessage("after tool", 13),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");

		for (const msg of transcript.messages) {
			for (const part of msg.parts) {
				const current = part.getText();
				if (current) part.setText(`§99§ ${current}`);
			}
		}
		transcript.commit();
		const output = transcript.getOutputMessages();

		expect(textOf(output[0] as never)).toBe("§99§ user text");
		expect(textOf(output[1] as never)).toBe("§99§ assistant text");
		expect(textOf(output[2] as never)).toBe("§99§ tool output");
		expect(textOf(output[3] as never)).toBe("§99§ after tool");
	});

	it("supports tag-prefix removal via part text mutation", () => {
		const messages = [
			userMessage("§1§ keep me", 10),
			assistantMessage("§2§ keep assistant", 11),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");

		for (const msg of transcript.messages) {
			for (const part of msg.parts) {
				part.setText((part.getText() ?? "").replace(/§\d+§\s*/g, ""));
			}
		}
		transcript.commit();
		const output = transcript.getOutputMessages();

		expect(textOf(output[0] as never)).toBe("keep me");
		expect(textOf(output[1] as never)).toBe("keep assistant");
	});

	it("preserves mixed user content shape for string and array messages", () => {
		const messages = [
			userMessage("string user", 10),
			userMessage(
				[
					{ type: "text", text: "array text" },
					{ type: "image", data: "abc", mimeType: "image/png" },
				],
				11,
			),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");

		transcript.messages[0]?.parts[0]?.setText("changed string");
		transcript.messages[1]?.parts[0]?.setText("changed array");
		transcript.commit();
		const output = transcript.getOutputMessages() as typeof messages;

		expect(typeof (output[0] as { content: unknown }).content).toBe("string");
		expect(Array.isArray((output[1] as { content: unknown }).content)).toBe(
			true,
		);
		expect(textOf(output[0] as never)).toBe("changed string");
		expect(textOf(output[1] as never)).toBe("changed array");
	});

	it("folds Pi toolResult messages into the following user transcript message", () => {
		const messages = [
			assistantToolCall("call-1", "Read", { path: "x" }),
			toolResultMessage("call-1", "file contents"),
			userMessage("continue", 13),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");

		expect(transcript.messages).toHaveLength(2);
		expect(transcript.messages[1]?.info.role).toBe("user");
		expect(transcript.messages[1]?.parts.map((part) => part.kind)).toEqual([
			"tool_result",
			"text",
		]);
	});
});
