import { afterEach, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	addMergedReasoningStrippedIds,
	getMergedReasoningStrippedIds,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	applyPiProactiveThinkingStrip,
	applyPiThinkingBindingRecovery,
	resolvePiBindingStripOrder,
	shouldRunPiProactiveThinkingStrip,
} from "./provider-error-recovery-pi";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

const assistant = (content: object[]) => ({ role: "assistant", content });
const thinking = () => ({
	type: "thinking",
	thinking: "signed",
	thinkingSignature: "signature",
});
const toolCall = () => ({
	type: "toolCall",
	id: "call-1",
	name: "bash",
	arguments: {},
});
const toolResult = () => ({
	role: "toolResult",
	toolCallId: "call-1",
	content: [{ type: "text", text: "ok" }],
});
const ids = ["assistant-1", "result-1", "assistant-2", "next-user"];
const input = () => [
	assistant([thinking(), toolCall()]),
	toolResult(),
	assistant([thinking()]),
	{ role: "user", content: [{ type: "text", text: "Next real turn" }] },
];

it("replays strip-all across independent connections, restart, and undo with the same entry ids", () => {
	const root = createTestTempDirFromPath(join(tmpdir(), "mc-strip-gate-"));
	roots.push(root);
	const path = join(root, "context.db");
	const first = new Database(path);
	initializeDatabase(first);
	const second = new Database(path);
	try {
		const wireA = input();
		expect(
			applyPiProactiveThinkingStrip({
				db: first,
				sessionId: "shared",
				messages: wireA,
				entryIds: ids,
				provider: "anthropic",
				model: "claude-opus-5-5",
				cacheBustingPass: true,
			}),
		).toEqual({ entryIds: ["assistant-1", "assistant-2"] });
		expect(wireA[0].content).toEqual([toolCall()]);
		expect(wireA[1]).toEqual(toolResult());
		expect(wireA[2].content).toEqual([]);
		expect(getMergedReasoningStrippedIds(second, "shared")).toContain(
			"binding_mismatch:assistant-1",
		);

		// The second connection represents a concurrently serving host; a fresh
		// connection after both close represents process restart. Undo hands back
		// the original stored message with the *same* entry id.
		const wireB = input();
		applyPiThinkingBindingRecovery({
			db: second,
			sessionId: "shared",
			messages: wireB,
			entryIds: ids,
			provider: "anthropic",
			model: "claude-opus-5-5",
		});
		expect(wireB).toEqual(wireA);
	} finally {
		first.close();
		second.close();
	}
	const restarted = new Database(path);
	try {
		const reverted = input();
		applyPiThinkingBindingRecovery({
			db: restarted,
			sessionId: "shared",
			messages: reverted,
			entryIds: ids,
			provider: "anthropic",
			model: "claude-opus-5-5",
		});
		expect(reverted[0].content).toEqual([toolCall()]);
		expect(reverted[2].content).toEqual([]);
	} finally {
		restarted.close();
	}
});

it("a defer branch-away does not silently switch legacy strip order before undo restores the old arc", () => {
	const db = new Database(":memory:");
	initializeDatabase(db);
	try {
		const sessionId = "legacy-undo";
		// The old build stripped before rendering the dropped tool arc. When the
		// entry leaves the active branch, a defer pass must not permanently change
		// that order: undo can restore this same entry on the very next defer.
		addMergedReasoningStrippedIds(db, sessionId, [
			"binding_mismatch:assistant-1",
		]);
		expect(
			resolvePiBindingStripOrder({
				db,
				sessionId,
				messages: [{ role: "user", content: "other branch" }],
				entryIds: ["user-other"],
				bustPermittedAtStart: false,
			}),
		).toBe("start");
		expect(getMergedReasoningStrippedIds(db, sessionId)).not.toContain(
			"binding_mismatch_order:end",
		);
		expect(
			resolvePiBindingStripOrder({
				db,
				sessionId,
				messages: input(),
				entryIds: ids,
				bustPermittedAtStart: false,
			}),
		).toBe("start");
	} finally {
		db.close();
	}
});

it("runs the proactive strip for subagents as for primaries, never under compaction-off or start order", () => {
	for (const isSubagent of [false, true]) {
		expect(
			shouldRunPiProactiveThinkingStrip({
				compactionOff: false,
				bindingStripOrder: "end",
				isSubagent,
			}),
		).toBe(true);
		expect(
			shouldRunPiProactiveThinkingStrip({
				compactionOff: true,
				bindingStripOrder: "end",
				isSubagent,
			}),
		).toBe(false);
		expect(
			shouldRunPiProactiveThinkingStrip({
				compactionOff: false,
				bindingStripOrder: "start",
				isSubagent,
			}),
		).toBe(false);
	}
});
