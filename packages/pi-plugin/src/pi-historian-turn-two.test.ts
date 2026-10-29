import { afterEach, describe, expect, it } from "bun:test";
import type * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { acquireCompartmentLease } from "@magic-context/core/features/magic-context/compartment-lease";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { CHECK_SCHEMA_CONTRACT } from "@magic-context/core/features/magic-context/memory/historian-schema";
import { CHECK_SYSTEM_PROMPTS } from "@magic-context/core/features/magic-context/memory/lifecycle-gates";
import { lifecycleTextHash } from "@magic-context/core/features/magic-context/memory/lifecycle-text";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	getMemoriesByProject,
	getMemoryById,
	insertMemory,
} from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	allocateTurnOneSend,
	commitTurnOnePublication,
	HISTORIAN_FORMAT_INSTRUCTION,
} from "@magic-context/core/features/magic-context/memory/turn-one-publication";
import {
	recoverTurnTwoStages,
	runTurnTwo,
	TurnTwoOutcomeUnknownError,
	type TurnTwoStageReply,
} from "@magic-context/core/features/magic-context/memory/turn-two";
import {
	lifecycleToolHash,
	matchesReportedProfile,
} from "@magic-context/core/features/magic-context/memory/turn-two-allowlist";
import identityVectors from "@magic-context/core/features/magic-context/memory/turn-two-identity-vectors.json";
import { authorizationFixture } from "@magic-context/core/features/magic-context/memory/turn-two-test-fixtures.test";
import { closeDatabase } from "@magic-context/core/features/magic-context/storage";
import { COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT } from "@magic-context/core/hooks/magic-context/compartment-prompt";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { type PiHistorianDeps, runPiHistorian } from "./pi-historian-runner";
import {
	createPiTurnTwoCarrier,
	PI_RPC_CARRIER,
	recoverLostPiRpcStages,
	settlePiHistorianTurnTwoRuns,
} from "./pi-historian-turn-two";
import { PiSubagentRunner } from "./subagent-runner";
import { createTestDb } from "./test-utils.test";

const projectPath = resolveProjectIdentity(process.cwd());
if (!projectPath)
	throw new Error("RPC parity tests require a project identity");
const xml =
	'<compartment start="1" end="2" title="Rule change"><p1>Updated the rule.</p1></compartment>\n<CONSTRAINTS>\n* [at_compartment=1 messages=1-1] New rule replaces the old one\n</CONSTRAINTS>';
const messages: RawMessage[] = Array.from({ length: 12 }, (_, index) => ({
	ordinal: index + 1,
	id: `m${index + 1}`,
	role: index % 2 ? "assistant" : "user",
	parts: [
		{ type: "text", text: index === 0 ? "New rule." : `Turn ${index + 1}` },
	],
}));

const combinedFixture = authorizationFixture(
	{
		lane: "pi",
		carrier: PI_RPC_CARRIER,
		provider: "test",
		modelId: "validated-model",
		variant: null,
		temperature: null,
		thinkingLevel: null,
	},
	COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT,
	[],
	HISTORIAN_FORMAT_INSTRUCTION,
);

type Prompt = { type: string; id: string; message: string };
function rpcFixture(
	reply: (prompt: Prompt, system: string, childIndex: number) => string,
	budgetGuardAvailable = true,
	toolMessages: unknown[] = [],
) {
	const children: Array<{
		args: string[];
		system: string;
		prompts: Prompt[];
		killed: boolean;
		emit: (text: string) => void;
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
		const promptFile = options.env?.MAGIC_CONTEXT_SUBAGENT_PROMPT_FILE;
		if (!promptFile)
			throw new Error("RPC fixture requires an explicit system prompt file");
		const system = readFileSync(promptFile, "utf8");
		const index = children.length;
		const item = {
			args,
			system,
			prompts: [] as Prompt[],
			killed: false,
			emit: (text: string) => {
				const message = {
					role: "assistant",
					content: [{ type: "text", text }],
					stopReason: "stop",
					provider: "test",
					model: "validated-model",
					usage: { input: 10, output: 5, totalTokens: 15 },
				};
				stdout.write(
					`${JSON.stringify({ type: "message_end", message })}\n${JSON.stringify({ type: "agent_end", messages: [...toolMessages, message] })}\n`,
				);
			},
		};
		children.push(item);
		let exitCode: number | null = null;
		const child = {
			pid: 42 + index,
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
				if (!item.killed) {
					item.killed = true;
					exitCode = 0;
					stdout.end();
					stderr.end();
					events.emit("close", 0, null);
				}
				return true;
			},
		};
		if (args.includes("rpc")) {
			stdin.on("data", (data) => {
				for (const line of String(data).trim().split("\n")) {
					const prompt = JSON.parse(line) as Prompt;
					item.prompts.push(prompt);
					if (prompt.type === "prompt")
						setImmediate(() => {
							if (!item.killed) {
								const text = reply(prompt, system, index);
								item.emit(
									prompt.message.includes(HISTORIAN_FORMAT_INSTRUCTION) &&
										text.trim().startsWith("<")
										? combinedFixture.turnOne(text)
										: text,
								);
							}
						});
				}
			});
		} else
			setImmediate(() => {
				item.emit(xml);
				child.kill();
			});
		return child;
	}) as unknown as typeof childProcess.spawn;
	return {
		children,
		runner: new PiSubagentRunner({
			invocation: {
				command: "fixture-pi",
				prefixArgs: [],
				targetHarness: "pi",
			},
			spawnImpl: spawn,
			subagentExtensions: ["/fixture/subagent-entry.js"],
			budgetGuardAvailable,
		}),
	};
}

function base(
	db: ReturnType<typeof createTestDb>,
	runner: PiHistorianDeps["runner"],
): PiHistorianDeps {
	expect(acquireCompartmentLease(db, "ses-rpc", "holder")).not.toBeNull();
	return {
		db,
		sessionId: "ses-rpc",
		directory: process.cwd(),
		provider: { readMessages: () => messages },
		runner,
		historianModel: "test/validated-model",
		historianChunkTokens: 20_000,
		historianContextLimit: 200_000,
		compartmentLeaseHolderId: "holder",
		ensureProjectRegistered: () => {},
		memoryLifecycleLane: "enabled",
		validatedProfiles: authorizationFixture(
			{
				lane: "pi",
				carrier: PI_RPC_CARRIER,
				provider: "test",
				modelId: "validated-model",
				variant: null,
				temperature: null,
				thinkingLevel: null,
			},
			COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT,
			[],
			HISTORIAN_FORMAT_INSTRUCTION,
		).rows,
		temperature: 0,
	};
}

afterEach(() => {
	closeDatabase();
	__setPiHarnessKindForTesting(undefined);
});

describe("Pi historian RPC parity", () => {
	it("Pi enabled parse failures send no repair and the fourth firing publishes dormant", async () => {
		const db = createTestDb();
		const f = rpcFixture(() => "invalid turn-one envelope");
		try {
			const deps = { ...base(db, f.runner), forceDrainQuota: true };
			for (let i = 1; i <= 3; i++) {
				await runPiHistorian(deps);
				expect(f.children).toHaveLength(i);
				expect(f.children.at(-1)?.prompts).toHaveLength(1);
				expect(getCompartments(db, "ses-rpc")).toEqual([]);
				expect(
					db.prepare("SELECT COUNT(*) AS n FROM memory_pending_facts").get(),
				).toEqual({ n: 0 });
			}
			await runPiHistorian(deps);
			expect(f.children).toHaveLength(4);
			expect(f.children[3]?.prompts).toHaveLength(0);
			expect(getCompartments(db, "ses-rpc")).toHaveLength(1);
			expect(
				db
					.prepare(
						"SELECT state,run_attempt FROM memory_stage_attempts WHERE publication_id LIKE 't1fail:%' ORDER BY run_attempt",
					)
					.all(),
			).toEqual([
				{ state: "parse_failed", run_attempt: 1 },
				{ state: "parse_failed", run_attempt: 2 },
				{ state: "parse_failed", run_attempt: 3 },
				{ state: "counter_reset", run_attempt: 4 },
			]);
		} finally {
			closeQuietly(db);
		}
	});
	it("Pi late reply after off applies nothing, charges nothing and releases once", async () => {
		const db = createTestDb();
		let enabled = true;
		const f = rpcFixture(() => {
			if (f.children[0]?.prompts.length === 1) return xml;
			enabled = false;
			const fact = db.prepare("SELECT id FROM memory_pending_facts").get() as {
				id: number;
			};
			return JSON.stringify({
				result: {
					step: "turn_two",
					decisions: [
						{ fact_id: fact.id, check: "Audit fixture.", action: "new" },
					],
				},
			});
		});
		try {
			await runPiHistorian({
				...base(db, f.runner),
				turnTwoIsEnabled: () => enabled,
			});
			await settlePiHistorianTurnTwoRuns();
			expect(getMemoriesByProject(db, projectPath)).toEqual([]);
			expect(
				db
					.prepare("SELECT state,fact_attempts FROM memory_pending_facts")
					.all(),
			).toEqual([{ state: "retryable", fact_attempts: 0 }]);
			expect(f.children).toHaveLength(1);
			expect(f.children[0]?.killed).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});
	for (const harness of ["pi", "omp"] as const) {
		it(`${harness} reports every C1 key without confusing configured thinking with variant`, async () => {
			__setPiHarnessKindForTesting(harness);
			const f = rpcFixture(() => '{"verdicts":[]}');
			const options = {
				agent: "historian",
				model: "test/validated-model",
				systemPrompt: "system",
				userMessage: "turn one",
				thinkingLevel: "high",
				temperature: 0.1,
				tokenBudget: 1_000_000,
				timeoutMs: 1000,
			};
			const first = await f.runner.runRetainedHistorian(options, "first");
			if (!first.child) throw new Error("expected retained child");
			try {
				const carrier = createPiTurnTwoCarrier({
					child: first.child,
					runner: f.runner,
					options,
					turnOneText: first.result.ok ? first.result.assistantText : "",
					formatInstructions: "format\n",
				});
				expect(carrier.harness).toBe(harness);
				expect(carrier.variant).toBeNull();
				const reply = await carrier.send("turn two", "second");
				const profile = {
					lane: harness,
					carrier: PI_RPC_CARRIER,
					provider: "test",
					modelId: "validated-model",
					variant: null,
					temperature: null,
					thinkingLevel: null,
					systemHash: lifecycleTextHash("system"),
					schemaHash: lifecycleTextHash("format\n"),
					toolHash: lifecycleToolHash([]),
				};
				expect(reply.profile).toEqual(profile);
				expect(matchesReportedProfile(reply.profile, profile)).toBe(true);
				expect(
					matchesReportedProfile(
						{ ...reply.profile, lane: harness === "pi" ? "omp" : "pi" },
						profile,
					),
				).toBe(false);
				const check = await carrier.check({
					key: "check",
					kind: "support",
					system: "check system",
					systemHash: "stale caller hash",
					operands: [],
					pairs: [],
					input: "input",
				});
				expect(check.profile).toEqual({
					...profile,
					systemHash: lifecycleTextHash("check system"),
					schemaHash: lifecycleTextHash(CHECK_SCHEMA_CONTRACT),
				});
				expect(check.profile.toolHash).toBe(
					identityVectors.toolHashes.find((vector) =>
						vector.carriers?.includes(PI_RPC_CARRIER),
					)?.sha256,
				);
				for (const child of f.children)
					expect(child.args).toContain("--no-tools");
			} finally {
				await first.child.close();
			}
		});
	}

	it("Pi RPC prefix uses the same child with spawn-fixed system and tools and never rewrites raw history", async () => {
		const format =
			"Return JSON with result.step and result.xml or result.decisions.\n";
		const raw =
			' \n{ "result": { "xml": "<compartments>raw\\nreply</compartments>", "step": "turn_one" } }\n';
		const f = rpcFixture((prompt) =>
			prompt.id === "one"
				? raw
				: '{"result":{"step":"turn_two","decisions":[]}}',
		);
		const options = {
			agent: "historian",
			systemPrompt: `system\n${format}`,
			userMessage: `${format}turn one`,
			model: "test/validated-model",
			tokenBudget: 1_000_000,
			timeoutMs: 1000,
		};
		const first = await f.runner.runRetainedHistorian(options, "one");
		if (!first.child || !first.result.ok)
			throw new Error("expected retained child");
		try {
			expect(first.result.assistantText).toBe(raw);
			const child = f.children[0];
			if (!child) throw new Error("expected spawned child");
			const spawn = JSON.stringify({ args: child.args, system: child.system });
			const prefix = child.prompts
				.map((prompt) => `${JSON.stringify(prompt)}\n`)
				.join("");
			const carrier = createPiTurnTwoCarrier({
				child: first.child,
				runner: f.runner,
				options,
				turnOneText: raw,
				formatInstructions: format,
			});
			await carrier.send(`${format}turn two`, "two");
			expect(f.children).toHaveLength(1);
			expect(JSON.stringify({ args: child.args, system: child.system })).toBe(
				spawn,
			);
			expect(child.system).toBe(options.systemPrompt);
			expect(child.args).toContain("--no-tools");
			expect(
				child.prompts
					.map((prompt) => `${JSON.stringify(prompt)}\n`)
					.join("")
					.startsWith(prefix),
			).toBe(true);
			expect(child.prompts).toEqual([
				{ type: "prompt", id: "one", message: options.userMessage },
				{ type: "prompt", id: "two", message: `${format}turn two` },
			]);
			expect(carrier.baseline).toBe(lifecycleTextHash(raw));
		} finally {
			await first.child.close();
		}
	});
	it("Pi RPC carries tool-result contamination even when followed by a valid wrapper", async () => {
		const wrapped = '{"result":{"step":"turn_two","decisions":[]}}';
		const f = rpcFixture(() => wrapped, true, [
			{ role: "toolResult", content: "blocked read" },
		]);
		const options = {
			agent: "historian",
			systemPrompt: "contract",
			userMessage: "first",
			model: "test/validated-model",
			tokenBudget: 1_000_000,
			timeoutMs: 1000,
		};
		const first = await f.runner.runRetainedHistorian(options, "turn-one");
		if (!first.child) throw new Error("expected retained child");
		try {
			expect(first.result.meta?.toolActivity).toBe(true);
			const carrier = createPiTurnTwoCarrier({
				child: first.child,
				runner: f.runner,
				options,
				turnOneText: wrapped,
			});
			expect(await carrier.send("second", "turn-two")).toMatchObject({
				text: wrapped,
				toolActivity: true,
			});
		} finally {
			await first.child.close();
		}
	});
	it("Pi RPC serialized requests stay prompt-only and recovery reuses the recorded reply without a send", async () => {
		const db = createTestDb();
		const authorization = authorizationFixture(
			{
				lane: "pi",
				carrier: "pi-historian-rpc",
				provider: "test",
				modelId: "validated-model",
				variant: null,
				temperature: null,
				thinkingLevel: null,
			},
			"combined prompt contract",
			[],
		);
		const wrapped =
			' \n{"result":{"step":"turn_two","decisions":[{"fact_id":1,"check":"Audit fixture.","action":"new"}]}}\n';
		const f = rpcFixture((prompt) =>
			prompt.id === "turn-one-key" ? "turn one raw reply" : wrapped,
		);
		const options = {
			agent: "historian",
			systemPrompt: "combined prompt contract",
			userMessage: "turn one",
			model: "test/validated-model",
			tokenBudget: 1_000_000,
			timeoutMs: 1000,
		};
		const first = await f.runner.runRetainedHistorian(options, "turn-one-key");
		if (!first.child) throw new Error("expected retained child");
		try {
			const send = allocateTurnOneSend(db, {
				projectPath,
				sessionId: "ses-wire",
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
					sessionId: "ses-wire",
					compartments: [],
					blocks: [],
					candidateFacts: [
						{ category: "CONSTRAINTS", content: "Keep the wire." },
					],
					honourAnchors: true,
				}),
			)();
			const carrier = createPiTurnTwoCarrier({
				formatInstructions: authorization.request.formatInstruction,
				child: first.child,
				runner: f.runner,
				options,
				turnOneText: "turn one raw reply",
			});
			let reply: TurnTwoStageReply | undefined;
			const stage = await runTurnTwo(db, {
				projectPath,
				publicationId: send.publicationId,
				sessionId: "ses-wire",
				lane: "enabled",
				memoryEnabled: true,
				autoPromote: true,
				validatedProfiles: authorization.rows,
				carrier: {
					...carrier,
					send: async (prompt, key) => {
						reply = await carrier.send(prompt, key);
						throw new TurnTwoOutcomeUnknownError();
					},
				},
			});
			expect(stage.status).toBe("in_flight");
			expect(reply?.text).toBe(wrapped);
			const wire = JSON.stringify(
				f.children.map((child) => ({
					system: child.system,
					args: child.args,
					prompts: child.prompts,
				})),
			);
			for (const key of [
				"response_schema",
				"responseSchema",
				"response_format",
				"tool_choice",
				"toolChoice",
				"StructuredOutput",
				"capture",
			])
				expect(wire).not.toContain(key);
			expect(f.children).toHaveLength(1);
			expect(f.children[0]!.args).toContain("--no-tools");
			expect(
				f.children[0]!.prompts.filter((prompt) => prompt.type === "prompt"),
			).toHaveLength(2);
			await recoverTurnTwoStages(db, {
				projectPath,
				memoryEnabled: true,
				autoPromote: true,
				validatedProfiles: authorization.rows,
				resolver: (record) => {
					expect(record.stageKey).toBe(stage.stageKey!);
					return {
						check: carrier.check,
						reattach: async () => ({ kind: "reply", reply: reply! }),
					};
				},
			});
			expect(
				db
					.prepare("SELECT state,fact_attempts FROM memory_pending_facts")
					.get(),
			).toEqual({ state: "applied", fact_attempts: 0 });
			expect(
				JSON.stringify(
					f.children.map((child) => ({
						system: child.system,
						args: child.args,
						prompts: child.prompts,
					})),
				),
			).toBe(wire);
		} finally {
			await first.child.close();
			closeQuietly(db);
		}
	});
	it("suppresses the turn-one drain timer and continues on the same RPC child with a distinct stage key", async () => {
		const f = rpcFixture((prompt) =>
			prompt.id === "turn-one-key" ? "first reply" : "second reply",
		);
		const options = {
			agent: "historian",
			systemPrompt: "system",
			userMessage: "first",
			model: "test/validated-model",
			tokenBudget: 1_000_000,
			timeoutMs: 1_000,
		};
		const { result, child } = await f.runner.runRetainedHistorian(
			options,
			"turn-one-key",
		);
		try {
			expect(result.ok).toBe(true);
			expect(child).not.toBeNull();
			await new Promise<void>((resolve) => setTimeout(resolve, 2_150));
			expect(f.children[0]?.killed).toBe(false);
			const second = await child?.send("second", "turn-two-key");
			expect(second).toMatchObject({
				ok: true,
				assistantText: "second reply",
				meta: { reportedProvider: "test", reportedModel: "validated-model" },
			});
			await new Promise<void>((resolve) => setTimeout(resolve, 1_050));
			expect(f.children[0]?.killed).toBe(false);
			expect(f.children).toHaveLength(1);
			expect(f.children[0]?.prompts).toEqual([
				{ type: "prompt", id: "turn-one-key", message: "first" },
				{ type: "prompt", id: "turn-two-key", message: "second" },
			]);
		} finally {
			await child?.close();
		}
		expect(f.children[0]?.killed).toBe(true);
	});

	it("publishes anchored facts then applies a gated edit and history through RPC with four isolated checks", async () => {
		const db = createTestDb();
		const memory = insertMemory(db, {
			projectPath,
			category: "CONSTRAINTS",
			content: "Old rule. Keep rule.",
		});
		const f = rpcFixture((prompt, system, index) => {
			if (index === 0 && f.children[0]?.prompts.length === 1) return xml;
			if (index === 0) {
				expect(getCompartments(db, "ses-rpc")).toHaveLength(1);
				expect(f.children[0]?.killed).toBe(false);
				const fact = db
					.prepare("SELECT id,state FROM memory_pending_facts")
					.get() as { id: number; state: string };
				expect(fact.state).toBe("in_flight");
				return JSON.stringify({
					result: {
						step: "turn_two",
						decisions: [
							{
								fact_id: fact.id,
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
				});
			}
			expect(f.children[0]?.killed).toBe(false);
			expect(prompt.message).not.toContain("<new_messages>");
			const operands = (prompt.message.split("\n\nInput:\n")[0] ?? "")
				.split("\n")
				.filter((line) => line.startsWith("["));
			const ids = operands.map((line) =>
				system === CHECK_SYSTEM_PROMPTS.compatibility
					? line
					: line.slice(0, line.indexOf("]: ") + 1),
			);
			return JSON.stringify({
				verdicts: ids.map((id) => ({
					id,
					verdict:
						system === CHECK_SYSTEM_PROMPTS.disproof ||
						system === CHECK_SYSTEM_PROMPTS.support
							? "yes"
							: "no",
				})),
			});
		});
		try {
			const deps = base(db, f.runner);
			await runPiHistorian(deps);
			await settlePiHistorianTurnTwoRuns();
			expect(getMemoryById(db, memory.id)?.content).toBe(
				"New rule. Keep rule.",
			);
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM memory_history").get(),
			).toEqual({ n: 1 });
			expect(
				db
					.prepare(
						"SELECT state,fact_attempts,anchor_known FROM memory_pending_facts",
					)
					.get(),
			).toEqual({ state: "applied", fact_attempts: 0, anchor_known: 1 });
			expect(f.children).toHaveLength(5);
			expect(f.children[0]?.prompts).toHaveLength(2);
			expect(f.children[0]?.prompts[0]?.message).not.toContain("Old rule.");
			expect(f.children[0]?.prompts[0]?.id).not.toBe(
				f.children[0]?.prompts[1]?.id,
			);
			expect(
				f.children
					.slice(1)
					.map((child) => child.system)
					.sort(),
			).toEqual(Object.values(CHECK_SYSTEM_PROMPTS).sort());
			expect(f.children.every((child) => child.killed)).toBe(true);
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM memory_check_attempts").get(),
			).toEqual({ n: 4 });
		} finally {
			for (const child of f.children) expect(child.killed).toBe(true);
			closeQuietly(db);
		}
	});

	it("without RPC remains dormant and promotes through the applier with no candidates", async () => {
		const db = createTestDb();
		const runner = {
			harness: "pi" as const,
			run: async () => ({
				ok: true as const,
				assistantText: xml,
				durationMs: 1,
			}),
		};
		const memory = insertMemory(db, {
			projectPath,
			category: "CONSTRAINTS",
			content: "New rule replaces the old one",
		});
		try {
			await runPiHistorian(base(db, runner));
			expect(getMemoriesByProject(db, projectPath)).toHaveLength(1);
			expect(getMemoryById(db, memory.id)?.seenCount).toBe(2);
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM memory_pending_facts").get(),
			).toEqual({ n: 0 });
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM memory_decision_receipts").get(),
			).toEqual({ n: 1 });
		} finally {
			closeQuietly(db);
		}
	});

	it("a rejected editor keeps the validated draft child for turn two", async () => {
		const db = createTestDb();
		const f = rpcFixture((_prompt, _system, index) => {
			if (index === 1) return "invalid editor output";
			if (f.children[0]?.prompts.length === 1) return xml;
			expect(f.children[1]?.killed).toBe(true);
			const fact = db.prepare("SELECT id FROM memory_pending_facts").get() as {
				id: number;
			};
			return JSON.stringify({
				result: {
					step: "turn_two",
					decisions: [
						{ fact_id: fact.id, check: "Audit fixture.", action: "new" },
					],
				},
			});
		});
		try {
			await runPiHistorian({ ...base(db, f.runner), twoPass: true });
			await settlePiHistorianTurnTwoRuns();
			expect(f.children).toHaveLength(2);
			expect(f.children[0]?.prompts).toHaveLength(2);
			expect(f.children[1]?.prompts).toHaveLength(1);
			expect(f.children.every((child) => child.killed)).toBe(true);
			expect(getMemoriesByProject(db, projectPath)).toHaveLength(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("headless runs dormant and publishes compartments without a second turn", async () => {
		const db = createTestDb();
		const f = rpcFixture(() => xml);
		try {
			await runPiHistorian({ ...base(db, f.runner), hasUI: false });
			expect(f.children).toHaveLength(1);
			expect(f.children[0]?.prompts).toHaveLength(0);
			expect(getCompartments(db, "ses-rpc")).toHaveLength(1);
			expect(getMemoriesByProject(db, projectPath)).toHaveLength(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("without the budget guard remains dormant and promotes through the applier", async () => {
		const db = createTestDb();
		const f = rpcFixture(() => xml, false);
		try {
			expect(f.runner.canRetainHistorian).toBe(false);
			await runPiHistorian(base(db, f.runner));
			expect(f.children).toHaveLength(1);
			expect(f.children[0]?.args).not.toContain("rpc");
			expect(f.children[0]?.prompts).toHaveLength(0);
			expect(getMemoriesByProject(db, projectPath)).toHaveLength(1);
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM memory_pending_facts").get(),
			).toEqual({ n: 0 });
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM memory_decision_receipts").get(),
			).toEqual({ n: 1 });
		} finally {
			closeQuietly(db);
		}
	});

	for (const recoverAt of ["process start", "next run"] as const) {
		it(`lost RPC carrier releases reservations once with +1 at ${recoverAt}, including the attempt cap`, async () => {
			const db = createTestDb();
			try {
				const send = allocateTurnOneSend(db, {
					projectPath,
					sessionId: "ses-lost",
					harness: "pi",
					carrier: PI_RPC_CARRIER,
					lane: "enabled",
					chunkStart: 1,
					chunkEnd: 2,
				});
				db.transaction(() =>
					commitTurnOnePublication(db, {
						send,
						projectPath,
						sessionId: "ses-lost",
						compartments: [],
						blocks: [],
						candidateFacts: [
							{ category: "CONSTRAINTS", content: "Keep the retry." },
							{ category: "CONSTRAINTS", content: "Capped retry." },
						],
						honourAnchors: true,
					}),
				)();
				db.prepare(
					"UPDATE memory_pending_facts SET fact_attempts=2 WHERE fact_index=1",
				).run();
				await runTurnTwo(db, {
					projectPath,
					publicationId: send.publicationId,
					sessionId: "ses-lost",
					lane: "enabled",
					memoryEnabled: true,
					autoPromote: true,
					validatedProfiles: [],
					carrier: {
						carrier: PI_RPC_CARRIER,
						harness: "pi",
						enforcedJson: true,
						childSessionId: `pi-rpc:${process.pid}:0:lost`,
						send: async () => {
							throw new TurnTwoOutcomeUnknownError();
						},
						check: async () => {
							throw new Error("no check");
						},
					},
				});
				expect(
					db
						.prepare(
							"SELECT state,fact_attempts FROM memory_pending_facts ORDER BY id",
						)
						.all(),
				).toEqual([
					{ state: "in_flight", fact_attempts: 0 },
					{ state: "in_flight", fact_attempts: 2 },
				]);
				// A reply recorded before a crash still belongs to the lost RPC stage.
				db.prepare(
					"UPDATE memory_stage_attempts SET state='replied',reply_json=? WHERE stage='turn_two'",
				).run(
					JSON.stringify({ text: "{}", lengthCapped: false, profile: null }),
				);
				if (recoverAt === "process start")
					expect(recoverLostPiRpcStages(db)).toBe(2);
				else
					await runPiHistorian({
						...base(
							db,
							rpcFixture(() => {
								throw new Error("empty session must not dispatch");
							}).runner,
						),
						provider: { readMessages: () => [] },
					});
				expect(
					db
						.prepare(
							"SELECT state,fact_attempts,reason,reserved_stage_key FROM memory_pending_facts ORDER BY id",
						)
						.all(),
				).toEqual([
					{
						state: "retryable",
						fact_attempts: 1,
						reason: "carrier_lost",
						reserved_stage_key: null,
					},
					{
						state: "decided_pending",
						fact_attempts: 3,
						reason: "carrier_lost",
						reserved_stage_key: null,
					},
				]);
				expect(recoverLostPiRpcStages(db)).toBe(0);
				expect(
					db
						.prepare(
							"SELECT state FROM memory_stage_attempts WHERE stage='turn_two'",
						)
						.get(),
				).toEqual({ state: "lost" });
				expect(getMemoriesByProject(db, projectPath)).toHaveLength(0);
			} finally {
				closeQuietly(db);
			}
		});
	}

	it("recovery leaves a live foreign RPC process and other carriers in flight", async () => {
		const db = createTestDb();
		try {
			const send = allocateTurnOneSend(db, {
				projectPath,
				sessionId: "ses-live",
				harness: "pi",
				carrier: PI_RPC_CARRIER,
				lane: "enabled",
				chunkStart: 1,
				chunkEnd: 2,
			});
			db.transaction(() =>
				commitTurnOnePublication(db, {
					send,
					projectPath,
					sessionId: "ses-live",
					compartments: [],
					blocks: [],
					candidateFacts: [
						{ category: "CONSTRAINTS", content: "Live reservation." },
					],
					honourAnchors: true,
				}),
			)();
			await runTurnTwo(db, {
				projectPath,
				publicationId: send.publicationId,
				sessionId: "ses-live",
				lane: "enabled",
				memoryEnabled: true,
				autoPromote: true,
				validatedProfiles: [],
				carrier: {
					carrier: PI_RPC_CARRIER,
					harness: "pi",
					enforcedJson: true,
					childSessionId: `pi-rpc:${process.ppid}:${process.pid}:live`,
					send: async () => {
						throw new TurnTwoOutcomeUnknownError();
					},
					check: async () => {
						throw new Error("no check");
					},
				},
			});
			expect(recoverLostPiRpcStages(db)).toBe(0);
			db.prepare(
				"UPDATE memory_stage_attempts SET carrier='opencode-host',child_session_id='missing' WHERE stage='turn_two'",
			).run();
			expect(recoverLostPiRpcStages(db)).toBe(0);
			expect(
				db
					.prepare("SELECT state,fact_attempts FROM memory_pending_facts")
					.get(),
			).toEqual({ state: "in_flight", fact_attempts: 0 });
		} finally {
			closeQuietly(db);
		}
	});
});
