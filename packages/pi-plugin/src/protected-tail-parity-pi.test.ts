/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import {
	buildToolArcs,
	buildTrueRawTokenIndex,
} from "@magic-context/core/hooks/magic-context/read-session-true-raw-tokens";

describe("Pi protected-tail true-raw parity", () => {
	test("matches OpenCode text and tool-I/O totals for folded Pi shape", () => {
		const opencode: RawMessage[] = [
			{
				ordinal: 1,
				id: "u1",
				role: "user",
				parts: [{ type: "text", text: "please inspect" }],
			},
			{
				ordinal: 2,
				id: "a1",
				role: "assistant",
				parts: [
					{
						type: "tool",
						callID: "read:1",
						tool: "read",
						state: { input: { file: "a.ts" } },
					},
				],
			},
			{
				ordinal: 3,
				id: "u2",
				role: "user",
				parts: [
					{
						type: "tool",
						callID: "read:1",
						tool: "read",
						state: { output: "const a = 1;" },
					},
				],
			},
		];
		const piFolded: RawMessage[] = [
			{
				ordinal: 1,
				id: "u1",
				role: "user",
				parts: [{ type: "text", text: "please inspect" }],
			},
			{
				ordinal: 2,
				id: "a1",
				role: "assistant",
				parts: [
					{
						type: "tool",
						callID: "read:1",
						tool: "read",
						state: { input: { file: "a.ts" } },
					},
				],
			},
			{
				ordinal: 3,
				id: "synth-user-read-1",
				role: "user",
				parts: [
					{
						type: "tool",
						callID: "read:1",
						tool: "read",
						state: { output: "const a = 1;" },
					},
				],
			},
		];

		const ocIndex = buildTrueRawTokenIndex("ses-oc", opencode, {
			providerShapeVersion: "opencode-v1",
			cacheNamespace: "test:oc",
		});
		const piIndex = buildTrueRawTokenIndex("ses-pi", piFolded, {
			providerShapeVersion: "pi-folded-v1",
			cacheNamespace: "test:pi",
		});

		expect(piIndex.rangeTokens(1, 4)).toBe(ocIndex.rangeTokens(1, 4));
		expect(buildToolArcs(piFolded)).toEqual([
			{ callId: "read:1", invOrdinal: 2, resOrdinal: 3 },
		]);
	});

	test("documents Pi thinking/image undercount as an intentional provider-shape divergence", () => {
		const opencode: RawMessage[] = [
			{
				ordinal: 1,
				id: "a-thinking",
				role: "assistant",
				parts: [
					{ type: "thinking", thinking: "private chain of thought" },
					{ type: "image", width: 1024, height: 768 },
				],
			},
		];
		const piFolded: RawMessage[] = [
			{ ordinal: 1, id: "a-thinking", role: "assistant", parts: [] },
		];

		const ocTotal = buildTrueRawTokenIndex("ses-oc-divergence", opencode, {
			providerShapeVersion: "opencode-v1",
			cacheNamespace: "test:oc-divergence",
		}).rangeTokens(1, 2);
		const piTotal = buildTrueRawTokenIndex("ses-pi-divergence", piFolded, {
			providerShapeVersion: "pi-folded-v1",
			cacheNamespace: "test:pi-divergence",
		}).rangeTokens(1, 2);

		expect(piTotal).toBeLessThan(ocTotal);
	});
});

import {
	hasRunnableCompartmentWindow,
	type ProtectedTailBoundarySnapshot,
	resolveProtectedTailBoundary,
} from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import {
	readSessionChunk,
	withRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { computeRawRangeFingerprint } from "@magic-context/core/hooks/magic-context/read-session-true-raw-tokens";
import { selectPiHistorianRunBoundarySnapshot } from "./context-handler";
import { convertEntriesToRawMessages } from "./read-session-pi";

test("Pi 473-message edge waits rather than scheduling the split 299-299 chunk", () => {
	const entries = Array.from({ length: 473 }, (_, index) => {
		const ordinal = index + 1;
		return {
			type: "message",
			id: `m${ordinal}`,
			message: {
				role: ordinal === 1 || ordinal === 300 ? "user" : "assistant",
				content: [{ type: "text", text: `Session message ${ordinal}` }],
			} as Record<string, unknown>,
		};
	});
	for (const [invocation, result, id] of [
		[298, 301, "outer"],
		[299, 303, "inner"],
	] as const) {
		entries[invocation - 1].message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id,
					name: "bash",
					arguments: { command: "inspect history" },
				},
			],
		};
		entries[result - 1].message = {
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: "inspection finished" }],
		};
	}
	const messages = convertEntriesToRawMessages(entries);
	expect(messages).toHaveLength(473);
	const sessionId = "ses-pi-edge-299";
	withRawMessageProvider(sessionId, { readMessages: () => messages }, () => {
		const resolve = (percentage: number) =>
			resolveProtectedTailBoundary({
				sessionId,
				mode: "pi-trigger",
				contextLimit: 204_000,
				executeThresholdPercentage: 90,
				triggerBudget: 20_000,
				usage: { percentage, inputTokens: 180_138 },
				usageSource: "live",
				lastCompartmentEndOrdinal: 298,
				priorBoundaryOrdinal: 299,
				protectedTailPolicyVersion: 3,
				migrationFloorActive: false,
				providerShapeVersion: "pi-folded-v1",
				cacheNamespace: sessionId,
				storedTokenTotals: new Map(
					messages.map((message) => [
						message.id,
						message.ordinal === 299 ? 258 : 400,
					]),
				),
			});
		const boundary = resolve(88.3);
		expect(boundary.offset).toBe(299);
		expect(boundary.protectedTailStart).toBe(299);
		expect(boundary.eligibleEndOrdinal).toBe(299);
		expect(hasRunnableCompartmentWindow(boundary)).toBe(false);
		expect(
			readSessionChunk(sessionId, 20_000, 299, boundary.eligibleEndOrdinal)
				.messageCount,
		).toBe(0);
		// More pressure lifts the live-prompt floor and permits the whole completed component.
		const later = resolve(95);
		expect(later.eligibleEndOrdinal).toBeGreaterThan(303);
		expect(hasRunnableCompartmentWindow(later)).toBe(true);
	});
});

test("protected-tail fingerprints are content-stable: metadata-only drift matches, content drift does not", () => {
	// The fingerprint deliberately hashes ONLY content-bearing fields (text /
	// tool input+output lengths), not entry timestamps or version metadata.
	// The same logical message is observed through different views — Pi's
	// getBranch() entries, OpenCode DB rows, and OpenCode's in-memory
	// args.messages (which carries no timestamps) — and a snapshot computed
	// from one view must revalidate against another. Metadata sensitivity
	// would falsely reject every cross-view snapshot as stale. Content edits
	// still change the fingerprint, which is the staleness that matters for
	// the historian's chunk.
	const entry = (timestamp: number, text: string) => [
		{
			type: "message",
			id: "tool-result-1",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text }],
			},
		},
	];

	// Metadata-only drift (timestamp bump, same content) → SAME fingerprint.
	expect(
		computeRawRangeFingerprint(
			convertEntriesToRawMessages(entry(10, "short")),
			1,
			2,
		),
	).toBe(
		computeRawRangeFingerprint(
			convertEntriesToRawMessages(entry(11, "short")),
			1,
			2,
		),
	);

	// Content drift (output text changed) → DIFFERENT fingerprint.
	expect(
		computeRawRangeFingerprint(
			convertEntriesToRawMessages(entry(10, "short")),
			1,
			2,
		),
	).not.toBe(
		computeRawRangeFingerprint(
			convertEntriesToRawMessages(entry(10, "short but longer now")),
			1,
			2,
		),
	);
});

test("Pi historian runner uses the trigger boundary snapshot when the trigger re-resolves", () => {
	const resolved = {
		sessionId: "ses-pi-pre-trigger",
		mode: "pi-trigger",
		offset: 1,
		offsetMessageId: "m1",
		protectedTailStart: 40,
		protectedTailStartMessageId: "m40",
		eligibleEndOrdinal: 40,
		eligibleEndMessageId: "m39",
		rawMessageCountAtTrigger: 50,
		rawLastMessageIdAtTrigger: "m50",
		N: 4000,
		usagePercentage: 80,
		usageInputTokens: 160_000,
		usageSource: "live",
		contextLimit: 200_000,
		executeThresholdPercentage: 65,
		triggerBudget: 10_000,
		priorBoundaryOrdinal: 40,
		migrationFloorActive: false,
		providerShapeVersion: "pi-folded-v1",
		cacheNamespace: "pi:ses-pi-pre-trigger",
		createdAt: 1,
		rawRangeFingerprint: "",
		trueRawEligibleTokens: 20_000,
		oversizeAtomicUnit: false,
		boundaryReason: "primary",
	} satisfies ProtectedTailBoundarySnapshot;
	const triggerResolved = {
		...resolved,
		mode: "trigger",
		protectedTailStart: 20,
		emergencyTailScale: 0.5,
		boundaryReason: "force_band_scaled",
	} satisfies ProtectedTailBoundarySnapshot;

	expect(
		selectPiHistorianRunBoundarySnapshot({
			resolvedBoundarySnapshot: resolved,
			triggerBoundarySnapshot: triggerResolved,
		}),
	).toBe(triggerResolved);
	expect(
		selectPiHistorianRunBoundarySnapshot({
			resolvedBoundarySnapshot: resolved,
		}),
	).toBe(resolved);
});
