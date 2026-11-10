import { afterEach, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { openDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	_resetHarnessForTesting,
	setHarness,
} from "@magic-context/core/shared/harness";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiSystemHashChange,
} from "./context-handler";
import {
	clearPiSystemPromptSession,
	processSystemPromptForCache,
} from "./system-prompt";
import {
	assistantMessage,
	createFakePi,
	fakeContext,
	type PiMessage,
	userMessage,
} from "./test-utils.test";

// The request-tools release records a pass's tool list only after the pass
// has persisted the strip the change required (request-tools-release.ts,
// `commit`), so a pass whose strip did not land is evaluated again. On Pi with
// compaction on, the strip of a completed turn's thinking is persisted mid-pass
// and the end of the pass replays it. When that write fails, the pass must be
// refused rather than serve the thinking and record the new tool list anyway:
// every later pass would compare with that list, and the stale block would
// keep going out until the provider rejected it.

const MODEL = "claude-fable-5-2";
const THINKING = "SIGNED_AGAINST_THE_FIRST_TOOL_LIST";

type Tool = { name: string; description: string; parameters: object };

const roots: string[] = [];
afterEach(() => {
	_resetHarnessForTesting();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture(name: string) {
	const parent = join(tmpdir(), "magic-context", "request-tools-persistence");
	mkdirSync(parent, { recursive: true });
	const root = createTestTempDirFromPath(join(parent, `pi-${name}-`));
	roots.push(root);
	const sessionId = `pi-request-tools-persistence-${name}`;
	_resetHarnessForTesting();
	setHarness("pi");
	const db = openDatabase(join(root, "context.db"));
	if (!db) throw new Error("throwaway database unavailable");
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		piStableIdScheme: 1,
		lastResponseTime: Date.now(),
		cacheTtl: "never",
	});
	const tools: Tool[] = [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object" },
		},
	];
	const active = ["read"];
	const fake = createFakePi();
	Object.assign(fake.pi, {
		getAllTools: () => structuredClone(tools),
		getActiveTools: () => [...active],
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
		heuristics: { keepReasoningTokens: 2000 },
		scheduler: { executeThresholdPercentage: 65 },
	});
	const anthropic = (content: unknown[]) => ({
		provider: "anthropic",
		model: MODEL,
		api: "anthropic-messages",
		content,
	});
	const source: PiMessage[] = [userMessage("first task", 1)];
	const ids = ["p1"];
	let clock = 1;
	const add = (id: string, message: PiMessage) => {
		source.push(message);
		ids.push(id);
	};
	const turn = (reply: unknown[], prompt: string) => {
		clock += 10;
		add(`a${ids.length}`, assistantMessage("", clock, anthropic(reply)));
		clock += 10;
		add(`p${ids.length}`, userMessage(prompt, clock));
	};
	const serve = async () => {
		const prompt = processSystemPromptForCache({
			db,
			sessionId,
			systemPrompt: "base instruction",
			isCacheBusting: false,
		});
		if (prompt.hashChanged)
			signalPiSystemHashChange(sessionId, prompt.currentHash);
		const messages = structuredClone(source);
		const ctx = {
			...fakeContext(sessionId, process.cwd(), [...ids], messages),
			getSystemPrompt: () => prompt.systemPrompt,
			model: {
				provider: "anthropic",
				id: MODEL,
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
		const served = (await handler({ messages } as never, ctx as never)) as
			| { messages: unknown[] }
			| undefined;
		return JSON.stringify(served?.messages ?? messages);
	};
	/** Make every write to the thinking-strip ledger fail, as a failed SQLite write would. */
	const failStripWrites = (fail: boolean) =>
		db.exec(
			fail
				? `CREATE TRIGGER fail_strip_ledger BEFORE UPDATE OF merged_reasoning_stripped_ids ON session_meta
				   WHEN NEW.merged_reasoning_stripped_ids IS NOT OLD.merged_reasoning_stripped_ids
				   BEGIN SELECT RAISE(ABORT, 'injected strip ledger write failure'); END;`
				: "DROP TRIGGER IF EXISTS fail_strip_ledger;",
		);
	return {
		tools,
		active,
		turn,
		serve,
		failStripWrites,
		close: () => {
			clearContextHandlerSession(sessionId);
			clearPiSystemPromptSession(sessionId);
			db.close();
		},
	};
}

it("control: Pi, claude-fable-5-2: with healthy writes the tool change strips the kept thinking for good", async () => {
	const f = fixture("healthy-strip-write");
	try {
		await f.serve();
		f.turn(
			[
				{
					type: "thinking",
					thinking: THINKING,
					thinkingSignature: "signed-block",
				},
				{ type: "text", text: "first done" },
			],
			"second task",
		);
		expect(await f.serve()).toContain(THINKING);
		f.turn([{ type: "text", text: "second done" }], "third task");
		expect(await f.serve()).toContain(THINKING);
		f.tools.push({
			name: "mcp_search",
			description: "Search the connected MCP server",
			parameters: { type: "object", properties: { query: { type: "string" } } },
		});
		f.active.push("mcp_search");
		f.turn(
			[{ type: "text", text: "third done" }],
			"a task after the tool change",
		);
		expect(await f.serve()).not.toContain(THINKING);
		f.turn([{ type: "text", text: "fourth done" }], "the next task");
		expect(await f.serve()).not.toContain(THINKING);
	} finally {
		f.close();
	}
}, 60_000);

it("Pi, claude-fable-5-2: a tool change whose strip could not be persisted is released again on the next pass", async () => {
	const f = fixture("failed-strip-write");
	try {
		await f.serve();
		f.turn(
			[
				{
					type: "thinking",
					thinking: THINKING,
					thinkingSignature: "signed-block",
				},
				{ type: "text", text: "first done" },
			],
			"second task",
		);
		expect(await f.serve()).toContain(THINKING);
		f.turn([{ type: "text", text: "second done" }], "third task");
		expect(await f.serve()).toContain(THINKING);
		f.tools.push({
			name: "mcp_search",
			description: "Search the connected MCP server",
			parameters: { type: "object", properties: { query: { type: "string" } } },
		});
		f.active.push("mcp_search");
		f.turn(
			[{ type: "text", text: "third done" }],
			"a task after the tool change",
		);
		f.failStripWrites(true);
		// The write fails: this request cannot strip, and goes out with the block.
		expect(await f.serve()).toContain(THINKING);
		f.failStripWrites(false);
		f.turn(
			[{ type: "text", text: "fourth done" }],
			"the next task, writes healthy again",
		);
		// The tool list it was bound to is gone, so the block must not go out.
		expect(await f.serve()).not.toContain(THINKING);
	} finally {
		f.close();
	}
}, 60_000);
