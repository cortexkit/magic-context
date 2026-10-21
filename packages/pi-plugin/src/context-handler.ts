/**
 * Pi `context` event handler — the per-LLM-call transform pipeline.
 *
 * Pi fires `pi.on("context", ...)` immediately before each LLM
 * invocation, with the full `AgentMessage[]` that's about to be sent.
 * The handler can return `{ messages }` to replace the array.
 *
 * This handler now mirrors OpenCode's full transform pipeline (see
 * PARITY.md for the deliberate mechanism-level divergences). Per pass it:
 *   1. Wraps the AgentMessage[] in a Transcript via `createPiTranscript`.
 *   2. Tags eligible parts with the shared `Tagger` and injects `§N§ `
 *      prefixes (unless the session has no ctx_reduce tool).
 *   3. Applies queued drops (`pending_ops`) + persisted tag statuses so
 *      cross-session drops survive.
 *   4. Prepares m[0]/m[1] history injection, trims the live tail to the
 *      compartment boundary, and replays reasoning/placeholder/sentinel
 *      strips for cache stability — Pi DOES have prompt-cache-sensitive
 *      providers (Anthropic via the m[0]/m[1] split), so the same
 *      byte-stability discipline as OpenCode applies.
 *   5. Runs the historian/compartment trigger, nudges (rolling,
 *      note-nudge, ctx_reduce reminders), and auto-search hints.
 *   6. Drains deferred compaction markers via Pi's `appendCompaction()`
 *      surface (Pi's analogue of OpenCode's compaction-marker injection).
 *
 * Error handling: ordinary thrown errors are caught and logged, then the
 * original messages pass through unmodified — the same fail-open
 * philosophy as the OpenCode `messages-transform` wrapper. FailClosedBlockingError
 * is rethrown so deterministic inoperability cannot silently degrade to
 * native compaction.
 */

import * as crypto from "node:crypto";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ProtectedTokensTierOverrides } from "@magic-context/core/config/project-security";
import {
	acquireCompartmentLease,
	COMPARTMENT_LEASE_RENEWAL_MS,
	releaseCompartmentLeaseBestEffort,
	renewCompartmentLease,
} from "@magic-context/core/features/magic-context/compartment-lease";
import { isFailClosedBlockingError } from "@magic-context/core/features/magic-context/fail-closed-block";
import {
	isUsableProjectIdentity,
	resolveProjectIdentityForSession,
} from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	clearSessionTracking,
	scheduleIncrementalIndex,
	scheduleReconciliation,
} from "@magic-context/core/features/magic-context/message-index-async";
import { isPrefixBoundThinkingModel } from "@magic-context/core/features/magic-context/overflow-detection";
import {
	decodePiContentDecision,
	encodePiContentDecision,
} from "@magic-context/core/features/magic-context/pi-content-decisions";
import {
	computeProtectionWindow,
	getProtectionWindowForSession,
} from "@magic-context/core/features/magic-context/protection-window";
import {
	protectedToolTagNumbers,
	protectedToolTokenCount,
} from "@magic-context/core/features/magic-context/reclaim-protection";
import {
	createScheduler,
	parseCacheTtl,
	type Scheduler,
} from "@magic-context/core/features/magic-context/scheduler";
import { resolveSessionCacheTtl } from "@magic-context/core/features/magic-context/session-cache-ttl";
import {
	HYGIENE_PROVIDER_UNITS_VERSION,
	sessionDecisionCalibration,
	transitionSessionHygieneUnits,
} from "@magic-context/core/features/magic-context/session-decision-calibration";
import { recordSessionProjectIdentity } from "@magic-context/core/features/magic-context/session-project-storage";
import {
	adoptPiFallbackMessageTag,
	adoptPiFallbackToolOwnerTag,
	type ContextDatabase,
	captureChannel1PostReduceGraceBaseline,
	casChannel2NudgeState,
	clearPendingPiCompactionMarkerStateIf,
	deriveTagLoadFloor,
	findAdoptableFallbackTags,
	findPiFallbackToolOwnerTags,
	getActiveTagsBySession,
	getChannel1NudgeState,
	getDroppedTagsByNumbers,
	getMaxDroppedTagNumber,
	getOldestActiveUnprotectedToolTags,
	getPendingOps,
	getPendingOpsCount,
	getPendingPiCompactionMarkerState,
	getPersistedToolTagAccounting,
	getTagsByNumbers,
	getTagsBySession,
	getTagsForPendingOperations,
	isWrapupInProgress,
	setSessionWorkMetrics,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import {
	type AutoSearchHintDecision,
	type AutoSearchHintNoHintReason,
	clearDetectedContextLimit,
	clearEmergencyDropSample,
	clearEmergencyRecovery,
	clearHistorianFailureState,
	clearPersistedReasoningWatermark,
	clearThinkingBindingRecoveryIf,
	EMERGENCY_DRAIN_FAILURE_BACKOFF_MS,
	flushAutoSearchHintDecisionRetirement,
	getAutoSearchHintDecisions,
	getEmergencyInputSample,
	getHistorianFailureState,
	getNoteNudgeAnchors,
	getPersistedTodoSyntheticAnchor,
	isProviderOverflowFailClosedProven,
	type NoteNudgeAnchor,
	type PendingPiCompactionMarker,
	pruneNoteNudgeAnchors,
	resolveEpochFloorForPass,
	setEmergencyDropSample,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { getNativeReplayState } from "@magic-context/core/features/magic-context/storage-native-replay";
import { getSourceContents } from "@magic-context/core/features/magic-context/storage-source";
import { tagIdentityRevisionKey } from "@magic-context/core/features/magic-context/storage-tag-identity-revision";
import {
	findPiTagIdentityConflict,
	getPiMessageTagCandidates,
	getToolTagNumberByOwner,
	hasPiFallbackMessageTags as hasPersistedPiFallbackMessageTags,
	hasPiFallbackToolOwnerTags as hasPersistedPiFallbackToolOwnerTags,
	PiTagIdentityConflictError,
} from "@magic-context/core/features/magic-context/storage-tags";
import {
	createTagger,
	type Tagger,
} from "@magic-context/core/features/magic-context/tagger";
import {
	freezeTemporalDecisions,
	observeTemporalDecisions,
} from "@magic-context/core/features/magic-context/temporal-decisions";
import {
	findNewestPiAssistantEntryId,
	hasPendingPiSystemPromptHashChange,
	normalizeMaterializeReason,
	notePiSystemPromptHashChange,
	recordPendingPiTransformDecision,
	schedulePiTransformDecisionResolve,
} from "@magic-context/core/features/magic-context/transform-decision-log";
import { computePiWorkMetrics } from "@magic-context/core/features/magic-context/work-metrics";
import {
	applyFlushedStatuses,
	applyPendingOperations,
	convertLegacyToolSkeletons,
	foldBustsServedPrefix,
	RECENT_TOOL_SKELETON_WINDOW,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import {
	hasReclaimRide,
	reclaimRideLabel,
} from "@magic-context/core/hooks/magic-context/cache-busting-signals";
import {
	type CavemanWordRules,
	cavemanWordRulesForLanguage,
} from "@magic-context/core/hooks/magic-context/caveman";
import { replayCavemanCompression } from "@magic-context/core/hooks/magic-context/caveman-cleanup";
import {
	rearmChannel2AfterCoverageAdvancingHardFold,
	rearmChannel2AfterMeasuredCollapse,
} from "@magic-context/core/hooks/magic-context/channel2-cycle";
import { checkCompartmentTrigger } from "@magic-context/core/hooks/magic-context/compartment-trigger";
import { evaluateChannel2 } from "@magic-context/core/hooks/magic-context/ctx-reduce-nudge";
import { calibrationForModelKey } from "@magic-context/core/hooks/magic-context/decision-calibration";
import { DegradedPassRefusalError } from "@magic-context/core/hooks/magic-context/degraded-pass-refusal";
import { deriveTriggerBudget } from "@magic-context/core/hooks/magic-context/derive-budgets";
import {
	type DroppedTokenReduction,
	estimateDroppedTokensFromTagReductions,
} from "@magic-context/core/hooks/magic-context/dropped-token-estimate";
import {
	contextRefusalError,
	EmergencyFailClosedError,
	outgoingContextRefusal,
} from "@magic-context/core/hooks/magic-context/emergency-fail-closed";
import {
	DEFAULT_CONTEXT_LIMIT,
	historyBudgetPolicyIdentity,
	resolveExecuteThreshold,
} from "@magic-context/core/hooks/magic-context/event-resolvers";
import { foldExecutesThisPass } from "@magic-context/core/hooks/magic-context/fold-execution-gate";
import { isHistorianDrainBudgetSpent } from "@magic-context/core/hooks/magic-context/historian-drain-gate";
import { getVisibleMemoryIds } from "@magic-context/core/hooks/magic-context/inject-compartments";
import {
	hasActiveAnthropicThinkingTurn,
	latestAssistantTurnStart,
	protectNewTagMutations,
} from "@magic-context/core/hooks/magic-context/latest-assistant-turn";
import {
	captureOriginalTurn,
	prepareLatestThinkingRecovery,
} from "@magic-context/core/hooks/magic-context/latest-thinking-recovery";
import { loadPersistedLkgSlot } from "@magic-context/core/hooks/magic-context/lkg-persist";
import {
	invalidateCleanLkgRecoveryFence,
	LkgRecoveryFenceError,
} from "@magic-context/core/hooks/magic-context/lkg-recovery-fence";
import {
	markNoteNudgeDelivered,
	observeNoteNudgeServe,
	onNoteTrigger,
	peekNoteNudgeText,
} from "@magic-context/core/hooks/magic-context/note-nudger";
import {
	getRawHistoryEligibility,
	hasRunnableCompartmentWindow,
	type ProtectedTailBoundarySnapshot,
	resolveBoundaryContext,
	resolveProtectedTailBoundary,
} from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import {
	readRawSessionMessages,
	setRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { invalidateTrueRawTokenCache } from "@magic-context/core/hooks/magic-context/read-session-true-raw-tokens";
import {
	DEFAULT_KEEP_REASONING_TOKENS,
	resolveKeepReasoningTokens,
} from "@magic-context/core/hooks/magic-context/reasoning-budget";
import { captureOpencodeReasoningBudgetStatus } from "@magic-context/core/hooks/magic-context/reasoning-budget-status";
import {
	modelAcceptsEmptyContent,
	variantChangeBustsProviderCache,
} from "@magic-context/core/hooks/magic-context/sentinel";
import { servedPrefixMatches } from "@magic-context/core/hooks/magic-context/strict-thinking-prefix";
import {
	buildEditSupersessionReclaim,
	buildSupersessionReclaimOps,
	recentSupersessionOwnerMessageIds,
} from "@magic-context/core/hooks/magic-context/supersession-reclaim";
import { stripSystemInjection } from "@magic-context/core/hooks/magic-context/system-injection-stripper";
import { stripTagPrefix } from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import { formatTailHygienePrefixMismatch } from "@magic-context/core/hooks/magic-context/tail-hygiene-walk";
import { readServedTemporalDecisions } from "@magic-context/core/hooks/magic-context/temporal-served-projection";
import {
	advanceToolReclaimWatermarkByDistance,
	buildSyntheticToolReclaimOps,
	toolReclaimDistanceEntries,
} from "@magic-context/core/hooks/magic-context/tool-reclaim";
import { getUnpublishedAutoSearchNoHint } from "@magic-context/core/shared/auto-search-lifecycle";
import { escalationBands } from "@magic-context/core/shared/escalation-bands";
import { getHarness } from "@magic-context/core/shared/harness";
import { piModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";
import { log, sessionLog } from "@magic-context/core/shared/logger";
import type { ModelInput } from "@magic-context/core/shared/model-resolution";
import { isSaneLimit } from "@magic-context/core/shared/models-dev-cache";
import { recoveryReasoningPrefixes } from "@magic-context/core/shared/recovery-reasoning-prefix";
import {
	guardSqliteTransformPass,
	type Statement as PreparedStatement,
	withAsyncPrivilegedWriter,
	withoutSqliteTransformPass,
	withSqliteBackgroundWriter,
} from "@magic-context/core/shared/sqlite";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import {
	buildPersistedDropTargets,
	TEXT_TAG_IDENTITY_MARKER,
	tagTranscript,
} from "@magic-context/core/shared/tag-transcript";
import { logSlowWriteTransaction } from "@magic-context/core/shared/write-transaction-timing";
import {
	clearAutoSearchForPiSession,
	runAutoSearchHintForPi,
} from "./auto-search-pi";
import { clearPiEmbedSessionState } from "./commands/ctx-embed";
import { sendCtxStatusMessage } from "./commands/pi-command-utils";
import {
	type ApplyDeferredPiCompactionMarkerDeps,
	adaptPiAppendCompaction,
	applyDeferredPiCompactionMarker,
	clearPiCompactionMarkerDrainLogState,
	getPiCompactionMarkerDrainErrorFields,
	logPiCompactionMarkerDrainGateOnce,
} from "./compaction-marker-manager-pi";
import {
	commitPiCompactionModeRecord,
	reconcilePiCompactionMode,
} from "./compaction-off-pi";
import {
	hasPiTransformTimingObserver,
	recordPiTransformTiming,
} from "./context-perf-hooks";
import {
	clearPiChannel1State,
	getPiChannel1Baseline,
	setPiChannel1Baseline,
} from "./ctx-reduce-nudge-pi";
import { runPiDebugAssertion } from "./debug-assertions-pi";
import { detectRecentCommit } from "./detect-recent-commit";
import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import { hasPiFallbackMessageTags } from "./fallback-tag-probes-pi";
import {
	applyPiHeuristicCleanup,
	type PiHeuristicCleanupResult,
} from "./heuristic-cleanup-pi";
import { readPiHistorianTail } from "./historian-tail-pi";
import {
	clearPiHistoryBoundaryRepairSession,
	repairPiHistoryBoundary,
} from "./history-boundary-repair-pi";
import { readHostSystemPrompt } from "./host-system-prompt";
import {
	clearM0M1PiCache,
	clearPiInjectionTokenCountCache,
	clearPiMuralProcessCache,
	createPiM0M1PassSnapshot,
	injectM0M1Pi,
	mustMaterializePi,
	type PiM0M1InjectionResult as PiInjectionResult,
	type PiM0M1PassSnapshot,
	type PiM0M1State,
	prepareCachedM0M1PiReplay,
	trimPiMessagesToCachedBoundary,
} from "./inject-compartments-pi";
import {
	canClearNativeReasoning,
	NATIVE_TOOL_REMOVAL_MARKER,
} from "./native-replay-pi";
import {
	applyNativeReasoningReplayPi,
	applyNativeToolInputReplayPi,
	authorizePiToolRemoval,
	preparePiToolRemovalMeasurements,
} from "./native-replay-state-pi";
import { hasVisibleNoteReadCallPi } from "./note-visibility-pi";
import { PI_CONTEXT_BUDGET, PiContextDeadlineError } from "./pi-context-budget";
import {
	resolvePiUsableContextLimit,
	resolvePiWindowGeometry,
} from "./pi-context-limit";
import {
	clearPiContextReceipt,
	PiContextSupersededError,
	registerPiGuardedContext,
} from "./pi-context-refusal";
import { createPiFallbackIndex } from "./pi-fallback-index";
import {
	clearPiFitReclaimInput,
	clearPiUpperReclaimSession,
	piFitOverflowPossible,
	piUpperReclaimCursor,
	recordPiUpperEstimateReclaim,
	releasePiUpperEstimateReclaim,
	requestPiFitReclaimInput,
	reservePiUpperEstimateReclaim,
	shouldReclaimPiUpperEstimate,
} from "./pi-fit-reclaim";
import { type PiHistorianDeps, runPiHistorian } from "./pi-historian-runner";
import { readPiHistoryRetirement } from "./pi-history-retirement";
import {
	clearPiLkgSessionState,
	createPiLkgCoordinator,
	isTransientPiStorageError,
	type PiLkgPassSnapshot,
	type PiLkgSerializedOutput,
	PiLkgUncapturable,
	piStorageErrorReason,
	reconcilePiLkgEntryIds,
	resolvePiLkgOutputEntryIds,
	restorePiLkgInputForFit,
} from "./pi-lkg";
import { readPiLkgFitEnvelope } from "./pi-lkg-fit-envelope";
import {
	piMessageEntryFingerprint as fingerprintPiMessage,
	piCachedMessageSurvivor,
} from "./pi-message-identity";
import {
	clearPiOrdinalAlignmentSession,
	isPiOrdinalAlignmentUnanchored,
	type PiOrdinalAlignment,
	piRawOrdinalOffsetSource,
	resolvePiOrdinalAlignment,
	resolvePiOrdinalAlignmentForContext,
} from "./pi-ordinal-alignment";
import {
	clearPiLiveUsageClassification,
	formatPiPressureForLog,
	isPiLiveUsageRawBranchEstimate,
	noteRejectedPiUsage,
	piPressureEvidenceLimit,
	piProviderUsageWasRejected,
	recordPiLiveUsageClassification,
	resolvePiPressureSnapshotWithEstimateGuard,
} from "./pi-pressure";
import { resolvePiProvenInputFloor } from "./pi-proven-floor";
import {
	assertPiRawFallbackFits,
	classifyPiOutgoingFit,
	estimatePiOutgoingInputTokens,
	PiDegradedPassError,
	PiStorageBusyError,
	piFallbackRefusal,
} from "./pi-raw-fallback";
import {
	notePiPublicationIssue,
	PiServedEnvelopeUnavailable,
	publishPiServedNumbers,
	readPiCommittedServedNumbers,
} from "./pi-served-identities";
import {
	acknowledgePiIdentityRebuilds,
	claimPiIdentityRebuildFailure,
	claimPiIdentityRepair,
	PI_TAG_IDENTITY_REPAIR_REASON,
	type PiIdentityRebuild,
	queuePiIdentityRebuild,
	readPiIdentityDecisions,
	readPiIdentityRebuilds,
	recordPiIdentityRecurrence,
} from "./pi-tag-identity-repair";
import { injectSyntheticTodowriteForPi } from "./pi-todo-inject";
import {
	piAssistantToolIdentity,
	piCachedToolSurvivor,
} from "./pi-tool-identity";
import { loadPiToolWireSchema } from "./pi-tool-wire-schema";
import {
	applyPiProactiveThinkingStrip,
	applyPiThinkingBindingRecovery,
	frozenBindingEntryIds,
	hasUnfrozenPiThinking,
	resolvePiBindingStripOrder,
	shouldRunPiProactiveThinkingStrip,
} from "./provider-error-recovery-pi";
import {
	convertEntriesToRawMessagePage,
	convertEntriesToRawMessages,
	countPiRawMessages,
	findRestartModelSeedFromBranch,
	isPiContentFallbackId,
	isPiIndexFallbackId,
	piContentFallbackIds,
	readPiSessionMessagePage,
	readPiSessionMessages,
	resolvePiRealStableId,
	resolvePiStableId,
} from "./read-session-pi";
import {
	buildMessageIdToMaxTag,
	clearOldReasoningPi,
	piReasoningClearCutoff,
	piReasoningStatusMessages,
	replayClearedReasoningPi,
	replayStrippedInlineThinkingPi,
	stripInlineThinkingPi,
} from "./reasoning-replay-pi";
import { replayPiReminderStrips } from "./reminder-strip-pi";
import {
	capturePiServedArray,
	clearPiServedArraySession,
	getPiLastServedArray,
	getPiServedTagNumbers,
	PiServedIdentityError,
} from "./served-array-ledger";
import { stripPiDroppedPlaceholderMessages } from "./strip-placeholders-pi";
import { stripPiProcessedImages } from "./strip-processed-images-pi";
import {
	adoptPiCompactionSystemSnapshot,
	isPiSystemEntry,
	isPiSystemMessageEntry,
	type PiEffectiveSystemState,
	resolvePiEffectiveSystemState,
} from "./system-entry-pi";
import { clearPiSystemPromptSession } from "./system-prompt";
import {
	assertPiTagSnapshotReady,
	cancelPiTagSnapshotSession,
	ensurePiTagSnapshotReady,
	getPiActiveTagSnapshotView,
	getPiTagSnapshotView,
	prewarmPiTagSnapshot,
	readPiFallbackTagRows,
} from "./tag-snapshot-pi";
import { PiTagHydrationError } from "./tag-snapshot-worker-client-pi";
import {
	assertPiTailHygieneContentUnchanged,
	clearPiTailHygieneContentMemo,
	effectivePiTailHygiene,
	refreshPiTailHygieneBaseline,
} from "./tail-hygiene-walk-pi";
import {
	collectPiTemporalCandidates,
	injectPiTemporalMarkers,
	stripPiLeadingTemporalMarker,
	withoutPiLeadingTemporalMarker,
} from "./temporal-awareness-pi";
import {
	type PiMessageTokenCacheEntry,
	tokenizePiMessages,
} from "./tokenize-pi-messages";
import { createPiTranscript } from "./transcript-pi";

/** Emergency-block threshold — mirrors OpenCode's >=95% emergency path. */
const EMERGENCY_BLOCK_PERCENTAGE = 95;

/**
 * Returns every row whose `tagNumber` equals `number`, from a list sorted by
 * tag number, using binary search. Legacy stores can hold more than one row
 * with the same number.
 */
function tagsWithNumber<T extends { tagNumber: number }>(
	sorted: readonly T[],
	number: number,
): T[] {
	let low = 0;
	let high = sorted.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((sorted[middle]?.tagNumber ?? Number.POSITIVE_INFINITY) < number)
			low = middle + 1;
		else high = middle;
	}
	const rows: T[] = [];
	for (let index = low; index < sorted.length; index += 1) {
		const row = sorted[index];
		if (row?.tagNumber !== number) break;
		rows.push(row);
	}
	return rows;
}

function newestActiveTagNumbersByCount(
	tags: readonly { status: string; tagNumber: number }[],
	count: number,
): Set<number> {
	return new Set(
		tags
			.filter((tag) => tag.status === "active")
			.sort((left, right) => right.tagNumber - left.tagNumber)
			.slice(0, Math.max(0, count))
			.map((tag) => tag.tagNumber),
	);
}

function isPiHardCacheExpired(
	lastResponseTime: number,
	ttlMs: number,
	now: number,
): boolean {
	// Strict > matches the Rust scheduler's predicate exactly: at elapsed == ttl
	// both sides DEFER (one more pass at the boundary is safe; a premature HARD
	// fold is a paid cache rebuild). Keep the comparators identical — the Rust
	// doc comment asserts this parity and an audit caught them disagreeing.
	return lastResponseTime > 0 && now - lastResponseTime > ttlMs;
}

let injectM0M1PiForRun = injectM0M1Pi;
let resolvePiEffectiveSystemStateForRun = resolvePiEffectiveSystemState;
let persistReasoningWatermarkForRun = updateSessionMeta;
let persistStableIdSchemeForRun = updateSessionMeta;
let afterFallbackAdoptionForTests:
	| ((stableIdSchemeCutover: boolean) => void)
	| undefined;
let pendingDecisionLogObserverForTests: ((message: string) => void) | undefined;
let mutationGateObserverForTests:
	| ((snapshot: {
			foldDue: boolean;
			foldExecuted: boolean;
			foldBustsServedPrefix: boolean;
			shouldApplyPendingOps: boolean;
			shouldRunHeuristics: boolean;
			shouldRunReasoningCleanup: boolean;
	  }) => void)
	| undefined;
let lkgRecoveryLogObserverForTests: ((message: string) => void) | undefined;
let pipelineResultObserverForTests:
	| ((
			sessionId: string,
			result: Readonly<
				Pick<
					RunPipelineResult,
					| "prefixBustPermitted"
					| "bustedThisPass"
					| "identityRebuilt"
					| "signedPrefixRewritten"
				>
			>,
	  ) => void)
	| undefined;

function observePipelineResultForTests(
	sessionId: string,
	result: RunPipelineResult,
): void {
	pipelineResultObserverForTests?.(sessionId, {
		prefixBustPermitted: result.prefixBustPermitted,
		bustedThisPass: result.bustedThisPass,
		identityRebuilt: result.identityRebuilt,
		signedPrefixRewritten: result.signedPrefixRewritten,
	});
}

let variantChangeLogObserverForTests: ((message: string) => void) | undefined;
let beforePipelineForTests: (() => Promise<void>) | undefined;

function logPiLkgRecovery(sessionId: string, message: string): void {
	lkgRecoveryLogObserverForTests?.(message);
	sessionLog(sessionId, message);
}

export const __test = {
	readPiFallbackFingerprintHeaders,
	setBeforePipelineForTests(fn: (() => Promise<void>) | undefined) {
		const previous = beforePipelineForTests;
		beforePipelineForTests = fn;
		return () => {
			beforePipelineForTests = previous;
		};
	},
	updateSessionProjectTracking,
	isPiHardCacheExpired,
	adoptPiFallbackTags,
	guardPiToolAllocations,
	guardPiMessageAllocations,
	buildEntryFingerprintMap,
	readPiEntryFingerprintCount: () => piEntryFingerprintCount,
	resolvePiEventEntryIds,
	readPiEntryAlignmentLaneCounts: () => ({ ...piEntryAlignmentLaneCounts }),
	buildPiToolOwnerMap,
	readPiBranchEntriesForContext,
	getTaggedStableMessageIdsForTests(sessionId: string): ReadonlySet<string> {
		return new Set(taggedStableMessageIdsBySession.get(sessionId));
	},
	recordSuccessfulTaggedMessageIds,
	buildPiTextIdentityPlan,
	setInFlightHistorianForTests(
		sessionId: string,
		promise: Promise<unknown>,
	): () => void {
		inFlightHistorian.set(sessionId, promise);
		return () => {
			if (inFlightHistorian.get(sessionId) === promise) {
				inFlightHistorian.delete(sessionId);
			}
		};
	},
	setInjectM0M1PiForTests(fn: typeof injectM0M1Pi): () => void {
		injectM0M1PiForRun = fn;
		return () => {
			injectM0M1PiForRun = injectM0M1Pi;
		};
	},
	setPiEffectiveSystemStateResolverForTests(
		fn: typeof resolvePiEffectiveSystemState,
	): () => void {
		resolvePiEffectiveSystemStateForRun = fn;
		return () => {
			resolvePiEffectiveSystemStateForRun = resolvePiEffectiveSystemState;
		};
	},
	setReasoningWatermarkPersistenceForTests(
		fn: typeof updateSessionMeta,
	): () => void {
		persistReasoningWatermarkForRun = fn;
		return () => {
			persistReasoningWatermarkForRun = updateSessionMeta;
		};
	},
	setStableIdSchemePersistenceForTests(
		fn: typeof updateSessionMeta,
	): () => void {
		persistStableIdSchemeForRun = fn;
		return () => {
			persistStableIdSchemeForRun = updateSessionMeta;
		};
	},
	setAfterFallbackAdoptionForTests(
		fn: ((stableIdSchemeCutover: boolean) => void) | undefined,
	): () => void {
		afterFallbackAdoptionForTests = fn;
		return () => {
			afterFallbackAdoptionForTests = undefined;
		};
	},
	setPendingDecisionLogObserverForTests(
		fn: typeof pendingDecisionLogObserverForTests,
	): () => void {
		pendingDecisionLogObserverForTests = fn;
		return () => {
			pendingDecisionLogObserverForTests = undefined;
		};
	},
	setMutationGateObserverForTests(
		fn: typeof mutationGateObserverForTests,
	): () => void {
		mutationGateObserverForTests = fn;
		return () => {
			mutationGateObserverForTests = undefined;
		};
	},
	variantRefreshStateForTests(sessionId: string) {
		return {
			history: historyRefreshSessions.has(sessionId),
			systemPrompt: systemPromptRefreshSessions.has(sessionId),
			materialization: pendingMaterializationSessions.has(sessionId),
		};
	},
	setVariantChangeLogObserverForTests(
		fn: typeof variantChangeLogObserverForTests,
	): () => void {
		variantChangeLogObserverForTests = fn;
		return () => {
			variantChangeLogObserverForTests = undefined;
		};
	},
	setLkgRecoveryLogObserverForTests(
		fn: typeof lkgRecoveryLogObserverForTests,
	): () => void {
		lkgRecoveryLogObserverForTests = fn;
		return () => {
			lkgRecoveryLogObserverForTests = undefined;
		};
	},
	setPipelineResultObserverForTests(
		fn: typeof pipelineResultObserverForTests,
	): () => void {
		const previous = pipelineResultObserverForTests;
		pipelineResultObserverForTests = fn;
		return () => {
			pipelineResultObserverForTests = previous;
		};
	},
};

/**
 * Current Pi message stable-id scheme version. Bump when the durable message
 * stable-id format changes in a way that re-keys persisted tag/source_contents/
 * caveman/placeholder state. A session whose persisted `pi_stable_id_scheme` is
 * below this triggers a one-time forced execute+materialize cutover.
 *   0 (NULL) = legacy index-based `pi-msg-${index}-...` ids.
 *   1        = real-SessionEntry-id scheme (resolvePiStableId).
 */
const PI_STABLE_ID_SCHEME = 1;

/**
 * Per-session emergency-notification dedup. Mirrors OpenCode's
 * `lastEmergencyNotificationCount` map — we only re-notify when the
 * historian failure count grows OR after a long quiet period, so a
 * stuck 95%+ session doesn't spam notifications on every defer pass.
 */
const lastEmergencyNotificationAtMs = new Map<string, number>();
const EMERGENCY_NOTIFICATION_COOLDOWN_MS = 60_000;

/**
 * Per-session "saw a commit on the previous pass" tracker for the
 * note-nudge `commit_detected` trigger. Mirrors OpenCode's
 * `commitSeenLastPass` map in `transform.ts`. The trigger only fires
 * on the rising edge: when this pass detects a recent commit AND the
 * previous pass did NOT (and we have a baseline at all — first-pass
 * detection silently sets the baseline without firing, so a fresh
 * restart over an old session that just committed doesn't surface a
 * stale trigger).
 *
 * Cleared in `clearContextHandlerSession()` so leaving a session
 * doesn't leave dead state behind.
 */
const commitSeenLastPass = new Map<string, boolean>();

/**
 * Three independent per-session refresh signals — mirrors OpenCode's
 * three-set split (transform.ts:444 + system-prompt-hash.ts:206 +
 * transform-postprocess-phase.ts:172). Each lifetime is consumed by a
 * different consumer so they cannot share state:
 *
 *  - `historyRefreshSessions`: invalidate the `<session-history>`
 *    injection cache. Set by `/ctx-flush`, historian publish,
 *    compressor publish. Drained inside runPipeline after the rebuild
 *    completes.
 *
 *  - `systemPromptRefreshSessions`: refresh disk/DB-derived adjuncts
 *    in the system prompt (`<project-docs>`, `<user-profile>`,
 *    `<key-files>`, sticky date). Set by `/ctx-flush`, system-prompt
 *    hash change, dreamer publish, user-memory promotion. Drained
 *    inside the `before_agent_start` handler after adjuncts have been
 *    refreshed (or kept cached).
 *
 *  - `pendingMaterializationSessions`: pending ops should materialize
 *    on the next execute pass. Set by `/ctx-flush`. Drained inside
 *    runPipeline once materialization runs.
 *
 * They get signaled together when a system-prompt hash change is
 * detected (the prefix cache is already busted, so all three caches
 * should rebuild on the same cycle).
 *
 * Module-scoped so command handlers, historian, and compressor can
 * write to them without holding a reference to the registerPiContextHandler
 * closure.
 */
const historyRefreshSessions = new Set<string>();
const systemPromptRefreshSessions = new Set<string>();
const pendingMaterializationSessions = new Set<string>();
const deferredHistoryRefreshSessions = new Set<string>();
const deferredMaterializationSessions = new Set<string>();
// Fingerprint the effective host prompt, not injection metadata: later extensions
// can replace the prompt after before_agent_start. Only successful returns advance it.
const lastServedSystemHashBySession = new Map<string, string>();

export function signalPiSystemHashChange(
	sessionId: string,
	hash: string,
): void {
	recordSystemRefreshOwnership(
		sessionId,
		hash,
		!historyRefreshSessions.has(sessionId),
		historyRefreshSessions,
		pendingMaterializationSessions,
	);
	signalPiHistoryRefresh(sessionId);
	signalPiSystemPromptRefresh(sessionId);
	if (!pendingMaterializationSessions.has(sessionId))
		signalPiPendingMaterialization(sessionId, "system_hash");
	// The next main context pass serves the first request that carries the new
	// system prompt. Record that the transform decision for that request must
	// name system_hash, even when the pass keeps m[0]/m[1] unchanged.
	notePiSystemPromptHashChange(sessionId);
}

function deferPiDeliveredSystemRefresh(
	sessionId: string,
	ownsHistory: boolean,
): void {
	deferDeliveredSystemRefresh(
		{
			historyRefreshSessions,
			pendingMaterializationSessions,
			deferredHistoryRefreshSessions,
			deferredMaterializationSessions,
		},
		sessionId,
		ownsHistory,
	);
}
const sessionsByProject = new Map<string, Set<string>>();
const lastSeenProjectIdentityBySession = new Map<string, string>();
const persistedProjectIdentityBySession = new Map<string, string>();
const sessionProjectBindingFailureLogAtBySession = new Map<string, number>();
const SESSION_PROJECT_BINDING_FAILURE_LOG_INTERVAL_MS = 10 * 60 * 1000;
const rawMessageProviderUnregistersBySession = new Map<string, () => void>();
const activeContextHandlerSessions = new Set<string>();
const lastHeuristicsTurnIdBySession = new Map<string, string>();
const routinePressureAppliedBySession = new Map<string, boolean>();
const firstContextPassSeenBySession = new Set<string>();
const contextPassGeneration = new Map<string, symbol>();

// The budget may remain reachable after preparation. Capture only generation
// and cancellation state here, never the handler's event or message history.
function createPiContextGenerationGuard(
	assertOperation: () => void,
	passSessionId: string | undefined,
	generation: symbol,
	sideTurn: boolean,
	signal: AbortSignal | undefined,
): () => void {
	return () => {
		assertOperation();
		// Supersession takes precedence over cancellation: the old context's
		// abort API belongs to the session and could cancel its replacement.
		if (
			!sideTurn &&
			passSessionId &&
			contextPassGeneration.get(passSessionId) !== generation
		)
			throw new PiContextSupersededError(
				"Pi context pass superseded by a newer context generation",
				"context generation",
			);
		signal?.throwIfAborted();
	};
}

class PiLkgAdmissionReplay extends Error {
	constructor(
		readonly messages: unknown[],
		readonly recovery = "fitting LKG before writer retries",
		readonly trigger: "writer_busy" | "held_identity_repair" = "writer_busy",
	) {
		super("Saved request served before writer wait");
	}
}
const liveModelBySession = new Map<string, string>();
const latestAssistantModelTimestampBySession = new Map<string, number>();
const taggedStableMessageIdsBySession = new Map<string, Set<string>>();
const taggedEntryHeadersBySession = new Map<string, Map<string, string>>();
const taggersBySession = new Map<string, Tagger>();

function recordSuccessfulTaggedMessageIds(
	sessionId: string,
	entryIds: readonly (string | undefined)[],
	branchEntries: readonly unknown[] | null,
): void {
	const liveRealIds = new Set<string>();
	for (const entryId of entryIds) {
		if (entryId && !entryId.startsWith("pi-msg-")) liveRealIds.add(entryId);
	}
	taggedStableMessageIdsBySession.set(sessionId, liveRealIds);
	const prior = taggedEntryHeadersBySession.get(sessionId);
	const current = branchEntries
		? getPiBranchEntryLookup(branchEntries).alignmentChecks
		: undefined;
	const headers = new Map<string, string>();
	for (const id of liveRealIds) {
		const header = current?.get(id)?.headerKey ?? prior?.get(id);
		if (header !== undefined) headers.set(id, header);
	}
	taggedEntryHeadersBySession.set(sessionId, headers);
}

const piMessageTokenCacheBySession = new Map<
	string,
	Map<string, PiMessageTokenCacheEntry>
>();
const piTagTextTokenCacheBySession = new Map<
	string,
	Map<string, { text: string; tokenCount: number }>
>();
const piTagToolTokenCacheBySession = new Map<
	string,
	Map<string, { text: string; tokenCount: number }>
>();
const piTextIdentitySourceCacheBySession = new Map<
	string,
	Map<number, string>
>();

const piFallbackIndexesBySession = new Map<
	string,
	{
		db: ContextDatabase;
		index: ReturnType<typeof createPiFallbackIndex>;
	}
>();

interface PiTextIdentityPlan {
	driftedMessageIds: Set<string>;
	legacyReminderTagNumbers: Set<number>;
	reusableMessageIds: Set<string>;
	sourceCache: Map<number, string>;
}

function buildPiTextIdentityPlan(
	db: ContextDatabase,
	sessionId: string,
	tagger: Tagger,
	transcript: ReturnType<typeof createPiTranscript>,
	reuseCandidates: ReadonlySet<string> = new Set(),
): PiTextIdentityPlan {
	const currentSourcesByMessageId = new Map<string, string[]>();
	for (const message of transcript.messages) {
		const messageId = message.info.id;
		if (messageId === undefined) continue;
		currentSourcesByMessageId.set(
			messageId,
			// Temporal gap markers are derived from the current projection. They are
			// not part of the stored message identity and can disappear when a newly
			// applied compaction boundary promotes a user message to the wire head.
			message.parts
				.filter((part) => part.kind === "text")
				.map((part) =>
					withoutPiLeadingTemporalMarker(stripTagPrefix(part.getText() ?? "")),
				),
		);
	}

	const legacyRowsByMessageId = new Map<
		string,
		Array<{ ordinal: number; tagId: number }>
	>();
	const versionedMessageIds = new Set<string>();
	for (const [contentId, tagId] of tagger.getAssignments(sessionId)) {
		const markerIndex = contentId.lastIndexOf(TEXT_TAG_IDENTITY_MARKER);
		if (markerIndex >= 0) {
			const ownerId = contentId.slice(0, markerIndex);
			if (currentSourcesByMessageId.has(ownerId))
				versionedMessageIds.add(ownerId);
			continue;
		}

		const ordinalMatch = /:p(\d+)$/.exec(contentId);
		if (!ordinalMatch) continue;
		const ownerId = contentId.slice(0, ordinalMatch.index);
		if (!currentSourcesByMessageId.has(ownerId)) continue;
		const ordinal = Number.parseInt(ordinalMatch[1] ?? "", 10);
		if (!Number.isSafeInteger(ordinal)) continue;
		const rows = legacyRowsByMessageId.get(ownerId) ?? [];
		rows.push({ ordinal, tagId });
		legacyRowsByMessageId.set(ownerId, rows);
	}

	let sourceCache = piTextIdentitySourceCacheBySession.get(sessionId);
	if (!sourceCache) {
		sourceCache = new Map();
		piTextIdentitySourceCacheBySession.set(sessionId, sourceCache);
	}
	const missingTagIds = Array.from(legacyRowsByMessageId.values())
		.flat()
		.map((row) => row.tagId)
		.filter((tagId) => !sourceCache.has(tagId));
	for (let offset = 0; offset < missingTagIds.length; offset += 500) {
		const loaded = getSourceContents(
			db,
			sessionId,
			missingTagIds.slice(offset, offset + 500),
		);
		for (const [tagId, source] of loaded) sourceCache.set(tagId, source);
	}

	const driftedMessageIds = new Set<string>();
	const legacyReminderTagNumbers = new Set<number>();
	for (const [messageId, currentSources] of currentSourcesByMessageId) {
		const legacyRows = legacyRowsByMessageId.get(messageId) ?? [];
		if (versionedMessageIds.has(messageId)) {
			driftedMessageIds.add(messageId);
			continue;
		}
		if (legacyRows.length === 0) continue;
		legacyRows.sort((left, right) => left.ordinal - right.ordinal);
		const vectorMatches =
			legacyRows.length === currentSources.length &&
			legacyRows.every((row, index) => {
				if (row.ordinal !== index) return false;
				const stored = withoutPiLeadingTemporalMarker(
					sourceCache.get(row.tagId) ?? "",
				);
				const current = currentSources[index] ?? "";
				if (stored === current) return true;
				// Older Pi cleanup persisted the stripped reminder body as source.
				// Treat that exact projection as the same text identity so deployment
				// does not retag the message before compatibility replay can restore it.
				const strippedCurrent = stripSystemInjection(current);
				const storedLegacyBody = withoutPiLeadingTemporalMarker(
					`${sourceCache.get(row.tagId) ?? ""}\n`,
				).trimEnd();
				const legacyReminderMatches =
					strippedCurrent !== null &&
					withoutPiLeadingTemporalMarker(stripTagPrefix(strippedCurrent)) ===
						storedLegacyBody;
				if (legacyReminderMatches) legacyReminderTagNumbers.add(row.tagId);
				return legacyReminderMatches;
			});
		if (!vectorMatches) driftedMessageIds.add(messageId);
	}

	const reusableMessageIds = new Set<string>();
	for (const messageId of reuseCandidates) {
		if (!driftedMessageIds.has(messageId)) reusableMessageIds.add(messageId);
	}
	return {
		driftedMessageIds,
		legacyReminderTagNumbers,
		reusableMessageIds,
		sourceCache,
	};
}

interface PiBranchEntryLookup {
	entryIdByMessageRef: Map<object, string>;
	entryIdsByFingerprint: Map<string, string[]>;
	entryIdsByToolIdentity: Map<string, string[]>;
	alignedEntryIds: (string | undefined)[];
	/**
	 * The same projection without system-role slots. Pi 0.87+ withholds system
	 * messages from `context` handlers (runner.js emitContext filters them out),
	 * so its event arrays align with this list rather than `alignedEntryIds`.
	 */
	alignedVisibleEntryIds: (string | undefined)[];
	/** What the context message built from each emitted entry must look like. */
	alignmentChecks: Map<string, PiAlignmentCheck>;
	/** How many emitted entries share each header key. */
	alignmentHeaderCounts: Map<string, number>;
	/** The entry with each header key; meaningful only where the count is 1. */
	alignmentEntryIdByHeader: Map<string, string>;
}

/**
 * The non-content fields of the context message Pi builds from one branch
 * entry (session-manager.js sessionEntryToContextMessages), used to check a
 * positional entry-id assignment without hashing message content.
 */
interface PiAlignmentCheck {
	responseId: string | null;
	timestamp: number | string | null;
	role: string;
	toolCallId: string | null;
	/** The four fields above, serialized, to count entries that share them. */
	headerKey: string;
	entry: { type: string; message?: unknown; [key: string]: unknown };
	/** Content fingerprint of the expected message, computed on first need. */
	fingerprint?: string | null;
}

interface PiBranchProjectionCache {
	leafId: string;
	entries: readonly unknown[];
	indexById: Map<string, number>;
	lookup: PiBranchEntryLookup;
}

const piBranchProjectionBySession = new Map<string, PiBranchProjectionCache>();
const piBranchLookupByProjection = new WeakMap<
	readonly unknown[],
	PiBranchEntryLookup
>();

function logTransformElapsed(
	sessionId: string,
	stage: string,
	elapsedMs: number,
	extra?: string,
): void {
	const suffix = extra ? ` ${extra}` : "";
	recordPiTransformTiming({ sessionId, stage, elapsedMs, extra });
	sessionLog(
		sessionId,
		`transform stage: stage=${stage} elapsed=${elapsedMs.toFixed(1)}ms${suffix}`,
	);
}

function logTransformTiming(
	sessionId: string,
	stage: string,
	start: number,
	extra?: string,
): void {
	logTransformElapsed(sessionId, stage, performance.now() - start, extra);
}

export function piVariantChangeBustsProviderCache(
	providerID?: string,
	modelID?: string,
): boolean {
	return variantChangeBustsProviderCache(providerID, modelID);
}

function resolvePiContextModelKey(ctx: ExtensionContext): string | undefined {
	const model = (ctx as { model?: { provider?: unknown; id?: unknown } }).model;
	if (!model) return undefined;
	if (typeof model.provider !== "string" || model.provider.length === 0) {
		return undefined;
	}
	if (typeof model.id !== "string" || model.id.length === 0) return undefined;
	return `${model.provider}/${model.id}`;
}

function readPiSessionMessageById(
	ctx: ExtensionContext,
	messageId: string,
	ordinalOffset = 0,
): ReturnType<typeof readPiSessionMessages>[number] | null {
	return (
		readPiSessionMessages(ctx, ordinalOffset).find(
			(message) => message.id === messageId,
		) ?? null
	);
}

function convertLocatedPiUserEntry(
	branchEntries: readonly unknown[],
	messageId: string,
	ordinalOffset = 0,
): ReturnType<typeof readPiSessionMessages>[number] | null {
	let rawOrdinal = ordinalOffset > 0 ? ordinalOffset : 0;
	let pendingToolStart = -1;
	for (let index = 0; index < branchEntries.length; index += 1) {
		const entry = branchEntries[index];
		if (!entry || typeof entry !== "object") continue;
		const record = entry as { type?: unknown; id?: unknown; message?: unknown };
		if (
			record.type !== "message" ||
			!record.message ||
			typeof record.message !== "object"
		) {
			continue;
		}
		const role = (record.message as { role?: unknown }).role;
		if (role === "toolResult") {
			if (pendingToolStart < 0) pendingToolStart = index;
			continue;
		}
		if (role === "assistant" && pendingToolStart >= 0) rawOrdinal += 1;
		rawOrdinal += 1;
		if (record.id === messageId && role === "user") {
			const start = pendingToolStart >= 0 ? pendingToolStart : index;
			const converted = convertEntriesToRawMessages(
				branchEntries.slice(start, index + 1) as unknown[],
			).find((message) => message.id === messageId);
			return converted ? { ...converted, ordinal: rawOrdinal } : null;
		}
		pendingToolStart = -1;
	}
	return null;
}

/**
 * Mark a Pi session as needing an injection-cache rebuild on its next
 * transform pass. Cheap idempotent set add — multiple callers can
 * signal in the same window and only the next pass will see the
 * combined effect.
 */
export function signalPiHistoryRefresh(sessionId: string): void {
	historyRefreshSessions.add(sessionId);
}

/**
 * Mark a Pi session as needing system-prompt adjunct refresh on its
 * next `before_agent_start` event. Used by /ctx-flush, dreamer doc
 * publication, and user-memory promotion.
 */
export function signalPiSystemPromptRefresh(sessionId: string): void {
	systemPromptRefreshSessions.add(sessionId);
}

/**
 * Mark a Pi session as needing pending-op materialization on the next
 * execute pass. Used by /ctx-flush.
 */
export function signalPiPendingMaterialization(
	sessionId: string,
	origin: PendingMaterializationOrigin = "user_flush",
): void {
	requestPendingMaterialization(
		pendingMaterializationSessions,
		sessionId,
		origin,
	);
}

export function clearPiM0Cache(
	db: ContextDatabase,
	sessionId: string,
	reason: string,
): void {
	clearM0M1PiCache(db, sessionId, reason);
}

export function signalPiDeferredHistoryRefresh(sessionId: string): void {
	deferredHistoryRefreshSessions.add(sessionId);
}

export function signalPiDeferredMaterialization(sessionId: string): void {
	deferredMaterializationSessions.add(sessionId);
}

export function consumeDeferredHistoryRefresh(sessionId: string): boolean {
	const wasSet = deferredHistoryRefreshSessions.has(sessionId);
	deferredHistoryRefreshSessions.delete(sessionId);
	return wasSet;
}

export function consumeDeferredMaterialization(sessionId: string): boolean {
	const wasSet = deferredMaterializationSessions.has(sessionId);
	deferredMaterializationSessions.delete(sessionId);
	return wasSet;
}

// Upper bound on the number of sessions whose per-session in-memory caches
// (the ~16 module-scoped Maps/Sets above) we retain. A session normally frees
// its entries via clearContextHandlerSession on shutdown/switch, but a crashed
// or force-quit Pi process never fires those, so the entries would leak forever
// in a long-running host. When the live set grows past this cap we evict the
// least-recently-tracked session through the SAME cleanup path — safe because
// every per-session cache is rebuildable from the durable DB on resume (we do
// NOT touch DB state here, identical to a process restart).
const MAX_TRACKED_SESSIONS = 100;

export function trackSessionForProject(
	projectIdentity: string,
	sessionId: string,
): void {
	// Move-to-end so iteration order is least-recently-tracked → most-recent
	// (Set preserves insertion order; re-inserting refreshes recency).
	activeContextHandlerSessions.delete(sessionId);
	activeContextHandlerSessions.add(sessionId);
	// A session outside any project (empty identity) still gets its caches
	// tracked for eviction, but is never filed under a blank project key.
	if (isUsableProjectIdentity(projectIdentity)) {
		let sessions = sessionsByProject.get(projectIdentity);
		if (!sessions) {
			sessions = new Set();
			sessionsByProject.set(projectIdentity, sessions);
		}
		sessions.add(sessionId);
	}

	// Evict the oldest tracked sessions beyond the cap. clearContextHandlerSession
	// removes the evicted id from activeContextHandlerSessions, so the loop
	// terminates; never evict the session we just registered.
	while (activeContextHandlerSessions.size > MAX_TRACKED_SESSIONS) {
		const oldest = activeContextHandlerSessions.values().next().value;
		if (oldest === undefined || oldest === sessionId) break;
		clearContextHandlerSession(oldest);
	}
}

function isContextHandlerSessionActive(sessionId: string): boolean {
	return activeContextHandlerSessions.has(sessionId);
}

function updateSessionProjectTracking(
	sessionId: string,
	projectIdentity: string | undefined,
	db?: ContextDatabase,
	observedCwd?: string,
): void {
	if (!projectIdentity) return;
	const prev = lastSeenProjectIdentityBySession.get(sessionId);
	if (prev && prev !== projectIdentity) {
		const prevSessions = sessionsByProject.get(prev);
		prevSessions?.delete(sessionId);
		if (prevSessions?.size === 0) sessionsByProject.delete(prev);
		clearPiSystemPromptSession(sessionId);
	}
	// Pi's session cwd is host-owned, so persist its project binding even for
	// sessions that never embed chunks. Retry failed writes on later observations;
	// successful bindings do not write on steady-state passes.
	if (
		db &&
		persistedProjectIdentityBySession.get(sessionId) !== projectIdentity
	) {
		try {
			const change = recordSessionProjectIdentity(
				db,
				sessionId,
				projectIdentity,
			);
			persistedProjectIdentityBySession.set(sessionId, projectIdentity);
			if (change) {
				sessionLog(
					sessionId,
					`project binding changed harness=${getHarness()} cwd=${observedCwd ?? "unknown"} old=${change.previousProjectPath ?? "none"} new=${change.projectPath}`,
				);
			}
		} catch (error) {
			const now = Date.now();
			const lastLoggedAt =
				sessionProjectBindingFailureLogAtBySession.get(sessionId);
			if (
				lastLoggedAt === undefined ||
				now - lastLoggedAt >= SESSION_PROJECT_BINDING_FAILURE_LOG_INTERVAL_MS
			) {
				sessionProjectBindingFailureLogAtBySession.set(sessionId, now);
				sessionLog(
					sessionId,
					`project binding write failed harness=${getHarness()} cwd=${observedCwd ?? "unknown"} attempted=${projectIdentity}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			// Retry on the next observation; tracking a session is not proof of persistence.
		}
	}
	if (
		db &&
		persistedProjectIdentityBySession.get(sessionId) === projectIdentity &&
		sessionProjectBindingFailureLogAtBySession.delete(sessionId)
	) {
		sessionLog(
			sessionId,
			`project binding write recovered harness=${getHarness()} cwd=${observedCwd ?? "unknown"} identity=${projectIdentity}`,
		);
	}
	trackSessionForProject(projectIdentity, sessionId);
	lastSeenProjectIdentityBySession.set(sessionId, projectIdentity);
}

export function signalPiSystemPromptRefreshForProject(
	projectIdentity: string,
): void {
	const sessions = sessionsByProject.get(projectIdentity);
	if (!sessions) return;
	for (const sessionId of sessions) {
		systemPromptRefreshSessions.add(sessionId);
	}
}

export function recordPiLiveModel(
	sessionId: string,
	modelKey: string,
	assistantTimestamp?: number,
): boolean {
	if (
		typeof assistantTimestamp === "number" &&
		Number.isFinite(assistantTimestamp)
	) {
		const latestTimestamp =
			latestAssistantModelTimestampBySession.get(sessionId);
		// Pi may replay terminal events after a newer assistant has already finished.
		// Only the newest timestamp may move the model pin used by later context passes.
		if (latestTimestamp !== undefined && assistantTimestamp < latestTimestamp)
			return false;
		latestAssistantModelTimestampBySession.set(sessionId, assistantTimestamp);
	}
	liveModelBySession.set(sessionId, modelKey);
	return true;
}

function persistLastTransformErrorIfChanged(
	db: ContextDatabase,
	sessionId: string,
	summary: string,
	knownCurrent?: string | null,
): void {
	try {
		const current =
			knownCurrent === undefined
				? getOrCreateSessionMeta(db, sessionId).lastTransformError
				: knownCurrent;
		if (current !== summary) {
			updateSessionMeta(db, sessionId, { lastTransformError: summary });
		}
	} catch (err) {
		sessionLog(
			sessionId,
			`transform error persistence failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function clearLastTransformErrorIfSet(
	db: ContextDatabase,
	sessionId: string,
	knownCurrent?: string | null,
): void {
	try {
		const current =
			knownCurrent === undefined
				? getOrCreateSessionMeta(db, sessionId).lastTransformError
				: knownCurrent;
		if (current !== null) {
			updateSessionMeta(db, sessionId, { lastTransformError: null });
		}
	} catch (err) {
		sessionLog(
			sessionId,
			`transform error clear failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Read (without draining) the system-prompt refresh signal for a session.
 * The `before_agent_start` handler in `index.ts` calls this at the start
 * of each turn to decide whether adjuncts should refresh, then calls
 * `clearSystemPromptRefresh(...)` only after the rebuild work succeeds.
 */
export function hasSystemPromptRefresh(sessionId: string): boolean {
	return systemPromptRefreshSessions.has(sessionId);
}

/** Drain the system-prompt refresh signal. Called from
 *  `before_agent_start` after `processSystemPromptForCache(...)` succeeds. */
export function clearSystemPromptRefresh(sessionId: string): boolean {
	const wasSet = systemPromptRefreshSessions.has(sessionId);
	systemPromptRefreshSessions.delete(sessionId);
	return wasSet;
}

/** Read (without draining) the pending-materialization signal. The
 *  runPipeline call drains it. */
export function hasPendingMaterialization(sessionId: string): boolean {
	return pendingMaterializationSessions.has(sessionId);
}

/** Drain the pending-materialization signal. Called from runPipeline
 *  after pending-op materialization completes (or is skipped because
 *  this pass is `defer`). */
export function consumePendingMaterialization(sessionId: string): boolean {
	const wasSet = pendingMaterializationSessions.has(sessionId);
	clearPendingMaterialization(pendingMaterializationSessions, sessionId);
	return wasSet;
}

/**
 * Pi's full AgentMessage union (user | assistant | toolResult | custom).
 * Sourced from the live ContextEvent payload so the type stays in sync
 * with @earendil-works/pi-coding-agent without us re-declaring it.
 *
 * The nudge / note-nudge / auto-search helpers below operate on this
 * union but only inspect/mutate user and (rarely) assistant messages —
 * `toolResult` and `custom` flow through unchanged. Each helper guards
 * its mutations with role checks so the wider union is safe.
 */
type PiAgentMessage = ContextEvent["messages"][number];

/**
 * Optional historian config. When provided, the context handler checks
 * the compartment trigger after tagging and fires `runPiHistorian`
 * asynchronously (fire-and-forget) when the trigger says shouldFire.
 * When omitted, no historian invocation happens — useful for testing
 * the transform pipeline in isolation or running Pi without a
 * configured historian model.
 */
export interface PiHistorianOptions {
	/** SubagentRunner instance (PiSubagentRunner). */
	runner: SubagentRunner;
	/** Historian provider/model id (e.g. `anthropic/claude-haiku-4-5`). */
	model: string;
	/** Optional ordered fallback chain, retaining each entry's Pi thinking level. */
	fallbackModels?: readonly ModelInput[];
	/** Historian chunk budget derived from its context window. */
	historianChunkTokens: number;
	/** Known context limit for the resolved historian model. */
	historianContextLimit?: number;
	/** Optional per-call timeout (default 600s). */
	timeoutMs?: number;
	/** Provider sampling temperature; when omitted, uses the temperature configured for historian runs. */
	temperature?: number;
	/** Provider output budget; when omitted, uses the output-token budget configured for historian runs. */
	maxOutputTokens?: number;
	/** When true, run a second editor pass after a successful first pass to
	 *  clean low-signal U: lines and cross-compartment duplicates. Mirrors
	 *  OpenCode's `historian.two_pass` config. */
	twoPass?: boolean;
	expandTools?: Record<string, string | false>;
	/** Pi only: explicit thinking level for historian/compressor subagent
	 *  invocations (passed as --thinking <level>). When unset, Pi's own
	 *  default resolution applies. See `historian.thinking_level` in config. */
	thinkingLevel?: string;
	/** Cross-session memory feature gate (`memory.enabled`). */
	memoryEnabled?: boolean;
	/** Allow a session started exactly in the canonical home directory only when user-level configuration enables it. */
	allowHomeProject?: boolean;
	/** Automatic-promotion gate (`memory.auto_promote`). */
	autoPromote?: boolean;
	/** User-memory feature gate (`dreamer.user_memories.enabled`). Gates whether
	 *  historian user observations are persisted as candidates. */
	userMemoriesEnabled?: boolean;
	/** False when the dreamer is not runnable; the historian then skips user observations. */
	userObservationsRequested?: boolean;
	language?: string;
	/** Notify UI/status surfaces after historian state changes. */
	onStatusChange?: (ctx: ExtensionContext, sessionId: string) => void;
	/**
	 * Execute-threshold percentage used by the trigger logic to compute
	 * pressure-driven trigger points. Mirrors OpenCode's
	 * `execute_threshold_percentage` config; defaults to 65 when omitted.
	 */
	executeThresholdPercentage?:
		| number
		| { default: number; [modelKey: string]: number };
	/** Token-based execute-threshold overrides. Mirrors OpenCode `execute_threshold_tokens`. */
	executeThresholdTokens?: {
		default?: number;
		[modelKey: string]: number | undefined;
	};
	/** Commit-cluster trigger config. Mirrors OpenCode `commit_cluster_trigger`. */
	commitClusterTrigger?: { enabled: boolean; min_clusters: number };
	protectedTags?: number;
	clearReasoningAge?: number;
	keepReasoningTokens?: number | Record<string, number>;
	/** Fraction of executable context reserved for rendered <session-history>. */
	historyBudgetPercentage?: number;
}

/**
 * Optional auto-search hint config (Step 4b.4). When enabled, runs
 * `unifiedSearch` against new user prompts and appends a compact
 * vague-recall hint to the user message. Cross-harness coherent: hints
 * are computed against the same shared cortexkit DB OpenCode uses.
 */
export interface PiAutoSearchHandlerOptions {
	enabled: boolean;
	scoreThreshold: number;
	minPromptChars: number;
}

/** Heuristic-cleanup config — tiered emergency drop, dedup, strips system injections. */
export interface PiHeuristicsOptions {
	caveman?: {
		enabled: boolean;
		minChars: number;
		wordRules?: CavemanWordRules;
	};
	/**
	 * Number of tags before the most recent tag whose typed reasoning is
	 * cleared on cache-busting passes. Mirrors OpenCode's
	 * `clear_reasoning_age` config (`packages/plugin/src/config/schema/magic-context.ts:303`).
	 * Default `50` matches OpenCode. Pi previously hardcoded `30`, which
	 * cleared reasoning more aggressively than the user configured.
	 */
	clearReasoningAge?: number;
	keepReasoningTokens?: number | Record<string, number>;
}

/** <session-history> injection config — writes compartments+facts+memories into message[0]. */
export interface PiInjectionOptions {
	/** When false (config `memory.enabled=false`), project memories are NOT read
	 *  or rendered into m[0]/m[1]. Docs are controlled by injectDocs. */
	memoryEnabled?: boolean;
	/** Defaults true. When false, m[0] omits the <project-docs> block and docs hash. */
	injectDocs?: boolean;
	injectionBudgetTokens: number;
	temporalAwareness?: boolean;
	/** mural.enabled — when enabled, generate a deterministic image of memories that did not fit the context budget whenever the system performs a full (HARD) context fold. */
	muralEnabled?: boolean;
}

/** Scheduler config — gates cache-busting stages on TTL + threshold. */
export interface PiSchedulerOptions {
	executeThresholdPercentage:
		| number
		| { default: number; [modelKey: string]: number };
	executeThresholdTokens?: {
		default?: number;
		[modelKey: string]: number | undefined;
	};
}

export interface PiContextHandlerOptions {
	cacheTtlConfig?: import("@magic-context/core/shared/model-cache-ttl").CacheTtlConfig;
	cacheTtlConfigured?: boolean;
	db: ContextDatabase;
	/** Deprecated caller input, ignored. Supersession always rides an existing rebuild. */
	smartDrops?: boolean;
	protectedTools?: Readonly<Record<string, number>>;
	/**
	 * Heuristic-cleanup config (tiered emergency drop + caveman). When
	 * omitted, heuristic cleanup is disabled — tagging and queued-drop
	 * application still run, but the transform won't proactively shrink
	 * context. Use this only for tests; production always passes this.
	 */
	heuristics?: PiHeuristicsOptions;
	/**
	 * `<session-history>` injection config. When omitted, the prepared
	 * compartment/fact/memory block is NOT written into message[0].
	 * Production always passes this; tests can omit.
	 */
	injection?: PiInjectionOptions;
	/**
	 * Scheduler config — gates heuristic cleanup on TTL/threshold.
	 * When omitted, defaults to 65% threshold + 5m TTL behavior.
	 */
	scheduler?: PiSchedulerOptions;
	/**
	 * Number of most-recent tags treated as protected (mirrors OpenCode
	 * `protected_tags`). Drops with tag IDs in the protected window are
	 * deferred — `applyPendingOperations` requeues them as deferred so
	 * they re-evaluate next pass instead of being lost. Critical for
	 * keeping the agent's recent working context intact.
	 *
	 * Defaults from the schema to 20; can be 1-100. Optional so existing
	 * test fixtures don't need updating; callers in production (`index.ts`)
	 * always thread the loaded config value. A previous bug used a
	 * hardcoded `0` here — the council audit caught that recent turns
	 * were getting dropped mid-task.
	 */
	protectedTags?: number;
	/** Direct override for non-loader callers; production also passes tier provenance. */
	protectedTokens?: number;
	protectedTokenTierOverrides?: ProtectedTokensTierOverrides;
	language?: string;
	/**
	 * Optional historian wiring (Step 4b.3b). When omitted, the trigger
	 * check is skipped — context events still tag + drop normally, and
	 * historian state stays untouched. When provided, the trigger fires
	 * async after each tagging pass.
	 */
	historian?: PiHistorianOptions;
	/**
	 * Optional auto-search hint wiring (Step 4b.4). When omitted or
	 * disabled, no hint computation runs. Notes that auto-search shares
	 * the cortexkit DB with OpenCode, so memories ARE cross-harness.
	 */
	autoSearch?: PiAutoSearchHandlerOptions;
	/**
	 * Per-project config resolver (Pi `/cd` / multi-root). Pi can switch
	 * projects mid-process; a switched-into checkout may carry its own
	 * `.cortexkit/magic-context.jsonc` (different protected_tags, thresholds,
	 * memory/key-files toggles, historian model). Without this, every
	 * context pass after a switch would run with the LAUNCH project's
	 * settings (config bleed). When provided, the handler calls it once per
	 * pass with the current `ctx.cwd` and uses the returned options for that
	 * pass; the caller is expected to MEMOIZE per cwd so the hot path stays
	 * allocation-free after warmup. Returns the base options for the launch
	 * cwd. Tests omit it (the static options are used directly).
	 */
	resolveForProject?: (projectDir: string) => PiContextHandlerOptions;
	/** Whether the resolved Pi project config enables the todowrite tool. */
	todowriteEnabled?: boolean;
	/** Boot-resolved compaction-off flag. It remains fixed for this Pi process. */
	compactionOff?: boolean;
	/** Allow a session started exactly in the canonical home directory only when user-level configuration enables it. */
	allowHomeProject?: boolean;
	maybeAutoEmbedSession?: (
		sessionId: string,
		projectDir: string,
		projectIdentity: string,
	) => void;
}

/**
 * Resolve the active Pi session id for the given context. Pi's
 * ReadonlySessionManager exposes `getSessionId()` (the UUID written
 * into the session file's `SessionHeader`); that's stable across the
 * session's lifetime even when branches are navigated, and matches
 * what Pi itself uses internally to address the session. We prefer
 * the UUID over the file path because:
 *
 *   - It's invariant under file moves (forks create new files but
 *     keep the original session id semantics intact).
 *   - It's the same id Pi uses in its `session_switch` event, so
 *     downstream code can correlate events to magic-context state
 *     without re-deriving from paths.
 *
 * Returns undefined when no session is active — context events should
 * never fire in that state, but defending against it keeps the
 * transform fail-open if Pi's lifecycle changes in future versions.
 */
function resolveSessionId(ctx: ExtensionContext): string | undefined {
	const sm = ctx.sessionManager;
	if (sm === undefined) return undefined;
	const getSessionId = (sm as { getSessionId?: () => string | undefined })
		.getSessionId;
	if (typeof getSessionId !== "function") return undefined;
	try {
		const id = getSessionId.call(sm);
		if (typeof id !== "string" || id.length === 0) return undefined;
		return id;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the SessionEntry id for each AgentMessage in `event.messages`.
 *
 * Pi's runtime builds `event.messages` from `sessionManager.getBranch()`
 * by filtering to message-type entries (`type === "message"`) plus
 * synthetic compaction-summary / branch-summary messages. Magic Context
 * needs the underlying SessionEntry id for compartment boundary lookup
 * (historian writes `start_message_id`/`end_message_id` from
 * `read-session-pi.ts` → `RawMessage.id = entry.id`).
 *
 * We replicate the same filter here. Indexes that don't have a real
 * SessionEntry behind them (synthetic compaction summary at index 0
 * when Pi compaction has run; nothing else today) get `undefined` —
 * boundary lookup falls back to a synthesized id which is harmless
 * because no real boundary will ever match it.
 *
 * `expectedLength` is `event.messages.length`. If the resolved entry
 * count diverges from that (e.g. Pi inserted compaction summaries that
 * don't appear as `type==="message"` entries), we return `undefined`
 * — boundary lookup falls through to the synthesized fallback for
 * the whole pass. Better to skip the trim than trim the wrong slice.
 */
/**
 * Collect SessionEntry ids that align 1:1 with `event.messages` —
 * the same `AgentMessage[]` Pi's `buildSessionContext()` produces.
 *
 * Critical: `getBranch()` returns the entire path from leaf to root,
 * INCLUDING entries that pre-date the latest compaction. Filtering
 * `getBranch()` for `type === "message"` would yield a much larger
 * array than `event.messages`, breaking the index alignment that
 * `<session-history>` boundary trim relies on. We must replicate
 * `buildSessionContext`'s compaction-aware emission order so the
 * resulting `entryIds[]` lines up with `event.messages` exactly.
 *
 * Algorithm — mirrors @earendil-works/pi-coding-agent's
 * `buildSessionContext` implementation (see node_modules/.../core/
 * session-manager.js:108 and our copy of the algorithm in this repo's
 * earlier debug session for `ses_21cba3abaffenqSinaCFbAFF3E`):
 *
 *   1. Find the LATEST compaction entry on the branch (if any).
 *   2. If a compaction exists:
 *      - Emit `undefined` at index 0 for the synthetic compaction
 *        summary message (which has no SessionEntry id).
 *      - Skip every entry before `compaction.firstKeptEntryId`.
 *      - Then emit one id per entry from `firstKeptEntryId` up to
 *        (but not including) the compaction entry itself, plus every
 *        entry AFTER the compaction.
 *      - Each emitted id is the SessionEntry's id for `message` /
 *        `custom_message` / `branch_summary` (the three types that
 *        produce an AgentMessage); other types produce no message
 *        and are simply skipped.
 *   3. If no compaction exists: emit one id per emit-eligible entry
 *      across the full branch path, in path order.
 *
 * Returns `undefined` only when the SessionManager API is unavailable
 * or throws — those are real "we cannot determine alignment" cases.
 * When we successfully traverse the path, we ALWAYS return an array;
 * if the result length doesn't match `expectedLength` we log the
 * divergence (with diagnostics) and still return our best-effort
 * mapping rather than silently disabling the trim.
 */
function collectMessageEntryIds(
	ctx: ExtensionContext,
	expectedLength: number,
	sessionId?: string,
	strict = false,
): readonly (string | undefined)[] | undefined {
	const sm = ctx.sessionManager as
		| {
				getBranch?: (fromId?: string) => unknown[];
				getLeafId?: () => string | undefined;
		  }
		| undefined;
	if (typeof sm?.getBranch !== "function") return undefined;

	let entries: unknown[];
	try {
		entries = sm.getBranch.call(sm);
	} catch {
		return undefined;
	}
	if (!Array.isArray(entries)) return undefined;

	// Find the latest compaction entry (walk from end → start; same
	// algorithm Pi's getLatestCompactionEntry uses).
	let compactionIndex = -1;
	let firstKeptEntryId: string | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as {
			type?: unknown;
			firstKeptEntryId?: unknown;
		} | null;
		if (e && typeof e === "object" && e.type === "compaction") {
			compactionIndex = i;
			if (typeof e.firstKeptEntryId === "string") {
				firstKeptEntryId = e.firstKeptEntryId;
			}
			break;
		}
	}

	const ids: (string | undefined)[] = [];

	// Helper: is this entry type one that produces an AgentMessage in
	// buildSessionContext? Same three types: message, custom_message,
	// branch_summary (the latter only when summary is set). Note that
	// branch_summary entries with `summary === undefined` are skipped
	// by buildSessionContext but we accept all branch_summary entries
	// here for robustness — the worst case is we emit an extra id that
	// never matches a compartment boundary, which is harmless.
	const isEmitEligible = (entry: unknown): entry is { id: string } => {
		if (!entry || typeof entry !== "object") return false;
		const t = (entry as { type?: unknown }).type;
		const id = (entry as { id?: unknown }).id;
		if (typeof id !== "string") return false;
		if (t === "message") return true;
		if (t === "custom_message") return true;
		if (t === "branch_summary") {
			const summary = (entry as { summary?: unknown }).summary;
			return typeof summary === "string" && summary.length > 0;
		}
		return false;
	};

	if (compactionIndex >= 0) {
		const hasSystemSnapshot = isPiSystemEntry(
			(entries[compactionIndex] as { systemMessage?: unknown }).systemMessage,
		);
		if (hasSystemSnapshot) ids.push(undefined);
		// The synthetic summary has no SessionEntry id.
		ids.push(undefined);

		// Pre-compaction: emit ids from firstKeptEntryId (inclusive) up to
		// compactionIndex (exclusive). If firstKeptEntryId is undefined or
		// not found, emit nothing for the pre-compaction window (that's
		// what buildSessionContext does).
		if (firstKeptEntryId !== undefined) {
			let foundFirstKept = false;
			for (let i = 0; i < compactionIndex; i++) {
				const entry = entries[i];
				const entryId = (entry as { id?: unknown } | null)?.id;
				if (typeof entryId === "string" && entryId === firstKeptEntryId) {
					foundFirstKept = true;
				}
				if (
					!foundFirstKept ||
					(hasSystemSnapshot && isPiSystemMessageEntry(entry))
				)
					continue;
				if (isEmitEligible(entry)) {
					ids.push(entry.id);
				}
			}
		}

		// Post-compaction: emit ids for every emit-eligible entry after
		// the compaction marker.
		for (let i = compactionIndex + 1; i < entries.length; i++) {
			const entry = entries[i];
			if (isEmitEligible(entry)) {
				ids.push(entry.id);
			}
		}
	} else {
		// No compaction — emit one id per emit-eligible entry across the
		// full path.
		for (const entry of entries) {
			if (isEmitEligible(entry)) {
				ids.push(entry.id);
			}
		}
	}

	// Length mismatch is a real bug somewhere (probably a SessionEntry
	// type we're not handling correctly), but we still return our best
	// guess so the trim is robust. Log so future divergence shows up.
	if (ids.length !== expectedLength) {
		const sm2 = sm as {
			getBranch?: (fromId?: string) => unknown[];
		};
		const totalEntries = entries.length;
		log(
			`[magic-context][pi]${sessionId ? `[${sessionId}]` : ""} collectMessageEntryIds length mismatch: ` +
				`expected=${expectedLength} got=${ids.length} (compactionIndex=${compactionIndex} ` +
				`firstKeptEntryId=${firstKeptEntryId ?? "<none>"} totalBranchEntries=${totalEntries})` +
				` — best-effort mapping returned; boundary trim may not match exactly`,
		);
		if (strict) return undefined;
		// Defensively fall back: if we have FEWER ids than expected, pad
		// with undefined at the front (covers historical compaction-summary
		// cases where Pi prepended a synthetic message we missed). If we
		// have MORE ids than expected, slice from the END (post-compaction
		// matters most for boundary lookup).
		const _unused = sm2; // satisfy lint about unused alias above
		void _unused;
		if (ids.length < expectedLength) {
			const padded: (string | undefined)[] = [];
			for (let i = 0; i < expectedLength - ids.length; i++) {
				padded.push(undefined);
			}
			padded.push(...ids);
			return padded;
		}
		// ids.length > expectedLength — slice from the end (the most
		// recent entries are the ones we need for boundary lookup).
		return ids.slice(ids.length - expectedLength);
	}

	return ids;
}

export function collectMessageEntryIdsStrict(
	ctx: ExtensionContext,
	expectedLength: number,
	sessionId?: string,
): readonly (string | undefined)[] | null {
	try {
		return collectMessageEntryIds(ctx, expectedLength, sessionId, true) ?? null;
	} catch (error) {
		sessionLog(
			sessionId ?? "pi",
			`collectMessageEntryIdsStrict failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

/**
 * Resolve each context message to a real SessionEntry id without assuming the
 * context and branch arrays have identical positions. Pi clones context messages
 * before extension handlers run, so production alignment uses stable content
 * fingerprints cached with the session's branch projection. Reference matching
 * remains as a compatibility path for test doubles and older runtimes.
 *
 * Ambiguous fingerprints intentionally remain unresolved rather than risking a
 * wrong durable boundary. Custom and branch-summary wrappers also remain
 * unresolved because Pi synthesizes them for each context event and historian
 * boundaries only target ordinary message entries.
 */
export function collectMessageEntryIdsByRef(
	ctx: ExtensionContext,
	messages: readonly PiAgentMessage[],
	sessionId?: string,
	preloadedBranchEntries?: readonly unknown[],
): readonly (string | undefined)[] | null {
	let entries: readonly unknown[];
	if (preloadedBranchEntries !== undefined) {
		entries = preloadedBranchEntries;
	} else {
		const sm = ctx.sessionManager as
			| {
					getBranch?: (fromId?: string) => unknown[];
			  }
			| undefined;
		if (typeof sm?.getBranch !== "function") return null;

		try {
			const branch = sm.getBranch.call(sm);
			if (!Array.isArray(branch)) return null;
			entries = branch;
		} catch (error) {
			sessionLog(
				sessionId ?? "pi",
				`collectMessageEntryIdsByRef getBranch failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	}

	// SessionManager clones context messages before this handler runs, so the
	// fingerprint index is the production alignment path. The reference index is
	// retained for test doubles and older Pi runtimes that do not clone.
	const { entryIdByMessageRef, entryIdsByFingerprint, entryIdsByToolIdentity } =
		getPiBranchEntryLookup(entries);

	const result: (string | undefined)[] = new Array(messages.length);
	let resolved = 0;
	let fingerprintResolved = 0;
	const consumedFingerprintIds = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg || typeof msg !== "object") {
			result[i] = undefined;
			continue;
		}
		const id = entryIdByMessageRef.get(msg as object);
		if (typeof id === "string") {
			result[i] = id;
			resolved += 1;
			continue;
		}
		const fingerprint = piMessageEntryFingerprint(msg);
		const toolIdentity = piAssistantToolIdentity(msg);
		const fingerprintBucket =
			(fingerprint ? entryIdsByFingerprint.get(fingerprint) : undefined) ??
			(toolIdentity ? entryIdsByToolIdentity.get(toolIdentity) : undefined);
		// A fingerprint is only a safe fallback when it uniquely identifies a
		// branch entry. Repeated/cloned messages can share timestamp/role/text;
		// consuming the "next" bucket item would silently anchor to the wrong
		// SessionEntry after one clone is dropped or reordered.
		const fingerprintId =
			fingerprintBucket?.length === 1 &&
			!consumedFingerprintIds.has(fingerprintBucket[0] as string)
				? fingerprintBucket[0]
				: undefined;
		if (typeof fingerprintId === "string") {
			consumedFingerprintIds.add(fingerprintId);
			result[i] = fingerprintId;
			resolved += 1;
			fingerprintResolved += 1;
		} else {
			result[i] = undefined;
		}
	}

	// One-shot diagnostic: log a coverage summary so we can see how often
	// the new resolver finds real ids vs. falls back. This replaces the
	// "length mismatch" log line that `collectMessageEntryIds` used to
	// emit — that log was misleading because the position-based walk
	// reported divergence even when the underlying refs were fine.
	if (resolved < messages.length) {
		log(
			`[magic-context][pi]${sessionId ? `[${sessionId}]` : ""} ` +
				`collectMessageEntryIdsByRef: resolved=${resolved}/${messages.length} ` +
				`(fingerprint=${fingerprintResolved}, branchEntries=${entries.length}, messageEntries=${entryIdByMessageRef.size}) — ` +
				`unmapped slots fall through to synthesized ids; boundary lookup still works ` +
				`for any compartment whose start/end message is among the resolved set`,
		);
	}

	return result;
}

function piContextHeaderFields(message: unknown): {
	responseId: string | null;
	timestamp: number | string | null;
	role: string;
	toolCallId: string | null;
} | null {
	if (!message || typeof message !== "object") return null;
	const record = message as {
		responseId?: unknown;
		timestamp?: unknown;
		role?: unknown;
		toolCallId?: unknown;
	};
	if (typeof record.role !== "string") return null;
	return {
		responseId:
			typeof record.responseId === "string" ? record.responseId : null,
		timestamp:
			typeof record.timestamp === "number" ||
			typeof record.timestamp === "string"
				? record.timestamp
				: null,
		role: record.role,
		toolCallId:
			typeof record.toolCallId === "string" ? record.toolCallId : null,
	};
}

/**
 * Header of the context message Pi derives from an emitted entry. Custom
 * messages and branch summaries are built by createCustomMessage and
 * createBranchSummaryMessage, which stamp `new Date(entry.timestamp).getTime()`.
 */
function piAlignmentCheckForEntry(entry: unknown): PiAlignmentCheck | null {
	if (!isPiContextEmitEligible(entry)) return null;
	const row = entry as unknown as PiAlignmentCheck["entry"] & {
		timestamp?: unknown;
	};
	const header =
		row.type === "message"
			? piContextHeaderFields(row.message)
			: {
					responseId: null,
					timestamp: new Date(row.timestamp as string).getTime(),
					role: row.type === "custom_message" ? "custom" : "branchSummary",
					toolCallId: null,
				};
	if (!header) return null;
	return {
		...header,
		headerKey: JSON.stringify([
			header.responseId,
			header.timestamp,
			header.role,
			header.toolCallId,
		]),
		entry: row,
	};
}

/**
 * Whether a context message carries the content of the entry it was aligned
 * to. Used only where the header cannot tell entries apart, because it reads
 * (and, for messages, hashes) the content.
 */
function piAlignedContentMatches(
	check: PiAlignmentCheck,
	message: unknown,
): boolean {
	const entry = check.entry;
	if (entry.type === "branch_summary") {
		const summary = message as { summary?: unknown; fromId?: unknown };
		return summary.summary === entry.summary && summary.fromId === entry.fromId;
	}
	if (entry.type === "custom_message") {
		const custom = message as { customType?: unknown };
		if (custom.customType !== entry.customType) return false;
	}
	if (check.fingerprint === undefined) {
		check.fingerprint =
			entry.type === "message"
				? piMessageEntryFingerprint(entry.message)
				: piMessageEntryFingerprint({
						role: check.role,
						timestamp: check.timestamp,
						content: entry.content ?? [],
					});
	}
	return (
		check.fingerprint !== null &&
		piMessageEntryFingerprint(message) === check.fingerprint
	);
}

/**
 * Index of the first event message that does not match the entry its
 * position assigns, or -1 when every position matches. An extension earlier
 * in Pi's context chain can replace or reorder messages without changing the
 * count; trusting positions then would give a message another entry's id.
 * Each position compares the header fields; only entries whose header another
 * emitted entry shares (two messages stamped in the same millisecond, for
 * example) also compare content, since a swap of those keeps every header.
 */
function findPiAlignmentMismatch(
	lookup: PiBranchEntryLookup,
	entryIds: readonly (string | undefined)[],
	messages: readonly unknown[],
): number {
	for (let index = 0; index < entryIds.length; index += 1) {
		const id = entryIds[index];
		// Slots Pi fills without an entry (the compaction summary and its system
		// snapshot) stay unresolved either way.
		if (id === undefined) continue;
		if (!piAlignedPositionMatches(lookup, id, messages[index])) return index;
	}
	return -1;
}

/** One position of findPiAlignmentMismatch: header, plus content where shared. */
function piAlignedPositionMatches(
	lookup: PiBranchEntryLookup,
	id: string,
	message: unknown,
): boolean {
	const check = lookup.alignmentChecks.get(id);
	const header = piContextHeaderFields(message);
	if (
		!check ||
		!header ||
		header.role !== check.role ||
		!Object.is(header.timestamp, check.timestamp) ||
		header.responseId !== check.responseId ||
		header.toolCallId !== check.toolCallId
	)
		return false;
	return (
		(lookup.alignmentHeaderCounts.get(check.headerKey) ?? 0) <= 1 ||
		piAlignedContentMatches(check, message)
	);
}

/**
 * Entry ids for an event that cannot be aligned position by position, for
 * example because another extension added a message or Pi left one out.
 *
 * Messages whose header belongs to exactly one emitted entry are anchors.
 * Anchors must appear in projection order and each entry at most once;
 * otherwise this returns null and the caller matches every message by content
 * fingerprint instead. Between consecutive anchors (and before the first and
 * after the last), a run of messages as long as the projected run it faces
 * is aligned position by position, each position passing the same check as
 * the positional lane. That keeps the real ids of messages only their
 * position can identify, such as identical text sent twice in one
 * millisecond, so a pass on this lane tags them exactly as an aligned pass
 * does. Messages still unresolved are then matched one by one by content
 * fingerprint, as in collectMessageEntryIdsByRef.
 */
function anchorPiEventEntryIds(
	lookup: PiBranchEntryLookup,
	aligned: readonly (string | undefined)[],
	messages: readonly unknown[],
): (string | undefined)[] | null {
	const projectionIndex = new Map<string, number>();
	for (let index = 0; index < aligned.length; index += 1) {
		const id = aligned[index];
		if (id !== undefined) projectionIndex.set(id, index);
	}
	const result: (string | undefined)[] = new Array(messages.length).fill(
		undefined,
	);
	const used = new Set<string>();
	const anchors: { message: number; projection: number }[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const header = piContextHeaderFields(messages[index]);
		if (!header) continue;
		const key = JSON.stringify([
			header.responseId,
			header.timestamp,
			header.role,
			header.toolCallId,
		]);
		if (lookup.alignmentHeaderCounts.get(key) !== 1) continue;
		const id = lookup.alignmentEntryIdByHeader.get(key);
		const position = id === undefined ? undefined : projectionIndex.get(id);
		if (id === undefined || position === undefined) continue;
		const previous = anchors.at(-1);
		if (used.has(id) || (previous && position <= previous.projection))
			return null;
		anchors.push({ message: index, projection: position });
		used.add(id);
		result[index] = id;
	}
	const fillRun = (
		messageStart: number,
		messageEnd: number,
		projectionStart: number,
		projectionEnd: number,
	) => {
		if (messageEnd - messageStart !== projectionEnd - projectionStart) return;
		for (let offset = 0; offset < messageEnd - messageStart; offset += 1) {
			const id = aligned[projectionStart + offset];
			const message = messages[messageStart + offset];
			if (
				id !== undefined &&
				!used.has(id) &&
				piAlignedPositionMatches(lookup, id, message)
			) {
				result[messageStart + offset] = id;
				used.add(id);
			}
		}
	};
	let previousMessage = -1;
	let previousProjection = -1;
	for (const anchor of anchors) {
		fillRun(
			previousMessage + 1,
			anchor.message,
			previousProjection + 1,
			anchor.projection,
		);
		previousMessage = anchor.message;
		previousProjection = anchor.projection;
	}
	fillRun(
		previousMessage + 1,
		messages.length,
		previousProjection + 1,
		aligned.length,
	);
	for (let index = 0; index < messages.length; index += 1) {
		if (result[index] !== undefined) continue;
		const message = messages[index];
		if (!message || typeof message !== "object") continue;
		const byRef = lookup.entryIdByMessageRef.get(message);
		if (byRef !== undefined && !used.has(byRef)) {
			result[index] = byRef;
			used.add(byRef);
			continue;
		}
		const fingerprint = piMessageEntryFingerprint(message);
		const bucket = fingerprint
			? lookup.entryIdsByFingerprint.get(fingerprint)
			: undefined;
		// Same rule as collectMessageEntryIdsByRef: only a fingerprint that names
		// exactly one entry, and only once.
		const id = bucket?.length === 1 ? bucket[0] : undefined;
		if (id !== undefined && !used.has(id)) {
			result[index] = id;
			used.add(id);
		}
	}
	return result;
}

const piAlignmentMismatchLoggedSessions = new Set<string>();

// Passes that could not use the positional lane, by the lane that resolved
// them. Read only by tests that check which lane a pass took.
const piEntryAlignmentLaneCounts = { anchored: 0, fingerprint: 0 };

/**
 * Entry id for each event message. Pi builds the context from the branch
 * projection, so an event with the projection's length normally lines up
 * position by position; that lane is used only after every position passes
 * findPiAlignmentMismatch. Otherwise anchorPiEventEntryIds aligns the runs
 * between messages it can identify by header, and only if those anchors are
 * out of order is every message matched by content fingerprint in
 * collectMessageEntryIdsByRef, leaving ambiguous ones unresolved.
 */
function resolvePiEventEntryIds(
	ctx: ExtensionContext,
	messages: readonly PiAgentMessage[],
	sessionId: string,
	branchEntries: readonly unknown[] | null,
): readonly (string | undefined)[] | null {
	if (branchEntries === null) return null;
	const lookup = getPiBranchEntryLookup(branchEntries);
	// Pi 0.87+ never shows system messages to `context` handlers, so an event
	// without any must be aligned against the projection without them.
	// Otherwise every pass of a session that persisted a system entry misses
	// this lane and hashes every message in the fallback below.
	const aligned = (messages as readonly unknown[]).some(isPiSystemEntry)
		? lookup.alignedEntryIds
		: lookup.alignedVisibleEntryIds;
	if (aligned.length === messages.length) {
		const mismatch = findPiAlignmentMismatch(lookup, aligned, messages);
		if (mismatch < 0) return aligned;
		if (!piAlignmentMismatchLoggedSessions.has(sessionId)) {
			piAlignmentMismatchLoggedSessions.add(sessionId);
			sessionLog(
				sessionId,
				`pi entry alignment: message ${mismatch} of ${messages.length} does not match its projected entry; resolving ids by content fingerprint (logged once per session)`,
			);
		}
	}
	const anchored = anchorPiEventEntryIds(lookup, aligned, messages);
	if (anchored) {
		piEntryAlignmentLaneCounts.anchored += 1;
		return restorePiRetainedEntryIds(
			sessionId,
			branchEntries,
			anchored,
			messages,
		);
	}
	piEntryAlignmentLaneCounts.fingerprint += 1;
	return restorePiRetainedEntryIds(
		sessionId,
		branchEntries,
		fillPiEntryIdsByUniqueHeader(
			lookup,
			collectMessageEntryIdsByRef(ctx, messages, sessionId, branchEntries),
			messages,
		),
		messages,
	);
}

/**
 * Oh My Pi can retain older raw messages in its context event after native
 * compaction removes their entries from the branch APIs. Remember ids tagged
 * on the previous successful pass, matching only when the response id,
 * timestamp, role and tool call id name exactly one entry AND exactly one
 * message in this event, and the entry has not been used by another message.
 * Uniqueness on the entry side alone is not enough: a header unique last pass
 * can now describe two event messages, and giving the old id to either one
 * would replay the old message's drop onto the wrong message. Otherwise saved
 * text drops lose their emergency targets.
 */
function restorePiRetainedEntryIds(
	sessionId: string,
	branchEntries: readonly unknown[],
	resolved: readonly (string | undefined)[] | null,
	messages: readonly unknown[],
): readonly (string | undefined)[] | null {
	if (!resolved?.includes(undefined)) return resolved;
	const previous = taggedEntryHeadersBySession.get(sessionId);
	if (!previous?.size) return resolved;
	const headers = new Map(previous);
	for (const [id, check] of getPiBranchEntryLookup(branchEntries)
		.alignmentChecks) {
		headers.set(id, check.headerKey);
	}
	const owners = new Map<string, string[]>();
	for (const [id, header] of headers) {
		const bucket = owners.get(header) ?? [];
		bucket.push(id);
		owners.set(header, bucket);
	}
	// Count every message in the event, resolved or not, so a header shared
	// with any other message in this pass is treated as ambiguous.
	const eventKeys = messages.map((message) => {
		const header = piContextHeaderFields(message);
		return header
			? JSON.stringify([
					header.responseId,
					header.timestamp,
					header.role,
					header.toolCallId,
				])
			: undefined;
	});
	const eventCounts = new Map<string, number>();
	for (const key of eventKeys) {
		if (key !== undefined)
			eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
	}
	const result = [...resolved];
	const used = new Set(result.filter((id) => id !== undefined));
	for (let index = 0; index < messages.length; index++) {
		if (result[index] !== undefined) continue;
		const key = eventKeys[index];
		if (key === undefined || eventCounts.get(key) !== 1) continue;
		const bucket = owners.get(key);
		const id = bucket?.length === 1 ? bucket[0] : undefined;
		if (id === undefined || used.has(id)) continue;
		result[index] = id;
		used.add(id);
	}
	return result;
}

/**
 * Give a message the fingerprint lane left unresolved the entry its header
 * names, when exactly one emitted entry carries that header and no other
 * message of this pass already took it.
 *
 * The positional and anchored lanes identify such a message by this same
 * header, so a pass on one of those lanes tags it under that entry even when
 * its event content differs from the persisted entry (an extension or host
 * rewrite). The fingerprint lane runs only because the anchors were out of
 * order, which says nothing about a header that names a single entry. Without
 * this, the same message switched to a temporary id whenever a pass fell to
 * the fingerprint lane and lost the number it was served with.
 */
function fillPiEntryIdsByUniqueHeader(
	lookup: PiBranchEntryLookup,
	resolved: readonly (string | undefined)[] | null,
	messages: readonly unknown[],
): readonly (string | undefined)[] | null {
	if (!resolved?.includes(undefined)) return resolved;
	const result = [...resolved];
	const used = new Set(result.filter((id) => id !== undefined));
	for (let index = 0; index < messages.length; index += 1) {
		if (result[index] !== undefined) continue;
		const header = piContextHeaderFields(messages[index]);
		if (!header) continue;
		const key = JSON.stringify([
			header.responseId,
			header.timestamp,
			header.role,
			header.toolCallId,
		]);
		if (lookup.alignmentHeaderCounts.get(key) !== 1) continue;
		const id = lookup.alignmentEntryIdByHeader.get(key);
		if (id === undefined || used.has(id)) continue;
		result[index] = id;
		used.add(id);
	}
	return result;
}

function addPiBranchEntryToLookup(
	lookup: PiBranchEntryLookup,
	entry: unknown,
): void {
	if (!entry || typeof entry !== "object") return;
	const check = piAlignmentCheckForEntry(entry);
	if (check) {
		lookup.alignmentChecks.set((entry as { id: string }).id, check);
		lookup.alignmentEntryIdByHeader.set(
			check.headerKey,
			(entry as { id: string }).id,
		);
		lookup.alignmentHeaderCounts.set(
			check.headerKey,
			(lookup.alignmentHeaderCounts.get(check.headerKey) ?? 0) + 1,
		);
	}
	const row = entry as { type?: unknown; id?: unknown; message?: unknown };
	if (
		row.type !== "message" ||
		typeof row.id !== "string" ||
		!row.message ||
		typeof row.message !== "object"
	) {
		return;
	}
	lookup.entryIdByMessageRef.set(row.message as object, row.id);
	const toolIdentity = piAssistantToolIdentity(row.message);
	if (toolIdentity) {
		const owners = lookup.entryIdsByToolIdentity.get(toolIdentity);
		if (owners) owners.push(row.id);
		else lookup.entryIdsByToolIdentity.set(toolIdentity, [row.id]);
	}
	const fingerprint = piMessageEntryFingerprint(row.message);
	if (check) check.fingerprint = fingerprint;
	if (!fingerprint) return;
	const bucket = lookup.entryIdsByFingerprint.get(fingerprint);
	if (bucket) bucket.push(row.id);
	else lookup.entryIdsByFingerprint.set(fingerprint, [row.id]);
}

function isPiContextEmitEligible(entry: unknown): entry is { id: string } {
	if (!entry || typeof entry !== "object") return false;
	const row = entry as { type?: unknown; id?: unknown; summary?: unknown };
	if (typeof row.id !== "string") return false;
	return (
		row.type === "message" ||
		row.type === "custom_message" ||
		(row.type === "branch_summary" &&
			typeof row.summary === "string" &&
			row.summary.length > 0)
	);
}

function buildPiAlignedEntryIds(entries: readonly unknown[]): {
	all: (string | undefined)[];
	visible: (string | undefined)[];
} {
	const all = buildPiAlignedEntryIdsIncludingSystem(entries);
	return { all, visible: buildPiAlignedVisibleEntryIds(entries) };
}

/**
 * Entry ids for the messages a Pi 0.87+ `context` handler receives: the
 * compaction-aware projection with every system-role message removed. The
 * compaction summary keeps its unresolved slot; its system snapshot does not.
 *
 * Pi 0.87.1 also applies `context_edit` entries found in that projection
 * (session-manager.js buildSessionProjection): the last edit for a target
 * wins, and a null replacement drops the target's messages. Pi appends such an
 * omission before every automatic retry and overflow recovery, so ignoring it
 * leaves this list one longer than the event until the next compaction.
 */
function buildPiAlignedVisibleEntryIds(
	entries: readonly unknown[],
): (string | undefined)[] {
	let compactionIndex = -1;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (
			(entries[index] as { type?: unknown } | undefined)?.type === "compaction"
		) {
			compactionIndex = index;
			break;
		}
	}
	// The entries Pi projects, in order (buildContextEntries).
	const context: unknown[] = [];
	if (compactionIndex >= 0) {
		const compaction = entries[compactionIndex];
		context.push(compaction);
		const firstKeptEntryId = (compaction as { firstKeptEntryId?: unknown })
			.firstKeptEntryId;
		let foundFirstKept = false;
		for (let index = 0; index < compactionIndex; index += 1) {
			const entry = entries[index];
			if (
				typeof firstKeptEntryId === "string" &&
				(entry as { id?: unknown } | undefined)?.id === firstKeptEntryId
			) {
				foundFirstKept = true;
			}
			if (foundFirstKept) context.push(entry);
		}
	}
	for (let index = compactionIndex + 1; index < entries.length; index += 1) {
		context.push(entries[index]);
	}
	const omitted = new Map<string, boolean>();
	for (const entry of context) {
		const edit = entry as
			| { type?: unknown; targetId?: unknown; replacement?: unknown }
			| undefined;
		if (edit?.type !== "context_edit" || typeof edit.targetId !== "string")
			continue;
		omitted.set(edit.targetId, edit.replacement === null);
	}
	const ids: (string | undefined)[] = [];
	if (compactionIndex >= 0) {
		const compactionId = (entries[compactionIndex] as { id?: unknown }).id;
		if (typeof compactionId !== "string" || omitted.get(compactionId) !== true)
			ids.push(undefined);
	}
	for (
		let index = compactionIndex >= 0 ? 1 : 0;
		index < context.length;
		index += 1
	) {
		const entry = context[index];
		if (
			isPiContextEmitEligible(entry) &&
			!isPiSystemMessageEntry(entry) &&
			omitted.get(entry.id) !== true
		)
			ids.push(entry.id);
	}
	return ids;
}

function buildPiAlignedEntryIdsIncludingSystem(
	entries: readonly unknown[],
): (string | undefined)[] {
	let compactionIndex = -1;
	let firstKeptEntryId: string | undefined;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const row = entries[index] as
			| { type?: unknown; firstKeptEntryId?: unknown }
			| undefined;
		if (row?.type !== "compaction") continue;
		compactionIndex = index;
		firstKeptEntryId =
			typeof row.firstKeptEntryId === "string"
				? row.firstKeptEntryId
				: undefined;
		break;
	}
	if (compactionIndex < 0) {
		return entries.filter(isPiContextEmitEligible).map((entry) => entry.id);
	}

	const compaction = entries[compactionIndex] as { systemMessage?: unknown };
	const hasSystemSnapshot = isPiSystemEntry(compaction.systemMessage);
	const ids: (string | undefined)[] = hasSystemSnapshot
		? [undefined, undefined]
		: [undefined];
	if (firstKeptEntryId !== undefined) {
		let foundFirstKept = false;
		for (let index = 0; index < compactionIndex; index += 1) {
			const entry = entries[index];
			if ((entry as { id?: unknown } | undefined)?.id === firstKeptEntryId) {
				foundFirstKept = true;
			}
			if (
				foundFirstKept &&
				isPiContextEmitEligible(entry) &&
				!(hasSystemSnapshot && isPiSystemMessageEntry(entry))
			)
				ids.push(entry.id);
		}
	}
	for (let index = compactionIndex + 1; index < entries.length; index += 1) {
		const entry = entries[index];
		if (isPiContextEmitEligible(entry)) ids.push(entry.id);
	}
	return ids;
}

// The injected history users already contain the compartment summaries.
// Calling appendCompaction makes Pi add the same summary during the next projection,
// changing bytes sent to the provider one pass after cache invalidation. Remove it
// only when the branch entry proves this plugin created the matching compaction.
function stripMcOwnedPiCompactionSummary(
	messages: PiAgentMessage[],
	entryIds: (string | undefined)[],
	branchEntries: readonly unknown[],
): boolean {
	const summaryIndex = isPiSystemEntry(messages[0]) ? 1 : 0;
	const summaryMessage = messages[summaryIndex] as
		| { role?: unknown; summary?: unknown; tokensBefore?: unknown }
		| undefined;
	if (summaryMessage?.role !== "compactionSummary") return false;

	let compaction:
		| {
				type?: unknown;
				summary?: unknown;
				tokensBefore?: unknown;
				fromHook?: unknown;
				/** OMP records the hook origin here instead of `fromHook`. */
				fromExtension?: unknown;
				details?: unknown;
		  }
		| undefined;
	for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
		const entry = branchEntries[index] as typeof compaction;
		if (entry?.type === "compaction") {
			compaction = entry;
			break;
		}
	}
	if (compaction?.fromHook !== true && compaction?.fromExtension !== true) {
		return false;
	}
	const details = compaction.details as { source?: unknown } | undefined;
	if (details?.source !== "magic-context") return false;
	if (
		summaryMessage.summary !== compaction.summary ||
		summaryMessage.tokensBefore !== compaction.tokensBefore ||
		entryIds[summaryIndex] !== undefined
	) {
		return false;
	}

	messages.splice(summaryIndex, 1);
	entryIds.splice(summaryIndex, 1);
	return true;
}

function getPiBranchEntryLookup(
	entries: readonly unknown[],
): PiBranchEntryLookup {
	const cached = piBranchLookupByProjection.get(entries);
	if (cached) return cached;
	const aligned = buildPiAlignedEntryIds(entries);
	const lookup: PiBranchEntryLookup = {
		entryIdByMessageRef: new Map(),
		entryIdsByFingerprint: new Map(),
		alignedEntryIds: aligned.all,
		alignedVisibleEntryIds: aligned.visible,
		alignmentChecks: new Map(),
		alignmentHeaderCounts: new Map(),
		alignmentEntryIdByHeader: new Map(),
		entryIdsByToolIdentity: new Map(),
	};
	// SessionManager.getBranch() still includes messages cut by compaction.
	// alignedEntryIds names only entries that Pi emits in the retained context;
	// indexing older copies would make an identical retained message ambiguous.
	const visibleIds = new Set(lookup.alignedEntryIds);
	for (const entry of entries) {
		if (visibleIds.has((entry as { id?: string } | null)?.id))
			addPiBranchEntryToLookup(lookup, entry);
	}
	piBranchLookupByProjection.set(entries, lookup);
	return lookup;
}

/**
 * Build a `Map<AgentMessage-ref, SessionEntry.id>` from branch entries.
 *
 * Same source-of-truth as `collectMessageEntryIdsByRef` (the message-typed
 * branch entries), but keyed by object identity instead of collapsed to a
 * positional array. This is the splice-safe map threaded to post-mutation
 * consumers (sticky reminders, note nudges, auto-search) so they resolve the
 * CURRENT message's entry id by reference rather than by a stale index. Only the
 * lossless reference path is included — the fingerprint fallback in
 * `collectMessageEntryIdsByRef` is position/consumption-ordered and not safe to
 * reuse out of order, so unmapped messages simply fall through (anchor defers).
 */
function buildEntryIdByRefMap(
	branchEntries: readonly unknown[] | null,
): Map<object, string> {
	return branchEntries
		? getPiBranchEntryLookup(branchEntries).entryIdByMessageRef
		: new Map();
}

function readPiBranchEntriesForContext(
	ctx: ExtensionContext,
	sessionId: string,
): readonly unknown[] | null {
	const sm = ctx.sessionManager as
		| {
				getLeafId?: () => string | null;
				getEntry?: (id: string) => unknown;
				getBranch?: (fromId?: string) => unknown[];
		  }
		| undefined;

	const installProjection = (
		leafId: string,
		entries: readonly unknown[],
	): readonly unknown[] => {
		const indexById = new Map<string, number>();
		const lookup = getPiBranchEntryLookup(entries);
		for (let index = 0; index < entries.length; index += 1) {
			const entry = entries[index];
			if (entry && typeof entry === "object") {
				const id = (entry as { id?: unknown }).id;
				if (typeof id === "string") indexById.set(id, index);
			}
		}
		const projection = { leafId, entries, indexById, lookup };
		piBranchProjectionBySession.set(sessionId, projection);
		piBranchLookupByProjection.set(entries, lookup);
		return entries;
	};

	const fallbackToBranch = (): readonly unknown[] | null => {
		if (typeof sm?.getBranch !== "function") return null;
		const entries = sm.getBranch.call(sm);
		if (!Array.isArray(entries)) return null;
		const leafId =
			typeof (entries.at(-1) as { id?: unknown } | undefined)?.id === "string"
				? ((entries.at(-1) as { id: string }).id ?? "")
				: "";
		return leafId ? installProjection(leafId, entries) : entries;
	};

	try {
		if (
			typeof sm?.getLeafId !== "function" ||
			typeof sm.getEntry !== "function"
		) {
			return fallbackToBranch();
		}
		const leafId = sm.getLeafId.call(sm);
		if (leafId === null) return [];
		if (typeof leafId !== "string" || leafId.length === 0) {
			return fallbackToBranch();
		}

		const cached = piBranchProjectionBySession.get(sessionId);
		if (cached?.leafId === leafId) return cached.entries;

		const suffix: unknown[] = [];
		const seen = new Set<string>();
		let cursor: string | null = leafId;
		let cachedAncestorIndex: number | undefined;
		while (cursor !== null) {
			const priorIndex = cached?.indexById.get(cursor);
			if (priorIndex !== undefined) {
				cachedAncestorIndex = priorIndex;
				break;
			}
			if (seen.has(cursor)) return fallbackToBranch();
			seen.add(cursor);
			const entry = sm.getEntry.call(sm, cursor);
			if (!entry || typeof entry !== "object") return fallbackToBranch();
			const row = entry as { id?: unknown; parentId?: unknown };
			if (
				row.id !== cursor ||
				(row.parentId !== null && typeof row.parentId !== "string")
			) {
				return fallbackToBranch();
			}
			suffix.push(entry);
			cursor = row.parentId as string | null;
		}
		suffix.reverse();

		if (cached && cachedAncestorIndex === cached.entries.length - 1) {
			const entries = [...cached.entries, ...suffix];
			// A compaction re-bases the projection and a `context_edit` can remove
			// an earlier entry from it; neither can be applied by appending.
			if (
				suffix.some((entry) => {
					const type = (entry as { type?: unknown } | undefined)?.type;
					return type === "compaction" || type === "context_edit";
				})
			) {
				return installProjection(leafId, entries);
			}
			for (let index = 0; index < suffix.length; index += 1) {
				const entry = suffix[index];
				const id = (entry as { id: string }).id;
				cached.indexById.set(id, cached.entries.length + index);
				addPiBranchEntryToLookup(cached.lookup, entry);
				if (isPiContextEmitEligible(entry)) {
					cached.lookup.alignedEntryIds.push(entry.id);
					if (!isPiSystemMessageEntry(entry)) {
						cached.lookup.alignedVisibleEntryIds.push(entry.id);
					}
				}
			}
			const projection = {
				leafId,
				entries,
				indexById: cached.indexById,
				lookup: cached.lookup,
			};
			piBranchProjectionBySession.set(sessionId, projection);
			piBranchLookupByProjection.set(entries, cached.lookup);
			return entries;
		}

		const entries =
			cached && cachedAncestorIndex !== undefined
				? [...cached.entries.slice(0, cachedAncestorIndex + 1), ...suffix]
				: suffix;
		return installProjection(leafId, entries);
	} catch (error) {
		sessionLog(
			sessionId,
			`Pi branch projection failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		try {
			return fallbackToBranch();
		} catch (fallbackError) {
			sessionLog(
				sessionId,
				`Pi branch pre-read failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
			);
			return null;
		}
	}
}

/**
 * The fingerprint fields that do not depend on content, serialized exactly as
 * the first four elements of {@link piMessageEntryFingerprint}. Two messages can
 * share a fingerprint only if they share this header, so a header lookup can
 * rule a message out without hashing its content.
 */
function piMessageEntryFingerprintHeader(message: unknown): string | null {
	if (!message || typeof message !== "object") return null;
	const record = message as {
		responseId?: unknown;
		timestamp?: unknown;
		role?: unknown;
		toolCallId?: unknown;
	};
	if (typeof record.role !== "string") return null;
	return JSON.stringify([
		typeof record.responseId === "string" ? record.responseId : null,
		typeof record.timestamp === "number" || typeof record.timestamp === "string"
			? record.timestamp
			: null,
		record.role,
		typeof record.toolCallId === "string" ? record.toolCallId : null,
	]);
}

/**
 * Headers of every persisted `pi-msg-*` message tag fingerprint, or null when a
 * stored fingerprint has an unexpected shape and the caller must hash every
 * message. Rows without a fingerprint can never be adopted and are skipped.
 */
function readPiFallbackFingerprintHeaders(
	db: ContextDatabase,
	sessionId: string,
): Set<string> | null {
	const rows = db
		.prepare(
			`SELECT DISTINCT entry_fingerprint FROM json_each(?) prefix CROSS JOIN tags INDEXED BY idx_tags_session_message_id WHERE session_id = ? AND tags.type = 'message'
             AND message_id >= prefix.value AND message_id < substr(prefix.value, 1, 6) || '.'
             AND entry_fingerprint IS NOT NULL AND message_id LIKE 'pi-msg-%'`,
		)
		.all(PI_FALLBACK_PREFIXES_JSON, sessionId) as {
		entry_fingerprint: string;
	}[];
	const headers = new Set<string>();
	for (const row of rows) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.entry_fingerprint);
		} catch {
			return null;
		}
		if (!Array.isArray(parsed) || parsed.length !== 5) return null;
		headers.add(JSON.stringify(parsed.slice(0, 4)));
	}
	return headers;
}

// Number of piMessageEntryFingerprint calls (each hashes one message's content).
// Tests read it to check that an append pass hashes the same number of messages
// regardless of session length.
let piEntryFingerprintCount = 0;

function piMessageEntryFingerprint(message: unknown): string | null {
	piEntryFingerprintCount += 1;
	return fingerprintPiMessage(message);
}

/**
 * Build a `messageId → fingerprint` map from the RAW pre-transform messages,
 * keyed by the stable id each message resolves to this pass. Captured before
 * `runPipeline` mutates text (temporal markers, §N§ prefix, caveman) so the
 * fingerprint is byte-stable across the fallback-pass (in-flight) and the
 * real-id-pass (settled) — the invariant tag adoption depends on. The
 * fingerprint is persisted on the tag row at creation; only message-typed
 * entries get one (tool tags are out of scope).
 */
function buildEntryFingerprintMap(
	messages: readonly PiAgentMessage[],
	resolveStableId: (msg: unknown, index: number) => string | undefined,
	reusableMessageIds?: ReadonlySet<string>,
	includeReusable = true,
	reusableHeaders?: ReadonlySet<string> | null,
): Map<string, string> {
	const map = new Map<string, string>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const id = resolveStableId(msg, i);
		if (!id) continue;
		if (reusableMessageIds?.has(id)) {
			if (!includeReusable) continue;
			// Already-tagged messages only need a fingerprint to be matched
			// against a persisted fallback row. Hashing every one of them made
			// this stage scale with session size whenever any fallback row lingered.
			if (reusableHeaders) {
				const header = piMessageEntryFingerprintHeader(msg);
				if (header === null || !reusableHeaders.has(header)) continue;
			}
		}
		const fp = piMessageEntryFingerprint(msg);
		if (fp) map.set(id, fp);
	}
	return map;
}

function piToolOwnerMapKey(timestamp: number, callId: string): string {
	return `${timestamp}\x00${callId}`;
}

function buildPiToolOwnerMap(
	messages: readonly PiAgentMessage[],
	resolveStableId: (msg: unknown, index: number) => string | undefined,
): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		const msg = message as {
			role?: unknown;
			content?: unknown;
			timestamp?: unknown;
		};
		if (msg.role !== "assistant") continue;
		if (typeof msg.timestamp !== "number" || !Number.isFinite(msg.timestamp)) {
			continue;
		}
		if (!Array.isArray(msg.content)) continue;
		const ownerId = resolveStableId(message, i);
		if (!ownerId) continue;
		for (const part of msg.content) {
			if (!part || typeof part !== "object") continue;
			const p = part as { type?: unknown; id?: unknown };
			if (p.type !== "toolCall") continue;
			if (typeof p.id !== "string" || p.id.length === 0) continue;
			const key = piToolOwnerMapKey(msg.timestamp, p.id);
			let owners = map.get(key);
			if (!owners) {
				owners = new Set<string>();
				map.set(key, owners);
			}
			owners.add(ownerId);
		}
	}
	return map;
}

function parsePiFallbackToolOwnerId(
	ownerMsgId: string,
): { timestamp: number; role: string } | null {
	// Both the index-bearing `pi-msg-<index>-<ts>-<role>` form and the
	// position-independent `pi-msg-c<digest>o<n>-<ts>-<role>` form.
	const match = /^pi-msg-(?:\d+|c[0-9a-f]{16}o\d+)-(\d+)-(.+)$/.exec(
		ownerMsgId,
	);
	if (!match) return null;
	const timestamp = Number(match[1]);
	if (!Number.isFinite(timestamp)) return null;
	return { timestamp, role: match[2] ?? "" };
}

const piToolGuardStatements = new WeakMap<ContextDatabase, PreparedStatement>();
const piToolGuardVersionStatements = new WeakMap<
	ContextDatabase,
	PreparedStatement
>();
const piToolGuardFallbackStatements = new WeakMap<
	ContextDatabase,
	PreparedStatement
>();
const piToolGuardCallIds = new WeakMap<
	ContextDatabase,
	Map<
		string,
		{ version: number; identityRevision: string | null; ids: Set<string> }
	>
>();
function fallbackPiToolCallIds(
	db: ContextDatabase,
	sessionId: string,
): Set<string> {
	let statement = piToolGuardVersionStatements.get(db);
	if (!statement) {
		statement = db.prepare(
			`SELECT COALESCE((SELECT tags_version FROM session_meta WHERE session_id = ?), 0) AS version,
			(SELECT value FROM schema_migrations_meta WHERE key = ?) AS identity_revision`,
		);
		piToolGuardVersionStatements.set(db, statement);
	}
	const stamp = statement.get(sessionId, tagIdentityRevisionKey(sessionId)) as
		| { version: number; identity_revision?: string | null }
		| undefined;
	const version = stamp?.version ?? 0;
	const identityRevision = stamp?.identity_revision ?? null;
	let sessions = piToolGuardCallIds.get(db);
	if (!sessions) {
		sessions = new Map();
		piToolGuardCallIds.set(db, sessions);
	}
	const cached = sessions.get(sessionId);
	if (
		cached?.version === version &&
		cached.identityRevision === identityRevision
	)
		return cached.ids;
	let fallbackStatement = piToolGuardFallbackStatements.get(db);
	if (!fallbackStatement) {
		fallbackStatement = db.prepare(
			"SELECT DISTINCT message_id AS callId FROM tags WHERE session_id = ? AND type = 'tool' AND tool_owner_message_id LIKE 'pi-msg-%'",
		);
		piToolGuardFallbackStatements.set(db, fallbackStatement);
	}
	const ids = new Set(
		(fallbackStatement.all(sessionId) as { callId: string }[]).map(
			(row) => row.callId,
		),
	);
	if (!sessions.has(sessionId) && sessions.size >= MAX_TRACKED_SESSIONS)
		sessions.delete(sessions.keys().next().value as string);
	sessions.set(sessionId, { version, identityRevision, ids });
	return ids;
}

/**
 * An allocation the identity guards could not tie to its existing tag: the
 * call or message already has a row under another id, and nothing proves
 * which one it is. Tagging then allocates a new number, as it did before the
 * guards existed. That is one cache change for this identity, which the pass
 * logs; it never refuses the turn, because a refusal here would repeat on
 * every turn for as long as the shape persists.
 */
interface PiUnresolvedIdentity {
	kind: "tool" | "message";
	id: string;
}

const piUnresolvedIdentityLogged = new Set<string>();

function logPiUnresolvedIdentities(
	sessionId: string,
	unresolved: readonly PiUnresolvedIdentity[],
): void {
	const fresh = unresolved.filter(
		(item) =>
			!piUnresolvedIdentityLogged.has(`${sessionId}\0${item.kind}\0${item.id}`),
	);
	if (!fresh.length) return;
	if (piUnresolvedIdentityLogged.size > 10_000)
		piUnresolvedIdentityLogged.clear();
	for (const item of fresh)
		piUnresolvedIdentityLogged.add(`${sessionId}\0${item.kind}\0${item.id}`);
	sessionLog(
		sessionId,
		`tag identity unresolved: serving with a newly allocated tag number (one cache change per identity) session=${sessionId} ${fresh.map((item) => `${item.kind}=${item.id}`).join(" ")}`,
	);
}

function guardPiToolAllocations(
	db: ContextDatabase,
	sessionId: string,
	messages: readonly PiAgentMessage[],
	resolveId: (msg: unknown, index: number) => string | undefined,
	tagger?: Tagger,
	messageIndexes?: readonly number[],
): PiUnresolvedIdentity[] {
	const unresolved: PiUnresolvedIdentity[] = [];
	const fallbackCalls = fallbackPiToolCallIds(db, sessionId);
	for (const index of messageIndexes ?? messages.keys()) {
		const message = messages[index];
		if (message?.role !== "assistant" || !Array.isArray(message.content))
			continue;
		const owner = resolveId(message, index);
		if (!owner) continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			if (tagger?.getToolTag(sessionId, part.id, owner) !== undefined) continue;
			// A temporary owner with no timestamp cannot be matched to an assistant
			// entry. Only a tool with that same call id needs its ambiguity check.
			if (!owner.startsWith("pi-msg-") && !fallbackCalls.has(part.id)) continue;
			let statement = piToolGuardStatements.get(db);
			if (!statement) {
				statement = db.prepare(
					"SELECT tool_owner_message_id AS owner FROM tags WHERE session_id = ? AND type = 'tool' AND message_id = ? AND tool_owner_message_id IS NOT NULL",
				);
				piToolGuardStatements.set(db, statement);
			}
			const rows = statement.all(sessionId, part.id) as { owner: string }[];
			if (rows.some((row) => row.owner === owner)) continue;
			// A temporary assistant id can mean the same persisted call was moved
			// or edited by another extension. Until its timestamp proves a distinct
			// invocation, a new assignment could give that call two model-visible tags.
			if (
				rows.some((row) => {
					if (!row.owner.startsWith("pi-msg-"))
						return owner.startsWith("pi-msg-");
					const parsed = parsePiFallbackToolOwnerId(row.owner);
					return (
						!parsed ||
						typeof message.timestamp !== "number" ||
						parsed.timestamp === message.timestamp
					);
				})
			) {
				unresolved.push({ kind: "tool", id: `${owner}/${part.id}` });
			}
		}
	}
	return unresolved;
}

function guardPiMessageAllocations(
	db: ContextDatabase,
	sessionId: string,
	fingerprints: ReadonlyMap<string, string>,
): PiUnresolvedIdentity[] {
	const unresolved: PiUnresolvedIdentity[] = [];
	const hasFallback = hasPersistedPiFallbackMessageTags(db, sessionId);
	for (const [id, fingerprint] of fingerprints) {
		if (!id.startsWith("pi-msg-") && !hasFallback) continue;
		const rows = db
			.prepare(
				"SELECT message_id AS id FROM tags WHERE session_id = ? AND type = 'message' AND entry_fingerprint = ?",
			)
			.all(sessionId, fingerprint) as { id: string }[];
		if (rows.some((row) => row.id.replace(/:p\d+$/, "") === id)) continue;
		if (
			rows.some(
				(row) => id.startsWith("pi-msg-") || row.id.startsWith("pi-msg-"),
			)
		) {
			unresolved.push({ kind: "message", id });
		}
	}
	return unresolved;
}

function databaseIsInTransaction(db: ContextDatabase): boolean {
	const state = db as unknown as {
		inTransaction?: unknown;
		isTransaction?: unknown;
	};
	return state.inTransaction === true || state.isTransaction === true;
}

function runImmediateTransaction<T>(db: ContextDatabase, fn: () => T): T {
	if (databaseIsInTransaction(db)) {
		return db.transaction(fn).immediate();
	}
	db.exec("BEGIN IMMEDIATE");
	const transactionStartedAt = performance.now();
	try {
		const result = fn();
		db.exec("COMMIT");
		logSlowWriteTransaction("pi_fallback_adoption", transactionStartedAt);
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

const PI_CONTENT_FALLBACK_PARTS = /^pi-msg-c([0-9a-f]{16})o(\d+)(-.*)?$/;

/**
 * Keep exact-duplicate unmapped messages from inheriting each other's tags.
 *
 * piContentFallbackIds numbers byte-identical copies `o0`, `o1`, … in the
 * order they appear in this pass. When a copy disappears (a host rebuilds or
 * rewinds the context) the remaining ones shift down, and a survivor would
 * take the vanished copy's id, number and status, a dropped status included.
 * Identical copies cannot say which one survived, so that correspondence is
 * treated as unknown and never followed: when stored rows exist for an
 * occurrence this pass no longer has, the survivors take the stored
 * occurrences with the newest tag numbers (the one-time repair rule), in
 * order. If that changes any copy's id, the change is declared once per
 * message as a `tag_identity_repair` rebuild under the once guard
 * `["message-occurrence", <digest>]`; later passes keep the same choice
 * without declaring again. Failures to read or record leave the ids as
 * computed and never refuse the turn.
 */
function settlePiFallbackOccurrences(
	db: ContextDatabase,
	sessionId: string,
	ids: (string | undefined)[],
): (string | undefined)[] {
	const groups = new Map<string, { suffix: string; indices: number[] }>();
	ids.forEach((id, index) => {
		const match = id ? PI_CONTENT_FALLBACK_PARTS.exec(id) : null;
		if (!match?.[1]) return;
		const group = groups.get(match[1]) ?? {
			suffix: match[3] ?? "",
			indices: [],
		};
		group.indices.push(index);
		groups.set(match[1], group);
	});
	if (!groups.size) return ids;
	let result = ids;
	for (const [digest, { suffix, indices }] of groups) {
		let rows: { id: string; n: number }[];
		try {
			rows = db
				.prepare(
					"SELECT message_id AS id, tag_number AS n FROM tags WHERE session_id = ? AND type = 'message' AND message_id >= ? AND message_id < ?",
				)
				.all(sessionId, `pi-msg-c${digest}o`, `pi-msg-c${digest}p`) as {
				id: string;
				n: number;
			}[];
		} catch {
			continue;
		}
		const newestByOccurrence = new Map<number, number>();
		for (const row of rows) {
			const occurrence = Number(
				PI_CONTENT_FALLBACK_PARTS.exec(row.id.replace(/:p\d+$/, ""))?.[2],
			);
			if (!Number.isSafeInteger(occurrence)) continue;
			newestByOccurrence.set(
				occurrence,
				Math.max(newestByOccurrence.get(occurrence) ?? 0, row.n),
			);
		}
		const present = indices.length;
		if (
			![...newestByOccurrence.keys()].some(
				(occurrence) => occurrence >= present,
			)
		)
			continue;
		const chosen = [...newestByOccurrence]
			.sort((left, right) => right[1] - left[1])
			.slice(0, present)
			.sort((left, right) => left[0] - right[0]);
		let fresh = Math.max(...newestByOccurrence.keys()) + 1;
		const occurrences = indices.map((_, i) => chosen[i]?.[0] ?? fresh++);
		if (result === ids) result = [...ids];
		indices.forEach((index, i) => {
			result[index] = `pi-msg-c${digest}o${occurrences[i]}${suffix}`;
		});
		if (occurrences.every((occurrence, i) => occurrence === i)) continue;
		const guardKey = JSON.stringify(["message-occurrence", digest]);
		if (claimPiIdentityRepair(db, sessionId, guardKey) !== "claimed") continue;
		const kept = Math.max(...chosen.map(([, number]) => number));
		if (
			queuePiIdentityRebuild(db, sessionId, {
				key: guardKey,
				kept,
				removed: [],
				kind: "message",
			})
		)
			sessionLog(
				sessionId,
				`tag identity repair without last-served evidence: session=${sessionId} identical unmapped messages lost a copy; survivors keep the newest numbers kept=${chosen.map(([, number]) => number).join(",")}`,
			);
	}
	return result;
}

/**
 * Thrown inside the savepoint that merges duplicate tag rows, to undo a repair
 * whose pending-rebuild record could not be written.
 */
class PiIdentityRebuildUnrecorded extends Error {}

interface AdoptPiFallbackTagsOptions {
	allowUnprovenRebuild?: boolean;
	deferUnprovenRebuild?: boolean;
	messages?: readonly PiAgentMessage[];
	resolveStableId?: (msg: unknown, index: number) => string | undefined;
	hasFallbackMessageTags?: boolean;
	hasFallbackToolOwnerTags?: boolean;
	preflightRevision?: ReturnType<typeof readPiAdoptionRevision>;
	rebuildFingerprints?: () => ReadonlyMap<string, string>;
	toolOwners?: Map<string, Set<string>>;
	realIdPositions?: ReadonlyMap<string, number>;
}

function readPiAdoptionRevision(db: ContextDatabase) {
	return {
		external: db.prepare("PRAGMA data_version").get() as {
			data_version: number;
		},
		local: db.prepare("SELECT total_changes() AS changes").get() as {
			changes: number;
		},
	};
}

function preparePiAdoptionFingerprints(
	fingerprintById: ReadonlyMap<string, string>,
) {
	const realIdsByFingerprint = new Map<string, string[]>();
	// Position-independent fallback ids are adoption targets for rows stored
	// under the older index-bearing form; other fallback ids never are.
	const fallbackIdsByFingerprint = new Map<string, string[]>();
	for (const [id, fingerprint] of fingerprintById) {
		const byFingerprint = !id.startsWith("pi-msg-")
			? realIdsByFingerprint
			: isPiContentFallbackId(id)
				? fallbackIdsByFingerprint
				: undefined;
		if (!byFingerprint) continue;
		const ids = byFingerprint.get(fingerprint) ?? [];
		ids.push(id);
		byFingerprint.set(fingerprint, ids);
	}
	const fingerprints = [
		...new Set([
			...realIdsByFingerprint.keys(),
			...fallbackIdsByFingerprint.keys(),
		]),
	];
	const batches: { values: string[]; placeholders: string }[] = [];
	for (let i = 0; i < fingerprints.length; i += 900) {
		const values = fingerprints.slice(i, i + 900);
		batches.push({ values, placeholders: values.map(() => "?").join(",") });
	}
	return { realIdsByFingerprint, fallbackIdsByFingerprint, batches };
}

function readAdoptablePiFallbackFingerprints(
	db: ContextDatabase,
	sessionId: string,
	batches: readonly { values: string[]; placeholders: string }[],
): Set<string> {
	const found = new Set<string>();
	for (const { values, placeholders } of batches) {
		const rows = db
			.prepare(
				`SELECT DISTINCT entry_fingerprint FROM tags WHERE session_id = ? AND type = 'message'
			 AND entry_fingerprint IN (${placeholders}) AND message_id LIKE 'pi-msg-%'`,
			)
			.all(sessionId, ...values) as { entry_fingerprint: string }[];
		for (const row of rows) found.add(row.entry_fingerprint);
	}
	return found;
}

function piFallbackBaseId(messageId: string): string {
	return /^(.*):p\d+$/.exec(messageId)?.[1] ?? messageId;
}

/**
 * Pair several fallback messages that share one fingerprint with the real ids
 * now carrying it, so that their tags (and any dropped status) move to the
 * right messages instead of being re-created.
 *
 * Identical messages stamped in the same millisecond share a fingerprint. When
 * every pass resolved them by fingerprint, they were tagged under index-based
 * `pi-msg-<index>-…` ids, and a compaction that shifted the indexes tagged them
 * again under new ones. The pair that was served last holds the highest tag
 * numbers, and within one pass the index order is the message order. So the
 * N newest bases, ordered by index, map to the N real ids ordered by position.
 * Returns null for every real id when that cannot be established: fewer than
 * two real ids, a real id with no position, fewer bases than real ids, or a
 * base without a distinct index.
 */
function pairPiFallbackBases(
	realIds: readonly string[],
	candidates: readonly { tagNumber: number; messageId: string }[],
	realIdPositions: () => ReadonlyMap<string, number> | undefined,
): Map<string, string | null> {
	const pairs = new Map<string, string | null>(
		realIds.map((id) => [id, null] as const),
	);
	if (realIds.length < 2) return pairs;
	const positions = realIdPositions();
	if (!positions || realIds.some((id) => !positions.has(id))) return pairs;
	const newestTag = new Map<string, number>();
	for (const c of candidates) {
		const base = piFallbackBaseId(c.messageId);
		newestTag.set(base, Math.max(newestTag.get(base) ?? 0, c.tagNumber));
	}
	if (newestTag.size < realIds.length) return pairs;
	// Within one pass, an index-bearing base's index and a position-independent
	// base's occurrence counter both follow message order; the two schemes are
	// not comparable with each other, so a mix pairs nothing.
	const chosen = [...newestTag.entries()]
		.sort((left, right) => right[1] - left[1])
		.slice(0, realIds.length)
		.map(([base]) => {
			const indexed = /^pi-msg-(\d+)-/.exec(base)?.[1];
			const counted = /^pi-msg-c[0-9a-f]{16}o(\d+)-/.exec(base)?.[1];
			return {
				base,
				index: indexed ?? counted,
				scheme: indexed !== undefined ? "index" : "occurrence",
			};
		});
	if (chosen.some((entry) => entry.index === undefined)) return pairs;
	if (new Set(chosen.map((entry) => entry.scheme)).size > 1) return pairs;
	chosen.sort((left, right) => Number(left.index) - Number(right.index));
	if (new Set(chosen.map((entry) => entry.index)).size !== chosen.length)
		return pairs;
	const ordered = [...realIds].sort(
		(left, right) => (positions.get(left) ?? 0) - (positions.get(right) ?? 0),
	);
	for (let index = 0; index < ordered.length; index += 1) {
		pairs.set(ordered[index] as string, chosen[index]?.base ?? null);
	}
	return pairs;
}

/**
 * Check an order-based pairing against the served-number ledger before it is
 * applied, so that each real id keeps the number the model last saw.
 *
 * pairPiFallbackBases picks the newest fallback bases on the assumption that
 * they were served last. The ledger records every number ever served, not just
 * the latest pass, so it cannot confirm that assumption, but it can refute it:
 * when some fallback base of this fingerprint was served and a chosen base was
 * never served, the newest pair may come from a pass that never reached the
 * model, and moving it onto the real id would change that message's number.
 * Such a pair is still safe when the real id already holds a served row for
 * every part, because the collision rules in adoptPiFallbackMessageTag then keep
 * that served number and fold the unserved fallback into it. With no served
 * fallback number at all there is no evidence either way and the newest-pair
 * rule stands. Returns false when the pairing must not be applied.
 */
function piPairingKeepsServedNumbers(
	pairs: ReadonlyMap<string, string | null>,
	candidates: readonly { tagNumber: number; messageId: string }[],
	served: ReadonlySet<number>,
	rowsForRealContentId: (
		realContentId: string,
	) => readonly { tagNumber: number }[],
): boolean {
	const servedBases = new Set(
		candidates
			.filter((c) => served.has(c.tagNumber))
			.map((c) => piFallbackBaseId(c.messageId)),
	);
	if (servedBases.size === 0) return true;
	for (const [realId, base] of pairs) {
		if (base === null || servedBases.has(base)) continue;
		for (const c of candidates) {
			if (piFallbackBaseId(c.messageId) !== base) continue;
			const ordinal = /:p(\d+)$/.exec(c.messageId)?.[1];
			if (ordinal === undefined) return false;
			const rows = rowsForRealContentId(`${realId}:p${ordinal}`);
			if (!rows.some((row) => served.has(row.tagNumber))) return false;
		}
	}
	return true;
}

/**
 * Replace temporary `pi-msg-*` identities when Pi supplies real entry ids,
 * or when an unresolved assistant moves to a different visible array index,
 * or when a message row an older build keyed by array index now has a
 * position-independent fallback id.
 * Match message tags by raw content fingerprint and tool tags by their owning
 * assistant's `(timestamp, callId)`. If both identities have rows, merge them
 * without changing the actually served number or losing dropped status, queued
 * reductions, or maximum size/token accounting. Update the tagger's lookup keys
 * before `tagTranscript` can allocate a second number for the same message.
 */
function adoptPiFallbackTags(
	db: ContextDatabase,
	sessionId: string,
	tagger: Tagger,
	fingerprintById: ReadonlyMap<string, string>,
	options: AdoptPiFallbackTagsOptions = {},
): { protectedTagNumbers: Set<number>; rebuilds: PiIdentityRebuild[] } {
	const pendingRebuilds = readPiIdentityRebuilds(db, sessionId);
	const outcome = {
		protectedTagNumbers: new Set<number>(
			pendingRebuilds.map((repair) => repair.kept),
		),
		rebuilds: pendingRebuilds,
	};
	const claimed = new Set<string>();
	const repairing = new Set<string>();
	// Reuse one union of legacy JSONL and SQLite-committed served numbers for adoption.
	let servedNumbers: ReadonlySet<number> | undefined;
	const readServedNumbers = () =>
		(servedNumbers ??= getPiServedTagNumbers(sessionId, undefined, db));
	const newRebuilds: PiIdentityRebuild[] = [];
	const recurrences: { key: string; numbers: number[]; fresh: boolean }[] = [];
	/**
	 * Decide how to merge one duplicate identity. Returns `{ rebuilding }` to
	 * fold (with `rebuilding` set when the newest number is kept without proof),
	 * or null to leave the rows unmerged and serve the identity as tagging does.
	 *
	 * - Proven (a cached survivor, or exactly one served number): fold with no
	 *   byte change. The once-guard is recorded but its spent state is not
	 *   consulted. Exception: when identity decisions cannot be read or the
	 *   guard cannot be written, or the identity is already recorded as served
	 *   unmerged, it stays unmerged.
	 * - Unproven, first time for this identity: one declared repair that keeps
	 *   the newest number, whether or not a last served array is in memory. A
	 *   cached array that proves nothing (a quoted old number, rewritten
	 *   text, numbers that were never served) is no better evidence than none.
	 * - Unproven again after that repair, or the guard cannot be persisted:
	 *   no second repair and no refusal; recorded as a recurring identity.
	 * Every decision read and write here is contained (see
	 * pi-tag-identity-repair.ts): a failure leaves the rows unmerged.
	 * Low-level callers without `allowUnprovenRebuild` keep failing closed in
	 * selectPiTagSurvivor.
	 */
	const plan = (
		rows: readonly { tagNumber: number }[],
		key: string,
		legacyKeys: readonly string[],
		served: ReadonlySet<number>,
		cached: number | undefined,
	): { rebuilding: number | undefined } | null => {
		const proven =
			cached !== undefined ||
			rows.filter((row) => served.has(row.tagNumber)).length === 1;
		// Ambiguous identities need a prefix rewrite; leave them unmerged while
		// signed thinking holds that rewrite for the next real user turn.
		if (!proven && options.deferUnprovenRebuild) return null;
		if (proven && options.allowUnprovenRebuild) {
			// Even a byte-safe fold needs readable, writable identity decisions:
			// an identity this session already serves unmerged (its repair was
			// spent or could not be recorded) stays unmerged rather than changing
			// which rows exist from one turn to the next.
			const decisions = readPiIdentityDecisions(db, sessionId);
			let unmerged =
				decisions === null ||
				decisions.has(encodePiContentDecision("tag-identity-recurring", key));
			if (!unmerged && !claimed.has(key)) {
				unmerged =
					claimPiIdentityRepair(db, sessionId, key, legacyKeys) ===
					"unpersisted";
				claimed.add(key);
			}
			if (!unmerged) return { rebuilding: undefined };
			recurrences.push({
				key,
				numbers: rows.map((row) => row.tagNumber).sort((x, y) => x - y),
				fresh: recordPiIdentityRecurrence(db, sessionId, key),
			});
			return null;
		}
		if (proven || !options.allowUnprovenRebuild) {
			if (!claimed.has(key)) {
				claimPiIdentityRepair(db, sessionId, key, legacyKeys);
				claimed.add(key);
			}
			return { rebuilding: undefined };
		}
		const newest = Math.max(...rows.map((row) => row.tagNumber));
		if (repairing.has(key)) return { rebuilding: newest };
		const claim = claimed.has(key)
			? "recurring"
			: claimPiIdentityRepair(db, sessionId, key, legacyKeys);
		claimed.add(key);
		if (claim === "claimed") {
			repairing.add(key);
			return { rebuilding: newest };
		}
		recurrences.push({
			key,
			numbers: rows.map((row) => row.tagNumber).sort((x, y) => x - y),
			fresh: recordPiIdentityRecurrence(db, sessionId, key),
		});
		return null;
	};
	/**
	 * Run one fold. A repair's pending-rebuild record is written inside the same
	 * savepoint, so a fold whose rebuild cannot be recorded (a full decision
	 * ledger, a rejected write) is undone and the identity is served unmerged
	 * instead of changing bytes without a declared rebuild. With production
	 * options any other failure inside the savepoint is contained the same
	 * way: the turn is served with the rows as they were. `recordKey` names the
	 * rebuild record (one per target part); `guardKey` is the identity's
	 * once-guard key, under which an unrecorded repair is noted.
	 */
	const fold = (
		run: () => ReturnType<typeof adoptPiFallbackMessageTag>,
		recordKey: string,
		guardKey: string,
		kind: "tool" | "message",
		rebuilding: number | undefined,
	): ReturnType<typeof adoptPiFallbackMessageTag> => {
		const key = recordKey;
		let repair: PiIdentityRebuild | undefined;
		let adoption: ReturnType<typeof adoptPiFallbackMessageTag>;
		try {
			adoption = db
				.transaction(() => {
					const result = run();
					if (result.action !== "folded" || rebuilding === undefined)
						return result;
					repair = {
						key,
						kept: result.tagNumber,
						removed: result.deletedTagNumbers,
						kind,
					};
					if (!queuePiIdentityRebuild(db, sessionId, repair))
						throw new PiIdentityRebuildUnrecorded();
					return result;
				})
				.immediate();
		} catch (error) {
			if (
				!(error instanceof PiIdentityRebuildUnrecorded) &&
				!options.allowUnprovenRebuild
			)
				throw error;
			if (!(error instanceof PiIdentityRebuildUnrecorded))
				sessionLog(
					sessionId,
					`tag identity fold failed; serving the duplicate unmerged: ${error instanceof Error ? error.message : String(error)}`,
				);
			recurrences.push({
				key: guardKey,
				numbers: [],
				fresh: recordPiIdentityRecurrence(db, sessionId, guardKey),
			});
			return { action: "skipped" };
		}
		if (adoption.action === "folded") {
			outcome.protectedTagNumbers.add(adoption.tagNumber);
			if (repair) newRebuilds.push(repair);
		}
		return adoption;
	};
	// Prepare message identities and SQL bind lists before taking the writer.
	// Another connection can add a synthetic tag while this work runs, so validate
	// the discovery revision after BEGIN; never trust an earlier negative read.
	let { realIdsByFingerprint, fallbackIdsByFingerprint, batches } =
		preparePiAdoptionFingerprints(fingerprintById);
	const ownerMap =
		options.toolOwners ??
		(options.messages && options.resolveStableId
			? buildPiToolOwnerMap(options.messages, options.resolveStableId)
			: null);
	if (!batches.length && !ownerMap?.size && !options.rebuildFingerprints)
		return outcome;
	const revision = () => readPiAdoptionRevision(db);
	const beforeDiscovery = revision();
	// Discover candidates without blocking writers and prepare their target ids.
	// The data_version/total_changes comparison inside the immediate transaction
	// below is authoritative: discovery may miss a fallback row another
	// connection just committed, or include one it already moved to a real id.
	// Both existence probes query the tags table, so they see every writer. If
	// no commit happened between beforeDiscovery and that transaction, their
	// results still describe the table and are not re-run under the lock.
	const discoveredMessageFallback = hasPersistedPiFallbackMessageTags(
		db,
		sessionId,
	);
	const discoveredToolOwnerFallback = ownerMap?.size
		? hasPersistedPiFallbackToolOwnerTags(db, sessionId)
		: false;
	const discovered = discoveredMessageFallback
		? readAdoptablePiFallbackFingerprints(db, sessionId, batches)
		: new Set<string>();
	const targetsFor = (fingerprints: Iterable<string>) =>
		[...fingerprints].flatMap((fingerprint) =>
			(realIdsByFingerprint.get(fingerprint) ?? []).map(
				(id) => [id, fingerprint] as const,
			),
		);
	const fallbackTargetsFor = (fingerprints: Iterable<string>) =>
		[...fingerprints].flatMap((fingerprint) =>
			(fallbackIdsByFingerprint.get(fingerprint) ?? []).map(
				(id) => [id, fingerprint] as const,
			),
		);
	const discoveredTargets = targetsFor(discovered);

	/** Move one fallback message's part rows to `targetId`, folding into any rows it already has. */
	const adoptMessageCandidates = (
		targetId: string,
		fingerprint: string,
		candidates: readonly { tagNumber: number; messageId: string }[],
	) => {
		for (const c of candidates) {
			const ordinalMatch = /:p(\d+)$/.exec(c.messageId);
			if (!ordinalMatch) continue;
			const realContentId = `${targetId}:p${ordinalMatch[1]}`;
			const served = readServedNumbers();
			const canonical = getPiMessageTagCandidates(db, sessionId, realContentId);
			const collisionRows = [
				...getTagsByNumbers(db, sessionId, [c.tagNumber]),
				...canonical,
			];
			const cachedSurvivor = canonical.length
				? piCachedMessageSurvivor(
						sessionId,
						fingerprint,
						Number(ordinalMatch[1]),
						collisionRows,
					)
				: undefined;
			// The rebuild record names the target part; the once guard names the
			// message itself (its header-and-content fingerprint and part
			// ordinal), so the guard still holds when the same message later
			// moves from a fallback id to a real entry id. The target-id key
			// earlier builds wrote is still honoured.
			const repairKey = JSON.stringify(["message", realContentId]);
			const guardKey = JSON.stringify([
				"message",
				fingerprint,
				Number(ordinalMatch[1]),
			]);
			const decision = canonical.length
				? plan(collisionRows, guardKey, [repairKey], served, cachedSurvivor)
				: { rebuilding: undefined };
			// The duplicate came back after its one repair: leave the fallback row
			// and the target's row as they are; tagging serves the target's row.
			if (decision === null) continue;
			const rebuilding = decision.rebuilding;
			if (
				canonical.length &&
				!collisionRows.some((row) => served.has(row.tagNumber)) &&
				cachedSurvivor === undefined &&
				rebuilding === undefined
			) {
				throw new PiTagIdentityConflictError(
					"duplicate message identities have no proven served-byte survivor",
					"message",
				);
			}
			const adoption = fold(
				() =>
					adoptPiFallbackMessageTag(
						db,
						sessionId,
						c.tagNumber,
						c.messageId,
						realContentId,
						served,
						cachedSurvivor,
						rebuilding,
					),
				repairKey,
				guardKey,
				"message",
				rebuilding,
			);
			if (adoption.action !== "skipped") {
				// Drop stale fallback and collision aliases, then bind the survivor
				// under the target key so the same-pass exact lookup hits it.
				tagger.unbindTag(sessionId, c.messageId);
				if (adoption.action === "folded") {
					tagger.unbindTag(sessionId, realContentId);
				}
				tagger.bindTag(sessionId, realContentId, adoption.tagNumber);
			}
		}
	};

	runImmediateTransaction(db, () => {
		const admitted = revision();
		// No commit from this or another connection since discovery.
		const unchangedSinceDiscovery =
			beforeDiscovery.external.data_version ===
				admitted.external.data_version &&
			beforeDiscovery.local.changes === admitted.local.changes;
		const preflight = options.preflightRevision;
		const rebuild = options.rebuildFingerprints;
		const expanded = Boolean(
			preflight &&
				rebuild &&
				(preflight.external.data_version !== admitted.external.data_version ||
					preflight.local.changes !== admitted.local.changes),
		);
		if (expanded && rebuild) {
			// A new commit may target history omitted by the negative gate. Recover
			// those pristine fingerprints, not just more rows for the old tail set.
			({ realIdsByFingerprint, fallbackIdsByFingerprint, batches } =
				preparePiAdoptionFingerprints(rebuild()));
		}
		if (
			batches.length &&
			(unchangedSinceDiscovery
				? discoveredMessageFallback
				: hasPersistedPiFallbackMessageTags(db, sessionId))
		) {
			// After writer admission the candidate set cannot gain rows from a
			// sibling connection. Missing fingerprints need no per-message read;
			// present ones still use the sequential, authoritative migration path.
			// data_version detects other connections' commits; total_changes catches
			// this connection's own writes. With BEGIN held, an unchanged revision
			// makes discovery authoritative without repeating the large IN queries.
			const unchanged = !expanded && unchangedSinceDiscovery;
			const adoptable = unchanged
				? discovered
				: readAdoptablePiFallbackFingerprints(db, sessionId, batches);
			const targets = expanded
				? targetsFor(adoptable)
				: discoveredTargets.filter(([, fp]) => adoptable.has(fp));
			if (!expanded)
				targets.push(
					...targetsFor([...adoptable].filter((fp) => !discovered.has(fp))),
				);
			const pairedBaseByRealId = new Map<string, string | null>();
			let positions: ReadonlyMap<string, number> | undefined =
				options.realIdPositions;
			const realIdPositions = (): ReadonlyMap<string, number> | undefined => {
				if (positions) return positions;
				const { messages, resolveStableId } = options;
				if (!messages || !resolveStableId) return undefined;
				const computed = new Map<string, number>();
				for (let index = 0; index < messages.length; index += 1) {
					const id = resolveStableId(messages[index], index);
					if (id !== undefined && !computed.has(id)) computed.set(id, index);
				}
				positions = computed;
				return positions;
			};
			for (const [realMessageId, fingerprint] of targets) {
				// This loop adopts onto real ids only; position-independent fallback
				// targets are handled by the loop after it.
				if (realMessageId.startsWith("pi-msg-")) continue;
				// Several real ids sharing one fingerprint (identical messages stamped
				// in the same millisecond) can only adopt through an order-proven
				// pairing below, never through the single-fallback shortcut: one
				// fallback row cannot say which of the identical entries it tagged.
				const sharedFingerprint =
					(realIdsByFingerprint.get(fingerprint)?.length ?? 0) > 1;
				if (!adoptable.has(fingerprint)) continue;
				const candidates = findAdoptableFallbackTags(
					db,
					sessionId,
					fingerprint,
				);
				if (candidates.length === 0) continue;
				// Group candidates by their fallback message base id (strip the :pN
				// suffix). A unique base for a unique real id means exactly one fallback
				// message carried this fingerprint → safe to adopt. Several bases, or
				// several real ids, are ambiguous unless pairPiFallbackBases matches them
				// in order and the served-number ledger agrees with that pairing;
				// otherwise skip: guardPiMessageAllocations reports the id, and tagging
				// allocates a new number for it (one logged cache change, no refusal).
				const baseIds = new Set(
					candidates.map((c) => piFallbackBaseId(c.messageId)),
				);
				let base: string | undefined;
				if (baseIds.size === 1 && !sharedFingerprint) base = [...baseIds][0];
				else {
					if (!pairedBaseByRealId.has(realMessageId)) {
						const pairs = pairPiFallbackBases(
							(realIdsByFingerprint.get(fingerprint) ?? []).filter(
								(id) => !id.startsWith("pi-msg-"),
							),
							candidates,
							realIdPositions,
						);
						const proven = piPairingKeepsServedNumbers(
							pairs,
							candidates,
							readServedNumbers(),
							(realContentId) =>
								getPiMessageTagCandidates(db, sessionId, realContentId),
						);
						for (const [id, paired] of pairs)
							pairedBaseByRealId.set(id, proven ? paired : null);
					}
					base = pairedBaseByRealId.get(realMessageId) ?? undefined;
				}
				if (base === undefined) continue;
				adoptMessageCandidates(
					realMessageId,
					fingerprint,
					candidates.filter((c) => piFallbackBaseId(c.messageId) === base),
				);
			}
			// A message no lane maps keeps a position-independent fallback id
			// (piContentFallbackIds). Rows an older build stored under the
			// index-bearing `pi-msg-<index>-…` form move to that id, numbers
			// unchanged, the way tool owners are re-keyed below. Only a fingerprint
			// carried by exactly one message of this pass, and by no real entry, is
			// re-keyed: otherwise the old rows cannot say which copy they tagged.
			for (const [fallbackId, fingerprint] of fallbackTargetsFor(adoptable)) {
				if (realIdsByFingerprint.has(fingerprint)) continue;
				if ((fallbackIdsByFingerprint.get(fingerprint)?.length ?? 0) !== 1)
					continue;
				const legacy = findAdoptableFallbackTags(
					db,
					sessionId,
					fingerprint,
				).filter((c) => isPiIndexFallbackId(piFallbackBaseId(c.messageId)));
				// Oldest first: the first old row is re-keyed, and any later old row
				// for the same message is then merged into it (proven or repaired).
				legacy.sort((left, right) => left.tagNumber - right.tagNumber);
				for (const base of new Set(
					legacy.map((c) => piFallbackBaseId(c.messageId)),
				))
					adoptMessageCandidates(
						fallbackId,
						fingerprint,
						legacy.filter((c) => piFallbackBaseId(c.messageId) === base),
					);
			}
		}

		if (
			ownerMap &&
			(unchangedSinceDiscovery
				? discoveredToolOwnerFallback
				: hasPersistedPiFallbackToolOwnerTags(db, sessionId))
		) {
			for (const row of findPiFallbackToolOwnerTags(db, sessionId)) {
				const parsed = parsePiFallbackToolOwnerId(row.toolOwnerMessageId);
				if (parsed?.role !== "assistant") continue;
				const owners = ownerMap.get(
					piToolOwnerMapKey(parsed.timestamp, row.callId),
				);
				if (owners?.size !== 1) continue;
				const [realOwnerId] = owners;
				if (!realOwnerId || realOwnerId === row.toolOwnerMessageId) continue;
				const existingNumber = getToolTagNumberByOwner(
					db,
					sessionId,
					row.callId,
					realOwnerId,
				);
				const served = readServedNumbers();
				const cachedSurvivor =
					existingNumber === null
						? undefined
						: piCachedToolSurvivor(
								sessionId,
								row.callId,
								parsed.timestamp,
								getTagsByNumbers(db, sessionId, [
									row.tagNumber,
									existingNumber,
								]),
							);
				// Keyed by the owning assistant's timestamp and the call id, which is
				// how this loop matched the rows: an unresolved owner's id can change
				// (its content changed, or an older build's id carried its index), and
				// a key built from it would let the same call be repaired twice. The
				// owner-id key earlier builds wrote is still honoured.
				const repairKey = JSON.stringify([
					"tool",
					parsed.timestamp,
					row.callId,
				]);
				const legacyKeys = [JSON.stringify(["tool", realOwnerId, row.callId])];
				const decision =
					existingNumber === null
						? { rebuilding: undefined }
						: plan(
								[{ tagNumber: row.tagNumber }, { tagNumber: existingNumber }],
								repairKey,
								legacyKeys,
								served,
								cachedSurvivor,
							);
				// The duplicate came back after its one repair: leave the fallback-owner
				// row and the current owner's row; tagging serves the current owner's.
				if (decision === null) continue;
				const rebuilding = decision.rebuilding;
				if (
					existingNumber !== null &&
					!served.has(existingNumber) &&
					!served.has(row.tagNumber) &&
					cachedSurvivor === undefined &&
					rebuilding === undefined
				) {
					throw new PiTagIdentityConflictError(
						"duplicate tool identities have no proven served-byte survivor",
					);
				}
				const adoption = fold(
					() =>
						adoptPiFallbackToolOwnerTag(
							db,
							sessionId,
							row.tagNumber,
							row.callId,
							row.toolOwnerMessageId,
							realOwnerId,
							served.size === 0 && cachedSurvivor !== undefined
								? new Set([cachedSurvivor])
								: served,
							cachedSurvivor,
							rebuilding,
						),
					repairKey,
					repairKey,
					"tool",
					rebuilding,
				);
				if (adoption.action !== "skipped") {
					tagger.unbindToolTag(sessionId, row.toolOwnerMessageId, row.callId);
					if (adoption.action === "folded") {
						tagger.unbindToolTag(sessionId, realOwnerId, row.callId);
					}
					tagger.bindToolTag(
						sessionId,
						row.callId,
						realOwnerId,
						adoption.tagNumber,
					);
					const accounting = getPersistedToolTagAccounting(
						db,
						sessionId,
						adoption.tagNumber,
					);
					if (accounting) {
						// Collision folds can raise stored maxima; refresh the mirror before
						// identity reuse uses it as the no-BPE growth baseline.
						tagger.setToolTagAccounting(
							sessionId,
							adoption.tagNumber,
							accounting,
						);
					}
				}
			}
		}
	});
	for (const recurrence of recurrences) {
		if (!recurrence.fresh) continue;
		sessionLog(
			sessionId,
			`tag identity recurred after its one repair: serving without a second rebuild (one cache change) session=${sessionId} identity=${recurrence.key} numbers=${recurrence.numbers.join(",")}`,
		);
	}
	if (newRebuilds.length) {
		sessionLog(
			sessionId,
			`tag identity repair without last-served evidence: session=${sessionId} kept=${newRebuilds.map((repair) => repair.kept).join(",")} removed=${newRebuilds.flatMap((repair) => repair.removed).join(",")}`,
		);
	}
	outcome.rebuilds = readPiIdentityRebuilds(db, sessionId);
	return outcome;
}

interface PiHistorianStateSnapshot {
	detectedContextLimit: number;
	needsEmergencyRecovery: boolean;
	historianFailureCount: number;
}

const EMPTY_PI_HISTORIAN_STATE_SNAPSHOT: PiHistorianStateSnapshot = {
	detectedContextLimit: 0,
	needsEmergencyRecovery: false,
	historianFailureCount: 0,
};

function loadPiHistorianStateSnapshot(
	db: ContextDatabase,
	sessionId: string,
): PiHistorianStateSnapshot {
	const row = db
		.prepare(
			`SELECT detected_context_limit, needs_emergency_recovery,
			        historian_failure_count
			   FROM session_meta
			  WHERE session_id = ?`,
		)
		.get(sessionId) as
		| {
				detected_context_limit?: unknown;
				needs_emergency_recovery?: unknown;
				historian_failure_count?: unknown;
		  }
		| undefined;
	return {
		detectedContextLimit:
			typeof row?.detected_context_limit === "number" &&
			row.detected_context_limit > 0
				? row.detected_context_limit
				: 0,
		needsEmergencyRecovery:
			typeof row?.needs_emergency_recovery === "number" &&
			row.needs_emergency_recovery > 0,
		historianFailureCount:
			typeof row?.historian_failure_count === "number" &&
			row.historian_failure_count >= 0
				? row.historian_failure_count
				: 0,
	};
}

/**
 * Register the Pi `context` event handler.
 *
 * The Tagger is created once per session boot — same lifecycle as the
 * OpenCode plugin's tagger. It maintains in-memory state (the
 * monotonic counter, assignment map) across `context` events so tag
 * numbers stay stable for the duration of the Pi session.
 */
export function registerPiContextHandler(
	pi: ExtensionAPI,
	baseOptions: PiContextHandlerOptions,
): void {
	const tagger = createTagger();
	const lkgCoordinator = createPiLkgCoordinator(
		baseOptions.db,
		undefined,
		({ sessionId, elapsedMs, reusedPrefix }) =>
			logTransformElapsed(
				sessionId,
				"lkgCapture",
				elapsedMs,
				`reusedPrefix=${reusedPrefix}`,
			),
	);

	// Pi can switch projects mid-process (`/cd`, multi-root). A scheduler is
	// pure (config in, decision out — no per-session state), so it's safe to
	// rebuild per project. We memoize one scheduler per distinct PiScheduler
	// options instance so the hot path doesn't reparse TTL every pass; the
	// per-cwd options are already memoized by the caller's resolveForProject.
	const schedulerCache = new WeakMap<PiSchedulerOptions, Scheduler>();
	const DEFAULT_SCHEDULER_CONFIG: PiSchedulerOptions = {
		executeThresholdPercentage: 65,
	};
	const schedulerFor = (opts: PiContextHandlerOptions): Scheduler => {
		const cfg = opts.scheduler ?? DEFAULT_SCHEDULER_CONFIG;
		let s = schedulerCache.get(cfg);
		if (!s) {
			s = createScheduler({
				executeThresholdPercentage: cfg.executeThresholdPercentage,
				executeThresholdTokens: cfg.executeThresholdTokens,
			});
			schedulerCache.set(cfg, s);
		}
		return s;
	};

	pi.on("thinking_level_select", async (event, ctx) => {
		if (event.previousLevel === event.level) return;
		const sessionId = resolveSessionId(ctx);
		if (!sessionId) return;
		const providerID = ctx.model?.provider;
		const modelID = ctx.model?.id;
		if (piVariantChangeBustsProviderCache(providerID, modelID)) {
			sessionLog(
				sessionId,
				`variant changed (${event.previousLevel} -> ${event.level}), triggering flush`,
			);
			historyRefreshSessions.add(sessionId);
			systemPromptRefreshSessions.add(sessionId);
			requestPendingMaterialization(
				pendingMaterializationSessions,
				sessionId,
				"variant_change",
			);
			lastHeuristicsTurnIdBySession.delete(sessionId);
			return;
		}
		const message = `variant changed (${event.previousLevel} -> ${event.level}) on ${providerID ?? "unknown"}/${modelID ?? "unknown"} without a proven natural cache bust; deferring flush to next natural bust`;
		variantChangeLogObserverForTests?.(message);
		sessionLog(sessionId, message);
	});

	const contextHandler: Parameters<typeof registerPiGuardedContext>[1] = async (
		event,
		ctx,
		budget,
	) => {
		// The guarded wrapper may start this handler late, after waiting for the
		// foreground SQLite reservation. If the pass was replaced, ended or ran
		// out of time meanwhile, stop before claiming the session's pass
		// generation: claiming it would mark a newer pass as superseded.
		budget.assertOutcome();
		const passSessionId = ctx.sessionManager
			? resolveSessionId(ctx)
			: undefined;
		const generation = Symbol();
		if (passSessionId && !budget.sideTurn)
			contextPassGeneration.set(passSessionId, generation);
		const signal = budget.signal;
		budget.assertOwner = createPiContextGenerationGuard(
			budget.assertOwner,
			passSessionId,
			generation,
			budget.sideTurn,
			signal,
		);
		let assertCurrentPass = budget.assert;
		const guardAwait = budget.wait;
		const passGuard = { assert: assertCurrentPass, wait: guardAwait };
		guardSqliteTransformPass({
			assert: assertCurrentPass,
			remainingMs: budget.remainingWork,
		});
		budget.stage = "schema";
		const toolWireSchema = await guardAwait(loadPiToolWireSchema());
		const transformStartTime = budget.startedAt;
		let rawMessageCount = 0;
		let rawFallbackLimit: number | undefined;
		let sessionIdForError: string | undefined;
		let systemHashForPass: string | undefined;
		const recordServedSystemHash = () => {
			if (budget.sideTurn || !sessionIdForError) return;
			if (systemHashForPass === undefined)
				lastServedSystemHashBySession.delete(sessionIdForError);
			else
				lastServedSystemHashBySession.set(sessionIdForError, systemHashForPass);
		};
		let lkgPassSnapshot: PiLkgPassSnapshot | undefined;
		let lkgCompactionOff = baseOptions.compactionOff === true;
		let lkgOptions = baseOptions;
		let lkgEmergencyRecoveryArmed = false;
		const captureServedEvidence = (
			...args: Parameters<typeof capturePiServedArray>
		) => {
			try {
				return capturePiServedArray(...args);
			} catch {
				budget.assertOutcome();
				notePiPublicationIssue(
					args[0],
					"identity_mirror_failed",
					"mirror_failed",
				);
				return undefined;
			}
		};
		try {
			const tFindSession = performance.now();
			const sessionId = resolveSessionId(ctx);
			if (sessionId === undefined) {
				// No active session — fall through with no mutation.
				log(
					"[magic-context][pi] context event fired with no session id (falling through unmodified)",
				);
				return;
			}
			sessionIdForError = sessionId;
			// Context runs after every before_agent_start handler. Measure the final
			// host prompt before storage admission, so an early validated LKG replay
			// also records the system bytes served alongside the replayed messages.
			try {
				const effectiveSystem = readHostSystemPrompt(ctx);
				if (effectiveSystem !== undefined)
					systemHashForPass = crypto
						.createHash("sha256")
						.update(effectiveSystem)
						.digest("hex");
			} catch {
				// A failed getter cannot prove that the provider's cached system bytes changed.
			}
			// Resolve a DB-independent wall before the first storage operation can fail.
			let piUsage:
				| ReturnType<NonNullable<ExtensionContext["getContextUsage"]>>
				| undefined;
			try {
				piUsage = ctx.getContextUsage?.();
			} catch {
				// Model metadata remains available if the host usage probe fails.
			}
			rawFallbackLimit = resolvePiWindowGeometry({
				rawContextWindow: piUsage?.contextWindow,
				model: ctx.model,
			})?.usableHard;
			const projectDirectory = ctx.cwd;
			rawMessageCount = event.messages.length;
			const fullWireMessageCount = rawMessageCount;

			// Resolve the effective options for THIS pass's project. On a `/cd`
			// switch this picks up the switched-into checkout's config (caller
			// memoizes per cwd). Falls back to baseOptions (launch cwd) when no
			// resolver is wired (tests) or the resolver returns nothing.
			const options =
				baseOptions.resolveForProject?.(projectDirectory) ?? baseOptions;
			lkgOptions = options;
			const projectIdentity =
				resolveProjectIdentityForSession(
					projectDirectory,
					options.allowHomeProject,
				) ?? "";
			// Queue history embedding before optional work can exhaust the context
			// budget, including the tag snapshot wait below: a cold session whose
			// tag load spends or refuses the pass must still schedule its backfill.
			// The callback yields before storage work, outside the foreground writer scope.
			withoutSqliteTransformPass(() =>
				options.maybeAutoEmbedSession?.(
					sessionId,
					projectDirectory,
					projectIdentity,
				),
			);
			if (!options.compactionOff) {
				budget.stage = "tag snapshot hydration";
				const hydration = ensurePiTagSnapshotReady(
					options.db,
					sessionId,
					budget,
				);
				if (hydration) await guardAwait(hydration);
			}
			const deliveryModelKey = resolvePiContextModelKey(ctx);
			if (!budget.sideTurn && deliveryModelKey) {
				const parentId = ctx.sessionManager.getLeafId?.();
				beginPiSystemPromptRequest(
					options.db,
					sessionId,
					deliveryModelKey,
					parentId === null || typeof parentId === "string"
						? { parentId, readBranch: () => ctx.sessionManager.getBranch() }
						: undefined,
				);
			}
			const schedulerConfig = options.scheduler ?? DEFAULT_SCHEDULER_CONFIG;
			const scheduler = schedulerFor(options);
			lkgCompactionOff = options.compactionOff === true;
			logTransformTiming(
				sessionId,
				"findSessionId",
				tFindSession,
				`messages=${event.messages.length}`,
			);

			budget.stage = "branch projection";
			const tEntryBranch = performance.now();
			const branchEntries = readPiBranchEntriesForContext(ctx, sessionId);
			assertCurrentPass();
			if (!budget.sideTurn)
				repairPiHistoryBoundary(options.db, sessionId, ctx, branchEntries);
			// Pi's live usage figure is a whole-raw-branch estimate while a context
			// edit or compaction follows the last recorded usage (e.g. after a
			// retried request); such a figure is never used as pressure.
			const piLiveUsageIsRawBranchEstimate =
				isPiLiveUsageRawBranchEstimate(branchEntries);
			recordPiLiveUsageClassification(
				sessionId,
				piLiveUsageIsRawBranchEstimate,
			);
			assertCurrentPass();
			// Raw side-turn snapshots are not acknowledgments of the main served prefix.
			if (!budget.sideTurn)
				schedulePiTransformDecisionResolve({
					db: options.db,
					sessionId,
					branchEntries,
					assertCurrentPass,
				});
			let rawOrdinalCount: number | undefined;
			// Stored ordinals may sit ahead of this branch walk; derive the offset
			// once per pass, on first use, from the same entries every reader below
			// numbers (pi-ordinal-alignment.ts).
			let passOrdinalAlignment: PiOrdinalAlignment | undefined;
			const ordinalAlignment = (): PiOrdinalAlignment =>
				(passOrdinalAlignment ??=
					branchEntries !== null
						? resolvePiOrdinalAlignment(options.db, sessionId, branchEntries)
						: resolvePiOrdinalAlignmentForContext(options.db, sessionId, ctx));
			const ordinalOffset = (): number => ordinalAlignment().offset;
			const rawMessageProvider = {
				getMessageCount: () =>
					(rawOrdinalCount ??=
						branchEntries !== null
							? countPiRawMessages(branchEntries, ordinalOffset())
							: readPiSessionMessages(ctx, ordinalOffset()).length),
				readMessages: () =>
					branchEntries !== null
						? convertEntriesToRawMessages(branchEntries, ordinalOffset())
						: readPiSessionMessages(ctx, ordinalOffset()),
				readMessagePage: (
					afterOrdinal: number,
					limit: number,
					finalWatermark: number,
				) =>
					branchEntries !== null
						? convertEntriesToRawMessagePage(
								branchEntries,
								afterOrdinal,
								limit,
								finalWatermark,
								ordinalOffset(),
							)
						: readPiSessionMessagePage(
								ctx,
								afterOrdinal,
								limit,
								finalWatermark,
								ordinalOffset(),
							),
				readMessageById: (messageId: string) =>
					readPiSessionMessageById(ctx, messageId, ordinalOffset()),
			};
			rawMessageProviderUnregistersBySession.get(sessionId)?.();
			const unregisterRaw = setRawMessageProvider(
				sessionId,
				rawMessageProvider,
			);
			rawMessageProviderUnregistersBySession.set(sessionId, unregisterRaw);
			// The search index files messages under stored ordinals; while those
			// cannot be placed on this branch, indexing would file branch-local
			// numbers under them, so it waits.
			const indexOrdinalsPlaceable = (): boolean =>
				!isPiOrdinalAlignmentUnanchored(ordinalAlignment());
			if (indexOrdinalsPlaceable())
				scheduleReconciliation(options.db, sessionId, readRawSessionMessages);
			const alignedEntryIds =
				branchEntries === null
					? null
					: getPiBranchEntryLookup(branchEntries).alignedEntryIds;
			const resolvedEntryIds = resolvePiEventEntryIds(
				ctx,
				event.messages as readonly PiAgentMessage[],
				sessionId,
				branchEntries,
			);
			const strictEntryIds = resolvedEntryIds ? [...resolvedEntryIds] : null;
			// runPipeline trims positional ids along with a compacted prefix.
			// Oh My Pi may present that raw prefix again, so remember the input ids.
			const taggedInputEntryIds = strictEntryIds ? [...strictEntryIds] : null;
			const lkgEntryIds = reconcilePiLkgEntryIds(
				strictEntryIds,
				alignedEntryIds,
			);
			const lkgModelKey = resolvePiContextModelKey(ctx) ?? null;
			const lkgContextModel = (ctx as { model?: { provider?: unknown } }).model;
			const lkgProviderKey =
				typeof lkgContextModel?.provider === "string"
					? lkgContextModel.provider
					: null;
			const snapshot = lkgCoordinator.beginPass({
				sessionId,
				messages: event.messages,
				entryIds: lkgEntryIds,
				modelKey: lkgModelKey,
				providerKey: lkgProviderKey,
				apiKey: ctx.model?.api ?? null,
				transport: (ctx.model as { transport?: string } | undefined)?.transport,
			});
			lkgPassSnapshot = snapshot;
			const recovery =
				budget.sideTurn || lkgCompactionOff
					? {}
					: lkgCoordinator.recoveryFor(snapshot);
			const lkgInputFields = new WeakMap(
				snapshot.inputs.flatMap((input) => {
					const message = event.messages[input.messageIndex];
					return message && typeof message === "object"
						? [[message, input.fields] as const]
						: [];
				}),
			);
			let checkedReplay = false;
			budget.stage = "writer admission";
			assertCurrentPass();
			const sessionMetaForUsage = await guardAwait(
				withAsyncPrivilegedWriter(
					options.db,
					() => {
						assertCurrentPass();
						// Keep BEGIN held through the session-meta read/create. Acquiring and
						// releasing an empty transaction would let another writer win before
						// this write. Subsequent tagging/materialization failures refuse the
						// turn rather than rerunning already committed work.
						return getOrCreateSessionMeta(options.db, sessionId);
					},
					{
						signal,
						budgetMs: budget.writerAllowance(),
						assertCurrentPass,
						jitter: true,
						beforeRetry: (error) => {
							assertCurrentPass();
							if (!lkgCompactionOff)
								assertPiTagSnapshotReady(options.db, sessionId);
							if (checkedReplay) return;
							checkedReplay = true;
							const state = loadPiHistorianStateSnapshot(options.db, sessionId);
							lkgEmergencyRecoveryArmed = state.needsEmergencyRecovery;
							if (state.detectedContextLimit > 0)
								rawFallbackLimit = resolvePiWindowGeometry({
									model: ctx.model,
									rawContextWindow: piUsage?.contextWindow,
									detectedContextLimit: state.detectedContextLimit,
								})?.usableHard;
							if (
								lkgCompactionOff ||
								recovery.rebuildReason ||
								lkgEmergencyRecoveryArmed ||
								isProviderOverflowFailClosedProven(sessionId)
							)
								return;
							const replay = lkgCoordinator.replay(
								snapshot,
								(id) => ctx.sessionManager.getEntry?.(id)?.parentId,
							);
							if (!replay.ok) return;
							try {
								assertPiRawFallbackFits(
									replay.messages,
									rawFallbackLimit,
									(line) => logPiLkgRecovery(sessionId, line),
									error,
									readPiLkgFitEnvelope(
										ctx,
										pi,
										lkgModelKey,
										sessionDecisionCalibration(options.db, sessionId),
										toolWireSchema,
									),
									replay.measuredPrefix,
								);
							} catch {
								return;
							}
							logPiLkgRecovery(
								sessionId,
								`TRANSIENT STORAGE FAILURE ${piStorageErrorReason(error)}: LKG replay served ${replay.messages.length} messages instead of raw ${rawMessageCount}`,
							);
							throw new PiLkgAdmissionReplay(replay.messages);
						},
					},
				),
			);
			assertCurrentPass();
			updateSessionProjectTracking(
				sessionId,
				projectIdentity,
				options.db,
				projectDirectory,
			);
			const lkgInputIdByRef = new Map<unknown, string>();
			for (const input of lkgPassSnapshot.inputs)
				lkgInputIdByRef.set(event.messages[input.messageIndex], input.id);
			// Binding-mismatch strips normally run on the final array at the end of
			// the pass, so every stage sees the same thinking on every pass. A
			// session whose strips predate that order keeps stripping here, before
			// any stage, until a pass that may change bytes switches it.
			const bindingStripOrder = resolvePiBindingStripOrder({
				db: options.db,
				sessionId,
				messages: event.messages as unknown[],
				entryIds: lkgEntryIds ?? [],
				bustPermittedAtStart: hasPendingMaterialization(sessionId),
			});
			const startOfPassBindingRecovery =
				bindingStripOrder === "start"
					? applyPiThinkingBindingRecovery({
							db: options.db,
							sessionId,
							messages: event.messages as unknown[],
							entryIds: lkgEntryIds ?? [],
							provider: lkgProviderKey ?? undefined,
							model: ctx.model?.id,
						})
					: null;
			// Maps each input message object to its branch entry id, so the strip at
			// the end of the pass can still identify messages the pipeline kept as
			// the same object.
			const bindingEntryIdByRef = new Map<unknown, string>();
			if (lkgEntryIds) {
				for (let index = 0; index < event.messages.length; index += 1) {
					const entryId = lkgEntryIds[index];
					if (entryId) bindingEntryIdByRef.set(event.messages[index], entryId);
				}
			}
			const tMeta = performance.now();
			const historianStateForPass = options.compactionOff
				? EMPTY_PI_HISTORIAN_STATE_SNAPSHOT
				: (() => {
						try {
							return loadPiHistorianStateSnapshot(options.db, sessionId);
						} catch (error) {
							sessionLog(
								sessionId,
								`historian state snapshot failed; using safe defaults: ${error instanceof Error ? error.message : String(error)}`,
							);
							return EMPTY_PI_HISTORIAN_STATE_SNAPSHOT;
						}
					})();
			let piM0M1PassSnapshot = options.injection
				? createPiM0M1PassSnapshot({
						db: options.db,
						sessionId,
						compactionOff: options.compactionOff === true,
						sessionMeta: sessionMetaForUsage,
					})
				: undefined;
			logTransformTiming(sessionId, "getOrCreateSessionMeta", tMeta);
			if (
				strictEntryIds &&
				branchEntries &&
				options.injection &&
				!options.compactionOff &&
				stripMcOwnedPiCompactionSummary(
					event.messages as PiAgentMessage[],
					strictEntryIds,
					branchEntries,
				)
			) {
				logTransformTiming(
					sessionId,
					"mcCompactionSummarySuppression",
					tEntryBranch,
				);
			}
			if (strictEntryIds && options.injection && !options.compactionOff) {
				const removed = trimPiMessagesToCachedBoundary(
					options.db,
					sessionId,
					event.messages as unknown as Parameters<
						typeof trimPiMessagesToCachedBoundary
					>[2],
					strictEntryIds,
					piM0M1PassSnapshot,
				);
				if (removed > 0) {
					logTransformTiming(
						sessionId,
						"cachedBoundaryEarlyTrim",
						tEntryBranch,
						`removed=${removed}`,
					);
				}
			}
			// Splice-safe message→entryId map keyed by reference. runPipeline
			// mutates the message array in place (compartment trim + placeholder
			// strip), so post-mutation consumers must resolve by identity, not by
			// the stale positional strictEntryIds.
			const entryIdByRef = buildEntryIdByRefMap(branchEntries);
			const previouslyTaggedIds =
				taggedStableMessageIdsBySession.get(sessionId);
			const reusableMessageIds = new Set<string>();
			if (strictEntryIds && previouslyTaggedIds) {
				for (const entryId of strictEntryIds) {
					if (entryId && previouslyTaggedIds.has(entryId)) {
						reusableMessageIds.add(entryId);
					}
				}
			}
			logTransformTiming(
				sessionId,
				"entryParseAndBranchResolution",
				tEntryBranch,
				`branchEntries=${branchEntries?.length ?? 0}`,
			);

			const tLastUser = performance.now();
			const latestUser = findLatestUserMessageIdPi(
				event.messages as PiAgentMessage[],
				buildPiMessageIdByIndex(
					event.messages as PiAgentMessage[],
					strictEntryIds,
				),
			);
			logTransformTiming(sessionId, "findLastUserMessageId", tLastUser);
			const tMessageIndexScheduling = performance.now();
			if (latestUser && indexOrdinalsPlaceable()) {
				const located = branchEntries
					? convertLocatedPiUserEntry(
							branchEntries,
							latestUser.messageId,
							ordinalOffset(),
						)
					: null;
				scheduleIncrementalIndex(
					options.db,
					sessionId,
					latestUser.messageId,
					located ??
						((_sessionId, messageId) =>
							readPiSessionMessageById(ctx, messageId, ordinalOffset())),
				);
			}
			logTransformTiming(
				sessionId,
				"messageIndexScheduling",
				tMessageIndexScheduling,
			);

			// Lazy-initialize tagger state from DB. Idempotent: re-init
			// during the same session is a no-op because the in-memory
			// counter is already populated. Required because the tag
			// counter persists across plugin restarts via the
			// `session_meta.counter` column.
			const taggerFloor = strictEntryIds
				? deriveTagLoadFloor(options.db, sessionId, strictEntryIds)
				: 0;
			tagger.initFromDb(sessionId, options.db, taggerFloor);
			taggersBySession.set(sessionId, tagger);
			const isFirstContextPassForSession =
				!firstContextPassSeenBySession.has(sessionId);
			firstContextPassSeenBySession.add(sessionId);

			const tModelDetect = performance.now();
			// Seed the in-memory model key from the JSONL on the first pass after a
			// (re)start. liveModelBySession is volatile, so without this a model
			// switch that happened while the process was DOWN would go undetected
			// (previousModelKey undefined → modelChanged false), leaking the prior
			// model's detected-context-limit / reasoning-watermark / historian-
			// failure state into the new model. The last model_change entry in the
			// branch is the session's last-used model; seeding it lets the
			// comparison below fire. No-op when the branch has no model_change
			// (older sessions) — previousModelKey stays undefined (today's behavior).
			// A model_change newer than the last reply is seeded from that reply's
			// model instead (see findRestartModelSeedFromBranch), so a switch made
			// before the first prompt after the restart is still detected.
			if (
				isFirstContextPassForSession &&
				liveModelBySession.get(sessionId) === undefined
			) {
				// Reuse the branch entries already read above (readPiBranchEntries
				// ForContext) — getBranch() must be walked only once per event.
				const seeded = findRestartModelSeedFromBranch(branchEntries);
				if (seeded !== undefined) {
					liveModelBySession.set(sessionId, seeded);
				}
			}
			const previousModelKey = liveModelBySession.get(sessionId);
			const currentModelKey = resolvePiContextModelKey(ctx);
			if (options.cacheTtlConfig !== undefined)
				sessionMetaForUsage.cacheTtl = resolveSessionCacheTtl(
					options.db,
					sessionId,
					options.cacheTtlConfig,
					currentModelKey,
					options.cacheTtlConfigured,
				).value;
			const modelChanged =
				previousModelKey !== undefined &&
				currentModelKey !== undefined &&
				piModelRefToCanonical(previousModelKey) !==
					piModelRefToCanonical(currentModelKey);
			if (currentModelKey !== undefined) {
				liveModelBySession.set(sessionId, currentModelKey);
			}
			logTransformTiming(sessionId, "modelChangeDetection", tModelDetect);
			const tPressureResolution = performance.now();

			// Resolve scheduler decision: execute-vs-defer based on TTL
			// + threshold. Drives whether heuristic cleanup runs on this
			// pass. Read live context usage from Pi (tokens/percent) and
			// the persisted session-meta record (last_response_time,
			// cache_ttl).
			// Prefer the OpenCode-equivalent pressure persisted by
			// `message_end` in `index.ts`. `session_meta.lastContextPercentage`
			// is computed from the assistant message's `usage` with the
			// same formula OpenCode uses (input + cacheRead + cacheWrite,
			// divided by `effectiveContextLimit` which already factors in
			// `detected_context_limit`). Pi's built-in `getContextUsage()`
			// `percent` field includes output tokens, which causes a
			// small but real drift in tests and a much larger drift after
			// a provider overflow recovery sets a lower detected limit.
			// Fall back to `piUsage` on the first pass before message_end
			// has had a chance to run.
			// The Pi equivalent of OpenCode marker cleanup is durable
			// pending_pi_compaction_marker_state plus these deferred-drain sets.
			// Reconcile before any transform phase so an off pass cannot drain or
			// render stale MC compaction state.
			const compactionTransition = reconcilePiCompactionMode({
				db: options.db,
				sessionId,
				compactionOff: options.compactionOff === true,
				historianRunnable: options.historian !== undefined,
			});
			if (compactionTransition.recordToWrite) {
				if (compactionTransition.clearDeferredMarkerState) {
					clearPiCompactionOffInMemoryState(sessionId);
				}
				if (compactionTransition.invalidatedBaseline) {
					clearPiInjectionTokenCountCache(sessionId);
					sessionMetaForUsage.cachedM0Bytes = null;
					sessionMetaForUsage.cachedM1Bytes = null;
					piM0M1PassSnapshot = options.injection
						? createPiM0M1PassSnapshot({
								db: options.db,
								sessionId,
								compactionOff: options.compactionOff === true,
								sessionMeta: sessionMetaForUsage,
								compartments: piM0M1PassSnapshot?.compartments,
							})
						: undefined;
				}
				let noticeDelivered = compactionTransition.notice === null;
				if (compactionTransition.notice && ctx.ui?.notify) {
					ctx.ui.notify(compactionTransition.notice, "info");
					noticeDelivered = true;
				}
				if (noticeDelivered) {
					commitPiCompactionModeRecord(
						options.db,
						sessionId,
						compactionTransition.recordToWrite,
					);
				}
			}
			// Model change invalidates the safe-token baseline + alert state too
			// (new model, new limits), so it clears all four pressure fields.
			const usageReset = {
				lastContextPercentage: 0,
				lastInputTokens: 0,
				observedSafeInputTokens: 0,
				cacheAlertSent: false,
			};
			if (modelChanged) {
				// Model change: clear UNCONDITIONALLY (not gated on stale usage).
				// The reasoning watermark, historian failure/recovery state, and
				// detected context limit were specific to the previous model and
				// must be discarded so the new model gets a clean slate — even when
				// the prior usage counters happen to read zero (e.g. a switch right
				// after a reset). Mirrors OpenCode transform.ts model-change reset,
				// which runs with no usage>0 guard.
				sessionLog(
					sessionId,
					`transform: model switch ${previousModelKey} -> ${currentModelKey} reset — percentage=${sessionMetaForUsage.lastContextPercentage.toFixed(1)}% tokens=${sessionMetaForUsage.lastInputTokens} — clearing stale model-specific state`,
				);
				updateSessionMeta(options.db, sessionId, {
					...usageReset,
					clearedReasoningThroughTag: 0,
				});
				clearHistorianFailureState(options.db, sessionId);
				clearPersistedReasoningWatermark(options.db, sessionId);
				clearDetectedContextLimit(options.db, sessionId);
				clearEmergencyRecovery(options.db, sessionId);
				// The emergency idempotence latch is keyed to the prior model's
				// ceiling; a smaller new model must re-evaluate the full tail.
				// Mirrors OpenCode hook-handlers.ts model-change reset.
				clearEmergencyDropSample(options.db, sessionId);
				sessionMetaForUsage.clearedReasoningThroughTag = 0;
				sessionMetaForUsage.lastContextPercentage = 0;
				sessionMetaForUsage.lastInputTokens = 0;
				sessionMetaForUsage.observedSafeInputTokens = 0;
				sessionMetaForUsage.cacheAlertSent = false;
			} else if (
				isFirstContextPassForSession &&
				sessionMetaForUsage.lastContextPercentage > 0
			) {
				// First pass after restart (same model): clear ONLY the two stale
				// pressure fields. Gate on lastContextPercentage>0 (matches OpenCode
				// transform.ts first-pass). historian-failure state and the
				// reasoning watermark MUST be preserved — restart recovery uses the
				// failure backoff, and clearing the reasoning watermark would
				// resurface previously cleared reasoning (a cache bust + larger
				// prompt). observedSafeInputTokens and cacheAlertSent are ALSO
				// preserved: the model is unchanged, so the learned safe-input
				// baseline still holds across the restart (OpenCode preserves it
				// too — only lastContextPercentage/lastInputTokens are cleared).
				sessionLog(
					sessionId,
					`transform: first pass reset — percentage=${sessionMetaForUsage.lastContextPercentage.toFixed(1)}% tokens=${sessionMetaForUsage.lastInputTokens} — clearing stale usage state`,
				);
				updateSessionMeta(options.db, sessionId, {
					lastContextPercentage: 0,
					lastInputTokens: 0,
				});
				sessionMetaForUsage.lastContextPercentage = 0;
				sessionMetaForUsage.lastInputTokens = 0;
			}
			let usagePercentage = 0;
			let usageInputTokens = 0;
			// Persisted usage (from message_end via persistPiPressureFromMessageEnd)
			// already has its percentage computed against the sane-bounded +
			// detected-limit-corrected effective limit, so it's authoritative and
			// must NOT be recomputed below. The fallback path (raw getContextUsage)
			// uses Pi's own denominator and DOES need correcting.
			let usedPersistedUsage = false;
			if (
				sessionMetaForUsage.lastContextPercentage > 0 &&
				sessionMetaForUsage.lastInputTokens > 0
			) {
				usagePercentage = sessionMetaForUsage.lastContextPercentage;
				usageInputTokens = sessionMetaForUsage.lastInputTokens;
				usedPersistedUsage = true;
			} else {
				usagePercentage =
					typeof piUsage?.percent === "number" ? piUsage.percent : 0;
				usageInputTokens =
					typeof piUsage?.tokens === "number" ? piUsage.tokens : 0;
			}
			// Sane-bound Pi's reported window the SAME way message_end does
			// (isSaneLimit, not `> 0`). A garbage-but-positive window (e.g. a
			// transient 6748) must be REJECTED here, not trusted — otherwise the
			// history budget collapses to a few hundred tokens and over-archives.
			let usageContextLimit = isSaneLimit(piUsage?.contextWindow)
				? piUsage.contextWindow
				: undefined;
			let usageContextWindowSource: "observed" | "catalog" = "catalog";
			let detectedContextLimit: number | undefined;

			// Overflow recovery: a previous LLM call ended with a
			// provider context-overflow error AND the pi.on("message_end")
			// handler persisted needs_emergency_recovery=1. On THIS pass:
			//
			//   1. If the error reported a real context limit, prefer
			//      that limit over Pi's reported contextWindow (which
			//      was clearly wrong if we just overflowed).
			//   2. Bump effective percentage to 95% so the existing
			//      emergency path (await historian + drop-all-tools)
			//      fires regardless of pressure math.
			//
			// Mirrors OpenCode's transform.ts wiring. The recovery flag is
			// cleared by the historian publication path on success (see
			// signalPiHistoryRefresh), so we won't keep bumping forever.
			const tEmergencyRecovery = performance.now();
			let needsEmergencyBump = false;
			let emergencyRecoveryArmed = false;
			try {
				const overflowState = historianStateForPass;
				if (overflowState.detectedContextLimit > 0) {
					detectedContextLimit = overflowState.detectedContextLimit;
					// Always prefer detected limit over reported window
					// when one exists — the reported window came from
					// metadata that produced a wrong answer last time.
					usageContextLimit = Math.min(
						usageContextLimit ?? overflowState.detectedContextLimit,
						overflowState.detectedContextLimit,
					);
				}
				emergencyRecoveryArmed = overflowState.needsEmergencyRecovery;
				lkgEmergencyRecoveryArmed = emergencyRecoveryArmed;
				// Pi's estimate of its entire unmodified history may be discarded below.
				// Keep the persisted overflow flag so pressure still reaches 95% afterward.
				needsEmergencyBump = overflowState.needsEmergencyRecovery;
			} catch (err) {
				sessionLog(
					sessionId,
					`transform: overflow state read failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			let sessionMeta = sessionMetaForUsage;
			const modelKey = liveModelBySession.get(sessionId);
			const providerId =
				typeof ctx.model?.provider === "string"
					? ctx.model.provider
					: undefined;
			// With temporal markers disabled and thinking strips delayed until the
			// end of the pass, adoption still sees these raw inputs. Reuse LKG's
			// detached fields unless the intervening test hook may edit them.
			const fallbackInputFields: RunPipelineArgs["fallbackInputFields"] =
				bindingStripOrder === "end" &&
				!options.injection?.temporalAwareness &&
				!beforePipelineForTests
					? lkgInputFields
					: undefined;
			const canUseEmptySentinels = modelAcceptsEmptyContent(providerId);
			// Cold-start stable-limit fallback: if `getContextUsage()` hasn't
			// reported a (sane) window yet (first pass after restart, before any
			// response), read the model's window directly from `ctx.model`
			// — Pi exposes it at model-select, independent of any message. This
			// is Pi's authoritative source (replacing the old models.dev lookup);
			// sane-bounded so a transient bad value can't shrink the budget to the
			// 60K default and over-archive. An unknown/insane window yields
			// undefined and we keep the live back-derivation path.
			if (usageContextLimit === undefined) {
				const modelWindow = ctx.model?.contextWindow;
				if (isSaneLimit(modelWindow)) {
					usageContextLimit = modelWindow;
					usageContextWindowSource = "catalog";
				}
			}
			const baseWindowGeometry = resolvePiWindowGeometry({
				rawContextWindow: usageContextLimit,
				rawContextWindowSource: usageContextWindowSource,
				model: ctx.model,
				detectedContextLimit,
			});
			rawFallbackLimit = baseWindowGeometry?.usableHard ?? rawFallbackLimit;
			const providerInputLimit = piPressureEvidenceLimit(baseWindowGeometry);
			const provenInputTokens = resolvePiProvenInputFloor({
				db: options.db,
				sessionId,
				modelKey: currentModelKey,
				readBranch: () => branchEntries ?? undefined,
				providerInputLimit,
			});

			const windowGeometry = resolvePiWindowGeometry({
				rawContextWindow: usageContextLimit,
				rawContextWindowSource: usageContextWindowSource,
				model: ctx.model,
				detectedContextLimit,
				provenInputTokens: provenInputTokens || undefined,
			});
			usageContextLimit = windowGeometry?.usableSoft;
			const effectiveExecuteThresholdPercentage = resolveExecuteThreshold(
				schedulerConfig.executeThresholdPercentage,
				modelKey,
				65,
				{
					tokensConfig: schedulerConfig.executeThresholdTokens,
					contextLimit: usageContextLimit,
					sessionId,
				},
			);
			const { forceMaterializationPercentage } = escalationBands(
				effectiveExecuteThresholdPercentage,
			);
			// Fallback-path percentage correction: when we DIDN'T use persisted
			// usage, `usagePercentage` is on Pi's raw denominator — which is wrong
			// once we've corrected the limit (detected-overflow cap, or a sane
			// window replacing a garbage one). Recompute against the corrected
			// limit so the scheduler's percentage check and the 85/95% cleanup
			// paths see the true pressure. (Persisted usage is already correct.)
			if (
				!usedPersistedUsage &&
				isSaneLimit(usageContextLimit) &&
				usageInputTokens > 0
			) {
				usagePercentage = (usageInputTokens / usageContextLimit) * 100;
			}
			let fallbackInputTokens: number | undefined;
			const suspectReading = Math.max(usageInputTokens, piUsage?.tokens ?? 0);
			if (
				suspectReading > providerInputLimit ||
				piProviderUsageWasRejected(sessionId)
			) {
				if (suspectReading > providerInputLimit)
					noteRejectedPiUsage(
						sessionId,
						suspectReading,
						providerInputLimit,
						"transform",
					);
				// Count request messages, replaying the last served prefix where it is
				// available. Pi rebuilds raw history on every pass; counting that old
				// prefix again would forget reductions already served to the model.
				const replay =
					!lkgCompactionOff && lkgPassSnapshot
						? lkgCoordinator.replay(
								lkgPassSnapshot,
								(id) => ctx.sessionManager.getEntry?.(id)?.parentId,
							)
						: undefined;
				const counts = tokenizePiMessages(
					replay?.ok ? replay.messages : event.messages,
				);
				const envelope = readPiLkgFitEnvelope(
					ctx,
					pi,
					currentModelKey,
					sessionDecisionCalibration(options.db, sessionId),
				);
				fallbackInputTokens =
					counts.conversation +
					counts.toolCall +
					(envelope?.systemTokens ?? 0) +
					(envelope?.toolDefinitionTokens ?? 0);
			}
			({ percentage: usagePercentage, inputTokens: usageInputTokens } =
				resolvePiPressureSnapshotWithEstimateGuard({
					providerInputLimit,
					fallbackInputTokens,
					sessionId,
					source: "transform",
					liveIsRawBranchEstimate: piLiveUsageIsRawBranchEstimate,
					persistedFromLive: !usedPersistedUsage,
					persistedPercentage: usagePercentage,
					persistedInputTokens: usageInputTokens,
					liveInputTokens: piUsage?.tokens,
					usableContextLimit: usageContextLimit,
				}));
			const realUsagePercentageBeforeEmergencyBump = usagePercentage;
			// Emergency bump LAST so it floors recovery pressure without capping
			// a higher live forward-pressure reading.
			if (needsEmergencyBump) {
				sessionLog(
					sessionId,
					`transform: overflow recovery flag set — bumping percentage to 95% (detectedLimit=${usageContextLimit ?? "unknown"})`,
				);
				usagePercentage = Math.max(usagePercentage, 95);
			}
			let schedulerDecision: "execute" | "defer";
			const tScheduler = performance.now();
			try {
				schedulerDecision = scheduler.shouldExecute(
					sessionMeta,
					{ percentage: usagePercentage, inputTokens: usageInputTokens },
					Date.now(),
					sessionId,
					modelKey,
					usageContextLimit,
				);
			} catch (err) {
				sessionLog(
					sessionId,
					`scheduler failed (defaulting to defer): ${err instanceof Error ? err.message : String(err)}`,
				);
				schedulerDecision = "defer";
			}
			logTransformTiming(sessionId, "schedulerAndUsage", tScheduler);

			// Migrated/imported sessions: a Pi session loaded with a large
			// existing JSONL has no usage data yet (pre-LLM-call) and no
			// `last_response_time` baseline, so the scheduler returns
			// "defer" on the brand-new-session branch — but the message
			// array IS already enormous and WILL overflow the model on
			// this turn. Force "execute" when the AgentMessage[] arriving
			// for transform is much larger than any healthy fresh session
			// would produce.
			//
			// Threshold: 50 messages. A normal first turn carries 1
			// system message + 1 user message; even a complex multi-step
			// first turn with tool calls would only reach ~10. 50 is
			// firmly in "this came from migration or session import"
			// territory and below it we keep the cache-friendly defer.
			const piMessageCount = fullWireMessageCount;
			const looksLikeImportedSession =
				schedulerDecision === "defer" &&
				usagePercentage === 0 &&
				sessionMeta.lastResponseTime === 0 &&
				piMessageCount >= 50;
			if (looksLikeImportedSession && !options.compactionOff) {
				schedulerDecision = "execute";
				sessionLog(
					sessionId,
					`transform: large imported session detected (${piMessageCount} messages, no usage baseline) — forcing execute on first pass`,
				);
			}
			logTransformTiming(sessionId, "pressureResolution", tPressureResolution);

			// Pi stable-id scheme cutover (one-time, per session). When this
			// session's persisted tags/source_contents/caveman/placeholder state
			// were keyed under the OLD index-based pi-msg-* scheme (stored scheme <
			// PI_STABLE_ID_SCHEME, NULL = 0 = legacy), switching to real-entry-id
			// ids re-keys every row → the tagger re-tags and prior drops orphan.
			// Force ONE controlled execute+materialize pass so heuristic cleanup
			// re-drops by tag content and the prefix rebuilds in a single bust
			// (rather than an uncontrolled defer-pass bust that could leak
			// full-size content). Also clear stripped_placeholder_ids so the
			// forced pass rediscovers placeholders under the new scheme. The new
			// scheme stamp is staged until every transform phase succeeds. A failed
			// cutover therefore retries placeholder discovery and fallback adoption on
			// the next pass instead of hiding legacy pi-msg-* replay state.
			const storedStableIdScheme = sessionMeta.piStableIdScheme ?? 0;
			// Only activate the cutover when REAL SessionEntry ids are available this
			// pass. The cutover re-keys persisted state from pi-msg-* index ids to
			// real entry ids; if branch resolution failed (strictEntryIds null →
			// pi-msg-* fallback), forcing an execute+materialize would burn a cache
			// bust without re-keying anything, then either false-complete (if we
			// stamped) or churn the placeholder set under pi-msg-* ids. Defer the
			// whole cutover to a later pass when getBranch() succeeds.
			const realEntryIdsAvailable =
				strictEntryIds?.some((id) => typeof id === "string" && id.length > 0) ??
				false;
			const stableIdSchemeCutover =
				storedStableIdScheme < PI_STABLE_ID_SCHEME && realEntryIdsAvailable;
			if (
				storedStableIdScheme < PI_STABLE_ID_SCHEME &&
				!realEntryIdsAvailable
			) {
				sessionLog(
					sessionId,
					`stable-id scheme cutover deferred: real SessionEntry ids unavailable this pass (branch resolution failed) — will retry when getBranch() succeeds`,
				);
			}
			if (stableIdSchemeCutover && !options.compactionOff) {
				schedulerDecision = "execute";
				signalPiPendingMaterialization(sessionId, "tag_identity_repair");
				// Re-keying of stripped_placeholder_ids from pi-msg-* to real ids is
				// done by the strip's own prune this pass (forceDiscovery + carried
				// map → finalIds = idsToStrip ∩ presentIds, and stale pi-msg-* ids
				// aren't in the real-id presentIds, so they're dropped atomically
				// within the strip's persist). We deliberately do NOT pre-clear the
				// set here: an early clear before the pass succeeds would lose the
				// placeholder set on a mid-pass failure, and forceDiscovery keeps
				// retrying every pass until the scheme stamps anyway.
				sessionLog(
					sessionId,
					`stable-id scheme cutover: stored=${storedStableIdScheme} < current=${PI_STABLE_ID_SCHEME} — forcing execute+materialize this pass`,
				);
			}

			const tBoundaryChecks = performance.now();
			const schedulerDeferReason =
				schedulerDecision === "defer" ? ("scheduler_defer" as const) : null;

			// At the derived force band, evaluate tiered target-headroom reclaim.
			const forceMaterialization =
				!options.compactionOff &&
				usagePercentage >= forceMaterializationPercentage;
			// Require five points below the force band so a batch-induced dip cannot
			// immediately rearm another cache rewrite as the tail regrows.
			if (
				usagePercentage > 0 &&
				usagePercentage < forceMaterializationPercentage - 5 &&
				getEmergencyInputSample(options.db, sessionId) > 0
			) {
				clearEmergencyDropSample(options.db, sessionId);
			}

			// Prefer already-published history and available tools. Prose-only history
			// needs the historian's summary before its queued drops can reclaim bytes.
			const hardUsagePercentage = needsEmergencyBump
				? Math.max(EMERGENCY_BLOCK_PERCENTAGE, usagePercentage)
				: windowGeometry?.usableHard && usageInputTokens > 0
					? (usageInputTokens / windowGeometry.usableHard) * 100
					: usagePercentage;
			// Direct/test callers without a model cannot resolve geometry. Keep the
			// prior denominator in that compatibility lane; production always has ctx.model.
			const emergencyPercentage = ctx.model
				? hardUsagePercentage
				: usagePercentage;
			const isEmergency =
				!options.compactionOff &&
				emergencyPercentage >= EMERGENCY_BLOCK_PERCENTAGE;
			if (isEmergency) {
				const lastNotifiedAt =
					lastEmergencyNotificationAtMs.get(sessionId) ?? 0;
				const now = Date.now();
				if (now - lastNotifiedAt >= EMERGENCY_NOTIFICATION_COOLDOWN_MS) {
					lastEmergencyNotificationAtMs.set(sessionId, now);
					sendPiIgnoredNotification(
						ctx,
						"Context full — /ctx-flush or /clear to continue.",
					);
					sessionLog(
						sessionId,
						`EMERGENCY: usage=${usagePercentage.toFixed(1)}% — notified user, evaluating available emergency reclaim`,
					);
				}

				const historian = inFlightHistorian.get(sessionId);
				const visibleToolResults = new Set(
					(event.messages as PiAgentMessage[]).flatMap((message) =>
						message.role === "toolResult" ? [message.toolCallId] : [],
					),
				);
				const toolTags = getTagsBySession(options.db, sessionId).filter(
					(tag) => tag.type === "tool",
				);
				const knownTools = new Set(toolTags.map((tag) => tag.messageId));
				const activeTools = new Set(
					toolTags
						.filter((tag) => tag.status === "active")
						.map((tag) => tag.messageId),
				);
				const hasToolReclaim = (event.messages as PiAgentMessage[]).some(
					(message) =>
						message.role === "assistant" &&
						message.content.some(
							(part) =>
								part.type === "toolCall" &&
								visibleToolResults.has(part.id) &&
								(!knownTools.has(part.id) || activeTools.has(part.id)),
						),
				);
				if (
					historian &&
					!hasToolReclaim &&
					getPendingOps(options.db, sessionId).length === 0 &&
					!historyRefreshSessions.has(sessionId) &&
					!deferredHistoryRefreshSessions.has(sessionId)
				) {
					budget.stage = "emergency historian";
					// Charge the join to the existing optional clock, leaving the outcome
					// reserve for replay or refusal. A timeout must not serve unreduced input.
					await budget.wait(historian);
					assertCurrentPass();
					// Publication happened after the pass snapshot. Read both the new
					// summary and its boundary so the queued drops are safe on this pass.
					sessionMeta = getOrCreateSessionMeta(options.db, sessionId);
					piM0M1PassSnapshot = options.injection
						? createPiM0M1PassSnapshot({
								db: options.db,
								sessionId,
								compactionOff: false,
								sessionMeta,
							})
						: undefined;
				}

				// Disarm a stuck emergency-recovery flag only after real pressure has
				// fallen below the force-materialization threshold. The flag must survive
				// while the session is genuinely oversized; clearing it early would expose
				// the next send to another overflow. Once the user has freed enough context,
				// the emergency bump is stale and can stop forcing every pass to 95%. The
				// detected context limit is left intact as authoritative model data.
				if (
					emergencyRecoveryArmed &&
					realUsagePercentageBeforeEmergencyBump <
						forceMaterializationPercentage &&
					!inFlightHistorian.has(sessionId) &&
					!hasEligiblePiCompartmentHistory(options.db, sessionId)
				) {
					try {
						clearEmergencyRecovery(options.db, sessionId);
						sessionLog(
							sessionId,
							"EMERGENCY: disarming recovery — no eligible pre-tail history to compact (would otherwise loop at 95%)",
						);
					} catch (err) {
						sessionLog(
							sessionId,
							`EMERGENCY: clearEmergencyRecovery failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			}

			// `isCacheBusting` controls whether the injection cache is
			// bypassed for the `<session-history>` block. ONLY reads
			// `historyRefreshSessions` — the narrow injection-rebuild
			// signal — to mirror OpenCode's transform.ts:444 exactly.
			//
			// Critical: do NOT force a cache rebuild on every execute /
			// force / emergency pass. Those signal that THIS pass will
			// mutate tag state (drops, caveman, reasoning clearing), but
			// the rendered `<session-history>` block depends only on
			// stored compartments/facts/memories, which only change
			// when historian publishes (which sets historyRefreshSessions
			// via the shared compartment-runner publish path).
			//
			// Without this separation, every execute pass rebuilds and
			// re-renders the history block — busting Anthropic prompt
			// cache on EVERY tool call once context crosses the execute
			// threshold, exactly the regression Oracle flagged.
			// PEEK-then-drain-on-success pattern (Oracle audit Round 8 #6):
			// capture the boolean here, but DELETE only after
			// `injectSessionHistoryIntoPi(...)` succeeds inside
			// `runPipeline`. If injection throws, the flag survives so
			// the next pass retries the rebuild. Defer passes within the
			// same TTL window still hit the cached injection result
			// because the consumer compares against the cached cutoff.
			const isCacheBusting = historyRefreshSessions.has(sessionId);
			logTransformTiming(sessionId, "boundaryTriggerChecks", tBoundaryChecks);

			sessionLog(
				sessionId,
				`transform: ${formatPiPressureForLog({ percentage: usagePercentage, inputTokens: usageInputTokens, contextLimit: usageContextLimit })} decision=${schedulerDecision}${forceMaterialization ? " force=true" : ""}${isEmergency ? " EMERGENCY=true" : ""}${isCacheBusting ? " busting=true" : ""}`,
			);
			logTransformTiming(
				sessionId,
				"emergencyRecoveryBlock",
				tEmergencyRecovery,
			);

			// Resolve SessionEntry IDs for each AgentMessage in event.messages
			// so the boundary lookup in `<session-history>` injection uses
			// the same id format historian persists. Reference-based
			// matching — see collectMessageEntryIdsByRef for why this is
			// preferred over the position-based collectMessageEntryIds.
			const entryIds = strictEntryIds ?? undefined;

			// Ceiling for the tiered emergency drop = contextLimit ×
			// executeThreshold%. Undefined when the limit isn't resolved → the
			// emergency drop skips that pass (95% block stays the backstop).
			const emergencyCeilingTokens =
				usageContextLimit && usageContextLimit > 0
					? Math.floor(
							usageContextLimit *
								// Ceiling from the SCHEDULER execute threshold (not
								// options.historian, which falls back to 65 and ignores
								// the user's execute_threshold_* when historian is off).
								(resolveExecuteThreshold(
									schedulerConfig.executeThresholdPercentage ?? 65,
									liveModelBySession.get(sessionId),
									65,
									{
										tokensConfig: schedulerConfig.executeThresholdTokens,
										contextLimit: usageContextLimit,
										sessionId,
									},
								) /
									100),
						)
					: undefined;

			logTransformTiming(sessionId, "prePipelineTotal", transformStartTime);
			const tRunPipeline = performance.now();
			budget.stage = "pipeline";
			// Tagging and reclaim must finish before the single 25s outcome deadline.
			// Optional search remains limited to 21s from handler entry.
			assertCurrentPass = budget.assertOutcome;
			guardSqliteTransformPass({
				assert: assertCurrentPass,
				remainingMs: budget.remainingOutcome,
			});
			if (beforePipelineForTests)
				await budget.waitMandatory(beforePipelineForTests());
			assertCurrentPass();
			const fitInputStart = hasPiTransformTimingObserver()
				? performance.now()
				: undefined;
			const nativeFitPossible =
				getHarness() === "pi" &&
				!options.compactionOff &&
				piFitOverflowPossible({
					hasUI: ctx.hasUI,
					inputTokens: usageInputTokens,
					// Reuse the saved-request rebuild signal; do not scan the old prefix here.
					recoveryArmed: emergencyRecoveryArmed || !!recovery.rebuildReason,
					forceMaterialization,
					imported:
						looksLikeImportedSession ||
						(usageInputTokens <= 0 &&
							(isFirstContextPassForSession ||
								lkgPassSnapshot?.replayFailure !== null)),
					coldInjection: !!options.injection && !sessionMeta.cachedM0Bytes,
					cacheBusting: isCacheBusting,
					sessionId,
					appendedMessages:
						lkgPassSnapshot?.pristineTail ?? event.messages.slice(-1),
					contextLimit: rawFallbackLimit,
					forcePercentage: forceMaterializationPercentage,
				});
			let inputForThinkingFit: unknown[] | null =
				(getHarness() !== "pi" || nativeFitPossible) &&
				isPrefixBoundThinkingModel(ctx.model?.provider, ctx.model?.id)
					? structuredClone(event.messages)
					: null;
			// Renderers can mutate parts, and JSONL lacks context added by extensions.
			// Preserve the original only for recovery, missing usage, near-capacity
			// input, a large new tail, or an invalidated cache; not steady low-pressure turns.
			let inputForFitReclaim: unknown[] | undefined = nativeFitPossible
				? (inputForThinkingFit ?? structuredClone(event.messages))
				: undefined;
			if (fitInputStart !== undefined)
				recordPiTransformTiming({
					sessionId,
					stage: "fitInputPreparation",
					elapsedMs: performance.now() - fitInputStart,
					extra: inputForFitReclaim ? "snapshot" : "no-snapshot",
				});
			const pipelineArgs: RunPipelineArgs = {
				recoveryPrefix: recovery.prefix,
				recoveryRebuildReason: recovery.rebuildReason,
				assertCurrentPass,
				db: options.db,
				tagger,
				sessionId,
				projectIdentity,
				projectDirectory,
				sessionMeta,
				effectiveSystemHash: systemHashForPass,
				messages: event.messages,
				lkgEntryIds: event.messages.map((message) =>
					lkgInputIdByRef.get(message),
				),
				smartDrops: options.smartDrops === true,
				protectedTools: options.protectedTools,
				protectedTags: options.protectedTags ?? 20,
				protectedTokens: options.protectedTokens,
				protectedTokenTierOverrides: options.protectedTokenTierOverrides,
				usableSoft: windowGeometry?.usableSoft ?? usageContextLimit ?? 200_000,
				reclaimUsableWindow:
					windowGeometry?.usableSoft ?? usageContextLimit ?? 0,
				heuristics: options.heuristics,
				emergencyCeilingTokens,
				injection: options.injection
					? {
							...options.injection,
							memoryEnabled: options.injection.memoryEnabled,
							// History decay uses the history budget, not the smaller memory
							// injection budget. Derive it from live usage and historian
							// configuration so history is retained consistently across hosts.
							historyBudgetPolicyIdentity: historyBudgetPolicyIdentity(
								options.historian?.historyBudgetPercentage,
								options.historian?.executeThresholdPercentage,
								liveModelBySession.get(sessionId),
								options.historian?.executeThresholdTokens,
							),
							historyBudgetTokens: resolveHistoryBudgetTokensForPi({
								historyBudgetPercentage:
									options.historian?.historyBudgetPercentage,
								usagePercentage,
								usageInputTokens,
								usageContextLimit,
								executeThresholdPercentage:
									options.historian?.executeThresholdPercentage,
								executeThresholdTokens:
									options.historian?.executeThresholdTokens,
								modelKey: liveModelBySession.get(sessionId),
							}),
						}
					: undefined,
				entryIds,
				entryIdByRef,
				reusableMessageIds,
				fallbackInputFields,
				stableIdSchemeCutover,
				schedulerDecision,
				schedulerDeferReason,
				// At 95% context usage, permit emergency materialization even
				// when the configured force percentage has not been reached.
				forceMaterialization: forceMaterialization || isEmergency,
				forceMaterializationPercentage,
				contextUsage: {
					percentage: usagePercentage,
					inputTokens: usageInputTokens,
				},
				isCacheBusting,
				userFlushOrigin: hasPendingMaterializationOrigin(
					pendingMaterializationSessions,
					sessionId,
					"user_flush",
				),
				reasoningClearing: {
					keepReasoningTokens: resolveKeepReasoningTokens(
						options.heuristics?.keepReasoningTokens,
						resolvePiContextModelKey(ctx),
					),
					nativeReasoningMayClear: canClearNativeReasoning(ctx.model),
					prefixBound: isPrefixBoundThinkingModel(
						typeof ctx.model?.provider === "string"
							? ctx.model.provider
							: undefined,
						typeof ctx.model?.id === "string" ? ctx.model.id : undefined,
					),
					preserveReasoningToolArcs:
						ctx.model?.api !== "openai-codex-responses" &&
						ctx.model?.api !== "openai-responses",
				},
				resolvedProviderID: ctx.model?.provider,
				resolvedModelID: ctx.model?.id,
				providerApi: ctx.model?.api,
				canUseEmptySentinels,
				temporalAwareness: options.injection?.temporalAwareness === true,
				appendCompaction: guardedPiAppendCompaction(ctx, assertCurrentPass),
				readBranchEntries: resolvePiReadBranchEntries(ctx),
				isSubagent: sessionMeta.isSubagent,
				compactionOff: options.compactionOff === true,
				injectionPassSnapshot: piM0M1PassSnapshot,
				readLastServedMessages: () => {
					const serialized = getPiLastServedArray(sessionId);
					try {
						return serialized ? JSON.parse(serialized) : null;
					} catch {
						return null;
					}
				},
				tryReplayHeldIdentityRebuild: () => {
					const replay = lkgCoordinator.replay(
						snapshot,
						(id) => ctx.sessionManager.getEntry?.(id)?.parentId,
					);
					if (!replay.ok) {
						sessionLog(
							sessionId,
							`Pi held identity rebuild: prior prefix unavailable (${replay.reason}); applying the declared rebuild`,
						);
						return;
					}
					try {
						assertPiRawFallbackFits(
							replay.messages,
							rawFallbackLimit,
							(line) => logPiLkgRecovery(sessionId, line),
							undefined,
							readPiLkgFitEnvelope(
								ctx,
								pi,
								lkgModelKey,
								sessionDecisionCalibration(options.db, sessionId),
								toolWireSchema,
							),
							replay.measuredPrefix,
						);
					} catch (error) {
						sessionLog(
							sessionId,
							`Pi held identity rebuild: prior prefix cannot fit (${String(error)}); applying the declared rebuild`,
						);
						return;
					}
					logPiLkgRecovery(
						sessionId,
						"Pi held identity rebuild: replaying the served prefix and retaining the pending repair",
					);
					throw new PiLkgAdmissionReplay(
						replay.messages,
						"held tag-identity rebuild: replaying the served prefix",
						"held_identity_repair",
					);
				},
			};
			if (!options.compactionOff)
				assertPiTagSnapshotReady(options.db, sessionId);
			let result = await budget.waitMandatory(runPipeline(pipelineArgs));
			observePipelineResultForTests(sessionId, result);
			logTransformTiming(sessionId, "runPipeline", tRunPipeline);
			if (result.identityRebuilt || result.lkgFrozenReleaseReason)
				schedulerDecision = "execute";
			const postPipelineStart = performance.now();
			const tTransformDecision = performance.now();
			// Replace the reuse window only after a successful pass. Bound it to the
			// latest raw context input, which can include entries the branch APIs no
			// longer expose, rather than accumulating every id seen in the session.
			if (strictEntryIds) {
				assertCurrentPass();
				recordSuccessfulTaggedMessageIds(
					sessionId,
					taggedInputEntryIds ?? strictEntryIds,
					branchEntries,
				);
			}
			const piDecisionSnapshotNewestAssistant =
				result.bustedThisPass || hasPendingPiSystemPromptHashChange(sessionId)
					? findNewestPiAssistantEntryId(branchEntries)
					: undefined;
			const publishTransformDecision =
				!budget.sideTurn && piDecisionSnapshotNewestAssistant !== undefined
					? () => {
							recordPendingPiTransformDecision(
								sessionId,
								{
									tsMs: Date.now(),
									decision: schedulerDecision,
									materialized: result.materialized,
									materializeReason: normalizeMaterializeReason(
										"pi",
										result.materializeReason,
										result.materialized,
									),
									systemHashPrev: result.materialized
										? (result.injectionResult?.systemHashPrev ?? null)
										: null,
									systemHashNew: result.materialized
										? (result.injectionResult?.systemHashNew ?? null)
										: null,
									m0ModelKeyPrev: result.materialized
										? (result.injectionResult?.m0ModelKeyPrev ?? null)
										: null,
									m0ModelKeyNew: result.materialized
										? (result.injectionResult?.m0ModelKeyNew ?? null)
										: null,
									emergency: result.emergency,
									droppedTokens: result.droppedTokens,
									droppedCount: result.droppedCount,
									inputTokens: usageInputTokens,
									bustedThisPass: true,
									lkgFrozenReleaseReason: result.lkgFrozenReleaseReason,
								},
								piDecisionSnapshotNewestAssistant,
								budget.assertDecisionPublication,
							);
						}
					: undefined;
			logTransformTiming(
				sessionId,
				"transformDecisionAndReuseState",
				tTransformDecision,
			);

			// After tagging and drops commit, an optional historian can start in
			// the background. A headless request proven too large joins it below
			// before deciding whether the rebuilt request can be sent.
			const tHistorianScheduling = performance.now();
			const historian = options.historian;
			budget.stage = "historian scheduling";
			if (historian && !options.compactionOff && budget.remainingWork() > 0) {
				guardSqliteTransformPass({
					assert: budget.assert,
					remainingMs: budget.remainingWork,
				});
				try {
					budget.assert();
					maybeFireHistorian({
						startGuard: () => {
							// A completed pass has already admitted the background run;
							// a following context pass must not cancel that admission.
							if (!budget.completed) budget.assertOwner();
							if (budget.abandoned || budget.remainingWork() === 0)
								throw new PiContextDeadlineError(budget.diagnostic());
						},
						pi,
						ctx,
						sessionId,
						db: options.db,
						historian,
						isFirstContextPassForSession,
						activeTags: result.activeTags,
						eligiblePendingDropTagIds: result.eligiblePendingDropTagIds,
						rawMessageProvider,
						ordinalAlignment: ordinalAlignment(),
						taggerFloor,
						sessionMeta,
						piUsage,
						pressureSnapshot: {
							percentage: usagePercentage,
							inputTokens: usageInputTokens,
						},
						minimumPercentage: usagePercentage,
						liveIsRawBranchEstimate: piLiveUsageIsRawBranchEstimate,
						historianStateSnapshot: historianStateForPass,
						publishedHistoryRide: isCacheBusting,
					});
				} catch (error) {
					budget.assertOutcome();
					sessionLog(
						sessionId,
						`historian scheduling skipped: ${String(error)}`,
					);
				} finally {
					guardSqliteTransformPass({
						assert: budget.assertOutcome,
						remainingMs: budget.remainingOutcome,
					});
				}
			}
			logTransformTiming(
				sessionId,
				"historianScheduling",
				tHistorianScheduling,
			);

			// Step 4b.4: nudge + note-nudge + auto-search hint. All three
			// run AFTER tagging/drops finish so they see the post-mutation
			// message shape. Each is independently optional and fail-open —
			// any thrown error is logged and the pipeline returns the
			// already-mutated messages unchanged.
			const tPostTransform = performance.now();
			let outputMessages = result.messages as PiAgentMessage[];
			let assertTailHygieneLastWriter: (() => void) | undefined;

			const postTransformSnapshot = (() => {
				try {
					return loadPiPostTransformSnapshot(options.db, sessionId);
				} catch (error) {
					sessionLog(
						sessionId,
						`post-transform snapshot failed; using independent reads: ${error instanceof Error ? error.message : String(error)}`,
					);
					return undefined;
				}
			})();
			// Sticky reminders and the synthetic todo pair this pass adds or moves
			// edit an earlier user or assistant message; the proactive thinking
			// strip below needs to know.
			const stickyBefore = postTransformSnapshot
				? piStickyInjectionKeys(postTransformSnapshot)
				: null;
			const todoAnchorBefore = JSON.stringify(
				getPersistedTodoSyntheticAnchor(options.db, sessionId),
			);
			const tNoteNudges = performance.now();
			try {
				if (!options.compactionOff) {
					outputMessages = applyNoteNudges({
						sessionId,
						db: options.db,
						messages: outputMessages,
						projectIdentity,
						entryIds: strictEntryIds,
						// Use the map produced after commits and splices because those operations
						// can change the final message-reference to entry-ID mapping.
						entryIdByRef: result.postCommitEntryIdByRef,
						// Sticky-anchor GC shares the pipeline's permission, including
						// its signed-prefix hold, rather than a refresh request alone.
						isCacheBusting:
							result.prefixBustPermitted && !result.strictThinkingKept,
						// Kept signatures also cover older reminder anchors.
						// These leading synthetic messages have no persisted entry IDs, so
						// exclude them from the sticky-anchor GC denominator.
						syntheticLeadingCount: result.syntheticLeadingCount,
						postTransformSnapshot,
					});
				}
			} catch (err) {
				sessionLog(
					sessionId,
					`note nudges failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			logTransformTiming(sessionId, "noteNudges", tNoteNudges);

			const tAutoSearch = performance.now();
			budget.stage = "auto-search";
			if (
				options.autoSearch?.enabled &&
				!options.compactionOff &&
				result.prefixMutationAllowed &&
				budget.remainingWork() > PI_CONTEXT_BUDGET.searchMs
			) {
				guardSqliteTransformPass({
					assert: budget.assert,
					remainingMs: budget.remainingWork,
				});
				try {
					outputMessages = await guardAwait(
						runAutoSearchHintForPi({
							passGuard,
							sessionId,
							db: options.db,
							messages: outputMessages,
							entryIds: strictEntryIds,
							// Use the map produced after commits and splices because those operations
							// can change the final message-reference to entry-ID mapping.
							entryIdByRef: result.postCommitEntryIdByRef,
							ensureProjectRegistered: () =>
								ensureProjectRegisteredFromPiDirectory(
									projectDirectory,
									options.db,
								),
							decisions: postTransformSnapshot?.autoSearchDecisions,
							options: {
								enabled: true,
								scoreThreshold: options.autoSearch.scoreThreshold,
								minPromptChars: options.autoSearch.minPromptChars,
								projectPath: projectIdentity,
								visibleMemoryIds:
									getVisibleMemoryIds(options.db, sessionId) ?? null,
								// `language` is user-level only; a project config cannot set it.
								wordRules: cavemanWordRulesForLanguage(options.language),
							},
						}),
					);
				} catch (err) {
					assertCurrentPass();
					sessionLog(
						sessionId,
						`auto-search failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				} finally {
					guardSqliteTransformPass({
						assert: budget.assertOutcome,
						remainingMs: budget.remainingOutcome,
					});
				}
			}
			logTransformTiming(sessionId, "autoSearch", tAutoSearch);

			// Synthetic todowrite injection — Pi parity with OpenCode's
			// transform-postprocess-phase.ts B7. On cache-busting passes,
			// inject a Pi-shape toolCall + toolResult pair built from the
			// `session_meta.last_todo_state` snapshot captured by
			// `tool_execution_start` in index.ts. On defer passes, replay
			// the same pair from the persisted snapshot to keep wire bytes
			// byte-identical (Anthropic prompt cache stability).
			//
			// Reuse the pipeline's permission, including its signed-prefix hold;
			// a pending history refresh alone cannot authorize a new todo pair.
			//
			// Subagents do not receive these synthetic todo reminders, matching
			// OpenCode's primary-session-only policy.
			const tTodoCapture = performance.now();
			const injectTodo = () => {
				try {
					const sessionMetaForTodo = sessionMeta;
					if (
						options.todowriteEnabled === true &&
						!options.compactionOff &&
						!sessionMetaForTodo.isSubagent &&
						sessionMetaForTodo.lastTodoState !== ""
					) {
						const isCacheBustingForTodo =
							result.prefixBustPermitted && !result.strictThinkingKept;
						outputMessages = injectSyntheticTodowriteForPi({
							db: options.db,
							sessionId,
							isSubagent: sessionMetaForTodo.isSubagent,
							isCacheBusting: isCacheBustingForTodo,
							lastTodoState: sessionMetaForTodo.lastTodoState,
							messages: outputMessages as unknown as Parameters<
								typeof injectSyntheticTodowriteForPi
							>[0]["messages"],
						}) as unknown as typeof outputMessages;
					}
				} catch (err) {
					sessionLog(
						sessionId,
						`synthetic todowrite injection failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			};
			injectTodo();
			logTransformTiming(sessionId, "todoCapture", tTodoCapture);

			// Thinking-binding strips run last, on the array this pass serves, so the
			// pipeline sees the same thinking on every pass: a stage whose output
			// depends on whether an assistant carries thinking (a dropped tool arc
			// kept as a skeleton beside native reasoning, for example) then renders
			// identically on the pass that first strips a block and on every later
			// pass that replays the strip. Replays and an armed recovery come first;
			// a busting pass then removes the thinking its own edit invalidated.
			// Sessions that still strip before the pipeline stages had their strips
			// applied at the start of the pass and skip this step.
			const tThinkingBinding = performance.now();
			let hostEditBeforeNewestThinking = true;
			try {
				const stickyAfter = piStickyInjectionKeys(
					loadPiPostTransformSnapshot(options.db, sessionId),
				);
				hostEditBeforeNewestThinking =
					stickyBefore === null ||
					[...stickyAfter].some((key) => !stickyBefore.has(key)) ||
					JSON.stringify(
						getPersistedTodoSyntheticAnchor(options.db, sessionId),
					) !== todoAnchorBefore;
			} catch {
				// The reminder and todo state could not be read, so whether this
				// pass edited an earlier message is unknown. Treat it as edited:
				// stripping a still-valid block costs a cache rewrite, keeping an
				// invalidated one costs a rejected request.
			}
			const outputEntryIds = resolvePiLkgOutputEntryIds(
				outputMessages,
				result.syntheticLeadingCount,
				(message) =>
					result.lkgEntryIdByRef.get(message) ??
					result.postCommitEntryIdByRef.get(message) ??
					bindingEntryIdByRef.get(message),
			).map((entryId) => entryId ?? undefined);
			const thinkingBindingRecoveryApplied =
				bindingStripOrder === "end"
					? applyPiThinkingBindingRecovery({
							db: options.db,
							sessionId,
							messages: outputMessages as unknown[],
							entryIds: outputEntryIds,
							provider: lkgProviderKey ?? undefined,
							model: ctx.model?.id,
							endOfPassOrder: true,
							// A rebuild already records any new omissions it needs, but
							// must also replay saved omissions on every model. The proactive
							// stripper below does nothing for non-prefix-bound models.
							replayOnly:
								result.signedPrefixRewritten && result.prefixBustPermitted,
						})
					: startOfPassBindingRecovery;
			if (
				shouldRunPiProactiveThinkingStrip({
					compactionOff: options.compactionOff === true,
					bindingStripOrder,
					isSubagent: sessionMeta.isSubagent === true,
				})
			) {
				try {
					applyPiProactiveThinkingStrip({
						db: options.db,
						sessionId,
						messages: outputMessages as unknown[],
						entryIds: outputEntryIds,
						provider: lkgProviderKey ?? undefined,
						model: ctx.model?.id,
						// Host-side mutations share the pipeline's permission. A history
						// refresh alone cannot authorize changes before kept thinking:
						// signatures bind all preceding bytes. A permitted prefix rewrite
						// omits every signed block, including those in the active turn.
						cacheBustingPass:
							result.prefixBustPermitted &&
							!result.strictThinkingKept &&
							(result.signedPrefixRewritten ||
								isCacheBusting ||
								result.prefixRebuildAlreadyPriced ||
								(result.executedWorkThisPass &&
									(result.prefixEditBesidesReasoningTrim ||
										hostEditBeforeNewestThinking))),
						stripActiveTurn: result.signedPrefixRewritten,
						requirePersistence: !!recovery.rebuildReason,
						report: (line) => sessionLog(sessionId, line),
					});
				} catch (err) {
					if (recovery.rebuildReason) throw err;
					sessionLog(
						sessionId,
						`proactive thinking strip failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			logTransformTiming(sessionId, "thinkingBinding", tThinkingBinding);

			// Restore previously sent recovery bytes before counting the returned
			// content for nudge decisions and work totals. The content-unchanged
			// assertion must also compare that final array, not the temporary
			// renderer output which the provider never receives.
			if (recovery.prefix && !result.recoveryNormalized) {
				const priorIds = new Set(
					recovery.prefix.inputs.map((input) => input.id),
				);
				const newIds = new Set(
					snapshot.inputs
						.filter((input) => !priorIds.has(input.id))
						.map((input) => input.id),
				);
				const suffix = outputMessages.filter((message) => {
					const id =
						result.postCommitEntryIdByRef.get(message) ??
						result.lkgEntryIdByRef.get(message);
					return id !== undefined && newIds.has(id);
				});
				const prefix = JSON.parse(recovery.prefix.json) as PiAgentMessage[];
				const recoveredEntryIds = new Map(result.postCommitEntryIdByRef);
				prefix.forEach((message, index) => {
					const id = recovery.prefix?.outputEntryIds[index];
					if (id) recoveredEntryIds.set(message, id);
				});
				result.postCommitEntryIdByRef = recoveredEntryIds;
				outputMessages = [...prefix, ...suffix];
				result.syntheticLeadingCount = recovery.prefix.outputEntryIds.findIndex(
					(id) => id !== null,
				);
				if (result.syntheticLeadingCount < 0)
					result.syntheticLeadingCount = prefix.length;
			}

			// Walk Pi's final rendered entry stream once to calculate both nudge-channel
			// totals. A cache-busting pass replaces the saved baseline; a deferred pass
			// keeps it and adds only newly appended content and protection-boundary moves.
			const tChannelAccounting = performance.now();
			try {
				const sessionMetaForCh1 = sessionMeta;
				if (!options.compactionOff && !sessionMetaForCh1.isSubagent) {
					const { tags, protectedTagNumbers, pendingDropTagNumbers } =
						result.channelBaselineSnapshot;
					const stableId = (message: unknown): string | undefined =>
						message && typeof message === "object"
							? result.postCommitEntryIdByRef.get(message)
							: undefined;
					const hygieneCalibration = sessionDecisionCalibration(
						options.db,
						sessionId,
					);
					const hygieneUnitsVersion = transitionSessionHygieneUnits(
						options.db,
						sessionId,
						result.bustedThisPass,
						hygieneCalibration,
					);
					const previousBaseline = getPiChannel1Baseline(sessionId);
					const baseline = refreshPiTailHygieneBaseline({
						messages: outputMessages,
						providerApi: ctx.model?.api,
						tags,
						tagCacheKey: result.channelBaselineSnapshot.tagCacheKey,
						protectedTagNumbers,
						protectedTools: options.protectedTools,
						pendingDropTagNumbers,
						stableId,
						// Only active rows can be protected; the active projection gives
						// the same numbers without sorting every historical tag.
						protectedToolTags: protectedToolTagNumbers(
							result.channelBaselineSnapshot.activeTags,
							options.protectedTools,
						),
						syntheticLeadingCount: result.syntheticLeadingCount,
						cacheBusting: result.bustedThisPass,
						previous: previousBaseline,
						calibration:
							hygieneUnitsVersion >= HYGIENE_PROVIDER_UNITS_VERSION
								? hygieneCalibration
								: undefined,
						hygieneUnitsVersion,
					});
					const effective = effectivePiTailHygiene(baseline);
					// One line per invalidation event, not one per pass: the baseline
					// only carries a mismatch on the pass that re-measured because of it.
					if (baseline.lastPrefixMismatch) {
						sessionLog(
							sessionId,
							formatTailHygienePrefixMismatch(
								baseline.lastPrefixMismatch,
								baseline.baselineGeneration,
							),
						);
					}
					const durableGrace =
						baseline.evaluable && !baseline.generationInvalidated
							? captureChannel1PostReduceGraceBaseline(
									options.db,
									sessionId,
									effective.u,
								)
							: getChannel1NudgeState(options.db, sessionId);
					baseline.channel1PostReduceGrace =
						durableGrace.postReduceGracePending ||
						durableGrace.postReduceGraceBaselineU !== undefined
							? {
									pending: durableGrace.postReduceGracePending === true,
									baselineU: durableGrace.postReduceGraceBaselineU,
									preReduceLevel:
										durableGrace.postReduceGracePreLevel ?? durableGrace.level,
								}
							: undefined;
					const oldestReclaimableToolTags = getOldestActiveUnprotectedToolTags(
						options.db,
						sessionId,
						protectedTagNumbers,
					);
					const channelState = {
						...baseline,
						usableWindow: usageContextLimit ?? 0,
						realUserTurnCount: baseline.realUserTurnCount,
						reducedSinceRefresh: false,
						agentDropsAppliedThisPass: result.agentDropsAppliedThisPass,
						oldestReclaimableToolTags,
					};
					setPiChannel1Baseline(sessionId, channelState);

					const channel2Evaluation = evaluateChannel2(channelState);
					if (channel2Evaluation.evaluable) {
						try {
							rearmChannel2AfterMeasuredCollapse({
								db: options.db,
								sessionId,
								baseline: channelState,
								rebuilding: result.bustedThisPass,
								previous: previousBaseline,
							});
						} catch (error) {
							sessionLog(
								sessionId,
								`pi channel2 U-collapse reset failed: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
						if (channel2Evaluation.shouldTrigger) {
							casChannel2NudgeState(options.db, sessionId, "", "pending");
						} else {
							casChannel2NudgeState(options.db, sessionId, "pending", "");
						}
					}

					assertTailHygieneLastWriter = () =>
						assertPiTailHygieneContentUnchanged({
							messages: outputMessages,
							tags,
							protectedTagNumbers,
							pendingDropTagNumbers,
							stableId,
							syntheticLeadingCount: result.syntheticLeadingCount,
							expectedSignature: baseline.contentSignature,
						});
				} else {
					clearPiChannel1State(sessionId);
				}
			} catch (err) {
				const stale = getPiChannel1Baseline(sessionId);
				if (stale) {
					stale.evaluable = false;
					stale.generationInvalidated = true;
				}
				sessionLog(
					sessionId,
					`channel1 baseline / channel2 trigger failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			logTransformTiming(
				sessionId,
				"channelNudgeAccounting",
				tChannelAccounting,
			);

			// Work-metrics update runs on EVERY transform pass (not just
			// execute passes). The Pi compute helper is pure-read on
			// outputMessages; setSessionWorkMetrics is a pure write to
			// session_meta (no tag state, no message[0] mutation, no
			// cache-busting). Gating on executedWorkThisPass would mean
			// sessions sitting below execute threshold never see populated
			// values, making Pi's status surface permanently zero.
			const tWorkMetrics = performance.now();
			budget.stage = "bookkeeping";
			try {
				const metrics = computePiWorkMetrics(outputMessages as unknown[]);
				setSessionWorkMetrics(
					options.db,
					sessionId,
					metrics.newWorkTokens,
					metrics.totalInputTokens,
				);
			} catch (err) {
				sessionLog(
					sessionId,
					`work-metrics update failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			logTransformTiming(sessionId, "workMetrics", tWorkMetrics);

			const tStableIdSchemePersist = performance.now();
			if (stableIdSchemeCutover && !options.compactionOff) {
				// Scheme stamps only after the cutover pass completed. If this write
				// fails, the outer fail-open path ships the original messages and the
				// next pass repeats forced placeholder discovery.
				persistStableIdSchemeForRun(options.db, sessionId, {
					piStableIdScheme: PI_STABLE_ID_SCHEME,
				});
				invalidateTrueRawTokenCache({
					sessionId,
					reason: "pi.stable-id-scheme.changed",
				});
				sessionLog(
					sessionId,
					`stable-id scheme cutover complete — stamped scheme=${PI_STABLE_ID_SCHEME}`,
				);
			}
			logTransformTiming(
				sessionId,
				"stableIdSchemePersist",
				tStableIdSchemePersist,
			);

			logTransformTiming(sessionId, "postTransformPhase", tPostTransform);

			// Cast the rebuilt array back to the AgentMessage[] shape Pi's
			// ContextEventResult expects. The nudge/note/auto-search paths
			// preserve message identity for unchanged messages and only
			// rebuild the mutated ones, so this cast is safe at runtime.
			clearLastTransformErrorIfSet(
				options.db,
				sessionId,
				sessionMeta.lastTransformError,
			);
			logTransformTiming(sessionId, "postPipelineTotal", postPipelineStart);
			const transformElapsedMs = performance.now() - transformStartTime;
			recordPiTransformTiming({
				sessionId,
				stage: "total",
				elapsedMs: transformElapsedMs,
				extra: `messages=${outputMessages.length} targets=${result.targetCount}`,
			});
			sessionLog(
				sessionId,
				`transform completed in ${transformElapsedMs.toFixed(1)}ms (${outputMessages.length} messages, ${result.targetCount} targets, watermark: ${result.reasoningWatermark})`,
			);
			runPiDebugAssertion(assertTailHygieneLastWriter);
			const fitSelectionStart = hasPiTransformTimingObserver()
				? performance.now()
				: undefined;
			const checkOutgoingFit =
				!options.compactionOff &&
				(getHarness() === "pi"
					? nativeFitPossible ||
						result.bustedThisPass ||
						result.materialized ||
						isCacheBusting ||
						schedulerDecision === "execute"
					: result.executedWorkThisPass ||
						isCacheBusting ||
						schedulerDecision === "execute");
			if (fitSelectionStart !== undefined)
				recordPiTransformTiming({
					sessionId,
					stage: "fitAdmissionSelection",
					elapsedMs: performance.now() - fitSelectionStart,
					extra: checkOutgoingFit ? "estimate" : "skip",
				});
			if (checkOutgoingFit) {
				const envelope = readPiLkgFitEnvelope(
					ctx,
					pi,
					resolvePiContextModelKey(ctx),
					sessionDecisionCalibration(options.db, sessionId),
					toolWireSchema,
				);
				const measuredPrefix = lkgPassSnapshot
					? lkgCoordinator.measureOutgoingPrefix(
							lkgPassSnapshot,
							outputMessages,
							(id) => ctx.sessionManager.getEntry?.(id)?.parentId,
						)
					: undefined;
				// Exceeding Magic Context's earlier reclaim threshold or replay output
				// reservation is not proof that the model's actual window is exceeded.
				const outgoingFitLimit =
					getHarness() === "pi" && baseWindowGeometry
						? baseWindowGeometry.derivation.absoluteWall
						: rawFallbackLimit;
				let estimate = estimatePiOutgoingInputTokens(
					outputMessages,
					envelope,
					measuredPrefix,
					outgoingFitLimit,
				);
				let fitReclaimedThisPass = false;
				if (
					!inputForThinkingFit &&
					result.strictThinkingKept &&
					rawFallbackLimit &&
					estimate.refusalGrade &&
					(estimate.refusalTokens ?? estimate.tokens) > rawFallbackLimit
				) {
					const restored = restorePiLkgInputForFit(
						lkgPassSnapshot,
						branchEntries,
					);
					if (restored) inputForThinkingFit = restored;
				}
				if (
					inputForThinkingFit &&
					result.strictThinkingKept &&
					rawFallbackLimit &&
					estimate.refusalGrade &&
					(estimate.refusalTokens ?? estimate.tokens) > rawFallbackLimit
				) {
					result = await budget.waitMandatory(
						runPipeline({
							...pipelineArgs,
							messages: inputForThinkingFit,
							forceSignedRebuildForFit: true,
							forceMaterialization: true,
							// Rebuilding signed thinking does not turn estimated fit pressure
							// into real 95% usage or release the protected tool tail.
							contextUsage: pipelineArgs.contextUsage,
						}),
					);
					observePipelineResultForTests(sessionId, result);
					fitReclaimedThisPass = true;
					// This input was consumed by the retry; it is no longer pristine.
					inputForFitReclaim = undefined;
					outputMessages = result.messages as PiAgentMessage[];
					const retryIds = resolvePiLkgOutputEntryIds(
						outputMessages,
						result.syntheticLeadingCount,
						(message) =>
							result.lkgEntryIdByRef.get(message) ??
							result.postCommitEntryIdByRef.get(message),
					);
					applyPiProactiveThinkingStrip({
						db: options.db,
						sessionId,
						messages: outputMessages,
						entryIds: retryIds.map((id) => id ?? undefined),
						provider: ctx.model?.provider,
						model: ctx.model?.id,
						cacheBustingPass: result.prefixBustPermitted,
						stripActiveTurn: true,
					});
					estimate = estimatePiOutgoingInputTokens(
						outputMessages,
						envelope,
						undefined,
						rawFallbackLimit,
					);
				}
				const opaqueFallbackSteps =
					piOpaqueThinkingFallbackSteps(outputMessages);
				if (opaqueFallbackSteps > 0)
					sessionLog(
						sessionId,
						`opaque thinking fallback: steps=${opaqueFallbackSteps} tokensPerStep=1000 (native usage unavailable; telemetry only)`,
					);
				if (
					measuredPrefix?.previousMessages?.some((raw) => {
						const message = raw as {
							content?: Array<{ thinkingSignature?: string }>;
						};
						return (
							Array.isArray(message.content) &&
							message.content.some((part) => part.thinkingSignature)
						);
					})
				) {
					const previous = estimatePiOutgoingInputTokens(
						measuredPrefix.previousMessages,
						envelope,
					);
					sessionLog(
						sessionId,
						`thinking estimate drift: estimate=${previous.tokens} provider=${measuredPrefix.inputTokens} ratio=${(previous.tokens / measuredPrefix.inputTokens).toFixed(4)} (previous served request; telemetry only)`,
					);
				}
				if (
					result.signedPrefixRewritten &&
					rawFallbackLimit &&
					estimate.refusalGrade &&
					(estimate.refusalTokens ?? estimate.tokens) > rawFallbackLimit
				)
					throw contextRefusalError(
						"The request remains over the model window after stripping signed thinking and reclaiming context",
					);
				if (getHarness() === "pi") {
					const fitCase = classifyPiOutgoingFit(estimate, outgoingFitLimit);
					const currentUpperCursor = () =>
						piUpperReclaimCursor({
							sessionId,
							modelKey: resolvePiContextModelKey(ctx) ?? null,
							contextWindow: outgoingFitLimit,
							head: getOrCreateSessionMeta(options.db, sessionId),
							messageCount: fullWireMessageCount,
							snapshot: lkgPassSnapshot,
							input: inputForFitReclaim ?? event.messages,
						});
					const upperCursor =
						fitCase === "upper-estimate-pressure"
							? currentUpperCursor()
							: undefined;
					if (fitCase === "over-window-proof") {
						requestPiFitReclaimInput(sessionId);
					}
					if (fitCase === "fits-or-unknown") clearPiFitReclaimInput(sessionId);
					// Active thinking signatures bind earlier messages to the provider's
					// reasoning. Uncertain metadata size cannot authorize rewriting them;
					// provider overflow or proof that the request cannot fit can do so.
					const upperPassEligible =
						schedulerDecision === "execute" ||
						result.bustedThisPass ||
						result.prefixRebuildAlreadyPriced ||
						isCacheBusting ||
						forceMaterialization ||
						isEmergency;
					const reclaimHeld =
						fitCase === "upper-estimate-pressure" &&
						(result.strictThinkingKept ||
							!upperPassEligible ||
							!shouldReclaimPiUpperEstimate(options.db, upperCursor));
					if (reclaimHeld)
						sessionLog(
							sessionId,
							"outgoing fit: upper-estimate-pressure; reclaim held by signed prefix, deferred pass or used session latch",
						);
					if (
						fitCase === "upper-estimate-pressure" &&
						!reclaimHeld &&
						!inputForFitReclaim
					)
						// An unexpected over-count can prepare a clean input next pass.
						// Never copy an already-rendered prefix to retry its injection.
						requestPiFitReclaimInput(sessionId);
					if (
						fitCase !== "fits-or-unknown" &&
						!reclaimHeld &&
						!fitReclaimedThisPass &&
						!inputForFitReclaim
					)
						inputForFitReclaim = restorePiLkgInputForFit(
							lkgPassSnapshot,
							branchEntries,
						);
					if (
						fitCase !== "fits-or-unknown" &&
						!reclaimHeld &&
						!fitReclaimedThisPass &&
						inputForFitReclaim
					) {
						const reservation = upperCursor
							? reservePiUpperEstimateReclaim(options.db, upperCursor)
							: undefined;
						if (!upperCursor || reservation) {
							let reclaimCompleted = false;
							try {
								sessionLog(
									sessionId,
									`outgoing fit: ${fitCase}; attempting emergency reclaim`,
								);
								// Upper estimates may include metadata the provider never sees.
								// They request reclaim; only a proven minimum above the window
								// can block the outgoing request.
								if (
									fitCase === "over-window-proof" &&
									!ctx.hasUI &&
									historian
								) {
									maybeFireHistorian({
										pi,
										ctx,
										sessionId,
										db: options.db,
										historian,
										startGuard: budget.assert,
										isFirstContextPassForSession: false,
										activeTags: result.activeTags,
										eligiblePendingDropTagIds: result.eligiblePendingDropTagIds,
										rawMessageProvider,
										ordinalAlignment: ordinalAlignment(),
										taggerFloor,
										sessionMeta: getOrCreateSessionMeta(options.db, sessionId),
										piUsage,
										pressureSnapshot: {
											percentage: Math.max(95, usagePercentage),
											inputTokens: usageInputTokens,
										},
										minimumPercentage: 95,
										publishedHistoryRide: false,
										historianStateSnapshot: loadPiHistorianStateSnapshot(
											options.db,
											sessionId,
										),
									});
									const pending = inFlightHistorian.get(sessionId);
									if (pending) {
										budget.stage = "headless fit historian";
										await budget.wait(pending);
									}
								}
								budget.stage = "outgoing fit reclaim";
								const freshMeta = getOrCreateSessionMeta(options.db, sessionId);
								result = await budget.waitMandatory(
									runPipeline({
										...pipelineArgs,
										messages: inputForFitReclaim,
										sessionMeta: freshMeta,
										schedulerDecision: "execute",
										schedulerDeferReason: null,
										forceMaterialization: true,
										upperEstimateOnly: fitCase === "upper-estimate-pressure",
										forceSignedRebuildForFit: fitCase === "over-window-proof",
										isCacheBusting:
											historyRefreshSessions.has(sessionId) ||
											deferredHistoryRefreshSessions.has(sessionId),
										injectionPassSnapshot: options.injection
											? createPiM0M1PassSnapshot({
													db: options.db,
													sessionId,
													compactionOff: false,
													sessionMeta: freshMeta,
												})
											: undefined,
										contextUsage: {
											percentage: usagePercentage,
											inputTokens: usageInputTokens,
										},
									}),
								);
								outputMessages = result.messages as PiAgentMessage[];
								observePipelineResultForTests(sessionId, result);
								// Reclaim replaces the postprocessed output with a pristine-input
								// rebuild. Restore the todo pair before stripping and measuring it.
								injectTodo();
								if (upperCursor)
									recordPiUpperEstimateReclaim(
										options.db,
										currentUpperCursor() ?? upperCursor,
										reservation,
									);
								reclaimCompleted = true;
								applyPiProactiveThinkingStrip({
									db: options.db,
									sessionId,
									messages: outputMessages,
									entryIds: resolvePiLkgOutputEntryIds(
										outputMessages,
										result.syntheticLeadingCount,
										(message) =>
											result.lkgEntryIdByRef.get(message) ??
											result.postCommitEntryIdByRef.get(message),
									).map((id) => id ?? undefined),
									provider: ctx.model?.provider,
									model: ctx.model?.id,
									cacheBustingPass: result.prefixBustPermitted,
									stripActiveTurn: result.signedPrefixRewritten,
								});
								estimate = estimatePiOutgoingInputTokens(
									outputMessages,
									envelope,
									undefined,
									outgoingFitLimit,
								);
							} finally {
								if (!reclaimCompleted && upperCursor && reservation)
									// Releasing this owner's claim is safe after cancellation or
									// deadline expiry; it cannot publish a superseded request.
									withoutSqliteTransformPass(() =>
										releasePiUpperEstimateReclaim(
											options.db,
											upperCursor,
											reservation,
										),
									);
							}
						}
					}
				}
				const refusal = outgoingContextRefusal(
					estimate,
					rawFallbackLimit,
					protectedToolTokenCount(
						getActiveTagsBySession(options.db, sessionId),
						options.protectedTools,
						envelope ? calibrationForModelKey(envelope.modelKey) : undefined,
					),
				);
				if (refusal) throw contextRefusalError(refusal);
				if (
					getHarness() === "pi" &&
					classifyPiOutgoingFit(estimate, outgoingFitLimit) ===
						"over-window-proof"
				)
					throw new PiDegradedPassError("outgoing-over-window");
			}
			let serializedOutput: PiLkgSerializedOutput | undefined;
			let numbersCommitted = false;
			budget.stage = "LKG/served publication";
			// The outcome/ownership guard admits the request before reserving tag numbers.
			// They do not prove the provider saw the bytes: Oh My Pi can later refuse a
			// late, stale or ended turn. Keep its reservations and any saved last-good
			// request; ambiguous number conflicts use the existing one-time identity repair.
			// Normal transform work is finished. Serialization and publication use
			// the reserved completion margin, never a new budget or a raw fallback.
			budget.assertOutcome();
			guardSqliteTransformPass({
				assert: budget.assertOutcome,
				remainingMs: budget.remainingOutcome,
			});
			// Empty host history has neither new identities nor an input prefix to publish.
			if (
				!budget.sideTurn &&
				!lkgCompactionOff &&
				lkgPassSnapshot &&
				(rawMessageCount > 0 || result.servedTagNumbers?.size)
			) {
				let hostEnvelopeSignature: string | undefined;
				try {
					hostEnvelopeSignature = readPiLkgFitEnvelope(
						ctx,
						pi,
						resolvePiContextModelKey(ctx),
						sessionDecisionCalibration(baseOptions.db, sessionId),
						toolWireSchema,
					)?.envelopeSignature;
				} catch {
					/* Missing optional attribution must not prevent capturing the good prefix. */
				}
				budget.assertOutcome();
				try {
					// Preserve unreadable or newer-version session replay JSON rather than
					// overwrite state this build cannot interpret. The transformed request can still be served.
					readPiCommittedServedNumbers(options.db, sessionId);
					serializedOutput = lkgCoordinator.captureAppliedPass({
						publishServedNumbers: () =>
							publishPiServedNumbers(options.db, sessionId, [
								...getPiServedTagNumbers(sessionId, undefined, options.db),
								...(result.servedTagNumbers ?? []),
							]),
						assertCurrentPass: budget.assertOutcome,
						hostEnvelopeSignature,
						snapshot: lkgPassSnapshot,
						outputMessages,
						outputEntryIds: resolvePiLkgOutputEntryIds(
							outputMessages,
							result.syntheticLeadingCount,
							(message) =>
								result.postCommitEntryIdByRef.get(message) ??
								result.lkgEntryIdByRef.get(message),
						),
						// Refresh the replay request on every successful managed pass. If reductions
						// changed its representation, invalidate the stale request before replacement.
						cacheBusting: result.bustedThisPass,
						releaseRecovery:
							result.recoveryNormalized || !!recovery.rebuildReason,
					});
					numbersCommitted = true;
				} catch (error) {
					// Publication failure cannot admit an expired, cancelled or superseded context invocation.
					if (error instanceof LkgRecoveryFenceError)
						throw new PiServedIdentityError(error);
					try {
						invalidateCleanLkgRecoveryFence(sessionId, () =>
							loadPersistedLkgSlot(options.db, sessionId),
						);
					} catch (fenceError) {
						throw new PiServedIdentityError(fenceError);
					}
					budget.assertOutcome();
					// Do not attach the next assistant's provider-usage measurement to a
					// previous request when this newly served request was not captured.
					clearPiLkgSessionState(sessionId);
					if (error instanceof PiLkgUncapturable) {
						try {
							// Even without a replay snapshot, the tag numbers on the served bytes
							// must remain immutable. Record them only while the outcome clock admits this invocation.
							budget.assertOutcome();
							options.db
								.transaction(() => {
									budget.assertOutcome();
									publishPiServedNumbers(options.db, sessionId, [
										...getPiServedTagNumbers(sessionId, undefined, options.db),
										...(result.servedTagNumbers ?? []),
									]);
								})
								.immediate();
							budget.assertOutcome();
							numbersCommitted = true;
							notePiPublicationIssue(sessionId, error.reason, "numbers_only");
						} catch (numberError) {
							budget.assertOutcome();
							notePiPublicationIssue(
								sessionId,
								numberError instanceof PiServedEnvelopeUnavailable
									? "envelope_unreadable"
									: "number_write_failed",
								numberError instanceof PiServedEnvelopeUnavailable
									? "skipped"
									: "commit_failed",
							);
						}
					} else {
						const reason =
							error instanceof PiServedEnvelopeUnavailable
								? "envelope_unreadable"
								: error instanceof Error &&
										error.message === "Pi LKG/served publication failed"
									? "pair_commit_failed"
									: "capture_failed";
						notePiPublicationIssue(
							sessionId,
							reason,
							reason === "pair_commit_failed" ? "commit_failed" : "skipped",
						);
					}
				}
			}
			budget.assertOutcome();
			if (
				!budget.sideTurn &&
				(numbersCommitted || lkgCompactionOff || rawMessageCount === 0)
			)
				captureServedEvidence(sessionId, outputMessages, {
					db: !lkgCompactionOff ? options.db : undefined,
					servedTagNumbers: result.servedTagNumbers,
					serializedOutput,
					assertCurrentPass: budget.assertOutcome,
				});
			if (
				!budget.sideTurn &&
				result.identityRebuilt &&
				(numbersCommitted || lkgCompactionOff)
			)
				acknowledgePiIdentityRebuilds(options.db, sessionId);
			if (!budget.sideTurn)
				captureOpencodeReasoningBudgetStatus(
					sessionId,
					piReasoningStatusMessages(outputMessages),
					resolveKeepReasoningTokens(
						options.heuristics?.keepReasoningTokens,
						resolvePiContextModelKey(ctx),
					),
					isPrefixBoundThinkingModel(ctx.model?.provider, ctx.model?.id),
					sessionDecisionCalibration(options.db, sessionId).proseRatio,
				);
			if (thinkingBindingRecoveryApplied) {
				try {
					clearThinkingBindingRecoveryIf(
						options.db,
						sessionId,
						thinkingBindingRecoveryApplied.flagTarget,
					);
				} catch (error) {
					sessionLog(
						sessionId,
						`thinking binding recovery cleanup deferred: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			budget.assertOutcome();
			publishTransformDecision?.();
			if (
				!budget.sideTurn &&
				result.strictThinkingKept &&
				!result.signedPrefixRewritten &&
				!result.materialized
			)
				recordPiHeldSystemHead(sessionId, (ownsHistory) =>
					deferPiDeliveredSystemRefresh(sessionId, ownsHistory),
				);
			recordServedSystemHash();
			return { messages: outputMessages } as {
				messages: typeof event.messages;
			};
		} catch (err) {
			// Cancellation must not enter recovery or queue a failed-turn diagnostic,
			// including on hosts that report AbortError without exposing a signal.
			if (budget.isCancelled(err)) throw err;
			if (err instanceof PiTagHydrationError) {
				budget.failureReason = err.message;
				if (sessionIdForError) {
					try {
						prewarmPiTagSnapshot(lkgOptions.db, sessionIdForError);
					} catch {}
				}
				throw err;
			}
			budget.assertOutcome();
			budget.stage = "recovery";
			if (err instanceof PiServedIdentityError) {
				// Identity safety errors outside optional publication retain their existing
				// refusal policy. Post-commit mirror failures are handled at the successful-result boundary.
				if (sessionIdForError) clearPiLkgSessionState(sessionIdForError);
				throw piFallbackRefusal("served-identity-unavailable", err);
			}
			if (err instanceof PiLkgAdmissionReplay && sessionIdForError) {
				budget.assertOutcome();
				assertPiTagSnapshotReady(lkgOptions.db, sessionIdForError);
				// A queued tag-number repair uses its durable database row to keep
				// replaying the saved request until a rebuild may change old bytes.
				// It is not a failure to get SQLite's writer. Only replay caused by
				// that failure records new raw tail bytes here; marking the repair
				// path dirty would make an ordinary restart change a held prefix.
				if (lkgPassSnapshot && err.trigger === "writer_busy")
					lkgCoordinator.noteRecovery(lkgPassSnapshot, err.messages);
				if (!budget.sideTurn)
					captureServedEvidence(sessionIdForError, err.messages, {
						recoveryWithoutTagState: true,
						assertCurrentPass: budget.assertOutcome,
					});
				budget.assertOutcome();
				budget.recovery = err.recovery;
				recordServedSystemHash();
				return { messages: err.messages } as {
					messages: typeof event.messages;
				};
			}
			// Loud fail-closed / emergency aborts must reach the user — do not
			// swallow into native-compaction fallthrough.
			if (
				(isFailClosedBlockingError(err) ||
					err instanceof EmergencyFailClosedError) &&
				!baseOptions.compactionOff
			)
				throw err;
			if (
				!lkgCompactionOff &&
				sessionIdForError &&
				isProviderOverflowFailClosedProven(sessionIdForError)
			) {
				throw new EmergencyFailClosedError(
					"Emergency recovery transform failed; refusing an unbounded raw fallback",
					{ cause: err },
				);
			}
			const message = err instanceof Error ? err.message : String(err);
			budget.failureReason = message;
			const stack = err instanceof Error ? err.stack : undefined;
			const transientStorageFailure = isTransientPiStorageError(err);
			const identityConflict = findPiTagIdentityConflict(err);
			if (identityConflict) {
				if (sessionIdForError)
					taggersBySession.get(sessionIdForError)?.cleanup(sessionIdForError);
				throw identityConflict;
			}
			// Every failed managed pass is handled like a busy store: Pi's own
			// messages lack the session's persisted reductions, even if they fit.
			const degradedPass = !lkgCompactionOff;
			const replayOrRefuse = transientStorageFailure || degradedPass;
			const failureLabel = transientStorageFailure
				? "TRANSIENT STORAGE FAILURE"
				: "DEGRADED PASS";
			if (
				replayOrRefuse &&
				sessionIdForError &&
				lkgPassSnapshot &&
				!lkgCompactionOff &&
				!lkgEmergencyRecoveryArmed
			) {
				try {
					const replay = lkgCoordinator.recoveryFor(lkgPassSnapshot)
						.rebuildReason
						? {
								ok: false as const,
								reason:
									lkgPassSnapshot.replayFailure ?? "lkg_recovery_unproven",
							}
						: lkgCoordinator.replay(
								lkgPassSnapshot,
								(id) => ctx.sessionManager.getEntry?.(id)?.parentId,
							);
					if (replay.ok) {
						const reasoningPrefixes = recoveryReasoningPrefixes(
							replay.messages,
							"content",
						);
						// A later write can fail after earlier drops committed. Render those
						// decisions on the saved request now, not for the first time on defer.
						const entryIds = lkgCoordinator.recoveryEntryIds(lkgPassSnapshot);
						const recoverySessionId = sessionIdForError;
						const recoveryTranscript = createPiTranscript(
							replay.messages,
							sessionIdForError,
							entryIds.map((id) => id ?? undefined),
							{
								preserveReasoningToolArcs:
									ctx.model?.api !== "openai-codex-responses" &&
									ctx.model?.api !== "openai-responses",
								authorizeToolRemoval: (callId) =>
									authorizePiToolRemoval({
										db: lkgOptions.db,
										sessionId: recoverySessionId,
										callId,
										saved: getNativeReplayState(
											lkgOptions.db,
											recoverySessionId,
										).toolInputs,
										canApply: false,
									}),
							},
						);
						assertPiTagSnapshotReady(lkgOptions.db, sessionIdForError);
						const drops = getPiTagSnapshotView(
							lkgOptions.db,
							sessionIdForError,
						).filter((tag) => tag.status === "dropped");
						const changed = applyFlushedStatuses(
							sessionIdForError,
							lkgOptions.db,
							buildPersistedDropTargets(recoveryTranscript, drops, {
								allowReasoningPrefixRewrite: true,
							}),
							drops,
						);
						const working = recoveryTranscript.getWorkingMessages();
						recoveryTranscript.commit();
						const idsByOutput = new Map<unknown, string | null>(
							working.map((message, index) => [message, entryIds[index]]),
						);
						recoveryTranscript.finalizeToolRemovals();
						// Applying already stored drops does not authorize new history edits.
						// Removing every thinking block needs a successful rebuild that also
						// persists those omissions. Refuse here instead of removing thinking
						// on a fallback that may run while scheduled edits are deferred.
						if (
							JSON.stringify(
								recoveryReasoningPrefixes(replay.messages, "content"),
							) !== JSON.stringify(reasoningPrefixes)
						)
							throw new DegradedPassRefusalError(
								"lkg-reasoning-prefix-changed",
								{ cause: err },
							);
						const recoveryIds = replay.messages.map(
							(message) => idsByOutput.get(message) ?? null,
						);
						// A valid stored prefix does not bound the newly appended raw tail.
						assertPiRawFallbackFits(
							replay.messages,
							rawFallbackLimit,
							(line) => {
								if (sessionIdForError)
									logPiLkgRecovery(sessionIdForError, line);
							},
							err,
							readPiLkgFitEnvelope(
								ctx,
								pi,
								resolvePiContextModelKey(ctx),
								sessionDecisionCalibration(baseOptions.db, sessionIdForError),
								toolWireSchema,
							),
							changed ? undefined : replay.measuredPrefix,
						);
						const reason = piStorageErrorReason(err);
						logPiLkgRecovery(
							sessionIdForError,
							`${failureLabel} ${reason}: LKG replay served ${replay.messages.length} messages instead of raw ${rawMessageCount}`,
						);
						budget.assertOutcome();
						lkgCoordinator.noteRecovery(
							lkgPassSnapshot,
							replay.messages,
							recoveryIds,
						);
						if (!budget.sideTurn)
							captureServedEvidence(sessionIdForError, replay.messages, {
								recoveryWithoutTagState: true,
								assertCurrentPass: budget.assertOutcome,
							});
						budget.assertOutcome();
						budget.recovery = "fitting LKG replay";
						recordServedSystemHash();
						return { messages: replay.messages } as unknown as {
							messages: typeof event.messages;
						};
					}
					logPiLkgRecovery(
						sessionIdForError,
						`${failureLabel} ${piStorageErrorReason(err)}: LKG unavailable (${replay.reason}); refusing unreduced ${rawMessageCount}-message input`,
					);
				} catch (replayError) {
					if (replayError instanceof PiTagHydrationError) throw replayError;
					budget.assertOutcome();
					if (replayError instanceof DegradedPassRefusalError)
						throw replayError;
					if (replayError instanceof PiStorageBusyError) throw replayError;
					logPiLkgRecovery(
						sessionIdForError,
						`${failureLabel} ${piStorageErrorReason(err)}: LKG replay unavailable (${replayError instanceof Error ? replayError.message : String(replayError)}); refusing unreduced ${rawMessageCount}-message input`,
					);
				}
			} else if (replayOrRefuse && sessionIdForError) {
				const refusal = lkgCompactionOff
					? "compaction_off"
					: lkgEmergencyRecoveryArmed
						? "lkg_emergency_armed"
						: (lkgPassSnapshot?.preparationFailure ?? "lkg_miss");
				logPiLkgRecovery(
					sessionIdForError,
					`${failureLabel} ${piStorageErrorReason(err)}: LKG unavailable (${refusal}); refusing unreduced ${rawMessageCount}-message input`,
				);
			}
			// Keep refusal outside the replay try/catch: it must reach Pi, not be
			// mistaken for another replay failure and swallowed into raw fallthrough.
			if (transientStorageFailure) throw new PiStorageBusyError({ cause: err });
			if (
				err instanceof PiDegradedPassError &&
				err.site === "outgoing-over-window"
			)
				throw contextRefusalError(
					"The request exceeds the model's context window after reclaim, and no fitting saved request is available; this turn was not sent.",
				);
			// Fit is not enough: raw messages omit persisted decisions even when
			// small. Only a validated last-good replay may serve a failed pass.
			// Without a resolved session there are no persisted decisions to omit
			// (Pi's runtime manager is missing), so the host's input passes through.
			if (!lkgCompactionOff && sessionIdForError) {
				throw piFallbackRefusal("context-handler-failed", err);
			}
			log(
				`[magic-context][pi] context handler failed (continuing without mutation): ${message}`,
				stack,
			);
			// Fall through with no mutation — Pi proceeds with original
			// messages, equivalent to a no-op transform pass.
			return;
		}
	};
	registerPiGuardedContext(pi, contextHandler, {
		compactionOff: (ctx) =>
			(baseOptions.resolveForProject?.(ctx.cwd) ?? baseOptions)
				.compactionOff === true,
		onRefusal: (ctx, budget, message, isCurrent) => {
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) return;
			withoutSqliteTransformPass(() =>
				setImmediate(() => {
					if (!isCurrent()) return;
					try {
						withSqliteBackgroundWriter(() =>
							persistLastTransformErrorIfChanged(
								baseOptions.db,
								sessionId,
								budget.failureReason ?? message,
							),
						);
					} catch (error) {
						log(
							`[magic-context][pi] refused-turn diagnostic not persisted ${budget.diagnostic()}`,
							error,
						);
					}
				}),
			);
		},
	});
	log(
		"[magic-context][pi] registered context handler (tagging + drops + nudges)",
	);
}

/**
 * Track in-flight historian runs per session so we don't fire a second
 * pass while the first is still running. The flag also exists in
 * session_meta.compartment_in_progress (see `runPiHistorian` setting
 * it), but that DB-side flag is durable across restarts and the
 * trigger logic already inspects it; this in-memory map is a
 * fast-path so we don't hit the DB just to dedupe per turn.
 *
 * We store the actual Promise (not just the session id) so the
 * `session_shutdown` handler can cancel and await outstanding runs.
 * Headless requests proven too large also join the tracked run within their
 * foreground context deadline before retrying reclaim and the fit check.
 */
const inFlightHistorian = new Map<string, Promise<unknown>>();
const historianAbortControllers = new Map<string, AbortController>();

export function abortInFlightHistorians(sessionId: string): void {
	historianAbortControllers.get(sessionId)?.abort();
}

/**
 * Wait for one session's in-flight historian run to complete. Called from the
 * Pi `session_shutdown` event handler so its historian can finish writing
 * compartments before that session shuts down. Omitting the session id waits
 * for all runs and remains available for process-exit callers and tests. Returns
 * immediately if no matching runs are in-flight.
 */
export async function awaitInFlightHistorians(
	sessionId?: string,
): Promise<void> {
	const runs = sessionId
		? [inFlightHistorian.get(sessionId)].filter(
				(run): run is Promise<unknown> => run !== undefined,
			)
		: [...inFlightHistorian.values()];
	if (runs.length === 0) return;
	await Promise.allSettled(runs);
}

export function resolvePiHistorianTriggerInputs(args: {
	db: ContextDatabase;
	sessionId: string;
	historian: PiHistorianOptions;
	modelKey: string | undefined;
	usageContextLimit?: number;
}): {
	executeThresholdPercentage: number;
	triggerBudget: number;
	protectedTags: number | undefined;
	keepReasoningTokens: number;
	commitClusterTrigger: { enabled: boolean; min_clusters: number } | undefined;
	contextLimit: number;
	/** ceiling = contextLimit × executeThreshold% (tiered emergency drop). */
	emergencyCeilingTokens: number;
} {
	// Pi resolves the context window from its own runtime (passed in as
	// usageContextLimit, derived from getContextUsage()/getModel().contextWindow
	// with the detected-overflow override already applied). models.dev is not
	// consulted for Pi. Fall back to the conservative default only when the
	// runtime hasn't reported a usable window yet.
	const contextLimit =
		typeof args.usageContextLimit === "number" &&
		Number.isFinite(args.usageContextLimit) &&
		args.usageContextLimit > 0
			? args.usageContextLimit
			: DEFAULT_CONTEXT_LIMIT;
	const executeThresholdPercentage = resolveExecuteThreshold(
		args.historian.executeThresholdPercentage ?? 65,
		args.modelKey,
		65,
		{
			tokensConfig: args.historian.executeThresholdTokens,
			contextLimit,
			sessionId: args.sessionId,
		},
	);
	return {
		executeThresholdPercentage,
		triggerBudget: deriveTriggerBudget(
			contextLimit,
			executeThresholdPercentage,
		),
		protectedTags: args.historian.protectedTags,
		keepReasoningTokens: resolveKeepReasoningTokens(
			args.historian.keepReasoningTokens,
			args.modelKey,
		),
		commitClusterTrigger: args.historian.commitClusterTrigger,
		contextLimit,
		emergencyCeilingTokens: Math.floor(
			contextLimit * (executeThresholdPercentage / 100),
		),
	};
}

export function selectPiHistorianRunBoundarySnapshot(args: {
	resolvedBoundarySnapshot: ProtectedTailBoundarySnapshot;
	triggerBoundarySnapshot?: ProtectedTailBoundarySnapshot;
}): ProtectedTailBoundarySnapshot {
	// The trigger may re-resolve under emergency pressure; the runner must
	// consume the exact boundary the fire decision evaluated, falling back only
	// for recovery paths that did not go through the trigger.
	return args.triggerBoundarySnapshot ?? args.resolvedBoundarySnapshot;
}

export function resolveHistoryBudgetTokensForPi(args: {
	historyBudgetPercentage: number | undefined;
	usagePercentage: number;
	usageInputTokens: number;
	usageContextLimit: number | undefined;
	executeThresholdPercentage: PiHistorianOptions["executeThresholdPercentage"];
	executeThresholdTokens: PiHistorianOptions["executeThresholdTokens"];
	modelKey: string | undefined;
}): number | undefined {
	const {
		historyBudgetPercentage,
		usagePercentage,
		usageInputTokens,
		usageContextLimit,
		executeThresholdPercentage,
		executeThresholdTokens,
		modelKey,
	} = args;
	if (!historyBudgetPercentage) return undefined;
	// Prefer the model's STABLE context limit (Pi reports contextWindow; an
	// overflow-detected limit overrides it). Only fall back to the live-usage
	// back-derivation when no stable limit is available — and that fallback
	// needs a positive percentage. The earlier `usagePercentage <= 0` early
	// return was too aggressive: on the first pass after restart Pi can report
	// percentage=0 while contextWindow is already known, which forced the
	// budget through to the hard-coded 60K default and over-archived history
	// (matches the OpenCode resolveHistoryBudgetTokens fix).
	const derivedLimit =
		usageContextLimit && usageContextLimit > 0
			? usageContextLimit
			: usagePercentage > 0 && usageInputTokens > 0
				? usageInputTokens / (usagePercentage / 100)
				: 0;
	if (!Number.isFinite(derivedLimit) || derivedLimit <= 0) return undefined;
	return Math.floor(
		derivedLimit *
			// Pass executeThresholdTokens so token-based per-model thresholds drive
			// the history budget identically to OpenCode (resolveHistoryBudgetTokens).
			// Without it, a session configured with execute_threshold_tokens would
			// get a different (percentage-only) decay budget than OpenCode → different
			// render tiers for the same state.
			(resolveExecuteThreshold(executeThresholdPercentage ?? 65, modelKey, 65, {
				tokensConfig: executeThresholdTokens,
				contextLimit: derivedLimit,
			}) /
				100) *
			historyBudgetPercentage,
	);
}

function startPiCompartmentLeaseRenewal(
	db: ContextDatabase,
	sessionId: string,
	holderId: string,
): ReturnType<typeof setInterval> {
	return inRootAsyncContext(() =>
		setInterval(() => {
			try {
				if (!renewCompartmentLease(db, sessionId, holderId)) {
					sessionLog(
						sessionId,
						"compartment lease renewal failed; publish will be skipped if holder is stale",
					);
				}
			} catch (err) {
				// A missed renewal is safe because the compartment lease has a five-minute TTL.
				sessionLog(
					sessionId,
					`compartment lease renewal threw; publish will be skipped if holder is stale (${err instanceof Error ? err.message : String(err)})`,
				);
			}
		}, COMPARTMENT_LEASE_RENEWAL_MS),
	);
}

function ensureRunnablePiBoundaryForTests(
	snapshot: ProtectedTailBoundarySnapshot,
): ProtectedTailBoundarySnapshot {
	if (
		process.env.NODE_ENV !== "test" ||
		hasRunnableCompartmentWindow(snapshot)
	) {
		return snapshot;
	}
	const rawEnd =
		(snapshot.rawMessageCountAtTrigger ?? snapshot.protectedTailStart) + 1;
	const endOrdinal = Math.min(
		rawEnd,
		Math.max(snapshot.offset + 2, snapshot.protectedTailStart),
	);
	return {
		...snapshot,
		protectedTailStart: endOrdinal,
		eligibleEndOrdinal: endOrdinal,
		trueRawEligibleTokens: Math.max(1, snapshot.trueRawEligibleTokens),
		rawRangeFingerprint: "",
	};
}

function hasEligiblePiCompartmentHistory(
	db: ContextDatabase,
	sessionId: string,
	boundarySnapshot?: ProtectedTailBoundarySnapshot,
): boolean {
	try {
		const rawEligibility = getRawHistoryEligibility(db, sessionId);
		if (!rawEligibility.hasRawBeyondLastCompartment) return false;
		if (!boundarySnapshot)
			return rawEligibility.offset <= rawEligibility.rawMessageCount;
		return hasRunnableCompartmentWindow(
			ensureRunnablePiBoundaryForTests(boundarySnapshot),
		);
	} catch (err) {
		sessionLog(
			sessionId,
			`historian recovery eligibility failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
}

function sendPiIgnoredNotification(
	ctx: ExtensionContext,
	message: string,
): void {
	const uiNotify = (ctx as { ui?: { notify?: (message: string) => unknown } })
		.ui?.notify;
	if (typeof uiNotify === "function") {
		try {
			const result = uiNotify.call(ctx.ui, message);
			if (
				result &&
				typeof (result as PromiseLike<unknown>).then === "function"
			) {
				void Promise.resolve(result).catch((error) =>
					sessionLog("pi", "UI notification rejected:", error),
				);
			}
			return;
		} catch {
			// Fall through to session log below.
		}
	}
	sessionLog("pi", message);
}

function spawnPiHistorianRun(args: {
	startGuard?: () => void;
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	sessionId: string;
	db: ContextDatabase;
	historian: PiHistorianOptions;
	provider: { readMessages: () => ReturnType<typeof readPiSessionMessages> };
	unregister: () => void;
	boundarySnapshot:
		| ProtectedTailBoundarySnapshot
		| (() => ProtectedTailBoundarySnapshot | undefined);
	refreshBoundarySnapshot?: () => ProtectedTailBoundarySnapshot;
	currentContextLimit: number;
	fallbackModelId?: string;
}): void {
	const {
		pi,
		ctx,
		sessionId,
		db,
		historian,
		provider,
		unregister,
		boundarySnapshot,
		refreshBoundarySnapshot,
		currentContextLimit,
		fallbackModelId,
	} = args;
	args.startGuard?.();
	const holderId = crypto.randomUUID();
	const controller = new AbortController();
	historianAbortControllers.set(sessionId, controller);
	const runPromise = inRootAsyncContext(() =>
		(async () => {
			// Defer the runner's synchronous prefix until the context handler has returned.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			if (controller.signal.aborted) return;
			// Do not start a historian after the pass's 21s optional cutoff.
			// Once started, its lease protects history-summary publication without
			// borrowing the foreground context deadline.
			args.startGuard?.();
			const lease = acquireCompartmentLease(db, sessionId, holderId);
			if (!lease) {
				sessionLog(
					sessionId,
					"historian skipped: compartment lease held by another process",
				);
				return;
			}
			if (isWrapupInProgress(db, sessionId)) {
				// Close the cross-process check/lease race: /ctx-wrapup may have published
				// its marker after the first check but before this process won the lease.
				sessionLog(sessionId, "historian skipped: /ctx-wrapup became active");
				releaseCompartmentLeaseBestEffort(db, sessionId, holderId, sessionLog);
				return;
			}
			const renewal = startPiCompartmentLeaseRenewal(db, sessionId, holderId);
			try {
				const runBoundary =
					typeof boundarySnapshot === "function"
						? boundarySnapshot()
						: boundarySnapshot;
				if (!runBoundary) return;
				await runPiHistorian({
					db,
					sessionId,
					directory: ctx.cwd,
					provider,
					appendCompaction: resolvePiAppendCompaction(ctx),
					readBranchEntries: resolvePiReadBranchEntries(ctx),
					runner: historian.runner,
					signal: controller.signal,
					historianModel: historian.model,
					fallbackModels: historian.fallbackModels,
					fallbackModelId,
					historianChunkTokens: historian.historianChunkTokens,
					historianContextLimit: historian.historianContextLimit,
					resolveHostOutputLimit: (model) => {
						const slash = model.indexOf("/");
						if (slash < 1) return undefined;
						return ctx.modelRegistry?.find(
							model.slice(0, slash),
							model.slice(slash + 1),
						)?.maxTokens;
					},
					resolveHostContextLimit: (model) => {
						const slash = model.indexOf("/");
						if (slash < 1) return undefined;
						const window = ctx.modelRegistry?.find(
							model.slice(0, slash),
							model.slice(slash + 1),
						)?.contextWindow;
						return isSaneLimit(window) ? window : undefined;
					},
					boundarySnapshot: runBoundary,
					refreshBoundarySnapshot,
					currentContextLimit,
					historianTimeoutMs: historian.timeoutMs,
					temperature: historian.temperature,
					maxOutputTokens: historian.maxOutputTokens,
					twoPass: historian.twoPass,
					expandTools: historian.expandTools,
					thinkingLevel: historian.thinkingLevel,
					memoryEnabled: historian.memoryEnabled,
					allowHomeProject: historian.allowHomeProject,
					autoPromote: historian.autoPromote,
					userMemoriesEnabled: historian.userMemoriesEnabled,
					userObservationsRequested: historian.userObservationsRequested,
					language: historian.language,
					compartmentLeaseHolderId: holderId,
					notifyIssue: (text) => {
						if (!isContextHandlerSessionActive(sessionId)) {
							sessionLog(
								sessionId,
								"historian failure notice skipped after session context cleared",
							);
							return;
						}
						sendCtxStatusMessage(pi, {
							title: "Magic Context",
							text,
							level: "warning",
						});
					},
					onPublished: () => {
						const sessionStillActive = isContextHandlerSessionActive(sessionId);
						try {
							clearEmergencyRecovery(db, sessionId);
						} catch (err) {
							sessionLog(
								sessionId,
								`historian: clearEmergencyRecovery failed: ${err instanceof Error ? err.message : String(err)}`,
							);
						}
						// Historian publication invalidates the injection cache AND
						// queues drops for the messages now covered by new
						// compartments. Mirrors OpenCode's onInjectionCacheCleared
						// callback in transform.ts:502-505:
						//   - signalPiHistoryRefresh: triggers ONE rebuild on the next
						//     transform pass (drained immediately after rebuild).
						//   - signalPiPendingMaterialization: queues the drops the
						//     historian published; persists until the next pipeline
						//     pass actually materializes them. Without this signal,
						//     drops sit in pending_ops and context climbs until the
						//     derived force-materialization threshold — exactly the
						//     "context kept going up after historian ran" symptom
						//     users observed at 64% → 69%+ on Pi.
						//
						// We deliberately do NOT signal systemPromptRefresh — historian
						// doesn't change disk-backed adjuncts (docs/profile/key-files),
						// so re-reading them would burn IO for nothing.
						signalPiDeferredHistoryRefresh(sessionId);
						signalPiDeferredMaterialization(sessionId);
						if (sessionStillActive) {
							historian.onStatusChange?.(ctx, sessionId);
						} else {
							sessionLog(
								sessionId,
								"historian publication recorded after session clear; status callback skipped",
							);
						}
					},
				});
			} finally {
				clearInterval(renewal);
				releaseCompartmentLeaseBestEffort(db, sessionId, holderId, sessionLog);
			}
		})()
			.catch((error) => {
				sessionLog(
					sessionId,
					`pi historian run failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			})
			.finally(() => {
				try {
					inFlightHistorian.delete(sessionId);
					if (historianAbortControllers.get(sessionId) === controller)
						historianAbortControllers.delete(sessionId);
					unregister();
					if (isContextHandlerSessionActive(sessionId)) {
						historian.onStatusChange?.(ctx, sessionId);
					}
				} catch (error) {
					sessionLog(
						sessionId,
						`pi historian finalizer failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}),
	);
	inFlightHistorian.set(sessionId, runPromise);
	historian.onStatusChange?.(ctx, sessionId);
}

function resolvePiAppendCompaction(
	ctx: ExtensionContext,
): PiHistorianDeps["appendCompaction"] {
	const sm = ctx.sessionManager as
		| {
				appendCompaction?: (
					summary: string,
					firstKeptEntryId: string,
					tokensBefore: number,
					details?: unknown,
					fromHook?: boolean,
				) => string | undefined;
		  }
		| undefined;
	if (typeof sm?.appendCompaction !== "function") return undefined;
	return adaptPiAppendCompaction(sm.appendCompaction.bind(sm));
}

function guardedPiAppendCompaction(
	ctx: ExtensionContext,
	assertCurrentPass: () => void,
): PiHistorianDeps["appendCompaction"] {
	const append = resolvePiAppendCompaction(ctx);
	return append
		? (...args) => {
				assertCurrentPass();
				return append(...args);
			}
		: undefined;
}

function resolvePiReadBranchEntries(
	ctx: ExtensionContext,
): (() => unknown[]) | undefined {
	const sm = ctx.sessionManager as { getBranch?: () => unknown[] } | undefined;
	if (typeof sm?.getBranch !== "function") return undefined;
	return () => {
		const entries = sm.getBranch?.call(sm);
		if (!Array.isArray(entries)) {
			throw new Error("Pi sessionManager.getBranch() did not return an array");
		}
		return entries;
	};
}

/**
 * Trigger evaluation + fire-and-forget historian invocation. Runs
 * after the synchronous tagging pass so trigger logic sees the
 * just-assigned tags.
 *
 * The actual historian subagent spawn (`runPiHistorian`) is async
 * and intentionally NOT awaited — the LLM call should never wait on
 * historian. Errors are logged but never propagated; the user's
 * agent turn continues regardless of historian outcome.
 */
function maybeFireHistorian(args: {
	startGuard?: () => void;
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	sessionId: string;
	db: ContextDatabase;
	historian: PiHistorianOptions;
	isFirstContextPassForSession?: boolean;
	activeTags?: ReturnType<typeof getActiveTagsBySession>;
	eligiblePendingDropTagIds?: ReadonlySet<number>;
	rawMessageProvider?: {
		readMessages: () => ReturnType<typeof readPiSessionMessages>;
		readMessagePage?: (
			after: number,
			limit: number,
			watermark: number,
		) => ReturnType<typeof readPiSessionMessages>;
		getMessageCount?: () => number;
	};
	/**
	 * Where the session's stored ordinals sit relative to the branch the
	 * provider numbers. Derived from the live branch when absent.
	 */
	ordinalAlignment?: PiOrdinalAlignment;
	taggerFloor?: number;
	sessionMeta: ReturnType<typeof getOrCreateSessionMeta>;
	/** The transform and reclaim already admitted this request-pressure pair. */
	pressureSnapshot?: { percentage: number; inputTokens: number };
	liveIsRawBranchEstimate?: boolean;
	piUsage:
		| ReturnType<NonNullable<ExtensionContext["getContextUsage"]>>
		| undefined;
	minimumPercentage: number;
	historianStateSnapshot: PiHistorianStateSnapshot;
	publishedHistoryRide: boolean;
}): void {
	const {
		ctx,
		sessionId,
		db,
		historian,
		isFirstContextPassForSession,
		sessionMeta,
		piUsage,
		historianStateSnapshot,
	} = args;

	if (inFlightHistorian.has(sessionId)) {
		sessionLog(sessionId, "historian trigger eval: in-flight, skipping");
		return;
	}

	// Every boundary the historian computes and every compartment it writes is
	// an ordinal. When the stored ordinals cannot be placed on this branch,
	// any range it chose would be a guess, so it does not run.
	// resolvePiOrdinalAlignment has already logged why.
	const ordinalAlignment =
		args.ordinalAlignment ??
		resolvePiOrdinalAlignmentForContext(db, sessionId, ctx);
	if (isPiOrdinalAlignmentUnanchored(ordinalAlignment)) return;

	if (isWrapupInProgress(db, sessionId)) {
		// /ctx-wrapup owns compartment-state publication while this marker is live.
		// The marker has a five-minute TTL renewed by wrapup, so a crashed wrapup
		// self-expires instead of suppressing trigger-fired historian runs forever.
		sessionLog(
			sessionId,
			"historian trigger eval: /ctx-wrapup active, skipping",
		);
		return;
	}

	// Prefer OpenCode-equivalent pressure persisted by message_end.
	// Pi's built-in `ctx.getContextUsage()` reports total-tokens
	// percent (input + output + cache), but historian/trigger math
	// expects wire-input pressure (input + cacheRead + cacheWrite).
	// `session_meta.lastContextPercentage` carries the corrected value
	// computed by `pi-pressure.ts` against the effective context
	// limit (with detected_context_limit override applied).
	let usage: { percentage: number; inputTokens: number };
	let usageContextLimit: number | undefined;
	try {
		let usageSource: "session_meta" | "piUsage fallback" | "request snapshot";
		// Sane-bound (isSaneLimit, NOT `> 0`) so a garbage-but-positive window
		// can't drive the trigger budget — mirrors the main pressure pass.
		usageContextLimit = isSaneLimit(piUsage?.contextWindow)
			? piUsage.contextWindow
			: undefined;
		let usageContextWindowSource: "observed" | "catalog" = "catalog";
		let detectedContextLimit: number | undefined;
		// Cold-start: fall back to the model's window when usage hasn't reported
		// a sane one yet (first pass after restart).
		if (
			usageContextLimit === undefined &&
			isSaneLimit(ctx.model?.contextWindow)
		) {
			usageContextLimit = ctx.model.contextWindow;
			usageContextWindowSource = "catalog";
		}
		// Apply the detected-overflow cap (authoritative real limit) just like the
		// main pass — otherwise the trigger budget uses the wrong (larger) limit.
		try {
			const overflowState = historianStateSnapshot;
			if (overflowState.detectedContextLimit > 0) {
				detectedContextLimit = overflowState.detectedContextLimit;
				usageContextLimit = Math.min(
					usageContextLimit ?? overflowState.detectedContextLimit,
					overflowState.detectedContextLimit,
				);
			}
		} catch {
			// Best-effort — fall through with the uncorrected limit.
		}
		usageContextLimit = resolvePiUsableContextLimit({
			rawContextWindow: usageContextLimit,
			rawContextWindowSource: usageContextWindowSource,
			model: ctx.model,
			detectedContextLimit,
			provenInputTokens:
				resolvePiProvenInputFloor({
					db,
					sessionId,
					modelKey: resolvePiContextModelKey(ctx),
					readBranch: () => ctx.sessionManager.getBranch(),
					providerInputLimit: piPressureEvidenceLimit(
						resolvePiWindowGeometry({
							rawContextWindow: usageContextLimit,
							rawContextWindowSource: usageContextWindowSource,
							model: ctx.model,
							detectedContextLimit,
						}),
					),
				}) || undefined,
		});
		if (args.pressureSnapshot) {
			usage = args.pressureSnapshot;
			usageSource = "request snapshot";
		} else if (
			sessionMeta.lastContextPercentage > 0 &&
			sessionMeta.lastInputTokens > 0
		) {
			usage = {
				percentage: sessionMeta.lastContextPercentage,
				inputTokens: sessionMeta.lastInputTokens,
			};
			usageSource = "session_meta";
		} else {
			// Fallback to Pi-reported usage when no message_end has
			// landed yet (first turn). This is the same fallback the
			// original implementation used; the +output token drift
			// of ~0.1% is acceptable on the first turn before
			// message_end runs.
			if (
				!piUsage ||
				piUsage.tokens === null ||
				piUsage.percent === null ||
				piUsage.contextWindow === 0
			) {
				sessionLog(
					sessionId,
					`historian trigger eval: no usage info yet (tokens=${piUsage?.tokens ?? "<no piUsage>"}, percent=${piUsage?.percent ?? "<no piUsage>"}, contextWindow=${piUsage?.contextWindow ?? "<no piUsage>"})`,
				);
				return;
			}
			// Recompute the fallback percentage against the corrected limit (raw
			// piUsage.percent is on Pi's own denominator and is wrong once the
			// limit was sane-bounded or overflow-capped).
			const fallbackPercentage =
				isSaneLimit(usageContextLimit) && piUsage.tokens > 0
					? (piUsage.tokens / usageContextLimit) * 100
					: piUsage.percent;
			usage = {
				percentage: fallbackPercentage,
				inputTokens: piUsage.tokens,
			};
			usageSource = "piUsage fallback";
		}
		usage =
			args.pressureSnapshot ??
			resolvePiPressureSnapshotWithEstimateGuard({
				sessionId,
				source: "historian trigger",
				liveIsRawBranchEstimate: args.liveIsRawBranchEstimate,
				persistedFromLive: usageSource === "piUsage fallback",
				persistedPercentage: usage.percentage,
				persistedInputTokens: usage.inputTokens,
				liveInputTokens: piUsage?.tokens,
				usableContextLimit: usageContextLimit,
				minimumPercentage: args.minimumPercentage,
			});
		sessionLog(
			sessionId,
			`historian trigger eval: usage=${usage.percentage.toFixed(1)}% (${usage.inputTokens} tokens) [${usageSource}], checking trigger...`,
		);
	} catch (err) {
		sessionLog(
			sessionId,
			`historian trigger eval: getContextUsage threw: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	// Register the Pi RawMessageProvider for this sessionId so the
	// shared trigger logic + historian can read Pi session messages
	// via the standard `readRawSessionMessages` etc. helpers. The
	// provider stays registered while the historian runs and
	// unregisters in finally.
	const offsetSource = piRawOrdinalOffsetSource(db, sessionId);
	const provider = args.rawMessageProvider ?? {
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
	const modelKey = liveModelBySession.get(sessionId);
	const triggerInputs = resolvePiHistorianTriggerInputs({
		db,
		sessionId,
		historian,
		modelKey,
		usageContextLimit,
	});
	const historianForceMaterializationPercentage = escalationBands(
		triggerInputs.executeThresholdPercentage,
	).forceMaterializationPercentage;
	const boundaryContextLimit = triggerInputs.contextLimit;
	if (
		isHistorianDrainBudgetSpent({
			db,
			sessionId,
			contextLimit: boundaryContextLimit,
			executeThresholdPercentage: triggerInputs.executeThresholdPercentage,
			usagePercentage: usage.percentage,
		})
	) {
		if (sessionMeta.compartmentInProgress) {
			updateSessionMeta(db, sessionId, { compartmentInProgress: false });
			sessionMeta.compartmentInProgress = false;
		}
		return;
	}
	const unregister = setRawMessageProvider(sessionId, provider);
	const resolvePiBoundarySnapshot = (
		emergencyTailScale?: 0.5 | 0.25,
	): ProtectedTailBoundarySnapshot =>
		resolveProtectedTailBoundary(
			resolveBoundaryContext({
				db,
				sessionId,
				mode: "pi-trigger",
				contextLimit: boundaryContextLimit,
				executeThresholdPercentage: triggerInputs.executeThresholdPercentage,
				usage,
				usageSource: "live",
				providerShapeVersion: "pi-folded-v1",
				cacheNamespace: `pi:${sessionId}`,
				emergencyTailScale,
			}),
		);
	const resolveRunnablePiBoundarySnapshot =
		(): ProtectedTailBoundarySnapshot => {
			let snapshot = ensureRunnablePiBoundaryForTests(
				resolvePiBoundarySnapshot(),
			);
			// Derived band, not literal 80: under a raised execute threshold the
			// emergency-scaled retry must not relax the boundary below the force
			// band (same escalation class as the OpenCode trigger's force gate).
			if (
				!hasRunnableCompartmentWindow(snapshot) &&
				usage.percentage >= historianForceMaterializationPercentage
			) {
				snapshot = ensureRunnablePiBoundaryForTests(
					resolvePiBoundarySnapshot(usage.percentage >= 95 ? 0.25 : 0.5),
				);
			}
			return snapshot;
		};
	let boundarySnapshot: ProtectedTailBoundarySnapshot | undefined;

	let triggered = false;
	try {
		if (
			isFirstContextPassForSession &&
			sessionMeta.compartmentInProgress &&
			!inFlightHistorian.has(sessionId)
		) {
			updateSessionMeta(db, sessionId, { compartmentInProgress: false });
			sessionMeta.compartmentInProgress = false;
			sessionLog(
				sessionId,
				"historian: cleared stale compartmentInProgress flag on first context pass after restart",
			);
		}
		if (readPiHistoryRetirement(db, sessionId)) {
			const failedAt =
				getHistorianFailureState(db, sessionId).lastFailureAt ?? 0;
			const now = Date.now();
			if (
				sessionMeta.compartmentInProgress ||
				(failedAt > 0 &&
					failedAt <= now &&
					now - failedAt < EMERGENCY_DRAIN_FAILURE_BACKOFF_MS)
			)
				return;
			const snapshot = resolveRunnablePiBoundarySnapshot();
			if (!hasEligiblePiCompartmentHistory(db, sessionId, snapshot)) return;
			// Retirement exposes a formerly summarized range even when it is too
			// small for a normal tail-size trigger. All other admission, lease,
			// protected-tail and producer checks remain on the ordinary path.
			triggered = true;
			spawnPiHistorianRun({
				startGuard: args.startGuard,
				pi: args.pi,
				ctx,
				sessionId,
				db,
				historian,
				provider,
				unregister,
				boundarySnapshot: snapshot,
				refreshBoundarySnapshot: resolveRunnablePiBoundarySnapshot,
				currentContextLimit: boundaryContextLimit,
				fallbackModelId: modelKey,
			});
			return;
		}
		if (isFirstContextPassForSession) {
			const failureCount = historianStateSnapshot.historianFailureCount;
			if (failureCount > 0) {
				triggered = true;
				const prepareRecoveryBoundary = ():
					| ProtectedTailBoundarySnapshot
					| undefined => {
					const snapshot = resolveRunnablePiBoundarySnapshot();
					if (!hasEligiblePiCompartmentHistory(db, sessionId, snapshot))
						return undefined;
					sessionLog(
						sessionId,
						`historian recovery triggered on session load after ${failureCount} failure(s)`,
					);
					sendPiIgnoredNotification(
						ctx,
						`## Historian recovery\n\nHistorian previously failed ${failureCount} time(s), so Magic Context is retrying history comparting immediately after restart.`,
					);
					return snapshot;
				};
				spawnPiHistorianRun({
					startGuard: args.startGuard,
					pi: args.pi,
					ctx,
					sessionId,
					db,
					historian,
					provider,
					unregister,
					boundarySnapshot: prepareRecoveryBoundary,
					refreshBoundarySnapshot: resolveRunnablePiBoundarySnapshot,
					currentContextLimit: boundaryContextLimit,
					fallbackModelId: modelKey,
				});
				return;
			}
		}

		// Pi's cleared thinking is safe to project for every provider: its
		// serializers omit empty thinking blocks, unlike OpenCode's
		// canonical-Anthropic-only empty-sentinel path.
		const trigger = checkCompartmentTrigger(
			db,
			sessionId,
			sessionMeta,
			usage,
			0, // _previousPercentage — unused by current trigger logic
			triggerInputs.executeThresholdPercentage,
			triggerInputs.triggerBudget,
			triggerInputs.keepReasoningTokens,
			triggerInputs.commitClusterTrigger,
			args.activeTags,
			boundaryContextLimit,
			() => readPiHistorianTail(db, sessionId, provider),
			args.taggerFloor,
			{ canClearReasoning: true },
			{
				hardFold: false,
				force:
					usage.percentage >= historianForceMaterializationPercentage &&
					(usage.percentage >= 95 ||
						getEmergencyInputSample(db, sessionId) === 0),
				explicitFlush: hasPendingMaterialization(sessionId),
				publishedHistory: args.publishedHistoryRide,
			},
			args.eligiblePendingDropTagIds,
		);

		if (!trigger.shouldFire) {
			sessionLog(
				sessionId,
				`historian trigger eval: shouldFire=false (no trigger condition met)`,
			);
			// Disarm a STALE emergency-recovery flag here, where the AUTHORITATIVE
			// runnable-window snapshot is in hand. The early disarm in the main
			// pass (the `isEmergency` block) uses the loose "any raw past boundary"
			// check, which returns true for a tiny non-runnable tail (e.g. one
			// in-progress message after /ctx-recomp) and so never disarms — the
			// flag then bumps every pass to 95% forever even at low real pressure.
			//
			// Gate on REAL pressure (usage.percentage, NOT the 95% emergency bump):
			//   - LOW pressure + armed + no runnable window  → the flag is STALE
			//     (overflow already resolved, e.g. by /ctx-recomp); disarm so it
			//     stops force-bumping. This is the user-rescued case (~20%).
			//   - HIGH pressure + armed + no runnable window  → a GENUINE overflow
			//     whose tail is one in-progress arc; the window will become runnable
			//     once the arc closes. Keep armed so drop-all-tools keeps shrinking
			//     the prompt every pass until then (OpenCode keeps it armed too,
			//     stopping only the bump via a counter escape). detectedContextLimit
			//     is left intact (authoritative model data).
			try {
				const overflowState = historianStateSnapshot;
				if (
					overflowState.needsEmergencyRecovery &&
					usage.percentage < historianForceMaterializationPercentage &&
					!inFlightHistorian.has(sessionId)
				) {
					boundarySnapshot ??= resolveRunnablePiBoundarySnapshot();
				}
				if (
					overflowState.needsEmergencyRecovery &&
					usage.percentage < historianForceMaterializationPercentage &&
					!inFlightHistorian.has(sessionId) &&
					boundarySnapshot !== undefined &&
					!hasRunnableCompartmentWindow(boundarySnapshot)
				) {
					clearEmergencyRecovery(db, sessionId);
					sessionLog(
						sessionId,
						`historian: disarming stale emergency recovery — real pressure ${usage.percentage.toFixed(1)}% with no runnable compartment window (would otherwise bump to 95% every pass)`,
					);
				}
			} catch (err) {
				sessionLog(
					sessionId,
					`historian: emergency-recovery disarm check failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return;
		}

		// Archive summaries, drops and the checkpoint marker commit together.
		// If a host without a UI exits, its publication lease can be reclaimed.
		// Such hosts can run this background historian across turns; a request
		// proven too large waits for its result before the final fit check.
		triggered = true;
		sessionLog(
			sessionId,
			`historian trigger fired (reason=${trigger.reason ?? "unknown"}) usage=${usage.percentage.toFixed(1)}% — spawning subagent`,
		);

		// Track the background promise so an oversized headless request can
		// await it, and shutdown can cancel the child and wait for the run's
		// finally block to release its compartment-state lease.
		spawnPiHistorianRun({
			startGuard: args.startGuard,
			pi: args.pi,
			ctx,
			sessionId,
			db,
			historian,
			provider,
			unregister,
			boundarySnapshot: selectPiHistorianRunBoundarySnapshot({
				resolvedBoundarySnapshot:
					boundarySnapshot ??
					trigger.boundarySnapshot ??
					resolveRunnablePiBoundarySnapshot(),
				triggerBoundarySnapshot: trigger.boundarySnapshot,
			}),
			refreshBoundarySnapshot: resolveRunnablePiBoundarySnapshot,
			currentContextLimit: boundaryContextLimit,
			fallbackModelId: modelKey,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		sessionLog(sessionId, `historian trigger eval failed: ${message}`);
	} finally {
		if (!triggered) unregister();
	}
}
interface RunPipelineArgs {
	/** Metadata estimates alone cannot rewrite messages bound to an active thinking signature. */
	upperEstimateOnly?: boolean;
	recoveryPrefix?: import("./pi-lkg").PiLkgRecoveryPrefix;
	recoveryRebuildReason?: string;
	tryReplayHeldIdentityRebuild?: () => void;
	readLastServedMessages?: () => readonly unknown[] | null;
	forceSignedRebuildForFit?: boolean;
	resolvedProviderID?: string;
	resolvedModelID?: string;
	providerApi?: string;
	assertCurrentPass?: () => void;
	db: ContextDatabase;
	tagger: Tagger;
	sessionId: string;
	projectIdentity: string;
	projectDirectory: string;
	sessionMeta: ReturnType<typeof getOrCreateSessionMeta>;
	effectiveSystemHash?: string;
	messages: Parameters<typeof createPiTranscript>[0];
	lkgEntryIds?: readonly (string | undefined)[];
	/** Smart-drops (experimental, default off): also reclaim tool output that a
	 *  later call supersedes, on top of the age-based auto-drop. Off → messages
	 *  sent to the model are byte-identical to the age-based-only behavior. */
	smartDrops?: boolean;
	protectedTools?: Readonly<Record<string, number>>;
	protectedTags: number;
	protectedTokens?: number;
	protectedTokenTierOverrides?: ProtectedTokensTierOverrides;
	usableSoft: number;
	reclaimUsableWindow?: number;
	/** Heuristic-cleanup config — when omitted, defaults to OpenCode parity values. */
	heuristics?: {
		caveman?: {
			enabled: boolean;
			minChars: number;
			wordRules?: CavemanWordRules;
		};
	};
	isSubagent?: boolean;
	/** Additive-only transform mode: no tags, drops, history trim, markers, or nudges. */
	compactionOff?: boolean;
	/** ceiling = contextLimit × executeThreshold% for the tiered emergency drop. */
	emergencyCeilingTokens?: number;
	/** Memory-injection config — when omitted, no <session-history> injection runs. */
	injection?: {
		/** When false (config `memory.enabled=false`), project memories are NOT
		 *  read or rendered into m[0]/m[1]. Docs are controlled by injectDocs. */
		memoryEnabled?: boolean;
		/** Defaults true. When false, m[0] omits the <project-docs> block and docs hash. */
		injectDocs?: boolean;
		injectionBudgetTokens: number;
		/** v2 decay-render history budget (~60K), distinct from the memory
		 *  injection budget. Drives compartment tier demotion in renderM0Pi. */
		historyBudgetTokens?: number;
		historyBudgetPolicyIdentity?: string;
		temporalAwareness?: boolean;
		/** mural.enabled — when enabled, generate a deterministic image of memories that did not fit the context budget whenever the system performs a full (HARD) context fold. */
		muralEnabled?: boolean;
	};
	/**
	 * Optional entry-id array, indexed 1:1 with `messages`, providing
	 * the SessionEntry id for each AgentMessage. When supplied,
	 * `injectSessionHistoryIntoPi` uses these IDs for compartment
	 * boundary lookup — matching what historian persists as
	 * `start_message_id`/`end_message_id` (set up via read-session-pi.ts:
	 * `RawMessage.id = entry.id`). Caller resolves this by walking
	 * `ctx.sessionManager.getBranch()` and filtering to message-type
	 * entries — same filter `buildSessionContext` applies.
	 *
	 * Without this, boundary lookup falls back to a synthesized
	 * `pi-msg-${index}-${ts}-${role}` id, which never matches anything
	 * historian wrote → `<session-history>` cannot trim raw history.
	 */
	entryIds?: readonly (string | undefined)[];
	/**
	 * Splice-safe message→entryId map keyed by AgentMessage reference. Best-effort
	 * first try for stable-id resolution (misses messages tagging/drops cloned this
	 * pass — positional entryIds is the mandatory fallback). Threaded so the
	 * transcript-tag path and the reasoning/heuristic stable-id paths resolve the
	 * SAME id for a message (the cross-path lookup invariant).
	 */
	entryIdByRef?: ReadonlyMap<object, string> | null;
	/** Real entry ids whose append-only Pi message objects were tagged previously. */
	reusableMessageIds?: ReadonlySet<string>;
	fallbackInputFields?: WeakMap<
		object,
		PiLkgPassSnapshot["inputs"][number]["fields"]
	>;
	/**
	 * True on the one-time stable-id-scheme cutover pass (Pi message identity
	 * switched from index-based to real-entry-id). Forces placeholder rediscovery
	 * under the new scheme. The forced execute+materialize cutover machinery
	 * (pi_stable_id_scheme persisted version) is wired by the caller; when unset,
	 * no cutover behavior runs (safe default).
	 */
	stableIdSchemeCutover?: boolean;
	/**
	 * Pre-resolved scheduler decision for THIS pass. When `"execute"`,
	 * heuristic cleanup runs (cache-busting). When `"defer"`, only the
	 * cache-stable stages run (tagging + applyFlushedStatuses + replay
	 * cached injection). Mirrors OpenCode's pre-resolved scheduler decision.
	 */
	schedulerDecision: "execute" | "defer";
	/** The defer reason is computed once when the scheduler decision is made; preserve it so refusal logs report the actual reason instead of recomputing it. */
	schedulerDeferReason: "scheduler_defer" | null;
	/**
	 * Enables tiered emergency selection when usage reaches the derived force band.
	 * The pressure-episode latch still prevents repeated originating batches.
	 */
	forceMaterialization?: boolean;
	/** Resolved escalation band for this pass (defaults to 85 for test/direct callers). */
	forceMaterializationPercentage?: number;
	contextUsage: { percentage: number; inputTokens: number };
	/**
	 * One-shot signal that the injection cache should be invalidated and
	 * the prepared block rebuilt on this pass. Mirrors OpenCode's
	 * historyRefreshSessions set.
	 */
	isCacheBusting: boolean;
	/** Preserve command authorization through retries of this context invocation only. */
	userFlushOrigin?: boolean;
	/**
	 * Reasoning-clearing config. When provided, typed PiThinkingContent
	 * blocks for messages older than `clearReasoningAge` from the newest
	 * tag are replaced with `[cleared]` on execute passes; the watermark
	 * is persisted to `session_meta.cleared_reasoning_through_tag` so
	 * defer passes replay the cleared state. Mirrors OpenCode's
	 * `clearOldReasoning` + `replayClearedReasoning` pair.
	 *
	 * OpenCode PR #24146 (preserve empty reasoning_content for DeepSeek
	 * V4 thinking mode) made the provider transform always emit the
	 * interleaved field (e.g. Moonshot/Kimi `reasoning_content`) — empty
	 * when no reasoning parts remain — so providers that previously
	 * needed prior reasoning preserved no longer reject the request.
	 */
	reasoningClearing?: {
		keepReasoningTokens?: number;
		/** Deprecated caller input, ignored. */
		clearReasoningAge?: number;
		nativeReasoningMayClear: boolean;
		preserveReasoningToolArcs: boolean;
		/** Model binds signed thinking to the request prefix (Fable 5.1, Opus 5.5, Sonnet 5.5). */
		prefixBound?: boolean;
	};
	/** True only when the active provider filters empty sentinel content safely. */
	canUseEmptySentinels: boolean;
	/**
	 * Whether to inject temporal `<!-- +Xm -->` markers into user
	 * messages with large gaps. Mirrors OpenCode's
	 * `experimental.temporal_awareness`. Idempotent across passes.
	 */
	temporalAwareness?: boolean;
	appendCompaction?: ApplyDeferredPiCompactionMarkerDeps["appendCompaction"];
	readBranchEntries?: ApplyDeferredPiCompactionMarkerDeps["readBranchEntries"];
	/** Pass-local cache, replaced after a HARD fold writes new cache metadata. */
	injectionPassSnapshot?: PiM0M1PassSnapshot;
}

interface PiChannelBaselineSnapshot {
	tagCacheKey?: object;
	tags: ReturnType<typeof getTagsBySession>;
	/** The rows of `tags` whose status is "active", in the same order. */
	activeTags: readonly ReturnType<typeof getTagsBySession>[number][];
	protectedTagNumbers: Set<number>;
	pendingDropTagNumbers: Set<number>;
}

interface RunPipelineResult {
	recoveryNormalized?: boolean;
	lkgFrozenReleaseReason?: string;
	/** Shared permission for first applications in the pipeline and host-side lanes. */
	prefixBustPermitted: boolean;
	/** False while a signed-prefix hold defers new host-side work. */
	prefixMutationAllowed: boolean;
	strictThinkingKept: boolean;
	signedPrefixRewritten: boolean;
	/** A missing or cold cache already costs a rebuild; further eligible edits add no extra bust. */
	prefixRebuildAlreadyPriced: boolean;
	identityRebuilt?: boolean;
	messages: unknown[];
	servedTagNumbers?: ReadonlySet<number>;
	/** Whether heuristic cleanup actually ran on this pass. */
	heuristicsExecuted: boolean;
	/** Whether any execute-only state mutation ran on this pass. */
	executedWorkThisPass: boolean;
	/** Whether <session-history> was written into message[0]. */
	historyInjected: boolean;
	/**
	 * Count of synthetic id-less messages injection prepended (the m[0]/m[1]
	 * pair). Anchor-GC excludes these from its "all messages resolved"
	 * denominator — they never resolve to a real entry id, so without this
	 * exclusion `allResolved` is permanently false and pruning never runs.
	 */
	syntheticLeadingCount: number;
	/** Aggregate counts for log parity with OpenCode. */
	heuristicsResult: PiHeuristicCleanupResult | null;
	injectionResult: PiInjectionResult | null;
	materialized: boolean;
	materializeReason: string | null;
	droppedTokens: number;
	droppedCount: number;
	emergency: boolean;
	bustedThisPass: boolean;
	agentDropsAppliedThisPass: boolean;
	eligiblePendingDropTagIds?: ReadonlySet<number>;
	/**
	 * This pass edited bytes before newer thinking in some way other than the
	 * oldest-prefix thinking clear of a prefix-bound model, or cannot say what
	 * it changed (a first render, a requested materialization, published
	 * history). The proactive thinking strip runs only when this is true.
	 */
	prefixEditBesidesReasoningTrim: boolean;
	targetCount: number;
	reasoningWatermark: number;
	activeTags: ReturnType<typeof getTagsBySession>;
	channelBaselineSnapshot: PiChannelBaselineSnapshot;
	/**
	 * REAL-SessionEntry-id map keyed by AgentMessage object identity, built AFTER
	 * transcript.commit() and BEFORE injection splices. The ONLY correct map for
	 * consumers running after runPipeline mutated the array (sticky reminder,
	 * note nudges, auto-search): the pass-start `entryIdByRef` keys pre-commit
	 * objects and misses every cloned (dirty) message. Contains NO pi-msg-*
	 * fallback ids, so a branch-resolution failure leaves a message unmapped and
	 * the consumer correctly falls to its degraded (entryIds === null) path.
	 */
	postCommitEntryIdByRef: ReadonlyMap<object, string>;
	lkgEntryIdByRef: ReadonlyMap<object, string>;
}

function pendingPiMarkerCoveredByRenderedBoundary(
	pending: PendingPiCompactionMarker,
	injection: PiInjectionResult | null,
): boolean {
	// Contention fallbacks must never authorize a native trim: the served
	// bytes may lag the latest compartment snapshot.
	if (!injection || injection.contentionExhausted) return false;
	// m[0] arm: the boundary rendered into the m[0] snapshot.
	const boundary = injection.renderedBoundary;
	if (pending.endMessageId === boundary.endMessageId) return true;
	if (boundary.ordinal !== null && pending.ordinal <= boundary.ordinal)
		return true;
	// m[1] arm (liveness fix): fresh publications render their compartment
	// into the m[1] delta, not m[0] (which folds only on a HARD bust), so the
	// m[0] snapshot boundary stays behind the pending marker until an
	// unrelated HARD fold — starving the drain for hours in stable sessions.
	// Accept coverage from a compartment actually rendered into m[1] THIS
	// pass. The field is non-null only when m[1] was freshly recomputed this
	// pass without a contention fallback (null on cached/sibling replay, where
	// contentionExhausted alone would miss the sibling-fallback's stale
	// bytes), so this restores OpenCode's consuming-pass drain parity without
	// ever trimming getBranch() beyond content the model was shown this pass.
	const m1Coverage = injection.m1RenderedCoverage;
	if (!m1Coverage) return false;
	if (pending.endMessageId === m1Coverage.endMessageId) return true;
	return m1Coverage.ordinal !== null && pending.ordinal <= m1Coverage.ordinal;
}

function captureReasoningMutationRollback(
	messages: readonly unknown[],
): () => void {
	const snapshots: Array<{
		part: Record<string, unknown>;
		field: "thinking" | "text";
		value: unknown;
		hadSignature?: boolean;
		signature?: unknown;
	}> = [];
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const message = raw as {
			role?: unknown;
			content?: unknown;
		};
		if (message.role !== "assistant" || !Array.isArray(message.content))
			continue;
		for (const rawPart of message.content) {
			if (!rawPart || typeof rawPart !== "object") continue;
			const part = rawPart as Record<string, unknown>;
			if (part.type === "thinking") {
				snapshots.push({
					part,
					field: "thinking",
					value: part.thinking,
					hadSignature: Object.hasOwn(part, "thinkingSignature"),
					signature: part.thinkingSignature,
				});
			} else if (part.type === "text") {
				snapshots.push({ part, field: "text", value: part.text });
			}
		}
	}
	return () => {
		for (const snapshot of snapshots) {
			snapshot.part[snapshot.field] = snapshot.value;
			if (snapshot.field === "thinking") {
				if (snapshot.hadSignature) {
					snapshot.part.thinkingSignature = snapshot.signature;
				} else {
					delete snapshot.part.thinkingSignature;
				}
			}
		}
	};
}

async function runCompactionOffPipeline(
	args: RunPipelineArgs,
): Promise<RunPipelineResult> {
	let injectionResult: PiInjectionResult | null = null;
	if (args.injection) {
		injectionResult = injectM0M1Pi(
			{
				sessionId: args.sessionId,
				projectIdentity: args.projectIdentity,
				projectDirectory: args.projectDirectory,
				memoryEnabled: args.injection.memoryEnabled,
				injectDocs: args.injection.injectDocs,
				injectionBudgetTokens: args.injection.injectionBudgetTokens,
				historyBudgetTokens: args.injection.historyBudgetTokens,
				historyBudgetPolicyIdentity: args.injection.historyBudgetPolicyIdentity,
				muralEnabled: args.injection.muralEnabled === true,
				compactionOff: true,
			},
			args.db,
			args.messages as Parameters<typeof injectM0M1Pi>[2],
			args.entryIds,
			false,
			args.injectionPassSnapshot,
		);
	}
	return {
		messages: args.messages as unknown[],
		prefixBustPermitted: false,
		prefixMutationAllowed: false,
		strictThinkingKept: false,
		signedPrefixRewritten: false,
		prefixRebuildAlreadyPriced: false,
		heuristicsExecuted: false,
		executedWorkThisPass: false,
		historyInjected: false,
		syntheticLeadingCount: injectionResult?.syntheticLeadingCount ?? 0,
		heuristicsResult: null,
		injectionResult,
		materialized: injectionResult?.m0Materialized === true,
		materializeReason: injectionResult?.m0Reason ?? null,
		droppedTokens: 0,
		droppedCount: 0,
		emergency: false,
		bustedThisPass: injectionResult?.m0Materialized === true,
		agentDropsAppliedThisPass: false,
		// Compaction-off passes never reach the proactive strip. True is the
		// value that would strip if one ever did.
		prefixEditBesidesReasoningTrim: true,
		targetCount: 0,
		reasoningWatermark: args.sessionMeta.clearedReasoningThroughTag ?? 0,
		activeTags: [],
		channelBaselineSnapshot: {
			tags: [],
			activeTags: [],
			protectedTagNumbers: new Set(),
			pendingDropTagNumbers: new Set(),
		},
		postCommitEntryIdByRef: new Map(),
		lkgEntryIdByRef: new Map(),
	};
}

async function runPipeline(args: RunPipelineArgs): Promise<RunPipelineResult> {
	args.assertCurrentPass?.();
	if (args.compactionOff) return runCompactionOffPipeline(args);
	const thinkingRecovery = prepareLatestThinkingRecovery({
		db: args.db,
		sessionId: args.sessionId,
		messages: args.messages,
		id: (message, index) =>
			resolvePiStableId(
				message,
				index,
				args.entryIds,
				args.entryIdByRef ?? undefined,
			),
		parts: (message) =>
			Array.isArray((message as { content?: unknown })?.content)
				? (message as { content: unknown[] }).content
				: [],
	});
	if (thinkingRecovery.ended)
		signalPiPendingMaterialization(args.sessionId, "thinking_hold");
	let restoreOriginals:
		| ReturnType<typeof captureOriginalTurn<unknown>>
		| undefined;
	let activeThinkingTurn = hasActiveAnthropicThinkingTurn(
		args.messages,
		args.resolvedProviderID,
		args.resolvedModelID,
	);
	let protectedSignedPrefix =
		activeThinkingTurn && args.reasoningClearing?.prefixBound === true;
	let rewritingSignedPrefix = false;
	// A changed recovery input or a new thinking omission rewrites the request.
	// A restart that only replays already recorded decisions does not price cleanup.
	let isCacheBustingPass =
		args.recoveryRebuildReason === "lkg_recovery_input_rebuild" ||
		((!!args.recoveryRebuildReason || args.forceSignedRebuildForFit === true) &&
			hasUnfrozenPiThinking({
				messages: args.messages,
				entryIds: args.messages.map(
					(message, index) =>
						args.lkgEntryIds?.[index] ??
						resolvePiRealStableId(
							message,
							index,
							args.entryIds,
							args.entryIdByRef ?? undefined,
						),
				),
				frozen: frozenBindingEntryIds(args.db, args.sessionId),
				provider: args.resolvedProviderID,
				model: args.resolvedModelID,
			}));
	let workingForRewrite: unknown[] | undefined;
	const stripForPrefixRewrite = (permitRewrite = true) => {
		// Required prefix rewrites permit queued drops and cleanup on this request.
		// Recovery that only replays stored decisions passes false instead, so it
		// cannot introduce a fresh edit into an otherwise unchanged saved request.
		isCacheBustingPass ||= permitRewrite;
		const messages = workingForRewrite ?? args.messages;
		const result = applyPiProactiveThinkingStrip({
			db: args.db,
			sessionId: args.sessionId,
			messages: messages as unknown[],
			entryIds: messages.map(
				(message, index) =>
					args.lkgEntryIds?.[index] ??
					resolvePiRealStableId(
						message,
						index,
						args.entryIds,
						args.entryIdByRef ?? undefined,
					),
			),
			provider: args.resolvedProviderID,
			model: args.resolvedModelID,
			cacheBustingPass: isCacheBustingPass,
			stripActiveTurn: true,
			persistOnly: true,
			requirePersistence: !!args.recoveryRebuildReason,
		});
		if (activeThinkingTurn && isCacheBustingPass && !result)
			throw new Error(
				"Cannot persist signed thinking omission before prefix rewrite",
			);
		rewritingSignedPrefix = true;
		activeThinkingTurn = false;
		protectedSignedPrefix = false;
	};
	if (
		args.recoveryRebuildReason ||
		(args.forceSignedRebuildForFit && protectedSignedPrefix)
	)
		stripForPrefixRewrite(isCacheBustingPass);
	// Messages without a real entry id get a position-independent fallback id
	// computed once from this pass's input, before any stage edits content.
	// Every stage below resolves by the index it was given into this same array
	// (nothing splices it before the post-commit maps), so they all see one id.
	const realStableId = (msg: unknown, index: number): string | undefined =>
		resolvePiRealStableId(
			msg,
			index,
			args.entryIds,
			args.entryIdByRef ?? undefined,
		);
	const passFallbackIds = settlePiFallbackOccurrences(
		args.db,
		args.sessionId,
		piContentFallbackIds(args.messages, realStableId),
	);
	const stableIdResolver = (msg: unknown, index: number): string | undefined =>
		realStableId(msg, index) ??
		passFallbackIds[index] ??
		resolvePiStableId(msg, index);
	let foldingSystemState: PiEffectiveSystemState | null = null;
	try {
		// Capture the provider-visible system state before transforming the served
		// array. A pending compaction marker must compare this input state with the
		// system state that Pi persists in its session.
		foldingSystemState = resolvePiEffectiveSystemStateForRun(args.messages);
	} catch {
		// If effective system state is unavailable, continue without it; a pending
		// marker's gate below logs this failure using IDs and ordinals only.
	}
	const forceMaterializationPercentage =
		args.forceMaterializationPercentage ??
		escalationBands(65).forceMaterializationPercentage;
	let executedWorkThisPass = false;
	let historyWasConsumedThisPass = false;
	let materializationSatisfiedThisPass = false;
	let pendingOpsAppliedThisPass = false;
	let pendingOpsDidMutate = false;
	let eligiblePendingDropTagIds: ReadonlySet<number> | undefined;
	let heuristicOrReasoningDidMutate = false;
	// An edit this pass made before newer thinking other than the oldest-prefix
	// thinking clear of a prefix-bound model; see RunPipelineResult.
	let prefixEditBesidesReasoningTrim = false;
	// Only first application changes the served prefix. Frozen-id replay rebuilds
	// prior bytes from raw history and must not create a new bust or invalidation.
	const recordFirstApplicationWireEdit = (
		beforeNewerThinking: boolean,
	): void => {
		heuristicOrReasoningDidMutate = true;
		prefixEditBesidesReasoningTrim ||= beforeNewerThinking;
		executedWorkThisPass = true;
	};
	// Retain source order through later splices. A terminal edit must not move
	// the rewrite backward into thinking whose preceding bytes did not change.
	let firstEditSourceOrder: Map<string, number> | undefined;
	const firstEditParts = new Map<string, number>();
	const recordFirstApplicationAt = (
		message: unknown,
		index: number,
		partIndex: number,
		resolveId: (
			message: unknown,
			index: number,
		) => string | undefined = stableIdResolver,
	): void => {
		firstEditSourceOrder ??= new Map(
			args.messages.flatMap((item, sourceIndex) => {
				const id = resolveId(item, sourceIndex);
				return id ? [[id, sourceIndex] as const] : [];
			}),
		);
		const id = resolveId(message, index);
		if (!id || !firstEditSourceOrder.has(id)) {
			recordFirstApplicationWireEdit(true);
			return;
		}
		recordFirstApplicationWireEdit(false);
		firstEditParts.set(
			id,
			Math.min(firstEditParts.get(id) ?? Infinity, partIndex),
		);
	};
	// Call ids can repeat across owners; only the matched arc and its paired
	// results contribute locations, not unrelated turns reusing the same id.
	const recordStaleReduceEdit = (tag: {
		messageId: string;
		toolOwnerMessageId: string | null;
	}): void => {
		let matchedOwner = false;
		let located = false;
		for (let index = 0; index < args.messages.length; index++) {
			const raw = args.messages[index];
			if (!raw || typeof raw !== "object") continue;
			const message = raw as {
				role?: string;
				toolCallId?: string;
				content?: unknown;
			};
			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (
					let partIndex = 0;
					partIndex < message.content.length;
					partIndex++
				) {
					const part = message.content[partIndex] as {
						type?: string;
						id?: string;
					};
					if (part?.type !== "toolCall" || part.id !== tag.messageId) continue;
					matchedOwner =
						tag.toolOwnerMessageId === null ||
						stableIdResolver(raw, index) === tag.toolOwnerMessageId;
					if (matchedOwner) {
						recordFirstApplicationAt(raw, index, partIndex);
						located = true;
					}
				}
			} else if (
				message.role === "toolResult" &&
				message.toolCallId === tag.messageId &&
				matchedOwner
			) {
				recordFirstApplicationAt(raw, index, 0);
				located = true;
			}
		}
		if (!located) recordFirstApplicationWireEdit(true);
	};
	let droppedCount = 0;
	let droppedTokens = 0;
	const droppedTokenReductions: DroppedTokenReduction[] = [];
	let emergency = false;
	let autoReclaimDidMutateThisPass = false;
	let suppressDeferredHistoryDrain = false;
	let deferredMaterializationConsumedThisPass = false;
	let casLost = false;
	let injectionPassSnapshot = args.injectionPassSnapshot;
	const deferredHistoryWasPendingAtPassStart =
		deferredHistoryRefreshSessions.has(args.sessionId);

	// Prepare prefix work on a shadow array. An execute with unchanged m[1] is
	// not a ride; changed published bytes or an executed fold price the reductions.
	const piHardSignals = args.injection
		? (() => {
				// HARD-bust signals (parity with OpenCode). systemHash + TTL idle
				// derive from freshly-read session_meta; modelKey from the volatile live
				// map.
				const hardMeta = args.sessionMeta;
				let piTtlMs = 5 * 60 * 1000;
				try {
					piTtlMs = parseCacheTtl(hardMeta.cacheTtl);
				} catch {
					// invalid cache_ttl → 5m default (parity with execute-status)
				}
				return {
					systemHash:
						typeof hardMeta.systemPromptHash === "string"
							? hardMeta.systemPromptHash
							: "",
					modelKey: liveModelBySession.get(args.sessionId) ?? "",
					cacheExpired: isPiHardCacheExpired(
						hardMeta.lastResponseTime,
						piTtlMs,
						Date.now(),
					),
					lastResponseTime: hardMeta.lastResponseTime,
				};
			})()
		: undefined;
	const emergencyDropEligible =
		args.forceMaterialization === true ||
		args.contextUsage.percentage >= forceMaterializationPercentage;
	// Build the fold state once and reuse it for both the preflight and the wire
	// injection. Omitting a render-affecting field from only one of those calls can
	// manufacture a HARD signal that the real injection immediately disproves.
	const piM0State: PiM0M1State | undefined =
		args.injection && piHardSignals
			? {
					sessionId: args.sessionId,
					projectIdentity: args.projectIdentity,
					projectDirectory: args.projectDirectory,
					memoryEnabled: args.injection.memoryEnabled,
					injectDocs: args.injection.injectDocs,
					injectionBudgetTokens: args.injection.injectionBudgetTokens,
					historyBudgetTokens: args.injection.historyBudgetTokens,
					historyBudgetPolicyIdentity:
						args.injection.historyBudgetPolicyIdentity,
					hardSignals: piHardSignals,
					muralEnabled: args.injection.muralEnabled === true,
					freezePrefixForPass: true,
					allowFreshContentionFallback:
						args.forceMaterialization === true || emergencyDropEligible,
				}
			: undefined;
	const foldDueDecision = piM0State
		? mustMaterializePi(
				piM0State,
				args.db,
				injectionPassSnapshot?.compartments,
				injectionPassSnapshot,
			)
		: { value: false, reason: null };
	// Without history injection, first-time real entry tagging still builds a
	// fresh prefix. A later marker retry has a served snapshot and cannot use it.
	const firstRenderBust =
		piM0State !== undefined
			? !(
					injectionPassSnapshot?.cachedRow?.cached_m0_bytes &&
					injectionPassSnapshot.cachedRow.cached_m1_bytes
				)
			: args.stableIdSchemeCutover === true &&
				args.readLastServedMessages?.() === null;
	let foldExecutedThisPass = false;
	const effectiveSystemChangedThisPass =
		args.effectiveSystemHash !== undefined &&
		lastServedSystemHashBySession.has(args.sessionId) &&
		lastServedSystemHashBySession.get(args.sessionId) !==
			args.effectiveSystemHash;
	// The one bust permission an executed fold grants: true only when the fold
	// also loses the provider's cached prefix (see foldBustsServedPrefix). Every
	// lane that rides a fold consults it: legacy skeleton conversion, pending-op
	// drains, heuristics, synthetic todo and sentinel first-application.
	let foldBustsServedPrefixThisPass = false;
	let publishedM1RefreshedThisPass = false;
	let prefixPreflightContended = false;
	const softRefreshOpportunity = args.schedulerDecision === "execute";
	const cachedPrefixBeforePreflight =
		piM0State &&
		(foldDueDecision.value || softRefreshOpportunity) &&
		!emergencyDropEligible
			? prepareCachedM0M1PiReplay(
					piM0State,
					args.db,
					injectionPassSnapshot?.cachedRow,
				)
			: undefined;
	let preFoldInjectionResult: PiInjectionResult | null = null;
	const persistedM0BeforeFold =
		injectionPassSnapshot?.sessionMeta ?? args.sessionMeta;
	const m0CoverageBeforeFold =
		persistedM0BeforeFold.cachedM0Bytes === null
			? -1
			: persistedM0BeforeFold.cachedM0MaxCompartmentSeq;
	if (protectedSignedPrefix && !firstRenderBust && piM0State) {
		piM0State.preparedPrefix = prepareCachedM0M1PiReplay(
			piM0State,
			args.db,
			injectionPassSnapshot?.cachedRow,
		);
	}
	if (
		(!protectedSignedPrefix || firstRenderBust) &&
		(foldDueDecision.value || softRefreshOpportunity) &&
		piM0State
	) {
		try {
			// Persist the fold before opening mutation gates. The shadow array keeps
			// this pre-execution off the outgoing wire; the normal injection below
			// replays the persisted pair into the real message array.
			preFoldInjectionResult = injectM0M1PiForRun(
				piM0State,
				args.db,
				[],
				undefined,
				softRefreshOpportunity,
				injectionPassSnapshot,
			);
			if (protectedSignedPrefix && firstRenderBust) {
				const candidate = getOrCreateSessionMeta(args.db, args.sessionId);
				if (
					!servedPrefixMatches({
						messages: args.readLastServedMessages?.(),
						m0Text: candidate.cachedM0Bytes?.toString(),
						m1Text: candidate.cachedM1Bytes?.toString(),
						muralDataUrl: candidate.cachedM0MuralDataUrl,
					})
				)
					stripForPrefixRewrite();
			}
			prefixPreflightContended =
				preFoldInjectionResult.contentionExhausted === true;
			publishedM1RefreshedThisPass =
				!prefixPreflightContended &&
				persistedM0BeforeFold.cachedM1Bytes?.toString("utf8") !==
					getOrCreateSessionMeta(
						args.db,
						args.sessionId,
					).cachedM1Bytes?.toString("utf8");
			foldExecutedThisPass = foldExecutesThisPass(
				foldDueDecision.value || softRefreshOpportunity,
				preFoldInjectionResult.m0Materialized === true,
			);
			if (foldExecutedThisPass) {
				const afterFold = getOrCreateSessionMeta(args.db, args.sessionId);
				foldBustsServedPrefixThisPass =
					!protectedSignedPrefix &&
					foldBustsServedPrefix(
						// Pi's fold reason uses upstream metadata. Effective system
						// changes are measured separately at the context boundary.
						foldDueDecision.reason === "system_hash" &&
							!effectiveSystemChangedThisPass
							? undefined
							: foldDueDecision.reason,
						{
							m0Bytes: persistedM0BeforeFold.cachedM0Bytes ?? null,
							m1Bytes: persistedM0BeforeFold.cachedM1Bytes ?? null,
							muralDataUrl: persistedM0BeforeFold.cachedM0MuralDataUrl ?? null,
						},
						{
							m0Bytes: afterFold.cachedM0Bytes ?? null,
							m1Bytes: afterFold.cachedM1Bytes ?? null,
							muralDataUrl: afterFold.cachedM0MuralDataUrl ?? null,
						},
					);
			}
			if (preFoldInjectionResult.m0Materialized) {
				injectionPassSnapshot = createPiM0M1PassSnapshot({
					db: args.db,
					sessionId: args.sessionId,
					compactionOff: false,
					compartments: injectionPassSnapshot?.compartments,
				});
			}
			const m0CoverageAfterFold =
				injectionPassSnapshot?.sessionMeta.cachedM0MaxCompartmentSeq ??
				m0CoverageBeforeFold;
			try {
				rearmChannel2AfterCoverageAdvancingHardFold({
					db: args.db,
					sessionId: args.sessionId,
					foldExecuted: foldExecutedThisPass,
					compactionOff: false,
					previousCoverage: m0CoverageBeforeFold,
					currentCoverage: m0CoverageAfterFold,
				});
			} catch (error) {
				sessionLog(
					args.sessionId,
					`pi channel2 fold-cycle reset failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} catch (error) {
			piM0State.preparedPrefix = cachedPrefixBeforePreflight;
			prefixPreflightContended = true;
			sessionLog(
				args.sessionId,
				`pi m[0] HARD fold pre-execution failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const mismatch = foldDueDecision.mismatch
			? ` mismatch=${JSON.stringify(foldDueDecision.mismatch)}`
			: "";
		sessionLog(
			args.sessionId,
			`pi m[0] HARD fold decision: reason=${preFoldInjectionResult?.m0Reason ?? foldDueDecision.reason ?? "soft_refresh"}${mismatch} executed=${foldExecutedThisPass} bustsServedPrefix=${foldBustsServedPrefixThisPass}`,
		);
	}
	// Observe candidates before any history cut. Replay only durable decisions
	// until the independently priced rebuild permission below is known.
	const temporalCandidates = args.temporalAwareness
		? collectPiTemporalCandidates(args.messages, args.entryIds ?? [])
		: new Map<string, string>();
	// Older versions removed a gap at a compaction seam. Preserve those already
	// served choices; new seams no longer create a position-dependent removal.
	for (const entry of readPiIdentityDecisions(args.db, args.sessionId) ?? []) {
		const decision = decodePiContentDecision(entry);
		if (decision?.[0] === "seam-temporal-strip")
			temporalCandidates.set(decision[1], "");
	}
	let temporalDecisions = args.temporalAwareness
		? observeTemporalDecisions(
				args.db,
				args.sessionId,
				temporalCandidates,
				(ids) =>
					readServedTemporalDecisions(args.db, args.sessionId, "pi", ids),
			)
		: new Map<string, string>();
	if (args.temporalAwareness) {
		const tTemporal = performance.now();
		try {
			const injected = injectPiTemporalMarkers(
				args.messages,
				temporalDecisions,
				stableIdResolver,
			);
			if (injected > 0) {
				sessionLog(
					args.sessionId,
					`temporal-awareness: injected ${injected} gap markers`,
				);
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`temporal-awareness failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		logTransformTiming(args.sessionId, "injectTemporalMarkers", tTemporal);
	}

	// Pass entryIds so the transcript tags each message under its real SessionEntry
	// id (position-independent) instead of the index-based pi-msg-* id that drifts
	// when the visible array shifts (compaction trim / custom_message inserts),
	// orphaning tags/source_contents/caveman/drop-state. Positional entryIds is
	// exactly aligned here: tagging runs at transcript-build time, before any splice.
	let nativeRemovalInputs: Map<string, string> | undefined;
	try {
		nativeRemovalInputs = getNativeReplayState(
			args.db,
			args.sessionId,
		).toolInputs;
	} catch {
		/* Invalid native state must retain the whole pair. */
	}
	const tTranscriptBuild = performance.now();
	const transcript = createPiTranscript(
		args.messages,
		args.sessionId,
		// Reusing a stored tag and assigning a new one must see the same assistant
		// entry id. A branch message reference can resolve even when an extension
		// edit made its positional entry-id slot unavailable.
		args.messages.map(stableIdResolver),
		{
			preserveReasoningToolArcs:
				args.reasoningClearing?.preserveReasoningToolArcs,
			// Legacy full drops were skeletons even without a native envelope. The
			// existing tool-input lane freezes their first priced structural removal.
			authorizeToolRemoval: (callId) =>
				authorizePiToolRemoval({
					db: args.db,
					sessionId: args.sessionId,
					callId,
					saved: nativeRemovalInputs,
					canApply: isCacheBustingPass,
				}),
			authorizeToolRemovals: (callIds) =>
				preparePiToolRemovalMeasurements({
					db: args.db,
					sessionId: args.sessionId,
					callIds,
					saved: nativeRemovalInputs,
					canApply: isCacheBustingPass,
				}),
		},
	);
	logTransformTiming(args.sessionId, "transcriptBuild", tTranscriptBuild);
	// Reasoning clearing/replay mutate `part.thinking` in place. They MUST target
	// the transcript's `working` array (the channel commit() flushes), not the
	// original `args.messages`: tagging/drops/caveman reassign working[idx] to
	// fresh objects, so a reasoning mutation written to args.messages[idx] (a
	// now-divergent object) would be discarded when commit() does
	// source[idx] = working[idx], leaving the cleared-reasoning watermark ahead
	// of the actual wire bytes → defer-pass replay divergence → cache bust.
	const workingMessages = transcript.getWorkingMessages();
	workingForRewrite = workingMessages;
	// Stable-id resolver for the reasoning/placeholder paths. MUST match the id the
	// transcript assigned each message (so reasoning's messageIdToMaxTag lookup
	// hits). Reasoning runs on `workingMessages` where tagging may have cloned
	// working[i] → entryIdByRef misses those, so positional args.entryIds is the
	// mandatory fallback (same precedence resolvePiStableId enforces).
	const currentTurnId = (() => {
		const ids = buildPiMessageIdByIndex(
			args.messages as PiAgentMessage[],
			args.entryIds ?? null,
		);
		return (
			findLatestUserMessageIdPi(args.messages as PiAgentMessage[], ids)
				?.messageId ?? null
		);
	})();
	const alreadyRanHeuristicsThisTurn =
		currentTurnId !== null &&
		lastHeuristicsTurnIdBySession.get(args.sessionId) === currentTurnId;
	// Pi's primary process always registers ctx_reduce. Hidden/no-session child
	// processes do not use this context handler; if a future path marks a session
	// as subagent here, suppress visible tags and nudges so the prompt never points
	// at a missing session-scoped tool.
	const ctxReduceCallable = !args.sessionMeta.isSubagent;
	// Deferred publication signals may be consumed only on a pass that already
	// has a genuine bust opportunity. Pi's historian is detached and signals via
	// the deferred sets post-publish, so there is no inline await to special-case.
	const canConsumeDeferredLate =
		args.schedulerDecision === "execute" ||
		args.forceMaterialization === true ||
		args.contextUsage.percentage >= forceMaterializationPercentage;
	let deferredMaterializeEligible =
		canConsumeDeferredLate &&
		deferredMaterializationSessions.has(args.sessionId) &&
		!protectedSignedPrefix;
	// Primary sessions run routine age-sensitive cleanup only once during an
	// unbroken stretch of execute/emergency pressure. Later passes still evaluate
	// emergency drops, but another batch requires pressure to clear and rise again.
	const executePressureEligible =
		args.schedulerDecision === "execute" || emergencyDropEligible;
	if (!executePressureEligible) {
		routinePressureAppliedBySession.delete(args.sessionId);
	} else if (!args.sessionMeta.isSubagent && alreadyRanHeuristicsThisTurn) {
		routinePressureAppliedBySession.set(args.sessionId, true);
	}
	const routinePressureAlreadyApplied =
		!args.sessionMeta.isSubagent &&
		executePressureEligible &&
		routinePressureAppliedBySession.get(args.sessionId) === true;
	let hasPendingMaterializeSignal =
		!protectedSignedPrefix && hasPendingMaterialization(args.sessionId);
	// Subagents have no history fold to ride. Their execute pass admits every
	// eligible cleanup lane together, without rewriting bytes when none acts.
	// Idle expiry admits eligible edits after kept thinking only while a signed
	// turn is unfinished. Otherwise, expiry adds no cleanup permission beyond
	// the existing history rebuild, explicit flush and pressure-relief rules.
	const heldIdleExpiryRebuild =
		protectedSignedPrefix && piHardSignals?.cacheExpired === true;
	const systemPrefixChangedThisPass =
		!prefixPreflightContended && effectiveSystemChangedThisPass;
	// Deferred render requests and native marker retries do not prove that the
	// served system/m[0]/m[1] prefix changed. Only a user flush may deliberately
	// admit drops when that prefix is unchanged.
	const rideSignals = {
		subagentExecute:
			args.sessionMeta.isSubagent && args.schedulerDecision === "execute",
		hardFold:
			foldBustsServedPrefixThisPass ||
			systemPrefixChangedThisPass ||
			firstRenderBust ||
			heldIdleExpiryRebuild ||
			isCacheBustingPass,
		force:
			(args.forceMaterialization === true || emergencyDropEligible) &&
			(args.contextUsage.percentage >= 95 ||
				getEmergencyInputSample(args.db, args.sessionId) === 0),
		explicitFlush:
			!protectedSignedPrefix &&
			(args.userFlushOrigin === true ||
				hasPendingMaterializationOrigin(
					pendingMaterializationSessions,
					args.sessionId,
					"user_flush",
				)),
		publishedHistory: !prefixPreflightContended && publishedM1RefreshedThisPass,
	};
	// Warm-cache thinking holds defer every new prefix edit. First render, idle
	// expiry and pressure relief can admit work, but target guards still forbid
	// edits before retained signatures. A genuine rewrite omits all signed blocks;
	// expiry alone leaves them and their preceding bytes intact.
	let prefixMutationAllowed =
		!protectedSignedPrefix ||
		firstRenderBust ||
		heldIdleExpiryRebuild ||
		emergencyDropEligible;
	isCacheBustingPass = prefixMutationAllowed && hasReclaimRide(rideSignals);
	let publishedWorkDrainAllowed = isCacheBustingPass;
	const usesTokenProtection =
		args.protectedTokenTierOverrides !== undefined ||
		args.protectedTokens !== undefined;
	const resolveProtectionFloor = () =>
		resolveEpochFloorForPass(args.db, args.sessionId, {
			configuredOverride: args.protectedTokens,
			tierOverrides: args.protectedTokenTierOverrides,
			usableSoft: args.usableSoft,
			isCacheBustingPass,
			onRejectedProjectOverride: (warning) =>
				sessionLog(args.sessionId, warning),
		});
	let protectionFloorResolution = resolveProtectionFloor();
	let shouldRunHeuristics =
		args.heuristics !== undefined &&
		isCacheBustingPass &&
		(rideSignals.publishedHistory ||
			systemPrefixChangedThisPass ||
			rideSignals.explicitFlush ||
			args.forceMaterialization === true ||
			hasPendingMaterializeSignal ||
			deferredMaterializeEligible ||
			// A fold persisted earlier in this pass changed the served prefix, so
			// reductions may ride it without causing an independent bust.
			foldBustsServedPrefixThisPass ||
			firstRenderBust ||
			heldIdleExpiryRebuild ||
			(args.recoveryRebuildReason !== undefined && isCacheBustingPass) ||
			rideSignals.subagentExecute ||
			(args.schedulerDecision === "execute" && !alreadyRanHeuristicsThisTurn));
	let unavoidableCarriedIdentityRebuild = false;
	if (
		protectedSignedPrefix &&
		readPiIdentityRebuilds(args.db, args.sessionId).length > 0
	) {
		// Try the last served prefix before tagging can expose new numbers that
		// another writer committed to the database but never sent to the provider.
		args.tryReplayHeldIdentityRebuild?.();
		stripForPrefixRewrite();
		unavoidableCarriedIdentityRebuild = true;
		prefixMutationAllowed = true;
		args.tagger.cleanup(args.sessionId);
		args.tagger.initFromDb(args.sessionId, args.db);
	}

	// 1. Tagging: assigns tag numbers + injects §N§ prefixes when ctx_reduce
	// is callable. DB-side tag IDs still get created when prefixes are skipped
	// so queued drops and automatic cleanup continue to work.
	//
	// Pi-only fallback-tag adoption: the newest (in-flight) message is tagged
	// under an unstable pi-msg-* fallback id on the pass it is newest (its real
	// SessionEntry id isn't resolvable yet), then resolves to its real id one
	// pass later. Build a raw-message fingerprint map (BEFORE tagging mutates
	// text) and migrate any fallback-id tag onto the real id up front, so the
	// message keeps its tag_number/§N§ instead of getting a fresh tag. No-op for
	// OpenCode (this path is Pi-only) and for messages already on a real id.
	// Sync the tag snapshot (and its cached fallback rows) before taking
	// preflightRevision. Syncing deletes consumed rows from a TEMP change table;
	// if that write came after preflightRevision, adoptPiFallbackTags would count
	// it as a tag change since preflight and take its slower rebuild path.
	const tTagSnapshotSync = performance.now();
	readPiFallbackTagRows(args.db, args.sessionId);
	logTransformTiming(args.sessionId, "tagSnapshotSync", tTagSnapshotSync);
	const tFallbackIdentity = performance.now();
	// This indexed preflight avoids rebuilding fingerprints for every old message.
	// adoptPiFallbackTags rechecks a negative result with a table query once the
	// fingerprint map built below is complete; its tool-owner probe also runs
	// only at that point.
	const preflightRevision = readPiAdoptionRevision(args.db);
	const hasFallbackMessageTags = hasPiFallbackMessageTags(
		args.db,
		args.sessionId,
	);
	let fallbackCache = piFallbackIndexesBySession.get(args.sessionId);
	if (!fallbackCache || fallbackCache.db !== args.db) {
		fallbackCache = { db: args.db, index: createPiFallbackIndex() };
		piFallbackIndexesBySession.set(args.sessionId, fallbackCache);
	}
	const fallbackIndex = fallbackCache.index.update({
		messages: args.messages as PiAgentMessage[],
		fields: args.fallbackInputFields,
		resolveId: stableIdResolver,
		header: piMessageEntryFingerprintHeader,
		fingerprint: piMessageEntryFingerprint,
		toolOwners: (message, id) => buildPiToolOwnerMap([message], () => id),
		reusable: args.reusableMessageIds,
	});
	const entryFingerprintByMessageId = fallbackIndex.fingerprints(
		hasFallbackMessageTags
			? readPiFallbackFingerprintHeaders(args.db, args.sessionId)
			: undefined,
	);
	args.assertCurrentPass?.();
	const identityAdoption = adoptPiFallbackTags(
		args.db,
		args.sessionId,
		args.tagger,
		entryFingerprintByMessageId,
		{
			allowUnprovenRebuild: true,
			deferUnprovenRebuild: !prefixMutationAllowed,
			messages: args.messages as PiAgentMessage[],
			resolveStableId: stableIdResolver,
			toolOwners: fallbackIndex.owners,
			realIdPositions: fallbackIndex.positions,
			hasFallbackMessageTags,
			preflightRevision,
			rebuildFingerprints: args.reusableMessageIds?.size
				? () => {
						args.assertCurrentPass?.();
						// Runs with the writer held, so the fallback rows read here are
						// authoritative. Only messages sharing a fallback row's header
						// can match it; retrieve those indexed fingerprints, not history.
						const full = fallbackIndex.fingerprints(
							readPiFallbackFingerprintHeaders(args.db, args.sessionId),
						);
						for (const [id, fingerprint] of full)
							entryFingerprintByMessageId.set(id, fingerprint);
						return entryFingerprintByMessageId;
					}
				: undefined,
		},
	);
	let identityRebuild =
		unavoidableCarriedIdentityRebuild || identityAdoption.rebuilds.length > 0;
	if (identityRebuild) {
		if (!prefixMutationAllowed) {
			// A pending repair can arrive after the entry check. Try the previously
			// served numbers again, keeping its pending record when replay succeeds.
			if (!unavoidableCarriedIdentityRebuild) {
				args.tryReplayHeldIdentityRebuild?.();
				stripForPrefixRewrite();
				args.tagger.cleanup(args.sessionId);
				args.tagger.initFromDb(args.sessionId, args.db);
			}
			// Without a replayable prefix, guessing old numbers is unsafe and a
			// refusal would repeat on every tool step. Pay for the declared rebuild
			// once instead, and let eligible riders share that unavoidable bust.
			prefixMutationAllowed = true;
		}
		args.schedulerDecision = "execute";
		hasPendingMaterializeSignal = hasPendingMaterialization(args.sessionId);
		deferredMaterializeEligible =
			canConsumeDeferredLate &&
			deferredMaterializationSessions.has(args.sessionId);
		isCacheBustingPass = prefixMutationAllowed;
		publishedWorkDrainAllowed = isCacheBustingPass;
		shouldRunHeuristics = args.heuristics !== undefined;
		if (piM0State && prefixMutationAllowed) {
			try {
				clearM0M1PiCache(
					args.db,
					args.sessionId,
					PI_TAG_IDENTITY_REPAIR_REASON,
				);
				piM0State.preparedPrefix = undefined;
				piM0State.freezePrefixForPass = false;
				injectionPassSnapshot = createPiM0M1PassSnapshot({
					db: args.db,
					sessionId: args.sessionId,
					compactionOff: false,
				});
			} catch (error) {
				if (claimPiIdentityRebuildFailure(args.db, args.sessionId) === "first")
					throw error;
				identityRebuild = false;
				piM0State.preparedPrefix ??= prepareCachedM0M1PiReplay(
					piM0State,
					args.db,
					injectionPassSnapshot?.cachedRow,
				);
				piM0State.freezePrefixForPass = true;
				sessionLog(
					args.sessionId,
					"Pi identity rebuild failed again; serving with the repair still pending",
				);
			}
		}
	}
	if (args.temporalAwareness && isCacheBustingPass && !protectedSignedPrefix) {
		temporalDecisions = freezeTemporalDecisions(
			args.db,
			args.sessionId,
			temporalCandidates,
		);
		if (
			injectPiTemporalMarkers(
				args.messages,
				temporalDecisions,
				stableIdResolver,
			) > 0
		)
			recordFirstApplicationWireEdit(true);
	}
	logPiUnresolvedIdentities(args.sessionId, [
		...guardPiToolAllocations(
			args.db,
			args.sessionId,
			args.messages as PiAgentMessage[],
			stableIdResolver,
			args.tagger,
			fallbackIndex.guardIndexes,
		),
		...guardPiMessageAllocations(
			args.db,
			args.sessionId,
			entryFingerprintByMessageId,
		),
	]);
	logTransformTiming(
		args.sessionId,
		"fallbackIdentityAndAdoption",
		tFallbackIdentity,
	);
	afterFallbackAdoptionForTests?.(args.stableIdSchemeCutover === true);
	const textIdentityPlan = buildPiTextIdentityPlan(
		args.db,
		args.sessionId,
		args.tagger,
		transcript,
		args.reusableMessageIds,
	);
	const tTag = performance.now();
	// Part getters build fresh proxy objects. Reuse one view for tagging and
	// safety coordinates; its proxies still read/write the working messages.
	const mutationView = transcript.messages.map((message) => ({
		...message,
		parts: message.parts,
	}));
	// Storage recovery sent these messages without the §N§ message-number markers.
	// Adding markers changes cached bytes, so wait for permission to rewrite the
	// request or repair its tag identities. Release the recovery copy when that
	// permission arrives, before applying drops, so it cannot hide saved changes
	// that later requests will replay from the database.
	const recoveryNormalized =
		!!args.recoveryPrefix && (isCacheBustingPass || identityRebuild);
	const taggingView =
		args.recoveryPrefix && !recoveryNormalized
			? mutationView.filter(
					(message) =>
						!args.recoveryPrefix?.untaggedInputIds.has(message.info.id ?? ""),
				)
			: mutationView;
	let tagTextTokenCache = piTagTextTokenCacheBySession.get(args.sessionId);
	if (!tagTextTokenCache) {
		tagTextTokenCache = new Map();
		piTagTextTokenCacheBySession.set(args.sessionId, tagTextTokenCache);
	}
	let tagToolTokenCache = piTagToolTokenCacheBySession.get(args.sessionId);
	if (!tagToolTokenCache) {
		tagToolTokenCache = new Map();
		piTagToolTokenCacheBySession.set(args.sessionId, tagToolTokenCache);
	}
	// Without tag targets none of the session's persisted drops can be
	// replayed, so a tagging failure must not fall through to Pi's raw
	// messages; see runPersistedReplayStage.
	const { targets } = runPersistedReplayStage(
		"tagging-persistence-failure",
		() => args.tagger.cleanup(args.sessionId),
		() => {
			args.assertCurrentPass?.();
			return tagTranscript(
				args.sessionId,
				{ ...transcript, messages: taggingView },
				args.tagger,
				args.db,
				{
					skipPrefixInjection: !ctxReduceCallable,
					entryFingerprintByMessageId,
					reuseMessageIds: textIdentityPlan.reusableMessageIds,
					textIdentityDriftMessageIds: textIdentityPlan.driftedMessageIds,
					textIdentitySourceCache: textIdentityPlan.sourceCache,
					textTokenCache: tagTextTokenCache,
					toolTokenCache: tagToolTokenCache,
					onTiming: hasPiTransformTimingObserver()
						? (phase, elapsedMs) => {
								recordPiTransformTiming({
									sessionId: args.sessionId,
									stage: `tag:${phase}`,
									elapsedMs,
								});
							}
						: undefined,
				},
			);
		},
	);
	logTransformTiming(args.sessionId, "tagMessages", tTag);
	const reasoningTagsForProtection = buildMessageIdToMaxTag(targets);
	const frozenThinkingForProtection = activeThinkingTurn
		? frozenBindingEntryIds(args.db, args.sessionId)
		: new Set<string>();
	const protectedThinkingProxies = new Set<unknown>();
	if (activeThinkingTurn) {
		// mutationView is the filtered transcript message array: dropped/empty
		// messages are absent. Its indices and IDs, not workingMessages indices,
		// locate the thinking whose preceding bytes must remain unchanged.
		const rawById = new Map(
			workingMessages.map((message, index) => [
				stableIdResolver(message, index),
				message,
			]),
		);
		for (
			let i = latestAssistantTurnStart(mutationView);
			i < mutationView.length;
			i++
		) {
			const id = mutationView[i].info.id;
			if (
				!thinkingRecovery.restore &&
				id &&
				frozenThinkingForProtection.has(id)
			)
				continue;
			for (let p = 0; p < mutationView[i].parts.length; p++) {
				const part = mutationView[i].parts[p];
				if (part.kind !== "thinking") continue;
				const raw = rawById.get(id) as
					| { content?: { redacted?: boolean }[] }
					| undefined;
				const redacted = raw?.content?.some((part) => part.redacted === true);
				if (
					!thinkingRecovery.restore &&
					!redacted &&
					id &&
					(reasoningTagsForProtection.get(id) ?? Infinity) <=
						(args.sessionMeta.clearedReasoningThroughTag ?? 0)
				)
					continue;
				protectedThinkingProxies.add(part);
			}
		}
	}
	let newTargets = new Map(
		protectNewTagMutations(
			mutationView.map((message) => ({
				info: message.info,
				parts: message.parts,
			})),
			targets,
			protectedThinkingProxies,
			args.reasoningClearing?.prefixBound === true,
		),
	);
	if (
		protectedSignedPrefix &&
		args.contextUsage.percentage >= 95 &&
		!args.upperEstimateOnly
	) {
		const candidates = getActiveTagsBySession(args.db, args.sessionId).filter(
			(tag) => tag.type === "tool" && targets.get(tag.tagNumber)?.canDrop?.(),
		);
		if (
			candidates.length > 0 &&
			candidates.every(
				(tag) =>
					newTargets.get(tag.tagNumber)?.thinkingRewriteProtected === true,
			)
		) {
			stripForPrefixRewrite();
			newTargets = targets;
			prefixMutationAllowed = true;
			isCacheBustingPass = true;
			publishedWorkDrainAllowed = true;
			shouldRunHeuristics = args.heuristics !== undefined;
			hasPendingMaterializeSignal = hasPendingMaterialization(args.sessionId);
		}
	}
	for (const number of identityAdoption.protectedTagNumbers) {
		if (rewritingSignedPrefix) break;
		const target = newTargets.get(number);
		if (!target) continue;
		// A drop recovered from the deleted tag remains queued. This request must
		// keep the active bytes already returned; a later execute may change them.
		// Its own flag, not thinkingDropProtected: that one also keeps a pending
		// flush signal alive (thinking retries on the next pass), which would make
		// the next scheduler-deferred pass apply this queued drop as a second bust.
		newTargets.set(number, {
			...target,
			identityRepairProtected: true,
			thinkingRewriteProtected: true,
			canDrop: () => false,
			drop: () => "incomplete",
			truncate: () => "incomplete",
			skeletonReal: () => "incomplete",
			skeletonStripped: () => "incomplete",
			editMarker: () => "incomplete",
			editMarkerStripped: () => "incomplete",
			setContent: () => false,
		});
	}
	if (thinkingRecovery.restore && !rewritingSignedPrefix) {
		transcript.commit();
		restoreOriginals = captureOriginalTurn(
			args.messages as unknown[],
			(message) => (message as { content: unknown }).content,
			(message, content) => {
				(message as { content: unknown }).content = content;
			},
		);
	}

	// Legacy dropped-tool skeletons (argument marker) convert to the
	// real-or-absent rule only on a pass whose HARD fold executed and loses the
	// cached prefix anyway (foldBustsServedPrefixThisPass), so the byte change
	// rides that fold's cache bust. The fold committed before tagging
	// built the targets the decision needs, so this is its own transaction
	// right after it; the status replay below then renders the new modes. A
	// crash between the two leaves the tags legacy until the next HARD fold.
	// Either way the next served request already carries the fold's new cached
	// prefix, so it is a cache bust regardless of the tool bytes.
	if (foldBustsServedPrefixThisPass) {
		try {
			let converted = 0;
			args.db
				.transaction(() => {
					converted = convertLegacyToolSkeletons(
						args.db,
						args.sessionId,
						targets,
						{
							// A full drop whose arc removal is recorded was removed, not
							// served as a marker. Keep it full even when this pass's model
							// must keep tool pairs, so passes that can remove it still do
							// and the placeholder strip never sees its call come back.
							// Unreadable removal records keep every full drop as it is.
							keepFullDrop: (callId) =>
								nativeRemovalInputs === undefined ||
								(callId !== null &&
									nativeRemovalInputs.get(callId) ===
										NATIVE_TOOL_REMOVAL_MARKER),
						},
					).size;
				})
				.immediate();
			if (converted > 0) {
				sessionLog(
					args.sessionId,
					`pi HARD fold converted ${converted} legacy dropped-tool skeleton(s) to real-or-absent`,
				);
			}
		} catch (error) {
			sessionLog(
				args.sessionId,
				`pi legacy dropped-tool skeleton conversion failed (kept legacy bytes): ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	// 1b. Note-nudge `commit_detected` trigger. Mirrors OpenCode's logic
	// in `tag-messages.ts` + `transform.ts:677-690`: only fire on the
	// RISING edge (this pass saw a commit, previous pass did not, and a
	// previous pass actually ran). First-pass detection silently sets
	// the baseline so a fresh restart over an old session that already
	// committed doesn't surface a stale trigger.
	//
	// Subagents never deliver note nudges (gated in postprocess), so
	// skip accumulating orphan trigger state.
	try {
		if (!args.sessionMeta.isSubagent) {
			const hasRecentCommit = detectRecentCommit(args.messages);
			const hadPriorCommitState = commitSeenLastPass.has(args.sessionId);
			const sawCommitLastPass = commitSeenLastPass.get(args.sessionId) ?? false;
			if (hadPriorCommitState && hasRecentCommit && !sawCommitLastPass) {
				onNoteTrigger(args.db, args.sessionId, "commit_detected");
			}
			commitSeenLastPass.set(args.sessionId, hasRecentCommit);
		}
	} catch (err) {
		// commit-detect is opportunistic; failure should not break the
		// pipeline. Log and continue.
		sessionLog(
			args.sessionId,
			`commit-detect failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// 2. Apply queued drops from pending_ops. Gated on scheduler decision
	// because materialization mutates tag content, busting provider cache.
	// Mirrors OpenCode's transform-postprocess-phase.ts:184-186 gating:
	// run on execute, force, OR when /ctx-flush has set
	// pendingMaterializationSessions for this session. Hash-change
	// detection in `before_agent_start` also signals this set so a
	// real prompt-content change forces materialization on the same
	// turn the cache already busts.
	// Normal drains wait while this session's historian is in flight. Force
	// materialization and successfully executed m[0] folds may bypass that veto.
	//
	// PEEK-then-drain-on-success pattern (Oracle audit Round 8 #6):
	// the signal is only deleted AFTER applyPendingOperations succeeds.
	// If the call throws, the flag survives so the next pass retries.
	//
	// Drops in the protected window are deferred (re-queued) so the
	// agent's recent working context stays intact.
	const deferredMaterializationWasPending = deferredMaterializationSessions.has(
		args.sessionId,
	);
	const deferredHistoryRefreshWasPending = deferredHistoryWasPendingAtPassStart;
	// Defer passes replay persisted tag statuses below; they never apply newly
	// queued operations. Avoid reading pending_ops unless this pass can consume
	// them, matching OpenCode's cache-stable per-pass gate.
	const shouldReadPendingOps =
		!args.compactionOff &&
		(publishedWorkDrainAllowed ||
			args.schedulerDecision === "execute" ||
			args.forceMaterialization ||
			hasPendingMaterializeSignal ||
			foldExecutedThisPass ||
			firstRenderBust);
	const pendingOps = shouldReadPendingOps
		? getPendingOps(args.db, args.sessionId)
		: [];
	const reclaimDistance = isCacheBustingPass
		? toolReclaimDistanceEntries(mutationView, targets)
		: [];
	const protectedToolTags = protectedToolTagNumbers(
		getActiveTagsBySession(args.db, args.sessionId),
		args.protectedTools,
	);
	for (const number of identityAdoption.protectedTagNumbers)
		protectedToolTags.add(number);
	const protectionWindowForPass = getProtectionWindowForSession(
		args.db,
		args.sessionId,
		protectionFloorResolution.floor,
	);
	const protectedTagNumbersForPass = usesTokenProtection
		? protectionWindowForPass.protectedTagNumbers
		: newestActiveTagNumbersByCount(
				getActiveTagsBySession(args.db, args.sessionId),
				args.protectedTags,
			);
	const pendingOperationTags =
		pendingOps.length > 0
			? getTagsForPendingOperations(
					args.db,
					args.sessionId,
					pendingOps.map((operation) => operation.tagId),
					usesTokenProtection ? 0 : args.protectedTags,
					RECENT_TOOL_SKELETON_WINDOW,
				)
			: [];
	const deferredMaterialize =
		canConsumeDeferredLate && deferredMaterializationWasPending;
	const deferredHistoryRefresh =
		canConsumeDeferredLate && deferredHistoryRefreshWasPending;
	const shouldApplyPendingOps = publishedWorkDrainAllowed;
	mutationGateObserverForTests?.({
		foldDue: foldDueDecision.value,
		foldExecuted: foldExecutedThisPass,
		foldBustsServedPrefix: foldBustsServedPrefixThisPass,
		shouldApplyPendingOps,
		shouldRunHeuristics,
		shouldRunReasoningCleanup:
			args.reasoningClearing !== undefined && shouldRunHeuristics,
	});
	if (shouldApplyPendingOps) {
		const applyReason = hasPendingMaterializeSignal
			? `pending_materialization origin=${pendingMaterializationOrigin(pendingMaterializationSessions, args.sessionId)}`
			: deferredMaterialize
				? "deferred_publication"
				: args.forceMaterialization
					? "force_materialization"
					: foldBustsServedPrefixThisPass &&
							args.schedulerDecision !== "execute"
						? `m0_hard_fold (drain folded into executed m[0] bust, scheduler=${args.schedulerDecision})`
						: `${reclaimRideLabel(rideSignals)} (scheduler=${args.schedulerDecision})`;
		const pendingOpsDepth = getPendingOpsCount(args.db, args.sessionId);
		const pendingDecisionLog = `pending ops WILL APPLY — reason=${applyReason}, pendingOps=${pendingOpsDepth === null ? "not loaded (deferred pass)" : pendingOpsDepth} context=${args.contextUsage.percentage.toFixed(1)}%`;
		sessionLog(args.sessionId, pendingDecisionLog);
		pendingDecisionLogObserverForTests?.(pendingDecisionLog);
		try {
			const tApplyPending = performance.now();
			pendingOpsDidMutate = applyPendingOperations(
				args.sessionId,
				args.db,
				newTargets,
				new Set([
					...(args.contextUsage.percentage >= 95
						? []
						: protectedTagNumbersForPass),
					...protectedToolTags,
					...identityAdoption.protectedTagNumbers,
				]),
				pendingOperationTags,
				pendingOps,
				[],
				new Set(),
				(reduction) => droppedTokenReductions.push(reduction),
				undefined,
				(eligible) => {
					eligiblePendingDropTagIds = eligible;
				},
			);
			if (pendingOpsDidMutate) {
				droppedCount += pendingOps.length;
			}
			logTransformTiming(
				args.sessionId,
				"applyPendingOperations",
				tApplyPending,
			);
			executedWorkThisPass ||= isCacheBustingPass;
			// materializationSatisfiedThisPass enables the deferred-HISTORY drain
			// below. OpenCode drains deferred-history on history-consumption alone
			// (not heuristics success), so setting this right after pending-ops
			// success matches OpenCode for the history drain.
			materializationSatisfiedThisPass = true;
			pendingOpsAppliedThisPass = true;
			if (hasPendingMaterializeSignal) {
				if (args.heuristics === undefined) {
					if (
						!pendingOps.some(
							(op) => newTargets.get(op.tagId)?.thinkingDropProtected,
						)
					)
						consumePendingMaterialization(args.sessionId);
				}
			}
			// NOTE: do NOT consume deferredMaterialization here. OpenCode only
			// marks deferredMaterializedSuccessfully AFTER the heuristics phase
			// also completes (its pending-ops + heuristics share one try block, and
			// the success flag is set at the end). If heuristics throws, OpenCode
			// leaves deferred-materialization UNdrained so the next pass retries the
			// full publication-driven materialization + heuristics. Pi's heuristics
			// run in a separate try below, so we defer this consume to after that
			// block, gated on heuristics success (or heuristics being disabled).
		} catch (err) {
			sessionLog(
				args.sessionId,
				`pending operations failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			throw err;
		}
	} else {
		const pendingOpsDepth = getPendingOpsCount(args.db, args.sessionId);
		const refusalReason =
			args.schedulerDeferReason ?? "no_originating_cache_bust";
		const pendingDecisionLog = `pending ops WILL NOT APPLY — reason=${refusalReason} pendingOps=${pendingOpsDepth === null ? "not loaded (deferred pass)" : pendingOpsDepth} context=${args.contextUsage.percentage.toFixed(1)}%`;
		sessionLog(args.sessionId, pendingDecisionLog);
		pendingDecisionLogObserverForTests?.(pendingDecisionLog);
	}

	// 3. Apply persistent dropped/truncated tag statuses so cross-pass
	// drops survive. Always runs, regardless of scheduler decision —
	// this is the cache-stable replay of mutations persisted on prior
	// execute passes. Mirrors OpenCode's `applyFlushedStatuses` call
	// at transform.ts:728.
	//
	// Status replay only acts on dropped targets. Filter by both status and
	// visible tag number in SQLite so active rows are not materialized merely to
	// be discarded by applyFlushedStatuses.
	const targetTagNumbers = [...targets.keys()];
	const tGetTags = performance.now();
	const flushedDroppedTags = getDroppedTagsByNumbers(
		args.db,
		args.sessionId,
		targetTagNumbers,
	);
	logTransformTiming(
		args.sessionId,
		"getDroppedTagsByNumbers",
		tGetTags,
		`targets=${targetTagNumbers.length} fetched=${flushedDroppedTags.length}`,
	);
	const tFlushed = performance.now();
	runPersistedReplayStage("flushed-status-failure", undefined, () =>
		applyFlushedStatuses(args.sessionId, args.db, targets, flushedDroppedTags),
	);
	logTransformTiming(args.sessionId, "applyFlushedStatuses", tFlushed);
	logTransformTiming(args.sessionId, "batchFinalize:flushed", tFlushed);

	// 3b. Reasoning replay (cache-stable, runs on EVERY pass).
	// Re-applies typed-reasoning [cleared] markers and inline
	// <thinking> stripping for messages whose tag is below the
	// persisted watermark. Pi rebuilds AgentMessage[] from the JSONL
	// on every context event, so without replay the original
	// thinking content would re-appear on defer passes and bust
	// provider prompt cache. Mirrors OpenCode's
	// `replayClearedReasoning` + `replayStrippedInlineThinking`
	// in transform-postprocess-phase.ts.
	const messageIdToMaxTag = buildMessageIdToMaxTag(targets);

	// Pi rebuilds messages from raw history on every request. Replay persisted
	// caveman compression first, then remove inline reasoning again. Compression
	// reads pristine source, so running it last would restore reasoning text that
	// an earlier request removed under the persisted reasoning-clear tag cutoff.
	if (args.heuristics?.caveman?.enabled && !args.isSubagent) {
		const tCavemanReplay = performance.now();
		try {
			const tags = getTagsByNumbers(args.db, args.sessionId, targetTagNumbers);
			const replayed = replayCavemanCompression(
				args.sessionId,
				args.db,
				targets,
				tags,
			);
			if (replayed > 0) {
				sessionLog(
					args.sessionId,
					`caveman replay: ${replayed} tags re-compressed from source`,
				);
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`caveman replay failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		logTransformTiming(args.sessionId, "cavemanReplay", tCavemanReplay);
	}

	if (args.reasoningClearing) {
		try {
			const tReplayReasoning = performance.now();
			const clearedReplay = replayClearedReasoningPi({
				protectLatestTurn: false,
				db: args.db,
				sessionId: args.sessionId,
				messages: workingMessages,
				messageIdToMaxTag,
				piMessageStableId: stableIdResolver,
			});
			const inlineReplay = replayStrippedInlineThinkingPi({
				protectLatestTurn: false,
				db: args.db,
				sessionId: args.sessionId,
				messages: workingMessages,
				messageIdToMaxTag,
				piMessageStableId: stableIdResolver,
			});
			if (clearedReplay > 0 || inlineReplay > 0) {
				sessionLog(
					args.sessionId,
					`reasoning replay: cleared=${clearedReplay} inline=${inlineReplay}`,
				);
			}
			logTransformTiming(
				args.sessionId,
				"replayReasoningClearing",
				tReplayReasoning,
			);
			logTransformTiming(
				args.sessionId,
				"stripClearedReasoning",
				tReplayReasoning,
				`strippedParts=${clearedReplay}`,
			);
		} catch (err) {
			sessionLog(
				args.sessionId,
				`reasoning replay failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// 3d. Cleanup stages NOT applicable to Pi (intentionally omitted):
	//
	// - stripStructuralNoise: removes OpenCode AI-SDK-specific part
	//   types (step-start, step-finish, meta, reasoning shells). Pi's
	//   AgentMessage shape doesn't have these — only text, toolCall,
	//   toolResult, thinking, image — so there's nothing to strip.
	//
	// - stripReasoningFromMergedAssistants: handles a quirk of the
	//   Vercel AI SDK where two consecutive assistant messages with
	//   reasoning parts get merged before send. Pi's send path doesn't
	//   merge messages this way, so the workaround isn't needed.
	//

	// 4. Heuristic cleanup — drops aged tools, dedups, strips system
	// injections, age-tier caveman compression. Gated on scheduler
	// decision because mutations bust provider cache; persisted to DB
	// so subsequent defer passes replay via applyFlushedStatuses.
	// Mirrors OpenCode's `applyHeuristicCleanup` call in
	// transform-postprocess-phase.ts.
	let heuristicsExecuted = false;
	let routineCleanupApplied = false;
	let heuristicsResult: PiHeuristicCleanupResult | null = null;
	const tActiveTags = performance.now();
	// Load the canonical tag set once after pending operations. Heuristics use its
	// active projection; Channel-1 baseline construction reuses the full set.
	const allTagsForPass = getPiTagSnapshotView(args.db, args.sessionId);
	// Same rows as filtering allTagsForPass by status, kept current from changed
	// rows instead of walking every tag the session ever had.
	const activeTags = getPiActiveTagSnapshotView(
		args.db,
		args.sessionId,
		allTagsForPass,
	);
	logTransformTiming(
		args.sessionId,
		"getTagsBySessionSnapshot",
		tActiveTags,
		`all=${allTagsForPass.length} active=${activeTags.length}`,
	);
	if (shouldRunHeuristics) {
		const reason = args.forceMaterialization
			? "force_materialization"
			: foldBustsServedPrefixThisPass && args.schedulerDecision !== "execute"
				? `m0_hard_fold (drain folded into executed m[0] bust, scheduler=${args.schedulerDecision})`
				: `${reclaimRideLabel(rideSignals)} (pendingOps=${pendingOps.length}, scheduler=${args.schedulerDecision})`;
		const heuristicsDecisionLog = `heuristics WILL RUN — reason=${reason}, context=${args.contextUsage.percentage.toFixed(1)}%, turn=n/a`;
		sessionLog(args.sessionId, heuristicsDecisionLog);
		pendingDecisionLogObserverForTests?.(heuristicsDecisionLog);
	} else {
		const reason =
			args.heuristics === undefined
				? "disabled"
				: (args.schedulerDeferReason ??
					(!isCacheBustingPass
						? "no_originating_cache_bust"
						: alreadyRanHeuristicsThisTurn
							? "already_ran_this_turn"
							: "scheduler_defer"));
		const heuristicsDecisionLog = `heuristics WILL NOT RUN — reason=${reason}`;
		sessionLog(args.sessionId, heuristicsDecisionLog);
		pendingDecisionLogObserverForTests?.(heuristicsDecisionLog);
	}
	if (shouldRunHeuristics && args.heuristics) {
		try {
			const tHeuristic = performance.now();
			const independentMutationBeforeHeuristics =
				pendingOpsDidMutate ||
				systemPrefixChangedThisPass ||
				foldBustsServedPrefixThisPass ||
				identityRebuild ||
				firstRenderBust ||
				heldIdleExpiryRebuild;
			// Applied work, new identity numbers or a missing/cold cache already
			// cost a rebuild. Under force pressure, reset the saved emergency
			// sample so accumulated cleanup joins this pass. Restoring previously
			// served drops is not new work and must not start another batch.
			if (
				args.forceMaterialization === true &&
				independentMutationBeforeHeuristics &&
				getEmergencyInputSample(args.db, args.sessionId) > 0
			) {
				clearEmergencyDropSample(args.db, args.sessionId);
			}
			// Replaying persisted drop state yields the same served bytes every pass,
			// so it does not count as a new change. After the first pass under pressure,
			// allow routine cleanup again only when new work was applied or a fold ran.
			routineCleanupApplied =
				(emergencyDropEligible
					? args.contextUsage.percentage >= 95 ||
						getEmergencyInputSample(args.db, args.sessionId) === 0
					: args.sessionMeta.isSubagent || !routinePressureAlreadyApplied) ||
				hasPendingMaterializeSignal ||
				rideSignals.explicitFlush ||
				deferredMaterialize ||
				independentMutationBeforeHeuristics;
			heuristicsResult = applyPiHeuristicCleanup(
				args.sessionId,
				args.db,
				newTargets,
				args.messages,
				{
					protectedTags: args.protectedTags,
					prepareToolRemovalMeasurements:
						transcript.prepareToolRemovalMeasurements,
					protectedToolTags,
					protectedCutoff: usesTokenProtection
						? protectionWindowForPass.cutoff
						: undefined,
					routine: routineCleanupApplied,
					staleReduceStripEnabled: true,
					onStaleReduceEdit: recordStaleReduceEdit,
					// Tiered emergency drop fires only at the derived force band AND when the
					// ceiling is known. forceMaterialization already incorporates
					// the derived force-band / emergency condition for Pi (primary-equivalent).
					emergency:
						args.forceMaterialization === true &&
						args.emergencyCeilingTokens !== undefined &&
						args.emergencyCeilingTokens > 0
							? {
									currentTotalInputTokens: args.contextUsage.inputTokens,
									ceilingTokens: args.emergencyCeilingTokens,
									usagePercentage: args.contextUsage.percentage,
									passAlreadyPriced: independentMutationBeforeHeuristics,
								}
							: undefined,
					caveman: args.isSubagent ? undefined : args.heuristics.caveman,
				},
				activeTags,
				stableIdResolver,
			);
			if (
				!routineCleanupApplied &&
				heuristicsResult.emergencyDroppedTools > 0
			) {
				const ridingCleanup = applyPiHeuristicCleanup(
					args.sessionId,
					args.db,
					newTargets,
					args.messages,
					{
						protectedTags: args.protectedTags,
						protectedToolTags,
						protectedCutoff: usesTokenProtection
							? protectionWindowForPass.cutoff
							: undefined,
						routine: true,
						staleReduceStripEnabled: true,
						onStaleReduceEdit: recordStaleReduceEdit,
						caveman: args.isSubagent ? undefined : args.heuristics.caveman,
					},
					getActiveTagsBySession(args.db, args.sessionId),
					stableIdResolver,
				);
				heuristicsResult = {
					droppedTools:
						heuristicsResult.droppedTools + ridingCleanup.droppedTools,
					deduplicatedTools:
						heuristicsResult.deduplicatedTools +
						ridingCleanup.deduplicatedTools,
					droppedInjections:
						heuristicsResult.droppedInjections +
						ridingCleanup.droppedInjections,
					droppedStaleReduceCalls:
						heuristicsResult.droppedStaleReduceCalls +
						ridingCleanup.droppedStaleReduceCalls,
					emergencyDroppedTools: heuristicsResult.emergencyDroppedTools,
					compressedTextTags:
						heuristicsResult.compressedTextTags +
						ridingCleanup.compressedTextTags,
					mutatedTextTags:
						heuristicsResult.mutatedTextTags + ridingCleanup.mutatedTextTags,
					droppedTokenReductions: [
						...heuristicsResult.droppedTokenReductions,
						...ridingCleanup.droppedTokenReductions,
					],
				};
				routineCleanupApplied = true;
			}
			if (
				routineCleanupApplied &&
				!args.sessionMeta.isSubagent &&
				executePressureEligible
			) {
				routinePressureAppliedBySession.set(args.sessionId, true);
			}
			const heuristicMutationCount =
				heuristicsResult.droppedTools +
				heuristicsResult.deduplicatedTools +
				heuristicsResult.droppedInjections +
				heuristicsResult.droppedStaleReduceCalls +
				heuristicsResult.mutatedTextTags;
			droppedCount +=
				heuristicsResult.droppedTools +
				heuristicsResult.deduplicatedTools +
				heuristicsResult.droppedInjections +
				heuristicsResult.droppedStaleReduceCalls +
				heuristicsResult.mutatedTextTags;
			emergency ||= heuristicsResult.emergencyDroppedTools > 0;
			if (heuristicsResult.droppedTokenReductions.length > 0) {
				droppedTokenReductions.push(...heuristicsResult.droppedTokenReductions);
			}
			if (heuristicMutationCount > heuristicsResult.droppedStaleReduceCalls) {
				recordFirstApplicationWireEdit(true);
			}
			heuristicsExecuted = true;
			executedWorkThisPass = true;
			if (hasPendingMaterializeSignal) {
				if (
					!pendingOps.some(
						(op) => newTargets.get(op.tagId)?.thinkingDropProtected,
					)
				)
					consumePendingMaterialization(args.sessionId);
			}
			if (currentTurnId !== null) {
				lastHeuristicsTurnIdBySession.set(args.sessionId, currentTurnId);
			}
			logTransformTiming(
				args.sessionId,
				"applyHeuristicCleanup",
				tHeuristic,
				`droppedTools=${heuristicsResult.droppedTools} deduplicatedTools=${heuristicsResult.deduplicatedTools} droppedInjections=${heuristicsResult.droppedInjections} staleReduce=${heuristicsResult.droppedStaleReduceCalls} compressedTextTags=${heuristicsResult.compressedTextTags} mutatedTextTags=${heuristicsResult.mutatedTextTags}`,
			);
		} catch (err) {
			sessionLog(
				args.sessionId,
				`heuristic cleanup failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// Consume deferred-materialization ONLY after the full pass (pending ops +
	// heuristics) succeeded — matching OpenCode, which sets
	// deferredMaterializedSuccessfully after its shared pending-ops+heuristics
	// try block completes. If heuristics was SUPPOSED to run this pass
	// (shouldRunHeuristics) but threw (heuristicsExecuted stays false), we leave
	// the signal armed so the next pass retries the publication-driven
	// materialization + heuristics. When heuristics weren't scheduled this pass
	// (!shouldRunHeuristics — e.g. heuristics disabled), pending-ops success is
	// sufficient. Whenever deferredMaterialize is true, shouldRunHeuristics is
	// also true (deferredMaterializeEligible feeds it), so the common path waits
	// on heuristics exactly like OpenCode.
	if (deferredMaterialize && pendingOpsAppliedThisPass) {
		const fullPassSucceeded = shouldRunHeuristics ? heuristicsExecuted : true;
		if (fullPassSucceeded) {
			deferredMaterializationConsumedThisPass = consumeDeferredMaterialization(
				args.sessionId,
			);
		}
	}

	// 4b. Reasoning clearing on EXECUTE passes only (cache-busting).
	// Walks Pi assistant messages whose tag number is older than
	// `clearReasoningAge` from the newest tag and replaces typed
	// PiThinkingContent.thinking with `[cleared]`. Persists the
	// max-tag-cleared watermark so subsequent defer passes replay
	// the same set via the cache-stable replay above. Mirrors
	// OpenCode's `clearOldReasoning` (strip-content.ts) gated to
	// execute passes via the same scheduler decision used for
	// heuristic cleanup.
	// Gate reasoning clearing on the SAME signal as heuristic drops
	// (shouldRunHeuristics), not the narrower execute||forceMaterialization.
	// OpenCode runs clearOldReasoning inside its shouldRunHeuristics block, so
	// the reasoning-watermark advance rides the exact same cache-busting passes
	// as the tool drops. The old gate skipped reasoning on pending/deferred-
	// materialization passes where heuristics DO run — leaving reasoning on the
	// wire on a pass that already dropped tools (inconsistent + a missed
	// same-pass mutation). shouldRunHeuristics is the broader, correct set.
	let reasoningPersistenceFailed = false;
	let reasoningBudgetCutoffThisPass = 0;
	const nativeBudgetClearingAllowed = Boolean(
		args.reasoningClearing && args.reasoningClearing.prefixBound !== true,
	);
	if (
		args.reasoningClearing &&
		nativeBudgetClearingAllowed &&
		shouldRunHeuristics &&
		routineCleanupApplied &&
		!protectedSignedPrefix
	) {
		const rollbackReasoning = captureReasoningMutationRollback(workingMessages);
		try {
			const tClearReasoning = performance.now();
			const prevWatermark = args.sessionMeta.clearedReasoningThroughTag ?? 0;
			// Both lanes share one replayed watermark, so both use the same bound:
			// below the newest assistant, and on prefix-bound models below the
			// first assistant that would leave a gap in the cleared prefix.
			const prefixBound = args.reasoningClearing.prefixBound === true;
			const bindingStripped = prefixBound
				? frozenBindingEntryIds(args.db, args.sessionId)
				: new Set<string>();
			const nativeGone = getNativeReplayState(
				args.db,
				args.sessionId,
			).reasoningIds;
			const maxCutoff = piReasoningClearCutoff({
				protectLatestTurn: activeThinkingTurn,
				messages: workingMessages,
				messageIdToMaxTag,
				keepReasoningTokens:
					args.reasoningClearing.keepReasoningTokens ??
					DEFAULT_KEEP_REASONING_TOKENS,
				proseRatio: sessionDecisionCalibration(args.db, args.sessionId)
					.proseRatio,
				piMessageStableId: stableIdResolver,
				prefixBound,
				anthropic: args.canUseEmptySentinels || prefixBound,
				alreadyGone: (id) => bindingStripped.has(id) || nativeGone.has(id),
			});
			reasoningBudgetCutoffThisPass = maxCutoff;
			const clearOutcome = clearOldReasoningPi({
				protectLatestTurn: activeThinkingTurn,
				messages: workingMessages,
				messageIdToMaxTag,
				piMessageStableId: stableIdResolver,
				maxCutoff,
			});
			// The inline strip rewrites assistant text, an edit of an earlier
			// message, so it never starts on a prefix-bound model; the cutoff
			// above already stops below any text it could reach on replay.
			const stripOutcome = stripInlineThinkingPi({
				protectLatestTurn: activeThinkingTurn,
				messages: workingMessages,
				messageIdToMaxTag,
				piMessageStableId: stableIdResolver,
				maxCutoff: prefixBound ? 0 : maxCutoff,
			});
			const combinedWatermark = Math.max(
				clearOutcome.newWatermark,
				stripOutcome.newWatermark,
			);
			if (combinedWatermark > prevWatermark) {
				persistReasoningWatermarkForRun(args.db, args.sessionId, {
					clearedReasoningThroughTag: combinedWatermark,
				});
				args.sessionMeta.clearedReasoningThroughTag = combinedWatermark;
				sessionLog(
					args.sessionId,
					`reasoning cleanup: cleared=${clearOutcome.cleared} inlineStripped=${stripOutcome.stripped} watermark=${prevWatermark}→${combinedWatermark}`,
				);
			}
			logTransformTiming(args.sessionId, "clearOldReasoning", tClearReasoning);
			logTransformTiming(args.sessionId, "watermarkCleanup", tClearReasoning);
			if (clearOutcome.cleared > 0 || stripOutcome.stripped > 0) {
				heuristicOrReasoningDidMutate = true;
				droppedCount += clearOutcome.cleared + stripOutcome.stripped;
			}
			// On a prefix-bound model, clearing typed thinking is the
			// oldest-prefix removal; rewriting text never is.
			if (stripOutcome.stripped > 0) prefixEditBesidesReasoningTrim = true;
			if (clearOutcome.cleared > 0 && !prefixBound) {
				prefixEditBesidesReasoningTrim = true;
			}
			if (
				combinedWatermark > prevWatermark ||
				clearOutcome.cleared > 0 ||
				stripOutcome.stripped > 0
			) {
				executedWorkThisPass = true;
			}
		} catch (err) {
			reasoningPersistenceFailed = true;
			// Never ship cleared reasoning unless replay state persisted. Restoring the
			// pre-cleanup parts keeps this pass byte-stable and lets the next execute
			// pass retry the watermark write.
			rollbackReasoning();
			sessionLog(
				args.sessionId,
				`reasoning clearing failed; restored original reasoning: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// Fresh caveman compression in the heuristic cleanup above rebuilds text from
	// its original source, which brings back inline thinking that the replay at the
	// start of this pass removed. The fresh strip only reaches this pass's cutoff
	// (and never runs on prefix-bound models), while every later pass replays up to
	// the persisted watermark. Strip up to that watermark again so this pass serves
	// the bytes the next deferred pass will replay. This also covers the rollback
	// above. Not counted as a new edit: it only restores what replay already removed.
	if (args.reasoningClearing && shouldRunHeuristics && routineCleanupApplied) {
		try {
			replayStrippedInlineThinkingPi({
				protectLatestTurn: false,
				db: args.db,
				sessionId: args.sessionId,
				messages: workingMessages,
				messageIdToMaxTag,
				piMessageStableId: stableIdResolver,
			});
		} catch (err) {
			sessionLog(
				args.sessionId,
				`inline thinking re-strip after cleanup failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	const toolReclaimApplicationOpportunity = isCacheBustingPass;
	let autoReclaimTargetCount = 0;
	let autoReclaimDidMutate = false;
	if (toolReclaimApplicationOpportunity && !emergencyDropEligible) {
		const reclaimMeta = args.sessionMeta;
		const syntheticPendingOps = buildSyntheticToolReclaimOps({
			db: args.db,
			sessionId: args.sessionId,
			targets: newTargets,
			watermark: reclaimMeta.toolReclaimWatermark ?? 0,
			protectedToolTags,
			pendingOps,
		});
		// Smart-drops: also reclaim older todowrite/ctx_reduce/meta outputs that
		// a later call supersedes, and compress superseded edits to an
		// edit_marker (keep filePath + region hint). Merged into the same
		// already-gated drop apply as the age-based sweep above. Dedupe (a tag
		// can qualify under more than one rule).
		const editMarkerTagIds = new Set<number>();
		{
			const recentMessageIds = recentSupersessionOwnerMessageIds(
				args.db,
				args.sessionId,
			);
			const selectedIds = new Set(syntheticPendingOps.map((op) => op.tagId));
			const supersessionOps = buildSupersessionReclaimOps({
				db: args.db,
				sessionId: args.sessionId,
				targets: newTargets,
				pendingOps,
				recentMessageIds,
				protectedToolTags,
			});
			for (const op of supersessionOps) {
				if (!selectedIds.has(op.tagId)) {
					syntheticPendingOps.push(op);
					selectedIds.add(op.tagId);
				}
			}
			const editReclaim = buildEditSupersessionReclaim({
				watermark: reclaimMeta.toolReclaimWatermark ?? 0,
				db: args.db,
				sessionId: args.sessionId,
				targets: newTargets,
				pendingOps,
				recentMessageIds,
				protectedToolTags,
			});
			for (const op of editReclaim.ops) {
				// Drop wins over compress: only compress an edit no earlier rule
				// already selected for a full/skeleton drop.
				if (!selectedIds.has(op.tagId)) {
					syntheticPendingOps.push(op);
					selectedIds.add(op.tagId);
					editMarkerTagIds.add(op.tagId);
				}
			}
		}
		autoReclaimTargetCount = syntheticPendingOps.length;
		if (syntheticPendingOps.length > 0) {
			autoReclaimDidMutate = applyPendingOperations(
				args.sessionId,
				args.db,
				newTargets,
				protectedTagNumbersForPass,
				undefined,
				[],
				syntheticPendingOps,
				editMarkerTagIds,
				(reduction) => droppedTokenReductions.push(reduction),
			);
			if (autoReclaimDidMutate) {
				droppedCount += syntheticPendingOps.length;
				autoReclaimDidMutateThisPass = true;
			}
		}
	}

	// 4c. Replace answered images at/below the dropped-tag watermark with
	// non-empty text markers. Discover new message ids only when this pass is
	// already allowed to rewrite the prefix, and persist them before editing.
	// Replay saved ids on every provider and pass so removed bytes cannot return.
	{
		const tProcessedImages = performance.now();
		try {
			const imagePositionTags = new Map<string, number>();
			const noteImagePosition = (id: string | undefined, tag: number) => {
				if (id && tag > (imagePositionTags.get(id) ?? 0))
					imagePositionTags.set(id, tag);
			};
			for (const [tagNumber, target] of targets) {
				for (const { message, part } of target.mutationParts ?? []) {
					if (
						typeof part === "object" &&
						part !== null &&
						"kind" in part &&
						part.kind === "text"
					)
						noteImagePosition(message.info.id, tagNumber);
				}
			}
			// Transcript user rows can contain several results and a later user's
			// text. Associate tool tags with their native occurrences, never that row.
			const imageToolTags = new Map(
				allTagsForPass
					.filter((tag) => tag.type === "tool")
					.map((tag) => [
						`${tag.toolOwnerMessageId ?? ""}\0${tag.messageId}`,
						tag.tagNumber,
					]),
			);
			const imageToolOwners = new Map<string, string>();
			for (let index = 0; index < workingMessages.length; index++) {
				const message = workingMessages[index];
				const id = stableIdResolver(message, index);
				if (message.role === "assistant" && Array.isArray(message.content)) {
					for (const part of message.content) {
						if (part.type !== "toolCall") continue;
						imageToolOwners.set(part.id, id ?? "");
						noteImagePosition(
							id,
							imageToolTags.get(`${id ?? ""}\0${part.id}`) ?? 0,
						);
					}
				} else if (message.role === "toolResult") {
					noteImagePosition(
						id,
						imageToolTags.get(
							`${imageToolOwners.get(message.toolCallId) ?? ""}\0${message.toolCallId}`,
						) ?? 0,
					);
				}
			}
			const protectedImageToolKeys = new Set(
				activeTags
					.filter(
						(tag) =>
							tag.type === "tool" && protectedToolTags.has(tag.tagNumber),
					)
					.map((tag) =>
						tag.toolOwnerMessageId
							? `${tag.toolOwnerMessageId}\x00${tag.messageId}`
							: tag.messageId,
					),
			);
			const imageResult = stripPiProcessedImages({
				db: args.db,
				sessionId: args.sessionId,
				messages: workingMessages,
				detect: isCacheBustingPass && !protectedSignedPrefix,
				watermark: getMaxDroppedTagNumber(args.db, args.sessionId),
				messageIdToMaxTag: imagePositionTags,
				protectedCutoff: usesTokenProtection
					? protectionWindowForPass.cutoff
					: protectedTagNumbersForPass.size > 0
						? Math.min(...protectedTagNumbersForPass)
						: null,
				usagePercentage: args.contextUsage.percentage,
				protectedToolKeys: protectedImageToolKeys,
				stableId: stableIdResolver,
				onFirstApplication: recordFirstApplicationAt,
			});
			if (imageResult.newlyStrippedIds.length > 0) {
				droppedCount += imageResult.stripped;
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`processed-image strip failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		logTransformTiming(
			args.sessionId,
			"stripProcessedImages",
			tProcessedImages,
		);
	}

	// Compression can restore original text, including system reminders that an
	// earlier request omitted. Reproduce those omissions after compression even
	// when new cleanup is disabled. Use the original targets: newTargets blocks
	// newly changing text before signed thinking, but replay must restore the
	// already-served text to preserve both the signed prefix and the prompt cache.
	const contentDecisions = replayPiReminderStrips({
		db: args.db,
		sessionId: args.sessionId,
		activeTags,
		targets,
		legacyReminderTagNumbers: textIdentityPlan.legacyReminderTagNumbers,
		cacheBusting: isCacheBustingPass,
	});

	// 5. Commit tagging mutations back to Pi messages BEFORE injecting
	// the history block. Otherwise the injection write target is the
	// pre-tagged content. Pi's transcript adapter writes mutations
	// back to the underlying AgentMessage[] via the part proxies, so
	// commit() just locks the result in.
	const tTranscriptCommit = performance.now();
	transcript.commit();
	logTransformTiming(args.sessionId, "transcriptCommit", tTranscriptCommit);

	// Legacy drop/watermark state does not authorize first native activation.
	// Use committed canonical inputs, then publish only persisted native decisions.
	let nativeInputs: ReadonlyMap<string, string> | undefined;
	let nativeReasoningIds: ReadonlySet<string> | undefined;
	try {
		// Validate both lanes before either can publish replay or activation.
		const saved = getNativeReplayState(args.db, args.sessionId);
		nativeInputs = saved.toolInputs;
		nativeReasoningIds = saved.reasoningIds;
	} catch (error) {
		sessionLog(
			args.sessionId,
			`native replay state unavailable; retaining native history (continuing): ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (nativeInputs !== undefined && nativeReasoningIds !== undefined) {
		const nativeInputsApplied = applyNativeToolInputReplayPi(
			{
				db: args.db,
				sessionId: args.sessionId,
				messages: args.messages,
				changes: transcript.getToolInputChanges(),
				canApply: isCacheBustingPass,
			},
			nativeInputs,
		);
		const nativeReasoningApplied = args.reasoningClearing
			? applyNativeReasoningReplayPi(
					{
						db: args.db,
						sessionId: args.sessionId,
						messages: args.messages,
						messageIdToMaxTag,
						stableId: stableIdResolver,
						localWatermark: args.sessionMeta.clearedReasoningThroughTag ?? 0,
						budgetCutoff: reasoningBudgetCutoffThisPass,
						omissionAllowed: args.reasoningClearing.nativeReasoningMayClear,
						canApply: isCacheBustingPass && !reasoningPersistenceFailed,
						detectAged: shouldRunHeuristics && routineCleanupApplied,
					},
					nativeReasoningIds,
				)
			: 0;
		if (nativeInputsApplied > 0 || nativeReasoningApplied > 0) {
			recordFirstApplicationWireEdit(true);
		}
	}
	// Finalize the shared episode after all reclaim producers, including processed
	// images and native replay activation. Failed persistence and replay-only work
	// contribute no mutation, so an empty batch leaves the episode available.
	if (
		emergencyDropEligible &&
		(pendingOpsDidMutate ||
			heuristicOrReasoningDidMutate ||
			autoReclaimDidMutate)
	) {
		setEmergencyDropSample(
			args.db,
			args.sessionId,
			args.contextUsage.inputTokens,
		);
	}
	if (toolReclaimApplicationOpportunity) {
		advanceToolReclaimWatermarkByDistance(
			args.db,
			args.sessionId,
			reclaimDistance,
			args.reclaimUsableWindow ?? 0,
		);
	}
	if (autoReclaimTargetCount > 0) {
		sessionLog(
			args.sessionId,
			`tool reclaim auto-drop: targets=${autoReclaimTargetCount} mutated=${autoReclaimDidMutate}`,
		);
	}

	// Two post-commit stable-id maps, both keyed by AgentMessage object identity.
	// Built AFTER commit() — commit reassigns args.messages[idx] = working[idx]
	// (cloned objects for dirty messages), so a map built BEFORE the pipeline (the
	// pass-start `entryIdByRef`) keys the PRE-commit objects and misses every
	// cloned message. Built BEFORE injectM0M1Pi — injection splices/unshifts the
	// array, after which positional entryIds[index] is stale; object identity
	// survives both the clone and the splice, so a ref-keyed map resolves correctly
	// for consumers that run AFTER the pipeline mutates the array. There is NO
	// structural splice between pass start and here (only commit's in-place
	// reassignment), so positional entryIds[i] is still authoritative at build time.
	//
	// Two maps because the consumers have DIFFERENT identity contracts:
	//   1. postCommitStableIdByRef (FULL fallback via stableIdResolver, incl.
	//      the pass's pi-msg-* fallback ids) — for stripPiDroppedPlaceholderMessages, which needs
	//      a stable id for EVERY message (skip-on-miss + legacy path).
	//   2. postCommitEntryIdByRef (REAL SessionEntry ids ONLY, no pi-msg-* fallback)
	//      — for sticky reminder / note nudges / auto-search. These must fall to
	//      their degraded path (entryIds === null) when branch resolution failed;
	//      a pi-msg-* fallback id would defeat that and anchor to an unstable id.
	// The only legitimate misses are injection's synthetic m[0]/m[1] prepends,
	// which carry no SessionEntry id and must not be anchored.
	const tPostCommitStableIdMaps = performance.now();
	const postCommitStableIdByRef = new Map<object, string>();
	const postCommitEntryIdByRef = new Map<object, string>();
	const lkgEntryIdByRef = new Map<object, string>();
	for (let i = 0; i < args.messages.length; i++) {
		const m = args.messages[i];
		if (!m || typeof m !== "object") continue;
		const id = stableIdResolver(m, i);
		if (id) postCommitStableIdByRef.set(m as object, id);
		const lkgId = args.lkgEntryIds?.[i];
		if (lkgId) lkgEntryIdByRef.set(m as object, lkgId);
		// Real-only: positional entryIds[i] is a real SessionEntry id or undefined
		// (never pi-msg-*). Authoritative here because nothing has spliced yet.
		const realId = args.entryIds?.[i];
		if (typeof realId === "string" && realId.length > 0) {
			postCommitEntryIdByRef.set(m as object, realId);
		}
	}
	logTransformTiming(
		args.sessionId,
		"postCommitStableIdMaps",
		tPostCommitStableIdMaps,
	);

	// 6. <session-history> injection — writes compartments, facts, and
	// project memories into message[0]. This is the second-biggest
	// reduction lever after heuristic cleanup: a session that's been
	// summarized has its bulk history replaced by a compact compartment
	// block. Mirrors OpenCode's prepareCompartmentInjection +
	// renderCompartmentInjection pair (transform.ts:587-616 + ~960).
	let injectionResult: PiInjectionResult | null = null;
	if (args.injection) {
		try {
			const tInjection = performance.now();
			// NOTE: do NOT clear the m[0]/m[1] cache on a cache-busting pass. A new
			// compartment is an m[1] DELTA (SOFT), not an m[0] re-materialization
			// (HARD) — clearing forced mustMaterializePi to first_render and folded
			// m[0] every history-refresh pass, defeating the whole m[0]/m[1] split.
			// This matches OpenCode's rule that a new compartment sequence alone is not
			// a HARD trigger. injectM0M1Pi now keeps cached m[0] and soft-refreshes m[1];
			// HARD triggers (model/system/ttl/epoch/upgrade/mutation) still
			// re-materialize inside mustMaterializePi when genuinely needed.
			if (!piM0State) {
				throw new Error("Pi m[0] state must exist before wire injection");
			}
			const wireInjectionResult = injectM0M1PiForRun(
				piM0State,
				args.db,
				args.messages as Parameters<typeof injectM0M1Pi>[2],
				args.entryIds,
				// recomputeM1ThisPass: recompute m[1] (vs byte-identical replay) on any
				// cache-busting pass — history refresh (new compartment published),
				// deferred history refresh, OR executed work (drops/heuristics). A
				// history-refresh-only pass has executedWorkThisPass=false but MUST
				// re-render m[1] so the new compartment surfaces; gating on work alone
				// (the prior behavior, masked by the now-removed cache clear) would
				// replay stale m[1]. Mirrors OpenCode's isCacheBustingPass gate.
				isCacheBustingPass,
				injectionPassSnapshot,
			);
			injectionResult = preFoldInjectionResult?.m0Materialized
				? {
						...wireInjectionResult,
						m0Materialized: true,
						m0Reason:
							preFoldInjectionResult.m0Reason ?? wireInjectionResult.m0Reason,
						systemHashPrev: preFoldInjectionResult.systemHashPrev ?? null,
						systemHashNew: preFoldInjectionResult.systemHashNew ?? null,
						m0ModelKeyPrev: preFoldInjectionResult.m0ModelKeyPrev ?? null,
						m0ModelKeyNew: preFoldInjectionResult.m0ModelKeyNew ?? null,
					}
				: wireInjectionResult;
			// A prior trim's marker removal remains authoritative after caveman
			// restores pre-trim source, even when this pass trims nothing late.
			for (const message of args.messages) {
				if (!message || typeof message !== "object") continue;
				const id = postCommitStableIdByRef.get(message);
				if (
					id &&
					contentDecisions.has(
						encodePiContentDecision("seam-temporal-strip", id),
					)
				) {
					stripPiLeadingTemporalMarker(message);
				}
			}
			// PEEK-then-drain-on-success (Oracle audit Round 8 #6):
			// only drain `historyRefreshSessions` if the rebuild
			// succeeded AND this pass was busting the cache. If
			// injection throws, the flag survives so the next pass
			// retries the rebuild. Deferred-history is NOT drained
			// here; Pi-native compaction marker application happens at
			// the end of runPipeline after materializing work succeeds.
			if (args.isCacheBusting && prefixMutationAllowed) {
				historyRefreshSessions.delete(args.sessionId);
				historyWasConsumedThisPass = true;
			}
			if (deferredHistoryRefresh && prefixMutationAllowed) {
				historyWasConsumedThisPass = true;
			}
			logTransformTiming(
				args.sessionId,
				"prepareCompartmentInjection",
				tInjection,
			);
			logTransformTiming(args.sessionId, "compartmentPhase", tInjection);
		} catch (err) {
			sessionLog(
				args.sessionId,
				`compartment injection failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	transcript.finalizeToolRemovals();
	const tDroppedPlaceholders = performance.now();
	stripPiDroppedPlaceholderMessages({
		db: args.db,
		sessionId: args.sessionId,
		messages: args.messages,
		// Removing an entire placeholder message changes the cached request prefix.
		// Discover new removals only during an admitted rewrite with a history
		// refresh; replay previously persisted removals on every pass. Subagent
		// execute alone must not collapse a freshly dropped turn's placeholders.
		isCacheBusting: args.isCacheBusting && isCacheBustingPass,
		stableIdByRef: postCommitStableIdByRef,
		// A stable message-ID scheme change also needs rediscovery to re-key saved
		// removals, but it must still wait for permission to rewrite the prefix.
		forceDiscovery: args.stableIdSchemeCutover === true && isCacheBustingPass,
		// Frozen ids whose message owns a tool call are forgotten only on a pass
		// that already changes the served prefix, so the stored set never changes
		// on a pass meant to replay the previous bytes.
		canFirstApply: isCacheBustingPass,
		onLegacyReplay: (previous, next) => {
			const id = postCommitStableIdByRef.get(previous);
			if (id) postCommitStableIdByRef.set(next, id);
		},
		// Oh My Pi converts a tool result whose call is absent into a
		// <stale-tool-result> user message (pi-ai providers/transform-messages.ts,
		// 18.10.4:1395-1449, 18.11.0:1391-1445). Responses/Anthropic request
		// validation rejects that role change, so remove dropped results first.
		// Chat validation accepts the exact placeholder note; defer its removal
		// until another change already invalidates the provider's cached prefix.
		retireOrphansBeforeRefusal: [
			"openai-responses",
			"openai-codex-responses",
			"azure-openai-responses",
			"anthropic-messages",
		].includes(args.providerApi ?? ""),
		onFirstApplication: (message, index) =>
			recordFirstApplicationAt(message, index, 0, (item) =>
				item && typeof item === "object"
					? postCommitStableIdByRef.get(item)
					: undefined,
			),
	});
	logTransformTiming(
		args.sessionId,
		"stripDroppedPlaceholders",
		tDroppedPlaceholders,
	);

	// Once synthetic history messages m[0]/m[1] are served, their deferred render
	// requests are complete even if no drop was admitted. The durable Pi compaction
	// marker records unfinished native journal work and is retried independently.
	const deferredHistoryDrainEligible =
		((canConsumeDeferredLate && !firstRenderBust) ||
			(historyWasConsumedThisPass &&
				materializationSatisfiedThisPass &&
				(deferredHistoryWasPendingAtPassStart ||
					hasPendingMaterializeSignal))) &&
		prefixMutationAllowed &&
		injectionResult !== null &&
		injectionResult.contentionExhausted !== true &&
		!prefixPreflightContended &&
		!suppressDeferredHistoryDrain &&
		!casLost;
	const consumePublicationRender = () => {
		// A marker-only retry must not consume a publication that arrived after
		// this pass captured its rendering inputs.
		if (!deferredHistoryWasPendingAtPassStart || !historyWasConsumedThisPass)
			return;
		consumeDeferredHistoryRefresh(args.sessionId);
		if (
			!publishedWorkDrainAllowed ||
			(pendingOpsAppliedThisPass &&
				(!shouldRunHeuristics || heuristicsExecuted))
		)
			deferredMaterializationConsumedThisPass =
				consumeDeferredMaterialization(args.sessionId) ||
				deferredMaterializationConsumedThisPass;
	};
	let pendingForDrain: PendingPiCompactionMarker | null = null;
	if (
		!deferredHistoryDrainEligible &&
		(deferredHistoryWasPendingAtPassStart || hasPendingMaterializeSignal)
	) {
		try {
			const pending = getPendingPiCompactionMarkerState(
				args.db,
				args.sessionId,
			);
			if (pending)
				logPiCompactionMarkerDrainGateOnce(
					args.sessionId,
					pending,
					"drain-not-eligible",
					{
						historyConsumed: historyWasConsumedThisPass,
						materializationSatisfied: materializationSatisfiedThisPass,
						drainSuppressed: suppressDeferredHistoryDrain,
						casLost,
					},
				);
		} catch {
			// A failed marker-state read for logging must not abort sending the unchanged conversation.
		}
	}
	if (deferredHistoryDrainEligible) {
		try {
			args.assertCurrentPass?.();
			const pending = getPendingPiCompactionMarkerState(
				args.db,
				args.sessionId,
			);
			pendingForDrain = pending;
			if (!pending) {
				if (injectionResult?.contentionExhausted === true) {
					suppressDeferredHistoryDrain = true;
					sessionLog(
						args.sessionId,
						"Pi deferred-history drain skipped: m[0]/m[1] used a contention fallback; preserving deferred signals",
					);
				} else {
					consumePublicationRender();
				}
			} else if (
				!pendingPiMarkerCoveredByRenderedBoundary(pending, injectionResult)
			) {
				suppressDeferredHistoryDrain = true;
				const boundary = injectionResult?.renderedBoundary;
				const m1Coverage = injectionResult?.m1RenderedCoverage;
				logPiCompactionMarkerDrainGateOnce(
					args.sessionId,
					pending,
					"rendered-history-not-covering-marker",
					{
						renderedCoverageOrdinal: boundary?.ordinal,
						renderedCoverageEndMessageId: boundary?.endMessageId,
						m1CoverageOrdinal: m1Coverage?.ordinal,
						m1CoverageEndMessageId: m1Coverage?.endMessageId,
					},
				);
			} else if (
				!args.appendCompaction ||
				!args.readBranchEntries ||
				!foldingSystemState
			) {
				consumePublicationRender();
				suppressDeferredHistoryDrain = true;
				if (!args.appendCompaction)
					logPiCompactionMarkerDrainGateOnce(
						args.sessionId,
						pending,
						"append-compaction-unavailable",
					);
				if (!args.readBranchEntries)
					logPiCompactionMarkerDrainGateOnce(
						args.sessionId,
						pending,
						"get-branch-unavailable",
					);
				if (!foldingSystemState)
					logPiCompactionMarkerDrainGateOnce(
						args.sessionId,
						pending,
						"folding-system-state-unavailable",
					);
			} else {
				consumePublicationRender();
				args.assertCurrentPass?.();
				const outcome = applyDeferredPiCompactionMarker(
					{
						db: args.db,
						appendCompaction: args.appendCompaction,
						readBranchEntries: args.readBranchEntries,
					},
					args.sessionId,
					pending,
				);
				let markerEquivalent = outcome.kind === "stale-skip";
				if (outcome.kind === "applied" || outcome.kind === "already-current") {
					const syntheticHistoryMessages = injectionResult
						? args.messages.slice(
								Math.max(0, injectionResult.syntheticLeadingCount - 2),
								injectionResult.syntheticLeadingCount,
							)
						: [];
					const adoption = adoptPiCompactionSystemSnapshot(
						args.messages,
						args.readBranchEntries(),
						outcome.compactionId,
						foldingSystemState,
						syntheticHistoryMessages,
					);
					if (adoption.kind === "adopted") {
						markerEquivalent = true;
						if (injectionResult) {
							const lastSynthetic = syntheticHistoryMessages.at(-1);
							const lastSyntheticIndex = lastSynthetic
								? args.messages.indexOf(lastSynthetic as never)
								: -1;
							if (lastSyntheticIndex >= 0) {
								injectionResult.syntheticLeadingCount = lastSyntheticIndex + 1;
							}
						}
					} else {
						suppressDeferredHistoryDrain = true;
						if (adoption.kind === "divergent") {
							// appendCompaction has already persisted this entry. Pi exposes no
							// retraction API, and 0.86 session-manager.js:187-190 re-emits
							// [systemMessage, summary]. Keep MC's fold for this pass and retain
							// the pending marker so the next pass rechecks the then-current
							// journal instead of trusting the persisted snapshot.
							logPiCompactionMarkerDrainGateOnce(
								args.sessionId,
								pending,
								"equivalence-refused",
								{
									firstKeptEntryId: outcome.firstKeptEntryId,
									foldingOnlyTools: adoption.foldingOnlyTools,
									persistedOnlyTools: adoption.persistedOnlyTools,
									changedTools: adoption.changedTools,
									promptLengthDelta:
										adoption.persistedPromptLength -
										adoption.foldingPromptLength,
									foldingPromptLength: adoption.foldingPromptLength,
									persistedPromptLength: adoption.persistedPromptLength,
								},
							);
						} else {
							logPiCompactionMarkerDrainGateOnce(
								args.sessionId,
								pending,
								"equivalence-unavailable",
								{ firstKeptEntryId: outcome.firstKeptEntryId },
							);
						}
					}
				}
				if (outcome.kind === "waiting-for-entry") {
					suppressDeferredHistoryDrain = true;
				} else if (outcome.kind === "retryable-failure") {
					// The compaction marker manager logged the retryable failure's gate
					// classification without error text.
				} else if (
					markerEquivalent &&
					clearPendingPiCompactionMarkerStateIf(
						args.db,
						args.sessionId,
						pending,
						outcome.kind === "stale-skip" ? outcome.reason : outcome.kind,
					)
				) {
					consumeDeferredHistoryRefresh(args.sessionId);
				} else if (markerEquivalent) {
					casLost = true;
					logPiCompactionMarkerDrainGateOnce(
						args.sessionId,
						pending,
						"cas-clear-lost",
					);
				}
			}
		} catch (err) {
			args.assertCurrentPass?.();
			if (pendingForDrain)
				logPiCompactionMarkerDrainGateOnce(
					args.sessionId,
					pendingForDrain,
					"drain-threw",
					getPiCompactionMarkerDrainErrorFields(err),
				);
		}
	}
	if (
		(prefixPreflightContended ||
			injectionResult?.contentionExhausted === true) &&
		deferredMaterializationConsumedThisPass
	)
		signalPiDeferredMaterialization(args.sessionId);

	logTransformTiming(
		args.sessionId,
		"batchFinalize:heuristics",
		performance.now(),
	);
	if (args.temporalAwareness) {
		injectPiTemporalMarkers(args.messages, temporalDecisions, (message) =>
			message && typeof message === "object"
				? postCommitStableIdByRef.get(message)
				: undefined,
		);
	}

	const outputMessages = transcript.getOutputMessages();

	// 7. Persist conversation/tool-call token totals for /ctx-status and
	// the dashboard. Walks the post-everything message array (tagged,
	// injected, stripped) so the numbers reflect what the LLM actually
	// receives. Mirrors OpenCode's transform.ts:996-1127. Best-effort —
	// never fail the pipeline on a stats write error.
	try {
		const tTokenAccounting = performance.now();
		let tokenCache = piMessageTokenCacheBySession.get(args.sessionId);
		if (!tokenCache) {
			tokenCache = new Map();
			piMessageTokenCacheBySession.set(args.sessionId, tokenCache);
		}
		const counts = tokenizePiMessages(outputMessages as unknown[], {
			cache: tokenCache,
			stableId: (message) => postCommitEntryIdByRef.get(message),
			onTiming: hasPiTransformTimingObserver()
				? (phase, elapsedMs) => {
						recordPiTransformTiming({
							sessionId: args.sessionId,
							stage: `token:${phase}`,
							elapsedMs,
						});
					}
				: undefined,
		});
		updateSessionMeta(args.db, args.sessionId, {
			conversationTokens: counts.conversation,
			toolCallTokens: counts.toolCall,
		});
		logTransformTiming(args.sessionId, "tokenAccounting", tTokenAccounting);
	} catch (err) {
		sessionLog(
			args.sessionId,
			`token accounting failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	restoreOriginals?.(workingMessages);
	const materialized = injectionResult?.m0Materialized === true;
	if (
		args.reasoningClearing?.prefixBound &&
		firstEditSourceOrder &&
		firstEditParts.size > 0 &&
		!prefixEditBesidesReasoningTrim
	) {
		const frozenThinking = frozenBindingEntryIds(args.db, args.sessionId);
		let firstEdit: { index: number; part: number } | undefined;
		for (const [id, part] of firstEditParts) {
			const index = firstEditSourceOrder.get(id);
			if (
				index !== undefined &&
				(!firstEdit ||
					index < firstEdit.index ||
					(index === firstEdit.index && part < firstEdit.part))
			)
				firstEdit = { index, part };
		}
		for (const raw of outputMessages) {
			if (!raw || typeof raw !== "object") continue;
			const message = raw as { role?: string; content?: unknown };
			if (message.role !== "assistant" || !Array.isArray(message.content))
				continue;
			const id = postCommitStableIdByRef.get(raw);
			if (id && frozenThinking.has(id)) continue;
			const index = id ? firstEditSourceOrder.get(id) : undefined;
			for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
				const part = message.content[partIndex] as {
					type?: string;
					thinking?: string;
				};
				const thinking =
					part?.type === "thinking" &&
					part.thinking !== "" &&
					part.thinking !== "[cleared]";
				if (
					!thinking &&
					part?.type !== "redactedThinking" &&
					part?.type !== "redacted_thinking"
				)
					continue;
				if (
					index === undefined ||
					(firstEdit &&
						(index > firstEdit.index ||
							(index === firstEdit.index && partIndex >= firstEdit.part)))
				)
					prefixEditBesidesReasoningTrim = true;
			}
		}
	}
	const materializeReason = identityRebuild
		? PI_TAG_IDENTITY_REPAIR_REASON
		: (injectionResult?.m0Reason ?? null);
	const bustedThisPass =
		!!args.recoveryRebuildReason ||
		recoveryNormalized ||
		identityRebuild ||
		firstRenderBust ||
		pendingOpsDidMutate ||
		heuristicOrReasoningDidMutate ||
		autoReclaimDidMutateThisPass ||
		materialized ||
		historyWasConsumedThisPass;
	const calibrationBustReason = identityRebuild
		? PI_TAG_IDENTITY_REPAIR_REASON
		: materialized || firstRenderBust
			? "fold"
			: args.forceMaterialization
				? "force"
				: pendingOpsDidMutate
					? "flush"
					: historyWasConsumedThisPass
						? "refresh"
						: args.schedulerDecision === "execute"
							? "execute"
							: "unknown";
	const activeCalibration = sessionDecisionCalibration(
		args.db,
		args.sessionId,
		{
			bustPermitted: bustedThisPass,
			bustReason: calibrationBustReason,
			onAdopt: (message) => sessionLog(args.sessionId, message),
		},
	);
	protectionFloorResolution = resolveProtectionFloor();
	const protectedTagNumbers = usesTokenProtection
		? computeProtectionWindow(
				allTagsForPass,
				protectionFloorResolution.floor,
				activeCalibration.toolsRatio,
			).protectedTagNumbers
		: newestActiveTagNumbersByCount(activeTags, args.protectedTags);
	// A defer pass cannot consume queue rows, so preserve the snapshot loaded at
	// pass start. Execute passes may remove only a subset (protected/incomplete
	// targets remain), and therefore retain the one correctness-required re-read.
	const channelPendingOps = shouldApplyPendingOps
		? getPendingOps(args.db, args.sessionId)
		: shouldReadPendingOps
			? pendingOps
			: getPendingOps(args.db, args.sessionId);
	const channelBaselineSnapshot: PiChannelBaselineSnapshot = {
		tagCacheKey: fallbackCache.index,
		tags: allTagsForPass,
		activeTags,
		protectedTagNumbers,
		pendingDropTagNumbers: new Set(
			channelPendingOps
				.filter((operation) => operation.operation === "drop")
				.map((operation) => operation.tagId),
		),
	};

	if (bustedThisPass || isCacheBustingPass) {
		droppedTokens = estimateDroppedTokensFromTagReductions(
			args.db,
			args.sessionId,
			droppedTokenReductions,
		);
	}

	// A removed tool call/result pair never served its allocated number. Use
	// surviving structured call IDs and this pass's tagged targets as evidence,
	// not marker-like strings quoted in user content.
	const visibleCallIds = new Set<string>();
	for (const message of outputMessages as PiAgentMessage[]) {
		if (message.role === "toolResult") visibleCallIds.add(message.toolCallId);
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type === "toolCall") visibleCallIds.add(part.id);
			}
		}
	}
	// Look up only this pass's target numbers in the tag-ordered snapshot, in
	// ascending order, instead of filtering every tag the session ever had.
	const servedTagNumbers = new Set<number>();
	for (const number of [...targets.keys()].sort((a, b) => a - b)) {
		for (const tag of tagsWithNumber(allTagsForPass, number)) {
			if (
				tag.type === "message"
					? ctxReduceCallable || tag.status !== "active"
					: tag.type === "tool" &&
						visibleCallIds.has(tag.messageId) &&
						(ctxReduceCallable || tag.status !== "active")
			)
				servedTagNumbers.add(tag.tagNumber);
		}
	}
	return {
		messages: outputMessages,
		recoveryNormalized,
		lkgFrozenReleaseReason:
			args.recoveryRebuildReason ??
			(recoveryNormalized ? "recovery_tail_normalized" : undefined),
		prefixBustPermitted: isCacheBustingPass,
		prefixMutationAllowed,
		strictThinkingKept: protectedSignedPrefix,
		signedPrefixRewritten: rewritingSignedPrefix,
		prefixRebuildAlreadyPriced:
			firstRenderBust ||
			heldIdleExpiryRebuild ||
			(!!args.recoveryRebuildReason && isCacheBustingPass),
		identityRebuilt: identityRebuild,
		servedTagNumbers,
		heuristicsExecuted,
		executedWorkThisPass: executedWorkThisPass || identityRebuild,
		historyInjected: injectionResult?.injected ?? false,
		syntheticLeadingCount: injectionResult?.syntheticLeadingCount ?? 0,
		heuristicsResult,
		injectionResult,
		materialized,
		materializeReason,
		droppedTokens,
		droppedCount,
		emergency,
		bustedThisPass,
		agentDropsAppliedThisPass: pendingOpsDidMutate,
		eligiblePendingDropTagIds,
		prefixEditBesidesReasoningTrim:
			!!args.recoveryRebuildReason ||
			prefixEditBesidesReasoningTrim ||
			firstRenderBust ||
			args.isCacheBusting ||
			hasPendingMaterializeSignal ||
			deferredMaterializationConsumedThisPass ||
			foldBustsServedPrefixThisPass ||
			publishedM1RefreshedThisPass ||
			materialized ||
			historyWasConsumedThisPass ||
			pendingOpsDidMutate ||
			autoReclaimDidMutateThisPass ||
			emergency,
		targetCount: targets.size,
		reasoningWatermark: args.sessionMeta.clearedReasoningThroughTag ?? 0,
		activeTags,
		channelBaselineSnapshot,
		postCommitEntryIdByRef,
		lkgEntryIdByRef,
	};
}

// ---------------------------------------------------------------------------
// Nudge / note-nudge helpers
// ---------------------------------------------------------------------------

interface PiPostTransformSnapshot {
	noteAnchors: NoteNudgeAnchor[];
	autoSearchDecisions: AutoSearchHintDecision[];
	noteTriggerPending: boolean;
}

const AUTO_SEARCH_NO_HINT_REASONS = new Set<AutoSearchHintNoHintReason>([
	"below-threshold",
	"timeout",
	"empty",
	"error",
	"stacked",
	"too-short",
]);

function parseStoredArray<T>(
	raw: unknown,
	isValue: (value: unknown) => value is T,
): T[] {
	if (typeof raw !== "string" || raw.length === 0) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? parsed.filter(isValue) : [];
	} catch {
		return [];
	}
}

function isNoteNudgeAnchor(value: unknown): value is NoteNudgeAnchor {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.messageId === "string" &&
		row.messageId.length > 0 &&
		typeof row.text === "string" &&
		row.text.length > 0
	);
}

function isAutoSearchHintDecision(
	value: unknown,
): value is AutoSearchHintDecision {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	if (typeof row.messageId !== "string" || row.messageId.length === 0)
		return false;
	if (row.decision === "hint") {
		return typeof row.text === "string" && row.text.length > 0;
	}
	return (
		row.decision === "no-hint" &&
		typeof row.reason === "string" &&
		AUTO_SEARCH_NO_HINT_REASONS.has(row.reason as AutoSearchHintNoHintReason)
	);
}

/** Keys of the sticky reminders a pass appends to user messages. */
function piStickyInjectionKeys(snapshot: PiPostTransformSnapshot): Set<string> {
	const keys = new Set<string>();
	for (const anchor of snapshot.noteAnchors) {
		keys.add(JSON.stringify(["note", anchor]));
	}
	for (const decision of snapshot.autoSearchDecisions) {
		if (decision.decision === "hint") {
			keys.add(JSON.stringify(["hint", decision]));
		}
	}
	return keys;
}

function loadPiPostTransformSnapshot(
	db: ContextDatabase,
	sessionId: string,
): PiPostTransformSnapshot {
	const row = db
		.prepare(
			`SELECT note_nudge_anchors, auto_search_hint_decisions,
			        note_nudge_trigger_pending
			   FROM session_meta
			  WHERE session_id = ?`,
		)
		.get(sessionId) as
		| {
				note_nudge_anchors?: unknown;
				auto_search_hint_decisions?: unknown;
				note_nudge_trigger_pending?: unknown;
		  }
		| undefined;
	return {
		noteAnchors: parseStoredArray(row?.note_nudge_anchors, isNoteNudgeAnchor),
		autoSearchDecisions: parseStoredArray(
			row?.auto_search_hint_decisions,
			isAutoSearchHintDecision,
		),
		noteTriggerPending: row?.note_nudge_trigger_pending === 1,
	};
}

/**
 * Note-nudge + Channel 1/2 helpers.
 *
 * The rolling/iteration nudge and the tool-heavy sticky reminder were removed
 * in the ctx_reduce nudge redesign — replaced by Channel 1 (in-turn tool-result
 * append via `pi.on("tool_result")`, see `ctx-reduce-nudge-pi.ts`) and Channel 2
 * (the hidden `sendMessage` ceiling). `appendReminderToUserMessageByIdPi` /
 * `appendReminderToPiUserMessage` below are retained — they back the note-nudge
 * and auto-search hint paths, which still inject into user messages.
 */
/**
 * Apply note-nudge replay + delivery. Mirrors OpenCode's
 * `transform-postprocess-phase.ts` (around lines 611-650).
 *
 * Two paths:
 *   1. Sticky replay: a previously-delivered nudge anchored to a user
 *      message id replays into that same message every pass (idempotent
 *      because `appendReminderToUserMessageById` checks for the exact
 *      reminder text before appending).
 *   2. Fresh delivery: when a note trigger has fired since the last
 *      delivery and the agent hasn't already read the note state,
 *      append a `<instruction name="deferred_notes">…` block to the
 *      latest user message and mark delivered.
 *
 * Both paths fail-open: if no eligible user message exists, the call
 * simply returns the messages unchanged.
 */
function applyNoteNudges(args: {
	sessionId: string;
	db: ContextDatabase;
	messages: PiAgentMessage[];
	projectIdentity: string;
	entryIds: readonly (string | undefined)[] | null;
	/**
	 * Splice-safe message→entryId map keyed by AgentMessage reference. Resolved
	 * against branch entries and correct even though `messages` was spliced since
	 * `entryIds` (positional) was computed. Takes precedence over `entryIds`.
	 */
	entryIdByRef?: ReadonlyMap<object, string> | null;
	/**
	 * Whether THIS pass is cache-busting. Sticky-anchor pruning is storage-only
	 * and must run ONLY on cache-busting passes (parity with OpenCode
	 * transform-postprocess `args.fullFeatureMode && isCacheBustingPass`). On a
	 * defer pass the persisted sticky state must not change, or future replay
	 * bytes could shift and bust the prompt cache.
	 */
	isCacheBusting: boolean;
	/**
	 * Count of ALL id-less synthetic messages present in `messages` — the
	 * m[0]/m[1] prepends plus the rolling-nudge synthetic if it fired this pass.
	 * Excluded from the anchor-GC `allResolved` denominator (see below) since none
	 * of them resolve to a real entry id. Position is irrelevant; only the count
	 * matters for the denominator.
	 */
	syntheticLeadingCount?: number;
	/** Shared row projection; a missing snapshot preserves the legacy fail-open reads. */
	postTransformSnapshot?: PiPostTransformSnapshot;
}): PiAgentMessage[] {
	const { sessionId, db, messages, projectIdentity, entryIds, entryIdByRef } =
		args;

	const tNoteIndexMaps = performance.now();
	const messageIdByIndex = buildPiMessageIdByIndex(
		messages,
		entryIds,
		false,
		entryIdByRef,
	);
	const replayMessageIdByIndex = buildPiMessageIdByIndex(
		messages,
		entryIds,
		true,
		entryIdByRef,
	);
	logTransformTiming(sessionId, "noteIndexMaps", tNoteIndexMaps);

	const tStickyReplay = performance.now();
	const noteAnchors =
		args.postTransformSnapshot?.noteAnchors ??
		getNoteNudgeAnchors(db, sessionId);
	for (const anchor of noteAnchors) {
		appendReminderToUserMessageByIdPi(
			messages,
			replayMessageIdByIndex,
			anchor.messageId,
			anchor.text,
		);
	}
	logTransformTiming(sessionId, "stickyReplayDecisions", tStickyReplay);

	// Path 2: fresh delivery. Observe even when no trigger is pending, so a
	// later trigger cannot change a user already served without the reminder.
	//
	// Visibility-aware suppression: peekNoteNudgeText suppresses the
	// nudge when the agent already ran ctx_note(read) since the latest
	// note activity AND that read is still visible in the current
	// message context. Once the read has aged out / been dropped, we
	// re-surface the nudge at the next work-boundary trigger so the
	// agent regains visibility into deferred intentions. Mirrors
	// OpenCode's transform-postprocess-phase.ts:647 wiring.
	const latestUser = findLatestUserMessageIdPi(messages, messageIdByIndex);
	const latestUserId = latestUser?.messageId ?? null;
	const eligibility = observeNoteNudgeServe({
		db,
		sessionId,
		userMessageIds: [...messageIdByIndex]
			.filter(([index]) => messages[index]?.role === "user")
			.map(([, id]) => id),
		anchorMessageId: latestUserId,
		isLiveTail: latestUser?.index === messages.length - 1,
		// Pi's cache-bust permission does not prove bytes before this user message
		// actually changed. Without that evidence, append only to an unserved user
		// message at the tail so the reminder cannot originate a prefix rewrite.
		prefixRewriteCoversAnchor: false,
	});
	const noteReadStillVisible = hasVisibleNoteReadCallPi(messages);
	// The row snapshot is the change signal for expensive note/smart-note reads.
	// A false trigger cannot produce a nudge, so avoid entering the shared helper
	// (which otherwise re-reads session_meta before reaching the same conclusion).
	const deferredNoteText =
		args.postTransformSnapshot?.noteTriggerPending === false
			? null
			: peekNoteNudgeText(
					db,
					sessionId,
					latestUserId,
					projectIdentity,
					noteReadStillVisible,
					eligibility,
				);
	if (deferredNoteText) {
		if (entryIds === null) {
			sessionLog(
				sessionId,
				"Pi note-nudge: strict resolution failed; deferring delivery to next pass",
			);
			return messages;
		}
		const noteInstruction = `\n\n<instruction name="deferred_notes">${deferredNoteText}</instruction>`;
		const anchoredId = latestUser?.messageId ?? null;
		if (!anchoredId) {
			sessionLog(
				sessionId,
				"Pi note-nudge: latest user message has no resolved SessionEntry id; deferring delivery to next pass",
			);
			return messages;
		}
		const outcome = markNoteNudgeDelivered(
			db,
			sessionId,
			noteInstruction,
			anchoredId,
		);
		if (latestUser && outcome.ok) {
			appendReminderToPiUserMessage(
				messages[latestUser.index] as PiAgentMessage,
				noteInstruction,
			);
		} else if (!outcome.ok) {
			sessionLog(
				sessionId,
				`Pi note-nudge delivery skipped wire append: ${outcome.kind}`,
			);
		}
	}

	// Saved auto-search hints follow both saved and newly delivered note nudges;
	// reversing that order on replay would rewrite the cached user message.
	const autoSearchDecisions =
		args.postTransformSnapshot?.autoSearchDecisions ??
		getAutoSearchHintDecisions(db, sessionId);
	for (const decision of autoSearchDecisions) {
		if (
			decision.decision === "hint" &&
			getUnpublishedAutoSearchNoHint(sessionId, decision.messageId) ===
				undefined
		) {
			appendReminderToUserMessageByIdPi(
				messages,
				replayMessageIdByIndex,
				decision.messageId,
				decision.text,
			);
		}
	}

	// Storage-only GC of stale sticky anchors — gated on cache-busting passes
	// ONLY (parity with OpenCode). Pruning on a defer pass would mutate persisted
	// sticky-injection state and could shift future replay bytes.
	//
	// The visible set MUST reflect the CURRENT (post-splice) messages, not the
	// stale positional `entryIds`: pruning against pre-splice positions could
	// drop an anchor whose message is still present (just shifted) and therefore
	// erase a still-needed replay. We derive it from `messageIdByIndex`, which is
	// reference-resolved against the current array. Only prune when every current
	// message resolved to a real id (a partial map could miss a present message
	// and wrongly prune its anchor).
	if (args.isCacheBusting) {
		const visibleIds = new Set<string>(messageIdByIndex.values());
		// "All REAL messages resolved" — exclude injection's synthetic id-less
		// m[0]/m[1] prepends from the denominator (they never resolve to a real
		// entry id). Without this, allResolved is permanently false on every
		// injected pass and the prune never runs → unbounded anchor growth.
		const realMessageCount = Math.max(
			0,
			messages.length - (args.syntheticLeadingCount ?? 0),
		);
		const allResolved = messageIdByIndex.size === realMessageCount;
		if (allResolved && visibleIds.size > 0) {
			pruneNoteNudgeAnchors(db, sessionId, visibleIds);
			flushAutoSearchHintDecisionRetirement(db, sessionId, visibleIds);
			// A branch switch can hide user messages that will later be served again.
			// Keep their saved search hints, including no-hint omissions. Only the actual
			// prefix trim records IDs covered by a summary; this prefix-rebuild opportunity
			// may flush them to storage, while cached-prefix replay must not write them.
			// Today's visible IDs are not proof of deletion.
		}
	}

	return messages;
}

/** Returns true when the message is a user role with non-empty text content. */
function hasMeaningfulUserTextPi(message: PiAgentMessage): boolean {
	if (message.role !== "user") return false;
	const content = (message as { content: unknown }).content;
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	for (const part of content as Array<{ type?: unknown; text?: unknown }>) {
		if (
			part &&
			part.type === "text" &&
			typeof part.text === "string" &&
			part.text.trim().length > 0
		) {
			return true;
		}
	}
	return false;
}

type PiMessageIdByIndex = Map<number, string>;

/**
 * Build an index→entryId map for the CURRENT `messages` array.
 *
 * # Why a per-call rebuild keyed by reference, not a frozen positional array
 *
 * `strictEntryIds` is a positional array resolved against the ORIGINAL
 * `event.messages` at pass start. `runPipeline` then structurally mutates the
 * array in place — compartment-boundary trim and `stripPiDroppedPlaceholderMessages`
 * both `splice()` messages out, shifting every later index. Any consumer that
 * runs AFTER those splices (sticky reminders, note nudges, auto-search hints)
 * must NOT index the stale positional `strictEntryIds[]` against the shifted
 * array — index N no longer points at the same message, so anchors would resolve
 * to the wrong SessionEntry id and replay/prune on the wrong message (the Pi
 * analogue of the #81 positional-drift class).
 *
 * Reference identity survives splices (splicing changes positions, not object
 * identity). When `entryIdByRef` is supplied, each CURRENT message is resolved
 * through it by identity, so the map is correct regardless of how many splices
 * happened. The positional `entryIds` path is kept for pre-mutation callers
 * (those that legitimately align to the original `event.messages`).
 */
function buildPiMessageIdByIndex(
	messages: PiAgentMessage[],
	entryIds: readonly (string | undefined)[] | null,
	includeMessageIdFallback = false,
	entryIdByRef?: ReadonlyMap<object, string> | null,
): PiMessageIdByIndex {
	const ids = new Map<number, string>();
	for (let index = 0; index < messages.length; index += 1) {
		// Reference-identity resolution takes precedence: correct even after the
		// array was spliced since strictEntryIds was computed.
		if (entryIdByRef) {
			const msg = messages[index];
			const byRef =
				msg && typeof msg === "object"
					? entryIdByRef.get(msg as object)
					: undefined;
			if (typeof byRef === "string") {
				ids.set(index, byRef);
				continue;
			}
			// CRITICAL: when a ref-map is supplied, a MISS must NOT fall back to
			// positional `entryIds[index]`. The ref-map is built against the
			// CURRENT (post-commit/post-splice) array; `entryIds` is the stale
			// pass-start positional array, so after a splice index N no longer
			// points at the same message and the positional id would anchor the
			// WRONG message. The only legitimate ref-map misses are injection's
			// synthetic m[0]/m[1] prepends and commit-cloned messages with no real
			// SessionEntry id — both must resolve to "unmapped" so the consumer
			// degrades safely (replay-only / no fresh anchor) rather than mis-anchor.
			// The own-`.id` fallback below IS splice-safe (reads the current
			// object's own id, not a positional lookup) so it stays for replay
			// callers (includeMessageIdFallback=true).
			if (includeMessageIdFallback) {
				const messageId = (messages[index] as { id?: unknown } | undefined)?.id;
				if (typeof messageId === "string") {
					ids.set(index, messageId);
				}
			}
			continue;
		}
		// No ref-map (pre-mutation callers that legitimately align to the original
		// event.messages): positional entryIds is authoritative.
		const entryId = entryIds?.[index];
		if (typeof entryId === "string") {
			ids.set(index, entryId);
			continue;
		}
		if (includeMessageIdFallback) {
			const messageId = (messages[index] as { id?: unknown } | undefined)?.id;
			if (typeof messageId === "string") {
				ids.set(index, messageId);
			}
		}
		// Fresh anchors deliberately do not use AgentMessage.id: Pi's context
		// messages may carry transient wrapper ids that are not SessionEntry ids.
		// Existing anchors may still replay through that fallback for backward
		// compatibility when includeMessageIdFallback=true.
	}
	return ids;
}

function findLatestUserMessageIdPi(
	messages: PiAgentMessage[],
	messageIdByIndex: PiMessageIdByIndex,
): { index: number; messageId: string } | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role !== "user" || !hasMeaningfulUserTextPi(msg)) continue;
		const messageId = messageIdByIndex.get(i);
		if (typeof messageId === "string") {
			return { index: i, messageId };
		}
	}
	return null;
}

/**
 * Append `reminder` to the user message at `messageId`. Idempotent: skips if
 * the exact reminder text is already present. Mirrors
 * `appendReminderToUserMessageById` from OpenCode's
 * `transform-message-helpers.ts:54`.
 */
function appendReminderToUserMessageByIdPi(
	messages: PiAgentMessage[],
	messageIdByIndex: PiMessageIdByIndex,
	messageId: string,
	reminder: string,
): boolean {
	for (let i = 0; i < messages.length; i += 1) {
		const msg = messages[i];
		if (msg?.role !== "user" || !hasMeaningfulUserTextPi(msg)) continue;
		if (messageIdByIndex.get(i) !== messageId) continue;
		appendReminderToPiUserMessage(msg, reminder);
		return true;
	}
	return false;
}

/**
 * Append text to a user message, preserving its existing content shape:
 *   - `string`: direct concat (Pi accepts string user content).
 *   - array: append to the first text block, or push a new text block
 *     when the message is image-only.
 *
 * Idempotent — skips when the reminder is already present.
 */
function appendReminderToPiUserMessage(
	message: PiAgentMessage,
	reminder: string,
): void {
	// Only `user` messages carry a string-or-array content shape we can
	// safely append to. Other roles (toolResult, custom, bashExecution)
	// don't get nudge text.
	if (message.role !== "user") return;
	const userMsg = message as { content: unknown };

	if (typeof userMsg.content === "string") {
		if (!userMsg.content.includes(reminder)) {
			userMsg.content = userMsg.content + reminder;
		}
		return;
	}
	if (!Array.isArray(userMsg.content)) return;

	const contentArr = userMsg.content as Array<{
		type?: unknown;
		text?: unknown;
	}>;
	for (let i = 0; i < contentArr.length; i += 1) {
		const part = contentArr[i];
		if (
			part &&
			part.type === "text" &&
			typeof (part as { text?: string }).text === "string"
		) {
			const text = (part as { text: string }).text;
			if (!text.includes(reminder)) {
				(part as { text: string }).text = text + reminder;
			}
			return;
		}
	}
	// Image-only or empty array — push a new text block. Trim leading
	// `\n\n` because there's nothing to separate from.
	contentArr.push({ type: "text", text: reminder.trimStart() });
}

function clearPiCompactionOffInMemoryState(sessionId: string): void {
	historyRefreshSessions.delete(sessionId);
	deferredHistoryRefreshSessions.delete(sessionId);
	clearPendingMaterialization(pendingMaterializationSessions, sessionId);
	deferredMaterializationSessions.delete(sessionId);
	clearPiChannel1State(sessionId);
}

/**
 * Per-session cleanup. Pi has no `session_deleted` event, but a completed
 * switch to a different session within the same process tears the outgoing
 * session down (`session_shutdown` on stock Pi, `session_switch` on OMP), and
 * `session_shutdown` also fires when the process exits. Those are the moments
 * to drain caches keyed by the outgoing session id so we don't leak unbounded
 * memory across many session switches in a long-lived Pi process.
 *
 * Counterpart to OpenCode `session.deleted` cleanup in
 * `event-handler.ts:262-276`. We clean every per-session map this
 * module owns:
 *   - all 3 refresh signal sets (history / pendingMaterialization /
 *     systemPromptRefresh)
 *   - first-pass tracking
 *   - emergency-notification cooldown
 *   - auto-search per-turn cache
 *   - compressor cooldown timer
 *   - stable-message token totals
 *
 * NOT cleaned (intentional):
 *   - `inFlightHistorian` / `inFlightCompressor` — these promises
 *     own their own cleanup in `.finally()` and a session switch
 *     doesn't cancel a background subagent that's already running.
 *   - `pendingNoteNudgeState` — module-private to other files; they
 *     expose their own clear helpers called from where they live.
 */
// IMPORTANT: this clears only IN-MEMORY, process-local maps — it must NOT call
// the durable DB `clearSession(db, sessionId)`. The two callers are
// `session_shutdown` and OMP's `session_switch`, NEITHER of which means the
// session was deleted — the session still exists on disk and may be resumed.
// Pi has no `session_deleted` event (OpenCode's event-handler is the only place
// the durable DB clearSession fires). Calling DB clearSession here would DESTROY
// live durable state (compartments, tags, memories) for a session the user
// merely switched away from — a data-loss bug far worse than the bounded
// orphan-row cost for sessions that are genuinely abandoned and never resumed.
// Do not add DB clearSession here.
export function clearContextHandlerSession(sessionId: string): void {
	cancelPiTagSnapshotSession(sessionId);
	lastServedSystemHashBySession.delete(sessionId);
	clearPiHistoryBoundaryRepairSession(sessionId);
	clearPiUpperReclaimSession(sessionId);
	invalidateTrueRawTokenCache({ sessionId, reason: "pi.branch.changed" });
	clearPiLiveUsageClassification(sessionId);
	clearPiLkgSessionState(sessionId);
	clearPiServedArraySession(sessionId);
	activeContextHandlerSessions.delete(sessionId);
	clearAutoSearchForPiSession(sessionId);
	lastEmergencyNotificationAtMs.delete(sessionId);
	historyRefreshSessions.delete(sessionId);
	clearPendingMaterialization(pendingMaterializationSessions, sessionId);
	systemPromptRefreshSessions.delete(sessionId);
	deferredHistoryRefreshSessions.delete(sessionId);
	deferredMaterializationSessions.delete(sessionId);
	firstContextPassSeenBySession.delete(sessionId);
	contextPassGeneration.delete(sessionId);
	clearPiContextReceipt(sessionId);
	commitSeenLastPass.delete(sessionId);
	liveModelBySession.delete(sessionId);
	latestAssistantModelTimestampBySession.delete(sessionId);
	taggedStableMessageIdsBySession.delete(sessionId);
	taggedEntryHeadersBySession.delete(sessionId);
	const tagger = taggersBySession.get(sessionId);
	if (tagger) {
		tagger.cleanup(sessionId);
		taggersBySession.delete(sessionId);
	}
	piMessageTokenCacheBySession.delete(sessionId);
	piTagTextTokenCacheBySession.delete(sessionId);
	piTagToolTokenCacheBySession.delete(sessionId);
	piTextIdentitySourceCacheBySession.delete(sessionId);
	piFallbackIndexesBySession.delete(sessionId);
	piBranchProjectionBySession.delete(sessionId);
	piAlignmentMismatchLoggedSessions.delete(sessionId);
	clearPiOrdinalAlignmentSession(sessionId);
	clearPiCompactionMarkerDrainLogState(sessionId);
	clearPiInjectionTokenCountCache(sessionId);
	clearPiMuralProcessCache(sessionId);
	// The content memo is shared across sessions, not owned by one session id.
	// Dropping it at teardown releases old bodies; deterministic counts rebuild.
	clearPiTailHygieneContentMemo();
	clearPiChannel1State(sessionId);
	lastHeuristicsTurnIdBySession.delete(sessionId);
	routinePressureAppliedBySession.delete(sessionId);
	lastSeenProjectIdentityBySession.delete(sessionId);
	persistedProjectIdentityBySession.delete(sessionId);
	sessionProjectBindingFailureLogAtBySession.delete(sessionId);
	for (const [projectIdentity, sessions] of sessionsByProject) {
		sessions.delete(sessionId);
		if (sessions.size === 0) sessionsByProject.delete(projectIdentity);
	}
	const unregister = rawMessageProviderUnregistersBySession.get(sessionId);
	if (unregister) {
		unregister();
		rawMessageProviderUnregistersBySession.delete(sessionId);
	}
	clearSessionTracking(sessionId);
	clearPiEmbedSessionState(sessionId);
}

/**
 * Run a stage the served messages cannot do without. If it fails, the context
 * handler's catch must not fall through to Pi's unmodified messages: they lack
 * the session's persisted drops and can be far larger than the last request.
 * A busy or locked store is rethrown as is (the handler's transient-storage
 * path); any other error becomes a PiDegradedPassError, which that path
 * handles the same way. `onFailure` runs first, for state the next pass must
 * reload.
 */
function runPersistedReplayStage<T>(
	site: string,
	onFailure: (() => void) | undefined,
	run: () => T,
): T {
	try {
		return run();
	} catch (error) {
		try {
			onFailure?.();
		} catch (cleanupError) {
			log(
				`[magic-context][pi] cleanup after ${site} failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
			);
		}
		if (isTransientPiStorageError(error)) throw error;
		throw new PiDegradedPassError(site, { cause: error });
	}
}

import type { PendingMaterializationOrigin } from "@magic-context/core/hooks/magic-context/pending-materialization";
import {
	clearPendingMaterialization,
	hasPendingMaterializationOrigin,
	pendingMaterializationOrigin,
	requestPendingMaterialization,
} from "@magic-context/core/hooks/magic-context/pending-materialization";
import {
	deferDeliveredSystemRefresh,
	recordSystemRefreshOwnership,
} from "@magic-context/core/hooks/magic-context/system-prompt-delivery";
import { inRootAsyncContext } from "@magic-context/core/shared/sqlite";
import { PI_FALLBACK_PREFIXES_JSON } from "../../plugin/src/shared/tag-owner-id";
import {
	beginPiSystemPromptRequest,
	recordPiHeldSystemHead,
} from "./system-prompt-delivery-pi";
import { piOpaqueThinkingFallbackSteps } from "./tokenize-pi-messages";
