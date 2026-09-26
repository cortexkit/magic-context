import { afterEach, describe, expect, it } from "bun:test";
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

// Three assistants whose thinking was signed before a prefix edit. The newest
// one called a tool whose result is the pending continuation.
function multiAssistantOpenToolMessages(): unknown[] {
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

	it("converges after exactly one binding failure, including an open tool round", () => {
		const database = db();
		const sessionId = "pi-binding-converges-once";
		const entryIds = ["u1", "a1", "u2", "a2", "u3", "a3", "tr3"];
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
			const wire = multiAssistantOpenToolMessages();
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
		const replay = multiAssistantOpenToolMessages();
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
