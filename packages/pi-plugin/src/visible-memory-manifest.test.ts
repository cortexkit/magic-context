import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	archiveMemory,
	insertMemory,
	supersededMemory,
} from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	getOrCreateSessionMeta,
	queueMemoryMutation,
} from "@magic-context/core/features/magic-context/storage";
import {
	encodeCachedM0UpgradeIdentity,
	withCachedM0MemoryIds,
} from "@magic-context/core/hooks/magic-context/compartment-render-epoch";
import { renderMemoryBlockV2 } from "@magic-context/core/hooks/magic-context/inject-compartments";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { createTestTempDirFromPath } from "@magic-context/core/shared/test-temp-dir";
import {
	injectM0M1Pi,
	materializeM0Pi,
	mustMaterializePi,
} from "./inject-compartments-pi";
import { createTestDb, userMessage } from "./test-utils.test";

function fixture() {
	const dir = createTestTempDirFromPath(join(tmpdir(), "pi-visible-manifest-"));
	const db = createTestDb(join(dir, "context.db"));
	const state = {
		sessionId: "pi-visible-manifest",
		projectIdentity: "git:visible-manifest",
		projectDirectory: dir,
		injectDocs: false,
	};
	const row = () =>
		db
			.prepare("SELECT * FROM session_meta WHERE session_id = ?")
			.get(state.sessionId);
	const manifest = () => {
		const value = row() as {
			memory_block_ids: string;
			memory_block_count: number;
		};
		return {
			ids: JSON.parse(value.memory_block_ids) as number[],
			count: value.memory_block_count,
		};
	};
	const serveWithResult = (refresh = false) => {
		const messages = [userMessage("tail", 1000)];
		const result = injectM0M1Pi(
			state,
			db,
			messages as never,
			undefined,
			refresh,
		);
		return { prefix: messages.slice(0, 2), result };
	};
	const serve = (refresh = false) => serveWithResult(refresh).prefix;
	return {
		db,
		state,
		row,
		manifest,
		serve,
		serveWithResult,
		close: () => {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("Pi visible-memory manifest", () => {
	it("replays a previous-code snapshot without a HARD fold or byte change on the first upgraded pass", () => {
		const f = fixture();
		try {
			const baseline = insertMemory(f.db, {
				projectPath: f.state.projectIdentity,
				category: "ARCHITECTURE",
				content: "legacy baseline",
			});
			f.serve();
			insertMemory(f.db, {
				projectPath: f.state.projectIdentity,
				category: "ARCHITECTURE",
				content: "legacy delta",
			});
			const before = f.serve(true);
			const legacyIdentity = encodeCachedM0UpgradeIdentity(
				"pi-m0m1-v2:ready",
				"cre2",
				false,
				"m8000-h60000",
				"mre3",
				"m8000-h60000",
			);
			expect(
				getOrCreateSessionMeta(f.db, f.state.sessionId).cachedM0UpgradeState,
			).toBe(withCachedM0MemoryIds(legacyIdentity, [baseline.id]));
			// Previous Pi snapshots recorded only the m[0] ids even with an m[1] delta.
			f.db
				.prepare(
					"UPDATE session_meta SET cached_m0_upgrade_state = ?, memory_block_ids = ?, memory_block_count = 1 WHERE session_id = ?",
				)
				.run(legacyIdentity, JSON.stringify([baseline.id]), f.state.sessionId);
			const row = f.row();
			expect(mustMaterializePi(f.state, f.db).value).toBe(false);
			const upgraded = f.serveWithResult();
			expect(upgraded.result.m0Materialized).toBe(false);
			expect(upgraded.prefix).toEqual(before);
			expect(f.row()).toEqual(row);
		} finally {
			f.close();
		}
	});

	it("ignores adding or changing only frozen ids for HARD decisions and stays SOFT after metadata adoption", () => {
		const f = fixture();
		try {
			const baseline = insertMemory(f.db, {
				projectPath: f.state.projectIdentity,
				category: "ARCHITECTURE",
				content: "unchanged baseline",
			});
			const before = f.serve();
			const legacyIdentity = encodeCachedM0UpgradeIdentity(
				"pi-m0m1-v2:ready",
				"cre2",
				false,
				"m8000-h60000",
				"mre3",
				"m8000-h60000",
			);
			for (const identity of [
				legacyIdentity,
				withCachedM0MemoryIds(legacyIdentity, [baseline.id]),
				withCachedM0MemoryIds(legacyIdentity, []),
			]) {
				f.db
					.prepare(
						"UPDATE session_meta SET cached_m0_upgrade_state = ? WHERE session_id = ?",
					)
					.run(identity, f.state.sessionId);
				expect(mustMaterializePi(f.state, f.db).value).toBe(false);
				const served = f.serveWithResult();
				expect(served.result.m0Materialized).toBe(false);
				expect(served.prefix).toEqual(before);
			}
			f.db
				.prepare(
					"UPDATE session_meta SET cached_m0_upgrade_state = ? WHERE session_id = ?",
				)
				.run(legacyIdentity, f.state.sessionId);
			const delta = insertMemory(f.db, {
				projectPath: f.state.projectIdentity,
				category: "ARCHITECTURE",
				content: "metadata adoption delta",
			});
			const refreshed = f.serveWithResult(true);
			expect(refreshed.result.m0Materialized).toBe(false);
			expect(f.manifest()).toEqual({ ids: [baseline.id, delta.id], count: 2 });
			expect(
				(f.row() as { cached_m0_upgrade_state: string })
					.cached_m0_upgrade_state,
			).toBe(withCachedM0MemoryIds(legacyIdentity, [baseline.id]));
			expect(mustMaterializePi(f.state, f.db).value).toBe(false);
			const next = f.serveWithResult();
			expect(next.result.m0Materialized).toBe(false);
			expect(next.prefix).toEqual(refreshed.prefix);
		} finally {
			f.close();
		}
	});

	it("includes additive m[1] memories and replaces rather than accumulates refreshed ids", () => {
		const f = fixture();
		try {
			f.serve();
			const visible = insertMemory(f.db, {
				projectPath: f.state.projectIdentity,
				category: "ARCHITECTURE",
				content: "visible additive memory",
			});
			const first = f.serve(true);
			expect(JSON.stringify(first)).toContain(
				`#${visible.id}: visible additive memory`,
			);
			expect(f.manifest()).toEqual({ ids: [visible.id], count: 1 });
			expect(f.serve(true)).toEqual(first);
			archiveMemory(f.db, visible.id);
			expect(JSON.stringify(f.serve(true))).not.toContain(`#${visible.id}:`);
			expect(f.manifest()).toEqual({ ids: [], count: 0 });
		} finally {
			f.close();
		}
	});

	it("includes memory added between the m[0] snapshot and fold writer admission", () => {
		const f = fixture();
		const exec = f.db.exec.bind(f.db);
		try {
			let added = 0;
			f.db.exec = (sql) => {
				if (sql === "BEGIN IMMEDIATE" && !added)
					added = insertMemory(f.db, {
						projectPath: f.state.projectIdentity,
						category: "ARCHITECTURE",
						content: "fold delta memory",
					}).id;
				return exec(sql);
			};
			const fold = materializeM0Pi(f.state, f.db);
			expect(fold.m0).not.toContain("fold delta memory");
			expect(fold.m1).toContain(`#${added}: fold delta memory`);
			expect(f.manifest()).toEqual({ ids: [added], count: 1 });
		} finally {
			f.db.exec = exec;
			f.close();
		}
	});

	it("keeps forced m[1] replacements below the baseline watermark visible on repeated refresh", () => {
		const f = fixture();
		try {
			const original = insertMemory(f.db, {
				projectPath: f.state.projectIdentity,
				category: "ARCHITECTURE",
				content: "original A ".repeat(40),
				importance: 100,
			});
			const replacement = insertMemory(f.db, {
				projectPath: f.state.projectIdentity,
				category: "ARCHITECTURE",
				content: "replacement B ".repeat(40),
				importance: 1,
			});
			const state = {
				...f.state,
				injectionBudgetTokens:
					estimateTokens(renderMemoryBlockV2([original])) + 2,
			};
			const fold = materializeM0Pi(state, f.db);
			expect(fold.renderedMemoryIds).toEqual([original.id]);
			// Simulate a cached pair written before baseline selection metadata existed.
			f.db
				.prepare(
					"UPDATE session_meta SET cached_m0_upgrade_state = substr(cached_m0_upgrade_state, 1, instr(cached_m0_upgrade_state, '|m0-memory-ids:') - 1) WHERE session_id = ?",
				)
				.run(state.sessionId);
			supersededMemory(f.db, original.id, replacement.id);
			queueMemoryMutation(f.db, {
				projectPath: state.projectIdentity,
				mutationType: "superseded",
				targetMemoryId: original.id,
				supersededById: replacement.id,
			});
			const refresh = () => {
				const messages = [userMessage("tail", 1000)];
				injectM0M1Pi(state, f.db, messages as never, undefined, true);
				return messages.slice(0, 2);
			};
			const first = refresh();
			expect(JSON.stringify(first)).toContain(
				`#${replacement.id}: replacement B`,
			);
			expect(f.manifest()).toEqual({
				ids: [original.id, replacement.id],
				count: 2,
			});
			expect(refresh()).toEqual(first);
			archiveMemory(f.db, replacement.id);
			queueMemoryMutation(f.db, {
				projectPath: state.projectIdentity,
				mutationType: "archive",
				targetMemoryId: replacement.id,
			});
			expect(JSON.stringify(refresh())).not.toContain(`#${replacement.id}:`);
			expect(f.manifest()).toEqual({ ids: [original.id], count: 1 });
		} finally {
			f.close();
		}
	});

	it("rolls back refreshed bytes and their manifest together", () => {
		const f = fixture();
		try {
			f.serve();
			insertMemory(f.db, {
				projectPath: f.state.projectIdentity,
				category: "ARCHITECTURE",
				content: "new delta",
			});
			const before = f.row();
			f.db.exec(
				`CREATE TRIGGER reject_manifest BEFORE UPDATE OF memory_block_ids ON session_meta BEGIN SELECT RAISE(ABORT, 'manifest rejected'); END`,
			);
			expect(() => f.serve(true)).toThrow("manifest rejected");
			expect(f.row()).toEqual(before);
		} finally {
			f.close();
		}
	});

	it("keeps fold, refresh and defer prompt bytes identical to the pre-manifest baseline", () => {
		const f = fixture();
		try {
			insertMemory(f.db, {
				projectPath: f.state.projectIdentity,
				category: "ARCHITECTURE",
				content: "baseline memory",
			});
			const hash = (value: unknown) =>
				createHash("sha256").update(JSON.stringify(value)).digest("hex");
			const capture = (refresh = false) => {
				const prefix = f.serve(refresh);
				const meta = getOrCreateSessionMeta(f.db, f.state.sessionId);
				if (!meta.cachedM0Bytes || !meta.cachedM1Bytes) {
					throw new Error("expected persisted bytes");
				}
				return hash({
					m0: meta.cachedM0Bytes.toString("utf8"),
					m1: meta.cachedM1Bytes.toString("utf8"),
					prefix,
				});
			};
			const fold = capture();
			insertMemory(f.db, {
				projectPath: f.state.projectIdentity,
				category: "ARCHITECTURE",
				content: "incremental memory",
			});
			const refresh = capture(true);
			const before = f.row();
			insertMemory(f.db, {
				projectPath: f.state.projectIdentity,
				category: "ARCHITECTURE",
				content: "not served during defer",
			});
			const defer = capture();
			// Captured from the unmodified renderer before the manifest fix.
			expect({ fold, refresh, defer }).toEqual({
				fold: "41805f680c01aa6870c79ee455a0f08f6a7d30fb5766d90862364cbcf2e7d778",
				refresh:
					"74d4559ec633d643b6f6cb33f59f3dbf4c374785ad300b85a2c0cf9916c6e9e6",
				defer:
					"74d4559ec633d643b6f6cb33f59f3dbf4c374785ad300b85a2c0cf9916c6e9e6",
			});
			expect(defer).toBe(refresh);
			expect(f.row()).toEqual(before);
		} finally {
			f.close();
		}
	});
});
