import {
	afterEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
	spyOn,
} from "bun:test";
import {
	getOrCreateSessionMeta,
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import * as loggerModule from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearContextHandlerSession,
	__test as contextHandlerInternals,
	registerPiContextHandler,
} from "./context-handler";
import {
	persistPiMessageEndModelMeta,
	persistPiPressureFromMessageEnd,
} from "./index";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

// Issue 545: a Pi session with a 30m cache TTL and queued ctx_reduce drops sat
// idle for 1h42m. The first pass after the pause logged decision=defer and the
// drops did not apply, although the provider cache was long gone. Pi emits
// message_end for the user's new prompt before it runs the context pass, and
// that message_end used to stamp last_response_time as if a provider response
// had just arrived, so every idle check saw an elapsed time of a few ms.

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

function setup(sessionId: string) {
	const logs: string[] = [];
	spyOn(loggerModule, "sessionLog").mockImplementation(
		(_session: string, ...parts: unknown[]) => {
			logs.push(parts.map(String).join(" "));
		},
	);
	const db = createTestDb();
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		heuristics: {},
		injection: { injectionBudgetTokens: 10_000 },
		protectedTags: 1,
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
			cacheTtlConfig: CACHE_TTL_CONFIG,
		});
		await persistPiPressureFromMessageEnd({
			db,
			sessionId,
			message,
			piContextWindow: 100_000,
			piContextWindowSource: "catalog",
			piModel: MODEL,
		});
	};

	const runPass = async (messages: PiMessage[], percent: number) => {
		await handler({ messages: messages as never[] }, {
			...fakeContext(
				sessionId,
				process.cwd(),
				messages.map((_message, index) => `entry-${index}`),
				messages,
			),
			model: { ...MODEL, contextWindow: 100_000 },
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

function tagStatus(
	ctx: ReturnType<typeof setup>,
	sessionId: string,
	id: number,
) {
	return getTagsBySession(ctx.db, sessionId).find((tag) => tag.id === id)
		?.status;
}

describe("Pi idle past the cache TTL applies queued drops (issue 545)", () => {
	afterEach(() => {
		setSystemTime();
		mock.restore();
	});

	it("advances last_response_time only for an assistant message that carries provider usage", async () => {
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

	it("applies queued drops on the first pass after the user returns from an idle past the TTL", async () => {
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

			// The cache is dead, so the scheduler executes and the ttl_idle HARD
			// fold rebuilds the prefix; the queued drop rides that fold.
			expect(ctx.lines).toContain(
				"pending ops WILL APPLY — reason=ride=hardFold (scheduler=execute), pendingOps=1 context=20.0%",
			);
			expect(
				ctx.logs.some((line) =>
					line.startsWith("pi m[0] HARD fold decision: reason=ttl_idle "),
				),
			).toBe(true);
			expect(getPendingOps(ctx.db, sessionId)).toHaveLength(0);
			expect(tagStatus(ctx, sessionId, target)).toBe("dropped");
		} finally {
			ctx.cleanup();
		}
	});

	it("applies queued drops when the last request before the pause failed", async () => {
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

			expect(getPendingOps(ctx.db, sessionId)).toHaveLength(0);
			expect(tagStatus(ctx, sessionId, target)).toBe("dropped");
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
