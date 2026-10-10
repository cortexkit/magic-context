import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import {
	clearSession,
	openDatabase,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { resetEmbeddingActivityForTests } from "@magic-context/core/shared/embedding-activity";
import * as loggerModule from "@magic-context/core/shared/logger";
import {
	cleanupTestTempDir,
	createTestTempDir,
} from "@magic-context/core/shared/test-temp-dir";
import { __test as dreamerTest } from "./dreamer";
import magicContextPiExtension, {
	__test,
	resetPiModelChainReportsForTest,
} from "./index";
import {
	findEmptyPiModelChains,
	formatEmptyPiModelChain,
	suggestRegisteredPiModel,
} from "./model-chain-health";
import { MAGIC_CONTEXT_PI_SUBAGENT_ENV } from "./subagent-runner";

// The registry an operator had: the antigravity-auth extension registers its
// provider as `google-antigravity`, and pi-ollama-cloud's catalog carries
// `deepseek-v4.1-flash` but not `deepseek-v4-flash:0731`.
const REGISTERED = [
	{ provider: "google-antigravity", id: "antigravity-gemini-3.8-flash" },
	{ provider: "google-antigravity", id: "antigravity-claude-opus-4-6" },
	{ provider: "ollama-cloud", id: "deepseek-v4.1-flash" },
	{ provider: "ollama-cloud", id: "qwen3.5-coder" },
	{ provider: "openai-codex", id: "gpt-6.1-sol" },
];

function registry(models = REGISTERED) {
	return {
		find: (provider: string, id: string) =>
			models.find((model) => model.provider === provider && model.id === id),
		getAll: () => models,
	};
}

const HISTORIAN_CHAIN = {
	model: "google/antigravity-gemini-3.8-flash",
	fallback_models: ["ollama-cloud/deepseek-v4-flash:0731"],
};

describe("suggestRegisteredPiModel", () => {
	it("finds the same model id under another provider", () => {
		expect(
			suggestRegisteredPiModel(
				"google/antigravity-gemini-3.8-flash",
				REGISTERED,
			),
		).toBe("google-antigravity/antigravity-gemini-3.8-flash");
	});

	it("finds a close model id within the same provider", () => {
		expect(
			suggestRegisteredPiModel(
				"ollama-cloud/deepseek-v4-flash:0731",
				REGISTERED,
			),
		).toBe("ollama-cloud/deepseek-v4.1-flash");
	});

	it("suggests nothing for an unrelated id", () => {
		expect(
			suggestRegisteredPiModel("ollama-cloud/llama-9-vision", REGISTERED),
		).toBeUndefined();
		expect(
			suggestRegisteredPiModel("nowhere/antigravity-gemini-9", REGISTERED),
		).toBeUndefined();
	});
});

describe("findEmptyPiModelChains", () => {
	const config = (dreamerTasks: Record<string, unknown>) =>
		({
			historian: { pi: HISTORIAN_CHAIN },
			dreamer: { pi: HISTORIAN_CHAIN, tasks: dreamerTasks },
			mural: {},
		}) as unknown as MagicContextConfig;

	it("names each dropped model with its closest registered match", () => {
		const empty = findEmptyPiModelChains({
			config: config({ curate: { schedule: "0 4 * * 0" } }),
			registry: registry(),
			harness: "pi",
		});
		expect(empty.map((chain) => chain.owner)).toEqual(["historian", "curate"]);
		expect(formatEmptyPiModelChain(empty[0])).toBe(
			"historian: google/antigravity-gemini-3.8-flash (did you mean google-antigravity/antigravity-gemini-3.8-flash?), ollama-cloud/deepseek-v4-flash:0731 (did you mean ollama-cloud/deepseek-v4.1-flash?)",
		);
	});

	it("leaves out dreamer tasks that cannot run (empty schedule)", () => {
		const empty = findEmptyPiModelChains({
			config: config({
				curate: { schedule: "0 4 * * 0" },
				verify: { schedule: "" },
				"map-memories": { schedule: "" },
			}),
			registry: registry(),
			harness: "pi",
		});
		expect(empty.map((chain) => chain.owner)).toEqual(["historian", "curate"]);
	});

	it("reports nothing once the chain names registered models", () => {
		expect(
			findEmptyPiModelChains({
				config: {
					historian: {
						pi: { model: "google-antigravity/antigravity-gemini-3.8-flash" },
					},
					dreamer: { disable: true },
					mural: {},
				} as unknown as MagicContextConfig,
				registry: registry(),
				harness: "pi",
			}),
		).toEqual([]);
	});
});

describe("Pi extension reports an empty historian chain at session start", () => {
	const originalEnv = {
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		MAGIC_CONTEXT_PI_SUBAGENT: process.env.MAGIC_CONTEXT_PI_SUBAGENT,
	};
	const roots: string[] = [];

	// Every runtime and context a test started a session on, so teardown can end
	// the session the way Pi does.
	const startedSessions: Array<{
		runtime: ReturnType<typeof createPi>;
		ctx: unknown;
	}> = [];

	afterEach(async () => {
		for (const { runtime, ctx } of startedSessions.splice(0)) {
			await runtime.emit("session_shutdown", ctx);
		}
		// Backstop: an agent turn left open marks the whole process busy, and
		// background embedding in later test files sharing the process stops.
		resetEmbeddingActivityForTests();
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		for (const root of roots.splice(0)) cleanupTestTempDir(root);
		__test.clearPiInProcessSubagentInitContext();
		__test.clearPiStartupMaintenanceClaim();
		dreamerTest.reset();
		resetPiModelChainReportsForTest();
		mock.restore();
	});

	function createPi() {
		const handlers = new Map<
			string,
			Array<(event: unknown, ctx: unknown) => unknown>
		>();
		const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
		const entries: Array<{ customType: string; data: { text?: string } }> = [];
		const pi = {
			events: { on: () => () => undefined },
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(event, [...(handlers.get(event) ?? []), handler]),
			registerTool: () => undefined,
			getActiveTools: () => [],
			setActiveTools: () => undefined,
			registerFlag: () => undefined,
			registerCommand: (
				name: string,
				command: { handler: (args: string, ctx: unknown) => unknown },
			) => commands.set(name, command.handler),
			registerEntryRenderer: () => undefined,
			appendEntry: (customType: string, data: { text?: string }) =>
				entries.push({ customType, data }),
			sendMessage: () => undefined,
			sendUserMessage: () => undefined,
		} as unknown as ExtensionAPI;
		const runtime = {
			pi,
			entries,
			async runCommand(name: string, ctx: unknown) {
				await commands.get(name)?.("", ctx);
			},
			async emit(event: string, ctx: unknown) {
				if (event === "session_start") startedSessions.push({ runtime, ctx });
				for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
			},
			/** One agent turn: Pi always follows agent_start with agent_end. */
			async agentTurn(ctx: unknown) {
				await runtime.emit("agent_start", ctx);
				await runtime.emit("agent_end", ctx);
			},
		};
		return runtime;
	}

	function isolatedConfig(config: unknown): string {
		const root = createTestTempDir("magic-context-pi-latch-test-").dir;
		roots.push(root);
		process.env.XDG_CONFIG_HOME = join(root, "config");
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		mkdirSync(join(root, "config", "cortexkit"), { recursive: true });
		writeFileSync(
			join(root, "config", "cortexkit", "magic-context.jsonc"),
			JSON.stringify(config),
		);
		return root;
	}

	// A second, independently configured project: Pi hands every session
	// context the operator's cwd, and the report machinery keys its reader and
	// deps caches on that directory, so a switch between projects needs a
	// distinct cwd -- and the project tier must sit under it, not under the
	// temp root.
	function projectCwd(root: string, name: string, config: unknown): string {
		const cwd = join(root, name);
		mkdirSync(join(cwd, ".cortexkit"), { recursive: true });
		writeFileSync(
			join(cwd, ".cortexkit", "magic-context.jsonc"),
			JSON.stringify(config),
		);
		return cwd;
	}

	// Only the historian trigger lines, so an assertion names what the report
	// decided instead of incidental boot logging.
	function triggerLines(logs: string[]): string[] {
		return logs.filter((line) =>
			line.includes("registered historian trigger"),
		);
	}

	// Yield until queued microtasks -- the settled refresh's re-check chain --
	// have run: setImmediate is the first macrotask after them.
	function macrotask(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		return promise;
	}

	it("/ctx-status lists only chains that can run, with suggestions and the inert drain latch", async () => {
		const root = isolatedConfig({
			historian: { pi: HISTORIAN_CHAIN },
			dreamer: {
				pi: HISTORIAN_CHAIN,
				tasks: {
					curate: { schedule: "0 4 * * 0" },
					verify: { schedule: "" },
					"map-memories": { schedule: "" },
				},
			},
		});
		dreamerTest.setStartDreamScheduleTimerFactory(async () => () => {});
		const sessionId = "ses-chain-status";
		const db = openDatabase();
		// Set 2026-09-26T21:21:47.897Z by a spike into the force band; the
		// historian that would read and clear it has not run since.
		updateSessionMeta(db, sessionId, {
			emergencyDrainActive: 1_790_457_707_897,
		});
		try {
			const runtime = createPi();
			await magicContextPiExtension(runtime.pi);
			const ctx = {
				cwd: root,
				hasUI: false,
				modelRegistry: registry(),
				model: { provider: "openai-codex", id: "gpt-6.1-sol" },
				sessionManager: {
					getSessionId: () => sessionId,
					getBranch: () => [],
				},
				getContextUsage: () => ({
					contextWindow: 500_000,
					tokens: 1_000,
					percent: 0.2,
				}),
				ui: { setStatus: () => undefined, notify: () => undefined },
			};
			await runtime.emit("session_start", ctx);
			await runtime.runCommand("ctx-status", ctx);

			const text = runtime.entries.map((entry) => entry.data.text).join("\n");
			expect(text).toContain("WARNING: Pi model chain empty (no model found):");
			expect(text).toContain(
				"historian: google/antigravity-gemini-3.8-flash (did you mean google-antigravity/antigravity-gemini-3.8-flash?)",
			);
			expect(text).toContain("curate: google/antigravity-gemini-3.8-flash");
			expect(text).not.toContain("verify:");
			expect(text).not.toContain("map-memories:");
			expect(text).toContain(
				"emergency drain latch set 2026-09-26T21:21:47.897Z has no effect while the historian cannot run",
			);
		} finally {
			clearSession(db, sessionId);
		}
	}, 20_000);

	it("notifies once per process and logs the validated historian chain", async () => {
		const root = isolatedConfig({
			historian: { pi: HISTORIAN_CHAIN },
			dreamer: { disable: true },
		});
		const logs: string[] = [];
		spyOn(loggerModule, "log").mockImplementation((message: unknown) => {
			logs.push(String(message));
		});
		dreamerTest.setStartDreamScheduleTimerFactory(async () => () => {});

		const runtime = createPi();
		await magicContextPiExtension(runtime.pi);
		const notify = mock((_message: string, _level?: string) => undefined);
		const ctx = {
			cwd: root,
			hasUI: true,
			modelRegistry: registry(),
			sessionManager: { getSessionId: () => "ses-chain" },
			ui: { notify, setStatus: () => undefined },
		};
		await runtime.emit("session_start", ctx);
		await runtime.emit("session_start", ctx);
		await runtime.agentTurn(ctx);

		expect(notify).toHaveBeenCalledTimes(1);
		const notice = String(notify.mock.calls[0]?.[0]);
		expect(notice).toContain("historian");
		expect(notice).toContain(
			"google/antigravity-gemini-3.8-flash (did you mean google-antigravity/antigravity-gemini-3.8-flash?)",
		);
		expect(notice).toContain(
			"ollama-cloud/deepseek-v4-flash:0731 (did you mean ollama-cloud/deepseek-v4.1-flash?)",
		);
		const historianLines = logs.filter((line) =>
			line.includes("registered historian trigger"),
		);
		expect(historianLines).toHaveLength(1);
		expect(historianLines[0]).toContain("DISABLED");
		expect(historianLines[0]).not.toContain(
			"(model=google/antigravity-gemini-3.8-flash",
		);

		// A config reload that keeps one registered fallback: the trigger line
		// names the model that will run, and nothing new is notified.
		writeFileSync(
			join(root, "config", "cortexkit", "magic-context.jsonc"),
			JSON.stringify({
				historian: {
					pi: {
						model: "google/antigravity-gemini-3.8-flash",
						fallback_models: [
							"google-antigravity/antigravity-gemini-3.8-flash",
						],
					},
				},
				dreamer: { disable: true },
			}),
		);
		await runtime.agentTurn(ctx);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(
			logs.some((line) =>
				line.includes(
					"registered historian trigger (model=google-antigravity/antigravity-gemini-3.8-flash,",
				),
			),
		).toBe(true);

		// A reload that breaks the chain differently is notified again.
		writeFileSync(
			join(root, "config", "cortexkit", "magic-context.jsonc"),
			JSON.stringify({
				historian: { pi: { model: "openai/gpt-6.1-sol" } },
				dreamer: { disable: true },
			}),
		);
		await runtime.agentTurn(ctx);
		expect(notify).toHaveBeenCalledTimes(2);
		expect(String(notify.mock.calls[1]?.[0])).toContain(
			"openai/gpt-6.1-sol (did you mean openai-codex/gpt-6.1-sol?)",
		);
	}, 20_000);

	it("waits for the host's discovery refresh before declaring the chain dead", async () => {
		// The OMP shape seen in the field: `litellm` is a dynamic-only extension
		// provider, so its models exist only after the boot-time
		// refreshInBackground() merge settles -- which nothing on the startup path
		// awaits -- and extension registerProvider calls are queued until after
		// extension loading. One synchronous find() there is a "not yet", not an
		// "absent"; reporting it as `registered historian trigger: DISABLED` told
		// operators their working historian config was broken.
		const root = isolatedConfig({
			historian: { pi: { model: "litellm/google/gemini-3.1-flash-lite" } },
			dreamer: { disable: true },
		});
		const logs: string[] = [];
		spyOn(loggerModule, "log").mockImplementation((message: unknown) => {
			logs.push(String(message));
		});
		dreamerTest.setStartDreamScheduleTimerFactory(async () => () => {});

		let hydrated = false;
		const hydratedModels = [
			{ provider: "litellm", id: "google/gemini-3.1-flash-lite" },
		];
		const lateRegistry = {
			find: (provider: string, id: string) =>
				(hydrated ? hydratedModels : []).find(
					(m) => m.provider === provider && m.id === id,
				),
			getAll: () => (hydrated ? hydratedModels : []),
			awaitBackgroundRefresh: async () => {
				hydrated = true;
			},
		};

		const runtime = createPi();
		await magicContextPiExtension(runtime.pi);
		const notify = mock((_message: string, _level?: string) => undefined);
		const ctx = {
			cwd: root,
			hasUI: true,
			modelRegistry: lateRegistry,
			sessionManager: { getSessionId: () => "ses-hydrating" },
			ui: { notify, setStatus: () => undefined },
		};
		await runtime.emit("session_start", ctx);
		const { promise: settled, resolve: resolveSettled } =
			Promise.withResolvers<void>();
		setImmediate(resolveSettled);
		await settled;

		// Exactly one trigger line, and it is the running one: a first pass that
		// announced DISABLED would leave a second element here.
		const historianLines = logs.filter((line) =>
			line.includes("registered historian trigger"),
		);
		expect(historianLines).toEqual([
			expect.stringContaining("(model=litellm/google/gemini-3.1-flash-lite"),
		]);
		expect(notify).toHaveBeenCalledTimes(0);
	}, 20_000);

	it("holds every report back while the discovery refresh is still pending", async () => {
		// The second-event bypass the fix removes: the settled marker used to be
		// set when the await was *scheduled*, so a session_start arriving
		// inside the refresh window skipped the wait and pinned
		// `registered historian trigger: DISABLED` for the process from a
		// catalogue that was still hydrating.
		const root = isolatedConfig({
			historian: { pi: { model: "litellm/google/gemini-3.1-flash-lite" } },
			dreamer: { disable: true },
		});
		const logs: string[] = [];
		spyOn(loggerModule, "log").mockImplementation((message: unknown) => {
			logs.push(String(message));
		});
		dreamerTest.setStartDreamScheduleTimerFactory(async () => () => {});

		let hydrated = false;
		let resolveRefresh!: () => void;
		const refreshing = new Promise<void>((resolve) => {
			resolveRefresh = resolve;
		});
		const lateRegistry = {
			find: (provider: string, id: string) =>
				(hydrated
					? [{ provider: "litellm", id: "google/gemini-3.1-flash-lite" }]
					: []
				).find((model) => model.provider === provider && model.id === id),
			getAll: () =>
				hydrated ? [{ provider: "litellm", id: "google/gemini-3.1-flash-lite" }] : [],
			awaitBackgroundRefresh: () => refreshing,
		};

		const runtime = createPi();
		await magicContextPiExtension(runtime.pi);
		const notify = mock((_message: string, _level?: string) => undefined);
		const ctx = {
			cwd: projectCwd(root, "repo-pending", { dreamer: { disable: true } }),
			hasUI: true,
			modelRegistry: lateRegistry,
			sessionManager: { getSessionId: () => "ses-pending" },
			ui: { notify, setStatus: () => undefined },
		};
		// First pass schedules the await; a second session_start and a turn
		// arrive while it is still in flight.
		await runtime.emit("session_start", ctx);
		await runtime.emit("session_start", ctx);
		await runtime.agentTurn(ctx);

		expect(triggerLines(logs)).toEqual([]);
		expect(notify).toHaveBeenCalledTimes(0);

		// The refresh settles: one report, from the settled catalogue.
		hydrated = true;
		resolveRefresh();
		await macrotask();

		expect(triggerLines(logs)).toEqual([
			expect.stringContaining("(model=litellm/google/gemini-3.1-flash-lite"),
		]);
		expect(notify).toHaveBeenCalledTimes(0);
	}, 20_000);

	it("re-checks the settled catalogue against current state after a session switch", async () => {
		// The stale replay the fix removes: the deferred report used to invoke
		// the session context captured when the wait was scheduled. After a
		// switch into another session that capture belongs to a dead session,
		// and re-reading its registry -- not the live catalogue -- reported
		// DISABLED for a model the running session can resolve.
		// One operator config: historian model selection is user-tier by
		// design (a repository cannot choose the historian's model), so both
		// sessions share it -- deliberately the same chain, so the live
		// session's healthy line and the settled re-check's line have equal
		// content and the log's line count is the discriminator: a replay of
		// the captured stale registry would add a DISABLED line, while a
		// deferred report that never fired would leave a single line.
		const root = isolatedConfig({
			historian: { pi: { model: "litellm/deepseek-v4-flash" } },
			dreamer: { disable: true },
		});
		const logs: string[] = [];
		spyOn(loggerModule, "log").mockImplementation((message: unknown) => {
			logs.push(String(message));
		});
		dreamerTest.setStartDreamScheduleTimerFactory(async () => () => {});

		let resolveRefresh!: () => void;
		const refreshing = new Promise<void>((resolve) => {
			resolveRefresh = resolve;
		});
		// The switched-away session's catalogue never gains the model.
		const stalledRegistry = {
			find: () => undefined,
			getAll: () => [],
			awaitBackgroundRefresh: () => refreshing,
		};

		const runtime = createPi();
		await magicContextPiExtension(runtime.pi);
		const staleNotify = mock(() => undefined);
		const staleCwd = projectCwd(root, "repo-stale", {
			dreamer: { disable: true },
		});
		await runtime.emit("session_start", {
			cwd: staleCwd,
			hasUI: true,
			modelRegistry: stalledRegistry,
			sessionManager: { getSessionId: () => "ses-stale" },
			ui: { notify: staleNotify, setStatus: () => undefined },
		});

		const liveNotify = mock(() => undefined);
		const liveCwd = projectCwd(root, "repo-live", { dreamer: { disable: true } });
		await runtime.emit("session_start", {
			cwd: liveCwd,
			hasUI: true,
			modelRegistry: registry([
				{ provider: "openai-codex", id: "gpt-6.1-sol" },
				{ provider: "litellm", id: "deepseek-v4-flash" },
			]),
			sessionManager: { getSessionId: () => "ses-live" },
			ui: { notify: liveNotify, setStatus: () => undefined },
		});

		resolveRefresh();
		await macrotask();

		// The switched-away project's settled re-check resolved the *current*
		// registry: its chain reports as running -- and with the live
		// session's line deduplicated by the once-per-process log, exactly
		// this one healthy line exists. No DISABLED line, and no warning ever
		// reached the captured stale session's ui.
		expect(triggerLines(logs)).toEqual([
			expect.stringContaining("(model=litellm/deepseek-v4-flash"),
		]);
		expect(staleNotify).toHaveBeenCalledTimes(0);
		expect(liveNotify).toHaveBeenCalledTimes(0);
	}, 20_000);

	it("leaves a replaced config's deferred report to the reload-aware path", async () => {
		// Config generation verification: the refresh was awaited for one
		// configuration, but the operator reloaded the file before it settled.
		// Replaying the scheduled pass after the wait would warn about chains
		// that no longer describe the config on disk; the generation gate owns
		// the new file, and the next agent turn gets the single report.
		const root = isolatedConfig({
			historian: { pi: { model: "litellm/google/gemini-3.1-flash-lite" } },
			dreamer: { disable: true },
		});
		const cwd = projectCwd(root, "repo-reload", { dreamer: { disable: true } });
		const logs: string[] = [];
		spyOn(loggerModule, "log").mockImplementation((message: unknown) => {
			logs.push(String(message));
		});
		dreamerTest.setStartDreamScheduleTimerFactory(async () => () => {});

		// Unhydrated while the refresh is pending, so the scheduled pass finds
		// the empty chain; the refresh settles the catalogue either way.
		let hydrated = false;
		let resolveRefresh!: () => void;
		const refreshing = new Promise<void>((resolve) => {
			resolveRefresh = () => {
				hydrated = true;
				resolve();
			};
		});
		const lateRegistry = {
			find: (provider: string, id: string) =>
				(hydrated
					? [
							{ provider: "litellm", id: "google/gemini-3.1-flash-lite" },
							{ provider: "litellm", id: "openai/gpt-4.1-mini" },
						]
					: []
				).find((model) => model.provider === provider && model.id === id),
			getAll: () =>
				hydrated
					? [
							{ provider: "litellm", id: "google/gemini-3.1-flash-lite" },
							{ provider: "litellm", id: "openai/gpt-4.1-mini" },
						]
					: [],
			awaitBackgroundRefresh: () => refreshing,
		};

		const runtime = createPi();
		await magicContextPiExtension(runtime.pi);
		const notify = mock((_message: string, _level?: string) => undefined);
		const ctx = {
			cwd,
			hasUI: true,
			modelRegistry: lateRegistry,
			sessionManager: { getSessionId: () => "ses-reloaded" },
			ui: { notify, setStatus: () => undefined },
		};
		await runtime.emit("session_start", ctx);

		// The operator's reload moves both tiers: poll() re-reads the effective
		// config from disk, and the generation the deferred report verifies
		// against must have visibly moved.
		writeFileSync(
			join(root, "config", "cortexkit", "magic-context.jsonc"),
			JSON.stringify({
				historian: { pi: { model: "litellm/openai/gpt-4.1-mini" } },
				dreamer: { disable: true },
			}),
		);
		writeFileSync(
			join(cwd, ".cortexkit", "magic-context.jsonc"),
			JSON.stringify({
				historian: { pi: { model: "litellm/openai/gpt-4.1-mini" } },
				dreamer: { disable: true },
			}),
		);

		resolveRefresh();
		await macrotask();

		// Nothing announced for the replaced configuration.
		expect(triggerLines(logs)).toEqual([]);
		expect(notify).toHaveBeenCalledTimes(0);

		// The reload-aware path (agent_start's generation gate) reports the
		// current file once.
		await runtime.agentTurn(ctx);
		expect(triggerLines(logs)).toEqual([
			expect.stringContaining("(model=litellm/openai/gpt-4.1-mini"),
		]);
		expect(notify).toHaveBeenCalledTimes(0);
	}, 20_000);
});
