import { expect, test } from "bun:test";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
	getTagsBySession,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	applyFlushedStatuses,
	applyPendingOperations,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { computePiPressure } from "./pi-pressure";
import { measurePiTailHygiene } from "./tail-hygiene-walk-pi";
import { createTestDb } from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

for (const native of [false, true]) {
	test(`full drops remove old paired wire bytes (${native ? "Responses native" : "Anthropic"})`, async () => {
		const db = createTestDb();
		try {
			const session = `overwall-${native}`;
			const source = Array.from({ length: 25 }, (_, i) => {
				const callId = `call_${i}`;
				const itemId = `fc_${i}`;
				const id = native ? `${callId}|${itemId}` : callId;
				return [
					{
						role: "assistant",
						timestamp: i * 2,
						content: [
							...(native
								? [{ type: "thinking", thinking: "retained reasoning" }]
								: []),
							{
								type: "toolCall",
								id,
								name: "read",
								arguments: { path: `original-${i}` },
							},
						],
						...(native
							? {
									providerPayload: {
										type: "openaiResponsesHistory",
										items: [
											{
												type: "function_call",
												id: itemId,
												call_id: callId,
												name: "read",
												arguments: JSON.stringify({ path: `original-${i}` }),
											},
										],
									},
								}
							: {}),
					},
					{
						role: "toolResult",
						timestamp: i * 2 + 1,
						toolCallId: id,
						toolName: "read",
						content: [{ type: "text", text: `output-${i}` }],
					},
				];
			}).flat();
			const tagger = createTagger();
			tagger.initFromDb(session, db);
			const serve = (replay: boolean) => {
				const messages = structuredClone(source);
				const transcript = createPiTranscript(messages, session, undefined, {
					preserveReasoningToolArcs: !native,
				});
				const { targets } = tagTranscript(session, transcript, tagger, db);
				if (replay) applyFlushedStatuses(session, db, targets);
				else {
					for (const tag of getTagsBySession(db, session))
						if (tag.type === "tool")
							queuePendingOp(db, session, tag.tagNumber, "drop", Date.now());
					applyPendingOperations(session, db, targets, new Set());
				}
				transcript.commit();
				transcript.finalizeToolRemovals();
				return messages;
			};
			const served = serve(false);
			const calls = served.flatMap((m) =>
				m.role === "assistant"
					? m.content.filter((p) => p.type === "toolCall")
					: [],
			);
			const results = served.filter((m) => m.role === "toolResult");
			expect(calls).toHaveLength(20);
			expect(results).toHaveLength(20);
			expect(calls.map((c) => ("id" in c ? c.id : undefined))).toEqual(
				results.map((r) => ("toolCallId" in r ? r.toolCallId : undefined)),
			);
			const model = {
				id: "test",
				name: "test",
				api: native ? "openai-responses" : "anthropic-messages",
				provider: native ? "openai" : "anthropic",
				baseUrl: "https://invalid.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 272000,
				maxTokens: 1024,
			};
			let wire: unknown;
			if (native)
				wire = convertResponsesMessages(
					model as never,
					{ messages: served } as never,
					new Set(["openai"]),
				);
			else {
				const stream = streamAnthropic(
					model as never,
					{ messages: served } as never,
					{
						apiKey: "fixture-not-a-secret",
						onPayload(payload) {
							wire = payload;
							throw new Error("captured before network");
						},
					},
				);
				await stream.result();
			}
			expect(wire).toBeDefined();
			const wireBytes = JSON.stringify(wire);
			const wireCalls = native
				? (wire as Array<{ type: string; call_id?: string }>)
						.filter((i) => i.type === "function_call")
						.map((i) => i.call_id)
				: (
						wire as {
							messages: Array<{
								content: Array<{ type: string; id?: string }>;
							}>;
						}
					).messages.flatMap((m) =>
						m.content.filter((p) => p.type === "tool_use").map((p) => p.id),
					);
			const wireResults = native
				? (wire as Array<{ type: string; call_id?: string }>)
						.filter((i) => i.type === "function_call_output")
						.map((i) => i.call_id)
				: (
						wire as {
							messages: Array<{
								content: Array<{ type: string; tool_use_id?: string }>;
							}>;
						}
					).messages.flatMap((m) =>
						m.content
							.filter((p) => p.type === "tool_result")
							.map((p) => p.tool_use_id),
					);
			expect(wireCalls).toHaveLength(20);
			expect(wireResults).toEqual(wireCalls);
			for (let i = 0; i < 5; i++) expect(wireBytes).not.toContain(`call_${i}"`);
			const bytes = JSON.stringify(served);
			for (let i = 0; i < 5; i++) expect(bytes).not.toContain(`call_${i}"`);
			if (native) {
				const items = served.flatMap((m) =>
					"providerPayload" in m ? (m.providerPayload?.items ?? []) : [],
				);
				expect(
					items.filter((i) => i.type === "function_call").map((i) => i.call_id),
				).toEqual(Array.from({ length: 20 }, (_, i) => `call_${i + 5}`));
			}
			expect(JSON.stringify(serve(true))).toBe(bytes);
		} finally {
			db.close();
		}
	});
}

test("above-wall provider usage is rejected instead of clamped into pressure", () => {
	expect(computePiPressure({ input: 380687 }, 204000, 272000)).toBeNull();
});

test("hygiene counts served skeleton bytes in T but never in U", () => {
	const measured = measurePiTailHygiene({
		messages: [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c",
						name: "read",
						arguments: { dropped: "[dropped §1§]" },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "c",
				content: [{ type: "text", text: "[dropped §1§]" }],
			},
		],
		tags: [],
		protectedTagNumbers: new Set(),
	});
	expect(measured.t).toBeGreaterThan(0);
	expect(measured.u).toBe(0);
});

test("rejected usage leaves overflow recovery to the explicit recovery pressure latch", async () => {
	const { persistPiPressureFromMessageEnd } = await import("./index");
	const { getOrCreateSessionMeta, updateSessionMeta } = await import(
		"@magic-context/core/features/magic-context/storage"
	);
	const { getOverflowState } = await import(
		"@magic-context/core/features/magic-context/storage-meta-persisted"
	);
	const { createScheduler } = await import(
		"@magic-context/core/features/magic-context/scheduler"
	);
	const { resolvePiPressureSnapshot } = await import("./pi-pressure");
	const db = createTestDb();
	const sessionId = "bounded-pressure-proof";
	try {
		updateSessionMeta(db, sessionId, {
			observedSafeInputTokens: 140000,
			lastInputTokens: 1000,
			lastContextPercentage: 0.5,
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
		expect(meta.lastUsageContextLimit).toBe(204000);
		expect(meta.observedSafeInputTokens).toBe(140000);
		expect(
			getOverflowState(db, sessionId).detectedContextLimit,
		).toBeLessThanOrEqual(272000);
		const pressure = resolvePiPressureSnapshot({
			persistedPercentage: meta.lastContextPercentage,
			persistedInputTokens: meta.lastInputTokens,
			usableContextLimit: meta.lastUsageContextLimit,
			// A genuine overflow error, not rejected usage, arms recovery.
			minimumPercentage: 95,
		});
		expect(pressure.percentage).toBeGreaterThanOrEqual(95);
		expect(
			createScheduler({ executeThresholdPercentage: 90 }).shouldExecute(
				meta,
				pressure,
			),
		).toBe("execute");
	} finally {
		db.close();
	}
});

test("structural full drop preserves open arcs and ambiguous native identity", () => {
	for (const complete of [false, true]) {
		const db = createTestDb();
		try {
			const sessionId = `arc-safety-${complete}`;
			const messages: unknown[] = [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call",
							name: "read",
							arguments: { path: "keep" },
						},
					],
					providerPayload: {
						type: "openaiResponsesHistory",
						items: [
							{
								type: "function_call",
								call_id: "call",
								id: "a",
								arguments: "{}",
							},
							{
								type: "function_call",
								call_id: "call",
								id: "b",
								arguments: "{}",
							},
						],
					},
				},
			];
			if (complete)
				messages.push({
					role: "toolResult",
					toolCallId: "call",
					content: [{ type: "text", text: "result" }],
				});
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const transcript = createPiTranscript(messages, sessionId);
			const { targets } = tagTranscript(sessionId, transcript, tagger, db);
			const target = [...targets.values()][0];
			expect(target.canDrop?.()).toBe(complete);
			expect(target.drop?.()).toBe(complete ? "removed" : "incomplete");
			transcript.commit();
			transcript.finalizeToolRemovals();
			expect(messages).toHaveLength(complete ? 2 : 1);
			expect(JSON.stringify(messages)).toContain('"type":"toolCall"');
		} finally {
			db.close();
		}
	}
});
