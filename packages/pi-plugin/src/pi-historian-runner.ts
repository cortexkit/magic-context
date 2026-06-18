/**
 * Pi historian runner — Step 4b.3b.
 *
 * Mirrors `compartment-runner-incremental.ts` (OpenCode) but uses
 * `PiSubagentRunner` (spawns `pi --print --mode json` subprocess) for the
 * actual historian invocation instead of `client.session.create` + prompt.
 *
 * What this runner does:
 *   1. Read existing compartments + facts for this session
 *   2. Validate stored compartments are sane
 *   3. Compute eligible chunk start (after last compartment, before protected tail)
 *   4. Read raw chunk via shared `readSessionChunk` (using Pi RawMessageProvider)
 *   5. Build prompt via shared `buildCompartmentAgentPrompt`
 *   6. Spawn historian subagent via `PiSubagentRunner.run()`
 *   7. Parse + validate output via shared `validateHistorianOutput`
 *   8. On validation failure: try repair pass (one retry)
 *   9. Append new compartments + replace facts atomically
 *  10. Queue drops for compartmentalized message range
 *  11. Promote facts to project memories (if memory.enabled + auto_promote)
 *  12. Emit success notification (if notifier provided)
 *
 * What this runner does NOT do (deferred to later slices):
 *   - OpenCode-style compaction markers (Pi has native compaction)
 *   - Compressor pass (Step 4b.4 territory)
 *   - Two-pass editor mode (config option, defer)
 *   - Note nudge triggers (Step 4b.4 territory)
 *   - Emergency 95% recovery (defer)
 *   - User memory candidate extraction (defer to dedicated slice)
 *   - In-flight cancellation via AbortSignal (PiSubagentRunner handles per-run timeout)
 *
 * Failure handling philosophy: like OpenCode, this runner is fail-closed —
 * any validation/parse/spawn failure leaves stored compartments untouched
 * and increments the historian failure counter so the next pass can
 * react. We never write partial state.
 *
 * Logs go through the shared sessionLog so OpenCode log-tailing tools
 * see Pi runs in the same `[magic-context][ses_xxx]` format.
 */

import * as crypto from "node:crypto";
import { withContentLanguageDirective } from "@magic-context/core/agents/language-directive";
import { embedAndStoreCompartmentChunks } from "@magic-context/core/features/magic-context/compartment-embedding";
import { insertCompartmentEvents } from "@magic-context/core/features/magic-context/compartment-events";
import { isCompartmentLeaseHeld } from "@magic-context/core/features/magic-context/compartment-lease";
import {
	appendCompartments,
	getCompartments,
} from "@magic-context/core/features/magic-context/compartment-storage";
import {
	embedPromotedFacts,
	promoteSessionFactsDurable,
} from "@magic-context/core/features/magic-context/memory";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { getMemoriesByProject } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { promoteSkillObservations } from "@magic-context/core/features/magic-context/skill-memory/promote";
import {
	clearEmergencyDrainLatch,
	clearEmergencyRecovery,
	clearHistorianDrainFailure,
	clearHistorianFailureState,
	getOverflowState,
	incrementHistorianFailure,
	isWrapupInProgress,
	recordHistorianDrainFailure,
	recordProtectedTailPublicationFloor,
	reserveProtectedTailDrainTokens,
	rollbackProtectedTailDrainReservation,
	setPendingPiCompactionMarkerState,
} from "@magic-context/core/features/magic-context/storage";
import {
	type HistorianRunInput,
	recordHistorianRun,
	summarizeImportance,
	tallyFactsByCategory,
} from "@magic-context/core/features/magic-context/storage-historian-runs";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import { insertPrimerCandidates } from "@magic-context/core/features/magic-context/storage-primers";
import { getLatestHistorianInvocationId } from "@magic-context/core/features/magic-context/storage-subagent-invocations";
import { insertUserMemoryCandidates } from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import {
	buildCompartmentAgentPrompt,
	buildHistorianEditorPrompt,
	COMPARTMENT_AGENT_SYSTEM_PROMPT,
	HISTORIAN_EDITOR_SYSTEM_PROMPT,
} from "@magic-context/core/hooks/magic-context/compartment-prompt";
import { queueDropsForCompartmentalizedMessages } from "@magic-context/core/hooks/magic-context/compartment-runner-drop-queue";
import {
	buildHistorianFailureNotice,
	buildHistorianRepairPrompt,
	HISTORIAN_BOUNDARY_HEALING_SLACK,
	shouldDiscardLastHistorianCompartment,
	validateChunkCoverage,
	validateHistorianOutput,
	validateStoredCompartments,
} from "@magic-context/core/hooks/magic-context/compartment-runner-validation";
import { renderMemoryBlock } from "@magic-context/core/hooks/magic-context/inject-compartments";
import { onNoteTrigger } from "@magic-context/core/hooks/magic-context/note-nudger";
import {
	createDefaultBoundarySnapshotForTests,
	hasRunnableCompartmentWindow,
	type ProtectedTailBoundarySnapshot,
	recordHighPressureNoEligibleHead,
	selectPerRunCap,
	validateBoundarySnapshot,
} from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import {
	type RawMessageProvider,
	readSessionChunk,
	withRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { buildReferenceBlocks } from "@magic-context/core/hooks/magic-context/reference-retrieval";
import { describeError } from "@magic-context/core/shared/error-message";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";
import type {
	SubagentProgressEvent,
	SubagentRunner,
	SubagentRunOptions,
	SubagentRunResult,
} from "@magic-context/core/shared/subagent-runner";

import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import {
	convertEntriesToRawMessages,
	SYNTH_USER_ID_PREFIX,
} from "./read-session-pi";

const HISTORIAN_AGENT_NAME = "magic-context-historian";
const DEFAULT_HISTORIAN_TIMEOUT_MS = 120_000;
const MAX_HISTORIAN_RETRIES = 2;

/** Keep historian alert noise to once per minute per session. */
const HISTORIAN_ALERT_COOLDOWN_MS = 60 * 1000;
const lastHistorianAlertBySession = new Map<string, number>();

function getHistorianRetryBackoffMs(retryIndex: number): number {
	if (retryIndex === 0) {
		return 2_000 + Math.floor(Math.random() * 1_001);
	}

	return 6_000 + Math.floor(Math.random() * 2_001);
}

function isTransientHistorianPromptError(message: string): boolean {
	const normalized = message.toLowerCase();
	if (
		normalized.includes("invalid request") ||
		normalized.includes("bad request") ||
		normalized.includes("unauthorized") ||
		normalized.includes("forbidden") ||
		normalized.includes("authentication") ||
		normalized.includes("auth") ||
		normalized.includes(" 400") ||
		normalized.startsWith("400")
	) {
		return false;
	}

	return [
		"429",
		"rate limit",
		"timeout",
		"econnreset",
		"etimedout",
		"503",
		"502",
		"500",
		"overloaded",
	].some((token) => normalized.includes(token));
}

function isTransientHistorianRunFailure(
	result: Extract<SubagentRunResult, { ok: false }>,
): boolean {
	if (result.reason === "abort") return false;
	if (result.reason === "timeout") return true;
	return isTransientHistorianPromptError(result.error);
}

function historianAbortResult(startedAt: number): SubagentRunResult {
	return {
		ok: false,
		reason: "abort",
		error: "pi subagent aborted by caller",
		durationMs: Date.now() - startedAt,
	};
}

async function sleepWithAbort(
	ms: number,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) return true;
	if (ms <= 0) return signal?.aborted === true;

	return new Promise<boolean>((resolve) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const finish = (aborted: boolean) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			resolve(aborted);
		};
		const onAbort = () => finish(true);
		signal?.addEventListener("abort", onAbort, { once: true });
		timeout = setTimeout(() => finish(false), ms);
	});
}

async function runHistorianSubagentWithTransientRetries(args: {
	runner: SubagentRunner;
	options: SubagentRunOptions;
	sessionId: string;
	passLabel: string;
	retryBackoffMs?: (retryIndex: number) => number;
}): Promise<SubagentRunResult> {
	const startedAt = Date.now();
	if (args.options.signal?.aborted) return historianAbortResult(startedAt);

	for (
		let retryIndex = 0;
		retryIndex <= MAX_HISTORIAN_RETRIES;
		retryIndex += 1
	) {
		const attemptStart = Date.now();
		let result: SubagentRunResult;
		try {
			result = await args.runner.run({
				...args.options,
				// The historian runner owns fallback iteration because every candidate's
				// output must be parsed and validated before the chain can stop.
				fallbackModels: undefined,
			});
		} catch (error) {
			const desc = describeError(error);
			result = {
				ok: false,
				reason: "model_failed",
				error: desc.brief,
				durationMs: Date.now() - attemptStart,
			};
		}

		if (result.ok) return result;
		if (result.reason === "abort" || args.options.signal?.aborted) {
			return result.reason === "abort"
				? result
				: historianAbortResult(startedAt);
		}

		const shouldRetry =
			retryIndex < MAX_HISTORIAN_RETRIES &&
			isTransientHistorianRunFailure(result);
		if (!shouldRetry) return result;

		const backoffMs =
			args.retryBackoffMs?.(retryIndex) ??
			getHistorianRetryBackoffMs(retryIndex);
		sessionLog(
			args.sessionId,
			`historian[${args.passLabel}] transient failure; retry ${retryIndex + 1}/${MAX_HISTORIAN_RETRIES} on same model after ${backoffMs}ms: ${result.error}`,
		);
		const aborted = await sleepWithAbort(backoffMs, args.options.signal);
		if (aborted) return historianAbortResult(startedAt);
	}

	return historianAbortResult(startedAt);
}

function buildHistorianFallbackChain(
	primaryModel: string,
	fallbackModels?: readonly string[],
	fallbackModelId?: string,
): Array<{ modelId: string; kind: "configured" | "session" }> {
	const seen = new Set<string>();
	if (primaryModel) seen.add(primaryModel);
	const chain: Array<{ modelId: string; kind: "configured" | "session" }> = [];
	for (const candidate of fallbackModels ?? []) {
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		chain.push({ modelId: candidate, kind: "configured" });
	}
	if (fallbackModelId && !seen.has(fallbackModelId)) {
		chain.push({ modelId: fallbackModelId, kind: "session" });
	}
	return chain;
}

function parseSourceMessageTime(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const numeric = Number(value);
		if (Number.isFinite(numeric) && numeric > 0) return numeric;
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function truncateHistorianInputIfNeeded(text: string, budget: number): string {
	if (estimateTokens(text) <= budget) return text;
	let lo = 0;
	let hi = text.length;
	let best = 0;
	const marker =
		"\n[… tokens truncated by Magic Context to fit the historian window …]";
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (estimateTokens(text.slice(0, mid) + marker) <= budget) {
			best = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return text.slice(0, best) + marker;
}

function shouldSuppressHistorianAlert(sessionId: string): boolean {
	const last = lastHistorianAlertBySession.get(sessionId);
	if (last && Date.now() - last < HISTORIAN_ALERT_COOLDOWN_MS) return true;
	lastHistorianAlertBySession.set(sessionId, Date.now());
	return false;
}

/** Cleanup module-scope state on session deletion. */
export function clearPiHistorianAlertState(sessionId: string): void {
	lastHistorianAlertBySession.delete(sessionId);
}

export interface PiHistorianDeps {
	/** SQLite handle for the shared cortexkit DB. */
	db: Database;
	/** Pi-resolved sessionId (from `pi.sessionManager.getSessionId()`). */
	sessionId: string;
	/** Project working directory (used for memory project-identity scoping). */
	directory: string;
	/** Provider that resolves `readRawSessionMessages(sessionId)` to Pi data. */
	provider: RawMessageProvider;
	/** Subagent runner (PiSubagentRunner instance) for historian spawn. */
	runner: SubagentRunner;
	/** Historian model id (provider/model) — required for PiSubagentRunner. */
	historianModel: string;
	/** Optional ordered fallback chain. */
	fallbackModels?: readonly string[];
	/** Live session model used as the final fallback after configured fallbacks. */
	fallbackModelId?: string;
	/** Historian context window — used to derive chunk token budget. */
	historianChunkTokens: number;
	/** Boundary resolved by the Pi trigger/recovery decision with the real model context. */
	boundarySnapshot?: ProtectedTailBoundarySnapshot;
	/**
	 * Optional live boundary resolver used only to recover a stale trigger snapshot.
	 * It must recompute against the currently registered Pi raw-message provider.
	 */
	refreshBoundarySnapshot?: () => ProtectedTailBoundarySnapshot;
	/** Current resolved context limit used to reject stale snapshots after model switches. */
	currentContextLimit?: number;
	/** Optional per-call timeout (default 120s). */
	historianTimeoutMs?: number;
	/** Optional cancellation signal for the historian run and retry backoff. */
	signal?: AbortSignal;
	/** Test seam for transient retry backoff. Defaults to OpenCode's retry cadence. */
	retryBackoffMs?: (retryIndex: number) => number;
	/** When true, run a second editor pass after a successful first pass to
	 *  clean low-signal U: lines and cross-compartment duplicates. Mirrors
	 *  OpenCode's `historian.two_pass` config. Editor validation falls back
	 *  to the first-pass result on failure. Default: false. */
	twoPass?: boolean;
	/** Pi only: explicit thinking level passed as --thinking <level> to
	 *  historian subagent invocations. When unset, Pi's own resolution runs
	 *  (works for most providers; may fail for e.g. github-copilot/gpt-5.4). */
	thinkingLevel?: string;
	/** Cross-session memory feature gate (`memory.enabled`). */
	memoryEnabled?: boolean;
	/** Allow a session started exactly in the canonical home directory only when user-level configuration enables it. */
	allowHomeProject?: boolean;
	/** Automatic-promotion gate (`memory.auto_promote`). */
	autoPromote?: boolean;
	/** User-memory feature gate (`dreamer.user_memories.enabled`). Gates whether
	 *  historian-extracted user observations are persisted as candidates. */
	userMemoriesEnabled?: boolean;
	language?: string;
	/** Optional callback invoked on successful publication for cache-bust signaling. */
	onPublished?: () => void;
	/** Holder id for the DB-backed compartment-state lease guarding publish paths. */
	compartmentLeaseHolderId?: string;
	/** Optional Pi-native compaction append hook (`sessionManager.appendCompaction`). */
	appendCompaction?: (
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: unknown,
		fromHook?: boolean,
	) => string | undefined;
	/** Optional raw Pi branch entries used to map raw ordinals back to entry ids. */
	readBranchEntries?: () => unknown[];
	/** Optional callback for surfacing failure notices (Pi UI / logs). */
	notifyIssue?: (message: string) => void | Promise<void>;
	/** Test seam / embedding bootstrap override. Defaults to Pi directory registration. */
	ensureProjectRegistered?: (
		directory: string,
		db: Database,
	) => void | Promise<void>;
	/** Manual wrapup bypasses the pressure-window quota but keeps no-progress protection. */
	forceDrainQuota?: boolean;
	/** Persist the final weak-lookahead compartment for coverage while skipping promotion. */
	forceKeepLastCompartment?: boolean;
}

export async function runPiHistorian(deps: PiHistorianDeps): Promise<void> {
	const {
		db,
		sessionId,
		directory,
		provider,
		runner,
		historianModel,
		fallbackModels,
		fallbackModelId,
		historianChunkTokens,
		boundarySnapshot: providedBoundarySnapshot,
		refreshBoundarySnapshot,
		currentContextLimit,
		historianTimeoutMs = DEFAULT_HISTORIAN_TIMEOUT_MS,
		signal,
		retryBackoffMs,
		twoPass,
		thinkingLevel,
		memoryEnabled,
		allowHomeProject,
		autoPromote,
		userMemoriesEnabled,
		onPublished,
		compartmentLeaseHolderId,
		readBranchEntries,
		notifyIssue,
		ensureProjectRegistered = ensureProjectRegisteredFromPiDirectory,
		forceDrainQuota,
		forceKeepLastCompartment,
	} = deps;

	let issueNotified = false;
	const notify = async (message: string): Promise<void> => {
		issueNotified = true;
		if (shouldSuppressHistorianAlert(sessionId)) {
			sessionLog(sessionId, "historian alert suppressed (cooldown)");
			return;
		}
		try {
			await notifyIssue?.(message);
		} catch (error) {
			sessionLog(sessionId, "historian notify failed", {
				error: describeError(error).brief,
			});
		}
	};

	updateSessionMeta(db, sessionId, { compartmentInProgress: true });

	// historian_runs telemetry (migration v24) — recorded ONCE in finally so every
	// exit path is logged. Best-effort. Mirrors the OpenCode incremental runner.
	const invocationBaseline = getLatestHistorianInvocationId(db, sessionId);
	const telemetry: Partial<HistorianRunInput> = {
		runKind: "incremental",
		status: "failed",
	};
	let completedSuccessfully = false;
	let retainDrainReservationForRetryThrottle = false;
	let drainReservation: ReturnType<
		typeof reserveProtectedTailDrainTokens
	>["reservation"] = null;
	const rollbackDrainReservation = (): void => {
		if (!drainReservation) return;
		rollbackProtectedTailDrainReservation(db, drainReservation);
		drainReservation = null;
	};

	try {
		// All session-data reads in the historian path go through the shared
		// helpers, which consult our RawMessageProvider for this sessionId.
		// The withRawMessageProvider scope ensures we unregister even on throw.
		await withRawMessageProvider(sessionId, provider, async () => {
			const priorCompartments = getCompartments(db, sessionId);

			// Sanity-check existing stored state before touching anything.
			const existingValidationError =
				validateStoredCompartments(priorCompartments);
			if (existingValidationError) {
				sessionLog(
					sessionId,
					`historian failure: source=existing-validation reason="${existingValidationError}"`,
				);
				{
					const failCount = incrementHistorianFailure(
						db,
						sessionId,
						existingValidationError,
					);
					await notify(
						buildHistorianFailureNotice(failCount, existingValidationError),
					);
				}
				return;
			}

			// Where does the new chunk start?
			const offset =
				priorCompartments.length > 0
					? priorCompartments[priorCompartments.length - 1].endMessage + 1
					: 1;

			let boundarySnapshot =
				providedBoundarySnapshot ??
				(process.env.NODE_ENV === "test"
					? createDefaultBoundarySnapshotForTests(sessionId)
					: null);
			if (!boundarySnapshot) {
				sessionLog(
					sessionId,
					"historian no-op: missing protected-tail boundary snapshot from Pi trigger decision",
				);
				return;
			}
			let validation =
				boundarySnapshot.rawRangeFingerprint.length > 0
					? validateBoundarySnapshot({
							db,
							snapshot: boundarySnapshot,
							currentContextLimit:
								currentContextLimit ?? boundarySnapshot.contextLimit,
						})
					: { ok: true as const };
			// A boundary captured at trigger time can go stale before the detached
			// historian validates it because new live-tail messages may arrive. Re-resolve
			// once from the current Pi messages and adopt the result only when it still
			// exposes an eligible head. The refreshed snapshot recomputes the protected
			// tail from live messages, so the compacted head cannot include a message that
			// now belongs to the protected tail.
			if (
				!validation.ok &&
				validation.reason === "stale_snapshot" &&
				refreshBoundarySnapshot
			) {
				try {
					const refreshed = refreshBoundarySnapshot();
					if (hasRunnableCompartmentWindow(refreshed)) {
						sessionLog(
							sessionId,
							`historian: refreshed stale protected-tail snapshot at run time (was: ${validation.detail ?? "stale"}) — eligible head ${refreshed.offset}-${refreshed.eligibleEndOrdinal - 1}`,
						);
						boundarySnapshot = refreshed;
						validation = { ok: true };
					}
				} catch (error) {
					const desc = describeError(error);
					sessionLog(
						sessionId,
						`historian: failed to refresh stale protected-tail snapshot at run time (${validation.detail ?? "stale"}): ${desc.brief}`,
					);
				}
			}
			if (!validation.ok) {
				sessionLog(
					sessionId,
					`historian no-op: stale protected-tail snapshot (${validation.detail ?? validation.reason ?? "unknown"})`,
				);
				return;
			}
			const protectedTailStart = boundarySnapshot.protectedTailStart;
			const eligibleEndOrdinal = Math.min(
				boundarySnapshot.eligibleEndOrdinal,
				protectedTailStart,
			);
			if (protectedTailStart <= offset || eligibleEndOrdinal <= offset) {
				sessionLog(
					sessionId,
					`historian no-op: protectedTailStart=${protectedTailStart} eligibleEnd=${eligibleEndOrdinal} <= offset=${offset} — nothing to compact`,
				);
				if (boundarySnapshot.usagePercentage < 80) {
					if (!isWrapupInProgress(db, sessionId))
						clearEmergencyRecovery(db, sessionId);
				} else {
					recordHighPressureNoEligibleHead(db, boundarySnapshot);
				}
				// Tail exhausted — clear the emergency catch-up latch (see OpenCode).
				clearEmergencyDrainLatch(db, sessionId);
				return;
			}

			const perRunCap = selectPerRunCap(boundarySnapshot);
			const usable = Math.max(
				1,
				Math.round(
					(boundarySnapshot.contextLimit *
						boundarySnapshot.executeThresholdPercentage) /
						100,
				),
			);
			const reserve = forceDrainQuota
				? { ok: true as const, reservation: null }
				: reserveProtectedTailDrainTokens({
						db,
						sessionId,
						runId: crypto.randomUUID(),
						trueRawTokens: boundarySnapshot.trueRawEligibleTokens,
						usagePercentage: boundarySnapshot.usagePercentage,
						usable,
						perRunCap,
						executeThresholdPercentage:
							boundarySnapshot.executeThresholdPercentage,
					});
			if (!reserve.ok) {
				sessionLog(
					sessionId,
					`historian rate-limit skip: ${reserve.skippedReason ?? "quota exhausted"}`,
				);
				telemetry.status = "noop";
				telemetry.failureReason = "protected-tail drain quota exhausted";
				return;
			}
			drainReservation = reserve.reservation;

			const chunk = readSessionChunk(
				sessionId,
				historianChunkTokens,
				offset,
				eligibleEndOrdinal,
			);
			const forceKeepLastCompartmentForChunk =
				forceKeepLastCompartment === true && !chunk.hasMore;
			if (!chunk.text || chunk.messageCount === 0) {
				sessionLog(
					sessionId,
					`historian no-op: chunk empty after filtering (messageCount=${chunk.messageCount}, textLen=${chunk.text?.length ?? 0}) range=${offset}-${protectedTailStart - 1}`,
				);
				if (boundarySnapshot.usagePercentage < 80) {
					if (!isWrapupInProgress(db, sessionId))
						clearEmergencyRecovery(db, sessionId);
				} else {
					recordHighPressureNoEligibleHead(db, boundarySnapshot);
				}
				// Eligible head produced no compactable chunk — clear the latch.
				clearEmergencyDrainLatch(db, sessionId);
				telemetry.status = "noop";
				telemetry.failureReason = "chunk empty after filtering";
				rollbackDrainReservation();
				return;
			}

			const chunkCoverageError = validateChunkCoverage(chunk);
			if (chunkCoverageError) {
				sessionLog(
					sessionId,
					`historian failure: source=chunk-coverage reason="${chunkCoverageError}" chunkRange=${chunk.startIndex}-${chunk.endIndex}`,
				);
				{
					const failCount = incrementHistorianFailure(
						db,
						sessionId,
						chunkCoverageError,
					);
					await notify(
						buildHistorianFailureNotice(failCount, chunkCoverageError),
					);
				}
				rollbackDrainReservation();
				return;
			}

			// Build prompt: include prior compartments, facts, AND read-only
			// memory block so historian can dedup new facts against existing
			// project memories. Cross-harness coherence comes free here —
			// memories written by OpenCode show up in this Pi historian run.
			const projectPath = resolveProjectIdentityForSession(
				directory,
				allowHomeProject,
			);
			if (!projectPath) {
				rollbackDrainReservation();
				return;
			}
			const memories = getMemoriesByProject(db, projectPath, [
				"active",
				"permanent",
			]);
			const memoryBlock = renderMemoryBlock(memories) ?? undefined;

			// v2 (E6 parity): bounded reference blocks replace the unbounded
			// existing-state dump. The historian no longer sees ALL prior
			// compartments — it gets 4 rotating cross-project seed examples
			// (importance-band calibration) + the last 6 same-session
			// compartments (continuity) + <project-memory> for fact dedup.
			// Bounded forever regardless of session age, so no temp-file
			// offload is needed. Mirrors the OpenCode incremental runner.
			const projectMemory = memoryBlock ?? "";
			const references = buildReferenceBlocks({
				sessionId,
				chunkStart: chunk.startIndex,
				sessionCompartments: priorCompartments,
			});

			const chunkText = truncateHistorianInputIfNeeded(
				chunk.text,
				historianChunkTokens,
			);
			if (chunkText !== chunk.text) {
				sessionLog(
					sessionId,
					`historian pre-flight: truncated formatted input for ${chunk.startIndex}-${chunk.endIndex} to fit ${historianChunkTokens} tokens`,
				);
			}

			const prompt = buildCompartmentAgentPrompt({
				seedExamples: references.seedExamples,
				sessionReferences: references.sessionReferences,
				projectMemory,
				inputSource: `Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunkText}`,
				memoryEnabled: memoryEnabled !== false,
			});

			// Defensive: use MAX(sequence) + 1 over .length to survive any old
			// recomp gaps. Same logic as OpenCode runner.
			const maxExistingSequence = priorCompartments.reduce(
				(max, c) => (c.sequence > max ? c.sequence : max),
				-1,
			);
			const sequenceOffset =
				priorCompartments.length === 0 ? 0 : maxExistingSequence + 1;

			sessionLog(
				sessionId,
				`historian: invoking subagent (model=${historianModel}, chunk=${chunk.startIndex}-${chunk.endIndex}, ${chunk.messageCount} msgs, ~${chunk.tokenEstimate} tokens)`,
			);

			// Per-pass milestone tracing for the Pi child run. We log the
			// high-signal lifecycle events (`spawned`, `terminal`, `stderr`,
			// `child_exit`) so historian failure timelines stay readable in
			// `magic-context.log`, but skip the full per-event NDJSON stream
			// (`raw_event`, `first_event`) — those were added during the
			// April timeout investigation, served their purpose, and would
			// be excessive in production. If a future hang needs deeper
			// inspection, set MC_PI_HISTORIAN_TRACE=1 to opt into raw-event
			// logging without rebuilding.
			const traceRawEvents = process.env.MC_PI_HISTORIAN_TRACE === "1";
			const buildProgressLogger = (passLabel: string) => {
				return (event: SubagentProgressEvent) => {
					try {
						if (event.type === "spawned") {
							sessionLog(
								sessionId,
								`historian[${passLabel}] spawned pid=${event.pid ?? "?"} argv=${event.argv.length} args`,
							);
						} else if (event.type === "terminal") {
							sessionLog(
								sessionId,
								`historian[${passLabel}] terminal @${event.ms}ms stopReason=${event.stopReason ?? "?"} textLen=${event.textLength} hasToolCall=${event.hasToolCall}`,
							);
						} else if (event.type === "stderr") {
							const cleaned = event.chunk.replace(/\s+/g, " ").trim();
							if (cleaned.length > 0) {
								sessionLog(
									sessionId,
									`historian[${passLabel}] stderr: ${cleaned.slice(0, 500)}`,
								);
							}
						} else if (event.type === "child_exit") {
							sessionLog(
								sessionId,
								`historian[${passLabel}] child_exit @${event.ms}ms code=${event.code} signal=${event.signal}`,
							);
						} else if (traceRawEvents) {
							if (event.type === "raw_event") {
								let serialized: string;
								try {
									serialized = JSON.stringify(event.event);
								} catch {
									serialized = "[unserializable]";
								}
								if (serialized.length > 4000) {
									serialized = `${serialized.slice(0, 4000)}…[truncated ${serialized.length - 4000} chars]`;
								}
								sessionLog(
									sessionId,
									`historian[${passLabel}] raw_event @${event.ms}ms type=${event.eventType ?? "?"}: ${serialized}`,
								);
							} else if (event.type === "first_event") {
								sessionLog(
									sessionId,
									`historian[${passLabel}] first_event @${event.ms}ms type=${event.eventType}`,
								);
							}
						}
					} catch {
						// Logging must never crash the runner.
					}
				};
			};

			retainDrainReservationForRetryThrottle = true;
			const historianSystemPrompt = withContentLanguageDirective(
				COMPARTMENT_AGENT_SYSTEM_PROMPT,
				deps.language,
				{ preserveUserQuotes: true },
			);
			const historianEditorSystemPrompt = withContentLanguageDirective(
				HISTORIAN_EDITOR_SYSTEM_PROMPT,
				deps.language,
				{ preserveUserQuotes: true },
			);

			// First pass.
			const firstResult = await runHistorianSubagentWithTransientRetries({
				runner,
				sessionId,
				passLabel: "first",
				retryBackoffMs,
				options: {
					agent: HISTORIAN_AGENT_NAME,
					systemPrompt: historianSystemPrompt,
					userMessage: prompt,
					model: historianModel,
					timeoutMs: historianTimeoutMs,
					cwd: directory,
					signal,
					thinkingLevel,
					onProgress: buildProgressLogger("first"),
					accountingSessionId: sessionId,
					accountingSubagent: "historian",
				},
			});

			let validatedPass = await validateHistorianResult(
				firstResult,
				sessionId,
				chunk,
				priorCompartments,
				sequenceOffset,
			);
			// Track which subagent run actually produced the validated
			// draft. This matters for the optional two-pass editor refinement
			// below: when first-pass validation fails but repair succeeds,
			// the editor must refine the REPAIR draft (the one that
			// validated), NOT the original first-pass text. Mirrors
			// OpenCode parity in `compartment-runner-historian.ts`,
			// which feeds `firstRun.result` or `repairRun.result` into
			// `runEditorPassOrFallback` based on which run validated.
			let validatedDraftText: string | null = firstResult.ok
				? firstResult.assistantText
				: null;

			// Repair retry on validation failure (mirrors OpenCode behavior).
			if (validatedPass.kind === "validation-failed") {
				sessionLog(
					sessionId,
					`historian: first pass validation failed, retrying with repair prompt: ${validatedPass.error}`,
				);
				const repairPrompt = buildHistorianRepairPrompt(
					prompt,
					validatedPass.rawText,
					validatedPass.error,
					deps.language,
				);
				const repairResult = await runHistorianSubagentWithTransientRetries({
					runner,
					sessionId,
					passLabel: "repair",
					retryBackoffMs,
					options: {
						agent: HISTORIAN_AGENT_NAME,
						systemPrompt: historianSystemPrompt,
						userMessage: repairPrompt,
						model: historianModel,
						timeoutMs: historianTimeoutMs,
						cwd: directory,
						signal,
						thinkingLevel,
						onProgress: buildProgressLogger("repair"),
						accountingSessionId: sessionId,
						accountingSubagent: "historian",
					},
				});
				validatedPass = await validateHistorianResult(
					repairResult,
					sessionId,
					chunk,
					priorCompartments,
					sequenceOffset,
				);
				// If repair produced a valid result, that's the draft we
				// want the editor to refine. (If repair also failed,
				// validatedDraftText doesn't matter — we'll bail before
				// the editor block.)
				if (validatedPass.kind === "ok" && repairResult.ok) {
					validatedDraftText = repairResult.assistantText;
				}
			}

			// Escalate through the fallback chain on empty/invalid output. Each
			// candidate is run and validated explicitly because a model can complete
			// successfully while producing no usable compartments. The live session's
			// current model is appended as the final last-resort candidate.
			const fallbackChain = buildHistorianFallbackChain(
				historianModel,
				fallbackModels,
				fallbackModelId,
			);
			if (
				validatedPass.kind !== "ok" &&
				!(
					validatedPass.kind === "spawn-failed" &&
					validatedPass.reason === "abort"
				) &&
				fallbackChain.length > 0
			) {
				for (let i = 0; i < fallbackChain.length; i += 1) {
					const candidate = fallbackChain[i];
					sessionLog(
						sessionId,
						`historian: escalating to ${candidate.kind === "session" ? "session-model last resort" : "configured fallback model"} ${candidate.modelId}`,
					);
					const fbResult = await runHistorianSubagentWithTransientRetries({
						runner,
						sessionId,
						passLabel:
							candidate.kind === "session" ? "fallback-session" : "fallback",
						retryBackoffMs,
						options: {
							agent: HISTORIAN_AGENT_NAME,
							systemPrompt: historianSystemPrompt,
							userMessage: prompt,
							model: candidate.modelId,
							timeoutMs: historianTimeoutMs,
							cwd: directory,
							signal,
							thinkingLevel,
							onProgress: buildProgressLogger("fallback"),
							accountingSessionId: sessionId,
							accountingSubagent: "historian",
						},
					});
					const fbPass = await validateHistorianResult(
						fbResult,
						sessionId,
						chunk,
						priorCompartments,
						sequenceOffset,
					);
					if (fbPass.kind === "ok") {
						validatedPass = fbPass;
						if (fbResult.ok) validatedDraftText = fbResult.assistantText;
						break;
					}
					if (fbPass.kind === "spawn-failed" && fbPass.reason === "abort") {
						validatedPass = fbPass;
						break;
					}
				}
			}

			if (validatedPass.kind !== "ok") {
				const errorMsg =
					validatedPass.kind === "validation-failed"
						? validatedPass.error
						: validatedPass.kind === "spawn-failed"
							? `subagent run failed (${validatedPass.reason}): ${validatedPass.error}`
							: "historian returned no usable text";
				sessionLog(sessionId, `historian failure: ${errorMsg}`);
				{
					const failCount = incrementHistorianFailure(db, sessionId, errorMsg);
					await notify(buildHistorianFailureNotice(failCount, errorMsg));
				}
				return;
			}
			retainDrainReservationForRetryThrottle = false;

			// Optional two-pass editor refinement. Mirrors OpenCode's
			// `runEditorPassOrFallback` in `compartment-runner-historian.ts`.
			// When `historian.two_pass` is enabled, the validated draft is
			// fed back to the historian agent with the editor system
			// prompt. The editor cleans low-signal U: lines and
			// cross-compartment redundancy. If the editor pass fails or
			// its output fails validation, we fall back to the draft.
			if (twoPass && validatedPass.kind === "ok") {
				// Feed the editor the draft that ACTUALLY validated. Without
				// this fix, when first-pass spawn-failed and repair succeeded,
				// the editor would silently get an empty string and skip the
				// editor pass entirely (silent feature regression). When
				// first-pass validation-failed (parsed but invalid) and repair
				// succeeded, the editor would refine the BAD original draft
				// instead of the repaired one. See parity audit Round 7.
				const draftAssistantText = validatedDraftText ?? "";
				if (draftAssistantText.trim().length > 0) {
					sessionLog(sessionId, "historian two-pass: running editor on draft");
					const editorResult = await runHistorianSubagentWithTransientRetries({
						runner,
						sessionId,
						passLabel: "editor",
						retryBackoffMs,
						options: {
							agent: HISTORIAN_AGENT_NAME,
							systemPrompt: historianEditorSystemPrompt,
							userMessage: buildHistorianEditorPrompt(draftAssistantText),
							model: historianModel,
							timeoutMs: historianTimeoutMs,
							cwd: directory,
							signal,
							thinkingLevel,
							onProgress: buildProgressLogger("editor"),
							accountingSessionId: sessionId,
							accountingSubagent: "historian_editor",
						},
					});
					const editorPass = await validateHistorianResult(
						editorResult,
						sessionId,
						chunk,
						priorCompartments,
						sequenceOffset,
					);
					if (editorPass.kind === "ok") {
						sessionLog(
							sessionId,
							`historian two-pass: editor accepted, replacing draft`,
						);
						validatedPass = editorPass;
					} else {
						const editorErr =
							editorPass.kind === "validation-failed"
								? editorPass.error
								: editorPass.kind === "spawn-failed"
									? `subagent run failed (${editorPass.reason}): ${editorPass.error}`
									: "editor returned no usable text";
						sessionLog(
							sessionId,
							`historian two-pass: editor failed (${editorErr}), falling back to draft`,
						);
						// Keep validatedPass as the first-pass result.
					}
				}
			}

			// Discard-last boundary healing (E6 parity with OpenCode): the LAST
			// compartment of a greedy-consume run was decided WITHOUT lookahead,
			// so its boundary is structurally unreliable. If historian consumed
			// ~the whole chunk (≤ SLACK messages of lookahead past the last
			// compartment), drop that provisional compartment so it's re-derived
			// next run with real following context (offset re-reads its range).
			// Require at least two emitted compartments so one remains and publication
			// advances; never leave the persisted boundary inside a completed invocation/
			// result pair; and retain everything during emergency recovery for immediate
			// space relief. Outside emergency recovery, the next run safely re-derives a
			// discarded compartment with additional following context.
			const inEmergency = getOverflowState(
				db,
				sessionId,
			).needsEmergencyRecovery;
			const emittedCompartments = validatedPass.compartments;
			let newCompartments = emittedCompartments;
			if (
				!inEmergency &&
				!forceKeepLastCompartmentForChunk &&
				shouldDiscardLastHistorianCompartment(emittedCompartments, chunk)
			) {
				const lastEmitted = emittedCompartments[emittedCompartments.length - 1];
				const lookaheadMargin = chunk.endIndex - lastEmitted.endMessage;
				newCompartments = emittedCompartments.slice(0, -1);
				sessionLog(
					sessionId,
					`historian discard-last: dropped provisional compartment ${lastEmitted.startMessage}-${lastEmitted.endMessage} (lookaheadMargin=${lookaheadMargin} <= ${HISTORIAN_BOUNDARY_HEALING_SLACK}); will re-derive next run`,
				);
			}
			const lastNewEnd =
				newCompartments[newCompartments.length - 1]?.endMessage ?? 0;
			if (lastNewEnd + 1 <= offset) {
				const errorMsg = `historian returned compartments that did not advance past raw message ${offset - 1}`;
				sessionLog(
					sessionId,
					`historian failure: source=no-progress newCompartmentCount=${newCompartments.length} lastNewEnd=${lastNewEnd} priorEnd=${offset - 1}`,
				);
				{
					const failCount = incrementHistorianFailure(db, sessionId, errorMsg);
					await notify(buildHistorianFailureNotice(failCount, errorMsg));
				}
				rollbackDrainReservation();
				return;
			}

			const markerSummary = buildPiCompactionSummary(newCompartments);
			const lastNewEndMessageId =
				newCompartments[newCompartments.length - 1]?.endMessageId;
			let firstKeptEntryId: string | null = null;
			if (readBranchEntries) {
				try {
					firstKeptEntryId = findFirstKeptEntryId(
						readBranchEntries(),
						lastNewEnd,
					);
					if (!firstKeptEntryId) {
						sessionLog(
							sessionId,
							`historian: native compaction queue skipped; no firstKeptEntryId after ordinal ${lastNewEnd}`,
						);
					}
				} catch (error) {
					sessionLog(
						sessionId,
						`historian: native compaction queue lookup failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}

			// A wrapup caller may request final weak-lookahead preservation, but the
			// runner is authoritative: a token-capped chunk (`chunk.hasMore`) still has
			// more raw history after it, so it must use normal discard-last healing and
			// promotion. Only the actual final chunk keeps its weak-lookahead tail and
			// skips unanchored promotion.
			const discardedLast = newCompartments.length < emittedCompartments.length;
			const weakLookaheadFinalCompartment = forceKeepLastCompartmentForChunk;
			// discard-last runs must also skip unanchored promotion: facts cannot be
			// attributed to the persisted range, and a reworded re-emission next run
			// would double-store.
			const skipUnanchoredPromotion =
				discardedLast || weakLookaheadFinalCompartment;

			// Two distinct gates (parity with OpenCode): embeddingActive = memory
			// feature on (drives registration + embedding, the ctx_search / dreamer
			// linking substrate); promotionActive additionally requires auto_promote
			// (drives writing facts as memories).
			const embeddingActive = memoryEnabled !== false;
			const promotionActive = embeddingActive && autoPromote !== false;

			// Events: stored, NOT rendered. Best-effort. discard-last: drop events
			// anchored to the discarded provisional compartment.
			const publishableEvents = (validatedPass.events ?? []).filter((e) => {
				if (typeof e.atCompartment !== "number")
					return !weakLookaheadFinalCompartment;
				if (e.atCompartment > newCompartments.length) return false;
				if (
					weakLookaheadFinalCompartment &&
					e.atCompartment >= emittedCompartments.length
				)
					return false;
				return true;
			});
			let promotedFactRefs: Array<{ memoryId: number; content: string }> = [];
			let persistedIds: number[] = [];

			// Atomic publication: append + durable facts/events/drop queue + clear failure state.
			// The Pi-native compaction marker payload is staged in the same
			// transaction so a crash cannot leave compartments without a queued
			// marker for the deferred materializing drain. BEGIN IMMEDIATE keeps the
			// holder check and writes on one fresh write-locked snapshot.
			if (!compartmentLeaseHolderId) {
				sessionLog(
					sessionId,
					"historian publish skipped: missing compartment lease holder",
				);
				rollbackDrainReservation();
				return;
			}
			let published = false;
			db.exec("BEGIN IMMEDIATE");
			try {
				if (!isCompartmentLeaseHeld(db, sessionId, compartmentLeaseHolderId)) {
					db.exec("ROLLBACK");
					sessionLog(
						sessionId,
						"historian publish skipped: compartment lease no longer held",
					);
					rollbackDrainReservation();
					return;
				}
				appendCompartments(db, sessionId, newCompartments);
				// Resolve durable ids for the just-appended compartments (last N rows by
				// sequence — appendCompartments inserts at the tail). Used for events
				// anchoring + post-commit embeddings.
				persistedIds = getCompartments(db, sessionId)
					.slice(-newCompartments.length)
					.map((c) => c.id);
				// v2 faithful fact lifecycle (E6 parity): facts are no longer a
				// REPLACE-the-whole-list store. The historian emits only THIS
				// chunk's facts (deduped against <project-memory> in the prompt);
				// they flow to project memory via in-transaction durable promotion.
				// No replaceSessionFacts — promoted facts reach the agent through the
				// renderer's m[1] new-memories watermark. Promotion is in the SAME
				// transaction as the boundary floor below, so both commit or both roll back.
				if (promotionActive && !skipUnanchoredPromotion) {
					promotedFactRefs = promoteSessionFactsDurable(
						db,
						sessionId,
						projectPath,
						validatedPass.facts ?? [],
					);
				}

				if (publishableEvents.length > 0) {
					try {
						insertCompartmentEvents(
							db,
							sessionId,
							publishableEvents,
							persistedIds,
						);
						sessionLog(
							sessionId,
							`stored ${publishableEvents.length} compartment event(s)`,
						);
					} catch (error) {
						sessionLog(sessionId, "failed to store compartment events:", error);
					}
				}

				queueDropsForCompartmentalizedMessages(db, sessionId, lastNewEnd);

				clearHistorianFailureState(db, sessionId);
				// Healthy historian progress clears the drain-failure backoff. Normal
				// runs also clear overflow recovery; wrapup keeps it armed until the loop
				// reaches the keep watermark.
				clearHistorianDrainFailure(db, sessionId);
				recordProtectedTailPublicationFloor(db, sessionId, lastNewEnd + 1);
				if (!isWrapupInProgress(db, sessionId))
					clearEmergencyRecovery(db, sessionId);
				// userObservations are inserted POST-COMMIT
				// (best-effort, below), not inside this publish transaction. An
				// auxiliary user_memory_candidates failure must never roll back
				// compartment publication. Mirrors OpenCode.
				if (firstKeptEntryId && lastNewEndMessageId) {
					setPendingPiCompactionMarkerState(db, sessionId, {
						firstKeptEntryId,
						endMessageId: lastNewEndMessageId,
						ordinal: lastNewEnd,
						tokensBefore: chunk.tokenEstimate,
						summary: markerSummary,
						publishedAt: Date.now(),
					});
				}
				db.exec("COMMIT");
				published = true;
			} finally {
				if (!published) {
					try {
						db.exec("ROLLBACK");
					} catch {
						// Transaction may already be closed by an early rollback.
					}
				}
			}

			// Signal deferred materialization/history-refresh immediately after COMMIT.
			// All publish-visible durable state (compartments, boundary floor, promoted
			// facts, event attempts, and drop queue) is already in the transaction above;
			// embedding registration and provider calls below are post-commit best-effort
			// and must never leave a committed publish marked failed or unsignaled.
			onPublished?.();
			completedSuccessfully = true;

			sessionLog(
				sessionId,
				`historian: published ${newCompartments.length} compartment(s), ${validatedPass.facts?.length ?? 0} fact(s) covering messages ${chunk.startIndex}-${lastNewEnd}`,
			);

			// Note-nudge trigger #1 (of 3): historian publication is a natural
			// work boundary, so signal that deferred notes should surface on
			// the next user turn. Mirrors OpenCode's placement.
			onNoteTrigger(db, sessionId, "historian_complete");

			// user observations are inserted POST-COMMIT,
			// best-effort, so an auxiliary failure never rolls back the publish.
			// Gated on the user-memory feature so opted-out users never have
			// behavioral candidates persisted (privacy parity with OpenCode).
			if (
				userMemoriesEnabled === true &&
				!skipUnanchoredPromotion &&
				validatedPass.userObservations?.length
			) {
				try {
					insertUserMemoryCandidates(
						db,
						validatedPass.userObservations.map((obs) => ({
							content: obs,
							sessionId,
							sourceCompartmentStart: newCompartments[0]?.startMessage,
							sourceCompartmentEnd: lastNewEnd,
						})),
					);
					sessionLog(
						sessionId,
						`stored ${validatedPass.userObservations.length} user memory candidate(s)`,
					);
				} catch (error) {
					sessionLog(
						sessionId,
						"failed to store user memory candidates:",
						error,
					);
				}
			}

			// Primers v1 are recall-only side-table writes (dashboard + ctx_search),
			// never prompt injection. They use the same actual-final weak-lookahead
			// gate as facts and observations.
			if (
				!skipUnanchoredPromotion &&
				validatedPass.primerCandidates?.length &&
				projectPath
			) {
				try {
					const firstNew = newCompartments[0];
					const lastNew = newCompartments[newCompartments.length - 1];
					// Stable occurrence key intentionally excludes question text, so a
					// source chunk stores at most one candidate occurrence (its
					// origin-compartment tag is the single tagged origin).
					const [candidate] = validatedPass.primerCandidates;
					// Origin-tag (mirrors OpenCode): narrow the source to the SPECIFIC
					// compartment the question came from. originCompartmentIndex is
					// 1-based into the emitted list (same convention as <events>);
					// chunk-span fallback when untagged or out of range (non-fatal).
					const idx = candidate.originCompartmentIndex;
					const origin =
						typeof idx === "number" && idx >= 1 && idx <= newCompartments.length
							? newCompartments[idx - 1]
							: undefined;
					const startC = origin ?? firstNew;
					const endC = origin ?? lastNew;
					const sourceStartMessageId =
						startC?.startMessageId ||
						`ordinal:${startC?.startMessage ?? chunk.startIndex}`;
					const sourceEndMessageId =
						endC?.endMessageId || `ordinal:${endC?.endMessage ?? lastNewEnd}`;
					const sourceMessage =
						provider.readMessageById?.(sourceStartMessageId);
					const sourceMessageTime =
						parseSourceMessageTime(sourceMessage?.version) ?? Date.now();
					const stored = insertPrimerCandidates(db, [
						{
							projectPath,
							harness: "pi",
							sessionId,
							question: candidate.question,
							sourceCompartmentStart: startC?.startMessage,
							sourceCompartmentEnd: endC?.endMessage,
							sourceStartMessageId,
							sourceEndMessageId,
							sourceMessageTime,
						},
					]);
					sessionLog(
						sessionId,
						`stored ${stored.length} primer candidate occurrence(s)${origin ? " (origin-tagged)" : " (chunk-span fallback)"}`,
					);
				} catch (error) {
					sessionLog(sessionId, "failed to store primer candidates:", error);
				}
			}

			// Skill-memory historian extraction (Pi mirror of OpenCode): promote
			// <skill_observations> into per-skill notes. Same promotionActive +
			// !discardedLast gate as facts/primers so a provisional tail does not
			// double-emit.
			if (
				promotionActive &&
				!discardedLast &&
				validatedPass.skillObservations &&
				validatedPass.skillObservations.length > 0
			) {
				try {
					const written = promoteSkillObservations(
						db,
						projectPath,
						validatedPass.skillObservations,
					);
					sessionLog(sessionId, `promoted ${written} skill observation(s)`);
				} catch (error) {
					sessionLog(sessionId, "failed to promote skill observations:", error);
				}
			}

			// Raw chunk embeddings: the ctx_search semantic substrate over session
			// history. Fire-and-forget, best-effort, memory-gated.
			if (embeddingActive) {
				const chunksToEmbed = newCompartments
					.map((c, i) => ({
						id: persistedIds[i],
						startMessage: c.startMessage,
						endMessage: c.endMessage,
						sourceChunkText: chunk.text,
					}))
					.filter((c) => typeof c.id === "number");
				void (async () => {
					try {
						await ensureProjectRegistered(directory, db);
					} catch (error) {
						sessionLog(
							sessionId,
							"project registration after publish failed:",
							error,
						);
					}
					try {
						await embedPromotedFacts(
							db,
							sessionId,
							projectPath,
							promotedFactRefs,
						);
					} catch (error) {
						sessionLog(
							sessionId,
							"promoted fact embedding dispatch failed:",
							error,
						);
					}
					try {
						await embedAndStoreCompartmentChunks(
							db,
							sessionId,
							projectPath,
							chunksToEmbed,
						);
					} catch (error) {
						sessionLog(
							sessionId,
							"compartment embedding dispatch failed:",
							error,
						);
					}
				})();
			}

			// historian_runs telemetry — full success metrics.
			{
				const facts = validatedPass.facts ?? [];
				const validIds = persistedIds.filter(
					(id): id is number => typeof id === "number",
				);
				const imp = summarizeImportance(
					newCompartments.map((c) => c.importance ?? 50),
				);
				telemetry.status = "success";
				telemetry.chunkStartOrdinal = chunk.startIndex;
				telemetry.chunkEndOrdinal = chunk.endIndex;
				telemetry.unprocessedFrom = lastNewEnd + 1;
				telemetry.compartmentsProduced = newCompartments.length;
				telemetry.compartmentIdMin =
					validIds.length > 0 ? Math.min(...validIds) : null;
				telemetry.compartmentIdMax =
					validIds.length > 0 ? Math.max(...validIds) : null;
				telemetry.factsEmitted = facts.length;
				telemetry.factsByCategory =
					facts.length > 0 ? tallyFactsByCategory(facts) : null;
				telemetry.eventsEmitted = publishableEvents.length;
				telemetry.importanceMin = imp.min;
				telemetry.importanceMax = imp.max;
				telemetry.importanceAvg = imp.avg;
				telemetry.discardedLast = discardedLast;
			}
		});
	} catch (error) {
		const desc = describeError(error);
		telemetry.failureReason = `exception: ${desc.brief}`;
		sessionLog(
			sessionId,
			`historian failure: source=exception ${desc.brief}${desc.stackHead ? ` stackHead="${desc.stackHead}"` : ""}`,
		);
		if (!issueNotified) {
			const failCount = incrementHistorianFailure(db, sessionId, desc.brief);
			await notify(buildHistorianFailureNotice(failCount, desc.brief));
		}
	} finally {
		if (!completedSuccessfully) {
			if (!retainDrainReservationForRetryThrottle) {
				rollbackDrainReservation();
			} else {
				// Genuine historian failure (the retained-reservation retry-throttle
				// condition) — suppress the emergency catch-up latch bypass for a
				// short backoff so a broken historian can't retry-thrash. Mirrors
				// OpenCode.
				recordHistorianDrainFailure(db, sessionId);
			}
		}
		updateSessionMeta(db, sessionId, { compartmentInProgress: false });
		// Record one historian_runs row for this attempt (every exit path).
		try {
			const latest = getLatestHistorianInvocationId(db, sessionId);
			const invocationId =
				latest != null &&
				(invocationBaseline == null || latest > invocationBaseline)
					? latest
					: null;
			recordHistorianRun(db, {
				sessionId,
				harness: "pi",
				subagentInvocationId: invocationId,
				runKind: telemetry.runKind ?? "incremental",
				status: telemetry.status ?? "failed",
				failureReason: telemetry.failureReason ?? null,
				chunkStartOrdinal: telemetry.chunkStartOrdinal ?? null,
				chunkEndOrdinal: telemetry.chunkEndOrdinal ?? null,
				unprocessedFrom: telemetry.unprocessedFrom ?? null,
				compartmentsProduced: telemetry.compartmentsProduced ?? 0,
				compartmentIdMin: telemetry.compartmentIdMin ?? null,
				compartmentIdMax: telemetry.compartmentIdMax ?? null,
				factsEmitted: telemetry.factsEmitted ?? 0,
				factsByCategory: telemetry.factsByCategory ?? null,
				eventsEmitted: telemetry.eventsEmitted ?? 0,
				importanceMin: telemetry.importanceMin ?? null,
				importanceMax: telemetry.importanceMax ?? null,
				importanceAvg: telemetry.importanceAvg ?? null,
				discardedLast: telemetry.discardedLast ?? false,
			});
		} catch {
			/* telemetry must not break compaction */
		}
	}
}

/** Internal validation result classification — mirrors OpenCode pass result shape. */
type ValidationOutcome =
	| {
			kind: "ok";
			compartments: ReturnType<typeof validateHistorianOutput> extends infer T
				? T extends { ok: true; compartments: infer C }
					? C
					: never
				: never;
			facts: ReturnType<typeof validateHistorianOutput> extends infer T
				? T extends { ok: true; facts: infer F }
					? F
					: never
				: never;
			userObservations?: string[];
			primerCandidates?: ReturnType<
				typeof validateHistorianOutput
			> extends infer T
				? T extends { ok: true; primerCandidates?: infer P }
					? P
					: never
				: never;
			skillObservations?: ReturnType<
				typeof validateHistorianOutput
			> extends infer T
				? T extends { ok: true; skillObservations?: infer S }
					? S
					: never
				: never;
			events?: ReturnType<typeof validateHistorianOutput> extends infer T
				? T extends { ok: true; events?: infer E }
					? E
					: never
				: never;
	  }
	| { kind: "validation-failed"; error: string; rawText: string }
	| { kind: "spawn-failed"; reason: string; error: string }
	| { kind: "no-output" };

async function validateHistorianResult(
	result: SubagentRunResult,
	sessionId: string,
	chunk: Parameters<typeof validateHistorianOutput>[2],
	priorCompartments: Parameters<typeof validateHistorianOutput>[3],
	sequenceOffset: number,
): Promise<ValidationOutcome> {
	if (!result.ok) {
		return {
			kind: "spawn-failed",
			reason: result.reason,
			error: result.error,
		};
	}
	if (result.assistantText.trim().length === 0) {
		return { kind: "no-output" };
	}

	const validation = validateHistorianOutput(
		result.assistantText,
		sessionId,
		chunk,
		priorCompartments,
		sequenceOffset,
	);
	if (validation.ok) {
		return {
			kind: "ok",
			compartments: validation.compartments,
			facts: validation.facts,
			userObservations: validation.userObservations,
			primerCandidates: validation.primerCandidates,
			skillObservations: validation.skillObservations,
			events: validation.events,
		};
	}
	return {
		kind: "validation-failed",
		error: validation.error,
		rawText: result.assistantText,
	};
}

export function buildPiCompactionSummary(
	compartments: Array<{
		title: string;
		startMessage: number;
		endMessage: number;
	}>,
): string {
	if (compartments.length === 0)
		return "Magic Context compacted prior history.";
	const titles = compartments
		.map((c) => c.title.trim())
		.filter((title) => title.length > 0);
	if (titles.length === 0) {
		const first = compartments[0];
		const last = compartments[compartments.length - 1];
		return `Magic Context compacted messages ${first?.startMessage ?? "?"}-${last?.endMessage ?? "?"}.`;
	}
	// Cap the title list so the marker summary stays bounded. This summary lives
	// behind the compaction boundary (not model-visible — filterCompacted stops
	// here and <session-history> replaces it), but it IS written to the JSONL and
	// can surface in Pi's resume picker. Joining ALL titles grows unbounded with
	// compartment count (a recomp/upgrade on a long session has hundreds), so cap
	// to the first N and summarize the remainder.
	const MAX_SUMMARY_TITLES = 5;
	if (titles.length <= MAX_SUMMARY_TITLES) {
		return `Magic Context compacted: ${titles.join("; ")}`;
	}
	const shown = titles.slice(0, MAX_SUMMARY_TITLES).join("; ");
	return `Magic Context compacted ${titles.length} segments: ${shown}; …and ${
		titles.length - MAX_SUMMARY_TITLES
	} more`;
}

/**
 * Find the Pi SessionEntry id whose RawMessage ordinal corresponds to
 * `lastCompactedOrdinal + 1` — i.e., the first entry whose content
 * should survive a Pi-native compaction marker placed after the
 * compartment that ends at `lastCompactedOrdinal`.
 *
 * # Why this routes through convertEntriesToRawMessages
 *
 * Historian publishes compartments whose `endMessage` ordinal comes
 * from `read-session-pi.ts:convertEntriesToRawMessages` — the
 * canonical Pi ordinal source. Pi's `appendCompaction` API expects
 * `firstKeptEntryId` as a real SessionEntry id.
 *
 * A previous implementation walked `entries` with its own counter
 * that incremented only on user|assistant roles. That counter
 * diverged from `convertEntriesToRawMessages`, which also emits
 * synthetic-user RawMessages for `toolResult→assistant` transitions
 * (the common pattern in tool-heavy sessions: ~3,005 such transitions
 * out of ~7,423 ordinals in a 2-week tool-heavy session).
 *
 * When the counters diverged, the function could never count past
 * `(user_count + assistant_count)` ordinals, returned null for any
 * `lastCompactedOrdinal` beyond that point, and Pi's native compaction
 * marker was silently never written. The Pi JSONL grew unbounded
 * while magic-context kept publishing compartments to its DB
 * (cortexkit issue #X1, surfaced by pi-deferred-compaction-marker
 * e2e test).
 *
 * Now the function delegates to the canonical ordinal source. The
 * RawMessage at ordinal `N` carries `id` populated from either the
 * real underlying entry (user|assistant|unknown role) or the first
 * folded toolResult entry (synthetic user) — never empty.
 *
 * # Why we DEFER (not advance) when the kept-start ordinal is synthetic
 *
 * A folded-toolResult run is emitted as a synthetic-user RawMessage whose id is
 * `${SYNTH_USER_ID_PREFIX}<realToolResultId>` — NOT a real SessionEntry id. Pi's
 * compaction replay (`getBranch`/`buildSessionContext`) starts the kept tail at
 * the entry whose real `entry.id === compaction.firstKeptEntryId`; a synthetic
 * id matches nothing, so the deferred drain would treat the marker as stale,
 * CAS-clear the pending blob, and the native marker would never be written.
 *
 * `target = lastCompactedOrdinal + 1` is BY CONSTRUCTION the first KEPT-tail
 * raw message (everything at ordinal ≤ lastCompactedOrdinal is summarized). So
 * if the message AT `target` is a synthetic-user (folded toolResult run), it is
 * un-summarized kept-tail content. We must NOT advance past it to a later
 * assistant: that would drop the folded toolResult run entirely (it is neither
 * in the summary — ordinal > the compartment's endMessage — nor in the kept
 * tail). We also cannot cut the boundary AT a toolResult, because the kept tail
 * must not start with an orphaned tool result whose tool_use was summarized
 * (provider 400). Both unsafe options collapse to one correct action: return
 * null and DEFER the marker. The caller stages no marker this pass; the next
 * historian pass re-resolves the boundary once a real, replay-safe entry (the
 * following assistant/user) heads the kept tail — exactly Pi's native behavior
 * of never choosing a tool-result tail as a cut point. Deferring loses no
 * content (nothing is trimmed until a safe boundary exists) and the branch keeps
 * accumulating safely until then.
 *
 * If the boundary message resolves to a real (non-synthetic) entry id, use it
 * directly. An empty-id slot (unknown role with no entry id) is also unsafe to
 * cut at, so defer there too.
 */
export function findFirstKeptEntryId(
	entries: unknown[],
	lastCompactedOrdinal: number,
): string | null {
	const rawMessages = convertEntriesToRawMessages(entries);
	const target = lastCompactedOrdinal + 1;
	const boundary = rawMessages.find((m) => m.ordinal === target);
	if (!boundary) return null;
	// The kept tail must START at this exact message. If it carries a real,
	// replay-safe entry id, use it. If it is synthetic (folded toolResult run)
	// or has no id, cutting here is unsafe and advancing past it would drop
	// kept-tail content — defer the marker until a later pass when a real entry
	// heads the kept tail.
	if (boundary.id.length === 0) return null;
	if (boundary.id.startsWith(SYNTH_USER_ID_PREFIX)) return null;
	return boundary.id;
}
