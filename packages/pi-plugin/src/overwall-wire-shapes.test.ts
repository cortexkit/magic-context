import { expect, test } from "bun:test";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { createScheduler } from "@magic-context/core/features/magic-context/scheduler";
import {
	getOrCreateSessionMeta,
	getTagsBySession,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getOverflowState } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { applyFlushedStatuses } from "@magic-context/core/hooks/magic-context/apply-operations";
import { evaluateChannel2 } from "@magic-context/core/hooks/magic-context/ctx-reduce-nudge";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { applyPiHeuristicCleanup } from "./heuristic-cleanup-pi";
import { computePiPressure, resolvePiPressureSnapshot } from "./pi-pressure";
import { measurePiTailHygiene } from "./tail-hygiene-walk-pi";
import { createTestDb } from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

const call = (id: string) => ({
	type: "toolCall",
	id,
	name: "read",
	arguments: { path: id },
});
const result = (id: string, text = "result") => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text }],
	timestamp: 2,
});
async function wire(messages: unknown[], native: boolean): Promise<unknown> {
	const model = {
		id: "test",
		name: "test",
		api: native ? "openai-responses" : "anthropic-messages",
		provider: native ? "openai" : "anthropic",
		baseUrl: "https://invalid.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 1024,
	};
	if (native)
		return convertResponsesMessages(
			model as never,
			{ messages } as never,
			new Set(["openai"]),
		);
	let captured: unknown;
	await streamAnthropic(model as never, { messages } as never, {
		apiKey: "fixture",
		onPayload(p) {
			captured = p;
			throw Error("capture");
		},
	}).result();
	return captured;
}
for (const native of [false, true])
	for (const thinking of [false, true])
		test(`Q4 serialized mixed shared-message arcs native=${native} thinking=${thinking}`, async () => {
			const db = createTestDb();
			try {
				const source: unknown[] = [
					{
						role: "assistant",
						api: native ? "openai-responses" : "anthropic-messages",
						provider: native ? "openai" : "anthropic",
						model: "test",
						timestamp: 1,
						content: [
							...(thinking
								? [
										{
											type: "thinking",
											thinking: "signed thought",
											thinkingSignature: native
												? JSON.stringify({
														type: "reasoning",
														id: "rs_test",
														summary: [
															{ type: "summary_text", text: "signed thought" },
														],
													})
												: "signature",
										},
									]
								: []),
							call("drop"),
							call("keep"),
						],
					},
					result("drop"),
					result("keep"),
					{ role: "assistant", content: [call("open")], timestamp: 3 },
				];
				const tr = createPiTranscript(source, "shapes", undefined, {
					preserveReasoningToolArcs: !native,
				});
				const tagger = createTagger();
				tagger.initFromDb("shapes", db);
				const { targets } = tagTranscript("shapes", tr, tagger, db);
				const tags = getTagsBySession(db, "shapes");
				const dropTag = tags.find((t) => t.messageId === "drop");
				if (!dropTag) throw new Error("Expected drop tool tag");
				const target = targets.get(dropTag.tagNumber);
				if (!target?.drop) throw new Error("Expected droppable tool target");
				target.drop();
				const openTag = tags.find((t) => t.messageId === "open");
				if (!openTag) throw new Error("Expected open tool tag");
				const open = targets.get(openTag.tagNumber);
				if (!open?.drop) throw new Error("Expected incomplete tool target");
				expect(open.drop()).toBe("incomplete");
				tr.commit();
				tr.finalizeToolRemovals();
				const w: unknown = await wire(source, native);
				expect(w).toBeDefined();
				const parts = native
					? w
					: w.messages.flatMap((m: unknown) => m.content);
				const calls = parts
					.filter(
						(p: unknown) => p.type === (native ? "function_call" : "tool_use"),
					)
					.map((p: unknown) => (native ? p.call_id : p.id));
				const results = parts
					.filter(
						(p: unknown) =>
							p.type === (native ? "function_call_output" : "tool_result"),
					)
					.map((p: unknown) => (native ? p.call_id : p.tool_use_id));
				expect(calls).toContain("keep");
				expect(calls).toContain("open");
				expect(results).toContain("keep");
				for (const id of results) expect(calls).toContain(id);
				if (!thinking || native) {
					expect(calls).not.toContain("drop");
					expect(results).not.toContain("drop");
				} else {
					expect(calls).toContain("drop");
					expect(results).toContain("drop");
					expect(
						w.messages
							.filter((m: unknown) => m.role === "assistant")
							.every((m: unknown) => m.content.length > 0),
					).toBe(true);
				}
			} finally {
				db.close();
			}
		});
test("Q5 99 percent emergency skeletonizes signed arc and replay is byte stable", () => {
	const db = createTestDb();
	try {
		const source: unknown[] = [
			{
				role: "assistant",
				timestamp: 1,
				content: [
					{
						type: "thinking",
						thinking: "signed thought",
						thinkingSignature: "signature",
					},
					call("signed"),
				],
			},
			result("signed", "payload ".repeat(20000)),
		];
		const serve = (replay: boolean) => {
			const messages = structuredClone(source);
			const tr = createPiTranscript(messages, "emergency", undefined, {
				preserveReasoningToolArcs: true,
			});
			const tagger = createTagger();
			tagger.initFromDb("emergency", db);
			const { targets } = tagTranscript("emergency", tr, tagger, db);
			if (replay) applyFlushedStatuses("emergency", db, targets);
			else {
				const outcome = applyPiHeuristicCleanup(
					"emergency",
					db,
					targets,
					messages,
					{
						routine: false,
						protectedTags: 0,
						emergency: {
							usagePercentage: 99,
							currentTotalInputTokens: 100000,
							ceilingTokens: 100000,
						},
					} as never,
				);
				expect(outcome.emergencyDroppedTools).toBe(1);
			}
			tr.commit();
			tr.finalizeToolRemovals();
			return messages;
		};
		const initial = serve(false);
		expect(initial.length).toBe(2);
		expect(
			getTagsBySession(db, "emergency").find((t) => t.type === "tool")
				?.dropMode,
		).toBe("skeleton_real");
		expect(JSON.stringify(serve(true))).toBe(JSON.stringify(initial));
		expect(JSON.stringify(serve(true))).toBe(JSON.stringify(initial));
	} finally {
		db.close();
	}
});
test("Q6 above-wall persisted floor plus provider pressure, then below wall", async () => {
	const { persistPiPressureFromMessageEnd } = await import("./index");
	const db = createTestDb();
	try {
		const sessionId = "floor";
		updateSessionMeta(db, sessionId, {
			observedSafeInputTokens: 140000,
			lastInputTokens: 500000,
			lastContextPercentage: 500,
			cacheTtl: "never",
		});
		// The floor was proven on the model this reply comes from; a floor with
		// no recorded model would be dropped instead of kept.
		const { recordPiProvenFloorModel } = await import("./pi-proven-floor");
		recordPiProvenFloorModel(db, sessionId, "openai-codex/gpt-5.6-sol", 140000);
		await persistPiPressureFromMessageEnd({
			db,
			sessionId,
			message: {
				role: "assistant",
				usage: { input: 380687 },
				errorMessage: "Your input exceeds the context window",
			},
			piContextWindow: 272000,
			piModel: {
				provider: "openai-codex",
				id: "gpt-5.6-sol",
				maxTokens: 128000,
			},
		});
		const meta = getOrCreateSessionMeta(db, sessionId);
		expect(meta.lastInputTokens).toBe(0);
		expect(meta.observedSafeInputTokens).toBe(140000);
		expect(
			getOverflowState(db, sessionId).detectedContextLimit,
		).toBeLessThanOrEqual(272000);
		const pressure = resolvePiPressureSnapshot({
			persistedPercentage: meta.lastContextPercentage,
			persistedInputTokens: meta.lastInputTokens,
			usableContextLimit: meta.lastUsageContextLimit,
			// Recovery is driven by the provider error, not aggregate usage.
			minimumPercentage: 95,
		});
		expect(pressure.percentage).toBe(95);
		expect(
			createScheduler({ executeThresholdPercentage: 90 }).shouldExecute(
				meta,
				pressure,
			),
		).toBe("execute");
		expect(computePiPressure({ input: 271999 }, 204000, 272000)).toEqual({
			inputTokens: 271999,
			percentage: (271999 / 204000) * 100,
		});
	} finally {
		db.close();
	}
});
test("Q7 skeleton-heavy tail still counts real reclaimable output but suppresses Channel2", () => {
	const messages: unknown[] = [];
	for (let i = 0; i < 1000; i++)
		messages.push(
			{
				role: "assistant",
				content: [
					{ ...call(`s${i}`), arguments: { dropped: `[dropped §${i + 1}§]` } },
				],
			},
			result(`s${i}`, `[dropped §${i + 1}§]`),
		);
	messages.push(
		{ role: "assistant", content: [call("live")] },
		result("live", "reclaim ".repeat(1000)),
	);
	const tags: unknown[] = [
		{
			tagNumber: 1001,
			messageId: "live",
			type: "tool",
			status: "active",
			toolName: "read",
			toolOwnerMessageId: "owner",
		},
	];
	const h = measurePiTailHygiene({
		messages,
		tags,
		protectedTagNumbers: new Set(),
		stableId: (m: unknown) =>
			m.content?.[0]?.id === "live" ? "owner" : undefined,
	});
	expect(h.u).toBeGreaterThan(1000);
	expect(h.u / h.t).toBeLessThan(0.75);
	expect(
		evaluateChannel2({
			baselineU: h.u,
			baselineT: h.t,
			turnDeltaU: 0,
			turnDeltaT: 0,
			evaluable: true,
			generationInvalidated: false,
		}).shouldTrigger,
	).toBe(false);
	console.log("Q7 measured", h.u, h.t, h.u / h.t);
});
test("Q8 indices survive marking and commit; identity finalizer tolerates intervening history prepend", () => {
	const db = createTestDb();
	try {
		const messages: unknown[] = [
			{ role: "assistant", content: [call("old")] },
			result("old"),
			{ role: "user", content: "tail" },
		];
		const ids = ["assistant-entry", "result-entry", "tail-entry"];
		const tr = createPiTranscript(messages, "indices", ids, {
			preserveReasoningToolArcs: false,
		});
		const tagger = createTagger();
		tagger.initFromDb("indices", db);
		const { targets } = tagTranscript("indices", tr, tagger, db);
		const tags = getTagsBySession(db, "indices");
		const oldTag = tags.find((t) => t.messageId === "old");
		if (!oldTag) throw new Error("Expected old tool tag");
		const oldTarget = targets.get(oldTag.tagNumber);
		if (!oldTarget?.drop) throw new Error("Expected droppable old target");
		oldTarget.drop();
		expect(tr.getWorkingMessages().length).toBe(3);
		expect(tr.messages.some((m) => m.info.id === "tail-entry")).toBe(true);
		tr.commit();
		expect(messages.length).toBe(3);
		const byRef = new Map(messages.map((m, i) => [m, ids[i]]));
		messages.unshift({ role: "user", content: "history" });
		tr.finalizeToolRemovals();
		expect(messages.length).toBe(2);
		expect(byRef.get(messages[1])).toBe("tail-entry");
		expect(messages[1].content).toContain("tail");
	} finally {
		db.close();
	}
});

test("Q4 Anthropic sole signed tool arc retains serialized separator", async () => {
	const db = createTestDb();
	try {
		const messages: unknown[] = [
			{
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				timestamp: 1,
				content: [
					{
						type: "thinking",
						thinking: "thought",
						thinkingSignature: "signed",
					},
					call("sole"),
				],
			},
			result("sole"),
		];
		const tr = createPiTranscript(messages, "sole", undefined, {
			preserveReasoningToolArcs: true,
		});
		const tagger = createTagger();
		tagger.initFromDb("sole", db);
		const { targets } = tagTranscript("sole", tr, tagger, db);
		const soleTag = getTagsBySession(db, "sole").find((t) => t.type === "tool");
		if (!soleTag) throw new Error("Expected sole tool tag");
		const soleTarget = targets.get(soleTag.tagNumber);
		if (!soleTarget?.drop) throw new Error("Expected droppable sole target");
		soleTarget.drop();
		tr.commit();
		tr.finalizeToolRemovals();
		const w: unknown = await wire(messages, false);
		const assistant = w.messages.find((m: unknown) => m.role === "assistant");
		expect(assistant.content.length).toBeGreaterThan(0);
		expect(
			assistant.content.some(
				(p: unknown) => p.type === "tool_use" && p.id === "sole",
			),
		).toBe(true);
		expect(
			w.messages
				.flatMap((m: unknown) => m.content)
				.some(
					(p: unknown) => p.type === "tool_result" && p.tool_use_id === "sole",
				),
		).toBe(true);
	} finally {
		db.close();
	}
});
