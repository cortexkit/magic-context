import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeProtectionWindow } from "@magic-context/core/features/magic-context/protection-window";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import {
	cleanupTestTempDir,
	createTestTempDirFromPath,
} from "@magic-context/core/shared/test-temp-dir";
import {
	LARGE_SESSION_ID,
	seedLargeSession,
} from "./__tests__/large-session-profile.fixture";
import { __test, clearContextHandlerSession } from "./context-handler";
import { protectedPiPassTagNumbers } from "./pass-tag-projection-pi";
import {
	createPiTagSnapshotCandidate,
	getPiActiveTagSnapshotView,
	getPiPassTagSnapshotView,
	getPiTagSnapshotView,
	projectPiPassTag,
} from "./tag-snapshot-pi";
import { startPiTagSnapshotWorker } from "./tag-snapshot-worker-client-pi";
import { measurePiTailHygiene } from "./tail-hygiene-walk-pi";
import {
	assistantToolCall,
	createTestDb,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

test("pass projection preserves historical attribution and atomic protection without full historical rows", () => {
	const db = createTestDb();
	try {
		const insert =
			db.prepare(`INSERT INTO tags(session_id, tag_number, message_id,
			type, status, byte_size, tool_owner_message_id, token_count, tool_name)
			VALUES ('s', ?, ?, ?, ?, 4096, ?, ?, 'Read')`);
		for (let number = 1; number <= 1000; number++) {
			insert.run(
				number,
				`call-${number}`,
				"tool",
				number > 990 ? "active" : number % 2 ? "dropped" : "compacted",
				`owner-${number}`,
				number % 7 ? 31 : 0,
			);
		}
		insert.run(1001, "user:p0", "message", "dropped", null, 9);
		const full = getPiTagSnapshotView(db, "s");
		const pass = getPiPassTagSnapshotView(db, "s");
		expect(
			pass
				.filter((row) => row.status !== "active")
				.every((row) => !("byteSize" in row) && !("dropMode" in row)),
		).toBe(true);
		expect(getPiActiveTagSnapshotView(db, "s", pass)).toEqual(
			full.filter((row) => row.status === "active"),
		);
		expect(getPiTagSnapshotView(db, "s")).toEqual(full);
		for (const floor of [0, 1, 100, 20_000, Infinity]) {
			for (const ratio of [0, 0.7, 1, 1.3]) {
				expect(
					[...protectedPiPassTagNumbers(pass, floor, ratio)].sort(
						(a, b) => a - b,
					),
				).toEqual(
					[
						...computeProtectionWindow(full, floor, ratio).protectedTagNumbers,
					].sort((a, b) => a - b),
				);
			}
		}
		const messages = [
			assistantToolCall("call-1", "Read", { path: "old" }, 1),
			toolResultMessage("call-1", "§1§ historical output", 2),
			userMessage("§1001§ historical user", 3),
		];
		const input = {
			messages,
			protectedTagNumbers: new Set<number>(),
			stableId: (_message: unknown, index: number) =>
				["owner-1", "result", "user"][index],
		};
		expect(measurePiTailHygiene({ ...input, tags: pass })).toEqual(
			measurePiTailHygiene({ ...input, tags: full }),
		);
		const initial = createPiTagSnapshotCandidate();
		for (const row of pass) initial.appendTag(row);
		initial.end("tags");
		initial.end("fallback");
		const cold = initial.finish();
		const replay = createPiTagSnapshotCandidate(cold.tags);
		for (const row of getTagsBySession(db, "s").map(projectPiPassTag))
			replay.appendTag(row);
		replay.end("tags");
		replay.end("fallback");
		const warm = replay.finish();
		expect(warm.tags.every((row, index) => row === cold.tags[index])).toBe(
			true,
		);
		expect(warm.allocatedBytes).toBeLessThan(cold.allocatedBytes / 10);
	} finally {
		db.close();
	}
});

test("restart validates text sources independently of tool identity and stable-ID drift", () => {
	const db = createTestDb();
	const session = "restart-text";
	try {
		const tagger = createTagger();
		tagger.initFromDb(session, db);
		tagTranscript(
			session,
			createPiTranscript([userMessage("original", 1)], session, ["entry"]),
			tagger,
			db,
		);
		clearContextHandlerSession(session);
		const restarted = createTagger();
		restarted.initFromDb(session, db);
		const transcript = createPiTranscript(
			[userMessage("original", 1)],
			session,
			["entry"],
		);
		const plan = __test.buildPiTextIdentityPlan(
			db,
			session,
			restarted,
			transcript,
		);
		expect(plan.reusableTextMessageIds.has("entry")).toBe(true);
		expect(plan.reusableMessageIds.size).toBe(0);
		let assignments = 0;
		tagTranscript(
			session,
			transcript,
			{
				...restarted,
				assignTag(...args) {
					assignments++;
					return restarted.assignTag(...args);
				},
			},
			db,
			{
				reuseTextMessageIds: plan.reusableTextMessageIds,
				textIdentitySourceCache: plan.sourceCache,
			},
		);
		expect(assignments).toBe(0);
		const drift = __test.buildPiTextIdentityPlan(
			db,
			session,
			restarted,
			createPiTranscript([userMessage("rewritten", 1)], session, ["entry"]),
		);
		expect(drift.reusableTextMessageIds.has("entry")).toBe(false);
		expect(drift.driftedMessageIds.has("entry")).toBe(true);
	} finally {
		db.close();
		clearContextHandlerSession(session);
	}
});

test("cold persisted tool accounting skips unchanged tokenization but counts growth", () => {
	const db = createTestDb();
	try {
		const session = "restart-tools";
		const input = () => [
			assistantToolCall("call", "Read", { path: "file" }, 1),
			toolResultMessage("call", "original result", 2),
		];
		const ids = ["owner", "result"];
		const first = createTagger();
		first.initFromDb(session, db);
		const original = createPiTranscript(input(), session, ids);
		tagTranscript(session, original, first, db);
		const replay = createTagger();
		replay.initFromDb(session, db);
		const transcript = createPiTranscript(input(), session, ids);
		const tools = new Map<string, { text: string; tokenCount: number }>();
		const view = transcript.messages.map((message) => ({
			...message,
			parts: message.parts,
		}));
		let inputTokenizations = 0;
		for (const message of view)
			for (const part of message.parts) {
				const metadata = part.getToolMetadata.bind(part);
				part.getToolMetadata = (options) => {
					if (part.kind === "tool_use" && !options?.skipInputTokenCount)
						inputTokenizations++;
					return metadata(options);
				};
			}
		tagTranscript(session, { ...transcript, messages: view }, replay, db, {
			toolTokenCache: tools,
		});
		expect(tools.size).toBe(0);
		expect(inputTokenizations).toBe(0);
		expect(transcript.getOutputMessages()).toEqual(
			original.getOutputMessages(),
		);
		const grown = createPiTranscript(
			[
				assistantToolCall("call", "Read", { path: "file" }, 1),
				toolResultMessage("call", "larger output ".repeat(100), 2),
			],
			session,
			ids,
		);
		tagTranscript(session, grown, replay, db, { toolTokenCache: tools });
		expect(tools.size).toBeGreaterThan(0);
		expect(
			replay.getToolTagAccounting(session, "call", "owner")?.byteSize,
		).toBeGreaterThan(100);
	} finally {
		db.close();
	}
});

test("250000 historical tags hydrate under the unchanged snapshot admission cap", async () => {
	const scratch = resolve(import.meta.dir, "../../../target/scratch");
	mkdirSync(scratch, { recursive: true });
	const directory = createTestTempDirFromPath(
		join(scratch, "pi-pass-admission-"),
	);
	const path = join(directory, "context.sqlite");
	const db = createTestDb(path);
	try {
		seedLargeSession(db, 250_000);
		const job = startPiTagSnapshotWorker({
			path,
			sessionId: LARGE_SESSION_ID,
			connectionEpoch: 1,
			sessionEpoch: 1,
			jobId: 1,
			projection: "pass",
		});
		try {
			const { candidate } = await job.result;
			expect(candidate.tags.length).toBe(250_000);
			expect(candidate.active.length).toBe(2500);
			expect(candidate.fallback.length).toBe(250);
			expect(candidate.estimatedBytes).toBeLessThan(128 * 1024 * 1024);
		} finally {
			await job.released;
		}
	} finally {
		db.close();
		cleanupTestTempDir(directory);
	}
}, 120_000);
