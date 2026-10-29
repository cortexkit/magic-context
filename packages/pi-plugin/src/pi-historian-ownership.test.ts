import { describe, expect, it } from "bun:test";
import {
	MemoryStageOwnershipLostError,
	releaseMemoryReservations,
} from "@magic-context/core/features/magic-context/memory/lifecycle-applier";
import {
	CHECK_SYSTEM_PROMPTS,
	type CheckReply,
	type CheckRequest,
} from "@magic-context/core/features/magic-context/memory/lifecycle-gates";
import { lifecycleTextHash } from "@magic-context/core/features/magic-context/memory/lifecycle-text";
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
import { authorizationFixture } from "@magic-context/core/features/magic-context/memory/turn-two-test-fixtures.test";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { SubagentRunResult } from "@magic-context/core/shared/subagent-runner";
import {
	createPiTurnTwoCarrier,
	PI_RPC_CARRIER,
	PI_RPC_STAGE_LEASE_MS,
	recoverLostPiRpcStages,
	schedulePiHistorianTurnTwo,
	settlePiHistorianTurnTwoRuns,
} from "./pi-historian-turn-two";
import type {
	PiRpcHistorianChild,
	PiRpcHistorianRunner,
} from "./subagent-runner";
import { createTestDb } from "./test-utils.test";

const projectPath = "dir:/s8-ownership";
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
	"historian system",
	[],
);
const profile = authorization.profile;
const validatedProfiles = authorization.rows;

function publication(db: ReturnType<typeof createTestDb>) {
	const send = allocateTurnOneSend(db, {
		projectPath,
		sessionId: "ses-fence",
		harness: "opencode",
		carrier: "test",
		lane: "enabled",
		chunkStart: 1,
		chunkEnd: 2,
	});
	authorization.persist(db, send.stageKey);
	db.transaction(() =>
		commitTurnOnePublication(db, {
			send,
			projectPath,
			sessionId: "ses-fence",
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
				{ startOrdinal: 1, endOrdinal: 1, role: "user", parts: ["New rule."] },
			],
			candidateFacts: [
				{
					category: "CONSTRAINTS",
					content: "New rule replaces the old one",
					anchor: { compartmentIndex: 1, startOrdinal: 1, endOrdinal: 1 },
				},
			],
			honourAnchors: true,
		}),
	)();
	return send;
}

describe("historian resolving ownership", () => {
	for (const release of ["stage", "fact"] as const) {
		it(`resolving transaction refuses a checked edit after ${release} ownership is released`, async () => {
			const db = createTestDb();
			const send = publication(db);
			const memory = insertMemory(db, {
				projectPath,
				category: "CONSTRAINTS",
				content: "Old rule. Keep rule.",
			});
			let resume = () => {};
			let started = () => {};
			const barrier = new Promise<void>((resolve) => {
				resume = resolve;
			});
			const waiting = new Promise<void>((resolve) => {
				started = resolve;
			});
			let stageKey = "";
			const run = runTurnTwo(db, {
				projectPath,
				publicationId: send.publicationId,
				sessionId: "ses-fence",
				lane: "enabled",
				memoryEnabled: true,
				autoPromote: true,
				validatedProfiles,
				carrier: {
					carrier: "test",
					harness: "opencode",
					enforcedJson: true,
					childSessionId: "child-fence",
					send: async (_prompt, key) => {
						stageKey = key;
						return {
							text: JSON.stringify({
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
											added: [
												{ text: "New rule. ", block: 1, excerpt: "New rule." },
											],
											final_text: "New rule. Keep rule.",
										},
									],
								},
							}),
							lengthCapped: false,
							profile,
						};
					},
					check: async (request): Promise<CheckReply> => {
						started();
						await barrier;
						return {
							verdicts: (request.kind === "compatibility"
								? request.pairs
								: request.operands
							).map((operand) => ({
								id: operand.id,
								verdict:
									request.kind === "disproof" || request.kind === "support"
										? "yes"
										: "no",
							})),
							profile: authorization.checkProfile(request.systemHash),
							usage: null,
						};
					},
				},
			}).then(
				(result) => ({ result, error: null }),
				(error: unknown) => ({ result: null, error }),
			);
			try {
				await waiting;
				if (release === "stage")
					db.prepare(
						"UPDATE memory_stage_attempts SET state='lost' WHERE stage_key=?",
					).run(stageKey);
				else releaseMemoryReservations(db, ["ses-fence"], "opencode");
				const before = db
					.prepare(
						"SELECT state,fact_attempts,reserved_stage_key FROM memory_pending_facts",
					)
					.get();
				resume();
				const outcome = await run;
				expect(outcome.error).toBeInstanceOf(MemoryStageOwnershipLostError);
				expect(getMemoryById(db, memory.id)?.content).toBe(
					"Old rule. Keep rule.",
				);
				expect(
					db.prepare("SELECT COUNT(*) AS n FROM memory_history").get(),
				).toEqual({ n: 0 });
				expect(
					db
						.prepare(
							"SELECT state,fact_attempts,reserved_stage_key FROM memory_pending_facts",
						)
						.get(),
				).toEqual(before);
			} finally {
				resume();
				await run;
				closeQuietly(db);
			}
		});
	}

	it("released Pi checks abort promptly and close a late child that ignored the signal", async () => {
		let finish: (reply: {
			result: SubagentRunResult;
			child: PiRpcHistorianChild | null;
		}) => void = () => {};
		const pending = new Promise<{
			result: SubagentRunResult;
			child: PiRpcHistorianChild | null;
		}>((resolve) => {
			finish = resolve;
		});
		let signal: AbortSignal | undefined;
		let closes = 0;
		const child: PiRpcHistorianChild = {
			id: "cancelled-child",
			alive: true,
			send: async () => {
				throw new Error("unused");
			},
			close: async () => {
				closes++;
			},
		};
		const runner: PiRpcHistorianRunner = {
			harness: "pi",
			canRetainHistorian: true,
			run: async () => {
				throw new Error("unused");
			},
			runRetainedHistorian: async (options) => {
				signal = options.signal;
				return pending;
			},
		};
		const carrier = createPiTurnTwoCarrier({
			child,
			runner,
			options: {
				agent: "historian",
				systemPrompt: "system",
				userMessage: "first",
			},
			turnOneText: "first",
			enforcedJson: true,
		});
		const request: CheckRequest = {
			key: "cancelled-check",
			kind: "disproof",
			system: CHECK_SYSTEM_PROMPTS.disproof,
			systemHash: lifecycleTextHash(CHECK_SYSTEM_PROMPTS.disproof),
			operands: [{ id: "old", text: "Old rule." }],
			pairs: [],
			input: "New rule.",
		};
		const checking = carrier.check(request).then(
			() => null,
			(error: unknown) => error,
		);
		carrier.cancel();
		expect(signal?.aborted).toBe(true);
		expect(await checking).toBeInstanceOf(Error);
		finish({ result: { ok: true, assistantText: "{}", durationMs: 1 }, child });
		await pending;
		await Promise.resolve();
		expect(closes).toBe(1);
	});
});

describe("Pi UUID stage lease", () => {
	it("an active scheduled check renews the same UUID lease while waiting", async () => {
		const db = createTestDb();
		const send = publication(db);
		const memory = insertMemory(db, {
			projectPath,
			category: "CONSTRAINTS",
			content: "Old rule. Keep rule.",
		});
		let alive = true;
		let started = () => {};
		let finish = () => {};
		const waiting = new Promise<void>((resolve) => {
			started = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const child: PiRpcHistorianChild = {
			id: `pi-rpc:${process.pid}:0:heartbeat-stage-uuid`,
			get alive() {
				return alive;
			},
			close: async () => {},
			send: async () => ({
				ok: true,
				durationMs: 1,
				meta: { reportedProvider: "test", reportedModel: "model" },
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
			}),
		};
		const runner: PiRpcHistorianRunner = {
			harness: "pi",
			canRetainHistorian: true,
			run: async () => {
				throw new Error("unused");
			},
			runRetainedHistorian: async () => {
				started();
				await barrier;
				return {
					child: null,
					result: {
						ok: false,
						reason: "abort",
						error: "test ended",
						durationMs: 1,
					},
				};
			},
		};
		schedulePiHistorianTurnTwo({
			formatInstructions: authorization.request.formatInstruction,
			db,
			projectPath,
			sessionId: "ses-fence",
			publicationId: send.publicationId,
			child,
			runner,
			options: {
				agent: "historian",
				systemPrompt: "historian system",
				userMessage: "first",
				temperature: 0,
			},
			turnOneText: "first",
			memoryEnabled: true,
			autoPromote: true,
			validatedProfiles,
			log: () => {},
		});
		try {
			await waiting;
			const readLease = () => {
				const row = db
					.prepare(
						"SELECT stage_key,request_json FROM memory_stage_attempts WHERE stage='turn_two'",
					)
					.get() as { stage_key: string; request_json: string };
				const active = JSON.parse(row.request_json).piRpcLease as {
					owner: string;
					stageKey: string;
					expiresAt: number;
				};
				expect(active.stageKey).toBe(row.stage_key);
				expect(active.owner).toBe(child.id);
				return active;
			};
			const initial = readLease();
			await new Promise<void>((resolve) => setTimeout(resolve, 10_100));
			expect(readLease().expiresAt).toBeGreaterThan(initial.expiresAt);
			alive = false;
			expect(recoverLostPiRpcStages(db)).toBe(1);
			await settlePiHistorianTurnTwoRuns();
			expect(
				db
					.prepare(
						"SELECT state FROM memory_stage_attempts WHERE stage='turn_two'",
					)
					.get(),
			).toEqual({ state: "lost" });
		} finally {
			alive = false;
			recoverLostPiRpcStages(db);
			finish();
			await settlePiHistorianTurnTwoRuns();
			closeQuietly(db);
		}
	}, 20_000);
	async function foreignStage(db: ReturnType<typeof createTestDb>) {
		const send = publication(db);
		const owner = `pi-rpc:${process.ppid}:${process.pid}:owned-stage-uuid`;
		const result = await runTurnTwo(db, {
			projectPath,
			publicationId: send.publicationId,
			sessionId: "ses-fence",
			lane: "enabled",
			memoryEnabled: true,
			autoPromote: true,
			validatedProfiles: [],
			carrier: {
				carrier: PI_RPC_CARRIER,
				harness: "pi",
				enforcedJson: true,
				childSessionId: owner,
				send: async () => {
					throw new TurnTwoOutcomeUnknownError();
				},
				check: async () => {
					throw new Error("unused");
				},
			},
		});
		if (!result.stageKey)
			throw new Error("foreign lease fixture requires a reserved stage");
		db.prepare(
			"UPDATE memory_stage_attempts SET started_at=? WHERE stage_key=?",
		).run(Date.now() - TURN_TWO_UNREACHABLE_MAX_AGE_MS - 1, result.stageKey);
		return { key: result.stageKey, owner };
	}
	function lease(
		db: ReturnType<typeof createTestDb>,
		key: string,
		owner: string,
		expiresAt: number,
	) {
		db.prepare(
			"UPDATE memory_stage_attempts SET request_json=json_set(request_json,'$.piRpcLease',json(?)) WHERE stage_key=?",
		).run(JSON.stringify({ owner, stageKey: key, expiresAt }), key);
	}
	async function visit(db: ReturnType<typeof createTestDb>) {
		const send = allocateTurnOneSend(db, {
			projectPath,
			sessionId: "ses-lease-visit",
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
				sessionId: "ses-lease-visit",
				compartments: [],
				blocks: [],
				candidateFacts: [],
				honourAnchors: true,
			}),
		)();
		const child: PiRpcHistorianChild = {
			id: send.publicationId,
			alive: true,
			close: async () => {},
			send: async () => {
				throw new Error("test has no answering carrier");
			},
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
		schedulePiHistorianTurnTwo({
			formatInstructions: authorization.request.formatInstruction,
			db,
			projectPath,
			sessionId: "ses-lease-visit",
			publicationId: send.publicationId,
			child,
			runner,
			options: {
				agent: "historian",
				systemPrompt: "system",
				userMessage: "first",
			},
			turnOneText: "first",
			memoryEnabled: true,
			autoPromote: true,
			validatedProfiles: [],
			log: () => {},
		});
		await settlePiHistorianTurnTwoRuns();
	}
	it("fresh UUID heartbeat protects an old foreign stage until its lease expires", async () => {
		const db = createTestDb();
		try {
			const stage = await foreignStage(db);
			lease(db, stage.key, stage.owner, Date.now() + PI_RPC_STAGE_LEASE_MS);
			for (let index = 0; index < 4; index++) {
				expect(recoverLostPiRpcStages(db)).toBe(0);
				await visit(db);
			}
			expect(
				db
					.prepare(
						"SELECT state,fact_attempts,reserved_stage_key FROM memory_pending_facts",
					)
					.get(),
			).toEqual({
				state: "in_flight",
				fact_attempts: 0,
				reserved_stage_key: stage.key,
			});
			lease(db, stage.key, stage.owner, Date.now() - 1);
			expect(recoverLostPiRpcStages(db)).toBe(1);
			expect(recoverLostPiRpcStages(db)).toBe(0);
			expect(
				db
					.prepare("SELECT state,fact_attempts FROM memory_pending_facts")
					.get(),
			).toEqual({ state: "retryable", fact_attempts: 1 });
		} finally {
			closeQuietly(db);
		}
	});
	it("a different stage UUID cannot preserve a stale reservation using the same live PIDs", async () => {
		const db = createTestDb();
		try {
			const stage = await foreignStage(db);
			lease(
				db,
				stage.key,
				stage.owner.replace("owned-stage-uuid", "reused-pid-uuid"),
				Date.now() + PI_RPC_STAGE_LEASE_MS,
			);
			await visit(db);
			expect(
				db
					.prepare("SELECT state FROM memory_stage_attempts WHERE stage_key=?")
					.get(stage.key),
			).toEqual({ state: "lost" });
		} finally {
			closeQuietly(db);
		}
	});
});
