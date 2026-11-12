import { expect, test } from "bun:test";
import {
	responsesModel,
	signedHistory,
} from "./__tests__/responses-signed-history";
import { applyNativeResponseTagReplayPi } from "./native-replay-tags-pi";
import {
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";
import { createTestDb } from "./test-utils.test";

// The wire defaults to the prepared message's own native items, which is what
// Oh My Pi's warm native replay sends.
function mismatch(
	messages: unknown[],
	input = (messages[0] as ReturnType<typeof signedHistory>).providerPayload
		.items,
) {
	return piPreparedStructureMismatch(
		{ input },
		piPreparedStructure(messages, responsesModel, "omp"),
	);
}

/** An unsigned block after a historical native tag strip was replayed on it. */
function strippedUnsigned(
	sessionId: string,
	db: ReturnType<typeof createTestDb>,
) {
	applyNativeResponseTagReplayPi({
		db,
		sessionId,
		messages: [signedHistory()],
		canApply: true,
	});
	const message = signedHistory();
	message.content[0].text = "Hello";
	Reflect.deleteProperty(message.content[0], "textSignature");
	const messages = [message];
	expect(
		applyNativeResponseTagReplayPi({
			db,
			sessionId,
			messages,
			canApply: false,
		}),
	).toBe(0);
	return messages;
}

test("clean unsigned phased native text is admitted without a persisted strip", () => {
	const message = signedHistory("Hello");
	Reflect.deleteProperty(message.content[0], "textSignature");
	expect(mismatch([message])).toBeUndefined();
});

test("a replayed native tag strip is admitted for an unsigned block, and the unstripped native bytes are refused", () => {
	const db = createTestDb();
	try {
		const messages = strippedUnsigned("serialized-frozen-phase", db);
		expect(messages[0].content[0]).not.toHaveProperty("textSignature");
		expect(messages[0].providerPayload.items[0].content[0].text).toBe("Hello");
		expect(mismatch(messages)).toBeUndefined();
		const restored = JSON.parse(JSON.stringify(messages));
		expect(mismatch(restored)).toBeUndefined();
		// The pass decided the native bytes; a request still carrying the stored
		// "§42§ Hello" was not prepared by it.
		expect(mismatch(messages, signedHistory().providerPayload.items)).toContain(
			"comparison=content",
		);
	} finally {
		db.close();
	}
});

test.each([
	"block body",
	"wire phase",
	"wire text",
	"unowned sibling text",
])("an unsigned block is refused when the %s differs", (kind) => {
	const db = createTestDb();
	try {
		const messages = strippedUnsigned(`phase-proof-${kind}`, db);
		const replay = messages[0];
		let input: unknown[] = replay.providerPayload.items;
		if (kind === "block body") replay.content[0].text = "Different body";
		if (kind === "wire phase" || kind === "wire text") {
			input = structuredClone(input);
			const item = input[0] as (typeof replay.providerPayload.items)[0];
			if (kind === "wire phase") item.phase = "commentary";
			else item.content[0].text = "Different body";
		}
		if (kind === "unowned sibling text") {
			const sibling = signedHistory("Another", "msg_other");
			Reflect.deleteProperty(sibling.content[0], "textSignature");
			sibling.providerPayload.items[0].content[0].text = "Other";
			replay.content.push(sibling.content[0]);
			replay.providerPayload.items.push(sibling.providerPayload.items[0]);
		}
		expect(mismatch(messages, input)).toContain("comparison=content");
	} finally {
		db.close();
	}
});

test.each([
	"same new body on both sides",
	"different item id",
	"different item phase",
	"unowned sibling with matching text",
])("an unsigned block whose native item replays it exactly is admitted: %s", (kind) => {
	const db = createTestDb();
	try {
		const messages = strippedUnsigned(`phase-admit-${kind}`, db);
		const replay = messages[0];
		const native = replay.providerPayload.items[0];
		if (kind === "same new body on both sides") {
			replay.content[0].text = "Different body";
			native.content[0].text = "Different body";
		}
		// An unsigned block names no item id or phase, and the dispatch check
		// compares a replayed message by its text and phase only, so the stored
		// item's own id and phase are what the wire must carry.
		if (kind === "different item id") native.id = "msg_other";
		if (kind === "different item phase") native.phase = "commentary";
		if (kind === "unowned sibling with matching text") {
			const sibling = signedHistory("Another", "msg_other");
			Reflect.deleteProperty(sibling.content[0], "textSignature");
			replay.content.push(sibling.content[0]);
			replay.providerPayload.items.push(sibling.providerPayload.items[0]);
		}
		expect(mismatch(messages)).toBeUndefined();
	} finally {
		db.close();
	}
});
