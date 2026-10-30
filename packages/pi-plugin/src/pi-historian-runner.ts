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
	externalHistorianFailureReason,
	subprocessExitHistorianFailureReason,
} from "@magic-context/core/features/magic-context/historian-failure-reason";
import {
	embedPromotedFacts,
	promoteSessionFactsDurable,
} from "@magic-context/core/features/magic-context/memory";
import { hasHistorianToolActivity } from "@magic-context/core/features/magic-context/memory/historian-wire";
import { tsOwnsMemory } from "@magic-context/core/features/magic-context/memory/lifecycle-applier";
import type { ReportedProfile } from "@magic-context/core/features/magic-context/memory/lifecycle-gates";
import { lifecycleTextHash } from "@magic-context/core/features/magic-context/memory/lifecycle-text";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { getMemoriesByProject } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	allocateTurnOneSend,
	blocksSentToHistorian,
	commitTurnOnePublication,
	HISTORIAN_FORMAT_INSTRUCTION,
	parseEnabledTurnOne,
	publishedFacts,
	readTurnOneFailureCount,
	recordTurnOneCounter,
	registerTurnOneChild,
	selectTurnOneExecution,
	sweepDormantTurnTwo,
	type TurnOneFact,
	type TurnOneLane,
	type TurnOneSend,
	turnOneCounterKey,
	turnOneProfileAuthorized,
} from "@magic-context/core/features/magic-context/memory/turn-one-publication";
import {
	buildTurnOneAuthorizationRequest,
	freezeTurnOneProfile,
	persistTurnOneAuthorization,
} from "@magic-context/core/features/magic-context/memory/turn-two";
import type { TurnTwoTrialAuthorization } from "@magic-context/core/features/magic-context/memory/turn-two-profile";
import {
	clearEmergencyDrainLatch,
	clearEmergencyRecovery,
	clearHistorianDrainFailure,
	clearHistorianFailureState,
	describeProtectedTailDrainBudgetSkip,
	getHistorianFailureState,
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
	HISTORIAN_EDITOR_SYSTEM_PROMPT,
	historianSystemPrompt as selectedHistorianSystem,
} from "@magic-context/core/hooks/magic-context/compartment-prompt";
import {
	prepareCompartmentDrops,
	queuePreparedCompartmentDrops,
} from "@magic-context/core/hooks/magic-context/compartment-runner-drop-queue";
import {
	buildHistorianFailureNotice,
	buildHistorianRepairPrompt,
	buildHistorianWindowTooSmallNotice,
	HISTORIAN_BOUNDARY_HEALING_SLACK,
	shouldDiscardLastHistorianCompartment,
	validateChunkCoverage,
	validateHistorianOutput,
	validateStoredCompartments,
} from "@magic-context/core/hooks/magic-context/compartment-runner-validation";
import {
	producerSourceLocalBudget,
	resolveHistorianProducerLimits,
	resolveKnownHistorianContextLimit,
} from "@magic-context/core/hooks/magic-context/derive-budgets";
import {
	clearHistorianHistoryWait,
	recordHistorianNoProgress,
	shouldWaitForNewHistorianHistory,
} from "@magic-context/core/hooks/magic-context/historian-history-wait";
import {
	describeHistorianPromptTrim,
	fitHistorianPrompt,
	PRODUCER_PROMPT_FIT_FAILURE_PATTERN,
} from "@magic-context/core/hooks/magic-context/historian-prompt-fit";
import { readTurnTwoExcerpt } from "@magic-context/core/hooks/magic-context/historian-turn-two-step";
import { onNoteTrigger } from "@magic-context/core/hooks/magic-context/note-nudger";
import { persistFilteredNoise } from "@magic-context/core/hooks/magic-context/persist-filtered-noise";
import {
	fitAtomicHistorianSourceToProducerWindow,
	historianProducerReserve,
	producerInputTokenLimit,
	producerPromptFailureReason,
	producerWindowFailureReason,
} from "@magic-context/core/hooks/magic-context/producer-window-guard";
import {
	createDefaultBoundarySnapshotForTests,
	describeBoundaryDiagnostics,
	hasRunnableCompartmentWindow,
	type ProtectedTailBoundarySnapshot,
	recordHighPressureNoEligibleHead,
	selectPerRunCap,
	validateBoundarySnapshot,
} from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import {
	getRawSessionTagKeysThrough,
	type RawMessageProvider,
	readSessionChunk,
	withRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { readEffectiveReferenceCompartments } from "@magic-context/core/hooks/magic-context/score-projection";
import { describeError } from "@magic-context/core/shared/error-message";
import { piModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";
import { isTransientHistorianPromptError } from "@magic-context/core/shared/historian-transient-error";
import { sessionLog } from "@magic-context/core/shared/logger";
import type {
	ModelInput,
	ResolvedModelEntry,
} from "@magic-context/core/shared/model-resolution";
import { toModelEntry } from "@magic-context/core/shared/resolve-fallbacks";
import {
	type Database,
	isTransientSqliteError,
} from "@magic-context/core/shared/sqlite";
import type {
	SubagentProgressEvent,
	SubagentRunner,
	SubagentRunOptions,
	SubagentRunResult,
} from "@magic-context/core/shared/subagent-runner";
import { summarizeChildStderr } from "@magic-context/core/shared/summarize-child-stderr";
import { logSlowWriteTransaction } from "@magic-context/core/shared/write-transaction-timing";
import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import { resolvePiHarnessKind } from "./pi-harness-kind";
import {
	isPiRpcHistorianRunner,
	PI_RPC_CARRIER,
	recoverLostPiRpcStages,
	reportedProfile,
	schedulePiHistorianTurnTwo,
} from "./pi-historian-turn-two";
import { acknowledgePiHistoryRetirement } from "./pi-history-retirement";
import {
	isPiOrdinalAlignmentUnanchored,
	resolvePiOrdinalAlignment,
} from "./pi-ordinal-alignment";
import { ZEN_FREE_TIER_FAILURE } from "./pi-zen-free-tier";
import {
	iterateEntriesToRawMessageRange,
	SYNTH_USER_ID_PREFIX,
} from "./read-session-pi";
import type { PiRpcHistorianChild } from "./subagent-runner";
import { isPiSystemEntry } from "./system-entry-pi";

const HISTORIAN_AGENT_NAME = "magic-context-historian";
const DEFAULT_HISTORIAN_TIMEOUT_MS = 600_000;
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

const loggedProducerWindows = new Set<string>();
const loggedInconsistentWindows = new Set<string>();

async function runHistorianSubagentWithTransientRetriesGuarded(args: {
	resolveContextLimit?: (model: string) => number | undefined;
	resolveOutputLimit?: (model: string) => number | undefined;
	onDispatch?: () => void;
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
			const key = piModelRefToCanonical(args.options.model ?? "");
			const window =
				args.resolveContextLimit?.(key) ??
				resolveKnownHistorianContextLimit(key);
			const limits = args.resolveContextLimit
				? { context: window, input: undefined }
				: resolveHistorianProducerLimits(key);
			const context =
				limits.context ?? (limits.input === undefined ? window : undefined);
			const reserve = historianProducerReserve(
				context,
				args.options.maxOutputTokens,
				args.resolveOutputLimit?.(key),
			);
			if (
				window !== undefined &&
				producerInputTokenLimit(context, reserve, limits.input) === undefined &&
				!loggedInconsistentWindows.has(key)
			) {
				loggedInconsistentWindows.add(key);
				sessionLog(
					args.sessionId,
					`producer window inconsistent for ${key}: window=${window} reserve=${reserve}; sending unguarded`,
				);
			}
			const failure = producerPromptFailureReason({
				sourceLocal: estimateTokens(args.options.userMessage),
				systemLocal: estimateTokens(args.options.systemPrompt),
				toolsLocal: 0,
				modelKey: key,
				contextLimitTokens: context,
				inputLimitTokens: limits.input,
				maxOutputTokens: reserve,
			});
			if (failure) throw new Error(failure);
			args.onDispatch?.();
			result = await args.runner.run({
				...args.options,
				cacheTail:
					retryIndex > 0 ? "write" : (args.options.cacheTail ?? "skip"),
				// The historian runner owns fallback iteration because every candidate's
				// output must be parsed and validated before the chain can stop.
				fallbackModels: undefined,
			});
		} catch (error) {
			const desc = describeError(error);
			result = {
				ok: false,
				reason: "model_failed",
				error: PRODUCER_PROMPT_FIT_FAILURE_PATTERN.test(desc.message)
					? desc.message
					: desc.brief,
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
	primaryThinkingLevel: string | undefined,
	fallbackModels?: readonly ModelInput[],
): ResolvedModelEntry[] {
	const seen = new Set<string>([
		`${primaryModel}\u0000${primaryThinkingLevel ?? ""}`,
	]);
	const chain: ResolvedModelEntry[] = [];
	for (const candidate of fallbackModels ?? []) {
		const entry =
			typeof candidate === "string" ? { model: candidate } : candidate;
		const key = `${entry.model}\u0000${entry.qualifier ?? ""}`;
		if (!entry.model || seen.has(key)) continue;
		seen.add(key);
		chain.push(entry);
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
	clearHistorianHistoryWait(sessionId);
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
	/** Config key supplying the selected historian model. */
	modelConfigKey?: string;
	/** Optional ordered fallback chain, retaining each entry's Pi thinking level. */
	fallbackModels?: readonly ModelInput[];
	/** Live session model for host context; never appended to the configured chain. */
	fallbackModelId?: string;
	/** Historian chunk budget derived from its context window. */
	historianChunkTokens: number;
	/** Known context limit for the same resolved historian model. Unknown means no producer guard. */
	historianContextLimit?: number;
	producerContextLimits?: ReadonlyMap<string, number>;
	/** Live Pi/OMP registry lookup; its models include host snapshot and custom overrides. */
	resolveHostContextLimit?: (model: string) => number | undefined;
	resolveHostOutputLimit?: (model: string) => number | undefined;
	/** Boundary resolved by the Pi trigger/recovery decision with the real model context. */
	boundarySnapshot?: ProtectedTailBoundarySnapshot;
	/**
	 * Optional live boundary resolver used only to recover a stale trigger snapshot.
	 * It must recompute against the currently registered Pi raw-message provider.
	 * It receives the stale snapshot so it can carry that snapshot's one-pass
	 * live-prompt floor lift into the re-resolved boundary.
	 */
	refreshBoundarySnapshot?: (
		stale: ProtectedTailBoundarySnapshot,
	) => ProtectedTailBoundarySnapshot;
	/** Current resolved context limit used to reject stale snapshots after model switches. */
	currentContextLimit?: number;
	/** Optional per-call timeout (default 600s). */
	historianTimeoutMs?: number;
	/** Sampling temperature carried to the serialized provider request. */
	temperature?: number;
	/** Output-token budget carried to the serialized provider request. */
	maxOutputTokens?: number;
	/** Optional cancellation signal for the historian run and retry backoff. */
	signal?: AbortSignal;
	/** Test seam for transient retry backoff. Defaults to OpenCode's retry cadence. */
	retryBackoffMs?: (retryIndex: number) => number;
	/** When true, run a second editor pass after a successful first pass to
	 *  clean low-signal U: lines and cross-compartment duplicates. Mirrors
	 *  OpenCode's `historian.two_pass` config. Editor validation falls back
	 *  to the first-pass result on failure. Default: false. */
	twoPass?: boolean;
	expandTools?: Record<string, string | false>;
	/** Pi and OMP: explicit thinking level passed as --thinking <level> to
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
	/** False when the dreamer is not runnable, so the historian prompt asks it to
	 *  skip user observations nothing could review. Undefined counts as true. */
	userObservationsRequested?: boolean;
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
	/**
	 * Test-only publication override; it never authorizes turn-two application.
	 * Production enables memory verification unless the user turns it off.
	 */
	memoryLifecycleLane?: TurnOneLane;
	turnTwo?: "on" | "off";
	/** Reads the live switch after provider replies rather than freezing a scheduling-time value. */
	turnTwoIsEnabled?: () => boolean;
	trialAuthorization?: TurnTwoTrialAuthorization;
	/** Test-only expected provider/model and request identities for isolated checks. */
	validatedProfiles?: readonly ReportedProfile[];
	/** Headless sessions may compartment history, but cannot run the experimental memory lifecycle. */
	hasUI?: boolean;
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
		historianChunkTokens: providerHistorianChunkTokens,
		historianContextLimit,
		boundarySnapshot: providedBoundarySnapshot,
		refreshBoundarySnapshot,
		currentContextLimit,
		historianTimeoutMs = DEFAULT_HISTORIAN_TIMEOUT_MS,
		temperature,
		maxOutputTokens: configuredMaxOutputTokens,
		signal,
		retryBackoffMs,
		twoPass,
		thinkingLevel,
		memoryEnabled,
		allowHomeProject,
		autoPromote,
		userMemoriesEnabled,
		userObservationsRequested,
		onPublished,
		compartmentLeaseHolderId,
		readBranchEntries,
		notifyIssue,
		ensureProjectRegistered = ensureProjectRegisteredFromPiDirectory,
		forceDrainQuota,
		forceKeepLastCompartment,
	} = deps;
	const primaryModelKey = piModelRefToCanonical(
		historianModel ?? fallbackModelId ?? "",
	);
	const primaryWindow =
		deps.resolveHostContextLimit?.(primaryModelKey) ?? historianContextLimit;
	const maxOutputTokens =
		configuredMaxOutputTokens ??
		(primaryWindow === undefined
			? 32_000
			: historianProducerReserve(
					primaryWindow,
					undefined,
					deps.resolveHostOutputLimit?.(primaryModelKey) ?? 32_000,
				));
	const combinedSystem = withContentLanguageDirective(
		selectedHistorianSystem(true),
		deps.language,
		{ preserveUserQuotes: true },
	);
	const harness = resolvePiHarnessKind();
	const requestedModel = toModelEntry(historianModel ?? fallbackModelId);
	const route = piModelRefToCanonical(requestedModel?.model ?? "");
	const slash = route.indexOf("/");
	let authorizationRequest = buildTurnOneAuthorizationRequest(
		{
			lane: harness,
			carrier: PI_RPC_CARRIER,
			provider: slash < 0 ? "" : route.slice(0, slash),
			modelId: slash < 0 ? route : route.slice(slash + 1),
			variant: requestedModel?.qualifier ?? null,
			temperature: temperature ?? null,
			thinkingLevel: thinkingLevel ?? null,
		},
		{
			system: combinedSystem,
			formatInstruction: HISTORIAN_FORMAT_INSTRUCTION,
			toolSurface: [],
			checkToolSurface: [],
		},
	);
	const selectionProject =
		resolveProjectIdentityForSession(directory, allowHomeProject) ?? "";
	// Negotiate retained historian support before selecting the two-pass carrier.
	if (
		harness === "omp" &&
		twoPass !== true &&
		deps.turnTwo !== "off" &&
		"prepareRetainedHistorian" in runner &&
		typeof runner.prepareRetainedHistorian === "function"
	) {
		await runner.prepareRetainedHistorian(directory);
	}
	const rpcRunner = isPiRpcHistorianRunner(runner) ? runner : null;
	const selection = selectTurnOneExecution(db, {
		projectPath: selectionProject,
		request: authorizationRequest,
		override: deps.memoryLifecycleLane,
		turnTwo: deps.turnTwoIsEnabled?.() === false ? "off" : deps.turnTwo,
		twoPass,
		canContinue: !!rpcRunner,
		hasUI: deps.hasUI,
		validatedProfiles: deps.validatedProfiles,
		trialAuthorization: deps.trialAuthorization,
	});
	const sweep = () => sweepDormantTurnTwo(db, selectionProject);
	if (selection.lane === "dormant") await sweep();
	if (selection.refused) return;
	recoverLostPiRpcStages(db);
	let historianSystemPrompt = withContentLanguageDirective(
		selectedHistorianSystem(selection.lane === "enabled"),
		deps.language,
		{ preserveUserQuotes: true },
	);
	const historianChunkTokens = producerSourceLocalBudget(
		providerHistorianChunkTokens,
		piModelRefToCanonical(historianModel ?? fallbackModelId ?? ""),
	);
	const resolveProducerContextLimit = (model: string): number | undefined => {
		const hostWindow = deps.resolveHostContextLimit?.(model);
		const primaryWindow =
			model === piModelRefToCanonical(historianModel)
				? historianContextLimit
				: undefined;
		const suppliedWindow = deps.producerContextLimits?.get(model);
		const cachedWindow = resolveKnownHistorianContextLimit(model);
		const window =
			hostWindow ?? primaryWindow ?? suppliedWindow ?? cachedWindow;
		if (!loggedProducerWindows.has(model)) {
			loggedProducerWindows.add(model);
			sessionLog(
				sessionId,
				window === undefined
					? `producer window unknown for ${model}: sending unguarded`
					: `historian producer window for ${model}: ${window} (${hostWindow !== undefined ? "host registry" : primaryWindow !== undefined ? "configured" : suppliedWindow !== undefined ? "supplied" : "persisted cache"})`,
			);
		}
		return window;
	};
	const runHistorianSubagentWithTransientRetries = (
		args: Parameters<typeof runHistorianSubagentWithTransientRetriesGuarded>[0],
	) =>
		runHistorianSubagentWithTransientRetriesGuarded({
			...args,
			onDispatch: () => {
				producerDispatched = true;
			},
			resolveOutputLimit: deps.resolveHostOutputLimit,
			resolveContextLimit: resolveProducerContextLimit,
		});

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
	let retained: {
		child: PiRpcHistorianChild;
		options: SubagentRunOptions;
		text: string;
	} | null = null;
	let continuation: Parameters<typeof schedulePiHistorianTurnTwo>[0] | null =
		null;
	let retainDrainReservationForRetryThrottle = false;
	let producerDispatched = false;
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
				telemetry.failureReason = existingValidationError;
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
				telemetry.status = "noop";
				telemetry.failureReason = "missing protected-tail boundary snapshot";
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
					const refreshed = refreshBoundarySnapshot(boundarySnapshot);
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
				telemetry.status = "noop";
				telemetry.failureReason = "stale protected-tail boundary snapshot";
				sessionLog(
					sessionId,
					`historian no-op: stale protected-tail snapshot (${validation.detail ?? validation.reason ?? "unknown"})`,
				);
				return;
			}
			const protectedTailStart = boundarySnapshot.protectedTailStart;
			if (
				!forceDrainQuota &&
				shouldWaitForNewHistorianHistory(boundarySnapshot, {
					emergency: getOverflowState(db, sessionId).needsEmergencyRecovery,
				})
			) {
				telemetry.status = "noop";
				telemetry.failureReason =
					"waiting for new history after no forward progress";
				sessionLog(
					sessionId,
					"historian no-op: waiting for new history after no forward progress",
				);
				return;
			}
			const eligibleEndOrdinal = Math.min(
				boundarySnapshot.eligibleEndOrdinal,
				protectedTailStart,
			);
			if (protectedTailStart <= offset || eligibleEndOrdinal <= offset) {
				telemetry.status = "noop";
				telemetry.failureReason = "nothing to compact before protected tail";
				sessionLog(
					sessionId,
					`historian no-op: protectedTailStart=${protectedTailStart} eligibleEnd=${eligibleEndOrdinal} <= offset=${offset} — nothing to compact; ${describeBoundaryDiagnostics(boundarySnapshot)}`,
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

			// Size the prompt to the producer model before reserving drain budget or
			// reading the chunk: the fixed prompt parts and the output reserve come
			// off the window first, and the chunk gets what is left. The window is
			// resolved the way the dispatch guard resolves it for the primary model.
			const projectPath = resolveProjectIdentityForSession(
				directory,
				allowHomeProject,
			);
			// On an `enabled` turn-one lane (see `TurnOneLane`) with memory on, the
			// historian gets no project-memory block and anchors every fact to its
			// source lines; the anchor is stored with the fact's candidate row, and a
			// later reconcile step compares the fact with existing memory instead.
			let counterKey = turnOneCounterKey(
				authorizationRequest,
				sessionId,
				readSessionChunk(sessionId, Number.MAX_SAFE_INTEGER, offset, offset + 1)
					.lines[0]?.messageId ?? `ordinal:${offset}`,
			);
			const turnOneLane =
				readTurnOneFailureCount(db, projectPath ?? "", counterKey) >= 3
					? "dormant"
					: selection.lane;
			if (turnOneLane === "dormant" && deps.trialAuthorization) {
				telemetry.status = "noop";
				telemetry.failureReason = "turn_one_budget_exhausted";
				return;
			}
			if (turnOneLane === "dormant" && selection.lane === "enabled")
				await sweep();
			historianSystemPrompt = withContentLanguageDirective(
				selectedHistorianSystem(turnOneLane === "enabled"),
				deps.language,
				{ preserveUserQuotes: true },
			);
			const anchoredFacts =
				turnOneLane === "enabled" && memoryEnabled !== false;
			const fitModelKey = piModelRefToCanonical(historianModel ?? "");
			const fitContext = fitModelKey
				? resolveProducerContextLimit(fitModelKey)
				: undefined;
			// Every attempt in the chain (configured fallbacks, then the session
			// model as the last resort) sends this same prompt, so size it for each
			// of their windows too, resolved as the dispatch guard resolves them.
			const fallbackWindows = [
				...(fallbackModels ?? []).map((entry) =>
					typeof entry === "string" ? entry : entry.model,
				),
				fallbackModelId,
			]
				.map((model) => (model ? piModelRefToCanonical(model) : ""))
				.filter((key) => key.length > 0 && key !== fitModelKey)
				.map((key) => {
					const context = resolveProducerContextLimit(key);
					return {
						modelKey: key,
						contextLimitTokens: context,
						maxOutputTokens: historianProducerReserve(
							context,
							maxOutputTokens,
							deps.resolveHostOutputLimit?.(key),
						),
					};
				});
			const promptFit = fitHistorianPrompt({
				window: {
					modelKey: fitModelKey || undefined,
					contextLimitTokens: fitContext,
					maxOutputTokens: historianProducerReserve(
						fitContext,
						maxOutputTokens,
						deps.resolveHostOutputLimit?.(fitModelKey),
					),
				},
				fallbackWindows,
				systemPrompt: historianSystemPrompt,
				requestedChunkTokens: historianChunkTokens,
				sessionId,
				chunkStart: Math.max(1, offset),
				lastOrdinal: eligibleEndOrdinal - 1,
				sessionCompartments: readEffectiveReferenceCompartments(
					db,
					sessionId,
					priorCompartments,
				),
				memories: () =>
					projectPath && !anchoredFacts
						? getMemoriesByProject(db, projectPath, ["active", "permanent"])
						: [],
				memoryEnabled: memoryEnabled !== false,
				anchoredFacts,
				userObservationsRequested,
			});
			if (!promptFit.ok) {
				telemetry.failureReason = promptFit.reason;
				if (
					getHistorianFailureState(db, sessionId).lastError === promptFit.reason
				) {
					// The same model and window already failed this way. Nothing but
					// a model, window or instruction change alters the reason, so
					// running again would only repeat the failure and its notice.
					telemetry.status = "noop";
					sessionLog(
						sessionId,
						`historian no-op: prompt still cannot fit the historian model (${promptFit.reason}); waiting for a model or window change`,
					);
					return;
				}
				sessionLog(
					sessionId,
					`historian failure: source=prompt-fit reason="${promptFit.reason}"`,
				);
				incrementHistorianFailure(db, sessionId, promptFit.reason);
				retainDrainReservationForRetryThrottle = true;
				await notify(buildHistorianWindowTooSmallNotice());
				return;
			}
			const chunkTokens = promptFit.chunkTokens;
			if (promptFit.trimmed || chunkTokens < historianChunkTokens) {
				sessionLog(
					sessionId,
					`historian prompt fit: sized to ${fitModelKey || "unknown"} (${describeHistorianPromptTrim(promptFit)}; requestedChunkTokens=${historianChunkTokens})`,
				);
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
				sessionLog(sessionId, describeProtectedTailDrainBudgetSkip(reserve));
				telemetry.status = "noop";
				telemetry.failureReason = "internal protected-tail drain budget spent";
				return;
			}
			drainReservation = reserve.reservation;

			let chunk = readSessionChunk(
				sessionId,
				chunkTokens,
				offset,
				eligibleEndOrdinal,
				{
					expandTools: deps.expandTools,
					singleMessageLines: turnOneLane === "enabled",
				},
			);
			const forceKeepLastCompartmentForChunk =
				forceKeepLastCompartment === true && !chunk.hasMore;
			if (!chunk.text || chunk.messageCount === 0) {
				if (persistFilteredNoise(db, sessionId, chunk, eligibleEndOrdinal)) {
					telemetry.status = "noop";
					telemetry.failureReason = "filtered noise skipped";
					telemetry.chunkStartOrdinal = offset;
					telemetry.chunkEndOrdinal = eligibleEndOrdinal - 1;
					rollbackDrainReservation();
					return;
				}
				sessionLog(
					sessionId,
					`historian no-op: chunk empty after filtering (messageCount=${chunk.messageCount}, textLen=${chunk.text?.length ?? 0}) range=${offset}-${eligibleEndOrdinal - 1}`,
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
				telemetry.failureReason = chunkCoverageError;
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

			if (!projectPath) {
				telemetry.status = "noop";
				telemetry.failureReason = "project path unavailable";
				rollbackDrainReservation();
				return;
			}

			// v2 (E6 parity): bounded reference blocks replace the unbounded
			// existing-state dump: 3 seeds + 3 diverse older + 4 recent session
			// examples. Recent scores are hidden to prevent anchoring in
			// one-compartment runs. Add <project-memory> for fact dedup, so
			// memories written by OpenCode show up in this Pi historian run. The
			// memory block is id-free because the historian dedups by content;
			// byte-parity with the Rust port is pinned by the historian prompt
			// golden. The prompt fit above rendered these blocks, trimmed if the
			// producer window needed room for the chunk. Mirrors the OpenCode
			// incremental runner.
			const fittedAtomicSource =
				chunk.oversizeAtomicUnit && turnOneLane !== "enabled"
					? fitAtomicHistorianSourceToProducerWindow({
							text: chunk.text,
							resultBoundaries: chunk.toolResultBoundaries,
							contextLimitTokens: historianContextLimit,
							maxOutputTokens,
							maxSourceTokens: promptFit.roomTokens,
						})
					: null;
			const chunkText =
				turnOneLane === "enabled"
					? chunk.text
					: chunk.oversizeAtomicUnit
						? (fittedAtomicSource?.text ?? chunk.text)
						: truncateHistorianInputIfNeeded(chunk.text, chunkTokens);
			const producerSourceTokens = estimateTokens(chunkText);
			if (boundarySnapshot.oversizeAtomicUnit || chunk.oversizeAtomicUnit) {
				sessionLog(
					sessionId,
					`historian oversize admission: range=${chunk.startIndex}-${chunk.endIndex} rawComponentTokens=${boundarySnapshot.diagnostics?.head.completedFence.tokenMass ?? "unknown"} perRunCap=${perRunCap} producerSourceTokens=${producerSourceTokens} historianChunkTokens=${chunkTokens}; ${describeBoundaryDiagnostics(boundarySnapshot)}`,
				);
			}
			if (fittedAtomicSource && fittedAtomicSource.removedTokens > 0) {
				sessionLog(
					sessionId,
					`historian pathological component split: range=${chunk.startIndex}-${chunk.endIndex} resultBoundary=${fittedAtomicSource.splitBoundaryOrdinal ?? "midpoint"} removedTokens=${fittedAtomicSource.removedTokens} producerSourceTokens=${producerSourceTokens} producerInputLimitTokens=${fittedAtomicSource.producerInputLimitTokens ?? "unknown"}`,
				);
			}
			const producerWindowFailure = producerWindowFailureReason({
				producerSourceTokens,
				contextLimitTokens: historianContextLimit,
				maxOutputTokens,
			});
			if (producerWindowFailure) {
				telemetry.failureReason = producerWindowFailure;
				rollbackDrainReservation();
				sessionLog(
					sessionId,
					`historian oversize admission refused before spawn: ${producerWindowFailure}`,
				);
				return;
			}
			if (chunkText !== chunk.text) {
				sessionLog(
					sessionId,
					`historian pre-flight: truncated formatted input for ${chunk.startIndex}-${chunk.endIndex} to fit ${chunkTokens} tokens`,
				);
			}

			const prompt = buildCompartmentAgentPrompt({
				seedExamples: promptFit.seedExamples,
				sessionReferences: promptFit.sessionReferences,
				projectMemory: anchoredFacts ? "" : promptFit.projectMemory,
				inputSource: `Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunkText}`,
				memoryEnabled: memoryEnabled !== false,
				anchoredFacts,
				userObservationsRequested,
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
							const cleaned = summarizeChildStderr(event.chunk)
								.replace(/\s+/g, " ")
								.trim();
							if (cleaned.length > 0) {
								sessionLog(
									sessionId,
									`historian[${passLabel}] stderr: ${cleaned}`,
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

			// Persist turn one's send record, with the publication id the compartment
			// transaction will commit under, before spawning the subagent. A run that
			// fails before publishing leaves the id for the session's next run, so one
			// chunk's candidates and activity are published under one id however many
			// sends it takes.
			let turnOneSend: TurnOneSend;
			let recoveredResult: SubagentRunResult | undefined;
			let recoveredOptions: SubagentRunOptions | undefined;
			try {
				turnOneSend = allocateTurnOneSend(db, {
					projectPath,
					sessionId,
					harness: resolvePiHarnessKind(),
					carrier: turnOneLane === "enabled" ? PI_RPC_CARRIER : "pi-subagent",
					lane: turnOneLane,
					chunkStart: chunk.startIndex,
					chunkEnd: chunk.endIndex,
				});
				if (turnOneSend.recovery) {
					const stored = db
						.prepare(
							"SELECT request_json,reply_json FROM memory_stage_attempts WHERE stage_key=?",
						)
						.get(turnOneSend.stageKey) as {
						request_json: string;
						reply_json: string | null;
					};
					if (!stored.reply_json) {
						db.prepare(
							"UPDATE memory_stage_attempts SET state='expired' WHERE stage_key=? AND state='sending'",
						).run(turnOneSend.stageKey);
						telemetry.status = "noop";
						telemetry.failureReason = "carrier_expired";
						return;
					}
					const request = JSON.parse(stored.request_json);
					authorizationRequest = request;
					historianSystemPrompt = request.system;
					chunk = request.chunk;
					counterKey = turnOneCounterKey(
						authorizationRequest,
						sessionId,
						chunk.lines[0]?.messageId ?? `ordinal:${chunk.startIndex}`,
					);
					recoveredResult = JSON.parse(stored.reply_json);
					recoveredOptions = request.answerOptions;
				}
				if (turnOneLane === "enabled" && !turnOneSend.recovery) {
					persistTurnOneAuthorization(
						db,
						turnOneSend.stageKey,
						authorizationRequest,
					);
					db.prepare(
						"UPDATE memory_stage_attempts SET request_json=json_set(request_json,'$.prompt',?,'$.chunk',json(?)) WHERE stage_key=?",
					).run(
						`${prompt}\n\n${authorizationRequest.formatInstruction}`,
						JSON.stringify(chunk),
						turnOneSend.stageKey,
					);
				}
			} catch (error) {
				if (!isTransientSqliteError(error)) throw error;
				// The store stayed busy past its timeout before anything was sent. This
				// is contention, not a historian failure: skip the run without touching
				// the failure count or its backoff, release the drain budget, and let
				// the next trigger try again.
				telemetry.status = "noop";
				telemetry.failureReason = "turn_one_send_store_busy";
				sessionLog(
					sessionId,
					`historian skipped: store busy while recording turn one's send (${describeError(error).brief}); retrying on the next trigger`,
				);
				rollbackDrainReservation();
				return;
			}

			retainDrainReservationForRetryThrottle = true;
			const historianEditorSystemPrompt = withContentLanguageDirective(
				HISTORIAN_EDITOR_SYSTEM_PROMPT,
				deps.language,
				{ preserveUserQuotes: true },
			);
			const publicationRunner: SubagentRunner =
				turnOneLane === "enabled" && rpcRunner
					? {
							harness: runner.harness,
							run: async (options) => {
								await retained?.child.close();
								retained = null;
								// PiSubagentRunner selects RPC when a call has a token budget and
								// subagent-entry.js is available to reject tools after that budget.
								// This effectively unlimited budget selects RPC without adding a
								// historian token-spend limit.
								const guarded = {
									...options,
									tokenBudget: Number.MAX_SAFE_INTEGER,
								};
								db.prepare(
									"UPDATE memory_stage_attempts SET state='sending' WHERE stage_key=? AND state='dispatched'",
								).run(turnOneSend.stageKey);
								const reply = await rpcRunner.runRetainedHistorian(
									guarded,
									turnOneSend.stageKey,
								);
								if (
									reply.result.ok &&
									options.accountingSubagent === "historian"
								) {
									db.prepare(
										"UPDATE memory_stage_attempts SET state='replied',reply_json=?,request_json=json_set(request_json,'$.answerOptions',json(?)) WHERE stage_key=? AND state='sending'",
									).run(
										JSON.stringify(reply.result),
										JSON.stringify({ model: guarded.model }),
										turnOneSend.stageKey,
									);
								} else
									db.prepare(
										"UPDATE memory_stage_attempts SET state='dispatched' WHERE stage_key=? AND state='sending'",
									).run(turnOneSend.stageKey);
								if (reply.child && reply.result.ok) {
									const child = reply.child;
									retained = {
										child: {
											...child,
											close: registerTurnOneChild(child.id, () =>
												child.close(),
											),
										},
										options: guarded,
										text: reply.result.assistantText,
									};
									if (options.accountingSubagent === "historian")
										db.prepare(
											"UPDATE memory_stage_attempts SET child_session_id=? WHERE stage_key=?",
										).run(reply.child.id, turnOneSend.stageKey);
								} else await reply.child?.close();
								return reply.result;
							},
						}
					: runner;

			// First pass.
			if (!recoveredResult && !forceDrainQuota) {
				shouldWaitForNewHistorianHistory(boundarySnapshot, {
					emergency: getOverflowState(db, sessionId).needsEmergencyRecovery,
					claim: true,
				});
			}
			const firstResult =
				recoveredResult ??
				(await runHistorianSubagentWithTransientRetries({
					runner: publicationRunner,
					sessionId,
					passLabel: "first",
					retryBackoffMs,
					options: {
						agent: HISTORIAN_AGENT_NAME,
						systemPrompt: historianSystemPrompt,
						userMessage:
							prompt +
							(turnOneLane === "enabled"
								? `\n\n${authorizationRequest.formatInstruction}`
								: ""),
						model: historianModel,
						timeoutMs: historianTimeoutMs,
						cwd: directory,
						signal,
						thinkingLevel,
						temperature,
						maxOutputTokens,
						onProgress: buildProgressLogger("first"),
						accountingSessionId: sessionId,
						accountingSubagent: "historian",
						accountingModelConfigKey: deps.modelConfigKey,
					},
				}));

			let validatedPass = await validateHistorianResult(
				firstResult,
				sessionId,
				chunk,
				priorCompartments,
				sequenceOffset,
				turnOneLane === "enabled",
			);
			let answeringResult = firstResult;
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
			let fallbackPrompt = prompt;

			// Repair retry on validation failure (mirrors OpenCode behavior).
			if (
				turnOneLane !== "enabled" &&
				validatedPass.kind === "validation-failed"
			) {
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
				fallbackPrompt = repairPrompt;
				const repairResult = await runHistorianSubagentWithTransientRetries({
					runner: publicationRunner,
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
						temperature,
						maxOutputTokens,
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
			// successfully while producing no usable compartments. Only explicitly
			// configured fallback models may receive these summarization requests.
			const fallbackChain = buildHistorianFallbackChain(
				historianModel,
				thinkingLevel,
				fallbackModels,
			);
			if (
				validatedPass.kind !== "ok" &&
				(turnOneLane !== "enabled" || validatedPass.kind === "spawn-failed") &&
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
						`historian: escalating to configured fallback model ${candidate.model}`,
					);
					const fbResult = await runHistorianSubagentWithTransientRetries({
						runner: publicationRunner,
						sessionId,
						passLabel: "fallback",
						retryBackoffMs,
						options: {
							agent: HISTORIAN_AGENT_NAME,
							systemPrompt: historianSystemPrompt,
							userMessage:
								fallbackPrompt +
								(turnOneLane === "enabled"
									? `\n\n${authorizationRequest.formatInstruction}`
									: ""),
							model: candidate.model,
							timeoutMs: historianTimeoutMs,
							cwd: directory,
							signal,
							thinkingLevel: candidate.qualifier,
							temperature,
							maxOutputTokens,
							onProgress: buildProgressLogger("fallback"),
							accountingSessionId: sessionId,
							accountingSubagent: "historian",
							accountingModelConfigKey:
								candidate.sourceConfigKey ?? deps.modelConfigKey,
							accountingTask: "fallback",
						},
					});
					const fbPass = await validateHistorianResult(
						fbResult,
						sessionId,
						chunk,
						priorCompartments,
						sequenceOffset,
						turnOneLane === "enabled",
					);
					answeringResult = fbResult;
					if (fbPass.kind === "ok") {
						validatedPass = fbPass;
						if (fbResult.ok) validatedDraftText = fbResult.assistantText;
						break;
					}
					if (fbPass.kind === "spawn-failed" && fbPass.reason === "abort") {
						validatedPass = fbPass;
						break;
					}
					if (turnOneLane === "enabled" && fbPass.kind !== "spawn-failed") {
						validatedPass = fbPass;
						break;
					}
				}
			}

			if (turnOneLane === "enabled") {
				const current = retained as { options: SubagentRunOptions } | null;
				const actual = reportedProfile(
					answeringResult,
					current?.options ??
						recoveredOptions ??
						({ model: historianModel } as SubagentRunOptions),
					lifecycleTextHash(historianSystemPrompt),
					authorizationRequest.formatInstruction,
				);
				if (actual) {
					const frozen = db
						.prepare(
							"SELECT reported_profile_json FROM memory_stage_attempts WHERE stage_key=?",
						)
						.get(turnOneSend.stageKey) as {
						reported_profile_json: string | null;
					};
					if (!frozen.reported_profile_json)
						freezeTurnOneProfile(db, turnOneSend.stageKey, actual);
				}
				if (deps.turnTwo === "off" || deps.turnTwoIsEnabled?.() === false) {
					await sweep();
					return;
				}
				if (
					validatedPass.kind !== "ok" &&
					validatedPass.kind !== "spawn-failed"
				)
					recordTurnOneCounter(db, {
						projectPath,
						key: counterKey,
						harness,
						carrier: PI_RPC_CARRIER,
						state: "parse_failed",
					});
			}
			if (validatedPass.kind !== "ok") {
				db.prepare(
					"UPDATE memory_stage_attempts SET state='dispatched' WHERE stage_key=? AND state='replied'",
				).run(turnOneSend.stageKey);
				const errorMsg =
					validatedPass.kind === "validation-failed"
						? validatedPass.error
						: validatedPass.kind === "spawn-failed"
							? `subagent run failed (${validatedPass.reason}): ${validatedPass.error}`
							: "historian returned no usable text";
				telemetry.failureReason =
					validatedPass.kind === "validation-failed"
						? validatedPass.error
						: validatedPass.kind === "no-output"
							? "empty_output"
							: piSubagentFailureReason(validatedPass);
				// A window refusal here comes from a fallback model (the primary was
				// fitted above). Treat it like any other failed pass: count it, notify,
				// and keep the reserved drain budget spent even though nothing was
				// dispatched, so the next trigger does not retry at once.
				if (
					!producerDispatched &&
					!PRODUCER_PROMPT_FIT_FAILURE_PATTERN.test(errorMsg)
				)
					retainDrainReservationForRetryThrottle = false;
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
					const draftRetained = retained;
					retained = null;
					let editorAccepted = false;
					try {
						sessionLog(
							sessionId,
							"historian two-pass: running editor on draft",
						);
						const editorResult = await runHistorianSubagentWithTransientRetries(
							{
								runner: publicationRunner,
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
									temperature,
									maxOutputTokens,
									onProgress: buildProgressLogger("editor"),
									accountingSessionId: sessionId,
									accountingSubagent: "historian_editor",
									accountingModelConfigKey: deps.modelConfigKey,
								},
							},
						);
						const editorPass = await validateHistorianResult(
							editorResult,
							sessionId,
							chunk,
							priorCompartments,
							sequenceOffset,
						);
						if (editorPass.kind === "ok") {
							editorAccepted = true;
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
							// Keep the validated draft's compartments and facts when the editor fails.
						}
					} finally {
						if (editorAccepted && turnOneLane !== "enabled")
							await (
								draftRetained as { child: PiRpcHistorianChild } | null
							)?.child.close();
						else {
							await (
								retained as { child: PiRpcHistorianChild } | null
							)?.child.close();
							retained = draftRetained;
						}
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
				telemetry.failureReason = errorMsg;
				sessionLog(
					sessionId,
					`historian failure: source=no-progress newCompartmentCount=${newCompartments.length} lastNewEnd=${lastNewEnd} priorEnd=${offset - 1}`,
				);
				{
					const failCount = incrementHistorianFailure(db, sessionId, errorMsg);
					await notify(buildHistorianFailureNotice(failCount, errorMsg));
				}
				recordHistorianNoProgress(boundarySnapshot, inEmergency);
				rollbackDrainReservation();
				return;
			}

			const markerSummary = buildPiCompactionSummary(newCompartments);
			const lastNewEndMessageId =
				newCompartments[newCompartments.length - 1]?.endMessageId;
			let firstKeptEntryId: string | null = null;
			if (readBranchEntries) {
				try {
					const branchEntries = readBranchEntries();
					const alignment = resolvePiOrdinalAlignment(
						db,
						sessionId,
						branchEntries,
					);
					// Leave the marker unresolved (pending) while stored ordinals
					// cannot be placed on the branch; a later drain resolves it.
					firstKeptEntryId = isPiOrdinalAlignmentUnanchored(alignment)
						? null
						: findFirstKeptEntryId(branchEntries, lastNewEnd, alignment.offset);
					if (!firstKeptEntryId) {
						sessionLog(
							sessionId,
							`historian: native compaction marker waiting; no resolvable firstKeptEntryId at or after ordinal ${lastNewEnd + 1}`,
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

			// Writing facts as memories requires the memory feature AND auto_promote
			// (parity with OpenCode). History embedding below is NOT gated here: it
			// depends only on the embedding provider, which the embed call checks.
			const promotionActive = memoryEnabled !== false && autoPromote !== false;

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
			const unanchoredPromotionSkipReason = discardedLast
				? "discarded_last"
				: weakLookaheadFinalCompartment
					? "weak_lookahead_final_compartment"
					: null;
			if (unanchoredPromotionSkipReason) {
				sessionLog(
					sessionId,
					`historian unanchored promotion skipped: reason=${unanchoredPromotionSkipReason} facts=${validatedPass.facts?.length ?? 0} user_observations=${validatedPass.userObservations?.length ?? 0} primers=${validatedPass.primerCandidates?.length ?? 0} events_publishable=${publishableEvents.length}/${validatedPass.events?.length ?? 0}`,
				);
			}
			let promotedFactRefs: Array<{ memoryId: number; content: string }> = [];
			let promotedFactCount = 0;
			let publishedEventCount = 0;
			let persistedIds: number[] = [];

			// Atomic publication: append + durable facts/events/drop queue + clear failure state.
			// The Pi-native compaction marker payload is staged in the same
			// transaction so a crash cannot leave compartments without a queued
			// marker for the deferred materializing drain. BEGIN IMMEDIATE keeps the
			// holder check and writes on one fresh write-locked snapshot.
			if (!compartmentLeaseHolderId) {
				telemetry.status = "noop";
				telemetry.failureReason = "missing compartment lease holder";
				sessionLog(
					sessionId,
					"historian publish skipped: missing compartment lease holder",
				);
				rollbackDrainReservation();
				return;
			}
			const compartmentTagKeys = await getRawSessionTagKeysThrough(
				sessionId,
				lastNewEnd,
				{ db },
			);
			const preparedDrops = prepareCompartmentDrops(
				db,
				sessionId,
				lastNewEnd,
				compartmentTagKeys,
			);
			let published = false;
			db.exec("BEGIN IMMEDIATE");
			const transactionStartedAt = performance.now();
			try {
				if (!isCompartmentLeaseHeld(db, sessionId, compartmentLeaseHolderId)) {
					db.exec("ROLLBACK");
					telemetry.status = "noop";
					telemetry.failureReason = "compartment lease no longer held";
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
				const durableRows = getCompartments(db, sessionId).slice(
					-newCompartments.length,
				);
				persistedIds = durableRows.map((c) => c.id);
				// The historian emits only this chunk's facts. As in the OpenCode runner,
				// this transaction also commits turn one's publication, once: the
				// activity ledger counts the new compartments, and the reply's published
				// facts (see `keepPublishedFact`: one tied to a discarded or weak final
				// compartment is dropped and comes back when the next run re-derives
				// those lines) go to one of three places.
				// - `enabled` lane: every published fact becomes a candidate with its
				//   resolved anchor; nothing is promoted, a later reconcile step decides.
				// - `dormant` lane, project memory owned by the Rust module: each fact
				//   becomes a candidate with an unknown anchor, since this process may
				//   not write those memories.
				// - `dormant` lane, project memory owned here: facts are promoted below,
				//   in the same transaction as the protected-tail publication floor, so
				//   both commit or both roll back. A promoted memory reaches the agent at
				//   the session's next HARD rebuild of its memory block.
				const memoryAuthorityHere = tsOwnsMemory(db, projectPath);
				const keptFacts: TurnOneFact[] = publishedFacts(
					validatedPass.facts ?? [],
					newCompartments.length,
					discardedLast,
					weakLookaheadFinalCompartment ? emittedCompartments.length : null,
				);
				const candidateFacts =
					turnOneLane === "enabled"
						? memoryEnabled !== false
							? keptFacts
							: []
						: promotionActive && !memoryAuthorityHere
							? keptFacts
							: [];
				const turnOnePublication = commitTurnOnePublication(db, {
					send: turnOneSend,
					projectPath,
					sessionId,
					compartments: durableRows.map((row, index) => ({
						id: row.id,
						startMessage: row.startMessage,
						endMessage: row.endMessage,
						replyStartMessage: newCompartments[index]?.startMessage ?? -1,
						replyEndMessage: newCompartments[index]?.endMessage ?? -1,
					})),
					blocks:
						turnOneLane === "enabled"
							? blocksSentToHistorian(
									chunk.printedBlocks,
									chunk.text,
									chunkText,
								)
							: [],
					candidateFacts,
					honourAnchors: turnOneLane === "enabled",
				});
				recordTurnOneCounter(db, {
					projectPath,
					key: counterKey,
					harness,
					carrier: turnOneLane === "enabled" ? PI_RPC_CARRIER : "pi-subagent",
					state: "counter_reset",
				});
				if (turnOnePublication.candidatesInserted > 0) {
					sessionLog(
						sessionId,
						`historian turn one: recorded ${turnOnePublication.candidatesInserted} candidate fact(s) (${turnOnePublication.anchoredCandidates} anchored, ${turnOnePublication.blocksStored} block(s))${turnOnePublication.authorityElsewhere ? "; memory authority is the module" : ""}`,
					);
				}
				if (
					turnOneLane === "dormant" &&
					memoryAuthorityHere &&
					promotionActive &&
					keptFacts.length > 0
				) {
					const promotion = promoteSessionFactsDurable(
						db,
						sessionId,
						projectPath,
						keptFacts,
					);
					promotedFactRefs = promotion.newMemoryRefs;
					promotedFactCount = promotion.factsPromoted;
				}

				if (publishableEvents.length > 0) {
					try {
						insertCompartmentEvents(
							db,
							sessionId,
							publishableEvents,
							persistedIds,
						);
						publishedEventCount = publishableEvents.length;
						sessionLog(
							sessionId,
							`stored ${publishableEvents.length} compartment event(s)`,
						);
					} catch (error) {
						sessionLog(sessionId, "failed to store compartment events:", error);
					}
				}

				queuePreparedCompartmentDrops(db, preparedDrops);

				clearHistorianFailureState(db, sessionId);
				// Healthy historian progress clears the drain-failure backoff. Normal
				// runs also clear overflow recovery; wrapup keeps it armed until the loop
				// reaches the keep watermark.
				clearHistorianDrainFailure(db, sessionId);
				recordProtectedTailPublicationFloor(db, sessionId, lastNewEnd + 1);
				acknowledgePiHistoryRetirement(
					db,
					sessionId,
					lastNewEnd,
					(id) =>
						provider.readMessages().find((message) => message.id === id)
							?.ordinal,
				);
				if (!isWrapupInProgress(db, sessionId))
					clearEmergencyRecovery(db, sessionId);
				// userObservations are inserted POST-COMMIT
				// (best-effort, below), not inside this publish transaction. An
				// auxiliary user_memory_candidates failure must never roll back
				// compartment publication. Mirrors OpenCode.
				if (lastNewEndMessageId) {
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
				clearHistorianHistoryWait(sessionId);
				logSlowWriteTransaction("pi_historian_publish", transactionStartedAt);
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
			if (!firstKeptEntryId && notifyIssue) {
				try {
					await notifyIssue(
						"Magic Context compacted history, but Pi's native compaction marker is waiting for a resolvable kept entry. It will retry on the next materializing pass.",
					);
				} catch (error) {
					sessionLog(sessionId, "historian marker-wait status failed", {
						error: describeError(error).brief,
					});
				}
			}

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
							harness: resolvePiHarnessKind(),
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

			// Raw chunk embeddings: the ctx_search semantic substrate over session
			// history. Fire-and-forget, best-effort, gated only by the embedding
			// provider (`memory.enabled` does not affect it).
			if (newCompartments.length > 0) {
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
				telemetry.factsPromoted = promotedFactCount;
				telemetry.eventsEmitted = (validatedPass.events ?? []).length;
				telemetry.eventsPublished = publishedEventCount;
				telemetry.importanceMin = imp.min;
				telemetry.importanceMax = imp.max;
				telemetry.importanceAvg = imp.avg;
				telemetry.discardedLast = discardedLast;
			}
			const retainedOptions = (
				retained as { options: SubagentRunOptions } | null
			)?.options;
			const actual = retainedOptions
				? reportedProfile(
						answeringResult,
						retainedOptions,
						lifecycleTextHash(historianSystemPrompt),
						authorizationRequest.formatInstruction,
					)
				: null;
			if (
				published &&
				retained &&
				rpcRunner &&
				turnOneProfileAuthorized(
					authorizationRequest,
					actual ?? undefined,
					selection.validatedProfiles,
					deps.trialAuthorization,
				)
			) {
				const child = retained as {
					child: PiRpcHistorianChild;
					options: SubagentRunOptions;
					text: string;
				};
				continuation = {
					db,
					projectPath,
					publicationId: turnOneSend.publicationId,
					sessionId,
					child: child.child,
					runner: rpcRunner,
					options: {
						...child.options,
						model: actual
							? `${actual.provider}/${actual.modelId}`
							: child.options.model,
					},
					turnOneText: child.text,
					memoryEnabled: memoryEnabled !== false,
					autoPromote: autoPromote !== false,
					validatedProfiles: selection.validatedProfiles,
					trialAuthorization: deps.trialAuthorization,
					formatInstructions: authorizationRequest.formatInstruction,
					beforeResolve: async () => {
						if (deps.turnTwo === "off" || deps.turnTwoIsEnabled?.() === false) {
							await sweep();
							return false;
						}
						return true;
					},
					readExcerpt: (sourceSession, from, to) =>
						sourceSession === sessionId
							? withRawMessageProvider(sessionId, provider, () =>
									readTurnTwoExcerpt(sourceSession, from, to),
								)
							: null,
					log: (message) => sessionLog(sessionId, message),
				};
			}
		});
	} catch (error) {
		const desc = describeError(error);
		telemetry.failureReason = PRODUCER_PROMPT_FIT_FAILURE_PATTERN.test(
			desc.message,
		)
			? desc.message
			: externalHistorianFailureReason(error, "exception");
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
				harness: resolvePiHarnessKind(),
				subagentInvocationId: invocationId,
				runKind: telemetry.runKind ?? "incremental",
				status: telemetry.status ?? "failed",
				failureReason:
					telemetry.failureReason ??
					((telemetry.status ?? "failed") === "failed"
						? "provider_error"
						: null),
				chunkStartOrdinal: telemetry.chunkStartOrdinal ?? null,
				chunkEndOrdinal: telemetry.chunkEndOrdinal ?? null,
				unprocessedFrom: telemetry.unprocessedFrom ?? null,
				compartmentsProduced: telemetry.compartmentsProduced ?? 0,
				compartmentIdMin: telemetry.compartmentIdMin ?? null,
				compartmentIdMax: telemetry.compartmentIdMax ?? null,
				factsEmitted: telemetry.factsEmitted ?? 0,
				factsByCategory: telemetry.factsByCategory ?? null,
				factsPromoted: telemetry.factsPromoted ?? 0,
				eventsEmitted: telemetry.eventsEmitted ?? 0,
				eventsPublished: telemetry.eventsPublished ?? 0,
				importanceMin: telemetry.importanceMin ?? null,
				importanceMax: telemetry.importanceMax ?? null,
				importanceAvg: telemetry.importanceAvg ?? null,
				discardedLast: telemetry.discardedLast ?? false,
			});
		} catch {
			/* telemetry must not break compaction */
		}
		if (continuation) schedulePiHistorianTurnTwo(continuation);
		else if (retained)
			await (retained as { child: PiRpcHistorianChild }).child.close();
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
			events?: ReturnType<typeof validateHistorianOutput> extends infer T
				? T extends { ok: true; events?: infer E }
					? E
					: never
				: never;
	  }
	| { kind: "validation-failed"; error: string; rawText: string }
	| {
			kind: "spawn-failed";
			reason: string;
			error: string;
			meta?: Record<string, unknown>;
	  }
	| { kind: "no-output" };

function piSubagentFailureReason(
	failure: Extract<ValidationOutcome, { kind: "spawn-failed" }>,
): string {
	if (failure.meta?.failureClass === ZEN_FREE_TIER_FAILURE)
		return ZEN_FREE_TIER_FAILURE;
	if (PRODUCER_PROMPT_FIT_FAILURE_PATTERN.test(failure.error))
		return failure.error;
	if (
		["step_limit", "token_budget", "invalid_prompt"].includes(failure.reason)
	) {
		return failure.error;
	}
	if (failure.reason === "abort") return "aborted";
	if (failure.reason === "timeout") {
		return externalHistorianFailureReason(failure.error, "timeout");
	}
	if (failure.reason === "parse_failed") return "parse_failed";
	if (failure.reason === "non_zero_exit") {
		const exitCode =
			failure.meta?.exitCode ??
			/\bcode\s*=\s*(-?\d+|null)\b/i.exec(failure.error)?.[1];
		return subprocessExitHistorianFailureReason(exitCode, failure.meta?.stderr);
	}
	if (failure.reason === "no_assistant") {
		const providerReason = externalHistorianFailureReason(failure.error);
		return providerReason === "provider_error"
			? "empty_output"
			: providerReason;
	}
	return externalHistorianFailureReason(
		failure.error,
		failure.reason === "spawn_failed" ? "exception" : "provider_error",
	);
}

async function validateHistorianResult(
	result: SubagentRunResult,
	sessionId: string,
	chunk: Parameters<typeof validateHistorianOutput>[2],
	priorCompartments: Parameters<typeof validateHistorianOutput>[3],
	sequenceOffset: number,
	turnTwoEnabled = false,
): Promise<ValidationOutcome> {
	if (!result.ok) {
		return {
			kind: "spawn-failed",
			reason: result.reason,
			error: result.error,
			...(result.meta ? { meta: result.meta } : {}),
		};
	}
	if (result.assistantText.trim().length === 0) {
		return { kind: "no-output" };
	}

	const xml = turnTwoEnabled
		? parseEnabledTurnOne(result.assistantText)
		: result.assistantText;
	if (
		xml === null ||
		result.meta?.lengthCapped === true ||
		(turnTwoEnabled && hasHistorianToolActivity(result.meta))
	)
		return {
			kind: "validation-failed",
			error: "Invalid turn-one envelope",
			rawText: result.assistantText,
		};
	const validation = validateHistorianOutput(
		xml,
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
 * Resolve the first real Pi SessionEntry id at or after the raw ordinal that
 * follows the newest compartment. Historian boundaries use RawMessage ordinals,
 * so this must use the same conversion rather than counting branch entries.
 *
 * Empty-id slots cannot anchor Pi's native compaction marker, but may be followed
 * by a real entry that can. Folded tool-result slots are different: their
 * synthesized id represents kept-tail content, so advancing past one would drop
 * that content. resolvePiFirstKeptEntry distinguishes a trailing result group that
 * can merge into a future user entry from an interior group that needs a newer
 * summary boundary before a native marker can be placed.
 * System slots keep their ordinals but cannot anchor the kept conversation tail;
 * Pi's compaction snapshot preserves their effective state instead.
 *
 * `ordinalOffset` places the stored ordinal on this branch when the walk no
 * longer starts where the stored coordinates were written (see
 * pi-ordinal-alignment.ts).
 */
export function findFirstKeptEntryId(
	entries: readonly unknown[],
	lastCompactedOrdinal: number,
	ordinalOffset = 0,
): string | null {
	const boundary = resolvePiFirstKeptEntry(
		entries,
		lastCompactedOrdinal,
		ordinalOffset,
	);
	return boundary.kind === "resolved" ? boundary.entryId : null;
}

export function resolvePiFirstKeptEntry(
	entries: readonly unknown[],
	lastCompactedOrdinal: number,
	ordinalOffset = 0,
):
	| { kind: "resolved"; entryId: string }
	| { kind: "waiting" }
	| { kind: "unplaceable"; rawId: string } {
	const target = lastCompactedOrdinal + 1;
	const afterOrdinal = Number.isNaN(lastCompactedOrdinal)
		? 0
		: Math.max(0, lastCompactedOrdinal);
	let syntheticKeptId: string | undefined;
	for (const message of iterateEntriesToRawMessageRange(
		entries,
		afterOrdinal,
		Number.MAX_SAFE_INTEGER,
		Number.MAX_SAFE_INTEGER,
		ordinalOffset,
	)) {
		if (message.ordinal < target || isPiSystemEntry(message)) continue;
		// iterateEntriesToRawMessageRange groups consecutive tool results into a
		// generated user message without a real SessionEntry id. A real user appended
		// at the session tail can carry those results instead. Once another chat
		// message follows the group, appends cannot change it. Skipping the group
		// would discard tool results outside the summary.
		if (syntheticKeptId) return { kind: "unplaceable", rawId: syntheticKeptId };
		if (message.id.startsWith(SYNTH_USER_ID_PREFIX)) {
			syntheticKeptId = message.id;
			continue;
		}
		if (message.id.length === 0) continue;
		return { kind: "resolved", entryId: message.id };
	}
	return { kind: "waiting" };
}
