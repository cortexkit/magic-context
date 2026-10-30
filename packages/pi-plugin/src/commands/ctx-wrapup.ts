import * as crypto from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	acquireCompartmentLease,
	COMPARTMENT_LEASE_RENEWAL_MS,
	releaseCompartmentLeaseBestEffort,
	renewCompartmentLease,
} from "@magic-context/core/features/magic-context/compartment-lease";
import {
	getCompartments,
	getLastCompartmentEndMessage,
} from "@magic-context/core/features/magic-context/compartment-storage";
import {
	acquireWrapupInProgress,
	type ContextDatabase,
	clearEmergencyRecovery,
	getOrCreateSessionMeta,
	getOverflowState,
	getWrapupInProgressState,
	releaseWrapupInProgress,
	updateWrapupInProgress,
} from "@magic-context/core/features/magic-context/storage";
import { resolveExecuteThreshold } from "@magic-context/core/hooks/magic-context/event-resolvers";
import {
	describeBoundaryDiagnostics,
	hasRunnableCompartmentWindow,
	resolveWrapupProtectedTailBoundary,
} from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import { setRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { ModelInput } from "@magic-context/core/shared/model-resolution";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { COMPACTION_OFF_COMMAND_UNAVAILABLE } from "../compaction-off-pi";
import {
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
} from "../context-handler";
import { ensureProjectRegisteredFromPiDirectory } from "../embedding-bootstrap";
import { repairPiHistoryBoundary } from "../history-boundary-repair-pi";
import { resolvePiUsableContextLimit } from "../pi-context-limit";
import { runPiHistorian } from "../pi-historian-runner";
import {
	isPiOrdinalAlignmentUnanchored,
	piRawOrdinalOffsetSource,
	resolvePiOrdinalAlignmentForContext,
} from "../pi-ordinal-alignment";
import { isPiRecompInFlight } from "../pi-recomp-runner";
import {
	readPiSessionMessagePage,
	readPiSessionMessages,
} from "../read-session-pi";
import { updateStatusLine } from "../status-line";
import { createCtxStatusSender, resolveSessionId } from "./pi-command-utils";

export interface RegisterCtxWrapupDeps {
	db: ContextDatabase;
	runner: SubagentRunner;
	historianModel: string | undefined;
	historianChunkTokens: number;
	historianFallbacks?: readonly ModelInput[];
	historianTimeoutMs?: number;
	historianMaxOutputTokens?: number;
	historianThinkingLevel?: string;
	language?: string;
	memoryEnabled: boolean;
	autoPromote: boolean;
	userMemoriesEnabled?: boolean;
	/** False when the dreamer is not runnable; the historian then skips user observations. */
	userObservationsRequested?: boolean;
	executeThresholdPercentage?:
		| number
		| { default: number; [modelKey: string]: number };
	executeThresholdTokens?: {
		default?: number;
		[modelKey: string]: number | undefined;
	};
	runPiHistorianForWrapup?: typeof runPiHistorian;
	wrapupLeaseWaitTimeoutMs?: number;
	resolveRuntimeDeps?: (ctx: { cwd: string }) => CtxWrapupRuntimeDeps;
	compactionOff?: boolean;
	shutdownSignal?: AbortSignal;
}

export type CtxWrapupRuntimeDeps = Omit<
	RegisterCtxWrapupDeps,
	"resolveRuntimeDeps"
>;

const DEFAULT_MESSAGES_TO_KEEP = 20;
const LEASE_WAIT_MS = 1_000;
const MAX_WRAPUP_LEASE_WAIT_MS = 10 * 60 * 1_000;

type LeaseAcquireResult =
	| { ok: true; holderId: string }
	| { ok: false; reason: "ownership_lost" | "timeout" };

function resolveWrapupLeaseWaitTimeout(deps: CtxWrapupRuntimeDeps): number {
	const configured = deps.wrapupLeaseWaitTimeoutMs ?? MAX_WRAPUP_LEASE_WAIT_MS;
	return Number.isFinite(configured) && configured >= 0
		? configured
		: MAX_WRAPUP_LEASE_WAIT_MS;
}

export function parseWrapupArgs(
	raw: string,
): { ok: true; messagesToKeep: number } | { ok: false; message: string } {
	const trimmed = raw.trim();
	if (trimmed === "")
		return { ok: true, messagesToKeep: DEFAULT_MESSAGES_TO_KEEP };
	if (!/^\d+$/.test(trimmed)) {
		return {
			ok: false,
			message:
				"Usage: `/ctx-wrapup [messages_to_keep]` where messages_to_keep is a positive integer.",
		};
	}
	const messagesToKeep = Number.parseInt(trimmed, 10);
	if (!Number.isSafeInteger(messagesToKeep) || messagesToKeep <= 0) {
		return {
			ok: false,
			message: "messages_to_keep must be a positive integer.",
		};
	}
	return { ok: true, messagesToKeep };
}

export function registerCtxWrapupCommand(
	pi: ExtensionAPI,
	deps: RegisterCtxWrapupDeps,
): void {
	pi.registerCommand("ctx-wrapup", {
		description:
			"Compact older Magic Context history while keeping the newest messages raw",
		handler: async (args, ctx) => {
			const sendStatus = createCtxStatusSender(pi, ctx);
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendStatus({
					title: "/ctx-wrapup",
					text: "## Magic Wrapup\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}
			const currentDeps = {
				...(deps.resolveRuntimeDeps?.(ctx) ?? deps),
				shutdownSignal: deps.shutdownSignal,
			};
			if (currentDeps.compactionOff) {
				sendStatus({
					title: "/ctx-wrapup",
					text: COMPACTION_OFF_COMMAND_UNAVAILABLE,
					level: "warning",
				});
				return;
			}

			const sessionMeta = getOrCreateSessionMeta(currentDeps.db, sessionId);
			if (sessionMeta.isSubagent) {
				sendStatus({
					title: "/ctx-wrapup",
					text: "## Magic Wrapup — Skipped\n\n/ctx-wrapup is only available in primary sessions.",
					level: "warning",
				});
				return;
			}

			if (!currentDeps.historianModel) {
				sendStatus({
					title: "/ctx-wrapup",
					text: "## Magic Wrapup\n\n/ctx-wrapup is unavailable because the active harness's historian model is not configured.",
					level: "error",
				});
				return;
			}

			const parsed = parseWrapupArgs(args);
			if (!parsed.ok) {
				sendStatus({
					title: "/ctx-wrapup",
					text: `## Magic Wrapup — Invalid Arguments\n\n${parsed.message}`,
					level: "error",
				});
				return;
			}

			const result = await runPiWrapup(
				pi,
				currentDeps,
				ctx,
				sessionId,
				parsed.messagesToKeep,
			);
			sendStatus({
				title: "/ctx-wrapup",
				text: result,
				level:
					result.includes("Failed") || result.includes("Partial")
						? "error"
						: "success",
			});
		},
	});
}

export async function runPiWrapup(
	pi: ExtensionAPI,
	deps: RegisterCtxWrapupDeps,
	ctx: ExtensionCommandContext,
	sessionId: string,
	messagesToKeep: number,
): Promise<string> {
	const sendStatus = createCtxStatusSender(pi, ctx);
	if (getOrCreateSessionMeta(deps.db, sessionId).isSubagent) {
		return "## Magic Wrapup — Skipped\n\n/ctx-wrapup is only available in primary sessions.";
	}
	if (isPiRecompInFlight(sessionId)) {
		return "## Magic Wrapup — Skipped\n\nA recomp or upgrade is already running for this session. Wait for it to finish, then try `/ctx-wrapup` again.";
	}

	repairPiHistoryBoundary(deps.db, sessionId, ctx);
	const ordinalAlignment = resolvePiOrdinalAlignmentForContext(
		deps.db,
		sessionId,
		ctx,
	);
	if (isPiOrdinalAlignmentUnanchored(ordinalAlignment)) {
		return `## Magic Wrapup — Skipped\n\nThe stored history boundaries no longer match this session branch (${ordinalAlignment.detail}), so a wrapup cannot place new summaries safely.`;
	}
	const offsetSource = piRawOrdinalOffsetSource(deps.db, sessionId);
	const provider = {
		readMessages: () => readPiSessionMessages(ctx, offsetSource),
		readMessagePage: (
			afterOrdinal: number,
			limit: number,
			finalWatermark: number,
		) =>
			readPiSessionMessagePage(
				ctx,
				afterOrdinal,
				limit,
				finalWatermark,
				offsetSource,
			),
	};
	const unregister = setRawMessageProvider(sessionId, provider);
	let holderId = "";
	try {
		const contextLimit = resolvePiContextLimit(ctx, deps.db, sessionId);
		const modelKey = ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: undefined;
		const executeThresholdPercentage = resolveExecuteThreshold(
			deps.executeThresholdPercentage ?? 65,
			modelKey,
			65,
			{
				tokensConfig: deps.executeThresholdTokens,
				contextLimit,
				sessionId,
			},
		);
		const initialPlan = resolveWrapupProtectedTailBoundary({
			db: deps.db,
			sessionId,
			mode: "manual-wrapup",
			contextLimit,
			executeThresholdPercentage,
			usage: { percentage: 0, inputTokens: 0 },
			usageSource: "manual-none",
			providerShapeVersion: "pi-folded-v1",
			cacheNamespace: `pi:${sessionId}`,
			messagesToKeep,
		});
		if (initialPlan.rawMessagesAboveLastCompartment <= messagesToKeep) {
			return `## Magic Wrapup\n\nNothing to wrap up — only ${initialPlan.rawMessagesAboveLastCompartment} messages above the last compartment.`;
		}
		if (!hasRunnableCompartmentWindow(initialPlan.snapshot)) {
			return `## Magic Wrapup — Partial\n\nNo runnable wrapup boundary is available yet; wrapped up 0 messages into 0 compartments. Run /ctx-wrapup again to continue.`;
		}

		holderId = crypto.randomUUID();
		const acquired = acquireWrapupInProgress(deps.db, sessionId, {
			holderId,
			messagesToKeep,
			anchorRawMessageCount: initialPlan.anchorRawMessageCount,
			targetEligibleEndOrdinal: initialPlan.targetEligibleEndOrdinal,
			lastCompartmentEnd: getLastCompartmentEndMessage(deps.db, sessionId),
			chunkIndex: 0,
			expectedChunks: estimateChunks(
				initialPlan.snapshot.trueRawEligibleTokens,
				deps.historianChunkTokens,
			),
		});
		if (!acquired.ok) {
			return formatExistingWrapup(
				acquired.state ?? getWrapupInProgressState(deps.db, sessionId),
			);
		}

		let ownershipLost = false;
		const ownershipLostReason =
			"another process took over this session's wrapup";
		const markOwnershipLost = (): void => {
			if (ownershipLost) return;
			ownershipLost = true;
		};
		const renewWrapupMarker = (
			updates: Parameters<typeof updateWrapupInProgress>[3],
		): boolean => {
			const updated = updateWrapupInProgress(
				deps.db,
				sessionId,
				holderId,
				updates,
			);
			if (!updated) {
				markOwnershipLost();
				return false;
			}
			return true;
		};
		const renewal = inRootAsyncContext(() =>
			setInterval(() => {
				try {
					renewWrapupMarker({
						lastCompartmentEnd: getLastCompartmentEndMessage(
							deps.db,
							sessionId,
						),
					});
				} catch (err) {
					// A missed renewal is safe because the wrapup marker has a five-minute TTL.
					sessionLog(
						sessionId,
						`[pi] /ctx-wrapup marker renewal failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}, 60_000),
		);
		const stopRenewal = () => clearInterval(renewal);
		deps.shutdownSignal?.addEventListener("abort", stopRenewal, { once: true });
		try {
			sendStatus({
				title: "/ctx-wrapup",
				text: `## Magic Wrapup\n\nEligible history is about ${initialPlan.snapshot.trueRawEligibleTokens.toLocaleString()} tokens across approximately ${estimateChunks(initialPlan.snapshot.trueRawEligibleTokens, deps.historianChunkTokens)} historian chunk(s).`,
				level: "info",
			});

			const startEnd = getLastCompartmentEndMessage(deps.db, sessionId);
			const startCompartmentCount = getCompartments(deps.db, sessionId).length;
			let chunkIndex = 0;
			let lastEnd = startEnd;
			let targetEligibleEndOrdinal = initialPlan.targetEligibleEndOrdinal;
			let failure: string | null = null;

			for (;;) {
				if (ownershipLost) {
					failure = `${ownershipLostReason}; wrapped up through message ${lastEnd}. Run /ctx-wrapup again to continue.`;
					break;
				}
				if (
					!renewWrapupMarker({
						chunkIndex,
						lastCompartmentEnd: getLastCompartmentEndMessage(
							deps.db,
							sessionId,
						),
					})
				) {
					failure = `${ownershipLostReason}; wrapped up through message ${lastEnd}. Run /ctx-wrapup again to continue.`;
					break;
				}

				const plan = resolveWrapupProtectedTailBoundary({
					db: deps.db,
					sessionId,
					mode: "manual-wrapup",
					contextLimit,
					executeThresholdPercentage,
					usage: { percentage: 0, inputTokens: 0 },
					usageSource: "manual-none",
					providerShapeVersion: "pi-folded-v1",
					cacheNamespace: `pi:${sessionId}`,
					messagesToKeep,
					anchorRawMessageCount: initialPlan.anchorRawMessageCount,
				});
				targetEligibleEndOrdinal = plan.targetEligibleEndOrdinal;
				lastEnd = getLastCompartmentEndMessage(deps.db, sessionId);
				if (lastEnd + 1 >= targetEligibleEndOrdinal) break;
				if (!hasRunnableCompartmentWindow(plan.snapshot)) {
					sessionLog(
						sessionId,
						`wrapup no-op: ${describeBoundaryDiagnostics(plan.snapshot)}`,
					);
					failure = `No runnable wrapup boundary is available yet; wrapped up through message ${lastEnd}. Run /ctx-wrapup again to continue.`;
					break;
				}

				chunkIndex += 1;
				if (
					!renewWrapupMarker({
						chunkIndex,
						lastCompartmentEnd: getLastCompartmentEndMessage(
							deps.db,
							sessionId,
						),
						targetEligibleEndOrdinal: plan.targetEligibleEndOrdinal,
						expectedChunks: Math.max(
							chunkIndex,
							estimateChunks(
								plan.snapshot.trueRawEligibleTokens,
								deps.historianChunkTokens,
							),
						),
					})
				) {
					failure = `${ownershipLostReason}; wrapped up through message ${lastEnd}. Run /ctx-wrapup again to continue.`;
					break;
				}
				// Boundary diagnostics belong in the log; the chat line stays a plain progress sentence.
				sessionLog(
					sessionId,
					`wrapup chunk ${chunkIndex}: ${describeBoundaryDiagnostics(plan.snapshot)}`,
				);
				sendStatus({
					title: "/ctx-wrapup",
					text: `## Magic Wrapup\n\nChunk ${chunkIndex}: wrapping messages ${plan.snapshot.offset}-${plan.snapshot.eligibleEndOrdinal - 1} (~${plan.snapshot.trueRawEligibleTokens.toLocaleString()} eligible tokens remain).`,
					level: "info",
				});

				const leaseResult = await acquireCompartmentLeaseEventually(
					deps.db,
					sessionId,
					renewWrapupMarker,
					resolveWrapupLeaseWaitTimeout(deps),
					deps.shutdownSignal,
				);
				if (!leaseResult.ok) {
					failure = ownershipLost
						? `${ownershipLostReason}; wrapped up through message ${lastEnd}. Run /ctx-wrapup again to continue.`
						: leaseResult.reason === "timeout"
							? `Timed out waiting for another process to release the compartment-state lease; wrapped up through message ${lastEnd}. Run /ctx-wrapup again to continue.`
							: "Another Magic Context rebuild started while wrapup was waiting. Run /ctx-wrapup again to continue.";
					break;
				}
				const leaseHolder = leaseResult.holderId;
				const leaseRenewal = inRootAsyncContext(() =>
					setInterval(() => {
						try {
							renewCompartmentLease(deps.db, sessionId, leaseHolder);
						} catch (err) {
							// A missed renewal is safe because the compartment lease has a five-minute TTL.
							sessionLog(
								sessionId,
								`[pi] /ctx-wrapup compartment lease renewal failed: ${err instanceof Error ? err.message : String(err)}`,
							);
						}
					}, COMPARTMENT_LEASE_RENEWAL_MS),
				);
				const stopLeaseRenewal = () => clearInterval(leaseRenewal);
				deps.shutdownSignal?.addEventListener("abort", stopLeaseRenewal, {
					once: true,
				});
				try {
					const runHistorian = deps.runPiHistorianForWrapup ?? runPiHistorian;
					await runHistorian({
						db: deps.db,
						// RPC can expose UI methods without a persistent interactive host.
						// A detached second turn would outlive the wrapup command's caller.
						hasUI:
							ctx.hasUI === true && (ctx as { mode?: string }).mode !== "rpc",
						sessionId,
						directory: ctx.cwd,
						provider,
						runner: deps.runner,
						signal: deps.shutdownSignal,
						historianModel: deps.historianModel as string,
						fallbackModels: deps.historianFallbacks,
						fallbackModelId: modelKey,
						historianChunkTokens: deps.historianChunkTokens,
						boundarySnapshot: plan.snapshot,
						refreshBoundarySnapshot: () =>
							resolveWrapupProtectedTailBoundary({
								db: deps.db,
								sessionId,
								mode: "manual-wrapup",
								contextLimit,
								executeThresholdPercentage,
								usage: { percentage: 0, inputTokens: 0 },
								usageSource: "manual-none",
								providerShapeVersion: "pi-folded-v1",
								cacheNamespace: `pi:${sessionId}`,
								messagesToKeep,
								anchorRawMessageCount: initialPlan.anchorRawMessageCount,
							}).snapshot,
						currentContextLimit: contextLimit,
						historianTimeoutMs: deps.historianTimeoutMs,
						maxOutputTokens: deps.historianMaxOutputTokens,
						thinkingLevel: deps.historianThinkingLevel,
						memoryEnabled: deps.memoryEnabled,
						autoPromote: deps.autoPromote,
						userMemoriesEnabled: deps.userMemoriesEnabled,
						userObservationsRequested: deps.userObservationsRequested,
						language: deps.language,
						compartmentLeaseHolderId: leaseHolder,
						readBranchEntries: () => readPiWrapupBranchEntries(ctx),
						notifyIssue: (text) =>
							sendStatus({
								title: "/ctx-wrapup",
								text,
								level: "warning",
							}),
						ensureProjectRegistered: ensureProjectRegisteredFromPiDirectory,
						forceDrainQuota: true,
						// The boundary resolver caps each run's window, so chunk.hasMore cannot
						// see the full drain target. Request weak-lookahead preservation only
						// for the window that reaches that target; the runner still downgrades
						// the hint if its own chunk reader stops early within the window.
						forceKeepLastCompartment:
							plan.snapshot.eligibleEndOrdinal >= plan.targetEligibleEndOrdinal,
						onPublished: () => {
							updateStatusLine(ctx, { db: deps.db, projectIdentity: ctx.cwd });
							signalPiDeferredHistoryRefresh(sessionId);
							signalPiDeferredMaterialization(sessionId);
						},
					});
				} finally {
					clearInterval(leaseRenewal);
					deps.shutdownSignal?.removeEventListener("abort", stopLeaseRenewal);
					releaseCompartmentLeaseBestEffort(
						deps.db,
						sessionId,
						leaseHolder,
						sessionLog,
					);
				}

				const afterEnd = getLastCompartmentEndMessage(deps.db, sessionId);
				if (afterEnd <= lastEnd) {
					failure = `No forward progress after chunk ${chunkIndex}; wrapped up through message ${lastEnd}. Run /ctx-wrapup again to continue.`;
					break;
				}
				lastEnd = afterEnd;
			}

			const finalEnd = getLastCompartmentEndMessage(deps.db, sessionId);
			if (!failure && finalEnd + 1 < targetEligibleEndOrdinal) {
				failure = `Wrapped up through message ${finalEnd}, but no runnable wrapup boundary remained before target message ${targetEligibleEndOrdinal}. Run /ctx-wrapup again to continue.`;
			}
			const finalCompartmentCount = getCompartments(deps.db, sessionId).length;
			const messagesWrapped = Math.max(0, finalEnd - startEnd);
			const compartmentsCreated = Math.max(
				0,
				finalCompartmentCount - startCompartmentCount,
			);
			if (failure) {
				return `## Magic Wrapup — Partial\n\nWrapped up ${messagesWrapped} messages into ${compartmentsCreated} compartments; ${failure}`;
			}
			try {
				clearEmergencyRecovery(deps.db, sessionId);
			} catch {
				// Best-effort: normal historian recovery disarm remains the backstop.
			}
			return `## Magic Wrapup\n\nWrapped up ${messagesWrapped} messages into ${compartmentsCreated} compartments. The compacted history is queued and materializes on your next message.`;
		} finally {
			clearInterval(renewal);
			deps.shutdownSignal?.removeEventListener("abort", stopRenewal);
			releaseWrapupInProgress(deps.db, sessionId, holderId);
		}
	} finally {
		unregister();
	}
}

function resolvePiContextLimit(
	ctx: ExtensionCommandContext,
	db: ContextDatabase,
	sessionId: string,
): number {
	const usage = ctx.getContextUsage?.();
	let detectedContextLimit: number | undefined;
	try {
		const detected = getOverflowState(db, sessionId).detectedContextLimit;
		if (detected > 0) detectedContextLimit = detected;
	} catch {
		// Wrap-up can continue with the runtime model window.
	}
	return (
		resolvePiUsableContextLimit({
			rawContextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
			rawContextWindowSource: "catalog",
			model: ctx.model,
			detectedContextLimit,
		}) ?? 128_000
	);
}

async function acquireCompartmentLeaseEventually(
	db: ContextDatabase,
	sessionId: string,
	renewWrapupMarker: (
		updates: Parameters<typeof updateWrapupInProgress>[3],
	) => boolean,
	maxWaitMs: number,
	signal?: AbortSignal,
): Promise<LeaseAcquireResult> {
	const waitStartedAt = Date.now();
	const remainingMs = (): number =>
		Math.max(0, waitStartedAt + maxWaitMs - Date.now());
	for (;;) {
		if (signal?.aborted) return { ok: false, reason: "ownership_lost" };
		if (remainingMs() <= 0) return { ok: false, reason: "timeout" };
		const holderId = crypto.randomUUID();
		const lease = acquireCompartmentLease(db, sessionId, holderId);
		if (lease) return { ok: true, holderId };
		if (!renewWrapupMarker({})) return { ok: false, reason: "ownership_lost" };
		await new Promise<void>((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", finish);
				resolve();
			};
			const timer = setTimeout(finish, Math.min(LEASE_WAIT_MS, remainingMs()));
			signal?.addEventListener("abort", finish, { once: true });
			if (signal?.aborted) finish();
		});
	}
}

function estimateChunks(tokens: number, chunkTokens: number): number {
	return Math.max(1, Math.ceil(Math.max(0, tokens) / Math.max(1, chunkTokens)));
}

function formatExistingWrapup(
	state: ReturnType<typeof getWrapupInProgressState>,
): string {
	if (!state) {
		return "## Magic Wrapup — Skipped\n\nAnother /ctx-wrapup is already compacting this session. Wait for it to finish, then try again.";
	}
	return `## Magic Wrapup — Skipped\n\nAnother /ctx-wrapup is already compacting this session (chunk ${state.chunkIndex}/${Math.max(state.chunkIndex, state.expectedChunks)}, wrapped through message ${state.lastCompartmentEnd}). Wait for it to finish, then try again.`;
}

/**
 * The live branch for the native compaction marker step, read fresh on each
 * call. Pi and Oh My Pi both return `getBranch()` as an array of entries.
 * An unreadable branch is empty, which keeps the marker waiting (the ordinal
 * alignment cannot find its anchor in it) instead of guessing a cut.
 */
export function readPiWrapupBranchEntries(
	ctx: Pick<ExtensionCommandContext, "sessionManager">,
): unknown[] {
	const sessionManager = ctx.sessionManager as
		| { getBranch?: () => unknown }
		| undefined;
	if (typeof sessionManager?.getBranch !== "function") return [];
	try {
		const branch = sessionManager.getBranch.call(sessionManager);
		return Array.isArray(branch) ? branch : [];
	} catch {
		return [];
	}
}

import { inRootAsyncContext } from "@magic-context/core/shared/sqlite";
