/**
 * Opt-in tests of extracted facts being reconciled with project memory. Recovery
 * must recheck renewed leases in the transaction that releases fact reservations.
 * If a paused owner cannot renew, another process may take over, but the owner's
 * late reply must not apply a second edit. Processes on one machine share wall
 * time; deliberately offsetting only one process's clock is outside that contract.
 * .cortexkit/internal-docs/investigations/reports/memory-s8-review-r2.md records the accepted takeover cost and rulings.
 * The long-send and starvation cases use real timers and take about 130 seconds.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { MemoryStageOwnershipLostError } from "@magic-context/core/features/magic-context/memory/lifecycle-applier";
import {
	CHECK_SYSTEM_PROMPTS,
	type CheckReply,
	type CheckRequest,
} from "@magic-context/core/features/magic-context/memory/lifecycle-gates";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	allocateTurnOneSend,
	commitTurnOnePublication,
} from "@magic-context/core/features/magic-context/memory/turn-one-publication";
import {
	recoverTurnTwoStages,
	runTurnTwo,
	type TurnTwoCarrier,
} from "@magic-context/core/features/magic-context/memory/turn-two";
import { authorizationFixture } from "@magic-context/core/features/magic-context/memory/turn-two-test-fixtures.test";
import * as loggerModule from "@magic-context/core/shared/logger";
import { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	cleanupTestTempDir,
	createTestTempDir,
} from "@magic-context/core/shared/test-temp-dir";
import {
	PI_RPC_CARRIER,
	recoverLostPiRpcStages,
	schedulePiHistorianTurnTwo,
	settlePiHistorianTurnTwoRuns,
} from "./pi-historian-turn-two";
import { createTestDb } from "./test-utils.test";

const enabled = process.env.MC_S8_REVIEW === "1";
const projectPath = "dir:/s8-review-r2";
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
type Db = ReturnType<typeof createTestDb>;
const delay = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
function barrier() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function publication(db: Db, count: number) {
	const send = allocateTurnOneSend(db, {
		projectPath,
		sessionId: "ses-review-r2",
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
			sessionId: "ses-review-r2",
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
					startOrdinal: 1,
					endOrdinal: 1,
					role: "user",
					parts: ["New rule 1. New rule 2."],
				},
			],
			candidateFacts: Array.from({ length: count }, (_, i) => ({
				category: "CONSTRAINTS",
				content: `New rule ${i + 1}.`,
				anchor: { compartmentIndex: 1, startOrdinal: 1, endOrdinal: 1 },
			})),
			honourAnchors: true,
		}),
	)();
	return send.publicationId;
}
function fixture(db: Db, count = 1) {
	const publicationId = publication(db, count);
	const decisions = Array.from({ length: count }, (_, i) => {
		const memory = insertMemory(db, {
			projectPath,
			category: "CONSTRAINTS",
			content: `Old rule ${i + 1}. Keep rule ${i + 1}.`,
		});
		const rule = `New rule ${i + 1}.`;
		return {
			fact_id: i + 1,
			check: "Audit fixture.",
			action: "edit",
			target_id: memory.id,
			revision: 1,
			removed: [],
			replaced: [{ memory_id: memory.id, clause: 1, block: 1, excerpt: rule }],
			kept: [{ memory_id: memory.id, clause: 2 }],
			added: [{ text: `${rule} `, block: 1, excerpt: rule }],
			final_text: `${rule} Keep rule ${i + 1}.`,
		};
	});
	return { publicationId, decisions };
}
function accepted(request: CheckRequest): CheckReply {
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
}
function input(f: ReturnType<typeof fixture>, carrier: TurnTwoCarrier) {
	return {
		projectPath,
		publicationId: f.publicationId,
		sessionId: "ses-review-r2",
		lane: "enabled" as const,
		memoryEnabled: true,
		autoPromote: true,
		validatedProfiles,
		carrier,
	};
}
function carrier(f: ReturnType<typeof fixture>): TurnTwoCarrier {
	return {
		carrier: PI_RPC_CARRIER,
		harness: "pi",
		enforcedJson: true,
		childSessionId: `review-r2-${randomUUID()}`,
		historianSystemHash: profile.systemHash,
		send: async () => ({
			text: JSON.stringify({
				result: { step: "turn_two", decisions: f.decisions },
			}),
			lengthCapped: false,
			profile,
		}),
		check: async (request) => accepted(request),
	};
}
function assertAppliedOnce(db: Db, count: number) {
	expect(
		db.prepare("SELECT content,revision FROM memories ORDER BY id").all(),
	).toEqual(
		Array.from({ length: count }, (_, i) => ({
			content: `New rule ${i + 1}. Keep rule ${i + 1}.`,
			revision: 2,
		})),
	);
	expect(db.prepare("SELECT COUNT(*) AS n FROM memory_history").get()).toEqual({
		n: count,
	});
	expect(
		db.prepare("SELECT state FROM memory_pending_facts ORDER BY id").all(),
	).toEqual(Array.from({ length: count }, () => ({ state: "applied" })));
	expect(
		db
			.prepare(
				"SELECT COUNT(*) AS n FROM memory_decision_receipts WHERE json_extract(receipt_json,'$.state')='applied'",
			)
			.get(),
	).toEqual({ n: count });
}

// The owner runs the real Pi scheduler in a separate process and SQLite connection.
// Its RPC transport is a held fixture; both PID fields point to live processes.
function ownerScript() {
	const moduleUrl = new URL("./pi-historian-turn-two.ts", import.meta.url).href;
	const sqliteUrl = new URL(
		"../../plugin/src/shared/sqlite.ts",
		import.meta.url,
	).href;
	return `
import { Database } from ${JSON.stringify(sqliteUrl)};
import { schedulePiHistorianTurnTwo, settlePiHistorianTurnTwoRuns } from ${JSON.stringify(moduleUrl)};
import { createInterface } from "node:readline";
const cfg = JSON.parse(process.env.MC_S8_R2_OWNER);
const db = new Database(cfg.path);
const realNow = Date.now;
Date.now = () => realNow() + cfg.skew;
const out = (value) => console.log(JSON.stringify(value));
let finish;
const pending = new Promise(resolve => { finish = resolve; });
let sends = 0;
const child = {
 id: "pi-rpc:" + process.pid + ":" + process.ppid + ":" + cfg.uuid,
 alive: true,
 close: async () => {},
 send: async () => {
  sends++;
  const row = db.prepare("SELECT stage_key,request_json FROM memory_stage_attempts WHERE state='sending'").get();
  out({ event: "ready", pid: process.pid, sends, ...row });
  await pending;
  return { ok: true, durationMs: 1, assistantText: JSON.stringify({ result: { step: "turn_two", decisions: cfg.decisions } }), meta: { reportedProvider: "test", reportedModel: "model" } };
 }
};
const runner = {
 harness: "pi", canRetainHistorian: true,
 run: async () => { throw new Error("unused"); },
 runRetainedHistorian: async options => {
  const ids = options.userMessage.split("\\n\\nInput:\\n")[0].split("\\n").filter(line => line.startsWith("[")).map(line => options.systemPrompt === cfg.systems.compatibility ? line : line.slice(0, line.indexOf("]: ") + 1));
  return { child: null, result: { ok: true, durationMs: 1, assistantText: JSON.stringify({ verdicts: ids.map(id => ({ id, verdict: options.systemPrompt === cfg.systems.disproof || options.systemPrompt === cfg.systems.support ? "yes" : "no" })) }), meta: { reportedProvider: "test", reportedModel: "model" } } };
 }
};
schedulePiHistorianTurnTwo({ formatInstructions: cfg.formatInstructions, db, projectPath: cfg.projectPath, publicationId: cfg.publicationId, sessionId: "ses-review-r2", child, runner, options: { agent: "historian", systemPrompt: "historian system", userMessage: "first", temperature: 0 }, turnOneText: "first", memoryEnabled: true, autoPromote: true, validatedProfiles: cfg.profiles, log: line => out({ event: "log", line }) });
createInterface({ input: process.stdin }).on("line", async command => {
 if (command === "starve") {
  const start = performance.now();
  out({ event: "starving" });
  // This intentionally blocks the event loop, not the clock or the lease writer.
  while (performance.now() - start < 64_000) {}
  out({ event: "resumed" });
 }
 if (command === "finish") {
  finish();
  await settlePiHistorianTurnTwoRuns();
  out({ event: "finished", sends, memory: db.prepare("SELECT content,revision FROM memories").get(), history: db.prepare("SELECT COUNT(*) AS n FROM memory_history").get() });
  db.close();
  process.exit(0);
 }
});
`;
}

type OwnerEvent = {
	event: string;
	pid?: number;
	stage_key?: string;
	request_json?: string;
	memory?: { content: string; revision: number };
	history?: { n: number };
	sends?: number;
};
function startOwner(path: string, f: ReturnType<typeof fixture>, skew = 0) {
	const child = spawn(process.execPath, ["-e", ownerScript()], {
		windowsHide: true,
		cwd: process.cwd(),
		env: {
			...process.env,
			NODE_ENV: "test",
			MAGIC_CONTEXT_TEST_DATA_DIR: dirname(path),
			XDG_DATA_HOME: dirname(path),
			BUN_JSC_useOMGJIT: "0",
			MC_S8_R2_OWNER: JSON.stringify({
				path,
				...f,
				skew,
				uuid: randomUUID(),
				projectPath,
				profiles: validatedProfiles,
				formatInstructions: authorization.request.formatInstruction,
				systems: CHECK_SYSTEM_PROMPTS,
			}),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const events: OwnerEvent[] = [];
	const listeners = new Set<() => void>();
	let stderr = "";
	let exited = false;
	child.stderr.on("data", (data) => {
		stderr += String(data);
	});
	createInterface({ input: child.stdout }).on("line", (line) => {
		events.push(JSON.parse(line) as OwnerEvent);
		for (const listener of listeners) listener();
	});
	const exit = new Promise<void>((resolve) =>
		child.once("exit", () => {
			exited = true;
			for (const listener of listeners) listener();
			resolve();
		}),
	);
	return {
		path,
		child,
		events,
		exit,
		command: (command: string) => child.stdin.write(`${command}\n`),
		wait: (event: string, timeout = 15_000) =>
			new Promise<OwnerEvent>((resolve, reject) => {
				const timer = setTimeout(() => {
					listeners.delete(check);
					reject(new Error(`owner timed out: ${event}; ${stderr}`));
				}, timeout);
				const check = () => {
					const found = events.find((item) => item.event === event);
					if (!found && !exited) return;
					clearTimeout(timer);
					listeners.delete(check);
					if (found) resolve(found);
					else reject(new Error(`owner exited before ${event}: ${stderr}`));
				};
				listeners.add(check);
				check();
			}),
	};
}

async function withOwner(
	skew: number,
	test: (
		db: Db,
		f: ReturnType<typeof fixture>,
		owner: ReturnType<typeof startOwner>,
	) => Promise<void>,
) {
	const { dir } = createTestTempDir("mc-s8-r2-");
	const path = join(dir, "review.db");
	const db = createTestDb(path);
	const f = fixture(db);
	const owner = startOwner(path, f, skew);
	try {
		await owner.wait("ready");
		await test(db, f, owner);
	} finally {
		owner.child.kill("SIGKILL");
		await owner.exit;
		closeQuietly(db);
		cleanupTestTempDir(dir);
	}
}

async function visitPi(db: Db, publicationId = publication(db, 0)) {
	const child = {
		id: `review-r2-visit-${randomUUID()}`,
		alive: true,
		close: async () => {},
		send: async () => ({
			ok: true as const,
			durationMs: 1,
			assistantText: JSON.stringify({
				result: {
					step: "turn_two",
					decisions: [
						{ fact_id: 1, check: "Audit fixture.", action: "abstain" },
					],
				},
			}),
			meta: { reportedProvider: "test", reportedModel: "model" },
		}),
	};
	schedulePiHistorianTurnTwo({
		formatInstructions: authorization.request.formatInstruction,
		db,
		projectPath,
		publicationId,
		sessionId: "ses-review-r2",
		child,
		runner: {
			harness: "pi",
			canRetainHistorian: true,
			run: async () => {
				throw new Error("unused");
			},
			runRetainedHistorian: async () => {
				throw new Error("unused");
			},
		},
		options: {
			agent: "historian",
			systemPrompt: "historian system",
			userMessage: "first",
		},
		turnOneText: "first",
		memoryEnabled: true,
		autoPromote: true,
		validatedProfiles,
		log: () => {},
	});
	await settlePiHistorianTurnTwoRuns();
}

describe.skipIf(!enabled)("S8 independent review round two", () => {
	for (const mode of [
		"normal enabled",
		"slow check",
		"two facts sharing a stage",
	] as const) {
		it(`legitimate ${mode} applies each checked edit exactly once`, async () => {
			const db = createTestDb();
			const count = mode === "two facts sharing a stage" ? 2 : 1;
			const f = fixture(db, count);
			const c = carrier(f);
			let sends = 0;
			let checks = 0;
			const send = c.send;
			c.send = async (...args) => {
				sends++;
				return send(...args);
			};
			c.check = async (request) => {
				checks++;
				if (mode === "slow check") await delay(250);
				return accepted(request);
			};
			try {
				const result = await runTurnTwo(db, input(f, c));
				expect(result.status).toBe("resolved");
				expect(result.childInFlight).toBe(false);
				expect(checks).toBe(4 * count);
				assertAppliedOnce(db, count);
				await recoverTurnTwoStages(db, {
					projectPath,
					memoryEnabled: true,
					autoPromote: true,
					validatedProfiles,
					resolver: () => {
						throw new Error("resolved stages must not reattach");
					},
				});
				expect((await runTurnTwo(db, input(f, c))).status).toBe(
					"nothing_to_send",
				);
				expect(sends).toBe(1);
				assertAppliedOnce(db, count);
				expect(
					db
						.prepare(
							"SELECT state FROM memory_stage_attempts WHERE stage='turn_two'",
						)
						.all(),
				).toEqual([{ state: "resolved" }]);
			} finally {
				closeQuietly(db);
			}
		});
	}

	it("own control: changing the fact attempt during checks revokes the commit", async () => {
		const db = createTestDb();
		const f = fixture(db);
		const c = carrier(f);
		const started = barrier();
		const resume = barrier();
		c.check = async (request) => {
			started.resolve();
			await resume.promise;
			return accepted(request);
		};
		const run = runTurnTwo(db, input(f, c)).then(
			() => null,
			(error: unknown) => error,
		);
		try {
			await started.promise;
			db.prepare(
				"UPDATE memory_pending_facts SET fact_attempts=fact_attempts+1 WHERE id=1",
			).run();
			resume.resolve();
			expect(await run).toBeInstanceOf(MemoryStageOwnershipLostError);
			expect(db.prepare("SELECT revision FROM memories").get()).toEqual({
				revision: 1,
			});
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM memory_history").get(),
			).toEqual({ n: 0 });
		} finally {
			resume.resolve();
			await run;
			closeQuietly(db);
		}
	});

	it("own control: a late send cannot overwrite a terminal stage", async () => {
		const db = createTestDb();
		const f = fixture(db);
		const c = carrier(f);
		const started = barrier();
		const resume = barrier();
		let stageKey = "";
		const send = c.send;
		c.send = async (prompt, key) => {
			stageKey = key;
			started.resolve();
			await resume.promise;
			return send(prompt, key);
		};
		const run = runTurnTwo(db, input(f, c));
		try {
			await started.promise;
			db.prepare(
				"UPDATE memory_stage_attempts SET state='lost' WHERE stage_key=?",
			).run(stageKey);
			resume.resolve();
			await run;
			expect(
				db
					.prepare(
						"SELECT state,reply_json FROM memory_stage_attempts WHERE stage_key=?",
					)
					.get(stageKey),
			).toEqual({ state: "lost", reply_json: null });
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM memory_history").get(),
			).toEqual({ n: 0 });
		} finally {
			resume.resolve();
			await run;
			closeQuietly(db);
		}
	});

	it("a healthy 66-second scheduled Pi send keeps its foreign lease and applies once", async () => {
		await withOwner(0, async (db, _f, owner) => {
			const ready = await owner.wait("ready");
			let previous = JSON.parse(ready.request_json ?? "{}").piRpcLease
				.expiresAt as number;
			for (let i = 0; i < 6; i++) {
				await delay(11_000);
				const row = db
					.prepare(
						"SELECT request_json FROM memory_stage_attempts WHERE stage_key=?",
					)
					.get(ready.stage_key ?? "") as { request_json: string };
				const lease = JSON.parse(row.request_json).piRpcLease;
				expect(lease.expiresAt).toBeGreaterThan(previous);
				previous = lease.expiresAt;
				expect(recoverLostPiRpcStages(db)).toBe(0);
			}
			owner.command("finish");
			const finished = await owner.wait("finished");
			expect(finished.sends).toBe(1);
			assertAppliedOnce(db, 1);
			console.log(
				"S8 r2 long send: six renewals over 66 seconds, six foreign recoveries, one applied revision",
			);
		});
	}, 90_000);

	it("legacy foreign stages without lease metadata reach the shared visit bound", async () => {
		await withOwner(0, async (db, _f, owner) => {
			const ready = await owner.wait("ready");
			db.prepare(
				"UPDATE memory_stage_attempts SET request_json=json_remove(request_json,'$.piRpcLease') WHERE stage_key=?",
			).run(ready.stage_key ?? "");
			expect(recoverLostPiRpcStages(db)).toBe(0);
			// Finish these visits before the first heartbeat recreates piRpcLease;
			// recovery must be tested with the lease metadata still absent.
			for (let visit = 0; visit < 4; visit++) await visitPi(db);
			expect(
				db
					.prepare(
						"SELECT state,json_extract(request_json,'$.recoveryVisits') AS recovery_visits FROM memory_stage_attempts WHERE stage_key=?",
					)
					.get(ready.stage_key ?? ""),
			).toEqual({ state: "expired", recovery_visits: 3 });
			expect(
				db
					.prepare("SELECT state,fact_attempts FROM memory_pending_facts")
					.get(),
			).toEqual({ state: "decided_pending", fact_attempts: 1 });
			owner.command("finish");
			await owner.wait("finished");
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM memory_history").get(),
			).toEqual({ n: 0 });
		});
	});

	it("witness: a lease renewed before the recovery write lock stays busy at the visit bound", async () => {
		await withOwner(0, async (db, _f, owner) => {
			const ready = await owner.wait("ready");
			const stageKey = ready.stage_key ?? "";
			db.prepare(
				"UPDATE memory_stage_attempts SET request_json=json_set(request_json,'$.piRpcLease.expiresAt',?,'$.recoveryVisits',2) WHERE stage_key=?",
			).run(Date.now() - 1, stageKey);
			const next = publication(db, 0);
			const renewer = new Database(owner.path);
			const transaction = db.transaction.bind(db);
			let renewed = false;
			// Interleave a real second-connection heartbeat after the resolver's read,
			// immediately before its release transaction acquires the SQLite write lock.
			db.transaction = ((fn: Parameters<Db["transaction"]>[0]) => {
				const tx = transaction(fn);
				const immediate = tx.immediate.bind(tx);
				tx.immediate = (...args: Parameters<typeof immediate>) => {
					if (!renewed) {
						renewed = true;
						renewer
							.prepare(
								"UPDATE memory_stage_attempts SET request_json=json_set(request_json,'$.piRpcLease.expiresAt',?) WHERE stage_key=?",
							)
							.run(Date.now() + 60_000, stageKey);
					}
					return immediate(...args);
				};
				return tx;
			}) as Db["transaction"];
			try {
				await visitPi(db, next);
				const state = db
					.prepare(
						"SELECT state,json_extract(request_json,'$.piRpcLease.expiresAt') AS expires_at,json_extract(request_json,'$.recoveryVisits') AS visits FROM memory_stage_attempts WHERE stage_key=?",
					)
					.get(stageKey) as {
					state: string;
					expires_at: number;
					visits: number;
				};
				expect(renewed).toBe(true);
				expect(state.expires_at).toBeGreaterThan(Date.now());
				console.log(
					`S8 r2 renewal race: original=${state.state}; fresh lease retained=true; visits=${state.visits}`,
				);
				owner.command("finish");
				await owner.wait("finished");
				expect(state.state).toBe("sending");
			} finally {
				db.transaction = transaction;
				closeQuietly(renewer);
			}
		});
	});

	// Pi owners and observers run on one machine and share its wall clock. A
	// per-process Date.now override does not model a supported deployment.
	it.skip("unsupported witness: per-process clock skew (same-machine Pi processes share wall time)", async () => {
		await withOwner(-120_000, async (db) => {
			expect(recoverLostPiRpcStages(db)).toBe(0);
		});
	}, 90_000);

	it("timer starvation takeover logs expiry once, applies once and fences the late owner reply", async () => {
		const logs: Array<{ sessionId: string; line: string }> = [];
		const log = spyOn(loggerModule, "sessionLog").mockImplementation(
			(sessionId, line) => {
				logs.push({ sessionId, line });
			},
		);
		try {
			await withOwner(0, async (db, f, owner) => {
				const ready = await owner.wait("ready");
				const stageKey = ready.stage_key ?? "";
				const expiry = JSON.parse(ready.request_json ?? "{}").piRpcLease
					.expiresAt as number;
				owner.command("starve");
				await owner.wait("starving");
				await delay(61_000);
				const before = Date.now();
				expect(recoverLostPiRpcStages(db)).toBe(1);
				const after = Date.now();
				expect(recoverLostPiRpcStages(db)).toBe(0);
				const takeovers = logs.filter((entry) =>
					entry.line.startsWith("Pi RPC lease takeover "),
				);
				expect(takeovers).toHaveLength(1);
				expect(takeovers[0]?.sessionId).toBe("ses-review-r2");
				expect(takeovers[0]?.line).toContain(`stage=${stageKey} `);
				const stale = Number(
					/stale_ms=(\d+)$/.exec(takeovers[0]?.line ?? "")?.[1],
				);
				expect(stale).toBeGreaterThanOrEqual(before - expiry);
				expect(stale).toBeLessThanOrEqual(after - expiry);
				process.kill(owner.child.pid ?? 0, 0);
				expect(owner.events.some((event) => event.event === "finished")).toBe(
					false,
				);
				const original = () =>
					db
						.prepare(
							"SELECT state,reply_json FROM memory_stage_attempts WHERE stage_key=?",
						)
						.get(stageKey);
				expect(original()).toEqual({ state: "lost", reply_json: null });
				// Expiry permits overlapping execution, not overlapping commits: the
				// observer may apply before the starved owner's send has finished.
				const retry = { ...f, publicationId: publication(db, 0) };
				expect(
					(await runTurnTwo(db, input(retry, carrier(retry)))).status,
				).toBe("resolved");
				assertAppliedOnce(db, 1);
				owner.command("finish");
				expect((await owner.wait("finished")).sends).toBe(1);
				expect(original()).toEqual({ state: "lost", reply_json: null });
				assertAppliedOnce(db, 1);
				expect(
					logs.filter((entry) =>
						entry.line.startsWith("Pi RPC lease takeover "),
					),
				).toHaveLength(1);
				console.log(
					"S8 r2 timer starvation: one logged takeover, one canonical application, late owner reply fenced",
				);
			});
		} finally {
			log.mockRestore();
		}
	}, 90_000);
});
