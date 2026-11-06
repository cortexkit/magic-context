import { afterEach, expect, it, spyOn } from "bun:test";
import {
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage";
import {
	recordOverflowDetected,
	resetEmergencyRecoveryRegistryForTest,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { _resetHarnessForTesting } from "@magic-context/core/shared/harness";
import * as logger from "@magic-context/core/shared/logger";
import {
	__test,
	clearContextHandlerSession,
	recordPiLiveModel,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import * as pressure from "./pi-pressure";
import { applyPiProactiveThinkingStrip } from "./provider-error-recovery-pi";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

afterEach(() => {
	resetEmergencyRecoveryRegistryForTest();
	_resetHarnessForTesting();
});

function fixture(
	session: string,
	raw: ReturnType<typeof userMessage>[],
	heuristics = false,
	model = { provider: "mock", id: "mock", contextWindow: 100_000 },
) {
	const db = createTestDb();
	const fake = createFakePi();
	const pi = {
		...fake.pi,
		getAllTools: () => [
			{
				name: "read",
				description: "Read a file",
				parameters: { type: "object" },
			},
		],
	};
	const register = () =>
		registerPiContextHandler(pi as never, {
			db,
			protectedTags: 0,
			heuristics: heuristics ? {} : undefined,
			scheduler: { executeThresholdPercentage: 65 },
		});
	register();
	let count = raw.length;
	const context = (messages: typeof raw, tokens: number, percent: number) => {
		const ids = messages.map((_, index) => `entry-${index}`);
		const base = fakeContext(session, process.cwd(), ids, messages);
		const branch = base.sessionManager.getBranch().map((entry, index) => ({
			...entry,
			parentId: index ? ids[index - 1] : null,
		}));
		return {
			...base,
			sessionManager: {
				...base.sessionManager,
				getBranch: () => branch,
				getEntry: (id: string) => branch.find((entry) => entry.id === id),
				getLeafId: () => ids.at(-1) ?? null,
			},
			model,
			getSystemPrompt: () => "You are a helpful assistant.",
			getContextUsage: () => ({ tokens, percent, contextWindow: 100_000 }),
		};
	};
	return {
		db,
		session,
		rewind(length: number) {
			count = length;
		},
		restart() {
			clearContextHandlerSession(session);
			register();
		},
		async recordReductionLeaf() {
			const messages = structuredClone(raw.slice(0, count));
			await fake.handlers.get("tool_call")?.(
				{ toolName: "ctx_reduce" } as never,
				context(messages, 1000, 1) as never,
			);
		},
		async pass(tokens = 1000, percent = 1) {
			updateSessionMeta(db, session, {
				lastInputTokens: tokens,
				lastContextPercentage: percent,
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
			});
			recordPiLiveModel(session, `${model.provider}/${model.id}`);
			const messages = structuredClone(raw.slice(0, count));
			return (await fake.handlers.get("context")!(
				{ messages } as never,
				context(messages, tokens, percent) as never,
			)) as { messages: unknown[] };
		},
		armOverflow() {
			recordOverflowDetected(
				db,
				session,
				100_000,
				`${model.provider}/${model.id}`,
				"provider_overflow",
			);
		},
		close() {
			clearContextHandlerSession(session);
			resetEmergencyRecoveryRegistryForTest();
			db.close();
		},
	};
}

it("rewind cancellation shares the late execute-reclaim rebuild permission", async () => {
	const f = fixture("review-late-rebuild", [
		userMessage("initial request", 1),
		assistantToolCall("call", "read", {}, 2),
		toolResultMessage("call", "ORIGINAL_REWOUND_OUTPUT", 3),
		assistantMessage("large answer ".repeat(4000), 4),
		userMessage("abandoned branch", 5),
	]);
	const passes: boolean[] = [];
	const restore = __test.setPipelineResultObserverForTests((id, result) => {
		if (id === f.session) passes.push(result.prefixBustPermitted);
	});
	try {
		await f.pass();
		const tool = getTagsBySession(f.db, f.session).find(
			(tag) => tag.type === "tool",
		)!;
		const text = getTagsBySession(f.db, f.session).find(
			(tag) => tag.messageId === "entry-3:p0",
		)!;
		expect(text).toBeDefined();
		await f.recordReductionLeaf();
		updateTagStatus(f.db, f.session, tool.tagNumber, "dropped");
		queuePendingOp(f.db, f.session, text.tagNumber, "drop");
		await f.pass();
		f.rewind(4);
		passes.length = 0;
		const rebuilt = await f.pass(70_000, 70);
		expect(passes).toEqual([true]);
		expect(getPendingOps(f.db, f.session)).toEqual([]);
		const statuses = getTagsBySession(f.db, f.session);
		expect({
			oldDrop: statuses.find((tag) => tag.tagNumber === tool.tagNumber)?.status,
			abandonedQueue: statuses.find((tag) => tag.tagNumber === text.tagNumber)
				?.status,
		}).toEqual({ oldDrop: "active", abandonedQueue: "active" });
		expect(JSON.stringify(rebuilt)).toContain("ORIGINAL_REWOUND_OUTPUT");
	} finally {
		restore();
		f.close();
	}
});

it("provider-overflow recovery sends a fitting request with a supported system entry", async () => {
	const f = fixture(
		"review-system-overflow",
		[
			{ role: "system", content: "Be helpful.", timestamp: 0 } as never,
			userMessage("Hello", 1),
			assistantMessage("Hello!", 2),
			userMessage("Continue", 3),
		],
		true,
	);
	try {
		const warm = await f.pass();
		expect(Buffer.byteLength(JSON.stringify(warm))).toBeLessThan(10_000);
		f.armOverflow();
		signalPiPendingMaterialization(f.session, "user_flush");
		const recovered = await f.pass(0, 0);
		expect(recovered.messages).toEqual(warm.messages);
	} finally {
		f.close();
	}
});

it("a deferred rewind replays its prefix and leaves off-branch operations untouched across restart", async () => {
	const f = fixture("review-rewind-replay", [
		userMessage("initial request", 1),
		assistantToolCall("call", "read", {}, 2),
		toolResultMessage("call", "REPLAYED_TOOL_OUTPUT", 3),
		assistantMessage("earlier answer", 4),
		userMessage("abandoned branch", 5),
	]);
	try {
		await f.pass();
		const tags = getTagsBySession(f.db, f.session);
		const tool = tags.find((tag) => tag.type === "tool")!;
		const text = tags.find((tag) => tag.messageId === "entry-3:p0")!;
		await f.recordReductionLeaf();
		updateTagStatus(f.db, f.session, tool.tagNumber, "dropped");
		queuePendingOp(f.db, f.session, text.tagNumber, "drop");
		const dropped = await f.pass();
		f.rewind(4);
		const deferred = await f.pass();
		expect(deferred.messages).toEqual(
			dropped.messages.slice(0, deferred.messages.length),
		);
		expect(JSON.stringify(await f.pass())).toBe(JSON.stringify(deferred));
		expect(getPendingOps(f.db, f.session)).toHaveLength(1);
		f.restart();
		signalPiPendingMaterialization(f.session, "user_flush");
		const restored = await f.pass();
		expect(JSON.stringify(restored)).toContain("REPLAYED_TOOL_OUTPUT");
		expect(getPendingOps(f.db, f.session)).toEqual([]);
		expect(JSON.stringify(await f.pass())).toBe(JSON.stringify(restored));
	} finally {
		f.close();
	}
});

it("rewind plus unknown-usage rerun stores the same decisions as one priced pass", async () => {
	const session = "review-rewind-overflow";
	const raw = [userMessage("Read both images", 1)];
	for (let index = 0; index < 2; index++) {
		raw.push(assistantToolCall(`image-${index}`, "read", {}, 2 + index * 2), {
			...toolResultMessage(`image-${index}`, "Image read", 3 + index * 2),
			content: [
				{ type: "image", mimeType: "image/png", data: "A".repeat(220_000) },
			],
		} as never);
	}
	raw.push(
		assistantMessage("earlier answer", 6),
		userMessage("abandoned branch", 7),
	);
	const clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
	const log = spyOn(logger, "sessionLog");
	const prepare = async () => {
		const f = fixture(session, raw, true);
		await f.pass();
		const tags = getTagsBySession(f.db, session);
		await f.recordReductionLeaf();
		updateTagStatus(
			f.db,
			session,
			tags.find((tag) => tag.type === "tool")!.tagNumber,
			"dropped",
		);
		queuePendingOp(
			f.db,
			session,
			tags.find((tag) => tag.messageId === "entry-5:p0")!.tagNumber,
			"drop",
		);
		await f.pass();
		f.rewind(6);
		f.armOverflow();
		signalPiPendingMaterialization(session, "user_flush");
		return f;
	};
	const decisions = (f: ReturnType<typeof fixture>) => ({
		tags: getTagsBySession(f.db, session),
		pending: getPendingOps(f.db, session),
		meta: f.db
			.prepare("SELECT * FROM session_meta WHERE session_id = ?")
			.get(session),
	});
	let f: ReturnType<typeof fixture> | undefined;
	try {
		f = await prepare();
		const retry = await f.pass(0, 0);
		const line = log.mock.calls.find(([, line]) =>
			line.includes("overflow unknown-usage recovery:"),
		)?.[1];
		const tokens = Number(line?.match(/inputTokens=(\d+)/)?.[1]);
		expect(tokens).toBeGreaterThan(0);
		const retriedState = decisions(f);
		expect(getPendingOps(f.db, session)).toEqual([]);
		expect(JSON.stringify(retry)).not.toContain('"type":"image"');
		f.close();
		f = undefined;
		f = await prepare();
		const pressureSpy = spyOn(
			pressure,
			"resolvePiPressureSnapshotWithEstimateGuard",
		).mockReturnValueOnce({
			inputTokens: tokens,
			percentage: Math.max(95, tokens / 1000),
		});
		try {
			const single = await f.pass(0, 0);
			expect(single.messages).toEqual(retry.messages);
			expect(decisions(f)).toEqual(retriedState);
		} finally {
			pressureSpy.mockRestore();
		}
	} finally {
		f?.close();
		log.mockRestore();
		clock.mockRestore();
	}
});

it("last-good replay after a failed restoration cannot expose restored bytes on a deferred pass", async () => {
	const f = fixture("review-restoration-last-good", [
		userMessage("initial request", 1),
		assistantToolCall("call", "read", {}, 2),
		toolResultMessage("call", "RESTORE_ONLY_ON_REBUILD", 3),
		assistantMessage("earlier answer", 4),
		userMessage("abandoned branch", 5),
	]);
	let stopObserving = () => {};
	try {
		await f.pass();
		const tool = getTagsBySession(f.db, f.session).find(
			(tag) => tag.type === "tool",
		)!;
		await f.recordReductionLeaf();
		updateTagStatus(f.db, f.session, tool.tagNumber, "dropped");
		await f.pass();
		f.rewind(4);
		const dropped = await f.pass();
		expect(JSON.stringify(dropped)).not.toContain("RESTORE_ONLY_ON_REBUILD");
		signalPiPendingMaterialization(f.session, "user_flush");
		stopObserving = __test.setPipelineResultObserverForTests((id) => {
			if (id === f.session)
				throw new Error("post-pipeline failure before publication");
		});
		const replay = await f.pass();
		stopObserving();
		stopObserving = () => {};
		expect(JSON.stringify(replay)).toBe(JSON.stringify(dropped));
		const permissions: boolean[] = [];
		stopObserving = __test.setPipelineResultObserverForTests((id, result) => {
			if (id === f.session) permissions.push(result.prefixBustPermitted);
		});
		const next = await f.pass();
		expect(permissions).toEqual([false]);
		expect(JSON.stringify(next)).toBe(JSON.stringify(replay));
	} finally {
		stopObserving();
		f.close();
	}
});

it("restoring dropped text does not restore signed thinking omitted before that branch", async () => {
	const model = {
		provider: "anthropic",
		id: "claude-opus-5-5",
		contextWindow: 100_000,
	};
	const raw = [
		userMessage("initial request", 1),
		assistantMessage("visible answer", 2, {
			provider: model.provider,
			model: model.id,
			content: [
				{
					type: "thinking",
					thinking: "NEVER_SERVED_THINKING",
					thinkingSignature: "signed-original",
				},
				{ type: "text", text: "visible answer" },
			],
		}),
		userMessage("kept branch", 3),
		userMessage("abandoned branch", 4),
	];
	const f = fixture("review-restored-thinking-mask", raw, false, model);
	try {
		applyPiProactiveThinkingStrip({
			db: f.db,
			sessionId: f.session,
			messages: structuredClone(raw),
			entryIds: raw.map((_, index) => `entry-${index}`),
			provider: model.provider,
			model: model.id,
			cacheBustingPass: true,
			stripActiveTurn: true,
		});
		const warm = await f.pass();
		expect(JSON.stringify(warm)).not.toContain("NEVER_SERVED_THINKING");
		const text = getTagsBySession(f.db, f.session).find(
			(tag) => tag.type === "message" && tag.messageId.startsWith("entry-1:"),
		)!;
		expect(text).toBeDefined();
		await f.recordReductionLeaf();
		updateTagStatus(f.db, f.session, text.tagNumber, "dropped");
		await f.pass();
		f.rewind(3);
		signalPiPendingMaterialization(f.session, "user_flush");
		const restored = await f.pass();
		expect(JSON.stringify(restored)).toContain("visible answer");
		expect(JSON.stringify(restored)).not.toContain("NEVER_SERVED_THINKING");
		expect(JSON.stringify(restored)).not.toContain("signed-original");
	} finally {
		f.close();
	}
});
