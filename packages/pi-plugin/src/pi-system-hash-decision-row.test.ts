import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { openDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { __test as decisionLog } from "@magic-context/core/features/magic-context/transform-decision-log";
import { setHarness } from "@magic-context/core/shared/harness";
import * as logger from "@magic-context/core/shared/logger";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiSystemHashChange,
} from "./context-handler";
import { persistPiPressureFromMessageEnd } from "./index";
import {
	clearPiSystemPromptSession,
	processSystemPromptForCache,
} from "./system-prompt";
import {
	assistantMessage,
	createFakePi,
	fakeContext,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

// A changed system prompt rewrites the provider's prompt cache on the first
// request that carries it. In a signed Anthropic tool loop Pi keeps m[0]/m[1]
// frozen on that request (the head is delivered with the new prompt), so its
// pass changes no history bytes and used to stage no transform_decisions row.
// On a prefix-bound model the held turn's signed thinking is invalid behind
// the changed prompt, so that request strips it. The row bound to that
// request's reply must still name system_hash, and passes with an unchanged
// prompt add no row.

const roots: string[] = [];
afterEach(() => {
	decisionLog.reset();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const parent = join(tmpdir(), "magic-context", "issue-713");
	mkdirSync(parent, { recursive: true });
	const root = createTestTempDirFromPath(join(parent, "pi-system-hash-row-"));
	roots.push(root);
	const sessionId = "pi-system-hash-row";
	// The late row write reopens the database by path, so it must be on disk
	// and opened through openDatabase, which records that path.
	setHarness("pi");
	const db = openDatabase(join(root, "context.db"));
	if (!db) throw new Error("throwaway database unavailable");
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		piStableIdScheme: 1,
		lastResponseTime: Date.now(),
		cacheTtl: "never",
	});
	const fake = createFakePi();
	Object.assign(fake.pi, {
		getAllTools: () => [
			{ name: "read", description: "Read", parameters: { type: "object" } },
		],
		getActiveTools: () => ["read"],
	});
	registerPiContextHandler(fake.pi as never, {
		db,
		tagger: createTagger(),
		protectedTokens: 4000,
		injection: {
			injectionBudgetTokens: 1000,
			memoryEnabled: false,
			injectDocs: false,
		},
		protectedTools: { read: 0 },
		heuristics: { keepReasoningTokens: 2000 },
		scheduler: { executeThresholdPercentage: 65 },
	});
	const model = "claude-opus-5-5";
	const extra = (content: unknown[]) => ({
		provider: "anthropic",
		model,
		api: "anthropic-messages",
		content,
	});
	const source: PiMessage[] = [
		userMessage("earlier task", 1),
		assistantMessage(
			"",
			2,
			extra([
				{
					type: "toolCall",
					id: "old-call",
					name: "read",
					arguments: { path: "old.ts" },
				},
			]),
		),
		toolResultMessage("old-call", "historical result", 3),
		userMessage("current task", 40),
	];
	const ids = ["old-prompt", "old-answer", "old-result", "prompt"];
	const branch: unknown[] = [];
	const responses: unknown[] = [];
	let responseCounter = 0;
	/** One provider request: before_agent_start's prompt step, then the context pass. */
	const serve = async (text: string) => {
		// Same steps as the before_agent_start handler in index.ts.
		const prompt = processSystemPromptForCache({
			db,
			sessionId,
			systemPrompt: text,
			isCacheBusting: false,
		});
		if (prompt.hashChanged)
			signalPiSystemHashChange(sessionId, prompt.currentHash);
		const messages = structuredClone(source);
		const parentId = ids.at(-1) ?? null;
		branch.splice(
			0,
			branch.length,
			...ids.map((id, index) => ({
				type: "message",
				id,
				message: messages[index],
			})),
			...responses,
		);
		const ctx = {
			...fakeContext(sessionId, process.cwd(), [...ids], messages),
			sessionManager: {
				getSessionId: () => sessionId,
				getLeafId: () => parentId,
				getBranch: () => branch,
			},
			getSystemPrompt: () => prompt.systemPrompt,
			model: {
				provider: "anthropic",
				id: model,
				api: "anthropic-messages",
				contextWindow: 200000,
			},
			getContextUsage: () => ({
				tokens: 20000,
				percent: 10,
				contextWindow: 200000,
			}),
		};
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("context handler was not registered");
		const served = (await handler({ messages } as never, ctx as never)) as {
			messages: unknown[];
		};
		// The provider answers this request. The decision row staged by this
		// pass is written against this reply's entry id when the next pass starts.
		const message = {
			role: "assistant",
			timestamp: Date.now() + ++responseCounter,
			provider: "anthropic",
			model,
			stopReason: "toolUse",
			usage: { input: 1000, output: 10, cacheRead: 1000, cacheWrite: 0 },
		};
		const id = `response-${responseCounter}`;
		const entry = { type: "message", id, parentId, message };
		responses.push(entry);
		branch.push(entry);
		persistPiPressureFromMessageEnd({
			db,
			sessionId,
			piContextWindow: 200000,
			message,
		});
		// The next context pass queues the row write for this pass on a timer,
		// and a pass that starts before the timer fires discards it. Real
		// requests are seconds apart, so let the timer run.
		await new Promise((resolve) => setTimeout(resolve, 20));
		return { messages: served.messages, prompt, id };
	};
	// Enter a signed tool loop: the newest assistant carries signed thinking
	// whose recorded reasoning is heavy enough for Pi to hold the turn.
	const hold = () => {
		source.push(
			assistantMessage("", 50, {
				...extra([
					{
						type: "thinking",
						thinking: "active plan",
						thinkingSignature: "kept-signature",
					},
					{
						type: "toolCall",
						id: "active-call",
						name: "read",
						arguments: { path: "current.ts" },
					},
				]),
				usage: {
					input: 0,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 50,
					reasoning: 1_600,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
			toolResultMessage("active-call", "current result", 51),
		);
		ids.push("thinking", "result");
	};
	const rows = () =>
		db
			.prepare(
				"SELECT message_id, decision, materialize_reason FROM transform_decisions WHERE session_id = ? ORDER BY rowid",
			)
			.all(sessionId) as Array<{
			message_id: string;
			decision: string;
			materialize_reason: string | null;
		}>;
	return {
		db,
		sessionId,
		serve,
		hold,
		rows,
		pair: () => {
			const meta = getOrCreateSessionMeta(db, sessionId);
			return `${meta.cachedM0Bytes}\u0000${meta.cachedM1Bytes}`;
		},
		close: () => {
			clearContextHandlerSession(sessionId);
			clearPiSystemPromptSession(sessionId);
			db.close();
		},
	};
}

it("Pi: the held pass that carries a system prompt change records system_hash", async () => {
	const f = fixture();
	try {
		await f.serve("base instruction");
		f.hold();
		await f.serve("base instruction");
		const control = await f.serve("base instruction");
		const prefix = f.pair();
		const changed = await f.serve("genuine changed instruction");
		// The change rode a held signed loop: m[0]/m[1] did not move. The held
		// turn's signed thinking, invalid behind the new prompt, was stripped.
		expect(f.pair()).toBe(prefix);
		expect(JSON.stringify(changed.messages)).not.toContain("active plan");
		const after = await f.serve("genuine changed instruction");
		// The row staged by the pass before this one is written when this pass starts.
		await f.serve("genuine changed instruction");
		// The write is asynchronous, so wait for the changed pass's row rather than
		// for a fixed delay that a slow runner can outlast.
		const deadline = Date.now() + 5_000;
		while (
			!f.rows().some((row) => row.message_id === changed.id) &&
			Date.now() < deadline
		)
			await new Promise((resolve) => setTimeout(resolve, 10));

		const rows = f.rows();
		expect(rows.filter((row) => row.message_id === changed.id)).toEqual([
			expect.objectContaining({ materialize_reason: "system_hash" }),
		]);
		// Ordinary held passes before and after the change add no row.
		expect(rows.some((row) => row.message_id === control.id)).toBe(false);
		expect(rows.some((row) => row.message_id === after.id)).toBe(false);
		expect(
			rows.filter((row) => row.materialize_reason === "system_hash"),
		).toHaveLength(1);
	} finally {
		f.close();
	}
}, 60_000);

it("Pi: the pass after a released held system prompt change replays it byte for byte", async () => {
	const f = fixture();
	const logs = spyOn(logger, "sessionLog");
	try {
		await f.serve("base instruction");
		f.hold();
		await f.serve("base instruction");
		const held = await f.serve("base instruction");
		expect(JSON.stringify(held.messages)).toContain("active plan");
		const changed = await f.serve("genuine changed instruction");
		expect(JSON.stringify(changed.messages)).not.toContain("active plan");
		// The held path released it, not an unheld bust.
		expect(
			logs.mock.calls.some(
				(call) =>
					call[1] ===
					"system prompt changed under a held signed turn: releasing signed thinking",
			),
		).toBe(true);
		const pair = f.pair();
		const after = await f.serve("genuine changed instruction");
		// The strip and the folded head replay unchanged; nothing new lands.
		expect(JSON.stringify(after.messages)).toBe(
			JSON.stringify(changed.messages),
		);
		expect(f.pair()).toBe(pair);
	} finally {
		logs.mockRestore();
		f.close();
	}
}, 60_000);
