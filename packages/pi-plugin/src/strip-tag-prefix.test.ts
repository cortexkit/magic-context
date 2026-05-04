import { describe, expect, it } from "bun:test";
import { stripTagPrefixFromAssistantMessage } from "./strip-tag-prefix";

describe("stripTagPrefixFromAssistantMessage", () => {
	it("strips a single §N§ prefix from assistant text", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "text", text: "§4§ Yes. I can see the magic context." },
			],
		};
		const mutated = stripTagPrefixFromAssistantMessage(msg);
		expect(mutated).toBe(true);
		expect((msg.content[0] as { text: string }).text).toBe(
			"Yes. I can see the magic context.",
		);
	});

	it("strips consecutive §N§ prefixes (model-mimicked sequence)", () => {
		const msg = {
			role: "assistant",
			content: [{ type: "text", text: "§3§ §4§ §5§ Hello world" }],
		};
		expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
		expect((msg.content[0] as { type: string; text: string }).text).toBe(
			"Hello world",
		);
	});

	it("preserves embedded §N§ references inside the response", () => {
		const msg = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Looking at §5§ which references the earlier discussion",
				},
			],
		};
		expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
		expect((msg.content[0] as { type: string; text: string }).text).toBe(
			"Looking at §5§ which references the earlier discussion",
		);
	});

	it("does NOT strip prefix on user messages", () => {
		const msg = {
			role: "user",
			content: [{ type: "text", text: "§4§ Hello from user" }],
		};
		expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
		// Content unchanged
		expect((msg.content[0] as { type: string; text: string }).text).toBe(
			"§4§ Hello from user",
		);
	});

	it("does NOT strip prefix on tool result messages", () => {
		const msg = {
			role: "toolResult",
			content: [{ type: "text", text: "§7§ tool output" }],
		};
		expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
	});

	it("strips across multiple text parts in a single message", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "text", text: "§4§ First chunk" },
				{ type: "text", text: "§4§ Second chunk" },
			],
		};
		expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
		expect((msg.content[0] as { type: string; text: string }).text).toBe(
			"First chunk",
		);
		expect((msg.content[1] as { type: string; text: string }).text).toBe(
			"Second chunk",
		);
	});

	it("ignores non-text parts (thinking, toolCall, image)", () => {
		const msg = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "§4§ pretend reasoning, not stripped",
				},
				{ type: "text", text: "§4§ Real assistant text" },
				{
					type: "toolCall",
					id: "t1",
					name: "ctx_search",
					arguments: {},
				},
			],
		};
		expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
		// Text part stripped
		expect((msg.content[1] as { type: string; text: string }).text).toBe(
			"Real assistant text",
		);
		// Thinking part untouched (only text parts are scrubbed)
		expect(
			(msg.content[0] as { type: string; thinking: string }).thinking,
		).toBe("§4§ pretend reasoning, not stripped");
	});

	it("returns false when no text parts have prefixes", () => {
		const msg = {
			role: "assistant",
			content: [{ type: "text", text: "Plain response without any prefix" }],
		};
		expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
	});

	it("handles empty content array gracefully", () => {
		const msg = { role: "assistant", content: [] };
		expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
	});

	it("handles non-array content gracefully", () => {
		// Pi user messages can have content: string (legacy shape)
		const msg = { role: "assistant", content: "§4§ legacy string" };
		expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
		// String content unchanged (we don't touch legacy string-shape on assistants)
		expect(msg.content).toBe("§4§ legacy string");
	});

	it("strips trailing whitespace after the prefix", () => {
		const msg = {
			role: "assistant",
			content: [{ type: "text", text: "§4§   \n\nYes" }],
		};
		expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
		expect((msg.content[0] as { type: string; text: string }).text).toBe("Yes");
	});

	it("strips multi-digit tag IDs", () => {
		const msg = {
			role: "assistant",
			content: [{ type: "text", text: "§38773§ Found it." }],
		};
		expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
		expect((msg.content[0] as { type: string; text: string }).text).toBe(
			"Found it.",
		);
	});
});
