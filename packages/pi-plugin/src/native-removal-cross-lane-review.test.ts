import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getNativeReplayState } from "@magic-context/core/features/magic-context/storage-native-replay";
import { createTestTempDirFromPath } from "@magic-context/core/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import * as heuristicCleanup from "./heuristic-cleanup-pi";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

test("review witness: failed heuristic group preserves an earlier successful queued group", async () => {
	const root = createTestTempDirFromPath(
		join(tmpdir(), "native-batch-cross-lane-review-"),
	);
	const db = createTestDb(join(root, "fixture.db"));
	const id = "independent-cross-lane-review";
	const fake = createFakePi();
	Object.assign(fake.pi, { getActiveTools: () => [], getAllTools: () => [] });
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTokens: 0,
		protectedTags: 0,
		heuristics: {},
	});
	let handler = fake.handlers.get("context");
	if (!handler) throw new Error("context handler missing");
	const build = (count: number) => [
		userMessage("start", 1),
		...Array.from({ length: count }, (_, i) => [
			assistantToolCall(`reduce-${i}`, "ctx_reduce", {}, 100 + i * 2),
			{
				...toolResultMessage(`reduce-${i}`, "r".repeat(20000), 101 + i * 2),
				toolName: "ctx_reduce",
			},
		]).flat(),
		assistantMessage("answered", 200),
		userMessage("continue", 201),
	];
	const pass = (count: number) => {
		const messages = build(count);
		if (!handler) throw new Error("context handler missing");
		return handler(
			{ messages } as never,
			{
				...fakeContext(
					id,
					root,
					messages.map((m) => `entry-${m.timestamp}`),
					messages,
				),
				getSystemPrompt: () => "isolated review system",
				model: {
					provider: "anthropic",
					id: "claude-sonnet-4",
					api: "anthropic-messages",
					contextWindow: 100000,
				},
				getContextUsage: () => ({
					tokens: 1000,
					percent: 1,
					contextWindow: 100000,
				}),
			} as never,
		) as Promise<{ messages: unknown[] } | undefined>;
	};
	let cleanupSpy: ReturnType<typeof spyOn> | undefined;
	try {
		await pass(3);
		updateSessionMeta(db, id, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
			lastContextPercentage: 1,
			lastInputTokens: 1000,
		});
		const before = await pass(6);
		expect(before).toBeDefined();
		updateSessionMeta(db, id, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
			lastContextPercentage: 1,
			lastInputTokens: 1000,
		});
		const tools = getTagsBySession(db, id).filter((tag) => tag.type === "tool");
		if (!tools[0]) throw new Error("queued target missing");
		queuePendingOp(db, id, tools[0].tagNumber, "drop");
		if (!tools[1]) throw new Error("cleanup fault target missing");
		cleanupSpy = spyOn(heuristicCleanup, "applyPiHeuristicCleanup");
		db.exec(
			`CREATE TEMP TRIGGER review_later_lane BEFORE UPDATE OF status ON tags WHEN NEW.tag_number=${tools[1].tagNumber} AND NEW.status='dropped' BEGIN SELECT RAISE(ABORT,'review later-lane tag failure'); END`,
		);
		signalPiPendingMaterialization(id);
		let returned: { messages: unknown[] } | undefined;
		let failure: unknown;
		try {
			returned = await pass(6);
		} catch (error) {
			failure = error;
		}
		const dropped = getTagsBySession(db, id).filter(
			(tag) => tag.status === "dropped",
		);
		updateSessionMeta(db, id, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
			lastContextPercentage: 1,
			lastInputTokens: 1000,
		});
		let next: { messages: unknown[] } | undefined;
		try {
			next = await pass(6);
		} catch {}
		clearContextHandlerSession(id);
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTokens: 0,
			protectedTags: 0,
			heuristics: {},
		});
		handler = fake.handlers.get("context");
		let restarted: { messages: unknown[] } | undefined;
		try {
			restarted = await pass(6);
		} catch {}
		console.log(
			"CROSS_LANE_REVIEW",
			JSON.stringify({
				dropped: dropped.map((tag) => tag.messageId),
				markers: [...getNativeReplayState(db, id).toolInputs.keys()],
				returned: !!returned,
				equal:
					!!returned &&
					JSON.stringify(returned.messages) ===
						JSON.stringify(before?.messages),
				failure: String(failure),
				deferEqual:
					!!next &&
					JSON.stringify(next.messages) === JSON.stringify(returned?.messages),
				restartEqual:
					!!restarted &&
					JSON.stringify(restarted.messages) ===
						JSON.stringify(returned?.messages),
				cleanupCalls: cleanupSpy.mock.calls.length,
			}),
		);
		// Rollback is per group: the earlier queued drop survives the failed heuristic group.
		expect(dropped).toHaveLength(1);
		if (returned) {
			expect(JSON.stringify(next?.messages)).toBe(
				JSON.stringify(returned.messages),
			);
			expect(JSON.stringify(restarted?.messages)).toBe(
				JSON.stringify(returned.messages),
			);
		}
	} finally {
		cleanupSpy?.mockRestore();
		clearContextHandlerSession(id);
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});
