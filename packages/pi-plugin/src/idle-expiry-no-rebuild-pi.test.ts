// An idle expiry only means the provider forgot its prompt cache. The request's
// bytes before the conversation are unchanged, so resending them costs the same
// re-read as a rebuild and keeps every signed thinking block valid. These cases
// run Pi's context handler and check that such a pass replays the request byte
// for byte: queued drops stay queued, signed thinking stays, and a subagent's
// drops wait for its next execute pass.
import { expect, spyOn, test } from "bun:test";
import {
	getOrCreateSessionMeta,
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import * as loggerModule from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
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

const ANTHROPIC = {
	provider: "anthropic",
	id: "claude-opus-5-5",
	api: "anthropic-messages",
	contextWindow: 100_000,
};
const PLAIN = {
	provider: "test-provider",
	id: "test-model",
	contextWindow: 100_000,
};

/**
 * One Pi session at 30% usage (below the 65% execute threshold) whose cache
 * lifetime is five minutes. `pass()` serves the source and returns the
 * request's messages as served.
 */
function piSession(
	sessionId: string,
	source: PiMessage[],
	options: { subagent?: boolean; model?: typeof PLAIN | typeof ANTHROPIC } = {},
) {
	const db = createTestDb();
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		isSubagent: options.subagent === true,
		lastResponseTime: Date.now(),
		cacheTtl: "5m",
	});
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		tagger: createTagger(),
		protectedTokens: 4000,
		protectedTags: 1,
		heuristics: {},
		scheduler: { executeThresholdPercentage: 65 },
		injection: {
			injectionBudgetTokens: 1000,
			memoryEnabled: false,
			injectDocs: false,
		},
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<{ messages: unknown[] }>;
	let percent = 30;
	const logs: string[] = [];
	const log = spyOn(loggerModule, "sessionLog").mockImplementation(
		(_session: string, ...parts: unknown[]) => {
			logs.push(parts.map(String).join(" "));
		},
	);
	return {
		db,
		logs,
		setUsage(value: number) {
			percent = value;
		},
		/**
		 * The provider cache lifetime passed two hours ago, after a response
		 * that followed the last history-head render (as in a real session).
		 */
		idle() {
			db.prepare(
				"UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?",
			).run(Date.now() - 3 * 60 * 60 * 1000, sessionId);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now() - 2 * 60 * 60 * 1000,
			});
		},
		dropOldestTool(): number {
			const tool = getTagsBySession(db, sessionId)
				.filter((tag) => tag.type === "tool" && tag.status === "active")
				.sort((a, b) => a.tagNumber - b.tagNumber)[0];
			if (!tool) throw new Error("no active tool tag to drop");
			queuePendingOp(db, sessionId, tool.tagNumber, "drop");
			return tool.tagNumber;
		},
		status(tagNumber: number) {
			return getTagsBySession(db, sessionId).find(
				(tag) => tag.tagNumber === tagNumber,
			)?.status;
		},
		pendingOps() {
			return getPendingOps(db, sessionId).length;
		},
		/** Serves the source, or only its first `count` messages. */
		async pass(count = source.length) {
			logs.length = 0;
			const messages = structuredClone(source.slice(0, count));
			const result = await handler({ messages: messages as never[] }, {
				...fakeContext(
					sessionId,
					process.cwd(),
					messages.map((_message, index) => `entry-${index}`),
					messages,
				),
				model: options.model ?? PLAIN,
				getContextUsage: () => ({
					tokens: percent * 1000,
					percent,
					contextWindow: 100_000,
				}),
			} as never);
			updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() });
			return JSON.stringify(result.messages);
		},
		close() {
			log.mockRestore();
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		},
	};
}

/** A finished task of large tool outputs, then a new user turn. */
function toolTask(): PiMessage[] {
	const messages: PiMessage[] = [userMessage("implement the feature", 1)];
	for (let index = 0; index < 6; index++) {
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
		} as PiMessage);
	}
	messages.push(userMessage("next task", 20));
	return messages;
}

test("Pi: an idle expiry below the execute threshold replays the request byte-identically and keeps queued drops queued", async () => {
	const s = piSession("pi-idle-replay", toolTask());
	try {
		await s.pass();
		const warm = await s.pass();
		const tag = s.dropOldestTool();
		// A warm pass with the drop queued replays: the baseline the expiry must match.
		expect(await s.pass()).toBe(warm);
		s.idle();
		const expired = await s.pass();
		expect(
			s.logs.some((line) =>
				line.includes("HARD fold decision: reason=ttl_idle"),
			),
		).toBe(false);
		expect(expired).toBe(warm);
		expect(s.pendingOps()).toBe(1);
		expect(s.status(tag)).toBe("active");
		// The queued drop waits for a real rebuild and lands on it.
		signalPiPendingMaterialization("pi-idle-replay", "user_flush");
		await s.pass();
		expect(s.status(tag)).toBe("dropped");
		expect(s.pendingOps()).toBe(0);
	} finally {
		s.close();
	}
});

test("Pi: an idle expiry on a prefix-bound Anthropic model keeps the signed thinking", async () => {
	const thought = (n: number) =>
		assistantMessage(`answer ${n}`, n, {
			provider: ANTHROPIC.provider,
			model: ANTHROPIC.id,
			content: [
				{
					type: "thinking",
					thinking: `thought ${n}`,
					thinkingSignature: `sig-${n}`,
				},
				{ type: "text", text: `answer ${n}` },
			],
		});
	const s = piSession(
		"pi-idle-signed",
		[
			userMessage("old task", 1),
			thought(2),
			userMessage("active task", 3),
			thought(4),
		],
		{ model: ANTHROPIC },
	);
	try {
		// The first render rebuilds the head before any signed thinking is served.
		await s.pass(1);
		const warm = await s.pass();
		expect(warm).toContain('"thinkingSignature":"sig-4"');
		s.idle();
		const expired = await s.pass();
		expect(expired).toContain('"thinkingSignature":"sig-4"');
		expect(expired).toBe(warm);
	} finally {
		s.close();
	}
});

test("Pi: a subagent's queued drops wait through an idle expiry and land at its next execute pass", async () => {
	const s = piSession("pi-idle-subagent", toolTask(), { subagent: true });
	try {
		await s.pass();
		const warm = await s.pass();
		const tag = s.dropOldestTool();
		s.idle();
		expect(await s.pass()).toBe(warm);
		expect(s.pendingOps()).toBe(1);
		expect(s.status(tag)).toBe("active");
		s.setUsage(70);
		await s.pass();
		expect(s.status(tag)).toBe("dropped");
		expect(s.pendingOps()).toBe(0);
	} finally {
		s.close();
	}
});
