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

// Claude 5.1 and later models bind every signed thinking block to the `system`
// prompt, the `tools` array and the messages sent before it. Anthropic's edit
// table lists "Add, remove, rename, or edit a tool in `tools`" as invalidating
// those blocks, and Claude Fable 5.2 returns a 400 for an invalid block on
// every account. A request whose tool list changed therefore has to go out
// without the thinking earlier requests served.
//
// Pi lists a tool in its system prompt only when the tool has a prompt
// snippet, so a tool without one (or a changed description or schema) changes
// `tools` and leaves the system prompt identical. The kept block belongs to a
// completed earlier turn, so no signed-thinking hold is involved.

const MODEL = "claude-fable-5-2";
const THINKING = "SIGNED_AGAINST_THE_FIRST_TOOL_LIST";

type Tool = { name: string; description: string; parameters: object };

const roots: string[] = [];
afterEach(() => {
	_resetHarnessForTesting();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture(name: string, harness: "pi" | "omp" = "pi") {
	const parent = join(tmpdir(), "magic-context", "fable-5-2-tool-binding");
	mkdirSync(parent, { recursive: true });
	const root = createTestTempDirFromPath(join(parent, `pi-${name}-`));
	roots.push(root);
	const sessionId = `pi-fable-5-2-tools-${name}`;
	_resetHarnessForTesting();
	setHarness(harness);
	const db = openDatabase(join(root, "context.db"));
	if (!db) throw new Error("throwaway database unavailable");
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		piStableIdScheme: 1,
		lastResponseTime: Date.now(),
		cacheTtl: "never",
	});
	const tools: Tool[] = [
		{ name: "read", description: "Read a file", parameters: { type: "object" } },
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
	/** A completed reply, then the next user prompt. */
	const turn = (reply: unknown[], prompt: string) => {
		add(`a${ids.length}`, assistantMessage("", (clock += 10), anthropic(reply)));
		add(`p${ids.length}`, userMessage(prompt, (clock += 10)));
	};
	/** One provider request: the system-prompt step, then the context pass. */
	const serve = async (systemText: string) => {
		const prompt = processSystemPromptForCache({
			db,
			sessionId,
			systemPrompt: systemText,
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
	return {
		tools,
		active,
		/**
		 * The first task's reply carries signed thinking and stays on the wire
		 * across two later requests; then `change` and one more request.
		 */
		async acrossChange(change: () => string) {
			await serve("base instruction");
			turn(
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
			const kept = await serve("base instruction");
			turn([{ type: "text", text: "second done" }], "third task");
			const unchanged = await serve("base instruction");
			const systemText = change();
			turn(
				[{ type: "text", text: "third done" }],
				"a task after the change",
			);
			const changed = await serve(systemText);
			return { kept, unchanged, changed };
		},
		close: () => {
			clearContextHandlerSession(sessionId);
			clearPiSystemPromptSession(sessionId);
			db.close();
		},
	};
}

for (const harness of ["pi", "omp"] as const) {
	it(`${harness}, claude-fable-5-2: a system prompt change strips the kept signed thinking`, async () => {
		// Control for the fixtures below: a change Pi and OMP already treat as
		// a prefix rebuild removes the kept block.
		const f = fixture(`${harness}-system`, harness);
		try {
			const served = await f.acrossChange(() => "changed instruction");
			expect(served.kept).toContain(THINKING);
			expect(served.unchanged).toContain(THINKING);
			expect(served.changed).not.toContain(THINKING);
		} finally {
			f.close();
		}
	}, 60_000);
}

// Known gap: Pi's fold signals carry no tool identity (inject-compartments-pi.ts),
// so a tool that does not change the system prompt keeps the signed thinking,
// and Claude Fable 5.2 rejects the request. Remove `.failing` when a tool
// change strips that thinking.
it.failing("Pi, claude-fable-5-2: a tool added without a prompt snippet strips the kept signed thinking", async () => {
	const f = fixture("tool");
	try {
		const served = await f.acrossChange(() => {
			f.tools.push({
				name: "mcp_search",
				description: "Search the connected MCP server",
				parameters: {
					type: "object",
					properties: { query: { type: "string" } },
				},
			});
			f.active.push("mcp_search");
			return "base instruction";
		});
		expect(served.kept).toContain(THINKING);
		expect(served.unchanged).toContain(THINKING);
		expect(served.changed).not.toContain(THINKING);
	} finally {
		f.close();
	}
}, 60_000);

// Known gap, OMP: OMP's system prompt names every active tool (and renders
// full tool descriptors unless it lists names only), so an added or removed
// tool already changes the system prompt. A changed description or schema in
// list mode does not, and nothing else here sees it. Remove `.failing` when
// such a change strips the kept thinking.
it.failing("OMP, claude-fable-5-2: a changed tool schema strips the kept signed thinking", async () => {
	const f = fixture("omp-schema", "omp");
	try {
		const served = await f.acrossChange(() => {
			f.tools[0]!.parameters = {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			};
			return "base instruction";
		});
		expect(served.kept).toContain(THINKING);
		expect(served.unchanged).toContain(THINKING);
		expect(served.changed).not.toContain(THINKING);
	} finally {
		f.close();
	}
}, 60_000);
