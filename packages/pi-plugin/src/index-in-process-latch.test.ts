import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	acquireCompartmentLease,
	releaseCompartmentLease,
} from "@magic-context/core/features/magic-context/compartment-lease";
import {
	clearSession,
	getOrCreateSessionMeta,
	getTagsBySession,
	insertTag,
	openDatabase,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	clearProducerModelObservations,
	observeProducerModelsForTest,
} from "@magic-context/core/hooks/magic-context/producer-window-test-support";
import {
	cleanupTestTempDir,
	createTestTempDir,
} from "@magic-context/core/shared/test-temp-dir";

import {
	awaitInFlightHistorians,
	hasPendingMaterialization,
	signalPiPendingMaterialization,
} from "./context-handler";
import { __test as dreamerTest } from "./dreamer";
import magicContextPiExtension, { __test } from "./index";
import { awaitInFlightRecomps, spawnPiRecompRun } from "./pi-recomp-runner";
import {
	MAGIC_CONTEXT_PI_SUBAGENT_ENV,
	PiSubagentRunner,
} from "./subagent-runner";

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
	const flags: string[] = [];
	const commands: string[] = [];
	const commandHandlers = new Map<
		string,
		(args: string, ctx: unknown) => unknown
	>();
	const entryRenderers: string[] = [];
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
		}),
		getActiveTools: () => [],
		setActiveTools: () => {},
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
		appendEntry: mock(() => undefined),
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
		runCommand(name: string, args: string, ctx: unknown) {
			const handler = commandHandlers.get(name);
			if (!handler) throw new Error(`Command not registered: ${name}`);
			return handler(args, ctx);
		},
		eventBusHandlerCount(channel: string) {
			return eventBusHandlers.get(channel)?.size ?? 0;
		},
		emitEvent(channel: string, data: unknown = {}) {
			for (const handler of eventBusHandlers.get(channel) ?? []) handler(data);
		},
		async emitPiEvent(event: string, data: unknown = {}, ctx: unknown = {}) {
			const results: unknown[] = [];
			for (const handler of piEventHandlers.get(event) ?? []) {
				results.push(await handler(data, ctx));
			}
			return results;
		},
	};
}

afterEach(() => {
	restoreEnv();
	for (const root of tempRoots.splice(0)) cleanupTestTempDir(root);
	// The marker context lives on globalThis (process-global by design), so clear it
	// between tests or one test's child state could suppress the next.
	__test.clearPiInProcessSubagentInitContext();
	__test.clearPiStartupMaintenanceClaim();
	dreamerTest.reset();
});

describe("Pi in-process child guard (#247)", () => {
	it("claims process-wide startup maintenance from the full runtime", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const first = createCountingPi();
		await magicContextPiExtension(first.pi);
		expect(__test.claimPiStartupMaintenance()).toBe(false);

		const second = createCountingPi();
		await magicContextPiExtension(second.pi);
		expect(__test.claimPiStartupMaintenance()).toBe(false);
	}, 15_000);
	it("registers independent sessions in the same process", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const first = createCountingPi();
		await magicContextPiExtension(first.pi);
		// Sanity: the first init registered the full runtime.
		expect(first.events.length).toBeGreaterThan(0);
		expect(first.tools).toContain("ctx_search");
		expect(first.commands).toContain("ctx-status");
		expect(first.entryRenderers).toEqual([
			"magic-context-turn-refused",
			"ctx-status",
		]);

		const second = createCountingPi();
		await magicContextPiExtension(second.pi);
		expect(second.events.length).toBeGreaterThan(0);
		expect(second.tools).toContain("ctx_search");
		expect(second.commands).toContain("ctx-status");
		expect(second.entryRenderers).toEqual([
			"magic-context-turn-refused",
			"ctx-status",
		]);
	}, 15_000);

	it("headless Pi does not register scheduled dreamer children", async () => {
		const configHome = isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		const configDir = join(configHome, "cortexkit");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "magic-context.jsonc"),
			JSON.stringify({ dreamer: { pi: { model: "test/dreamer" } } }),
		);
		const scheduled = mock(async () => () => {});
		dreamerTest.setStartDreamScheduleTimerFactory(scheduled);
		const runtime = createCountingPi();
		await magicContextPiExtension(runtime.pi);
		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			sessionManager: { getSessionId: () => "ses-print" },
			ui: { setStatus() {} },
		};
		await runtime.emitPiEvent("session_start", {}, ctx);
		await runtime.emitPiEvent("before_agent_start", {}, ctx);
		expect(scheduled).not.toHaveBeenCalled();
		await runtime.emitPiEvent("session_shutdown", {}, ctx);
	}, 20_000);

	it("keeps session B historian and Dreamer live when session A shuts down", async () => {
		const configHome = isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		const configDir = join(configHome, "cortexkit");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "magic-context.jsonc"),
			JSON.stringify({
				dreamer: { pi: { model: "test/dreamer" } },
				historian: { pi: { model: "test/historian" } },
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
		await magicContextPiExtension(runtimeA.pi);
		await magicContextPiExtension(runtimeB.pi);
		const startCtx = {
			cwd: process.cwd(),
			hasUI: true,
			ui: { notify: () => undefined, setStatus: () => undefined },
			sessionManager: { getSessionId: () => "ses-live-b" },
		};
		await runtimeA.emitPiEvent("session_start", {}, startCtx);
		await runtimeB.emitPiEvent("session_start", {}, startCtx);
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
			hasUI: true,
			model: {
				provider: "test",
				id: "model",
				contextWindow: 100_000,
				maxTokens: 4_096,
			},
			sessionManager: {
				getSessionId: () => "ses-live-b",
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
				shutdownCtx("ses-retired-a"),
			);
			await Promise.resolve();
			expect(scheduledClients).toHaveLength(2);

			const activeClient = scheduledClients[1];
			if (!activeClient) throw new Error("expected session B Dreamer client");
			const session = (await activeClient.session.create({})) as { id: string };
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
			await awaitInFlightHistorians("ses-live-b");
			expect(
				historianRun.mock.calls.some(
					([options]) =>
						(options as { model?: unknown }).model === "test/historian",
				),
			).toBe(true);
		} finally {
			historianRun.mockRestore();
			await runtimeB.emitPiEvent(
				"session_shutdown",
				{},
				shutdownCtx("ses-live-b"),
			);
		}
	}, 20_000);

	it("shutdown terminates a real historian child and releases its compartment lease", async () => {
		const configHome = isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		const configDir = join(configHome, "cortexkit");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "magic-context.jsonc"),
			JSON.stringify({
				historian: { pi: { model: "test/historian" } },
				protected_tags: 1,
			}),
		);
		const sessionId = "ses-historian-shutdown-child";
		const db = openDatabase();
		let started!: (pid: number) => void;
		const childStarted = new Promise<number>((resolve) => {
			started = resolve;
		});
		let childPid = 0;
		let startTimeout: ReturnType<typeof setTimeout> | undefined;
		const children = new Set<ReturnType<typeof spawn>>();
		const historianRun = spyOn(
			PiSubagentRunner.prototype,
			"run",
		).mockImplementation(
			(options) =>
				new Promise((resolve) => {
					const child = spawn(
						process.execPath,
						["-e", "setInterval(() => {}, 1000)"],
						{ stdio: "ignore", windowsHide: true },
					);
					children.add(child);
					childPid = child.pid ?? 0;
					options.signal?.addEventListener(
						"abort",
						() => child.kill("SIGTERM"),
						{ once: true },
					);
					child.once("close", () => {
						children.delete(child);
						resolve({
							ok: false,
							reason: "abort",
							error: "shutdown",
							durationMs: 0,
						});
					});
					started(childPid);
				}) as never,
		);
		const runtime = createCountingPi();
		try {
			await magicContextPiExtension(runtime.pi);
			const makeMessages = (count: number) =>
				Array.from({ length: count }, (_, index) => {
					const role = index % 2 === 0 ? "user" : "assistant";
					return {
						role,
						content: [
							{
								type: "text",
								text: `${role} ${index} ${"history detail ".repeat(200)}`,
							},
						],
						timestamp: Date.now() + index,
					};
				});
			const context = (
				messages: ReturnType<typeof makeMessages>,
				percent: number,
			) => ({
				cwd: process.cwd(),
				hasUI: true,
				model: {
					provider: "test",
					id: "model",
					contextWindow: 100_000,
					maxTokens: 4096,
				},
				sessionManager: {
					getSessionId: () => sessionId,
					getBranch: () =>
						messages.map((message, index) => ({
							type: "message",
							id: `entry-${index + 1}`,
							message,
						})),
				},
				getContextUsage: () => ({
					tokens: Math.round(percent * 1000),
					percent,
					contextWindow: 100_000,
				}),
				ui: { setStatus() {}, notify() {} },
			});
			const prime = makeMessages(1);
			await runtime.emitPiEvent(
				"context",
				{ messages: prime },
				context(prime, 1),
			);
			const live = makeMessages(50);
			await runtime.emitPiEvent(
				"context",
				{ messages: live },
				context(live, 90),
			);
			const pid = await Promise.race([
				childStarted,
				new Promise<never>((_, reject) => {
					startTimeout = setTimeout(
						() => reject(new Error("historian did not start")),
						3000,
					);
				}),
			]);
			expect(pid).toBeGreaterThan(0);
			await runtime.emitPiEvent(
				"session_shutdown",
				{},
				{
					sessionManager: { getSessionId: () => sessionId },
					ui: { setStatus() {} },
				},
			);
			await awaitInFlightHistorians(sessionId);
			expect(() =>
				execFileSync("ps", ["-p", String(pid), "-o", "pid="], {
					windowsHide: true,
				}),
			).toThrow();
			expect(
				acquireCompartmentLease(db, sessionId, "next-process"),
			).not.toBeNull();
			releaseCompartmentLease(db, sessionId, "next-process");
		} finally {
			if (startTimeout) clearTimeout(startTimeout);
			for (const child of children) child.kill("SIGKILL");
			historianRun.mockRestore();
		}
	}, 20_000);

	it("Pi lifecycle adjudication: reversible switch and shutdown preserve durable session state", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		const runtime = createCountingPi();
		const sessionId = "ses-pi-reversible-lifecycle-pin";
		const db = openDatabase();
		try {
			await magicContextPiExtension(runtime.pi);
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

	it("keeps the current session's in-memory state when a switch does not happen", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		const runtime = createCountingPi();
		const sessionId = "ses-pi-cancelled-switch";
		const ctx = {
			sessionManager: { getSessionId: () => sessionId },
			ui: { setStatus: () => undefined },
		};
		await magicContextPiExtension(runtime.pi);
		signalPiPendingMaterialization(sessionId);

		// Pi emits session_before_switch before it commits: another extension
		// can cancel it, and opening the target can still fail (missing cwd).
		// Either way the user stays in this session and nothing else follows.
		await runtime.emitPiEvent("session_before_switch", {}, ctx);

		expect(hasPendingMaterialization(sessionId)).toBe(true);

		// A switch Pi carries out tears the outgoing session down with
		// session_shutdown, which drains the same state.
		await runtime.emitPiEvent("session_shutdown", {}, ctx);
		expect(hasPendingMaterialization(sessionId)).toBe(false);
	}, 15_000);

	it("drains the outgoing session once an OMP session_switch confirms it", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		const runtime = createCountingPi();
		const outgoing = "ses-omp-switch-outgoing";
		const incoming = "ses-omp-switch-incoming";
		let current = outgoing;
		const ctx = {
			sessionManager: { getSessionId: () => current },
			ui: { setStatus: () => undefined },
		};
		try {
			await magicContextPiExtension(runtime.pi);
			signalPiPendingMaterialization(outgoing);
			signalPiPendingMaterialization(incoming);

			// OMP keeps one extension runtime across a switch: no
			// session_shutdown, but a session_switch once it is done.
			await runtime.emitPiEvent("session_before_switch", {}, ctx);
			current = incoming;
			await runtime.emitPiEvent("session_switch", {}, ctx);

			expect(hasPendingMaterialization(outgoing)).toBe(false);
			expect(hasPendingMaterialization(incoming)).toBe(true);
		} finally {
			await runtime.emitPiEvent("session_shutdown", {}, ctx);
		}
	}, 15_000);

	it("unsubscribes child lifecycle listeners on session shutdown", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const runtime = createCountingPi();
		await magicContextPiExtension(runtime.pi);
		expect(
			runtime.eventBusHandlerCount("subagents:child:session-created"),
		).toBe(1);
		expect(runtime.eventBusHandlerCount("subagents:child:disposed")).toBe(1);

		await runtime.emitPiEvent(
			"session_shutdown",
			{},
			{
				sessionManager: { getSessionId: () => undefined },
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

		let resolveCustom!: (value: undefined) => void;
		let notifications = 0;
		const ctx = {
			mode: "rpc",
			hasUI: false,
			cwd: process.cwd(),
			model: undefined,
			sessionManager: { getSessionId: () => undefined },
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
		await runtime.runCommand("ctx-status", "", ctx);
		expect(resolveCustom).toBeDefined();

		await runtime.emitPiEvent("session_shutdown", {}, ctx);
		resolveCustom(undefined);
		await Promise.resolve();
		await Promise.resolve();
		expect(notifications).toBe(0);
	});

	it("aborts a recomp before waiting for the bounded shutdown drain", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		const runtime = createCountingPi();
		await magicContextPiExtension(runtime.pi);

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
			expect(observedSignal?.aborted).toBe(true);

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

	it("skips only the marked in-process child", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const parent = createCountingPi();
		await magicContextPiExtension(parent.pi);
		parent.emitEvent("subagents:child:spawning");
		parent.emitEvent("subagents:child:session-created");

		// Second init in the SAME process (the in-process child case).
		// It must register nothing — same contract as a spawned subagent.
		const child = createCountingPi();
		await magicContextPiExtension(child.pi);
		expect(child.events).toEqual([]);
		expect(child.tools).toEqual([]);
		expect(child.commands).toEqual([]);

		// Simulate the child dispose path clearing its lifecycle marker.
		parent.emitEvent("subagents:child:disposed");
		// A subsequent independent init re-registers the full runtime.
		const sibling = createCountingPi();
		await magicContextPiExtension(sibling.pi);
		expect(sibling.tools).toContain("ctx_search");
		expect(sibling.commands).toContain("ctx-status");
	}, 15_000);

	it("does not suppress an independent session while a child marker is active", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const parent = createCountingPi();
		await magicContextPiExtension(parent.pi);

		let childMarked!: () => void;
		const marked = new Promise<void>((resolve) => {
			childMarked = resolve;
		});
		let releaseChild!: () => void;
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		const child = createCountingPi();
		const childBranch = Promise.resolve().then(async () => {
			parent.emitEvent("subagents:child:session-created");
			await magicContextPiExtension(child.pi);
			childMarked();
			await release;
			parent.emitEvent("subagents:child:disposed");
		});

		await marked;
		try {
			expect(child.tools).toEqual([]);

			const independent = createCountingPi();
			await magicContextPiExtension(independent.pi);
			expect(independent.tools).toContain("ctx_search");
			expect(independent.commands).toContain("ctx-status");
		} finally {
			releaseChild();
			await childBranch;
		}
	}, 15_000);

	it("suppresses four overlapping child initializations without leaking ALS state", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const parent = createCountingPi();
		await magicContextPiExtension(parent.pi);
		__test.clearPiStartupMaintenanceClaim();

		const children = Array.from({ length: 4 }, () => createCountingPi());
		let markedCount = 0;
		let releaseBarrier!: () => void;
		const allMarked = new Promise<void>((resolve) => {
			releaseBarrier = resolve;
		});
		const branches = children.map((child) =>
			Promise.resolve().then(async () => {
				parent.emitEvent("subagents:child:session-created");
				markedCount += 1;
				if (markedCount === children.length) releaseBarrier();
				await allMarked;
				await magicContextPiExtension(child.pi);
				parent.emitEvent("subagents:child:disposed");
			}),
		);
		await allMarked;
		await Promise.all(branches);

		for (const child of children) {
			expect(child.events).toEqual([]);
			expect(child.tools).toEqual([]);
			expect(child.flags).toEqual([]);
			expect(child.commands).toEqual([]);
			expect(child.entryRenderers).toEqual([]);
			expect(
				child.eventBusHandlerCount("subagents:child:session-created"),
			).toBe(0);
			expect(child.eventBusHandlerCount("subagents:child:disposed")).toBe(0);
		}
		// Child entry must return before claiming process-wide startup maintenance.
		expect(__test.claimPiStartupMaintenance()).toBe(true);
		__test.clearPiStartupMaintenanceClaim();

		const independent = createCountingPi();
		await magicContextPiExtension(independent.pi);
		expect(independent.tools).toContain("ctx_search");
		expect(independent.commands).toContain("ctx-status");
		expect(independent.entryRenderers).toEqual([
			"magic-context-turn-refused",
			"ctx-status",
		]);
		expect(__test.claimPiStartupMaintenance()).toBe(false);
	}, 20_000);

	it("keeps sibling child markers isolated after one child disposes early", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const parent = createCountingPi();
		await magicContextPiExtension(parent.pi);
		__test.clearPiStartupMaintenanceClaim();
		const children = Array.from({ length: 4 }, () => createCountingPi());
		let markedCount = 0;
		let releaseBarrier!: () => void;
		const allMarked = new Promise<void>((resolve) => {
			releaseBarrier = resolve;
		});
		let firstDisposed!: () => void;
		const firstChildDisposed = new Promise<void>((resolve) => {
			firstDisposed = resolve;
		});

		const branches = children.map((child, index) =>
			Promise.resolve().then(async () => {
				parent.emitEvent("subagents:child:session-created");
				markedCount += 1;
				if (markedCount === children.length) releaseBarrier();
				await allMarked;
				if (index !== 0) await firstChildDisposed;
				await magicContextPiExtension(child.pi);
				parent.emitEvent("subagents:child:disposed");
				if (index === 0) firstDisposed();
			}),
		);
		await Promise.all(branches);

		for (const child of children) {
			expect(child.events).toEqual([]);
			expect(child.tools).toEqual([]);
			expect(child.flags).toEqual([]);
			expect(child.commands).toEqual([]);
			expect(child.entryRenderers).toEqual([]);
		}
		expect(__test.claimPiStartupMaintenance()).toBe(true);
		__test.clearPiStartupMaintenanceClaim();
	}, 20_000);

	it("keeps the spawned-child environment guard", async () => {
		isolateXdgEnv();
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
		expect(later.tools).toContain("ctx_search");
	});

	it("mutation direction: clearing the marker makes the child-init test fail", async () => {
		// This test documents the regression guard: if the marker check is
		// removed from the entry, a child init would register everything.
		// We simulate the marker being absent before the child init and assert
		// that it then registers the full runtime — proving the marker suppresses it.
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const parent = createCountingPi();
		await magicContextPiExtension(parent.pi);
		parent.emitEvent("subagents:child:session-created");

		// Simulate the marker being absent: clear it before the child init.
		__test.clearPiInProcessSubagentInitContext();

		const child = createCountingPi();
		await magicContextPiExtension(child.pi);

		// Without the marker suppressing it, the child init registers.
		expect(child.events.length).toBeGreaterThan(0);
		expect(child.tools.length).toBeGreaterThan(0);
		expect(child.commands.length).toBeGreaterThan(0);
	}, 15_000);
});

describe("Pi system-prompt section injection (#649)", () => {
	it("injects the guidance block as a structured section that composes with later extensions", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		const runtime = createCountingPi();
		await magicContextPiExtension(runtime.pi);

		// Register a second extension's handler AFTER magic-context, mirroring
		// Pi's in-order before_agent_start dispatch: a later extension writing
		// its own section into the same shared, mutable options map.
		runtime.pi.on("before_agent_start", (event) => {
			event.systemPromptOptions.sections.later_ext =
				"<later-ext>snapshot</later-ext>";
		});

		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			sessionManager: { getSessionId: () => "ses-section-injection" },
			ui: { setStatus() {} },
		};
		await runtime.emitPiEvent("session_start", {}, ctx);

		// Mirror Pi's BeforeAgentStartEvent: systemPromptOptions.sections is
		// the normalized, mutable map every extension's handler writes into.
		const event = {
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "BASE PROMPT",
			systemPromptOptions: { sections: {} as Record<string, string> },
		};
		await runtime.emitPiEvent("before_agent_start", event, ctx);

		// The guidance block must land in the shared sections map — not in a
		// forced prompt, which Pi would render INSTEAD of the sections and
		// thereby hide the later extension's section from the provider.
		expect(event.systemPromptOptions.sections.magic_context).toContain(
			"## Magic Context",
		);
		expect(event.systemPromptOptions.sections.later_ext).toBe(
			"<later-ext>snapshot</later-ext>",
		);

		await runtime.emitPiEvent("session_shutdown", {}, ctx);
	}, 20_000);

	it("keeps the forced-prompt fallback on hosts without a sections API (Oh My Pi)", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		const runtime = createCountingPi();
		await magicContextPiExtension(runtime.pi);
		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			sessionManager: { getSessionId: () => "ses-omp-fallback" },
			ui: { setStatus() {} },
		};
		await runtime.emitPiEvent("session_start", {}, ctx);

		// Oh My Pi's before_agent_start event has no systemPromptOptions
		// (verified on Oh My Pi 18.2.6 and 18.8.7): the handler must not throw
		// and must keep injecting via a forced prompt return, or requests
		// would go out with no guidance block at all.
		const event = {
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "BASE PROMPT",
		};
		const results = await runtime.emitPiEvent("before_agent_start", event, ctx);
		const forced = results.find(
			(r): r is { systemPrompt: string } =>
				typeof r === "object" && r !== null && "systemPrompt" in r,
		);
		expect(forced?.systemPrompt).toContain("BASE PROMPT");
		expect(forced?.systemPrompt).toContain("## Magic Context");

		await runtime.emitPiEvent("session_shutdown", {}, ctx);
	}, 20_000);
});

beforeEach(async () => {
	await observeProducerModelsForTest(["test/historian"]);
});
afterEach(clearProducerModelObservations);
