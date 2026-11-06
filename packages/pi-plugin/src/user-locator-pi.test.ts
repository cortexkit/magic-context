import { expect, it } from "bun:test";
import { __test } from "./context-handler";
import { convertEntriesToRawMessages } from "./read-session-pi";

const entry = (id: string, message: unknown) => ({
	type: "message",
	id,
	message,
});

it.each([
	0, 100,
])("locates user ordinals across tool-result checkpoints with offset %i", (offset) => {
	for (const protocol of [[], [entry("checkpoint", { role: "system" })]]) {
		const entries = [
			entry("call", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }],
			}),
			entry("result", {
				role: "toolResult",
				toolCallId: "tc1",
				content: [{ type: "text", text: "original output" }],
			}),
			...protocol,
			entry("reply", {
				role: "assistant",
				content: [{ type: "text", text: "Done" }],
			}),
			entry("user", { role: "user", content: "Continue" }),
		];
		const canonical = convertEntriesToRawMessages(entries, offset).find(
			(message) => message.id === "user",
		);
		expect(canonical?.ordinal).toBe(offset + 4 + protocol.length);
		expect(__test.convertLocatedPiUserEntry(entries, "user", offset)).toEqual(
			canonical,
		);
	}
});

it("keeps pending results across protocol rows until a real user consumes them", () => {
	const entries = [
		entry("result", {
			role: "toolResult",
			toolCallId: "tc1",
			content: [{ type: "text", text: "output" }],
		}),
		entry("checkpoint", { role: "system" }),
		entry("user", { role: "user", content: "Continue" }),
	];
	expect(__test.convertLocatedPiUserEntry(entries, "user")).toEqual(
		convertEntriesToRawMessages(entries).find(
			(message) => message.id === "user",
		),
	);
});
