import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
	appendCompartments,
	getCompartments,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { getRawHistoryEligibility } from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import { withRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import * as logger from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { applyDeferredPiCompactionMarker } from "./compaction-marker-manager-pi";
import {
	awaitInFlightHistorians,
	clearContextHandlerSession,
	__test as contextHandlerInternals,
	registerPiContextHandler,
} from "./context-handler";
import entriesWithSystem from "./fixtures/system-ordinals-pi.input.json";
import {
	clearPiOrdinalAlignmentSession,
	resolvePiOrdinalAlignment,
} from "./pi-ordinal-alignment";
import {
	convertEntriesToRawMessagePage,
	convertEntriesToRawMessages,
	countPiRawMessages,
	locatePiRawOrdinals,
} from "./read-session-pi";
import { createFakePi, createTestDb, fakeContext } from "./test-utils.test";
import { createCtxExpandTool } from "./tools/ctx-expand";

for (const count of [1000, 50000]) {
	it(`reuses located anchors on a one-entry append to ${count} Pi entries`, () => {
		const db = createTestDb();
		const sessionId = `append-${count}`;
		const branch = Array.from({ length: count + 1 }, (_, index) => ({
			type: "message",
			id: `m${index}`,
			parentId: index === 0 ? null : `m${index - 1}`,
			message: { role: "user", content: `question ${index}` },
		}));
		const byId = new Map(branch.map((entry) => [entry.id, entry]));
		let leafId = `m${count - 1}`;
		let hostEntryVisits = 0;
		const ctx = {
			sessionManager: {
				getLeafId: () => leafId,
				getEntry: (id: string) => {
					hostEntryVisits++;
					return byId.get(id);
				},
			},
		} as never;
		const readBranch = () => {
			const entries = contextHandlerInternals.readPiBranchEntriesForContext(
				ctx,
				sessionId,
			);
			if (!entries) throw new Error("fixture branch could not be read");
			return entries;
		};
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: count,
					startMessageId: "m0",
					endMessageId: leafId,
					title: "History",
					content: "Summary",
				},
			]);
			const before = readBranch();
			const expected = resolvePiOrdinalAlignment(db, sessionId, before);
			expect(expected).toEqual({ kind: "aligned", offset: 0 });
			hostEntryVisits = 0;
			leafId = `m${count}`;
			const appended = readBranch();
			expect(hostEntryVisits).toBe(1);
			expect(before).toHaveLength(count);
			expect(appended).toEqual(branch);
			let alignmentVisits = 0;
			Object.defineProperty(appended, Symbol.iterator, {
				value: function* () {
					for (let index = 0; index < appended.length; index += 1) {
						alignmentVisits++;
						yield appended[index];
					}
				},
			});
			expect(resolvePiOrdinalAlignment(db, sessionId, appended)).toEqual(
				expected,
			);
			console.log(
				`pi-ordinal-append entries=${count} projectionLookups=${hostEntryVisits} alignmentVisits=${alignmentVisits}`,
			);
			expect(alignmentVisits).toBe(0);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});
}

/*
 * Fixture for a session whose branch walk lost its first entries: one
 * conversation of 90,740 message entries in the session file, of which the
 * branch walk (`getBranch()`) only reaches the last 18,250, because the walk
 * stops at an entry whose parent it cannot find. The stored compartments were
 * written while the walk still reached the first entry, so they tile ordinals
 * 1..65938 of the whole conversation, and the newest one ends on a message the
 * shortened branch still contains, at branch ordinal 7,946.
 *
 * Each turn is five entries and four ordinals: a user message, an assistant
 * with two tool calls, the two tool results (folded into one synthetic user
 * ordinal), and the assistant's answer.
 */
const ENTRIES_PER_TURN = 5;
const ORDINALS_PER_TURN = 4;
const TOTAL_TURNS = 18_148; // 90,740 entries
const LOST_TURNS = 14_498; // 72,490 entries, 57,992 ordinals the walk lost
const STORED_LAST_END = 65_938;
const LOST_ORDINALS = LOST_TURNS * ORDINALS_PER_TURN;

type Entry = {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	message?: Record<string, unknown>;
};

function turnEntries(prefix: string, turn: number, parentId: string | null) {
	const t = 1_700_000_000_000 + turn * 10_000;
	const at = (offset: number) => new Date(t + offset).toISOString();
	const ids = {
		user: `${prefix}u${turn}`,
		call: `${prefix}a${turn}`,
		resultA: `${prefix}r${turn}a`,
		resultB: `${prefix}r${turn}b`,
		answer: `${prefix}t${turn}`,
	};
	const entries: Entry[] = [
		{
			type: "message",
			id: ids.user,
			parentId,
			timestamp: at(0),
			message: {
				role: "user",
				content: `${prefix}question ${turn}`,
				timestamp: t,
			},
		},
		{
			type: "message",
			id: ids.call,
			parentId: ids.user,
			timestamp: at(1),
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: `${prefix}c${turn}a`,
						name: "read",
						arguments: { path: `a${turn}` },
					},
					{
						type: "toolCall",
						id: `${prefix}c${turn}b`,
						name: "read",
						arguments: { path: `b${turn}` },
					},
				],
				api: "test-api",
				provider: "test-provider",
				model: "test-model",
				usage: {},
				stopReason: "toolUse",
				timestamp: t + 1,
			},
		},
		{
			type: "message",
			id: ids.resultA,
			parentId: ids.call,
			timestamp: at(2),
			message: {
				role: "toolResult",
				toolCallId: `${prefix}c${turn}a`,
				toolName: "read",
				content: [{ type: "text", text: `${prefix}file a ${turn}` }],
				isError: false,
				timestamp: t + 2,
			},
		},
		{
			type: "message",
			id: ids.resultB,
			parentId: ids.resultA,
			timestamp: at(3),
			message: {
				role: "toolResult",
				toolCallId: `${prefix}c${turn}b`,
				toolName: "read",
				content: [{ type: "text", text: `${prefix}file b ${turn}` }],
				isError: false,
				timestamp: t + 3,
			},
		},
		{
			type: "message",
			id: ids.answer,
			parentId: ids.resultB,
			timestamp: at(4),
			message: {
				role: "assistant",
				content: [{ type: "text", text: `${prefix}answer ${turn}` }],
				api: "test-api",
				provider: "test-provider",
				model: "test-model",
				usage: {},
				stopReason: "stop",
				timestamp: t + 4,
			},
		},
	];
	return entries;
}

function buildConversation(
	turns: number,
	options: {
		prefix?: string;
		firstTurn?: number;
		parentId?: string | null;
	} = {},
): Entry[] {
	const prefix = options.prefix ?? "";
	const firstTurn = options.firstTurn ?? 0;
	let parentId = options.parentId ?? null;
	const entries: Entry[] = [];
	for (let turn = firstTurn; turn < firstTurn + turns; turn++) {
		const next = turnEntries(prefix, turn, parentId);
		entries.push(...next);
		parentId = next[next.length - 1]?.id ?? parentId;
	}
	return entries;
}

interface DivergedSession {
	/** The whole conversation, as the branch walk saw it when compartments were written. */
	full: Entry[];
	/** What `getBranch()` returns now: the walk stops after the lost entries. */
	branch: Entry[];
}

let cachedShape: DivergedSession | null = null;

/** The 90,740-entry conversation and its 18,250-entry branch walk. */
function divergedSession(): DivergedSession {
	if (cachedShape) return cachedShape;
	const full = buildConversation(TOTAL_TURNS);
	const branch = full.slice(LOST_TURNS * ENTRIES_PER_TURN);
	// The first entry the walk reaches names a parent the walk cannot load.
	expect(branch[0]?.parentId).toBe(full[LOST_TURNS * ENTRIES_PER_TURN - 1]?.id);
	cachedShape = { full, branch };
	return cachedShape;
}

/** Compartments that tile 1..65938 of the whole conversation, as they were written. */
function seedStoredCompartments(
	db: Database,
	sessionId: string,
	full: readonly Entry[],
): void {
	const raw = convertEntriesToRawMessages(full);
	const idAt = (ordinal: number) => {
		const id = raw[ordinal - 1]?.id;
		if (!id) throw new Error(`no raw message at ${ordinal}`);
		return id;
	};
	const rows = [];
	for (let start = 1, sequence = 0; start <= STORED_LAST_END; sequence++) {
		const end = Math.min(start + 999, STORED_LAST_END);
		rows.push({
			sequence,
			startMessage: start,
			endMessage: end,
			startMessageId: idAt(start),
			endMessageId: idAt(end),
			title: `Work ${start}-${end}`,
			content: `Summary of messages ${start}-${end}.`,
			p1: `Summary of messages ${start}-${end}.`,
		});
		start = end + 1;
	}
	appendCompartments(db, sessionId, rows);
}

function plainProvider(entries: readonly Entry[]) {
	return {
		readMessages: () => convertEntriesToRawMessages(entries),
		readMessagePage: (after: number, limit: number, watermark: number) =>
			convertEntriesToRawMessagePage(entries, after, limit, watermark),
		getMessageCount: () => countPiRawMessages(entries),
	};
}

function alignedProvider(db: Database, sessionId: string, entries: Entry[]) {
	const offset = resolvePiOrdinalAlignment(db, sessionId, entries).offset;
	return {
		readMessages: () => convertEntriesToRawMessages(entries, offset),
		readMessagePage: (after: number, limit: number, watermark: number) =>
			convertEntriesToRawMessagePage(entries, after, limit, watermark, offset),
		getMessageCount: () => countPiRawMessages(entries, offset),
	};
}

function branchContext(sessionId: string, entries: () => readonly Entry[]) {
	return {
		...fakeContext(sessionId),
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => entries(),
		},
	};
}

afterEach(() => {
	mock.restore();
});

describe("Pi ordinal alignment: stored ordinals ahead of the branch walk", () => {
	it("reproduces the stall: plain branch numbering never reaches past the stored end", () => {
		const db = createTestDb();
		const sessionId = "ordinal-stall-repro";
		try {
			const { full, branch } = divergedSession();
			expect(full.filter((entry) => entry.type === "message").length).toBe(
				90_740,
			);
			expect(branch.length).toBe(18_250);
			seedStoredCompartments(db, sessionId, full);

			const eligibility = withRawMessageProvider(
				sessionId,
				plainProvider(branch),
				() => getRawHistoryEligibility(db, sessionId),
			);
			// The logged shape: nextStartOrdinal=65939 lastCompartmentEnd=65938,
			// and a branch whose ordinals stop at 14,600 however long it grows.
			expect(eligibility.lastCompartmentEnd).toBe(STORED_LAST_END);
			expect(eligibility.offset).toBe(STORED_LAST_END + 1);
			expect(eligibility.rawMessageCount).toBe(14_600);
			expect(eligibility.hasRawBeyondLastCompartment).toBe(false);
		} finally {
			clearPiOrdinalAlignmentSession(sessionId);
			closeQuietly(db);
		}
	});

	it("measures the offset from the newest compartment's end and continues the stored numbering", () => {
		const db = createTestDb();
		const sessionId = "ordinal-shift-measured";
		const logs: string[] = [];
		spyOn(logger, "sessionLog").mockImplementation((_id, ...parts) => {
			logs.push(parts.map(String).join(" "));
		});
		try {
			const { full, branch } = divergedSession();
			seedStoredCompartments(db, sessionId, full);

			const alignment = resolvePiOrdinalAlignment(db, sessionId, branch);
			expect(alignment).toMatchObject({
				kind: "shifted",
				offset: LOST_ORDINALS,
				storedOrdinal: STORED_LAST_END,
				branchOrdinal: STORED_LAST_END - LOST_ORDINALS,
			});
			expect(
				logs.filter((line) => line.startsWith("pi ordinal alignment:")),
			).toEqual([
				`pi ordinal alignment: stored ordinals run ${LOST_ORDINALS} ahead of the branch walk (newest compartment end a16484 stored at ${STORED_LAST_END}, branch ordinal 7946); numbering the branch from ${LOST_ORDINALS + 1} so stored coordinates keep their meaning`,
			]);
			// Derived again for the same branch and rows: no second log line.
			resolvePiOrdinalAlignment(db, sessionId, branch);
			resolvePiOrdinalAlignment(db, sessionId, [...branch]);
			expect(
				logs.filter((line) => line.startsWith("pi ordinal alignment:")),
			).toHaveLength(1);

			const eligibility = withRawMessageProvider(
				sessionId,
				alignedProvider(db, sessionId, branch),
				() => getRawHistoryEligibility(db, sessionId),
			);
			expect(eligibility.offset).toBe(STORED_LAST_END + 1);
			expect(eligibility.rawMessageCount).toBe(TOTAL_TURNS * ORDINALS_PER_TURN);
			expect(eligibility.hasRawBeyondLastCompartment).toBe(true);

			// Every message the branch still holds keeps the ordinal, id, role
			// and content it had before the walk lost its first entries.
			const before = convertEntriesToRawMessages(full).slice(LOST_ORDINALS);
			const after = convertEntriesToRawMessages(branch, LOST_ORDINALS);
			expect(after).toHaveLength(TOTAL_TURNS * ORDINALS_PER_TURN);
			expect(JSON.stringify(after.slice(LOST_ORDINALS))).toBe(
				JSON.stringify(before),
			);
			// The unreachable ordinals are empty slots, never another message.
			expect(
				after
					.slice(0, LOST_ORDINALS)
					.every(
						(message, index) =>
							message.ordinal === index + 1 &&
							message.id === "" &&
							message.parts.length === 0,
					),
			).toBe(true);
			// A page that straddles the boundary is dense and continuous.
			const page = convertEntriesToRawMessagePage(
				branch,
				LOST_ORDINALS - 2,
				4,
				Number.MAX_SAFE_INTEGER,
				LOST_ORDINALS,
			);
			expect(page.map((message) => [message.ordinal, message.id])).toEqual([
				[LOST_ORDINALS - 1, ""],
				[LOST_ORDINALS, ""],
				[LOST_ORDINALS + 1, `u${LOST_TURNS}`],
				[LOST_ORDINALS + 2, `a${LOST_TURNS}`],
			]);
		} finally {
			clearPiOrdinalAlignmentSession(sessionId);
			closeQuietly(db);
		}
	});

	it("ctx_expand of an old range returns what it returned before the walk lost entries", async () => {
		const db = createTestDb();
		const sessionId = "ordinal-shift-expand";
		try {
			const { full, branch } = divergedSession();
			seedStoredCompartments(db, sessionId, full);
			const expand = async (
				entries: readonly Entry[],
				params: Record<string, unknown>,
			) => {
				const result = await createCtxExpandTool({ db }).execute(
					"expand",
					params as never,
					new AbortController().signal,
					undefined,
					branchContext(sessionId, () => entries) as never,
				);
				return (result.content[0] as { text: string }).text;
			};
			const range = { start: 65_001, end: STORED_LAST_END };
			const beforeRange = await expand(full, range);
			expect(beforeRange).toContain("question 16250");
			expect(await expand(branch, range)).toBe(beforeRange);
			const one = { message: STORED_LAST_END };
			expect(await expand(branch, one)).toBe(await expand(full, one));
			// A range the walk no longer reaches finds nothing, rather than
			// showing whichever branch message now carries that number.
			const lost = await expand(branch, { start: 1_001, end: 1_100 });
			expect(lost).not.toContain("question");
			expect(lost).not.toContain("answer");
			// Every mode says plainly that those messages are gone.
			const gone = "no longer in this session's history";
			expect(lost).toBe(
				`No messages found in range 1001-1100: those messages are ${gone}, which now starts at message ${LOST_ORDINALS + 1}.`,
			);
			expect(
				await expand(branch, { start: 1_001, end: 1_100, verbose: true }),
			).toBe(lost);
			expect(await expand(branch, { message: 1_001 })).toBe(
				`No message at ordinal 1001: it is ${gone}, which now starts at message ${LOST_ORDINALS + 1}.`,
			);
			// A range that straddles the break shows the reachable part and says
			// which messages are gone.
			const straddle = await expand(branch, {
				start: LOST_ORDINALS - 1,
				end: LOST_ORDINALS + 2,
			});
			expect(straddle).toStartWith(
				`Messages ${LOST_ORDINALS - 1}-${LOST_ORDINALS} are ${gone}; showing from ${LOST_ORDINALS + 1}.`,
			);
			expect(straddle).toContain(`question ${LOST_TURNS}`);
		} finally {
			clearPiOrdinalAlignmentSession(sessionId);
			closeQuietly(db);
		}
	});

	it("places a pending compaction marker's stored ordinal on the branch", () => {
		const db = createTestDb();
		const sessionId = "ordinal-shift-marker";
		try {
			const { full, branch } = divergedSession();
			seedStoredCompartments(db, sessionId, full);
			// The historian's next publish: 65939 (turn 16484's folded results) and
			// 65940 (its answer), written in the stored numbering.
			appendCompartments(db, sessionId, [
				{
					sequence: 66,
					startMessage: STORED_LAST_END + 1,
					endMessage: STORED_LAST_END + 2,
					startMessageId: "synth-user-r16484a",
					endMessageId: "t16484",
					title: "resumed",
					content: "resumed",
					p1: "resumed",
				},
			]);
			const appended: string[] = [];
			const outcome = applyDeferredPiCompactionMarker(
				{
					db,
					readBranchEntries: () => branch,
					appendCompaction: (_summary, firstKept) => {
						appended.push(firstKept);
						return "compaction-1";
					},
				},
				sessionId,
				{
					firstKeptEntryId: null,
					endMessageId: "t16484",
					ordinal: STORED_LAST_END + 2,
					tokensBefore: 0,
					summary: "summary",
					publishedAt: 1,
				},
			);
			// Stored ordinal 65941 is the user turn that follows, on the branch.
			expect(outcome).toEqual({
				kind: "applied",
				firstKeptEntryId: "u16485",
				compactionId: "compaction-1",
			});
			expect(appended).toEqual(["u16485"]);
		} finally {
			clearPiOrdinalAlignmentSession(sessionId);
			closeQuietly(db);
		}
	});
});

describe("Pi ordinal alignment: fail-closed and unchanged cases", () => {
	it("a /tree jump to before the anchor leaves the session unanchored, and one after it keeps the offset", () => {
		const db = createTestDb();
		const sessionId = "ordinal-shift-tree-jump";
		const logs: string[] = [];
		spyOn(logger, "sessionLog").mockImplementation((_id, ...parts) => {
			logs.push(parts.map(String).join(" "));
		});
		try {
			const { full, branch } = divergedSession();
			seedStoredCompartments(db, sessionId, full);
			// Navigate back to turn 15,000 (before the anchor's turn 16,484) and
			// continue there: the new branch shares the walk up to that turn.
			const backTo = (15_000 - LOST_TURNS) * ENTRIES_PER_TURN;
			const jumpedBack = [
				...branch.slice(0, backTo),
				...buildConversation(40, {
					prefix: "n",
					firstTurn: 0,
					parentId: branch[backTo - 1]?.id ?? null,
				}),
			];
			const back = resolvePiOrdinalAlignment(db, sessionId, jumpedBack);
			expect(back).toMatchObject({
				kind: "unanchored",
				reason: "anchor-missing",
			});
			expect(back.offset).toBe(0);
			expect(logs.at(-1)).toContain("anchor-missing");
			expect(logs.at(-1)).toContain("stored ordinal 65938 on message a16484");

			// Navigating to a point after the anchor keeps it on the branch.
			const forwardTo = (17_000 - LOST_TURNS) * ENTRIES_PER_TURN;
			const jumpedForward = [
				...branch.slice(0, forwardTo),
				...buildConversation(40, {
					prefix: "m",
					parentId: branch[forwardTo - 1]?.id ?? null,
				}),
			];
			expect(
				resolvePiOrdinalAlignment(db, sessionId, jumpedForward),
			).toMatchObject({ kind: "shifted", offset: LOST_ORDINALS });
		} finally {
			clearPiOrdinalAlignmentSession(sessionId);
			closeQuietly(db);
		}
	});

	it("a failed anchor read is unresolved, logged once, and keeps the marker waiting", () => {
		const db = createTestDb();
		const sessionId = "ordinal-anchor-read-failure";
		const logs: string[] = [];
		spyOn(logger, "sessionLog").mockImplementation((_id, ...parts) => {
			logs.push(parts.map(String).join(" "));
		});
		try {
			const { full, branch } = divergedSession();
			seedStoredCompartments(db, sessionId, full);
			const prepare = db.prepare.bind(db);
			spyOn(db, "prepare").mockImplementation((sql: string) => {
				if (sql.startsWith("SELECT sequence, start_message, end_message"))
					throw new Error("anchor read unavailable");
				return prepare(sql);
			});
			expect(resolvePiOrdinalAlignment(db, sessionId, branch)).toMatchObject({
				kind: "unresolved",
				offset: 0,
			});
			resolvePiOrdinalAlignment(db, sessionId, branch);
			expect(
				logs.filter((line) =>
					line.startsWith("pi ordinal alignment: unresolved"),
				),
			).toHaveLength(1);
			const outcome = applyDeferredPiCompactionMarker(
				{
					db,
					readBranchEntries: () => branch,
					appendCompaction: () => "must-not-append",
				},
				sessionId,
				{
					firstKeptEntryId: null,
					endMessageId: "a16484",
					ordinal: STORED_LAST_END,
					tokensBefore: 0,
					summary: "summary",
					publishedAt: 1,
				},
			);
			expect(outcome).toEqual({ kind: "waiting-for-entry" });
		} finally {
			clearPiOrdinalAlignmentSession(sessionId);
			closeQuietly(db);
		}
	});

	it("two stored anchors that imply different offsets leave the session unanchored", () => {
		const db = createTestDb();
		const sessionId = "ordinal-shift-disagree";
		try {
			const { full, branch } = divergedSession();
			seedStoredCompartments(db, sessionId, full);
			// The previous compartment's end now claims a position one later than
			// the one the newest compartment's end implies.
			db.prepare(
				"UPDATE compartments SET end_message = end_message + 1 WHERE session_id = ? AND sequence = (SELECT MAX(sequence) - 1 FROM compartments WHERE session_id = ?)",
			).run(sessionId, sessionId);
			const alignment = resolvePiOrdinalAlignment(db, sessionId, branch);
			expect(alignment).toMatchObject({
				kind: "unanchored",
				reason: "anchors-disagree",
			});
			expect(alignment.offset).toBe(0);
		} finally {
			clearPiOrdinalAlignmentSession(sessionId);
			closeQuietly(db);
		}
	});

	it("a session whose walk still starts at its first entry is aligned and numbered exactly as before", () => {
		const db = createTestDb();
		const sessionId = "ordinal-aligned";
		const logs: string[] = [];
		spyOn(logger, "sessionLog").mockImplementation((_id, ...parts) => {
			logs.push(parts.map(String).join(" "));
		});
		try {
			const entries = buildConversation(300);
			const raw = convertEntriesToRawMessages(entries);
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 600,
					startMessageId: raw[0]?.id ?? "",
					endMessageId: raw[599]?.id ?? "",
					title: "first",
					content: "first",
					p1: "first",
				},
				{
					sequence: 1,
					startMessage: 601,
					endMessage: 1_001,
					startMessageId: raw[600]?.id ?? "",
					endMessageId: raw[1_000]?.id ?? "",
					title: "second",
					content: "second",
					p1: "second",
				},
			]);
			expect(resolvePiOrdinalAlignment(db, sessionId, entries)).toEqual({
				kind: "aligned",
				offset: 0,
			});
			expect(logs.filter((line) => line.includes("ordinal alignment"))).toEqual(
				[],
			);
			expect(JSON.stringify(convertEntriesToRawMessages(entries, 0))).toBe(
				JSON.stringify(raw),
			);
			// No compartments at all: nothing to anchor, nothing changes.
			expect(
				resolvePiOrdinalAlignment(db, "ordinal-no-compartments", entries),
			).toEqual({ kind: "aligned", offset: 0 });
		} finally {
			clearPiOrdinalAlignmentSession(sessionId);
			closeQuietly(db);
		}
	});

	it("locates every raw message at the ordinal the converter gives it", () => {
		const shapes: unknown[][] = [
			entriesWithSystem as unknown[],
			buildConversation(30),
			[
				// A result without a call id takes no ordinal; a protocol entry
				// between results and the next assistant takes one before the fold.
				...buildConversation(2),
				{
					type: "message",
					id: "orphan-result",
					parentId: "t1",
					message: { role: "toolResult", content: [] },
				},
				{
					type: "message",
					id: "late-result",
					parentId: "orphan-result",
					message: { role: "toolResult", toolCallId: "c-late", content: [] },
				},
				{
					type: "message",
					id: "bash-1",
					parentId: "late-result",
					message: { role: "bashExecution", command: "ls", output: "" },
				},
				{ type: "label", id: "label-1", parentId: "bash-1" },
				{
					type: "message",
					id: "after-fold",
					parentId: "label-1",
					message: { role: "assistant", content: [] },
				},
				// A trailing open fold still has an ordinal.
				{
					type: "message",
					id: "trailing-result",
					parentId: "after-fold",
					message: { role: "toolResult", toolCallId: "c-tail", content: [] },
				},
			],
		];
		for (const entries of shapes) {
			const raw = convertEntriesToRawMessages(entries);
			const located = locatePiRawOrdinals(
				entries,
				new Set(raw.map((message) => message.id)),
			);
			expect(
				raw.map((message) => [message.id, located.get(message.id)]),
			).toEqual(raw.map((message) => [message.id, message.ordinal]));
		}
	});
});

describe("Pi ordinal alignment: the live context pass", () => {
	/**
	 * One context pass over the diverged session, through the real handler and
	 * historian runner. Only the historian's model call is mocked; it answers
	 * with two compartments covering whatever chunk it was given.
	 */
	async function runPass(args: {
		db: Database;
		sessionId: string;
		branch: Entry[];
		runner: SubagentRunner;
	}) {
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db: args.db,
			protectedTags: 0,
			historian: {
				runner: args.runner,
				model: "test/historian",
				historianChunkTokens: 20_000,
				executeThresholdPercentage: 80,
				protectedTags: 0,
			},
		});
		const handler = fake.handlers.get("context") as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		// Pi sends the turns after its own last compaction; here the last 60.
		const visible = args.branch.slice(-60 * ENTRIES_PER_TURN);
		const messages = visible.map((entry) => entry.message);
		await handler(
			{ messages },
			{
				...branchContext(args.sessionId, () => args.branch),
				getContextUsage: () => ({
					tokens: 85_000,
					percent: 85,
					contextWindow: 100_000,
				}),
			},
		);
		await awaitInFlightHistorians();
	}

	function historianRunner(chunks: Array<{ start: number; end: number }>) {
		return {
			harness: "pi",
			run: mock(async (options: { userMessage?: string }) => {
				const match = /Messages (\d+)-(\d+):/.exec(options.userMessage ?? "");
				const start = Number(match?.[1]);
				const end = Number(match?.[2]);
				chunks.push({ start, end });
				const middle = Math.floor((start + end) / 2);
				return {
					ok: true as const,
					assistantText: `<compartment start="${start}" end="${middle}" title="Resumed work"><p1>Resumed work.</p1></compartment><compartment start="${middle + 1}" end="${end}" title="Later work"><p1>Later work.</p1></compartment>`,
					durationMs: 1,
				};
			}),
		} as unknown as SubagentRunner;
	}

	it("the stuck session's historian resumes at 65939 on the first pass, with no repair step", async () => {
		const db = createTestDb();
		const sessionId = "ordinal-shift-live";
		const logs: string[] = [];
		spyOn(logger, "sessionLog").mockImplementation((_id, ...parts) => {
			logs.push(parts.map(String).join(" "));
		});
		const chunks: Array<{ start: number; end: number }> = [];
		const runner = historianRunner(chunks);
		try {
			const { full, branch } = divergedSession();
			seedStoredCompartments(db, sessionId, full);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				piStableIdScheme: 1,
			});
			const storedBefore = getCompartments(db, sessionId);

			await runPass({ db, sessionId, branch, runner });

			const transcript = logs.join("\n");
			expect(transcript).not.toContain("no new raw history");
			expect(runner.run, transcript).toHaveBeenCalledTimes(1);
			expect(chunks[0]?.start).toBe(STORED_LAST_END + 1);
			const after = getCompartments(db, sessionId);
			// The stored history is untouched; the new compartment continues it.
			expect(after.slice(0, storedBefore.length)).toEqual(storedBefore);
			const resumed = after[storedBefore.length];
			expect(resumed?.startMessage).toBe(STORED_LAST_END + 1);
			// Ordinal 65939 is the folded results of turn 16484, on the branch.
			expect(resumed?.startMessageId).toBe("synth-user-r16484a");
		} finally {
			clearContextHandlerSession(sessionId);
			clearPiOrdinalAlignmentSession(sessionId);
			closeQuietly(db);
		}
	}, 60_000);

	it("an unanchored session does not fire the historian", async () => {
		const db = createTestDb();
		const sessionId = "ordinal-unanchored-live";
		const logs: string[] = [];
		spyOn(logger, "sessionLog").mockImplementation((_id, ...parts) => {
			logs.push(parts.map(String).join(" "));
		});
		const chunks: Array<{ start: number; end: number }> = [];
		const runner = historianRunner(chunks);
		try {
			const { full } = divergedSession();
			seedStoredCompartments(db, sessionId, full);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				piStableIdScheme: 1,
			});
			// /tree back to before the anchor, then 3,000 new turns: the branch is
			// long enough again that plain numbering would pass the stored end and
			// summarize from a position that means something else on this branch.
			const backTo = (15_000 - LOST_TURNS) * ENTRIES_PER_TURN;
			const jumped = [
				...full.slice(0, LOST_TURNS * ENTRIES_PER_TURN + backTo),
				...buildConversation(3_000, {
					prefix: "n",
					parentId:
						full[LOST_TURNS * ENTRIES_PER_TURN + backTo - 1]?.id ?? null,
				}),
			];
			expect(countPiRawMessages(jumped)).toBeGreaterThan(STORED_LAST_END);

			await runPass({ db, sessionId, branch: jumped, runner });

			const transcript = logs.join("\n");
			expect(runner.run, transcript).not.toHaveBeenCalled();
			expect(transcript).toContain("pi ordinal alignment: anchor-missing");
		} finally {
			clearContextHandlerSession(sessionId);
			clearPiOrdinalAlignmentSession(sessionId);
			closeQuietly(db);
		}
	}, 60_000);
});
