import { describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeProtectionWindow } from "@magic-context/core/features/magic-context/protection-window";
import {
	getChannel2NudgeState,
	setChannel2NudgeState,
} from "@magic-context/core/features/magic-context/storage";
import type { TagEntry } from "@magic-context/core/features/magic-context/types";
import {
	rearmChannel2AfterCoverageAdvancingHardFold,
	rearmChannel2AfterMeasuredCollapse,
} from "@magic-context/core/hooks/magic-context/channel2-cycle";
import {
	buildChannel1Reminder,
	decideChannel1,
	evaluateChannel2,
} from "@magic-context/core/hooks/magic-context/ctx-reduce-nudge";
import * as formattingModule from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { PI_CTX_REDUCE_KEEP } from "./heuristic-cleanup-pi";
import {
	__test,
	assertPiTailHygieneContentUnchanged,
	clearPiTailHygieneContentMemo,
	effectivePiTailHygiene,
	measurePiTailHygiene,
	refreshPiTailHygieneBaseline,
} from "./tail-hygiene-walk-pi";
import { createTestDb } from "./test-utils.test";

function tag(
	tagNumber: number,
	messageId: string,
	type: TagEntry["type"],
	overrides: Partial<TagEntry> = {},
): TagEntry {
	return {
		tagNumber,
		messageId,
		type,
		status: "active",
		dropMode: "full",
		toolName: type === "tool" ? "read" : null,
		inputByteSize: 0,
		byteSize: 1,
		reasoningByteSize: 0,
		sessionId: "pi-hygiene",
		cavemanDepth: 0,
		toolOwnerMessageId: type === "tool" ? "owner" : null,
		...overrides,
	};
}

function withStableIds(messages: object[], ids: string[]) {
	const byRef = new Map<object, string>();
	messages.forEach((message, index) => {
		byRef.set(message, ids[index] ?? `m-${index}`);
	});
	return (message: unknown): string | undefined =>
		message && typeof message === "object" ? byRef.get(message) : undefined;
}

function textMessage(
	role: "user" | "assistant",
	text: string,
): Record<string, unknown> {
	return { role, content: [{ type: "text", text }] };
}

function toolArc(
	ownerId: string,
	callId: string,
	toolName: string,
	input: unknown,
	output: string,
): {
	messages: object[];
	stableId: (message: unknown) => string | undefined;
	tag: TagEntry;
} {
	const messages = [
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: callId, name: toolName, arguments: input },
			],
		},
		{
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content: [{ type: "text", text: output }],
		},
	];
	return {
		messages,
		stableId: withStableIds(messages, [ownerId, `${ownerId}-result`]),
		tag: tag(1, callId, "tool", { toolName, toolOwnerMessageId: ownerId }),
	};
}

function measuredBand(u: number, t: number): string {
	const baseline = {
		baselineU: u,
		baselineT: t,
		turnDeltaU: 0,
		turnDeltaT: 0,
		evaluable: true,
		generationInvalidated: false,
	};
	if (evaluateChannel2(baseline).shouldTrigger) return "channel2";
	const channel1 = decideChannel1({
		...baseline,
		lastNudgeUndropped: 0,
		lastNudgeLevel: "",
		hasRecentReduce: false,
	});
	return channel1.fire ? channel1.level : "quiet";
}

describe("Pi rendered-tail hygiene walk", () => {
	it("calibrates the Fable tool-only hygiene floors and reminder figures", () => {
		const tokenizer = spyOn(
			formattingModule,
			"estimateTokens",
		).mockImplementation((content) =>
			content.startsWith("fable-output-") ? 10_000 : 0,
		);
		// The walk memoizes token counts process-wide. Another test file in the same
		// process can cache the real count for the same content (`{}` tool input),
		// which would bypass this stub.
		clearPiTailHygieneContentMemo();
		try {
			const messages: object[] = [];
			const ids: string[] = [];
			const tags: TagEntry[] = [];
			for (let number = 1; number <= 4; number += 1) {
				const owner = `fable-owner-${number}`;
				const callId = `fable-call-${number}`;
				messages.push(
					{
						role: "assistant",
						content: [
							{ type: "toolCall", id: callId, name: "read", arguments: {} },
						],
					},
					{
						role: "toolResult",
						toolCallId: callId,
						toolName: "read",
						content: [{ type: "text", text: `fable-output-${number}` }],
					},
				);
				ids.push(owner, `${owner}-result`);
				tags.push(tag(number, callId, "tool", { toolOwnerMessageId: owner }));
			}
			const baseline = refreshPiTailHygieneBaseline({
				messages,
				tags,
				protectedTagNumbers: new Set([3, 4]),
				stableId: withStableIds(messages, ids),
				cacheBusting: true,
				calibration: { toolsRatio: 1.551639, proseRatio: 1.571778 },
				hygieneUnitsVersion: 2,
			});
			const effective = effectivePiTailHygiene(baseline);
			const decision = decideChannel1({
				...baseline,
				lastNudgeUndropped: 0,
				lastNudgeLevel: "",
				hasRecentReduce: false,
			});

			expect(effective).toEqual({ u: 31_033, t: 62_066 });
			expect(decision).toMatchObject({
				fire: true,
				band: "firm",
				level: "firm",
			});
			expect(buildChannel1Reminder("firm", effective.u, 4)).toContain(
				"4 spent tool outputs (~31k tokens)",
			);
		} finally {
			tokenizer.mockRestore();
		}
	});

	it("excludes thinking, redacted reasoning, and every signature field", () => {
		const base = [textMessage("assistant", "visible work ".repeat(2_000))];
		const withReasoning = [
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: "visible work ".repeat(2_000),
						textSignature: "signed text ".repeat(20_000),
					},
					{
						type: "thinking",
						thinking: "private chain ".repeat(50_000),
						thinkingSignature: "signed thought ".repeat(20_000),
					},
					{ type: "redacted_thinking", data: "opaque".repeat(50_000) },
				],
			},
		];
		const tags = [tag(1, "answer:p0", "message")];
		const expected = measurePiTailHygiene({
			messages: base,
			tags,
			protectedTagNumbers: new Set(),
			stableId: withStableIds(base, ["answer"]),
		});
		const actual = measurePiTailHygiene({
			messages: withReasoning,
			tags,
			protectedTagNumbers: new Set(),
			stableId: withStableIds(withReasoning, ["answer"]),
		});
		expect({ u: actual.u, t: actual.t }).toEqual({
			u: expected.u,
			t: expected.t,
		});
	});

	it("counts surviving dropped arcs in T without advertising their bytes in U", () => {
		const live = toolArc(
			"owner",
			"call",
			"read",
			{ path: "large" },
			"result ".repeat(5_000),
		);
		const dropped = toolArc(
			"owner",
			"call",
			"read",
			{ path: "large" },
			"[dropped §1§]",
		);
		const staleDroppedRow = { ...dropped.tag, status: "dropped" as const };
		const liveWithStaleStatus = measurePiTailHygiene({
			messages: live.messages,
			tags: [staleDroppedRow],
			protectedTagNumbers: new Set(),
			stableId: live.stableId,
		});
		const droppedMeasured = measurePiTailHygiene({
			messages: dropped.messages,
			tags: [dropped.tag],
			protectedTagNumbers: new Set(),
			stableId: dropped.stableId,
		});
		expect(liveWithStaleStatus.u).toBe(0);
		expect(liveWithStaleStatus.t).toBeGreaterThan(0);
		expect(droppedMeasured.u).toBe(0);
		expect(droppedMeasured.t).toBeGreaterThan(0);
	});

	it("keeps the recency reserve and newest three ctx_reduce exemplars out of U", () => {
		const messages: object[] = [];
		const ids: string[] = [];
		const tags: TagEntry[] = [];
		for (let index = 1; index <= 4; index += 1) {
			const arc = toolArc(
				`reduce-owner-${index}`,
				`reduce-${index}`,
				"ctx_reduce",
				{ drop: index },
				`reduced ${index}`,
			);
			messages.push(...arc.messages);
			ids.push(`reduce-owner-${index}`, `reduce-result-${index}`);
			tags.push({ ...arc.tag, tagNumber: index });
		}
		const measured = measurePiTailHygiene({
			messages,
			tags,
			protectedTagNumbers: new Set([4]),
			stableId: withStableIds(messages, ids),
		});
		const protectedNumbers = new Set(
			measured.parts
				.filter((part) => part.protected)
				.map((part) => part.tagNumber),
		);
		expect(PI_CTX_REDUCE_KEEP).toBe(3);
		expect(protectedNumbers).toEqual(new Set([2, 3, 4]));
		expect(
			measured.parts
				.filter((part) => part.tagNumber === 1)
				.every((part) => part.uTokens > 0),
		).toBe(true);
		expect(
			measured.parts
				.filter((part) => (part.tagNumber ?? 0) >= 2)
				.every((part) => part.uTokens === 0),
		).toBe(true);
	});

	it("handles empty, all-synthetic, untagged, and all-protected degenerates", () => {
		expect(
			measurePiTailHygiene({
				messages: [],
				tags: [],
				protectedTagNumbers: new Set(),
			}),
		).toMatchObject({
			u: 0,
			t: 0,
		});
		const synthetic = [textMessage("user", "m0 ".repeat(50_000))];
		expect(
			measurePiTailHygiene({
				messages: synthetic,
				tags: [tag(1, "m0:p0", "message")],
				protectedTagNumbers: new Set(),
				stableId: withStableIds(synthetic, ["m0"]),
				syntheticLeadingCount: 1,
			}),
		).toMatchObject({ u: 0, t: 0 });
		const untagged = [textMessage("user", "visible")];
		expect(
			measurePiTailHygiene({
				messages: untagged,
				tags: [],
				protectedTagNumbers: new Set(),
				stableId: withStableIds(untagged, ["untagged"]),
			}),
		).toMatchObject({ u: 0 });
		const protectedMessage = [textMessage("user", "protected ".repeat(1_000))];
		const protectedMeasured = measurePiTailHygiene({
			messages: protectedMessage,
			tags: [tag(1, "protected:p0", "message")],
			protectedTagNumbers: new Set([1]),
			stableId: withStableIds(protectedMessage, ["protected"]),
		});
		expect(protectedMeasured.u).toBe(0);
		expect(protectedMeasured.t).toBeGreaterThan(0);
		expect(protectedMeasured.u).toBeLessThanOrEqual(protectedMeasured.t);
	});

	it("enforces MIN_T on measurements from Pi entries", () => {
		const underMessages = [textMessage("user", "token ".repeat(59_000))];
		const overMessages = [textMessage("user", "token ".repeat(61_000))];
		const tags = [tag(1, "tail:p0", "message")];
		const under = measurePiTailHygiene({
			messages: underMessages,
			tags,
			protectedTagNumbers: new Set(),
			stableId: withStableIds(underMessages, ["tail"]),
		});
		const over = measurePiTailHygiene({
			messages: overMessages,
			tags,
			protectedTagNumbers: new Set(),
			stableId: withStableIds(overMessages, ["tail"]),
		});
		expect(under.t).toBeLessThan(60_000);
		expect(over.t).toBeGreaterThan(60_000);
		expect(
			decideChannel1({
				baselineU: under.u,
				baselineT: under.t,
				turnDeltaU: 0,
				turnDeltaT: 0,
				lastNudgeUndropped: 0,
				lastNudgeLevel: "",
				hasRecentReduce: false,
			}).fire,
		).toBe(false);
		expect(
			decideChannel1({
				baselineU: over.u,
				baselineT: over.t,
				turnDeltaU: 0,
				turnDeltaT: 0,
				lastNudgeUndropped: 0,
				lastNudgeLevel: "",
				hasRecentReduce: false,
			}).fire,
		).toBe(true);
	});
});

describe("Pi baseline persistence and defer deltas", () => {
	it("subtracts queued-drop mass through the defer delta without changing T or the frozen baseline", () => {
		const messages = [
			textMessage("user", "mass ".repeat(25_000)),
			textMessage("user", "mass ".repeat(45_000)),
			textMessage("user", "mass ".repeat(30_000)),
		];
		const tags = [
			tag(1, "queued:p0", "message"),
			tag(2, "remaining:p0", "message"),
		];
		const stableId = withStableIds(messages, [
			"queued",
			"remaining",
			"untagged",
		]);
		const initial = measurePiTailHygiene({
			messages,
			tags,
			protectedTagNumbers: new Set(),
			stableId,
		});
		const queuedMass = measurePiTailHygiene({
			messages: [messages[0]],
			tags: [tags[0]],
			protectedTagNumbers: new Set(),
			stableId: withStableIds([messages[0]], ["queued"]),
		}).u;
		const baseline = refreshPiTailHygieneBaseline({
			messages,
			tags,
			protectedTagNumbers: new Set(),
			stableId,
			cacheBusting: true,
		});
		const queued = measurePiTailHygiene({
			messages,
			tags,
			protectedTagNumbers: new Set(),
			pendingDropTagNumbers: new Set([1]),
			stableId,
		});
		const defer = refreshPiTailHygieneBaseline({
			messages,
			tags,
			protectedTagNumbers: new Set(),
			pendingDropTagNumbers: new Set([1]),
			stableId,
			cacheBusting: false,
			previous: baseline,
		});

		expect(queued.t).toBe(initial.t);
		expect(queued.u).toBe(initial.u - queuedMass);
		expect(defer.evaluable).toBe(true);
		expect(defer.baselineU).toBe(baseline.baselineU);
		expect(defer.baselineT).toBe(baseline.baselineT);
		expect(effectivePiTailHygiene(defer)).toEqual({ u: queued.u, t: queued.t });
		expect(
			decideChannel1({
				...baseline,
				lastNudgeUndropped: 0,
				lastNudgeLevel: "",
				hasRecentReduce: false,
			}).level,
		).toBe("urgent");
		expect(
			decideChannel1({
				...defer,
				lastNudgeUndropped: 0,
				lastNudgeLevel: "",
				hasRecentReduce: false,
			}).level,
		).toBe("firm");
	});

	it("is deterministic across bust/defer and adds every typed append", () => {
		const base = [textMessage("user", "base ".repeat(2_000))];
		const baseTags = [tag(1, "base:p0", "message")];
		const bust = refreshPiTailHygieneBaseline({
			messages: base,
			tags: baseTags,
			protectedTagNumbers: new Set([1]),
			stableId: withStableIds(base, ["base"]),
			cacheBusting: true,
			now: 10,
		});
		const unchanged = refreshPiTailHygieneBaseline({
			messages: base,
			tags: baseTags,
			protectedTagNumbers: new Set([1]),
			stableId: withStableIds(base, ["base"]),
			cacheBusting: false,
			previous: bust,
			now: 20,
		});
		expect(effectivePiTailHygiene(unchanged)).toEqual(
			effectivePiTailHygiene(bust),
		);
		expect(unchanged.baselineGeneration).toBe(bust.baselineGeneration);

		const user = textMessage("user", "new user ".repeat(1_000));
		const assistant = textMessage("assistant", "new assistant ".repeat(1_000));
		const image = {
			role: "user",
			content: [
				{
					type: "image",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
					mimeType: "image/png",
				},
			],
		};
		const tool = toolArc(
			"tool-owner",
			"call-delta",
			"read",
			{ path: "new" },
			"output ".repeat(1_000),
		);
		const messages = [...base, user, assistant, image, ...tool.messages];
		const tags = [
			...baseTags,
			tag(2, "user:p0", "message"),
			tag(3, "assistant:p0", "message"),
			tag(4, "image:file0", "file"),
			{ ...tool.tag, tagNumber: 5 },
		];
		const defer = refreshPiTailHygieneBaseline({
			messages,
			tags,
			protectedTagNumbers: new Set([5]),
			stableId: withStableIds(messages, [
				"base",
				"user",
				"assistant",
				"image",
				"tool-owner",
				"tool-result",
			]),
			cacheBusting: false,
			previous: bust,
		});
		expect(defer.evaluable).toBe(true);
		expect(defer.turnDeltaT).toBeGreaterThan(0);
		expect(defer.turnDeltaU).toBeGreaterThan(0);
		expect(effectivePiTailHygiene(defer).u).toBeLessThanOrEqual(
			effectivePiTailHygiene(defer).t,
		);
	});

	it("counts an appended tool output after it ages out of the protected suffix", () => {
		const baseMessages = [textMessage("user", "base text")];
		const baseTags = [tag(1, "base:p0", "message")];
		const reminder =
			"\n\n<system-reminder>\nHousekeeping backlog: spent tool outputs are reclaimable.\n</system-reminder>";
		const appended = toolArc(
			"tool-delta",
			"call-delta",
			"read",
			{ path: "new" },
			`${"reclaimable tool output ".repeat(1_000)}${reminder}`,
		);
		const messages = [...baseMessages, ...appended.messages];
		const tags = [...baseTags, { ...appended.tag, tagNumber: 2 }];
		const stableId = withStableIds(messages, [
			"base",
			"tool-delta",
			"tool-delta-result",
		]);
		const sha256 = (value: unknown): string =>
			createHash("sha256").update(JSON.stringify(value)).digest("hex");
		const prefixSha = sha256(baseMessages);
		const servedArraySha = sha256(messages);
		const baseline = refreshPiTailHygieneBaseline({
			messages: baseMessages,
			tags: baseTags,
			protectedTagNumbers: new Set([1]),
			stableId: withStableIds(baseMessages, ["base"]),
			cacheBusting: true,
		});
		const protectedDefer = refreshPiTailHygieneBaseline({
			messages,
			tags,
			protectedTagNumbers: new Set([1, 2]),
			stableId,
			cacheBusting: false,
			previous: baseline,
		});
		const agedDefer = refreshPiTailHygieneBaseline({
			messages,
			tags,
			protectedTagNumbers: new Set([1]),
			stableId,
			cacheBusting: false,
			previous: protectedDefer,
		});
		const measuredAged = measurePiTailHygiene({
			messages,
			tags,
			protectedTagNumbers: new Set([1]),
			stableId,
		});

		expect(effectivePiTailHygiene(protectedDefer).u).toBe(0);
		expect(effectivePiTailHygiene(agedDefer)).toEqual({
			u: measuredAged.u,
			t: measuredAged.t,
		});
		expect(sha256(baseMessages)).toBe(prefixSha);
		expect(sha256(messages)).toBe(servedArraySha);
		expect(JSON.stringify(baseMessages)).not.toContain("Housekeeping backlog");
		expect(JSON.stringify(messages.at(-1))).toContain("Housekeeping backlog");
	});

	it("advances the protection boundary additively without changing generation", () => {
		const before = [
			textMessage("user", "old mass ".repeat(2_000)),
			textMessage("assistant", "recent mass ".repeat(2_000)),
		];
		const beforeTags = [
			tag(1, "old:p0", "message"),
			tag(2, "recent:p0", "message"),
		];
		const baseline = refreshPiTailHygieneBaseline({
			messages: before,
			tags: beforeTags,
			protectedTagNumbers: new Set([1, 2]),
			stableId: withStableIds(before, ["old", "recent"]),
			cacheBusting: true,
		});
		const oldMass = measurePiTailHygiene({
			messages: [before[0]],
			tags: [beforeTags[0]],
			protectedTagNumbers: new Set(),
			stableId: withStableIds([before[0]], ["old"]),
		}).t;
		const newest = textMessage("user", "newest mass ".repeat(2_000));
		const messages = [...before, newest];
		const defer = refreshPiTailHygieneBaseline({
			messages,
			tags: [...beforeTags, tag(3, "newest:p0", "message")],
			protectedTagNumbers: new Set([2, 3]),
			stableId: withStableIds(messages, ["old", "recent", "newest"]),
			cacheBusting: false,
			previous: baseline,
		});
		expect(baseline.baselineU).toBe(0);
		expect(defer.turnDeltaU).toBe(oldMass);
		expect(defer.evaluable).toBe(true);
		expect(defer.baselineGeneration).toBe(baseline.baselineGeneration);
	});

	it("re-measures a prior-part mutation on the defer pass that finds it", () => {
		// The newest message is never frozen, so the mutated message needs one after
		// it to land inside the frozen prefix that a defer pass compares.
		const newest = textMessage("assistant", "newest turn");
		const original = [textMessage("user", "original"), newest];
		const changed = [textMessage("user", "changed and then some"), newest];
		const tags = [tag(1, "m:p0", "message")];
		const ids = ["m", "newest"];
		const baseline = refreshPiTailHygieneBaseline({
			messages: original,
			tags,
			protectedTagNumbers: new Set(),
			stableId: withStableIds(original, ids),
			cacheBusting: true,
		});
		const remeasured = refreshPiTailHygieneBaseline({
			messages: changed,
			tags,
			protectedTagNumbers: new Set(),
			stableId: withStableIds(changed, ids),
			cacheBusting: false,
			previous: baseline,
		});
		const measured = measurePiTailHygiene({
			messages: changed,
			tags,
			protectedTagNumbers: new Set(),
			stableId: withStableIds(changed, ids),
		});
		// Named, then measured on this same pass rather than held until a bust.
		expect(remeasured.lastPrefixMismatch).toMatchObject({
			partIndex: 0,
			messageId: "m",
			field: "contentHash",
		});
		expect(remeasured.evaluable).toBe(true);
		expect(remeasured.generationInvalidated).toBe(false);
		expect(remeasured.baselineGeneration).toBe(baseline.baselineGeneration + 1);
		expect(evaluateChannel2(remeasured).evaluable).toBe(true);
		expect(effectivePiTailHygiene(remeasured)).toEqual({
			u: measured.u,
			t: measured.t,
		});
		const steady = refreshPiTailHygieneBaseline({
			messages: changed,
			tags,
			protectedTagNumbers: new Set(),
			stableId: withStableIds(changed, ids),
			cacheBusting: false,
			previous: remeasured,
		});
		// One invalidation event, one diagnostic.
		expect(steady.lastPrefixMismatch).toBeUndefined();
		expect(steady.baselineGeneration).toBe(remeasured.baselineGeneration);
	});

	it("fires Channel 1 inside a long defer window after a mid-window mismatch", () => {
		const narration = {
			type: "text",
			text: `${"narration text ".repeat(9_000)}\n\n`,
		};
		const messages: object[] = [
			textMessage("user", "prompt text ".repeat(9_000)),
			{ role: "assistant", content: [narration] },
		];
		const ids = ["prompt", "narration"];
		const tags: TagEntry[] = [];
		let arcs = 0;
		const appendArc = (): void => {
			arcs += 1;
			const callId = `call-${arcs}`;
			messages.push(
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: callId,
							name: "read",
							arguments: { path: `file-${arcs}` },
						},
					],
				},
				{
					role: "toolResult",
					toolCallId: callId,
					toolName: "read",
					content: [
						{
							type: "text",
							text: `${"tool output row ".repeat(4_400)}${arcs}`,
						},
					],
				},
			);
			ids.push(`arc-${arcs}`, `arc-${arcs}-result`);
			tags.push(
				tag(arcs, callId, "tool", {
					toolName: "read",
					toolOwnerMessageId: `arc-${arcs}`,
				}),
			);
		};
		appendArc();
		appendArc();

		let baseline: ReturnType<typeof refreshPiTailHygieneBaseline> | undefined;
		let lastNudgeUndropped = 0;
		let lastNudgeLevel: "" | "gentle" | "firm" | "urgent" = "";
		const reasons: string[] = [];
		const fires: number[] = [];
		const diagnosed: number[] = [];
		for (let pass = 1; pass <= 11; pass += 1) {
			if (pass > 1) appendArc();
			// A historical assistant part loses its trailing blank line after it was
			// already measured into the frozen prefix.
			if (pass === 3) narration.text = narration.text.replace(/\n\n$/, "");
			baseline = refreshPiTailHygieneBaseline({
				messages,
				tags,
				protectedTagNumbers:
					pass < 3
						? new Set(tags.map((entry) => entry.tagNumber))
						: new Set([arcs]),
				stableId: withStableIds(messages, ids),
				cacheBusting: pass === 1,
				previous: baseline,
			});
			const decision = decideChannel1({
				...baseline,
				lastNudgeUndropped,
				lastNudgeLevel,
				hasRecentReduce: false,
			});
			lastNudgeUndropped = decision.nextLastNudge;
			lastNudgeLevel = decision.nextLastNudgeLevel;
			reasons.push(decision.verdictReason);
			if (decision.fire) fires.push(pass);
			if (baseline.lastPrefixMismatch) diagnosed.push(pass);
		}

		expect(reasons.slice(0, 2)).toEqual([
			"reclaimable-below-floor",
			"reclaimable-below-floor",
		]);
		expect(reasons).not.toContain("baseline-unevaluable");
		expect(fires[0]).toBeGreaterThanOrEqual(3);
		expect(fires[0]).toBeLessThanOrEqual(5);
		expect(diagnosed).toEqual([3]);
	});

	it("detects a byte mutation after the final walk", () => {
		const messages = [textMessage("user", "stable")];
		const stableId = withStableIds(messages, ["m"]);
		const tags = [tag(1, "m:p0", "message")];
		const measured = measurePiTailHygiene({
			messages,
			tags,
			protectedTagNumbers: new Set(),
			stableId,
		});
		(
			(messages[0] as { content: Array<{ text: string }> }).content[0] as {
				text: string;
			}
		).text = "mutated";
		expect(() =>
			assertPiTailHygieneContentUnchanged({
				messages,
				tags,
				protectedTagNumbers: new Set(),
				stableId,
				expectedSignature: measured.contentSignature,
			}),
		).toThrow(/not the last byte-affecting operation/i);
	});
});

describe("Pi Channel-2 tail-cycle cap", () => {
	it("re-arms only for a coverage-advancing HARD fold", () => {
		const db = createTestDb();
		const session = "pi-cap-fold";
		const scenarios = [
			{
				foldExecuted: false,
				compactionOff: false,
				previousCoverage: 1,
				currentCoverage: 2,
			},
			{
				foldExecuted: true,
				compactionOff: true,
				previousCoverage: 1,
				currentCoverage: 2,
			},
			{
				foldExecuted: true,
				compactionOff: false,
				previousCoverage: 2,
				currentCoverage: 2,
			},
		];
		for (const scenario of scenarios) {
			setChannel2NudgeState(db, session, "delivered");
			expect(
				rearmChannel2AfterCoverageAdvancingHardFold({
					db,
					sessionId: session,
					...scenario,
				}),
			).toBe(false);
			expect(getChannel2NudgeState(db, session)).toBe("delivered");
		}
		setChannel2NudgeState(db, session, "delivered");
		expect(
			rearmChannel2AfterCoverageAdvancingHardFold({
				db,
				sessionId: session,
				foldExecuted: true,
				compactionOff: false,
				previousCoverage: 1,
				currentCoverage: 2,
			}),
		).toBe(true);
		expect(getChannel2NudgeState(db, session)).toBe("");
	});

	it("re-arms on measured U collapse but not an invalidated or still-large baseline", () => {
		const db = createTestDb();
		const session = "pi-cap-collapse";
		const baseline = (u: number, evaluable = true) => ({
			baselineU: u,
			baselineT: 100_000,
			turnDeltaU: 0,
			turnDeltaT: 0,
			evaluable,
			generationInvalidated: !evaluable,
		});
		for (const held of [baseline(25_000), baseline(10_000, false)]) {
			setChannel2NudgeState(db, session, "delivered");
			expect(
				rearmChannel2AfterMeasuredCollapse({
					db,
					sessionId: session,
					baseline: held,
					rebuilding: true,
				}),
			).toBe(false);
			expect(getChannel2NudgeState(db, session)).toBe("delivered");
		}
		setChannel2NudgeState(db, session, "delivered");
		expect(
			rearmChannel2AfterMeasuredCollapse({
				db,
				sessionId: session,
				baseline: baseline(24_999),
				rebuilding: true,
			}),
		).toBe(true);
		expect(getChannel2NudgeState(db, session)).toBe("");
	});
});

type FixtureBlock =
	| { type: "text"; unit: string; repeat: number }
	| { type: "reasoning"; unit: string; repeat: number }
	| { type: "tool_call"; id: string; name: string; input: unknown }
	| {
			type: "tool_result";
			id: string;
			name: string;
			unit: string;
			repeat: number;
	  }
	| { type: "file"; mime: string; url: string };
type FixtureMessage = {
	mid: string;
	ordinal: number;
	role: "user" | "assistant";
	synthetic?: boolean;
	blocks: FixtureBlock[];
};
type FixtureTag = {
	tag_number: number;
	block_id: string;
	kind: "message" | "tool" | "file";
	token_count: number;
};
type HygieneFixture = {
	id: string;
	/** Retained as inert migration input; protection derives from the token fields below. */
	protected_tags: number;
	protected_tokens_effective: number;
	messages: FixtureMessage[];
	tags: FixtureTag[];
	pending_drop_tag_numbers?: number[];
	expected: { u: number; t: number; band: string };
};

function adaptFixtureToPi(fixture: HygieneFixture): {
	messages: object[];
	tags: TagEntry[];
	stableId: (message: unknown) => string | undefined;
	syntheticMessages: ReadonlySet<object>;
} {
	const messages: object[] = [];
	const ids: string[] = [];
	const syntheticMessages = new Set<object>();
	for (const message of fixture.messages) {
		for (const block of message.blocks) {
			let adapted: object;
			if (block.type === "tool_result") {
				adapted = {
					role: "toolResult",
					toolCallId: block.id,
					toolName: block.name,
					content: [{ type: "text", text: block.unit.repeat(block.repeat) }],
				};
			} else if (block.type === "reasoning") {
				adapted = {
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: block.unit.repeat(block.repeat),
							thinkingSignature: "fixture-signature",
						},
					],
				};
			} else if (block.type === "tool_call") {
				adapted = {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: block.id,
							name: block.name,
							arguments: block.input,
						},
					],
				};
			} else if (block.type === "file" && block.mime.startsWith("image/")) {
				adapted = {
					role: message.role,
					content: [{ type: "image", data: block.url, mimeType: block.mime }],
				};
			} else {
				const text =
					block.type === "text" ? block.unit.repeat(block.repeat) : block.url;
				adapted = { role: message.role, content: [{ type: "text", text }] };
			}
			messages.push(adapted);
			ids.push(message.mid);
			if (message.synthetic === true) syntheticMessages.add(adapted);
		}
	}
	const ownerByCall = new Map<string, string>();
	for (const message of fixture.messages) {
		for (const block of message.blocks) {
			if (block.type === "tool_call" && !ownerByCall.has(block.id)) {
				ownerByCall.set(block.id, message.mid);
			}
		}
	}
	const messagesByMid = new Map(
		fixture.messages.map((message) => [message.mid, message]),
	);
	const tags = fixture.tags.map((fixtureTag) => {
		const [mid, rawIndex] = fixtureTag.block_id.split("#");
		const partIndex = Number(rawIndex);
		const block = messagesByMid.get(mid ?? "")?.blocks[partIndex];
		const legacyCallId =
			!block && fixtureTag.kind === "tool" ? fixtureTag.block_id : null;
		const callId =
			block?.type === "tool_call" || block?.type === "tool_result"
				? block.id
				: legacyCallId;
		const isTextFile =
			block?.type === "file" && !block.mime.startsWith("image/");
		const messageId =
			fixtureTag.kind === "tool"
				? (callId ?? fixtureTag.block_id)
				: isTextFile
					? `${mid}:p0`
					: `${mid}:${fixtureTag.kind === "file" ? "file" : "p"}${partIndex}`;
		return tag(fixtureTag.tag_number, messageId, fixtureTag.kind, {
			toolName:
				fixtureTag.kind === "tool" &&
				(block?.type === "tool_call" || block?.type === "tool_result")
					? block.name
					: fixtureTag.kind === "tool"
						? "read"
						: null,
			toolOwnerMessageId:
				fixtureTag.kind === "tool" && !legacyCallId && callId
					? (ownerByCall.get(callId) ?? null)
					: null,
		});
	});
	return {
		messages,
		tags,
		stableId: withStableIds(messages, ids),
		syntheticMessages,
	};
}

describe("TS/Pi/module differential hygiene corpus", () => {
	const golden = JSON.parse(
		readFileSync(
			join(
				import.meta.dir,
				"../../plugin/test-fixtures/runtime/nudge-hygiene-golden.json",
			),
			"utf8",
		),
	) as {
		schema: number;
		provenance: { generator_version: string };
		cases: HygieneFixture[];
	};

	it("keeps Pi as the third leg across the full shared corpus", () => {
		expect(golden.schema).toBe(2);
		expect(golden.provenance.generator_version).toBe("nudge-hygiene-ts-v3");
		expect(golden.cases.length).toBeGreaterThanOrEqual(14);
		for (const fixture of golden.cases) {
			const adapted = adaptFixtureToPi(fixture);
			const protectedTagNumbers = computeProtectionWindow(
				fixture.tags,
				fixture.protected_tokens_effective,
			).tagNumberSet.tagNumbers;
			const measured = measurePiTailHygiene({
				...adapted,
				protectedTagNumbers,
				pendingDropTagNumbers: new Set(fixture.pending_drop_tag_numbers ?? []),
			});
			for (const [label, actual, expected] of [
				["U", measured.u, fixture.expected.u],
				["T", measured.t, fixture.expected.t],
			] as const) {
				const tolerance = Math.max(12, Math.ceil(Math.abs(expected) * 0.03));
				expect(
					Math.abs(actual - expected),
					`${fixture.id} ${label}`,
				).toBeLessThanOrEqual(tolerance);
			}
			expect(measuredBand(measured.u, measured.t), `${fixture.id} band`).toBe(
				fixture.expected.band,
			);
			expect(measured.u).toBeLessThanOrEqual(measured.t);
		}
	});
});

describe("Pi image content memoization", () => {
	it("hashes raw and prefixed user/tool images without text-tokenizing their payloads", () => {
		const rawPayload = "A".repeat(3 * 1024 * 1024);
		const prefixedPayload = `data:image/png;base64,${rawPayload}`;
		const messages = [
			{
				role: "user",
				content: [{ type: "image", data: rawPayload, mimeType: "image/png" }],
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "image-call",
						name: "read",
						arguments: { path: "image-fixture" },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "image-call",
				toolName: "read",
				content: [
					{ type: "image", data: prefixedPayload, mimeType: "image/png" },
				],
			},
		];
		const tokenizer = spyOn(formattingModule, "estimateTokens");
		try {
			const stableId = withStableIds(messages, [
				"user-image",
				"tool-owner",
				"tool-result",
			]);
			const tags = [
				tag(1, "user-image:file0", "file"),
				tag(2, "image-call", "tool", { toolOwnerMessageId: "tool-owner" }),
			];
			const baseline = measurePiTailHygiene({
				messages,
				tags,
				protectedTagNumbers: new Set(),
				stableId,
			});
			const measured = measurePiTailHygiene({
				messages,
				tags,
				protectedTagNumbers: new Set([2]),
				pendingDropTagNumbers: new Set([1]),
				stableId,
			});
			const imageParts = measured.parts.filter(
				(part) => part.kind === "file" || part.kind === "toolOutput",
			);
			const imagePayloadCalls = tokenizer.mock.calls.filter(
				([content]) =>
					typeof content === "string" && content.includes(rawPayload),
			);

			expect(imagePayloadCalls).toHaveLength(0);
			expect(imageParts.map(({ kind, tokens }) => ({ kind, tokens }))).toEqual([
				{ kind: "file", tokens: 1200 },
				{ kind: "toolOutput", tokens: 1200 },
			]);
			expect(measured.t).toBe(baseline.t);
			expect(measured.u).toBe(0);
			expect(baseline.contentSignature).toBe(measured.contentSignature);
			expect(measured.contentSignature).toBe("721a4413");
			expect(measured.parts.find((part) => part.tagNumber === 1)).toMatchObject(
				{
					queuedForDrop: true,
					protected: false,
				},
			);
			expect(
				measured.parts
					.filter((part) => part.tagNumber === 2)
					.every((part) => part.protected && part.uTokens === 0),
			).toBe(true);
		} finally {
			tokenizer.mockRestore();
		}
	});

	it("counts a tool-output key once when an image hash is requested first", () => {
		const content = `data:image/png;base64,${"B".repeat(64)}`;
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "hash-first-call",
						name: "read",
						arguments: { path: "hash-first" },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "hash-first-call",
				toolName: "read",
				content: [
					{ type: "image", data: content, mimeType: "image/png" },
					{ type: "text", text: content },
				],
			},
		];
		const expectedTextTokens = formattingModule.estimateTokens(content);
		const tokenizer = spyOn(formattingModule, "estimateTokens");
		try {
			const measured = measurePiTailHygiene({
				messages,
				tags: [
					tag(3, "hash-first-call", "tool", {
						toolOwnerMessageId: "hash-first-owner",
					}),
				],
				protectedTagNumbers: new Set(),
				stableId: withStableIds(messages, [
					"hash-first-owner",
					"hash-first-result",
				]),
			});
			const textCalls = tokenizer.mock.calls.filter(
				([value]) => value === content,
			);
			const toolOutputParts = measured.parts.filter(
				(part) => part.kind === "toolOutput",
			);

			expect(textCalls).toHaveLength(1);
			expect(toolOutputParts.map((part) => part.tokens)).toEqual([
				1200,
				expectedTextTokens,
			]);
		} finally {
			tokenizer.mockRestore();
		}
	});

	it("caches a genuine zero and keeps excluded content out of the tokenizer", () => {
		const zeroContent = "pi-zero-token-fixture";
		const excludedContent = "pi-excluded-fixture";
		const tokenizer = spyOn(
			formattingModule,
			"estimateTokens",
		).mockImplementation((content) => (content === zeroContent ? 0 : 1));
		try {
			const messages = [
				{
					role: "user",
					content: [
						{ type: "text", text: zeroContent },
						{ type: "thinking", thinking: excludedContent },
					],
				},
			];
			const input = {
				messages,
				tags: [tag(4, "zero:p0", "message")],
				protectedTagNumbers: new Set<number>(),
				stableId: withStableIds(messages, ["zero"]),
			};
			const first = measurePiTailHygiene(input);
			const second = measurePiTailHygiene(input);
			expect(first.parts.find((part) => part.kind === "text")?.tokens).toBe(0);
			expect(second.parts.find((part) => part.kind === "text")?.tokens).toBe(0);
			expect(
				tokenizer.mock.calls.filter(([value]) => value === zeroContent),
			).toHaveLength(1);
			expect(
				tokenizer.mock.calls.filter(([value]) => value === excludedContent),
			).toHaveLength(0);
		} finally {
			tokenizer.mockRestore();
		}
	});
});

describe("Pi hygiene walk performance", () => {
	it("memoized 250k-token rendered tail walks are cheap relative to the cold walk", () => {
		const messages = [textMessage("user", "token ".repeat(250_000))];
		const tags = [tag(1, "perf:p0", "message")];
		const stableId = withStableIds(messages, ["perf"]);
		const walk = (content: string) => {
			(messages[0] as { content: string }).content = content;
			const start = performance.now();
			measurePiTailHygiene({
				messages,
				tags,
				protectedTagNumbers: new Set(),
				stableId,
			});
			return performance.now() - start;
		};
		const medianOf = (samples: number[]) => {
			const sorted = [...samples].sort((left, right) => left - right);
			return sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
		};
		// The content memo is keyed on the rendered text, so a walk over unchanged
		// content must skip tokenization while a walk over fresh content pays it.
		// A shared CI runner cannot promise an absolute millisecond budget (the
		// memoized walk read 2.7ms locally and 19ms on a loaded runner), so the
		// invariant is the ratio between the unmemoized and memoized walks measured
		// in the same process, which load scales equally. The ratio compares
		// medians: a p95 over a 2ms memoized walk is one scheduler stall away from
		// any value (a release gate at load 46 read memoized p95 57ms against
		// unmemoized 143ms), while the median of 25 samples is not. The absolute
		// ceiling is kept behind MC_PERF_GATE for machines that opt into wall-clock
		// budgets.
		const base = "token ".repeat(250_000);
		const unmemoized: number[] = [];
		for (let iteration = 0; iteration < 8; iteration += 1) {
			unmemoized.push(walk(`${base} fresh-${iteration}`));
		}
		walk(base);
		const memoized: number[] = [];
		for (let iteration = 0; iteration < 25; iteration += 1)
			memoized.push(walk(base));
		const unmemoizedMedian = medianOf(unmemoized);
		const memoizedMedian = medianOf(memoized);
		console.log(
			`pi-tail-hygiene-walk 250k-token unmemoized p50=${unmemoizedMedian.toFixed(3)}ms memoized p50=${memoizedMedian.toFixed(3)}ms`,
		);
		expect(memoizedMedian).toBeLessThan(unmemoizedMedian / 5);
		if (process.env.MC_PERF_GATE === "1")
			expect(memoizedMedian).toBeLessThan(15);
	});
});
it("Pi adopts map edits only on rebuilding and preserves the Channel 2 lease on SOFT+", () => {
	const db = createTestDb();
	try {
		const arc = toolArc("owner", "call", "probe", {}, "word ".repeat(12000));
		const input = {
			messages: arc.messages,
			tags: [arc.tag],
			stableId: arc.stableId,
			protectedTagNumbers: new Set<number>(),
		};
		const before = refreshPiTailHygieneBaseline({
			...input,
			cacheBusting: true,
		});
		expect(effectivePiTailHygiene(before).u).toBeGreaterThan(6000);
		setChannel2NudgeState(db, "pi-policy", "delivered");
		const deferred = refreshPiTailHygieneBaseline({
			...input,
			previous: before,
			cacheBusting: false,
			protectedTools: { probe: 1 },
		});
		rearmChannel2AfterMeasuredCollapse({
			db,
			sessionId: "pi-policy",
			baseline: deferred,
			rebuilding: false,
			previous: before,
		});
		expect(effectivePiTailHygiene(deferred)).toEqual(
			effectivePiTailHygiene(before),
		);
		expect(getChannel2NudgeState(db, "pi-policy")).toBe("delivered");
		const rebuilt = refreshPiTailHygieneBaseline({
			...input,
			previous: deferred,
			cacheBusting: true,
			protectedTools: { probe: 1 },
		});
		rearmChannel2AfterMeasuredCollapse({
			db,
			sessionId: "pi-policy",
			baseline: rebuilt,
			rebuilding: true,
		});
		expect(effectivePiTailHygiene(rebuilt).u).toBe(0);
		expect(getChannel2NudgeState(db, "pi-policy")).toBe("");
	} finally {
		db.close();
	}
});

it("Pi legacy default upgrade preserves U until rebuilding", () => {
	const arc = toolArc("owner", "call", "todowrite", {}, "word ".repeat(12000));
	const input = {
		messages: arc.messages,
		tags: [arc.tag],
		stableId: arc.stableId,
		protectedTagNumbers: new Set<number>(),
	};
	const before = refreshPiTailHygieneBaseline({
		...input,
		cacheBusting: true,
		protectedTools: { todowrite: 0 },
	});
	delete before.protectedToolsPolicy;
	expect(effectivePiTailHygiene(before).u).toBeGreaterThan(6000);
	const deferred = refreshPiTailHygieneBaseline({
		...input,
		cacheBusting: false,
		previous: before,
	});
	expect(effectivePiTailHygiene(deferred)).toEqual(
		effectivePiTailHygiene(before),
	);
	const rebuilt = refreshPiTailHygieneBaseline({
		...input,
		cacheBusting: true,
		previous: deferred,
	});
	expect(effectivePiTailHygiene(rebuilt).u).toBe(0);
});

it("Pi rotation inside the adopted policy keeps queued mass out of U on SOFT+", () => {
	const first = toolArc("owner-1", "call-1", "probe", {}, "word ".repeat(3000));
	const second = toolArc(
		"owner-2",
		"call-2",
		"probe",
		{},
		"word ".repeat(3000),
	);
	const before = refreshPiTailHygieneBaseline({
		messages: first.messages,
		tags: [first.tag],
		stableId: first.stableId,
		protectedTagNumbers: new Set(),
		pendingDropTagNumbers: new Set([1]),
		protectedTools: { probe: 1 },
		cacheBusting: true,
	});
	const messages = [...first.messages, ...second.messages];
	const tags = [first.tag, { ...second.tag, tagNumber: 2 }];
	const deferred = refreshPiTailHygieneBaseline({
		messages,
		tags,
		stableId: withStableIds(messages, [
			"owner-1",
			"owner-1-result",
			"owner-2",
			"owner-2-result",
		]),
		protectedTagNumbers: new Set(),
		pendingDropTagNumbers: new Set([1]),
		protectedTools: { probe: 0 },
		cacheBusting: false,
		previous: before,
	});
	expect(effectivePiTailHygiene(deferred).u).toBe(
		effectivePiTailHygiene(before).u,
	);
});

it("the hygiene projection counts real user turns without a second message walk", () => {
	const input = {
		messages: [
			{ role: "user", content: "synthetic leading history" },
			{ role: "user", content: "first real prompt" },
			{ role: "custom", content: "hidden nudge" },
			{ role: "assistant", content: [{ type: "text", text: "reply" }] },
			{ role: "user", content: "second real prompt" },
		],
		tags: [],
		protectedTagNumbers: new Set<number>(),
		syntheticLeadingCount: 1,
	};
	expect(measurePiTailHygiene(input).realUserTurnCount).toBe(2);
	const first = refreshPiTailHygieneBaseline({ ...input, cacheBusting: true });
	expect(first.realUserTurnCount).toBe(2);
	const next = refreshPiTailHygieneBaseline({
		...input,
		messages: [
			...input.messages,
			{ role: "user", content: "third real prompt" },
		],
		cacheBusting: false,
		previous: first,
	});
	expect(next.realUserTurnCount).toBe(3);
});

it("immutable hygiene tag attribution extends appends and rebuilds rewritten, deleted and reowned rows", () => {
	const key = {};
	const first = Object.freeze([
		Object.freeze(tag(1, "user:p0", "message")),
		Object.freeze(tag(2, "call", "tool", { toolOwnerMessageId: "assistant" })),
	]);
	const messages = [
		{ role: "user", content: "§1§ prompt" },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
		},
		{
			role: "toolResult",
			toolCallId: "call",
			content: [{ type: "text", text: "§2§ result" }],
		},
	];
	const compare = (tags: readonly TagEntry[]) => {
		const input = {
			messages,
			tags,
			protectedTagNumbers: new Set<number>(),
			stableId: (_message: unknown, index: number) =>
				["user", "assistant", "result"][index],
		};
		expect(measurePiTailHygiene({ ...input, tagCacheKey: key })).toEqual(
			measurePiTailHygiene(input),
		);
	};
	compare(first);
	const appended = Object.freeze([
		...first,
		Object.freeze(tag(3, "hidden:p0", "message")),
	]);
	compare(appended);
	compare(
		Object.freeze([
			first[0] as TagEntry,
			Object.freeze(
				tag(2, "call", "tool", {
					toolOwnerMessageId: "different",
					status: "dropped",
				}),
			),
			appended[2] as TagEntry,
		]),
	);
	compare(Object.freeze([first[0] as TagEntry]));
});

describe("Pi tail-hygiene content memo across long histories", () => {
	// Each body is about 128 Ki characters. Keyed by full content, 300 of them
	// count as about 75 MiB against the memo's 64 MiB bound.
	const longHistory = () =>
		Array.from({ length: 300 }, (_, index) => ({
			role: index % 2 ? "assistant" : "user",
			content: [
				{
					type: "text",
					text: `${index}:${"synthetic tool output line\n".repeat(5042)}`,
				},
			],
		}));
	const walk = (messages: readonly unknown[]) =>
		measurePiTailHygiene({
			messages,
			tags: [],
			protectedTagNumbers: new Set<number>(),
			stableId: (_message: unknown, index: number) => `history-${index}`,
		});

	it("re-walks a history larger than the byte bound without re-measuring it", () => {
		clearPiTailHygieneContentMemo();
		const tokenizer = spyOn(
			formattingModule,
			"estimateTokens",
		).mockImplementation((content) => Math.ceil(content.length / 4));
		try {
			const first = walk(longHistory());
			expect(tokenizer).toHaveBeenCalledTimes(300);
			// The host rebuilds every pass from its own store: same content, new objects.
			tokenizer.mockClear();
			__test.resetContentMemoCounters();
			const second = walk(longHistory());
			expect(__test.contentMemoStats()).toMatchObject({
				hits: 300,
				misses: 0,
				evictions: 0,
			});
			expect(tokenizer).not.toHaveBeenCalled();
			expect(second.contentSignature).toBe(first.contentSignature);
			expect(second.t).toBe(first.t);
		} finally {
			tokenizer.mockRestore();
			clearPiTailHygieneContentMemo();
		}
	});

	it("re-measures an old message edited in place", () => {
		clearPiTailHygieneContentMemo();
		const tokenizer = spyOn(
			formattingModule,
			"estimateTokens",
		).mockImplementation((content) => Math.ceil(content.length / 4));
		try {
			const messages = longHistory();
			const before = walk(messages);
			// Same length and same object, so only the content can tell them apart.
			const part = messages[3]?.content[0] as { text: string };
			const edited = `${part.text.slice(0, -2)}!\n`;
			part.text = edited;
			tokenizer.mockClear();
			__test.resetContentMemoCounters();
			const after = walk(messages);
			expect(tokenizer.mock.calls).toEqual([[edited]]);
			expect(__test.contentMemoStats()).toMatchObject({ hits: 299, misses: 1 });
			expect(after.contentSignature).not.toBe(before.contentSignature);
			expect(after.parts[3]?.contentHash).not.toBe(
				before.parts[3]?.contentHash,
			);
		} finally {
			tokenizer.mockRestore();
			clearPiTailHygieneContentMemo();
		}
	});

	it("keeps unpaired surrogates distinct in digest keys", () => {
		clearPiTailHygieneContentMemo();
		const tokenizer = spyOn(
			formattingModule,
			"estimateTokens",
		).mockImplementation((content) => content.charCodeAt(content.length - 1));
		try {
			const body = "x".repeat(200);
			// UTF-8 would encode both lone surrogates as the same replacement bytes.
			const measured = walk([
				{ role: "user", content: `${body}\ud800` },
				{ role: "user", content: `${body}\udbff` },
			]);
			expect(measured.parts.map((part) => part.tokens)).toEqual([
				0xd800, 0xdbff,
			]);
			expect(tokenizer).toHaveBeenCalledTimes(2);
		} finally {
			tokenizer.mockRestore();
			clearPiTailHygieneContentMemo();
		}
	});
});
