import { describe, expect, test } from "bun:test";
import { tokenizePiMessages } from "./tokenize-pi-messages";

/**
 * Regression coverage for the Pi `/ctx-status` Tool Calls bug.
 *
 * Symptom: dialog showed `Tool Calls: 1.1M (650.6%)` on a 162K-token
 * context — mathematically impossible. Root cause: the dialog walked
 * `ctx.sessionManager.getBranch()`, which returns the FULL leaf-to-root
 * path including pre-compaction-marker entries. Those pre-compaction
 * tool calls/results were never tagged (predate the marker), so they
 * couldn't be filtered out of the count.
 *
 * Fix: the pipeline now persists token totals from the post-compaction
 * `event.messages` view (the same one tagger sees), and the dialog
 * reads the persisted value instead of re-walking `getBranch()`.
 *
 * These tests pin the `tokenizePiMessages()` function — the source of
 * truth for what gets persisted. Each test asserts the tool-call vs
 * conversation partitioning matches OpenCode's per-part categorization
 * in `transform.ts:1028-1119`.
 */

describe("tokenizePiMessages", () => {
	test("user text → conversation bucket", () => {
		const counts = tokenizePiMessages([
			{
				role: "user",
				content: [{ type: "text", text: "hello world" }],
			},
		]);
		expect(counts.conversation).toBeGreaterThan(0);
		expect(counts.toolCall).toBe(0);
	});

	test("user content as plain string → conversation bucket", () => {
		// Pi accepts user.content as either an array OR a bare string.
		const counts = tokenizePiMessages([
			{ role: "user", content: "hello world" },
		]);
		expect(counts.conversation).toBeGreaterThan(0);
		expect(counts.toolCall).toBe(0);
	});

	test("assistant thinking → conversation bucket (incl. signature)", () => {
		const counts = tokenizePiMessages([
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "let me consider this",
						thinkingSignature: "sig-block-data",
					},
				],
			},
		]);
		expect(counts.conversation).toBeGreaterThan(0);
		expect(counts.toolCall).toBe(0);
	});

	test("assistant toolCall → toolCall bucket (name + JSON args)", () => {
		const counts = tokenizePiMessages([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_abc",
						name: "read",
						arguments: { path: "/some/file/path.ts" },
					},
				],
			},
		]);
		expect(counts.conversation).toBe(0);
		expect(counts.toolCall).toBeGreaterThan(0);
	});

	test("toolResult role → toolCall bucket (the bulky result body)", () => {
		// The result body dominates the bucket. Real `read` results are
		// often kilobytes. Confirm a reasonable text result lands in
		// toolCall, not conversation. Use varied content because
		// repeated single chars compress unrealistically well under a
		// real BPE tokenizer.
		const bigResult = Array.from(
			{ length: 200 },
			(_, i) => `line ${i}: data ${i * 7}`,
		).join("\n");
		const counts = tokenizePiMessages([
			{
				role: "toolResult",
				toolCallId: "call_abc",
				content: [{ type: "text", text: bigResult }],
			},
		]);
		expect(counts.conversation).toBe(0);
		expect(counts.toolCall).toBeGreaterThan(100);
	});

	test("toolResult with bare-string content → toolCall bucket", () => {
		const counts = tokenizePiMessages([
			{
				role: "toolResult",
				toolCallId: "call_abc",
				content: "result body as string",
			},
		]);
		expect(counts.conversation).toBe(0);
		expect(counts.toolCall).toBeGreaterThan(0);
	});

	test("dropped sentinels tokenize to ~few tokens (NOT the original bulk)", () => {
		// After the pipeline drops a tool tag, the toolResult content is
		// replaced with `[dropped §N§]`. Confirm this tokenizes small —
		// proves the post-strip walk reflects what the LLM actually sees.
		const counts = tokenizePiMessages([
			{
				role: "toolResult",
				toolCallId: "call_abc",
				content: [{ type: "text", text: "[dropped §42§]" }],
			},
		]);
		expect(counts.toolCall).toBeLessThan(20);
	});

	test("mixed conversation + tool I/O → both buckets populated", () => {
		const counts = tokenizePiMessages([
			{ role: "user", content: [{ type: "text", text: "read foo.ts" }] },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "read",
						arguments: { path: "/foo.ts" },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				content: [{ type: "text", text: "file contents here" }],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
			},
		]);
		expect(counts.conversation).toBeGreaterThan(0);
		expect(counts.toolCall).toBeGreaterThan(0);
	});

	test("empty array → both zero (no NaN, no throw)", () => {
		const counts = tokenizePiMessages([]);
		expect(counts.conversation).toBe(0);
		expect(counts.toolCall).toBe(0);
	});

	test("malformed entries are skipped without throwing", () => {
		const counts = tokenizePiMessages([
			null,
			undefined,
			"junk",
			{ role: "assistant" }, // no content
			{ role: "assistant", content: null },
			{ role: "user", content: [null, { type: "text" }] }, // no text field
		] as unknown[]);
		expect(counts.conversation).toBe(0);
		expect(counts.toolCall).toBe(0);
	});

	test("image content → conversation bucket (visual fallback)", () => {
		// Pi image content is base64 without dimensions at this layer;
		// use OpenCode's fallback constant of 1200 tokens per image.
		const counts = tokenizePiMessages([
			{
				role: "user",
				content: [{ type: "image", data: "abc==", mimeType: "image/png" }],
			},
		]);
		expect(counts.conversation).toBe(1200);
		expect(counts.toolCall).toBe(0);
	});

	test("image inside toolResult → toolCall bucket", () => {
		// Tool that returns an image (e.g. screenshot) — the visual
		// tokens should land in the tool bucket, not conversation.
		const counts = tokenizePiMessages([
			{
				role: "toolResult",
				toolCallId: "call_screenshot",
				content: [{ type: "image", data: "xyz==", mimeType: "image/png" }],
			},
		]);
		expect(counts.conversation).toBe(0);
		expect(counts.toolCall).toBe(1200);
	});

	test("toolCall args as pre-stringified JSON → toolCall bucket", () => {
		// Some Pi providers may stringify arguments before storing.
		const counts = tokenizePiMessages([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_pre",
						name: "fetch",
						arguments: '{"url":"https://example.com/api"}',
					},
				],
			},
		]);
		expect(counts.toolCall).toBeGreaterThan(0);
	});
});
