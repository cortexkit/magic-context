import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	copySessionStateForClone,
	getCompartments,
	getPendingPiCompactionMarkerState,
	getTagsBySession,
	setPendingPiCompactionMarkerState,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import {
	getCurrentSystemPrompt,
	getCurrentTools,
	getInitialSystemMessage,
	normalizeContext,
} from "pi-ai-086";
import { stream as anthropicStream } from "pi-ai-086/api/anthropic-messages";
import { stream as responsesStream } from "pi-ai-086/api/openai-responses";
import { SessionManager } from "pi-coding-agent-086";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	__test as cloneTest,
	handlePiCloneSessionStart,
} from "./clone-inheritance";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
} from "./context-handler";
import { applyPiHeuristicCleanup } from "./heuristic-cleanup-pi";
import { injectM0M1Pi } from "./inject-compartments-pi";
import { createPiLkgCoordinator } from "./pi-lkg";
import { convertEntriesToRawMessages } from "./read-session-pi";
import { isPiSystemEntry } from "./system-entry-pi";
import { measurePiTailHygiene } from "./tail-hygiene-walk-pi";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	toolResultMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

const userMessage = (content: string, timestamp = 1) => ({
	role: "user" as const,
	content,
	timestamp,
});
const tool = (name: string) => ({
	name,
	description: name,
	parameters: { type: "object", properties: {} },
});
const initial = {
	role: "system" as const,
	content: "BASE_GATE_PROMPT",
	toolsAdded: [tool("read"), tool("edit"), tool("bash")],
	timestamp: 0,
};
const delta = {
	role: "system" as const,
	content: "DELTA_GATE_PROMPT",
	toolsAdded: [tool("mcp-a"), tool("mcp-b")],
	timestamp: 2,
};
const digest = (messages: unknown[]) =>
	createHash("sha256").update(JSON.stringify(messages)).digest("hex");
function capture(label: string, messages: unknown[]) {
	const state = {
		label,
		sha256: digest(messages),
		tools: getCurrentTools(messages as never).map((t) => t.name),
		prompt: getCurrentSystemPrompt(messages as never),
	};
	console.log(`GATE ${JSON.stringify(state)}`);
	return state;
}
function harness(db: ReturnType<typeof createTestDb>, manager: SessionManager) {
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		injection: { injectionBudgetTokens: 10000 },
		scheduler: { executeThresholdPercentage: 65 },
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: unknown[] },
		ctx: unknown,
	) => Promise<{ messages: unknown[] }>;
	return (tokens = 10000, runtime: unknown = manager) =>
		handler(
			{ messages: structuredClone(manager.buildSessionContext().messages) },
			{
				cwd: process.cwd(),
				hasUI: false,
				signal: new AbortController().signal,
				ui: { notify() {} },
				model: {
					provider: "anthropic",
					id: "claude-sonnet-4-5",
					contextWindow: 100000,
				},
				sessionManager: runtime,
				getContextUsage: () => ({
					tokens,
					percent: tokens / 1000,
					contextWindow: 100000,
				}),
			},
		);
}
function publish(
	db: ReturnType<typeof createTestDb>,
	manager: SessionManager,
	end: string,
	tail: string,
	sequence = 0,
) {
	const sessionId = manager.getSessionId();
	const raw = convertEntriesToRawMessages(manager.getBranch());
	const ordinal = raw.find((m) => m.id === end)?.ordinal;
	if (!ordinal) throw new Error("No boundary ordinal");
	appendCompartments(db, sessionId, [
		{
			sequence,
			startMessage: sequence ? ordinal : 1,
			endMessage: ordinal,
			startMessageId: sequence ? end : raw[0]?.id,
			endMessageId: end,
			title: "gate",
			content: `MC_ONLY_PREFIX_${sequence}`,
		},
	]);
	setPendingPiCompactionMarkerState(db, sessionId, {
		firstKeptEntryId: tail,
		endMessageId: end,
		ordinal,
		tokensBefore: 70000,
		summary: "MC marker",
		publishedAt: Date.now(),
	});
	signalPiDeferredHistoryRefresh(sessionId);
	signalPiDeferredMaterialization(sessionId);
	updateSessionMeta(db, sessionId, {
		lastResponseTime: Date.now(),
		cacheTtl: "59m",
		lastContextPercentage: 70,
		lastInputTokens: 70000,
	});
}

it.skipIf(!process.env.MC_GATE_RESTART)("A restart child", async () => {
	const manager = SessionManager.open(process.env.MC_GATE_SESSION as string);
	const db = createTestDb(process.env.MC_GATE_DB);
	try {
		capture("A-process-restart", (await harness(db, manager)()).messages);
	} finally {
		db.close();
	}
});

it("A C D reporter fold, process restart, LKG and second cut", async () => {
	const dir = createTestTempDirFromPath(join(tmpdir(), "mc-gate-"));
	const dbPath = join(dir, "gate.sqlite");
	const db = createTestDb(dbPath);
	const manager = SessionManager.create(process.cwd(), dir);
	const sid = manager.getSessionId();
	try {
		manager.appendMessage(initial);
		const old = manager.appendMessage(userMessage("old", 1));
		manager.appendMessage(delta);
		const tail = manager.appendMessage(userMessage("tail", 3));
		manager.appendMessage(assistantMessage("answer", 4) as never);
		updateSessionMeta(db, sid, { piStableIdScheme: 1 });
		const pass = harness(db, manager);
		await pass();
		const before = capture("A-before", manager.buildSessionContext().messages);
		publish(db, manager, old, tail);
		const folded = capture("A-fold", (await pass(70000)).messages);
		expect(folded.tools).toEqual(["read", "edit", "bash", "mcp-a", "mcp-b"]);
		expect(folded.prompt).toBe(before.prompt);
		updateSessionMeta(db, sid, {
			lastContextPercentage: 10,
			lastInputTokens: 10000,
		});
		let served: unknown[] = [];
		for (let i = 0; i < 4; i++) {
			served = (await pass()).messages;
			expect(capture(`A-defer-${i}`, served).sha256).toBe(folded.sha256);
		}
		const child = Bun.spawnSync(
			[process.execPath, "test", import.meta.path, "-t", "A restart child"],
			{
				windowsHide: true,
				env: {
					...process.env,
					MC_GATE_RESTART: "1",
					MC_GATE_SESSION: manager.getSessionFile() ?? "",
					MC_GATE_DB: dbPath,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(child.exitCode).toBe(0);
		const output = child.stdout.toString() + child.stderr.toString();
		console.log(output);
		expect(output).toContain(folded.sha256);
		const lkg = createPiLkgCoordinator(db, (fn) => fn());
		const raw = manager.buildSessionContext().messages;
		const args = {
			sessionId: sid,
			messages: raw,
			entryIds: raw.map((_, i) => `r${i}`),
			modelKey: "gate",
			providerKey: "gate",
		};
		lkg.captureAppliedPass({
			snapshot: lkg.beginPass(args),
			outputMessages: served,
			cacheBusting: true,
		});
		const replay = lkg.replay(lkg.beginPass(args));
		expect(replay.ok).toBe(true);
		if (replay.ok)
			expect(capture("A-LKG", replay.messages).sha256).toBe(folded.sha256);
		manager.appendMessage({
			role: "system",
			content: "POST_BOUNDARY",
			toolsAdded: [tool("late")],
			timestamp: 5,
		});
		const end2 = manager.appendMessage(userMessage("second old", 6));
		manager.appendMessage({
			role: "system",
			content: "",
			toolsRemoved: [{ name: "edit" }, { name: "mcp-a" }],
			timestamp: 7,
		});
		const tail2 = manager.appendMessage(userMessage("second tail", 8));
		manager.appendMessage(assistantMessage("answer2", 9) as never);
		const secondBefore = capture(
			"CD-before",
			manager.buildSessionContext().messages,
		);
		publish(db, manager, end2, tail2, 1);
		const second = capture("CD-fold", (await pass(70000)).messages);
		expect(second.tools).toEqual(["read", "bash", "mcp-b", "late"]);
		expect(second.prompt).toBe(secondBefore.prompt);
		expect(
			manager.getBranch().filter((e) => e.type === "compaction"),
		).toHaveLength(2);
		updateSessionMeta(db, sid, {
			lastContextPercentage: 10,
			lastInputTokens: 10000,
		});
		expect(capture("CD-defer", (await pass()).messages).sha256).toBe(
			second.sha256,
		);
	} finally {
		clearContextHandlerSession(sid);
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

for (const order of ["inject-first", "marker-first"])
	it(`B snapshot excludes MC prefix ${order}`, () => {
		const dir = createTestTempDirFromPath(join(tmpdir(), "mc-order-"));
		const db = createTestDb();
		const manager = SessionManager.create(process.cwd(), dir);
		const sid = manager.getSessionId();
		try {
			const head = manager.appendMessage(initial);
			const old = manager.appendMessage(userMessage("old", 1));
			manager.appendMessage(delta);
			const tail = manager.appendMessage(userMessage("tail", 3));
			appendCompartments(db, sid, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: head,
					endMessageId: old,
					title: "gate",
					content: "MC_ONLY_PREFIX",
				},
			]);
			const messages = structuredClone(manager.buildSessionContext().messages);
			const inject = () =>
				injectM0M1Pi(
					{
						sessionId: sid,
						projectDirectory: process.cwd(),
						projectIdentity: "gate",
					},
					db,
					messages as never,
					manager
						.getBranch()
						.filter((e) => e.type === "message")
						.map((e) => e.id),
				);
			const marker = () => manager.appendCompaction("MC marker", tail, 70000);
			if (order === "inject-first") {
				inject();
				marker();
			} else {
				marker();
				inject();
			}
			expect(JSON.stringify(messages)).toContain("<session-history>");
			const state = capture(`B-${order}`, messages);
			const snapshot = manager
				.getBranch()
				.reverse()
				.find((e) => e.type === "compaction");
			if (snapshot?.type !== "compaction" || !snapshot.systemMessage)
				throw new Error("Missing snapshot");
			const prompt = getCurrentSystemPrompt([snapshot.systemMessage]);
			expect(prompt).toBe("BASE_GATE_PROMPT\n\nDELTA_GATE_PROMPT");
			expect(prompt).not.toContain("<session-history>");
			expect(state.prompt).toBe(prompt);
		} finally {
			clearContextHandlerSession(sid);
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

it("E displaced system is promoted for the initial resolver on defer", () => {
	const db = createTestDb();
	const sid = "gate-displaced";
	try {
		const messages = [
			userMessage("EXTENSION_BEFORE_SYSTEM", -1),
			structuredClone(initial),
			userMessage("tail", 3),
		];
		const entryIds = ["extension", "system", "tail"];
		injectM0M1Pi(
			{
				sessionId: sid,
				projectDirectory: process.cwd(),
				projectIdentity: "gate",
			},
			db,
			messages as never,
			entryIds,
		);
		capture("E-displaced", messages);
		expect(getCurrentTools(messages as never)).toHaveLength(3);
		expect(
			getInitialSystemMessage(messages as never)?.toolsAdded?.map(
				(entry) => entry.name,
			),
		).toEqual(["read", "edit", "bash"]);
		expect(messages[0]?.role).toBe("system");
		expect(messages[1]).toEqual(userMessage("EXTENSION_BEFORE_SYSTEM", -1));
		expect(messages.slice(2, 4).map((message) => message.role)).toEqual([
			"user",
			"user",
		]);
		expect(entryIds).toEqual(["extension", "system", "tail"]);
	} finally {
		clearContextHandlerSession(sid);
		db.close();
	}
});

it("I foreign system role is protocol state and excluded mass", () => {
	const db = createTestDb();
	try {
		const foreign = {
			role: "system",
			content: "FOREIGN ".repeat(20000),
			timestamp: 0,
		};
		const messages = [foreign];
		const transcript = createPiTranscript(messages, "foreign");
		const tagger = createTagger();
		tagger.initFromDb("foreign", db);
		expect(tagTranscript("foreign", transcript, tagger, db).targets.size).toBe(
			0,
		);
		const measured = measurePiTailHygiene({
			messages,
			tags: [],
			protectedTagNumbers: new Set(),
		});
		expect(measured.t).toBe(0);
		expect(measured.u).toBe(0);
		expect(getCurrentSystemPrompt(messages as never)).toBe(foreign.content);
		console.log(
			`GATE I ${digest(messages)} promptBytes=${foreign.content.length} tools=${getCurrentTools(messages as never).length}`,
		);
	} finally {
		db.close();
	}
});

it("H clone filter preserves system ordinals without tag targets", () => {
	const db = createTestDb();
	try {
		const entries = [
			initial,
			userMessage("old", 1),
			delta,
			userMessage("tail", 3),
		].map((message, i) => ({ type: "message", id: `e${i}`, message }));
		appendCompartments(db, "source", [
			{
				sequence: 0,
				startMessage: 1,
				endMessage: 3,
				startMessageId: "e0",
				endMessageId: "e2",
				title: "gate",
				content: "summary",
			},
		]);
		copySessionStateForClone(
			db,
			"source",
			"fork",
			cloneTest.createCloneFilter(entries),
		);
		expect(getCompartments(db, "fork")[0]?.endMessage).toBe(3);
		expect(
			convertEntriesToRawMessages(entries).map((m) => [m.id, m.ordinal]),
		).toEqual([
			["e0", 1],
			["e1", 2],
			["e2", 3],
			["e3", 4],
		]);
		const messages = structuredClone(entries.map((e) => e.message));
		const view = createPiTranscript(
			messages,
			"fork",
			entries.map((e) => e.id),
		);
		const tagger = createTagger();
		tagger.initFromDb("fork", db);
		tagTranscript("fork", view, tagger, db);
		view.commit();
		expect(
			getTagsBySession(db, "fork").some((t) => /e[02]/.test(t.messageId)),
		).toBe(false);
		expect(messages.filter(isPiSystemEntry)).toEqual([initial, delta]);
		expect(capture("H-fork", messages).tools).toHaveLength(5);
	} finally {
		db.close();
	}
});

for (const api of ["anthropic-messages", "openai-responses"])
	it(`G emergency interleaved pairing ${api}`, async () => {
		const db = createTestDb();
		const sid = `gate-${api}`;
		try {
			const messages: unknown[] = [structuredClone(initial)];
			for (let i = 0; i < 8; i++) {
				const call = assistantToolCall(`read-${i}`, "read", {}, i * 2 + 1);
				Object.assign(call, {
					api,
					provider: api === "anthropic-messages" ? "anthropic" : "openai",
				});
				messages.push(
					call,
					toolResultMessage(
						`read-${i}`,
						"large output ".repeat(4000),
						i * 2 + 2,
					),
				);
				if (i === 3) messages.push(structuredClone(delta));
			}
			const before = capture(`G-${api}-before`, messages);
			const view = createPiTranscript(messages, sid);
			const tagger = createTagger();
			tagger.initFromDb(sid, db);
			const { targets } = tagTranscript(sid, view, tagger, db);
			const result = applyPiHeuristicCleanup(sid, db, targets, messages, {
				routine: false,
				protectedTags: 0,
				staleReduceStripEnabled: false,
				emergency: {
					currentTotalInputTokens: 95000,
					ceilingTokens: 65000,
					usagePercentage: 95,
				},
			});
			view.commit();
			view.finalizeToolRemovals();
			expect(result.emergencyDroppedTools).toBeGreaterThan(0);
			expect(messages.filter(isPiSystemEntry)).toEqual([initial, delta]);
			const calls: string[] = [];
			const results: string[] = [];
			for (const m of messages as {
				role: string;
				toolCallId?: string;
				content?: { type: string; id?: string }[];
			}[]) {
				if (m.role === "assistant" && Array.isArray(m.content))
					for (const c of m.content)
						if (c.type === "toolCall" && c.id) calls.push(c.id);
				if (m.role === "toolResult" && m.toolCallId) results.push(m.toolCallId);
			}
			expect(calls.sort()).toEqual(results.sort());
			const after = capture(`G-${api}-after`, messages);
			expect(after.tools).toEqual(before.tools);
			expect(after.prompt).toBe(before.prompt);
			let payload: unknown;
			const options = {
				apiKey: "gate-no-network",
				onPayload: (value: unknown) => {
					payload = value;
					throw new Error("gate payload captured before network");
				},
			};
			const wire =
				api === "anthropic-messages"
					? anthropicStream(
							{
								api,
								input: ["text"],
								reasoning: false,
								id: "claude-sonnet-4-5",
								provider: "anthropic",
								baseUrl: "https://api.anthropic.com",
								maxTokens: 4096,
								contextWindow: 100000,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							} as never,
							normalizeContext({ messages: messages as never }),
							options,
						)
					: responsesStream(
							{
								api,
								input: ["text"],
								reasoning: false,
								id: "gpt-5",
								provider: "openai",
								baseUrl: "https://api.openai.com/v1",
								maxTokens: 4096,
								contextWindow: 100000,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							} as never,
							normalizeContext({ messages: messages as never }),
							options,
						);
			const wireResult = await wire.result();
			if (!payload) throw new Error(JSON.stringify(wireResult));
			expect(payload).toBeDefined();
			const body = payload as {
				messages?: {
					content: { type: string; id?: string; tool_use_id?: string }[];
				}[];
				input?: { type: string; call_id?: string }[];
				tools: { name: string }[];
			};
			const wireCalls: string[] = [];
			const wireResults: string[] = [];
			for (const message of body.messages ?? [])
				for (const part of Array.isArray(message.content)
					? message.content
					: []) {
					if (part.type === "tool_use" && part.id) wireCalls.push(part.id);
					if (part.type === "tool_result" && part.tool_use_id)
						wireResults.push(part.tool_use_id);
				}
			for (const item of body.input ?? []) {
				if (item.type === "function_call" && item.call_id)
					wireCalls.push(item.call_id);
				if (item.type === "function_call_output" && item.call_id)
					wireResults.push(item.call_id);
			}
			expect(wireCalls.length).toBeGreaterThan(0);
			expect(wireCalls.sort()).toEqual(wireResults.sort());
			expect(body.tools.map((t) => t.name)).toEqual(before.tools);
			console.log(
				`GATE G-wire-${api} sha256=${digest([payload])} pairs=${wireCalls.length}`,
			);
		} finally {
			db.close();
		}
	});

for (const mode of ["missing-method", "throwing-signature", "readonly-085"])
	it(`J reflective drain ${mode}`, async () => {
		const dir = createTestTempDirFromPath(join(tmpdir(), "mc-bind-"));
		const db = createTestDb();
		const manager = SessionManager.create(process.cwd(), dir);
		const sid = manager.getSessionId();
		try {
			manager.appendMessage(initial);
			const old = manager.appendMessage(userMessage("old", 1));
			const tail = manager.appendMessage(userMessage("tail", 2));
			manager.appendMessage(assistantMessage("answer", 3) as never);
			updateSessionMeta(db, sid, { piStableIdScheme: 1 });
			const pass = harness(db, manager);
			await pass();
			publish(db, manager, old, tail);
			const runtime = new Proxy(manager, {
				get(target, key) {
					if (key === "appendCompaction")
						return mode === "throwing-signature"
							? () => {
									throw new TypeError("simulated incompatible signature");
								}
							: undefined;
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const served = (await pass(70000, runtime)).messages;
			expect(
				manager.getBranch().filter((e) => e.type === "compaction"),
			).toHaveLength(0);
			expect(getPendingPiCompactionMarkerState(db, sid)).not.toBeNull();
			expect(JSON.stringify(served)).toContain("<session-history>");
			expect(capture(`J-${mode}`, served).tools).toHaveLength(3);
		} finally {
			clearContextHandlerSession(sid);
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

it("J populated stale-view snapshot is refused by the equivalence fence", async () => {
	const dir = createTestTempDirFromPath(join(tmpdir(), "mc-race-"));
	const db = createTestDb();
	const manager = SessionManager.create(process.cwd(), dir);
	const sid = manager.getSessionId();
	try {
		manager.appendMessage(initial);
		const old = manager.appendMessage(userMessage("old", 1));
		const tail = manager.appendMessage(userMessage("tail", 2));
		manager.appendMessage(assistantMessage("answer", 3) as never);
		updateSessionMeta(db, sid, { piStableIdScheme: 1 });
		const pass = harness(db, manager);
		await pass();
		publish(db, manager, old, tail);
		const assumed = capture(
			"J-fence-before",
			manager.buildSessionContext().messages,
		);
		const runtime = new Proxy(manager, {
			get(target, key) {
				if (key === "appendCompaction")
					return (
						summary: string,
						firstKeptEntryId: string,
						tokensBefore: number,
						details: unknown,
						fromHook: boolean | undefined,
						usage: Parameters<SessionManager["appendCompaction"]>[5],
					) => {
						// Append to the host session after Magic Context has read the messages it will fold.
						target.appendMessage({
							role: "system",
							content: "RACING_EXTENSION",
							toolsRemoved: [{ name: "read" }],
							timestamp: 10,
						});
						return target.appendCompaction(
							summary,
							firstKeptEntryId,
							tokensBefore,
							details,
							fromHook,
							usage,
						);
					};
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const served = (await pass(70000, runtime)).messages;
		const after = capture("J-fence-after", served);
		const equivalent =
			JSON.stringify(after.tools) === JSON.stringify(assumed.tools) &&
			after.prompt === assumed.prompt;
		const markers = manager.getBranch().filter((e) => e.type === "compaction");
		expect(equivalent).toBe(true);
		expect(markers).toHaveLength(1);
		const snapshot = markers[0]?.systemMessage;
		expect(snapshot).toBeDefined();
		if (!snapshot) throw new Error("Missing populated snapshot");
		expect(getCurrentTools([snapshot]).map((t) => t.name)).toEqual([
			"edit",
			"bash",
		]);
		expect(getCurrentSystemPrompt([snapshot])).toBe(
			"BASE_GATE_PROMPT\n\nRACING_EXTENSION",
		);
		expect(after.tools).toEqual(["read", "edit", "bash"]);
		expect(after.prompt).toBe("BASE_GATE_PROMPT");
		expect(getPendingPiCompactionMarkerState(db, sid)).not.toBeNull();
		expect(JSON.stringify(served)).toContain("<session-history>");

		const journal = capture(
			"J-fence-journal",
			manager.buildSessionContext().messages,
		);
		const replayed = capture("J-fence-rechecked", (await pass(70000)).messages);
		expect(replayed.tools).toEqual(journal.tools);
		expect(replayed.prompt).toBe(journal.prompt);
		expect(getPendingPiCompactionMarkerState(db, sid)).toBeNull();
		expect(
			manager.getBranch().filter((e) => e.type === "compaction"),
		).toHaveLength(1);
	} finally {
		clearContextHandlerSession(sid);
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("J wholly absent runtime manager returns unchanged input", async () => {
	const dir = createTestTempDirFromPath(join(tmpdir(), "mc-absent-"));
	const db = createTestDb();
	const manager = SessionManager.create(process.cwd(), dir);
	const sid = manager.getSessionId();
	try {
		manager.appendMessage(initial);
		const old = manager.appendMessage(userMessage("old", 1));
		const tail = manager.appendMessage(userMessage("tail", 2));
		manager.appendMessage(assistantMessage("answer", 3) as never);
		updateSessionMeta(db, sid, { piStableIdScheme: 1 });
		const pass = harness(db, manager);
		await pass();
		publish(db, manager, old, tail);
		const before = manager.buildSessionContext().messages;
		const result = await pass(70000, null);
		console.log(`GATE J-absent result=${JSON.stringify(result)}`);
		expect(result).toBeUndefined();
		capture("J-absent-host-input", before);
		expect(getPendingPiCompactionMarkerState(db, sid)).not.toBeNull();
		expect(
			manager.getBranch().filter((e) => e.type === "compaction"),
		).toHaveLength(0);
	} finally {
		clearContextHandlerSession(sid);
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("H physical fork inherits protocol entries and compartment ordinals", async () => {
	const dir = createTestTempDirFromPath(join(tmpdir(), "mc-fork-"));
	const db = createTestDb();
	try {
		const source = SessionManager.create(process.cwd(), dir);
		const sid = source.getSessionId();
		const head = source.appendMessage(initial);
		source.appendMessage(userMessage("old", 1));
		const mid = source.appendMessage(delta);
		source.appendMessage(userMessage("tail", 3));
		const leaf = source.appendMessage(assistantMessage("answer", 4) as never);
		const sourceFile = source.getSessionFile();
		if (!sourceFile) throw new Error("Missing source file");
		appendCompartments(db, sid, [
			{
				sequence: 0,
				startMessage: 1,
				endMessage: 3,
				startMessageId: head,
				endMessageId: mid,
				title: "fork",
				content: "summary",
			},
		]);
		const sourceRaw = convertEntriesToRawMessages(source.getBranch());
		const before = capture("H-source", source.buildSessionContext().messages);
		const path = source.createBranchedSession(leaf);
		if (!path) throw new Error("Missing fork file");
		const fork = SessionManager.open(path);
		const inherited = await handlePiCloneSessionStart(
			{ reason: "fork", previousSessionFile: sourceFile },
			{ sessionManager: fork },
			{ db, signalPendingMarker() {} },
		);
		expect(inherited).not.toBeNull();
		expect(convertEntriesToRawMessages(fork.getBranch())).toEqual(sourceRaw);
		expect(getCompartments(db, fork.getSessionId())[0]?.endMessage).toBe(3);
		const messages = fork.buildSessionContext().messages;
		expect(capture("H-physical-fork", messages).sha256).toBe(before.sha256);
		const view = createPiTranscript(
			messages,
			fork.getSessionId(),
			fork.getBranch().map((e) => e.id),
		);
		const tagger = createTagger();
		tagger.initFromDb(fork.getSessionId(), db);
		tagTranscript(fork.getSessionId(), view, tagger, db);
		view.commit();
		expect(messages.filter(isPiSystemEntry)).toEqual([initial, delta]);
		expect(
			getTagsBySession(db, fork.getSessionId()).some(
				(t) => t.messageId.startsWith(head) || t.messageId.startsWith(mid),
			),
		).toBe(false);
		capture("H-tagged-fork", messages);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
