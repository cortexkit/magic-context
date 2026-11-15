/**
 * Review findings for the change to Pi fallback-tag adoption
 * (chunked commits, a pass budget for duplicate folds, and once-guards moved
 * to their own `schema_migrations_meta` row). Each test describes a property
 * the change claims or must keep, and fails while that property is broken.
 */
import { Database as BunDatabase } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
	piIdentityFoldGuardKey,
	readPiIdentityFoldGuards,
} from "@magic-context/core/features/magic-context/pi-identity-fold-guards";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import { insertTag } from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	type Database,
	guardSqliteTransformPass,
	withSqliteTransformPass,
} from "@magic-context/core/shared/sqlite";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";
import { __test, clearContextHandlerSession } from "./context-handler";
import { PiContextDeadlineError } from "./pi-context-budget";
import { piMessageEntryFingerprint } from "./pi-message-identity";
import { claimPiIdentityRepair } from "./pi-tag-identity-repair";
import {
	capturePiServedArray,
	clearPiServedArraySession,
} from "./served-array-ledger";
import {
	assistantToolCall,
	createTestDb,
	type PiMessage,
	userMessage,
} from "./test-utils.test";

const sessions: string[] = [];
afterEach(() => {
	for (const id of sessions.splice(0)) {
		clearContextHandlerSession(id);
		clearPiServedArraySession(id);
	}
});

function session(name: string): string {
	const id = `issue-920-review-${name}-${Math.random().toString(36).slice(2)}`;
	sessions.push(id);
	return id;
}

function toolOwners(db: Database, sessionId: string) {
	return db
		.prepare(
			"SELECT tag_number, message_id, tool_owner_message_id AS owner FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number",
		)
		.all(sessionId);
}

test("review issue 920: a fold guard that cannot be written does not undo the plain re-keys of its chunk", () => {
	// call-0 was tagged twice (temporary owner 1, served; real owner 3), so
	// folding it needs a once-guard. call-1 has only its temporary-owner row
	// (2), which just moves to the real owner. Adoption promises that plain
	// re-keys always run: left undone, tagging allocates call-1 a second
	// number. Before the guards were batched per chunk, an unwritable guard
	// only left its own identity unmerged.
	const db = createTestDb();
	const sessionId = session("unwritten-guard");
	try {
		updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
		insertTag(
			db,
			sessionId,
			"call-0",
			"tool",
			100,
			1,
			0,
			"read",
			40,
			"pi-msg-0-1000-assistant",
		);
		insertTag(
			db,
			sessionId,
			"call-1",
			"tool",
			100,
			2,
			0,
			"read",
			40,
			"pi-msg-1-1001-assistant",
		);
		insertTag(db, sessionId, "call-0", "tool", 100, 3, 0, "read", 40, "real-0");
		capturePiServedArray(sessionId, [], { servedTagNumbers: [1, 2] });
		clearPiServedArraySession(sessionId);
		for (const event of ["INSERT", "UPDATE"])
			db.exec(
				`CREATE TRIGGER review_fail_guard_${event} BEFORE ${event} ON schema_migrations_meta WHEN NEW.key LIKE 'pi_identity_fold_guards:%' BEGIN SELECT RAISE(FAIL, 'injected guard write failure'); END`,
			);
		const messages: PiMessage[] = [
			assistantToolCall("call-0", "read", { n: 0 }, 1000),
			assistantToolCall("call-1", "read", { n: 1 }, 1001),
		];
		const ids = ["real-0", "real-1"];
		__test.adoptPiFallbackTags(db, sessionId, createTagger(), new Map(), {
			allowUnprovenRebuild: true,
			messages,
			resolveStableId: (_message: unknown, index: number) => ids[index],
		});
		expect(toolOwners(db, sessionId)).toEqual([
			// The duplicate stays unmerged: its guard could not be stored.
			{ tag_number: 1, message_id: "call-0", owner: "pi-msg-0-1000-assistant" },
			// The plain re-key needs no guard and must still be committed.
			{ tag_number: 2, message_id: "call-1", owner: "real-1" },
			{ tag_number: 3, message_id: "call-0", owner: "real-0" },
		]);
	} finally {
		db.close();
	}
});

test("review issue 920: claiming a repair outside adoption keeps a guard another connection stored meanwhile", () => {
	// claimPiIdentityRepair (used for identical unmapped messages) reads the
	// session's whole guard row and writes it back. Another connection, such
	// as a second process serving the same session, can commit a guard for a
	// fold of its own between that read and that write. The shared ledger the
	// guards used to live in was updated with a compare-and-swap, so neither
	// write was lost.
	const { dir, cleanup } = createTestTempDir("pi-fold-guard-race-");
	const path = join(dir, "context.db");
	const db = createTestDb(path);
	const other = new BunDatabase(path);
	const sessionId = session("lost-guard");
	const key = piIdentityFoldGuardKey(sessionId);
	const otherGuard = JSON.stringify(["tool", 5, "call-other"]);
	const ownGuard = JSON.stringify(["message-occurrence", "abc"]);
	try {
		other.exec("PRAGMA busy_timeout = 0");
		updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
		/** The other connection's own correct read-modify-write; false when the writer is held. */
		const storeOtherGuard = (): boolean => {
			try {
				other.exec("BEGIN IMMEDIATE");
			} catch {
				return false;
			}
			try {
				const row = other
					.query("SELECT value FROM schema_migrations_meta WHERE key = ?")
					.get(key) as { value: string } | null;
				const guards = new Set<string>(row ? JSON.parse(row.value) : []);
				guards.add(otherGuard);
				other
					.query(
						"INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
					)
					.run(key, JSON.stringify([...guards]));
				other.exec("COMMIT");
				return true;
			} catch (error) {
				other.exec("ROLLBACK");
				throw error;
			}
		};
		let attempted = false;
		let stored = false;
		const bind = (target: object, prop: string | symbol) => {
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		};
		// Let the other connection commit right after this one has read the
		// guard row. If the claim holds the writer at that point, the other
		// connection's commit waits until the claim has finished.
		const interleaved = new Proxy(db, {
			get(target, prop) {
				if (prop !== "prepare") return bind(target, prop);
				return (sql: string) => {
					const statement = target.prepare(sql);
					if (!/FROM schema_migrations_meta WHERE key = \?/.test(sql))
						return statement;
					return new Proxy(statement, {
						get(inner, name) {
							if (name !== "get") return bind(inner, name);
							return (...args: unknown[]) => {
								const row = (inner.get as (...a: unknown[]) => unknown)(
									...args,
								);
								if (!attempted && args[0] === key) {
									attempted = true;
									stored = storeOtherGuard();
								}
								return row;
							};
						},
					});
				};
			},
		}) as Database;
		expect(claimPiIdentityRepair(interleaved, sessionId, ownGuard)).toBe(
			"claimed",
		);
		expect(attempted).toBe(true);
		if (!stored) expect(storeOtherGuard()).toBe(true);
		expect([...readPiIdentityFoldGuards(db, sessionId)].sort()).toEqual(
			[ownGuard, otherGuard].sort(),
		);
	} finally {
		other.close();
		db.close();
		cleanup();
	}
});

test("review issue 920: a pass deadline during message-duplicate adoption keeps the folds made before it", () => {
	// Message duplicates are folded in the first writer transaction together
	// with all other message adoption, with no row or time bound. A deadline
	// inside that work rolls every one of them back, so a later pass that
	// meets the same deadline makes no progress, the problem the chunked
	// commits solved for tool duplicates.
	const count = 300;
	const seed = (db: Database, name: string) => {
		const sessionId = session(name);
		updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
		const fingerprints = new Map<string, string>();
		db.exec("BEGIN");
		for (let n = 0; n < count; n++) {
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
			insertTag(
				db,
				sessionId,
				`real-${n}:p0`,
				"message",
				40,
				count + n + 1,
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
			servedTagNumbers: Array.from({ length: count }, (_, n) => n + 1),
		});
		clearPiServedArraySession(sessionId);
		return { sessionId, fingerprints };
	};
	const adopt = (db: Database, seeded: ReturnType<typeof seed>) =>
		__test.adoptPiFallbackTags(
			db,
			seeded.sessionId,
			createTagger(),
			seeded.fingerprints,
			{ allowUnprovenRebuild: true },
		);
	const guarded = <T>(onAssert: () => void, work: () => T): T =>
		withSqliteTransformPass(() => {
			guardSqliteTransformPass({ assert: onAssert, remainingMs: () => 60_000 });
			return work();
		});
	const unmerged = (db: Database, sessionId: string) =>
		(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND type = 'message' AND message_id LIKE 'pi-msg-%'",
				)
				.get(sessionId) as { n: number }
		).n;
	const calibrationDb = createTestDb();
	const db = createTestDb();
	try {
		let total = 0;
		const calibration = seed(calibrationDb, "message-calibration");
		guarded(
			() => {
				total++;
			},
			() => adopt(calibrationDb, calibration),
		);
		expect(unmerged(calibrationDb, calibration.sessionId)).toBe(0);
		const seeded = seed(db, "message-deadline");
		let asserts = 0;
		expect(() =>
			guarded(
				() => {
					if (++asserts > total * 0.6)
						throw new PiContextDeadlineError("stage=pipeline");
				},
				() => adopt(db, seeded),
			),
		).toThrow(PiContextDeadlineError);
		expect(count - unmerged(db, seeded.sessionId)).toBeGreaterThan(0);
	} finally {
		calibrationDb.close();
		db.close();
	}
});
