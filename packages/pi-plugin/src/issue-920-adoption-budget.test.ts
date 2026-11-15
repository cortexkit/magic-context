import { afterEach, expect, spyOn, test } from "bun:test";
import { encodePiContentDecision } from "@magic-context/core/features/magic-context/pi-content-decisions";
import {
	PI_IDENTITY_FOLD_GUARD_LIMIT,
	readPiIdentityFoldGuards,
	writePiIdentityFoldGuards,
} from "@magic-context/core/features/magic-context/pi-identity-fold-guards";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import { insertTag } from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import * as logger from "@magic-context/core/shared/logger";
import {
	type Database,
	guardSqliteTransformPass,
	withSqliteTransformPass,
} from "@magic-context/core/shared/sqlite";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { PiContextDeadlineError } from "./pi-context-budget";
import { piMessageEntryFingerprint } from "./pi-message-identity";
import {
	capturePiServedArray,
	clearPiServedArraySession,
} from "./served-array-ledger";
import {
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

// A large session whose tool calls were each tagged twice: once under a
// temporary `pi-msg-*` owner while the assistant entry was in flight (the
// number that was served), and once more under the real entry id. Folding
// every duplicate is more work than one pass may spend.
const DUPLICATES = 600;

const sessions: string[] = [];
afterEach(() => {
	for (const id of sessions.splice(0)) {
		clearContextHandlerSession(id);
		clearPiServedArraySession(id);
	}
});

function seedDuplicates(
	db: Database,
	name: string,
	{ count = DUPLICATES, servedBoth = false } = {},
) {
	const sessionId = `issue-920-${name}-${Math.random().toString(36).slice(2)}`;
	sessions.push(sessionId);
	updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
	const messages: PiMessage[] = [];
	const ids: string[] = [];
	db.exec("BEGIN");
	for (let n = 0; n < count; n++) {
		const timestamp = 1_000 + n;
		messages.push(assistantToolCall(`call-${n}`, "read", { n }, timestamp));
		ids.push(`real-${n}`);
		insertTag(
			db,
			sessionId,
			`call-${n}`,
			"tool",
			100,
			n + 1,
			0,
			"read",
			40,
			`pi-msg-${n}-${timestamp}-assistant`,
		);
		insertTag(
			db,
			sessionId,
			`call-${n}`,
			"tool",
			100,
			count + n + 1,
			0,
			"read",
			40,
			`real-${n}`,
		);
	}
	db.exec("COMMIT");
	// Only the temporary owner's number was served, which proves it survives;
	// with both served, nothing proves either and a repair must be declared.
	capturePiServedArray(sessionId, [], {
		servedTagNumbers: Array.from(
			{ length: servedBoth ? count * 2 : count },
			(_, n) => n + 1,
		),
	});
	clearPiServedArraySession(sessionId);
	return { sessionId, messages, ids };
}

function adopt(
	db: Database,
	seed: ReturnType<typeof seedDuplicates>,
	remainingMs?: () => number,
) {
	return __test.adoptPiFallbackTags(
		db,
		seed.sessionId,
		createTagger(),
		new Map(),
		{
			allowUnprovenRebuild: true,
			messages: seed.messages,
			resolveStableId: (_message: unknown, index: number) => seed.ids[index],
			remainingMs,
		},
	);
}

function unmerged(db: Database, sessionId: string): number {
	return (
		db
			.prepare(
				"SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND tool_owner_message_id LIKE 'pi-msg-%'",
			)
			.get(sessionId) as { n: number }
	).n;
}

/** Run `work` as a transform pass whose write guard counts every guarded statement. */
function guarded<T>(onAssert: () => void, work: () => T): T {
	return withSqliteTransformPass(() => {
		guardSqliteTransformPass({ assert: onAssert, remainingMs: () => 60_000 });
		return work();
	});
}

test("issue 920: a pass deadline during fallback adoption ends the pass and keeps the chunks already committed", () => {
	const calibrationDb = createTestDb();
	const db = createTestDb();
	const log = spyOn(logger, "sessionLog");
	try {
		// Count the guarded statements a complete adoption runs, then end a
		// second, identical adoption past the middle of that work.
		let total = 0;
		const calibration = seedDuplicates(calibrationDb, "calibration");
		guarded(
			() => {
				total++;
			},
			() => adopt(calibrationDb, calibration),
		);
		expect(unmerged(calibrationDb, calibration.sessionId)).toBe(0);
		const seed = seedDuplicates(db, "deadline");
		let asserts = 0;
		expect(() =>
			guarded(
				() => {
					if (++asserts > total * 0.6)
						throw new PiContextDeadlineError("stage=pipeline");
				},
				() => adopt(db, seed),
			),
		).toThrow(PiContextDeadlineError);
		const folded = DUPLICATES - unmerged(db, seed.sessionId);
		// The deadline is not contained as an unwritable decision...
		expect(
			log.mock.calls.filter(([, line]) =>
				String(line).includes("could not be written"),
			),
		).toEqual([]);
		// ...and the work committed before it stays, guarded, for the next pass.
		expect(folded).toBeGreaterThan(0);
		expect(folded).toBeLessThan(DUPLICATES);
		expect(readPiIdentityFoldGuards(db, seed.sessionId).size).toBe(folded);
		adopt(db, seed);
		expect(unmerged(db, seed.sessionId)).toBe(0);
		expect(readPiIdentityFoldGuards(db, seed.sessionId).size).toBe(DUPLICATES);
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND tag_number > ?",
				)
				.get(seed.sessionId, DUPLICATES),
		).toEqual({ n: 0 });
	} finally {
		log.mockRestore();
		calibrationDb.close();
		db.close();
	}
});

test("issue 920: a repair larger than the pass budget pauses, logs once and continues on the next pass", () => {
	const db = createTestDb();
	const log = spyOn(logger, "sessionLog");
	try {
		const seed = seedDuplicates(db, "budget");
		let duplicatesSeen = 0;
		// Plenty of time for the first 400 duplicates, then the reserve is reached.
		adopt(db, seed, () => (++duplicatesSeen <= 400 ? 20_000 : 5_000));
		expect(unmerged(db, seed.sessionId)).toBe(DUPLICATES - 400);
		expect(readPiIdentityFoldGuards(db, seed.sessionId).size).toBe(400);
		const paused = log.mock.calls.filter(([, line]) =>
			String(line).includes("tag identity adoption reached the pass budget"),
		);
		expect(paused).toHaveLength(1);
		expect(String(paused[0]?.[1])).toContain(`${DUPLICATES - 400} duplicated`);
		adopt(db, seed, () => 20_000);
		expect(unmerged(db, seed.sessionId)).toBe(0);
	} finally {
		log.mockRestore();
		db.close();
	}
});

test("issue 920: a full fold-guard row leaves duplicates unmerged with one count line per pass", () => {
	const db = createTestDb();
	const log = spyOn(logger, "sessionLog");
	try {
		const seed = seedDuplicates(db, "full");
		writePiIdentityFoldGuards(
			db,
			seed.sessionId,
			new Set(
				Array.from(
					{ length: PI_IDENTITY_FOLD_GUARD_LIMIT },
					(_, n) => `filler-${n}`,
				),
			),
		);
		for (let pass = 0; pass < 2; pass++) adopt(db, seed);
		// A pass that reaches its budget does not count these as waiting for a
		// fold: no guard can be stored for them on any later pass either.
		adopt(db, seed, () => 5_000);
		expect(unmerged(db, seed.sessionId)).toBe(DUPLICATES);
		const lines = log.mock.calls
			.map(([, line]) => String(line))
			.filter((line) => line.includes("tag identity"));
		expect(lines).toEqual([
			`tag identity repairs without a stored guard: ${DUPLICATES} duplicated identities served unmerged this pass (guard store full or unreadable)`,
			`tag identity repairs without a stored guard: ${DUPLICATES} duplicated identities served unmerged this pass (guard store full or unreadable)`,
		]);
	} finally {
		log.mockRestore();
		db.close();
	}
});

test("issue 920: a once-guard an older build wrote to the shared ledger still prevents a second repair", () => {
	const db = createTestDb();
	try {
		// Both numbers served: neither is proven, so each identity needs its one
		// declared repair, which the legacy guard says call-0 already had.
		const seed = seedDuplicates(db, "legacy", { count: 2, servedBoth: true });
		const spent = JSON.stringify(["tool", 1_000, "call-0"]);
		db.prepare(
			"UPDATE session_meta SET merged_reasoning_stripped_ids = ? WHERE session_id = ?",
		).run(
			JSON.stringify([
				encodePiContentDecision("tag-identity-repair-once", spent),
			]),
			seed.sessionId,
		);
		const outcome = adopt(db, seed);
		expect(outcome.rebuilds.map((repair) => repair.kept)).toEqual([4]);
		expect(unmerged(db, seed.sessionId)).toBe(1);
		expect([...readPiIdentityFoldGuards(db, seed.sessionId)]).toEqual([
			JSON.stringify(["tool", 1_001, "call-1"]),
		]);
	} finally {
		db.close();
	}
});

test("issue 920: a pass that pauses folds at the budget serves without refusing, keeps its re-keys, and a later pass finishes", async () => {
	const db = createTestDb();
	const sessionId = `issue-920-pause-${Math.random().toString(36).slice(2)}`;
	sessions.push(sessionId);
	const log = spyOn(logger, "sessionLog");
	// Make every duplicate fold wait for a later pass, as a pass that already
	// spent its budget would; plain re-keys still run.
	const restoreReserve = __test.setPiAdoptionReserveMsForTests(25_000);
	try {
		updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
		const duplicates = 20;
		const rekeys = 5;
		const input: PiMessage[] = [userMessage("go", 1)];
		const ids = ["user"];
		let number = 0;
		for (let n = 0; n < duplicates + rekeys; n++) {
			const timestamp = 100 + n * 2;
			input.push(assistantToolCall(`call-${n}`, "read", { n }, timestamp));
			input.push(toolResultMessage(`call-${n}`, `out ${n}`, timestamp + 1));
			ids.push(`real-${n}`, `result-${n}`);
			insertTag(
				db,
				sessionId,
				`call-${n}`,
				"tool",
				100,
				++number,
				0,
				"read",
				40,
				`pi-msg-${input.length - 2}-${timestamp}-assistant`,
			);
		}
		const served = Array.from({ length: number }, (_, n) => n + 1);
		for (let n = 0; n < duplicates; n++)
			insertTag(
				db,
				sessionId,
				`call-${n}`,
				"tool",
				100,
				++number,
				0,
				"read",
				40,
				`real-${n}`,
			);
		capturePiServedArray(sessionId, [], { servedTagNumbers: served });
		clearPiServedArraySession(sessionId);
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, { db, protectedTags: 0 });
		const ctx = fakeContext(sessionId, process.cwd(), ids, input);
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("no context handler registered");
		const pass = async () =>
			JSON.stringify(
				(
					(await handler(
						{ messages: structuredClone(input) } as never,
						ctx as never,
					)) as { messages: unknown[] }
				).messages,
			);
		const first = await pass();
		expect(first).not.toContain("could not safely prepare this turn");
		expect(unmerged(db, sessionId)).toBe(duplicates);
		// The re-keys were committed even though every fold waited.
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND tool_owner_message_id LIKE 'real-%'",
				)
				.get(sessionId),
		).toEqual({ n: duplicates + rekeys });
		expect(
			log.mock.calls
				.map(([, line]) => String(line))
				.filter((line) =>
					line.includes("tag identity adoption reached the pass budget"),
				),
		).toEqual([
			`tag identity adoption reached the pass budget: session=${sessionId} ${duplicates} duplicated identities stay unmerged until the next pass`,
		]);
		restoreReserve();
		const second = await pass();
		expect(second).not.toContain("could not safely prepare this turn");
		expect(unmerged(db, sessionId)).toBe(0);
		expect(readPiIdentityFoldGuards(db, sessionId).size).toBe(duplicates);
	} finally {
		restoreReserve();
		log.mockRestore();
		db.close();
	}
});

/**
 * `count` message parts tagged twice: under a temporary `pi-msg-*` id (the
 * served number) and under the real entry id. `plain` more parts have only the
 * temporary row, which just moves to the real id.
 */
function seedMessageDuplicates(
	db: Database,
	name: string,
	{ count, plain = 0 }: { count: number; plain?: number },
) {
	const sessionId = `issue-920-${name}-${Math.random().toString(36).slice(2)}`;
	sessions.push(sessionId);
	updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
	const fingerprints = new Map<string, string>();
	db.exec("BEGIN");
	for (let n = 0; n < count + plain; n++) {
		const timestamp = 1_000 + n;
		const fingerprint = piMessageEntryFingerprint(
			userMessage(`message ${n}`, timestamp),
		);
		if (!fingerprint) throw new Error("no fingerprint");
		fingerprints.set(`real-${n}`, fingerprint);
		insertTag(
			db,
			sessionId,
			`pi-msg-${n}-${timestamp}-user:p0`,
			"message",
			40,
			n + 1,
			0,
			null,
			0,
			null,
			fingerprint,
		);
		if (n < count)
			insertTag(
				db,
				sessionId,
				`real-${n}:p0`,
				"message",
				40,
				count + plain + n + 1,
				0,
				null,
				0,
				null,
				fingerprint,
			);
	}
	db.exec("COMMIT");
	// Only the temporary rows' numbers were served: each fold is proven.
	capturePiServedArray(sessionId, [], {
		servedTagNumbers: Array.from({ length: count + plain }, (_, n) => n + 1),
	});
	clearPiServedArraySession(sessionId);
	return { sessionId, fingerprints };
}

function adoptMessages(
	db: Database,
	seed: ReturnType<typeof seedMessageDuplicates>,
	remainingMs?: () => number,
) {
	return __test.adoptPiFallbackTags(
		db,
		seed.sessionId,
		createTagger(),
		seed.fingerprints,
		{ allowUnprovenRebuild: true, remainingMs },
	);
}

function messageIds(db: Database, sessionId: string): unknown[] {
	return db
		.prepare(
			"SELECT tag_number, message_id FROM tags WHERE session_id = ? AND type = 'message' ORDER BY tag_number",
		)
		.all(sessionId);
}

test("issue 920: an unwritable fold guard leaves only the message duplicate unmerged", () => {
	const db = createTestDb();
	const log = spyOn(logger, "sessionLog");
	try {
		const seed = seedMessageDuplicates(db, "message-guard", {
			count: 1,
			plain: 1,
		});
		for (const event of ["INSERT", "UPDATE"])
			db.exec(
				`CREATE TRIGGER fail_guard_${event} BEFORE ${event} ON schema_migrations_meta WHEN NEW.key LIKE 'pi_identity_fold_guards:%' BEGIN SELECT RAISE(FAIL, 'injected guard write failure'); END`,
			);
		const outcome = adoptMessages(db, seed);
		expect(outcome.rebuilds).toEqual([]);
		expect(messageIds(db, seed.sessionId)).toEqual([
			// The duplicate needs a guard that cannot be stored: both rows stay.
			{ tag_number: 1, message_id: "pi-msg-0-1000-user:p0" },
			// The plain re-key needs no guard and is committed.
			{ tag_number: 2, message_id: "real-1:p0" },
			{ tag_number: 3, message_id: "real-0:p0" },
		]);
		expect(readPiIdentityFoldGuards(db, seed.sessionId).size).toBe(0);
		expect(
			log.mock.calls.filter(([, line]) =>
				String(line).includes("tag identity fold guards could not be written"),
			),
		).toHaveLength(1);
	} finally {
		log.mockRestore();
		db.close();
	}
});

test("issue 920: message-duplicate folds pause at the pass budget and continue on the next pass", () => {
	const db = createTestDb();
	const log = spyOn(logger, "sessionLog");
	try {
		const count = 300;
		const seed = seedMessageDuplicates(db, "message-budget", { count });
		let duplicatesSeen = 0;
		adoptMessages(db, seed, () => (++duplicatesSeen <= 100 ? 20_000 : 5_000));
		const temporary = () =>
			(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND message_id LIKE 'pi-msg-%'",
					)
					.get(seed.sessionId) as { n: number }
			).n;
		expect(temporary()).toBe(count - 100);
		expect(readPiIdentityFoldGuards(db, seed.sessionId).size).toBe(100);
		expect(
			log.mock.calls
				.map(([, line]) => String(line))
				.filter((line) => line.includes("reached the pass budget")),
		).toEqual([
			`tag identity adoption reached the pass budget: session=${seed.sessionId} ${count - 100} duplicated identities stay unmerged until the next pass`,
		]);
		adoptMessages(db, seed, () => 20_000);
		expect(temporary()).toBe(0);
		expect(readPiIdentityFoldGuards(db, seed.sessionId).size).toBe(count);
	} finally {
		log.mockRestore();
		db.close();
	}
});
