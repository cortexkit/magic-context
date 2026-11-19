import { describe, expect, it } from "bun:test";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { applyDeferredPiCompactionMarker } from "./compaction-marker-manager-pi";
import { __test as injectTest } from "./inject-compartments-pi";
import { findFirstKeptEntryId } from "./pi-historian-runner";
import { resolvePiMarkerKeptEntry } from "./pi-history-cut";
import { iterateEntriesToRawMessageRange } from "./read-session-pi";
import { createTestDb } from "./test-utils.test";

type Entry = {
	type: string;
	id: string;
	message?: Record<string, unknown>;
	customType?: string;
	content?: unknown;
	summary?: string;
	fromId?: string;
	timestamp?: string;
};

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
/** A tool result whose call is not on the branch. */
const orphanResult = (id: string): Entry => result(id, "call-not-on-branch");
/** A tool result that carries no call id at all. */
const resultWithoutCallId = (id: string): Entry => ({
	type: "message",
	id,
	message: {
		role: "toolResult",
		toolName: "read",
		content: [{ type: "text", text: "out" }],
	},
});
/** What an extension's sendCustomMessage appends while the agent is idle. */
const customMessage = (id: string): Entry => ({
	type: "custom_message",
	id,
	customType: "extension-note",
	content: "a note from an extension",
	timestamp: "2026-01-01T00:00:00.000Z",
});
const branchSummary = (id: string): Entry => ({
	type: "branch_summary",
	id,
	summary: "what the abandoned branch did",
	fromId: "elsewhere",
	timestamp: "2026-01-01T00:00:00.000Z",
});

/**
 * The context message Pi's buildSessionContext makes of an entry (role
 * `custom` for a custom message, `branchSummary` for a branch summary), the
 * input the request's cut runs on.
 */
function contextMessage(entry: Entry): Record<string, unknown> | undefined {
	const timestamp = entry.timestamp
		? new Date(entry.timestamp).getTime()
		: undefined;
	if (entry.type === "message") return structuredClone(entry.message);
	if (entry.type === "custom_message")
		return {
			role: "custom",
			customType: entry.customType,
			content: entry.content,
			display: true,
			timestamp,
		};
	if (entry.type === "branch_summary" && entry.summary)
		return {
			role: "branchSummary",
			summary: entry.summary,
			fromId: entry.fromId,
			timestamp,
		};
	return undefined;
}

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
	const messages: Record<string, unknown>[] = [];
	const ids: string[] = [];
	for (const entry of entries) {
		const message = contextMessage(entry);
		if (!message) continue;
		messages.push(message);
		ids.push(entry.id);
	}
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
	// Summaries that end a turn the next prompt closes, with nothing else the
	// request keeps in between: the marker keeps the same entry the ordinal
	// placement it replaced kept, the next prompt or the first entry after it.
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
		it(`keeps the entry the ordinal placement kept: ${name}`, () => {
			const boundary = rawAt(entries, ordinal);
			const before = findFirstKeptEntryId(entries, ordinal);
			const kept = resolvePiMarkerKeptEntry(entries, boundary.id);
			expect(kept.kind === "resolved" ? kept.entryId : null).toBe(before);
			if (before)
				expect(firstKeptByRequestCut(entries, boundary.id)).toBe(before);
		});
	}

	// Shapes where the ordinal placement started the marker after an entry the
	// request keeps; the marker now keeps that entry, as the request does.
	const requestKeepsMore: Array<
		[string, Entry[], number, string, string | null]
	> = [
		[
			"an orphan tool result before the next prompt",
			[user("u1", "a"), reply("a1", "b"), orphanResult("r1"), user("u2", "c")],
			2,
			"r1",
			"u2",
		],
		[
			"a tool result without a call id before the next prompt",
			[
				user("u1", "a"),
				reply("a1", "b"),
				resultWithoutCallId("r1"),
				user("u2", "c"),
			],
			2,
			"r1",
			"u2",
		],
		[
			// No prompt closes the turn yet, so the request keeps its prompt.
			"a branch that so far holds only a shell run after the summary",
			[user("u1", "a"), reply("a1", "b"), bash("b1")],
			2,
			"u1",
			"b1",
		],
		[
			"a branch that so far holds only a failed reply after the summary",
			[user("u1", "a"), reply("a1", "b"), reply("a2", "boom", "error")],
			2,
			"u1",
			"a2",
		],
		[
			"a custom message an extension appended before the next prompt",
			[
				user("u1", "a"),
				reply("a1", "b"),
				customMessage("cm1"),
				user("u2", "c"),
			],
			2,
			"cm1",
			"u2",
		],
		[
			"a branch summary before the next prompt",
			[
				user("u1", "a"),
				reply("a1", "b"),
				branchSummary("bs1"),
				user("u2", "c"),
			],
			2,
			"bs1",
			"u2",
		],
	];
	for (const [name, entries, ordinal, kept, before] of requestKeepsMore) {
		it(`keeps what the request keeps: ${name}`, () => {
			const boundary = rawAt(entries, ordinal);
			expect(findFirstKeptEntryId(entries, ordinal)).toBe(before);
			expect(resolvePiMarkerKeptEntry(entries, boundary.id)).toEqual({
				kind: "resolved",
				entryId: kept,
			});
			expect(firstKeptByRequestCut(entries, boundary.id)).toBe(kept);
		});
	}

	it("places a marker staged on another branch at the entry this branch's request keeps", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-history-cut-fork";
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "u1",
					endMessageId: "a1",
					title: "Shared start",
					content: "shared start",
				},
			]);
			// Published on the branch that continued with u2a; the session has
			// since forked at a1 and continues with u2b.
			const branch = [
				user("u1", "a"),
				reply("a1", "b"),
				user("u2b", "c"),
				reply("a2b", "d"),
			];
			const appended: string[] = [];
			const outcome = applyDeferredPiCompactionMarker(
				{
					db,
					readBranchEntries: () => branch,
					appendCompaction: (_summary, firstKeptEntryId) => {
						appended.push(firstKeptEntryId);
						return "compact-fork";
					},
				},
				sessionId,
				{
					firstKeptEntryId: "u2a",
					endMessageId: "a1",
					ordinal: 2,
					tokensBefore: 0,
					summary: "Shared start",
					publishedAt: 1,
				},
			);
			// The ordinal placement kept the staged entry and retired the marker
			// because that entry is not on this branch.
			expect(outcome).toEqual({
				kind: "applied",
				firstKeptEntryId: "u2b",
				compactionId: "compact-fork",
			});
			expect(appended).toEqual(["u2b"]);
			expect(firstKeptByRequestCut(branch, "a1")).toBe("u2b");
		} finally {
			closeQuietly(db);
		}
	});

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
		).toEqual({ kind: "missing" });
	});
});
