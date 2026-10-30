import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { acquireCompartmentLease } from "@magic-context/core/features/magic-context/compartment-lease";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { CHECK_SYSTEM_PROMPTS } from "@magic-context/core/features/magic-context/memory/lifecycle-gates";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	getMemoryById,
	insertMemory,
} from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	allocateTurnOneSend,
	commitTurnOnePublication,
} from "@magic-context/core/features/magic-context/memory/turn-one-publication";
import {
	runTurnTwo,
	TURN_TWO_UNREACHABLE_MAX_AGE_MS,
	TurnTwoOutcomeUnknownError,
} from "@magic-context/core/features/magic-context/memory/turn-two";
import { closeTurnTwoChild } from "@magic-context/core/features/magic-context/memory/turn-two-children";
import { authorizationFixture } from "@magic-context/core/features/magic-context/memory/turn-two-test-fixtures.test";
import { runMessageFtsRowidMapBackfill } from "@magic-context/core/features/magic-context/message-fts-rowid-map";
import {
	closeDatabase,
	openDatabase,
} from "@magic-context/core/features/magic-context/storage";
import { COMPARTMENT_AGENT_SYSTEM_PROMPT } from "@magic-context/core/hooks/magic-context/compartment-prompt";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	cleanupTestTempDir,
	createTestTempDirFromPath,
} from "@magic-context/core/shared/test-temp-dir";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { type PiHistorianDeps, runPiHistorian } from "./pi-historian-runner";
import {
	PI_RPC_CARRIER,
	recoverLostPiRpcStages,
	schedulePiHistorianTurnTwo,
	settlePiHistorianTurnTwoRuns,
} from "./pi-historian-turn-two";
import {
	type PiRpcHistorianChild,
	type PiRpcHistorianRunner,
	PiSubagentRunner,
} from "./subagent-runner";
import { createTestDb } from "./test-utils.test";

const enabled = process.env.MC_S8_REVIEW === "1";
const projectPath = resolveProjectIdentity(process.cwd());
const authorization = authorizationFixture(
	{
		lane: "pi",
		carrier: "pi-historian-rpc",
		provider: "test",
		modelId: "model",
		variant: null,
		temperature: null,
		thinkingLevel: null,
	},
	COMPARTMENT_AGENT_SYSTEM_PROMPT,
	[],
);
if (!projectPath) throw new Error("Review fixtures require a project identity");
const xml =
	'<compartment start="1" end="2" title="Review"><p1>Updated the rule.</p1></compartment>\n<CONSTRAINTS>\n* [at_compartment=1 messages=1-1] New rule.\n</CONSTRAINTS>';
const messages: RawMessage[] = Array.from({ length: 12 }, (_, i) => ({
	ordinal: i + 1,
	id: `m${i + 1}`,
	role: i % 2 ? "assistant" : "user",
	parts: [{ type: "text", text: i === 0 ? "New rule." : `Turn ${i + 1}` }],
}));
type Db = ReturnType<typeof createTestDb>;

function deps(db: Db, runner: PiHistorianDeps["runner"]): PiHistorianDeps {
	expect(acquireCompartmentLease(db, "ses-review", "holder")).not.toBeNull();
	return {
		db,
		runner,
		sessionId: "ses-review",
		directory: process.cwd(),
		provider: { readMessages: () => messages },
		historianModel: "test/model",
		historianChunkTokens: 20_000,
		historianContextLimit: 200_000,
		compartmentLeaseHolderId: "holder",
		ensureProjectRegistered: () => {},
		retryBackoffMs: () => 0,
		temperature: 0,
	};
}

type Step =
	| "valid"
	| "invalid"
	| "error"
	| "timeout"
	| "post-stop-abort"
	| "drain";
function fixture(
	Runner: typeof PiSubagentRunner,
	steps: Step[],
	controller: AbortController,
	harness: "pi" | "omp",
) {
	const calls: Array<{
		args: string[];
		system: string;
		stdin: string;
		killed: boolean;
	}> = [];
	const spawn = ((
		_command: string,
		args: string[],
		options: childProcess.SpawnOptions,
	) => {
		const events = new EventEmitter();
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const item = {
			args: args.map((arg) =>
				arg.includes("mc-pi-prompt-") ? "<prompt-file>" : arg,
			),
			system: readFileSync(
				options.env?.MAGIC_CONTEXT_SUBAGENT_PROMPT_FILE ?? "",
				"utf8",
			),
			stdin: "",
			killed: false,
		};
		calls.push(item);
		stdin.on("data", (data) => {
			item.stdin += String(data);
		});
		let exitCode: number | null = null;
		const finish = (code: number) => {
			if (exitCode !== null) return;
			exitCode = code;
			stdout.end();
			stderr.end();
			events.emit("exit", code, null);
			events.emit("close", code, null);
		};
		const child = {
			pid: 800 + calls.length,
			stdin,
			stdout,
			stderr,
			get killed() {
				return item.killed;
			},
			get exitCode() {
				return exitCode;
			},
			signalCode: null,
			on: events.on.bind(events),
			once: events.once.bind(events),
			kill: () => {
				item.killed = true;
				finish(0);
				return true;
			},
		};
		const step = steps.shift() ?? "invalid";
		setImmediate(() => {
			if (step === "timeout") return;
			if (step === "error") {
				stderr.write("provider refused request");
				finish(1);
				return;
			}
			const message = {
				role: "assistant",
				content: [{ type: "text", text: step === "invalid" ? "not XML" : xml }],
				stopReason: "stop",
				provider: "test",
				model: "model",
				usage: { input: 10, output: 5, totalTokens: 15 },
			};
			stdout.write(
				`${JSON.stringify({ type: "message_end", message })}\n${JSON.stringify({ type: "agent_end", messages: [message] })}\n`,
			);
			if (step === "post-stop-abort") {
				setTimeout(() => controller.abort(), 2);
				setTimeout(() => finish(0), 6);
			} else if (step !== "drain") finish(0);
		});
		return child;
	}) as unknown as typeof childProcess.spawn;
	return {
		calls,
		runner: new Runner({
			invocation: {
				command: "fixture-pi",
				prefixArgs: [],
				targetHarness: harness,
			},
			spawnImpl: spawn,
			subagentExtensions: ["/fixture/subagent-entry.js"],
		}),
	};
}

// Compare every table, preserving payloads and references; only independently allocated
// identities and wall-clock/elapsed measurements are canonicalized between the two runs.
function snapshot(db: Db) {
	const uuidMap = new Map<string, string>();
	const normalize = (value: unknown, key = ""): unknown => {
		if (
			value !== null &&
			/(_at$|At$|^(duration_ms|elapsed_ms|timestamp)$)/.test(key)
		)
			return "<time>";
		if (key === "generation" && typeof value === "string")
			return "<generation>";
		if (
			typeof value === "string" &&
			(value.startsWith("{") || value.startsWith("["))
		) {
			try {
				return normalize(JSON.parse(value));
			} catch {
				/* XML and prompt strings are compared verbatim. */
			}
		}
		if (typeof value === "string")
			return value.replace(
				/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
				(uuid) => {
					if (!uuidMap.has(uuid)) uuidMap.set(uuid, `uuid-${uuidMap.size}`);
					return uuidMap.get(uuid) ?? uuid;
				},
			);
		if (Array.isArray(value)) return value.map((item) => normalize(item));
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, normalize(v, k)]),
			);
		return value;
	};
	const tables = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all() as Array<{ name: string }>;
	return Object.fromEntries(
		tables.map(({ name }) => [
			name,
			normalize(
				db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
			),
		]),
	);
}

function rpcHarness(holdSecond = false) {
	const prompts: string[] = [];
	let kills = 0;
	let releaseSecond: () => void = () => {};
	let secondStartedResolve: () => void = () => {};
	const secondStarted = new Promise<void>((resolve) => {
		secondStartedResolve = resolve;
	});
	const spawn = ((
		_command: string,
		_args: string[],
		_options: childProcess.SpawnOptions,
	) => {
		const events = new EventEmitter();
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		let exitCode: number | null = null;
		const child = {
			pid: 901,
			stdin,
			stdout,
			stderr,
			get killed() {
				return exitCode !== null;
			},
			get exitCode() {
				return exitCode;
			},
			signalCode: null,
			on: events.on.bind(events),
			once: events.once.bind(events),
			kill: () => {
				if (exitCode === null) {
					kills++;
					exitCode = 0;
					stdout.end();
					stderr.end();
					events.emit("close", 0, null);
				}
				return true;
			},
		};
		stdin.on("data", (data) => {
			for (const line of String(data).trim().split("\n")) {
				const prompt = JSON.parse(line) as { type: string; id: string };
				if (prompt.type !== "prompt") continue;
				prompts.push(prompt.id);
				const first = prompts.length === 1;
				const emit = () => {
					if (exitCode !== null) return;
					const message = {
						role: "assistant",
						content: [
							{
								type: "text",
								text: first
									? xml
									: JSON.stringify({
											result: {
												step: "turn_two",
												decisions: [
													{
														fact_id: 1,
														check: "Audit fixture.",
														action: "new",
													},
												],
											},
										}),
							},
						],
						stopReason: "stop",
						provider: "test",
						model: "model",
					};
					stdout.write(
						`${JSON.stringify({ type: "message_end", message })}\n${JSON.stringify({ type: "agent_end", messages: [message] })}\n`,
					);
				};
				if (!first) secondStartedResolve();
				if (!first && holdSecond) releaseSecond = emit;
				else setTimeout(emit, 10);
			}
		});
		return child;
	}) as unknown as typeof childProcess.spawn;
	return {
		prompts,
		secondStarted,
		releaseSecond: () => releaseSecond(),
		get kills() {
			return kills;
		},
		runner: new PiSubagentRunner({
			invocation: {
				command: "fixture-pi",
				prefixArgs: [],
				targetHarness: "pi",
			},
			spawnImpl: spawn,
			subagentExtensions: ["/fixture/subagent-entry.js"],
		}),
	};
}

describe.skipIf(!enabled)("S8 independent review", () => {
	function publication(db: Db, facts = true) {
		const send = allocateTurnOneSend(db, {
			projectPath,
			sessionId: "ses-review",
			harness: "pi",
			carrier: PI_RPC_CARRIER,
			lane: "enabled",
			chunkStart: 1,
			chunkEnd: 2,
		});
		authorization.persist(db, send.stageKey);
		db.transaction(() =>
			commitTurnOnePublication(db, {
				send,
				projectPath,
				sessionId: "ses-review",
				compartments: [
					{
						id: 1,
						startMessage: 1,
						endMessage: 2,
						replyStartMessage: 1,
						replyEndMessage: 2,
					},
				],
				blocks: [
					{
						role: "user",
						startOrdinal: 1,
						endOrdinal: 1,
						parts: ["New rule."],
					},
				],
				candidateFacts: facts
					? [
							{
								category: "CONSTRAINTS",
								content: "New rule.",
								anchor: { compartmentIndex: 1, startOrdinal: 1, endOrdinal: 1 },
							},
						]
					: [],
				honourAnchors: true,
			}),
		)();
		return send;
	}
	let baselineHistorian: typeof runPiHistorian;
	let BaselineRunner: typeof PiSubagentRunner;
	const generated: string[] = [];
	beforeAll(async () => {
		for (const file of ["pi-historian-runner", "subagent-runner"]) {
			const path = fileURLToPath(
				new URL(`.s8-baseline-${file}-${process.pid}.ts`, import.meta.url),
			);
			writeFileSync(
				path,
				childProcess.execFileSync(
					"git",
					// Baseline: these files as they were immediately before the Pi turn-two
					// parity change merged (158074fac812). The change's original base is older
					// and lacks the fallback/session-fallback accounting task that the merged
					// code records, so comparing against it would flag that unrelated column.
					["show", `158074fac812:packages/pi-plugin/src/${file}.ts`],
					{ encoding: "utf8" },
				),
			);
			generated.push(path);
		}
		baselineHistorian = (await import(generated[0])).runPiHistorian;
		BaselineRunner = (await import(generated[1])).PiSubagentRunner;
	});
	afterAll(async () => {
		await settlePiHistorianTurnTwoRuns();
		for (const file of generated) unlinkSync(file);
		closeDatabase();
	});

	it("dormant randomized differential preserves Pi and OMP prompts, outcomes, cleanup and all store tables", async () => {
		let seed = 0x58c670ac;
		const rand = () => {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			return seed >>> 0;
		};
		const plans: Step[][] = [
			["valid"],
			["invalid", "invalid"],
			["timeout", "valid"],
			["post-stop-abort"],
			["error", "valid"],
			["invalid", "invalid", "valid"],
			["valid", "invalid"],
		];
		for (let i = 0; i < 43; i++) {
			const plan: Step[] = i === 42 ? ["drain"] : plans[i % plans.length];
			const twoPass = i % 7 === 6 || rand() % 3 === 0;
			const memoryEnabled = rand() % 4 !== 0;
			const autoPromote = rand() % 4 !== 0;
			const harness = i % 2 ? "omp" : "pi";
			const results = [];
			for (const [historian, Runner] of [
				[baselineHistorian, BaselineRunner],
				[runPiHistorian, PiSubagentRunner],
			] as const) {
				__setPiHarnessKindForTesting(harness);
				const testDataDir = createTestTempDirFromPath(
					join(tmpdir(), "mc-s8-differential-"),
				);
				const previousTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
				const previousXdgDataHome = process.env.XDG_DATA_HOME;
				closeDatabase();
				process.env.MAGIC_CONTEXT_TEST_DATA_DIR = testDataDir;
				process.env.XDG_DATA_HOME = testDataDir;
				// Use the singleton as the historian dependency too: the runner's
				// accounting writes must be part of the same compared store.
				const db = openDatabase();
				if (!db) throw new Error("Isolated accounting store did not open");
				await runMessageFtsRowidMapBackfill(db);
				const controller = new AbortController();
				const f = fixture(Runner, [...plan], controller, harness);
				let published = 0;
				try {
					insertMemory(db, {
						projectPath,
						category: "CONSTRAINTS",
						content: `Previously saved rule ${i}.`,
					});
					await historian({
						...deps(db, f.runner),
						memoryLifecycleLane: "dormant",
						twoPass,
						memoryEnabled,
						autoPromote,
						signal: controller.signal,
						historianTimeoutMs: 20,
						fallbackModels: ["test/fallback"],
						fallbackModelId: "test/session",
						onPublished: () => {
							published++;
						},
					});
					await settlePiHistorianTurnTwoRuns();
					results.push({ tables: snapshot(db), calls: f.calls, published });
				} finally {
					closeDatabase();
					if (previousTestDataDir === undefined)
						delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
					else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = previousTestDataDir;
					if (previousXdgDataHome === undefined)
						delete process.env.XDG_DATA_HOME;
					else process.env.XDG_DATA_HOME = previousXdgDataHome;
					cleanupTestTempDir(testDataDir);
					__setPiHarnessKindForTesting(undefined);
				}
			}
			expect(
				results[1],
				`seed=0x58c670ac case=${i} plan=${plan.join(",")} harness=${harness}`,
			).toEqual(results[0]);
		}
		console.log(
			"S8 differential: 43 paired runs, seed=0x58c670ac; 22 Pi + 21 OMP; every SQL table compared",
		);
	}, 60_000);

	it("own control: an idle retained child gives its next prompt a fresh deadline", async () => {
		const rpc = rpcHarness();
		const reply = await rpc.runner.runRetainedHistorian(
			{
				agent: "historian",
				model: "test/model",
				systemPrompt: "system",
				userMessage: "first",
				tokenBudget: 1000,
				timeoutMs: 50,
			},
			"first",
		);
		try {
			expect(reply.result.ok).toBe(true);
			await new Promise<void>((resolve) => setTimeout(resolve, 100));
			const next = await reply.child?.send("second", "second");
			expect(next?.ok).toBe(true);
			expect(rpc.prompts).toEqual(["first", "second"]);
			expect(rpc.kills).toBe(0);
		} finally {
			await reply.child?.close();
		}
	});

	it("own control: publication resolves before held reconciliation and releases caller lease", async () => {
		const db = createTestDb();
		const rpc = rpcHarness(true);
		let returned = false;
		const task = runPiHistorian({
			...deps(db, rpc.runner),
			memoryLifecycleLane: "enabled",
		}).then(() => {
			returned = true;
			db.prepare(
				"DELETE FROM compartment_state_lease WHERE session_id='ses-review'",
			).run();
		});
		try {
			await Promise.race([
				task,
				new Promise<void>((resolve) => setTimeout(resolve, 150)),
			]);
			expect(returned).toBe(true);
			expect(getCompartments(db, "ses-review")).toHaveLength(1);
			await rpc.secondStarted;
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM compartment_state_lease").get(),
			).toEqual({
				n: 0,
			});
			expect(rpc.kills).toBe(0);
		} finally {
			rpc.releaseSecond();
			await task;
			await settlePiHistorianTurnTwoRuns();
			closeQuietly(db);
		}
	});

	for (const action of ["retire", "promote_rule"] as const) {
		it(`witness: Pi turn two drops and logs ${action} without creating a proposal`, async () => {
			const db = createTestDb();
			const send = publication(db);
			const memory = insertMemory(db, {
				projectPath,
				category: "CONSTRAINTS",
				content: "An active rule.",
			});
			const logs: string[] = [];
			const child: PiRpcHistorianChild = {
				id: `review-${action}`,
				alive: true,
				close: async () => {},
				send: async () => ({
					ok: true,
					durationMs: 1,
					assistantText: JSON.stringify({
						result: {
							step: "turn_two",
							decisions: [
								{
									fact_id: 1,
									check: "Audit fixture.",
									action,
									target_id: memory.id,
								},
							],
						},
					}),
					meta: { reportedProvider: "test", reportedModel: "model" },
				}),
			};
			const runner: PiRpcHistorianRunner = {
				harness: "pi",
				canRetainHistorian: true,
				run: async () => {
					throw new Error("unused");
				},
				runRetainedHistorian: async () => {
					throw new Error("unused");
				},
			};
			try {
				schedulePiHistorianTurnTwo({
					formatInstructions: authorization.request.formatInstruction,
					db,
					projectPath,
					publicationId: send.publicationId,
					sessionId: "ses-review",
					child,
					runner,
					options: {
						agent: "historian",
						model: "test/model",
						systemPrompt: COMPARTMENT_AGENT_SYSTEM_PROMPT,
						userMessage: "first",
					},
					turnOneText: xml,
					memoryEnabled: true,
					autoPromote: true,
					validatedProfiles: authorization.rows,
					log: (line) => logs.push(line),
				});
				await settlePiHistorianTurnTwoRuns();
				expect(getMemoryById(db, memory.id)?.status).toBe("active");
				expect(
					db.prepare("SELECT COUNT(*) AS n FROM memory_tool_proposals").get(),
				).toEqual({ n: 0 });
				expect(logs.some((line) => line.includes(action))).toBe(true);
			} finally {
				await closeTurnTwoChild(child.id);
				closeQuietly(db);
			}
		});
	}

	it("witness: an old foreign RPC unknown outcome is bounded even while both PIDs live", async () => {
		const db = createTestDb();
		const original = publication(db);
		const foreignId = `pi-rpc:${process.ppid}:${process.pid}:foreign-idle`;
		try {
			const result = await runTurnTwo(db, {
				projectPath,
				publicationId: original.publicationId,
				sessionId: "ses-review",
				lane: "enabled",
				memoryEnabled: true,
				autoPromote: true,
				validatedProfiles: [],
				carrier: {
					carrier: PI_RPC_CARRIER,
					harness: "pi",
					enforcedJson: true,
					childSessionId: foreignId,
					send: async () => {
						throw new TurnTwoOutcomeUnknownError();
					},
					check: async () => {
						throw new Error("unused");
					},
				},
			});
			expect(result.childInFlight).toBe(true);
			db.prepare(
				"UPDATE memory_stage_attempts SET started_at=? WHERE stage='turn_two'",
			).run(Date.now() - TURN_TWO_UNREACHABLE_MAX_AGE_MS - 1);
			const runner: PiRpcHistorianRunner = {
				harness: "pi",
				canRetainHistorian: true,
				run: async () => {
					throw new Error("unused");
				},
				runRetainedHistorian: async () => {
					throw new Error("unused");
				},
			};
			for (let i = 0; i < 4; i++) {
				expect(recoverLostPiRpcStages(db)).toBe(0);
				const empty = publication(db, false);
				const child: PiRpcHistorianChild = {
					id: `review-foreign-${i}`,
					alive: true,
					close: async () => {},
					send: async () => {
						throw new Error("no new facts");
					},
				};
				schedulePiHistorianTurnTwo({
					db,
					projectPath,
					publicationId: empty.publicationId,
					sessionId: "ses-review",
					child,
					runner,
					options: {
						agent: "historian",
						model: "test/model",
						systemPrompt: "system",
						userMessage: "first",
					},
					turnOneText: xml,
					memoryEnabled: true,
					autoPromote: true,
					validatedProfiles: [],
					log: () => {},
				});
				await settlePiHistorianTurnTwoRuns();
			}
			expect(
				db.prepare("SELECT state FROM memory_pending_facts").get(),
			).not.toEqual({
				state: "in_flight",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("witness: a dead RPC stage cannot apply an edit after startup and next-run recovery release it", async () => {
		const db = createTestDb();
		const send = publication(db);
		const memory = insertMemory(db, {
			projectPath,
			category: "CONSTRAINTS",
			content: "Old rule. Keep rule.",
		});
		let alive = true;
		let unblock: () => void = () => {};
		let started: () => void = () => {};
		const waiting = new Promise<void>((resolve) => {
			started = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			unblock = resolve;
		});
		const child: PiRpcHistorianChild = {
			id: `pi-rpc:${process.pid}:0:review-race`,
			get alive() {
				return alive;
			},
			close: async () => {},
			send: async () => ({
				ok: true,
				durationMs: 1,
				assistantText: JSON.stringify({
					result: {
						step: "turn_two",
						decisions: [
							{
								fact_id: 1,
								check: "Audit fixture.",
								action: "edit",
								target_id: memory.id,
								revision: 1,
								removed: [],
								replaced: [
									{
										memory_id: memory.id,
										clause: 1,
										block: 1,
										excerpt: "New rule.",
									},
								],
								kept: [{ memory_id: memory.id, clause: 2 }],
								added: [{ text: "New rule. ", block: 1, excerpt: "New rule." }],
								final_text: "New rule. Keep rule.",
							},
						],
					},
				}),
				meta: { reportedProvider: "test", reportedModel: "model" },
			}),
		};
		const runner: PiRpcHistorianRunner = {
			harness: "pi",
			canRetainHistorian: true,
			run: async () => {
				throw new Error("no ordinary call");
			},
			runRetainedHistorian: async (options) => {
				started();
				await barrier;
				const ids = options.userMessage
					.split("\n\nInput:\n")[0]
					.split("\n")
					.filter((line) => line.startsWith("["))
					.map((line) =>
						options.systemPrompt === CHECK_SYSTEM_PROMPTS.compatibility
							? line
							: line.slice(0, line.indexOf("]: ") + 1),
					);
				return {
					child: null,
					result: {
						ok: true,
						durationMs: 1,
						assistantText: JSON.stringify({
							verdicts: ids.map((id) => ({
								id,
								verdict:
									options.systemPrompt === CHECK_SYSTEM_PROMPTS.disproof ||
									options.systemPrompt === CHECK_SYSTEM_PROMPTS.support
										? "yes"
										: "no",
							})),
						}),
						meta: { reportedProvider: "test", reportedModel: "model" },
					},
				};
			},
		};
		schedulePiHistorianTurnTwo({
			db,
			projectPath,
			publicationId: send.publicationId,
			sessionId: "ses-review",
			child,
			runner,
			options: {
				agent: "historian",
				model: "test/model",
				systemPrompt: COMPARTMENT_AGENT_SYSTEM_PROMPT,
				userMessage: "turn one",
				temperature: 0,
			},
			turnOneText: xml,
			memoryEnabled: true,
			autoPromote: true,
			log: () => {},
			validatedProfiles: authorization.rows,
			formatInstructions: authorization.request.formatInstruction,
		});
		try {
			await waiting;
			alive = false;
			expect(recoverLostPiRpcStages(db)).toBe(1);
			await runPiHistorian({ ...deps(db, runner), hasUI: false });
			expect(
				db
					.prepare("SELECT state,fact_attempts FROM memory_pending_facts")
					.get(),
			).toEqual({ state: "retryable", fact_attempts: 1 });
			expect(recoverLostPiRpcStages(db)).toBe(0);
			unblock();
			await settlePiHistorianTurnTwoRuns();
			expect(getMemoryById(db, memory.id)?.content).toBe(
				"Old rule. Keep rule.",
			);
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM memory_history").get(),
			).toEqual({ n: 0 });
		} finally {
			unblock();
			await settlePiHistorianTurnTwoRuns();
			await closeTurnTwoChild(child.id);
			closeQuietly(db);
		}
	});
});
