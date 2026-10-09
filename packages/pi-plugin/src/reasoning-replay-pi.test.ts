import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { openDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { reasoningStepCost } from "@magic-context/core/hooks/magic-context/reasoning-budget";
import { setHarness } from "@magic-context/core/shared/harness";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import prefixBoundGolden from "../../../crates/mc-module/testdata/prefix-bound-reasoning-trim.json";
import budgetGolden from "../../../crates/mc-module/testdata/reasoning-budget-trim.json";
import {
	buildMessageIdToMaxTag,
	clearOldReasoningPi,
	piMessageStableId,
	piReasoningClearCutoff,
	replayClearedReasoningPi,
	replayStrippedInlineThinkingPi,
	stripInlineThinkingPi,
} from "./reasoning-replay-pi";

setHarness("pi");

function makeDb() {
	const dir = createTestTempDir("pi-reasoning-replay-").dir;
	const path = join(dir, "context.db");
	return openDatabase(path);
}

function fakeTagTarget(messageId: string) {
	return {
		setContent: () => true,
		message: { info: { id: messageId, role: "assistant" }, parts: [] },
	};
}

/** Test helper: throw when piMessageStableId returns undefined. */
function requireId(msg: unknown, index: number): string {
	const id = piMessageStableId(msg, index);
	if (!id)
		throw new Error(`piMessageStableId returned undefined for index=${index}`);
	return id;
}

describe("buildMessageIdToMaxTag", () => {
	it("records the MAX tag number across parts of the same message", () => {
		const targets = new Map<number, ReturnType<typeof fakeTagTarget>>([
			[1, fakeTagTarget("msg-A")],
			[2, fakeTagTarget("msg-A")],
			[3, fakeTagTarget("msg-B")],
		]);
		const result = buildMessageIdToMaxTag(targets);
		expect(result.get("msg-A")).toBe(2);
		expect(result.get("msg-B")).toBe(3);
	});

	it("skips targets with no message id", () => {
		const targets = new Map<number, ReturnType<typeof fakeTagTarget>>([
			[1, { setContent: () => true, message: undefined }],
			[2, fakeTagTarget("msg-A")],
		] as Array<[number, ReturnType<typeof fakeTagTarget>]>);
		const result = buildMessageIdToMaxTag(
			targets as unknown as Map<
				number,
				import("@magic-context/core/hooks/magic-context/tag-messages").TagTarget
			>,
		);
		expect(result.size).toBe(1);
		expect(result.get("msg-A")).toBe(2);
	});
});

describe("piMessageStableId", () => {
	it("matches the format used by transcript-pi.ts", () => {
		expect(piMessageStableId({ role: "user", timestamp: 1234 }, 5)).toBe(
			"pi-msg-5-1234-user",
		);
		expect(piMessageStableId({ role: "assistant" }, 7)).toBe(
			"pi-msg-7-assistant",
		);
	});
});

describe("clearOldReasoningPi", () => {
	it("clears thinking on assistant messages whose tag is below the age cutoff", () => {
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [
					{ type: "thinking", thinking: "old reasoning" },
					{ type: "text", text: "old reply" },
				],
			},
			{
				role: "assistant",
				timestamp: 2,
				content: [
					{ type: "thinking", thinking: "recent reasoning" },
					{ type: "text", text: "recent reply" },
				],
			},
		];
		// Pretend tags 1..2 exist; clear messages with tag <= 1 (one message older than age 1).
		const id0 = piMessageStableId(messages[0], 0);
		const id1 = piMessageStableId(messages[1], 1);
		if (!id0 || !id1) throw new Error("piMessageStableId returned undefined");
		const messageIdToMaxTag = new Map<string, number>([
			[id0, 1],
			[id1, 2],
		]);
		const result = clearOldReasoningPi({
			messages,
			messageIdToMaxTag,
			maxCutoff: 1,
			piMessageStableId,
		});
		expect(result.cleared).toBe(1);
		expect(result.newWatermark).toBe(1);
		// Old reasoning is emptied (not "[cleared]"); every Pi serializer drops an
		// empty thinking block before the wire.
		expect(messages[0].content[0]).toMatchObject({
			type: "thinking",
			thinking: "",
		});
		// Recent message untouched.
		expect(messages[1].content[0]).toMatchObject({
			type: "thinking",
			thinking: "recent reasoning",
		});
	});

	it("leaves native-only reasoning to the native coordinator without advancing the local watermark", () => {
		const native = {
			type: "openaiResponsesHistory",
			dt: true,
			items: [
				{ type: "reasoning", encrypted_content: "persisted-only-reasoning" },
				{
					type: "function_call",
					id: "fc1",
					call_id: "call1",
					name: "read",
					arguments: "{}",
				},
			],
		};
		const nativeSnapshot = structuredClone(native);
		const localMessage = {
			role: "assistant",
			timestamp: 1,
			content: [{ type: "thinking", thinking: "local thinking" }],
		};
		const nativeOnlyMessage = {
			role: "assistant",
			timestamp: 2,
			content: [
				{ type: "toolCall", id: "call1|fc1", name: "read", arguments: {} },
			],
			providerPayload: native,
		};
		const messages = [localMessage, nativeOnlyMessage];
		const result = clearOldReasoningPi({
			messages,
			messageIdToMaxTag: new Map([
				["local", 1],
				["native", 2],
				["recent", 10],
			]),
			maxCutoff: 7,
			piMessageStableId: (_message, index) =>
				index === 0 ? "local" : "native",
		});

		expect(result).toEqual({ cleared: 1, newWatermark: 1 });
		expect(localMessage.content).toEqual([{ type: "thinking", thinking: "" }]);
		expect(nativeOnlyMessage.providerPayload).toBe(native);
		expect(nativeOnlyMessage.providerPayload).toEqual(nativeSnapshot);
	});

	it("preserves a full native snapshot while clearing local Pi thinking and replaying its watermark", () => {
		const db = makeDb();
		const sessionId = "ses-native-snapshot";
		try {
			const native = {
				type: "openaiResponsesHistory",
				dt: false,
				items: [{ type: "reasoning", encrypted_content: "snapshot-reasoning" }],
			};
			const original = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "required history",
						thinkingSignature: "sig",
					},
					{ type: "text", text: "reply" },
				],
				providerPayload: native,
			};
			const nativeSnapshot = structuredClone(native);
			const messageIdToMaxTag = new Map<string, number>([
				["a", 1],
				["recent", 10],
			]);
			const options = {
				messageIdToMaxTag,
				piMessageStableId: () => "a",
			};

			const first = structuredClone(original);
			const cleared = clearOldReasoningPi({
				...options,
				messages: [first],
				maxCutoff: 7,
			});
			expect(cleared).toEqual({ cleared: 1, newWatermark: 1 });
			expect(first.content).toEqual([
				{ type: "thinking", thinking: "" },
				{ type: "text", text: "reply" },
			]);
			expect(first.providerPayload).toEqual(nativeSnapshot);

			getOrCreateSessionMeta(db, sessionId);
			updateSessionMeta(db, sessionId, {
				clearedReasoningThroughTag: cleared.newWatermark,
			});
			const resumed = structuredClone(original);
			expect(
				replayClearedReasoningPi({
					...options,
					messages: [resumed],
					db,
					sessionId,
				}),
			).toBe(1);
			expect(resumed).toEqual(first);
			expect(resumed.providerPayload).toEqual(nativeSnapshot);
		} finally {
			db.close();
		}
	});

	it("does nothing when ageCutoff is 0 or below", () => {
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [{ type: "thinking", thinking: "a" }],
			},
		];
		const messageIdToMaxTag = new Map<string, number>([
			[requireId(messages[0], 0), 1],
		]);
		const result = clearOldReasoningPi({
			messages,
			messageIdToMaxTag,
			maxCutoff: 0,
			piMessageStableId,
		});
		expect(result.cleared).toBe(0);
		expect(result.newWatermark).toBe(0);
	});

	it("replays an old watermark byte-identically on mixed redacted and ordinary thinking after upgrade", () => {
		// Redacted blocks serialize before empty blocks, so they remain verbatim;
		// ordinary local thinking in the same message must still be cleared.
		const db = makeDb();
		const sessionId = "ses-mixed-generic-thinking";
		try {
			const native = {
				type: "openaiResponsesHistory",
				dt: true,
				items: [
					{ type: "reasoning", encrypted_content: "opaque native reasoning" },
				],
			};
			const original = {
				role: "assistant",
				timestamp: 1,
				providerPayload: native,
				content: [
					{
						type: "thinking",
						thinking: "opaque-redacted-payload",
						thinkingSignature: "sig-abc",
						redacted: true,
					},
					{
						type: "thinking",
						thinking: "ordinary local thinking",
						thinkingSignature: "ordinary-signature",
					},
					{ type: "text", text: "reply" },
				],
			};
			const messageIdToMaxTag = new Map<string, number>([
				[requireId(original, 0), 1],
				["recent", 4],
			]);
			const options = {
				messageIdToMaxTag,
				piMessageStableId,
			};

			const first = structuredClone(original);
			const cleared = clearOldReasoningPi({
				...options,
				messages: [first],
				maxCutoff: 2,
			});
			expect(cleared).toEqual({ cleared: 1, newWatermark: 1 });
			expect(first.content).toEqual([
				{
					type: "thinking",
					thinking: "opaque-redacted-payload",
					thinkingSignature: "sig-abc",
					redacted: true,
				},
				{ type: "thinking", thinking: "" },
				{ type: "text", text: "reply" },
			]);
			expect(first.providerPayload).toEqual(native);

			getOrCreateSessionMeta(db, sessionId);
			updateSessionMeta(db, sessionId, {
				clearedReasoningThroughTag: cleared.newWatermark,
			});
			const resumed = structuredClone(original);
			expect(
				replayClearedReasoningPi({
					...options,
					messages: [resumed],
					db,
					sessionId,
				}),
			).toBe(1);
			expect(resumed).toEqual(first);
		} finally {
			db.close();
		}
	});
});

describe("replayClearedReasoningPi", () => {
	it("replays emptied thinking for assistant parts below the watermark", () => {
		const db = makeDb();
		const sessionId = "ses_replay_pi_1";
		// First make the session_meta row exist.
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, { clearedReasoningThroughTag: 1 });

		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [{ type: "thinking", thinking: "should be cleared" }],
			},
			{
				role: "assistant",
				timestamp: 2,
				content: [{ type: "thinking", thinking: "still visible" }],
			},
		];
		const messageIdToMaxTag = new Map<string, number>([
			[requireId(messages[0], 0), 1],
			[requireId(messages[1], 1), 2],
		]);
		const cleared = replayClearedReasoningPi({
			db,
			sessionId,
			messages,
			messageIdToMaxTag,
			piMessageStableId,
		});
		expect(cleared).toBe(1);
		expect(messages[0].content[0]).toMatchObject({ thinking: "" });
		expect(messages[1].content[0]).toMatchObject({ thinking: "still visible" });
	});
});

describe("stripInlineThinkingPi", () => {
	it("strips both inline thinking tag forms below the age cutoff and reports a watermark", () => {
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [
					{
						type: "text",
						text: "A <thinking>secret</thinking> visible",
					},
				],
			},
			{
				role: "assistant",
				timestamp: 2,
				content: [{ type: "text", text: "B <think>hidden</think> visible" }],
			},
			{
				role: "assistant",
				timestamp: 3,
				content: [
					{
						type: "text",
						text: "C <thinking>keep</thinking><think>keep</think> visible",
					},
				],
			},
		];
		const messageIdToMaxTag = new Map<string, number>([
			[requireId(messages[0], 0), 1],
			[requireId(messages[1], 1), 2],
			[requireId(messages[2], 2), 3],
		]);

		const result = stripInlineThinkingPi({
			messages,
			messageIdToMaxTag,
			maxCutoff: 2,
			piMessageStableId,
		});

		expect(result).toEqual({ stripped: 2, newWatermark: 2 });
		expect(messages[0].content[0]).toMatchObject({ text: "A visible" });
		expect(messages[1].content[0]).toMatchObject({ text: "B visible" });
		expect(messages[2].content[0]).toMatchObject({
			text: "C <thinking>keep</thinking><think>keep</think> visible",
		});
	});
});

describe("replayStrippedInlineThinkingPi", () => {
	it("strips inline <thinking>...</thinking> from text parts below the watermark", () => {
		const db = makeDb();
		const sessionId = "ses_inline_pi_1";
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, { clearedReasoningThroughTag: 1 });

		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [
					{
						type: "text",
						text: "Hello <thinking>secret</thinking> world",
					},
				],
			},
		];
		const messageIdToMaxTag = new Map<string, number>([
			[requireId(messages[0], 0), 1],
		]);
		const stripped = replayStrippedInlineThinkingPi({
			db,
			sessionId,
			messages,
			messageIdToMaxTag,
			piMessageStableId,
		});
		expect(stripped).toBe(1);
		expect(messages[0].content[0]).toMatchObject({
			type: "text",
			text: "Hello world",
		});
	});

	it("returns 0 when no watermark is set", () => {
		const db = makeDb();
		const sessionId = "ses_inline_pi_2";
		getOrCreateSessionMeta(db, sessionId);
		// no watermark update — defaults to 0
		const messages = [
			{
				role: "assistant",
				timestamp: 1,
				content: [{ type: "text", text: "<thinking>nope</thinking>untouched" }],
			},
		];
		const messageIdToMaxTag = new Map<string, number>([
			[requireId(messages[0], 0), 1],
		]);
		const stripped = replayStrippedInlineThinkingPi({
			db,
			sessionId,
			messages,
			messageIdToMaxTag,
			piMessageStableId,
		});
		expect(stripped).toBe(0);
	});
});

describe("piReasoningClearCutoff", () => {
	it("charges encrypted native reasoning a fixed 1000 without tokenizing payload bytes", () => {
		const messages = [0, 1, 2].map((i) => ({
			role: "assistant",
			content: [{ type: "text", text: `answer-${i}` }],
			providerPayload: {
				items: [
					{
						type: "reasoning",
						encrypted_content: "x".repeat(i === 0 ? 100000 : 1),
					},
				],
			},
			usage: i === 2 ? { reasoning: 500 } : undefined,
		}));
		expect(
			piReasoningClearCutoff({
				messages,
				messageIdToMaxTag: new Map([
					["a0", 1],
					["a1", 2],
					["a2", 3],
				]),
				keepReasoningTokens: 1500,
				prefixBound: false,
				piMessageStableId: (_, i) => `a${i}`,
			}),
		).toBe(1);
	});
	it("matches shared whole-step budget selection and prefix-stop goldens", () => {
		for (const scenario of budgetGolden.cases) {
			// Two explicit exemptions belong to the pure-cutoff fixture. Pi's newest
			// reasoning-bearing assistant is also its newest replayable assistant.
			if (scenario.steps.filter((step) => step.exempt).length > 1) continue;
			const messages = scenario.steps.map((step, i) => ({
				role: "assistant",
				timestamp: i,
				usage: {
					reasoning: reasoningStepCost(
						step.reported,
						step.text_estimate ?? 0,
						step.opaque === true,
					),
				},
				content: [
					{ type: "thinking", thinking: "", thinkingSignature: `sig-${i}` },
					{ type: "text", text: `answer-${i}` },
				],
			}));
			const tags = new Map(
				scenario.steps.map((step, i) => [`a${i}`, step.tag]),
			);
			const gone = new Set(
				scenario.steps.flatMap((step, i) =>
					step.already_removed ? [`a${i}`] : [],
				),
			);
			const cutoff = piReasoningClearCutoff({
				messages,
				messageIdToMaxTag: tags,
				keepReasoningTokens: scenario.budget,
				prefixBound: scenario.prefix_bound,
				piMessageStableId: (_, i) => `a${i}`,
				alreadyGone: (id) => gone.has(id),
			});
			clearOldReasoningPi({
				messages,
				messageIdToMaxTag: tags,
				maxCutoff: cutoff,
				piMessageStableId: (_, i) => `a${i}`,
			});
			const after = messages.flatMap((message, i) =>
				gone.has(`a${i}`) || message.content[0].thinkingSignature === undefined
					? [i]
					: [],
			);
			expect({ name: scenario.name, after }).toEqual({
				name: scenario.name,
				after: scenario.removed_after,
			});
		}
	});
	// Five assistant steps; assistant i carries tag i + 1. A user turn after them
	// carries tag 40, so the age rule alone would cover every assistant.
	const build = (options: { redactedAt?: number } = {}) => {
		const messages: Array<Record<string, unknown>> = [];
		for (let step = 0; step < 5; step++) {
			messages.push({
				role: "assistant",
				timestamp: step + 1,
				content: [
					{
						type: "thinking",
						thinking: `reasoning ${step}`,
						thinkingSignature: `sig-${step}`,
						...(options.redactedAt === step ? { redacted: true } : {}),
					},
					{ type: "text", text: `reply ${step}` },
				],
			});
		}
		messages.push({
			role: "user",
			timestamp: 99,
			content: [{ type: "text", text: "next" }],
		});
		const messageIdToMaxTag = new Map<string, number>();
		messages.forEach((message, index) => {
			messageIdToMaxTag.set(
				requireId(message, index),
				index < 5 ? index + 1 : 40,
			);
		});
		return { messages, messageIdToMaxTag };
	};
	const thinkingOf = (message: Record<string, unknown>) =>
		(message.content as Array<{ thinking?: string }>)[0].thinking;

	it("stays below the newest assistant even when the age rule covers it", () => {
		const { messages, messageIdToMaxTag } = build();
		const cutoff = piReasoningClearCutoff({
			messages,
			messageIdToMaxTag,
			keepReasoningTokens: 0,
			piMessageStableId,
			prefixBound: false,
		});
		expect(cutoff).toBe(4);
		const outcome = clearOldReasoningPi({
			messages,
			messageIdToMaxTag,
			piMessageStableId,
			maxCutoff: cutoff,
		});
		expect(outcome.newWatermark).toBe(4);
		expect(thinkingOf(messages[3])).toBe("");
		expect(thinkingOf(messages[4])).toBe("reasoning 4");
	});

	// Rows of Anthropic's "What counts as an edit" table
	// (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking).
	it('prefix-bound: "Remove `thinking` blocks from the start of the history" is valid, so the oldest prefix is cleared', () => {
		const { messages, messageIdToMaxTag } = build();
		const bound = piReasoningClearCutoff({
			messages,
			messageIdToMaxTag,
			keepReasoningTokens: 0,
			piMessageStableId,
			prefixBound: true,
		});
		expect(bound).toBe(4);
		clearOldReasoningPi({
			messages,
			messageIdToMaxTag,
			piMessageStableId,
			maxCutoff: bound,
		});
		expect(messages.slice(0, 4).map(thinkingOf)).toEqual(["", "", "", ""]);
		expect(thinkingOf(messages[4])).toBe("reasoning 4");
	});

	it('prefix-bound: "Remove a `thinking` block from the middle of the history and keep later ones" is invalid, so the cutoff stops below the first block the clear would keep', () => {
		const { messages, messageIdToMaxTag } = build({ redactedAt: 2 });
		const bound = piReasoningClearCutoff({
			messages,
			messageIdToMaxTag,
			keepReasoningTokens: 0,
			piMessageStableId,
			prefixBound: true,
		});
		// The clear leaves a redacted block in place, so nothing after it may go.
		expect(bound).toBe(2);
		clearOldReasoningPi({
			messages,
			messageIdToMaxTag,
			piMessageStableId,
			maxCutoff: bound,
		});
		expect(messages.slice(0, 5).map(thinkingOf)).toEqual([
			"",
			"",
			"reasoning 2",
			"reasoning 3",
			"reasoning 4",
		]);
		// Unbound models keep skipping the redacted block.
		expect(
			piReasoningClearCutoff({
				messages,
				messageIdToMaxTag,
				keepReasoningTokens: 0,
				piMessageStableId,
				prefixBound: false,
			}),
		).toBe(4);
	});

	it("prefix-bound: an older tag behind the stop pulls the cutoff below it, so the cleared set stays a prefix", () => {
		const { messages, messageIdToMaxTag } = build({ redactedAt: 3 });
		// Step 1 carries a tag above step 3's (tags are not always in order).
		messageIdToMaxTag.set(requireId(messages[1], 1), 4);
		messageIdToMaxTag.set(requireId(messages[3], 3), 2);
		const bound = piReasoningClearCutoff({
			messages,
			messageIdToMaxTag,
			keepReasoningTokens: 0,
			piMessageStableId,
			prefixBound: true,
		});
		// Step 3 is kept (tag 2), so the cutoff is 1; step 1 (tag 4) then sits
		// above it, which stops the prefix after step 0.
		expect(bound).toBe(1);
	});

	it("prefix-bound: inline thinking markup in assistant text stops the prefix, because the shared watermark would rewrite that text", () => {
		const { messages, messageIdToMaxTag } = build();
		(messages[1].content as Array<{ type: string; text?: string }>)[1].text =
			"<thinking>inline</thinking>reply 1";
		expect(
			piReasoningClearCutoff({
				messages,
				messageIdToMaxTag,
				keepReasoningTokens: 0,
				piMessageStableId,
				prefixBound: true,
			}),
		).toBe(1);
	});

	it("prefix-bound: matches the shared TypeScript, Pi and Rust golden", () => {
		for (const scenario of prefixBoundGolden.cases) {
			const messages: Array<Record<string, unknown>> = [
				// Historical context carrier: the real active-turn witness is separate.
				{
					role: "user",
					synthetic: true,
					timestamp: 1,
					content: [{ type: "text", text: "go" }],
				},
			];
			for (let step = 0; step < scenario.steps; step++) {
				messages.push({
					role: "assistant",
					timestamp: step + 2,
					usage: { reasoning: 100 },
					content: [
						{
							type: "thinking",
							thinking: `reasoning a${step}`,
							thinkingSignature: `sig-a${step}`,
						},
						{ type: "text", text: `reply a${step}` },
					],
				});
			}
			const stepOf = new Map<string, string>();
			const messageIdToMaxTag = new Map<string, number>();
			messages.forEach((message, index) => {
				const id = requireId(message, index);
				const step = index === 0 ? "user" : `a${index - 1}`;
				stepOf.set(id, step);
				if (!scenario.untagged.includes(step)) {
					messageIdToMaxTag.set(id, index + 1);
				}
			});
			const gone = new Set(scenario.already_removed);
			const cutoff = piReasoningClearCutoff({
				messages,
				messageIdToMaxTag,
				keepReasoningTokens: scenario.keep_reasoning_tokens,
				piMessageStableId,
				prefixBound: true,
				alreadyGone: (id) => gone.has(stepOf.get(id) ?? ""),
			});
			clearOldReasoningPi({
				messages,
				messageIdToMaxTag,
				piMessageStableId,
				maxCutoff: cutoff,
			});
			const after = messages
				.slice(1)
				.map((message, step) => ({
					step: `a${step}`,
					thinking: thinkingOf(message),
				}))
				.filter(({ step, thinking }) => thinking === "" || gone.has(step))
				.map(({ step }) => step)
				.sort();
			expect({ name: scenario.name, after }).toEqual({
				name: scenario.name,
				after: [...scenario.removed_after].sort(),
			});
		}
	});

	it("replays exactly the executed clear on a rebuilt array, newest assistant untouched", () => {
		const db = makeDb();
		try {
			const sessionId = "ses-pi-cutoff-replay";
			const first = build();
			const cutoff = piReasoningClearCutoff({
				messages: first.messages,
				messageIdToMaxTag: first.messageIdToMaxTag,
				keepReasoningTokens: 0,
				piMessageStableId,
				prefixBound: false,
			});
			const outcome = clearOldReasoningPi({
				messages: first.messages,
				messageIdToMaxTag: first.messageIdToMaxTag,
				piMessageStableId,
				maxCutoff: cutoff,
			});
			getOrCreateSessionMeta(db, sessionId);
			updateSessionMeta(db, sessionId, {
				clearedReasoningThroughTag: outcome.newWatermark,
			});
			const rebuilt = build();
			replayClearedReasoningPi({
				db,
				sessionId,
				messages: rebuilt.messages,
				messageIdToMaxTag: rebuilt.messageIdToMaxTag,
				piMessageStableId,
			});
			expect(JSON.stringify(rebuilt.messages)).toBe(
				JSON.stringify(first.messages),
			);
			expect(thinkingOf(rebuilt.messages[4])).toBe("reasoning 4");
		} finally {
			db.close();
		}
	});
});
