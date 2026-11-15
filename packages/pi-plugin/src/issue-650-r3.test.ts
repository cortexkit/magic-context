/**
 * Pi tag identity (GitHub issue 650): no tag-identity conflict may refuse more
 * than one turn. These tests cover the position-independent fallback id given
 * to messages without a real entry id, the re-key of rows an older build
 * stored under the index-bearing `pi-msg-<index>-…` id, a duplicate message
 * identity that comes back after its one repair, and a session decision
 * ledger (session_meta's bounded list of durable Pi decisions) too full to
 * record a repair.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import {
	encodePiContentDecision,
	PI_CONTENT_DECISION_LIMIT,
	PI_IDENTITY_RECURRENCE_ALLOWANCE,
} from "@magic-context/core/features/magic-context/pi-content-decisions";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import { saveSourceContent } from "@magic-context/core/features/magic-context/storage-source";
import { insertTag } from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import * as logger from "@magic-context/core/shared/logger";
import {
	type Database,
	getTagIdentityWriteGeneration,
} from "@magic-context/core/shared/sqlite";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { piMessageEntryFingerprint } from "./pi-message-identity";
import {
	readPiIdentityRebuilds,
	readPiIdentityRecurrences,
} from "./pi-tag-identity-repair";
import { isPiContentFallbackId, piContentFallbackIds } from "./read-session-pi";
import {
	capturePiServedArray,
	clearPiServedArraySession,
} from "./served-array-ledger";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	userMessage,
} from "./test-utils.test";

const usedSessions: string[] = [];

afterEach(() => {
	resetLkgSlotsForTest();
	for (const sessionId of usedSessions.splice(0)) {
		clearPiServedArraySession(sessionId);
		clearContextHandlerSession(sessionId);
	}
});

function session(name: string): string {
	const id = `650-r3-${name}-${Math.random().toString(36).slice(2, 8)}`;
	usedSessions.push(id);
	return id;
}

const none = () => undefined;

test("issue 650 r3: an unmapped message keeps one fallback id wherever it sits", () => {
	const note = userMessage("Context notes: build is green", 5);
	const other = userMessage("hello", 10);
	const [atZero] = piContentFallbackIds([note, other], none);
	const shifted = piContentFallbackIds(
		[userMessage("x", 1), other, structuredClone(note)],
		none,
	);
	expect(atZero).toBeDefined();
	expect(isPiContentFallbackId(atZero!)).toBe(true);
	// Same header and content: same id at index 0 and index 2.
	expect(shifted[2]).toBe(atZero);
	// The timestamp and role suffix stay readable by the tool-owner parser.
	expect(atZero).toEndWith("-5-user");
	// A different message gets a different digest.
	expect(shifted[1]).not.toBe(atZero);
});

test("issue 650 r3: exact duplicates in one array are told apart by occurrence, real ids get none", () => {
	const note = userMessage("same", 7);
	const ids = piContentFallbackIds(
		[note, structuredClone(note), userMessage("mapped", 8)],
		(_message, index) => (index === 2 ? "real" : undefined),
	);
	expect(ids[0]).toMatch(/^pi-msg-c[0-9a-f]{16}o0-7-user$/);
	expect(ids[1]).toBe(ids[0]?.replace("o0-", "o1-"));
	expect(ids[2]).toBeUndefined();
});

/** Serve one pass; the branch holds only `hello`, so `note` is never mapped. */
async function serveNote(db: Database, sessionId: string, input: PiMessage[]) {
	const hello = input.find(
		(message) => (message as { content?: unknown }).content === "hello",
	)!;
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db, protectedTags: 0 });
	const result = (await fake.handlers.get("context")!(
		{ messages: structuredClone(input) } as never,
		fakeContext(sessionId, process.cwd(), ["hello"], [hello]) as never,
	)) as { messages: unknown[] };
	return JSON.stringify(result.messages);
}

test("issue 650 r3: a row an older build stored under an index-bearing id moves to the new id with its number", async () => {
	const db = createTestDb();
	const sessionId = session("legacy-rekey");
	try {
		const note = userMessage("Context notes: build is green", 5);
		const hello = userMessage("hello", 10);
		updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
		// The older build tagged the note under its index (it sat at index 1).
		insertTag(
			db,
			sessionId,
			"pi-msg-1-5-user:p0",
			"message",
			40,
			42,
			0,
			null,
			0,
			null,
			piMessageEntryFingerprint(note),
		);
		saveSourceContent(db, sessionId, 42, "Context notes: build is green");
		capturePiServedArray(sessionId, [userMessage("§42§ Context notes", 5)], {
			servedTagNumbers: [42],
		});
		// The note now sits at index 0, so an index-bearing id would differ from
		// the stored `pi-msg-1-…` one; the content-based id does not.
		const served = await serveNote(db, sessionId, [note, hello]);
		expect(served).toContain("§42§ Context notes: build is green");
		const rows = db
			.prepare(
				"SELECT tag_number, message_id FROM tags WHERE session_id = ? AND type = 'message' AND tag_number = 42",
			)
			.all(sessionId) as { tag_number: number; message_id: string }[];
		expect(rows).toHaveLength(1);
		expect(isPiContentFallbackId(rows[0]!.message_id)).toBe(true);
		// The next pass serves the note with the same number again.
		expect(await serveNote(db, sessionId, [note, hello])).toBe(served);
	} finally {
		db.close();
	}
});

test("issue 650 r3: re-keying an older build's message row counts as a tag identity write", () => {
	// Caches built from the tags table (the reasoning-budget and tag summaries)
	// rebuild only when the identity-write generation moves; a row moving from
	// `pi-msg-<index>-…` to the position-independent id changes its message id.
	const db = createTestDb();
	const sessionId = session("rekey-generation");
	try {
		const note = userMessage("Context notes: build is green", 5);
		const fingerprint = piMessageEntryFingerprint(note)!;
		insertTag(
			db,
			sessionId,
			"pi-msg-1-5-user:p0",
			"message",
			40,
			42,
			0,
			null,
			0,
			null,
			fingerprint,
		);
		const [fallbackId] = piContentFallbackIds([note], none);
		const before = getTagIdentityWriteGeneration();
		__test.adoptPiFallbackTags(
			db,
			sessionId,
			createTagger(),
			new Map([[fallbackId!, fingerprint]]),
			{ allowUnprovenRebuild: true },
		);
		expect(
			db
				.prepare("SELECT message_id FROM tags WHERE session_id = ?")
				.get(sessionId),
		).toEqual({ message_id: `${fallbackId}:p0` });
		expect(getTagIdentityWriteGeneration()).toBeGreaterThan(before);
	} finally {
		db.close();
	}
});

function seedMessageRow(
	db: Database,
	sessionId: string,
	messageId: string,
	number: number,
	fingerprint: string,
) {
	insertTag(
		db,
		sessionId,
		messageId,
		"message",
		40,
		number,
		0,
		null,
		0,
		null,
		fingerprint,
	);
}

function adoptReal(db: Database, sessionId: string, fingerprint: string) {
	return __test.adoptPiFallbackTags(
		db,
		sessionId,
		createTagger(),
		new Map([["real", fingerprint]]),
		{ allowUnprovenRebuild: true },
	);
}

function messageNumbers(db: Database, sessionId: string): unknown[] {
	return db
		.prepare(
			"SELECT tag_number, message_id FROM tags WHERE session_id = ? AND type = 'message' ORDER BY tag_number",
		)
		.all(sessionId);
}

test("issue 650 r3: a message duplicate that recurs after its repair is served without a second rebuild", () => {
	const db = createTestDb();
	const sessionId = session("message-recurrence");
	try {
		const fingerprint = piMessageEntryFingerprint(userMessage("same", 7))!;
		seedMessageRow(db, sessionId, "real:p0", 20, fingerprint);
		seedMessageRow(db, sessionId, "pi-msg-0-7-user:p0", 440, fingerprint);
		capturePiServedArray(sessionId, [], { servedTagNumbers: [20, 440] });
		clearPiServedArraySession(sessionId);
		expect(adoptReal(db, sessionId, fingerprint).rebuilds).toHaveLength(1);
		// Another row for the same message part appears under a third number
		// (a writer that should not exist, as in the guard tests).
		seedMessageRow(db, sessionId, "pi-msg-3-7-user:p0", 600, fingerprint);
		capturePiServedArray(sessionId, [], { servedTagNumbers: [600] });
		clearPiServedArraySession(sessionId);
		const again = adoptReal(db, sessionId, fingerprint);
		expect(again.rebuilds.map((repair) => repair.kept)).toEqual([440]);
		// The once guard is keyed on the message itself (fingerprint and part
		// ordinal), not on the id its rows currently sit under.
		expect(readPiIdentityRecurrences(db, sessionId)).toEqual([
			JSON.stringify(["message", fingerprint, 0]),
		]);
		expect(messageNumbers(db, sessionId)).toEqual([
			{ tag_number: 440, message_id: "real:p0" },
			{ tag_number: 600, message_id: "pi-msg-3-7-user:p0" },
		]);
	} finally {
		db.close();
	}
});

function fillDecisionLedger(db: Database, sessionId: string, count: number) {
	updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
	const entries = Array.from({ length: count }, (_, n) =>
		encodePiContentDecision("tag-identity-repair-once", `filler-${n}`),
	);
	db.prepare(
		"UPDATE session_meta SET merged_reasoning_stripped_ids = ? WHERE session_id = ?",
	).run(JSON.stringify(entries), sessionId);
}

for (const free of [0, 1] as const) {
	test(`issue 650 r3: a decision ledger with ${free} free slot(s) never refuses the duplicate`, () => {
		// The once guard lives in the identity fold-guard row, so a full shared
		// ledger cannot block it. With no slot the pending rebuild cannot be
		// recorded and the fold is undone: the duplicate is served unmerged.
		// With one slot the pending rebuild fits and the one repair goes ahead.
		const db = createTestDb();
		const sessionId = session(`ledger-${free}`);
		try {
			fillDecisionLedger(db, sessionId, PI_CONTENT_DECISION_LIMIT - free);
			const fingerprint = piMessageEntryFingerprint(userMessage("same", 7))!;
			seedMessageRow(db, sessionId, "real:p0", 20, fingerprint);
			seedMessageRow(db, sessionId, "pi-msg-0-7-user:p0", 440, fingerprint);
			capturePiServedArray(sessionId, [], { servedTagNumbers: [20, 440] });
			clearPiServedArraySession(sessionId);
			const outcome = adoptReal(db, sessionId, fingerprint);
			if (free === 0) {
				expect(outcome.rebuilds).toEqual([]);
				expect(readPiIdentityRebuilds(db, sessionId)).toEqual([]);
				expect(messageNumbers(db, sessionId)).toEqual([
					{ tag_number: 20, message_id: "real:p0" },
					{ tag_number: 440, message_id: "pi-msg-0-7-user:p0" },
				]);
			} else {
				expect(outcome.rebuilds.map((repair) => repair.kept)).toEqual([440]);
				expect(messageNumbers(db, sessionId)).toEqual([
					{ tag_number: 440, message_id: "real:p0" },
				]);
			}
		} finally {
			db.close();
		}
	});
}

test("issue 650 r3: a ledger with no room even for recurrence records logs the unmerged duplicate once per process", () => {
	// Past the recurrence allowance nothing can be recorded; the in-memory note
	// still keeps the log to one line instead of one per turn.
	const db = createTestDb();
	const sessionId = session("ledger-overfull");
	const log = spyOn(logger, "sessionLog");
	try {
		fillDecisionLedger(
			db,
			sessionId,
			PI_CONTENT_DECISION_LIMIT + PI_IDENTITY_RECURRENCE_ALLOWANCE,
		);
		const fingerprint = piMessageEntryFingerprint(userMessage("same", 7))!;
		seedMessageRow(db, sessionId, "real:p0", 20, fingerprint);
		seedMessageRow(db, sessionId, "pi-msg-0-7-user:p0", 440, fingerprint);
		capturePiServedArray(sessionId, [], { servedTagNumbers: [20, 440] });
		clearPiServedArraySession(sessionId);
		for (let n = 0; n < 3; n++)
			expect(adoptReal(db, sessionId, fingerprint).rebuilds).toEqual([]);
		expect(readPiIdentityRecurrences(db, sessionId)).toEqual([]);
		expect(
			log.mock.calls.filter(([, line]) =>
				String(line).includes("tag identity recurred after its one repair"),
			),
		).toHaveLength(1);
	} finally {
		log.mockRestore();
		db.close();
	}
});
