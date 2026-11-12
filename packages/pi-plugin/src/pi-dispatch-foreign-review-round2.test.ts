/**
 * Second-round review witnesses for the Oh My Pi foreign-row allowance, written
 * against commit ca33c30005 (ordered anchors and the lazy whole-session index).
 * The native-block and search cases originally failed against that commit.
 * The final case pins the deliberate first-index observation boundary instead
 * of requiring history indexing on matching requests. The findings are in
 * .cortexkit/internal-docs/audits/omp-foreign-rows-review.md (second section).
 */
import { describe, expect, test } from "bun:test";
import { piCheckPreparedDispatch } from "./pi-dispatch-acceptance";
import {
	createPiForeignSessionIndex,
	piForeignEvidence,
	piProtectPreparedRows,
	piWithoutForeignRows,
} from "./pi-dispatch-foreign";
import {
	type PiDispatchAlignedRow,
	piDispatchRowCount,
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";

const api = "anthropic-messages";
const model = { api, provider: "test", id: "test" };
const user = (text: string) => ({ role: "user", content: text });
const foreign = user(
	"<EXTREMELY_IMPORTANT>\nbootstrap inserted by another extension\n</EXTREMELY_IMPORTANT>",
);
const payload = (messages: unknown[]) => ({
	system: [{ type: "text", text: "system" }],
	max_tokens: 100,
	messages,
});
const entries = (messages: readonly Record<string, unknown>[]) =>
	messages.map((message, index) => ({
		type: "message",
		id: `e${index}`,
		parentId: index ? `e${index - 1}` : null,
		message,
	}));

describe("evidence for assistant block kinds Oh My Pi persists", () => {
	// @oh-my-pi/pi-ai 18.18.x types.ts AssistantMessage.content includes
	// AnthropicFallbackContent ("fallback": a server-side model switch marker)
	// and AnthropicServerToolContent ("anthropicServerTool": a retained web-search
	// or tool-search call/result). Both are persisted on assistant turns. Neither
	// carries text the session index must protect beyond its own fields, so a
	// session that contains one must not lose the allowance for good.
	for (const [kind, block] of [
		[
			"an Anthropic server-tool (web search) block",
			{
				type: "anthropicServerTool",
				block: {
					type: "server_tool_use",
					id: "srvtoolu_1",
					name: "web_search",
					input: { query: "release notes" },
				},
			},
		],
		[
			"an Anthropic server-side fallback marker",
			{
				type: "fallback",
				from: { model: "claude-a" },
				to: { model: "claude-b" },
			},
		],
	] as const)
		test(`an earlier assistant turn with ${kind} keeps the allowance on`, () => {
			const earlier = {
				role: "assistant",
				api,
				provider: "test",
				model: "test",
				timestamp: 1,
				stopReason: "stop",
				content: [block, { type: "text", text: "earlier answer" }],
			};
			const raw = [
				{ role: "user", content: "first session prompt", timestamp: 2 },
				{
					role: "assistant",
					api,
					provider: "test",
					model: "test",
					timestamp: 3,
					stopReason: "stop",
					content: [{ type: "text", text: "answer" }],
				},
				{ role: "user", content: "latest session prompt", timestamp: 4 },
			];
			const managed = [
				{ ...raw[0], content: "§1§ first session prompt" },
				raw[1],
				{ ...raw[2], content: "§3§ latest session prompt" },
			];
			const prepared = piPreparedStructure(managed, model, "omp");
			// The earlier turn was cut by Magic Context: it is in the session's
			// entries but not in the handler's input or the prepared rows.
			const evidence = piForeignEvidence(
				{ getEntries: () => entries([earlier, ...raw]) },
				raw,
			);
			piProtectPreparedRows(evidence, managed, prepared);
			const wire = [
				user("§1§ first session prompt"),
				{ role: "assistant", content: [{ type: "text", text: "answer" }] },
				user("§3§ latest session prompt"),
			];
			// Control: the base comparator accepts the managed turn.
			expect(piPreparedStructureMismatch(payload(wire), prepared)).toBe(
				undefined,
			);
			expect(
				piCheckPreparedDispatch(payload([foreign, ...wire]), prepared, evidence)
					.mismatch ?? "accepted",
			).toBe("accepted");
		});
});

describe("deletion-set search", () => {
	// The search tries every set of up to four candidate rows and runs the full
	// provider comparator for each (pi-dispatch-foreign.ts piWithoutForeignRows).
	// With n candidates and no set that fits, that is C(n,1)+…+C(n,4) comparator
	// runs, synchronously inside Oh My Pi's before_provider_request hook.
	test("a request with many added rows is refused after a bounded number of comparator runs", () => {
		const raw = [
			{ role: "user", content: "first session prompt", timestamp: 1 },
			{
				role: "assistant",
				api,
				provider: "test",
				model: "test",
				timestamp: 2,
				stopReason: "stop",
				content: [{ type: "text", text: "answer" }],
			},
			{ role: "user", content: "latest session prompt", timestamp: 3 },
		];
		const managed = [
			{ ...raw[0], content: "§1§ first session prompt" },
			raw[1],
			{ ...raw[2], content: "§3§ latest session prompt" },
		];
		const prepared = piPreparedStructure(managed, model, "omp");
		const evidence = piForeignEvidence(
			{ getEntries: () => entries(raw) },
			raw,
			createPiForeignSessionIndex(),
		);
		piProtectPreparedRows(evidence, managed, prepared);
		// An extension that adds one short row per item it wants the model to
		// see (rules, open files, memories): 30 rows, well past the 4-row bound.
		const added = Array.from({ length: 30 }, (_, i) =>
			user(`extension note ${i}`),
		);
		const wire = [
			...added,
			user("§1§ first session prompt"),
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
			user("§3§ latest session prompt"),
		];
		// Same callbacks as piCheckPreparedDispatch, counting comparator runs.
		// After a fixed number of real runs the counter stops delegating so the
		// test stays fast; every further call is still a run production makes.
		let runs = 0;
		const result = piWithoutForeignRows(
			payload(wire),
			evidence,
			(prefix) => piDispatchRowCount(prefix, prepared),
			(filtered) => {
				runs++;
				if (runs > 500) return undefined;
				let alignment: readonly PiDispatchAlignedRow[] | undefined;
				return piPreparedStructureMismatch(
					filtered,
					prepared,
					undefined,
					(rows) => {
						alignment = rows;
					},
				)
					? undefined
					: alignment;
			},
		);
		expect(result.payload).toBeUndefined();
		expect(result.reason).toBe("limit");
		// 30 candidates give 31,930 runs today. Any bound that does not grow
		// combinatorially with the number of candidate rows passes.
		expect(runs).toBeLessThanOrEqual(256);
	});
});

describe("session rendering protection starts at first index use in the process", () => {
	// The index is built only when a dispatch mismatches and has candidate rows.
	// Oh My Pi prunes tool output in place and persists it (rewriteEntries), so a
	// rendering that changed before the first such dispatch is never fingerprinted.
	test("a pre-index rendering is not protected, but an observed rendering survives a later in-place prune", () => {
		const original = `long tool output that the session produced earlier ${"x".repeat(200)}`;
		const result = {
			role: "toolResult",
			toolCallId: "call_read",
			toolName: "read",
			timestamp: 3,
			content: [{ type: "text", text: original }],
		};
		const raw = [
			{ role: "user", content: "first session prompt", timestamp: 1 },
			{
				role: "assistant",
				api,
				provider: "test",
				model: "test",
				timestamp: 2,
				stopReason: "toolUse",
				content: [
					{ type: "toolCall", id: "call_read", name: "read", arguments: {} },
				],
			},
			result,
			{ role: "user", content: "latest session prompt", timestamp: 4 },
		];
		const managed = [
			{ ...raw[0], content: "§1§ first session prompt" },
			raw[1],
			raw[2],
			{ ...raw[3], content: "§4§ latest session prompt" },
		];
		const prepared = piPreparedStructure(managed, model, "omp");
		const index = createPiForeignSessionIndex();
		const source = { getEntries: () => entries(raw) };
		const wire = (text: string) => [
			user("§1§ first session prompt"),
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "call_read", name: "read", input: {} },
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call_read", content: text },
				],
			},
			user("§4§ latest session prompt"),
		];
		const dispatch = (messages: unknown[]) => {
			const evidence = piForeignEvidence(source, raw, index);
			piProtectPreparedRows(evidence, managed, prepared);
			return (
				piCheckPreparedDispatch(payload(messages), prepared, evidence)
					.mismatch ?? "accepted"
			);
		};
		// A pass whose request matches: no foreign row, so no index work.
		expect(dispatch(wire(original))).toBe("accepted");
		// Oh My Pi's stale-result eviction rewrites the entry in place.
		result.content[0].text = "[Stale result elided - 1200 tokens]";
		(result as Record<string, unknown>).prunedAt = 5;
		// Another extension now re-inserts the original output as a user row.
		expect(
			dispatch([
				user(original),
				...wire("[Stale result elided - 1200 tokens]"),
			]),
		).toBe("accepted");
		// Matching passes deliberately did not index history. Observe the original
		// rendering now, then repeat the same host edit after the index exists.
		result.content[0].text = original;
		expect(dispatch([foreign, ...wire(original)])).toBe("accepted");
		result.content[0].text = "[Stale result elided - 1200 tokens]";
		expect(
			dispatch([user(original), ...wire(result.content[0].text)]),
		).toContain("session-content");
	});
});
