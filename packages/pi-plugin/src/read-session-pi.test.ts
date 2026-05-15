/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { convertEntriesToRawMessages, isMidTurnPi } from "./read-session-pi";

describe("isMidTurnPi", () => {
	it("is mid-turn when the latest assistant stopReason is toolUse", () => {
		expect(
			isMidTurnPi(
				{
					messages: [{ role: "assistant", stopReason: "toolUse", content: [] }],
				},
				"session-1",
			),
		).toBe(true);
	});

	it("is mid-turn when the latest assistant has an unpaired toolCall", () => {
		expect(
			isMidTurnPi(
				{
					messages: [
						{
							role: "assistant",
							content: [{ type: "toolCall", id: "call-1", name: "bash" }],
						},
					],
				},
				"session-1",
			),
		).toBe(true);
	});

	it("is not mid-turn when toolCall content is paired or absent", () => {
		expect(
			isMidTurnPi(
				{
					messages: [
						{
							role: "assistant",
							content: [{ type: "toolCall", id: "call-1", name: "bash" }],
						},
						{ role: "toolResult", toolCallId: "call-1", content: [] },
					],
				},
				"session-1",
			),
		).toBe(false);

		expect(
			isMidTurnPi(
				{
					messages: [
						{ role: "assistant", content: [{ type: "text", text: "done" }] },
					],
				},
				"session-1",
			),
		).toBe(false);
	});
});

describe("convertEntriesToRawMessages: synthetic-user entry-id propagation", () => {
	// Regression coverage for the cortexkit/magic-context X1+X2 production
	// bugs. Pi sessions with many `toolResult → assistant` transitions emit
	// synthetic user RawMessages. The original implementation set those
	// synthetic users' `id` to `""`, which broke two downstream consumers:
	//
	//   - read-session-chunk.ts:345 puts `messageId: msg.id` into
	//     `chunk.lines`. When the chunk's final ordinal lands on a synthetic
	//     user, `mapParsedCompartmentsToChunk` populates `endMessageId = ""`
	//     on the published compartment, breaking the magic-context
	//     boundary-trim path. (Bug X2)
	//   - pi-historian-runner.ts:findFirstKeptEntryId walks raw
	//     SessionEntries with its own counter that skips synthetics
	//     entirely, never reaching the historian's `lastCompactedOrdinal`.
	//     It returns null, `appendCompaction` is silently skipped, the
	//     JSONL grows unbounded, and Pi/Codex eventually rejects the wire
	//     payload with context_length_exceeded. (Bug X1)
	//
	// Fix: synthetic users now carry the FIRST folded toolResult's entry id
	// as `RawMessage.id`. That id is always a real, lookup-able SessionEntry
	// id, so chunk.lines and compaction-marker placement both work
	// correctly. findFirstKeptEntryId now delegates to
	// convertEntriesToRawMessages so the two ordinal counters can't diverge.

	function messageEntry(
		id: string,
		message: Record<string, unknown>,
	): Record<string, unknown> {
		return { type: "message", id, message };
	}

	it("assigns the first folded toolResult's id to a synthetic user emitted at toolResult→assistant", () => {
		const entries = [
			messageEntry("user-1", { role: "user", content: "kick off" }),
			messageEntry("asst-1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-1", name: "read" }],
			}),
			messageEntry("tr-1", {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: "output-1" }],
			}),
			// toolResult → assistant: synthetic user gets emitted here
			messageEntry("asst-2", {
				role: "assistant",
				content: [{ type: "text", text: "follow-up" }],
			}),
		];

		const raws = convertEntriesToRawMessages(entries);

		// Expected ordinal layout:
		//   1: user-1 (real)
		//   2: asst-1 (real)
		//   3: synthetic user folding tr-1 — MUST carry tr-1's id
		//   4: asst-2 (real)
		expect(
			raws.map((r) => ({ ordinal: r.ordinal, id: r.id, role: r.role })),
		).toEqual([
			{ ordinal: 1, id: "user-1", role: "user" },
			{ ordinal: 2, id: "asst-1", role: "assistant" },
			{ ordinal: 3, id: "tr-1", role: "user" },
			{ ordinal: 4, id: "asst-2", role: "assistant" },
		]);
	});

	it("assigns the first folded toolResult's id when multiple toolResults stack before an assistant", () => {
		const entries = [
			messageEntry("user-1", { role: "user", content: "start" }),
			messageEntry("asst-1", {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "tc-1", name: "read" },
					{ type: "toolCall", id: "tc-2", name: "read" },
				],
			}),
			messageEntry("tr-1", {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: "out-1" }],
			}),
			messageEntry("tr-2", {
				role: "toolResult",
				toolCallId: "tc-2",
				toolName: "read",
				content: [{ type: "text", text: "out-2" }],
			}),
			// stacked tr-1, tr-2 fold into synthetic user at this transition
			messageEntry("asst-2", { role: "assistant", content: [] }),
		];

		const raws = convertEntriesToRawMessages(entries);
		const synthetic = raws[2];
		expect(synthetic?.ordinal).toBe(3);
		expect(synthetic?.role).toBe("user");
		// First folded toolResult wins — never empty.
		expect(synthetic?.id).toBe("tr-1");
	});

	it("assigns the first folded toolResult's id to a trailing-tail synthetic user", () => {
		const entries = [
			messageEntry("user-1", { role: "user", content: "start" }),
			messageEntry("asst-1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-1", name: "read" }],
			}),
			messageEntry("tr-tail", {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: "tail" }],
			}),
			// No following user/assistant — trailing tail synthetic emits
		];

		const raws = convertEntriesToRawMessages(entries);
		const tail = raws[raws.length - 1];
		expect(tail?.ordinal).toBe(3);
		expect(tail?.role).toBe("user");
		expect(tail?.id).toBe("tr-tail");
	});

	it("clears pending state after a real user folds toolResults", () => {
		// Real user message folds toolResults — no synthetic should emit.
		// The pending state must reset so a LATER synthetic point doesn't
		// reuse a stale toolResult id.
		const entries = [
			messageEntry("asst-1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-1", name: "read" }],
			}),
			messageEntry("tr-1", {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: "x" }],
			}),
			messageEntry("real-user", { role: "user", content: "next" }),
			messageEntry("asst-2", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-2", name: "read" }],
			}),
			messageEntry("tr-2", {
				role: "toolResult",
				toolCallId: "tc-2",
				toolName: "read",
				content: [{ type: "text", text: "y" }],
			}),
			messageEntry("asst-3", { role: "assistant", content: [] }),
		];

		const raws = convertEntriesToRawMessages(entries);
		// Expected:
		//   1: asst-1
		//   2: real-user (folds tr-1)        — id="real-user", NOT "tr-1"
		//   3: asst-2
		//   4: synthetic user folding tr-2   — id="tr-2"
		//   5: asst-3
		expect(
			raws.map((r) => ({ ordinal: r.ordinal, id: r.id, role: r.role })),
		).toEqual([
			{ ordinal: 1, id: "asst-1", role: "assistant" },
			{ ordinal: 2, id: "real-user", role: "user" },
			{ ordinal: 3, id: "asst-2", role: "assistant" },
			{ ordinal: 4, id: "tr-2", role: "user" },
			{ ordinal: 5, id: "asst-3", role: "assistant" },
		]);
	});

	it("reproduces the user-session ordinal divergence: every RawMessage has a non-empty id", () => {
		// Build a branch that mirrors the user's stuck session pattern:
		// alternating assistant → toolResult → assistant transitions
		// produce a flood of synthetic users. Each synthetic must carry
		// the folded toolResult's id; no RawMessage may have id="".
		//
		// Pattern: kickoff user, then 50 cycles of
		//   assistant(toolCall) → toolResult → assistant(toolCall) → toolResult → ...
		// terminated by a final assistant. This is structurally identical
		// to a tool-heavy autonomous run where the agent fires tools, sees
		// results, and immediately fires more without user input.
		const entries: Array<Record<string, unknown>> = [
			messageEntry("u-0", { role: "user", content: "go" }),
		];
		for (let i = 1; i <= 50; i++) {
			entries.push(
				messageEntry(`a-${i}`, {
					role: "assistant",
					content: [{ type: "toolCall", id: `tc-${i}`, name: "read" }],
				}),
				messageEntry(`tr-${i}`, {
					role: "toolResult",
					toolCallId: `tc-${i}`,
					toolName: "read",
					content: [{ type: "text", text: `out-${i}` }],
				}),
			);
		}
		entries.push(
			messageEntry("a-final", {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
			}),
		);

		const raws = convertEntriesToRawMessages(entries);

		// Every RawMessage must carry a non-empty id, including synthetics.
		// Pre-fix this assertion failed because synthetic-user emissions
		// at every toolResult→assistant transition had id="".
		const empties = raws.filter((r) => !r.id || r.id.length === 0);
		expect(empties).toEqual([]);

		// Ordinals are contiguous from 1.
		const ordinals = raws.map((r) => r.ordinal);
		expect(ordinals[0]).toBe(1);
		for (let i = 1; i < ordinals.length; i++) {
			const prev = ordinals[i - 1] ?? 0;
			const cur = ordinals[i] ?? 0;
			expect(cur).toBe(prev + 1);
		}

		// 50 synthetic users (toolResult→assistant transitions) emitted,
		// each carrying its first folded toolResult's id.
		const syntheticUsers = raws.filter(
			(r, idx) =>
				r.role === "user" &&
				idx > 0 &&
				raws[idx - 1] !== undefined &&
				raws[idx - 1]?.role === "assistant" &&
				r.id.startsWith("tr-"),
		);
		expect(syntheticUsers.length).toBe(50);
	});
});
