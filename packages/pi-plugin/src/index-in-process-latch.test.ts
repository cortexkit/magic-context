import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	appendCompartments,
	getCompartments,
} from "@magic-context/core/features/magic-context/compartment-storage";
import {
	clearSession,
	getOrCreateSessionMeta,
	getTagsBySession,
	insertTag,
	openDatabase,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	cleanupTestTempDir,
	createTestTempDir,
} from "@magic-context/core/shared/test-temp-dir";

import { awaitInFlightHistorians } from "./context-handler";
import { __test as dreamerTest } from "./dreamer";
import magicContextPiExtension, { __test } from "./index";
import { loadPiConfig } from "./config";
import { awaitInFlightRecomps, spawnPiRecompRun } from "./pi-recomp-runner";
import {
	MAGIC_CONTEXT_PI_SUBAGENT_ENV,
	PiSubagentRunner,
} from "./subagent-runner";
import {
	assistantMessage,
	fakeContext,
	textOf,
	userMessage,
} from "./test-utils.test";

const originalEnv = {
	MAGIC_CONTEXT_PI_SUBAGENT: process.env.MAGIC_CONTEXT_PI_SUBAGENT,
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

function restoreEnv() {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

const tempRoots: string[] = [];

function isolateXdgEnv(): string {
	const root = createTestTempDir("magic-context-pi-latch-test-").dir;
	tempRoots.push(root);
	const configHome = join(root, "config");
	process.env.XDG_CONFIG_HOME = configHome;
	// Use the preload's migration-safe test database; isolate only configuration.
	delete process.env.XDG_DATA_HOME;
	return configHome;
}

/**
 * Counting ExtensionAPI seam. Every ordinary registration method pushes the name onto
 * a list, so a test can assert that a child init registered NOTHING (no
 * duplicate tools, events, commands, timers, or watchers). The custom event
 * bus drives the in-process child lifecycle signal.
 */
function createCountingPi() {
	const events: string[] = [];
	const tools: string[] = [];
	let activeTools: string[] = [];
	const flags: string[] = [];
	const commands: string[] = [];
	const commandHandlers = new Map<
		string,
		(args: string, ctx: unknown) => unknown
	>();
	const entryRenderers: string[] = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const eventBusHandlers = new Map<string, Set<(data: unknown) => void>>();
	const piEventHandlers = new Map<
		string,
		Set<(event: unknown, ctx: unknown) => unknown>
	>();
	const pi = {
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				const handlers = eventBusHandlers.get(channel) ?? new Set();
				handlers.add(handler);
				eventBusHandlers.set(channel, handlers);
				return () => handlers.delete(handler);
			},
		},
		on: mock(
			(event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				events.push(event);
				const handlers = piEventHandlers.get(event) ?? new Set();
				handlers.add(handler);
				piEventHandlers.set(event, handlers);
			},
		),
		registerTool: mock((tool: { name?: string }) => {
			tools.push(tool.name ?? "<unnamed>");
			activeTools.push(tool.name ?? "<unnamed>");
		}),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		registerFlag: mock((name: string) => {
			flags.push(name);
		}),
		registerCommand: mock(
			(
				name: string,
				command: { handler: (args: string, ctx: unknown) => unknown },
			) => {
				commands.push(name);
				commandHandlers.set(name, command.handler);
			},
		),
		registerEntryRenderer: mock((customType: string) => {
			entryRenderers.push(customType);
		}),
		appendEntry: mock((customType: string, data: unknown) => {
			entries.push({ customType, data });
		}),
		sendMessage: mock(() => undefined),
		sendUserMessage: mock(() => undefined),
	} as unknown as ExtensionAPI;
	return {
		pi,
		events,
		tools,
		flags,
		commands,
		entryRenderers,
		entries,
		runCommand(name: string, args: string, ctx: unknown) {
			const handler = commandHandlers.get(name);
			if (!handler) throw new Error(`Command not registered: ${name}`);
			return handler(args, ctx);
		},
		eventBusHandlerCount(channel: string) {
			return eventBusHandlers.get(channel)?.size ?? 0;
		},
		piHandlerCount(event: string) {
			return piEventHandlers.get(event)?.size ?? 0;
		},
		emitEvent(channel: string, data: unknown = {}) {
			for (const handler of eventBusHandlers.get(channel) ?? []) handler(data);
		},
		async emitPiEvent(event: string, data: unknown = {}, ctx: unknown = {}) {
			let result: unknown;
			for (const handler of piEventHandlers.get(event) ?? []) {
				const next = await handler(data, ctx);
				if (next !== undefined) result = next;
			}
			return result;
		},
	};
}

function childContext(sessionId: string, messages = childMessages()) {
	return {
		...fakeContext(
			sessionId,
			process.cwd(),
			messages.map((_, i) => `entry-${i + 1}`),
			messages,
		),
		hasUI: false,
		model: {
			provider: "test",
			id: "model",
			contextWindow: 100_000,
			maxTokens: 4096,
		},
		ui: { notify: () => undefined, setStatus: () => undefined },
	};
}

function childMessages() {
	return [
		userMessage("raw covered request", 1),
		assistantMessage("raw covered answer", 2),
		userMessage("live child tail", 3),
	];
}

function seedChildHistory(sessionId: string) {
	const db = openDatabase();
	updateSessionMeta(db, sessionId, { isSubagent: true, piStableIdScheme: 1 });
	appendCompartments(db, sessionId, [
		{
			sequence: 0,
			startMessage: 1,
			endMessage: 2,
			startMessageId: "entry-1",
			endMessageId: "entry-2",
			title: "Stored child history",
			content: "U: Prior request\nA: Prior answer",
			p1: "U: Prior request\nA: Prior answer",
		},
	]);
	return db;
}

function writeChildConfig(
	configHome: string,
	historian: unknown,
	compaction = true,
	extraConfig: { fail_closed_blocking?: boolean } = {},
) {
	const configDir = join(configHome, "cortexkit");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "magic-context.jsonc"),
		JSON.stringify({
			historian,
			compaction: { enabled: compaction },
			...extraConfig,
		}),
	);
}

afterEach(() => {
	restoreEnv();
	for (const root of tempRoots.splice(0)) cleanupTestTempDir(root);
	// Exact child claims live on globalThis, so clear them between tests.
	__test.clearPiChildClaims();
	__test.clearPiStartupMaintenanceClaim();
	dreamerTest.reset();
});

describe("Pi in-process child guard (#247)", () => {
	it("claims process-wide startup maintenance from the full runtime", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const first = createCountingPi();
		const second = createCountingPi();
		await magicContextPiExtension(first.pi);
		expect(first.tools).toEqual([]);
		expect(__test.claimPiStartupMaintenance()).toBe(true);
		__test.clearPiStartupMaintenanceClaim();
		try {
			await first.emitPiEvent(
				"session_start",
				{},
				childContext("ses-primary-startup-maintenance-a"),
			);
			expect(__test.claimPiStartupMaintenance()).toBe(false);

			await magicContextPiExtension(second.pi);
			expect(second.tools).toEqual([]);
			await second.emitPiEvent(
				"session_start",
				{},
				childContext("ses-primary-startup-maintenance-b"),
			);
			expect(__test.claimPiStartupMaintenance()).toBe(false);
		} finally {
			await first.emitPiEvent(
				"session_shutdown",
				{},
				childContext("ses-primary-startup-maintenance-a"),
			);
			await second.emitPiEvent(
				"session_shutdown",
				{},
				childContext("ses-primary-startup-maintenance-b"),
			);
		}
	}, 15_000);
	it("registers independent sessions in the same process", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const first = createCountingPi();
		const second = createCountingPi();
		await magicContextPiExtension(first.pi);
		expect(first.tools).toEqual([]);
		try {
			await first.emitPiEvent(
				"session_start",
				{},
				childContext("ses-independent-primary-a"),
			);
			// Sanity: session activation registered the full runtime.
			expect(first.events.length).toBeGreaterThan(0);
			expect(first.tools).toContain("ctx_search");
			expect(first.commands).toContain("ctx-status");
			expect(first.entryRenderers).toEqual([
				"magic-context-turn-refused",
				"ctx-status",
			]);

			await magicContextPiExtension(second.pi);
			expect(second.tools).toEqual([]);
			await second.emitPiEvent(
				"session_start",
				{},
				childContext("ses-independent-primary-b"),
			);
			expect(second.events.length).toBeGreaterThan(0);
			expect(second.tools).toContain("ctx_search");
			expect(second.commands).toContain("ctx-status");
			expect(second.entryRenderers).toEqual([
				"magic-context-turn-refused",
				"ctx-status",
			]);
		} finally {
			await first.emitPiEvent(
				"session_shutdown",
				{},
				childContext("ses-independent-primary-a"),
			);
			await second.emitPiEvent(
				"session_shutdown",
				{},
				childContext("ses-independent-primary-b"),
			);
		}
	}, 15_000);

	for (const childShutdown of [false, true]) {
		it(`keeps session B historian and Dreamer live when ${childShutdown ? "its child" : "session A"} shuts down`, async () => {
			const liveSessionId = `ses-live-b-${childShutdown}`;
			const configHome = isolateXdgEnv();
			delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
			const configDir = join(configHome, "cortexkit");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(
				join(configDir, "magic-context.jsonc"),
				JSON.stringify({
					dreamer: { pi: { model: "test/dreamer" } },
					historian: {
						pi: { model: "test/historian" },
						subagent_reconciliation: true,
					},
					protected_tags: 1,
				}),
			);

			const scheduledClients: Array<{
				session: {
					create(args: unknown): Promise<unknown>;
					prompt(args: unknown): Promise<unknown>;
				};
			}> = [];
			const dreamerRun = mock(async () => ({
				ok: true as const,
				assistantText: "done",
				cost: 0,
				durationMs: 1,
			}));
			const historianRun = spyOn(
				PiSubagentRunner.prototype,
				"run",
			).mockImplementation(async (options) => {
				const prompt = (options as { userMessage?: string }).userMessage ?? "";
				const ordinals = [...prompt.matchAll(/^\[(\d+)\] [UAT]:/gm)].map(
					(match) => Number(match[1]),
				);
				const start = ordinals[0] ?? 1;
				const end = ordinals.at(-1) ?? start;
				return {
					ok: true,
					assistantText: `<compartment start="${start}" end="${end}" title="Live B"><p1>Session B remains live.</p1></compartment>`,
					cost: 0,
					durationMs: 1,
				} as never;
			});
			dreamerTest.setPiSubagentRunnerFactory(
				() => ({ run: dreamerRun }) as never,
			);
			dreamerTest.setStartDreamScheduleTimerFactory(async (registration) => {
				scheduledClients.push(registration.client as never);
				return mock(() => {});
			});

			const runtimeA = createCountingPi();
			const runtimeB = createCountingPi();
			const runtimeAId = `ses-runtime-a-${childShutdown}`;
			if (childShutdown) {
				await magicContextPiExtension(runtimeB.pi);
				await magicContextPiExtension(runtimeA.pi);
				await runtimeB.emitPiEvent(
					"session_start",
					{},
					childContext(liveSessionId),
				);
				runtimeB.emitEvent("subagents:child:session-created", {
					sessionId: runtimeAId,
					parentSessionId: liveSessionId,
				});
				await runtimeA.emitPiEvent(
					"session_start",
					{},
					childContext(runtimeAId),
				);
			} else {
				await magicContextPiExtension(runtimeA.pi);
				await magicContextPiExtension(runtimeB.pi);
				await runtimeA.emitPiEvent(
					"session_start",
					{},
					childContext(runtimeAId),
				);
				await runtimeB.emitPiEvent(
					"session_start",
					{},
					childContext(liveSessionId),
				);
			}
			await Promise.resolve();
			expect(scheduledClients).toHaveLength(1);

			const shutdownCtx = (sessionId: string) => ({
				sessionManager: { getSessionId: () => sessionId },
				ui: { setStatus: () => undefined },
			});
			const makeMessages = (count: number) =>
				Array.from({ length: count }, (_, index) => {
					const role = index % 2 === 0 ? "user" : "assistant";
					return {
						role,
						content: [
							{
								type: "text",
								text: `${role} message ${index + 1} ${"history detail ".repeat(200)}`,
							},
						],
						timestamp: Date.now() + index,
					};
				});
			const historianCtx = (
				messages: ReturnType<typeof makeMessages>,
				percent: number,
			) => ({
				cwd: process.cwd(),
				hasUI: false,
				model: {
					provider: "test",
					id: "model",
					contextWindow: 100_000,
					maxTokens: 4_096,
				},
				sessionManager: {
					getSessionId: () => liveSessionId,
					getBranch: () =>
						messages.map((message, index) => ({
							type: "message",
							id: `entry-${index + 1}`,
							message,
						})),
				},
				getContextUsage: () => ({
					tokens: Math.round(percent * 1_000),
					percent,
					contextWindow: 100_000,
				}),
				ui: { setStatus: () => undefined, notify: () => undefined },
			});

			try {
				expect(historianRun).not.toHaveBeenCalled();
				await runtimeA.emitPiEvent(
					"session_shutdown",
					{},
					shutdownCtx(runtimeAId),
				);
				await Promise.resolve();
				expect(scheduledClients).toHaveLength(childShutdown ? 1 : 2);

				const activeClient = scheduledClients[childShutdown ? 0 : 1];
				if (!activeClient) throw new Error("expected session B Dreamer client");
				const session = (await activeClient.session.create({})) as {
					id: string;
				};
				await activeClient.session.prompt({
					path: { id: session.id },
					body: { system: "system", parts: [{ text: "continue dreamer" }] },
				});
				expect(dreamerRun).toHaveBeenCalledTimes(1);

				const primeMessages = makeMessages(1);
				await runtimeB.emitPiEvent(
					"context",
					{ messages: primeMessages },
					historianCtx(primeMessages, 1),
				);
				const liveMessages = makeMessages(50);
				await runtimeB.emitPiEvent(
					"context",
					{ messages: liveMessages },
					historianCtx(liveMessages, 90),
				);
				await awaitInFlightHistorians(liveSessionId);
				expect(
					historianRun.mock.calls.some(
						([options]) =>
							(options as { model?: unknown }).model === "test/historian",
					),
				).toBe(true);
			} finally {
				historianRun.mockRestore();
				if (childShutdown)
					runtimeB.emitEvent("subagents:child:disposed", {
						sessionId: runtimeAId,
					});
				await runtimeB.emitPiEvent(
					"session_shutdown",
					{},
					shutdownCtx(liveSessionId),
				);
				clearSession(openDatabase(), liveSessionId);
			}
		}, 20_000);
	}

	it("Pi lifecycle adjudication: reversible switch and shutdown preserve durable session state", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		const runtime = createCountingPi();
		const sessionId = "ses-pi-reversible-lifecycle-pin";
		const db = openDatabase();
		try {
			await magicContextPiExtension(runtime.pi);
			await runtime.emitPiEvent("session_start", {}, childContext(sessionId));
			insertTag(db, sessionId, "m-1", "message", 100, 1);
			updateSessionMeta(db, sessionId, {
				lastContextPercentage: 61,
				lastInputTokens: 61_000,
			});
			const ctx = {
				sessionManager: { getSessionId: () => sessionId },
				ui: { setStatus: () => undefined },
			};

			await runtime.emitPiEvent("session_before_switch", {}, ctx);
			expect(getTagsBySession(db, sessionId)).toHaveLength(1);
			expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(
				61_000,
			);

			await runtime.emitPiEvent("session_shutdown", {}, ctx);
			expect(getTagsBySession(db, sessionId)).toHaveLength(1);
			expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(
				61_000,
			);
		} finally {
			clearSession(db, sessionId);
		}
	}, 15_000);

	it("unsubscribes child lifecycle listeners on session shutdown", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const runtime = createCountingPi();
		await magicContextPiExtension(runtime.pi);
		const sessionId = "ses-command-lifecycle";
		await runtime.emitPiEvent(
			"session_start",
			{},
			childContext("ses-child-listener-owner"),
		);
		expect(
			runtime.eventBusHandlerCount("subagents:child:session-created"),
		).toBe(1);
		expect(runtime.eventBusHandlerCount("subagents:child:disposed")).toBe(1);

		await runtime.emitPiEvent(
			"session_shutdown",
			{},
			{
				sessionManager: { getSessionId: () => "ses-child-listener-owner" },
				ui: { setStatus: () => undefined },
			},
		);
		expect(
			runtime.eventBusHandlerCount("subagents:child:session-created"),
		).toBe(0);
		expect(runtime.eventBusHandlerCount("subagents:child:disposed")).toBe(0);
	}, 15_000);

	it("fences a registered command's late RPC fallback on shutdown", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		const runtime = createCountingPi();
		await magicContextPiExtension(runtime.pi);
		const sessionId = "ses-command-lifecycle";

		let resolveCustom!: (value: undefined) => void;
		let notifications = 0;
		const ctx = {
			mode: "rpc",
			hasUI: false,
			cwd: process.cwd(),
			model: undefined,
			sessionManager: { getSessionId: () => sessionId },
			ui: {
				custom: () =>
					new Promise<undefined>((resolve) => {
						resolveCustom = resolve;
					}),
				notify: () => {
					notifications += 1;
				},
				setStatus: () => undefined,
			},
		};
		await runtime.emitPiEvent("session_start", {}, ctx);
		await runtime.runCommand("ctx-status", "", ctx);
		expect(resolveCustom).toBeDefined();

		await runtime.emitPiEvent("session_shutdown", {}, ctx);
		resolveCustom(undefined);
		await Promise.resolve();
		await Promise.resolve();
		expect(notifications).toBe(0);
	});

	it("aborts a recomp only after the five-second shutdown drain expires", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		const runtime = createCountingPi();
		await magicContextPiExtension(runtime.pi);
		await runtime.emitPiEvent(
			"session_start",
			{},
			childContext("ses-shutdown-timeout"),
		);

		let observedSignal: AbortSignal | undefined;
		let releaseRun!: () => void;
		const runGate = new Promise<void>((resolve) => {
			releaseRun = resolve;
		});
		spawnPiRecompRun({
			sessionId: "ses-shutdown-timeout",
			provider: { readMessages: () => [] },
			onStatusChange() {},
			work: async (signal) => {
				observedSignal = signal;
				await runGate;
			},
		});
		await Promise.resolve();

		const timers: Array<{
			active: boolean;
			callback: () => void;
			delay: number;
			handle: ReturnType<typeof setTimeout>;
		}> = [];
		const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: (...args: unknown[]) => void,
			delay?: number,
		) => {
			const timer = {
				active: true,
				callback: () => callback(),
				delay: delay ?? 0,
				handle: { unref() {} } as ReturnType<typeof setTimeout>,
			};
			timers.push(timer);
			return timer.handle;
		}) as typeof setTimeout);
		const clearTimeoutSpy = spyOn(
			globalThis,
			"clearTimeout",
		).mockImplementation(((handle: ReturnType<typeof setTimeout>) => {
			const timer = timers.find((candidate) => candidate.handle === handle);
			if (timer) timer.active = false;
		}) as typeof clearTimeout);

		try {
			const shutdown = runtime.emitPiEvent(
				"session_shutdown",
				{},
				{
					sessionManager: { getSessionId: () => "ses-shutdown-timeout" },
					ui: { setStatus: () => undefined },
				},
			);
			for (let attempt = 0; attempt < 20 && timers.length < 2; attempt += 1) {
				await Promise.resolve();
			}
			const timeout = timers.findLast((timer) => timer.active);
			expect(timeout?.delay).toBe(5_000);
			expect(observedSignal?.aborted).toBe(false);

			timeout?.callback();
			await shutdown;
			expect(observedSignal?.aborted).toBe(true);
		} finally {
			setTimeoutSpy.mockRestore();
			clearTimeoutSpy.mockRestore();
			releaseRun();
			await awaitInFlightRecomps("ses-shutdown-timeout");
		}
	}, 15_000);

	for (const reconciliation of [false, true]) {
		it(`keeps a claimed ${reconciliation ? "opted-in" : "default-false"} child isolated from an independent primary`, async () => {
			const configHome = isolateXdgEnv();
			delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
			writeChildConfig(configHome, {
				pi: { model: "test/historian" },
				subagent_reconciliation: reconciliation,
			});

			const parent = createCountingPi();
			const child = createCountingPi();
			const independent = createCountingPi();
			const parentId = `ses-ordinary-parent-${reconciliation}`;
			const childId = `ses-ordinary-child-${reconciliation}`;
			const independentId = `ses-ordinary-independent-${reconciliation}`;
			await magicContextPiExtension(parent.pi);
			await parent.emitPiEvent("session_start", {}, childContext(parentId));
			await magicContextPiExtension(child.pi);
			expect(child.tools).toEqual([]);
			parent.emitEvent("subagents:child:session-created", {
				sessionId: childId,
				parentSessionId: parentId,
			});
			await child.emitPiEvent("session_start", {}, childContext(childId));
			expect(getOrCreateSessionMeta(openDatabase(), childId).isSubagent).toBe(
				true,
			);
			if (reconciliation) expect(child.tools).toContain("ctx_search");
			else expect(child.tools).toEqual([]);
			await magicContextPiExtension(independent.pi);
			expect(independent.tools).toEqual([]);
			await independent.emitPiEvent(
				"session_start",
				{},
				childContext(independentId),
			);
			expect(independent.tools).toContain("ctx_search");
			expect(
				getOrCreateSessionMeta(openDatabase(), independentId).isSubagent,
			).toBe(false);
			await child.emitPiEvent("session_shutdown", {}, childContext(childId));
			parent.emitEvent("subagents:child:disposed", { sessionId: childId });
			await parent.emitPiEvent("session_shutdown", {}, childContext(parentId));
			await independent.emitPiEvent(
				"session_shutdown",
				{},
				childContext(independentId),
			);
			clearSession(openDatabase(), childId);
			clearSession(openDatabase(), parentId);
			clearSession(openDatabase(), independentId);
		}, 15_000);
	}

	it("initializes an opted-in child with session-local historian context and tools", async () => {
		const configHome = isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		writeChildConfig(configHome, {
			pi: { model: "test/historian" },
			subagent_reconciliation: true,
		});
		const parent = createCountingPi();
		const child = createCountingPi();
		const parentId = "ses-optin-parent";
		const childId = "ses-optin-child";
		await magicContextPiExtension(parent.pi);
		await parent.emitPiEvent("session_start", {}, childContext(parentId));
		__test.clearPiStartupMaintenanceClaim();
		await magicContextPiExtension(child.pi);
		expect(child.events).toEqual(["session_start"]);
		expect(child.tools).toEqual([]);
		parent.emitEvent("subagents:child:session-created", {
			sessionId: childId,
			parentSessionId: parentId,
		});
		await child.emitPiEvent("session_start", {}, childContext(childId));
		expect(child.events).toContain("context");
		expect(child.events).toContain("before_agent_start");
		expect(child.tools).toContain("ctx_search");
		expect(child.tools).toContain("ctx_expand");
		expect(getOrCreateSessionMeta(openDatabase(), childId).isSubagent).toBe(
			true,
		);
		expect(__test.claimPiStartupMaintenance()).toBe(true);
		parent.emitEvent("subagents:child:disposed", { sessionId: childId });
		await child.emitPiEvent("session_shutdown", {}, childContext(childId));
		await parent.emitPiEvent("session_shutdown", {}, childContext(parentId));
	}, 15_000);

	for (const compaction of [true, false]) {
		it(`renders opted-in child tags only when ctx_reduce is registered (compaction=${compaction})`, async () => {
			const configHome = isolateXdgEnv();
			delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
			writeChildConfig(
				configHome,
				{ pi: { model: "test/historian" }, subagent_reconciliation: true },
				compaction,
			);
			const parent = createCountingPi();
			const parentId = `ses-tags-parent-${compaction}`;
			await magicContextPiExtension(parent.pi);
			await parent.emitPiEvent("session_start", {}, childContext(parentId));
			const child = createCountingPi();
			const sessionId = `ses-child-tags-${compaction}`;
			try {
				await magicContextPiExtension(child.pi);
				expect(child.tools).toEqual([]);
				parent.emitEvent("subagents:child:session-created", {
					sessionId,
					parentSessionId: parentId,
				});
				const messages = childMessages();
				const ctx = childContext(sessionId, messages);
				await child.emitPiEvent("session_start", {}, ctx);
				expect(child.tools.includes("ctx_reduce")).toBe(compaction);
				const result = (await child.emitPiEvent(
					"context",
					{ messages },
					ctx,
				)) as { messages: typeof messages };
				expect(result).toBeDefined();
				expect(result.messages.map(textOf).join("\n")).toContain(
					"live child tail",
				);
				expect(/§\d+§/.test(result.messages.map(textOf).join("\n"))).toBe(
					compaction,
				);
				expect(
					getOrCreateSessionMeta(openDatabase(), sessionId).isSubagent,
				).toBe(true);
			} finally {
				await child.emitPiEvent(
					"session_shutdown",
					{},
					childContext(sessionId),
				);
				parent.emitEvent("subagents:child:disposed", { sessionId });
				await parent.emitPiEvent(
					"session_shutdown",
					{},
					childContext(parentId),
				);
				clearSession(openDatabase(), sessionId);
			}
		}, 15_000);
	}

	for (const mode of ["false", "removed"] as const) {
		it(`replays stored child coverage once with historian ${mode}, without new reconciliation`, async () => {
			const configHome = isolateXdgEnv();
			delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
			writeChildConfig(
				configHome,
				mode === "false"
					? { pi: { model: "test/historian" }, subagent_reconciliation: false }
					: undefined,
			);
			const parent = createCountingPi();
			const child = createCountingPi();
			const sessionId = `ses-child-replay-${mode}`;
			const parentId = `ses-replay-parent-${mode}`;
			const db = seedChildHistory(sessionId);
			const historianRun = spyOn(
				PiSubagentRunner.prototype,
				"run",
			).mockRejectedValue(
				new Error("render-only child must not spawn historian"),
			);
			try {
				await magicContextPiExtension(parent.pi);
				await parent.emitPiEvent("session_start", {}, childContext(parentId));
				await magicContextPiExtension(child.pi);
				expect(child.events).toEqual(["session_start"]);
				expect(child.tools).toEqual([]);
				parent.emitEvent("subagents:child:session-created", {
					sessionId,
					parentSessionId: parentId,
				});
				const ctx = childContext(sessionId);
				await Promise.all([
					child.emitPiEvent("session_start", {}, ctx),
					child.emitPiEvent("session_start", {}, ctx),
				]);
				const registrations = {
					events: [...child.events],
					tools: [...child.tools],
					commands: [...child.commands],
				};
				await child.emitPiEvent("session_start", {}, ctx);
				expect({
					events: child.events,
					tools: child.tools,
					commands: child.commands,
				}).toEqual(registrations);
				expect(
					child.events.filter((event) => event === "context"),
				).toHaveLength(1);
				expect(
					child.events.filter((event) => event === "before_agent_start"),
				).toHaveLength(1);
				expect(
					child.tools.filter((tool) => tool === "ctx_reduce"),
				).toHaveLength(1);
				for (const percent of [1, 90]) {
					const messages = childMessages();
					if (percent === 90) {
						// A substantial unreconciled tail under pressure makes the no-new-run
						// assertion meaningful, rather than relying on a three-message session.
						for (let i = 0; i < 48; i++) {
							const text = `Unreconciled tail ${i} ${"history detail ".repeat(200)}`;
							messages.push(
								i % 2 === 0
									? assistantMessage(text, i + 4)
									: userMessage(text, i + 4),
							);
						}
					}
					const result = (await child.emitPiEvent(
						"context",
						{ messages },
						{
							...childContext(sessionId, messages),
							getContextUsage: () => ({
								tokens: percent * 1000,
								percent,
								contextWindow: 100_000,
							}),
						},
					)) as { messages: typeof messages };
					expect(result).toBeDefined();
					const rendered = result.messages.map(textOf).join("\n");
					expect(rendered).toContain("Stored child history");
					expect(rendered).toContain("live child tail");
					expect(rendered).not.toContain("raw covered request");
					expect(rendered).not.toContain("raw covered answer");
					expect(rendered).toMatch(/§\d+§/);
				}
				await awaitInFlightHistorians(sessionId);
				expect(historianRun).not.toHaveBeenCalled();
				expect(getCompartments(db, sessionId)).toHaveLength(1);
				expect(getOrCreateSessionMeta(db, sessionId).isSubagent).toBe(true);
			} finally {
				await child.emitPiEvent(
					"session_shutdown",
					{},
					childContext(sessionId),
				);
				parent.emitEvent("subagents:child:disposed", { sessionId });
				await parent.emitPiEvent(
					"session_shutdown",
					{},
					childContext(parentId),
				);
				historianRun.mockRestore();
				clearSession(db, sessionId);
			}
		}, 15_000);
	}

	for (const [blocking, label] of [
		[true, "blocking"],
		[false, "fail-open"],
	] as const) {
		it(`keeps a late-fault partial pipeline inert and ${label} after ctx-status registration`, async () => {
			const configHome = isolateXdgEnv();
			delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
			writeChildConfig(
				configHome,
				{
					pi: { model: "test/historian" },
					subagent_reconciliation: true,
				},
				true,
				{ fail_closed_blocking: blocking },
			);
			expect(
				loadPiConfig({ cwd: process.cwd() }).config.fail_closed_blocking,
			).toBe(blocking);
			const parent = createCountingPi();
			const child = createCountingPi();
			const parentId = "ses-failure-parent";
			const sessionId = "ses-child-render-boot-failure";
			await magicContextPiExtension(parent.pi);
			await parent.emitPiEvent("session_start", {}, childContext(parentId));
			await magicContextPiExtension(child.pi);
			parent.emitEvent("subagents:child:session-created", {
				sessionId,
				parentSessionId: parentId,
			});
			const db = seedChildHistory(sessionId);
			const failure = new Error("late ctx-status registration failure");
			const register = spyOn(child.pi, "registerCommand").mockImplementation(
				(name) => {
					if (name === "ctx-status") throw failure;
				},
			);
			try {
				const results = await Promise.allSettled([
					child.emitPiEvent("session_start", {}, childContext(sessionId)),
					child.emitPiEvent("session_start", {}, childContext(sessionId)),
				]);
				expect(results).toEqual([
					{ status: "rejected", reason: failure },
					{ status: "rejected", reason: failure },
				]);
				await expect(
					child.emitPiEvent("session_start", {}, childContext(sessionId)),
				).rejects.toBe(failure);
				expect(register).toHaveBeenCalledTimes(1);
				// Only blocking adds a refusal handler. The partial pipeline is inert
				// under either policy because runtime activation never completed.
				expect(
					child.events.filter((event) => event === "context"),
				).toHaveLength(blocking ? 2 : 1);
				const messages = childMessages();
				let aborts = 0;
				const served = await child.emitPiEvent(
					"context",
					{ messages },
					{
						...childContext(sessionId, messages),
						abort: () => {
							aborts += 1;
						},
					},
				);
				if (blocking) {
					expect(aborts).toBe(1);
					expect(child.entries).toEqual([
						{
							customType: "magic-context-turn-refused",
							data: {
								message:
									"Magic Context could not safely prepare this turn; send your message again.",
							},
						},
					]);
					expect(served).toEqual({ messages });
				} else {
					expect(aborts).toBe(0);
					expect(child.entries).toEqual([]);
					expect(served).toBeUndefined();
				}
				expect(getTagsBySession(db, sessionId)).toHaveLength(0);
				await awaitInFlightHistorians(sessionId);
				expect(
					child.events.filter((event) => event === "context"),
				).toHaveLength(blocking ? 2 : 1);
			} finally {
				register.mockRestore();
				parent.emitEvent("subagents:child:disposed", { sessionId });
				await parent.emitPiEvent(
					"session_shutdown",
					{},
					childContext(parentId),
				);
				clearSession(db, sessionId);
			}
		}, 15_000);
	}

	for (const reconciliation of [false, true]) {
		it(`isolates four overlapping claimed children and an independent primary (reconciliation=${reconciliation})`, async () => {
			const configHome = isolateXdgEnv();
			delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
			writeChildConfig(configHome, {
				pi: { model: "test/historian" },
				subagent_reconciliation: reconciliation,
			});
			const db = openDatabase();
			const parent = createCountingPi();
			const independent = createCountingPi();
			const parentId = `ses-overlap-parent-${reconciliation}`;
			const independentId = `ses-overlap-independent-${reconciliation}`;
			const children = Array.from({ length: 4 }, () => createCountingPi());
			const ids = children.map(
				(_, i) => `ses-overlap-child-${reconciliation}-${i}`,
			);
			try {
				await magicContextPiExtension(parent.pi);
				await parent.emitPiEvent("session_start", {}, childContext(parentId));
				__test.clearPiStartupMaintenanceClaim();
				await Promise.all(
					children.map(async (child, i) => {
						await magicContextPiExtension(child.pi);
						expect(child.tools).toEqual([]);
						parent.emitEvent("subagents:child:session-created", {
							sessionId: ids[i],
							parentSessionId: parentId,
						});
						await child.emitPiEvent("session_start", {}, childContext(ids[i]));
						expect(getOrCreateSessionMeta(db, ids[i]).isSubagent).toBe(true);
						expect(child.tools.includes("ctx_search")).toBe(reconciliation);
					}),
				);
				expect(__test.claimPiStartupMaintenance()).toBe(true);
				__test.clearPiStartupMaintenanceClaim();
				await magicContextPiExtension(independent.pi);
				await independent.emitPiEvent(
					"session_start",
					{},
					childContext(independentId),
				);
				expect(independent.tools).toContain("ctx_search");
				expect(getOrCreateSessionMeta(db, independentId).isSubagent).toBe(
					false,
				);
			} finally {
				for (const [i, child] of children.entries()) {
					await child.emitPiEvent("session_shutdown", {}, childContext(ids[i]));
					parent.emitEvent("subagents:child:disposed", { sessionId: ids[i] });
					clearSession(db, ids[i]);
				}
				await parent.emitPiEvent(
					"session_shutdown",
					{},
					childContext(parentId),
				);
				await independent.emitPiEvent(
					"session_shutdown",
					{},
					childContext(independentId),
				);
				clearSession(db, parentId);
				clearSession(db, independentId);
			}
		}, 20_000);
	}

	it("retains sibling claims after one exact child disposes early", async () => {
		const configHome = isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		writeChildConfig(configHome, {
			pi: { model: "test/historian" },
			subagent_reconciliation: true,
		});
		const db = openDatabase();
		const parent = createCountingPi();
		const first = createCountingPi();
		const sibling = createCountingPi();
		try {
			await magicContextPiExtension(parent.pi);
			await parent.emitPiEvent("session_start", {}, childContext("parent"));
			await magicContextPiExtension(first.pi);
			await magicContextPiExtension(sibling.pi);
			parent.emitEvent("subagents:child:session-created", {
				sessionId: "first",
				parentSessionId: "parent",
			});
			parent.emitEvent("subagents:child:session-created", {
				sessionId: "sibling",
				parentSessionId: "parent",
			});
			await first.emitPiEvent("session_start", {}, childContext("first"));
			parent.emitEvent("subagents:child:disposed", { sessionId: "first" });
			await sibling.emitPiEvent("session_start", {}, childContext("sibling"));
			expect(getOrCreateSessionMeta(db, "sibling").isSubagent).toBe(true);
		} finally {
			for (const [id, child] of [
				["first", first],
				["sibling", sibling],
			] as const) {
				await child.emitPiEvent("session_shutdown", {}, childContext(id));
				parent.emitEvent("subagents:child:disposed", { sessionId: id });
				clearSession(db, id);
			}
			await parent.emitPiEvent("session_shutdown", {}, childContext("parent"));
			clearSession(db, "parent");
		}
	}, 20_000);

	it("keeps the spawned-child environment guard", async () => {
		const configHome = isolateXdgEnv();
		writeChildConfig(configHome, {
			pi: { model: "test/historian" },
			subagent_reconciliation: true,
		});
		process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV] = "1";

		const registrations = createCountingPi();
		await magicContextPiExtension(registrations.pi);

		expect(registrations.events).toEqual([]);
		expect(registrations.tools).toEqual([]);
		expect(registrations.flags).toEqual([]);
		expect(registrations.commands).toEqual([]);
		expect(registrations.entryRenderers).toEqual([]);
		// The env guard returns BEFORE registering lifecycle markers, so a later
		// independent init in the same process would still initialize fully.
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		const later = createCountingPi();
		await magicContextPiExtension(later.pi);
		expect(later.tools).toEqual([]);
		await later.emitPiEvent(
			"session_start",
			{},
			childContext("ses-env-unguarded"),
		);
		expect(later.tools).toContain("ctx_search");
	});

	it("treats an unclaimed activation as an independent primary", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const parent = createCountingPi();
		await magicContextPiExtension(parent.pi);
		await parent.emitPiEvent("session_start", {}, childContext("parent"));

		const child = createCountingPi();
		await magicContextPiExtension(child.pi);
		expect(child.tools).toEqual([]);
		await child.emitPiEvent("session_start", {}, childContext("unclaimed"));
		expect(child.tools).toContain("ctx_search");
		expect(child.commands).toContain("ctx-status");
		expect(getOrCreateSessionMeta(openDatabase(), "unclaimed").isSubagent).toBe(
			false,
		);
	}, 15_000);

	for (const reconciliation of [false, true]) {
		it(`routes an unclaimed stored child through child runtime without primary maintenance (reconciliation=${reconciliation})`, async () => {
			const configHome = isolateXdgEnv();
			writeChildConfig(configHome, {
				pi: { model: "test/historian" },
				subagent_reconciliation: reconciliation,
			});
			const sessionId = `ses-unclaimed-stored-${reconciliation}`;
			const db = seedChildHistory(sessionId);
			const runtime = createCountingPi();
			const historianRun = spyOn(
				PiSubagentRunner.prototype,
				"run",
			).mockRejectedValue(
				new Error("stored child replay must not start historian when disabled"),
			);
			try {
				await magicContextPiExtension(runtime.pi);
				await runtime.emitPiEvent("session_start", {}, childContext(sessionId));
				expect(getOrCreateSessionMeta(db, sessionId).isSubagent).toBe(true);
				expect(__test.claimPiStartupMaintenance()).toBe(true);
				__test.clearPiStartupMaintenanceClaim();
				if (!reconciliation) {
					const messages = childMessages();
					const result = (await runtime.emitPiEvent(
						"context",
						{ messages },
						childContext(sessionId, messages),
					)) as { messages: typeof messages };
					const rendered = result.messages.map(textOf).join("\n");
					expect(rendered).toContain("Stored child history");
					expect(rendered).not.toContain("raw covered request");
					expect(rendered).toContain("live child tail");
					await awaitInFlightHistorians(sessionId);
					expect(historianRun).not.toHaveBeenCalled();
				}
			} finally {
				historianRun.mockRestore();
				await runtime.emitPiEvent(
					"session_shutdown",
					{},
					childContext(sessionId),
				);
				clearSession(db, sessionId);
			}
		}, 15_000);
	}

	it("fails closed for a claimed child before parent resources are ready, then uses the live holder after reload", async () => {
		const configHome = isolateXdgEnv();
		writeChildConfig(configHome, {
			pi: { model: "test/historian" },
			subagent_reconciliation: true,
		});
		const db = openDatabase();
		const parent = createCountingPi();
		const unavailable = createCountingPi();
		const recovered = createCountingPi();
		const parentId = "ses-holder-parent";
		const childId = "ses-holder-child";
		const holder: {
			current?: ReturnType<typeof loadPiConfig> & {
				db: ReturnType<typeof openDatabase>;
				hasDeprecatedProtectedTags: boolean;
			};
		} = {};
		const policy = { blocking: true };
		const unregister = __test.registerPiChildClaims(
			parent.pi,
			holder as never,
			parentId,
			policy,
		);
		try {
			parent.emitEvent("subagents:child:session-created", {
				sessionId: childId,
				parentSessionId: parentId,
			});
			await magicContextPiExtension(unavailable.pi);
			await expect(
				unavailable.emitPiEvent("session_start", {}, childContext(childId)),
			).rejects.toThrow("Parent Magic Context runtime is unavailable");
			expect(unavailable.tools).toEqual([]);
			expect(unavailable.entries).toEqual([]);
			expect(unavailable.piHandlerCount("context")).toBe(1);
			const blocked = await unavailable.emitPiEvent(
				"context",
				{ messages: childMessages() },
				{ ...childContext(childId), abort: mock(() => undefined) },
			);
			expect(blocked).toEqual({ messages: expect.any(Array) });
			expect(unavailable.entries).toEqual([
				{
					customType: "magic-context-turn-refused",
					data: {
						message:
							"Magic Context could not safely prepare this turn; send your message again.",
					},
				},
			]);
			holder.current = {
				...loadPiConfig({ cwd: process.cwd() }),
				db,
				hasDeprecatedProtectedTags: false,
			};
			await magicContextPiExtension(recovered.pi);
			await recovered.emitPiEvent("session_start", {}, childContext(childId));
			expect(recovered.tools).toContain("ctx_search");
			expect(getOrCreateSessionMeta(db, childId).isSubagent).toBe(true);
		} finally {
			unregister();
			parent.emitEvent("subagents:child:disposed", { sessionId: childId });
			await unavailable.emitPiEvent(
				"session_shutdown",
				{},
				childContext(childId),
			);
			await recovered.emitPiEvent(
				"session_shutdown",
				{},
				childContext(childId),
			);
			clearSession(db, childId);
		}
	}, 15_000);
});
