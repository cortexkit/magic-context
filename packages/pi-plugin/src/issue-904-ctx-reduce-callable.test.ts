import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	casChannel2NudgeState,
	getChannel2NudgeState,
	getOrCreateSessionMeta,
	getTagsBySession,
	openDatabase,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	cleanupTestTempDir,
	createTestTempDir,
} from "@magic-context/core/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	__test as handlerTest,
	registerPiContextHandler,
	signalPiSystemHashChange,
} from "./context-handler";
import {
	clearPiChannel1State,
	getPiChannel1Baseline,
	maybeChannel1ReminderForToolResult,
	maybeDeliverChannel2Pi,
	setPiChannel1Baseline,
} from "./ctx-reduce-nudge-pi";
import magicContextPiExtension from "./index";
import {
	buildMagicContextBlock,
	clearPiSystemPromptSession,
	composeMagicContextSystemPrompt,
	processSystemPromptForCache,
} from "./system-prompt";
import {
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

// Issue 904: on Pi and Oh My Pi, tag prefixes, the ctx_reduce guidance and the
// reduce reminders went out whether or not the session could call ctx_reduce.
// An Oh My Pi task child spawned from plan mode loses every extension tool but
// keeps Magic Context's hooks, so it was reminded to use a tool it did not
// have. The session's tool list now decides all of them, on every request,
// while queued drops and automatic reductions run either way.

const WINDOW = 200_000;
const BASE_PROMPT = "Synthetic host prompt for issue 904.";
const TOOLS = [
	{
		name: "bash",
		description: "Run a command",
		parameters: { type: "object", properties: { command: { type: "string" } } },
	},
	{
		name: "ctx_reduce",
		description: "Mark tags for dropping",
		parameters: { type: "object", properties: { drop: { type: "string" } } },
	},
];
const WITH_REDUCE = ["bash", "ctx_reduce"];
const WITHOUT_REDUCE = ["bash"];

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * A session whose oldest exchange is one large tool output, far outside the
 * protected window: the reclaimable share of its tail is high enough for both
 * reminders.
 */
function conversation(): { messages: PiMessage[]; ids: string[] } {
	const messages: PiMessage[] = [
		userMessage("read the big log", 1),
		assistantToolCall("old-call", "bash", { command: "cat big.log" }, 2),
		{
			...toolResultMessage("old-call", "log line ".repeat(45_000), 3),
			toolName: "bash",
		} as PiMessage,
	];
	const ids: string[] = ["first", "old-assistant", "old-result"];
	for (let index = 0; index < 30; index++) {
		messages.push(userMessage(`later prompt ${index}`, index + 10));
		ids.push(`prompt-${index}`);
	}
	// Newer tool output above the protected window's 4,000 tokens: the window
	// counts tool output only.
	for (let index = 0; index < 10; index++) {
		messages.push(
			assistantToolCall(
				`step-call-${index}`,
				"bash",
				{ command: `step ${index}` },
				40 + index * 2,
			),
			{
				...toolResultMessage(
					`step-call-${index}`,
					`step ${index}: ${"detail ".repeat(600)}`,
					41 + index * 2,
				),
				toolName: "bash",
			} as PiMessage,
		);
		ids.push(`step-assistant-${index}`, `step-result-${index}`);
	}
	messages.push(userMessage("continue", 70));
	ids.push("continue");
	return { messages, ids };
}

interface PassRecord {
	/** The messages the pass returned, serialized. */
	bytes: string;
	/** The pass had rebuild permission. */
	permitted: boolean;
	systemPrompt: string;
}

interface FixtureOptions {
	active?: string[];
	subagent?: boolean;
	/**
	 * How the system prompt is built: "guidance" renders the ctx_reduce
	 * guidance as before_agent_start does; "fixed" keeps one prompt whatever
	 * the tool list (system_prompt_injection disabled, or a primary guidance
	 * override that ignores the tool list).
	 */
	systemPrompt?: "guidance" | "fixed" | "override";
	/**
	 * Routine heuristics off leaves the queued drop as the only lane that can
	 * drop the old tool output, so a test sees which lane landed.
	 */
	heuristics?: boolean;
}

function fixture(name: string, options: FixtureOptions = {}) {
	const sessionId = `issue-904-${name}`;
	const db = createTestDb();
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		piStableIdScheme: 1,
		lastResponseTime: Date.now(),
		cacheTtl: "never",
		...(options.subagent ? { isSubagent: true } : {}),
	});
	let active = [...(options.active ?? WITH_REDUCE)];
	const fake = createFakePi();
	const sent: unknown[] = [];
	Object.assign(fake.pi, {
		getAllTools: () => TOOLS,
		getActiveTools: () => [...active],
		sendMessage: (message: unknown) => {
			sent.push(message);
		},
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
		scheduler: { executeThresholdPercentage: 65 },
		...(options.heuristics === false
			? {}
			: { heuristics: { keepReasoningTokens: 2000 } }),
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: PiMessage[] },
		ctx: never,
	) => Promise<{ messages: PiMessage[] } | undefined>;
	const { messages: source, ids } = conversation();
	const passes: PassRecord[] = [];
	const callable = () => active.includes("ctx_reduce");
	const systemText = () => {
		if (options.systemPrompt === "fixed") return BASE_PROMPT;
		const block = buildMagicContextBlock({
			db,
			cwd: process.cwd(),
			sessionId,
			memoryEnabled: false,
			ctxReduceCallable: callable(),
			...(options.systemPrompt === "override"
				? { primaryGuidanceOverride: "## Magic Context\n\nUser guidance." }
				: {}),
		});
		return composeMagicContextSystemPrompt(BASE_PROMPT, block);
	};
	/**
	 * One provider request. `turnStart` runs the system-prompt step of
	 * before_agent_start first; a later request of the same turn keeps the
	 * prompt that step produced.
	 */
	let currentPrompt = "";
	const serve = async (
		args: { percent?: number; turnStart?: boolean } = {},
	): Promise<PassRecord> => {
		const percent = args.percent ?? 10;
		if (args.turnStart !== false || currentPrompt === "") {
			const prompt = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: systemText(),
				isCacheBusting: false,
			});
			if (prompt.hashChanged)
				signalPiSystemHashChange(sessionId, prompt.currentHash);
			currentPrompt = prompt.systemPrompt;
		}
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			lastContextPercentage: percent,
			lastInputTokens: Math.round((WINDOW * percent) / 100),
		});
		const messages = structuredClone(source);
		const branch = ids.map((id, index) => ({
			type: "message",
			id,
			parentId: ids[index - 1] ?? null,
			message: messages[index],
		}));
		const systemPrompt = currentPrompt;
		const ctx = {
			...fakeContext(sessionId, process.cwd(), [...ids], messages),
			sessionManager: {
				getSessionId: () => sessionId,
				getLeafId: () => ids.at(-1),
				getBranch: () => branch,
				getEntries: () => branch,
			},
			getSystemPrompt: () => systemPrompt,
			model: {
				provider: "openai",
				id: "gpt-4.1",
				api: "openai-completions",
				contextWindow: WINDOW,
			},
			getContextUsage: () => ({
				tokens: Math.round((WINDOW * percent) / 100),
				percent,
				contextWindow: WINDOW,
			}),
		};
		let permitted = false;
		const restore = handlerTest.setPipelineResultObserverForTests(
			(id, result) => {
				if (id === sessionId) permitted = result.prefixBustPermitted;
			},
		);
		try {
			const result = await handler({ messages }, ctx as never);
			const record = {
				bytes: JSON.stringify(result?.messages ?? messages),
				permitted,
				systemPrompt,
			};
			passes.push(record);
			return record;
		} finally {
			restore();
		}
	};
	const toolTag = (callId: string) =>
		getTagsBySession(db, sessionId).find(
			(row) => row.type === "tool" && row.messageId === callId,
		);
	cleanups.push(() => {
		clearContextHandlerSession(sessionId);
		clearPiSystemPromptSession(sessionId);
		clearPiChannel1State(sessionId);
		db.close();
	});
	return {
		db,
		sessionId,
		pi: fake.pi,
		sent,
		passes,
		serve,
		toolTag,
		setActive: (next: string[]) => {
			active = [...next];
		},
		reminder: () =>
			maybeChannel1ReminderForToolResult({
				db,
				sessionId,
				toolName: "bash",
				content: [{ type: "text", text: "fresh result" }],
			}),
	};
}

/** Tag prefixes the request carries, such as `§3§ `. */
function prefixes(bytes: string): string[] {
	return bytes.match(/§\d+§ /g) ?? [];
}

/** A measured tail whose reclaimable share fires both reminders. */
function firingBaseline() {
	return {
		baselineU: 150_000,
		baselineT: 180_000,
		turnDeltaU: 0,
		turnDeltaT: 0,
		usableWindow: 128_000,
		realUserTurnCount: 1,
		baselineGeneration: 1,
		computedAt: 1,
		evaluable: true,
		generationInvalidated: false,
		baselineParts: [],
		contentSignature: "issue-904",
		reducedSinceRefresh: false,
		oldestReclaimableToolTags: [],
	};
}

describe("issue 904: reminders need a callable ctx_reduce", () => {
	it("a session without ctx_reduce under pressure gets neither reduce reminder", async () => {
		const f = fixture("reminder-without-tool", { active: WITHOUT_REDUCE });
		await f.serve({ percent: 70 });
		await f.serve({ percent: 70 });
		// The in-turn reminder the next tool result would carry.
		expect(f.reminder()).toBeNull();
		// The ceiling reminder sent at the end of the turn.
		expect(maybeDeliverChannel2Pi(f.pi as never, f.db, f.sessionId)).toBe(
			false,
		);
		expect(f.sent).toEqual([]);
	});

	it("control: the same session with ctx_reduce gets both reminders", async () => {
		const f = fixture("reminder-with-tool");
		await f.serve({ percent: 70 });
		await f.serve({ percent: 70 });
		expect(f.reminder()).not.toBeNull();
		expect(maybeDeliverChannel2Pi(f.pi as never, f.db, f.sessionId)).toBe(
			true,
		);
		expect(f.sent).toHaveLength(1);
	});
});

describe("issue 904: a session without ctx_reduce from the start", () => {
	it("gets no tags, guidance or reminders at any pressure, and the same automatic reductions", async () => {
		const without = fixture("absent", { active: WITHOUT_REDUCE });
		const withTool = fixture("present");
		for (const percent of [10, 70, 90]) {
			const pass = await without.serve({ percent });
			await withTool.serve({ percent });
			expect(prefixes(pass.bytes)).toEqual([]);
			expect(pass.systemPrompt).not.toContain("ctx_reduce");
			expect(pass.systemPrompt).not.toContain("§12§");
			expect(getPiChannel1Baseline(without.sessionId)).toBeUndefined();
			expect(without.reminder()).toBeNull();
		}
		expect(withTool.passes[0]?.systemPrompt).toContain("ctx_reduce");
		expect(prefixes(withTool.passes[0]?.bytes ?? "").length).toBeGreaterThan(
			0,
		);
		// Tags are still assigned and stored, and every automatic reduction
		// the session with the tool got, it got too.
		const statuses = (rows: ReturnType<typeof getTagsBySession>) =>
			rows.map((row) => [row.messageId, row.type, row.status]);
		const absentRows = getTagsBySession(without.db, without.sessionId);
		expect(absentRows.length).toBeGreaterThan(0);
		expect(statuses(absentRows)).toEqual(
			statuses(getTagsBySession(withTool.db, withTool.sessionId)),
		);
		expect(absentRows.some((row) => row.status === "dropped")).toBe(true);
		expect(without.sent).toEqual([]);
	});
});

describe("issue 904: ctx_reduce removed and restored", () => {
	it("rebuilds once at each change, never between, and keeps the tag numbers", async () => {
		const f = fixture("flip-primary");
		await f.serve();
		const before = await f.serve();
		expect(before.permitted).toBe(false);
		const numbers = prefixes(before.bytes);
		expect(numbers.length).toBeGreaterThan(0);

		f.setActive(WITHOUT_REDUCE);
		const removed = await f.serve();
		expect(removed.systemPrompt).not.toBe(before.systemPrompt);
		expect(removed.permitted).toBe(true);
		expect(prefixes(removed.bytes)).toEqual([]);
		const stillRemoved = await f.serve();
		expect(stillRemoved.permitted).toBe(false);
		expect(stillRemoved.bytes).toBe(removed.bytes);

		f.setActive(WITH_REDUCE);
		const restored = await f.serve();
		expect(restored.permitted).toBe(true);
		// Automatic reductions rode the rebuild at the removal (the oldest tool
		// output left in an age sweep); every tag still shown keeps its number.
		const dropped = getTagsBySession(f.db, f.sessionId)
			.filter((row) => row.status === "dropped")
			.map((row) => `§${row.tagNumber}§ `);
		expect(prefixes(restored.bytes)).toEqual(
			numbers.filter((prefix) => !dropped.includes(prefix)),
		);
		const stillRestored = await f.serve();
		expect(stillRestored.permitted).toBe(false);
		expect(stillRestored.bytes).toBe(restored.bytes);
	});

	// The guidance is in the system prompt, which the hosts build once per
	// turn. In these three cases the prompt does not change with the tool list,
	// so the change of the tool list alone must grant the rebuild that removes
	// the tag prefixes, and the drops queued while the tool was callable land
	// in that rebuild.
	for (const [label, systemPrompt, turnStart] of [
		["mid-turn removal", "guidance", false],
		["system prompt injection disabled", "fixed", true],
		["primary guidance override", "override", true],
	] as const) {
		it(`primary, ${label}: one rebuild at the change, carrying the queued drop`, async () => {
			const f = fixture(`queued-${label.replaceAll(" ", "-")}`, {
				systemPrompt,
				heuristics: false,
			});
			await f.serve();
			await f.serve();
			const old = f.toolTag("old-call");
			if (!old) throw new Error("the old tool output has no tag");
			queuePendingOp(f.db, f.sessionId, old.tagNumber, "drop");
			const held = await f.serve({ turnStart });
			expect(held.permitted).toBe(false);
			expect(held.bytes).toContain("log line log line");

			f.setActive(WITHOUT_REDUCE);
			const changed = await f.serve({ turnStart });
			expect(changed.systemPrompt).toBe(held.systemPrompt);
			expect(changed.permitted).toBe(true);
			expect(prefixes(changed.bytes)).toEqual([]);
			expect(changed.bytes).not.toContain("log line log line");
			expect(f.toolTag("old-call")?.status).toBe("dropped");

			const after = await f.serve({ turnStart });
			expect(after.permitted).toBe(false);
			expect(after.bytes).toBe(changed.bytes);
		});
	}

	it("queued drops survive a removal across a restart, and land in its rebuild", async () => {
		const f = fixture("restart", { systemPrompt: "fixed", heuristics: false });
		await f.serve();
		await f.serve();
		const old = f.toolTag("old-call");
		if (!old) throw new Error("the old tool output has no tag");
		queuePendingOp(f.db, f.sessionId, old.tagNumber, "drop");
		const held = await f.serve();
		expect(held.bytes).toContain("log line log line");
		// A restart forgets every in-memory record of the session.
		clearContextHandlerSession(f.sessionId);
		f.setActive(WITHOUT_REDUCE);
		const changed = await f.serve();
		expect(changed.permitted).toBe(true);
		expect(prefixes(changed.bytes)).toEqual([]);
		expect(f.toolTag("old-call")?.status).toBe("dropped");
	});

	it("subagent: the change of the tool list is the rebuild, and it has no history head", async () => {
		const f = fixture("flip-subagent", { subagent: true, heuristics: false });
		const first = await f.serve();
		expect(first.bytes).not.toContain("<session-history");
		const before = await f.serve();
		expect(before.permitted).toBe(false);
		const numbers = prefixes(before.bytes);
		expect(numbers.length).toBeGreaterThan(0);
		const old = f.toolTag("old-call");
		if (!old) throw new Error("the old tool output has no tag");
		queuePendingOp(f.db, f.sessionId, old.tagNumber, "drop");
		const held = await f.serve({ turnStart: false });
		expect(held.permitted).toBe(false);
		expect(held.bytes).toBe(before.bytes);

		f.setActive(WITHOUT_REDUCE);
		const removed = await f.serve({ turnStart: false });
		expect(removed.systemPrompt).toBe(held.systemPrompt);
		expect(removed.permitted).toBe(true);
		expect(prefixes(removed.bytes)).toEqual([]);
		expect(f.toolTag("old-call")?.status).toBe("dropped");
		const stillRemoved = await f.serve({ turnStart: false });
		expect(stillRemoved.permitted).toBe(false);
		expect(stillRemoved.bytes).toBe(removed.bytes);

		f.setActive(WITH_REDUCE);
		const restored = await f.serve({ turnStart: false });
		expect(restored.permitted).toBe(true);
		expect(prefixes(restored.bytes).length).toBeGreaterThan(0);
		expect(
			prefixes(restored.bytes).every((prefix) => numbers.includes(prefix)),
		).toBe(true);
	});

	it("control: a primary session renders its history head", async () => {
		const f = fixture("head-primary");
		const first = await f.serve();
		expect(first.bytes).toContain("<session-history");
	});
});

/** The ExtensionAPI surface Magic Context's entry point uses, recording handlers. */
function createRuntime() {
	const handlers = new Map<
		string,
		Array<(event: unknown, ctx: unknown) => unknown>
	>();
	const registered: Array<{ name: string }> = [];
	let active: string[] = [];
	const sendMessage = mock((_message: unknown) => undefined);
	const pi = {
		events: { on: () => () => undefined },
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (tool: { name: string }) => {
			registered.push(tool);
		},
		getAllTools: () => registered,
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
		registerFlag: () => undefined,
		registerCommand: () => undefined,
		registerEntryRenderer: () => undefined,
		appendEntry: () => undefined,
		sendMessage,
		sendUserMessage: () => undefined,
	};
	return {
		pi,
		sendMessage,
		toolNames: () => registered.map((tool) => tool.name),
		setActive: (names: string[]) => {
			active = [...names];
		},
		async emit(event: string, data: unknown, ctx: unknown) {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? [])
				results.push(await handler(data, ctx));
			return results;
		},
	};
}

describe("issue 904: the Pi extension's own sites", () => {
	it("guidance, both reminders and the spawned-session record follow the session", async () => {
		const runtime = createRuntime();
		await magicContextPiExtension(runtime.pi as never);
		const { dir } = createTestTempDir("issue-904-extension-");
		const db = openDatabase();
		const ctxFor = (sessionId: string, agent?: Record<string, unknown>) => ({
			cwd: dir,
			hasUI: false,
			sessionManager: { getSessionId: () => sessionId },
			ui: { setStatus: () => undefined, notify: () => undefined },
			...(agent ? { agent } : {}),
		});
		const all = runtime.toolNames();
		expect(all).toContain("ctx_reduce");
		const withoutReduce = all.filter((name) => name !== "ctx_reduce");
		try {
			// Guidance: before_agent_start reads the session's tool list.
			runtime.setActive(all);
			const [withGuidance] = (await runtime.emit(
				"before_agent_start",
				{ systemPrompt: BASE_PROMPT },
				ctxFor("ext-guidance-with"),
			)) as Array<{ systemPrompt?: string } | undefined>;
			expect(withGuidance?.systemPrompt).toContain("ctx_reduce");
			runtime.setActive(withoutReduce);
			const [withoutGuidance] = (await runtime.emit(
				"before_agent_start",
				{ systemPrompt: BASE_PROMPT },
				ctxFor("ext-guidance-without"),
			)) as Array<{ systemPrompt?: string } | undefined>;
			expect(withoutGuidance?.systemPrompt).toContain("## Magic Context");
			expect(withoutGuidance?.systemPrompt).not.toContain("ctx_reduce");

			// The in-turn reminder on a tool result.
			const toolResult = {
				toolName: "bash",
				content: [{ type: "text", text: "fresh result" }],
			};
			setPiChannel1Baseline("ext-reminder-without", firingBaseline());
			runtime.setActive(withoutReduce);
			const [quiet] = await runtime.emit(
				"tool_result",
				toolResult,
				ctxFor("ext-reminder-without"),
			);
			expect(quiet).toBeUndefined();
			setPiChannel1Baseline("ext-reminder-with", firingBaseline());
			runtime.setActive(all);
			const [reminded] = (await runtime.emit(
				"tool_result",
				toolResult,
				ctxFor("ext-reminder-with"),
			)) as Array<{ content?: unknown[] } | undefined>;
			expect(reminded?.content).toHaveLength(2);

			// The ceiling reminder at the end of a turn.
			const ceiling = "ext-ceiling";
			setPiChannel1Baseline(ceiling, firingBaseline());
			casChannel2NudgeState(db, ceiling, "", "pending");
			const end = { messages: [{ role: "assistant", stopReason: "stop" }] };
			runtime.setActive(withoutReduce);
			await runtime.emit("agent_end", end, ctxFor(ceiling));
			expect(runtime.sendMessage).not.toHaveBeenCalled();
			expect(getChannel2NudgeState(db, ceiling)).toBe("pending");
			runtime.setActive(all);
			await runtime.emit("agent_end", end, ctxFor(ceiling));
			expect(runtime.sendMessage).toHaveBeenCalledTimes(1);

			// Oh My Pi names the agent a session runs; Pi does not.
			const sub = { kind: "sub", id: "0-Task", name: "task", depth: 1 };
			const main = { kind: "main", id: "Main", name: "main", depth: 0 };
			await runtime.emit("session_start", {}, ctxFor("ext-child", sub));
			await runtime.emit("session_start", {}, ctxFor("ext-main", main));
			await runtime.emit("session_start", {}, ctxFor("ext-pi"));
			expect(getOrCreateSessionMeta(db, "ext-child").isSubagent).toBe(true);
			expect(getOrCreateSessionMeta(db, "ext-main").isSubagent).toBe(false);
			expect(getOrCreateSessionMeta(db, "ext-pi").isSubagent).toBe(false);
			// An advisor's calls reach the advising session's handlers as kind
			// "sub"; only the session's first event decides its record.
			await runtime.emit(
				"before_agent_start",
				{ systemPrompt: BASE_PROMPT },
				ctxFor("ext-main", { ...sub, id: "advisor", name: "advisor" }),
			);
			expect(getOrCreateSessionMeta(db, "ext-main").isSubagent).toBe(false);
			// A session first seen at before_agent_start is recorded there.
			await runtime.emit(
				"before_agent_start",
				{ systemPrompt: BASE_PROMPT },
				ctxFor("ext-late-child", sub),
			);
			expect(getOrCreateSessionMeta(db, "ext-late-child").isSubagent).toBe(
				true,
			);
		} finally {
			await runtime.emit("session_shutdown", {}, ctxFor("ext-main"));
			for (const sessionId of [
				"ext-reminder-without",
				"ext-reminder-with",
				"ext-ceiling",
			])
				clearPiChannel1State(sessionId);
			cleanupTestTempDir(dir);
		}
	}, 30_000);
});
