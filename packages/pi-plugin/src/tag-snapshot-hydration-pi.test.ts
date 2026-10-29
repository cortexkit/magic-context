import { expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { installTagIdentityRevisionTrigger } from "@magic-context/core/features/magic-context/storage-tag-identity-revision";
import {
	getTagsBySession,
	normalizeTagSnapshotRow,
	TAG_SELECT_COLUMNS,
} from "@magic-context/core/features/magic-context/storage-tags";
import { Database } from "@magic-context/core/shared/sqlite";
import { getWorkerShutdownStats } from "@magic-context/core/shared/worker-shutdown";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { PiContextBudget } from "./pi-context-budget";
import {
	decodePiHydrationOperation,
	encodePiHydrationOperation,
} from "./tag-snapshot-codec-pi";
import {
	__setPiTagSnapshotWorkerForTests,
	createPiTagSnapshotCandidate,
	drainPiTagSnapshotSession,
	ensurePiTagSnapshotReady,
	getPiTagSnapshotView,
	loadPiTagSnapshotCandidate,
	PI_FALLBACK_ROW_COLUMNS,
	PI_FALLBACK_ROW_PREDICATE,
	type PiFallbackTagRow,
	type PiTagSnapshotToken,
	readPiTagSnapshotRevision,
	samePiTagSnapshotToken,
} from "./tag-snapshot-pi";
import {
	createPiHydrationPacketConsumer,
	type PiHydrationMessage,
	type PiHydrationRequest,
	startPiTagSnapshotWorker,
} from "./tag-snapshot-worker-client-pi";

function fixture(journalMode?: "WAL" | "DELETE") {
	const root = createTestTempDirFromPath(join(tmpdir(), "pi-tag-hydration-"));
	const path = join(root, "context.db");
	const db = new Database(path);
	initializeDatabase(db);
	runMigrations(db);
	if (journalMode) db.exec(`PRAGMA journal_mode = ${journalMode}`);
	const foreign = new Database(path);
	if (journalMode !== "DELETE") initializeDatabase(foreign);
	return {
		db,
		foreign,
		path,
		close() {
			foreign.close();
			db.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function seed(db: Database) {
	const insert = db.prepare(`INSERT INTO tags
		(session_id, tag_number, message_id, type, status, byte_size, tool_owner_message_id, entry_fingerprint)
		VALUES ('s', ?, ?, ?, ?, ?, ?, ?)`);
	insert.run(8, "pi-msg-8:p0", "message", "active", 80, null, "fingerprint-8");
	insert.run(2, "call-2", "tool", "dropped", 20, "PI-MSG-2", "fingerprint-2");
	insert.run(5, "entry-5", "file", "compacted", 50, null, null);
	insert.run(11, "entry-11", "legacy", "legacy", 0, null, null);
	db.exec(`UPDATE tags SET drop_mode = 'legacy', caveman_depth = NULL,
		input_byte_size = NULL, reasoning_byte_size = NULL, token_count = NULL WHERE tag_number = 11`);
}

function assemble(db: Database, cached = getPiTagSnapshotView(db, "s")) {
	return loadPiTagSnapshotCandidate(async (candidate) => {
		const rows = db
			.prepare(
				`SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = 's' ORDER BY tag_number, id`,
			)
			.all();
		for (const raw of rows) {
			const tag = normalizeTagSnapshotRow(raw);
			if (tag) candidate.appendTag(tag);
		}
		candidate.end("tags");
		for (const row of db
			.prepare(
				`SELECT ${PI_FALLBACK_ROW_COLUMNS} FROM tags WHERE session_id = 's' AND ${PI_FALLBACK_ROW_PREDICATE}`,
			)
			.all()) {
			candidate.appendFallback(row as PiFallbackTagRow);
		}
		candidate.end("fallback");
	}, cached);
}

it("candidate exposes neither stream until both end markers arrive", () => {
	const candidate = createPiTagSnapshotCandidate();
	expect(() => candidate.finish()).toThrow("incomplete candidate");
	candidate.end("tags");
	expect(() => candidate.finish()).toThrow("incomplete candidate");
	candidate.end("fallback");
	expect(candidate.finish()).toMatchObject({
		tags: [],
		active: [],
		fallback: [],
	});
	expect(() => candidate.end("fallback")).toThrow("duplicate fallback end");
	expect(() => candidate.finish()).toThrow("incomplete candidate");
});

it("hydration publishes an empty complete session", async () => {
	const { db, close } = fixture();
	try {
		const result = await assemble(db, []);
		expect(result.tags).toEqual([]);
		expect(result.active).toEqual([]);
		expect(result.fallback).toEqual([]);
	} finally {
		close();
	}
});

for (const legacy of [true, false]) {
	it(`${legacy ? "legacy nonempty" : "revisioned nonempty"} hydration accepts its own first status update`, async () => {
		const { db, close } = fixture();
		try {
			seed(db);
			if (legacy)
				db.exec(
					"DELETE FROM schema_migrations_meta WHERE key = 'tag_revision:s'",
				);
			await ensurePiTagSnapshotReady(db, "s", new PiContextBudget());
			const before = getPiTagSnapshotView(db, "s");
			expect(before).toEqual(getTagsBySession(db, "s"));
			expect(before.find((tag) => tag.tagNumber === 8)?.status).toBe("active");
			db.exec(
				"UPDATE tags SET status = 'dropped' WHERE session_id = 's' AND tag_number = 8",
			);
			const after = getPiTagSnapshotView(db, "s");
			expect(after).toEqual(getTagsBySession(db, "s"));
			expect(after.find((tag) => tag.tagNumber === 8)?.status).toBe("dropped");
			expect(after[0]).toBe(before[0]);
		} finally {
			await drainPiTagSnapshotSession("s");
			close();
		}
	});
}

for (const mode of [
	"foreign allocation",
	"foreign write after own allocation",
	"untracked foreign write before own allocation",
] as const) {
	it(`legacy nonempty hydration refuses ${mode}`, async () => {
		const { db, foreign, path, close } = fixture();
		const writer = mode.startsWith("untracked") ? new Database(path) : foreign;
		try {
			seed(db);
			db.exec(
				"DELETE FROM schema_migrations_meta WHERE key = 'tag_revision:s'",
			);
			await ensurePiTagSnapshotReady(db, "s", new PiContextBudget());
			expect(getPiTagSnapshotView(db, "s")).toEqual(getTagsBySession(db, "s"));
			if (mode === "foreign write after own allocation")
				db.exec(
					"UPDATE tags SET status = 'dropped' WHERE session_id = 's' AND tag_number = 8",
				);
			writer.exec(
				"UPDATE tags SET status = 'active' WHERE session_id = 's' AND tag_number = 2",
			);
			if (mode.startsWith("untracked"))
				db.exec(
					"UPDATE tags SET status = 'dropped' WHERE session_id = 's' AND tag_number = 8",
				);
			expect(() => getPiTagSnapshotView(db, "s")).toThrow(
				"tag snapshot is not ready",
			);
		} finally {
			await drainPiTagSnapshotSession("s");
			if (writer !== foreign) writer.close();
			close();
		}
	});
}

for (const mode of [
	"recreated revision",
	"recreated first allocation",
	"recreated accepted allocation",
	"regressed first allocation",
] as const) {
	it(`nonempty hydration refuses a ${mode} on its own connection`, async () => {
		const { db, close } = fixture();
		try {
			seed(db);
			if (mode !== "recreated revision")
				db.exec(
					"DELETE FROM schema_migrations_meta WHERE key = 'tag_revision:s'",
				);
			await ensurePiTagSnapshotReady(db, "s", new PiContextBudget());
			expect(getPiTagSnapshotView(db, "s")).toEqual(getTagsBySession(db, "s"));
			if (mode !== "recreated revision")
				db.exec(
					"UPDATE tags SET status = 'dropped' WHERE session_id = 's' AND tag_number = 8",
				);
			if (mode === "recreated accepted allocation")
				expect(getPiTagSnapshotView(db, "s")).toEqual(
					getTagsBySession(db, "s"),
				);
			if (mode === "regressed first allocation")
				db.exec(`UPDATE schema_migrations_meta SET value = substr(value, 1, instr(value, ':')) || '0'
					WHERE key = 'tag_revision:s'`);
			else
				db.exec(
					"DELETE FROM schema_migrations_meta WHERE key = 'tag_revision:s'",
				);
			db.exec(
				"UPDATE tags SET status = 'active' WHERE session_id = 's' AND tag_number = 2",
			);
			expect(() => getPiTagSnapshotView(db, "s")).toThrow(
				"tag snapshot is not ready",
			);
		} finally {
			await drainPiTagSnapshotSession("s");
			close();
		}
	});
}

for (const evidence of ["pi_tag_first_allocation", "pi_tag_changes"] as const) {
	it(`legacy nonempty hydration refuses its own allocation without ${evidence}`, async () => {
		const { db, close } = fixture();
		try {
			seed(db);
			db.exec(
				"DELETE FROM schema_migrations_meta WHERE key = 'tag_revision:s'",
			);
			await ensurePiTagSnapshotReady(db, "s", new PiContextBudget());
			getPiTagSnapshotView(db, "s");
			db.exec(
				"UPDATE tags SET status = 'dropped' WHERE session_id = 's' AND tag_number = 8",
			);
			db.exec(`DELETE FROM ${evidence} WHERE session_id = 's'`);
			expect(() => getPiTagSnapshotView(db, "s")).toThrow(
				"tag snapshot is not ready",
			);
		} finally {
			await drainPiTagSnapshotSession("s");
			close();
		}
	});
}

it("candidate matches the independent synchronous process oracle including fallback order and legacy normalization", async () => {
	const { db, path, close } = fixture();
	try {
		seed(db);
		// The oracle imports no candidate code and opens its own connection. Its
		// fallback SQL intentionally has no ORDER BY, just like the baseline.
		const core = new URL("../../plugin/src/", import.meta.url).pathname;
		const script = `
			import { Database } from ${JSON.stringify(`${core}shared/sqlite.ts`)};
			import { getTagsBySession } from ${JSON.stringify(`${core}features/magic-context/storage-tags.ts`)};
			const db = new Database(process.argv[1], { readonly: true });
			const tags = getTagsBySession(db, 's');
			const fallback = db.prepare("SELECT id, tag_number, type, message_id, tool_owner_message_id, entry_fingerprint FROM tags WHERE session_id = 's' AND ((type = 'message' AND message_id LIKE 'pi-msg-%') OR (type = 'tool' AND tool_owner_message_id LIKE 'pi-msg-%'))").all();
			console.log(JSON.stringify({ tags, active: tags.filter(t => t.status === 'active'), fallback }));
			db.close();`;
		const oracle = Bun.spawn([process.execPath, "--eval", script, path], {
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		const [output, error, exit] = await Promise.all([
			new Response(oracle.stdout).text(),
			new Response(oracle.stderr).text(),
			oracle.exited,
		]);
		expect({ exit, error }).toEqual({ exit: 0, error: "" });
		const { estimatedBytes, allocatedBytes, reusedBytes, ...candidate } =
			await assemble(db, []);
		expect(JSON.stringify(candidate)).toBe(output.trim());
		expect(candidate.tags.map((row) => row.tagNumber)).toEqual([2, 5, 8, 11]);
		expect(candidate.tags.at(-1)).toMatchObject({
			type: "message",
			status: "active",
			cavemanDepth: 0,
			dropMode: "full",
		});
		expect(estimatedBytes).toBeGreaterThan(0);
	} finally {
		close();
	}
});

it("hydration reuses every unchanged frozen row", async () => {
	const { db, foreign, close } = fixture();
	try {
		seed(db);
		const old = getPiTagSnapshotView(db, "s");
		foreign.exec("UPDATE tags SET byte_size = 81 WHERE tag_number = 8");
		const candidate = await assemble(db, old);
		expect(candidate.tags).toEqual(getTagsBySession(db, "s"));
		for (let index = 0; index < old.length; index++) {
			if (old[index]?.tagNumber === 8)
				expect(candidate.tags[index]).not.toBe(old[index]);
			else expect(candidate.tags[index]).toBe(old[index]);
			expect(Object.isFrozen(candidate.tags[index])).toBe(true);
		}
		expect(candidate.tags[2]).toBe(candidate.active[0]);
	} finally {
		close();
	}
});

it("candidate rejects noncanonical input and memory overflow without exposing a prefix", async () => {
	const { db, close } = fixture();
	try {
		seed(db);
		const rows = getTagsBySession(db, "s");
		const first = rows[0];
		if (!first) throw new Error("missing seeded row");
		const outOfOrder = createPiTagSnapshotCandidate();
		outOfOrder.appendTag(first);
		expect(() => outOfOrder.appendTag(first)).toThrow("noncanonical");
		expect(() => outOfOrder.finish()).toThrow("incomplete");
		const overLimit = createPiTagSnapshotCandidate([], 193);
		expect(() => overLimit.appendTag(first)).toThrow("memory limit");
		expect(() => overLimit.finish()).toThrow("incomplete");
		expect(normalizeTagSnapshotRow({ id: 3 })).toBeNull();
		expect(normalizeTagSnapshotRow(null)).toBeNull();
	} finally {
		close();
	}
});

it("candidate authority includes rollback-safe revisions, incarnation and destination lifetime", () => {
	const { db, foreign, close } = fixture();
	try {
		seed(db);
		const revision = readPiTagSnapshotRevision(db, "s");
		if (!revision) throw new Error("missing revision outside transaction");
		const token: PiTagSnapshotToken = {
			connectionEpoch: 1,
			sessionEpoch: 1,
			jobId: 1,
			sessionId: "s",
			localRevision: revision[0],
			foreignRevision: revision[1],
			durableVersion: 4,
			ownVersion: 0,
		};
		db.exec("BEGIN; UPDATE tags SET byte_size = 99; ROLLBACK");
		expect(readPiTagSnapshotRevision(db, "s")).toEqual(revision);
		foreign.exec(
			"DELETE FROM schema_migrations_meta WHERE key = 'tag_revision:s'; UPDATE tags SET byte_size = 99 WHERE tag_number = 8",
		);
		const after = readPiTagSnapshotRevision(db, "s");
		if (!after) throw new Error("missing revision after incarnation change");
		expect(after[1]).not.toBe(revision[1]);
		expect(samePiTagSnapshotToken(token, { ...token })).toBe(true);
		for (const [field, value] of Object.entries(token)) {
			const changed = typeof value === "number" ? value + 1 : `${value}:new`;
			expect(
				samePiTagSnapshotToken(token, { ...token, [field]: changed }),
			).toBe(false);
		}
		expect(
			samePiTagSnapshotToken(token, { ...token, foreignRevision: after[1] }),
		).toBe(false);
	} finally {
		close();
	}
});

function requestFor(path: string): PiHydrationRequest {
	return {
		path,
		sessionId: "s",
		connectionEpoch: 1,
		sessionEpoch: 1,
		jobId: 1,
	};
}

function seedPages(db: Database) {
	const insert = db.prepare(`INSERT INTO tags
		(session_id, tag_number, message_id, type, status, byte_size)
		VALUES ('s', ?, ?, 'message', 'active', 10)`);
	db.transaction(() => {
		for (let n = 1; n <= 768; n++) insert.run(n, `pi-msg-${n}:p0`);
	})();
}

it("worker completes while another session commits between every page", async () => {
	const { db, foreign, path, close } = fixture();
	try {
		seedPages(db);
		let writes = 0;
		const job = startPiTagSnapshotWorker(requestFor(path), {
			beforeAck: async () => {
				foreign
					.prepare(`INSERT INTO tags
					(session_id, tag_number, message_id, type, status, byte_size)
					VALUES ('other', ?, ?, 'message', 'active', 10)`)
					.run(++writes, `other-${writes}`);
			},
		});
		try {
			const result = await job.result;
			expect(result.candidate.tags).toEqual(getTagsBySession(db, "s"));
			expect(writes).toBeGreaterThanOrEqual(8);
		} finally {
			await job.released;
		}
	} finally {
		close();
	}
});

it("hydration completes while another session commits between every page", async () => {
	const { db, foreign, close } = fixture();
	try {
		seedPages(db);
		let writes = 0;
		let starts = 0;
		__setPiTagSnapshotWorkerForTests(db, (request, cached) => {
			starts++;
			return startPiTagSnapshotWorker(request, {
				cached,
				beforeAck: async () => {
					foreign
						.prepare(`INSERT INTO tags
						(session_id, tag_number, message_id, type, status, byte_size)
						VALUES ('other', ?, ?, 'message', 'active', 10)`)
						.run(++writes, `other-${writes}`);
				},
			});
		});
		await ensurePiTagSnapshotReady(db, "s", new PiContextBudget());
		expect(starts).toBe(1);
		expect(writes).toBeGreaterThanOrEqual(8);
		expect(getPiTagSnapshotView(db, "s")).toEqual(getTagsBySession(db, "s"));
	} finally {
		await drainPiTagSnapshotSession("s");
		close();
	}
});

it("hydration restarts from the first page after repeated same-session writes", async () => {
	const { db, foreign, close } = fixture();
	try {
		seedPages(db);
		let starts = 0;
		let writes = 0;
		const firstTags: number[] = [];
		__setPiTagSnapshotWorkerForTests(db, (request, cached) => {
			const attempt = ++starts;
			let changed = false;
			return startPiTagSnapshotWorker(request, {
				cached,
				beforeAck: async (message) => {
					if (message.type !== "packet" || changed) return;
					changed = true;
					firstTags.push(message.rows);
					if (attempt <= 3) {
						foreign.exec(
							"UPDATE tags SET byte_size = byte_size + 1 WHERE session_id = 's' AND tag_number = 1",
						);
						writes++;
					}
				},
			});
		});
		await ensurePiTagSnapshotReady(db, "s", new PiContextBudget());
		expect(writes).toBe(3);
		expect(starts).toBe(4);
		expect(firstTags).toHaveLength(4);
		const tags = getPiTagSnapshotView(db, "s");
		expect(tags).toHaveLength(768);
		expect(tags[0]?.tagNumber).toBe(1);
		expect(tags[0]?.byteSize).toBe(13);
		expect(tags).toEqual(getTagsBySession(db, "s"));
	} finally {
		await drainPiTagSnapshotSession("s");
		close();
	}
});

it("repeated stale hydrations exhaust the original pass allowance", async () => {
	const { db, foreign, close } = fixture();
	try {
		seedPages(db);
		let starts = 0;
		const budget = new PiContextBudget();
		budget.hydrationAllowance = () => (starts >= 3 ? 0 : 5_000);
		__setPiTagSnapshotWorkerForTests(db, (request, cached) => {
			starts++;
			let changed = false;
			return startPiTagSnapshotWorker(request, {
				cached,
				beforeAck: async () => {
					if (changed) return;
					changed = true;
					foreign.exec(
						"UPDATE tags SET byte_size = byte_size + 1 WHERE session_id = 's' AND tag_number = 1",
					);
				},
			});
		});
		await expect(ensurePiTagSnapshotReady(db, "s", budget)).rejects.toThrow(
			"remaining pass budget exhausted",
		);
		expect(starts).toBe(3);
		expect(() => getPiTagSnapshotView(db, "s")).toThrow("not ready");
	} finally {
		await drainPiTagSnapshotSession("s");
		close();
	}
});

it("worker hydrates full active and fallback projections with bounded credited packets", async () => {
	const { db, path, close } = fixture();
	try {
		seed(db);
		const longName = "宽😀".repeat(30_000);
		db.prepare("UPDATE tags SET tool_name = ? WHERE tag_number = 2").run(
			longName,
		);
		const job = startPiTagSnapshotWorker(requestFor(path));
		const result = await job.result;
		await job.released;
		expect(result.candidate.tags).toEqual(getTagsBySession(db, "s"));
		expect(result.candidate.tags[0]?.toolName).toBe(longName);
		expect(
			result.candidate.tags.filter((tag) => tag.status === "active"),
		).toEqual(result.candidate.active);
		expect(result.candidate.fallback.map((tag) => tag.tag_number)).toEqual([
			2, 8,
		]);
		expect(result.telemetry.packetCount).toBeGreaterThan(2);
		expect(result.telemetry.maxReadTransactionMs).toBeGreaterThan(0);
	} finally {
		close();
	}
});

it("worker finishes module evaluation before it needs its first packet ACK", async () => {
	// Bun 1.3.14 delivers no parent message to a worker until the worker's
	// entry module has finished evaluating. A job awaited at module top level
	// then waits forever for its first ACK. The fixture entry reports when the
	// real worker module has settled, and this parent holds every ACK until
	// then, so the same deadlock shows up on any runtime.
	const { db, path, close } = fixture();
	// Seed before the worker starts: it reads pages on its own thread, and a
	// write landing between two of its pages is correctly refused as stale.
	seedPages(db);
	const worker = new Worker(
		new URL("./tag-snapshot-worker-evaluation.fixture.ts", import.meta.url),
		{ workerData: requestFor(path) },
	);
	try {
		let evaluated = false;
		const held: PiHydrationMessage[] = [];
		const ack = (message: PiHydrationMessage) => {
			const bytes = message.type === "packet" ? message.bytes : undefined;
			worker.postMessage(
				{ type: "ack", sequence: message.sequence, bytes },
				bytes ? [bytes] : [],
			);
		};
		const outcome = await new Promise<string>((resolve) => {
			const timer = setTimeout(() => resolve("no completion"), 5_000);
			worker.on(
				"message",
				(message: PiHydrationMessage | { type: "evaluated" }) => {
					if (message.type === "evaluated") {
						evaluated = true;
						for (const waiting of held.splice(0)) ack(waiting);
					} else if (message.type === "done" || message.type === "failed") {
						clearTimeout(timer);
						resolve(message.type);
					} else if (evaluated) ack(message);
					else held.push(message);
				},
			);
		});
		expect({ outcome, evaluated }).toEqual({
			outcome: "done",
			evaluated: true,
		});
	} finally {
		await worker.terminate();
		close();
	}
});

it("worker releases read transactions before slow acknowledgments in WAL and rollback journal modes", async () => {
	for (const mode of ["WAL", "DELETE"] as const) {
		const { db, foreign, path, close } = fixture(mode);
		try {
			seed(db);
			foreign.exec("PRAGMA busy_timeout = 10");
			let writes = 0;
			const job = startPiTagSnapshotWorker(requestFor(path), {
				beforeAck: async () => {
					if (writes++ === 0) {
						foreign.exec(
							"UPDATE tags SET status = 'dropped' WHERE tag_number = 8",
						);
						await new Promise((resolve) => setTimeout(resolve, 20));
					}
				},
			});
			await expect(job.result).rejects.toThrow("changed");
			await job.released;
			expect(writes).toBeGreaterThan(0);
			expect(
				getTagsBySession(db, "s").find((tag) => tag.tagNumber === 8)?.status,
			).toBe("dropped");
		} finally {
			close();
		}
	}
});

it("worker rejects metadata commits from a writer with revision triggers between streams", async () => {
	const { db, path, close } = fixture();
	const raw = new Database(path);
	try {
		seed(db);
		installTagIdentityRevisionTrigger(raw);
		let changed = false;
		const job = startPiTagSnapshotWorker(requestFor(path), {
			beforeAck: async () => {
				if (!changed) {
					changed = true;
					raw.exec("UPDATE tags SET byte_size = 999 WHERE tag_number = 8");
				}
			},
		});
		await expect(job.result).rejects.toThrow("changed");
		await job.released;
		expect(
			getTagsBySession(db, "s").find((tag) => tag.tagNumber === 8)?.byteSize,
		).toBe(999);
	} finally {
		raw.close();
		close();
	}
});

it("worker rejects legacy status commits between streams even without connection-local revision triggers", async () => {
	const { db, path, close } = fixture();
	const raw = new Database(path);
	try {
		seed(db);
		let changed = false;
		const job = startPiTagSnapshotWorker(requestFor(path), {
			beforeAck: async () => {
				if (!changed) {
					changed = true;
					raw.exec("UPDATE tags SET status = 'dropped' WHERE tag_number = 8");
				}
			},
		});
		await expect(job.result).rejects.toThrow("changed");
		await job.released;
		expect(
			getTagsBySession(db, "s").find((tag) => tag.tagNumber === 8)?.status,
		).toBe("dropped");
	} finally {
		raw.close();
		close();
	}
});

it("worker rejects memory overflow crashes and unsupported schemas without a candidate", async () => {
	const { db, path, close } = fixture();
	try {
		seed(db);
		for (const crash of ["before-end", "after-end"] as const) {
			const job = startPiTagSnapshotWorker({
				...requestFor(path),
				test: { crash },
			});
			await expect(job.result).rejects.toThrow(
				crash === "before-end" ? "injected" : "exited",
			);
			await job.released;
		}
		const oversize = startPiTagSnapshotWorker(requestFor(path), {
			byteLimit: 193,
		});
		await expect(oversize.result).rejects.toThrow("memory limit");
		await oversize.released;
		db.exec(
			"INSERT INTO schema_migrations (version, description, applied_at) VALUES (999, 'unsupported', 0)",
		);
		const unsupported = startPiTagSnapshotWorker(requestFor(path));
		await expect(unsupported.result).rejects.toMatchObject({
			name: "FailClosedBlockingError",
			code: "FAIL_CLOSED_BLOCKING",
			reason: { kind: "schema_fence", persistedVersion: 999 },
		});
		await unsupported.released;
	} finally {
		close();
	}
});

it("packet consumer rejects missing duplicate disordered wrong-lifetime and premature completion packets", async () => {
	const request = requestFor("unused.db");
	const base = {
		...request,
		generation: { revision: "0", durable: 0 },
		sequence: 0,
	};
	const end: PiHydrationMessage = {
		...base,
		type: "end",
		stream: "tags",
		rows: 0,
	};
	for (const mutation of [
		{ sequence: 1 },
		{ connectionEpoch: 2 },
		{ sessionEpoch: 2 },
		{ sessionId: "other" },
		{ jobId: 2 },
	]) {
		const consumer = createPiHydrationPacketConsumer(request);
		await expect(consumer.consume({ ...end, ...mutation })).rejects.toThrow(
			"mismatch",
		);
	}
	const duplicate = createPiHydrationPacketConsumer(request);
	await duplicate.consume(end);
	await expect(duplicate.consume(end)).rejects.toThrow("mismatch");
	const premature = createPiHydrationPacketConsumer(request);
	await expect(
		premature.consume({
			...base,
			type: "done",
			maxReadTransactionMs: 0,
			packetBytes: 0,
			packetCount: 0,
		}),
	).rejects.toThrow("before both streams");
	const changed = createPiHydrationPacketConsumer(request);
	await changed.consume(end);
	await expect(
		changed.consume({
			...end,
			sequence: 1,
			stream: "fallback",
			generation: { revision: "new:1", durable: 0 },
		}),
	).rejects.toThrow("generation mismatch");
	const malformed = createPiHydrationPacketConsumer(request);
	const bytes = encodePiHydrationOperation({ type: "row", value: {} as never });
	await expect(
		malformed.consume({
			...base,
			type: "packet",
			stream: "tags",
			bytes: new Uint8Array(bytes).buffer,
			byteLength: bytes.length,
			rows: 1,
		}),
	).rejects.toThrow("frame");
});

it("worker advances raw keysets across rejected legacy rows and rollback leaves one complete generation", async () => {
	const { db, path, close } = fixture();
	try {
		const insert = db.prepare(
			"INSERT INTO tags (session_id, tag_number, message_id, type, status, byte_size) VALUES ('s', ?, ?, 'message', 'active', ?)",
		);
		db.transaction(() => {
			for (let n = 1; n <= 300; n++)
				insert.run(n, `entry-${n}`, n < 290 ? "invalid" : 10);
		})();
		let rolledBack = false;
		const job = startPiTagSnapshotWorker(requestFor(path), {
			beforeAck: async () => {
				if (!rolledBack) {
					rolledBack = true;
					db.exec("BEGIN; UPDATE tags SET byte_size = 99; ROLLBACK");
				}
			},
		});
		const { candidate } = await job.result;
		await job.released;
		expect(candidate.tags).toEqual(getTagsBySession(db, "s"));
		expect(candidate.tags).toHaveLength(11);
	} finally {
		close();
	}
});

it("worker deadline and cancellation wait for release and never return a candidate", async () => {
	const { path, close } = fixture();
	try {
		const timedOut = startPiTagSnapshotWorker(
			{ ...requestFor(path), test: { pageDelayMs: 500 } },
			{ deadlineMs: 10 },
		);
		await expect(timedOut.result).rejects.toThrow("job deadline");
		await timedOut.released;
		const cancelled = startPiTagSnapshotWorker({
			...requestFor(path),
			test: { pageDelayMs: 500 },
		});
		cancelled.cancel();
		await expect(cancelled.result).rejects.toThrow("cancelled");
		await cancelled.released;
	} finally {
		close();
	}
});

it("a cancelled job closes its connection and exits instead of being terminated", async () => {
	const { db, path, close } = fixture();
	try {
		const before = getWorkerShutdownStats().get("pi-tag-snapshot") ?? {
			graceful: 0,
			forced: 0,
		};
		// The page delay pauses the job before its first page read, with its
		// connection already open.
		const cancelled = startPiTagSnapshotWorker({
			...requestFor(path),
			test: { pageDelayMs: 500 },
		});
		cancelled.cancel();
		await expect(cancelled.result).rejects.toThrow("cancelled");
		await cancelled.released;
		expect(getWorkerShutdownStats().get("pi-tag-snapshot")).toEqual({
			graceful: before.graceful + 1,
			forced: before.forced,
		});
		db.exec("PRAGMA busy_timeout=0");
		db.exec("BEGIN IMMEDIATE");
		db.exec("ROLLBACK");
	} finally {
		close();
	}
});

it("hydration rejects a foreign drop between streams", async () => {
	const { db, foreign, path, close } = fixture();
	try {
		seed(db);
		let committed = false;
		const job = startPiTagSnapshotWorker(requestFor(path), {
			beforeAck: async (message) => {
				if (message.type === "end" && message.stream === "tags") {
					foreign.exec(
						"UPDATE tags SET status = 'dropped' WHERE tag_number = 8",
					);
					committed = true;
				}
			},
		});
		await expect(job.result).rejects.toThrow("changed");
		await job.released;
		expect(committed).toBe(true);
		expect(
			getTagsBySession(foreign, "s").find((tag) => tag.tagNumber === 8)?.status,
		).toBe("dropped");
	} finally {
		close();
	}
});

it("hydration accepts an unchanged generation", async () => {
	const { db, path, close } = fixture();
	try {
		seed(db);
		const job = startPiTagSnapshotWorker(requestFor(path));
		const { candidate } = await job.result;
		await job.released;
		expect(candidate.tags).toEqual(getTagsBySession(db, "s"));
	} finally {
		close();
	}
});

it("packet codec preserves every SQLite scalar and mapper own field", () => {
	const row = {
		id: 1,
		tag_number: -0,
		type: undefined,
		message_id: "\ud800💾",
		tool_owner_message_id: Infinity,
		entry_fingerprint: new Uint8Array([0, 128, 255]),
		extra: NaN,
	};
	const operation = { type: "row" as const, value: row as never };
	const decoded = decodePiHydrationOperation(
		encodePiHydrationOperation(operation),
	);
	expect(decoded).toEqual(operation);
	expect(Object.keys((decoded as typeof operation).value)).toEqual(
		Object.keys(row),
	);
	expect(
		Object.is(
			(decoded as unknown as { value: typeof row }).value.tag_number,
			-0,
		),
	).toBe(true);
});

it("hydration discards late packets after connection reopen", async () => {
	const old = requestFor("unused.db");
	const current = {
		...old,
		connectionEpoch: old.connectionEpoch + 1,
		sessionEpoch: old.sessionEpoch + 1,
	};
	const consumer = createPiHydrationPacketConsumer(current);
	await expect(
		consumer.consume({
			...old,
			type: "end",
			stream: "tags",
			rows: 0,
			sequence: 0,
			generation: { revision: "0", durable: 0 },
		}),
	).rejects.toThrow("lifetime mismatch");
});

it("hydration accepts packets for the current lifetime", async () => {
	const request = requestFor("unused.db");
	const consumer = createPiHydrationPacketConsumer(request);
	const envelope = { ...request, generation: { revision: "0", durable: 0 } };
	await consumer.consume({
		...envelope,
		type: "end",
		stream: "tags",
		rows: 0,
		sequence: 0,
	});
	await consumer.consume({
		...envelope,
		type: "end",
		stream: "fallback",
		rows: 0,
		sequence: 1,
	});
	const candidate = await consumer.consume({
		...envelope,
		type: "done",
		sequence: 2,
		maxReadTransactionMs: 0,
		packetBytes: 0,
		packetCount: 0,
	});
	expect(candidate?.tags).toEqual([]);
});
