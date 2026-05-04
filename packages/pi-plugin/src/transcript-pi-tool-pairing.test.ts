/**
 * Regression test for the assistant `toolCall` ↔ `toolResult` pairing
 * preservation through `replaceWithSentinel`.
 *
 * Bug history: an earlier version of `createPiAssistantPart.replaceWithSentinel`
 * replaced the entire toolCall part with `{ type: "text", text: "[dropped §N§]" }`,
 * destroying the `id` field. The corresponding `toolResult` message
 * (separate role, separate `toolCallId`) then became orphaned, and Codex
 * rejected the request with:
 *
 *   `Error: No tool call found for function call output with call_id call_…`
 *
 * (Anthropic produces a similarly fatal "tool_use blocks must be followed by
 * matching tool_result blocks" error in the same scenario.)
 *
 * The fix preserves the toolCall structural shape — `{ type: "toolCall", id,
 * name, arguments }` — and only replaces `arguments` with a tiny sentinel
 * marker. The provider serializer still emits a `function_call` / `tool_use`
 * block with the original `call_id`, the toolResult message stays paired,
 * and the API accepts the request.
 */

import { describe, expect, it } from "bun:test";
import { createPiTranscript } from "./transcript-pi";

describe("transcript-pi tool pairing preservation", () => {
	it("preserves toolCall.id when replaceWithSentinel is called on an assistant tool part", () => {
		const messages = [
			{ role: "user", content: "do a thing", timestamp: 1000 },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "I'll read a file." },
					{
						type: "toolCall",
						id: "call_abc123",
						name: "mcp_read",
						arguments: { path: "/tmp/big.txt" },
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-4-5",
				usage: {
					input: 100,
					output: 10,
					cacheRead: 0,
					cacheWrite: 100,
					totalTokens: 210,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2000,
			},
			{
				role: "toolResult",
				toolCallId: "call_abc123",
				toolName: "mcp_read",
				content: [{ type: "text", text: "...500KB of file content..." }],
				isError: false,
				timestamp: 3000,
			},
		];

		const transcript = createPiTranscript(messages, "ses_pair_test");

		// Find the assistant's tool_use part and call drop()/replaceWithSentinel
		// on it (mirrors what tag-driven heuristic cleanup does in production).
		const assistantMsg = transcript.messages[1];
		expect(assistantMsg).toBeDefined();
		const toolUsePart = assistantMsg.parts.find((p) => p.kind === "tool_use");
		expect(toolUsePart).toBeDefined();
		expect(toolUsePart?.id).toBe("call_abc123");

		// This is the call path heuristic-cleanup uses through the TagTarget.drop()
		// indirection; we exercise it directly here.
		const replaced = toolUsePart?.replaceWithSentinel("[dropped §42§]");
		expect(replaced).toBe(true);

		transcript.commit();
		const out = transcript.getOutputMessages();

		// 1. The assistant message still exists and still has a toolCall part
		//    with the same id and name. This is the API-level requirement —
		//    Codex/Anthropic match `tool_use.id` with `tool_result.toolCallId`.
		const outAssistant = out[1] as {
			content: Array<{ type: string; id?: string; name?: string }>;
		};
		const outToolCall = outAssistant.content.find((p) => p.type === "toolCall");
		expect(outToolCall).toBeDefined();
		expect(outToolCall?.id).toBe("call_abc123");
		expect(outToolCall?.name).toBe("mcp_read");

		// 2. The toolResult message is unchanged in role/toolCallId — pairing
		//    intact for the provider serializer.
		const outToolResult = out[2] as {
			role: string;
			toolCallId: string;
		};
		expect(outToolResult.role).toBe("toolResult");
		expect(outToolResult.toolCallId).toBe("call_abc123");
	});

	it("preserves the toolCall sentinel arguments shape so the bulk content shrinks", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_xyz",
						name: "mcp_read",
						arguments: {
							path: "/tmp/very-long-path-that-takes-real-space.txt",
							something: "x".repeat(10_000),
						},
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-4-5",
				usage: {
					input: 100,
					output: 10,
					cacheRead: 0,
					cacheWrite: 100,
					totalTokens: 210,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2000,
			},
		];

		const transcript = createPiTranscript(messages, "ses_shrink_test");
		const part = transcript.messages[0].parts.find(
			(p) => p.kind === "tool_use",
		);
		expect(part?.replaceWithSentinel("[dropped §1§]")).toBe(true);
		transcript.commit();

		const out = transcript.getOutputMessages();
		const outAssistant = out[0] as {
			content: Array<{
				type: string;
				id?: string;
				name?: string;
				arguments?: Record<string, unknown>;
			}>;
		};
		const outCall = outAssistant.content[0];
		expect(outCall.type).toBe("toolCall");
		expect(outCall.id).toBe("call_xyz");
		expect(outCall.name).toBe("mcp_read");
		// arguments are reduced to the sentinel marker — bulk gone.
		expect(outCall.arguments).toEqual({
			__magic_context_dropped__: "[dropped §1§]",
		});
		// The full original args do NOT survive.
		expect(JSON.stringify(outCall.arguments).length).toBeLessThan(200);
	});

	it("falls back to plain text-sentinel for non-toolCall assistant parts", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "long text content".repeat(1000) },
					{ type: "thinking", thinking: "private thoughts" },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-4-5",
				usage: {
					input: 50,
					output: 0,
					cacheRead: 0,
					cacheWrite: 50,
					totalTokens: 100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1000,
			},
		];

		const transcript = createPiTranscript(messages, "ses_text_sentinel");
		const textPart = transcript.messages[0].parts.find(
			(p) => p.kind === "text",
		);
		expect(textPart?.replaceWithSentinel("[dropped §3§]")).toBe(true);
		transcript.commit();

		const out = transcript.getOutputMessages();
		const outAssistant = out[0] as {
			content: Array<{ type: string; text?: string }>;
		};
		expect(outAssistant.content[0]).toEqual({
			type: "text",
			text: "[dropped §3§]",
		});
	});
});
