import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	appendCompartments,
	getCompartments,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import {
	readSessionChunk,
	withRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import * as logger from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import { applyDeferredPiCompactionMarker } from "./compaction-marker-manager-pi";
import {
	awaitInFlightHistorians,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { findFirstKeptEntryId } from "./pi-historian-runner";
import {
	clearPiOrdinalAlignmentSession,
	isPiOrdinalAlignmentUnanchored,
	piRawOrdinalOffsetSource,
	resolvePiOrdinalAlignment,
} from "./pi-ordinal-alignment";
import {
	convertEntriesToRawMessagePage,
	convertEntriesToRawMessages,
	countPiRawMessages,
	readPiSessionSnapshot,
} from "./read-session-pi";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createCtxExpandTool } from "./tools/ctx-expand";

const LOST = 65_920;
const END = 65_938;
const START_TIME = Date.UTC(2026, 9, 5, 10, 41, 39);
type Entry = {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: unknown;
};

// Compartment end 65,938 is the assistant's two tool calls. The raw reader
// combines the following two result entries into one message at ordinal 65,939.
function reachableEntries(): Entry[] {
	const entries: Entry[] = [];
	const add = (id: string, message: unknown) => {
		entries.push({
			type: "message",
			id,
			parentId: entries.at(-1)?.id ?? "missing-parent",
			timestamp: new Date(START_TIME + entries.length * 1000).toISOString(),
			message,
		});
	};
	for (let local = 1; local <= 17; local++) {
		const timestamp = START_TIME + local * 1000;
		add(
			`b${local}`,
			local % 2
				? assistantMessage(`reachable ${local}`, timestamp)
				: userMessage(`reachable ${local}`, timestamp),
		);
	}
	add(
		"anchor-call",
		assistantToolCall("arc-a", "read", { path: "a" }, START_TIME + 18000),
	);
	add(
		"result-a",
		toolResultMessage("arc-a", "result payload a", START_TIME + 19000),
	);
	add(
		"result-b",
		toolResultMessage("arc-b", "result payload b", START_TIME + 20000),
	);
	// Both tool calls belong to the same invocation message.
	(entries[17]?.message as { content: unknown[] }).content.push({
		type: "toolCall",
		id: "arc-b",
		name: "read",
		arguments: { path: "b" },
	});
	add(
		"answer",
		assistantMessage("answer after both results", START_TIME + 21000),
	);
	for (let local = 21; local <= 160; local++) {
		add(
			`b${local}`,
			local % 2
				? userMessage(`reachable ${local}`, START_TIME + local * 1000)
				: assistantMessage(`reachable ${local}`, START_TIME + local * 1000),
		);
	}
	return entries;
}

function seed(db: Database, sessionId: string, offset = LOST): void {
	appendCompartments(db, sessionId, [
		{
			sequence: 0,
			startMessage: 1,
			endMessage: offset + 9,
			startMessageId: "old-1",
			endMessageId: "b9",
			title: "Older work",
			content: "Older stored work.",
			p1: "Older stored work.",
		},
		{
			sequence: 1,
			startMessage: offset + 10,
			endMessage: offset + 18,
			startMessageId: "b10",
			endMessageId: "anchor-call",
			title: "Latest work",
			content: "Latest stored work.",
			p1: "Latest stored work.",
		},
	]);
}

function ctx(sessionId: string, entries: readonly Entry[]) {
	return {
		...fakeContext(sessionId),
		sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
	};
}

async function expand(
	db: Database,
	sessionId: string,
	entries: readonly Entry[],
	params: Record<string, unknown>,
): Promise<string> {
	const result = await createCtxExpandTool({ db }).execute(
		"expand",
		params as never,
		new AbortController().signal,
		undefined,
		ctx(sessionId, entries) as never,
	);
	return (result.content[0] as { text: string }).text;
}

function provider(entries: readonly Entry[], offset: number) {
	return {
		readMessages: () => convertEntriesToRawMessages(entries, offset),
		readMessagePage: (after: number, limit: number, watermark: number) =>
			convertEntriesToRawMessagePage(entries, after, limit, watermark, offset),
		getMessageCount: () => countPiRawMessages(entries, offset),
	};
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	mock.restore();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

async function withFixture(
	run: (
		db: Database,
		sessionId: string,
		entries: Entry[],
	) => void | Promise<void>,
	offset = LOST,
) {
	const db = createTestDb();
	const sessionId = `ordinal-review-${crypto.randomUUID()}`;
	try {
		seed(db, sessionId, offset);
		await run(db, sessionId, reachableEntries());
	} finally {
		clearContextHandlerSession(sessionId);
		clearPiOrdinalAlignmentSession(sessionId);
		closeQuietly(db);
	}
}

describe("Pi ordinal offset independent review", () => {
	it("unreachable verbose range: reports unavailable instead of invented system messages", async () => {
		await withFixture(async (db, sessionId, entries) => {
			const text = await expand(db, sessionId, entries, {
				start: 1001,
				end: 1002,
				verbose: true,
			});
			expect(text).toContain("No messages found");
		});
	});
	it("unreachable verbose range partner: ordinary range reports no messages", async () => {
		await withFixture(async (db, sessionId, entries) => {
			expect(
				await expand(db, sessionId, entries, { start: 1001, end: 1002 }),
			).toContain("No messages found");
		});
	});

	it("unreachable single message: reports unavailable instead of full recovery", async () => {
		await withFixture(async (db, sessionId, entries) => {
			expect(await expand(db, sessionId, entries, { message: 1001 })).toContain(
				"No message at ordinal 1001",
			);
		});
	});
	it("unreachable single message partner: a reachable stored ordinal recovers the right text", async () => {
		await withFixture(async (db, sessionId, entries) => {
			expect(
				await expand(db, sessionId, entries, { message: LOST + 1 }),
			).toContain("reachable 1");
		});
	});

	it("unanchored expansion: refuses a lost stored range instead of relabeling branch messages", async () => {
		await withFixture(async (db, sessionId, entries) => {
			const jumped = entries.slice(0, 12);
			expect(resolvePiOrdinalAlignment(db, sessionId, jumped).kind).toBe(
				"unanchored",
			);
			expect(
				await expand(db, sessionId, jumped, { start: 1, end: 2 }),
			).not.toContain("reachable 1");
		});
	});
	it("unanchored expansion partner: a placed offset never aliases the lost stored range", async () => {
		await withFixture(async (db, sessionId, entries) => {
			expect(
				await expand(db, sessionId, entries, { start: 1, end: 2 }),
			).toContain("No messages found");
		});
	});

	it("anchor read failure: does not claim shifted history is aligned", async () => {
		await withFixture((db, sessionId, entries) => {
			const prepare = db.prepare.bind(db);
			spyOn(db, "prepare").mockImplementation((sql: string) => {
				if (
					sql.startsWith(
						"SELECT sequence, start_message, end_message, start_message_id",
					)
				)
					throw new Error("fixture anchor read unavailable");
				return prepare(sql);
			});
			expect(
				isPiOrdinalAlignmentUnanchored(
					resolvePiOrdinalAlignment(db, sessionId, entries),
				),
			).toBe(true);
		});
	});
	it("anchor read failure partner: a readable anchor proves the offset", async () => {
		await withFixture((db, sessionId, entries) => {
			expect(resolvePiOrdinalAlignment(db, sessionId, entries)).toMatchObject({
				kind: "shifted",
				offset: LOST,
			});
		});
	});

	it("marker cuts use stored ordinals at the anchor, first entry, and newest entry", async () => {
		await withFixture((db, sessionId, entries) => {
			// By stored ordinal alone, the combined results after the anchor have no
			// single JSONL entry ID to keep (the fallback for a boundary the branch
			// does not hold). The drain below places the marker by the history cut.
			expect(findFirstKeptEntryId(entries, END, LOST)).toBeNull();
			expect(findFirstKeptEntryId(entries, LOST, LOST)).toBe("b1");
			expect(findFirstKeptEntryId(entries, LOST + 1, LOST)).toBe("b2");
			expect(findFirstKeptEntryId(entries, LOST + 159, LOST)).toBe("b160");
			expect(findFirstKeptEntryId(entries, LOST + 160, LOST)).toBeNull();
			const appended: string[] = [];
			const deps = {
				db,
				readBranchEntries: () => entries,
				appendCompaction: (_summary: string, kept: string) => {
					appended.push(kept);
					return "marker";
				},
			};
			const pending = {
				firstKeptEntryId: null,
				endMessageId: "anchor-call",
				ordinal: END,
				tokensBefore: 0,
				summary: "covered",
				publishedAt: 1,
			};
			// The summary ends on the call message inside the turn prompted by b16;
			// its two results follow, and the reply "answer" continues that turn.
			// The request's history cut drops the call and its results and keeps
			// the turn's prompt b16, so the marker keeps b16 too: it hides nothing
			// the request keeps, and no longer has to be retired for want of a
			// real entry after the combined results.
			expect(applyDeferredPiCompactionMarker(deps, sessionId, pending)).toEqual(
				{ kind: "applied", firstKeptEntryId: "b16", compactionId: "marker" },
			);
			expect(appended).toEqual(["b16"]);
			appendCompartments(db, sessionId, [
				{
					sequence: 2,
					startMessage: END + 1,
					endMessage: END + 2,
					startMessageId: "synth-user-result-a",
					endMessageId: "answer",
					title: "Results",
					content: "Results and answer.",
					p1: "Results and answer.",
				},
			]);
			expect(
				applyDeferredPiCompactionMarker(deps, sessionId, {
					...pending,
					endMessageId: "answer",
					ordinal: END + 2,
				}),
			).toMatchObject({ kind: "applied", firstKeptEntryId: "b21" });
			expect(appended).toEqual(["b16", "b21"]);
		});
	});

	it("growing and healing branches keep independent offsets without identity-only logs", async () => {
		await withFixture(async (db, sessionId, entries) => {
			const logs: string[] = [];
			spyOn(logger, "sessionLog").mockImplementation((_id, ...parts) => {
				logs.push(parts.map(String).join(" "));
			});
			const first = resolvePiOrdinalAlignment(db, sessionId, entries);
			const firstEntry = entries[0];
			if (!firstEntry) throw new Error("expected reachable fixture entries");
			const grown = [
				...entries,
				{
					...firstEntry,
					id: "next",
					parentId: "b160",
					message: userMessage("next", START_TIME + 200000),
				},
			];
			expect(resolvePiOrdinalAlignment(db, sessionId, grown).offset).toBe(LOST);
			expect(resolvePiOrdinalAlignment(db, sessionId, [...grown]).offset).toBe(
				LOST,
			);
			expect(
				logs.filter((line) => line.startsWith("pi ordinal alignment:")),
			).toHaveLength(1);
			const prefix = Array.from(
				{ length: LOST },
				(_, index): Entry => ({
					type: "message",
					id: `old-${index + 1}`,
					parentId: index ? `old-${index}` : null,
					timestamp: new Date(START_TIME - LOST + index).toISOString(),
					message: userMessage("old", START_TIME - LOST + index),
				}),
			);
			const healed = [...prefix, ...entries];
			expect(resolvePiOrdinalAlignment(db, sessionId, healed)).toEqual({
				kind: "aligned",
				offset: 0,
			});
			expect(first.offset).toBe(LOST);
			const snapshots = await Promise.all(
				[entries, healed].map(async (branch) => {
					await Promise.resolve();
					return readPiSessionSnapshot(
						ctx(sessionId, branch) as never,
						piRawOrdinalOffsetSource(db, sessionId),
					);
				}),
			);
			expect(snapshots[0]?.rawMessages[LOST]?.id).toBe("b1");
			expect(snapshots[1]?.rawMessages[0]?.id).toBe("old-1");
			expect(snapshots[1]?.rawMessages[LOST]?.id).toBe("b1");
			expect(
				resolvePiOrdinalAlignment(db, sessionId, entries.slice(0, 12)),
			).toMatchObject({ kind: "unanchored", reason: "anchor-missing" });
		});
	});

	it("offset chunk ends do not split completed tool arcs; resumption preserves the stored start", async () => {
		await withFixture((db, sessionId, entries) => {
			const offset = resolvePiOrdinalAlignment(db, sessionId, entries).offset;
			const chunk = withRawMessageProvider(
				sessionId,
				provider(entries, offset),
				() => readSessionChunk(sessionId, 1, END, END + 3, { expand: true }),
			);
			expect(chunk.text).toContain("[65938-65939]");
			expect(chunk.text).toContain("read(a)");
			expect(chunk.text).toContain("read(b)");
			expect(chunk.endIndex).toBeGreaterThan(END);
			const resumed = withRawMessageProvider(
				sessionId,
				provider(entries, offset),
				() =>
					readSessionChunk(sessionId, 20000, END + 1, END + 3, {
						expand: true,
					}),
			);
			expect(resumed.startIndex).toBe(65_939);
			expect(resumed.text).toContain("[65939-65940]");
			expect(
				convertEntriesToRawMessagePage(entries, END, 1, END + 1, offset)[0],
			).toMatchObject({
				id: "synth-user-result-a",
				ordinal: END + 1,
				parts: [
					{ type: "tool", callID: "arc-a" },
					{ type: "tool", callID: "arc-b" },
				],
			});
			expect(resumed.text).not.toContain("[65938]");
		});
	});
});

// Keep the missing parent in the middle of the file without making each open
// parse tens of thousands of unrelated historical entries.
function persistedFixture(
	sessionId: string,
	offset: number,
): {
	path: string;
	complete: Entry[];
} {
	const temp = createTestTempDir("pi-ordinal-review-");
	cleanups.push(temp.cleanup);
	const dir = temp.dir;
	const path = join(dir, "session.jsonl");
	const prefix = Array.from(
		{ length: offset },
		(_, index): Entry => ({
			type: "message",
			id: index === offset - 1 ? "missing-parent" : `old-${index + 1}`,
			parentId: index ? `old-${index}` : null,
			timestamp: new Date(START_TIME - (offset - index) * 1000).toISOString(),
			message:
				index % 2
					? assistantMessage(
							"old history",
							START_TIME - (offset - index) * 1000,
						)
					: userMessage("old history", START_TIME - (offset - index) * 1000),
		}),
	);
	const complete = [...prefix, ...reachableEntries()];
	writeSession(path, sessionId, complete);
	return { path, complete };
}

function writeSession(
	path: string,
	sessionId: string,
	entries: readonly Entry[],
): void {
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: new Date(START_TIME).toISOString(),
		cwd: process.cwd(),
	};
	writeFileSync(
		path,
		`${[
			JSON.stringify(header),
			...entries.map((entry) => JSON.stringify(entry)),
		].join("\n")}\n`,
	);
}

describe("Pi ordinal offset persisted recovery", () => {
	it("a missing mid-file parent recovers automatically, grows, and leaves the defer head unchanged", async () => {
		const offset = reachableEntries().length;
		const recoveredStart = offset + 19;
		await withFixture(async (db, sessionId) => {
			const { path, complete } = persistedFixture(sessionId, offset);
			let manager = SessionManager.open(path);
			const fake = createFakePi();
			const chunks: Array<{ start: number; text: string }> = [];
			const runner = {
				harness: "pi",
				run: mock(async (options: { userMessage?: string }) => {
					const text = options.userMessage ?? "";
					const match = /Messages (\d+)-(\d+):/.exec(text);
					const start = Number(match?.[1]);
					const end = Number(match?.[2]);
					chunks.push({ start, text });
					return {
						ok: true as const,
						assistantText: `<compartment start="${start}" end="${end}" title="Recovered"><p1>Recovered results and subsequent work.</p1></compartment>`,
						durationMs: 1,
					};
				}),
			} as unknown as SubagentRunner;
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTags: 0,
				injection: { injectionBudgetTokens: 10_000 },
				historian: {
					runner,
					model: "test/historian",
					historianChunkTokens: 20_000,
					executeThresholdPercentage: 80,
					protectedTags: 0,
				},
			});
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const handler = fake.handlers.get("context") as (
				event: unknown,
				context: unknown,
			) => Promise<{ messages: unknown[] }>;
			const pass = async (tokens: number) => {
				const branch = manager.getBranch();
				// Model a host that keeps b101 as its first entry after compaction.
				// Appending a turn must not slide that start or change head timestamps.
				const visible = branch
					.slice(branch.findIndex((entry) => entry.id === "b101"))
					.filter((entry) => entry.type === "message")
					.map((entry) => (entry as Entry).message);
				return handler(
					{ messages: structuredClone(visible) },
					{
						...fakeContext(sessionId),
						sessionManager: manager,
						model: {
							provider: "anthropic",
							id: "claude-sonnet-4-5",
							contextWindow: 100_000,
						},
						getContextUsage: () => ({
							tokens,
							percent: tokens / 1000,
							contextWindow: 100_000,
						}),
					},
				);
			};
			expect(
				resolvePiOrdinalAlignment(db, sessionId, manager.getBranch()).offset,
			).toBe(0);
			const before = await pass(10_000);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
			});
			const head = JSON.stringify(before.messages.slice(0, 2));
			expect(head).toContain("<session-history>");
			expect(head).toContain("<session-history-since>");
			const disconnected = complete.filter(
				(entry) => entry.id !== "missing-parent",
			);
			writeSession(path, sessionId, disconnected);
			manager = SessionManager.open(path);
			expect(manager.getEntries()).toHaveLength(complete.length - 1);
			expect(manager.getBranch()).toHaveLength(reachableEntries().length);
			expect(manager.getBranch()[0]).toMatchObject({
				id: "b1",
				parentId: "missing-parent",
				message: { role: "assistant" },
			});
			expect(
				resolvePiOrdinalAlignment(db, sessionId, manager.getBranch()).offset,
			).toBe(offset);
			const broken = await pass(10_000);
			expect(JSON.stringify(broken.messages.slice(0, 2))).toBe(head);
			manager.appendMessage(
				userMessage("new work after break", START_TIME + 300000) as never,
			);
			expect(
				resolvePiOrdinalAlignment(db, sessionId, manager.getBranch()).offset,
			).toBe(offset);
			const grown = await pass(10_000);
			expect(JSON.stringify(grown.messages.slice(0, 2))).toBe(head);
			const trigger = await pass(85_000);
			expect(JSON.stringify(trigger.messages.slice(0, 2))).toBe(head);
			await awaitInFlightHistorians();
			expect(runner.run).toHaveBeenCalledTimes(1);
			expect(chunks[0]?.start).toBe(recoveredStart);
			expect(chunks[0]?.text).toContain(String(recoveredStart));
			expect(chunks[0]?.text).toContain("answer after both results");
			expect(getCompartments(db, sessionId)[2]).toMatchObject({
				startMessage: recoveredStart,
				startMessageId: "synth-user-result-a",
			});
			const deferAfterPublish = await pass(10_000);
			expect(JSON.stringify(deferAfterPublish.messages.slice(0, 2))).toBe(head);
			const appended = manager.getBranch().at(-1) as Entry;
			writeSession(path, sessionId, [...complete, appended]);
			manager = SessionManager.open(path);
			expect(manager.getBranch()).toHaveLength(complete.length + 1);
			expect(
				resolvePiOrdinalAlignment(db, sessionId, manager.getBranch()),
			).toEqual({ kind: "aligned", offset: 0 });
		}, offset);
	}, 60_000);
});
