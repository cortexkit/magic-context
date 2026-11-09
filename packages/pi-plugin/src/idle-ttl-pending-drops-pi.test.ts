import {
	afterEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
	spyOn,
} from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeHardCacheExpired } from "@magic-context/core/features/magic-context/scheduler";
import {
	getOrCreateSessionMeta,
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import * as loggerModule from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	__test as contextHandlerInternals,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import {
	persistPiMessageEndModelMeta,
	persistPiPressureFromMessageEnd,
} from "./index";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

// Issue 545: a Pi session with a 30m cache TTL and queued ctx_reduce drops sat
// idle for 1h42m. Pi emits message_end for the user's new prompt before it runs
// the context pass, and that message_end used to stamp last_response_time as if
// a provider response had just arrived, so every idle check saw an elapsed time
// of a few ms. The idle clock must still read the expiry correctly (the status
// views and the system date use it), but an expired cache no longer applies the
// queued drops: when only the provider forgot the cache, the pass replays the
// same bytes and the drops wait for a real rebuild.

const T0 = Date.parse("2026-09-26T15:31:18.000Z");
const MINUTE = 60_000;
const MODEL = { provider: "test-provider", id: "test-model" };
const CACHE_TTL_CONFIG = { default: "5m", "test-provider/test-model": "30m" };

function providerUsage(inputTokens: number) {
	return {
		usage: {
			input: inputTokens,
			output: 40,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 40,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function setup(
	sessionId: string,
	model = MODEL,
	cacheTtlConfig:
		| string
		| (Record<string, string> & { default: string }) = CACHE_TTL_CONFIG,
	protectedTokens?: number,
) {
	const logs: string[] = [];
	spyOn(loggerModule, "sessionLog").mockImplementation(
		(_session: string, ...parts: unknown[]) => {
			logs.push(parts.map(String).join(" "));
		},
	);
	const root = createTestTempDirFromPath(join(tmpdir(), "mc-idle-ttl-"));
	const db = createTestDb();
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		heuristics: {},
		injection: { injectionBudgetTokens: 10_000 },
		protectedTags: 1,
		protectedTokens,
		scheduler: { executeThresholdPercentage: 65 },
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<unknown>;
	const lines: string[] = [];
	const restoreObserver =
		contextHandlerInternals.setPendingDecisionLogObserverForTests((line) =>
			lines.push(line),
		);

	// The same two calls index.ts makes from pi.on("message_end").
	const messageEnd = async (message: PiMessage) => {
		persistPiMessageEndModelMeta({
			db,
			sessionId,
			message,
			cacheTtlConfig,
		});
		await persistPiPressureFromMessageEnd({
			db,
			sessionId,
			message,
			piContextWindow: 100_000,
			piContextWindowSource: "catalog",
			piModel: model,
		});
	};

	const runPass = async (
		messages: PiMessage[],
		percent: number,
		nextModel = model,
	) => {
		await handler({ messages: messages as never[] }, {
			...fakeContext(
				sessionId,
				root,
				messages.map((_message, index) => `entry-${index}`),
				messages,
			),
			model: { ...nextModel, contextWindow: 100_000 },
			getContextUsage: () => ({
				tokens: percent * 1_000,
				percent,
				contextWindow: 100_000,
			}),
		} as never);
	};

	const cleanup = () => {
		restoreObserver();
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
		rmSync(root, { recursive: true, force: true });
	};
	return { db, lines, logs, messageEnd, runPass, cleanup };
}

const user1 = userMessage(`first request ${"context ".repeat(200)}`, 1);
const assistant1 = assistantMessage(
	`first answer ${"detail ".repeat(200)}`,
	2,
	{ provider: MODEL.provider, model: MODEL.id, ...providerUsage(20_000) },
);

// Runs the turn before the pause: one pass, the provider's answer, and a
// queued drop of the first tag, all at T0.
async function turnBeforePause(
	ctx: ReturnType<typeof setup>,
	sessionId: string,
) {
	// The provider answers a few seconds after the pass that built the request.
	setSystemTime(new Date(T0 - 5_000));
	await ctx.runPass([user1], 20);
	setSystemTime(new Date(T0));
	await ctx.messageEnd(assistant1);
	const meta = getOrCreateSessionMeta(ctx.db, sessionId);
	expect(meta.cacheTtl).toBe("30m");
	expect(meta.lastResponseTime).toBe(T0);
	const target = getTagsBySession(ctx.db, sessionId).find(
		(tag) => tag.status === "active",
	);
	if (!target) throw new Error("the first pass tagged nothing");
	queuePendingOp(ctx.db, sessionId, target.id, "drop");
	ctx.lines.length = 0;
	return target.id;
}

function cacheExpired(ctx: ReturnType<typeof setup>, sessionId: string) {
	const meta = getOrCreateSessionMeta(ctx.db, sessionId);
	return computeHardCacheExpired(
		meta.cacheTtl,
		meta.lastResponseTime,
		Date.now(),
	);
}

function tagStatus(
	ctx: ReturnType<typeof setup>,
	sessionId: string,
	id: number,
) {
	return getTagsBySession(ctx.db, sessionId).find((tag) => tag.id === id)
		?.status;
}

describe("Pi idle past the cache TTL keeps queued drops queued (issue 545)", () => {
	afterEach(() => {
		setSystemTime();
		mock.restore();
	});

	it.each([
		"gpt-6",
		"unknown",
	])("built-in TTL real transform: %s after ten idle minutes", async (id) => {
		const model = { provider: "openai", id };
		const sessionId = `ses-built-in-${id}`;
		const ctx = setup(sessionId, model, "5m");
		try {
			setSystemTime(new Date(T0 - 5_000));
			await ctx.runPass([user1], 20);
			setSystemTime(new Date(T0));
			const answer = assistantMessage("answer", 2, {
				provider: model.provider,
				model: id,
				...providerUsage(20_000),
			});
			await ctx.messageEnd(answer);
			const tag = getTagsBySession(ctx.db, sessionId).find(
				(tag) => tag.status === "active",
			);
			if (!tag) throw new Error("first pass tagged nothing");
			queuePendingOp(ctx.db, sessionId, tag.id, "drop");
			ctx.lines.length = 0;
			ctx.logs.length = 0;
			setSystemTime(new Date(T0 + 10 * MINUTE));
			await ctx.runPass([user1, answer, userMessage("continue", 3)], 20);
			// gpt-6 keeps its 30m built-in TTL warm; the unknown model's 5m expired.
			const known = id === "gpt-6";
			expect(cacheExpired(ctx, sessionId)).toBe(!known);
			expect(getPendingOps(ctx.db, sessionId)).toHaveLength(1);
			expect(
				ctx.logs.some((line) =>
					line.startsWith("pi m[0] HARD fold decision: reason=ttl_idle "),
				),
			).toBe(false);
			expect(
				ctx.lines.some((line) => line.includes("reason=scheduler_defer")),
			).toBe(true);
		} finally {
			ctx.cleanup();
		}
	});

	it("advances last_response_time for served assistants, never user/tool/error events", async () => {
		const sessionId = "ses-545-stamp";
		const ctx = setup(sessionId);
		try {
			setSystemTime(new Date(T0));
			await ctx.messageEnd(assistant1);
			expect(getOrCreateSessionMeta(ctx.db, sessionId).lastResponseTime).toBe(
				T0,
			);

			// The user's next prompt, a tool result, and a failed request (Pi
			// records a provider error as an assistant message with zero usage)
			// are not provider responses; none of them refreshed the cache.
			setSystemTime(new Date(T0 + 40 * MINUTE));
			await ctx.messageEnd(userMessage("continue", 3));
			await ctx.messageEnd(toolResultMessage("call-1", "tool output", 4));
			await ctx.messageEnd(
				assistantMessage("", 5, {
					provider: MODEL.provider,
					model: MODEL.id,
					stopReason: "error",
					errorMessage: "429 You exceeded your current quota",
				}),
			);
			expect(getOrCreateSessionMeta(ctx.db, sessionId).lastResponseTime).toBe(
				T0,
			);

			setSystemTime(new Date(T0 + 41 * MINUTE));
			await ctx.messageEnd(
				assistantMessage("next answer", 6, {
					provider: MODEL.provider,
					model: MODEL.id,
					...providerUsage(21_000),
				}),
			);
			expect(getOrCreateSessionMeta(ctx.db, sessionId).lastResponseTime).toBe(
				T0 + 41 * MINUTE,
			);
		} finally {
			ctx.cleanup();
		}
	});

	it("expires once after a switch to usage-less completed replies, never on aborted replies", async () => {
		const sessionId = "ses-pi-no-usage-switch";
		const ctx = setup(sessionId);
		try {
			await turnBeforePause(ctx, sessionId);
			setSystemTime(new Date(T0 + 102 * MINUTE));
			await ctx.messageEnd(
				assistantMessage("", 3, {
					stopReason: "aborted",
					errorMessage: "Request was aborted",
				}),
			);
			expect(getOrCreateSessionMeta(ctx.db, sessionId).lastResponseTime).toBe(
				T0,
			);
			await ctx.runPass([user1, assistant1, userMessage("new model", 4)], 20);
			await ctx.messageEnd(
				assistantMessage("usage-less answer", 5, {
					provider: MODEL.provider,
					model: "usage-less",
					stopReason: "stop",
					usage: {},
				}),
			);
			expect(getOrCreateSessionMeta(ctx.db, sessionId).lastResponseTime).toBe(
				T0 + 102 * MINUTE,
			);
			ctx.logs.length = 0;
			setSystemTime(new Date(T0 + 103 * MINUTE));
			await ctx.runPass([user1, assistant1, userMessage("warm", 6)], 20);
			expect(ctx.logs.some((line) => line.includes("decision=defer"))).toBe(
				true,
			);
			await ctx.messageEnd(
				assistantMessage("still usage-less", 7, {
					provider: MODEL.provider,
					model: "usage-less",
					stopReason: "stop",
					usage: {},
				}),
			);
			ctx.logs.length = 0;
			setSystemTime(new Date(T0 + 104 * MINUTE));
			await ctx.runPass([user1, assistant1, userMessage("warm again", 8)], 20);
			expect(ctx.logs.some((line) => line.includes("decision=defer"))).toBe(
				true,
			);
		} finally {
			ctx.cleanup();
		}
	});

	it("keeps queued drops on the first pass after the user returns from an idle past the TTL", async () => {
		const sessionId = "ses-545-user-returns";
		const ctx = setup(sessionId);
		try {
			const target = await turnBeforePause(ctx, sessionId);

			// 1h42m later the user types "continue". Pi emits that prompt's
			// message_end before it runs the context pass.
			setSystemTime(new Date(T0 + 102 * MINUTE));
			const resume = userMessage("continue", 3);
			await ctx.messageEnd(resume);
			await ctx.runPass([user1, assistant1, resume], 20);

			// The idle clock sees the cache as expired, but only the provider
			// forgot it: no fold, and the queued drop waits for a real rebuild.
			expect(cacheExpired(ctx, sessionId)).toBe(true);
			expect(ctx.lines).toContain(
				"pending ops WILL NOT APPLY — reason=scheduler_defer pendingOps=1 context=20.0%",
			);
			expect(
				ctx.logs.some((line) =>
					line.startsWith("pi m[0] HARD fold decision: reason=ttl_idle "),
				),
			).toBe(false);
			expect(getPendingOps(ctx.db, sessionId)).toHaveLength(1);
			expect(tagStatus(ctx, sessionId, target)).toBe("active");
		} finally {
			ctx.cleanup();
		}
	});

	it("keeps queued drops when the last request before the pause failed", async () => {
		const sessionId = "ses-545-error-before-pause";
		const ctx = setup(sessionId);
		try {
			const target = await turnBeforePause(ctx, sessionId);

			// 20 minutes later a request fails on quota. The cache was last
			// refreshed at T0, so it is dead from T0 + 30m on.
			setSystemTime(new Date(T0 + 20 * MINUTE));
			const retry = userMessage("try again", 3);
			await ctx.messageEnd(retry);
			await ctx.runPass([user1, assistant1, retry], 20);
			expect(getPendingOps(ctx.db, sessionId)).toHaveLength(1);
			await ctx.messageEnd(
				assistantMessage("", 4, {
					provider: MODEL.provider,
					model: MODEL.id,
					stopReason: "error",
					errorMessage: "429 You exceeded your current quota",
				}),
			);

			// Pi retries the failed request with agent.continue(), which runs
			// the context pass with no new message_end. 31 minutes after T0.
			setSystemTime(new Date(T0 + 31 * MINUTE));
			await ctx.runPass([user1, assistant1, retry], 20);

			// The failed request did not refresh the idle clock, so the cache
			// reads as expired; the expiry alone still applies nothing.
			expect(cacheExpired(ctx, sessionId)).toBe(true);
			expect(getPendingOps(ctx.db, sessionId)).toHaveLength(1);
			expect(tagStatus(ctx, sessionId, target)).toBe("active");
		} finally {
			ctx.cleanup();
		}
	});

	it("still defers queued drops while the cache is warm", async () => {
		const sessionId = "ses-545-warm";
		const ctx = setup(sessionId);
		try {
			const target = await turnBeforePause(ctx, sessionId);

			setSystemTime(new Date(T0 + 10 * MINUTE));
			const resume = userMessage("continue", 3);
			await ctx.messageEnd(resume);
			await ctx.runPass([user1, assistant1, resume], 20);

			expect(ctx.lines).toContain(
				"pending ops WILL NOT APPLY — reason=scheduler_defer pendingOps=1 context=20.0%",
			);
			expect(getPendingOps(ctx.db, sessionId)).toHaveLength(1);
			expect(tagStatus(ctx, sessionId, target)).toBe("active");
		} finally {
			ctx.cleanup();
		}
	});
});

describe("Pi/Oh My Pi distance-based age bookmark", () => {
	afterEach(() => {
		setSystemTime();
		mock.restore();
	});

	it.each([
		2, 3, 5,
	])("keeps current-task outputs through %i flush rebuilds and a model switch", async (rebuilds) => {
		const sessionId = `ses-pi-distance-${rebuilds}`;
		const ctx = setup(sessionId, MODEL, "5m", 4000);
		const messages: PiMessage[] = [userMessage("implement the feature")];
		for (let index = 0; index < 8; index++) {
			messages.push(
				assistantToolCall(
					`call-${index}`,
					"bash",
					{ command: `inspect ${index}` },
					index * 2 + 2,
				),
			);
			messages.push({
				...toolResultMessage(
					`call-${index}`,
					`result ${index} ${"payload ".repeat(1500)}`,
					index * 2 + 3,
				),
				toolName: "bash",
			});
		}
		try {
			setSystemTime(new Date(T0 - 5000));
			await ctx.runPass([...messages], 2);
			setSystemTime(new Date(T0));
			await ctx.messageEnd(
				assistantMessage("done", 100, { ...providerUsage(2000) }),
			);
			for (let pass = 1; pass <= rebuilds; pass++) {
				setSystemTime(new Date(T0 + pass * 6 * MINUTE));
				// An expired cache rebuilds nothing, so each rebuild is a user flush.
				signalPiPendingMaterialization(sessionId, "user_flush");
				let rebuilt = false;
				const restoreObserver =
					contextHandlerInternals.setPipelineResultObserverForTests(
						(id, result) => {
							if (id === sessionId && result.prefixBustPermitted)
								rebuilt = true;
						},
					);
				try {
					await ctx.runPass([...messages], 2);
				} finally {
					restoreObserver();
				}
				expect(rebuilt).toBe(true);
				expect(
					getTagsBySession(ctx.db, sessionId).filter(
						(tag) => tag.type === "tool" && tag.status === "active",
					),
				).toHaveLength(8);
				expect(
					getOrCreateSessionMeta(ctx.db, sessionId).toolReclaimWatermark,
				).toBe(0);
				expect(
					ctx.logs.filter((line) =>
						line.startsWith("pi m[0] HARD fold firing: reason=ttl_idle"),
					),
				).toHaveLength(0);
				setSystemTime(new Date(T0 + pass * 6 * MINUTE + 1000));
				await ctx.messageEnd(
					assistantMessage("still working", 100 + pass, {
						...providerUsage(2000),
					}),
				);
			}
			await ctx.runPass([...messages], 2, {
				provider: "test-provider",
				id: "other-model",
			});
			expect(
				getOrCreateSessionMeta(ctx.db, sessionId).toolReclaimWatermark,
			).toBe(0);
			const tools = getTagsBySession(ctx.db, sessionId).filter(
				(tag) => tag.type === "tool",
			);
			expect(tools.every((tag) => tag.status === "active")).toBe(true);
			setSystemTime(new Date(T0 + rebuilds * 6 * MINUTE + 2000));
			await ctx.messageEnd(
				assistantMessage("switched", 200, {
					model: "other-model",
					...providerUsage(2000),
				}),
			);
			queuePendingOp(ctx.db, sessionId, tools[0]!.id, "drop");
			setSystemTime(new Date(T0 + (rebuilds + 1) * 6 * MINUTE));
			await ctx.runPass([...messages], 2);
			expect(getPendingOps(ctx.db, sessionId)).toHaveLength(0);
			expect(
				getTagsBySession(ctx.db, sessionId).filter(
					(tag) => tag.type === "tool" && tag.status === "dropped",
				),
			).toHaveLength(1);
		} finally {
			ctx.cleanup();
		}
	});

	it("single-user tool loop ages only the output followed by a quarter-window of tokens", async () => {
		const sessionId = "ses-pi-token-distance";
		const ctx = setup(sessionId, MODEL, "5m", 4000);
		const messages: PiMessage[] = [userMessage("one coding task")];
		for (let index = 0; index < 4; index++) {
			messages.push(
				assistantToolCall(
					`loop-${index}`,
					"bash",
					{ command: `inspect ${index}` },
					index * 2 + 2,
				),
			);
			messages.push({
				...toolResultMessage(
					`loop-${index}`,
					`result ${index} ${"payload ".repeat(index === 0 ? 500 : 9000)}`,
					index * 2 + 3,
				),
				toolName: "bash",
			});
		}
		try {
			setSystemTime(new Date(T0 - 5000));
			await ctx.runPass([...messages], 2);
			const tools = getTagsBySession(ctx.db, sessionId).filter(
				(tag) => tag.type === "tool",
			);
			expect(tools.map((tag) => tag.status)).toEqual(Array(4).fill("active"));
			expect(
				getOrCreateSessionMeta(ctx.db, sessionId).toolReclaimWatermark,
			).toBe(tools[0]!.tagNumber);
			setSystemTime(new Date(T0));
			await ctx.messageEnd(
				assistantMessage("still working", 100, { ...providerUsage(2000) }),
			);
			setSystemTime(new Date(T0 + 6 * MINUTE));
			// An expired cache rebuilds nothing; a user flush is the rebuild here.
			signalPiPendingMaterialization(sessionId, "user_flush");
			await ctx.runPass([...messages], 2);
			expect(
				getTagsBySession(ctx.db, sessionId)
					.filter((tag) => tag.type === "tool")
					.map((tag) => tag.status),
			).toEqual(["dropped", "active", "active", "active"]);
		} finally {
			ctx.cleanup();
		}
	});

	it("distant outputs and edits survive one free rebuild, then reclaim at low usage", async () => {
		const sessionId = "ses-pi-distance-edits";
		const ctx = setup(sessionId, MODEL, "5m", 4000);
		const messages: PiMessage[] = [userMessage("edit the feature")];
		for (let index = 0; index < 2; index++) {
			messages.push(
				assistantToolCall(
					`edit-${index}`,
					"edit",
					{ filePath: "/feature.ts", oldText: "a", newText: "b" },
					index * 2 + 2,
				),
			);
			messages.push({
				...toolResultMessage(`edit-${index}`, "edited", index * 2 + 3),
				toolName: "edit",
			});
		}
		messages.push(
			assistantToolCall("old-bash", "bash", { command: "inspect" }, 6),
		);
		messages.push({
			...toolResultMessage("old-bash", "payload ".repeat(500), 7),
			toolName: "bash",
		});
		for (let index = 0; index < 24; index++) {
			messages.push(
				index < 3
					? userMessage(
							"<system-reminder>Background task finished.</system-reminder>",
							index + 10,
						)
					: assistantMessage(`continuation ${index}`, index + 10),
			);
		}
		for (let index = 0; index < 3; index++) {
			messages.push(
				assistantToolCall(
					`guard-${index}`,
					"bash",
					{ command: `guard ${index}` },
					100 + index * 2,
				),
			);
			messages.push({
				...toolResultMessage(
					`guard-${index}`,
					`guard ${index} ${"tail ".repeat(2000)}`,
					101 + index * 2,
				),
				toolName: "bash",
			});
		}
		try {
			setSystemTime(new Date(T0 - 5000));
			await ctx.runPass([...messages], 2);
			const tools = getTagsBySession(ctx.db, sessionId).filter(
				(tag) => tag.type === "tool",
			);
			expect(tools.map((tag) => tag.status)).toEqual(Array(6).fill("active"));
			expect(
				getOrCreateSessionMeta(ctx.db, sessionId).toolReclaimWatermark,
			).toBe(tools[2]!.tagNumber);
			setSystemTime(new Date(T0));
			await ctx.messageEnd(
				assistantMessage("done", 100, { ...providerUsage(2000) }),
			);
			setSystemTime(new Date(T0 + 6 * MINUTE));
			// An expired cache rebuilds nothing; a user flush is the rebuild here.
			signalPiPendingMaterialization(sessionId, "user_flush");
			await ctx.runPass([...messages], 2);
			const after = getTagsBySession(ctx.db, sessionId).filter(
				(tag) => tag.type === "tool",
			);
			expect(after.map((tag) => tag.status)).toEqual([
				"dropped",
				"active",
				"dropped",
				"active",
				"active",
				"active",
			]);
			expect(after[0]!.dropMode).toBe("edit_marker");
		} finally {
			ctx.cleanup();
		}
	});
});
