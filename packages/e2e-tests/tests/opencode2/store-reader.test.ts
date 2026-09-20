import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSessionChunk, withRawMessageProvider } from "../../../plugin/src/hooks/magic-context/read-session-chunk";
import { readRawSessionMessagesFromDb } from "../../../plugin/src/hooks/magic-context/read-session-raw";
import { rawMessages } from "../../../plugin/src/v2/hooks/store";
import {
	sourceDatabaseFilename,
	V2StoreReader,
} from "../../../plugin/src/v2/store-reader";
import rows from "../../src/opencode2-runner/host-rows.json";
import golden from "../../src/opencode2-runner/reader-s4-golden.json";
import { isolation } from "../../src/opencode2-runner/spawn";

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
	const writer = new Database(path);
	writer.exec(
		"CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT)",
	);
	const insert = writer.prepare(
		"INSERT INTO session_message VALUES (?, ?, ?, ?, ?)",
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
	const id = rows[0]!.session_id;
	try {
		expect(JSON.stringify(reader.window(id))).toBe(JSON.stringify(rows));
		expect(() =>
			(reader as unknown as { db: Database }).db.exec(
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

test("latestAssistant selects the newest assistant row by seq and ignores other types", () => {
	const { root } = isolation();
	const path = join(root, "latest-assistant.db");
	const writer = new Database(path);
	writer.exec(
		"CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT)",
	);
	const insert = writer.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)");
	// Insert order deliberately shuffled so ORDER BY rowid cannot stand in for seq.
	insert.run("m4", "ses-A", "assistant", 4, JSON.stringify({ model: { providerID: "p", id: "new" } }));
	insert.run("m2", "ses-A", "user", 2, JSON.stringify({}));
	insert.run("m1", "ses-A", "assistant", 1, JSON.stringify({ model: { providerID: "p", id: "old" } }));
	insert.run("m3", "ses-B", "assistant", 3, JSON.stringify({ model: { providerID: "p", id: "other" } }));
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
	const v1 = new Database(v1Path);
	const v2 = new Database(v2Path);
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
	const db = new Database(path);
	db.exec("CREATE TABLE message(id TEXT); CREATE TABLE part(id TEXT)");
	db.close();
	expect(() => new V2StoreReader(path)).toThrow("expected v2, found v1");
});
