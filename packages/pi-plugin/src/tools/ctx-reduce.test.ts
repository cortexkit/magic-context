/**
 * Regression coverage for the Pi `ctx_reduce` tool.
 *
 * Pin the parity-critical behaviors against OpenCode's
 * `packages/plugin/src/tools/ctx-reduce/tools.ts`:
 *
 *   1. Range parsing accepts comma-separated and dash ranges
 *   2. Unknown tag IDs are rejected
 *   3. Compaction-survivor tags are rejected
 *   4. Protected-tag deferral
 *   5. Idempotent dedup of already-queued / already-dropped IDs
 *
 * These contracts must not regress — agents rely on the exact response
 * messaging to know which drops are immediate vs deferred.
 */

import { describe, expect, it } from "bun:test";
import {
	getPendingOps,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	insertTag,
	markWhitespaceAssistantTagInert,
	updateTagStatus,
	updateTagTokenCount,
} from "@magic-context/core/features/magic-context/storage-tags";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestDb, fakeContext } from "../test-utils.test";
import { createCtxReduceTool } from "./ctx-reduce";

function seedTags(
	db: ReturnType<typeof createTestDb>,
	sessionId: string,
	specs: Array<{
		tagNumber: number;
		messageId: string;
		status?: "active" | "dropped" | "compacted";
	}>,
): void {
	for (const spec of specs) {
		insertTag(db, sessionId, spec.messageId, "text", 100, spec.tagNumber);
		if (spec.status && spec.status !== "active") {
			updateTagStatus(db, sessionId, spec.tagNumber, spec.status);
		}
	}
	updateSessionMeta(db, sessionId, { counter: specs.length });
}

async function callDrop(args: {
	db: ReturnType<typeof createTestDb>;
	sessionId: string;
	drop: string;
	protectedTags?: number;
	floor?: number;
	protectedTokens?: number;
}) {
	const tool = createCtxReduceTool({
		db: args.db,
		protectedTags: args.protectedTags,
		floor: args.floor,
		protectedTokens: args.protectedTokens,
	});
	const result = await tool.execute(
		"call-1",
		{ drop: args.drop },
		new AbortController().signal,
		undefined,
		fakeContext(args.sessionId) as never,
	);
	const text = (result.content[0] as { text: string }).text;
	return { result, text, isError: result.isError === true };
}

describe("Pi ctx_reduce tool", () => {
	it("queues a drop for a known active tag", async () => {
		const db = createTestDb();
		const sessionId = "ses-reduce-1";
		seedTags(db, sessionId, [
			{ tagNumber: 1, messageId: "m1" },
			{ tagNumber: 2, messageId: "m2" },
			{ tagNumber: 3, messageId: "m3" },
		]);

		const { isError, text } = await callDrop({
			db,
			sessionId,
			drop: "2",
		});
		expect(isError).toBe(false);
		expect(text).toContain("Queued");
		expect(text).toContain("§2§");

		const ops = getPendingOps(db, sessionId);
		expect(ops).toHaveLength(1);
		expect(ops[0].operation).toBe("drop");
		expect(ops[0].tagId).toBe(2);
	});

	it("parses comma + dash ranges (3-5,7,9 → [3,4,5,7,9])", async () => {
		const db = createTestDb();
		const sessionId = "ses-reduce-range";
		seedTags(
			db,
			sessionId,
			[3, 4, 5, 7, 9].map((n) => ({ tagNumber: n, messageId: `m${n}` })),
		);

		const { isError } = await callDrop({
			db,
			sessionId,
			drop: "3-5,7,9",
		});
		expect(isError).toBe(false);

		const ops = getPendingOps(db, sessionId);
		const dropped = ops
			.filter((op) => op.operation === "drop")
			.map((op) => op.tagId)
			.sort((a, b) => a - b);
		expect(dropped).toEqual([3, 4, 5, 7, 9]);
	});

	it("rejects unknown tag IDs with a clear error", async () => {
		const db = createTestDb();
		const sessionId = "ses-reduce-unknown";
		seedTags(db, sessionId, [{ tagNumber: 1, messageId: "m1" }]);

		const { isError, text } = await callDrop({
			db,
			sessionId,
			drop: "1,42",
		});
		expect(isError).toBe(true);
		expect(text).toContain("Unknown tag");
		expect(text).toContain("§42§");

		// Nothing was queued — fail-closed semantics.
		expect(getPendingOps(db, sessionId)).toHaveLength(0);
	});

	it("rejects compaction-survivor tags with conflict error", async () => {
		const db = createTestDb();
		const sessionId = "ses-reduce-compacted";
		seedTags(db, sessionId, [
			{ tagNumber: 1, messageId: "m1", status: "compacted" },
			{ tagNumber: 2, messageId: "m2" },
		]);

		const { isError, text } = await callDrop({
			db,
			sessionId,
			drop: "1,2",
		});
		expect(isError).toBe(true);
		expect(text).toContain("from before compaction");
		expect(getPendingOps(db, sessionId)).toHaveLength(0);
	});

	it("acknowledges an inert whitespace tag without queueing it", async () => {
		const db = createTestDb();
		const sessionId = "ses-reduce-inert";
		seedTags(db, sessionId, [{ tagNumber: 7, messageId: "assistant:p0" }]);
		db.prepare("UPDATE tags SET type = 'message' WHERE session_id = ?").run(
			sessionId,
		);
		markWhitespaceAssistantTagInert(db, sessionId, 7, "assistant:p0");

		const { isError, text } = await callDrop({ db, sessionId, drop: "7" });

		expect(isError).toBe(false);
		expect(text).toContain("§7§ is provider framing, nothing to reclaim");
		expect(getPendingOps(db, sessionId)).toEqual([]);
	});

	it("skips inert whitespace inside a range while queueing every live tag", async () => {
		const db = createTestDb();
		const sessionId = "ses-reduce-inert-range";
		seedTags(db, sessionId, [
			{ tagNumber: 6, messageId: "m6" },
			{ tagNumber: 7, messageId: "assistant:p0" },
			{ tagNumber: 8, messageId: "m8" },
		]);
		db.prepare(
			"UPDATE tags SET type = 'message' WHERE session_id = ? AND tag_number = 7",
		).run(sessionId);
		markWhitespaceAssistantTagInert(db, sessionId, 7, "assistant:p0");

		const { isError, text } = await callDrop({ db, sessionId, drop: "6-8" });

		expect(isError).toBe(false);
		expect(text).toContain("drop §6§, §8§");
		expect(text).toContain("§7§ is provider framing, nothing to reclaim");
		expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toEqual([6, 8]);
	});

	it("treats already-dropped + already-queued IDs as idempotent (no error, no double-queue)", async () => {
		const db = createTestDb();
		const sessionId = "ses-reduce-idem";
		seedTags(db, sessionId, [
			{ tagNumber: 1, messageId: "m1", status: "dropped" },
			{ tagNumber: 2, messageId: "m2" },
		]);
		queuePendingOp(db, sessionId, 2, "drop", Date.now());

		const { isError, text } = await callDrop({
			db,
			sessionId,
			drop: "1,2",
		});
		expect(isError).toBe(false);
		expect(text.toLowerCase()).toContain("already");

		// Still exactly one pending op — no duplicate.
		const ops = getPendingOps(db, sessionId);
		expect(ops).toHaveLength(1);
		expect(ops[0].tagId).toBe(2);
	});

	it("defers protected-tag drops with explicit 'deferred drop' messaging", async () => {
		const db = createTestDb();
		const sessionId = "ses-reduce-protected";
		// 5 active tags. With protectedTags=2, the most recent 2 (tags 4 & 5)
		// are protected — drops of those land as deferred.
		seedTags(db, sessionId, [
			{ tagNumber: 1, messageId: "m1" },
			{ tagNumber: 2, messageId: "m2" },
			{ tagNumber: 3, messageId: "m3" },
			{ tagNumber: 4, messageId: "m4" },
			{ tagNumber: 5, messageId: "m5" },
		]);

		const { isError, text } = await callDrop({
			db,
			sessionId,
			drop: "1,4",
			protectedTags: 2,
		});
		expect(isError).toBe(false);
		expect(text).toContain("drop §1§");
		expect(text).toContain("deferred drop §4§");
	});

	it("rejects empty or missing drop string", async () => {
		const db = createTestDb();
		const sessionId = "ses-reduce-empty";
		seedTags(db, sessionId, [{ tagNumber: 1, messageId: "m1" }]);

		const tool = createCtxReduceTool({ db, protectedTags: 0 });
		const result = await tool.execute(
			"call-1",
			{},
			new AbortController().signal,
			undefined,
			fakeContext(sessionId) as never,
		);
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain(
			"'drop' must",
		);
	});

	it("derives protectedSet from shared protection window for tool tags", async () => {
		const db = createTestDb();
		const sessionId = "ses-reduce-window";
		try {
			for (let i = 1; i <= 5; i++) {
				insertTag(db, sessionId, `m${i}`, "tool", 4000, i);
				updateTagTokenCount(db, sessionId, i, 4000);
			}
			// Floor 16,000 with 5 tags each 4,000:
			// Tags 5 (4k), 4 (8k), 3 (12k), 2 (16k) are protected -> protectedSet {2, 3, 4, 5}.
			// Tag 1 is not protected.
			const { isError, text } = await callDrop({
				db,
				sessionId,
				drop: "1,4",
				floor: 16_000,
			});
			expect(isError).toBe(false);
			expect(text).toContain("drop §1§");
			expect(text).toContain("deferred drop §4§");
		} finally {
			closeQuietly(db);
		}
	});

	it("applies empty-window behavior (F8): empty protectedSet, drops are immediate", async () => {
		const db = createTestDb();
		const sessionId = "ses-reduce-f8";
		try {
			// Variant (b): non-tool tags, 0 tool tags
			for (let i = 1; i <= 3; i++) {
				insertTag(db, sessionId, `m${i}`, "message", 500, i);
			}
			const { isError, text } = await callDrop({
				db,
				sessionId,
				drop: "1,2",
				floor: 16_000,
			});
			expect(isError).toBe(false);
			// Both dropped immediately, nothing deferred
			expect(text).toContain("drop §1§, §2§");
			expect(text).not.toContain("deferred drop");
		} finally {
			closeQuietly(db);
		}
	});
});
