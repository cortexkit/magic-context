// Review witnesses for the history cut's branch-position fallback. Each test
// states a property the fallback is meant to keep and is expected to fail on
// the code it was written against; see
// .cortexkit/internal-docs/audits/issue-938-cut-review.md for the findings.
//
// A pass trims twice: first to the boundary the cached history head was built
// with (trimPiMessagesToCachedBoundary, before the pipeline), then to the
// boundary the head served on this pass (inside injectM0M1Pi). On a history
// refresh the two differ; on every later pass they are the same.
import { afterEach, describe, expect, it, mock } from "bun:test";
import { withRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { __test, resetPiUnplacedCutLog } from "./inject-compartments-pi";
import { convertEntriesToRawMessages } from "./read-session-pi";

type Entry = { type: string; id: string; message?: Record<string, unknown> };

const SESSION = "pi-cut-review";

function user(id: string): Entry {
	return { type: "message", id, message: { role: "user", content: id } };
}

function call(id: string, callId: string): Entry {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "read", arguments: {} }],
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

function answer(id: string, stopReason = "stop"): Entry {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			content: [{ type: "text", text: id }],
			stopReason,
		},
	};
}

// Pi builds this context message from a host compaction entry, so it has no
// position on the raw branch.
const HOST_SUMMARY = {
	role: "compactionSummary",
	summary: "Host compaction checkpoint.",
	tokensBefore: 900_000,
};

type EventItem = Entry | { extra: Record<string, unknown>; entryId?: string };

function eventFrom(items: EventItem[]) {
	return {
		messages: items.map((item) =>
			"extra" in item
				? structuredClone(item.extra)
				: structuredClone(item.message),
		) as never[],
		entryIds: items.map((item) => ("extra" in item ? item.entryId : item.id)),
	};
}

/**
 * Trim one context event to each boundary in turn, the way one pass does
 * (the first trim also shortens the entry ids, as the early trim does).
 * Returns the kept messages as labels and as bytes.
 */
function pass(branch: Entry[], items: EventItem[], boundaries: string[]) {
	const { messages, entryIds } = eventFrom(items);
	const raw = convertEntriesToRawMessages(branch as never);
	withRawMessageProvider(SESSION, { readMessages: () => raw }, () => {
		for (const boundary of boundaries)
			__test.trimPiMessagesToBoundary(
				messages,
				entryIds,
				boundary,
				true,
				SESSION,
			);
	});
	return {
		labels: (messages as Record<string, unknown>[]).map(label),
		bytes: JSON.stringify(messages),
	};
}

function label(message: Record<string, unknown>): string {
	if (message.role === "compactionSummary") return "host-summary";
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

describe("history cut fallback: byte stability across passes", () => {
	it("the defer pass after a history refresh serves the refresh pass's cut when a host summary leads the context", () => {
		// The previous summary ended on f2, a visible message; the new one ends
		// on a-err, a failed reply Pi hid before retrying.
		const branch = [
			user("u1"),
			call("a1", "c1"),
			result("r1", "c1"),
			answer("f1"),
			user("u2"),
			answer("f2"),
			user("u3"),
			answer("a-err", "error"),
		];
		const event: EventItem[] = [
			{ extra: HOST_SUMMARY, entryId: undefined },
			...branch.slice(0, 7),
		];
		// Refresh pass: early trim to the old boundary (found by id), then the
		// head's trim to the new one (placed by branch position).
		const refresh = pass(branch, event, ["f2", "a-err"]);
		// Every later pass: both trims use the new boundary.
		const defer = pass(branch, event, ["a-err", "a-err"]);
		expect(defer.labels).toEqual(refresh.labels);
		expect(defer.bytes).toBe(refresh.bytes);
	});

	it("the defer pass after a history refresh serves the refresh pass's cut when the old boundary lay inside the live turn", () => {
		const branch = [
			user("u1"),
			answer("f1"),
			user("u2"),
			call("a2", "c2"),
			result("r2", "c2"),
			answer("m2"),
			call("a3", "c3"),
			result("r3", "c3"),
			answer("a-err", "error"),
		];
		const event: EventItem[] = branch.slice(0, 8);
		const refresh = pass(branch, event, ["m2", "a-err"]);
		const defer = pass(branch, event, ["a-err", "a-err"]);
		expect(defer.labels).toEqual(refresh.labels);
	});

	it("a boundary found by id and the same boundary missing give the same cut when a host summary precedes it", () => {
		// The fallback's comment: when a user prompt follows the boundary, the
		// cut equals the one the id lookup makes, so a boundary that one pass
		// finds and a later pass cannot find keeps the same bytes.
		const branch = [
			user("u1"),
			call("a1", "c1"),
			result("r1", "c1"),
			answer("f1"),
			user("u2"),
			answer("a2"),
		];
		const summary: EventItem = { extra: HOST_SUMMARY, entryId: undefined };
		const found = pass(branch, [summary, ...branch], ["f1"]);
		const missing = pass(
			branch,
			[summary, branch[0], branch[1], branch[2], branch[4], branch[5]],
			["f1"],
		);
		expect(missing.labels).toEqual(found.labels);
		expect(missing.bytes).toBe(found.bytes);
	});

	it("the live prompt's protection does not change when the next message after a hidden boundary is a new prompt", () => {
		// Pass N runs while the hidden failed reply is the newest raw message;
		// the person's next prompt then lands directly after it (the retry never
		// produced a reply, for example because Pi exited during it).
		const live = [
			user("u1"),
			answer("f1"),
			user("u2"),
			answer("a-err", "error"),
		];
		const first = pass(live, live.slice(0, 3), ["a-err"]);
		const later = [...live, user("u3")];
		const next = pass(
			later,
			[later[0], later[1], later[2], later[4]],
			["a-err"],
		);
		// The earlier request must stay a prefix of the later one.
		expect(next.bytes.startsWith(first.bytes.slice(0, -1))).toBe(true);
	});
});
