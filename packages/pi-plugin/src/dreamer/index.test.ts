import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
	type DreamerConfig,
	DreamerConfigSchema,
} from "@magic-context/core/config/schema/magic-context";
import {
	acquireLease,
	releaseLease,
} from "@magic-context/core/features/magic-context/dreamer/lease";
import { getDreamRuns } from "@magic-context/core/features/magic-context/dreamer/storage-dream-runs";
import { getTaskScheduleState } from "@magic-context/core/features/magic-context/dreamer/storage-task-schedule";
import { leaseKeyFor } from "@magic-context/core/features/magic-context/dreamer/task-registry";
import { insertMemory } from "@magic-context/core/features/magic-context/memory";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import {
	closeDatabase,
	openDatabase,
} from "@magic-context/core/features/magic-context/storage";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getSubagentInvocations } from "@magic-context/core/features/magic-context/storage-subagent-invocations";
import * as logger from "@magic-context/core/shared/logger";
import { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { __setPiHarnessKindForTesting } from "../pi-harness-kind";
import { PiSubagentRunner } from "../subagent-runner";
import {
	__test,
	abortInFlightDreamers,
	awaitInFlightDreamers,
	registerPiDreamerProject,
	runPiDreamForProject,
	unregisterPiDreamerProject,
	validatePiDreamerModels,
} from ".";

let db: Database | null = null;

type CapturedDreamClient = {
	session: {
		create: (args: unknown) => Promise<unknown>;
		prompt: (args: unknown) => Promise<unknown>;
		messages: (args: unknown) => Promise<unknown>;
	};
};

function requireCapturedClient(
	client: CapturedDreamClient | null,
): CapturedDreamClient {
	expect(client).not.toBeNull();
	if (!client) throw new Error("dreamer client was not captured");
	return client;
}

function createDb(): Database {
	const database = new Database(":memory:");
	initializeDatabase(database);
	runMigrations(database);
	return database;
}

function enabledConfig() {
	return DreamerConfigSchema.parse({
		model: "test/model",
		tasks: { verify: { schedule: "0 3 * * *" } },
	});
}

function disabledConfig() {
	return DreamerConfigSchema.parse({ disable: true });
}

function dreamerOptions(args: {
	database: Database;
	projectIdentity: string;
	projectDir?: string;
	registrationOwner?: object;
	config?: DreamerConfig;
	harness?: "pi" | "omp";
	language?: string;
	onAdjunctsRefreshNeeded?: (projectIdentity: string) => void;
}) {
	return {
		db: args.database,
		projectDir:
			args.projectDir ??
			`/tmp/${args.projectIdentity.replace(/[^a-z0-9-]/gi, "-")}`,
		projectIdentity: args.projectIdentity,
		registrationOwner: args.registrationOwner ?? {},
		config: args.config ?? enabledConfig(),
		harness: args.harness ?? "pi",
		embeddingConfig: { provider: "off" as const },
		memoryEnabled: true,
		language: args.language,
		gitCommitIndexing: { enabled: false, since_days: 30, max_commits: 200 },
		onAdjunctsRefreshNeeded: args.onAdjunctsRefreshNeeded,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function createEventStreamChild() {
	const events = new EventEmitter();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const stdin = new PassThrough();
	return {
		pid: 42,
		stdin,
		stdout,
		stderr,
		killed: false,
		kill: mock(() => true),
		on: events.on.bind(events),
		once: events.once.bind(events),
		writeStdoutLine: (event: unknown) => {
			stdout.write(`${JSON.stringify(event)}\n`);
		},
		emitClose: () => {
			stdout.end();
			stderr.end();
			stdin.end();
			setTimeout(() => events.emit("close", 0, null), 0);
		},
	};
}

const CURATE_PSEUDO_TOOL_CALL = `归档与全局用户画像完全重复且无项目特化信息的记忆条目。[historical tool call]
id: call_2080315
name: ctx_memory
arguments:
{"action":"archive","reason":"与全局用户画像重复","ids":[6]}`;

afterEach(() => {
	__test.reset();
	if (db) {
		closeQuietly(db);
		db = null;
	}
});

describe("Pi dreamer wiring", () => {
	test("shutdown aborts an owner-bound dreamer child and ps finds no survivor", async () => {
		db = createDb();
		const owner = {};
		const identity = "git:pi-dream-shutdown-child";
		let client!: CapturedDreamClient;
		let pid = 0;
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			client = registration.client as CapturedDreamClient;
			return () => {};
		});
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: ({ signal }: { signal: AbortSignal }) =>
						new Promise((resolve) => {
							const child = spawn(
								process.execPath,
								["-e", "setInterval(() => {}, 1000)"],
								{ stdio: "ignore", windowsHide: true },
							);
							pid = child.pid ?? 0;
							signal.addEventListener("abort", () => child.kill("SIGTERM"), {
								once: true,
							});
							child.once("close", () =>
								resolve({ ok: false, reason: "abort", error: "cancelled" }),
							);
						}),
				}) as never,
		);
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectIdentity: identity,
				projectDir: process.cwd(),
				registrationOwner: owner,
				config: DreamerConfigSchema.parse({
					pi: { model: "test/model" },
					tasks: { curate: { schedule: "0 4 * * *" } },
				}),
			}),
		);
		await flushMicrotasks();
		const session = (await client.session.create({})) as { id: string };
		const prompt = client.session.prompt({
			path: { id: session.id },
			body: { parts: [{ text: "dream" }] },
		});
		await flushMicrotasks();
		expect(pid).toBeGreaterThan(0);
		abortInFlightDreamers(owner);
		await expect(prompt).rejects.toThrow("abort");
		await awaitInFlightDreamers(owner);
		expect(() =>
			execFileSync("ps", ["-p", String(pid), "-o", "pid="], {
				windowsHide: true,
			}),
		).toThrow();
	});
	test("manual dreamer uses the cap sampled for each child run", async () => {
		db = createDb();
		const identity = "git:pi-live-dreamer-cap";
		const owner = {};
		const caps: Array<number | undefined> = [];
		let liveCap = 4096;
		__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async (args: { maxOutputTokens?: number }) => {
						caps.push(args.maxOutputTokens);
						return { ok: true, assistantText: "curation complete" };
					}),
				}) as never,
		);
		const config = DreamerConfigSchema.parse({
			maxTokens: 2048,
			pi: { model: "test/model" },
			tasks: { curate: { schedule: "0 4 * * *" } },
		});
		insertMemory(db, {
			projectPath: identity,
			category: "PROJECT_RULES",
			content: "Keep run-local caps.",
		});
		registerPiDreamerProject({
			...dreamerOptions({
				database: db,
				projectIdentity: identity,
				projectDir: process.cwd(),
				registrationOwner: owner,
				config,
			}),
			sampleDreamRun: () => ({
				dreamerConfig: { ...config, maxTokens: liveCap },
			}),
		});
		await runPiDreamForProject(identity, "curate", owner);
		liveCap = 8192;
		await runPiDreamForProject(identity, "curate", owner);
		expect(caps).toEqual([4096, 8192]);
	});
	test("drops an unknown fallback with a warning while the valid primary runs", async () => {
		db = createDb();
		const identity = "git:pi-model-validation";
		const attempted: string[] = [];
		const warning = spyOn(logger, "log");
		__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async (args: { model: string }) => {
						attempted.push(args.model);
						return { ok: true, assistantText: "curation complete" };
					}),
				}) as never,
		);
		const registry = {
			find: (provider: string, model: string) =>
				provider === "test" && model === "model" ? {} : undefined,
		};
		const opts = dreamerOptions({
			database: db,
			projectIdentity: identity,
			projectDir: process.cwd(),
			config: {
				...DreamerConfigSchema.parse({
					tasks: { curate: { schedule: "0 4 * * *" } },
				}),
				pi: {
					model: "test/model",
					fallback_models: ["ollama-cloud/unknown-dreamer"],
				},
			} as never,
		});
		insertMemory(db, {
			projectPath: identity,
			category: "PROJECT_RULES",
			content: "Keep valid primary.",
		});
		try {
			registerPiDreamerProject({ ...opts, modelRegistry: registry });
			const result = await runPiDreamForProject(
				identity,
				"curate",
				opts.registrationOwner,
			);
			expect(result.failed).toEqual([]);
			expect(attempted).toEqual(["test/model"]);
			expect(
				warning.mock.calls.some(([message]) =>
					String(message).includes(
						"dropping Pi model not found: ollama-cloud/unknown-dreamer",
					),
				),
			).toBe(true);
		} finally {
			warning.mockRestore();
		}
	});

	test("defers OMP primary and fallback role validation to the host only", () => {
		const find = mock((provider: string, model: string) =>
			provider === "mock" && model === "known" ? {} : undefined,
		);
		const registry = { find };
		const task = {
			task: "classify-memories" as const,
			schedule: "",
			timeoutMinutes: 20,
			model: "@dreamer",
			fallbackModels: [
				{ model: "@cheap", qualifier: "low" },
				"mock/missing",
				"mock/known",
			],
		};
		expect(validatePiDreamerModels([task], registry, "omp")[0]).toMatchObject({
			model: "@dreamer",
			fallbackModels: [{ model: "@cheap", qualifier: "low" }, "mock/known"],
			modelChainUnavailable: false,
		});
		expect(find.mock.calls).toEqual([
			["mock", "missing"],
			["mock", "known"],
		]);
		expect(validatePiDreamerModels([task], registry, "pi")[0]).toMatchObject({
			model: "mock/known",
			fallbackModels: [],
		});
		expect(validatePiDreamerModels([task], registry, "omp")[0].model).toBe(
			"@dreamer",
		);
	});

	test("marks a chain with no Pi-resolvable models unavailable", () => {
		const tasks = validatePiDreamerModels(
			[
				{
					task: "classify-memories",
					schedule: "0 4 * * *",
					timeoutMinutes: 20,
					model: "ollama-cloud/unknown-dreamer",
				},
			],
			{ find: () => undefined },
		);
		expect(tasks[0].model).toBeUndefined();
		expect(tasks[0].modelChainUnavailable).toBe(true);
	});

	test("re-probes a model that becomes registered after an early miss", () => {
		// OMP queues a dynamic-only extension provider (`litellm`) during extension
		// loading and merges its catalogue in a fire-and-forget boot refresh, so a
		// miss at registration normally means "not hydrated yet". Caching the miss
		// kept the historian chain empty for the whole process even after the model
		// appeared -- observed in the field as `registered historian trigger:
		// DISABLED` in two of four OMP processes started within one minute.
		let hydrated = false;
		const registry = {
			find: (_provider: string, model: string) =>
				hydrated && model === "historian" ? {} : undefined,
		};
		const task = {
			task: "classify-memories" as const,
			schedule: "0 4 * * *",
			timeoutMinutes: 20,
			model: "litellm/historian",
		};
		expect(validatePiDreamerModels([task], registry)[0].model).toBeUndefined();
		hydrated = true;
		expect(validatePiDreamerModels([task], registry)[0]).toMatchObject({
			model: "litellm/historian",
			modelChainUnavailable: false,
		});
	});

	test("does not register the filesystem root or home for dreaming", () => {
		db = createDb();
		let starts = 0;
		__test.setStartDreamScheduleTimerFactory(async () => {
			starts++;
			return () => {};
		});
		for (const dir of ["/", homedir()])
			registerPiDreamerProject(
				dreamerOptions({
					database: db,
					projectIdentity: `dir:${dir}`,
					projectDir: dir,
				}),
			);
		expect(starts).toBe(0);
	});

	// A directory the identity resolver refuses (the home directory, or a folder
	// inside a dotfiles repository rooted at home) resolves to no identity. The
	// empty string must never become a dreamer project key: every task would run
	// against project "" and log "registered project " with a blank name.
	test("does not register a project with an empty identity", () => {
		db = createDb();
		const dir = createTestTempDirFromPath(
			join(tmpdir(), "mc-pi-dreamer-empty-identity-"),
		);
		try {
			let starts = 0;
			__test.setStartDreamScheduleTimerFactory(async () => {
				starts++;
				return () => {};
			});
			for (const projectIdentity of ["", "   "])
				registerPiDreamerProject(
					dreamerOptions({ database: db, projectIdentity, projectDir: dir }),
				);
			expect(starts).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("classifies a provider refusal surfaced by a Pi child runner", async () => {
		db = createDb();
		const projectIdentity = "git:pi-dreamer-provider-refusal";
		const providerText =
			"UnknownError: custody accounts exhausted: provider=synthetic accounts=main:cooldown";
		__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async () => ({
						ok: false,
						reason: "provider_error",
						error: providerText,
						transient: true,
					})),
				}) as never,
		);
		const opts = dreamerOptions({
			database: db,
			projectIdentity,
			config: DreamerConfigSchema.parse({
				model: "test/model",
				tasks: { curate: { schedule: "0 4 * * *" } },
			}),
		});
		insertMemory(db, {
			projectPath: projectIdentity,
			category: "PROJECT_RULES",
			content: "Keep this rule intact.",
		});
		registerPiDreamerProject(opts);

		await runPiDreamForProject(
			projectIdentity,
			"curate",
			opts.registrationOwner,
		);

		const run = getDreamRuns(db, projectIdentity)[0];
		const task = JSON.parse(run?.tasks_json ?? "[]")[0] as {
			failure?: { failure_class: string; provider_error: string | null };
		};
		expect(task.failure?.failure_class).toBe("provider_error");
		expect(task.failure?.provider_error).toContain(
			"custody accounts exhausted",
		);
	});
	test("disable=true config is a no-op", () => {
		db = createDb();

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: "/tmp/pi-project-disabled",
				projectIdentity: "git:pi-disabled",
				config: disabledConfig(),
			}),
		);

		expect(__test.registeredProjectCount()).toBe(0);
	});

	test("runnable config registers once for the same project", () => {
		db = createDb();
		const config = enabledConfig();
		const opts = dreamerOptions({
			database: db,
			projectDir: "/tmp/pi-project-enabled",
			projectIdentity: "git:pi-enabled",
			config,
		});

		registerPiDreamerProject(opts);
		registerPiDreamerProject(opts);

		expect(__test.registeredProjectCount()).toBe(1);
	});

	test("shares registrations across jiti-style module instances", async () => {
		db = createDb();
		let timerStarts = 0;
		__test.setStartDreamScheduleTimerFactory(async () => {
			timerStarts += 1;
			return mock(() => {});
		});
		const opts = dreamerOptions({
			database: db,
			projectDir: "/tmp/pi-shared-module",
			projectIdentity: "git:pi-shared-module",
		});
		registerPiDreamerProject(opts);
		await flushMicrotasks();

		const secondInstance = await import(
			`./index.ts?registry-instance=${Date.now()}`
		);
		secondInstance.__test.setStartDreamScheduleTimerFactory(async () => {
			timerStarts += 1;
			return mock(() => {});
		});
		secondInstance.registerPiDreamerProject({
			...opts,
			registrationOwner: {},
		});
		await flushMicrotasks();

		expect(timerStarts).toBe(1);
		expect(secondInstance.__test.registeredProjectCount()).toBe(1);
		secondInstance.__test.reset();
	});

	test("shares manual-run draining across jiti-style module instances", async () => {
		db = createDb();
		const gate = deferred<{ ok: true; assistantText: string }>();
		const runStarted = deferred<void>();
		__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(() => {
						runStarted.resolve();
						return gate.promise;
					}),
				}) as never,
		);
		const projectIdentity = "git:pi-shared-manual-drain";
		const ownerA = {};
		const ownerB = {};
		const config = DreamerConfigSchema.parse({
			model: "test/model",
			tasks: { curate: { schedule: "0 4 * * *" } },
		});
		insertMemory(db, {
			projectPath: projectIdentity,
			category: "PROJECT_RULES",
			content: "Keep reload-safe Dreamer lifecycle accounting process-shared.",
		});
		const opts = dreamerOptions({
			database: db,
			projectDir: process.cwd(),
			projectIdentity,
			registrationOwner: ownerA,
			config,
		});
		registerPiDreamerProject(opts);

		const secondInstance = await import(
			`./index.ts?manual-drain-instance=${Date.now()}`
		);
		secondInstance.registerPiDreamerProject({
			...opts,
			registrationOwner: ownerB,
		});
		const manualRun = secondInstance.runPiDreamForProject(
			projectIdentity,
			"curate",
			ownerB,
		);
		await runStarted.promise;
		let drained = false;
		const drain = secondInstance.awaitInFlightDreamers(ownerB).then(() => {
			drained = true;
		});
		await flushMicrotasks();
		expect(drained).toBe(false);

		gate.resolve({ ok: true, assistantText: "curation complete" });
		await manualRun;
		await drain;
		expect(drained).toBe(true);
		secondInstance.__test.reset();
	});

	test("threads resolved memory and embedding config into scheduled maintenance", async () => {
		db = createDb();
		let registration:
			| { memoryEnabled?: boolean; embeddingConfig?: { provider?: string } }
			| undefined;
		__test.setStartDreamScheduleTimerFactory(async (captured) => {
			registration = captured;
			return mock(() => {});
		});
		const opts = dreamerOptions({
			database: db,
			projectIdentity: "git:pi-maintenance-config",
		});

		registerPiDreamerProject({
			...opts,
			memoryEnabled: true,
			embeddingConfig: { provider: "local" },
		});
		await flushMicrotasks();

		expect(registration?.memoryEnabled).toBe(true);
		expect(registration?.embeddingConfig?.provider).toBe("local");
	});

	// Pi schedules through the plugin's dream timer, which stops scheduling and
	// deletes the schedule rows of a project whose `memory.enabled` is false. Pi
	// must pass that setting through, not leave it unset (which means enabled).
	test("threads a disabled project memory into scheduled maintenance", async () => {
		db = createDb();
		let registration: { memoryEnabled?: boolean } | undefined;
		__test.setStartDreamScheduleTimerFactory(async (captured) => {
			registration = captured;
			return mock(() => {});
		});
		const opts = dreamerOptions({
			database: db,
			projectIdentity: "git:pi-memory-disabled",
		});

		registerPiDreamerProject({ ...opts, memoryEnabled: false });
		await flushMicrotasks();

		expect(registration?.memoryEnabled).toBe(false);
	});

	test("threads OMP identity into scheduled dreamer model resolution", async () => {
		db = createDb();
		let harness: string | undefined;
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			harness = registration.harness;
			return mock(() => {});
		});

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectIdentity: "git:omp-model-resolution",
				harness: "omp",
				config: DreamerConfigSchema.parse({
					pi: { model: "pi/fallback" },
					omp: { model: "omp/selected" },
				}),
			}),
		);
		await flushMicrotasks();

		expect(harness).toBe("omp");
	});

	test("threads language into scheduled dreamer registration", async () => {
		db = createDb();
		let language: string | undefined;
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			language = (registration as { language?: string }).language;
			return mock(() => {});
		});

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectIdentity: "git:pi-language",
				language: "es",
			}),
		);
		await flushMicrotasks();

		expect(language).toBe("es");
	});

	test("manual dreamer uses refreshed options for its explicit owner", async () => {
		db = createDb();
		let capturedSystem = "";
		__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async (args: { systemPrompt?: string }) => {
						capturedSystem = args.systemPrompt ?? "";
						return { ok: true, assistantText: "done" };
					}),
				}) as never,
		);
		insertMemory(db, {
			projectPath: "git:pi-manual-language",
			category: "ARCHITECTURE",
			content: "The Pi harness runs dreamer prompts through a subprocess.",
		});

		const opts = dreamerOptions({
			database: db,
			projectDir: process.cwd(),
			projectIdentity: "git:pi-manual-language",
			config: DreamerConfigSchema.parse({
				model: "test/model",
				tasks: { curate: { schedule: "0 4 * * *" } },
			}),
			language: "en",
		});
		registerPiDreamerProject(opts);
		registerPiDreamerProject({ ...opts, language: "es" });

		const result = await runPiDreamForProject(
			"git:pi-manual-language",
			"curate",
			opts.registrationOwner,
		);
		expect(
			getTaskScheduleState(db, "git:pi-manual-language", "curate")?.lastError,
		).toBeNull();
		expect(result).toEqual({
			ran: ["curate"],
			skippedNoWork: [],
			deferredBusy: [],
			failed: [],
			failureDetails: [],
			details: ["curate: ARCHITECTURE (1)"],
			backlogBefore: {
				curate: { pending: 1, total: 1, category: "ARCHITECTURE" },
			},
			backlogAfter: {
				curate: { pending: 1, total: 1, category: "ARCHITECTURE" },
			},
		});

		expect(capturedSystem).toContain(
			"Write human-readable prose you author in: Spanish (Español).",
		);
	});

	test("rotates the shared curate category scope in Pi prompts", async () => {
		db = createDb();
		const projectIdentity = "git:pi-curate-rotation";
		const prompts: string[] = [];
		__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async (args: { userMessage?: string }) => {
						prompts.push(args.userMessage ?? "");
						return { ok: true, assistantText: "curation complete" };
					}),
				}) as never,
		);
		const projectRule = insertMemory(db, {
			projectPath: projectIdentity,
			category: "PROJECT_RULES",
			content: "Pi project rule scope fixture.",
		});
		const architecture = insertMemory(db, {
			projectPath: projectIdentity,
			category: "ARCHITECTURE",
			content: "Pi architecture scope fixture.",
		});
		for (const category of [
			"CONSTRAINTS",
			"CONFIG_VALUES",
			"NAMING",
		] as const) {
			insertMemory(db, {
				projectPath: projectIdentity,
				category,
				content: `Pi ${category} scope fixture.`,
			});
		}
		const opts = dreamerOptions({
			database: db,
			projectDir: process.cwd(),
			projectIdentity,
			config: DreamerConfigSchema.parse({
				model: "test/model",
				tasks: { curate: { schedule: "0 4 * * *" } },
			}),
		});
		registerPiDreamerProject(opts);

		await runPiDreamForProject(
			projectIdentity,
			"curate",
			opts.registrationOwner,
		);
		await runPiDreamForProject(
			projectIdentity,
			"curate",
			opts.registrationOwner,
		);

		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toContain("whole of the `PROJECT_RULES` category");
		expect(prompts[0]).toContain(`[${projectRule.id}] PROJECT_RULES`);
		expect(prompts[0]).not.toContain(`[${architecture.id}] ARCHITECTURE`);
		expect(prompts[1]).toContain("whole of the `ARCHITECTURE` category");
		expect(prompts[1]).toContain(`[${architecture.id}] ARCHITECTURE`);
		expect(prompts[1]).not.toContain(`[${projectRule.id}] PROJECT_RULES`);
	});

	test("persists an OMP 18.1.11 dreamer task stream with tokens and task label", async () => {
		const testDataDir = createTestTempDirFromPath(
			join(tmpdir(), "mc-pi-dreamer-accounting-"),
		);
		const previousTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
		const previousXdgDataHome = process.env.XDG_DATA_HOME;
		process.env.MAGIC_CONTEXT_TEST_DATA_DIR = testDataDir;
		process.env.XDG_DATA_HOME = testDataDir;
		closeDatabase();
		__setPiHarnessKindForTesting("omp");
		try {
			db = openDatabase();
			if (!db) throw new Error("dreamer accounting test database did not open");
			const child = createEventStreamChild();
			const spawned = deferred<void>();
			const runner = new PiSubagentRunner({
				invocation: { command: "omp", prefixArgs: [], targetHarness: "omp" },
				spawnImpl: mock(() => {
					spawned.resolve();
					return child as never;
				}) as never,
			});
			__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
			__test.setPiSubagentRunnerFactory(() => runner);
			const projectIdentity = "git:omp-dreamer-accounting";
			insertMemory(db, {
				projectPath: projectIdentity,
				category: "PROJECT_RULES",
				content: "Persist Pi dreamer token accounting once per task.",
			});
			const opts = dreamerOptions({
				database: db,
				projectDir: process.cwd(),
				projectIdentity,
				harness: "omp",
				config: {
					...DreamerConfigSchema.parse({
						tasks: { curate: { schedule: "0 4 * * *" } },
					}),
					omp: { model: "anthropic/claude-sonnet" },
				} as never,
			});
			registerPiDreamerProject(opts);

			const manualRun = runPiDreamForProject(
				projectIdentity,
				"curate",
				opts.registrationOwner,
			);
			await spawned.promise;
			child.writeStdoutLine({
				// OMP 18.1.11 reports provider usage on each message_end message.
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "curation complete" }],
					stopReason: "stop",
					usage: {
						input: 1_200,
						output: 80,
						cacheRead: 300,
						cacheWrite: 20,
					},
				},
			});
			child.emitClose();

			expect((await manualRun).ran).toEqual(["curate"]);
			const rows = getSubagentInvocations(db, projectIdentity);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				harness: "omp",
				subagent: "dreamer",
				task: "curate",
				providerId: "anthropic",
				modelId: "claude-sonnet",
				inputTokens: 1_200,
				outputTokens: 80,
				cacheReadTokens: 300,
				cacheWriteTokens: 20,
			});
		} finally {
			closeDatabase();
			__setPiHarnessKindForTesting(undefined);
			db = null;
			if (previousTestDataDir === undefined)
				delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
			else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = previousTestDataDir;
			if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = previousXdgDataHome;
			rmSync(testDataDir, { recursive: true, force: true });
		}
	});

	test("preserves completed ctx_memory results for a tool-only curate run", async () => {
		db = createDb();
		__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async () => ({
						ok: true,
						assistantText: "",
						toolCallCount: 1,
						completedToolCalls: [
							{
								name: "ctx_memory",
								arguments: { action: "archive" },
							},
						],
					})),
				}) as never,
		);
		insertMemory(db, {
			projectPath: "git:pi-curate-tool-only",
			category: "PROJECT_RULES",
			content: "Keep the memory pool concise.",
		});
		const opts = dreamerOptions({
			database: db,
			projectDir: process.cwd(),
			projectIdentity: "git:pi-curate-tool-only",
			config: DreamerConfigSchema.parse({
				model: "primary/curator",
				tasks: { curate: { schedule: "0 4 * * *" } },
			}),
		});
		registerPiDreamerProject(opts);

		const result = await runPiDreamForProject(
			"git:pi-curate-tool-only",
			"curate",
			opts.registrationOwner,
		);

		expect(result.failed).toEqual([]);
		expect(result.ran).toEqual(["curate"]);
		expect(result.details).toEqual([
			"curate: PROJECT_RULES (1); curate: 1 memory operation applied (archive)",
		]);
	});

	test("shared curate validation retries Pi pseudo-tool-call text with the fallback model", async () => {
		db = createDb();
		const attemptedModels: Array<string | undefined> = [];
		const attemptedThinkingLevels: Array<string | undefined> = [];
		__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(
						async (args: { model?: string; thinkingLevel?: string }) => {
							attemptedModels.push(args.model);
							attemptedThinkingLevels.push(args.thinkingLevel);
							return {
								ok: true,
								assistantText:
									attemptedModels.length === 1
										? CURATE_PSEUDO_TOOL_CALL
										: "curation complete",
							};
						},
					),
				}) as never,
		);
		insertMemory(db, {
			projectPath: "git:pi-curate-pseudo-tool-call",
			category: "PROJECT_RULES",
			content: "Use the shared release checklist before publishing.",
		});

		const opts = dreamerOptions({
			database: db,
			projectDir: process.cwd(),
			projectIdentity: "git:pi-curate-pseudo-tool-call",
			// Model resolution is harness-scoped: scheduling remains at
			// dreamer.tasks, while Pi's attempts live under dreamer.pi.
			config: {
				...DreamerConfigSchema.parse({
					tasks: { curate: { schedule: "0 4 * * *" } },
				}),
				pi: {
					model: { model: "primary/curator", thinking_level: "high" },
					tasks: {
						curate: {
							fallback_models: [
								{ model: "fallback/curator", thinking_level: "low" },
							],
						},
					},
				},
			} as never,
		});
		registerPiDreamerProject(opts);

		const result = await runPiDreamForProject(
			"git:pi-curate-pseudo-tool-call",
			"curate",
			opts.registrationOwner,
		);

		expect(attemptedModels).toEqual(["primary/curator", "fallback/curator"]);
		expect(attemptedThinkingLevels).toEqual(["high", "low"]);
		expect(result.failed).toEqual([]);
		expect(result.ran).toEqual(["curate"]);
	});

	test("re-registering the SAME dir is a no-op (keeps the first timer)", async () => {
		db = createDb();
		const timerCleanup = mock(() => {});
		__test.setStartDreamScheduleTimerFactory(async () => timerCleanup);

		const opts = dreamerOptions({
			database: db,
			projectDir: "/tmp/pi-samedir",
			projectIdentity: "git:pi-samedir",
		});
		registerPiDreamerProject(opts);
		await flushMicrotasks();
		registerPiDreamerProject(opts);
		await flushMicrotasks();

		expect(__test.registeredProjectCount()).toBe(1);
		// Same dir → no rebuild → original timer never cleaned up.
		expect(timerCleanup).not.toHaveBeenCalled();
	});

	test("legacy same-dir registration rebuilds once", async () => {
		db = createDb();
		const firstCleanup = mock(() => {});
		const secondCleanup = mock(() => {});
		const cleanups = [firstCleanup, secondCleanup];
		let timerStarts = 0;
		__test.setStartDreamScheduleTimerFactory(async () => {
			timerStarts += 1;
			return cleanups.shift() ?? mock(() => {});
		});
		const projectIdentity = "git:pi-legacy-registration";
		const opts = dreamerOptions({
			database: db,
			projectDir: "/tmp/pi-legacy",
			projectIdentity,
		});

		registerPiDreamerProject(opts);
		await flushMicrotasks();
		__test.clearRegistrationGeneration(projectIdentity);
		registerPiDreamerProject(opts);
		await flushMicrotasks();
		registerPiDreamerProject(opts);
		await flushMicrotasks();

		expect(timerStarts).toBe(2);
		expect(firstCleanup).toHaveBeenCalledTimes(1);
		expect(secondCleanup).not.toHaveBeenCalled();
	});

	test("one session shutdown keeps a same-project sibling registered", async () => {
		db = createDb();
		const firstCleanup = mock(() => {});
		const secondCleanup = mock(() => {});
		const cleanups = [firstCleanup, secondCleanup];
		__test.setStartDreamScheduleTimerFactory(
			async () => cleanups.shift() ?? mock(() => {}),
		);

		const firstOpts = dreamerOptions({
			database: db,
			projectDir: "/tmp/pi-shared-project",
			projectIdentity: "git:pi-shared-project",
		});
		const secondOpts = dreamerOptions({
			database: db,
			projectDir: "/tmp/pi-shared-project",
			projectIdentity: "git:pi-shared-project",
		});
		registerPiDreamerProject(firstOpts);
		await flushMicrotasks();
		registerPiDreamerProject(secondOpts);

		unregisterPiDreamerProject({
			projectIdentity: "git:pi-shared-project",
			registrationOwner: firstOpts.registrationOwner,
		});
		await flushMicrotasks();
		expect(__test.registeredProjectCount()).toBe(1);
		expect(firstCleanup).toHaveBeenCalledTimes(1);

		unregisterPiDreamerProject({
			projectIdentity: "git:pi-shared-project",
			registrationOwner: secondOpts.registrationOwner,
		});
		expect(__test.registeredProjectCount()).toBe(0);
		expect(secondCleanup).toHaveBeenCalledTimes(1);
	});

	test("re-registering the same identity with a DIFFERENT dir rebuilds (worktree switch)", async () => {
		db = createDb();
		const firstCleanup = mock(() => {});
		const secondCleanup = mock(() => {});
		const cleanups = [firstCleanup, secondCleanup];
		const dirs: string[] = [];
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			dirs.push((registration as { directory: string }).directory);
			return cleanups.shift() ?? mock(() => {});
		});

		// Worktree A of the same repo → identity X.
		const firstOpts = dreamerOptions({
			database: db,
			projectDir: "/tmp/worktree-A",
			projectIdentity: "git:pi-worktree",
		});
		registerPiDreamerProject(firstOpts);
		await flushMicrotasks();
		// Worktree B of the SAME repo (same identity, different dir).
		const secondOpts = dreamerOptions({
			database: db,
			projectDir: "/tmp/worktree-B",
			projectIdentity: "git:pi-worktree",
		});
		registerPiDreamerProject(secondOpts);
		await flushMicrotasks();

		// Still one registration, but rebuilt: first timer torn down, second
		// timer started against worktree B.
		expect(__test.registeredProjectCount()).toBe(1);
		expect(firstCleanup).toHaveBeenCalledTimes(1);
		expect(dirs).toEqual(["/tmp/worktree-A", "/tmp/worktree-B"]);

		// When the active worktree owner leaves, keep the sibling owner alive
		// and restore its registration instead of deleting the project timer.
		unregisterPiDreamerProject({
			projectIdentity: "git:pi-worktree",
			registrationOwner: secondOpts.registrationOwner,
		});
		await flushMicrotasks();
		expect(__test.registeredProjectCount()).toBe(1);
		expect(secondCleanup).toHaveBeenCalledTimes(1);
		expect(dirs).toEqual([
			"/tmp/worktree-A",
			"/tmp/worktree-B",
			"/tmp/worktree-A",
		]);
	});

	test("keeps only the final timer when A-B-A registrations start concurrently", async () => {
		db = createDb();
		const gates = [
			deferred<() => void>(),
			deferred<() => void>(),
			deferred<() => void>(),
		];
		const cleanups = [mock(() => {}), mock(() => {}), mock(() => {})];
		const clients: CapturedDreamClient[] = [];
		const timerRegistrations = new Map<string, number>();
		let timerIndex = 0;
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async () => ({ ok: true, assistantText: "done" })),
				}) as never,
		);
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			const index = timerIndex++;
			clients.push(registration.client as unknown as CapturedDreamClient);
			timerRegistrations.set(registration.directory, index);
			const cleanup = await (gates[index]?.promise ??
				Promise.resolve(mock(() => {})));
			return () => {
				cleanup();
				if (timerRegistrations.get(registration.directory) === index) {
					timerRegistrations.delete(registration.directory);
				}
			};
		});
		const projectIdentity = "git:pi-overlapping-handoff";
		const ownerA = {};
		const ownerB = {};
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: "/tmp/worktree-A",
				projectIdentity,
				registrationOwner: ownerA,
			}),
		);
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: "/tmp/worktree-B",
				projectIdentity,
				registrationOwner: ownerB,
			}),
		);
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: "/tmp/worktree-A",
				projectIdentity,
				registrationOwner: ownerA,
			}),
		);
		expect(timerIndex).toBe(3);

		gates[1]?.resolve(cleanups[1] as () => void);
		await flushMicrotasks();
		gates[0]?.resolve(cleanups[0] as () => void);
		await flushMicrotasks();
		gates[2]?.resolve(cleanups[2] as () => void);
		await flushMicrotasks();

		expect(cleanups[0]).toHaveBeenCalledTimes(1);
		expect(cleanups[1]).toHaveBeenCalledTimes(1);
		expect(cleanups[2]).not.toHaveBeenCalled();
		expect(timerRegistrations).toEqual(new Map([["/tmp/worktree-A", 2]]));
		await expect(clients[0]?.session.create({})).rejects.toThrow(
			"registration is no longer active",
		);
		await expect(clients[1]?.session.create({})).rejects.toThrow(
			"registration is no longer active",
		);
		const activeClient = requireCapturedClient(clients[2] ?? null);
		const session = (await activeClient.session.create({})) as { id: string };
		await activeClient.session.prompt({
			path: { id: session.id },
			body: { system: "system", parts: [{ text: "run dreamer" }] },
		});
	});

	test("stale sibling timer clients stay invalid across a worktree handoff", async () => {
		db = createDb();
		const clients: CapturedDreamClient[] = [];
		const run = mock(async () => ({
			ok: true as const,
			assistantText: "done",
		}));
		__test.setPiSubagentRunnerFactory(() => ({ run }) as never);
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			clients.push(registration.client as unknown as CapturedDreamClient);
			return mock(() => {});
		});
		const projectIdentity = "git:pi-stale-worktree-client";
		const ownerA = {};
		const ownerB = {};
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: "/tmp/worktree-A",
				projectIdentity,
				registrationOwner: ownerA,
			}),
		);
		await flushMicrotasks();
		const oldClient = requireCapturedClient(clients[0] ?? null);
		const created = (await oldClient.session.create({})) as { id: string };

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: "/tmp/worktree-B",
				projectIdentity,
				registrationOwner: ownerB,
			}),
		);
		await flushMicrotasks();
		await expect(oldClient.session.create({})).rejects.toThrow(
			"registration is no longer active",
		);
		await expect(
			oldClient.session.prompt({
				path: { id: created.id },
				body: { system: "system", parts: [{ text: "run dreamer" }] },
			}),
		).rejects.toThrow("registration is no longer active");

		unregisterPiDreamerProject({
			projectIdentity,
			registrationOwner: ownerB,
		});
		await flushMicrotasks();
		const replacementClient = requireCapturedClient(clients[2] ?? null);
		await expect(oldClient.session.create({})).rejects.toThrow(
			"registration is no longer active",
		);
		const replacementSession = (await replacementClient.session.create({})) as {
			id: string;
		};
		await replacementClient.session.prompt({
			path: { id: replacementSession.id },
			body: { system: "system", parts: [{ text: "run dreamer" }] },
		});
		expect(run).toHaveBeenCalledTimes(1);
	});

	test("discards a stale timer result that settles after a worktree handoff", async () => {
		db = createDb();
		const gate = deferred<{ ok: true; assistantText: string }>();
		const clients: CapturedDreamClient[] = [];
		const refresh = mock(() => {});
		__test.setPiSubagentRunnerFactory(
			() => ({ run: mock(() => gate.promise) }) as never,
		);
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			clients.push(registration.client as unknown as CapturedDreamClient);
			return mock(() => {});
		});
		const projectIdentity = "git:pi-late-stale-result";
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: "/tmp/worktree-A",
				projectIdentity,
				registrationOwner: {},
				onAdjunctsRefreshNeeded: refresh,
			}),
		);
		await flushMicrotasks();
		const oldClient = requireCapturedClient(clients[0] ?? null);
		const created = (await oldClient.session.create({})) as { id: string };
		const prompt = oldClient.session.prompt({
			path: { id: created.id },
			body: { system: "system", parts: [{ text: "run dreamer" }] },
		});
		await flushMicrotasks();

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: "/tmp/worktree-B",
				projectIdentity,
				registrationOwner: {},
			}),
		);
		await flushMicrotasks();
		gate.resolve({ ok: true, assistantText: "stale result" });

		await expect(prompt).rejects.toThrow("registration is no longer active");
		await expect(
			oldClient.session.messages({ path: { id: created.id } }),
		).rejects.toThrow("registration is no longer active");
		expect(refresh).not.toHaveBeenCalled();
	});

	test("active-owner handoff starts one timer when remaining worktree dirs repeat", async () => {
		db = createDb();
		const dirs: string[] = [];
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			dirs.push((registration as { directory: string }).directory);
			return mock(() => {});
		});

		const firstA = dreamerOptions({
			database: db,
			projectDir: "/tmp/worktree-A",
			projectIdentity: "git:pi-handoff",
		});
		const ownerB = dreamerOptions({
			database: db,
			projectDir: "/tmp/worktree-B",
			projectIdentity: "git:pi-handoff",
		});
		const secondA = dreamerOptions({
			database: db,
			projectDir: "/tmp/worktree-A",
			projectIdentity: "git:pi-handoff",
		});
		const activeC = dreamerOptions({
			database: db,
			projectDir: "/tmp/worktree-C",
			projectIdentity: "git:pi-handoff",
		});
		for (const owner of [firstA, ownerB, secondA, activeC]) {
			registerPiDreamerProject(owner);
			await flushMicrotasks();
		}

		unregisterPiDreamerProject({
			projectIdentity: "git:pi-handoff",
			registrationOwner: activeC.registrationOwner,
		});
		await flushMicrotasks();
		expect(dirs).toEqual([
			"/tmp/worktree-A",
			"/tmp/worktree-B",
			"/tmp/worktree-A",
			"/tmp/worktree-C",
			"/tmp/worktree-A",
		]);

		unregisterPiDreamerProject({
			projectIdentity: "git:pi-handoff",
			registrationOwner: secondA.registrationOwner,
		});
		await flushMicrotasks();
		unregisterPiDreamerProject({
			projectIdentity: "git:pi-handoff",
			registrationOwner: ownerB.registrationOwner,
		});
		await flushMicrotasks();
		expect(dirs.slice(-2)).toEqual(["/tmp/worktree-B", "/tmp/worktree-A"]);

		unregisterPiDreamerProject({
			projectIdentity: "git:pi-handoff",
			registrationOwner: firstA.registrationOwner,
		});
		expect(__test.registeredProjectCount()).toBe(0);
	});

	test("re-registration refreshes owner recency before active-owner handoff", async () => {
		db = createDb();
		const dirs: string[] = [];
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			dirs.push((registration as { directory: string }).directory);
			return mock(() => {});
		});

		const ownerA = {};
		const firstA = dreamerOptions({
			database: db,
			projectDir: "/tmp/worktree-A",
			projectIdentity: "git:pi-owner-recency",
			registrationOwner: ownerA,
		});
		const ownerB = dreamerOptions({
			database: db,
			projectDir: "/tmp/worktree-B",
			projectIdentity: "git:pi-owner-recency",
		});
		const refreshedA = dreamerOptions({
			database: db,
			projectDir: "/tmp/worktree-A",
			projectIdentity: "git:pi-owner-recency",
			registrationOwner: ownerA,
		});
		const activeC = dreamerOptions({
			database: db,
			projectDir: "/tmp/worktree-C",
			projectIdentity: "git:pi-owner-recency",
		});
		for (const owner of [firstA, ownerB, refreshedA, activeC]) {
			registerPiDreamerProject(owner);
			await flushMicrotasks();
		}

		unregisterPiDreamerProject({
			projectIdentity: "git:pi-owner-recency",
			registrationOwner: activeC.registrationOwner,
		});
		await flushMicrotasks();

		expect(dirs).toEqual([
			"/tmp/worktree-A",
			"/tmp/worktree-B",
			"/tmp/worktree-A",
			"/tmp/worktree-C",
			"/tmp/worktree-A",
		]);
	});

	test("rejects ownerless and unregistered-owner manual runs", async () => {
		db = createDb();
		__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
		const projectIdentity = "git:pi-stale-manual-owner";
		const ownerA = dreamerOptions({
			database: db,
			projectDir: "/tmp/worktree-A",
			projectIdentity,
		});
		const ownerB = dreamerOptions({
			database: db,
			projectDir: "/tmp/worktree-B",
			projectIdentity,
		});
		registerPiDreamerProject(ownerA);
		await flushMicrotasks();
		registerPiDreamerProject(ownerB);
		await flushMicrotasks();
		__test.setPiSubagentRunnerFactory(() => {
			throw new Error("manual client should not be created");
		});

		await expect(
			runPiDreamForProject(projectIdentity, undefined, undefined as never),
		).rejects.toThrow(
			`Pi dreamer registration owner is no longer active for project ${projectIdentity}`,
		);

		unregisterPiDreamerProject({
			projectIdentity,
			registrationOwner: ownerA.registrationOwner,
		});
		await expect(
			runPiDreamForProject(
				projectIdentity,
				undefined,
				ownerA.registrationOwner,
			),
		).rejects.toThrow(
			`Pi dreamer registration owner is no longer active for project ${projectIdentity}`,
		);
	});

	test("owner drain covers a lease wait and stale owner cannot start a prompt", async () => {
		db = createDb();
		__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
		const run = mock(async () => ({
			ok: true as const,
			assistantText: "<curate></curate>",
		}));
		__test.setPiSubagentRunnerFactory(() => ({ run }) as never);
		const projectIdentity = "git:pi-manual-lease-wait";
		const owner = {};
		const leaseKey = leaseKeyFor("curate", projectIdentity);
		const blocker = "manual-lease-blocker";
		insertMemory(db, {
			projectPath: projectIdentity,
			category: "PROJECT_RULES",
			content:
				"Keep the owner-drain lease test scoped to runnable curate work.",
		});
		expect(acquireLease(db, blocker, leaseKey)).toBe(true);
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectIdentity,
				registrationOwner: owner,
				config: DreamerConfigSchema.parse({
					model: "test/model",
					tasks: { curate: { schedule: "0 4 * * *" } },
				}),
			}),
		);

		const manualRun = runPiDreamForProject(projectIdentity, "curate", owner);
		await flushMicrotasks();
		let drained = false;
		const drain = awaitInFlightDreamers(owner).then(() => {
			drained = true;
		});
		await flushMicrotasks();
		expect(drained).toBe(false);

		unregisterPiDreamerProject({ projectIdentity, registrationOwner: owner });
		releaseLease(db, blocker, leaseKey);
		const result = await manualRun;
		await drain;
		expect(drained).toBe(true);
		expect(run).not.toHaveBeenCalled();
		expect(result.failed).toEqual(["curate"]);
	});

	test("drains a manual run whose successful result arrives after unregister", async () => {
		db = createDb();
		const gate = deferred<{ ok: true; assistantText: string }>();
		const runStarted = deferred<void>();
		const refresh = mock(() => {});
		__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(() => {
						runStarted.resolve();
						return gate.promise;
					}),
				}) as never,
		);
		const projectIdentity = "git:pi-manual-late-unregister";
		const owner = {};
		insertMemory(db, {
			projectPath: projectIdentity,
			category: "PROJECT_RULES",
			content: "Ignore Dreamer results after their registration owner exits.",
		});
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: process.cwd(),
				projectIdentity,
				registrationOwner: owner,
				config: DreamerConfigSchema.parse({
					model: "test/model",
					tasks: { curate: { schedule: "0 4 * * *" } },
				}),
				onAdjunctsRefreshNeeded: refresh,
			}),
		);

		const manualRun = runPiDreamForProject(projectIdentity, "curate", owner);
		await runStarted.promise;
		unregisterPiDreamerProject({
			projectIdentity,
			registrationOwner: owner,
		});
		let drained = false;
		const drain = awaitInFlightDreamers(owner).then(() => {
			drained = true;
		});
		await flushMicrotasks();
		expect(drained).toBe(false);

		gate.resolve({ ok: true, assistantText: "curation complete" });
		const result = await manualRun;
		await drain;
		expect(drained).toBe(true);
		expect(result.failed).toEqual(["curate"]);
		expect(refresh).not.toHaveBeenCalled();
	});

	test("unregister removes the project", () => {
		db = createDb();
		const opts = dreamerOptions({
			database: db,
			projectDir: "/tmp/pi-project-unregister",
			projectIdentity: "git:pi-unregister",
		});
		registerPiDreamerProject(opts);

		unregisterPiDreamerProject({
			projectIdentity: "git:pi-unregister",
			registrationOwner: opts.registrationOwner,
		});

		expect(__test.registeredProjectCount()).toBe(0);
	});

	test("awaitInFlightDreamers resolves immediately when nothing is running", async () => {
		await expect(awaitInFlightDreamers()).resolves.toBeUndefined();
	});

	test("awaitInFlightDreamers waits only for the requested owner", async () => {
		db = createDb();
		const ownerA = {};
		const ownerB = {};
		const gates = [
			deferred<{ ok: true; assistantText: string }>(),
			deferred<{ ok: true; assistantText: string }>(),
		];
		let nextRunner = 0;
		const clients: CapturedDreamClient[] = [];
		__test.setPiSubagentRunnerFactory(() => {
			const gate = gates[nextRunner++];
			return { run: mock(() => gate.promise) } as never;
		});
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			clients.push(registration.client as unknown as CapturedDreamClient);
			return mock(() => {});
		});

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectIdentity: "git:pi-owner-a",
				registrationOwner: ownerA,
			}),
		);
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectIdentity: "git:pi-owner-b",
				registrationOwner: ownerB,
			}),
		);
		await flushMicrotasks();

		const sessions = await Promise.all(
			clients.map(
				(client) => client.session.create({}) as Promise<{ id: string }>,
			),
		);
		const prompts = clients.map((client, index) =>
			client.session.prompt({
				path: { id: sessions[index]?.id },
				body: { system: "system", parts: [{ text: "run dreamer" }] },
			}),
		);
		await flushMicrotasks();

		let ownerADrained = false;
		const ownerADrain = awaitInFlightDreamers(ownerA).then(() => {
			ownerADrained = true;
		});
		gates[1]?.resolve({ ok: true, assistantText: "owner B done" });
		await prompts[1];
		await flushMicrotasks();
		expect(ownerADrained).toBe(false);

		gates[0]?.resolve({ ok: true, assistantText: "owner A done" });
		await ownerADrain;
		await prompts[0];
		expect(ownerADrained).toBe(true);
	});

	test("fires onAdjunctsRefreshNeeded after successful dreamer prompt", async () => {
		db = createDb();
		let capturedClient: CapturedDreamClient | null = null;
		const timerCleanup = mock(() => {});
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			capturedClient = registration.client as unknown as CapturedDreamClient;
			return timerCleanup;
		});
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async () => ({ ok: true, assistantText: "done" })),
				}) as never,
		);
		const onAdjunctsRefreshNeeded = mock(() => {});

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectIdentity: "git:pi-g5-success",
				onAdjunctsRefreshNeeded,
			}),
		);
		const client = requireCapturedClient(capturedClient);
		const created = (await client.session.create({})) as {
			id: string;
		};
		await client.session.prompt({
			path: { id: created.id },
			body: { system: "system", parts: [{ text: "run dreamer" }] },
		});

		expect(onAdjunctsRefreshNeeded).toHaveBeenCalledTimes(1);
		expect(onAdjunctsRefreshNeeded).toHaveBeenCalledWith("git:pi-g5-success");
	});

	test("notifies every registered worktree after a successful dreamer prompt", async () => {
		db = createDb();
		let capturedClient: CapturedDreamClient | null = null;
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			capturedClient = registration.client as unknown as CapturedDreamClient;
			return mock(() => {});
		});
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async () => ({ ok: true, assistantText: "done" })),
				}) as never,
		);
		const projectIdentity = "git:pi-g5-worktrees";
		const refreshA = mock(() => {});
		const refreshB = mock(() => {});
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: "/tmp/worktree-A",
				projectIdentity,
				onAdjunctsRefreshNeeded: refreshA,
			}),
		);
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: "/tmp/worktree-B",
				projectIdentity,
				onAdjunctsRefreshNeeded: refreshB,
			}),
		);

		const client = requireCapturedClient(capturedClient);
		const created = (await client.session.create({})) as { id: string };
		await client.session.prompt({
			path: { id: created.id },
			body: { system: "system", parts: [{ text: "run dreamer" }] },
		});

		expect(refreshA).toHaveBeenCalledWith(projectIdentity);
		expect(refreshB).toHaveBeenCalledWith(projectIdentity);
	});

	test("undefined onAdjunctsRefreshNeeded is a no-op after successful dreamer prompt", async () => {
		db = createDb();
		let capturedClient: CapturedDreamClient | null = null;
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			capturedClient = registration.client as unknown as CapturedDreamClient;
			return mock(() => {});
		});
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async () => ({ ok: true, assistantText: "done" })),
				}) as never,
		);

		registerPiDreamerProject(
			dreamerOptions({ database: db, projectIdentity: "git:pi-g5-noop" }),
		);
		const client = requireCapturedClient(capturedClient);
		const created = (await client.session.create({})) as {
			id: string;
		};
		await expect(
			client.session.prompt({
				path: { id: created.id },
				body: { system: "system", parts: [{ text: "run dreamer" }] },
			}),
		).resolves.toBeUndefined();
	});

	test("does not fire onAdjunctsRefreshNeeded when dreamer prompt fails", async () => {
		db = createDb();
		let capturedClient: CapturedDreamClient | null = null;
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			capturedClient = registration.client as unknown as CapturedDreamClient;
			return mock(() => {});
		});
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async () => ({
						ok: false,
						reason: "error",
						error: "boom",
					})),
				}) as never,
		);
		const onAdjunctsRefreshNeeded = mock(() => {});

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectIdentity: "git:pi-g5-failure",
				onAdjunctsRefreshNeeded,
			}),
		);
		const client = requireCapturedClient(capturedClient);
		const created = (await client.session.create({})) as {
			id: string;
		};
		await expect(
			client.session.prompt({
				path: { id: created.id },
				body: { system: "system", parts: [{ text: "run dreamer" }] },
			}),
		).rejects.toThrow("Pi dreamer subagent failed");

		expect(onAdjunctsRefreshNeeded).not.toHaveBeenCalled();
	});

	test("preserves transient status when a child rejects before producing output", async () => {
		db = createDb();
		let capturedClient: CapturedDreamClient | null = null;
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			capturedClient = registration.client as unknown as CapturedDreamClient;
			return mock(() => {});
		});
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async () => ({
						ok: false,
						reason: "invalid_prompt",
						transient: true,
						error: "zero-tool prompt missing",
						durationMs: 0,
					})),
				}) as never,
		);

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectIdentity: "git:pi-transient-child",
			}),
		);
		const client = requireCapturedClient(capturedClient);
		const created = (await client.session.create({})) as { id: string };
		await expect(
			client.session.prompt({
				path: { id: created.id },
				body: { system: "system", parts: [{ text: "run dreamer" }] },
			}),
		).rejects.toMatchObject({ transient: true });
	});

	test("unregister before timer promise resolves invokes timer cleanup when it eventually resolves", async () => {
		db = createDb();
		const timerCleanup = mock(() => {});
		const timer = deferred<() => void>();
		__test.setStartDreamScheduleTimerFactory(() => timer.promise);

		const opts = dreamerOptions({
			database: db,
			projectIdentity: "git:pi-g12-race",
		});
		registerPiDreamerProject(opts);
		unregisterPiDreamerProject({
			projectIdentity: "git:pi-g12-race",
			registrationOwner: opts.registrationOwner,
		});
		expect(timerCleanup).not.toHaveBeenCalled();

		timer.resolve(timerCleanup);
		await flushMicrotasks();

		expect(timerCleanup).toHaveBeenCalledTimes(1);
	});

	test("normal timer lifecycle invokes cleanup exactly once on unregister", async () => {
		db = createDb();
		const timerCleanup = mock(() => {});
		const timer = deferred<() => void>();
		__test.setStartDreamScheduleTimerFactory(() => timer.promise);

		const opts = dreamerOptions({
			database: db,
			projectIdentity: "git:pi-g12-normal",
		});
		registerPiDreamerProject(opts);
		timer.resolve(timerCleanup);
		await flushMicrotasks();

		unregisterPiDreamerProject({
			projectIdentity: "git:pi-g12-normal",
			registrationOwner: opts.registrationOwner,
		});
		unregisterPiDreamerProject({
			projectIdentity: "git:pi-g12-normal",
			registrationOwner: opts.registrationOwner,
		});

		expect(timerCleanup).toHaveBeenCalledTimes(1);
	});
});
