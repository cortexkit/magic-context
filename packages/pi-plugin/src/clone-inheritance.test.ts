/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CloneSessionStateFilter,
	copySessionStateForClone,
	getOrCreateSessionMeta,
	getSourceContents,
	getTagsBySession,
} from "@magic-context/core/features/magic-context/storage";
import { replayCavemanCompression } from "@magic-context/core/hooks/magic-context/caveman-cleanup";
import type { TagTarget } from "@magic-context/core/hooks/magic-context/tag-messages";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
	__test,
	handlePiCloneSessionStart,
	readPiSessionIdFromFile,
} from "./clone-inheritance";
import { mustMaterializePi } from "./inject-compartments-pi";
import { createTestDb } from "./test-utils.test";

const openDatabases: Database[] = [];
const temporaryDirectories: string[] = [];

function db(): Database {
	const value = createTestDb();
	openDatabases.push(value);
	return value;
}

afterEach(async () => {
	for (const database of openDatabases.splice(0)) database.close();
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

function user(id: string): unknown {
	return {
		type: "message",
		id,
		message: { role: "user", content: id, timestamp: 1 },
	};
}

function assistant(id: string): unknown {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			content: [{ type: "text", text: id }],
			provider: "test",
			model: "test",
			timestamp: 2,
		},
	};
}

function toolResult(id: string, callId = "call-1"): unknown {
	return {
		type: "message",
		id,
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "read",
			content: [{ type: "text", text: id }],
			timestamp: 2,
		},
	};
}

function compaction(id: string, firstKeptEntryId: string): unknown {
	return { type: "compaction", id, firstKeptEntryId, summary: "summary" };
}

function seedCompartment(
	database: Database,
	args: {
		sessionId?: string;
		sequence: number;
		startId: string;
		endId: string;
		start?: number;
		end?: number;
	},
): void {
	database
		.prepare(
			`INSERT INTO compartments
			 (session_id, sequence, start_message, end_message, start_message_id,
			  end_message_id, title, content, p1, p2, p3, p4, importance,
			  episode_type, legacy, created_at, harness)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			args.sessionId ?? "source",
			args.sequence,
			args.start ?? 1,
			args.end ?? 2,
			args.startId,
			args.endId,
			`title-${args.sequence}`,
			`content-${args.sequence}`,
			`p1-${args.sequence}`,
			`p2-${args.sequence}`,
			null,
			null,
			73,
			"feature",
			0,
			1000 + args.sequence,
			"pi",
		);
}

function seedTag(
	database: Database,
	args: {
		tagNumber: number;
		messageId: string;
		type?: "message" | "tool" | "file";
		ownerId?: string | null;
		status?: "active" | "dropped" | "compacted";
		cavemanDepth?: number;
	},
): void {
	database
		.prepare(
			`INSERT INTO tags
			 (session_id, message_id, type, status, byte_size, tag_number, harness,
			  entry_fingerprint, token_count, input_token_count, reasoning_token_count,
			  reasoning_byte_size, drop_mode, tool_name, input_byte_size,
			  caveman_depth, tool_owner_message_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			"source",
			args.messageId,
			args.type ?? "message",
			args.status ?? "active",
			100 + args.tagNumber,
			args.tagNumber,
			"pi",
			`fingerprint-${args.tagNumber}`,
			20,
			3,
			2,
			11,
			"truncated",
			args.type === "tool" ? "read" : null,
			9,
			args.cavemanDepth ?? 0,
			args.ownerId ?? null,
		);
}

function count(database: Database, table: string, sessionId = "clone"): number {
	return (
		database
			.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
			.get(sessionId) as { count: number }
	).count;
}

function copyWithEntries(database: Database, entries: unknown[]) {
	return copySessionStateForClone(
		database,
		"source",
		"clone",
		__test.createCloneFilter(entries),
	);
}

function seedMeta(database: Database, values: Record<string, unknown>): void {
	const columns = Object.keys(values);
	const placeholders = columns.map(() => "?").join(", ");
	database
		.prepare(
			`INSERT INTO session_meta (session_id, harness, ${columns.join(", ")}) VALUES (?, ?, ${placeholders})`,
		)
		.run("source", "pi", ...Object.values(values));
}

function pending(
	firstKeptEntryId: string,
	endMessageId: string,
	ordinal: number,
): string {
	return JSON.stringify({
		firstKeptEntryId,
		endMessageId,
		ordinal,
		tokensBefore: 123,
		summary: "marker summary",
		publishedAt: 456,
	});
}

describe("Pi clone state inheritance", () => {
	it("filters prefix clones, including compartments that span the fork point", () => {
		const database = db();
		seedCompartment(database, { sequence: 1, startId: "u1", endId: "a1" });
		seedCompartment(database, { sequence: 2, startId: "u3", endId: "a3" });
		seedCompartment(database, { sequence: 3, startId: "u2", endId: "a3" });
		seedTag(database, { tagNumber: 1, messageId: "a1:p0", status: "dropped" });
		seedTag(database, { tagNumber: 2, messageId: "a3:p0" });
		seedTag(database, {
			tagNumber: 3,
			messageId: "call-3",
			type: "tool",
			ownerId: "a3",
		});

		const result = copyWithEntries(database, [
			user("u1"),
			assistant("a1"),
			user("u2"),
		]);

		expect(result).toMatchObject({ compartmentsCopied: 1, tagsCopied: 1 });
		const compartments = database
			.prepare(
				"SELECT sequence, start_message, end_message FROM compartments WHERE session_id = ?",
			)
			.all("clone");
		expect(compartments).toEqual([
			{ sequence: 1, start_message: 1, end_message: 2 },
		]);
		const copiedTag = database
			.prepare(
				"SELECT tag_number, status, drop_mode, token_count FROM tags WHERE session_id = ?",
			)
			.get("clone");
		expect(copiedTag).toEqual({
			tag_number: 1,
			status: "dropped",
			drop_mode: "truncated",
			token_count: 20,
		});
	});

	it("migrates a compartment whose boundary is a synthetic folded-tool user", () => {
		const database = db();
		seedCompartment(database, {
			sequence: 1,
			startId: "synth-user-tool-1",
			endId: "a1",
		});

		const result = copyWithEntries(database, [
			toolResult("tool-1"),
			assistant("a1"),
		]);

		expect(result.compartmentsCopied).toBe(1);
		expect(
			database
				.prepare(
					"SELECT start_message, end_message FROM compartments WHERE session_id = ?",
				)
				.get("clone"),
		).toEqual({ start_message: 1, end_message: 2 });
	});

	it("inherits session notes and facts with fork-prefix anchors remapped", () => {
		const database = db();
		database
			.prepare(
				`INSERT INTO notes
				 (type, status, content, session_id, created_at, updated_at, harness,
				  anchor_ordinal, anchor_block_id)
				 VALUES ('session', 'active', ?, ?, ?, ?, 'pi', ?, ?)`,
			)
			.run("kept note", "source", 10, 10, 2, "a1#0");
		database
			.prepare(
				`INSERT INTO notes
				 (type, status, content, session_id, created_at, updated_at, harness,
				  anchor_ordinal, anchor_block_id)
				 VALUES ('session', 'active', ?, ?, ?, ?, 'pi', ?, ?)`,
			)
			.run("future note", "source", 11, 11, 3, "u3#0");
		database
			.prepare(
				"INSERT INTO session_facts (session_id, category, content, created_at, updated_at, harness) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("source", "decision", "keep the invariant", 12, 12, "pi");
		const sourceNoteId = (
			database
				.prepare(
					"SELECT id FROM notes WHERE session_id = ? ORDER BY id LIMIT 1",
				)
				.get("source") as { id: number }
		).id;
		const sourceFactId = (
			database
				.prepare("SELECT id FROM session_facts WHERE session_id = ?")
				.get("source") as { id: number }
		).id;

		const result = copyWithEntries(database, [user("u1"), assistant("a1")]);

		expect(result).toMatchObject({ notesCopied: 1, factsCopied: 1 });
		const note = database
			.prepare(
				"SELECT id, content, anchor_ordinal, anchor_block_id FROM notes WHERE session_id = ?",
			)
			.get("clone") as {
			id: number;
			content: string;
			anchor_ordinal: number;
			anchor_block_id: string;
		};
		expect(note).toEqual({
			id: expect.any(Number),
			content: "kept note",
			anchor_ordinal: 2,
			anchor_block_id: "a1#0",
		});
		expect(note.id).not.toBe(sourceNoteId);
		const fact = database
			.prepare(
				"SELECT id, category, content FROM session_facts WHERE session_id = ?",
			)
			.get("clone") as { id: number; category: string; content: string };
		expect(fact).toMatchObject({
			category: "decision",
			content: "keep the invariant",
		});
		expect(fact.id).not.toBe(sourceFactId);
	});

	it("does not migrate a pending marker already represented by the copied compaction", () => {
		const database = db();
		seedCompartment(database, {
			sequence: 1,
			startId: "u1",
			endId: "a2",
			end: 4,
		});
		seedMeta(database, {
			pending_pi_compaction_marker_state: pending("u1", "a2", 4),
		});

		const result = copyWithEntries(database, [
			user("u1"),
			assistant("a1"),
			compaction("c1", "u2"),
			user("u2"),
			assistant("a2"),
		]);

		expect(result.pendingMarkerMigrated).toBe(false);
		expect(getOrCreateSessionMeta(database, "clone")).toBeDefined();
		expect(
			(
				database
					.prepare(
						"SELECT pending_pi_compaction_marker_state AS marker FROM session_meta WHERE session_id = ?",
					)
					.get("clone") as { marker: string | null }
			).marker,
		).toBeNull();
	});

	it("migrates a newer pending marker beyond a copied compaction cut", () => {
		const database = db();
		seedCompartment(database, {
			sequence: 1,
			startId: "u1",
			endId: "a2",
			end: 4,
		});
		seedMeta(database, {
			pending_pi_compaction_marker_state: pending("u2", "a2", 99),
		});

		const result = copyWithEntries(database, [
			user("u1"),
			assistant("a1"),
			compaction("c1", "u1"),
			user("u2"),
			assistant("a2"),
		]);

		expect(result.pendingMarkerMigrated).toBe(true);
		const marker = JSON.parse(
			(
				database
					.prepare(
						"SELECT pending_pi_compaction_marker_state AS marker FROM session_meta WHERE session_id = ?",
					)
					.get("clone") as { marker: string }
			).marker,
		);
		expect(marker).toMatchObject({
			firstKeptEntryId: "u2",
			endMessageId: "a2",
			ordinal: 4,
		});
	});

	it("migrates an applicable pending marker when the clone has no compaction entry", () => {
		const database = db();
		seedCompartment(database, { sequence: 1, startId: "u1", endId: "a1" });
		seedMeta(database, {
			pending_pi_compaction_marker_state: pending("u1", "a1", 2),
		});

		const result = copyWithEntries(database, [user("u1"), assistant("a1")]);

		expect(result.pendingMarkerMigrated).toBe(true);
	});

	it("drops a pending marker that references outside the copied prefix", () => {
		const database = db();
		seedCompartment(database, { sequence: 1, startId: "u1", endId: "a1" });
		seedMeta(database, {
			pending_pi_compaction_marker_state: pending("u3", "a3", 6),
		});

		const result = copyWithEntries(database, [user("u1"), assistant("a1")]);

		expect(result.pendingMarkerMigrated).toBe(false);
	});

	it("skips atomically when the destination already has compartments or tags", () => {
		const database = db();
		seedCompartment(database, { sequence: 1, startId: "u1", endId: "a1" });
		seedTag(database, { tagNumber: 1, messageId: "a1:p0" });
		seedCompartment(database, {
			sessionId: "clone",
			sequence: 99,
			startId: "existing-u",
			endId: "existing-a",
		});

		const result = copyWithEntries(database, [user("u1"), assistant("a1")]);

		expect(result.kind).toBe("destination-not-empty");
		expect(count(database, "compartments")).toBe(1);
		expect(count(database, "tags")).toBe(0);
		expect(count(database, "session_meta")).toBe(0);
	});

	it("rolls back every copied row when a filter fails mid-copy", () => {
		const database = db();
		seedCompartment(database, { sequence: 1, startId: "u1", endId: "a1" });
		seedTag(database, { tagNumber: 1, messageId: "u1:p0" });
		seedTag(database, { tagNumber: 2, messageId: "a1:p0" });
		let visits = 0;
		const filter: CloneSessionStateFilter = {
			resolveBoundaryOrdinal: (id) =>
				id === "u1" ? 1 : id === "a1" ? 2 : undefined,
			includeMessageId: () => true,
			includeTag: () => {
				visits += 1;
				if (visits === 2) throw new Error("injected copy failure");
				return true;
			},
			selectPendingPiMarker: () => null,
		};

		expect(() =>
			copySessionStateForClone(database, "source", "clone", filter),
		).toThrow("injected copy failure");
		for (const table of [
			"compartments",
			"tags",
			"source_contents",
			"pending_ops",
			"session_meta",
		]) {
			expect(count(database, table)).toBe(0);
		}
	});

	it("copies pending operations only for copied tags", () => {
		const database = db();
		seedTag(database, { tagNumber: 1, messageId: "u1:p0" });
		seedTag(database, { tagNumber: 2, messageId: "u3:p0" });
		database
			.prepare(
				"INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, ?, ?, ?)",
			)
			.run("source", 1, "drop", 100, "pi");
		database
			.prepare(
				"INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, ?, ?, ?)",
			)
			.run("source", 2, "drop", 200, "pi");

		const result = copyWithEntries(database, [user("u1")]);

		expect(result.pendingOpsCopied).toBe(1);
		expect(
			database
				.prepare(
					"SELECT tag_id, operation, queued_at FROM pending_ops WHERE session_id = ?",
				)
				.all("clone"),
		).toEqual([{ tag_id: 1, operation: "drop", queued_at: 100 }]);
	});

	it("migrates all todo fields together when the anchor is on the clone path", () => {
		const database = db();
		seedMeta(database, {
			last_todo_state: '[{"content":"carry"}]',
			todo_synthetic_call_id: "todo-call",
			todo_synthetic_anchor_message_id: "a1",
			todo_synthetic_state_json: '[{"content":"carry"}]',
		});

		copyWithEntries(database, [user("u1"), assistant("a1")]);

		expect(
			database
				.prepare(
					`SELECT last_todo_state, todo_synthetic_call_id,
					        todo_synthetic_anchor_message_id, todo_synthetic_state_json
					   FROM session_meta WHERE session_id = ?`,
				)
				.get("clone"),
		).toEqual({
			last_todo_state: '[{"content":"carry"}]',
			todo_synthetic_call_id: "todo-call",
			todo_synthetic_anchor_message_id: "a1",
			todo_synthetic_state_json: '[{"content":"carry"}]',
		});
	});

	it("migrates no todo fields when the synthetic anchor is beyond the fork", () => {
		const database = db();
		seedMeta(database, {
			last_todo_state: '[{"content":"newer"}]',
			todo_synthetic_call_id: "todo-call",
			todo_synthetic_anchor_message_id: "a3",
			todo_synthetic_state_json: '[{"content":"newer"}]',
		});

		copyWithEntries(database, [user("u1"), assistant("a1")]);

		const row = database
			.prepare(
				`SELECT last_todo_state, todo_synthetic_call_id,
				        todo_synthetic_anchor_message_id, todo_synthetic_state_json
				   FROM session_meta WHERE session_id = ?`,
			)
			.get("clone");
		expect(row).toEqual({
			last_todo_state: "",
			todo_synthetic_call_id: "",
			todo_synthetic_anchor_message_id: "",
			todo_synthetic_state_json: "",
		});
	});

	it("copies source contents so caveman replay works on a migrated tag", () => {
		const database = db();
		const original =
			"I just really basically wanted to clearly explain ".repeat(20);

		seedTag(database, {
			tagNumber: 7,
			messageId: "u1:p0",
			cavemanDepth: 3,
		});
		database
			.prepare(
				"INSERT INTO source_contents (tag_id, session_id, content, created_at, harness) VALUES (?, ?, ?, ?, ?)",
			)
			.run(7, "source", original, 100, "pi");

		copyWithEntries(database, [user("u1")]);

		expect(getSourceContents(database, "clone", [7]).get(7)).toBe(original);
		let rendered = original;
		const targets = new Map<number, TagTarget>([
			[
				7,
				{
					getContent: () => rendered,
					setContent: (content) => {
						const changed = rendered !== content;
						rendered = content;
						return changed;
					},
				},
			],
		]);
		expect(
			replayCavemanCompression(
				"clone",
				database,
				targets,
				getTagsBySession(database, "clone"),
			),
		).toBe(1);
		expect(rendered).not.toBe(original);
	});

	it("sets the clone counter and watermarks from the maximum copied tag", () => {
		const database = db();
		seedTag(database, { tagNumber: 4, messageId: "u1:p0" });
		seedTag(database, { tagNumber: 12, messageId: "u3:p0" });
		seedMeta(database, {
			counter: 99,
			cleared_reasoning_through_tag: 20,
			tool_reclaim_watermark: 10,
		});

		copyWithEntries(database, [user("u1")]);

		const meta = database
			.prepare(
				"SELECT counter, cleared_reasoning_through_tag, tool_reclaim_watermark FROM session_meta WHERE session_id = ?",
			)
			.get("clone");
		expect(meta).toEqual({
			counter: 4,
			cleared_reasoning_through_tag: 4,
			tool_reclaim_watermark: 4,
		});
	});

	it("inherits frozen ids that remain on the clone path", () => {
		const database = db();
		seedMeta(database, {
			stripped_placeholder_ids: JSON.stringify(["a1", "a3"]),
			processed_image_stripped_ids: JSON.stringify(["u1", "u3"]),
		});

		copyWithEntries(database, [user("u1"), assistant("a1")]);

		const row = database
			.prepare(
				`SELECT stripped_placeholder_ids AS placeholders,
				        processed_image_stripped_ids AS images
				   FROM session_meta WHERE session_id = ?`,
			)
			.get("clone") as { placeholders: string; images: string };
		expect(JSON.parse(row.placeholders)).toEqual(["a1"]);
		expect(JSON.parse(row.images)).toEqual(["u1"]);
	});

	it("leaves every m0/m1 cache field fresh so the first pass hard-materializes", () => {
		const database = db();
		seedCompartment(database, { sequence: 1, startId: "u1", endId: "a1" });
		seedMeta(database, {
			cached_m0_bytes: Buffer.from("source-m0"),
			cached_m1_bytes: Buffer.from("source-m1"),
			memory_block_cache: "source-memory-cache",
			memory_block_ids: "[1,2]",
			cached_m0_max_compartment_seq: 1,
		});

		copyWithEntries(database, [user("u1"), assistant("a1")]);

		const decision = mustMaterializePi(
			{
				sessionId: "clone",
				projectIdentity: "project",
				projectDirectory: "/project",
			},
			database,
		);
		expect(decision).toEqual({ value: true, reason: "first_render" });
		const cacheRow = database
			.prepare(
				`SELECT cached_m0_bytes, cached_m1_bytes, memory_block_cache,
				        memory_block_ids, cached_m0_max_compartment_seq
				   FROM session_meta WHERE session_id = ?`,
			)
			.get("clone");
		expect(cacheRow).toEqual({
			cached_m0_bytes: null,
			cached_m1_bytes: null,
			memory_block_cache: "",
			memory_block_ids: "",
			cached_m0_max_compartment_seq: null,
		});
	});

	it("reads the source id from the previous JSONL header", async () => {
		const directory = await mkdtemp(join(tmpdir(), "mc-clone-header-"));
		temporaryDirectories.push(directory);
		const file = join(directory, "source.jsonl");
		await writeFile(
			file,
			'{"type":"session","id":"source-id"}\n{"type":"message"}\n',
		);
		expect(await readPiSessionIdFromFile(file)).toBe("source-id");
	});

	it("signals a migrated pending marker only after the transaction commits", async () => {
		const database = db();
		seedCompartment(database, { sequence: 1, startId: "u1", endId: "a1" });
		seedMeta(database, {
			pending_pi_compaction_marker_state: pending("u1", "a1", 2),
		});
		const directory = await mkdtemp(join(tmpdir(), "mc-clone-signal-"));
		temporaryDirectories.push(directory);
		const file = join(directory, "source.jsonl");
		await writeFile(file, '{"type":"session","id":"source"}\n');
		let markerVisibleAtSignal = false;

		const result = await handlePiCloneSessionStart(
			{ reason: "fork", previousSessionFile: file },
			{
				sessionManager: {
					getSessionId: () => "clone",
					getBranch: () => [user("u1"), assistant("a1")],
				},
			},
			{
				db: database,
				signalPendingMarker: () => {
					markerVisibleAtSignal =
						(
							database
								.prepare(
									"SELECT pending_pi_compaction_marker_state AS marker FROM session_meta WHERE session_id = ?",
								)
								.get("clone") as { marker: string | null }
						).marker !== null;
				},
				writeLog: () => undefined,
			},
		);

		expect(result?.pendingMarkerMigrated).toBe(true);
		expect(markerVisibleAtSignal).toBe(true);
	});

	it("fails open with one actionable structured log line", async () => {
		const database = db();
		const messages: string[] = [];

		const result = await handlePiCloneSessionStart(
			{ reason: "fork", previousSessionFile: "/missing/source.jsonl" },
			{ sessionManager: { getSessionId: () => "clone" } },
			{
				db: database,
				signalPendingMarker: () => undefined,
				writeLog: (message) => messages.push(message),
			},
		);

		expect(result).toBeNull();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain(
			"source=unknown dest=clone stage=read-source-header",
		);
		expect(messages[0]).toContain("run /ctx-wrapup to rebuild, or re-clone");
	});
});
