import { expect, test } from "bun:test";
import { join } from "node:path";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import {
	readReplayEnvelope,
	updateReplayDocument,
} from "@magic-context/core/features/magic-context/storage-replay-document";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
	readSessionMetaCollection,
	writeSessionMetaCollection,
} from "../../plugin/src/features/magic-context/storage-session-collections";
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

test("native tag strips first apply only on a rebuild and replay after reopening the database", () => {
	const { dir, cleanup } = createTestTempDir("mc-pi-test-", "native-tags");
	const path = join(dir, "context.db");
	let db = createTestDb(path);
	const sessionId = "signed-tag-freeze";
	const raw = signedHistory();
	const prepared = () => {
		const message = structuredClone(raw);
		message.content[0].text = "§2§ Hello";
		return [message];
	};
	const apply = (canApply: boolean) => {
		const messages = prepared();
		const added = applyNativeResponseTagReplayPi({
			db,
			sessionId,
			messages,
			canApply,
		});
		return { messages, added };
	};
	try {
		updateReplayDocument(db, sessionId, (doc) => {
			doc.version = 2;
			doc.piNative = { toolInputs: { call: "{}" }, reasoningIds: ["old"] };
			return true;
		});
		const before = readReplayEnvelope(db, sessionId);
		expect(apply(false)).toEqual({ messages: prepared(), added: 0 });
		expect(readReplayEnvelope(db, sessionId)).toEqual(before);
		const first = apply(true);
		expect(first.added).toBe(1);
		expect(first.messages[0].providerPayload.items[0].content[0].text).toBe(
			"Hello",
		);
		expect(first.messages[0].content).toEqual(prepared()[0].content);
		const stored = readReplayEnvelope(db, sessionId);
		expect(stored.piNative).toEqual(before.piNative);
		db.close();
		db = createTestDb(path);
		expect(apply(false)).toEqual({ ...first, added: 0 });
		expect(apply(true)).toEqual({ ...first, added: 0 });
		expect(readReplayEnvelope(db, sessionId)).toEqual(stored);
		expect(raw).toEqual(signedHistory());
		const unseen = signedHistory("§99§ Later", "msg_new");
		expect(
			applyNativeResponseTagReplayPi({
				db,
				sessionId,
				messages: [unseen],
				canApply: false,
			}),
		).toBe(0);
		expect(unseen.providerPayload.items[0].content[0].text).toBe("§99§ Later");
	} finally {
		db.close();
		cleanup();
	}
});

test("untagged signed history is unchanged and native reasoning and calls retain their bytes", () => {
	const db = createTestDb();
	try {
		const clean = signedHistory("Hello");
		const cleanPayload = clean.providerPayload;
		const cleanMessages = [clean];
		expect(
			applyNativeResponseTagReplayPi({
				db,
				sessionId: "clean",
				messages: cleanMessages,
				canApply: true,
			}),
		).toBe(0);
		expect(cleanMessages[0].providerPayload).toBe(cleanPayload);
		const original = signedHistory();
		const reasoning = {
			type: "reasoning",
			id: "rs_old",
			encrypted_content: "opaque signed reasoning",
			summary: [],
		};
		const call = {
			type: "function_call",
			id: "fc_old",
			call_id: "call_old",
			name: "read",
			arguments: "{}",
		};
		const messages = [
			{
				...original,
				providerPayload: {
					...original.providerPayload,
					items: [reasoning, original.providerPayload.items[0], call],
				},
			},
		];
		expect(
			applyNativeResponseTagReplayPi({
				db,
				sessionId: "mixed",
				messages,
				canApply: true,
			}),
		).toBe(1);
		expect(messages[0].providerPayload.items[0]).toBe(reasoning);
		expect(messages[0].providerPayload.items[2]).toBe(call);
		expect(original.providerPayload.items[0].content[0].text).toBe(
			"§42§ Hello",
		);
	} finally {
		db.close();
	}
});

test.each([
	"body",
	"id",
	"phase",
	"ambiguous",
	"unsigned",
])("native tag normalization rejects %s mismatches", (kind) => {
	const db = createTestDb();
	try {
		const message = signedHistory();
		message.content[0].text = "§2§ Hello";
		if (kind === "body") message.content[0].text += " changed";
		if (kind === "id") message.providerPayload.items[0].id = "wrong";
		if (kind === "phase") message.providerPayload.items[0].phase = "commentary";
		if (kind === "ambiguous") message.content.push({ ...message.content[0] });
		if (kind === "unsigned") message.content[0].textSignature = "";
		const messages = [message];
		const before = structuredClone(messages);
		expect(
			applyNativeResponseTagReplayPi({
				db,
				sessionId: kind,
				messages,
				canApply: true,
			}),
		).toBe(0);
		expect(messages).toEqual(before);
	} finally {
		db.close();
	}
});

test.each([
	"id",
	"phase",
	"native body",
	"duplicate native item",
])("a frozen strip does not authorize a changed %s", (kind) => {
	const db = createTestDb();
	const sessionId = `frozen-${kind}`;
	try {
		expect(
			applyNativeResponseTagReplayPi({
				db,
				sessionId,
				messages: [signedHistory()],
				canApply: true,
			}),
		).toBe(1);
		const ledger = readReplayEnvelope(db, sessionId);
		for (const canApply of [false, true]) {
			const message = signedHistory();
			message.content[0].text = "§2§ Hello";
			const native = message.providerPayload.items[0];
			if (kind === "id") native.id = "msg_changed";
			if (kind === "phase") native.phase = "commentary";
			if (kind === "native body")
				native.content[0].text = "§42§ Unrelated body";
			if (kind === "duplicate native item")
				message.providerPayload.items.push(structuredClone(native));
			const messages = [message];
			const before = structuredClone(messages);
			expect(
				applyNativeResponseTagReplayPi({ db, sessionId, messages, canApply }),
			).toBe(0);
			expect(messages).toEqual(before);
			expect(readReplayEnvelope(db, sessionId)).toEqual(ledger);
		}
	} finally {
		db.close();
	}
});

test("frozen native replay does not authorize unrelated unsigned typed body changes", () => {
	const db = createTestDb();
	const sessionId = "frozen-unrelated-typed-body";
	try {
		expect(
			applyNativeResponseTagReplayPi({
				db,
				sessionId,
				messages: [signedHistory()],
				canApply: true,
			}),
		).toBe(1);
		const ledger = readReplayEnvelope(db, sessionId);
		const message = signedHistory();
		message.content[0].text = "Unrelated body";
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
		expect(messages[0].providerPayload.items[0].content[0].text).toBe("Hello");
		expect(readReplayEnvelope(db, sessionId)).toEqual(ledger);
		expect(
			piPreparedStructureMismatch(
				{ input: messages[0].providerPayload.items },
				piPreparedStructure(messages, responsesModel, "omp"),
			),
		).toContain("comparison=content");
	} finally {
		db.close();
	}
});

test("a frozen missing-phase strip cannot replay an explicit null phase", () => {
	const db = createTestDb();
	const sessionId = "frozen-missing-phase";
	try {
		const original = signedHistory();
		Reflect.deleteProperty(original.providerPayload.items[0], "phase");
		original.content[0].textSignature = JSON.stringify({ v: 1, id: "msg_old" });
		expect(
			applyNativeResponseTagReplayPi({
				db,
				sessionId,
				messages: [original],
				canApply: true,
			}),
		).toBe(1);
		const ledger = readReplayEnvelope(db, sessionId);
		const changed = structuredClone(original);
		Reflect.set(changed.providerPayload.items[0], "phase", null);
		const messages = [changed];
		expect(
			applyNativeResponseTagReplayPi({
				db,
				sessionId,
				messages,
				canApply: false,
			}),
		).toBe(0);
		expect(messages[0].providerPayload.items[0].content[0].text).toBe(
			"§42§ Hello",
		);
		expect(readReplayEnvelope(db, sessionId)).toEqual(ledger);
	} finally {
		db.close();
	}
});

test("a failed decision write exposes no new native bytes", () => {
	const db = createTestDb();
	try {
		db.exec(
			"CREATE TRIGGER refuse_strip BEFORE INSERT ON session_meta_chunks WHEN NEW.column_name = 'trailing_blank_decisions' BEGIN SELECT RAISE(FAIL, 'denied'); END",
		);
		const messages = [signedHistory()];
		const before = structuredClone(messages);
		expect(() =>
			applyNativeResponseTagReplayPi({
				db,
				sessionId: "write-failure",
				messages,
				canApply: true,
			}),
		).toThrow();
		expect(messages).toEqual(before);
	} finally {
		db.close();
	}
});

test.each([
	"{",
	'{"version":3,"trailingBlank":{},"future":"preserve"}',
])("an unreadable replay envelope retains native bytes without overwriting: %s", (raw) => {
	const db = createTestDb();
	try {
		getOrCreateSessionMeta(db, "corrupt");
		writeSessionMetaCollection(db, "corrupt", "trailing_blank_decisions", raw);
		const messages = [signedHistory()];
		const before = structuredClone(messages);
		expect(
			applyNativeResponseTagReplayPi({
				db,
				sessionId: "corrupt",
				messages,
				canApply: true,
			}),
		).toBe(0);
		expect(messages).toEqual(before);
		expect(
			readSessionMetaCollection(db, "corrupt", "trailing_blank_decisions"),
		).toBe(raw);
	} finally {
		db.close();
	}
});
