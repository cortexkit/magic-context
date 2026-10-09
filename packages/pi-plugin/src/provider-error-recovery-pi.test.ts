import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	clearThinkingBindingRecoveryIf,
	getMergedReasoningStrippedIds,
	getOverflowState,
	getThinkingBindingRecoveryTarget,
	resetEmergencyRecoveryRegistryForTest,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";

import { resolvePiUsableContextLimit } from "./pi-context-limit";
import {
	applyPiProactiveThinkingStrip,
	applyPiThinkingBindingRecovery,
	handlePiProviderFailure,
} from "./provider-error-recovery-pi";
import { createTestDb } from "./test-utils.test";

const databases: ReturnType<typeof createTestDb>[] = [];

afterEach(() => {
	for (const db of databases.splice(0)) closeQuietly(db);
	resetEmergencyRecoveryRegistryForTest();
});

function db() {
	const value = createTestDb();
	databases.push(value);
	return value;
}

function fableMessages() {
	return [
		{ role: "user", content: "question", timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "bound bytes", thinkingSignature: "sig" },
				{ type: "text", text: "answer" },
			],
			provider: "anthropic",
			model: "claude-fable-5-1",
			timestamp: 2,
		},
		{ role: "user", content: "retry", timestamp: 3 },
	];
}

// Captured 400 body, identical for Claude Fable 5.1 and Claude Opus 5.5
// (docs/reports/anthropic-thinking-binding.md section 2).
const LIVE_BINDING_400_BODY = {
	type: "error",
	error: {
		type: "invalid_request_error",
		message:
			'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". Content before this block differs from when it was created, first at `messages.0.content.0`.',
	},
	request_id: "req_011CfSakFxfwQ2vmA7q6iK45",
};

// Three completed assistant turns whose thinking was signed before a prefix edit.
// The final real user entry releases the tool loop for history reductions.
function multiAssistantCompletedMessages(): unknown[] {
	const assistant = (thinking: string, rest: unknown, timestamp: number) => ({
		role: "assistant",
		content: [
			{ type: "thinking", thinking, thinkingSignature: `sig-${thinking}` },
			rest,
		],
		provider: "anthropic",
		model: "claude-opus-5-5",
		timestamp,
	});
	return [
		{ role: "user", content: "re-rendered first message", timestamp: 1 },
		assistant("one", { type: "text", text: "answer one" }, 2),
		{ role: "user", content: "second", timestamp: 3 },
		assistant("two", { type: "text", text: "answer two" }, 4),
		{ role: "user", content: "run it", timestamp: 5 },
		assistant(
			"three",
			{ type: "toolCall", id: "call-open", name: "bash", arguments: {} },
			6,
		),
		{
			role: "toolResult",
			toolCallId: "call-open",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 7,
		},
		{ role: "user", content: "Next real turn", timestamp: 8 },
	];
}

describe("Pi provider failure recovery", () => {
	it("arms message_end binding recovery and re-serves stripped bytes after restart", () => {
		const database = db();
		const sessionId = "pi-fable-binding-recovery";
		const diagnostics: string[] = [];
		const event = handlePiProviderFailure({
			db: database,
			sessionId,
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude-fable-5-1",
				errorMessage:
					"400 invalid_request_error: thinking block is bound to a different conversation",
			},
			report: (message) => diagnostics.push(message),
		});
		expect(event).toEqual({ kind: "thinking_binding", armed: true });
		expect(getThinkingBindingRecoveryTarget(database, sessionId)).toBe(
			"all_reasoning_bearing_assistants",
		);

		const first = fableMessages();
		const applied = applyPiThinkingBindingRecovery({
			db: database,
			sessionId,
			messages: first,
			entryIds: ["entry-u1", "entry-a1", "entry-u2"],
			provider: "anthropic",
			model: "claude-fable-5-1",
			report: (message) => diagnostics.push(message),
		});
		expect(applied).toEqual({
			flagTarget: "all_reasoning_bearing_assistants",
			entryIds: ["entry-a1"],
		});
		expect(JSON.stringify(first)).not.toContain("bound bytes");
		expect(diagnostics).toEqual([
			"thinking-binding recovery armed from message_end (provider paths: failing=? firstChanged=?)",
			"thinking-binding recovery consumed on context pass target=all_reasoning_bearing_assistants entries=1 [entry-a1]",
		]);
		expect(diagnostics[0]).not.toBe(diagnostics[1]);
		expect(getMergedReasoningStrippedIds(database, sessionId)).toContain(
			"binding_mismatch:entry-a1",
		);
		if (!applied) throw new Error("binding recovery was not applied");
		expect(
			clearThinkingBindingRecoveryIf(database, sessionId, applied.flagTarget),
		).toBe(true);

		const restarted = fableMessages();
		expect(
			applyPiThinkingBindingRecovery({
				db: database,
				sessionId,
				messages: restarted,
				entryIds: ["entry-u1", "entry-a1", "entry-u2"],
				provider: "anthropic",
				model: "claude-fable-5-1",
			}),
		).toBeNull();
		expect(JSON.stringify(restarted)).toBe(JSON.stringify(first));
	});

	it("arms the same recovery from OMP's wrapped message_end error text", () => {
		const database = db();
		const sessionId = "omp-fable-binding-recovery";
		const event = handlePiProviderFailure({
			db: database,
			sessionId,
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude-fable-5-1",
				stopReason: "error",
				errorStatus: 400,
				errorMessage:
					'400 {"type":"error","error":{"type":"invalid_request_error","message":"thinking block is bound to a different conversation"}}\nraw-http-request=/tmp/http-400-requests/request.json',
			},
		});

		expect(event).toEqual({ kind: "thinking_binding", armed: true });
		expect(getThinkingBindingRecoveryTarget(database, sessionId)).toBe(
			"all_reasoning_bearing_assistants",
		);
	});

	it("arms binding recovery for Opus 5.5 from the live 400 text", () => {
		const database = db();
		const sessionId = "pi-opus-binding-recovery";
		const event = handlePiProviderFailure({
			db: database,
			sessionId,
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude-opus-5-5",
				errorMessage: `400 ${JSON.stringify(LIVE_BINDING_400_BODY)}`,
			},
			report: () => {},
		});
		expect(event).toEqual({ kind: "thinking_binding", armed: true });
		expect(getThinkingBindingRecoveryTarget(database, sessionId)).toBe(
			"all_reasoning_bearing_assistants",
		);
	});

	it("converges after exactly one binding failure after a real user releases the tool round", () => {
		const database = db();
		const sessionId = "pi-binding-converges-once";
		const entryIds = ["u1", "a1", "u2", "a2", "u3", "a3", "tr3", "release"];
		const boundEntries = new Set(["a1", "a2", "a3"]);
		const rejects = (messages: unknown[]) =>
			messages.some(
				(message, index) =>
					boundEntries.has(entryIds[index] ?? "") &&
					JSON.stringify(message).includes('"type":"thinking"'),
			);
		let failures = 0;
		let acceptedBytes: string | null = null;
		for (let attempt = 0; attempt < 6; attempt += 1) {
			const wire = multiAssistantCompletedMessages();
			const applied = applyPiThinkingBindingRecovery({
				db: database,
				sessionId,
				messages: wire,
				entryIds,
				provider: "anthropic",
				model: "claude-opus-5-5",
				report: () => {},
			});
			if (applied)
				clearThinkingBindingRecoveryIf(database, sessionId, applied.flagTarget);
			if (!rejects(wire)) {
				acceptedBytes = JSON.stringify(wire);
				// The open tool round keeps its toolCall; only the invalid thinking goes.
				expect(wire[5]).toMatchObject({
					content: [{ type: "toolCall", id: "call-open" }],
				});
				break;
			}
			failures += 1;
			handlePiProviderFailure({
				db: database,
				sessionId,
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-opus-5-5",
					errorMessage: `400 ${JSON.stringify(LIVE_BINDING_400_BODY)}`,
				},
				report: () => {},
			});
		}
		expect(failures).toBe(1);
		expect(acceptedBytes).not.toBeNull();

		// Later passes replay the persisted strips byte-identically.
		const replay = multiAssistantCompletedMessages();
		expect(
			applyPiThinkingBindingRecovery({
				db: database,
				sessionId,
				messages: replay,
				entryIds,
				provider: "anthropic",
				model: "claude-opus-5-5",
			}),
		).toBeNull();
		expect(JSON.stringify(replay)).toBe(acceptedBytes);
	});

	it("recognises ninfer's prepared-prompt overflow and rejects unrelated errors", () => {
		const database = db();
		const sessionId = "pi-ninfer-overflow";
		const event = handlePiProviderFailure({
			db: database,
			sessionId,
			message: {
				role: "assistant",
				provider: "ninfer",
				model: "qwen3.8-27b",
				errorMessage:
					"AI_APICallError: prepared prompt exceeds Engine max_context 262144",
			},
		});
		expect(event).toMatchObject({ kind: "overflow", reportedLimit: 262144 });
		for (const errorMessage of ["Rate limit exceeded", "Invalid API key"]) {
			expect(
				handlePiProviderFailure({
					db: database,
					sessionId: `${sessionId}-${errorMessage}`,
					message: { role: "assistant", errorMessage },
				}),
			).toEqual({ kind: "none" });
		}
	});

	it("persists a provider overflow limit that the next Pi pass consumes", () => {
		const database = db();
		const sessionId = "pi-provider-overflow-limit";
		const event = handlePiProviderFailure({
			db: database,
			sessionId,
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude-fable-5-1",
				errorMessage:
					"prompt is too long: 70000 tokens > 64000 maximum context length",
			},
		});
		expect(event).toMatchObject({ kind: "overflow", reportedLimit: 64_000 });
		const overflow = getOverflowState(
			database,
			sessionId,
			"anthropic/claude-fable-5-1",
		);
		expect(overflow.detectedContextLimitModelKey).toBe(
			"anthropic/claude-fable-5-1",
		);
		expect(
			resolvePiUsableContextLimit({
				rawContextWindow: 200_000,
				detectedContextLimit: overflow.detectedContextLimit,
			}),
		).toBe(64_000);
	});
});

// Claude Fable 5.1, Opus 5.5 and Sonnet 5.5 bind each thinking block to every byte
// served before it, so a busting pass removes every thinking block still on the
// wire; later passes replay the removal byte-identically, and a defer pass never
// starts one.
describe("Pi proactive strip of thinking on busting passes", () => {
	const ENTRY_IDS = ["u1", "a1", "u2", "a2", "u3", "a3", "tr3", "release"];
	const sha256 = (value: unknown) =>
		createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const thinkingCount = (message: unknown) =>
		(
			(message as { content?: unknown }).content as
				| { type?: string }[]
				| undefined
		)?.filter?.((part) => part.type === "thinking").length ?? 0;

	function session(first = "original first message"): unknown[] {
		const messages = multiAssistantCompletedMessages();
		(messages[0] as { content: string }).content = first;
		return messages;
	}

	function withFreshTurn(messages: unknown[]): {
		messages: unknown[];
		entryIds: string[];
	} {
		return {
			messages: [
				...messages,
				{ role: "user", content: "next", timestamp: 8 },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "fresh", thinkingSignature: "sig-f" },
						{ type: "text", text: "fresh answer" },
					],
					provider: "anthropic",
					model: "claude-opus-5-5",
					timestamp: 9,
				},
			],
			entryIds: [...ENTRY_IDS, "u4", "a4"],
		};
	}

	// Mirrors the end of the context handler: replay persisted strips, then
	// strip everything left on a busting pass.
	function serve(
		database: ReturnType<typeof db>,
		sessionId: string,
		messages: unknown[],
		busting: boolean,
		entryIds: readonly string[] = ENTRY_IDS,
		model = "claude-opus-5-5",
		provider = "anthropic",
	) {
		applyPiThinkingBindingRecovery({
			db: database,
			sessionId,
			messages,
			entryIds,
			provider,
			model,
			endOfPassOrder: true,
		});
		return applyPiProactiveThinkingStrip({
			db: database,
			sessionId,
			messages,
			entryIds,
			provider,
			model,
			cacheBustingPass: busting,
			report: () => {},
		});
	}

	it("strips every block on a busting pass; the next defer pass keeps the shared prefix hash", () => {
		const database = db();
		const sessionId = "pi-proactive-bust";
		serve(database, sessionId, session(), false);

		const passA = session("re-rendered first message");
		expect(serve(database, sessionId, passA, true)).toEqual({
			entryIds: ["a1", "a2", "a3"],
		});
		expect([1, 3, 5].map((index) => thinkingCount(passA[index]))).toEqual([
			0, 0, 0,
		]);
		// The open tool round keeps its tool call.
		expect(passA[5]).toMatchObject({
			content: [{ type: "toolCall", id: "call-open" }],
		});
		expect(getMergedReasoningStrippedIds(database, sessionId)).toEqual(
			new Set([
				"binding_mismatch:a1",
				"binding_mismatch:a2",
				"binding_mismatch:a3",
				"binding_mismatch_order:end",
			]),
		);

		const passB = withFreshTurn(session("re-rendered first message"));
		expect(
			serve(database, sessionId, passB.messages, false, passB.entryIds),
		).toBeNull();
		expect(sha256(passB.messages.slice(0, passA.length))).toBe(sha256(passA));
		expect(thinkingCount(passB.messages.at(-1))).toBe(1);
	});

	for (const [provider, model] of [
		["google-vertex-anthropic", "claude-sonnet-5-5@20260930"],
		["amazon-bedrock", "anthropic.claude-opus-5-5-v1:0"],
	]) {
		it(`recovers a binding 400 via ${provider}`, () => {
			const database = db();
			const sessionId = `pi-cloud-recovery-${provider}`;
			expect(
				handlePiProviderFailure({
					db: database,
					sessionId,
					message: {
						role: "assistant",
						provider,
						model,
						stopReason: "error",
						errorStatus: 400,
						errorMessage: "thinking block is bound to a different conversation",
					},
				}),
			).toEqual({ kind: "thinking_binding", armed: true });
			const messages = session();
			expect(
				applyPiThinkingBindingRecovery({
					db: database,
					sessionId,
					messages,
					entryIds: ENTRY_IDS,
					provider,
					model,
				})?.entryIds,
			).toEqual(["a1", "a2", "a3"]);
			expect([1, 3, 5].map((index) => thinkingCount(messages[index]))).toEqual([
				0, 0, 0,
			]);
		});

		it(`strips on rebuild and replays byte-identically via ${provider}`, () => {
			const database = db();
			const sessionId = `pi-cloud-${provider}`;
			const first = session();
			const before = JSON.stringify(first);
			expect(
				serve(database, sessionId, first, false, ENTRY_IDS, model, provider),
			).toBeNull();
			expect(JSON.stringify(first)).toBe(before);
			const rebuilt = session("rebuilt prefix");
			expect(
				serve(database, sessionId, rebuilt, true, ENTRY_IDS, model, provider),
			).toEqual({
				entryIds: ["a1", "a2", "a3"],
			});
			expect([1, 3, 5].map((index) => thinkingCount(rebuilt[index]))).toEqual([
				0, 0, 0,
			]);
			for (let pass = 0; pass < 2; pass++) {
				const replay = withFreshTurn(session("rebuilt prefix"));
				expect(
					serve(
						database,
						sessionId,
						replay.messages,
						false,
						replay.entryIds,
						model,
						provider,
					),
				).toBeNull();
				expect(JSON.stringify(replay.messages.slice(0, rebuilt.length))).toBe(
					JSON.stringify(rebuilt),
				);
				expect(thinkingCount(replay.messages.at(-1))).toBe(1);
			}
		});
	}

	it("never strips on a defer pass", () => {
		const database = db();
		const sessionId = "pi-proactive-defer";
		serve(database, sessionId, session(), false);
		const pass = session("changed without a bust");
		const before = JSON.stringify(pass);
		expect(serve(database, sessionId, pass, false)).toBeNull();
		expect(JSON.stringify(pass)).toBe(before);
		expect(getMergedReasoningStrippedIds(database, sessionId)).toEqual(
			new Set(),
		);
	});

	it("keeps thinking produced after a strip through busts until a real user releases it", () => {
		const database = db();
		const sessionId = "pi-proactive-multi-pass";
		serve(database, sessionId, session(), true);

		const deferOne = withFreshTurn(session());
		serve(database, sessionId, deferOne.messages, false, deferOne.entryIds);
		const deferTwo = withFreshTurn(session());
		expect(
			serve(database, sessionId, deferTwo.messages, false, deferTwo.entryIds),
		).toBeNull();
		expect(thinkingCount(deferTwo.messages.at(-1))).toBe(1);
		expect(sha256(deferTwo.messages)).toBe(sha256(deferOne.messages));

		const nextBust = withFreshTurn(session());
		expect(
			serve(database, sessionId, nextBust.messages, true, nextBust.entryIds),
		).toBeNull();
		expect(thinkingCount(nextBust.messages.at(-1))).toBe(1);
		nextBust.messages.push({
			role: "user",
			content: "Finish the turn",
			timestamp: 11,
		});
		nextBust.entryIds.push("release-4");
		expect(
			serve(database, sessionId, nextBust.messages, true, nextBust.entryIds),
		).toEqual({ entryIds: ["a4"] });
		expect(thinkingCount(nextBust.messages.at(-2))).toBe(0);
	});

	it("strips nothing and remembers nothing when the frozen set cannot be written", () => {
		const database = db();
		const sessionId = "pi-proactive-persist-failure";
		serve(database, sessionId, session(), false);
		database.exec(
			"CREATE TRIGGER refuse_freeze BEFORE UPDATE OF merged_reasoning_stripped_ids ON session_meta BEGIN SELECT RAISE(FAIL, 'transient freeze write failure'); END",
		);
		const failed = session("re-rendered first message");
		const before = JSON.stringify(failed);
		expect(serve(database, sessionId, failed, true)).toBeNull();
		expect(JSON.stringify(failed)).toBe(before);
		database.exec("DROP TRIGGER refuse_freeze");
		const defer = session("re-rendered first message");
		expect(serve(database, sessionId, defer, false)).toBeNull();
		expect(JSON.stringify(defer)).toBe(before);
		expect(getMergedReasoningStrippedIds(database, sessionId)).toEqual(
			new Set(),
		);
	});

	it("leaves sessions on other models byte-identical", () => {
		const database = db();
		const sessionId = "pi-proactive-other-model";
		const pass = session("re-rendered first message");
		const before = JSON.stringify(pass);
		expect(
			serve(database, sessionId, pass, true, ENTRY_IDS, "claude-opus-4-1"),
		).toBeNull();
		expect(JSON.stringify(pass)).toBe(before);
		expect(getMergedReasoningStrippedIds(database, sessionId)).toEqual(
			new Set(),
		);
	});
});
