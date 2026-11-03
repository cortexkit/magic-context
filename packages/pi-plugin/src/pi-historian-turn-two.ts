import { CHECK_SCHEMA_CONTRACT } from "@magic-context/core/features/magic-context/memory/historian-schema";
import { hasHistorianToolActivity } from "@magic-context/core/features/magic-context/memory/historian-wire";
import { resolveFactDecision } from "@magic-context/core/features/magic-context/memory/lifecycle-applier";
import type { ReportedProfile } from "@magic-context/core/features/magic-context/memory/lifecycle-gates";
import { lifecycleTextHash } from "@magic-context/core/features/magic-context/memory/lifecycle-text";
import {
	runTurnTwo,
	TURN_TWO_UNREACHABLE_MAX_AGE_MS,
	type TurnTwoCarrier,
	type TurnTwoRecoveryResolver,
} from "@magic-context/core/features/magic-context/memory/turn-two";
import {
	closeTurnTwoChild,
	registerTurnTwoChild,
	retainedTurnTwoChild,
} from "@magic-context/core/features/magic-context/memory/turn-two-children";
import { lifecycleToolHash } from "@magic-context/core/features/magic-context/memory/turn-two-profile";
import type { TurnTwoExcerptReader } from "@magic-context/core/features/magic-context/memory/turn-two-scoring";
import { renderCheckInput } from "@magic-context/core/hooks/magic-context/historian-turn-two-carrier";
import { sessionLog } from "@magic-context/core/shared/logger";
import { toModelEntry } from "@magic-context/core/shared/resolve-fallbacks";
import type { Database } from "@magic-context/core/shared/sqlite";
import type {
	SubagentRunner,
	SubagentRunOptions,
	SubagentRunResult,
} from "@magic-context/core/shared/subagent-runner";
import { resolvePiHarnessKind } from "./pi-harness-kind";
import type {
	PiRpcHistorianChild,
	PiRpcHistorianRunner,
} from "./subagent-runner";

export const PI_RPC_CARRIER = "pi-historian-rpc";
export const PI_RPC_STAGE_LEASE_MS = 60_000;
const PI_RPC_HEARTBEAT_MS = 10_000;
const liveChildren = new Map<string, PiRpcHistorianChild>();
type PiTurnTwoCarrier = TurnTwoCarrier & { cancel(): void };
const liveCarriers = new Map<string, PiTurnTwoCarrier>();
const scheduled = new Set<Promise<void>>();

export function isPiRpcHistorianRunner(
	runner: SubagentRunner,
): runner is PiRpcHistorianRunner {
	return (
		"canRetainHistorian" in runner &&
		runner.canRetainHistorian === true &&
		"runRetainedHistorian" in runner &&
		typeof runner.runRetainedHistorian === "function"
	);
}

function processExists(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** PID existence alone is only transport reachability, not proof that the UUID owns active work. */
function carrierAlive(id: string | null): boolean {
	if (!id) return false;
	const local = liveChildren.get(id);
	if (local) return local.alive;
	const match = /^pi-rpc:(\d+):(\d+):/.exec(id);
	return (
		!!match &&
		Number(match[1]) !== process.pid &&
		processExists(Number(match[1])) &&
		processExists(Number(match[2]))
	);
}

interface PiStage {
	stage_key: string;
	child_session_id: string | null;
	started_at: number;
	request_json: string;
	session_id: string;
}

function openStage(db: Database, key: string): PiStage | null {
	return db
		.prepare(
			"SELECT stage_key,child_session_id,started_at,request_json,session_id FROM memory_stage_attempts WHERE stage_key=? AND carrier=? AND stage='turn_two' AND state IN ('reserved','sending','replied')",
		)
		.get(key, PI_RPC_CARRIER) as PiStage | null;
}

function stageLease(stage: PiStage): { expiresAt: number } | null {
	try {
		const lease = JSON.parse(stage.request_json).piRpcLease;
		return lease?.owner === stage.child_session_id &&
			lease?.stageKey === stage.stage_key &&
			typeof lease.expiresAt === "number" &&
			Number.isFinite(lease.expiresAt)
			? lease
			: null;
	} catch {
		return null;
	}
}

function expiredLeaseLog(
	stage: PiStage,
): { sessionId: string; line: string } | null {
	const lease = stageLease(stage);
	const now = Date.now();
	if (!lease || lease.expiresAt > now) return null;
	return {
		sessionId: stage.session_id,
		line: `Pi RPC lease takeover stage=${stage.stage_key} stale_ms=${Math.floor(now - lease.expiresAt)}`,
	};
}

/** The shared give-up must reread the lease under its own write lock, not reuse Pi recovery's earlier snapshot. */
function recoveryLeaseFence(db: Database, key: string) {
	let expiryLog: ReturnType<typeof expiredLeaseLog> = null;
	return {
		canRelease: () => {
			const stage = openStage(db, key);
			const lease = stage && stageLease(stage);
			if (
				stage &&
				lease &&
				lease.expiresAt > Date.now() &&
				carrierAlive(stage.child_session_id)
			) {
				expiryLog = null;
				return false;
			}
			expiryLog = stage ? expiredLeaseLog(stage) : null;
			return true;
		},
		onRelease: () => {
			if (expiryLog) sessionLog(expiryLog.sessionId, expiryLog.line);
			expiryLog = null;
		},
	};
}

/** Renew only this stage/child UUID while it still owns an open stage; a released send cannot resurrect its lease. */
function renewStageLease(
	db: Database,
	stageKey: string,
	owner: string,
): boolean {
	return (
		db
			.prepare(
				"UPDATE memory_stage_attempts SET request_json=json_set(request_json,'$.piRpcLease',json(?)) WHERE stage_key=? AND child_session_id=? AND carrier=? AND state IN ('reserved','sending','replied')",
			)
			.run(
				JSON.stringify({
					owner,
					stageKey,
					expiresAt: Date.now() + PI_RPC_STAGE_LEASE_MS,
				}),
				stageKey,
				owner,
				PI_RPC_CARRIER,
			).changes === 1
	);
}

function releasePiStage(
	db: Database,
	key: string,
	shouldRelease: (stage: PiStage) => boolean,
): number {
	let releasedChild: string | null = null;
	let expiryLog: ReturnType<typeof expiredLeaseLog> = null;
	const count = db
		.transaction(() => {
			// Read the lease again after acquiring the write lock, so a concurrent
			// heartbeat cannot be discarded using the recovery caller's old snapshot.
			const stage = openStage(db, key);
			if (!stage || !shouldRelease(stage)) return 0;
			const facts = db
				.prepare(
					"SELECT id,project_path FROM memory_pending_facts WHERE state='in_flight' AND reserved_stage_key=?",
				)
				.all(key) as Array<{ id: number; project_path: string }>;
			for (const fact of facts)
				resolveFactDecision(db, {
					key: JSON.stringify([key, fact.id, "carrier_lost"]),
					projectPath: fact.project_path,
					factId: fact.id,
					operation: "turn_two",
					state: "retryable",
					reason: "carrier_lost",
				});
			db.prepare(
				"UPDATE memory_stage_attempts SET state='lost' WHERE stage_key=? AND state IN ('reserved','sending','replied')",
			).run(key);
			releasedChild = stage.child_session_id;
			expiryLog = expiredLeaseLog(stage);
			return facts.length;
		})
		.immediate();
	if (expiryLog) {
		const log = expiryLog as { sessionId: string; line: string };
		sessionLog(log.sessionId, log.line);
	}
	if (releasedChild) {
		liveCarriers.get(releasedChild)?.cancel();
		liveChildren.delete(releasedChild);
		void closeTurnTwoChild(releasedChild);
	}
	return count;
}

/** Pi keeps conversation and check state in its processes. After they exit, retry unfinished facts even if a reply was stored before checks completed. */
export function recoverLostPiRpcStages(
	db: Database,
	projectPath?: string,
): number {
	const stages = db
		.prepare(
			`SELECT stage_key,child_session_id FROM memory_stage_attempts
		 WHERE carrier=? AND stage='turn_two' AND state IN ('reserved','sending','replied')
		 ${projectPath ? "AND project_path=?" : ""}`,
		)
		.all(PI_RPC_CARRIER, ...(projectPath ? [projectPath] : [])) as Array<{
		stage_key: string;
		child_session_id: string | null;
	}>;
	let released = 0;
	for (const stage of stages) {
		released += releasePiStage(db, stage.stage_key, (current) => {
			if (!carrierAlive(current.child_session_id)) return true;
			if (
				current.child_session_id &&
				liveChildren.get(current.child_session_id)?.alive
			)
				return false;
			const lease = stageLease(current);
			return !!lease && lease.expiresAt <= Date.now();
		});
	}
	return released;
}

export function reportedProfile(
	result: SubagentRunResult,
	options: SubagentRunOptions,
	systemHash: string,
	formatInstructions?: string,
	harness = resolvePiHarnessKind(),
): ReportedProfile | null {
	const provider = result.meta?.reportedProvider;
	const modelId = result.meta?.reportedModel;
	if (typeof provider !== "string" || typeof modelId !== "string") return null;
	return {
		lane: harness,
		carrier: PI_RPC_CARRIER,
		provider,
		modelId,
		variant: toModelEntry(options.model)?.qualifier ?? null,
		// RPC currently observes neither effective sampling nor effective thinking.
		temperature: null,
		thinkingLevel: null,
		systemHash,
		schemaHash:
			formatInstructions === undefined
				? null
				: lifecycleTextHash(formatInstructions),
		toolHash: lifecycleToolHash([]),
	};
}

/** Continue the retained historian child; locally validate its best-effort replies. */
export function createPiTurnTwoCarrier(args: {
	child: PiRpcHistorianChild;
	runner: PiRpcHistorianRunner;
	options: SubagentRunOptions;
	turnOneText: string;
	enforcedJson?: boolean;
	onStageKey?: (key: string) => void;
	/** Persisted format instructions, shared byte-for-byte by both turns. */
	formatInstructions?: string;
}): PiTurnTwoCarrier {
	const systemHash = lifecycleTextHash(args.options.systemPrompt);
	const harness = resolvePiHarnessKind();
	const cancellation = new AbortController();
	const signal = args.options.signal
		? AbortSignal.any([args.options.signal, cancellation.signal])
		: cancellation.signal;
	const checks = new Set<PiRpcHistorianChild>();
	return {
		cancel() {
			cancellation.abort(new Error("Pi RPC stage released"));
			for (const child of checks) void child.close().catch(() => {});
		},
		carrier: PI_RPC_CARRIER,
		harness,
		childSessionId: args.child.id,
		baseline: lifecycleTextHash(args.turnOneText),
		historianSystemHash: systemHash,
		variant: toModelEntry(args.options.model)?.qualifier ?? null,
		async send(prompt, key) {
			signal.throwIfAborted();
			args.onStageKey?.(key);
			const result = await args.child.send(prompt, key);
			signal.throwIfAborted();
			if (!result.ok)
				throw new Error(`Pi turn two: ${result.reason}: ${result.error}`);
			return {
				text: result.assistantText,
				lengthCapped: result.meta?.lengthCapped === true,
				toolActivity: hasHistorianToolActivity(result.meta),
				profile: reportedProfile(
					result,
					args.options,
					systemHash,
					args.formatInstructions,
					harness,
				),
				usage: result.meta?.usage,
			};
		},
		async check(request) {
			signal.throwIfAborted();
			const options = {
				...args.options,
				systemPrompt: request.system,
				userMessage: renderCheckInput(request),
				fallbackModels: undefined,
				signal,
			};
			const running = args.runner.runRetainedHistorian(options, request.key);
			// A carrier that ignores cancellation can still return a child later;
			// close it instead of admitting its reply or leaving a detached process.
			void running.then(
				({ child }) => {
					if (child) {
						checks.add(child);
						if (signal.aborted) void child.close().catch(() => {});
					}
				},
				() => {},
			);
			const { result, child } = await waitForCheck(running, signal);
			try {
				signal.throwIfAborted();
				if (!result.ok)
					throw new Error(`Pi check: ${result.reason}: ${result.error}`);
				const profile = reportedProfile(
					result,
					options,
					lifecycleTextHash(request.system),
					CHECK_SCHEMA_CONTRACT,
					harness,
				);
				let verdicts = [];
				try {
					verdicts = JSON.parse(result.assistantText).verdicts;
				} catch {
					/* Malformed output is a refusing verdict, not a transport retry. */
				}
				return {
					toolActivity: hasHistorianToolActivity(result.meta),
					verdicts:
						Array.isArray(verdicts) && result.meta?.lengthCapped !== true
							? verdicts
							: [],
					profile: profile ?? {
						lane: harness,
						carrier: PI_RPC_CARRIER,
						provider: "",
						modelId: "",
						variant: null,
						temperature: null,
						thinkingLevel: null,
						systemHash: lifecycleTextHash(request.system),
						schemaHash: lifecycleTextHash(CHECK_SCHEMA_CONTRACT),
						toolHash: lifecycleToolHash([]),
					},
					usage: result.meta?.usage,
				};
			} finally {
				if (child) checks.delete(child);
				await child?.close();
			}
		},
	};
}

function waitForCheck<T>(running: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		void running
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}

const recoverLivePiRpcStage =
	(db: Database): TurnTwoRecoveryResolver =>
	(record) => {
		if (record.carrier !== PI_RPC_CARRIER || !record.childSessionId)
			return null;
		const child = liveChildren.get(record.childSessionId);
		const carrier = liveCarriers.get(record.childSessionId);
		if (!child || !carrier) {
			const stage = openStage(db, record.stageKey);
			const lease = stage && stageLease(stage);
			if (
				lease &&
				lease.expiresAt > Date.now() &&
				carrierAlive(record.childSessionId)
			)
				return "busy";
			releasePiStage(db, record.stageKey, (current) => {
				const active = stageLease(current);
				return (
					!carrierAlive(current.child_session_id) ||
					(active
						? active.expiresAt <= Date.now()
						: Date.now() - current.started_at >=
							TURN_TWO_UNREACHABLE_MAX_AGE_MS)
				);
			});
			return {
				...recoveryLeaseFence(db, record.stageKey),
				check: async () => {
					throw new Error("Pi RPC check owner unavailable");
				},
				reattach: async () => ({
					kind: openStage(db, record.stageKey) ? "unknown" : "gone",
				}),
			};
		}
		if (retainedTurnTwoChild(record.childSessionId)?.active) return "busy";
		return {
			...recoveryLeaseFence(db, record.stageKey),
			check: carrier.check,
			reattach: async () => ({ kind: child.alive ? "unknown" : "gone" }),
			close: () => closeTurnTwoChild(child.id),
		};
	};

/** Schedule memory reconciliation after publication so it holds no compartment write lease and user requests do not wait on it. Keep its RPC child open until the reserved facts resolve. */
export function schedulePiHistorianTurnTwo(args: {
	db: Database;
	projectPath: string;
	publicationId: string;
	sessionId: string;
	child: PiRpcHistorianChild;
	runner: PiRpcHistorianRunner;
	options: SubagentRunOptions;
	turnOneText: string;
	memoryEnabled: boolean;
	autoPromote: boolean;
	validatedProfiles?: readonly ReportedProfile[];
	trialAuthorization?: import("@magic-context/core/features/magic-context/memory/turn-two-profile").TurnTwoTrialAuthorization;
	formatInstructions?: string;
	log: (message: string) => void;
	beforeResolve?: () => Promise<boolean | void>;
	readExcerpt?: TurnTwoExcerptReader;
}): void {
	liveChildren.set(args.child.id, args.child);
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const stopHeartbeat = () => {
		clearInterval(heartbeat);
		heartbeat = undefined;
	};
	const carrier = createPiTurnTwoCarrier({
		...args,
		onStageKey: (key) => {
			if (!renewStageLease(args.db, key, args.child.id))
				throw new Error("Pi RPC stage released before send");
			heartbeat = setInterval(() => {
				try {
					if (!renewStageLease(args.db, key, args.child.id)) {
						carrier.cancel();
						void closeTurnTwoChild(args.child.id);
					}
				} catch (error) {
					args.log(`Pi RPC heartbeat failed: ${String(error)}`);
				}
			}, PI_RPC_HEARTBEAT_MS);
			heartbeat.unref?.();
		},
	});
	liveCarriers.set(args.child.id, carrier);
	registerTurnTwoChild({
		childSessionId: args.child.id,
		parentSessionId: args.sessionId,
		harness: carrier.harness,
		handle: args.child,
		active: true,
		close: async () => {
			stopHeartbeat();
			carrier.cancel();
			liveChildren.delete(args.child.id);
			liveCarriers.delete(args.child.id);
			await args.child.close();
		},
	});
	const task = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(
		async () => {
			try {
				if ((await args.beforeResolve?.()) === false) {
					await closeTurnTwoChild(args.child.id);
					return;
				}
				const recovery = recoverLivePiRpcStage(args.db);
				const result = await runTurnTwo(args.db, {
					...args,
					lane: "enabled",
					carrier: {
						...carrier,
						send: async (...input) => {
							if ((await args.beforeResolve?.()) === false)
								throw new Error("Turn two was revoked before send");
							try {
								return await carrier.send(...input);
							} finally {
								await args.beforeResolve?.();
							}
						},
						check: async (...input) => {
							if ((await args.beforeResolve?.()) === false)
								throw new Error("Turn two was revoked before check");
							try {
								return await carrier.check(...input);
							} finally {
								await args.beforeResolve?.();
							}
						},
					},
					recover: (record) => {
						const recovered = recovery(record);
						if (!recovered || recovered === "busy") return recovered;
						return {
							...recovered,
							check: async (...input) => {
								if ((await args.beforeResolve?.()) === false)
									throw new Error("Recovered stage was revoked before check");
								try {
									return await recovered.check(...input);
								} finally {
									await args.beforeResolve?.();
								}
							},
							reattach: async () => {
								try {
									return await recovered.reattach();
								} finally {
									await args.beforeResolve?.();
								}
							},
							reattachCheck: recovered.reattachCheck
								? async (...input) => {
										try {
											return await recovered.reattachCheck!(...input);
										} finally {
											await args.beforeResolve?.();
										}
									}
								: undefined,
						};
					},
				});
				if (result.childInFlight) return;
			} catch (error) {
				args.log(`Pi turn two failed: ${String(error)}`);
				if (
					args.db
						.prepare(
							"SELECT 1 FROM memory_stage_attempts WHERE child_session_id=? AND stage='turn_two' AND state IN ('reserved','sending','replied')",
						)
						.get(args.child.id)
				)
					return;
			}
			await closeTurnTwoChild(args.child.id);
		},
	);
	scheduled.add(task);
	const settled = () => {
		stopHeartbeat();
		scheduled.delete(task);
		const retained = retainedTurnTwoChild(args.child.id);
		if (retained) retained.active = false;
	};
	void task.then(settled, (error) => {
		args.log(`Pi turn two failed: ${String(error)}`);
		settled();
	});
}

export async function settlePiHistorianTurnTwoRuns(): Promise<void> {
	while (scheduled.size) await Promise.allSettled([...scheduled]);
}
