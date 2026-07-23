import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	__resetMessageIndexAsyncForTests,
	isSessionReconciled,
} from "@magic-context/core/features/magic-context/message-index-async";
import * as searchModule from "@magic-context/core/features/magic-context/search";
import {
	acquireWrapupInProgress,
	addNote,
	appendNoteNudgeAnchor,
	getHistorianFailureState,
	getLastNudgeLevel,
	getLastNudgeUndropped,
	getNoteNudgeAnchors,
	getOrCreateSessionMeta,
	getPendingOps,
	getPendingPiCompactionMarkerState,
	getTagsBySession,
	hasPiFallbackToolOwnerTags,
	incrementHistorianFailure,
	insertTag,
	queuePendingOp,
	setLastNudgeLevel,
	setLastNudgeUndropped,
	setPendingPiCompactionMarkerState,
	updateCavemanDepth,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	getEmergencyInputSample,
	getOverflowState,
	recordOverflowDetected,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { checkCompartmentTrigger } from "@magic-context/core/hooks/magic-context/compartment-trigger";
import { deriveTriggerBudget } from "@magic-context/core/hooks/magic-context/derive-budgets";
import { resolveExecuteThreshold } from "@magic-context/core/hooks/magic-context/event-resolvers";
import { onNoteTrigger } from "@magic-context/core/hooks/magic-context/note-nudger";
import { withRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { setBootQuietPeriodForTests } from "@magic-context/core/plugin/boot-quiet";
import { clearModelsDevCache } from "@magic-context/core/shared/models-dev-cache";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { clearAutoSearchForPiSession } from "./auto-search-pi";
import {
	awaitInFlightHistorians,
	clearContextHandlerSession,
	collectMessageEntryIdsByRef,
	collectMessageEntryIdsStrict,
	consumeDeferredHistoryRefresh,
	consumeDeferredMaterialization,
	consumePendingMaterialization,
	__test as contextHandlerInternals,
	hasPendingMaterialization,
	recordPiLiveModel,
	registerPiContextHandler,
	resolvePiHistorianTriggerInputs,
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
	trackSessionForProject,
} from "./context-handler";
import {
	getPiChannel1Baseline,
	setPiChannel1Baseline,
} from "./ctx-reduce-nudge-pi";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	textOf,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

describe("applyForwardPressureFloor", () => {
	const { FORWARD_PRESSURE_LIMIT_FACTOR, applyForwardPressureFloor } =
		contextHandlerInternals;

	it("floors stale trailing pressure with Pi's live forward token estimate", () => {
		const result = applyForwardPressureFloor(68, 273_200, 340_000, 400_000);

		expect(FORWARD_PRESSURE_LIMIT_FACTOR).toBe(0.85);
		expect(result.percentage).toBeCloseTo(100, 8);
		expect(result.inputTokens).toBe(340_000);
	});

	it("leaves trailing pressure unchanged without usable forward tokens or a sane limit", () => {
		const trailing = { percentage: 68, inputTokens: 273_200 };

		expect(
			applyForwardPressureFloor(
				trailing.percentage,
				trailing.inputTokens,
				undefined,
				400_000,
			),
		).toEqual(trailing);
		expect(
			applyForwardPressureFloor(
				trailing.percentage,
				trailing.inputTokens,
				null,
				400_000,
			),
		).toEqual(trailing);
		expect(
			applyForwardPressureFloor(
				trailing.percentage,
				trailing.inputTokens,
				340_000,
				6_748,
			),
		).toEqual(trailing);
	});

	it("never lowers pressure or input-token accounting", () => {
		expect(applyForwardPressureFloor(80, 80_000, 10_000, 100_000)).toEqual({
			percentage: 80,
			inputTokens: 80_000,
		});
	});

	it("maps forward tokens at limit × 0.85 to 100%", () => {
		const atMargin = applyForwardPressureFloor(0, 0, 85_000, 100_000);
		const belowMargin = applyForwardPressureFloor(0, 0, 84_999, 100_000);

		expect(atMargin.percentage).toBeCloseTo(100, 8);
		expect(atMargin.inputTokens).toBe(85_000);
		expect(belowMargin.percentage).toBeLessThan(100);
	});

	it("keeps the emergency recovery bump as a floor instead of a cap", () => {
		const src = readFileSync(
			join(import.meta.dir, "context-handler.ts"),
			"utf8",
		);

		expect(src).toContain("usagePercentage = Math.max(usagePercentage, 95)");
		expect(src).not.toContain("usagePercentage = 95;");
	});
	describe("explicit-only tool reclaim source invariants", () => {
		it("retains the smart-drops gate without positional synthetic reclaim", () => {
			const src = readFileSync(
				join(import.meta.dir, "context-handler.ts"),
				"utf8",
			);
			expect(src).toContain("let pendingOpsDidMutate = false");
			expect(src).toContain("let heuristicOrReasoningDidMutate = false");
			expect(src).toContain(
				"const alreadyMutatingThisPass =\n\t\tpendingOpsDidMutate || heuristicOrReasoningDidMutate",
			);
			expect(src).toContain("heuristicsResult.droppedStaleReduceCalls");
			expect(src).toContain("args.smartDrops &&");
			expect(src).not.toContain("buildSyntheticToolReclaimOps");
			expect(src).not.toContain("advanceToolReclaimWatermarkToCurrentMax");
			expect(src).not.toContain(
				"const alreadyMutatingThisPass = executedWorkThisPass",
			);
		});
	});
});

describe("stable tag identity reuse window", () => {
	it("contains only real ids from the latest successful pass", () => {
		const sessionId = "ses-reuse-window";
		try {
			contextHandlerInternals.recordSuccessfulTaggedMessageIds(sessionId, [
				"entry-a",
				"entry-b",
				undefined,
				"pi-msg-2-10-user",
			]);
			contextHandlerInternals.recordSuccessfulTaggedMessageIds(sessionId, [
				"entry-b",
				"entry-c",
			]);

			expect(
				Array.from(
					contextHandlerInternals.getTaggedStableMessageIdsForTests(sessionId),
				).sort(),
			).toEqual(["entry-b", "entry-c"]);
		} finally {
			clearContextHandlerSession(sessionId);
		}
	});
});

describe("Pi fallback tag adoption", () => {
	type RawTagRow = {
		tagNumber: number;
		messageId: string;
		status: string;
		byteSize: number | null;
		reasoningByteSize: number | null;
		inputByteSize: number | null;
		tokenCount: number | null;
		inputTokenCount: number | null;
		reasoningTokenCount: number | null;
		toolOwnerMessageId: string | null;
	};

	function readTagRow(
		db: ReturnType<typeof createTestDb>,
		sessionId: string,
		tagNumber: number,
	): RawTagRow | undefined {
		const row = db
			.prepare(
				`SELECT tag_number AS tagNumber,
				        message_id AS messageId,
				        status,
				        byte_size AS byteSize,
				        reasoning_byte_size AS reasoningByteSize,
				        input_byte_size AS inputByteSize,
				        token_count AS tokenCount,
				        input_token_count AS inputTokenCount,
				        reasoning_token_count AS reasoningTokenCount,
				        tool_owner_message_id AS toolOwnerMessageId
				 FROM tags
				 WHERE session_id = ? AND tag_number = ?`,
			)
			.get(sessionId, tagNumber) as RawTagRow | null | undefined;
		return row ?? undefined;
	}

	function sourceContent(
		db: ReturnType<typeof createTestDb>,
		sessionId: string,
		tagNumber: number,
	): string | undefined {
		const row = db
			.prepare(
				"SELECT content FROM source_contents WHERE session_id = ? AND tag_id = ?",
			)
			.get(sessionId, tagNumber) as { content: string } | null | undefined;
		return row?.content;
	}

	function saveSource(
		db: ReturnType<typeof createTestDb>,
		sessionId: string,
		tagNumber: number,
		content: string,
	): void {
		db.prepare(
			"INSERT INTO source_contents (session_id, tag_id, content, created_at, harness) VALUES (?, ?, ?, ?, 'pi')",
		).run(sessionId, tagNumber, content, Date.now());
	}

	it("unbinds the pi-msg fallback alias while preserving the adopted §N§ prefix", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-fallback-adoption";
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);

			const fallbackMessages = [userMessage("hello", 10)];
			const fallbackTranscript = createPiTranscript(
				fallbackMessages,
				sessionId,
				[undefined],
			);
			const fallbackId = fallbackTranscript.messages[0]?.info.id;
			expect(fallbackId).toBe("pi-msg-0-10-user");
			if (!fallbackId) throw new Error("missing fallback id");
			const fallbackFingerprints =
				contextHandlerInternals.buildEntryFingerprintMap(
					fallbackMessages,
					() => fallbackId,
				);

			tagTranscript(sessionId, fallbackTranscript, tagger, db, {
				entryFingerprintByMessageId: fallbackFingerprints,
			});
			fallbackTranscript.commit();
			expect(textOf(fallbackMessages[0])).toBe("§1§ hello");
			expect(tagger.getTag(sessionId, `${fallbackId}:p0`, "message")).toBe(1);

			// Next pass starts with a data_version-only cache hit after the tagger's
			// own write, then Pi migrates the fallback row to the real entry id.
			tagger.initFromDb(sessionId, db);
			const realId = "entry-real-user";
			const realMessages = [userMessage("hello", 10)];
			const realFingerprints = contextHandlerInternals.buildEntryFingerprintMap(
				realMessages,
				() => realId,
			);
			contextHandlerInternals.adoptPiFallbackTags(
				db,
				sessionId,
				tagger,
				realFingerprints,
			);
			expect(
				tagger.getTag(sessionId, `${fallbackId}:p0`, "message"),
			).toBeUndefined();
			expect(tagger.getTag(sessionId, `${realId}:p0`, "message")).toBe(1);

			const realTranscript = createPiTranscript(realMessages, sessionId, [
				realId,
			]);
			tagTranscript(sessionId, realTranscript, tagger, db, {
				entryFingerprintByMessageId: realFingerprints,
			});
			realTranscript.commit();
			expect(textOf(realMessages[0])).toBe("§1§ hello");

			// A later data_version-only cache hit must not resurrect the old alias.
			tagger.initFromDb(sessionId, db);
			expect(
				tagger.assignTag(sessionId, `${fallbackId}:p0`, "message", 5, db),
			).toBe(2);
		} finally {
			closeQuietly(db);
		}
	});

	it("re-probes a stale negative after fingerprint construction before skipping adoption", () => {
		const dir = mkdtempSync(join(tmpdir(), "mc-pi-fallback-race-"));
		const dbPath = join(dir, "context.db");
		const db = createTestDb(dbPath);
		const siblingDb = createTestDb(dbPath);
		try {
			db.exec("PRAGMA journal_mode = WAL");
			siblingDb.exec("PRAGMA journal_mode = WAL");
			const sessionId = "ses-pi-fallback-negative-race";
			const realId = "entry-real-raced";
			const fallbackId = "pi-msg-0-10-user";
			const messages = [userMessage("raced message", 10)];
			const fingerprints = contextHandlerInternals.buildEntryFingerprintMap(
				messages,
				() => realId,
			);
			const fingerprint = fingerprints.get(realId);
			if (!fingerprint) throw new Error("missing test fingerprint");
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);

			// This commit lands after the caller's negative preflight and fingerprint
			// construction, matching a sibling Pi process on the same session.
			insertTag(
				siblingDb,
				sessionId,
				`${fallbackId}:p0`,
				"message",
				13,
				7,
				0,
				null,
				0,
				null,
				fingerprint,
				{ tokenCount: 3, inputTokenCount: 0, reasoningTokenCount: 0 },
			);

			contextHandlerInternals.adoptPiFallbackTags(
				db,
				sessionId,
				tagger,
				fingerprints,
				{ hasFallbackMessageTags: false },
			);
			expect(readTagRow(db, sessionId, 7)?.messageId).toBe(`${realId}:p0`);
			expect(tagger.getTag(sessionId, `${realId}:p0`, "message")).toBe(7);

			const transcript = createPiTranscript(messages, sessionId, [realId]);
			tagTranscript(sessionId, transcript, tagger, db, {
				entryFingerprintByMessageId: fingerprints,
			});
			transcript.commit();
			expect(getTagsBySession(db, sessionId)).toHaveLength(1);
			expect(textOf(messages[0])).toBe("§7§ raced message");
		} finally {
			closeQuietly(siblingDb);
			closeQuietly(db);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("migrates dropped sentinelized tool-only owners without allocating a fresh tag", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-tool-owner-dropped";
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);

			const fallbackMessages = [
				assistantToolCall("call-dropped", "Read", { path: "/tmp/full" }, 10),
				toolResultMessage("call-dropped", "FULL TOOL OUTPUT", 11),
			];
			const fallbackTranscript = createPiTranscript(
				fallbackMessages,
				sessionId,
				[undefined, undefined],
			);
			tagTranscript(sessionId, fallbackTranscript, tagger, db);
			fallbackTranscript.commit();
			const original = getTagsBySession(db, sessionId).find(
				(tag) => tag.type === "tool",
			);
			expect(original?.tagNumber).toBe(1);
			expect(original?.toolOwnerMessageId).toBe("pi-msg-0-10-assistant");
			db.prepare(
				"UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = ?",
			).run(sessionId, 1);

			const realOwner = "entry-tool-owner";
			const realMessages = [
				assistantToolCall(
					"call-dropped",
					"Read",
					{ __magic_context_dropped__: true },
					10,
				),
				toolResultMessage("call-dropped", "[dropped §1§]", 11),
			];
			contextHandlerInternals.adoptPiFallbackTags(
				db,
				sessionId,
				tagger,
				new Map(),
				{
					messages: realMessages,
					resolveStableId: (_msg: unknown, index: number) =>
						index === 0 ? realOwner : "entry-tool-result",
					hasFallbackToolOwnerTags: false,
				},
			);

			expect(
				tagger.getToolTag(sessionId, "call-dropped", "pi-msg-0-10-assistant"),
			).toBeUndefined();
			expect(tagger.getToolTag(sessionId, "call-dropped", realOwner)).toBe(1);
			expect(readTagRow(db, sessionId, 1)).toMatchObject({
				status: "dropped",
				toolOwnerMessageId: realOwner,
			});

			const realTranscript = createPiTranscript(realMessages, sessionId, [
				realOwner,
				"entry-tool-result",
			]);
			tagTranscript(sessionId, realTranscript, tagger, db);
			expect(
				getTagsBySession(db, sessionId).filter((tag) => tag.type === "tool"),
			).toHaveLength(1);
			expect(readTagRow(db, sessionId, 1)?.status).toBe("dropped");
		} finally {
			closeQuietly(db);
		}
	});

	it("folds tool-owner collisions into the real-id survivor with max accounting and alias rebinding", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-tool-owner-fold-max";
			const tagger = createTagger();
			const callId = "call-max";
			const piOwner = "pi-msg-0-10-assistant";
			const realOwner = "entry-tool-owner";
			insertTag(
				db,
				sessionId,
				callId,
				"tool",
				12,
				10,
				1,
				"Read",
				3,
				piOwner,
				null,
				{
					tokenCount: 2,
					inputTokenCount: 1,
					reasoningTokenCount: 0,
				},
			);
			db.prepare(
				"UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = 10",
			).run(sessionId);
			insertTag(
				db,
				sessionId,
				callId,
				"tool",
				1000,
				20,
				7,
				"Read",
				200,
				realOwner,
				null,
				{
					tokenCount: 300,
					inputTokenCount: 40,
					reasoningTokenCount: 5,
				},
			);
			saveSource(db, sessionId, 20, "duplicate source");
			tagger.bindToolTag(sessionId, callId, piOwner, 10);
			tagger.bindToolTag(sessionId, callId, realOwner, 20);

			contextHandlerInternals.adoptPiFallbackTags(
				db,
				sessionId,
				tagger,
				new Map(),
				{
					messages: [
						assistantToolCall(
							callId,
							"Read",
							{ __magic_context_dropped__: true },
							10,
						),
					],
					resolveStableId: () => realOwner,
				},
			);

			expect(readTagRow(db, sessionId, 10)).toBeUndefined();
			expect(sourceContent(db, sessionId, 20)).toBe("duplicate source");
			expect(readTagRow(db, sessionId, 20)).toMatchObject({
				status: "dropped",
				byteSize: 1000,
				reasoningByteSize: 7,
				inputByteSize: 200,
				tokenCount: 300,
				inputTokenCount: 40,
				reasoningTokenCount: 5,
				toolOwnerMessageId: realOwner,
			});
			expect(tagger.getToolTag(sessionId, callId, piOwner)).toBeUndefined();
			expect(tagger.getToolTag(sessionId, callId, realOwner)).toBe(20);
			expect(tagger.getToolTagAccounting(sessionId, callId, realOwner)).toEqual(
				{
					byteSize: 1000,
					tokenCount: 300,
					inputByteSize: 200,
					inputTokenCount: 40,
				},
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("retargets pending ops on collision without treating queued drops as applied", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-tool-owner-pending-fold";
			const tagger = createTagger();
			const callId = "call-pending";
			const piOwner = "pi-msg-0-20-assistant";
			const realOwner = "entry-tool-pending";
			insertTag(db, sessionId, callId, "tool", 10, 30, 0, "Read", 0, piOwner);
			insertTag(db, sessionId, callId, "tool", 20, 31, 0, "Read", 0, realOwner);
			queuePendingOp(db, sessionId, 30, "drop", 100);
			queuePendingOp(db, sessionId, 31, "drop", 101);
			tagger.bindToolTag(sessionId, callId, piOwner, 30);
			tagger.bindToolTag(sessionId, callId, realOwner, 31);

			contextHandlerInternals.adoptPiFallbackTags(
				db,
				sessionId,
				tagger,
				new Map(),
				{
					messages: [assistantToolCall(callId, "Read", {}, 20)],
					resolveStableId: () => realOwner,
				},
			);

			expect(readTagRow(db, sessionId, 30)).toBeUndefined();
			expect(readTagRow(db, sessionId, 31)).toMatchObject({
				status: "active",
				toolOwnerMessageId: realOwner,
			});
			expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toEqual([31]);
		} finally {
			closeQuietly(db);
		}
	});

	it("skips same-timestamp reused-callID ambiguity instead of wrong-migrating", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-tool-owner-ambiguous";
			const tagger = createTagger();
			const callId = "call-reused";
			const piOwner = "pi-msg-0-30-assistant";
			insertTag(db, sessionId, callId, "tool", 10, 40, 0, "Read", 0, piOwner);
			tagger.bindToolTag(sessionId, callId, piOwner, 40);

			contextHandlerInternals.adoptPiFallbackTags(
				db,
				sessionId,
				tagger,
				new Map(),
				{
					messages: [
						assistantToolCall(callId, "Read", {}, 30),
						assistantToolCall(callId, "Read", {}, 30),
					],
					resolveStableId: (_msg: unknown, index: number) =>
						index === 0 ? "entry-a" : "entry-b",
				},
			);

			expect(readTagRow(db, sessionId, 40)?.toolOwnerMessageId).toBe(piOwner);
			expect(tagger.getToolTag(sessionId, callId, "entry-a")).toBeUndefined();
			expect(tagger.getToolTag(sessionId, callId, "entry-b")).toBeUndefined();
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps side tables attached to the survivor on simple tool-owner rekey", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-tool-owner-simple-side-tables";
			const tagger = createTagger();
			const callId = "call-side";
			const piOwner = "pi-msg-0-40-assistant";
			const realOwner = "entry-tool-side";
			insertTag(db, sessionId, callId, "tool", 10, 50, 0, "Read", 0, piOwner);
			saveSource(db, sessionId, 50, "original source");
			queuePendingOp(db, sessionId, 50, "drop", 123);
			tagger.bindToolTag(sessionId, callId, piOwner, 50);

			contextHandlerInternals.adoptPiFallbackTags(
				db,
				sessionId,
				tagger,
				new Map(),
				{
					messages: [assistantToolCall(callId, "Read", {}, 40)],
					resolveStableId: () => realOwner,
				},
			);

			expect(readTagRow(db, sessionId, 50)?.toolOwnerMessageId).toBe(realOwner);
			expect(sourceContent(db, sessionId, 50)).toBe("original source");
			expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toEqual([50]);
			expect(tagger.getToolTag(sessionId, callId, realOwner)).toBe(50);
		} finally {
			closeQuietly(db);
		}
	});

	it("remains runnable after the scheme stamp so late-resolving tool owners rekey later", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-tool-owner-late";
			const tagger = createTagger();
			const callId = "call-late";
			const piOwner = "pi-msg-0-55-assistant";
			const realOwner = "entry-tool-late";
			insertTag(db, sessionId, callId, "tool", 10, 60, 0, "Read", 0, piOwner);
			tagger.bindToolTag(sessionId, callId, piOwner, 60);

			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			expect(getOrCreateSessionMeta(db, sessionId).piStableIdScheme).toBe(1);
			expect(readTagRow(db, sessionId, 60)?.toolOwnerMessageId).toBe(piOwner);

			contextHandlerInternals.adoptPiFallbackTags(
				db,
				sessionId,
				tagger,
				new Map(),
				{
					messages: [assistantToolCall(callId, "Read", {}, 55)],
					resolveStableId: () => realOwner,
				},
			);
			expect(readTagRow(db, sessionId, 60)?.toolOwnerMessageId).toBe(realOwner);

			contextHandlerInternals.adoptPiFallbackTags(
				db,
				sessionId,
				tagger,
				new Map(),
				{
					messages: [assistantToolCall(callId, "Read", {}, 55)],
					resolveStableId: () => realOwner,
				},
			);
			expect(
				getTagsBySession(db, sessionId).filter((tag) => tag.type === "tool"),
			).toHaveLength(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps a racing real-id §N§ stable when later adoption folds the fallback row", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-message-fold";
			const tagger = createTagger();
			const fallbackId = "pi-msg-0-70-user";
			const realId = "entry-user-real";
			const message = userMessage("hello", 70);
			const fingerprint = contextHandlerInternals
				.buildEntryFingerprintMap([message], () => fallbackId)
				.get(fallbackId);
			if (!fingerprint) throw new Error("missing fingerprint");
			insertTag(
				db,
				sessionId,
				`${fallbackId}:p0`,
				"message",
				10,
				70,
				0,
				null,
				0,
				null,
				fingerprint,
				{ tokenCount: 1, inputTokenCount: null, reasoningTokenCount: null },
			);
			insertTag(
				db,
				sessionId,
				`${realId}:p0`,
				"message",
				100,
				71,
				0,
				null,
				0,
				null,
				null,
				{ tokenCount: 9, inputTokenCount: null, reasoningTokenCount: null },
			);
			db.prepare(
				"UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = 71",
			).run(sessionId);
			saveSource(db, sessionId, 71, "duplicate message source");
			queuePendingOp(db, sessionId, 71, "drop", 200);
			tagger.bindTag(sessionId, `${fallbackId}:p0`, 70);
			tagger.bindTag(sessionId, `${realId}:p0`, 71);

			contextHandlerInternals.adoptPiFallbackTags(
				db,
				sessionId,
				tagger,
				new Map([[realId, fingerprint]]),
			);

			expect(readTagRow(db, sessionId, 70)).toBeUndefined();
			expect(sourceContent(db, sessionId, 71)).toBe("duplicate message source");
			expect(readTagRow(db, sessionId, 71)).toMatchObject({
				messageId: `${realId}:p0`,
				status: "dropped",
				byteSize: 100,
				tokenCount: 9,
			});
			expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toEqual([71]);
			expect(
				tagger.getTag(sessionId, `${fallbackId}:p0`, "message"),
			).toBeUndefined();
			expect(tagger.getTag(sessionId, `${realId}:p0`, "message")).toBe(71);

			const nextPass = [userMessage("hello", 70)];
			const transcript = createPiTranscript(nextPass, sessionId, [realId]);
			tagTranscript(sessionId, transcript, tagger, db, {
				entryFingerprintByMessageId: new Map([[realId, fingerprint]]),
			});
			transcript.commit();
			expect(textOf(nextPass[0])).toBe("§71§ hello");
		} finally {
			closeQuietly(db);
		}
	});

	it("leaves sessions with no pi-msg tool owners unchanged", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-tool-owner-noop";
			const tagger = createTagger();
			insertTag(
				db,
				sessionId,
				"call-real",
				"tool",
				10,
				80,
				0,
				"Read",
				0,
				"entry-real",
			);
			const before = JSON.stringify(getTagsBySession(db, sessionId));

			contextHandlerInternals.adoptPiFallbackTags(
				db,
				sessionId,
				tagger,
				new Map(),
				{
					messages: [assistantToolCall("call-real", "Read", {}, 80)],
					resolveStableId: () => "entry-real",
				},
			);

			expect(JSON.stringify(getTagsBySession(db, sessionId))).toBe(before);
		} finally {
			closeQuietly(db);
		}
	});

	it("retargets a duplicate-only pending op onto a survivor that lacks it", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-tool-owner-pending-only-dup";
			const tagger = createTagger();
			const callId = "call-pending-only";
			const piOwner = "pi-msg-0-90-assistant";
			const realOwner = "entry-tool-pending-only";
			// The fallback has no pending op; the real-id row already has one.
			insertTag(db, sessionId, callId, "tool", 10, 90, 0, "Read", 0, piOwner);
			insertTag(db, sessionId, callId, "tool", 20, 91, 0, "Read", 0, realOwner);
			queuePendingOp(db, sessionId, 91, "drop", 110);
			tagger.bindToolTag(sessionId, callId, piOwner, 90);
			tagger.bindToolTag(sessionId, callId, realOwner, 91);

			contextHandlerInternals.adoptPiFallbackTags(
				db,
				sessionId,
				tagger,
				new Map(),
				{
					messages: [assistantToolCall(callId, "Read", {}, 90)],
					resolveStableId: () => realOwner,
				},
			);

			// The real-id survivor and its pending op keep the tag identity already
			// emitted by the racing pass.
			expect(readTagRow(db, sessionId, 90)).toBeUndefined();
			expect(readTagRow(db, sessionId, 91)?.status).toBe("active");
			expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toEqual([91]);
		} finally {
			closeQuietly(db);
		}
	});

	it("skips a no-timestamp fallback owner instead of rekeying it", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-tool-owner-no-ts";
			const tagger = createTagger();
			const callId = "call-no-ts";
			// No-timestamp synthetic owner form: pi-msg-${index}-${role} (no ts segment).
			const piOwner = "pi-msg-0-assistant";
			insertTag(db, sessionId, callId, "tool", 10, 95, 0, "Read", 0, piOwner);
			tagger.bindToolTag(sessionId, callId, piOwner, 95);

			contextHandlerInternals.adoptPiFallbackTags(
				db,
				sessionId,
				tagger,
				new Map(),
				{
					messages: [assistantToolCall(callId, "Read", {}, 90)],
					resolveStableId: () => "entry-no-ts",
				},
			);

			// Unmatchable by (ts,callID) → left as-is, never wrong-rekeyed.
			expect(readTagRow(db, sessionId, 95)?.toolOwnerMessageId).toBe(piOwner);
			expect(
				tagger.getToolTag(sessionId, callId, "entry-no-ts"),
			).toBeUndefined();
		} finally {
			closeQuietly(db);
		}
	});

	it("cheap-gate: does not build the owner map when no pi-msg tool owners exist", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-tool-owner-cheap-gate";
			const tagger = createTagger();
			// Only a real-owner tool tag exists — no pi-msg-* owners to migrate.
			insertTag(
				db,
				sessionId,
				"call-real",
				"tool",
				10,
				96,
				0,
				"Read",
				0,
				"entry-real",
			);
			// Split a gate hole from a wrong test premise: the tool-owner gate MUST
			// be false here (no pi-msg-* owners), so the branch-walk never runs.
			expect(hasPiFallbackToolOwnerTags(db, sessionId)).toBe(false);

			let resolverCalls = 0;
			contextHandlerInternals.adoptPiFallbackTags(
				db,
				sessionId,
				tagger,
				new Map(),
				{
					messages: [assistantToolCall("call-real", "Read", {}, 90)],
					resolveStableId: () => {
						resolverCalls += 1;
						return "entry-real";
					},
				},
			);

			// The cheap hasPiFallbackToolOwnerTags gate short-circuits before any
			// branch walk, so the resolver is never consulted.
			expect(resolverCalls).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});
});

describe("registerPiContextHandler", () => {
	afterEach(() => {
		__resetMessageIndexAsyncForTests();
		clearModelsDevCache();
		clearContextHandlerSession("ses-context");
		clearContextHandlerSession("ses-sticky-context");
		clearAutoSearchForPiSession("ses-context");
		clearAutoSearchForPiSession("ses-sticky-context");
	});

	it("evicts the least-recently-tracked session's per-session caches past the cap", () => {
		// Register a victim session with observable per-session state, then track
		// >100 newer sessions so the victim is evicted via clearContextHandlerSession.
		const victim = "ses-evict-victim";
		setPiChannel1Baseline(victim, {
			tailToolTokens: 1,
			historyBudgetTokens: 0,
			contextLimit: 0,
			executeThresholdPercentage: 65,
			lastInputTokens: 0,
			turnToolTokens: 0,
			usableTokens: 0,
			reducedSinceRefresh: false,
			oldestReclaimableToolTags: [],
		});
		trackSessionForProject("proj-evict", victim);
		expect(getPiChannel1Baseline(victim)).toBeDefined();

		// 100 newer sessions push the victim past the cap (it was tracked first).
		for (let i = 0; i < 100; i++) {
			trackSessionForProject("proj-evict", `ses-evict-${i}`);
		}

		// Victim's per-session Channel 1 baseline was cleared by eviction
		// (clearContextHandlerSession → clearPiChannel1State).
		expect(getPiChannel1Baseline(victim)).toBeUndefined();

		// Cleanup the survivors.
		clearContextHandlerSession(victim);
		for (let i = 0; i < 100; i++) clearContextHandlerSession(`ses-evict-${i}`);
	});

	it("schedules first-touch message index reconciliation", async () => {
		// Another test file in the same process may have activated the Pi entry,
		// which arms the module-global boot-quiet gate and defers background
		// lanes by two minutes. Reconciliation timing is what this test asserts,
		// so neutralize the gate explicitly.
		setBootQuietPeriodForTests(null);
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = [userMessage("hello", 1)] as never[];

			await handler({ messages }, fakeContext("ses-context") as never);
			// The reconciliation runs asynchronously behind event-loop yields, so a
			// fixed number of microtask hops is not enough under full-suite load.
			// Poll with a wall-clock deadline instead of assuming a hop count.
			const deadline = Date.now() + 5_000;
			while (!isSessionReconciled("ses-context") && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(isSessionReconciled("ses-context")).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("resolves per-project options via resolveForProject using the pass cwd", async () => {
		// Council #4 (project-config bleed on /cd): a Pi process can switch
		// projects mid-session; the context handler must resolve options from the
		// CURRENT pass cwd, not the launch-cwd base options. We assert the
		// resolver is consulted with ctx.cwd and that its returned options win.
		const db = createTestDb();
		try {
			const fake = createFakePi();
			const seenDirs: string[] = [];
			const switchedDir = "/tmp/switched-project-abc";
			registerPiContextHandler(fake.pi as never, {
				db,
				resolveForProject: (dir: string) => {
					seenDirs.push(dir);
					return { db, smartDrops: true };
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] } | undefined>;
			const messages = [userMessage("hello", 1)] as never[];

			await handler(
				{ messages },
				fakeContext("ses-switch", switchedDir) as never,
			);

			// The resolver was consulted with the pass's cwd.
			expect(seenDirs).toContain(switchedDir);
		} finally {
			closeQuietly(db);
		}
	});

	it("resets the persisted Channel 1 band when baseline refresh sees a smaller tail", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-band-reset";
			setLastNudgeUndropped(db, sessionId, 80_000);
			setLastNudgeLevel(db, sessionId, "urgent");

			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] } | undefined>;

			await handler(
				{ messages: [userMessage("hello", 1)] as never[] },
				fakeContext(sessionId) as never,
			);

			expect(getLastNudgeUndropped(db, sessionId)).toBe(0);
			expect(getLastNudgeLevel(db, sessionId)).toBe("");
		} finally {
			closeQuietly(db);
		}
	});

	it("clears stale compartmentInProgress on first context pass after restart", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-zombie-historian";
			clearContextHandlerSession(sessionId);
			updateSessionMeta(db, sessionId, { compartmentInProgress: true });
			expect(getOrCreateSessionMeta(db, sessionId).compartmentInProgress).toBe(
				true,
			);

			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				historian: {
					runner: {} as SubagentRunner,
					model: "test/historian",
					historianChunkTokens: 8000,
					executeThresholdPercentage: 65,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = [userMessage("hello", 1)] as never[];
			const ctx = {
				...fakeContext(sessionId),
				getContextUsage: () => ({
					tokens: 1000,
					percent: 1,
					contextWindow: 100_000,
				}),
			};

			await handler({ messages }, ctx as never);

			expect(getOrCreateSessionMeta(db, sessionId).compartmentInProgress).toBe(
				false,
			);
		} finally {
			clearContextHandlerSession("ses-pi-zombie-historian");
			closeQuietly(db);
		}
	});

	it("resets stale persisted pressure on first context pass after restart", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-stale-pressure-restart";
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTags: 0,
				scheduler: { executeThresholdPercentage: 65 },
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = [
				userMessage("keep", 1),
				assistantMessage("do not drop on live low pressure", 2),
			] as never[];

			await handler({ messages }, fakeContext(sessionId) as never);
			queuePendingOp(db, sessionId, 2, "drop");
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 92,
				lastInputTokens: 92_000,
			});
			clearContextHandlerSession(sessionId);

			const ctx = {
				...fakeContext(sessionId),
				getContextUsage: () => ({
					tokens: 1_000,
					percent: 1,
					contextWindow: 100_000,
				}),
			};
			const result = await handler({ messages }, ctx as never);

			expect(textOf(result.messages[1] as never)).toContain(
				"do not drop on live low pressure",
			);
			const meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.lastContextPercentage).toBe(0);
			expect(meta.lastInputTokens).toBe(0);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("resets stale persisted pressure when Pi switches models", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-stale-pressure-model-switch";
		try {
			const fake = createFakePi();
			recordPiLiveModel(sessionId, "anthropic/old-model");
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTags: 0,
				scheduler: { executeThresholdPercentage: 65 },
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = [
				userMessage("keep", 1),
				assistantMessage("do not drop after model switch", 2),
			] as never[];

			await handler({ messages }, fakeContext(sessionId) as never);
			queuePendingOp(db, sessionId, 2, "drop");
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 88,
				lastInputTokens: 88_000,
				observedSafeInputTokens: 88_000,
				cacheAlertSent: true,
			});
			recordPiLiveModel(sessionId, "anthropic/old-model");

			const ctx = {
				...fakeContext(sessionId),
				model: { provider: "anthropic", id: "new-model" },
				getContextUsage: () => ({
					tokens: 2_000,
					percent: 2,
					contextWindow: 200_000,
				}),
			};
			const result = await handler({ messages }, ctx as never);

			expect(textOf(result.messages[1] as never)).toContain(
				"do not drop after model switch",
			);
			const meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.lastContextPercentage).toBe(0);
			expect(meta.lastInputTokens).toBe(0);
			expect(meta.observedSafeInputTokens).toBe(0);
			expect(meta.cacheAlertSent).toBe(false);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("tags user, assistant, and toolResult messages through the Pi adapter", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;

			const result = await handler(
				{
					messages: [
						userMessage("hello", 1),
						assistantMessage("answer", 2),
						toolResultMessage("call-1", "tool output", 3),
						userMessage("next", 4),
					] as never[],
				},
				fakeContext("ses-context") as never,
			);

			expect(textOf(result.messages[0] as never)).toMatch(/^§1§ hello/);
			expect(textOf(result.messages[1] as never)).toMatch(/^§2§ answer/);
			expect(textOf(result.messages[2] as never)).toMatch(/^§3§ tool output/);
			expect(
				getTagsBySession(db, "ses-context").map((tag) => tag.type),
			).toEqual(["message", "message", "tool", "message"]);
		} finally {
			closeQuietly(db);
		}
	});

	it("applies and drains pending drops for the session", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				// Disable protection so the immediate drop on tag #2 actually
				// materializes; otherwise the schema default (20) defers the
				// drop because tag #2 is in the protected window.
				protectedTags: 0,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;

			// Force scheduler to "execute" by pushing usage above the
			// default 65% threshold. Pi pending-ops materialization is
			// gated on schedulerDecision === "execute" || forceMaterialization
			// (mirrors OpenCode); without an over-threshold context, the
			// scheduler returns "defer" and drops correctly stay queued.
			const overThresholdCtx = {
				...fakeContext("ses-context"),
				getContextUsage: () => ({
					tokens: 70_000,
					percent: 70,
					contextWindow: 100_000,
				}),
			};
			await handler(
				{
					messages: [
						userMessage("keep user", 1),
						assistantMessage("drop assistant", 2),
					] as never[],
				},
				overThresholdCtx as never,
			);
			queuePendingOp(db, "ses-context", 2, "drop");
			const result = await handler(
				{
					messages: [
						userMessage("keep user", 1),
						assistantMessage("drop assistant", 2),
					] as never[],
				},
				overThresholdCtx as never,
			);

			expect(textOf(result.messages[1] as never)).toBe("[dropped §2§]");
			expect(getPendingOps(db, "ses-context")).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not use a legacy watermark to drop an unrequested tool", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-explicit-only";
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTags: 0,
				scheduler: { executeThresholdPercentage: 65 },
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = [
				userMessage("start", 1),
				assistantToolCall("call-1", "read", {}, 2),
				toolResultMessage("call-1", "explicit output", 3),
				assistantToolCall("call-2", "read", {}, 4),
				toolResultMessage("call-2", "unrequested output", 5),
				userMessage("continue", 6),
			] as never[];
			const executeCtx = {
				...fakeContext(sessionId),
				getContextUsage: () => ({
					tokens: 70_000,
					percent: 70,
					contextWindow: 100_000,
				}),
			};

			await handler({ messages }, executeCtx as never);
			const toolTags = getTagsBySession(db, sessionId).filter(
				(tag) => tag.type === "tool",
			);
			expect(toolTags).toHaveLength(2);
			queuePendingOp(db, sessionId, toolTags[0].tagNumber, "drop");
			updateSessionMeta(db, sessionId, {
				toolReclaimWatermark: toolTags[1].tagNumber,
			});

			const result = await handler({ messages }, executeCtx as never);
			const statuses = new Map(
				getTagsBySession(db, sessionId).map((tag) => [
					tag.tagNumber,
					tag.status,
				]),
			);
			expect(statuses.get(toolTags[0].tagNumber)).toBe("dropped");
			expect(statuses.get(toolTags[1].tagNumber)).toBe("active");
			expect(textOf(result.messages[4] as never)).toContain(
				"unrequested output",
			);
			expect(getOrCreateSessionMeta(db, sessionId).toolReclaimWatermark).toBe(
				toolTags[1].tagNumber,
			);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("injects deferred-note text into the latest new user message", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			addNote(db, "session", {
				sessionId: "ses-context",
				content: "Remember to update docs.",
			});
			onNoteTrigger(db, "ses-context", "historian_complete");

			const triggerMsg = userMessage("trigger turn", 1);
			const newMsg = userMessage("new turn", 2);
			await handler(
				{ messages: [triggerMsg] as never[] },
				fakeContext(
					"ses-context",
					process.cwd(),
					["entry-trigger"],
					[triggerMsg],
				) as never,
			);
			const result = await handler(
				{ messages: [newMsg] as never[] },
				fakeContext(
					"ses-context",
					process.cwd(),
					["entry-new"],
					[newMsg],
				) as never,
			);

			expect(textOf(result.messages[0] as never)).toContain(
				'<instruction name="deferred_notes">',
			);
			expect(textOf(result.messages[0] as never)).toContain("1 deferred note");
		} finally {
			closeQuietly(db);
		}
	});

	it("replays sticky note nudges idempotently across passes", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-sticky-context";
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			addNote(db, "session", {
				sessionId,
				content: "Sticky reminder.",
			});
			onNoteTrigger(db, sessionId, "historian_complete");
			const triggerMsg = userMessage("trigger turn", 1);
			const newMsg = userMessage("new turn", 2);
			await handler(
				{ messages: [triggerMsg] as never[] },
				fakeContext(
					sessionId,
					process.cwd(),
					["entry-trigger"],
					[triggerMsg],
				) as never,
			);
			await handler(
				{ messages: [newMsg] as never[] },
				fakeContext(sessionId, process.cwd(), ["entry-new"], [newMsg]) as never,
			);

			const result = await handler(
				{ messages: [newMsg] as never[] },
				fakeContext(sessionId, process.cwd(), ["entry-new"], [newMsg]) as never,
			);
			const onceMore = await handler(
				{ messages: result.messages },
				fakeContext(
					sessionId,
					process.cwd(),
					["entry-new"],
					[result.messages[0] as never],
				) as never,
			);

			expect(
				textOf(result.messages[0] as never).match(/deferred_notes/g),
			).toHaveLength(1);
			expect(
				textOf(onceMore.messages[0] as never).match(/deferred_notes/g),
			).toHaveLength(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("appends an auto-search hint to the latest user message when the threshold is met", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () =>
				[
					{
						source: "memory",
						content: "Relevant Pi search wiring",
						score: 0.9,
						memoryId: 1,
						category: "WORKFLOW_RULES",
						matchType: "fts",
					},
				] as never,
		);
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				autoSearch: {
					enabled: true,
					scoreThreshold: 0.6,
					minPromptChars: 10,
					memoryEnabled: true,
					embeddingEnabled: false,
					gitCommitsEnabled: false,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;

			const msg = userMessage("explain pi search wiring", 1);
			const result = await handler(
				{ messages: [msg] as never[] },
				fakeContext("ses-context", process.cwd(), ["entry-1"], [msg]) as never,
			);

			expect(spy).toHaveBeenCalledTimes(1);
			expect(textOf(result.messages[0] as never)).toContain(
				"<ctx-search-hint>",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("clearContextHandlerSession preserves persisted auto-search decisions", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [],
		);
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				autoSearch: {
					enabled: true,
					scoreThreshold: 0.6,
					minPromptChars: 10,
					memoryEnabled: true,
					embeddingEnabled: false,
					gitCommitsEnabled: false,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;

			const msg = userMessage("explain pi search wiring", 1);
			await handler(
				{ messages: [msg] as never[] },
				fakeContext("ses-context", process.cwd(), ["entry-1"], [msg]) as never,
			);
			await handler(
				{ messages: [msg] as never[] },
				fakeContext("ses-context", process.cwd(), ["entry-1"], [msg]) as never,
			);
			clearContextHandlerSession("ses-context");
			await handler(
				{ messages: [msg] as never[] },
				fakeContext("ses-context", process.cwd(), ["entry-1"], [msg]) as never,
			);

			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("replays note anchors by message id but skips new note persistence on ref failure", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-note-ref-fail";
			clearContextHandlerSession(sessionId);
			appendNoteNudgeAnchor(
				db,
				sessionId,
				"entry-existing",
				'\n\n<instruction name="deferred_notes">existing</instruction>',
			);
			addNote(db, "session", { sessionId, content: "Fresh note should wait." });
			onNoteTrigger(db, sessionId, "historian_complete");
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const msg = { ...userMessage("new turn", 1), id: "entry-existing" };
			const result = await handler({ messages: [msg] as never[] }, {
				...fakeContext(sessionId),
				sessionManager: { getSessionId: () => sessionId },
			} as never);

			expect(textOf(result.messages[0] as never)).toContain("existing");
			expect(getNoteNudgeAnchors(db, sessionId)).toHaveLength(1);
		} finally {
			clearContextHandlerSession("ses-note-ref-fail");
			closeQuietly(db);
		}
	});

	it("persists model-resolved cache_ttl from Pi message_end assistant metadata", async () => {
		const db = createTestDb();
		try {
			const { persistPiMessageEndModelMeta } = await import("./index");

			persistPiMessageEndModelMeta({
				db,
				sessionId: "ses-context",
				message: assistantMessage("done", 1, {
					provider: "anthropic",
					model: "claude-sonnet-4-5",
				}),
				cacheTtlConfig: {
					default: "5m",
					"anthropic/claude-sonnet-4-5": "1h",
				},
			});

			expect(getOrCreateSessionMeta(db, "ses-context").cacheTtl).toBe("1h");
		} finally {
			clearContextHandlerSession("ses-context");
			closeQuietly(db);
		}
	});

	it("tracks Pi observed safe input token high-water mark", async () => {
		const db = createTestDb();
		try {
			const { persistPiPressureFromMessageEnd } = await import("./index");

			await persistPiPressureFromMessageEnd({
				db,
				sessionId: "ses-pi-pressure-safe",
				message: assistantMessage("done", 1, {
					usage: { input: 80_000, cacheRead: 10_000, cacheWrite: 0 },
				}),
				piContextWindow: 200_000,
			});
			await persistPiPressureFromMessageEnd({
				db,
				sessionId: "ses-pi-pressure-safe",
				message: assistantMessage("smaller", 2, {
					usage: { input: 50_000, cacheRead: 0, cacheWrite: 0 },
				}),
				piContextWindow: 200_000,
			});

			const meta = getOrCreateSessionMeta(db, "ses-pi-pressure-safe");
			expect(meta.observedSafeInputTokens).toBe(90_000);
			expect(meta.lastInputTokens).toBe(50_000);
		} finally {
			closeQuietly(db);
		}
	});

	it("alerts once when Pi's reported context window is below observed safe tokens", async () => {
		const db = createTestDb();
		try {
			const { persistPiPressureFromMessageEnd } = await import("./index");
			// Pi resolves the window from its own runtime (piContextWindow), not
			// models.dev. Use a wrong-but-still-SANE window (30k): sub-20k values
			// are rejected by the sanity floor, so the "reported window is wrong"
			// scenario must use a value inside [20k, 3M] that is still smaller than
			// the tokens the model successfully accepted.
			updateSessionMeta(db, "ses-pi-pressure-alert", {
				observedSafeInputTokens: 80_000,
			});
			const notify = mock(async () => undefined);

			for (const inputTokens of [90_000, 120_000]) {
				await persistPiPressureFromMessageEnd({
					db,
					sessionId: "ses-pi-pressure-alert",
					message: assistantMessage("done", 1, {
						provider: "test-provider",
						model: "test-model",
						usage: { input: inputTokens, cacheRead: 0, cacheWrite: 0 },
					}),
					piContextWindow: 30_000,
					notifyIssue: notify,
				});
			}

			const meta = getOrCreateSessionMeta(db, "ses-pi-pressure-alert");
			expect(meta.cacheAlertSent).toBe(true);
			expect(meta.lastContextPercentage).toBe(400);
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0]?.[0]).toContain(
				"context limit of 30,000 tokens",
			);
			expect(notify.mock.calls[0]?.[0]).toContain(
				"successfully sent 90,000 tokens",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("uses the live model key for scheduler execute_threshold_percentage resolution", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			recordPiLiveModel("ses-context", "anthropic/claude-sonnet-4-5");
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTags: 0,
				scheduler: {
					executeThresholdPercentage: {
						default: 90,
						"anthropic/claude-sonnet-4-5": 40,
					},
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const ctx = {
				...fakeContext("ses-context"),
				getContextUsage: () => ({
					tokens: 45_000,
					percent: 45,
					contextWindow: 100_000,
				}),
			};

			await handler(
				{
					messages: [
						userMessage("keep", 1),
						assistantMessage("drop", 2),
					] as never[],
				},
				ctx as never,
			);
			queuePendingOp(db, "ses-context", 2, "drop");
			const result = await handler(
				{
					messages: [
						userMessage("keep", 1),
						assistantMessage("drop", 2),
					] as never[],
				},
				ctx as never,
			);

			expect(textOf(result.messages[1] as never)).toBe("[dropped §2§]");
		} finally {
			clearContextHandlerSession("ses-context");
			closeQuietly(db);
		}
	});

	it("uses live forward pressure to execute when persisted pressure is stale", async () => {
		const db = createTestDb();
		const sessionId = "ses-forward-scheduler-floor";
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTags: 0,
				scheduler: { executeThresholdPercentage: 80 },
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const buildMessages = () =>
				[
					userMessage("keep", 1),
					assistantMessage("drop when forward pressure crosses threshold", 2),
				] as never[];
			const entryIds = ["entry-1", "entry-2"];

			let messages = buildMessages();
			await handler({ messages }, {
				...fakeContext(sessionId, process.cwd(), entryIds, messages),
				getContextUsage: () => ({
					tokens: 1_000,
					percent: 1,
					contextWindow: 100_000,
				}),
			} as never);
			queuePendingOp(db, sessionId, 2, "drop");
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 68,
				lastInputTokens: 68_000,
			});

			messages = buildMessages();
			const result = await handler({ messages }, {
				...fakeContext(sessionId, process.cwd(), entryIds, messages),
				getContextUsage: () => ({
					tokens: 85_000,
					percent: 10,
					contextWindow: 100_000,
				}),
			} as never);

			expect(textOf(result.messages[1] as never)).toBe("[dropped §2§]");
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("vetoes pending-op drain and heuristics while a historian is in flight except during force materialization", async () => {
		async function runScenario(args: {
			sessionId: string;
			inFlightHistorian: boolean;
			inputTokens: number;
		}) {
			const db = createTestDb();
			let restoreInFlight: (() => void) | undefined;
			try {
				updateSessionMeta(db, args.sessionId, { piStableIdScheme: 1 });
				const fake = createFakePi();
				registerPiContextHandler(fake.pi as never, {
					db,
					protectedTags: 0,
					heuristics: {},
					scheduler: { executeThresholdPercentage: 65 },
				});
				const handler = fake.handlers.get("context") as (
					event: { messages: never[] },
					ctx: never,
				) => Promise<{ messages: never[] }>;
				const entryIds = [
					"entry-user-1",
					"entry-drop",
					"entry-user-2",
					"entry-tools",
					"entry-result-a",
					"entry-result-b",
					"entry-latest",
				];
				const buildMessages = () =>
					[
						userMessage("first request", 1),
						assistantMessage("drop target", 2),
						userMessage("read twice", 3),
						{
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "read-a",
									name: "mcp_read",
									arguments: { filePath: "src/a.ts" },
								},
								{
									type: "toolCall",
									id: "read-b",
									name: "mcp_read",
									arguments: { filePath: "src/a.ts" },
								},
							],
							timestamp: 4,
						},
						{
							...toolResultMessage("read-a", "read result", 5),
							toolName: "mcp_read",
						},
						{
							...toolResultMessage("read-b", "read result", 6),
							toolName: "mcp_read",
						},
						userMessage("latest request", 7),
					] as never[];
				const contextFor = (messages: never[], tokens = 1_000) =>
					({
						...fakeContext(args.sessionId, process.cwd(), entryIds, messages),
						getContextUsage: () => ({
							tokens,
							percent: tokens / 1000,
							contextWindow: 100_000,
						}),
					}) as never;

				let messages = buildMessages();
				await handler({ messages }, contextFor(messages, 0));

				const dropTag = getTagsBySession(db, args.sessionId).find(
					(tag) =>
						tag.type === "message" &&
						(tag.messageId === "entry-drop" ||
							tag.messageId.startsWith("entry-drop:")),
				);
				if (!dropTag) throw new Error("expected queued-drop target tag");
				queuePendingOp(db, args.sessionId, dropTag.tagNumber, "drop", 1);
				updateSessionMeta(db, args.sessionId, {
					lastResponseTime: Date.now(),
					cacheTtl: "59m",
					lastContextPercentage: args.inputTokens / 1000,
					lastInputTokens: args.inputTokens,
				});
				if (args.inFlightHistorian) {
					restoreInFlight =
						contextHandlerInternals.setInFlightHistorianForTests(
							args.sessionId,
							new Promise(() => undefined),
						);
				}

				messages = buildMessages();
				await handler({ messages }, contextFor(messages));

				const tags = getTagsBySession(db, args.sessionId);
				return {
					dropStatus: tags.find((tag) => tag.tagNumber === dropTag.tagNumber)
						?.status,
					readAStatus: tags.find((tag) => tag.messageId === "read-a")?.status,
					pendingOps: getPendingOps(db, args.sessionId).length,
				};
			} finally {
				restoreInFlight?.();
				clearContextHandlerSession(args.sessionId);
				closeQuietly(db);
			}
		}

		expect(
			await runScenario({
				sessionId: "ses-historian-veto-execute",
				inFlightHistorian: true,
				inputTokens: 70_000,
			}),
		).toEqual({
			dropStatus: "active",
			readAStatus: "active",
			pendingOps: 1,
		});
		expect(
			await runScenario({
				sessionId: "ses-historian-veto-force",
				inFlightHistorian: true,
				inputTokens: 85_000,
			}),
		).toMatchObject({
			dropStatus: "dropped",
			readAStatus: "dropped",
			pendingOps: 0,
		});
		expect(
			await runScenario({
				sessionId: "ses-historian-veto-none",
				inFlightHistorian: false,
				inputTokens: 70_000,
			}),
		).toMatchObject({
			dropStatus: "dropped",
			readAStatus: "dropped",
			pendingOps: 0,
		});
	});

	it("gates new stale ctx_reduce strips by provider but replays already-stripped tags", async () => {
		const buildMessages = () =>
			[
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
			] as never[];
		const entryIds = [
			"entry-1",
			"entry-reduce-owner",
			"entry-reduce-result",
			"entry-4",
			"entry-5",
			"entry-6",
		];

		async function runProviderScenario(
			provider: string,
			replayProvider = provider,
		) {
			const db = createTestDb();
			try {
				const sessionId = `ses-stale-reduce-${provider}`;
				updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
				const fake = createFakePi();
				registerPiContextHandler(fake.pi as never, {
					db,
					protectedTags: 2,
					heuristics: {},
					scheduler: { executeThresholdPercentage: 65 },
				});
				const handler = fake.handlers.get("context") as (
					event: { messages: never[] },
					ctx: never,
				) => Promise<{ messages: never[] }>;
				const contextFor = (
					messages: never[],
					tokens: number,
					providerForPass = provider,
				) =>
					({
						...fakeContext(sessionId, process.cwd(), entryIds, messages),
						model: {
							provider: providerForPass,
							id: "test-model",
							contextWindow: 100_000,
						},
						getContextUsage: () => ({
							tokens,
							percent: tokens / 1000,
							contextWindow: 100_000,
						}),
					}) as never;

				let messages = buildMessages();
				await handler({ messages }, contextFor(messages, 0));
				updateSessionMeta(db, sessionId, {
					lastResponseTime: Date.now(),
					cacheTtl: "59m",
					lastContextPercentage: 70,
					lastInputTokens: 70_000,
				});

				messages = buildMessages();
				await handler({ messages }, contextFor(messages, 70_000));
				const reduceStatus = getTagsBySession(db, sessionId).find(
					(tag) => tag.type === "tool" && tag.messageId === "reduce-1",
				)?.status;

				messages = buildMessages();
				const replay = await handler(
					{ messages },
					contextFor(messages, 1_000, replayProvider),
				);

				return {
					reduceStatus,
					replayedToolResult: textOf(replay.messages[2] as never),
				};
			} finally {
				clearContextHandlerSession(`ses-stale-reduce-${provider}`);
				closeQuietly(db);
			}
		}

		await expect(runProviderScenario("openai")).resolves.toEqual({
			reduceStatus: "active",
			replayedToolResult: "§3§ reduced old tags",
		});
		await expect(runProviderScenario("anthropic", "openai")).resolves.toEqual({
			reduceStatus: "dropped",
			replayedToolResult: "[dropped §3§]",
		});
	});

	it("latches same-sample emergency drops but re-runs on fresh forward growth", async () => {
		const db = createTestDb();
		const sessionId = "ses-forward-emergency-latch";
		const largeToolOutput = "x".repeat(12_000);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTags: 0,
				heuristics: {},
				scheduler: { executeThresholdPercentage: 65 },
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const buildMessages = () => {
				const messages = [userMessage("start tool burst", 1)];
				for (let i = 0; i < 20; i++) {
					messages.push(assistantToolCall(`call-${i}`, "bash", {}, 2 + i * 2), {
						...toolResultMessage(`call-${i}`, largeToolOutput, 3 + i * 2),
						toolName: "bash",
					});
				}
				messages.push(userMessage("continue", 50));
				return messages as never[];
			};
			const entryIds = Array.from(
				{ length: buildMessages().length },
				(_, index) => `entry-${index + 1}`,
			);
			const runPass = (tokens: number) => {
				const messages = buildMessages();
				return handler({ messages }, {
					...fakeContext(sessionId, process.cwd(), entryIds, messages),
					getContextUsage: () => ({
						tokens,
						percent: 10,
						contextWindow: 100_000,
					}),
				} as never);
			};
			await runPass(1_000);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 68,
				lastInputTokens: 68_000,
			});

			await runPass(85_000);
			const firstDropped = getTagsBySession(db, sessionId).filter(
				(tag) => tag.type === "tool" && tag.status === "dropped",
			).length;
			const toolCount = getTagsBySession(db, sessionId).filter(
				(tag) => tag.type === "tool",
			).length;
			expect(firstDropped).toBeGreaterThan(0);
			expect(firstDropped).toBeLessThan(toolCount);
			expect(getEmergencyInputSample(db, sessionId)).toBe(85_000);

			await runPass(85_000);
			const sameSampleDropped = getTagsBySession(db, sessionId).filter(
				(tag) => tag.type === "tool" && tag.status === "dropped",
			).length;
			expect(sameSampleDropped).toBe(firstDropped);

			await runPass(90_000);
			const freshGrowthDropped = getTagsBySession(db, sessionId).filter(
				(tag) => tag.type === "tool" && tag.status === "dropped",
			).length;
			expect(freshGrowthDropped).toBeGreaterThan(sameSampleDropped);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("does not replay persisted caveman compression when caveman is disabled", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-caveman-replay-disabled";
		const originalText =
			"The assistant should preserve the detailed explanation about queue scheduling because caveman replay is disabled.";
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTags: 0,
				heuristics: { caveman: { enabled: false, minChars: 1 } },
				scheduler: { executeThresholdPercentage: 65 },
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const entryIds = ["entry-user", "entry-assistant"];
			const buildMessages = () =>
				[userMessage("start", 1), assistantMessage(originalText, 2)] as never[];
			const contextFor = (messages: never[]) =>
				({
					...fakeContext(sessionId, process.cwd(), entryIds, messages),
					getContextUsage: () => ({
						tokens: 1_000,
						percent: 1,
						contextWindow: 100_000,
					}),
				}) as never;

			let messages = buildMessages();
			await handler({ messages }, contextFor(messages));
			const assistantTag = getTagsBySession(db, sessionId)
				.filter((tag) => tag.type === "message")
				.sort((left, right) => right.tagNumber - left.tagNumber)[0];
			if (!assistantTag) throw new Error("expected assistant message tag");
			updateCavemanDepth(db, sessionId, assistantTag.tagNumber, 1);
			db.prepare(
				"INSERT OR REPLACE INTO source_contents (session_id, tag_id, content, created_at, harness) VALUES (?, ?, ?, ?, 'pi')",
			).run(sessionId, assistantTag.tagNumber, originalText, Date.now());

			messages = buildMessages();
			const result = await handler({ messages }, contextFor(messages));

			expect(textOf(result.messages[1] as never)).toContain(originalText);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("keeps wire bytes stable on a forced pass with no emergency candidates", async () => {
		const db = createTestDb();
		const sessionId = "ses-forward-no-candidates";
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTags: 0,
				heuristics: {},
				scheduler: { executeThresholdPercentage: 65 },
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const buildMessages = () =>
				[
					userMessage("stable user", 1),
					assistantMessage("stable answer", 2),
				] as never[];
			const entryIds = ["entry-1", "entry-2"];
			const runPass = async (tokens: number) => {
				const messages = buildMessages();
				return handler({ messages }, {
					...fakeContext(sessionId, process.cwd(), entryIds, messages),
					getContextUsage: () => ({
						tokens,
						percent: 10,
						contextWindow: 100_000,
					}),
				} as never);
			};
			const prime = await runPass(1_000);
			const stableWire = prime.messages.map((message) =>
				textOf(message as never),
			);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 68,
				lastInputTokens: 68_000,
			});

			const forced = await runPass(85_000);

			expect(
				forced.messages.map((message) => textOf(message as never)),
			).toEqual(stableWire);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("shows the actionable emergency notification when Pi cannot abort the turn", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-emergency-notice";
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				scheduler: { executeThresholdPercentage: 65 },
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const notify = mock(() => undefined);
			const messages = [userMessage("continue", 1)] as never[];
			await handler({ messages }, {
				...fakeContext(sessionId, process.cwd(), ["entry-1"], messages),
				ui: { notify },
				getContextUsage: () => ({
					tokens: 85_000,
					percent: 85,
					contextWindow: 100_000,
				}),
			} as never);

			expect(notify).toHaveBeenCalledWith(
				"Context full — /ctx-flush or /clear to continue.",
			);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("handles a rejected asynchronous emergency notification", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-emergency-notice-reject";
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				scheduler: { executeThresholdPercentage: 65 },
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const notify = mock(async () => {
				throw new Error("toast unavailable");
			});
			const messages = [userMessage("continue", 1)] as never[];

			await handler({ messages }, {
				...fakeContext(sessionId, process.cwd(), ["entry-1"], messages),
				ui: { notify },
				getContextUsage: () => ({
					tokens: 85_000,
					percent: 85,
					contextWindow: 100_000,
				}),
			} as never);
			await Promise.resolve();

			expect(notify).toHaveBeenCalledTimes(1);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("disarms emergency recovery only after real pressure falls below the force threshold", async () => {
		async function runRecoveryPass(sessionId: string, tokens: number) {
			const db = createTestDb();
			try {
				updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
				recordOverflowDetected(db, sessionId, undefined);
				const fake = createFakePi();
				registerPiContextHandler(fake.pi as never, {
					db,
					scheduler: { executeThresholdPercentage: 65 },
				});
				const handler = fake.handlers.get("context") as (
					event: { messages: never[] },
					ctx: never,
				) => Promise<{ messages: never[] }>;

				await handler({ messages: [] as never[] }, {
					...fakeContext(sessionId, process.cwd(), [], []),
					getContextUsage: () => ({
						tokens,
						percent: tokens / 1000,
						contextWindow: 100_000,
					}),
				} as never);

				return getOverflowState(db, sessionId).needsEmergencyRecovery;
			} finally {
				clearContextHandlerSession(sessionId);
				closeQuietly(db);
			}
		}

		await expect(
			runRecoveryPass("ses-recovery-real-pressure-high", 85_000),
		).resolves.toBe(true);
		await expect(
			runRecoveryPass("ses-recovery-real-pressure-low", 10_000),
		).resolves.toBe(false);
	});

	it("uses live forward pressure when deciding whether to fire the historian", async () => {
		const db = createTestDb();
		const sessionId = "ses-forward-historian-floor";
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const runner = {
				harness: "pi",
				run: mock(async () => ({
					ok: true as const,
					assistantText:
						'<compartment start="1" end="2" title="Forward">Forward pressure history.</compartment>',
					durationMs: 1,
				})),
			} as unknown as SubagentRunner;
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTags: 0,
				historian: {
					runner,
					model: "test/historian",
					historianChunkTokens: 20_000,
					executeThresholdPercentage: 80,
					protectedTags: 0,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const prime = [userMessage("prime", 1)] as never[];
			await handler({ messages: prime }, {
				...fakeContext(sessionId, process.cwd(), ["entry-prime"], prime),
				getContextUsage: () => ({
					tokens: 1_000,
					percent: 1,
					contextWindow: 100_000,
				}),
			} as never);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 68,
				lastInputTokens: 68_000,
			});
			const messages = Array.from({ length: 12 }, (_, index) =>
				index % 2 === 0
					? userMessage(`user ${index}`, index + 2)
					: assistantMessage(`assistant ${index}`, index + 2),
			) as never[];
			await handler({ messages }, {
				...fakeContext(
					sessionId,
					process.cwd(),
					messages.map((_, index) => `entry-${index + 1}`),
					messages,
				),
				getContextUsage: () => ({
					tokens: 85_000,
					percent: 10,
					contextWindow: 100_000,
				}),
			} as never);
			await awaitInFlightHistorians();

			expect(runner.run).toHaveBeenCalledTimes(1);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("skips trigger-fired historian while /ctx-wrapup is active", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-wrapup-active-skip";
		try {
			acquireWrapupInProgress(db, sessionId, {
				holderId: "wrapup-holder",
				messagesToKeep: 20,
				anchorRawMessageCount: 100,
				targetEligibleEndOrdinal: 80,
				lastCompartmentEnd: 0,
				chunkIndex: 0,
				expectedChunks: 1,
			});
			const runner = {
				harness: "pi",
				run: mock(async () => ({
					ok: true as const,
					assistantText:
						'<compartment start="1" end="2" title="Skipped">Should not run.</compartment>',
					durationMs: 1,
				})),
			} as unknown as SubagentRunner;
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTags: 0,
				historian: {
					runner,
					model: "test/historian",
					historianChunkTokens: 20_000,
					executeThresholdPercentage: 80,
					protectedTags: 0,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = Array.from({ length: 12 }, (_, index) =>
				index % 2 === 0
					? userMessage(`user ${index}`, index + 1)
					: assistantMessage(`assistant ${index}`, index + 1),
			) as never[];

			await handler({ messages }, {
				...fakeContext(
					sessionId,
					process.cwd(),
					messages.map((_, index) => `entry-${index + 1}`),
					messages,
				),
				getContextUsage: () => ({
					tokens: 85_000,
					percent: 85,
					contextWindow: 100_000,
				}),
			} as never);
			await awaitInFlightHistorians();

			const leaseRow = db
				.prepare(
					"SELECT holder_id AS holderId FROM compartment_state_lease WHERE session_id = ?",
				)
				.get(sessionId) as { holderId: string } | null;
			expect(leaseRow).toBeNull();
			expect(runner.run).not.toHaveBeenCalled();
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("fires trigger historian after an expired /ctx-wrapup marker", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-wrapup-expired-fire";
		try {
			acquireWrapupInProgress(
				db,
				sessionId,
				{
					holderId: "expired-wrapup-holder",
					messagesToKeep: 20,
					anchorRawMessageCount: 100,
					targetEligibleEndOrdinal: 80,
					lastCompartmentEnd: 0,
					chunkIndex: 0,
					expectedChunks: 1,
				},
				Date.now() - 10 * 60_000,
			);
			const runner = {
				harness: "pi",
				run: mock(async () => ({
					ok: true as const,
					assistantText:
						'<compartment start="1" end="2" title="Expired">Expired wrapup marker no longer blocks.</compartment>',
					durationMs: 1,
				})),
			} as unknown as SubagentRunner;
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTags: 0,
				historian: {
					runner,
					model: "test/historian",
					historianChunkTokens: 20_000,
					executeThresholdPercentage: 80,
					protectedTags: 0,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = Array.from({ length: 12 }, (_, index) =>
				index % 2 === 0
					? userMessage(`user ${index}`, index + 1)
					: assistantMessage(`assistant ${index}`, index + 1),
			) as never[];

			await handler({ messages }, {
				...fakeContext(
					sessionId,
					process.cwd(),
					messages.map((_, index) => `entry-${index + 1}`),
					messages,
				),
				getContextUsage: () => ({
					tokens: 85_000,
					percent: 85,
					contextWindow: 100_000,
				}),
			} as never);
			await awaitInFlightHistorians();

			expect(runner.run).toHaveBeenCalledTimes(1);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("derives historian triggerBudget from the same live-session inputs as OpenCode", () => {
		const db = createTestDb();
		try {
			const modelKey = "test/model";
			const contextLimit = 200_000;
			const executeThresholdPercentage = { default: 90, [modelKey]: 70 };
			const executeThresholdTokens = { [modelKey]: 80_000 };
			const opencodeThreshold = resolveExecuteThreshold(
				executeThresholdPercentage,
				modelKey,
				65,
				{
					tokensConfig: executeThresholdTokens,
					contextLimit,
					sessionId: "ses-parity-budget",
				},
			);
			const opencodeBudget = deriveTriggerBudget(
				contextLimit,
				opencodeThreshold,
			);

			const piInputs = resolvePiHistorianTriggerInputs({
				db,
				sessionId: "ses-parity-budget",
				modelKey: undefined,
				usageContextLimit: contextLimit,
				historian: {
					runner: {} as SubagentRunner,
					model: "test/historian",
					historianChunkTokens: 8000,
					executeThresholdPercentage,
					executeThresholdTokens: { default: 80_000 },
				},
			});

			expect(piInputs.executeThresholdPercentage).toBe(opencodeThreshold);
			expect(piInputs.triggerBudget).toBe(opencodeBudget);
		} finally {
			closeQuietly(db);
		}
	});

	it("resolves the full checkCompartmentTrigger argument set per evaluation", () => {
		const db = createTestDb();
		try {
			const historian = {
				runner: {} as SubagentRunner,
				model: "test/historian",
				historianChunkTokens: 8000,
				executeThresholdPercentage: 65,
				executeThresholdTokens: { default: 40_000 },
				commitClusterTrigger: { enabled: false, min_clusters: 9 },
				protectedTags: 3,
				clearReasoningAge: 11,
			};

			const small = resolvePiHistorianTriggerInputs({
				db,
				sessionId: "ses-full-fields",
				historian,
				modelKey: undefined,
				usageContextLimit: 100_000,
			});
			const large = resolvePiHistorianTriggerInputs({
				db,
				sessionId: "ses-full-fields",
				historian: { ...historian, executeThresholdTokens: undefined },
				modelKey: undefined,
				usageContextLimit: 1_000_000,
			});

			expect(small).toMatchObject({
				executeThresholdPercentage: 40,
				triggerBudget: 5000,
				protectedTags: 3,
				clearReasoningAge: 11,
				commitClusterTrigger: { enabled: false, min_clusters: 9 },
				// ceiling = contextLimit(100k) × execThreshold(40%) = 40000
				emergencyCeilingTokens: 40_000,
			});
			expect(large.triggerBudget).toBe(32_500);
		} finally {
			closeQuietly(db);
		}
	});

	it("matches OpenCode compartment trigger decisions for identical resolved inputs", () => {
		const db = createTestDb();
		const sessionId = "ses-trigger-parity";
		try {
			const rawMessages = Array.from({ length: 20 }, (_, index) => ({
				ordinal: index + 1,
				id: `msg-${index + 1}`,
				role: "user",
				parts: [{ type: "text", text: `meaningful turn ${index + 1}` }],
			}));
			for (let i = 1; i <= 20; i++) {
				insertTag(db, sessionId, `msg-${i}`, "message", 1000, i);
			}
			const usage = { percentage: 64, inputTokens: 64_000 };
			const contextLimit = 200_000;
			const executeThresholdPercentage = 65;
			const triggerBudget = deriveTriggerBudget(
				contextLimit,
				executeThresholdPercentage,
			);
			const historian = {
				runner: {} as SubagentRunner,
				model: "test/historian",
				historianChunkTokens: 8000,
				executeThresholdPercentage,
				commitClusterTrigger: { enabled: true, min_clusters: 3 },
				protectedTags: 20,
				clearReasoningAge: 50,
			};
			const piInputs = resolvePiHistorianTriggerInputs({
				db,
				sessionId,
				historian,
				modelKey: undefined,
				usageContextLimit: contextLimit,
			});

			withRawMessageProvider(
				sessionId,
				{ readMessages: () => rawMessages },
				() => {
					const sessionMeta = getOrCreateSessionMeta(db, sessionId);
					const opencodeDecision = checkCompartmentTrigger(
						db,
						sessionId,
						sessionMeta,
						usage,
						0,
						executeThresholdPercentage,
						triggerBudget,
						50,
						{ enabled: true, min_clusters: 3 },
					);
					const piDecision = checkCompartmentTrigger(
						db,
						sessionId,
						sessionMeta,
						usage,
						0,
						piInputs.executeThresholdPercentage,
						piInputs.triggerBudget,
						piInputs.clearReasoningAge,
						piInputs.commitClusterTrigger,
					);

					const stripCreatedAtDeep = (value: unknown): unknown => {
						if (Array.isArray(value)) {
							return value.map(stripCreatedAtDeep);
						}
						if (!value || typeof value !== "object") return value;
						const entries = Object.entries(value as Record<string, unknown>)
							.filter(([key]) => key !== "createdAt")
							.map(([key, inner]) => [key, stripCreatedAtDeep(inner)]);
						return Object.fromEntries(entries);
					};

					expect(piInputs.triggerBudget).toBe(triggerBudget);
					expect(stripCreatedAtDeep(piDecision)).toEqual(
						stripCreatedAtDeep(opencodeDecision),
					);
					expect(piDecision).toMatchObject({
						shouldFire: true,
						reason: "projected_headroom",
					});
				},
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("persists and clears top-level transform errors", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] } | undefined>;
			const throwingEvent = {} as { messages: never[] };
			Object.defineProperty(throwingEvent, "messages", {
				get: () => {
					throw new Error("boom messages");
				},
			});

			await handler(throwingEvent, fakeContext("ses-context") as never);
			expect(getOrCreateSessionMeta(db, "ses-context").lastTransformError).toBe(
				"boom messages",
			);

			await handler(
				{ messages: [userMessage("ok", 2)] as never[] },
				fakeContext("ses-context") as never,
			);
			expect(getOrCreateSessionMeta(db, "ses-context").lastTransformError).toBe(
				null,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("walks the Pi branch only once per context event with historian enabled", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-pi-branch-once";
			clearContextHandlerSession(sessionId);
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				historian: {
					runner: {} as SubagentRunner,
					model: "test/historian",
					historianChunkTokens: 8000,
					executeThresholdPercentage: 65,
					triggerBudget: 8000,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = [userMessage("hello", 1), assistantMessage("answer", 2)];
			let getBranchCalls = 0;
			await handler({ messages: messages as never[] }, {
				...fakeContext(sessionId),
				sessionManager: {
					getSessionId: () => sessionId,
					getBranch: () => {
						getBranchCalls += 1;
						return messages.map((message, index) => ({
							type: "message",
							id: `entry-${index + 1}`,
							message,
						}));
					},
				},
				getContextUsage: () => ({
					tokens: 100,
					percent: 1,
					contextWindow: 100_000,
				}),
			} as never);

			expect(getBranchCalls).toBe(1);
		} finally {
			clearContextHandlerSession("ses-pi-branch-once");
			closeQuietly(db);
		}
	});

	it("restores reasoning bytes when the durable watermark write fails", async () => {
		const db = createTestDb();
		const sessionId = "ses-reasoning-watermark-failure";
		const restorePersistence =
			contextHandlerInternals.setReasoningWatermarkPersistenceForTests(() => {
				throw new Error("faulted reasoning watermark write");
			});
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				heuristics: { clearReasoningAge: 1 },
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] } | undefined>;
			const buildPass = () => [
				userMessage("first", 1),
				{
					role: "assistant",
					timestamp: 2,
					content: [
						{
							type: "thinking",
							thinking: "durable secret",
							thinkingSignature: "sig",
						},
						{ type: "text", text: "first answer" },
					],
				},
				userMessage("second", 3),
				assistantMessage("second answer", 4),
			];
			const runPass = async () => {
				const messages = buildPass();
				const result = await handler({ messages: messages as never[] }, {
					...fakeContext(
						sessionId,
						process.cwd(),
						["entry-u1", "entry-a1", "entry-u2", "entry-a2"],
						messages as never,
					),
					getContextUsage: () => ({
						tokens: 70_000,
						percent: 70,
						contextWindow: 100_000,
					}),
				} as never);
				if (!result) throw new Error("expected transformed messages");
				return result.messages;
			};

			const first = await runPass();
			const second = await runPass();
			const firstThinking = (first[1] as { content: Record<string, unknown>[] })
				.content[0];
			expect(firstThinking).toMatchObject({
				thinking: "durable secret",
				thinkingSignature: "sig",
			});
			expect(JSON.stringify(second)).toBe(JSON.stringify(first));
			expect(
				getOrCreateSessionMeta(db, sessionId).clearedReasoningThroughTag,
			).toBe(0);
		} finally {
			restorePersistence();
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("stamps the stable-id scheme only after a successful cutover pass", async () => {
		const db = createTestDb();
		const sessionId = "ses-cutover-staged-stamp";
		const cutoverAttempts: boolean[] = [];
		const restoreHook =
			contextHandlerInternals.setAfterFallbackAdoptionForTests((isCutover) => {
				cutoverAttempts.push(isCutover);
				if (cutoverAttempts.length === 1) {
					throw new Error("fault after fallback adoption");
				}
			});
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, { db });
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] } | undefined>;
			const buildPass = () => [
				userMessage("hello", 1),
				assistantMessage("answer", 2),
			];
			const runPass = async () => {
				const messages = buildPass() as never[];
				return handler(
					{ messages },
					fakeContext(
						sessionId,
						process.cwd(),
						["entry-user", "entry-assistant"],
						messages,
					) as never,
				);
			};

			expect(await runPass()).toBeUndefined();
			expect(getOrCreateSessionMeta(db, sessionId).piStableIdScheme ?? 0).toBe(
				0,
			);

			expect(await runPass()).toBeDefined();
			expect(cutoverAttempts).toEqual([true, true]);
			expect(getOrCreateSessionMeta(db, sessionId).piStableIdScheme).toBe(1);
		} finally {
			restoreHook();
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("fires a recovery historian on the first pass after persisted failure", async () => {
		const db = createTestDb();
		try {
			incrementHistorianFailure(db, "ses-context", "previous failure");
			const runner = {
				harness: "pi",
				run: mock(async () => ({
					ok: true as const,
					assistantText:
						'<compartment start="1" end="2" title="Recovered">Recovered prior Pi history.</compartment>',
					durationMs: 1,
				})),
			} as unknown as SubagentRunner;
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				historian: {
					runner,
					model: "test/model",
					historianChunkTokens: 20_000,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = Array.from({ length: 12 }, (_, index) =>
				index % 2 === 0
					? userMessage(`user ${index}`, index + 1)
					: assistantMessage(`assistant ${index}`, index + 1),
			) as never[];
			const notify = mock(() => undefined);
			const ctx = {
				...fakeContext("ses-context"),
				ui: { notify },
				sessionManager: {
					getSessionId: () => "ses-context",
					getBranch: () =>
						messages.map((message, index) => ({
							type: "message",
							id: `entry-${index + 1}`,
							message,
						})),
				},
				getContextUsage: () => ({
					tokens: 100,
					percent: 10,
					contextWindow: 10_000,
				}),
			};

			await handler({ messages }, ctx as never);
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(runner.run).toHaveBeenCalledTimes(1);
			expect(notify).toHaveBeenCalledWith(
				expect.stringContaining("Historian recovery"),
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("first pass after restart PRESERVES historian-failure + reasoning watermark while clearing usage", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-firstpass-preserve";
			// Simulate pre-restart state: persisted pressure (so the reset block
			// fires), a persisted historian failure (restart recovery needs it),
			// and a reasoning watermark (clearing it would resurface reasoning).
			incrementHistorianFailure(db, sessionId, "previous failure");
			updateSessionMeta(db, sessionId, {
				lastContextPercentage: 62,
				lastInputTokens: 120_000,
				clearedReasoningThroughTag: 7,
			});
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const msg = userMessage("after restart", 1);
			await handler({ messages: [msg] as never[] }, {
				...fakeContext(sessionId),
				sessionManager: { getSessionId: () => sessionId },
				// Same model as before (no model change) → first-pass path only.
				getContextUsage: () => ({
					tokens: 120_000,
					percent: 62,
					contextWindow: 200_000,
				}),
			} as never);

			const meta = getOrCreateSessionMeta(db, sessionId);
			// Usage fields cleared (stale pressure must not drive thresholds).
			expect(meta.lastContextPercentage).toBe(0);
			expect(meta.lastInputTokens).toBe(0);
			// PRESERVED — restart recovery + reasoning replay depend on these.
			expect(meta.clearedReasoningThroughTag).toBe(7);
			expect(
				getHistorianFailureState(db, sessionId).failureCount,
			).toBeGreaterThan(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps durable deferred publication signals when an in-flight historian publishes after session clear", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-cleared-historian-publish";
		let release!: () => void;
		try {
			incrementHistorianFailure(db, sessionId, "previous failure");
			const runner = {
				harness: "pi",
				run: mock(async () => {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return {
						ok: true as const,
						assistantText:
							'<compartment start="1" end="2" title="Cleared">Cleared session publication.</compartment>',
						durationMs: 1,
					};
				}),
			} as unknown as SubagentRunner;
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				historian: {
					runner,
					model: "test/model",
					historianChunkTokens: 20_000,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = Array.from({ length: 12 }, (_, index) =>
				index % 2 === 0
					? userMessage(`user ${index}`, index + 1)
					: assistantMessage(`assistant ${index}`, index + 1),
			) as never[];

			await handler(
				{ messages },
				fakeContext(
					sessionId,
					process.cwd(),
					messages.map((_, index) => `entry-${index + 1}`),
					messages as never,
				) as never,
			);
			expect(runner.run).toHaveBeenCalledTimes(1);

			clearContextHandlerSession(sessionId);
			release();
			await awaitInFlightHistorians();

			expect(consumeDeferredHistoryRefresh(sessionId)).toBe(true);
			expect(consumeDeferredMaterialization(sessionId)).toBe(true);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("keeps deferred publication signals when an in-flight historian publishes for an active session", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-active-historian-publish";
		let release!: () => void;
		try {
			incrementHistorianFailure(db, sessionId, "previous failure");
			const runner = {
				harness: "pi",
				run: mock(async () => {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return {
						ok: true as const,
						assistantText:
							'<compartment start="1" end="2" title="Active">Active session publication.</compartment>',
						durationMs: 1,
					};
				}),
			} as unknown as SubagentRunner;
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				historian: {
					runner,
					model: "test/model",
					historianChunkTokens: 20_000,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = Array.from({ length: 12 }, (_, index) =>
				index % 2 === 0
					? userMessage(`user ${index}`, index + 1)
					: assistantMessage(`assistant ${index}`, index + 1),
			) as never[];

			await handler(
				{ messages },
				fakeContext(
					sessionId,
					process.cwd(),
					messages.map((_, index) => `entry-${index + 1}`),
					messages as never,
				) as never,
			);
			release();
			await awaitInFlightHistorians();

			expect(consumeDeferredHistoryRefresh(sessionId)).toBe(true);
			expect(consumeDeferredMaterialization(sessionId)).toBe(true);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("isolates deferred publication signals across multiple in-flight sessions when one is cleared", async () => {
		const db = createTestDb();
		const clearedSessionId = "ses-pi-cleared-multi-historian";
		const activeSessionId = "ses-pi-active-multi-historian";
		const releases: Array<() => void> = [];
		try {
			incrementHistorianFailure(db, clearedSessionId, "previous failure");
			incrementHistorianFailure(db, activeSessionId, "previous failure");
			const runner = {
				harness: "pi",
				run: mock(async () => {
					const callIndex = releases.length;
					await new Promise<void>((resolve) => {
						releases.push(resolve);
					});
					return {
						ok: true as const,
						assistantText: `<compartment start="1" end="2" title="Multi ${callIndex}">Multi-session publication.</compartment>`,
						durationMs: 1,
					};
				}),
			} as unknown as SubagentRunner;
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				historian: {
					runner,
					model: "test/model",
					historianChunkTokens: 20_000,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const buildMessages = () =>
				Array.from({ length: 12 }, (_, index) =>
					index % 2 === 0
						? userMessage(`user ${index}`, index + 1)
						: assistantMessage(`assistant ${index}`, index + 1),
				) as never[];
			const clearedMessages = buildMessages();
			const activeMessages = buildMessages();

			await handler(
				{ messages: clearedMessages },
				fakeContext(
					clearedSessionId,
					process.cwd(),
					clearedMessages.map((_, index) => `cleared-entry-${index + 1}`),
					clearedMessages as never,
				) as never,
			);
			await handler(
				{ messages: activeMessages },
				fakeContext(
					activeSessionId,
					process.cwd(),
					activeMessages.map((_, index) => `active-entry-${index + 1}`),
					activeMessages as never,
				) as never,
			);
			expect(runner.run).toHaveBeenCalledTimes(2);

			clearContextHandlerSession(clearedSessionId);
			for (const release of releases) release();
			await awaitInFlightHistorians();

			expect(consumeDeferredHistoryRefresh(clearedSessionId)).toBe(true);
			expect(consumeDeferredMaterialization(clearedSessionId)).toBe(true);
			expect(consumeDeferredHistoryRefresh(activeSessionId)).toBe(true);
			expect(consumeDeferredMaterialization(activeSessionId)).toBe(true);
		} finally {
			clearContextHandlerSession(clearedSessionId);
			clearContextHandlerSession(activeSessionId);
			closeQuietly(db);
		}
	});
	describe("known m[0] hard-fold folds the execute pass in", () => {
		const BASE_MODEL = "anthropic/opus";
		const HARD_MODEL = "anthropic/sonnet";
		const BASE_SYSTEM_HASH = "sys-v1";
		const entryIds = ["entry-user", "entry-call", "entry-result"];

		const buildMessages = () =>
			[
				userMessage("start", 1),
				assistantToolCall("call-1", "bash", {}, 2),
				{
					...toolResultMessage("call-1", "x".repeat(4000), 3),
					toolName: "bash",
				},
			] as never[];

		function contextFor(sessionId: string, messages: never[]) {
			return {
				...fakeContext(sessionId, process.cwd(), entryIds, messages),
				getContextUsage: () => ({
					tokens: 4_000,
					percent: 4,
					contextWindow: 100_000,
				}),
			} as never;
		}

		async function primeBaseline(
			db: ReturnType<typeof createTestDb>,
			sessionId: string,
		) {
			updateSessionMeta(db, sessionId, {
				piStableIdScheme: 1,
				systemPromptHash: BASE_SYSTEM_HASH,
			});
			recordPiLiveModel(sessionId, BASE_MODEL);
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTags: 0,
				heuristics: {},
				injection: { injectionBudgetTokens: 10_000 },
				scheduler: { executeThresholdPercentage: 80 },
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;

			const firstMessages = buildMessages();
			await handler(
				{ messages: firstMessages },
				contextFor(sessionId, firstMessages),
			);

			const toolTag = getTagsBySession(db, sessionId).find(
				(tag) => tag.type === "tool",
			);
			if (!toolTag) throw new Error("expected Pi tool tag after baseline pass");
			queuePendingOp(db, sessionId, toolTag.tagNumber, "drop", 1);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 40,
				lastInputTokens: 4_000,
			});

			return { handler, toolTagNumber: toolTag.tagNumber };
		}

		it("drains queued pending ops on a DEFER scheduler pass when m[0] HARD-folds", async () => {
			const db = createTestDb();
			const sessionId = "ses-pi-hardfold-drain";
			try {
				const { handler, toolTagNumber } = await primeBaseline(db, sessionId);
				recordPiLiveModel(sessionId, HARD_MODEL);

				const secondMessages = buildMessages();
				await handler(
					{ messages: secondMessages },
					contextFor(sessionId, secondMessages),
				);

				expect(
					getTagsBySession(db, sessionId).find(
						(tag) => tag.tagNumber === toolTagNumber,
					)?.status,
				).toBe("dropped");
				expect(getPendingOps(db, sessionId)).toHaveLength(0);
			} finally {
				clearContextHandlerSession(sessionId);
				closeQuietly(db);
			}
		});

		it("leaves queued drops untouched on a plain DEFER pass with unchanged markers", async () => {
			const db = createTestDb();
			const sessionId = "ses-pi-hardfold-nodrain";
			try {
				const { handler, toolTagNumber } = await primeBaseline(db, sessionId);

				const secondMessages = buildMessages();
				await handler(
					{ messages: secondMessages },
					contextFor(sessionId, secondMessages),
				);

				expect(
					getTagsBySession(db, sessionId).find(
						(tag) => tag.tagNumber === toolTagNumber,
					)?.status,
				).toBe("active");
				expect(getPendingOps(db, sessionId)).toHaveLength(1);
			} finally {
				clearContextHandlerSession(sessionId);
				closeQuietly(db);
			}
		});
	});

	describe("Pi deferred compaction marker drain", () => {
		function seedCompartment(
			db: ReturnType<typeof createTestDb>,
			sessionId: string,
		): void {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-2",
					title: "Compacted",
					content: "Older history.",
				},
			]);
		}

		async function runDrainPass(args: {
			db: ReturnType<typeof createTestDb>;
			sessionId: string;
			appendCompaction?: (...args: unknown[]) => string | undefined;
			contextPercent?: number;
		}): Promise<void> {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db: args.db,
				injection: { injectionBudgetTokens: 10_000 },
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const messages = [
				userMessage("first", 1),
				assistantMessage("second", 2),
				userMessage("third", 3),
			] as never[];
			const ctx = fakeContext(
				args.sessionId,
				process.cwd(),
				["entry-1", "entry-2", "entry-3"],
				messages as never,
			) as never as {
				sessionManager: {
					appendCompaction?: (...args: unknown[]) => string | undefined;
				};
			};
			if (args.appendCompaction) {
				ctx.sessionManager.appendCompaction = args.appendCompaction;
			}
			if (args.contextPercent !== undefined) {
				(ctx as { getContextUsage: () => unknown }).getContextUsage = () => ({
					tokens: args.contextPercent === 0 ? 0 : 90_000,
					percent: args.contextPercent,
					contextWindow: 100_000,
				});
			}
			await handler({ messages }, ctx as never);
		}

		it("drains a deferred Pi marker only on a materializing pass", async () => {
			const db = createTestDb();
			const sessionId = "ses-pi-marker-drain";
			try {
				seedCompartment(db, sessionId);
				setPendingPiCompactionMarkerState(db, sessionId, {
					firstKeptEntryId: "entry-3",
					endMessageId: "entry-2",
					ordinal: 2,
					tokensBefore: 10,
					summary: "summary",
					publishedAt: 1,
				});
				signalPiDeferredHistoryRefresh(sessionId);
				signalPiPendingMaterialization(sessionId);
				const appendCompaction = mock(() => "compact-1");

				await runDrainPass({ db, sessionId, appendCompaction });

				expect(appendCompaction).toHaveBeenCalledTimes(1);
				expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
				expect(consumeDeferredHistoryRefresh(sessionId)).toBe(false);
			} finally {
				clearContextHandlerSession(sessionId);
				closeQuietly(db);
			}
		});

		it("preserves deferred marker signals on contention fallback, then drains after a covered render", async () => {
			const db = createTestDb();
			const sessionId = "ses-pi-marker-contention-retry";
			const appendCompaction = mock(() => "compact-1");
			let contention = true;
			const restoreInjection = contextHandlerInternals.setInjectM0M1PiForTests(
				(_state, _db, _messages) => ({
					injected: true,
					compartmentCount: 1,
					factCount: 0,
					memoryCount: 0,
					skippedVisibleMessages: 0,
					m0Materialized: !contention,
					m0Reason: contention ? "contention" : "test_success",
					m0Bytes: 2,
					m1Bytes: 2,
					contentionExhausted: contention,
					renderedBoundary: contention
						? { endMessageId: "entry-1", ordinal: 1 }
						: { endMessageId: "entry-2", ordinal: 2 },
					syntheticLeadingCount: 0,
				}),
			);
			try {
				seedCompartment(db, sessionId);
				setPendingPiCompactionMarkerState(db, sessionId, {
					firstKeptEntryId: "entry-3",
					endMessageId: "entry-2",
					ordinal: 2,
					tokensBefore: 10,
					summary: "summary",
					publishedAt: 1,
				});
				signalPiDeferredHistoryRefresh(sessionId);
				signalPiDeferredMaterialization(sessionId);

				await runDrainPass({
					db,
					sessionId,
					appendCompaction,
					contextPercent: 90,
				});

				expect(appendCompaction).not.toHaveBeenCalled();
				expect(getPendingPiCompactionMarkerState(db, sessionId)).not.toBeNull();
				expect(consumeDeferredHistoryRefresh(sessionId)).toBe(true);
				expect(consumeDeferredMaterialization(sessionId)).toBe(true);
				signalPiDeferredHistoryRefresh(sessionId);
				signalPiDeferredMaterialization(sessionId);

				contention = false;
				await runDrainPass({
					db,
					sessionId,
					appendCompaction,
					contextPercent: 90,
				});

				expect(appendCompaction).toHaveBeenCalledTimes(1);
				expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
				expect(consumeDeferredHistoryRefresh(sessionId)).toBe(false);
				expect(consumeDeferredMaterialization(sessionId)).toBe(false);
			} finally {
				restoreInjection();
				clearContextHandlerSession(sessionId);
				closeQuietly(db);
			}
		});

		it("defers rehydrated Pi marker signals until the next natural bust", async () => {
			const db = createTestDb();
			const sessionId = "ses-pi-marker-rehydrated-deferred";
			try {
				const { signalPiDeferredCompactionMarkerDrain } = await import(
					"./index"
				);
				seedCompartment(db, sessionId);
				const appendCompaction = mock(() => "compact-1");

				await runDrainPass({ db, sessionId, appendCompaction });

				setPendingPiCompactionMarkerState(db, sessionId, {
					firstKeptEntryId: "entry-3",
					endMessageId: "entry-2",
					ordinal: 2,
					tokensBefore: 10,
					summary: "summary",
					publishedAt: 1,
				});
				signalPiDeferredCompactionMarkerDrain(sessionId);
				expect(hasPendingMaterialization(sessionId)).toBe(false);

				await runDrainPass({
					db,
					sessionId,
					appendCompaction,
					contextPercent: 0,
				});

				expect(appendCompaction).not.toHaveBeenCalled();
				expect(getPendingPiCompactionMarkerState(db, sessionId)).not.toBeNull();

				await runDrainPass({
					db,
					sessionId,
					appendCompaction,
					contextPercent: 90,
				});

				expect(appendCompaction).toHaveBeenCalledTimes(1);
				expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
				expect(consumePendingMaterialization(sessionId)).toBe(false);
			} finally {
				clearContextHandlerSession(sessionId);
				closeQuietly(db);
			}
		});

		it("preserves blob_Y and deferred signal when CAS clear loses to a newer blob", async () => {
			const db = createTestDb();
			const sessionId = "ses-pi-marker-cas-loss";
			const blobY = {
				firstKeptEntryId: "entry-3",
				endMessageId: "entry-2",
				ordinal: 2,
				tokensBefore: 20,
				summary: "newer",
				publishedAt: 2,
			};
			try {
				seedCompartment(db, sessionId);
				setPendingPiCompactionMarkerState(db, sessionId, {
					firstKeptEntryId: "entry-3",
					endMessageId: "entry-2",
					ordinal: 2,
					tokensBefore: 10,
					summary: "older",
					publishedAt: 1,
				});
				signalPiDeferredHistoryRefresh(sessionId);
				signalPiPendingMaterialization(sessionId);
				const appendCompaction = mock(() => {
					setPendingPiCompactionMarkerState(db, sessionId, blobY);
					return "compact-1";
				});

				await runDrainPass({ db, sessionId, appendCompaction });

				expect(getPendingPiCompactionMarkerState(db, sessionId)).toEqual(blobY);
				expect(consumeDeferredHistoryRefresh(sessionId)).toBe(true);
			} finally {
				clearContextHandlerSession(sessionId);
				closeQuietly(db);
			}
		});

		it("drains a manually seeded blob on an explicit flush/materialization pass", async () => {
			const db = createTestDb();
			const sessionId = "ses-pi-marker-flush-no-drain";
			const blob = {
				firstKeptEntryId: "entry-3",
				endMessageId: "entry-2",
				ordinal: 2,
				tokensBefore: 10,
				summary: "summary",
				publishedAt: 1,
			};
			try {
				seedCompartment(db, sessionId);
				setPendingPiCompactionMarkerState(db, sessionId, blob);
				signalPiHistoryRefresh(sessionId);
				signalPiPendingMaterialization(sessionId);
				const appendCompaction = mock(() => "compact-1");

				await runDrainPass({ db, sessionId, appendCompaction });

				expect(appendCompaction).toHaveBeenCalledTimes(1);
				expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
			} finally {
				clearContextHandlerSession(sessionId);
				closeQuietly(db);
			}
		});
	});
});

describe("collectMessageEntryIdsStrict", () => {
	it("returns null on API unavailable or length mismatch", () => {
		expect(
			collectMessageEntryIdsStrict(
				{ sessionManager: {} } as never,
				1,
				"ses-strict",
			),
		).toBeNull();

		expect(
			collectMessageEntryIdsStrict(
				{
					sessionManager: {
						getBranch: () => [{ type: "message", id: "entry-1" }],
					},
				} as never,
				2,
				"ses-strict",
			),
		).toBeNull();
	});

	it("returns real entry ids and preserves synthetic undefined entries", () => {
		expect(
			collectMessageEntryIdsStrict(
				{
					sessionManager: {
						getBranch: () => [
							{ type: "message", id: "entry-1" },
							{ type: "compaction", firstKeptEntryId: "entry-2" },
							{ type: "message", id: "entry-2" },
						],
					},
				} as never,
				2,
				"ses-strict",
			),
		).toEqual([undefined, "entry-2"]);
	});
});

describe("collectMessageEntryIdsByRef", () => {
	it("returns null when SessionManager API is unavailable", () => {
		expect(
			collectMessageEntryIdsByRef(
				{ sessionManager: {} } as never,
				[userMessage("hi", 1)],
				"ses-ref",
			),
		).toBeNull();
	});

	it("resolves entry ids by reference identity, not by position", () => {
		// Same scenario as production: Pi's `agent.state.messages` and
		// `sessionManager.getBranch()` are in sync. Each event message has
		// a corresponding `type: "message"` branch entry whose `.message`
		// field is the SAME object reference.
		const m1 = userMessage("first", 1);
		const m2 = userMessage("second", 2);
		const m3 = userMessage("third", 3);
		const result = collectMessageEntryIdsByRef(
			{
				sessionManager: {
					getBranch: () => [
						{ type: "message", id: "entry-a", message: m1 },
						{ type: "message", id: "entry-b", message: m2 },
						{ type: "message", id: "entry-c", message: m3 },
					],
				},
			} as never,
			[m1, m2, m3],
			"ses-ref",
		);
		expect(result).toEqual(["entry-a", "entry-b", "entry-c"]);
	});

	it("survives off-by-one length divergence (regression for log-observed bug)", () => {
		// Production bug: Pi's `state.messages.length = N` while
		// `getBranch()` emit-eligible count = N ± 1. The position-based
		// walk in `collectMessageEntryIds` returned a slice with wrong
		// alignment. Reference-based resolution returns the correct
		// id for matched refs and undefined for unmatched, regardless
		// of length divergence.
		const m1 = userMessage("turn-1", 1);
		const m2 = userMessage("turn-2", 2);
		const m3 = userMessage("turn-3", 3);
		// `event.messages` has 3 entries but `getBranch()` only has 2
		// emit-eligible entries — Pi runtime hasn't appended turn-3
		// yet at the moment the context event fires (race window).
		const result = collectMessageEntryIdsByRef(
			{
				sessionManager: {
					getBranch: () => [
						{ type: "message", id: "entry-1", message: m1 },
						{ type: "message", id: "entry-2", message: m2 },
					],
				},
			} as never,
			[m1, m2, m3],
			"ses-ref",
		);
		expect(result).toEqual(["entry-1", "entry-2", undefined]);
	});

	it("survives catastrophic length divergence (issue #81 scenario)", () => {
		// Production bug: another Pi extension (e.g. condensed-milk-pi)
		// mutates `event.messages` in its own context handler, so the
		// messages we see have ZERO ref-identity overlap with the
		// branch entries. Position-based walk would map every index
		// to the wrong id; reference-based walk returns undefined for
		// every slot, leaving the caller's synthesized fallback to
		// handle them.
		const mutated = [
			userMessage("mutated-1", 1),
			userMessage("mutated-2", 2),
			userMessage("mutated-3", 3),
		];
		const branchOriginals = [
			userMessage("original-1", 1),
			userMessage("original-2", 2),
		];
		const result = collectMessageEntryIdsByRef(
			{
				sessionManager: {
					getBranch: () => [
						{ type: "message", id: "entry-a", message: branchOriginals[0] },
						{ type: "message", id: "entry-b", message: branchOriginals[1] },
					],
				},
			} as never,
			mutated,
			"ses-ref",
		);
		// All slots unmapped because no ref identity overlaps.
		expect(result).toEqual([undefined, undefined, undefined]);
	});

	it("resolves cloned message wrappers with fingerprint fallback", () => {
		const original = {
			...userMessage("same text", 10),
			responseId: "resp-1",
		};
		const clone = {
			...userMessage("same text", 10),
			responseId: "resp-1",
		};

		const result = collectMessageEntryIdsByRef(
			{
				sessionManager: {
					getBranch: () => [
						{ type: "message", id: "entry-clone", message: original },
					],
				},
			} as never,
			[clone as never],
			"ses-ref",
		);

		expect(result).toEqual(["entry-clone"]);
	});

	it("does not fingerprint-resolve ambiguous cloned repeated messages", () => {
		const originalA = userMessage("same text", 10);
		const originalB = userMessage("same text", 10);
		const clone = userMessage("same text", 10);

		const result = collectMessageEntryIdsByRef(
			{
				sessionManager: {
					getBranch: () => [
						{ type: "message", id: "entry-a", message: originalA },
						{ type: "message", id: "entry-b", message: originalB },
					],
				},
			} as never,
			[clone],
			"ses-ref",
		);

		expect(result).toEqual([undefined]);
	});

	it("skips non-message entry types and entries with missing fields", () => {
		// `compaction` and `branch_summary` entries are NOT used for
		// ref-mapping (Pi's `buildSessionContext` wraps them in fresh
		// objects per call, so reference matching would fail anyway).
		const m1 = userMessage("user-msg", 1);
		const result = collectMessageEntryIdsByRef(
			{
				sessionManager: {
					getBranch: () => [
						{ type: "model_change", id: "entry-mc" },
						{ type: "thinking_level_change", id: "entry-tlc" },
						{ type: "compaction", id: "entry-comp", firstKeptEntryId: "x" },
						{ type: "branch_summary", id: "entry-bs", summary: "x" },
						{ type: "message", id: "entry-msg", message: m1 },
					],
				},
			} as never,
			[m1],
			"ses-ref",
		);
		expect(result).toEqual(["entry-msg"]);
	});
});

describe("Pi branch projection cache", () => {
	it("rebuilds from a cached ancestor after a branch switch and matches a cold projection", () => {
		const entries = [
			{
				type: "message",
				id: "root",
				parentId: null,
				message: userMessage("root", 1),
			},
			{
				type: "message",
				id: "a",
				parentId: "root",
				message: userMessage("a", 2),
			},
			{ type: "message", id: "b", parentId: "a", message: userMessage("b", 3) },
			{ type: "message", id: "c", parentId: "b", message: userMessage("c", 4) },
			{ type: "message", id: "x", parentId: "a", message: userMessage("x", 5) },
			{ type: "message", id: "y", parentId: "x", message: userMessage("y", 6) },
		];
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		let leafId = "c";
		let getEntryCalls = 0;
		const context = {
			sessionManager: {
				getLeafId: () => leafId,
				getEntry: (id: string) => {
					getEntryCalls += 1;
					return byId.get(id);
				},
			},
		} as never;

		const initial = contextHandlerInternals.readPiBranchEntriesForContext(
			context,
			"ses-projection",
		);
		expect(initial?.map((entry) => (entry as { id: string }).id)).toEqual([
			"root",
			"a",
			"b",
			"c",
		]);
		expect(getEntryCalls).toBe(4);
		contextHandlerInternals.readPiBranchEntriesForContext(
			context,
			"ses-projection",
		);
		expect(getEntryCalls).toBe(4);

		leafId = "y";
		const switched = contextHandlerInternals.readPiBranchEntriesForContext(
			context,
			"ses-projection",
		);
		expect(getEntryCalls).toBe(6);
		const switchedMessages = (switched ?? []).map((entry) =>
			structuredClone((entry as { message: unknown }).message),
		);
		expect(
			collectMessageEntryIdsByRef(
				{} as never,
				switchedMessages as never[],
				"ses-projection",
				switched ?? undefined,
			),
		).toEqual(["root", "a", "x", "y"]);

		const cold = contextHandlerInternals.readPiBranchEntriesForContext(
			context,
			"ses-projection-cold",
		);
		expect(JSON.stringify(switched)).toBe(JSON.stringify(cold));
		clearContextHandlerSession("ses-projection");
		clearContextHandlerSession("ses-projection-cold");
	});
});

describe("maybeFireHistorian raw provider cleanup", () => {
	it("unregisters the raw-message provider in finally when no historian is spawned", () => {
		const src = readFileSync(
			join(import.meta.dir, "context-handler.ts"),
			"utf8",
		);
		const start = src.indexOf("function maybeFireHistorian");
		const end = src.indexOf("interface RunPipelineArgs", start);
		const body = src.slice(start, end);

		expect(body).toContain("let triggered = false");
		expect(body).toContain("if (!trigger.shouldFire)");
		expect(body).toContain("} finally {");
		expect(body).toContain("if (!triggered) unregister();");
	});
});
