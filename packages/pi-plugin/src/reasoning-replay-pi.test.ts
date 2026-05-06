import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { openDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { setHarness } from "@magic-context/core/shared/harness";
import {
	buildMessageIdToMaxTag,
	clearOldReasoningPi,
	piMessageStableId,
	replayClearedReasoningPi,
	replayStrippedInlineThinkingPi,
} from "./reasoning-replay-pi";

setHarness("pi");

function makeDb() {
	const dir = mkdtempSync(join(tmpdir(), "pi-reasoning-replay-"));
	const path = join(dir, "context.db");
	return openDatabase(path);
}

function fakeTagTarget(messageId: string) {
	return {
		setContent: () => true,
		message: { info: { id: messageId, role: "assistant" }, parts: [] },
	};
}

/** Test helper: throw when piMessageStableId returns undefined. */
function requireId(msg: unknown, index: number): string {
	const id = piMessageStableId(msg, index);
	if (!id)
		throw new Error(`piMessageStableId returned undefined for index=${index}`);
	return id;
}

describe("buildMessageIdToMaxTag", () => {
	it("records the MAX tag number across parts of the same message", () => {
		const targets = new Map<number, ReturnType<typeof fakeTagTarget>>([
			[1, fakeTagTarget("msg-A")],
			[2, fakeTagTarget("msg-A")],
			[3, fakeTagTarget("msg-B")],
		]);
		const result = buildMessageIdToMaxTag(targets);
		expect(result.get("msg-A")).toBe(2);
		expect(result.get("msg-B")).toBe(3);
	});

	it("skips targets with no message id", () => {
		const targets = new Map<number, ReturnType<typeof fakeTagTarget>>([
			[1, { setContent: () => true, message: undefined }],
			[2, fakeTagTarget("msg-A")],
		] as Array<[number, ReturnType<typeof fakeTagTarget>]>);
		const result = buildMessageIdToMaxTag(
			targets as unknown as Map<
				number,
				import("@magic-context/core/hooks/magic-context/tag-messages").TagTarget
			>,
		);
		expect(result.size).toBe(1);
		expect(result.get("msg-A")).toBe(2);
	});
});

describe("piMessageStableId", () => {
	it("matches the format used by transcript-pi.ts", () => {
		expect(piMessageStableId({ role: "user", timestamp: 1234 }, 5)).toBe(
			"pi-msg-5-1234-user",
		);
		expect(piMessageStableId({ role: "assistant" }, 7)).toBe(
			"pi-msg-7-assistant",
		);
	});
});

describe("clearOldReasoningPi", () => {
	it("clears thinking on assistant messages whose tag is below the age cutoff", () => {
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [
					{ type: "thinking", thinking: "old reasoning" },
					{ type: "text", text: "old reply" },
				],
			},
			{
				role: "assistant",
				timestamp: 2,
				content: [
					{ type: "thinking", thinking: "recent reasoning" },
					{ type: "text", text: "recent reply" },
				],
			},
		];
		// Pretend tags 1..2 exist; clear messages with tag <= 1 (one message older than age 1).
		const id0 = piMessageStableId(messages[0], 0);
		const id1 = piMessageStableId(messages[1], 1);
		if (!id0 || !id1) throw new Error("piMessageStableId returned undefined");
		const messageIdToMaxTag = new Map<string, number>([
			[id0, 1],
			[id1, 2],
		]);
		const result = clearOldReasoningPi({
			messages,
			messageIdToMaxTag,
			clearReasoningAge: 1,
			piMessageStableId,
		});
		expect(result.cleared).toBe(1);
		expect(result.newWatermark).toBe(1);
		expect(messages[0].content[0]).toMatchObject({
			type: "thinking",
			thinking: "[cleared]",
		});
		// Recent message untouched.
		expect(messages[1].content[0]).toMatchObject({
			type: "thinking",
			thinking: "recent reasoning",
		});
	});

	it("does nothing when ageCutoff is 0 or below", () => {
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [{ type: "thinking", thinking: "a" }],
			},
		];
		const messageIdToMaxTag = new Map<string, number>([
			[requireId(messages[0], 0), 1],
		]);
		const result = clearOldReasoningPi({
			messages,
			messageIdToMaxTag,
			clearReasoningAge: 5, // larger than maxTag → ageCutoff = -4
			piMessageStableId,
		});
		expect(result.cleared).toBe(0);
		expect(result.newWatermark).toBe(0);
	});
});

describe("replayClearedReasoningPi", () => {
	it("replays [cleared] for assistant thinking parts below the watermark", () => {
		const db = makeDb();
		const sessionId = "ses_replay_pi_1";
		// First make the session_meta row exist.
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, { clearedReasoningThroughTag: 1 });

		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [{ type: "thinking", thinking: "should be cleared" }],
			},
			{
				role: "assistant",
				timestamp: 2,
				content: [{ type: "thinking", thinking: "still visible" }],
			},
		];
		const messageIdToMaxTag = new Map<string, number>([
			[requireId(messages[0], 0), 1],
			[requireId(messages[1], 1), 2],
		]);
		const cleared = replayClearedReasoningPi({
			db,
			sessionId,
			messages,
			messageIdToMaxTag,
			piMessageStableId,
		});
		expect(cleared).toBe(1);
		expect(messages[0].content[0]).toMatchObject({ thinking: "[cleared]" });
		expect(messages[1].content[0]).toMatchObject({ thinking: "still visible" });
	});
});

describe("replayStrippedInlineThinkingPi", () => {
	it("strips inline <thinking>...</thinking> from text parts below the watermark", () => {
		const db = makeDb();
		const sessionId = "ses_inline_pi_1";
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, { clearedReasoningThroughTag: 1 });

		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [
					{
						type: "text",
						text: "Hello <thinking>secret</thinking> world",
					},
				],
			},
		];
		const messageIdToMaxTag = new Map<string, number>([
			[requireId(messages[0], 0), 1],
		]);
		const stripped = replayStrippedInlineThinkingPi({
			db,
			sessionId,
			messages,
			messageIdToMaxTag,
			piMessageStableId,
		});
		expect(stripped).toBe(1);
		expect(messages[0].content[0]).toMatchObject({
			type: "text",
			text: "Hello world",
		});
	});

	it("returns 0 when no watermark is set", () => {
		const db = makeDb();
		const sessionId = "ses_inline_pi_2";
		getOrCreateSessionMeta(db, sessionId);
		// no watermark update — defaults to 0
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [{ type: "text", text: "<thinking>nope</thinking>untouched" }],
			},
		];
		const messageIdToMaxTag = new Map<string, number>([
			[requireId(messages[0], 0), 1],
		]);
		const stripped = replayStrippedInlineThinkingPi({
			db,
			sessionId,
			messages,
			messageIdToMaxTag,
			piMessageStableId,
		});
		expect(stripped).toBe(0);
	});
});
