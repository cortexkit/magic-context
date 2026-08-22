import { describe, expect, it } from "bun:test";
import { replaceAllCompartmentState } from "@magic-context/core/features/magic-context/compartment-storage";
import { isMemoryMigrationDone } from "@magic-context/core/features/magic-context/memory/memory-migration";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	getMemoriesByProject,
	insertMemory,
} from "@magic-context/core/features/magic-context/memory/storage-memory";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import {
	getPendingPiCompactionMarkerState,
	insertTag,
} from "@magic-context/core/features/magic-context/storage";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { queuePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import { Database } from "@magic-context/core/shared/sqlite";

import {
	consumeDeferredHistoryRefresh,
	consumeDeferredMaterialization,
} from "../context-handler";
import {
	abortInFlightRecomps,
	awaitInFlightRecomps,
} from "../pi-recomp-runner";
import { registerCtxDreamCommand } from "./ctx-dream";
import { registerCtxFlushCommand } from "./ctx-flush";
import { registerCtxRecompCommand } from "./ctx-recomp";
import { registerCtxSessionUpgradeCommand } from "./ctx-session-upgrade";
import { registerCtxStatusCommand } from "./ctx-status";
import { registerCtxWrapupCommand } from "./ctx-wrapup";

type Handler = (args: string, ctx: MockCommandContext) => Promise<void>;

interface AppendedEntry {
	customType: string;
	data: {
		title: string;
		text: string;
		level?: "info" | "success" | "warning" | "error";
		details?: unknown;
	};
}

interface MockCommandContext {
	cwd: string;
	hasUI?: boolean;
	mode?: "rpc";
	ui: {
		custom: (factory: unknown, options?: unknown) => Promise<unknown>;
		notify?: (text: string, type?: string) => void;
		setStatus?: (key: string, text: string) => void;
	};
	model?: {
		provider: string;
		id: string;
		contextWindow?: number;
		maxTokens?: number;
	};
	sessionManager: {
		getSessionId: () => string | undefined;
		getBranch?: () => unknown[];
	};
	getContextUsage: () => {
		contextWindow: number;
		tokens: number;
		percent: number;
	};
}

function createDb() {
	const db = new Database(":memory:");
	initializeDatabase(db);
	runMigrations(db);
	return db;
}

function createMockPi() {
	const handlers = new Map<string, Handler>();
	const sent: AppendedEntry[] = [];
	return {
		pi: {
			registerCommand(name: string, options: { handler: Handler }) {
				handlers.set(name, options.handler);
			},
			registerEntryRenderer() {},
			appendEntry(customType: string, data: AppendedEntry["data"]) {
				sent.push({ customType, data });
			},
			sendMessage() {
				throw new Error("ctx-status must not use sendMessage");
			},
		},
		handlers,
		sent,
	};
}

function createCtx(sessionId = "ses-1"): MockCommandContext {
	const customCalls: Array<{ factory: unknown; options: unknown }> = [];
	const entries = Array.from({ length: 12 }, (_, index) => ({
		id: `m${index + 1}`,
		type: "message",
		message: {
			role: index % 2 === 0 ? "user" : "assistant",
			content:
				index % 2 === 0
					? `message ${index + 1}`
					: [{ type: "text", text: `message ${index + 1}` }],
		},
	}));
	return {
		cwd: "/tmp/project",
		hasUI: false,
		ui: {
			async custom(factory: unknown, options?: unknown) {
				customCalls.push({ factory, options });
				return undefined;
			},
			setStatus() {},
		},
		model: { provider: "anthropic", id: "claude" },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
		getContextUsage: () => ({
			contextWindow: 100_000,
			tokens: 1_000,
			percent: 1,
		}),
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function validCompartmentForPrompt(prompt: string): string {
	const ordinals = [...prompt.matchAll(/^\[(\d+)\] [UAT]:/gm)].map((match) =>
		Number(match[1]),
	);
	const start = ordinals[0];
	const end = ordinals.at(-1);
	if (start === undefined || end === undefined) {
		throw new Error("expected tagged transcript ordinals in historian prompt");
	}
	return `<compartment start="${start}" end="${end}" title="Test history"><p1>Covered messages ${start}-${end}.</p1></compartment>`;
}

function probeLiveCommandContext(ctx: MockCommandContext): {
	endLifecycle(): void;
	lateAccesses(): number;
} {
	let live = true;
	let cwd = ctx.cwd;
	let model = ctx.model;
	let lateAccessCount = 0;
	const guard = () => {
		if (!live) lateAccessCount += 1;
	};
	Object.defineProperty(ctx, "cwd", {
		configurable: true,
		get: () => {
			guard();
			return cwd;
		},
	});
	Object.defineProperty(ctx, "model", {
		configurable: true,
		get: () => {
			guard();
			return model;
		},
	});
	const custom = ctx.ui.custom;
	ctx.ui.custom = (...args) => {
		guard();
		return custom(...args);
	};
	const notify = ctx.ui.notify;
	ctx.ui.notify = (...args) => {
		guard();
		notify?.(...args);
	};
	const setStatus = ctx.ui.setStatus;
	ctx.ui.setStatus = (...args) => {
		guard();
		setStatus?.(...args);
	};
	return {
		endLifecycle() {
			live = false;
			cwd = "/tmp/reused-session-context";
			model = { provider: "other", id: "replacement" };
		},
		lateAccesses: () => lateAccessCount,
	};
}

describe("Pi Magic Context commands", () => {
	it("registers /ctx-status and opens a UI overlay when UI is available", async () => {
		const db = createDb();
		const tagId = insertTag(db, "ses-1", "msg-1", "message", 1234, 1);
		queuePendingOp(db, "ses-1", tagId, "drop");
		const { pi, handlers, sent } = createMockPi();
		const customCalls: Array<{ factory: unknown; options: unknown }> = [];
		const ctx = {
			...createCtx(),
			hasUI: true,
			ui: {
				async custom(factory: unknown, options?: unknown) {
					customCalls.push({ factory, options });
					return undefined;
				},
			},
		};

		registerCtxStatusCommand(pi as never, {
			db,
			projectIdentity: "/tmp/project",
		});
		await handlers.get("ctx-status")?.("", ctx);

		expect(sent).toHaveLength(0);
		expect(customCalls).toHaveLength(1);
		expect(customCalls[0]?.options).toMatchObject({ overlay: true });
	});

	it("appends a model-invisible status entry without UI", async () => {
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();

		registerCtxStatusCommand(pi as never, {
			db,
			projectIdentity: "/tmp/project",
		});
		await handlers.get("ctx-status")?.("", createCtx());

		expect(sent).toHaveLength(1);
		expect(sent[0]?.customType).toBe("ctx-status");
		expect(sent[0]?.data.text).toContain("## Magic Status");
	});

	it("surfaces the active profile in /ctx-status text and dialog data", async () => {
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();
		registerCtxStatusCommand(pi as never, {
			db,
			projectIdentity: "/tmp/project",
			activeProfile: "work",
		});

		await handlers.get("ctx-status")?.("", createCtx());

		expect(sent[0]?.data.text).toContain("Active profile: work");
		expect(sent[0]?.data.details).toMatchObject({ activeProfile: "work" });
	});

	it("presents /ctx-status through the live RPC command context", async () => {
		const db = createDb();
		const { pi, handlers } = createMockPi();
		const shownA: unknown[] = [];
		const shownB: unknown[] = [];
		const rpcCtx = (sessionId: string, shown: unknown[]) => ({
			...createCtx(sessionId),
			mode: "rpc" as const,
			ui: {
				async custom(factory: unknown) {
					shown.push(factory);
					return undefined;
				},
				notify() {},
			},
		});
		registerCtxStatusCommand(pi as never, {
			db,
			projectIdentity: "/tmp/project",
		});

		await handlers.get("ctx-status")?.("", rpcCtx("ses-a", shownA));
		await handlers.get("ctx-status")?.("", rpcCtx("ses-b", shownB));

		expect(shownA).toHaveLength(1);
		expect(shownB).toHaveLength(1);
	});

	it("/ctx-status keeps the persisted usable limit when command context omits maxTokens", async () => {
		const db = createDb();
		const sessionId = "ses-status-persisted-reserve";
		const inputTokens = 105_932;
		const { persistPiPressureFromMessageEnd } = await import("../index");
		await persistPiPressureFromMessageEnd({
			db,
			sessionId,
			message: {
				role: "assistant",
				usage: {
					input: inputTokens,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: inputTokens,
				},
			},
			piContextWindow: 204_000,
			piModel: {
				provider: "anthropic",
				id: "claude",
				maxTokens: 30_625,
			},
		});
		const { pi, handlers, sent } = createMockPi();
		registerCtxStatusCommand(pi as never, {
			db,
			projectIdentity: "/tmp/project",
		});

		await handlers.get("ctx-status")?.("", {
			...createCtx(sessionId),
			model: {
				provider: "anthropic",
				id: "claude",
				contextWindow: 204_000,
			},
			getContextUsage: () => ({
				tokens: inputTokens,
				percent: (inputTokens / 204_000) * 100,
				contextWindow: 204_000,
			}),
		});

		expect(sent[0]?.data.text).toContain("Last percentage: 61.1%");
		expect(sent[0]?.data.text).toContain("Resolved context limit: 173,375");
	});

	it("refuses every context-management command in compaction-off mode without mutations", async () => {
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();
		const sessionId = "ses-compaction-off-command";
		const tagId = insertTag(db, sessionId, "message-1", "message", 20, 1);
		queuePendingOp(db, sessionId, tagId, "drop");
		const common = {
			db,
			runner: {} as never,
			historianModel: "test/model",
			historianChunkTokens: 1000,
			memoryEnabled: true,
			autoPromote: false,
			compactionOff: true,
		};
		registerCtxFlushCommand(pi as never, { db, compactionOff: true });
		registerCtxRecompCommand(pi as never, common);
		registerCtxWrapupCommand(pi as never, common);
		registerCtxSessionUpgradeCommand(pi as never, common);

		for (const name of [
			"ctx-flush",
			"ctx-recomp",
			"ctx-wrapup",
			"ctx-session-upgrade",
		]) {
			await handlers.get(name)?.("", createCtx(sessionId));
		}

		expect(sent.map((entry) => entry.data.text)).toEqual([
			"Unavailable: magic-context is in compaction-off mode (compaction.enabled=false).",
			"Unavailable: magic-context is in compaction-off mode (compaction.enabled=false).",
			"Unavailable: magic-context is in compaction-off mode (compaction.enabled=false).",
			"Unavailable: magic-context is in compaction-off mode (compaction.enabled=false).",
		]);
		expect(
			db
				.prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ?")
				.get(sessionId),
		).toMatchObject({ n: 1 });
	});

	it("registers /ctx-flush and materializes queued pending ops", async () => {
		const db = createDb();
		const tagId = insertTag(db, "ses-1", "msg-1", "message", 1234, 1);
		queuePendingOp(db, "ses-1", tagId, "drop");
		const { pi, handlers, sent } = createMockPi();

		registerCtxFlushCommand(pi as never, { db });
		await handlers.get("ctx-flush")?.("", createCtx());

		expect(sent[0]?.customType).toBe("ctx-status");
		expect(sent[0]?.data.text).toContain("Flushed 1 pending ops");
	});

	it("registers /ctx-dream and starts a run (Dreamer v2 manual path)", async () => {
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();
		const registrationCwds: string[] = [];

		registerCtxDreamCommand(pi as never, {
			db,
			projectDir: "/tmp/project",
			projectIdentity: "/tmp/project",
			registrationOwner: {},
			ensureRegistered: (ctx) => {
				registrationCwds.push(ctx.cwd);
			},
		});
		// Not registered with the dreamer timer in this unit test, so runManual
		// throws "not registered" → the handler reports the failure. We only
		// assert the command is wired and emits a /ctx-dream status message.
		// The injected registration sync runs immediately before runManual.
		await handlers.get("ctx-dream")?.("", createCtx());

		expect(registrationCwds).toEqual(["/tmp/project"]);
		expect(sent[0]?.customType).toBe("ctx-status");
		expect(sent[0]?.data.text).toContain("/ctx-dream");
	});

	it("/ctx-dream accepts split memory tasks and rejects retired task names", async () => {
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();

		registerCtxDreamCommand(pi as never, {
			db,
			projectDir: "/tmp/project",
			projectIdentity: "/tmp/project",
			registrationOwner: {},
		});

		await handlers.get("ctx-dream")?.("verify", createCtx());
		expect(sent[0]?.data.text).toContain('Running dream task "verify"');

		sent.length = 0;
		await handlers.get("ctx-dream")?.("curate", createCtx());
		expect(sent[0]?.data.text).toContain('Running dream task "curate"');

		for (const retired of [
			"maintain-memory",
			"consolidate",
			"improve",
			"archive-stale",
		]) {
			sent.length = 0;
			await handlers.get("ctx-dream")?.(retired, createCtx());
			expect(sent[0]?.data.text).toContain(`Unknown task "${retired}"`);
		}
	});

	it("/ctx-dream reports friendly disabled state without running", async () => {
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();

		registerCtxDreamCommand(pi as never, {
			db,
			projectDir: "/tmp/project",
			projectIdentity: "/tmp/project",
			registrationOwner: {},
			dreamerEnabled: false,
		});
		await handlers.get("ctx-dream")?.("", createCtx());

		expect(sent[0]?.data.text).toContain("Dreamer is disabled");
	});

	it("/ctx-dream resolves dreamer enablement from the invocation cwd", async () => {
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();

		registerCtxDreamCommand(pi as never, {
			db,
			projectDir: "/tmp/project-a",
			projectIdentity: "/tmp/project-a",
			registrationOwner: {},
			resolveProject: (ctx) => ({
				projectDir: ctx.cwd,
				projectIdentity: ctx.cwd,
			}),
			dreamerEnabled: false,
			resolveDreamerEnabled: (ctx) => ctx.cwd === "/tmp/project-b",
		});

		await handlers.get("ctx-dream")?.("", {
			...createCtx(),
			cwd: "/tmp/project-b",
		});

		expect(sent[0]?.data.text).toContain(
			"Starting dream run for /tmp/project-b",
		);
		expect(sent[0]?.data.text).not.toContain("Dreamer is disabled");
	});

	it("/ctx-status resolves project identity at command time", async () => {
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();
		registerCtxStatusCommand(pi as never, {
			db,
			projectIdentity: "/tmp/boot",
			resolveProject: (ctx) => ({
				projectDir: ctx.cwd,
				projectIdentity: "/tmp/current",
			}),
		});

		await handlers.get("ctx-status")?.("", createCtx());
		expect(sent[0]?.data.details).toMatchObject({
			projectIdentity: "/tmp/current",
		});
	});

	it("/ctx-status passes dreamer enabled field through details", async () => {
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();
		registerCtxStatusCommand(pi as never, {
			db,
			projectIdentity: "/tmp/project",
			dreamer: { runnable: true, scheduleSummary: "verify 0 3 * * *" },
		});

		await handlers.get("ctx-status")?.("", createCtx());
		expect(sent[0]?.data.details).toMatchObject({
			dreamer: {
				enabled: true,
				scheduleSummary: "verify 0 3 * * *",
			},
		});
	});

	it("registers /ctx-recomp and requires confirmation before running", async () => {
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();
		let runnerCalled = false;

		registerCtxRecompCommand(pi as never, {
			db,
			runner: {
				run: async () => {
					runnerCalled = true;
					return { ok: true, assistantText: "[]", cost: 0, durationMs: 1 };
				},
			},
			historianModel: "anthropic/claude",
			historianChunkTokens: 32_000,
			memoryEnabled: false,
			autoPromote: false,
		});
		await handlers.get("ctx-recomp")?.("", createCtx());

		expect(runnerCalled).toBe(false);
		expect(sent[0]?.customType).toBe("ctx-status");
		expect(sent[0]?.data.text).toContain("Confirmation Required");
	});

	it("/ctx-recomp resolves historian model from the invocation cwd", async () => {
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();

		registerCtxRecompCommand(pi as never, {
			db,
			runner: {
				run: async () => ({
					ok: true,
					assistantText: "[]",
					cost: 0,
					durationMs: 1,
				}),
			},
			historianModel: undefined,
			historianChunkTokens: 32_000,
			memoryEnabled: false,
			autoPromote: false,
			resolveRuntimeDeps: () => ({
				db,
				runner: {
					run: async () => ({
						ok: true,
						assistantText: "[]",
						cost: 0,
						durationMs: 1,
					}),
				},
				historianModel: "anthropic/claude-from-project-b",
				historianChunkTokens: 32_000,
				memoryEnabled: false,
				autoPromote: false,
			}),
		});

		await handlers.get("ctx-recomp")?.("", {
			...createCtx("ses-recomp-dynamic"),
			cwd: "/tmp/project-b",
		});

		expect(sent[0]?.data.text).toContain("Confirmation Required");
		expect(sent[0]?.data.text).not.toContain("historian.model");
	});

	it("/ctx-recomp --upgrade returns the deprecation hint instead of usage", async () => {
		const db = createDb();
		replaceAllCompartmentState(
			db,
			"ses-upgrade",
			[
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "legacy",
					content: "legacy content",
				},
			],
			[],
		);
		const { pi, handlers, sent } = createMockPi();

		registerCtxRecompCommand(pi as never, {
			db,
			runner: {
				run: async () => ({
					ok: true,
					assistantText: "[]",
					cost: 0,
					durationMs: 1,
				}),
			},
			historianModel: undefined,
			historianChunkTokens: 32_000,
			memoryEnabled: false,
			autoPromote: false,
		});

		await handlers.get("ctx-recomp")?.("--upgrade", createCtx("ses-upgrade"));

		expect(sent[0]?.data.text).toContain("Magic Recomp Upgrade");
		expect(sent[0]?.data.text).toContain(
			"The `--upgrade` flag is deprecated. Run `/ctx-session-upgrade` to upgrade this session.",
		);
		expect(sent[0]?.data.text).not.toContain("Invalid Arguments");
	});

	it("passes configured historian chunk budget into /ctx-recomp execution", async () => {
		const db = createDb();
		replaceAllCompartmentState(
			db,
			"ses-budget",
			[
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "old",
					content: "old",
				},
			],
			[],
		);
		const { pi, handlers } = createMockPi();
		let promptText = "";

		registerCtxRecompCommand(pi as never, {
			db,
			runner: {
				run: async (args) => {
					promptText = args.userMessage;
					return { ok: true, assistantText: "[]", cost: 0, durationMs: 1 };
				},
			},
			historianModel: "anthropic/claude",
			historianChunkTokens: 20,
			memoryEnabled: false,
			autoPromote: false,
		});

		const ctx = createCtx("ses-budget");
		const branch = ctx.sessionManager.getBranch?.() as Array<{
			message: { content: unknown };
		}>;
		const firstMessage = branch[0];
		if (!firstMessage) throw new Error("expected a first message fixture");
		firstMessage.message.content = `message 1 ${"word ".repeat(100)}`;
		ctx.sessionManager.getBranch = () => branch;
		// First call shows the confirmation warning; second call confirms and
		// spawns the DETACHED recomp. The recomp now runs in the background
		// (parity with OpenCode), so await the in-flight run before asserting
		// what prompt the historian actually received.
		await handlers.get("ctx-recomp")?.("", ctx);
		await handlers.get("ctx-recomp")?.("", ctx);
		await awaitInFlightRecomps();

		expect(promptText).toContain("[1] U: message 1");
		expect(promptText).not.toContain("[2] A: message 2");
	});

	it("control: a valid /ctx-recomp publishes and stages deferred effects", async () => {
		const sessionId = "ses-recomp-control";
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();
		registerCtxRecompCommand(pi as never, {
			db,
			runner: {
				run: async (args) => ({
					ok: true as const,
					assistantText: validCompartmentForPrompt(args.userMessage),
					cost: 0,
					durationMs: 1,
				}),
			},
			historianModel: "anthropic/claude",
			historianChunkTokens: 100_000,
			memoryEnabled: false,
			autoPromote: false,
		});

		const ctx = createCtx(sessionId);
		await handlers.get("ctx-recomp")?.("", ctx);
		await handlers.get("ctx-recomp")?.("", ctx);
		await awaitInFlightRecomps(sessionId);

		expect(getPendingPiCompactionMarkerState(db, sessionId)).not.toBeNull();
		expect(consumeDeferredHistoryRefresh(sessionId)).toBe(true);
		expect(consumeDeferredMaterialization(sessionId)).toBe(true);
		expect(
			sent.some((entry) => entry.data.text.includes("Magic Recomp — Complete")),
		).toBe(true);
	});

	it("fences /ctx-recomp side effects when an aborted runner settles late", async () => {
		const sessionId = "ses-recomp-late";
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();
		const runStarted = deferred();
		const releaseRun = deferred();
		let observedSignal: AbortSignal | undefined;
		let observedDirectory: string | undefined;
		registerCtxRecompCommand(pi as never, {
			db,
			runner: {
				run: async (args) => {
					observedSignal = args.signal;
					observedDirectory = args.cwd;
					runStarted.resolve();
					await releaseRun.promise;
					return {
						ok: true as const,
						assistantText: validCompartmentForPrompt(args.userMessage),
						cost: 0,
						durationMs: 1,
					};
				},
			},
			historianModel: "anthropic/claude",
			historianChunkTokens: 20,
			memoryEnabled: false,
			autoPromote: false,
		});

		const ctx = createCtx(sessionId);
		const contextProbe = probeLiveCommandContext(ctx);
		let branchReads = 0;
		const getBranch = ctx.sessionManager.getBranch;
		ctx.sessionManager.getBranch = () => {
			branchReads += 1;
			if (branchReads > 1) throw new Error("late session access");
			return getBranch?.() ?? [];
		};
		await handlers.get("ctx-recomp")?.("", ctx);
		await handlers.get("ctx-recomp")?.("", ctx);
		await runStarted.promise;
		const sentBeforeAbort = sent.length;

		abortInFlightRecomps(sessionId);
		contextProbe.endLifecycle();
		releaseRun.resolve();
		await awaitInFlightRecomps(sessionId);

		expect(observedSignal?.aborted).toBe(true);
		expect(observedDirectory).toBe("/tmp/project");
		expect(contextProbe.lateAccesses()).toBe(0);
		expect(branchReads).toBe(1);
		expect(sent).toHaveLength(sentBeforeAbort);
		expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
		expect(consumeDeferredHistoryRefresh(sessionId)).toBe(false);
		expect(consumeDeferredMaterialization(sessionId)).toBe(false);
	});

	it("fences /ctx-session-upgrade side effects when an aborted runner settles late", async () => {
		const sessionId = "ses-upgrade-late";
		const db = createDb();
		replaceAllCompartmentState(
			db,
			sessionId,
			[
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "legacy",
					content: "legacy content",
				},
			],
			[],
		);
		const { pi, handlers, sent } = createMockPi();
		const runStarted = deferred();
		const releaseRun = deferred();
		let observedSignal: AbortSignal | undefined;
		let observedDirectory: string | undefined;
		let runnerCalls = 0;

		registerCtxSessionUpgradeCommand(pi as never, {
			db,
			runner: {
				run: async (args) => {
					runnerCalls += 1;
					observedSignal = args.signal;
					observedDirectory = args.cwd;
					runStarted.resolve();
					await releaseRun.promise;
					return {
						ok: true as const,
						assistantText: validCompartmentForPrompt(args.userMessage),
						cost: 0,
						durationMs: 1,
					};
				},
			},
			historianModel: "anthropic/claude",
			historianChunkTokens: 20,
			memoryEnabled: true,
			autoPromote: false,
		});

		const ctx = createCtx(sessionId);
		const contextProbe = probeLiveCommandContext(ctx);
		let branchReads = 0;
		const getBranch = ctx.sessionManager.getBranch;
		ctx.sessionManager.getBranch = () => {
			branchReads += 1;
			if (branchReads > 1) throw new Error("late session access");
			return getBranch?.() ?? [];
		};
		await handlers.get("ctx-session-upgrade")?.("", ctx);
		await runStarted.promise;
		const sentBeforeAbort = sent.length;

		abortInFlightRecomps(sessionId);
		contextProbe.endLifecycle();
		releaseRun.resolve();
		await awaitInFlightRecomps(sessionId);

		expect(observedSignal?.aborted).toBe(true);
		expect(observedDirectory).toBe("/tmp/project");
		expect(contextProbe.lateAccesses()).toBe(0);
		expect(runnerCalls).toBe(1);
		expect(branchReads).toBe(1);
		expect(sent).toHaveLength(sentBeforeAbort);
		expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
		expect(consumeDeferredHistoryRefresh(sessionId)).toBe(false);
		expect(consumeDeferredMaterialization(sessionId)).toBe(false);
	});

	it("keeps migration-only upgrade state unchanged after a late cancelled result", async () => {
		const sessionId = "ses-upgrade-migration-late";
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();
		const ctx = createCtx(sessionId);
		const projectPath = resolveProjectIdentity(ctx.cwd);
		insertMemory(db, {
			projectPath,
			category: "ARCHITECTURE_DECISIONS",
			content: "Legacy migration fixture.",
		});
		const before = getMemoriesByProject(db, projectPath).map((memory) => ({
			id: memory.id,
			category: memory.category,
			content: memory.content,
		}));
		const runStarted = deferred();
		const releaseRun = deferred();
		let observedSignal: AbortSignal | undefined;
		registerCtxSessionUpgradeCommand(pi as never, {
			db,
			runner: {
				run: async (args) => {
					observedSignal = args.signal;
					runStarted.resolve();
					await releaseRun.promise;
					return {
						ok: true as const,
						assistantText: [
							"<migrated>",
							"<ARCHITECTURE>",
							"* Migrated replacement.",
							"</ARCHITECTURE>",
							"</migrated>",
						].join("\n"),
						cost: 0,
						durationMs: 1,
					};
				},
			},
			historianModel: "anthropic/claude",
			historianChunkTokens: 100_000,
			memoryEnabled: true,
			autoPromote: false,
		});
		const contextProbe = probeLiveCommandContext(ctx);
		let branchReads = 0;
		const getBranch = ctx.sessionManager.getBranch;
		ctx.sessionManager.getBranch = () => {
			branchReads += 1;
			if (branchReads > 1) throw new Error("late session access");
			return getBranch?.() ?? [];
		};

		await handlers.get("ctx-session-upgrade")?.("", ctx);
		await runStarted.promise;
		const sentBeforeAbort = sent.length;
		abortInFlightRecomps(sessionId);
		contextProbe.endLifecycle();
		releaseRun.resolve();
		await awaitInFlightRecomps(sessionId);

		expect(observedSignal?.aborted).toBe(true);
		expect(branchReads).toBe(1);
		expect(contextProbe.lateAccesses()).toBe(0);
		expect(sent).toHaveLength(sentBeforeAbort);
		expect(
			getMemoriesByProject(db, projectPath).map((memory) => ({
				id: memory.id,
				category: memory.category,
				content: memory.content,
			})),
		).toEqual(before);
		expect(isMemoryMigrationDone(db, projectPath)).toBe(false);
	});
});
