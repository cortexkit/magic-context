import { expect, test } from "bun:test";
import {
	readSessionChunk,
	withRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import fixture from "../../../crates/mc-module/testdata/historian-tool-expansions.json";
import { convertEntriesToRawMessages } from "./read-session-pi";

test("Pi historian preserves long room posts and message-id replies through native tool entries", () => {
	const body =
		fixture.longMessage.sentence.repeat(fixture.longMessage.count) +
		fixture.longMessage.tail;
	const entries = [
		{
			type: "message",
			id: "a",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "r",
						name: "room",
						arguments: { action: "post", room_id: "rm_review", text: body },
					},
					{
						type: "toolCall",
						id: "p",
						name: "peer_send",
						arguments: { reply_to_pmid: "pm_42", message: body },
					},
					{ type: "text", text: "Tail text." },
				],
			},
		},
		{
			type: "message",
			id: "r-result",
			message: {
				role: "toolResult",
				toolCallId: "r",
				toolName: "room",
				content: [{ type: "text", text: "Room title…" }],
			},
		},
		{
			type: "message",
			id: "p-result",
			message: {
				role: "toolResult",
				toolCallId: "p",
				toolName: "peer_send",
				content: [{ type: "text", text: "PM title…" }],
			},
		},
	];
	const original = JSON.stringify(entries);
	const messages = convertEntriesToRawMessages(entries);
	const chunk = withRawMessageProvider(
		"pi-whole-post",
		{ readMessages: () => messages, getMessageCount: () => messages.length },
		() => readSessionChunk("pi-whole-post", 10_000),
	);
	expect(chunk.text).toBe(
		`[1] A: TC: Room post rm_review: ${body} / TC: PM reply to pm_42: ${body} / Tail text.`,
	);
	expect(JSON.stringify(entries)).toBe(original);
});
