import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	piConversationFields,
	piCursorManagedReceipt,
	piHasManagedSignature,
} from "./pi-dispatch-identity";

const signature = "<session-history>";
const managed = [
	{
		role: "user",
		content: [{ type: "text", text: `${signature}prepared</session-history>` }],
	},
	{ role: "user", content: "older" },
];
const root = [
	{ role: "system", content: "instructions" },
	{
		role: "user",
		content: [{ type: "text", text: `${signature}prepared</session-history>` }],
	},
	{ role: "user", content: [{ type: "text", text: "older" }] },
];
const rootIds = root.map((message) =>
	createHash("sha256").update(JSON.stringify(message), "utf8").digest(),
);

function cursorPayload(activeText = "current prompt", messageId = "random-1") {
	return {
		conversationState: {
			rootPromptMessagesJson: rootIds,
			turns: [],
		},
		action: {
			action: {
				case: "userMessageAction",
				value: {
					userMessage: { text: activeText, messageId },
				},
			},
		},
	};
}

test("issue 880 cursor-agent: managed root blobs are accepted through the receipt", () => {
	const receipt = piCursorManagedReceipt(managed);
	expect(receipt).toHaveLength(1);
	expect(piHasManagedSignature(cursorPayload(), signature, receipt)).toBe(true);
	expect(piHasManagedSignature(cursorPayload(), signature)).toBe(false);
});

test("issue 880 cursor-agent: a missing managed root blob is rejected", () => {
	const receipt = piCursorManagedReceipt(managed);
	const payload = cursorPayload();
	payload.conversationState.rootPromptMessagesJson = [rootIds[0], rootIds[2]];
	expect(piHasManagedSignature(payload, signature, receipt)).toBe(false);
});

test("issue 880 cursor-agent: inline root JSON remains readable", () => {
	const payload = cursorPayload();
	payload.conversationState.rootPromptMessagesJson = root.map((message) =>
		Buffer.from(JSON.stringify(message), "utf8"),
	);
	expect(piHasManagedSignature(payload, signature)).toBe(true);
});

test("issue 880 cursor-agent: action identity ignores Cursor's random message id", () => {
	const fields = piConversationFields(cursorPayload());
	expect(fields).toBeDefined();
	expect(
		piConversationFields(cursorPayload("current prompt", "random-2")),
	).toEqual(fields);
	expect(piConversationFields(cursorPayload("a different turn"))).not.toEqual(
		fields,
	);
});

test("issue 880 cursor-agent: standard message payloads still work", () => {
	const payload = {
		messages: [
			{ role: "user", content: `${signature}managed</session-history>` },
		],
	};
	expect(piHasManagedSignature(payload, signature)).toBe(true);
	expect(piConversationFields(payload)).toBeDefined();
});
