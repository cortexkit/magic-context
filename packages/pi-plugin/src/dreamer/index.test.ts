import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	type DreamerConfig,
	DreamerConfigSchema,
} from "@magic-context/core/config/schema/magic-context";
import {
	acquireLease,
	releaseLease,
} from "@magic-context/core/features/magic-context/dreamer/lease";
import { getTaskScheduleState } from "@magic-context/core/features/magic-context/dreamer/storage-task-schedule";
import { leaseKeyFor } from "@magic-context/core/features/magic-context/dreamer/task-registry";
import { insertMemory } from "@magic-context/core/features/magic-context/memory";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	__test,
	awaitInFlightDreamers,
	registerPiDreamerProject,
	runPiDreamForProject,
	unregisterPiDreamerProject,
} from ".";

let db: Database | null = null;

type CapturedDreamClient = {
	session: {
		create: (args: unknown) => Promise<unknown>;
		prompt: (args: unknown) => Promise<unknown>;
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

	test("manual dreamer passes a directive-bearing system prompt when language is set", async () => {
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

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: process.cwd(),
				projectIdentity: "git:pi-manual-language",
				config: DreamerConfigSchema.parse({
					model: "test/model",
					tasks: { curate: { schedule: "0 4 * * *" } },
				}),
				language: "es",
			}),
		);

		const result = await runPiDreamForProject(
			"git:pi-manual-language",
			"curate",
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
			backlogBefore: { curate: { pending: 1, total: 1 } },
			backlogAfter: { curate: { pending: 1, total: 1 } },
		});

		expect(capturedSystem).toContain(
			"Write human-readable prose you author in: Spanish (Español).",
		);
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

		registerPiDreamerProject(
			dreamerOptions({
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
			}),
		);

		const result = await runPiDreamForProject(
			"git:pi-curate-pseudo-tool-call",
			"curate",
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

	test("old timer client cannot prompt after its owner switches worktrees", async () => {
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
		const owner = {};
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: "/tmp/worktree-A",
				projectIdentity,
				registrationOwner: owner,
			}),
		);
		await flushMicrotasks();
		const oldClient = clients[0];
		expect(oldClient).toBeDefined();
		if (!oldClient) throw new Error("first dreamer client was not captured");
		const created = (await oldClient.session.create({})) as { id: string };

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: "/tmp/worktree-B",
				projectIdentity,
				registrationOwner: owner,
			}),
		);
		await expect(
			oldClient.session.prompt({
				path: { id: created.id },
				body: { system: "system", parts: [{ text: "run dreamer" }] },
			}),
		).rejects.toThrow("registration is no longer active");
		expect(run).not.toHaveBeenCalled();
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

	test("rejects a manual run after its explicit owner unregisters", async () => {
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
		unregisterPiDreamerProject({
			projectIdentity,
			registrationOwner: ownerA.registrationOwner,
		});
		__test.setPiSubagentRunnerFactory(() => {
			throw new Error("manual client should not be created");
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
