import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import {
	getMemoryVerifications,
	getUnmappedMemoryIds,
	recordMemoryVerifications,
} from "@magic-context/core/features/magic-context/memory/storage-memory-verifications";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import {
	closeDatabase,
	openDatabase,
} from "@magic-context/core/features/magic-context/storage";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getSubagentInvocations } from "@magic-context/core/features/magic-context/storage-subagent-invocations";
import { extractLatestAssistantText } from "@magic-context/core/shared/assistant-message-extractor";
import * as logger from "@magic-context/core/shared/logger";
import {
	getPromptFailureDetail,
	promptSyncWithValidatedOutputRetry,
} from "@magic-context/core/shared/model-suggestion-retry";
import { createPromptAsyncTransport } from "@magic-context/core/shared/prompt-async-transport";
import { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { __setPiHarnessKindForTesting } from "../pi-harness-kind";
import { ZEN_FREE_TIER_FAILURE } from "../pi-zen-free-tier";
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
	for (const harness of ["pi", "omp"] as const) {
		for (const streaming of [false, true]) {
			test(`${harness} dreamer ${streaming ? "streamed primary keeps its full timeout" : "silent primary is cut and fallback completes"}`, async () => {
				const dataDir = createTestTempDirFromPath(
					join(tmpdir(), "mc-pi-first-output-"),
				);
				const previous = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
				process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dataDir;
				closeDatabase();
				db = openDatabase();
				if (!db) throw new Error("test database unavailable");
				try {
					let client!: CapturedDreamClient;
					const models: string[] = [];
					__test.setStartDreamScheduleTimerFactory(async (registration) => {
						client = registration.client as CapturedDreamClient;
						return () => {};
					});
					__test.setPiSubagentRunnerFactory(
						() =>
							new PiSubagentRunner({
								invocation: {
									command: "pi-fixture",
									prefixArgs: [],
									targetHarness: harness,
								},
								spawnImpl: mock((_command, args) => {
									models.push(String(args[args.indexOf("--model") + 1]));
									const child = createEventStreamChild();
									child.kill.mockImplementation(() => {
										child.emitClose();
										return true;
									});
									const primary = models.length === 1;
									setTimeout(() => {
										if (!primary) {
											const message = {
												role: "assistant",
												stopReason: "stop",
												content: [{ type: "text", text: "fallback answer" }],
											};
											child.writeStdoutLine({ type: "message_end", message });
											child.writeStdoutLine({
												type: "agent_end",
												messages: [message],
											});
											child.emitClose();
											return;
										}
										child.writeStdoutLine({ type: "agent_start" });
										child.writeStdoutLine({
											type: "message_start",
											message: { role: "assistant", content: [] },
										});
										if (streaming)
											child.writeStdoutLine({
												type: "message_update",
												...(harness === "pi"
													? {
															message: {
																role: "assistant",
																content: [{ type: "text", text: "x" }],
															},
														}
													: {}),
												assistantMessageEvent: {
													type: "text_delta",
													delta: "x",
												},
											});
									}, 0);
									return child as never;
								}) as never,
							}),
					);
					registerPiDreamerProject(
						dreamerOptions({
							database: db,
							projectIdentity: `git:silent-${harness}`,
							projectDir: dataDir,
							harness,
						}),
					);
					await flushMicrotasks();
					const child = (await client.session.create({
						body: { title: "magic-context-dream-classify-memories" },
					})) as { id: string };
					const startedAt = Date.now();
					// Leave the fallback ample time even when another suite deschedules this worker.
					const timeoutMs = streaming ? 500 : 5_000;
					const run = promptSyncWithValidatedOutputRetry(
						client as never,
						{
							path: { id: child.id },
							body: {
								model: { providerID: "test", modelID: "primary" },
								parts: [{ type: "text", text: "classify" }],
							},
						},
						{
							timeoutMs,
							firstOutputTimeoutMs: 60,
							fallbackModels: ["test/fallback"],
							fetchOutput: async () =>
								(
									(await client.session.messages({
										path: { id: child.id },
									})) as { data: unknown[] }
								).data,
							validateOutput: (messages) =>
								extractLatestAssistantText(messages),
						},
					);
					if (streaming) {
						let caught: unknown;
						try {
							await run;
						} catch (error) {
							caught = error;
						}
						expect((caught as Error).message).toBe(
							"prompt timed out after 500ms",
						);
						expect(getPromptFailureDetail(caught)?.failureClass).toBe(
							"provider_timeout",
						);
						expect(models).toEqual(["test/primary"]);
						expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450);
					} else {
						expect((await run).validated).toBe("fallback answer");
						expect(models).toEqual(["test/primary", "test/fallback"]);
						expect(Date.now() - startedAt).toBeGreaterThanOrEqual(55);
						expect(Date.now() - startedAt).toBeLessThan(4_000);
						expect(
							getSubagentInvocations(db, `git:silent-${harness}`),
						).toMatchObject([
							{ modelId: "fallback", status: "completed" },
							{
								modelId: "primary",
								status: "timed_out",
								error: expect.stringContaining(
									"prompt timed out after 60ms with no model output",
								),
							},
						]);
					}
				} finally {
					closeDatabase();
					db = null;
					if (previous === undefined)
						delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
					else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = previous;
					rmSync(dataDir, { recursive: true, force: true });
				}
			});
		}
	}
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
	async function runnerTimeoutsFor(
		identity: string,
		curate: Record<string, unknown>,
	): Promise<{
		timeouts: Array<number | undefined>;
		fallbackModels: Array<readonly unknown[] | undefined>;
	}> {
		db = createDb();
		const owner = {};
		const timeouts: Array<number | undefined> = [];
		const fallbackModels: Array<readonly unknown[] | undefined> = [];
		__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(
						async (args: {
							timeoutMs?: number;
							fallbackModels?: readonly unknown[];
						}) => {
							timeouts.push(args.timeoutMs);
							fallbackModels.push(args.fallbackModels);
							return { ok: true, assistantText: "curation complete" };
						},
					),
				}) as never,
		);
		const config = DreamerConfigSchema.parse({
			pi: { model: "test/model", tasks: { curate } },
			tasks: { curate: { schedule: "0 4 * * *" } },
		});
		insertMemory(db, {
			projectPath: identity,
			category: "PROJECT_RULES",
			content: "Keep configured task timeout.",
		});
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectIdentity: identity,
				projectDir: process.cwd(),
				registrationOwner: owner,
				config,
			}),
		);
		const result = await runPiDreamForProject(identity, "curate", owner);
		expect(result.failed).toEqual([]);
		return { timeouts, fallbackModels };
	}

	test("Pi dreamer gives a task configured above 30 minutes a runner ceiling above its timeout", async () => {
		const { timeouts, fallbackModels } = await runnerTimeoutsFor(
			"git:pi-task-timeout",
			{ timeout_minutes: 120 },
		);
		// 120 minutes of task timeout plus 5 minutes of headroom, so the
		// executor's own timeout ends the run, not the subprocess ceiling.
		expect(timeouts).toEqual([(120 + 5) * 60 * 1000]);
		expect(fallbackModels).toEqual([undefined]);
	});

	test("Pi dreamer maps every child title to its configured task", () => {
		// The task name decides which timeout and model config a child gets,
		// so a title that maps to no task falls back to the unknown-task ceiling.
		expect(__test.accountingTaskFromTitle("magic-context-dream-curate")).toBe(
			"curate",
		);
		expect(__test.accountingTaskFromTitle("magic-context-dream-classify")).toBe(
			"classify-memories",
		);
		expect(
			__test.accountingTaskFromTitle("magic-context-dream-user-memories"),
		).toBe("review-user-memories");
		expect(
			__test.accountingTaskFromTitle("magic-context-smart-note-confirm-1"),
		).toBe("evaluate-smart-notes");
		expect(__test.accountingTaskFromTitle("something-else")).toBeNull();
	});

	test("Pi dreamer keeps the runner ceiling above the default task timeout", async () => {
		const { timeouts } = await runnerTimeoutsFor("git:pi-task-default", {});
		// An unconfigured task runs with the shared 20-minute default.
		expect(timeouts).toEqual([(20 + 5) * 60 * 1000]);
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
	test("disabled dreamer registers maintenance once but cannot run dream tasks", async () => {
		db = createDb();
		const starts: unknown[] = [];
		__test.setStartDreamScheduleTimerFactory(async (args) => {
			starts.push(args);
			return mock(() => {});
		});
		const opts = {
			...dreamerOptions({
				database: db,
				projectDir: "/tmp/pi-project-disabled",
				projectIdentity: "git:pi-disabled",
				config: disabledConfig(),
			}),
			gitCommitIndexing: { enabled: true, since_days: 30, max_commits: 200 },
		};
		registerPiDreamerProject(opts);
		registerPiDreamerProject(opts);
		expect(__test.registeredProjectCount()).toBe(1);
		expect(starts).toHaveLength(1);
		expect(starts[0]).toMatchObject({
			dreamerConfig: { disable: true },
			gitCommitIndexing: { enabled: true },
		});
		await expect(
			runPiDreamForProject(
				opts.projectIdentity,
				"verify",
				opts.registrationOwner,
			),
		).rejects.toThrow("dreamer is disabled");
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

	test("mapping facade retains intermediate decisions after a step-limit failure", async () => {
		db = createDb();
		let capturedClient: CapturedDreamClient | null = null;
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			capturedClient = registration.client as unknown as CapturedDreamClient;
			return mock(() => {});
		});
		const text = '<mappings><memory id="1" independent="true"/>';
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: async () => ({
						ok: false,
						reason: "step_limit",
						error: "cap",
						durationMs: 0,
						meta: {
							cap: 60,
							mappingMessages: [
								{ role: "assistant", content: [{ type: "text", text }] },
							],
						},
					}),
				}) as never,
		);
		const refresh = mock(() => {});
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectIdentity: "git:pi-map-partial",
				onAdjunctsRefreshNeeded: refresh,
			}),
		);
		const client = requireCapturedClient(capturedClient);
		const created = (await client.session.create({
			body: { title: "magic-context-dream-map-memories" },
		})) as { id: string };
		await expect(
			client.session.prompt({
				path: { id: created.id },
				body: { agent: "dreamer-memory-mapper", parts: [{ text: "map" }] },
			}),
		).rejects.toThrow();
		expect(
			JSON.stringify(
				await client.session.messages({ path: { id: created.id } }),
			),
		).toContain(JSON.stringify(text));
		expect(refresh).not.toHaveBeenCalled();
	});

	test("Pi mapping stream commits an emitted decision after runner abort", async () => {
		const dataDir = createTestTempDirFromPath(
			join(tmpdir(), "mc-pi-map-stream-"),
		);
		const previous = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
		process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dataDir;
		closeDatabase();
		try {
			db = openDatabase();
			const projectIdentity = "git:pi-map-stream";
			const first = insertMemory(db, {
				projectPath: projectIdentity,
				category: "CONSTRAINTS",
				content: "External provider rejects an empty request.",
			});
			insertMemory(db, {
				projectPath: projectIdentity,
				category: "CONSTRAINTS",
				content: "External provider requires authentication.",
			});
			const controller = new AbortController();
			const child = createEventStreamChild();
			const spawned = deferred<void>();
			const runner = new PiSubagentRunner({
				invocation: {
					command: "pi-fixture",
					prefixArgs: [],
					targetHarness: "pi",
				},
				spawnImpl: mock(() => {
					spawned.resolve();
					return child as never;
				}) as never,
			});
			__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
			__test.setPiSubagentRunnerFactory(
				() =>
					({
						run: (args: Parameters<PiSubagentRunner["run"]>[0]) =>
							runner.run({ ...args, signal: controller.signal }),
					}) as never,
			);
			const opts = dreamerOptions({
				database: db,
				projectIdentity,
				projectDir: dataDir,
				config: DreamerConfigSchema.parse({
					model: "test/model",
					tasks: { "map-memories": { schedule: "0 4 * * *" } },
				}),
			});
			registerPiDreamerProject(opts);
			const run = runPiDreamForProject(
				projectIdentity,
				"map-memories",
				opts.registrationOwner,
			);
			await spawned.promise;
			child.writeStdoutLine({
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [
						{
							type: "text",
							text: `<mappings><memory id="${first.id}" independent="true"/>`,
						},
						{
							type: "toolCall",
							id: "next",
							name: "read",
							arguments: { path: "next.ts" },
						},
					],
				},
			});
			controller.abort();
			expect((await run).ran).toEqual(["map-memories"]);
			expect(
				getMemoryVerifications(db, [first.id]).get(first.id)?.hasSentinel,
			).toBe(true);
		} finally {
			closeDatabase();
			db = null;
			if (previous === undefined)
				delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
			else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = previous;
			rmSync(dataDir, { recursive: true, force: true });
		}
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

test("Pi facade honors a shared batch envelope across failed and successful attempts", async () => {
	db = createDb();
	let captured: CapturedDreamClient | null = null;
	const budgets: number[] = [];
	__test.setStartDreamScheduleTimerFactory(async (registration) => {
		captured = registration.client as unknown as CapturedDreamClient;
		return mock(() => {});
	});
	__test.setPiSubagentRunnerFactory(
		() =>
			({
				run: async (args: { tokenBudget: number }) => {
					budgets.push(args.tokenBudget);
					const spent = budgets.length === 1 ? 100_000 : 400_000;
					return {
						ok: budgets.length !== 1,
						reason: "provider_error",
						error: "fixture refusal",
						assistantText: "<verify/>",
						meta: {
							tokenBudget: {
								budget: args.tokenBudget,
								spent,
								finalizeFired: false,
								hardStopped: false,
								refusedCalls: 0,
							},
						},
					};
				},
			}) as never,
	);
	registerPiDreamerProject(
		dreamerOptions({ database: db, projectIdentity: "git:pi-batch-budget" }),
	);
	const client = requireCapturedClient(captured);
	const child = (await client.session.create({
		body: { title: "magic-context-dream-verify" },
	})) as { id: string };
	const observed: number[] = [];
	const transport = createPromptAsyncTransport(client as never, child.id, {
		tokenBudget: 500_000,
		onBudgetUpdate: (s) => observed.push(s.spent),
	});
	expect(transport).toBeDefined();
	if (!transport) throw new Error("missing synchronous transport");
	const request = {
		path: { id: child.id },
		body: { parts: [{ text: "fixture" }] },
	} as never;
	await expect(transport(request)).rejects.toThrow("fixture refusal");
	await transport(request);
	await expect(transport(request)).rejects.toThrow("token_budget");
	expect(budgets).toEqual([500_000, 400_000]);
	expect(observed).toEqual([100_000, 500_000]);
});

test("Pi verify facade preserves complete verdicts before a budget interruption", async () => {
	db = createDb();
	let captured: CapturedDreamClient | null = null;
	__test.setStartDreamScheduleTimerFactory(async (registration) => {
		captured = registration.client as unknown as CapturedDreamClient;
		return mock(() => {});
	});
	__test.setPiSubagentRunnerFactory(
		() =>
			({
				run: async () => ({
					ok: false,
					reason: "token_budget",
					meta: {
						tokenBudget: { spent: 500_000 },
						mappingMessages: [
							{
								role: "assistant",
								content: [
									{
										type: "text",
										text: '<verify><verified id="1" files="src/fact.ts"/>',
									},
								],
							},
						],
					},
				}),
			}) as never,
	);
	registerPiDreamerProject(
		dreamerOptions({ database: db, projectIdentity: "git:pi-verify-partial" }),
	);
	const client = requireCapturedClient(captured);
	const child = (await client.session.create({
		body: { title: "magic-context-dream-verify" },
	})) as { id: string };
	await expect(
		client.session.prompt({
			path: { id: child.id },
			body: { parts: [{ text: "fixture" }] },
		}),
	).rejects.toThrow("token_budget");
	expect(
		JSON.stringify(await client.session.messages({ path: { id: child.id } })),
	).toContain('<verify><verified id=\\"1\\"');
});

for (const task of ["verify", "verify-broad"] as const) {
	for (const whitespace of [false, true]) {
		test(`Pi ${task} host verifies runner text behind ${whitespace ? "whitespace-only" : "tool-only"} streamed messages`, async () => {
			db = createDb();
			const directory = createTestTempDirFromPath(
				join(tmpdir(), "mc-pi-verify-separate-text-"),
			);
			const identity = `git:pi-${task}-${whitespace ? "whitespace" : "tools"}`;
			mkdirSync(join(directory, "src"));
			writeFileSync(
				join(directory, "src/fact.ts"),
				"export const backingFact = 1;\n",
			);
			const memory = insertMemory(db, {
				projectPath: identity,
				category: "ARCHITECTURE",
				content: "backingFact is exported by src/fact.ts.",
			});
			recordMemoryVerifications(db, memory.id, ["src/fact.ts"], 1_000);
			const text = `<verify><verified id="${memory.id}" files="src/fact.ts"/></verify>`;
			let attempts = 0;
			__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
			__test.setPiSubagentRunnerFactory(
				() =>
					({
						run: async () => {
							attempts++;
							return {
								ok: true,
								assistantText: text,
								meta: {
									mappingMessages: Array.from({ length: 8 }, (_, i) => ({
										role: "assistant",
										content: [
											{
												type: "toolCall",
												id: `read-${i}`,
												name: "read",
												arguments: {},
											},
											...(whitespace ? [{ type: "text", text: " \n\t " }] : []),
										],
									})),
								},
							};
						},
					}) as never,
			);
			const opts = dreamerOptions({
				database: db,
				projectIdentity: identity,
				projectDir: directory,
			});
			try {
				registerPiDreamerProject(opts);
				const result = await runPiDreamForProject(
					identity,
					task,
					opts.registrationOwner,
				);
				expect(result.failed).toEqual([]);
				expect(result.ran).toContain(task);
				expect(attempts).toBe(1);
				expect(
					getMemoryVerifications(db, [memory.id]).get(memory.id)?.verifiedAt,
				).toBeGreaterThan(1_000);
			} finally {
				unregisterPiDreamerProject(identity, opts.registrationOwner);
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}
}

for (const task of ["verify", "map-memories"] as const)
	test(`Pi ${task} never preserves a classified Zen free-tier refusal as output`, async () => {
		db = createDb();
		let captured: CapturedDreamClient | null = null;
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			captured = registration.client as unknown as CapturedDreamClient;
			return mock(() => {});
		});
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: async () => ({
						ok: false,
						reason: "provider_error",
						error:
							"FreeTierError: OpenCode's free tier can only be used from within OpenCode",
						assistantText:
							task === "map-memories"
								? '<mappings><memory id="1" independent="true"/></mappings>'
								: '<verify><verified id="1" files="src/fact.ts"/></verify>',
						meta: {
							failureClass: ZEN_FREE_TIER_FAILURE,
							mappingMessages: [
								{
									role: "assistant",
									content: [
										{
											type: "toolCall",
											id: "refused-tool",
											name: "read",
											arguments: {},
										},
									],
								},
							],
						},
					}),
				}) as never,
		);
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectIdentity: `git:pi-${task}-free-tier`,
			}),
		);
		const client = requireCapturedClient(captured);
		const child = (await client.session.create({
			body: { title: `magic-context-dream-${task}` },
		})) as { id: string };
		await expect(
			client.session.prompt({
				path: { id: child.id },
				body: { parts: [{ text: "fixture" }] },
			}),
		).rejects.toThrow("FreeTierError");
		expect(await client.session.messages({ path: { id: child.id } })).toEqual({
			data: [],
		});
	});

function mappingToolHistory(whitespace = false) {
	return Array.from({ length: 8 }, (_, index) => ({
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: `mapping-read-${index}`,
				name: "read",
				arguments: {},
			},
			...(whitespace ? [{ type: "text", text: " \n\t " }] : []),
		],
	}));
}

for (const whitespace of [false, true]) {
	test(`Pi mapping host maps eight ${whitespace ? "whitespace-only" : "tool-only"} turns with separate runner text`, async () => {
		db = createDb();
		const identity = `git:pi-mapping-separate-${whitespace ? "whitespace" : "tools"}`;
		const memory = insertMemory(db, {
			projectPath: identity,
			category: "ARCHITECTURE",
			content: "A standalone fixture fact.",
		});
		const text = `<mappings><memory id="${memory.id}" independent="true"/></mappings>`;
		let attempts = 0;
		__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: async () => {
						attempts++;
						return {
							ok: true,
							assistantText: text,
							meta: { mappingMessages: mappingToolHistory(whitespace) },
						};
					},
				}) as never,
		);
		const opts = dreamerOptions({
			database: db,
			projectIdentity: identity,
			projectDir: process.cwd(),
		});
		expect(getUnmappedMemoryIds(db, [memory.id])).toEqual([memory.id]);
		registerPiDreamerProject(opts);
		const result = await runPiDreamForProject(
			identity,
			"map-memories",
			opts.registrationOwner,
		);
		expect(result.failed).toEqual([]);
		expect(result.ran).toContain("map-memories");
		expect(attempts).toBe(1);
		expect(getUnmappedMemoryIds(db, [memory.id])).toEqual([]);
		expect(
			getMemoryVerifications(db, [memory.id]).get(memory.id)?.hasSentinel,
		).toBe(true);
	});
}

test("Pi mapping keeps meaningful streamed text ahead of separate runner text", async () => {
	db = createDb();
	let captured: CapturedDreamClient | null = null;
	const streamedText =
		'<mappings><memory id="1" independent="true"/></mappings>';
	const runnerText = '<mappings><memory id="2" independent="true"/></mappings>';
	const streamed = mappingToolHistory();
	streamed[0].content.push({ type: "text", text: streamedText });
	__test.setStartDreamScheduleTimerFactory(async (registration) => {
		captured = registration.client as unknown as CapturedDreamClient;
		return mock(() => {});
	});
	__test.setPiSubagentRunnerFactory(
		() =>
			({
				run: async () => ({
					ok: true,
					assistantText: runnerText,
					meta: { mappingMessages: streamed },
				}),
			}) as never,
	);
	registerPiDreamerProject(
		dreamerOptions({
			database: db,
			projectIdentity: "git:pi-mapping-stream-priority",
		}),
	);
	const client = requireCapturedClient(captured);
	const child = (await client.session.create({
		body: { title: "magic-context-dream-map-memories" },
	})) as { id: string };
	await client.session.prompt({
		path: { id: child.id },
		body: { parts: [{ text: "fixture" }] },
	});
	const messages = (
		(await client.session.messages({ path: { id: child.id } })) as {
			data: unknown[];
		}
	).data;
	const text = messages
		.map((message) => extractLatestAssistantText([message]) ?? "")
		.join("\n");
	expect(messages).toHaveLength(8);
	expect(text.trim()).toBe(streamedText);
	expect(text).not.toContain(runnerText);
});
