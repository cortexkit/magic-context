import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as embeddingModule from "@magic-context/core/features/magic-context/memory/embedding";
import {
	addNote,
	casChannel2NudgeState,
	getChannel2NudgeState,
	getOrCreateSessionMeta,
	getPendingOps,
	getTagsBySession,
	incrementHistorianFailure,
	openDatabase,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	readReplayEnvelope,
	updateReplayDocument,
} from "@magic-context/core/features/magic-context/storage-replay-document";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { autoSearchTestSnapshot } from "@magic-context/core/hooks/magic-context/auto-search-snapshot.fixture";
import * as searchModule from "@magic-context/core/hooks/magic-context/auto-search-worker-client";
import { onNoteTrigger } from "@magic-context/core/hooks/magic-context/note-nudger";
import { __setAsyncProcessProbeForTests } from "@magic-context/core/shared/rpc-utils";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import {
	cleanupTestTempDir,
	createTestTempDir,
} from "@magic-context/core/shared/test-temp-dir";
import {
	awaitInFlightHistorians,
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
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import {
	buildMagicContextBlock,
	clearPiSystemPromptSession,
	composeMagicContextSystemPrompt,
	processSystemPromptForCache,
} from "./system-prompt";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	heavyReasoningUsage,
	type PiMessage,
	textOf,
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
const HELD_THINKING = "SIGNED_PLAN_THE_NEXT_REQUEST_CONTINUES";
/** The developer reminder Oh My Pi puts in an ephemeral side turn. */
const OMP_SIDE_REMINDER =
	"<system-reminder>\nEphemeral side-channel turn; reuses current conversation context.\nTool catalog attached only to keep prompt cache warm; tools NOT available this turn.\nDo NOT emit tool calls; reply plain text only. Tool calls discarded without execution.\n</system-reminder>";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * A session whose oldest exchange is one large tool output, far outside the
 * protected window: the reclaimable share of its tail is high enough for both
 * reminders.
 */
function conversation(oldOutputLines = 45_000): {
	messages: PiMessage[];
	ids: string[];
} {
	const messages: PiMessage[] = [
		userMessage("read the big log", 1),
		assistantToolCall("old-call", "bash", { command: "cat big.log" }, 2),
		{
			...toolResultMessage("old-call", "log line ".repeat(oldOutputLines), 3),
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
	/**
	 * "prefix-bound" runs the session on an Anthropic model whose signed
	 * thinking stays valid only behind an unchanged request prefix.
	 */
	model?: "openai" | "prefix-bound";
	/** The scheduler's execute threshold, in percent of the window (default 65). */
	executeThreshold?: number;
	/**
	 * Lines of the oldest tool output (default 45,000, enough for both
	 * reminders). A small one keeps the request well inside the window.
	 */
	oldOutputLines?: number;
}

const PREFIX_BOUND_MODEL = "claude-opus-5-5";

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
	// null: the host's tool lists cannot be read on this request.
	let active: string[] | null = [...(options.active ?? WITH_REDUCE)];
	const fake = createFakePi();
	const sent: unknown[] = [];
	Object.assign(fake.pi, {
		getAllTools: () => TOOLS,
		getActiveTools: () => {
			if (active === null) throw new Error("tool registry not ready");
			return [...active];
		},
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
		scheduler: {
			executeThresholdPercentage: options.executeThreshold ?? 65,
		},
		...(options.heuristics === false
			? {}
			: { heuristics: { keepReasoningTokens: 2000 } }),
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: PiMessage[] },
		ctx: never,
	) => Promise<{ messages: PiMessage[] } | undefined>;
	const { messages: source, ids } = conversation(options.oldOutputLines);
	const passes: PassRecord[] = [];
	const callable = () => active?.includes("ctx_reduce") ?? true;
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
	 * prompt that step produced. `extra` messages go out after the session's
	 * own, without becoming session entries (an Oh My Pi side turn).
	 */
	let currentPrompt = "";
	const serve = async (
		args: { percent?: number; turnStart?: boolean; extra?: PiMessage[] } = {},
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
		const messages = structuredClone([...source, ...(args.extra ?? [])]);
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
			model:
				options.model === "prefix-bound"
					? {
							provider: "anthropic",
							id: PREFIX_BOUND_MODEL,
							api: "anthropic-messages",
							contextWindow: WINDOW,
						}
					: {
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
		push: (id: string, message: PiMessage) => {
			source.push(message);
			ids.push(id);
		},
		setActive: (next: string[] | null) => {
			active = next === null ? null : [...next];
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

/** One compartment of `sessionId`, covering the two named messages. */
function insertCompartment(
	db: ReturnType<typeof createTestDb>,
	sessionId: string,
	startMessageId: string,
	endMessageId: string,
): void {
	db.prepare(
		`INSERT INTO compartments
		 (session_id, sequence, start_message, end_message, start_message_id,
		  end_message_id, title, content, p1, p2, p3, p4, importance,
		  episode_type, legacy, created_at, harness)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		sessionId,
		1,
		1,
		2,
		startMessageId,
		endMessageId,
		"Inherited work",
		"INHERITED-HISTORY full content",
		"INHERITED-HISTORY p1",
		"INHERITED-HISTORY p2",
		null,
		null,
		73,
		"feature",
		0,
		1001,
		"pi",
	);
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
		expect(maybeDeliverChannel2Pi(f.pi as never, f.db, f.sessionId)).toBe(true);
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
		expect(prefixes(withTool.passes[0]?.bytes ?? "").length).toBeGreaterThan(0);
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
		// Automatic reductions landed in the rebuild at the removal (the oldest
		// tool output was dropped there), so some tags are no longer shown; every
		// tag still shown keeps the number it had before the removal.
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
		// The extension boot migrates this process's fresh store, and the migration
		// guard refuses while any Pi or OMP process runs on the machine: the test
		// preload's store counts as the shared default store. Other test files run
		// a real OMP in parallel workers (and a developer may run Pi), which left
		// the boot without storage and registered no tools. Show the guard's
		// process scan only this process for the boot.
		__setAsyncProcessProbeForTests(async () => {
			// One `ps -axo pid=,ppid=,lstart=,command=` row; lstart reads like
			// "Thu Nov 19 00:38:39 2026".
			const [day, month, date, year, time] = new Date(
				Date.now() - process.uptime() * 1000,
			)
				.toString()
				.split(" ");
			return `${process.pid} ${process.ppid} ${day} ${month} ${date} ${time} ${year} bun test\n`;
		});
		try {
			await magicContextPiExtension(runtime.pi as never);
		} finally {
			__setAsyncProcessProbeForTests();
		}
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
			// The size baseline measured while the tool was callable is dropped,
			// so the first result after the tool returns is not measured from it.
			expect(getPiChannel1Baseline("ext-reminder-without")).toBeUndefined();
			runtime.setActive(all);
			const [afterReturn] = await runtime.emit(
				"tool_result",
				toolResult,
				ctxFor("ext-reminder-without"),
			);
			expect(afterReturn).toBeUndefined();
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
			expect(getPiChannel1Baseline(ceiling)).toBeUndefined();
			runtime.setActive(all);
			// The next pass with the tool measures the session again.
			setPiChannel1Baseline(ceiling, firingBaseline());
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
			// Oh My Pi passes an advisor's identity (kind "sub") only to the
			// advising session's tool events. Neither reclassifies the session:
			// not after its session_start, and not when the advisor's events are
			// the first this process sees of it (an extension loaded mid-turn).
			const advisor = {
				kind: "sub",
				id: "advisor",
				name: "advisor",
				depth: 0,
				parentId: "Main",
			};
			for (const sessionId of ["ext-main", "ext-advised-late"]) {
				await runtime.emit(
					"tool_call",
					{ toolName: "bash", toolCallId: "advisor-call", input: {} },
					ctxFor(sessionId, advisor),
				);
				await runtime.emit(
					"tool_result",
					{ ...toolResult, toolCallId: "advisor-call" },
					ctxFor(sessionId, advisor),
				);
			}
			await runtime.emit(
				"before_agent_start",
				{ systemPrompt: BASE_PROMPT },
				ctxFor("ext-advised-late", main),
			);
			expect(getOrCreateSessionMeta(db, "ext-main").isSubagent).toBe(false);
			expect(getOrCreateSessionMeta(db, "ext-advised-late").isSubagent).toBe(
				false,
			);
			// A session first seen at before_agent_start is recorded there.
			await runtime.emit(
				"before_agent_start",
				{ systemPrompt: BASE_PROMPT },
				ctxFor("ext-late-child", sub),
			);
			expect(getOrCreateSessionMeta(db, "ext-late-child").isSubagent).toBe(
				true,
			);

			// Oh My Pi also runs forks as "sub". A fork that clone inheritance
			// gave its source's compartments continues that session and stays
			// primary. An ordinary task child also names its parent in its header,
			// and inherits the parent's session facts but no compartments: it is a
			// subagent.
			const forkSource = "019f0000-2222-7000-8000-000000000904";
			const childSource = "019f0000-3333-7000-8000-000000000904";
			insertCompartment(db, forkSource, "fork-u1", "fork-a1");
			insertCompartment(db, childSource, "parent-u1", "parent-a1");
			db.prepare(
				"INSERT INTO session_facts (session_id, category, content, created_at, updated_at, harness) VALUES (?, ?, ?, ?, ?, ?)",
			).run(childSource, "DECISIONS", "A fact of the parent", 1, 1, "pi");
			const spawned = (
				sessionId: string,
				parentSession: string,
				entryIds: string[],
				agent: Record<string, unknown>,
			) => ({
				...ctxFor(sessionId, agent),
				sessionManager: {
					getSessionId: () => sessionId,
					getHeader: () => ({ parentSession }),
					getBranch: () =>
						entryIds.map((id, index) => ({
							type: "message",
							id,
							parentId: entryIds[index - 1] ?? null,
							message:
								index % 2 === 0
									? userMessage(id, index + 1)
									: assistantMessage(id, index + 1),
						})),
				},
			});
			await runtime.emit(
				"session_start",
				{},
				spawned("ext-fork", forkSource, ["fork-u1", "fork-a1", "fork-u2"], {
					...sub,
					id: "Tan-1",
					name: "sub",
					depth: 0,
				}),
			);
			await runtime.emit(
				"session_start",
				{},
				spawned("ext-task-child", childSource, ["child-u1"], sub),
			);
			const count = (table: string, sessionId: string) =>
				(
					db
						.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`)
						.get(sessionId) as { n: number }
				).n;
			expect(count("compartments", "ext-fork")).toBe(1);
			expect(getOrCreateSessionMeta(db, "ext-fork").isSubagent).toBe(false);
			expect(count("compartments", "ext-task-child")).toBe(0);
			expect(count("session_facts", "ext-task-child")).toBe(1);
			expect(getOrCreateSessionMeta(db, "ext-task-child").isSubagent).toBe(
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

describe("issue 904: the answer each request is built with", () => {
	it("unreadable tool lists keep the last served answer", async () => {
		// No served request yet: the session counts as callable.
		const fresh = fixture("unknown-fresh", { systemPrompt: "fixed" });
		fresh.setActive(null);
		const first = await fresh.serve();
		expect(prefixes(first.bytes).length).toBeGreaterThan(0);

		const f = fixture("unknown-after-removal", { systemPrompt: "fixed" });
		await f.serve();
		f.setActive(WITHOUT_REDUCE);
		const removed = await f.serve();
		expect(removed.permitted).toBe(true);
		expect(prefixes(removed.bytes)).toEqual([]);
		// A failed read neither brings the prefixes back nor rebuilds.
		f.setActive(null);
		const unknown = await f.serve();
		expect(unknown.permitted).toBe(false);
		expect(unknown.bytes).toBe(removed.bytes);
		f.setActive(WITHOUT_REDUCE);
		const known = await f.serve();
		expect(known.permitted).toBe(false);
		expect(known.bytes).toBe(removed.bytes);
	});

	it("a removal stored before a restart is read back: no rebuild after the restart", async () => {
		const f = fixture("stored-false", { systemPrompt: "fixed" });
		await f.serve();
		await f.serve();
		f.setActive(WITHOUT_REDUCE);
		const removed = await f.serve();
		expect(removed.permitted).toBe(true);
		const steady = await f.serve();
		expect(steady.permitted).toBe(false);
		expect(
			readReplayEnvelope(f.db, f.sessionId, "read").piCtxReduceCallable,
		).toBe(false);
		// A restart forgets every in-memory record of the session.
		clearContextHandlerSession(f.sessionId);
		const afterRestart = await f.serve();
		expect(afterRestart.permitted).toBe(false);
		expect(afterRestart.bytes).toBe(steady.bytes);
	});

	it("an Oh My Pi side turn does not record the answer it was built with", async () => {
		__setPiHarnessKindForTesting("omp");
		try {
			const f = fixture("side-turn", { systemPrompt: "fixed" });
			await f.serve();
			const before = await f.serve();
			expect(before.permitted).toBe(false);
			f.setActive(WITHOUT_REDUCE);
			// A side turn reuses the conversation for one ephemeral request; it
			// is not the session's own request.
			await f.serve({
				extra: [
					{
						role: "developer",
						attribution: "agent",
						content: OMP_SIDE_REMINDER,
						timestamp: 100,
					} as unknown as PiMessage,
					{
						...userMessage("a quick side question", 101),
						attribution: "agent",
					} as PiMessage,
				],
			});
			expect(
				readReplayEnvelope(f.db, f.sessionId, "read").piCtxReduceCallable,
			).toBeUndefined();
			// The session's own last request still carried the tag prefixes, so
			// its next request is the change: it gets the rebuild that removes
			// them.
			const after = await f.serve();
			expect(after.permitted).toBe(true);
			expect(prefixes(after.bytes)).toEqual([]);
			expect(
				readReplayEnvelope(f.db, f.sessionId, "read").piCtxReduceCallable,
			).toBe(false);
		} finally {
			__setPiHarnessKindForTesting(undefined);
		}
	});
});

describe("issue 904: what rides the rebuild at a change of the tool list", () => {
	// A tool-list change on a prefix-bound model where nothing else marks the
	// tools as changed: the session's tools record predates this model, so the
	// pass adopts the current tool list silently. The change of ctx_reduce alone
	// must lift the hold on the newest signed thinking, which is invalid behind
	// the changed prefix.
	it("prefix-bound model: the change lifts the signed-thinking hold and strips the kept thinking once", async () => {
		const f = fixture("hold-lift", {
			systemPrompt: "fixed",
			model: "prefix-bound",
		});
		await f.serve();
		await f.serve();
		// A heavy signed step that the next request continues.
		f.push(
			"held-step",
			assistantMessage("", 80, {
				provider: "anthropic",
				model: PREFIX_BOUND_MODEL,
				api: "anthropic-messages",
				content: [
					{
						type: "thinking",
						thinking: HELD_THINKING,
						thinkingSignature: "held-signature",
					},
					{
						type: "toolCall",
						id: "held-call",
						name: "bash",
						arguments: { command: "plan" },
					},
				],
				usage: heavyReasoningUsage(),
			}),
		);
		f.push("held-result", {
			...toolResultMessage("held-call", "planned", 81),
			toolName: "bash",
		} as PiMessage);
		const held = await f.serve({ turnStart: false });
		expect(held.permitted).toBe(false);
		expect(held.bytes).toContain(HELD_THINKING);

		updateReplayDocument(f.db, f.sessionId, (doc) => {
			if (!("requestToolsRelease" in doc)) return false;
			delete doc.requestToolsRelease;
			return true;
		});
		f.setActive(WITHOUT_REDUCE);
		const changed = await f.serve({ turnStart: false });
		expect(changed.permitted).toBe(true);
		expect(prefixes(changed.bytes)).toEqual([]);
		expect(changed.bytes).not.toContain(HELD_THINKING);
		const next = await f.serve({ turnStart: false });
		expect(next.permitted).toBe(false);
		expect(next.bytes).toBe(changed.bytes);
	});

	/**
	 * Two identical parallel reads in a new turn, then enough newer tool
	 * output to move them out of the protected window: a duplicate that only
	 * routine cleanup removes (the older copy goes, the newer stays).
	 */
	const addDuplicateReads = (f: ReturnType<typeof fixture>) => {
		f.push("dup-prompt", userMessage("read the notes twice", 90));
		f.push(
			"dup-assistant",
			assistantMessage("", 91, {
				content: ["dup-a", "dup-b"].map((id) => ({
					type: "toolCall",
					id,
					name: "read",
					arguments: { path: "notes.md" },
				})),
			}),
		);
		for (const id of ["dup-a", "dup-b"])
			f.push(`${id}-result`, {
				...toolResultMessage(id, "the notes", 92),
				toolName: "read",
			} as PiMessage);
		for (let index = 0; index < 6; index++) {
			f.push(
				`late-assistant-${index}`,
				assistantToolCall(
					`late-call-${index}`,
					"bash",
					{ command: `late ${index}` },
					93 + index * 2,
				),
			);
			f.push(`late-result-${index}`, {
				...toolResultMessage(
					`late-call-${index}`,
					`late ${index}: ${"detail ".repeat(1000)}`,
					94 + index * 2,
				),
				toolName: "bash",
			} as PiMessage);
		}
		f.push("dup-done", userMessage("continue", 120));
	};

	it("routine cleanup rides a change of the tool list alone", async () => {
		const f = fixture("cleanup-ride", { systemPrompt: "fixed" });
		await f.serve();
		await f.serve();
		addDuplicateReads(f);
		const unchanged = await f.serve();
		expect(unchanged.permitted).toBe(false);
		expect(f.toolTag("dup-a")?.status).toBe("active");

		f.setActive(WITHOUT_REDUCE);
		const changed = await f.serve();
		expect(changed.systemPrompt).toBe(unchanged.systemPrompt);
		expect(changed.permitted).toBe(true);
		expect(f.toolTag("dup-a")?.status).toBe("dropped");
		expect(f.toolTag("dup-b")?.status).toBe("active");
	});

	// Above the execute threshold a primary session applies routine cleanup
	// once per pressure episode. After that, a pass runs it again only when
	// something else already rewrote the request: here, the change of the tool
	// list.
	it("under pressure, routine cleanup rides the change after it already ran in this episode", async () => {
		const f = fixture("cleanup-ride-pressure", {
			systemPrompt: "fixed",
			executeThreshold: 40,
			oldOutputLines: 2_000,
		});
		// The first pass under pressure applies the episode's routine cleanup.
		await f.serve({ percent: 45 });
		addDuplicateReads(f);
		const unchanged = await f.serve({ percent: 45 });
		expect(unchanged.permitted).toBe(false);
		expect(f.toolTag("dup-a")?.status).toBe("active");

		f.setActive(WITHOUT_REDUCE);
		const changed = await f.serve({ percent: 45 });
		expect(changed.permitted).toBe(true);
		expect(prefixes(changed.bytes)).toEqual([]);
		expect(f.toolTag("dup-a")?.status).toBe("dropped");
	});

	// A side turn's request is not the session's next request and records
	// nothing as served, so its tool list never counts as a change: nothing
	// rides it, and the session's own next request replays byte for byte.
	it("an Oh My Pi side turn without ctx_reduce takes no ride: no drop, no cleanup, the next request unchanged", async () => {
		__setPiHarnessKindForTesting("omp");
		try {
			const f = fixture("side-turn-no-ride", { systemPrompt: "fixed" });
			await f.serve();
			await f.serve();
			// A duplicate only routine cleanup removes, and a queued drop: both
			// land on the next pass that has rebuild permission.
			addDuplicateReads(f);
			const before = await f.serve();
			expect(before.permitted).toBe(false);
			const old = f.toolTag("old-call");
			if (!old || old.status !== "active")
				throw new Error("the old tool output has no active tag");
			queuePendingOp(f.db, f.sessionId, old.tagNumber, "drop");

			f.setActive(WITHOUT_REDUCE);
			const side = await f.serve({
				extra: [
					{
						role: "developer",
						attribution: "agent",
						content: OMP_SIDE_REMINDER,
						timestamp: 200,
					} as unknown as PiMessage,
					{
						...userMessage("a quick side question", 201),
						attribution: "agent",
					} as PiMessage,
				],
			});
			// The side turn's own request follows the tools it sends.
			expect(prefixes(side.bytes)).toEqual([]);
			expect(side.permitted).toBe(false);
			expect(f.toolTag("old-call")?.status).toBe("active");
			expect(f.toolTag("dup-a")?.status).toBe("active");
			expect(getPendingOps(f.db, f.sessionId)).toHaveLength(1);

			f.setActive(WITH_REDUCE);
			const after = await f.serve();
			expect(after.permitted).toBe(false);
			expect(after.bytes).toBe(before.bytes);
			expect(f.toolTag("old-call")?.status).toBe("active");
			expect(f.toolTag("dup-a")?.status).toBe("active");
		} finally {
			__setPiHarnessKindForTesting(undefined);
		}
	});
});

describe("issue 904: a recorded subagent gets no primary-only lanes", () => {
	/** A session behind the real context handler, primary or a recorded subagent. */
	const lane = (
		name: string,
		subagent: boolean,
		options: Partial<Parameters<typeof registerPiContextHandler>[1]> = {},
	) => {
		const db = createTestDb();
		const sessionId = `issue-904-lane-${name}-${subagent ? "sub" : "main"}`;
		getOrCreateSessionMeta(db, sessionId);
		if (subagent) updateSessionMeta(db, sessionId, { isSubagent: true });
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, { db, ...options });
		cleanups.push(() => {
			clearContextHandlerSession(sessionId);
			db.close();
		});
		const handler = fake.handlers.get("context") as (
			event: { messages: PiMessage[] },
			ctx: never,
		) => Promise<{ messages: PiMessage[] } | undefined>;
		return { db, sessionId, handler };
	};

	for (const subagent of [false, true]) {
		const who = subagent ? "a recorded subagent" : "control: a primary session";
		it(`historian: ${who}`, async () => {
			const runner = {
				harness: "pi",
				run: mock(async () => ({
					ok: true as const,
					assistantText:
						'<compartment start="1" end="2" title="Recovered"><p1>Recovered.</p1></compartment>',
					durationMs: 1,
				})),
			} as unknown as SubagentRunner;
			const s = lane("historian", subagent, {
				historian: {
					runner,
					model: "test/model",
					historianChunkTokens: 20_000,
				},
			});
			// A failed run on record: a primary session starts a recovery run on
			// its next pass.
			incrementHistorianFailure(s.db, s.sessionId, "previous failure");
			const messages = Array.from({ length: 12 }, (_, index) =>
				index % 2 === 0
					? userMessage(`user ${index}`, index + 1)
					: assistantMessage(`assistant ${index}`, index + 1),
			);
			await s.handler({ messages }, {
				...fakeContext(s.sessionId),
				sessionManager: {
					getSessionId: () => s.sessionId,
					getBranch: () =>
						messages.map((message, index) => ({
							type: "message",
							id: `entry-${index + 1}`,
							message,
						})),
				},
				getContextUsage: () => ({
					tokens: 100,
					percent: 10,
					contextWindow: 10_000,
				}),
			} as never);
			await new Promise((resolve) => setTimeout(resolve, 0));
			await awaitInFlightHistorians();
			expect(runner.run).toHaveBeenCalledTimes(subagent ? 0 : 1);
		});

		it(`note nudges: ${who}`, async () => {
			const s = lane("notes", subagent);
			addNote(s.db, "session", {
				sessionId: s.sessionId,
				content: "A note for later.",
			});
			const trigger = userMessage("trigger turn", 1);
			await s.handler(
				{ messages: [trigger] },
				fakeContext(
					s.sessionId,
					process.cwd(),
					["entry-trigger"],
					[trigger],
				) as never,
			);
			onNoteTrigger(s.db, s.sessionId, "historian_complete");
			const next = userMessage("new turn", 2);
			const result = await s.handler(
				{ messages: [next] },
				fakeContext(s.sessionId, process.cwd(), ["entry-new"], [next]) as never,
			);
			expect(textOf(result?.messages[0]).includes("deferred_notes")).toBe(
				!subagent,
			);
		});

		it(`auto-search: ${who}`, async () => {
			const snapshot = spyOn(
				embeddingModule,
				"getProjectEmbeddingSnapshot",
			).mockImplementation(autoSearchTestSnapshot);
			const search = spyOn(searchModule, "searchAutoHint").mockImplementation(
				async () =>
					[
						{
							source: "memory",
							content: "Relevant search wiring",
							score: 0.9,
							memoryId: 1,
							category: "WORKFLOW_RULES",
							matchType: "fts",
						},
					] as never,
			);
			try {
				const s = lane("search", subagent, {
					autoSearch: {
						enabled: true,
						scoreThreshold: 0.6,
						minPromptChars: 10,
						memoryEnabled: true,
						embeddingEnabled: false,
						gitCommitsEnabled: false,
					},
				});
				const prompt = userMessage("explain the search wiring", 1);
				const result = await s.handler(
					{ messages: [prompt] },
					fakeContext(
						s.sessionId,
						process.cwd(),
						["entry-1"],
						[prompt],
					) as never,
				);
				expect(search).toHaveBeenCalledTimes(subagent ? 0 : 1);
				expect(textOf(result?.messages[0]).includes("<ctx-search-hint>")).toBe(
					!subagent,
				);
			} finally {
				snapshot.mockRestore();
				search.mockRestore();
			}
		});
	}
});
