import { expect, test } from "bun:test";
import {
	responsesModel,
	signedHistory,
} from "./__tests__/responses-signed-history";
import { PI_NATIVE_TAG_STRIP_PROVENANCE } from "./native-replay-tag-provenance-pi";
import { applyNativeResponseTagReplayPi } from "./native-replay-tags-pi";
import {
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";
import { createTestDb } from "./test-utils.test";

function mismatch(messages: unknown[]) {
	const items = (messages[0] as ReturnType<typeof signedHistory>)
		.providerPayload.items;
	return piPreparedStructureMismatch(
		{ input: items },
		piPreparedStructure(messages, responsesModel, "omp"),
	);
}

test("clean unsigned phased native text still refuses without a persisted strip", () => {
	const message = signedHistory("Hello");
	Reflect.deleteProperty(message.content[0], "textSignature");
	expect(mismatch([message])).toContain("comparison=content");
});

test("frozen strip evidence survives prepared-message serialization without restoring typed signatures", () => {
	const db = createTestDb();
	const sessionId = "serialized-frozen-phase";
	try {
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
		expect(messages[0].content[0]).not.toHaveProperty("textSignature");
		expect(mismatch(messages)).toBeUndefined();
		const restored = JSON.parse(JSON.stringify(messages));
		expect(mismatch(restored)).toBeUndefined();
		delete restored[0][PI_NATIVE_TAG_STRIP_PROVENANCE];
		expect(mismatch(restored)).toContain("comparison=content");
	} finally {
		db.close();
	}
});

test.each([
	"body",
	"id",
	"phase",
	"unowned sibling",
])("frozen unsigned phase evidence does not authorize a different %s", (kind) => {
	const db = createTestDb();
	const sessionId = `phase-proof-${kind}`;
	try {
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
		applyNativeResponseTagReplayPi({
			db,
			sessionId,
			messages,
			canApply: false,
		});
		const replay = messages[0];
		const native = replay.providerPayload.items[0];
		if (kind === "body") {
			replay.content[0].text = "Different body";
			native.content[0].text = "Different body";
		}
		if (kind === "id") native.id = "msg_other";
		if (kind === "phase") native.phase = "commentary";
		if (kind === "unowned sibling") {
			const sibling = signedHistory("Another", "msg_other");
			Reflect.deleteProperty(sibling.content[0], "textSignature");
			replay.content.push(sibling.content[0]);
			replay.providerPayload.items.push(sibling.providerPayload.items[0]);
		}
		expect(mismatch(messages)).toContain("comparison=content");
	} finally {
		db.close();
	}
});
