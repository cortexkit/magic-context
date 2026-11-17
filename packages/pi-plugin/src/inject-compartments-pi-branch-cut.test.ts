// The history cut's branch-position fallback in trimPiMessagesToBoundary: the
// boundary message is missing from the context event, so the cut is placed by
// the messages' positions in the session's raw branch.
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { withRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import * as logger from "@magic-context/core/shared/logger";
import { __test, resetPiUnplacedCutLog } from "./inject-compartments-pi";
import { convertEntriesToRawMessages } from "./read-session-pi";

type Entry = { type: string; id: string; message?: Record<string, unknown> };

const SESSION = "pi-branch-cut";

function user(id: string): Entry {
	return { type: "message", id, message: { role: "user", content: id } };
}

function call(id: string, ...callIds: string[]): Entry {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			content: callIds.map((callId) => ({
				type: "toolCall",
				id: callId,
				name: "read",
				arguments: {},
			})),
			stopReason: "toolUse",
		},
	};
}

function result(id: string, callId: string): Entry {
	return {
		type: "message",
		id,
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "read",
			content: [{ type: "text", text: id }],
			isError: false,
		},
	};
}

function answer(id: string): Entry {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			content: [{ type: "text", text: id }],
			stopReason: "stop",
		},
	};
}

// Context messages Pi builds from entries that are not messages, so they have
// no position on the raw branch.
const HOST_SUMMARY = {
	role: "compactionSummary",
	summary: "Host compaction checkpoint.",
	tokensBefore: 900_000,
};
const CUSTOM = { role: "custom", customType: "note", content: "custom note" };

type EventItem = Entry | { extra: Record<string, unknown>; entryId?: string };

/**
 * Run the cut on a context event built from `items` (branch entries and
 * extra context-only messages, in event order) against the raw branch made of
 * `branch`. Returns the kept messages as short labels.
 */
function cut(branch: Entry[], items: EventItem[], boundary: string) {
	const messages = items.map((item) =>
		"extra" in item
			? structuredClone(item.extra)
			: structuredClone(item.message),
	) as never[];
	const entryIds = items.map((item) =>
		"extra" in item ? item.entryId : item.id,
	);
	const raw = convertEntriesToRawMessages(branch as never);
	withRawMessageProvider(SESSION, { readMessages: () => raw }, () =>
		__test.trimPiMessagesToBoundary(
			messages,
			entryIds,
			boundary,
			false,
			SESSION,
		),
	);
	return {
		labels: (messages as Record<string, unknown>[]).map(label),
		bytes: JSON.stringify(messages),
	};
}

function label(message: Record<string, unknown>): string {
	if (message.role === "compactionSummary") return "summary";
	if (message.role === "custom") return "custom";
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const first = content[0] as Record<string, unknown> | undefined;
		if (first?.type === "text") return String(first.text);
		if (first?.type === "toolCall") return `call:${String(first.id)}`;
	}
	return String(message.role);
}

afterEach(() => {
	mock.restore();
	resetPiUnplacedCutLog(SESSION);
});

describe("history cut placed by branch position", () => {
	it("cuts around a host compaction summary and a custom message, which stay in place", () => {
		const branch = [
			user("u1"),
			call("a1", "c1"),
			result("r1", "c1"),
			answer("f1"),
			user("u2"),
			answer("a-err"),
		];
		// Pi puts the host's summary first; the failed reply a-err is hidden.
		const { labels } = cut(
			branch,
			[
				{ extra: HOST_SUMMARY, entryId: "cmp1" },
				branch[0],
				branch[1],
				branch[2],
				{ extra: CUSTOM },
				branch[3],
				branch[4],
			],
			"a-err",
		);
		expect(labels).toEqual(["summary", "custom", "u2"]);
	});

	it("keeps the live prompt when the summary ends inside its turn, and later turns keep the same cut", () => {
		const live = [
			user("u1"),
			call("a1", "c1"),
			result("r1", "c1"),
			answer("f1"),
			user("u2"),
			answer("a-err"),
		];
		const first = cut(
			live,
			[live[0], live[1], live[2], live[3], live[4]],
			"a-err",
		);
		expect(first.labels).toEqual(["u2"]);
		// Pi's retry answers u2 after the hidden failure, then the person writes again.
		const later = [...live, answer("a-retry"), user("u3")];
		const next = cut(
			later,
			[later[0], later[1], later[2], later[3], later[4], later[6], later[7]],
			"a-err",
		);
		expect(next.labels).toEqual(["u2", "a-retry", "u3"]);
		expect(next.bytes.startsWith(first.bytes.slice(0, -1))).toBe(true);
	});

	it("cuts tool results that have no branch position together with their call", () => {
		// Only the first result of a run gets a position on the raw branch.
		const branch = [
			user("u1"),
			call("a1", "c1", "c2"),
			result("r1", "c1"),
			result("r2", "c2"),
			answer("f1"),
			user("u2"),
			answer("a2"),
		];
		const { labels } = cut(
			branch,
			[branch[0], branch[1], branch[2], branch[3], branch[5], branch[6]],
			"f1",
		);
		expect(labels).toEqual(["u2", "a2"]);
	});

	it("a boundary that closes a turn keeps the same bytes when a later pass cannot find it", () => {
		const branch = [
			user("u1"),
			call("a1", "c1"),
			result("r1", "c1"),
			answer("f1"),
			user("u2"),
			answer("a2"),
		];
		const found = cut(branch, branch, "f1");
		expect(found.labels).toEqual(["u2", "a2"]);
		const missing = cut(
			branch,
			[branch[0], branch[1], branch[2], branch[4], branch[5]],
			"f1",
		);
		expect(missing.bytes).toBe(found.bytes);
	});

	it("a found boundary that goes missing inside a turn gets the turn's prompt back once, then keeps it", () => {
		const branch = [
			user("u1"),
			call("a1", "c1"),
			result("r1", "c1"),
			answer("m1"),
			call("a3", "c3"),
			result("r3", "c3"),
			answer("f3"),
			user("u2"),
		];
		const found = cut(branch, branch, "m1");
		expect(found.labels).toEqual(["call:c3", "r3", "f3", "u2"]);
		const withoutBoundary = branch.filter((entry) => entry.id !== "m1");
		const missing = cut(branch, withoutBoundary, "m1");
		// The one rewrite: u1 comes back in front of the rest of its turn.
		expect(missing.labels).toEqual(["u1", "call:c3", "r3", "f3", "u2"]);
		const later = [...branch, answer("a4"), user("u3")];
		const next = cut(
			later,
			later.filter((entry) => entry.id !== "m1"),
			"m1",
		);
		expect(next.labels).toEqual([
			"u1",
			"call:c3",
			"r3",
			"f3",
			"u2",
			"a4",
			"u3",
		]);
		expect(next.bytes.startsWith(missing.bytes.slice(0, -1))).toBe(true);
	});

	it("logs once per pass when the boundary cannot be placed, and cuts nothing", () => {
		const lines: string[] = [];
		spyOn(logger, "sessionLog").mockImplementation((_id, ...parts) => {
			lines.push(parts.map(String).join(" "));
		});
		const branch = [user("u1"), answer("f1"), user("u2")];
		const items: EventItem[] = [
			{ extra: HOST_SUMMARY, entryId: "cmp1" },
			...branch,
		];
		const first = cut(branch, items, "gone");
		expect(first.labels).toEqual(["summary", "u1", "f1", "u2"]);
		cut(branch, items, "gone");
		const cutLines = () =>
			lines.filter((line) => line.startsWith("pi history cut not placed"));
		expect(cutLines()).toEqual([
			"pi history cut not placed: boundary gone is not among the 4 context messages and it is not on the active branch either; first message without a branch position: compactionSummary; nothing was cut",
		]);
		resetPiUnplacedCutLog(SESSION);
		cut(branch, items, "gone");
		expect(cutLines()).toHaveLength(2);
	});

	it("logs when the context is not in branch order", () => {
		const lines: string[] = [];
		spyOn(logger, "sessionLog").mockImplementation((_id, ...parts) => {
			lines.push(parts.map(String).join(" "));
		});
		const branch = [user("u1"), answer("f1"), user("u2"), answer("a-err")];
		const { labels } = cut(branch, [branch[2], branch[0], branch[1]], "a-err");
		expect(labels).toEqual(["u2", "u1", "f1"]);
		expect(
			lines.filter((line) => line.startsWith("pi history cut not placed")),
		).toEqual([
			"pi history cut not placed: boundary a-err is not among the 3 context messages and the context messages are not in branch order; first message without a branch position: none; nothing was cut",
		]);
	});
});
