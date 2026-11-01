import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getOrCreateSessionMeta,
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	addMergedReasoningStrippedIds,
	appendNoteNudgeAnchor,
	getMergedReasoningStrippedIds,
	getNoteNudgeAnchors,
	getPersistedTodoSyntheticAnchor,
	getThinkingBindingRecoveryTarget,
	setPersistedTodoSyntheticAnchor,
	THINKING_BINDING_STRIP_ORDER_END_MARKER,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { buildSyntheticTodoPart } from "@magic-context/core/hooks/magic-context/todo-view";
import { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import * as autoSearch from "./auto-search-pi";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
} from "./context-handler";
import { injectM0M1Pi } from "./inject-compartments-pi";
import {
	applyPiProactiveThinkingStrip,
	handlePiProviderFailure,
} from "./provider-error-recovery-pi";
import { clearOldReasoningPi } from "./reasoning-replay-pi";
import * as placeholders from "./strip-placeholders-pi";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	heavyReasoningUsage,
	userMessage,
} from "./test-utils.test";

test("Pi thinking spans every tool round until the next real user", () => {
	const messages = [
		{ role: "user", content: "task" },
		{
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "first",
					thinkingSignature: "signed-first",
				},
				{ type: "toolCall", id: "t1" },
			],
		},
		{
			role: "toolResult",
			toolCallId: "t1",
			content: [{ type: "text", text: "result" }],
		},
		{
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "last",
					thinkingSignature: "signed-last",
				},
				{ type: "text", text: "done" },
			],
		},
	];
	const before = JSON.stringify(messages);
	const db = createTestDb();
	try {
		applyPiProactiveThinkingStrip({
			db,
			sessionId: "latest-turn",
			messages,
			entryIds: ["u", "a", "r", "b"],
			provider: "anthropic",
			model: "claude-opus-5-5",
			cacheBustingPass: true,
		});
		clearOldReasoningPi({
			protectLatestTurn: true,
			messages,
			messageIdToMaxTag: new Map([
				["a", 2],
				["b", 80],
			]),
			clearReasoningAge: 5,
			piMessageStableId: (_m, i) => ["u", "a", "r", "b"][i],
		});
		expect(JSON.stringify(messages)).toBe(before);
	} finally {
		closeQuietly(db);
	}
});

// Earlier revisions held the queued drop for the whole signed turn, through
// the force band and 95%. The bounded hold ends at the cap (65% + 10), so the
// first execute bust above it applies the drop mid-turn and strips every signed
// block, and later passes replay that result.
test("Pi Anthropic task applies queued drops mid-turn above the hold cap and strips signed thinking once", async () => {
	const db = createTestDb();
	const sessionId = "pi-latest-turn-pipeline";
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		isSubagent: true,
		lastResponseTime: Date.now(),
		cacheTtl: "59m",
	});
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		tagger: createTagger(),
		protectedTokens: 4000,
		heuristics: { clearReasoningAge: 1 },
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<{ messages: unknown[] }>;
	let tokens = 20_000;
	const ctx = {
		...fakeContext(sessionId),
		model: {
			provider: "anthropic",
			id: "claude-opus-5-5",
			api: "anthropic-messages",
			contextWindow: 100_000,
		},
		getContextUsage: () => ({
			tokens,
			percent: tokens / 1000,
			contextWindow: 100_000,
		}),
	};
	const messages = [
		userMessage("task", 1),
		// Heavy steps keep the turn's signed thinking while usage stays below
		// the 75% cap; the 76% bust below strips it.
		assistantMessage("spent", 2, {
			provider: "anthropic",
			model: "claude-opus-5-5",
			usage: heavyReasoningUsage(),
			content: [
				{
					type: "thinking",
					thinking: "signed-one",
					thinkingSignature: "signature-one",
				},
				{ type: "text", text: "spent" },
			],
		}),
		assistantMessage("newest", 3, {
			provider: "anthropic",
			model: "claude-opus-5-5",
			usage: heavyReasoningUsage(),
			content: [
				{
					type: "thinking",
					thinking: "signed-two",
					thinkingSignature: "signature-two",
				},
				{ type: "text", text: "newest" },
			],
		}),
	];
	const pass = () =>
		handler({ messages: structuredClone(messages) as never[] }, ctx as never);
	try {
		await pass();
		const before = JSON.stringify((await pass()).messages);
		expect(before).toContain("signature-two");
		queuePendingOp(db, sessionId, 2, "drop");
		tokens = 76_000;
		const busted = JSON.stringify((await pass()).messages);
		expect(busted).not.toBe(before);
		expect(getPendingOps(db, sessionId)).toHaveLength(0);
		expect(busted).not.toContain("signature-one");
		expect(busted).not.toContain("signature-two");
		expect(busted).toContain("newest");
		for (const n of [85_000, 95_000]) {
			tokens = n;
			// Nothing refuses: the stripped request is served and replayed.
			const replay = JSON.stringify((await pass()).messages);
			expect(replay).not.toContain("signature-one");
			expect(replay).not.toContain("signature-two");
		}
	} finally {
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
	}
});

for (const order of ["start", "end"] as const) {
	test(`Pi ${order}-order recovery keeps the restored original for the rejected turn and omits it again after a real user`, async () => {
		const sessionId = `pi-recovery-durable-${order}`;
		const db = createTestDb();
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, {
			isSubagent: true,
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
		});
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTokens: 4000,
			heuristics: { clearReasoningAge: 1000 },
		});
		const handler = fake.handlers.get("context") as (
			event: { messages: never[] },
			ctx: never,
		) => Promise<{ messages: unknown[] }>;
		const original = {
			type: "thinking",
			thinking: "signed-2",
			thinkingSignature: "signature-2",
		};
		const source: unknown[] = [
			userMessage("task", 1),
			assistantMessage("answer-2", 2, {
				provider: "anthropic",
				model: "claude-opus-5-5",
				content: [original, { type: "text", text: "answer-2" }],
			}),
			assistantMessage("answer-3", 3, {
				provider: "anthropic",
				model: "claude-opus-5-5",
				content: [
					{
						type: "thinking",
						thinking: "signed-3",
						thinkingSignature: "signature-3",
					},
					{ type: "text", text: "answer-3" },
				],
			}),
		];
		const ids = ["u", "a", "b"];
		const pass = async () => {
			const messages = structuredClone(source);
			const ctx = {
				...fakeContext(sessionId, process.cwd(), ids, messages),
				model: {
					provider: "anthropic",
					id: "claude-opus-5-5",
					api: "anthropic-messages",
					contextWindow: 100_000,
				},
				getContextUsage: () => ({
					tokens: 20_000,
					percent: 20,
					contextWindow: 100_000,
				}),
			};
			return (await handler({ messages: messages as never[] }, ctx as never))
				.messages;
		};
		const thinkingOf = (messages: unknown[], text: string) =>
			messages
				.flatMap((message) => {
					const content = (message as { content?: unknown }).content;
					return Array.isArray(content) ? content : [];
				})
				.find((part) => (part as { thinking?: unknown }).thinking === text);
		try {
			await pass();
			addMergedReasoningStrippedIds(db, sessionId, [
				"binding_mismatch:a",
				...(order === "end" ? [THINKING_BINDING_STRIP_ORDER_END_MARKER] : []),
			]);
			expect(thinkingOf(await pass(), "signed-2")).toBeUndefined();
			handlePiProviderFailure({
				db,
				sessionId,
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-opus-5-5",
					errorMessage:
						"400: thinking or redacted_thinking blocks in the latest assistant message cannot be modified",
				},
			});
			// The retry and every later pass of the rejected turn carry the exact
			// original block; no pass removes it again.
			for (let n = 0; n < 2; n++)
				expect(thinkingOf(await pass(), "signed-2")).toEqual(original);
			expect(getThinkingBindingRecoveryTarget(db, sessionId)).toBe(
				"latest_thinking_original:u",
			);
			source.push(userMessage("next real user", 4));
			ids.push("next");
			const next = await pass();
			// The rejected turn ended: its accepted older-turn omission applies again.
			expect(thinkingOf(next, "signed-2")).toBeUndefined();
			expect(getThinkingBindingRecoveryTarget(db, sessionId) ?? "").toBe("");
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});
}

for (const lane of [
	"pipeline",
	"placeholders",
	"auto search",
	"sticky GC",
	"history",
	"synthetic todo",
	"thinking strip",
	"tag hydration",
	"tag hydration fold",
] as const) {
	const testName =
		lane === "tag hydration"
			? "hydration completion preserves a held signed prefix and queued drops"
			: lane === "tag hydration fold"
				? "a genuine fold still drains eligible pending drops"
				: `Pi 66% signed-prefix hold denies ${lane} until the next user`;
	test(testName, async () => {
		const root =
			lane === "tag hydration"
				? createTestTempDirFromPath(join(tmpdir(), "pi-held-hydration-"))
				: undefined;
		const db = createTestDb(root ? join(root, "context.db") : ":memory:");
		const sessionId = `pi-execute-prefix-hold-${lane}`;
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			cacheTtl: "13h",
		});
		const fake = createFakePi();
		const search = spyOn(
			autoSearch,
			"runAutoSearchHintForPi",
		).mockImplementation(async (args) => args.messages);
		const shells = spyOn(placeholders, "stripPiDroppedPlaceholderMessages");
		registerPiContextHandler(fake.pi as never, {
			db,
			tagger: createTagger(),
			protectedTokens: 0,
			heuristics: { clearReasoningAge: 1 },
			injection: {
				injectionBudgetTokens: 1000,
				memoryEnabled: false,
				injectDocs: false,
			},
			todowriteEnabled: true,
			scheduler: { executeThresholdPercentage: 65 },
			autoSearch: { enabled: true, minPromptChars: 1, scoreThreshold: 0 },
		});
		const handler = fake.handlers.get("context") as (
			event: { messages: never[] },
			ctx: never,
		) => Promise<{ messages: unknown[] }>;
		// The active turn's steps are heavy, so the 66% passes are held by the
		// bounded hold (below 65% + 10).
		const thought = (n: number) =>
			assistantMessage(`answer ${n}`, n, {
				provider: "anthropic",
				model: "claude-opus-5-5",
				...(n >= 4 ? { usage: heavyReasoningUsage() } : {}),
				content: [
					{
						type: "thinking",
						thinking: `thought ${n}`,
						thinkingSignature: `sig-${n}`,
					},
					{ type: "text", text: `answer ${n}` },
				],
			});
		const source = [
			userMessage("old task", 1),
			thought(2),
			userMessage("active task", 3),
			thought(4),
			thought(5),
		];
		const ids = [
			"old-user",
			"old-answer",
			"active-user",
			"active-one",
			"active-two",
		];
		let tokens = 20_000;
		const pass = async (warm = false) => {
			const messages = structuredClone(warm ? source.slice(0, 1) : source);
			const ctx = {
				...fakeContext(
					sessionId,
					process.cwd(),
					warm ? ids.slice(0, 1) : ids,
					messages,
				),
				model: {
					provider: "anthropic",
					id: "claude-opus-5-5",
					api: "anthropic-messages",
					contextWindow: 100_000,
				},
				getContextUsage: () => ({
					tokens,
					percent: tokens / 1000,
					contextWindow: 100_000,
				}),
			};
			return (await handler({ messages: messages as never[] }, ctx as never))
				.messages;
		};
		try {
			// Cache m[0]/m[1] before thinking starts, so these are warm-cache holds
			// rather than the first-render exception that permits cleanup.
			await pass(true);
			await pass();
			const baseline = JSON.stringify(await pass());
			search.mockClear();
			const oldTag = getTagsBySession(db, sessionId).find((tag) =>
				tag.messageId.startsWith("old-answer"),
			)!;
			expect(oldTag).toBeDefined();
			queuePendingOp(db, sessionId, oldTag.tagNumber, "drop");
			updateSessionMeta(db, sessionId, {
				lastTodoState: JSON.stringify([
					{
						id: "todo",
						content: "Deferred task",
						status: "pending",
						priority: "medium",
					},
				]),
			});
			signalPiHistoryRefresh(sessionId);
			signalPiPendingMaterialization(sessionId);
			if (lane === "sticky GC")
				expect(
					appendNoteNudgeAnchor(
						db,
						sessionId,
						"not-in-this-branch",
						"preserve until a permitted bust",
					),
				).toBe(true);
			tokens = 66_000;
			if (root) {
				const foreign = new Database(join(root, "context.db"));
				try {
					initializeDatabase(foreign);
					foreign
						.prepare(
							"UPDATE tags SET byte_size = byte_size WHERE session_id = ?",
						)
						.run(sessionId);
				} finally {
					foreign.close();
				}
			}
			shells.mockClear();
			for (let n = 0; n < 2; n++) {
				let gates: unknown;
				const restoreObserver = __test.setMutationGateObserverForTests(
					(snapshot) => {
						gates = snapshot;
					},
				);
				let held: unknown[];
				try {
					held = await pass();
				} finally {
					restoreObserver();
				}
				if (lane === "pipeline")
					expect(gates).toMatchObject({
						shouldApplyPendingOps: false,
						shouldRunHeuristics: false,
						shouldRunReasoningCleanup: false,
					});
				if (lane === "placeholders")
					expect(shells.mock.calls.at(-1)?.[0]).toMatchObject({
						isCacheBusting: false,
						forceDiscovery: false,
						canFirstApply: false,
					});
				if (lane === "auto search") expect(search).not.toHaveBeenCalled();
				if (lane === "sticky GC")
					expect(getNoteNudgeAnchors(db, sessionId)).toHaveLength(1);
				if (lane === "history")
					expect(__test.variantRefreshStateForTests(sessionId).history).toBe(
						true,
					);
				if (lane === "synthetic todo")
					expect(getPersistedTodoSyntheticAnchor(db, sessionId)).toBeNull();
				if (lane === "thinking strip")
					expect(
						[...getMergedReasoningStrippedIds(db, sessionId)].filter((id) =>
							id.startsWith("binding_mismatch:"),
						),
					).toEqual([]);
				expect(JSON.stringify(held)).toBe(baseline);
				expect(getPendingOps(db, sessionId)).toHaveLength(1);
			}
			source.push(userMessage("next user", 6));
			ids.push("next-user");
			tokens = 61_000;
			const released = JSON.stringify(await pass());
			expect(released).not.toBe(baseline);
			expect(getPendingOps(db, sessionId)).toHaveLength(0);
			expect(released).toContain("Deferred task");
			expect(released).not.toContain('"thinkingSignature"');
			if (lane === "auto search") expect(search).toHaveBeenCalled();
			if (lane === "sticky GC")
				expect(getNoteNudgeAnchors(db, sessionId)).toHaveLength(0);
		} finally {
			search.mockRestore();
			shells.mockRestore();
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
			if (root) rmSync(root, { recursive: true, force: true });
		}
	});
}

for (const cause of ["first render", "idle expiry"] as const) {
	test(
		cause === "first render"
			? "Pi rewriting first render strips all thinking and admits queued work"
			: "Pi idle expiry admits suffix work while keeping every signed block",
		async () => {
			const db = createTestDb();
			const sessionId = `pi-held-priced-${cause}`;
			getOrCreateSessionMeta(db, sessionId);
			updateSessionMeta(db, sessionId, {
				piStableIdScheme: 1,
				lastResponseTime: Date.now(),
				cacheTtl: "13h",
			});
			const fake = createFakePi();
			const options: Parameters<typeof registerPiContextHandler>[1] = {
				db,
				tagger: createTagger(),
				protectedTokens: 4000,
				injection:
					cause === "idle expiry"
						? {
								injectionBudgetTokens: 1000,
								memoryEnabled: false,
								injectDocs: false,
							}
						: undefined,
				heuristics: { keepReasoningTokens: 10000 },
				scheduler: { executeThresholdPercentage: 65 },
			};
			registerPiContextHandler(fake.pi as never, options);
			const handler = fake.handlers.get("context")!;
			// A heavy active step keeps the 66% passes under the bounded hold.
			const thought = (n: number) =>
				assistantMessage(`answer ${n}`, n, {
					provider: "anthropic",
					model: "claude-opus-5-5",
					...(n >= 4 ? { usage: heavyReasoningUsage() } : {}),
					content: [
						{
							type: "thinking",
							thinking: `thought ${n}`,
							thinkingSignature: `sig-${n}`,
						},
						{ type: "text", text: `answer ${n}` },
					],
				});
			const source = [
				userMessage("old task", 1),
				thought(2),
				userMessage("active task", 3),
				thought(4),
				assistantMessage("SAFE-LATE-CONTENT", 5, {
					provider: "anthropic",
					model: "claude-opus-5-5",
				}),
			];
			const ids = [
				"old-user",
				"old-answer",
				"active-user",
				"active-thought",
				"late-answer",
			];
			const pass = async (warm = false) => {
				const messages = structuredClone(warm ? source.slice(0, 1) : source);
				const ctx = {
					...fakeContext(
						sessionId,
						process.cwd(),
						warm ? ids.slice(0, 1) : ids,
						messages,
					),
					model: {
						provider: "anthropic",
						id: "claude-opus-5-5",
						api: "anthropic-messages",
						contextWindow: 100000,
					},
					getContextUsage: () => ({
						tokens: 66000,
						percent: 66,
						contextWindow: 100000,
					}),
				};
				return (
					(await handler({ messages } as never, ctx as never)) as {
						messages: unknown[];
					}
				).messages;
			};
			try {
				if (cause === "idle expiry") await pass(true);
				await pass();
				const late = getTagsBySession(db, sessionId)
					.filter((tag) => tag.type === "message")
					.sort((a, b) => b.tagNumber - a.tagNumber)[0]!;
				options.injection = {
					injectionBudgetTokens: 1000,
					memoryEnabled: false,
					injectDocs: false,
				};
				if (cause === "idle expiry")
					updateSessionMeta(db, sessionId, {
						lastResponseTime: Date.now() - 14 * 60 * 60 * 1000,
					});
				queuePendingOp(db, sessionId, late.tagNumber, "drop");
				const priced = await pass();
				expect(getPendingOps(db, sessionId)).toHaveLength(0);
				expect(
					getTagsBySession(db, sessionId).find(
						(tag) => tag.tagNumber === late.tagNumber,
					)?.status,
				).toBe("dropped");
				expect(JSON.stringify(priced)).not.toContain("SAFE-LATE-CONTENT");
				if (cause === "first render") {
					expect(JSON.stringify(priced)).not.toContain("thinkingSignature");
					expect([...getMergedReasoningStrippedIds(db, sessionId)]).toContain(
						"binding_mismatch:old-answer",
					);
				} else {
					expect(JSON.stringify(priced)).toContain(
						'"thinkingSignature":"sig-2"',
					);
					expect(JSON.stringify(priced)).toContain(
						'"thinkingSignature":"sig-4"',
					);
					expect(
						[...getMergedReasoningStrippedIds(db, sessionId)].filter((id) =>
							id.startsWith("binding_mismatch:"),
						),
					).toEqual([]);
				}
				updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() });
				expect(JSON.stringify(await pass())).toBe(JSON.stringify(priced));
			} finally {
				clearContextHandlerSession(sessionId);
				db.close();
			}
		},
	);
}

test("unheld contended preflight replays todo and preserves sticky anchors and thinking", async () => {
	const db = createTestDb();
	const sessionId = "pi-unheld-contended-riders";
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		piStableIdScheme: 1,
		lastResponseTime: Date.now(),
		cacheTtl: "13h",
		systemPromptHash: "before",
	});
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTokens: 4000,
		todowriteEnabled: true,
		injection: {
			injectionBudgetTokens: 1000,
			memoryEnabled: false,
			injectDocs: false,
		},
		heuristics: { keepReasoningTokens: 10000 },
		scheduler: { executeThresholdPercentage: 65 },
	});
	const handler = fake.handlers.get("context")!;
	const source = [
		userMessage("old task", 1),
		assistantMessage("old answer", 2, {
			provider: "anthropic",
			model: "claude-opus-5-5",
			content: [
				{
					type: "thinking",
					thinking: "old immutable thought",
					thinkingSignature: "old-signature",
				},
				{ type: "text", text: "old answer" },
			],
		}),
		userMessage("new task", 3),
	];
	const ids = ["old-user", "old-answer", "next-user"];
	let systemPrompt = "Original host instructions.";
	const pass = async (warm = false) => {
		const messages = structuredClone(warm ? source.slice(0, 1) : source);
		const ctx = {
			...fakeContext(
				sessionId,
				process.cwd(),
				warm ? ids.slice(0, 1) : ids,
				messages,
			),
			getSystemPrompt: () => systemPrompt,
			model: {
				provider: "anthropic",
				id: "claude-opus-5-5",
				api: "anthropic-messages",
				contextWindow: 100000,
			},
			getContextUsage: () => ({
				tokens: 20000,
				percent: 20,
				contextWindow: 100000,
			}),
		};
		return (
			(await handler({ messages } as never, ctx as never)) as {
				messages: unknown[];
			}
		).messages;
	};
	let restoreInjection = () => {};
	try {
		await pass(true);
		addMergedReasoningStrippedIds(db, sessionId, [
			THINKING_BINDING_STRIP_ORDER_END_MARKER,
		]);
		const oldTodo = JSON.stringify([
			{
				id: "a",
				content: "previous todo",
				status: "pending",
				priority: "medium",
			},
		]);
		const newTodo = JSON.stringify([
			{ id: "b", content: "new todo", status: "pending", priority: "medium" },
		]);
		const todoPart = buildSyntheticTodoPart(oldTodo)!;
		setPersistedTodoSyntheticAnchor(
			db,
			sessionId,
			todoPart.callID,
			"pi-ts-2",
			oldTodo,
		);
		updateSessionMeta(db, sessionId, { lastTodoState: oldTodo });
		const baseline = JSON.stringify(await pass());
		expect(baseline).toContain("previous todo");
		expect(baseline).toContain("old-signature");
		const anchor = getPersistedTodoSyntheticAnchor(db, sessionId);
		appendNoteNudgeAnchor(
			db,
			sessionId,
			"absent-user",
			"retain this sticky decision",
		);
		updateSessionMeta(db, sessionId, {
			lastTodoState: newTodo,
			systemPromptHash: "after",
		});
		signalPiHistoryRefresh(sessionId);
		let contended = false;
		restoreInjection = __test.setInjectM0M1PiForTests((...args) => {
			if (args[2].length > 0) return injectM0M1Pi(...args);
			const exec = db.exec.bind(db);
			const lock = spyOn(db, "exec").mockImplementation((sql) => {
				if (sql === "BEGIN IMMEDIATE")
					throw Object.assign(new Error("database is locked"), {
						code: "SQLITE_BUSY",
					});
				return exec(sql);
			});
			try {
				const result = injectM0M1Pi(...args);
				contended ||= result.contentionExhausted;
				return result;
			} finally {
				lock.mockRestore();
			}
		});
		const replay = JSON.stringify(await pass());
		expect(contended).toBe(true);
		expect(replay).toBe(baseline);
		expect(getPersistedTodoSyntheticAnchor(db, sessionId)).toEqual(anchor);
		expect(getNoteNudgeAnchors(db, sessionId)).toHaveLength(1);
		expect(
			[...getMergedReasoningStrippedIds(db, sessionId)].filter((id) =>
				id.startsWith("binding_mismatch:"),
			),
		).toEqual([]);
		restoreInjection();
		restoreInjection = () => {};
		systemPrompt = "Changed host instructions.";
		const released = JSON.stringify(await pass());
		expect(released).toContain("new todo");
		expect(released).not.toContain("old-signature");
		expect(getPersistedTodoSyntheticAnchor(db, sessionId)?.stateJson).toBe(
			newTodo,
		);
		expect(getNoteNudgeAnchors(db, sessionId)).toHaveLength(0);
	} finally {
		restoreInjection();
		clearContextHandlerSession(sessionId);
		db.close();
	}
});

test("Pi already-cold held pass keeps every signed block when no binding bytes change", async () => {
	const db = createTestDb();
	const sessionId = "pi-cold-strip-without-other-edit";
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		piStableIdScheme: 1,
		cacheTtl: "13h",
		lastResponseTime: Date.now(),
	});
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTokens: 4000,
		heuristics: { keepReasoningTokens: 10000 },
		injection: {
			injectionBudgetTokens: 1000,
			memoryEnabled: false,
			injectDocs: false,
		},
		scheduler: { executeThresholdPercentage: 65 },
	});
	const handler = fake.handlers.get("context")!;
	const thought = (n: number) =>
		assistantMessage(`answer ${n}`, n, {
			provider: "anthropic",
			model: "claude-opus-5-5",
			content: [
				{
					type: "thinking",
					thinking: `thought ${n}`,
					thinkingSignature: `sig-${n}`,
				},
				{ type: "text", text: `answer ${n}` },
			],
		});
	const source = [
		userMessage("old task", 1),
		thought(2),
		userMessage("active task", 3),
		thought(4),
	];
	const ids = ["old-user", "old-answer", "active-user", "active-thought"];
	const pass = async (warm = false) => {
		const messages = structuredClone(warm ? source.slice(0, 1) : source);
		const ctx = {
			...fakeContext(
				sessionId,
				process.cwd(),
				warm ? ids.slice(0, 1) : ids,
				messages,
			),
			model: {
				provider: "anthropic",
				id: "claude-opus-5-5",
				api: "anthropic-messages",
				contextWindow: 100000,
			},
			getContextUsage: () => ({
				tokens: 66000,
				percent: 66,
				contextWindow: 100000,
			}),
		};
		return (
			(await handler({ messages } as never, ctx as never)) as {
				messages: unknown[];
			}
		).messages;
	};
	try {
		await pass(true);
		const before = JSON.stringify(await pass());
		expect(before).toContain('"thinkingSignature":"sig-2"');
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now() - 14 * 60 * 60 * 1000,
		});
		const cold = JSON.stringify(await pass());
		expect(cold).toContain('"thinkingSignature":"sig-2"');
		expect(cold).toContain('"thinkingSignature":"sig-4"');
		updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() });
		expect(JSON.stringify(await pass())).toBe(cold);
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
	}
});

for (const trigger of ["wall", "final fit"] as const)
	for (const outcome of ["fits", "still too large"] as const) {
		test(`Pi ${trigger} strips kept thinking before emergency reclaim and ${outcome}`, async () => {
			const db = createTestDb();
			const sessionId = `pi-signed-fit-${trigger}-${outcome}`;
			getOrCreateSessionMeta(db, sessionId);
			updateSessionMeta(db, sessionId, {
				piStableIdScheme: 1,
				lastResponseTime: Date.now(),
				cacheTtl: "13h",
			});
			const fake = createFakePi();
			Object.assign(fake.pi, {
				getAllTools: () => [
					{
						name: "read",
						description: "Read a file",
						parameters: {
							type: "object",
							properties: { path: { type: "string" } },
						},
					},
				],
				getActiveTools: () => ["read"],
			});
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTokens: 4000,
				protectedTools: { read: 0 },
				injection: {
					injectionBudgetTokens: 1000,
					memoryEnabled: false,
					injectDocs: false,
				},
				heuristics: { keepReasoningTokens: 10000 },
				scheduler: { executeThresholdPercentage: 65 },
			});
			const handler = fake.handlers.get("context")!;
			const source = [
				userMessage("start", 1),
				assistantMessage("", 2, {
					provider: "anthropic",
					model: "claude-opus-5-5",
					api: "anthropic-messages",
					content: [
						{
							type: "toolCall",
							id: "old-call",
							name: "read",
							arguments: { path: "old.ts" },
						},
					],
				}),
				{
					role: "toolResult",
					toolCallId: "old-call",
					toolName: "read",
					content: [{ type: "text", text: "small result" }],
					isError: false,
					timestamp: 3,
				},
			];
			const ids = ["u0", "old-tool", "old-result"];
			let percent = 20;
			const serve = async () => {
				const messages = structuredClone(source);
				const ctx = {
					...fakeContext(sessionId, process.cwd(), ids, messages as never),
					getSystemPrompt: () => "Read files for the task.",
					model: {
						provider: "anthropic",
						id: "claude-opus-5-5",
						api: "anthropic-messages",
						contextWindow: 100000,
					},
					getContextUsage: () => ({
						tokens: percent * 1000,
						percent,
						contextWindow: 100000,
					}),
				};
				return (
					(await handler({ messages } as never, ctx as never)) as {
						messages: unknown[];
					}
				).messages;
			};
			try {
				await serve();
				const tag = getTagsBySession(db, sessionId).find(
					(tag) => tag.type === "tool",
				)!;
				(source[2].content as { text: string }[])[0].text =
					"RECLAIMABLE ".repeat(60000);
				// Add newer results so the queued old result is no longer protected
				// by recency. Fit recovery can reclaim it without yielding the newest result.
				for (let n = 0; n < 3; n++) {
					source.push(
						assistantMessage("", 10 + n * 2, {
							content: [
								{
									type: "toolCall",
									id: `filler-${n}`,
									name: "read",
									arguments: {},
								},
							],
						}),
						{
							role: "toolResult",
							toolCallId: `filler-${n}`,
							toolName: "read",
							content: [{ type: "text", text: "filler words ".repeat(1000) }],
							isError: false,
							timestamp: 11 + n * 2,
						},
					);
					ids.push(`filler-call-${n}`, `filler-result-${n}`);
				}
				source.push(
					userMessage(
						outcome === "fits" ? "continue" : "MANDATORY_USER ".repeat(90000),
						4,
					),
					assistantMessage("current work", 5, {
						provider: "anthropic",
						model: "claude-opus-5-5",
						api: "anthropic-messages",
						content: [
							{
								type: "thinking",
								thinking: "kept signed thinking",
								thinkingSignature: "fit-signature",
							},
							{ type: "text", text: "current work" },
						],
					}),
				);
				ids.push("active-user", "active");
				source.push(
					assistantMessage("", 30, {
						content: [
							{
								type: "toolCall",
								id: "latest-fit-call",
								name: "read",
								arguments: {},
							},
						],
					}),
					{
						role: "toolResult",
						toolCallId: "latest-fit-call",
						toolName: "read",
						content: [
							{ type: "text", text: "LATEST FIT RESULT ".repeat(12000) },
						],
						isError: false,
						timestamp: 31,
					},
				);
				ids.push("latest-fit-call", "latest-fit-result");
				queuePendingOp(db, sessionId, tag.tagNumber, "drop");
				percent = trigger === "wall" ? 96 : 75;
				if (outcome === "fits") {
					const output = JSON.stringify(await serve());
					expect(output).not.toContain("fit-signature");
					expect(output).not.toContain("RECLAIMABLE");
					if (trigger === "final fit")
						expect(output).toContain("LATEST FIT RESULT");
				} else {
					// Even when thinking omission is replayed, the outgoing request must fit the model window.
					for (let attempt = 0; attempt < 2; attempt++)
						await expect(serve()).rejects.toMatchObject({
							name: "EmergencyFailClosedError",
						});
				}
				expect(getPendingOps(db, sessionId)).toHaveLength(0);
				expect(
					getTagsBySession(db, sessionId).find(
						(row) => row.tagNumber === tag.tagNumber,
					)?.status,
				).toBe("dropped");
			} finally {
				clearContextHandlerSession(sessionId);
				db.close();
			}
		}, 30_000);
	}

test("Pi empty message shells do not relax signed-prefix target protection", async () => {
	const db = createTestDb();
	const sessionId = "pi-projected-thinking-boundary";
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		piStableIdScheme: 1,
		cacheTtl: "13h",
		lastResponseTime: Date.now(),
	});
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTokens: 4000,
		injection: {
			injectionBudgetTokens: 1000,
			memoryEnabled: false,
			injectDocs: false,
		},
		heuristics: { keepReasoningTokens: 10000 },
		scheduler: { executeThresholdPercentage: 65 },
	});
	const handler = fake.handlers.get("context")!;
	const extra = {
		provider: "anthropic",
		model: "claude-opus-5-5",
		api: "anthropic-messages",
	};
	const source = [
		userMessage("old work", 1),
		assistantMessage("PROTECTED_OLD_BODY", 2, extra),
		...Array.from({ length: 12 }, (_, i) =>
			assistantMessage("", 3 + i, { ...extra, content: [] }),
		),
		userMessage("active work", 20),
	];
	const ids = [
		"old-user",
		"old-body",
		...Array.from({ length: 12 }, (_, i) => `empty-${i}`),
		"active-user",
	];
	const serve = async () => {
		const messages = structuredClone(source);
		const ctx = {
			...fakeContext(sessionId, process.cwd(), ids, messages),
			model: { ...extra, id: extra.model, contextWindow: 100000 },
			getContextUsage: () => ({
				tokens: 66000,
				percent: 66,
				contextWindow: 100000,
			}),
		};
		return (
			(await handler({ messages } as never, ctx as never)) as {
				messages: unknown[];
			}
		).messages;
	};
	try {
		await serve();
		source.push(
			assistantMessage("current", 21, {
				...extra,
				content: [
					{
						type: "thinking",
						thinking: "kept",
						thinkingSignature: "projected-kept",
					},
					{ type: "text", text: "current" },
				],
			}),
		);
		ids.push("active-thinking");
		const before = JSON.stringify(await serve());
		const old = getTagsBySession(db, sessionId).find((tag) =>
			tag.messageId.startsWith("old-body"),
		)!;
		queuePendingOp(db, sessionId, old.tagNumber, "drop");
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now() - 14 * 60 * 60 * 1000,
		});
		const after = JSON.stringify(await serve());
		expect(after).toBe(before);
		expect(after).toContain("PROTECTED_OLD_BODY");
		expect(after).toContain("projected-kept");
		expect(getPendingOps(db, sessionId)).toHaveLength(1);
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
	}
});

test("Pi unheld idle expiry preserves queued work and completed thinking until a priced rewrite", async () => {
	const db = createTestDb();
	const sessionId = "pi-unheld-idle-riders";
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		piStableIdScheme: 1,
		cacheTtl: "13h",
		lastResponseTime: Date.now(),
	});
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTokens: 4000,
		injection: {
			injectionBudgetTokens: 1000,
			memoryEnabled: false,
			injectDocs: false,
		},
		heuristics: { keepReasoningTokens: 10000 },
		scheduler: { executeThresholdPercentage: 65 },
	});
	const handler = fake.handlers.get("context")!;
	const source = [
		userMessage("old work", 1),
		assistantMessage("RECLAIM_OLD", 2, {
			provider: "anthropic",
			model: "claude-opus-5-5",
			content: [
				{
					type: "thinking",
					thinking: "old",
					thinkingSignature: "old-complete",
				},
				{ type: "text", text: "RECLAIM_OLD" },
			],
		}),
		userMessage("new work", 3),
	];
	const ids = ["old-user", "old-body", "new-user"];
	const serve = async (warm = false) => {
		const messages = structuredClone(warm ? source.slice(0, 1) : source);
		const ctx = {
			...fakeContext(
				sessionId,
				process.cwd(),
				warm ? ids.slice(0, 1) : ids,
				messages,
			),
			model: {
				provider: "anthropic",
				id: "claude-opus-5-5",
				api: "anthropic-messages",
				contextWindow: 100000,
			},
			getContextUsage: () => ({
				tokens: 20000,
				percent: 20,
				contextWindow: 100000,
			}),
		};
		return (
			(await handler({ messages } as never, ctx as never)) as {
				messages: unknown[];
			}
		).messages;
	};
	try {
		await serve(true);
		const baseline = JSON.stringify(await serve());
		const old = getTagsBySession(db, sessionId).find((tag) =>
			tag.messageId.startsWith("old-body"),
		)!;
		queuePendingOp(db, sessionId, old.tagNumber, "drop");
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now() - 14 * 60 * 60 * 1000,
		});
		const cold = JSON.stringify(await serve());
		expect(getPendingOps(db, sessionId)).toHaveLength(1);
		expect(cold).toBe(baseline);
		expect(cold).toContain("RECLAIM_OLD");
		expect(cold).toContain("old-complete");
		updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() });
		expect(JSON.stringify(await serve())).toBe(cold);
		signalPiPendingMaterialization(sessionId);
		const flushed = JSON.stringify(await serve());
		expect(getPendingOps(db, sessionId)).toHaveLength(0);
		expect(flushed).not.toContain("RECLAIM_OLD");
		expect(flushed).not.toContain("old-complete");
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
	}
});
