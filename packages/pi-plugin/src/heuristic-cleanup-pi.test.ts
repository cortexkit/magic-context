import { describe, expect, it, spyOn } from "bun:test";
import { CTX_REDUCE_KEEP } from "@magic-context/core/features/magic-context/reclaim-protection";
import {
	getActiveTagsBySession,
	getTagsBySession,
	insertTag,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	applyFlushedStatuses,
	applyPendingOperations,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import type { TagTarget } from "@magic-context/core/hooks/magic-context/tag-messages";
import * as logger from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import {
	applyPiHeuristicCleanup,
	PI_CTX_REDUCE_KEEP,
	snapshotPiEmergencyServedMass,
} from "./heuristic-cleanup-pi";
import { authorizePiToolRemoval } from "./native-replay-state-pi";
import {
	assistantMessage,
	assistantToolCall,
	createTestDb,
	textOf,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

function tagMessages(
	sessionId: string,
	db: ReturnType<typeof createTestDb>,
	messages: unknown[],
) {
	const tagger = createTagger();
	tagger.initFromDb(sessionId, db);
	const transcript = createPiTranscript(messages, sessionId);
	const tagged = tagTranscript(sessionId, transcript, tagger, db);
	return { tagger, transcript, targets: tagged.targets };
}

function ctxReduceExchange(callId: string, timestamp: number): unknown[] {
	return [
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: callId,
					name: "ctx_reduce",
					arguments: {},
				},
			],
			timestamp,
		},
		{
			...toolResultMessage(callId, `reduced ${callId}`, timestamp + 1),
			toolName: "ctx_reduce",
		},
	];
}

describe("applyPiHeuristicCleanup", () => {
	it("keeps identical read-tool fingerprints distinct across assistant owners", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-heuristic-cross-owner";
			const messages = [
				userMessage("read once", 1),
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-call-a",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
					],
					timestamp: 2,
				},
				userMessage("read again", 3),
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-call-b",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
					],
					timestamp: 4,
				},
			];
			const { transcript, targets } = tagMessages(sessionId, db, messages);

			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				protectedTags: 0,
				staleReduceStripEnabled: true,
			});
			transcript.commit();

			expect(result.deduplicatedTools).toBe(0);
			expect(
				getTagsBySession(db, sessionId)
					.filter((tag) => tag.type === "tool")
					.map((tag) => [tag.messageId, tag.toolOwnerMessageId, tag.status]),
			).toEqual([
				["read-call-a", "pi-msg-1-2-assistant", "active"],
				["read-call-b", "pi-msg-3-4-assistant", "active"],
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps routine cleanup inert when only emergency selection may run", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-heuristic-routine-inert";
			const messages = [
				userMessage("read twice", 1),
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-call-a",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
						{
							type: "toolCall",
							id: "read-call-b",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
					],
					timestamp: 2,
				},
				toolResultMessage("read-call-a", "first result", 3),
				toolResultMessage("read-call-b", "second result", 4),
			];
			const { transcript, targets } = tagMessages(sessionId, db, messages);

			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				protectedTags: 0,
				staleReduceStripEnabled: true,
				routine: false,
			});
			transcript.commit();

			expect(result.deduplicatedTools).toBe(0);
			expect(
				getTagsBySession(db, sessionId)
					.filter((tag) => tag.type === "tool")
					.map((tag) => tag.status),
			).toEqual(["active", "active"]);
		} finally {
			closeQuietly(db);
		}
	});

	it("deduplicates same-owner parallel read calls with identical arguments", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-heuristic-same-owner";
			const messages = [
				userMessage("read twice", 1),
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-call-a",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
						{
							type: "toolCall",
							id: "read-call-b",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
					],
					timestamp: 2,
				},
				toolResultMessage("read-call-a", "first result", 3),
				toolResultMessage("read-call-b", "second result", 4),
			];
			const { transcript, targets } = tagMessages(sessionId, db, messages);

			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				protectedTags: 0,
				staleReduceStripEnabled: true,
			});
			transcript.commit();

			expect(result.deduplicatedTools).toBe(1);
			expect(
				getTagsBySession(db, sessionId)
					.filter((tag) => tag.type === "tool")
					.map((tag) => [tag.messageId, tag.toolOwnerMessageId, tag.status]),
			).toEqual([
				["read-call-a", "pi-msg-1-2-assistant", "dropped"],
				["read-call-b", "pi-msg-1-2-assistant", "active"],
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("deduplicates Pi's own bare read tool, not only the mcp_ form", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-heuristic-bare-read";
			const read = (id: string) => ({
				type: "toolCall",
				id,
				name: "read",
				arguments: { path: "src/a.ts" },
			});
			const messages = [
				userMessage("read twice", 1),
				{
					role: "assistant",
					content: [read("read-call-a"), read("read-call-b")],
					timestamp: 2,
				},
				toolResultMessage("read-call-a", "first result", 3),
				toolResultMessage("read-call-b", "second result", 4),
			];
			const { transcript, targets } = tagMessages(sessionId, db, messages);

			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				protectedTags: 0,
				staleReduceStripEnabled: true,
			});
			transcript.commit();

			expect(result.deduplicatedTools).toBe(1);
			expect(
				getTagsBySession(db, sessionId)
					.filter((tag) => tag.type === "tool")
					.map((tag) => [tag.messageId, tag.status]),
			).toEqual([
				["read-call-a", "dropped"],
				["read-call-b", "active"],
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps exactly one copy when the newest duplicate is protected", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-heuristic-protected-newest";
			const read = (id: string) => ({
				type: "toolCall",
				id,
				name: "read",
				arguments: { path: "src/a.ts" },
			});
			const messages = [
				userMessage("read three times", 1),
				{
					role: "assistant",
					content: [read("read-a"), read("read-b"), read("read-c")],
					timestamp: 2,
				},
				toolResultMessage("read-a", "first result", 3),
				toolResultMessage("read-b", "second result", 4),
				toolResultMessage("read-c", "third result", 5),
			];
			const { transcript, targets } = tagMessages(sessionId, db, messages);
			const toolTags = getTagsBySession(db, sessionId)
				.filter((tag) => tag.type === "tool")
				.map((tag) => tag.tagNumber)
				.sort((left, right) => left - right);

			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				protectedTags: 0,
				// Only the newest copy lies above the cutoff.
				protectedCutoff: toolTags[1],
				staleReduceStripEnabled: true,
			});
			transcript.commit();

			expect(result.deduplicatedTools).toBe(2);
			expect(
				getTagsBySession(db, sessionId)
					.filter((tag) => tag.type === "tool")
					.map((tag) => [tag.messageId, tag.status]),
			).toEqual([
				["read-a", "dropped"],
				["read-b", "dropped"],
				["read-c", "active"],
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not count an absent dedup target as a confirmed mutation", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-heuristic-dedup-absent";
			const messages = [
				userMessage("read twice", 1),
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-call-a",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
						{
							type: "toolCall",
							id: "read-call-b",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
					],
					timestamp: 2,
				},
			];
			const { targets } = tagMessages(sessionId, db, messages);
			const oldTag = getTagsBySession(db, sessionId).find(
				(tag) => tag.messageId === "read-call-a",
			);
			if (!oldTag) throw new Error("missing old tag");
			targets.delete(oldTag.tagNumber);

			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				protectedTags: 0,
				staleReduceStripEnabled: true,
			});

			expect(result.deduplicatedTools).toBe(0);
			expect(
				getTagsBySession(db, sessionId).find(
					(tag) => tag.tagNumber === oldTag.tagNumber,
				)?.status,
			).toBe("dropped");
		} finally {
			closeQuietly(db);
		}
	});

	it("protects the same newest three ctx_reduce arcs in Pi sentinel selection", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-ctx-reduce-exemplars";
			const messages: unknown[] = [];
			for (let n = 1; n <= 5; n++) {
				messages.push(
					userMessage(`request ${n}`, n * 3 - 2),
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: `reduce-${n}`,
								name: "ctx_reduce",
								arguments: {},
							},
						],
						timestamp: n * 3 - 1,
					},
					{
						...toolResultMessage(`reduce-${n}`, `reduced ${n}`, n * 3),
						toolName: "ctx_reduce",
					},
				);
			}
			const { transcript, targets } = tagMessages(sessionId, db, messages);

			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				protectedTags: 0,
				staleReduceStripEnabled: true,
			});
			transcript.commit();

			const reduceStatuses = getTagsBySession(db, sessionId)
				.filter((tag) => tag.type === "tool" && tag.toolName === "ctx_reduce")
				.sort((left, right) => left.tagNumber - right.tagNumber)
				.map((tag) => [tag.messageId, tag.status]);
			expect(result.droppedStaleReduceCalls).toBe(2);
			expect(reduceStatuses).toEqual([
				["reduce-1", "dropped"],
				["reduce-2", "dropped"],
				["reduce-3", "active"],
				["reduce-4", "active"],
				["reduce-5", "active"],
			]);
			expect(CTX_REDUCE_KEEP).toBe(3);
			expect(PI_CTX_REDUCE_KEEP).toBe(CTX_REDUCE_KEEP);
		} finally {
			closeQuietly(db);
		}
	});

	it("persists full drops for stale ctx_reduce calls and paired tool results", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-heuristic";
			const messages = [
				userMessage("older request", 1),
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will reduce now." },
						{
							type: "toolCall",
							id: "reduce-1",
							name: "ctx_reduce",
							arguments: {},
						},
					],
					timestamp: 2,
				},
				{
					...toolResultMessage("reduce-1", "reduced old tags", 3),
					toolName: "ctx_reduce",
				},
				userMessage("next request", 4),
				assistantMessage("newer answer", 5),
				userMessage("latest request", 6),
				...ctxReduceExchange("reduce-2", 7),
				...ctxReduceExchange("reduce-3", 9),
				...ctxReduceExchange("reduce-4", 11),
			];
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const transcript = createPiTranscript(messages, sessionId);
			const { targets } = tagTranscript(sessionId, transcript, tagger, db);

			// Stale-reduce cutoff is now the protected-tail window (maxTag -
			// protectedTags); protectedTags:2 reproduces the old age-2 cutoff.
			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				protectedTags: 2,
				staleReduceStripEnabled: true,
			});
			transcript.commit();

			expect(result.droppedStaleReduceCalls).toBe(1);
			expect(
				getTagsBySession(db, sessionId)
					.filter((tag) => tag.messageId === "reduce-1")
					.map((tag) => [tag.status, tag.dropMode]),
			).toEqual([["dropped", "full"]]);

			const replayMessages = [
				userMessage("older request", 1),
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will reduce now." },
						{
							type: "toolCall",
							id: "reduce-1",
							name: "ctx_reduce",
							arguments: {},
						},
					],
					timestamp: 2,
				},
				{
					...toolResultMessage("reduce-1", "reduced old tags", 3),
					toolName: "ctx_reduce",
				},
				userMessage("next request", 4),
				assistantMessage("newer answer", 5),
				userMessage("latest request", 6),
				...ctxReduceExchange("reduce-2", 7),
				...ctxReduceExchange("reduce-3", 9),
				...ctxReduceExchange("reduce-4", 11),
			];
			const replayTranscript = createPiTranscript(replayMessages, sessionId);
			const replay = tagTranscript(sessionId, replayTranscript, tagger, db);
			applyPendingOperations(sessionId, db, replay.targets, new Set());
			applyFlushedStatuses(sessionId, db, replay.targets);
			replayTranscript.commit();

			// Aggregate target uses tagId in sentinel (matches OpenCode parity in
			// apply-operations.ts:43 — `[dropped §<tagId>§]`). Tag allocation
			// order across the transcript: user "older request" (#1), assistant
			// text "I will reduce now." (#2), assistant toolCall reduce-1 (#3),
			// user toolResult reuses #3, user "next request" (#4), assistant
			// "newer answer" (#5), user "latest request" (#6). reduce-1 = #3.
			expect(textOf(replayTranscript.getOutputMessages()[2] as never)).toBe("");
		} finally {
			closeQuietly(db);
		}
	});

	it("drops a STALE ctx_reduce but preserves a FRESH one reusing the same callId", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-reduce-collision";
			// Two assistant turns both invoke ctx_reduce with the SAME callId
			// "reduce-1" (callId counters repeat across turns). The OLD one is stale
			// (tag age < cutoff); the FRESH one is recent (must survive). Composite
			// (owner, callId) identity must distinguish them — a bare-callId match
			// would wrongly drop both.
			const messages = [
				userMessage("old request", 1),
				{
					role: "assistant",
					content: [
						{ type: "text", text: "reducing (old)" },
						{
							type: "toolCall",
							id: "reduce-1",
							name: "ctx_reduce",
							arguments: {},
						},
					],
					timestamp: 2,
				},
				{
					...toolResultMessage("reduce-1", "reduced old", 3),
					toolName: "ctx_reduce",
				},
				// …several turns later…
				userMessage("a", 4),
				assistantMessage("b", 5),
				userMessage("c", 6),
				assistantMessage("d", 7),
				userMessage("fresh request", 8),
				{
					role: "assistant",
					content: [
						{ type: "text", text: "reducing (fresh)" },
						{
							type: "toolCall",
							id: "reduce-1",
							name: "ctx_reduce",
							arguments: {},
						},
					],
					timestamp: 9,
				},
				{
					...toolResultMessage("reduce-1", "reduced fresh", 10),
					toolName: "ctx_reduce",
				},
				userMessage("latest", 11),
				...ctxReduceExchange("reduce-2", 12),
				...ctxReduceExchange("reduce-3", 14),
			];
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const transcript = createPiTranscript(messages, sessionId);
			const { targets } = tagTranscript(sessionId, transcript, tagger, db);

			// The fresh reused call and two newer calls are the three exemplars;
			// the old owner-qualified arc with the same callId remains reclaimable.
			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				protectedTags: 3,
				staleReduceStripEnabled: true,
			});
			transcript.commit();

			// Exactly ONE stale ctx_reduce dropped (the old turn), NOT both.
			expect(result.droppedStaleReduceCalls).toBe(1);

			// The two ctx_reduce tool tags share callId "reduce-1" but have
			// DISTINCT owners; exactly one must be dropped, the fresher preserved.
			const reduceTags = getTagsBySession(db, sessionId)
				.filter((tag) => tag.type === "tool" && tag.messageId === "reduce-1")
				.map((tag) => tag.status);
			expect(reduceTags.filter((s) => s === "dropped")).toHaveLength(1);
			expect(reduceTags.filter((s) => s === "active")).toHaveLength(1);
		} finally {
			closeQuietly(db);
		}
	});
});

function makePiDropTarget(): TagTarget {
	const state = { present: true };
	return {
		setContent: () => false,
		drop: () => {
			if (!state.present) return "absent";
			state.present = false;
			return "removed";
		},
		canDrop: () => state.present,
	};
}

describe("applyPiHeuristicCleanup emergency floor accounting", () => {
	it("uses the post-pending-op active tag set for emergency planning", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-floor-recompute";
			const targets = new Map<number, TagTarget>();
			for (let tag = 1; tag <= 4; tag++) {
				insertTag(db, sessionId, `tool-${tag}`, "tool", 4000, tag, 0, "bash");
				targets.set(tag, makePiDropTarget());
			}
			queuePendingOp(db, sessionId, 1, "drop", 1);
			queuePendingOp(db, sessionId, 2, "drop", 2);

			applyPendingOperations(sessionId, db, targets, new Set());
			const activeAfterPending = getActiveTagsBySession(db, sessionId);
			applyPiHeuristicCleanup(
				sessionId,
				db,
				targets,
				[],
				{
					protectedTags: 0,
					staleReduceStripEnabled: true,
					emergency: { currentTotalInputTokens: 7000, ceilingTokens: 6000 },
				},
				activeAfterPending,
			);

			expect(
				getTagsBySession(db, sessionId).map((tag) => [
					tag.tagNumber,
					tag.status,
				]),
			).toEqual([
				[1, "dropped"],
				[2, "dropped"],
				[3, "active"],
				[4, "active"],
			]);
		} finally {
			closeQuietly(db);
		}
	});
});
it("Pi stale removal honors a custom ctx_reduce keep count above three", () => {
	const db = createTestDb();
	const sessionId = "pi-protected-stale-six";
	try {
		const messages: unknown[] = [];
		for (let n = 1; n <= 6; n++)
			messages.push(
				userMessage(`request ${n}`, n * 3 - 2),
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: `reduce-${n}`,
							name: "ctx_reduce",
							arguments: {},
						},
					],
					timestamp: n * 3 - 1,
				},
				{
					...toolResultMessage(`reduce-${n}`, `result ${n}`, n * 3),
					toolName: "ctx_reduce",
				},
			);
		const { transcript, targets } = tagMessages(sessionId, db, messages);
		const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
			protectedTags: 0,
			protectedCutoff: 100,
			staleReduceStripEnabled: true,
			protectedTools: { ctx_reduce: 6 },
		});
		transcript.commit();
		expect(result.droppedStaleReduceCalls).toBe(0);
		expect(
			getTagsBySession(db, sessionId).filter((tag) => tag.status === "dropped"),
		).toEqual([]);
		const disabled = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
			protectedTags: 0,
			protectedCutoff: 100,
			staleReduceStripEnabled: true,
			protectedTools: { ctx_reduce: 0 },
		});
		expect(disabled.droppedStaleReduceCalls).toBe(6);
		expect(
			getTagsBySession(db, sessionId)
				.filter((tag) => tag.type === "tool")
				.every((tag) => tag.status === "dropped"),
		).toBe(true);
	} finally {
		closeQuietly(db);
	}
});

describe("applyPiHeuristicCleanup emergency planner on the request this pass serves", () => {
	const OVERHEAD = 5_000;
	const calibration = { toolsRatio: 1, proseRatio: 1 };

	/** A task, then six completed bash calls with large outputs. */
	function session(sessionId: string, db: ReturnType<typeof createTestDb>) {
		const messages: unknown[] = [userMessage("run the checks", 1)];
		for (let i = 0; i < 6; i++) {
			messages.push(
				assistantToolCall(
					`call-${i}`,
					"bash",
					{ command: `check ${i}` },
					10 + i * 2,
				),
				{
					...toolResultMessage(
						`call-${i}`,
						`check ${i} output line\n`.repeat(400),
						11 + i * 2,
					),
					toolName: "bash",
				},
			);
		}
		return { messages, ...tagMessages(sessionId, db, messages) };
	}

	const toolTags = (db: ReturnType<typeof createTestDb>, sessionId: string) =>
		getActiveTagsBySession(db, sessionId)
			.filter((tag) => tag.type === "tool")
			.sort((a, b) => a.tagNumber - b.tagNumber);

	it("does not count what the same pass already dropped as fixed floor", () => {
		const db = createTestDb();
		const lines: string[] = [];
		const log = spyOn(logger, "sessionLog").mockImplementation((...args) => {
			lines.push(args.slice(1).map(String).join(" "));
		});
		try {
			const sessionId = "ses-pi-served-floor";
			const { messages, targets } = session(sessionId, db);
			const snapshot = snapshotPiEmergencyServedMass(
				getActiveTagsBySession(db, sessionId),
				targets,
			);
			let servedBefore = 0;
			for (const counts of snapshot.values())
				servedBefore += counts.tools + counts.prose;
			// The queued drops of four of the six outputs land first.
			const dropped = toolTags(db, sessionId).slice(0, 4);
			let droppedMass = 0;
			for (const [index, tag] of dropped.entries()) {
				queuePendingOp(db, sessionId, tag.tagNumber, "drop", index + 1);
				const counts = snapshot.get(tag.tagNumber)!;
				droppedMass += counts.tools + counts.prose;
			}
			applyPendingOperations(sessionId, db, targets, new Set());
			// The previous request's reading: fixed overhead plus every tag it
			// served. The ceiling sits between the real fixed part and that
			// part plus the outputs this pass just dropped.
			const reading = OVERHEAD + servedBefore;
			const ceiling = OVERHEAD + Math.round(droppedMass / 2);
			applyPiHeuristicCleanup(
				sessionId,
				db,
				targets,
				messages,
				{
					protectedTags: 0,
					staleReduceStripEnabled: false,
					routine: false,
					emergency: {
						currentTotalInputTokens: reading,
						ceilingTokens: ceiling,
						usagePercentage: 90,
						passAlreadyPriced: true,
						fitCalibration: calibration,
						servedBeforePass: snapshot,
					},
				},
				getActiveTagsBySession(db, sessionId),
			);
			const plan = lines.find((line) => line.includes("emergency tiered drop"));
			expect(plan).toBeDefined();
			expect(plan).not.toContain("already exceeds ceiling");
			expect(plan).toContain("removed this pass");
			// What stays fixed is the overhead plus the dropped calls' kept
			// arguments and placeholders, far below the ceiling.
			const floor = Number(/floor ?≈(\d+)/.exec(plan!)?.[1]);
			expect(floor).toBeGreaterThanOrEqual(OVERHEAD);
			expect(floor).toBeLessThan(ceiling);
		} finally {
			log.mockRestore();
			closeQuietly(db);
		}
	});

	it("taking the snapshot writes no native-removal decision, unlike measuring for reclaim", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-snapshot-read-only";
			const messages: unknown[] = [
				userMessage("run the checks", 1),
				assistantToolCall("call-a", "bash", { command: "check a" }, 2),
				{
					...toolResultMessage("call-a", "output ".repeat(300), 3),
					toolName: "bash",
				},
			];
			const saved = new Map<string, string>();
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const transcript = createPiTranscript(messages, sessionId, undefined, {
				authorizeToolRemoval: (callId) =>
					authorizePiToolRemoval({
						db,
						sessionId,
						callId,
						saved,
						canApply: true,
					}),
			});
			const { targets } = tagTranscript(sessionId, transcript, tagger, db);
			const dump = () =>
				JSON.stringify(
					(
						db
							.prepare(
								"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
							)
							.all() as Array<{ name: string }>
					).map(({ name }) => [
						name,
						db.prepare(`SELECT * FROM "${name}"`).all(),
					]),
				);
			const before = dump();
			const snapshot = snapshotPiEmergencyServedMass(
				getActiveTagsBySession(db, sessionId),
				targets,
			);
			expect(snapshot.size).toBeGreaterThan(0);
			expect(dump()).toBe(before);
			expect(saved.size).toBe(0);
			// Control: the reclaim measurement asks for removal and freezes it.
			const tool = getActiveTagsBySession(db, sessionId).find(
				(tag) => tag.type === "tool",
			)!;
			targets.get(tool.tagNumber)!.measureReclaim!(false);
			expect(dump()).not.toBe(before);
		} finally {
			closeQuietly(db);
		}
	});

	it("reclaim measurement already counts a call cut to a placeholder this pass at its placeholder size", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-skeleton-measure";
			const { targets } = session(sessionId, db);
			const target = targets.get(toolTags(db, sessionId)[0]!.tagNumber)!;
			const preview = target.measureReclaim!(true);
			expect(target.skeletonReal!()).toBe("truncated");
			const after = target.measureReclaim!(false);
			expect(after.beforeTools).toBe(preview.afterTools);
			expect(after.beforeTools).toBeLessThan(preview.beforeTools);
		} finally {
			closeQuietly(db);
		}
	});
});
