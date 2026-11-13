import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	evaluateTaskGate,
	getDreamTaskBacklog,
} from "../../../plugin/src/features/magic-context/dreamer/task-gates";
import { runMigrations } from "../../../plugin/src/features/magic-context/migrations";
import { initializeDatabase } from "../../../plugin/src/features/magic-context/storage-db";
import { Database as ContextDatabase } from "../../../plugin/src/shared/sqlite";
import {
	getRawSessionTagKeysThrough,
	readSessionChunk,
	setBoundedRawMessageProvider,
	withRawMessageProvider,
} from "../../../plugin/src/hooks/magic-context/read-session-chunk";
import { readRawSessionMessagesFromDb } from "../../../plugin/src/hooks/magic-context/read-session-raw";
import {
	createV2RawMessageProvider,
	createV2RawMessageReader,
	rawMessages,
} from "../../../plugin/src/v2/hooks/store";
import {
	getV2StoreReaderDebugCounters,
	resetV2StoreReaderDebugCounters,
	sourceDatabaseFilename,
	V2StoreReader,
} from "../../../plugin/src/v2/store-reader";
import rows from "../../src/opencode2-runner/host-rows.json";
import golden from "../../src/opencode2-runner/reader-s4-golden.json";
import { isolation } from "../../src/opencode2-runner/spawn";
import { cleanupE2ETempDir } from "../../src/temp-dir";

test("OpenCode 2 runner scopes retrospective probes to its root sessions", () => {
	const fixture = isolation();
	const db = new ContextDatabase(":memory:");
	try {
		initializeDatabase(db);
		runMigrations(db);
		const project = "git:opencode2-retrospective-gate";
		for (const [session, harness, subagent, activity] of [
			["root", "opencode2", 0, 100],
			["second-root", "opencode2", 0, 100],
			["child", "opencode2", 1, 900],
			["other-opencode", "opencode", 0, 900],
			["other-pi", "pi", 0, 900],
			["other-omp", "omp", 0, 900],
		] as const) {
			db.prepare(
				"INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
			).run(session, harness, project, activity);
			db.prepare(
				"INSERT INTO session_meta (session_id, harness, is_subagent) VALUES (?, ?, ?)",
			).run(session, harness, subagent);
			db.prepare(
				"INSERT INTO message_history_index (session_id, harness, last_indexed_ordinal, updated_at) VALUES (?, ?, 1, ?)",
			).run(session, harness, activity);
		}
		for (const watermark of [null, 0, 100]) {
			const pending = watermark === 100 ? 0 : 2;
			expect(
				getDreamTaskBacklog(db, project, "retrospective", {
					retrospectiveWatermarkMs: watermark,
				}),
			).toEqual({ pending, total: pending });
			expect(
				evaluateTaskGate("retrospective", {
					db,
					projectIdentity: project,
					lastRunAt: null,
					retrospectiveWatermarkMs: watermark,
					promotionThreshold: 3,
				}),
			).toBe(pending > 0);
		}
	} finally {
		db.close();
		cleanupE2ETempDir(fixture.root);
	}
});

// R16's owner ruling removes invalid characters; the audit's older source replaced them with '-'.
// OPENCODE_DB is source rule AND observed honoured by the GA CLI real-host placement test.
test("R16 source filename table covers every channel and override branch", () => {
	for (const channel of ["latest", "dev", "beta", "next", "prod"])
		expect(sourceDatabaseFilename(channel, {})).toBe("opencode.db");
	for (const value of ["1", "true"])
		expect(
			sourceDatabaseFilename("local", { OPENCODE_DISABLE_CHANNEL_DB: value }),
		).toBe("opencode.db");
	for (const value of ["0", "false", "TRUE", "yes"])
		expect(
			sourceDatabaseFilename("local", { OPENCODE_DISABLE_CHANNEL_DB: value }),
		).toBe("opencode-local.db");
	expect(sourceDatabaseFilename("local", {})).toBe("opencode-local.db");
	expect(sourceDatabaseFilename("release", {})).toBe("opencode-release.db");
	expect(sourceDatabaseFilename("a/b c!._-", {})).toBe("opencode-abc._-.db");
	expect(
		sourceDatabaseFilename("latest", { OPENCODE_DB: "opencode2.db" }),
	).toBe("opencode2.db");
	expect(sourceDatabaseFilename("local", { OPENCODE_DB: ":memory:" })).toBe(
		":memory:",
	);
	expect(sourceDatabaseFilename("local", { OPENCODE_DB: "" })).toBe("");
});

test("session_message_reader seq pages idle boundaries and checkpoint window", () => {
	const { root } = isolation();
	const path = join(root, "fixture.db");
	const writer = openTestDb(path);
	writer.exec(
		"CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER DEFAULT 0, data TEXT)",
	);
	const insert = writer.prepare(
		"INSERT INTO session_message(id, session_id, type, seq, data) VALUES (?, ?, ?, ?, ?)",
	);
	for (const row of [...rows].reverse())
		insert.run(
			row.id,
			row.session_id,
			row.type,
			row.seq,
			JSON.stringify(row.data),
		);
	const reader = new V2StoreReader(path);
	const firstRow = rows[0];
	if (!firstRow) throw new Error("host row fixture is empty");
	const id = firstRow.session_id;
	try {
		expect(
			JSON.stringify(reader.window(id).map(({ time_created: _, ...row }) => row)),
		).toBe(JSON.stringify(rows));
		expect(() =>
			(reader as unknown as { db: ContextDatabase }).db.exec(
				"DELETE FROM session_message",
			),
		).toThrow();
		expect(reader.page(id, { limit: 1 }).rows[0]?.seq).toBe(4);
		expect(reader.page(id, { limit: 1, after: 4 }).rows[0]?.seq).toBe(5);
		expect(
			reader.idleRows(id).map((row) => [row.seq, row.data.outcome]),
		).toEqual([[10, "succeeded"]]);
		expect(reader.latestCompaction(id)).toBeUndefined();
		// These additional rows exercise cut selection, not the provenance of the real-host fixture above.
		insert.run(
			"z-checkpoint",
			id,
			"compaction",
			12,
			JSON.stringify({ status: "completed", summary: "frozen", recent: "" }),
		);
		insert.run(
			"a-tail",
			id,
			"synthetic",
			13,
			JSON.stringify({ text: "after checkpoint" }),
		);
		insert.run(
			"a-failed",
			id,
			"compaction",
			14,
			JSON.stringify({ status: "failed" }),
		);
		expect(reader.latestCompaction(id)?.seq).toBe(12);
		expect(reader.window(id).map((row) => row.id)).toEqual([
			"z-checkpoint",
			"a-tail",
			"a-failed",
		]);
		expect(reader.window("other")).toEqual([]);
		expect(() => reader.page(id, { limit: 0 })).toThrow();
		const before = createHash("sha256")
			.update(readFileSync(path))
			.digest("hex");
		reader.window(id);
		expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(
			before,
		);
	} finally {
		reader.close();
		writer.close();
	}
	expect(() => new V2StoreReader(join(root, "missing.db"))).toThrow();
});

test("10,000-row raw read pages decode only the requested page and count decodes none", () => {
	const { root } = isolation();
	const path = join(root, "bounded-reader.db");
	const writer = openTestDb(path);
	writer.exec(
		"CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER DEFAULT 0, data TEXT)",
	);
	const insert = writer.prepare(
		"INSERT INTO session_message(id, session_id, type, seq, data) VALUES (?, 'ses-long', 'user', ?, ?)",
	);
	const insertIdle = writer.prepare(
		"INSERT INTO session_message(id, session_id, type, seq, data) VALUES (?, 'ses-long', 'idle', ?, ?)",
	);
	writer.transaction(() => {
		for (let ordinal = 1; ordinal <= 10_000; ordinal++) {
			const seq = ordinal * 2;
			if (ordinal % 1_000 === 0) {
				insertIdle.run(
					`idle-${ordinal}`,
					seq - 1,
					JSON.stringify({ outcome: "succeeded" }),
				);
			}
			insert.run(`message-${ordinal}`, seq, JSON.stringify({ text: `row ${ordinal}` }));
		}
	})();

	resetV2StoreReaderDebugCounters();
	const read = createV2RawMessageReader(() => new V2StoreReader(path));
	try {
		const page = read.readPage("ses-long", 9_900, 50, 9_990);
		expect(page).toHaveLength(50);
		expect(page[0]).toMatchObject({ id: "message-9901", ordinal: 9_901 });
		expect(page.at(-1)).toMatchObject({ id: "message-9950", ordinal: 9_950 });
		expect(read.getCount("ses-long")).toBe(10_000);
		expect(read.getStoredCount("ses-long")).toBe(10_010);
		expect(read.findById("ses-long", "message-9950")).toMatchObject({
			id: "message-9950",
			ordinal: 9_950,
		});
		expect(read.ordinalOf("ses-long", "message-9950")).toBe(9_950);
		expect(read.ordinalOf("ses-long", "idle-10000")).toBeNull();
		expect([...read.ordinalMapForRange("ses-long", 9_990, 9_992)]).toEqual([
			["message-9990", 9_990],
			["message-9991", 9_991],
			["message-9992", 9_992],
		]);
		expect(read.readOrdinalPage("ses-long", null, 2)).toEqual([
			{
				id: "message-1",
				timeCreated: 2,
				contributesOrdinal: true,
				hasValidInfo: true,
			},
			{
				id: "message-2",
				timeCreated: 4,
				contributesOrdinal: true,
				hasValidInfo: true,
			},
		]);
		const counters = getV2StoreReaderDebugCounters();
		expect(counters.decodedRows).toBeLessThanOrEqual(100);
		expect(counters.operations.messagePage).toEqual({
			calls: 1,
			decodedRows: 50,
			maxDecodedRows: 50,
		});
		expect(counters.operations.messageCount).toEqual({
			calls: 1,
			decodedRows: 0,
			maxDecodedRows: 0,
		});
		expect(counters.operations.messageById).toEqual({
			calls: 1,
			decodedRows: 1,
			maxDecodedRows: 1,
		});
		for (const operation of [
			"storedMessageCount",
			"messageOrdinalById",
			"messageIdOrdinals",
			"messageOrdinalPage",
		]) {
			expect(counters.operations[operation]?.decodedRows).toBe(0);
		}
		expect(counters.operations.history).toBeUndefined();
	} finally {
		writer.close();
	}
});

test("post-historian drop-key collection decodes only the published chunk", async () => {
	const { root } = isolation();
	const path = join(root, "post-historian-bounded-reader.db");
	const writer = openTestDb(path);
	writer.exec(`
		CREATE TABLE session_message(
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			type TEXT NOT NULL,
			seq INTEGER NOT NULL,
			time_created INTEGER NOT NULL,
			data TEXT NOT NULL
		);
		CREATE UNIQUE INDEX session_message_session_seq_idx
			ON session_message(session_id, seq);
		CREATE INDEX session_message_session_type_seq_idx
			ON session_message(session_id, type, seq);
	`);
	const insert = writer.prepare(
		"INSERT INTO session_message VALUES (?, 'ses-post-historian', 'user', ?, ?, ?)",
	);
	writer.transaction(() => {
		for (let ordinal = 1; ordinal <= 10_000; ordinal++) {
			insert.run(
				`message-${ordinal}`,
				ordinal,
				1_800_000_000_000 + ordinal,
				JSON.stringify({ text: `row ${ordinal}` }),
			);
		}
	})();

	resetV2StoreReaderDebugCounters({ captureQueries: true });
	const read = createV2RawMessageReader(() => new V2StoreReader(path));
	const unregister = setBoundedRawMessageProvider(
		"ses-post-historian",
		createV2RawMessageProvider(read, "ses-post-historian"),
	);
	const started = performance.now();
	try {
		await getRawSessionTagKeysThrough("ses-post-historian", 10_000, {
			pageSize: 32,
			yieldToEventLoop: async () => {},
			fromMessageIndex: 9_901,
		});
		const elapsedMs = performance.now() - started;
		const counters = getV2StoreReaderDebugCounters();
		expect(counters.operations.history).toBeUndefined();
		expect(counters.operations.messagePage).toEqual({
			calls: 4,
			decodedRows: 100,
			maxDecodedRows: 32,
		});
		expect(counters.queries).toHaveLength(4);
		expect(counters.queries?.every((query) => query.statement.includes("session_message"))).toBe(
			true,
		);
		expect(counters.queries?.reduce((sum, query) => sum + query.rows, 0)).toBe(100);
		expect(counters.queries?.every((query) => query.elapsedMs >= 0)).toBe(true);
		expect(counters.openReaders).toBe(0);
		expect(counters.readersOpened).toBe(counters.readersClosed);
		console.log(
			`[post-historian-bounded-read] rows=${counters.operations.messagePage?.decodedRows ?? 0} calls=${counters.operations.messagePage?.calls ?? 0} elapsed_ms=${elapsedMs.toFixed(3)}`,
		);
	} finally {
		unregister();
		writer.close();
	}
});

test("latestAssistant selects the newest assistant row by seq and ignores other types", () => {
	const { root } = isolation();
	const path = join(root, "latest-assistant.db");
	const writer = openTestDb(path);
	writer.exec(
		"CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER DEFAULT 0, data TEXT)",
	);
	const insert = writer.prepare(
		"INSERT INTO session_message(id, session_id, type, seq, data) VALUES (?, ?, ?, ?, ?)",
	);
	// Insertion order is shuffled so rowid cannot accidentally substitute for seq.
	insert.run(
		"m4",
		"ses-A",
		"assistant",
		4,
		JSON.stringify({ model: { providerID: "p", id: "new" } }),
	);
	insert.run("m2", "ses-A", "user", 2, JSON.stringify({}));
	insert.run(
		"m1",
		"ses-A",
		"assistant",
		1,
		JSON.stringify({ model: { providerID: "p", id: "old" } }),
	);
	insert.run(
		"m3",
		"ses-B",
		"assistant",
		3,
		JSON.stringify({ model: { providerID: "p", id: "other" } }),
	);
	const reader = new V2StoreReader(path);
	try {
		expect(reader.latestAssistant("ses-A")?.id).toBe("m4");
		expect(reader.latestAssistant("ses-B")?.id).toBe("m3");
		expect(reader.latestAssistant("ses-missing")).toBeUndefined();
	} finally {
		reader.close();
		writer.close();
	}
});

test("I11 v1/v2 readers feed the same transform core with pinned host differences", () => {
	const { root } = isolation();
	const sessionID = "ses-golden";
	const v1Path = join(root, "golden-v1.db");
	const v2Path = join(root, "golden-v2.db");
	const v1 = openTestDb(v1Path);
	const v2 = openTestDb(v2Path);
	v1.exec(`
		CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
		CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
	`);
	v2.exec(`
		CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
	`);
	const v1Message = v1.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
	const v1Part = v1.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
	const conversation = [
		{ id: "u1", role: "user", time: 100, text: "Plan the host-aware reader." },
		{ id: "a1", role: "assistant", time: 200, text: "I will inspect both stores." },
		{ id: "u2", role: "user", time: 300, text: "Keep v1 bytes stable." },
		{ id: "a2", role: "assistant", time: 400, text: "Both lanes now agree." },
	];
	for (const row of conversation) {
		v1Message.run(row.id, sessionID, row.time, row.time, JSON.stringify({ role: row.role }));
		v1Part.run(`p-${row.id}`, row.id, sessionID, row.time, row.time, JSON.stringify({ type: "text", text: row.text }));
	}
	v1Message.run("marker-summary", sessionID, 250, 250, JSON.stringify({ role: "assistant", summary: true, finish: "stop" }));
	v1Part.run("p-marker", "marker-summary", sessionID, 250, 250, JSON.stringify({ type: "text", text: "v1 marker" }));
	const v2Insert = v2.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)");
	for (const [index, row] of conversation.entries()) {
		const type = row.role === "assistant" ? "assistant" : "user";
		v2Insert.run(
			row.id,
			sessionID,
			type,
			index < 2 ? index + 1 : index + 2,
			row.time,
			JSON.stringify(type === "assistant" ? { content: [{ type: "text", text: row.text }], time: { created: row.time } } : { text: row.text, time: { created: row.time } }),
		);
	}
	v2Insert.run("host-checkpoint", sessionID, "compaction", 3, 250, JSON.stringify({ status: "completed", summary: "host-owned", recent: "" }));

	const v1Raw = readRawSessionMessagesFromDb(v1 as never, sessionID).map(({ version: _, ...row }) => row);
	const reader = new V2StoreReader(v2Path);
	const v2Rows = reader.history(sessionID);
	const v2Raw = rawMessages(v2Rows);
	const chunk = (messages: typeof v1Raw) =>
		withRawMessageProvider(sessionID, { readMessages: () => messages }, () =>
			readSessionChunk(sessionID, 10_000),
		);
	const actual = {
		v1Raw,
		v1RawSha256: createHash("sha256").update(JSON.stringify(v1Raw)).digest("hex"),
		v1Chunk: chunk(v1Raw),
		v2Raw,
		v2Chunk: chunk(v2Raw),
		v1MarkerRows: v1.prepare("SELECT id FROM message WHERE json_extract(data, '$.summary') = 1").all(),
		v2HostCompactionRows: v2Rows.filter((row) => row.type === "compaction").map((row) => ({ id: row.id, summary: row.data.summary })),
		v2MarkerRows: v2.prepare("SELECT name FROM sqlite_master WHERE name IN ('message', 'part')").all(),
	};
	expect(v2Raw).toEqual(v1Raw);
	expect(actual.v2Chunk).toEqual(actual.v1Chunk);
	expect(actual.v1RawSha256).toBe(golden.v1.rawSha256);
	expect(actual.v1Chunk.text).toBe(golden.v1.chunkText);
	expect(actual.v2Chunk.text).toBe(golden.v2.chunkText);
	expect(actual.v1MarkerRows).toEqual(golden.v1.markerRows);
	expect(actual.v2HostCompactionRows).toEqual(golden.v2.hostCompactionRows);
	expect(actual.v2MarkerRows).toEqual(golden.v2.markerRows);
	expect(v1Raw.map((row) => row.id)).toEqual(golden.common.messageIds);
	expect(v2Raw.map((row) => row.ordinal)).toEqual(golden.common.ordinals);
	expect(actual.v1Chunk.messageCount).toBe(golden.common.messageCount);
	expect(actual.v2Chunk.tokenEstimate).toBe(golden.common.tokenEstimate);
	reader.close();
	v1.close();
	v2.close();
});

test("host-aware dispatch refuses a v1 store before a v2 query", () => {
	const { root } = isolation();
	const path = join(root, "v1.db");
	const db = openTestDb(path);
	db.exec("CREATE TABLE message(id TEXT); CREATE TABLE part(id TEXT)");
	db.close();
	expect(() => new V2StoreReader(path)).toThrow("expected v2, found v1");
});
