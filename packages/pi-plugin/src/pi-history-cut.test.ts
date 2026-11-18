import { describe, expect, it } from "bun:test";
import { __test as injectTest } from "./inject-compartments-pi";
import { findFirstKeptEntryId } from "./pi-historian-runner";
import { resolvePiMarkerKeptEntry } from "./pi-history-cut";
import { iterateEntriesToRawMessageRange } from "./read-session-pi";

type Entry = { type: string; id: string; message?: Record<string, unknown> };

const user = (id: string, text: string): Entry => ({
	type: "message",
	id,
	message: { role: "user", content: text },
});
const reply = (id: string, text: string, stopReason = "stop"): Entry => ({
	type: "message",
	id,
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
	},
});
const call = (id: string, callId: string): Entry => ({
	type: "message",
	id,
	message: {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "read", arguments: {} }],
		stopReason: "toolUse",
	},
});
const result = (id: string, callId: string): Entry => ({
	type: "message",
	id,
	message: {
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text", text: "out" }],
	},
});
const system = (id: string): Entry => ({
	type: "message",
	id,
	message: { role: "system", content: "instructions" },
});
const bash = (id: string): Entry => ({
	type: "message",
	id,
	message: { role: "bashExecution", command: "ls", output: "a" },
});

/** The raw message a summary ending at `ordinal` ends on, as the historian records it. */
function rawAt(entries: readonly Entry[], ordinal: number) {
	const raw = [
		...iterateEntriesToRawMessageRange(
			entries,
			0,
			Number.MAX_SAFE_INTEGER,
			Number.MAX_SAFE_INTEGER,
		),
	].find((message) => message.ordinal === ordinal);
	if (!raw) throw new Error(`no raw message at ordinal ${ordinal}`);
	return raw;
}

/** The first message the request's history cut keeps for the same boundary. */
function firstKeptByRequestCut(
	entries: readonly Entry[],
	endMessageId: string,
): string | undefined {
	const messageEntries = entries.filter((entry) => entry.type === "message");
	const messages = messageEntries.map((entry) =>
		structuredClone(entry.message),
	);
	const ids = messageEntries.map((entry) => entry.id);
	injectTest.trimPiMessagesToBoundary(
		messages as never,
		ids,
		endMessageId,
		true,
	);
	return ids.find(
		(_, index) =>
			(messages[index] as { role?: unknown } | undefined)?.role !== "system",
	);
}

describe("Pi compaction marker kept entry", () => {
	// Summaries that end a finished turn: the marker keeps exactly the entry
	// it kept before it was derived from the history cut.
	const finishedTurns: Array<[string, Entry[], number]> = [
		[
			"a reply followed by the next prompt",
			[user("u1", "a"), reply("a1", "b"), user("u2", "c"), reply("a2", "d")],
			2,
		],
		[
			"a tool loop's final reply followed by the next prompt",
			[
				user("u1", "a"),
				call("a1", "c1"),
				result("r1", "c1"),
				reply("a2", "done"),
				user("u2", "next"),
				reply("a3", "e"),
			],
			4,
		],
		[
			"a reply followed by a system entry and a shell run",
			[
				user("u1", "a"),
				reply("a1", "b"),
				system("s1"),
				bash("b1"),
				user("u2", "c"),
			],
			2,
		],
		[
			"a reply followed by a failed reply and a new prompt",
			[
				user("u1", "a"),
				reply("a1", "b"),
				reply("a2", "boom", "error"),
				user("u2", "c"),
			],
			2,
		],
		["the newest message", [user("u1", "a"), reply("a1", "b")], 2],
	];
	for (const [name, entries, ordinal] of finishedTurns) {
		it(`is unchanged for a summary ending a finished turn: ${name}`, () => {
			const boundary = rawAt(entries, ordinal);
			const before = findFirstKeptEntryId(entries, ordinal);
			const kept = resolvePiMarkerKeptEntry(entries, boundary.id);
			expect(kept.kind === "resolved" ? kept.entryId : null).toBe(before);
			if (before)
				expect(firstKeptByRequestCut(entries, boundary.id)).toBe(before);
		});
	}

	const midTurn: Array<[string, Entry[], number]> = [
		[
			"the prompt, the reply under way",
			[user("u1", "a"), reply("a1", "b"), user("u2", "live"), reply("a2", "c")],
			3,
		],
		[
			"a folded tool result between steps",
			[
				user("u1", "a"),
				reply("a1", "b"),
				user("u2", "live"),
				call("a2", "c1"),
				result("r1", "c1"),
				reply("a3", "c"),
			],
			5,
		],
		[
			"the prompt, with a tool call still open after it",
			[user("u1", "a"), reply("a1", "b"), user("u2", "live"), call("a2", "c1")],
			3,
		],
	];
	for (const [name, entries, ordinal] of midTurn) {
		it(`keeps the turn's prompt, as the request does, for a summary ending inside a turn: ${name}`, () => {
			const boundary = rawAt(entries, ordinal);
			expect(resolvePiMarkerKeptEntry(entries, boundary.id)).toEqual({
				kind: "resolved",
				entryId: "u2",
			});
			expect(firstKeptByRequestCut(entries, boundary.id)).toBe("u2");
		});
	}

	it("waits while the summary reaches the end of the branch, where the request still keeps the prompt", () => {
		const entries = [user("u1", "a"), reply("a1", "b"), user("u2", "live")];
		const boundary = rawAt(entries, 3);
		expect(resolvePiMarkerKeptEntry(entries, boundary.id)).toEqual({
			kind: "waiting",
		});
		expect(firstKeptByRequestCut(entries, boundary.id)).toBe("u2");
	});

	it("falls back to the stored ordinal for a boundary the branch does not hold", () => {
		expect(
			resolvePiMarkerKeptEntry([user("u1", "a"), reply("a1", "b")], "gone"),
		).toEqual({ kind: "boundary-not-on-branch" });
	});
});
