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
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage-tags";
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
}) {
	const tool = createCtxReduceTool({
		db: args.db,
		protectedTags: args.protectedTags ?? 0,
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
});
