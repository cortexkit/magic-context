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
 * philosophy as the OpenCode `messages-transform` wrapper (see
 * AUDIT-KNOWN-ISSUES.md for the documented tradeoff). FailClosedBlockingError
 * is rethrown so deterministic inoperability cannot silently degrade to
 * native compaction.
 */

import * as crypto from "node:crypto";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	acquireCompartmentLease,
	COMPARTMENT_LEASE_RENEWAL_MS,
	releaseCompartmentLease,
	renewCompartmentLease,
} from "@magic-context/core/features/magic-context/compartment-lease";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { isFailClosedBlockingError } from "@magic-context/core/features/magic-context/fail-closed-block";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	clearSessionTracking,
	scheduleIncrementalIndex,
	scheduleReconciliation,
} from "@magic-context/core/features/magic-context/message-index-async";
import {
	createScheduler,
	parseCacheTtl,
	type Scheduler,
} from "@magic-context/core/features/magic-context/scheduler";
import { recordSessionProjectIdentity } from "@magic-context/core/features/magic-context/session-project-storage";
import {
	adoptPiFallbackMessageTag,
	adoptPiFallbackToolOwnerTag,
	type ContextDatabase,
	casChannel2NudgeState,
	clearPendingPiCompactionMarkerStateIf,
	deriveTagLoadFloor,
	findAdoptableFallbackTags,
	findPiFallbackToolOwnerTags,
	getActiveTagsBySession,
	getDroppedTagsByNumbers,
	getHistorianFailureState,
	getMaxDroppedTagNumber,
	getOldestActiveUnprotectedToolTags,
	getPendingOps,
	getPendingPiCompactionMarkerState,
	getPersistedToolTagAccounting,
	getTagsByNumbers,
	getTagsBySession,
	getTagsForPendingOperations,
	hasPiFallbackMessageTags,
	hasPiFallbackToolOwnerTags,
	isWrapupInProgress,
	setSessionWorkMetrics,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import {
	clearDeferredExecutePendingIfMatches,
	clearDetectedContextLimit,
	clearEmergencyDropSample,
	clearEmergencyRecovery,
	clearHistorianFailureState,
	clearPersistedReasoningWatermark,
	getAutoSearchHintDecisions,
	getNoteNudgeAnchors,
	getOverflowState,
	type PendingPiCompactionMarker,
	peekDeferredExecutePending,
	pruneAutoSearchHintDecisions,
	pruneNoteNudgeAnchors,
	resetLastNudgeCycleIfTailShrank,
	setDeferredExecutePendingIfAbsent,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { getSourceContents } from "@magic-context/core/features/magic-context/storage-source";
import {
	createTagger,
	type Tagger,
} from "@magic-context/core/features/magic-context/tagger";
import {
	findNewestPiAssistantEntryId,
	normalizeMaterializeReason,
	recordPendingPiTransformDecision,
	schedulePiTransformDecisionResolve,
} from "@magic-context/core/features/magic-context/transform-decision-log";
import { computePiWorkMetrics } from "@magic-context/core/features/magic-context/work-metrics";
import {
	applyFlushedStatuses,
	applyPendingOperations,
	RECENT_TOOL_SKELETON_WINDOW,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import {
	applyMidTurnDeferral,
	detectMidTurnBypassReason,
} from "@magic-context/core/hooks/magic-context/boundary-execution";
import { replayCavemanCompression } from "@magic-context/core/hooks/magic-context/caveman-cleanup";
import {
	rearmChannel2AfterCoverageAdvancingHardFold,
	rearmChannel2AfterMeasuredCollapse,
} from "@magic-context/core/hooks/magic-context/channel2-cycle";
import { checkCompartmentTrigger } from "@magic-context/core/hooks/magic-context/compartment-trigger";
import { evaluateChannel2 } from "@magic-context/core/hooks/magic-context/ctx-reduce-nudge";
import { deriveTriggerBudget } from "@magic-context/core/hooks/magic-context/derive-budgets";
import {
	DEFAULT_CONTEXT_LIMIT,
	resolveExecuteThreshold,
} from "@magic-context/core/hooks/magic-context/event-resolvers";
import { foldExecutesThisPass } from "@magic-context/core/hooks/magic-context/fold-execution-gate";
import { getVisibleMemoryIds } from "@magic-context/core/hooks/magic-context/inject-compartments";
import {
	markNoteNudgeDelivered,
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
import { modelAcceptsEmptyContent } from "@magic-context/core/hooks/magic-context/sentinel";
import {
	buildEditSupersessionReclaim,
	buildSupersessionReclaimOps,
} from "@magic-context/core/hooks/magic-context/supersession-reclaim";
import { stripTagPrefix } from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import {
	advanceToolReclaimWatermarkToCurrentMax,
	buildSyntheticToolReclaimOps,
} from "@magic-context/core/hooks/magic-context/tool-reclaim";
import { escalationBands } from "@magic-context/core/shared/escalation-bands";
import { piModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";
import { log, sessionLog } from "@magic-context/core/shared/logger";
import type { ModelInput } from "@magic-context/core/shared/model-resolution";
import { isSaneLimit } from "@magic-context/core/shared/models-dev-cache";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import {
	TEXT_TAG_IDENTITY_MARKER,
	tagTranscript,
} from "@magic-context/core/shared/tag-transcript";
import {
	clearAutoSearchForPiSession,
	runAutoSearchHintForPi,
} from "./auto-search-pi";
import { clearPiEmbedSessionState } from "./commands/ctx-embed";
import { sendCtxStatusMessage } from "./commands/pi-command-utils";
import {
	type ApplyDeferredPiCompactionMarkerDeps,
	applyDeferredPiCompactionMarker,
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
import { detectRecentCommit } from "./detect-recent-commit";
import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import {
	applyPiHeuristicCleanup,
	type PiHeuristicCleanupResult,
} from "./heuristic-cleanup-pi";
import {
	clearM0M1PiCache,
	clearPiInjectionTokenCountCache,
	injectM0M1Pi,
	mustMaterializePi,
	type PiM0M1InjectionResult as PiInjectionResult,
	trimPiMessagesToCachedBoundary,
} from "./inject-compartments-pi";
import { hasVisibleNoteReadCallPi } from "./note-visibility-pi";
import {
	resolvePiUsableContextLimit,
	resolvePiWindowGeometry,
} from "./pi-context-limit";
import { type PiHistorianDeps, runPiHistorian } from "./pi-historian-runner";
import { injectSyntheticTodowriteForPi } from "./pi-todo-inject";
import {
	convertEntriesToRawMessages,
	findLastModelKeyFromBranch,
	isMidTurnPi,
	readPiSessionMessages,
	resolvePiStableId,
} from "./read-session-pi";
import {
	buildMessageIdToMaxTag,
	clearOldReasoningPi,
	replayClearedReasoningPi,
	replayStrippedInlineThinkingPi,
	stripInlineThinkingPi,
} from "./reasoning-replay-pi";
import { stripPiDroppedPlaceholderMessages } from "./strip-placeholders-pi";
import { stripPiProcessedImages } from "./strip-processed-images-pi";
import { clearPiSystemPromptSession } from "./system-prompt";
import {
	assertPiTailHygieneContentUnchanged,
	countRealPiUserMessages,
	effectivePiTailHygiene,
	refreshPiTailHygieneBaseline,
} from "./tail-hygiene-walk-pi";
import {
	injectPiTemporalMarkers,
	stripPiLeadingTemporalMarker,
	withoutPiLeadingTemporalMarker,
} from "./temporal-awareness-pi";
import { withTimeout } from "./timeout";
import {
	type PiMessageTokenCacheEntry,
	tokenizePiMessages,
} from "./tokenize-pi-messages";
import { createPiTranscript } from "./transcript-pi";

/** Emergency-block threshold — mirrors OpenCode's >=95% emergency path. */
const EMERGENCY_BLOCK_PERCENTAGE = 95;

// estimateTokens (char-based) under-counts the real provider
// tokenizer + untagged structural/reasoning parts: the observed overflow was
// >400K real vs a ~340K forward estimate (~15% gap). Scaling the limit DOWN for
// the forward percentage reaches the derived force and absolute 95% emergency
// bands at a real size that corresponds to the window, not the under-counted estimate.
// 0.85 (not 0.90): 0.90 would make the 95% emergency band fire only at ~360K
// estimated, still short of the >400K real seen here.
const FORWARD_PRESSURE_LIMIT_FACTOR = 0.85;

// Returns { percentage, inputTokens } floored by Pi's FORWARD usage estimate.
// piUsage.tokens = last assistant usage + estimateTokens of every message after
// it (pi-mono estimateContextTokens), recomputed from the LIVE array each call —
// so it catches a mid-turn balloon the message_end-persisted trailing number
// misses. Keep ONLY .tokens (forward, input-side); .percent is discarded (counts
// output on Pi's own denominator). Immune to NULL token_count (live array, not
// our tag store). NEVER lowers (max), so it's never less reactive than today.
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

function applyForwardPressureFloor(
	trailingPercentage: number,
	trailingInputTokens: number,
	piUsageTokens: number | null | undefined,
	correctedLimit: number | undefined,
): { percentage: number; inputTokens: number } {
	const forwardTokens =
		typeof piUsageTokens === "number" && piUsageTokens > 0 ? piUsageTokens : 0;
	if (forwardTokens === 0 || !isSaneLimit(correctedLimit)) {
		return { percentage: trailingPercentage, inputTokens: trailingInputTokens };
	}
	// Scale the LIMIT only for this forward percentage — do NOT mutate the real
	// usageContextLimit (history-budget + emergency-drop ceiling rely on the true
	// limit) and do NOT inflate forwardTokens (emergency-drop needs the raw
	// current assembled size).
	const forwardPressureLimit = correctedLimit * FORWARD_PRESSURE_LIMIT_FACTOR;
	const forwardPercentage = (forwardTokens / forwardPressureLimit) * 100;
	return forwardPercentage > trailingPercentage
		? {
				percentage: forwardPercentage,
				inputTokens: Math.max(trailingInputTokens, forwardTokens),
			}
		: { percentage: trailingPercentage, inputTokens: trailingInputTokens };
}

let injectM0M1PiForRun = injectM0M1Pi;
let persistReasoningWatermarkForRun = updateSessionMeta;
let persistStableIdSchemeForRun = updateSessionMeta;
let afterFallbackAdoptionForTests:
	| ((stableIdSchemeCutover: boolean) => void)
	| undefined;
let mutationGateObserverForTests:
	| ((snapshot: {
			foldDue: boolean;
			foldExecuted: boolean;
			shouldApplyPendingOps: boolean;
			shouldRunHeuristics: boolean;
			shouldRunReasoningCleanup: boolean;
	  }) => void)
	| undefined;

export const __test = {
	FORWARD_PRESSURE_LIMIT_FACTOR,
	isPiHardCacheExpired,
	adoptPiFallbackTags,
	applyForwardPressureFloor,
	buildEntryFingerprintMap,
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
	setMutationGateObserverForTests(
		fn: typeof mutationGateObserverForTests,
	): () => void {
		mutationGateObserverForTests = fn;
		return () => {
			mutationGateObserverForTests = undefined;
		};
	},
};

/**
 * Default `clear_reasoning_age` when neither the Pi caller nor the user
 * config specifies one. Matches OpenCode's schema default
 * (`packages/plugin/src/config/schema/magic-context.ts:303` → `.default(50)`).
 */
const DEFAULT_CLEAR_REASONING_AGE = 50;

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
const sessionsByProject = new Map<string, Set<string>>();
const lastSeenProjectIdentityBySession = new Map<string, string>();
const rawMessageProviderUnregistersBySession = new Map<string, () => void>();
const activeContextHandlerSessions = new Set<string>();
const lastHeuristicsTurnIdBySession = new Map<string, string>();
const firstContextPassSeenBySession = new Set<string>();
const liveModelBySession = new Map<string, string>();
const taggedStableMessageIdsBySession = new Map<string, Set<string>>();
const taggersBySession = new Map<string, Tagger>();

function recordSuccessfulTaggedMessageIds(
	sessionId: string,
	entryIds: readonly (string | undefined)[],
): void {
	const liveRealIds = new Set<string>();
	for (const entryId of entryIds) {
		if (entryId && !entryId.startsWith("pi-msg-")) liveRealIds.add(entryId);
	}
	taggedStableMessageIdsBySession.set(sessionId, liveRealIds);
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

interface PiTextIdentityPlan {
	driftedMessageIds: Set<string>;
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
			legacyRows.every(
				(row, index) =>
					row.ordinal === index &&
					withoutPiLeadingTemporalMarker(sourceCache.get(row.tagId) ?? "") ===
						currentSources[index],
			);
		if (!vectorMatches) driftedMessageIds.add(messageId);
	}

	const reusableMessageIds = new Set<string>();
	for (const messageId of reuseCandidates) {
		if (!driftedMessageIds.has(messageId)) reusableMessageIds.add(messageId);
	}
	return { driftedMessageIds, reusableMessageIds, sourceCache };
}

interface PiBranchEntryLookup {
	entryIdByMessageRef: Map<object, string>;
	entryIdsByFingerprint: Map<string, string[]>;
	alignedEntryIds: (string | undefined)[];
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

function logTransformTiming(
	sessionId: string,
	stage: string,
	start: number,
	extra?: string,
): void {
	const elapsedMs = performance.now() - start;
	const elapsed = elapsedMs.toFixed(1);
	const suffix = extra ? ` ${extra}` : "";
	recordPiTransformTiming({ sessionId, stage, elapsedMs, extra });
	sessionLog(
		sessionId,
		`transform stage: stage=${stage} elapsed=${elapsed}ms${suffix}`,
	);
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
): ReturnType<typeof readPiSessionMessages>[number] | null {
	return (
		readPiSessionMessages(ctx).find((message) => message.id === messageId) ??
		null
	);
}

function convertLocatedPiUserEntry(
	branchEntries: readonly unknown[],
	messageId: string,
): ReturnType<typeof readPiSessionMessages>[number] | null {
	let rawOrdinal = 0;
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
export function signalPiPendingMaterialization(sessionId: string): void {
	pendingMaterializationSessions.add(sessionId);
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
	let sessions = sessionsByProject.get(projectIdentity);
	if (!sessions) {
		sessions = new Set();
		sessionsByProject.set(projectIdentity, sessions);
	}
	sessions.add(sessionId);

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
): void {
	if (!projectIdentity) return;
	const prev = lastSeenProjectIdentityBySession.get(sessionId);
	if (prev && prev !== projectIdentity) {
		const prevSessions = sessionsByProject.get(prev);
		prevSessions?.delete(sessionId);
		if (prevSessions?.size === 0) sessionsByProject.delete(prev);
		clearPiSystemPromptSession(sessionId);
	}
	// Persist the session→project ownership binding so the project-scoped

	// session's compartments to the right project. ctx.cwd is the authoritative
	// session directory in Pi (no SDK/launch-dir ambiguity), so every observation
	// is host-safe. Guarded to the once-per-(session,identity) transition — only
	// on first sight or an actual identity change — so steady-state passes carry
	// no per-pass DB write. embedSessionCompartmentChunks also self-records, so
	// this only widens coverage to passively-published sessions.
	if (db && prev !== projectIdentity) {
		try {
			recordSessionProjectIdentity(db, sessionId, projectIdentity);
		} catch {
			// best-effort; backfill re-records on demand from the session command
		}
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

export function recordPiLiveModel(sessionId: string, modelKey: string): void {
	liveModelBySession.set(sessionId, modelKey);
}

function summarizeTransformError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const normalized = raw.replace(/\s+/g, " ").trim();
	return normalized.length > 180
		? `${normalized.slice(0, 177).trimEnd()}...`
		: normalized || "Unknown transform error";
}

function persistLastTransformErrorIfChanged(
	db: ContextDatabase,
	sessionId: string,
	summary: string,
): void {
	try {
		const current = getOrCreateSessionMeta(db, sessionId).lastTransformError;
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
): void {
	try {
		const current = getOrCreateSessionMeta(db, sessionId).lastTransformError;
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
	pendingMaterializationSessions.delete(sessionId);
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
	/** Historian context window — used to derive chunk token budget. */
	historianChunkTokens: number;
	/** Optional per-call timeout (default 120s). */
	timeoutMs?: number;
	/** When true, run a second editor pass after a successful first pass to
	 *  clean low-signal U: lines and cross-compartment duplicates. Mirrors
	 *  OpenCode's `historian.two_pass` config. */
	twoPass?: boolean;
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
	caveman?: { enabled: boolean; minChars: number };
	/**
	 * Number of tags before the most recent tag whose typed reasoning is
	 * cleared on cache-busting passes. Mirrors OpenCode's
	 * `clear_reasoning_age` config (`packages/plugin/src/config/schema/magic-context.ts:303`).
	 * Default `50` matches OpenCode. Pi previously hardcoded `30`, which
	 * cleared reasoning more aggressively than the user configured.
	 */
	clearReasoningAge?: number;
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
	db: ContextDatabase;
	/** Smart-drops (experimental, default off): also reclaim tool output that a
	 *  later call supersedes, on top of the age-based auto-drop. Off → messages
	 *  sent to the model are byte-identical to the age-based-only behavior. */
	smartDrops?: boolean;
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
		// Index 0 = synthetic compaction summary — no SessionEntry id.
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
				if (!foundFirstKept) continue;
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
	const { entryIdByMessageRef, entryIdsByFingerprint } =
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
		const fingerprintBucket = fingerprint
			? entryIdsByFingerprint.get(fingerprint)
			: undefined;
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

function addPiBranchEntryToLookup(
	lookup: PiBranchEntryLookup,
	entry: unknown,
): void {
	if (!entry || typeof entry !== "object") return;
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
	const fingerprint = piMessageEntryFingerprint(row.message);
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

function buildPiAlignedEntryIds(
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

	const ids: (string | undefined)[] = [undefined];
	if (firstKeptEntryId !== undefined) {
		let foundFirstKept = false;
		for (let index = 0; index < compactionIndex; index += 1) {
			const entry = entries[index];
			if ((entry as { id?: unknown } | undefined)?.id === firstKeptEntryId) {
				foundFirstKept = true;
			}
			if (foundFirstKept && isPiContextEmitEligible(entry)) ids.push(entry.id);
		}
	}
	for (let index = compactionIndex + 1; index < entries.length; index += 1) {
		const entry = entries[index];
		if (isPiContextEmitEligible(entry)) ids.push(entry.id);
	}
	return ids;
}

// The first two prepended Pi messages already contain the compartment summaries.
// Calling appendCompaction makes Pi add the same summary during the next projection,
// changing bytes sent to the provider one pass after cache invalidation. Remove it
// only when the branch entry proves this plugin created the matching compaction.
function stripMcOwnedPiCompactionSummary(
	messages: PiAgentMessage[],
	entryIds: (string | undefined)[],
	branchEntries: readonly unknown[],
): boolean {
	const summaryMessage = messages[0] as
		| { role?: unknown; summary?: unknown; tokensBefore?: unknown }
		| undefined;
	if (summaryMessage?.role !== "compactionSummary") return false;

	let compaction:
		| {
				type?: unknown;
				summary?: unknown;
				tokensBefore?: unknown;
				fromHook?: unknown;
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
	if (compaction?.fromHook !== true) return false;
	const details = compaction.details as { source?: unknown } | undefined;
	if (details?.source !== "magic-context") return false;
	if (
		summaryMessage.summary !== compaction.summary ||
		summaryMessage.tokensBefore !== compaction.tokensBefore ||
		entryIds[0] !== undefined
	) {
		return false;
	}

	messages.splice(0, 1);
	entryIds.splice(0, 1);
	return true;
}

function getPiBranchEntryLookup(
	entries: readonly unknown[],
): PiBranchEntryLookup {
	const cached = piBranchLookupByProjection.get(entries);
	if (cached) return cached;
	const lookup: PiBranchEntryLookup = {
		entryIdByMessageRef: new Map(),
		entryIdsByFingerprint: new Map(),
		alignedEntryIds: buildPiAlignedEntryIds(entries),
	};
	for (const entry of entries) addPiBranchEntryToLookup(lookup, entry);
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
			if (
				suffix.some(
					(entry) =>
						(entry as { type?: unknown } | undefined)?.type === "compaction",
				)
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

function piMessageEntryFingerprint(message: unknown): string | null {
	if (!message || typeof message !== "object") return null;
	const record = message as {
		responseId?: unknown;
		timestamp?: unknown;
		role?: unknown;
		toolCallId?: unknown;
		content?: unknown;
	};
	if (typeof record.role !== "string") return null;
	const firstText = firstPiTextContent(record.content);
	const firstTextHash = crypto
		.createHash("sha256")
		.update(firstText ?? "")
		.digest("hex")
		.slice(0, 16);
	return JSON.stringify([
		typeof record.responseId === "string" ? record.responseId : null,
		typeof record.timestamp === "number" || typeof record.timestamp === "string"
			? record.timestamp
			: null,
		record.role,
		typeof record.toolCallId === "string" ? record.toolCallId : null,
		firstTextHash,
	]);
}

function firstPiTextContent(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const record = part as { type?: unknown; text?: unknown };
		if (record.type === "text" && typeof record.text === "string") {
			return record.text;
		}
	}
	return null;
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
): Map<string, string> {
	const map = new Map<string, string>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const id = resolveStableId(msg, i);
		if (!id) continue;
		if (!includeReusable && reusableMessageIds?.has(id)) continue;
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
		const ownerRealId = resolveStableId(message, i);
		if (!ownerRealId || ownerRealId.startsWith("pi-msg-")) continue;
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
			owners.add(ownerRealId);
		}
	}
	return map;
}

function parsePiFallbackToolOwnerId(
	ownerMsgId: string,
): { timestamp: number; role: string } | null {
	const match = /^pi-msg-\d+-(\d+)-(.+)$/.exec(ownerMsgId);
	if (!match) return null;
	const timestamp = Number(match[1]);
	if (!Number.isFinite(timestamp)) return null;
	return { timestamp, role: match[2] ?? "" };
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
		return db.transaction(fn)();
	}
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

interface AdoptPiFallbackTagsOptions {
	messages?: readonly PiAgentMessage[];
	resolveStableId?: (msg: unknown, index: number) => string | undefined;
	hasFallbackMessageTags?: boolean;
	hasFallbackToolOwnerTags?: boolean;
}

function hasAdoptablePiFallbackMessageTags(
	db: ContextDatabase,
	sessionId: string,
	fingerprintById: ReadonlyMap<string, string>,
): boolean {
	for (const [realMessageId, fingerprint] of fingerprintById) {
		if (realMessageId.startsWith("pi-msg-")) continue;
		if (findAdoptableFallbackTags(db, sessionId, fingerprint).length > 0) {
			return true;
		}
	}
	return false;
}

/**
 * Pi fallback-tag adoption pre-pass. Runs BEFORE tagging. Message text tags are
 * matched by raw-message fingerprint; tool tags are owner-driven from stored
 * `pi-msg-*` owners to the current real assistant entry id by `(timestamp,
 * callId)`. Collision folds keep the synthetic row's tag number/drop metadata,
 * merge size/token accounting by MAX, retarget pending ops, and update the
 * tagger's in-memory aliases before `tagTranscript` looks anything up.
 */
function adoptPiFallbackTags(
	db: ContextDatabase,
	sessionId: string,
	tagger: Tagger,
	fingerprintById: ReadonlyMap<string, string>,
	options: AdoptPiFallbackTagsOptions = {},
): void {
	// A positive preflight remains a valid fast path, but a negative preflight is
	// only advisory: a sibling connection can commit a fallback row after the
	// fingerprint map is built. Re-probe negatives here so the decision to skip
	// observes commits that happened before adoption starts.
	const hasFallbackMessageTags =
		options.hasFallbackMessageTags === true ||
		hasPiFallbackMessageTags(db, sessionId);
	const hasFallbackToolOwnerTags =
		options.hasFallbackToolOwnerTags === true ||
		hasPiFallbackToolOwnerTags(db, sessionId);
	const shouldRunMessageMigration =
		hasFallbackMessageTags &&
		hasAdoptablePiFallbackMessageTags(db, sessionId, fingerprintById);
	const shouldRunToolOwnerMigration = Boolean(
		options.messages && options.resolveStableId && hasFallbackToolOwnerTags,
	);
	if (!shouldRunMessageMigration && !shouldRunToolOwnerMigration) return;

	runImmediateTransaction(db, () => {
		if (shouldRunMessageMigration) {
			for (const [realMessageId, fingerprint] of fingerprintById) {
				// Only real ids can be adoption targets; a pi-msg-* id has no fallback
				// predecessor to migrate from.
				if (realMessageId.startsWith("pi-msg-")) continue;
				const candidates = findAdoptableFallbackTags(
					db,
					sessionId,
					fingerprint,
				);
				if (candidates.length === 0) continue;
				// Group candidates by their fallback message base id (strip the :pN
				// suffix). A unique base means exactly one fallback message carried this
				// fingerprint → safe to adopt; duplicates (same fingerprint on >1
				// fallback message) are ambiguous → skip, let tagTranscript allocate
				// fresh.
				const baseIds = new Set<string>();
				for (const c of candidates) {
					const m = /^(.*):p\d+$/.exec(c.messageId);
					baseIds.add(m ? m[1] : c.messageId);
				}
				if (baseIds.size !== 1) continue;
				for (const c of candidates) {
					const ordinalMatch = /:p(\d+)$/.exec(c.messageId);
					if (!ordinalMatch) continue;
					const realContentId = `${realMessageId}:p${ordinalMatch[1]}`;
					const adoption = adoptPiFallbackMessageTag(
						db,
						sessionId,
						c.tagNumber,
						c.messageId,
						realContentId,
					);
					if (adoption.action !== "skipped") {
						// Drop stale fallback and collision aliases, then bind the survivor
						// under the real key so the same-pass exact lookup hits it.
						tagger.unbindTag(sessionId, c.messageId);
						if (adoption.action === "folded") {
							tagger.unbindTag(sessionId, realContentId);
						}
						tagger.bindTag(sessionId, realContentId, adoption.tagNumber);
					}
				}
			}
		}

		if (
			shouldRunToolOwnerMigration &&
			options.messages &&
			options.resolveStableId
		) {
			const ownerMap = buildPiToolOwnerMap(
				options.messages,
				options.resolveStableId,
			);
			for (const row of findPiFallbackToolOwnerTags(db, sessionId)) {
				const parsed = parsePiFallbackToolOwnerId(row.toolOwnerMessageId);
				if (parsed?.role !== "assistant") continue;
				const owners = ownerMap.get(
					piToolOwnerMapKey(parsed.timestamp, row.callId),
				);
				if (owners?.size !== 1) continue;
				const [realOwnerId] = owners;
				if (!realOwnerId || realOwnerId.startsWith("pi-msg-")) continue;
				const adoption = adoptPiFallbackToolOwnerTag(
					db,
					sessionId,
					row.tagNumber,
					row.callId,
					row.toolOwnerMessageId,
					realOwnerId,
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

	pi.on("context", async (event, ctx) => {
		const transformStartTime = performance.now();
		let sessionIdForError: string | undefined;
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
			const projectDirectory = ctx.cwd;
			const fullWireMessageCount = event.messages.length;

			// Resolve the effective options for THIS pass's project. On a `/cd`
			// switch this picks up the switched-into checkout's config (caller
			// memoizes per cwd). Falls back to baseOptions (launch cwd) when no
			// resolver is wired (tests) or the resolver returns nothing.
			const options =
				baseOptions.resolveForProject?.(projectDirectory) ?? baseOptions;
			const schedulerConfig = options.scheduler ?? DEFAULT_SCHEDULER_CONFIG;
			const scheduler = schedulerFor(options);
			const projectIdentity =
				resolveProjectIdentityForSession(
					projectDirectory,
					options.allowHomeProject,
				) ?? "";
			updateSessionProjectTracking(sessionId, projectIdentity, options.db);
			logTransformTiming(
				sessionId,
				"findSessionId",
				tFindSession,
				`messages=${event.messages.length}`,
			);

			const tEntryBranch = performance.now();
			const branchEntries = readPiBranchEntriesForContext(ctx, sessionId);
			schedulePiTransformDecisionResolve({
				db: options.db,
				sessionId,
				branchEntries,
			});
			const rawMessageProvider = {
				readMessages: () =>
					branchEntries !== null
						? convertEntriesToRawMessages([...branchEntries])
						: readPiSessionMessages(ctx),
				readMessageById: (messageId: string) =>
					readPiSessionMessageById(ctx, messageId),
			};
			rawMessageProviderUnregistersBySession.get(sessionId)?.();
			const unregisterRaw = setRawMessageProvider(
				sessionId,
				rawMessageProvider,
			);
			rawMessageProviderUnregistersBySession.set(sessionId, unregisterRaw);
			scheduleReconciliation(options.db, sessionId, readRawSessionMessages);
			// Pi builds the context from this exact branch projection before cloning
			// messages for extension handlers. A compaction-aware projection with the
			// same length is therefore the lossless O(1) alignment lane. If another
			// extension changed the message count, fall back to conservative fingerprint
			// matching and leave ambiguous messages unresolved.
			const branchLookup =
				branchEntries === null ? null : getPiBranchEntryLookup(branchEntries);
			const alignedEntryIds = branchLookup?.alignedEntryIds ?? null;
			const resolvedEntryIds =
				alignedEntryIds?.length === event.messages.length
					? alignedEntryIds
					: branchEntries === null
						? null
						: collectMessageEntryIdsByRef(
								ctx,
								event.messages as readonly PiAgentMessage[],
								sessionId,
								branchEntries,
							);
			const strictEntryIds = resolvedEntryIds ? [...resolvedEntryIds] : null;
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
			if (latestUser) {
				const located = branchEntries
					? convertLocatedPiUserEntry(branchEntries, latestUser.messageId)
					: null;
				scheduleIncrementalIndex(
					options.db,
					sessionId,
					latestUser.messageId,
					located ??
						((_sessionId, messageId) =>
							readPiSessionMessageById(ctx, messageId)),
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
			const piUsage = ctx.getContextUsage?.();
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
			if (
				isFirstContextPassForSession &&
				liveModelBySession.get(sessionId) === undefined
			) {
				// Reuse the branch entries already read above (readPiBranchEntries
				// ForContext) — getBranch() must be walked only once per event.
				const seeded = findLastModelKeyFromBranch(branchEntries);
				if (seeded !== undefined) {
					liveModelBySession.set(sessionId, seeded);
				}
			}
			const previousModelKey = liveModelBySession.get(sessionId);
			const currentModelKey = resolvePiContextModelKey(ctx);
			const modelChanged =
				previousModelKey !== undefined &&
				currentModelKey !== undefined &&
				piModelRefToCanonical(previousModelKey) !==
					piModelRefToCanonical(currentModelKey);
			if (currentModelKey !== undefined) {
				liveModelBySession.set(sessionId, currentModelKey);
			}

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
			const tMeta = performance.now();
			const sessionMetaForUsage = getOrCreateSessionMeta(options.db, sessionId);
			logTransformTiming(sessionId, "getOrCreateSessionMeta", tMeta);

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
				const overflowState = options.compactionOff
					? { detectedContextLimit: 0, needsEmergencyRecovery: false }
					: getOverflowState(options.db, sessionId);
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
				needsEmergencyBump =
					overflowState.needsEmergencyRecovery && usagePercentage < 95;
			} catch (err) {
				sessionLog(
					sessionId,
					`transform: overflow state read failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			const sessionMeta = sessionMetaForUsage;
			const modelKey = liveModelBySession.get(sessionId);
			const providerId =
				typeof ctx.model?.provider === "string"
					? ctx.model.provider
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
				}
			}
			const windowGeometry = resolvePiWindowGeometry({
				rawContextWindow: usageContextLimit,
				model: ctx.model,
				detectedContextLimit,
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
			({ percentage: usagePercentage, inputTokens: usageInputTokens } =
				applyForwardPressureFloor(
					usagePercentage,
					usageInputTokens,
					piUsage?.tokens,
					usageContextLimit,
				));
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
			logTransformTiming(sessionId, "modelChangeDetection", tModelDetect);

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
				signalPiPendingMaterialization(sessionId);
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
			const schedulerDecisionEarly = schedulerDecision;
			const midTurn = isMidTurnPi(event, sessionId, branchEntries);
			const bypassReason = detectMidTurnBypassReason({
				contextUsage: { percentage: usagePercentage },
				sessionMeta,
				historyRefreshSessions,
				sessionId,
				effectiveExecuteThresholdPercentage,
			});

			const { midTurnAdjustedSchedulerDecision, sideEffect } =
				options.compactionOff
					? {
							midTurnAdjustedSchedulerDecision: "defer" as const,
							sideEffect: "none" as const,
						}
					: applyMidTurnDeferral({
							base: schedulerDecisionEarly,
							bypassReason,
							midTurn,
						});

			if (sideEffect === "set-flag" && !options.compactionOff) {
				const flagPayload = {
					id: crypto.randomUUID(),
					reason: `${schedulerDecisionEarly}-${bypassReason}`,
					recordedAt: Date.now(),
				};
				setDeferredExecutePendingIfAbsent(options.db, sessionId, flagPayload);
			}

			schedulerDecision = midTurnAdjustedSchedulerDecision;
			// NOTE: do NOT promote defer→execute when a deferred-execute flag
			// exists. OpenCode treats the flag as drain-on-success ONLY (it never
			// re-raises execute) — see transform-postprocess-phase.ts boundary-exec
			// drain + boundary-execution-integration.test.ts case 4 ("boundary defer
			// with prior flag preserves the flag"). The scheduler is idempotent:
			// shouldExecute re-returns "execute" on the next non-mid-turn pass while
			// pressure still holds, so the deferred execute fires naturally without a
			// Pi-only override. Promoting here diverged from OpenCode in exactly the
			// case where pressure dropped below threshold after the mid-turn defer:
			// OpenCode correctly defers (byte-stable) while Pi force-executed a
			// spurious cache-busting pass. The flag is drained on the next pass that
			// genuinely executes (peek+clear at the end of runPipeline).
			sessionLog(
				sessionId,
				`[boundary-exec] base=${schedulerDecisionEarly} bypass=${bypassReason} midTurn=${midTurn} effective=${midTurnAdjustedSchedulerDecision} sideEffect=${sideEffect}`,
			);

			// At the derived force band, enable aggressive drop-all-tools mode.
			// Mirrors OpenCode transform-postprocess-phase.ts:145-146.
			const forceMaterialization =
				!options.compactionOff &&
				usagePercentage >= forceMaterializationPercentage;

			// 95% emergency block: usage is dangerous enough that we
			// MUST wait for any in-flight historian to finish so its
			// queued drops can materialize on this pass, AND we apply
			// drop-all-tools cleanup to shrink the prompt as much as
			// possible before the LLM call. Mirrors OpenCode's >=95%
			// emergency path in transform.ts (~line 514+).
			//
			// Pi differences vs OpenCode:
			//   - We can't `client.session.abort()` mid-pass (Pi
			//     doesn't expose that surface to extensions). The next
			//     best is to await the in-flight historian here so the
			//     LLM call still happens, but with a freshly-shrunk
			//     prompt. If no historian is in flight we still apply
			//     dropAllTools via forceMaterialization so the prompt
			//     shrinks regardless.
			//   - We cap the wait at 30s to avoid stalling the user's
			//     turn forever if historian hangs. After 30s we fall
			//     through to the normal pipeline (with drop-all-tools
			//     still active via the derived force-band branch).
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
						`EMERGENCY: usage=${usagePercentage.toFixed(1)}% — notified user, awaiting in-flight historian + applying drop-all-tools`,
					);
				}

				// Wait for in-flight historian (if any) so its drops can
				// be applied on this pass. Bounded so a hung historian
				// doesn't stall the user's turn.
				const histPromise = inFlightHistorian.get(sessionId);
				if (histPromise) {
					try {
						await withTimeout(histPromise, 30_000);
						sessionLog(
							sessionId,
							"EMERGENCY: historian wait completed (or timed out)",
						);
					} catch {
						// Historian already logged its own failure; just continue.
					}
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
				`transform: usage=${usagePercentage.toFixed(1)}% (${usageInputTokens} tokens, limit=${usageContextLimit ?? "?"}) decision=${schedulerDecision}${forceMaterialization ? " force=true" : ""}${isEmergency ? " EMERGENCY=true" : ""}${isCacheBusting ? " busting=true" : ""}`,
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
			const result = await runPipeline({
				db: options.db,
				tagger,
				sessionId,
				projectIdentity,
				projectDirectory,
				sessionMeta,
				messages: event.messages,
				smartDrops: options.smartDrops === true,
				protectedTags: options.protectedTags ?? 20,
				heuristics: options.heuristics,
				emergencyCeilingTokens,
				injection: options.injection
					? {
							...options.injection,
							memoryEnabled: options.injection.memoryEnabled,
							// v2 decay rendering needs the HISTORY budget (~60K), not the
							// memory injection budget (~4K). Compute it from live usage +
							// historian config, mirroring OpenCode's decayPressure budget.
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
				stableIdSchemeCutover,
				schedulerDecision,
				// 95% emergency forces drop-all-tools regardless of the
				// derived force gate, so the LLM call sees the smallest possible
				// prompt before we hand control back to Pi.
				forceMaterialization: forceMaterialization || isEmergency,
				forceMaterializationPercentage,
				contextUsage: {
					percentage: usagePercentage,
					inputTokens: usageInputTokens,
				},
				isCacheBusting,
				reasoningClearing: {
					clearReasoningAge:
						options.heuristics?.clearReasoningAge ??
						DEFAULT_CLEAR_REASONING_AGE,
				},
				canUseEmptySentinels,
				temporalAwareness: options.injection?.temporalAwareness === true,
				appendCompaction: resolvePiAppendCompaction(ctx),
				readBranchEntries: resolvePiReadBranchEntries(ctx),
				isSubagent: sessionMeta.isSubagent,
				compactionOff: options.compactionOff === true,
			});
			logTransformTiming(sessionId, "runPipeline", tRunPipeline);
			const postPipelineStart = performance.now();
			const tTransformDecision = performance.now();
			// Replace the reuse window only after a successful pass. An id absent from
			// the current branch must take one full derivation pass if it later returns,
			// and bounding the set to the live branch prevents session-long growth.
			if (strictEntryIds) {
				recordSuccessfulTaggedMessageIds(sessionId, strictEntryIds);
			}
			const piDecisionSnapshotNewestAssistant = result.bustedThisPass
				? findNewestPiAssistantEntryId(branchEntries)
				: undefined;
			if (piDecisionSnapshotNewestAssistant !== undefined) {
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
					},
					piDecisionSnapshotNewestAssistant,
				);
			}
			logTransformTiming(
				sessionId,
				"transformDecisionAndReuseState",
				tTransformDecision,
			);

			// After tagging+drops have committed, check whether historian
			// should fire. Historian config is optional — tagging-only
			// behavior is the Step 4b.2 contract, and historian is
			// fire-and-forget so we never block the LLM call on it.
			const tHistorianScheduling = performance.now();
			if (options.historian && !options.compactionOff) {
				maybeFireHistorian({
					pi,
					ctx,
					sessionId,
					db: options.db,
					historian: options.historian,
					isFirstContextPassForSession,
					activeTags: result.activeTags,
					rawMessageProvider,
					taggerFloor,
				});
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
						// Same signal OpenCode uses to gate sticky-anchor GC
						// (isCacheBustingPass = history-refresh OR work executed).
						isCacheBusting: isCacheBusting || result.executedWorkThisPass,
						// These leading synthetic messages have no persisted entry IDs, so
						// exclude them from the sticky-anchor GC denominator.
						syntheticLeadingCount: result.syntheticLeadingCount,
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
			if (options.autoSearch?.enabled && !options.compactionOff) {
				try {
					outputMessages = await runAutoSearchHintForPi({
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
						options: {
							enabled: true,
							scoreThreshold: options.autoSearch.scoreThreshold,
							minPromptChars: options.autoSearch.minPromptChars,
							projectPath: projectIdentity,
							visibleMemoryIds:
								getVisibleMemoryIds(options.db, sessionId) ?? null,
						},
					});
				} catch (err) {
					sessionLog(
						sessionId,
						`auto-search failed: ${err instanceof Error ? err.message : String(err)}`,
					);
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
			// Cache-busting gate parity: OpenCode uses
			// `isCacheBustingPass = shouldApplyPendingOps || shouldRunHeuristics`
			// (transform-postprocess-phase.ts:273). Pi's `isCacheBusting`
			// flag from the outer handler only covers history refresh
			// (historian publication), so we OR it with
			// `result.executedWorkThisPass` — pending-op materialization,
			// heuristic cleanup, or reasoning clearing — to match
			// OpenCode's broader "execute pass that actually mutated state"
			// semantics.
			//
			// Subagents skip — they don't get synthetic injection in
			// OpenCode either (see B7 `args.fullFeatureMode` gate).
			const tTodoCapture = performance.now();
			try {
				const sessionMetaForTodo = getOrCreateSessionMeta(
					options.db,
					sessionId,
				);
				if (
					!options.compactionOff &&
					!sessionMetaForTodo.isSubagent &&
					sessionMetaForTodo.lastTodoState !== ""
				) {
					const isCacheBustingForTodo =
						isCacheBusting || result.executedWorkThisPass;
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
			logTransformTiming(sessionId, "todoCapture", tTodoCapture);

			// Walk Pi's final rendered entry stream once to calculate both nudge-channel
			// totals. A cache-busting pass replaces the saved baseline; a deferred pass
			// keeps it and adds only newly appended content and protection-boundary moves.
			const tChannelAccounting = performance.now();
			try {
				const sessionMetaForCh1 = getOrCreateSessionMeta(options.db, sessionId);
				if (!options.compactionOff && !sessionMetaForCh1.isSubagent) {
					const tags = getTagsBySession(options.db, sessionId);
					const protectedTags = options.protectedTags ?? 20;
					// Queued ctx_reduce drops are completed agent decisions. Their bytes
					// remain in T until a cache-busting materialization, but not in U.
					const pendingDropTagNumbers = new Set(
						getPendingOps(options.db, sessionId)
							.filter((operation) => operation.operation === "drop")
							.map((operation) => operation.tagId),
					);
					const stableId = (message: unknown): string | undefined =>
						message && typeof message === "object"
							? result.postCommitEntryIdByRef.get(message)
							: undefined;
					const baseline = refreshPiTailHygieneBaseline({
						messages: outputMessages,
						tags,
						protectedTags,
						pendingDropTagNumbers,
						stableId,
						syntheticLeadingCount: result.syntheticLeadingCount,
						cacheBusting: result.bustedThisPass,
						previous: getPiChannel1Baseline(sessionId),
					});
					const effective = effectivePiTailHygiene(baseline);
					resetLastNudgeCycleIfTailShrank(options.db, sessionId, effective.u);
					const oldestReclaimableToolTags = getOldestActiveUnprotectedToolTags(
						options.db,
						sessionId,
						protectedTags,
					);
					const channelState = {
						...baseline,
						usableWindow: usageContextLimit ?? 0,
						realUserTurnCount: countRealPiUserMessages({
							messages: outputMessages,
							tags,
							protectedTags,
							pendingDropTagNumbers,
							stableId,
							syntheticLeadingCount: result.syntheticLeadingCount,
						}),
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
							protectedTags,
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
			clearLastTransformErrorIfSet(options.db, sessionId);
			options.maybeAutoEmbedSession?.(
				sessionId,
				projectDirectory,
				projectIdentity,
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
			if (
				assertTailHygieneLastWriter &&
				process.env.NODE_ENV !== "production"
			) {
				assertTailHygieneLastWriter();
			}
			return { messages: outputMessages } as {
				messages: typeof event.messages;
			};
		} catch (err) {
			// Loud fail-closed / emergency aborts must reach the user — do not
			// swallow into native-compaction fallthrough.
			if (isFailClosedBlockingError(err) && !baseOptions.compactionOff)
				throw err;
			const message = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? err.stack : undefined;
			log(
				`[magic-context][pi] context handler failed (continuing without mutation): ${message}`,
				stack,
			);
			if (sessionIdForError) {
				// baseOptions.db (not the per-pass `options`, which is scoped to
				// the try). The DB handle is shared across all projects.
				persistLastTransformErrorIfChanged(
					baseOptions.db,
					sessionIdForError,
					summarizeTransformError(err),
				);
			}
			// Fall through with no mutation — Pi proceeds with original
			// messages, equivalent to a no-op transform pass.
			return;
		}
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
 * `session_shutdown` handler can `await` outstanding runs before Pi
 * exits — critical for `pi --print` mode where the parent process
 * exits as soon as `agent_end` fires, otherwise killing the historian
 * subprocess mid-run.
 */
const inFlightHistorian = new Map<string, Promise<unknown>>();

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
	clearReasoningAge: number;
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
		clearReasoningAge:
			args.historian.clearReasoningAge ?? DEFAULT_CLEAR_REASONING_AGE,
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
	return setInterval(() => {
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
	}, COMPARTMENT_LEASE_RENEWAL_MS);
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
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	sessionId: string;
	db: ContextDatabase;
	historian: PiHistorianOptions;
	provider: { readMessages: () => ReturnType<typeof readPiSessionMessages> };
	unregister: () => void;
	boundarySnapshot: ProtectedTailBoundarySnapshot;
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
	const holderId = crypto.randomUUID();
	const runPromise = (async () => {
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
			releaseCompartmentLease(db, sessionId, holderId);
			return;
		}
		const renewal = startPiCompartmentLeaseRenewal(db, sessionId, holderId);
		try {
			await runPiHistorian({
				db,
				sessionId,
				directory: ctx.cwd,
				provider,
				appendCompaction: resolvePiAppendCompaction(ctx),
				readBranchEntries: resolvePiReadBranchEntries(ctx),
				runner: historian.runner,
				historianModel: historian.model,
				fallbackModels: historian.fallbackModels,
				fallbackModelId,
				historianChunkTokens: historian.historianChunkTokens,
				boundarySnapshot,
				refreshBoundarySnapshot,
				currentContextLimit,
				historianTimeoutMs: historian.timeoutMs,
				twoPass: historian.twoPass,
				thinkingLevel: historian.thinkingLevel,
				memoryEnabled: historian.memoryEnabled,
				allowHomeProject: historian.allowHomeProject,
				autoPromote: historian.autoPromote,
				userMemoriesEnabled: historian.userMemoriesEnabled,
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
			releaseCompartmentLease(db, sessionId, holderId);
		}
	})().finally(() => {
		inFlightHistorian.delete(sessionId);
		unregister();
		if (isContextHandlerSessionActive(sessionId)) {
			historian.onStatusChange?.(ctx, sessionId);
		}
	});
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
	return sm.appendCompaction.bind(sm);
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
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	sessionId: string;
	db: ContextDatabase;
	historian: PiHistorianOptions;
	isFirstContextPassForSession?: boolean;
	activeTags?: ReturnType<typeof getActiveTagsBySession>;
	rawMessageProvider?: {
		readMessages: () => ReturnType<typeof readPiSessionMessages>;
	};
	taggerFloor?: number;
}): void {
	const { ctx, sessionId, db, historian, isFirstContextPassForSession } = args;

	if (inFlightHistorian.has(sessionId)) {
		sessionLog(sessionId, "historian trigger eval: in-flight, skipping");
		return;
	}

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
		const piUsage = ctx.getContextUsage?.();
		let usageSource: "session_meta" | "piUsage fallback";
		// Sane-bound (isSaneLimit, NOT `> 0`) so a garbage-but-positive window
		// can't drive the trigger budget — mirrors the main pressure pass.
		usageContextLimit = isSaneLimit(piUsage?.contextWindow)
			? piUsage.contextWindow
			: undefined;
		let detectedContextLimit: number | undefined;
		// Cold-start: fall back to the model's window when usage hasn't reported
		// a sane one yet (first pass after restart).
		if (
			usageContextLimit === undefined &&
			isSaneLimit(ctx.model?.contextWindow)
		) {
			usageContextLimit = ctx.model.contextWindow;
		}
		// Apply the detected-overflow cap (authoritative real limit) just like the
		// main pass — otherwise the trigger budget uses the wrong (larger) limit.
		try {
			const overflowState = getOverflowState(db, sessionId);
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
			model: ctx.model,
			detectedContextLimit,
		});
		const sessionMetaForUsage = getOrCreateSessionMeta(db, sessionId);
		if (
			sessionMetaForUsage.lastContextPercentage > 0 &&
			sessionMetaForUsage.lastInputTokens > 0
		) {
			usage = {
				percentage: sessionMetaForUsage.lastContextPercentage,
				inputTokens: sessionMetaForUsage.lastInputTokens,
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
		usage = applyForwardPressureFloor(
			usage.percentage,
			usage.inputTokens,
			piUsage?.tokens,
			usageContextLimit,
		);
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
	const provider = args.rawMessageProvider ?? {
		readMessages: () => readPiSessionMessages(ctx),
	};
	const unregister = setRawMessageProvider(sessionId, provider);
	const sessionMeta = getOrCreateSessionMeta(db, sessionId);
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
		if (isFirstContextPassForSession) {
			const sessionMeta = getOrCreateSessionMeta(db, sessionId);
			if (
				sessionMeta.compartmentInProgress &&
				!inFlightHistorian.has(sessionId)
			) {
				updateSessionMeta(db, sessionId, { compartmentInProgress: false });
				sessionLog(
					sessionId,
					"historian: cleared stale compartmentInProgress flag on first context pass after restart",
				);
			}

			const failureState = getHistorianFailureState(db, sessionId);
			if (failureState.failureCount > 0) {
				boundarySnapshot = resolveRunnablePiBoundarySnapshot();
			}
			const shouldRecoverOnFirstPass =
				failureState.failureCount > 0 &&
				boundarySnapshot !== undefined &&
				hasEligiblePiCompartmentHistory(db, sessionId, boundarySnapshot);
			if (shouldRecoverOnFirstPass) {
				triggered = true;
				sessionLog(
					sessionId,
					`historian recovery triggered on session load after ${failureState.failureCount} failure(s)`,
				);
				sendPiIgnoredNotification(
					ctx,
					`## Historian recovery\n\nHistorian previously failed ${failureState.failureCount} time(s), so Magic Context is retrying history comparting immediately after restart.`,
				);
				spawnPiHistorianRun({
					pi: args.pi,
					ctx,
					sessionId,
					db,
					historian,
					provider,
					unregister,
					boundarySnapshot: boundarySnapshot as ProtectedTailBoundarySnapshot,
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
			triggerInputs.clearReasoningAge,
			triggerInputs.commitClusterTrigger,
			args.activeTags,
			boundaryContextLimit,
			() => {
				const messages = provider.readMessages();
				return { messages, absoluteMessageCount: messages.length };
			},
			args.taggerFloor,
			{ canClearReasoning: true },
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
				const overflowState = getOverflowState(db, sessionId);
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

		triggered = true;
		sessionLog(
			sessionId,
			`historian trigger fired (reason=${trigger.reason ?? "unknown"}) usage=${usage.percentage.toFixed(1)}% — spawning subagent`,
		);

		// Fire-and-forget for the user's LLM call: the parent agent
		// turn never awaits this. But we DO track the Promise in
		// inFlightHistorian so `awaitInFlightHistorians()` can wait
		// at session_shutdown — without that, `pi --print` mode would
		// kill the historian subprocess mid-run when the parent exits.
		spawnPiHistorianRun({
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
	db: ContextDatabase;
	tagger: Tagger;
	sessionId: string;
	projectIdentity: string;
	projectDirectory: string;
	sessionMeta: ReturnType<typeof getOrCreateSessionMeta>;
	messages: Parameters<typeof createPiTranscript>[0];
	/** Smart-drops (experimental, default off): also reclaim tool output that a
	 *  later call supersedes, on top of the age-based auto-drop. Off → messages
	 *  sent to the model are byte-identical to the age-based-only behavior. */
	smartDrops?: boolean;
	protectedTags: number;
	/** Heuristic-cleanup config — when omitted, defaults to OpenCode parity values. */
	heuristics?: {
		caveman?: { enabled: boolean; minChars: number };
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
	 * cached injection). Mirrors OpenCode's `schedulerDecisionEarly`.
	 */
	schedulerDecision: "execute" | "defer";
	/**
	 * Force-materialization signal: when true, drop-all-tools mode
	 * activates (mirrors OpenCode's derived force-band emergency cleanup). Caller
	 * computes from current usage percentage.
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
		clearReasoningAge: number;
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
}

interface RunPipelineResult {
	messages: unknown[];
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
	targetCount: number;
	reasoningWatermark: number;
	activeTags: ReturnType<typeof getActiveTagsBySession>;
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
		const message = raw as { role?: unknown; content?: unknown };
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
				muralEnabled: args.injection.muralEnabled === true,
				compactionOff: true,
			},
			args.db,
			args.messages as Parameters<typeof injectM0M1Pi>[2],
			args.entryIds,
			false,
		);
	}
	return {
		messages: args.messages as unknown[],
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
		targetCount: 0,
		reasoningWatermark: args.sessionMeta.clearedReasoningThroughTag ?? 0,
		activeTags: [],
		postCommitEntryIdByRef: new Map(),
	};
}

async function runPipeline(args: RunPipelineArgs): Promise<RunPipelineResult> {
	if (args.compactionOff) return runCompactionOffPipeline(args);
	const forceMaterializationPercentage =
		args.forceMaterializationPercentage ??
		escalationBands(65).forceMaterializationPercentage;
	let executedWorkThisPass = false;
	let historyWasConsumedThisPass = false;
	let materializationSatisfiedThisPass = false;
	let pendingOpsAppliedThisPass = false;
	let pendingOpsDidMutate = false;
	let heuristicOrReasoningDidMutate = false;
	let didMutateFromFlushedStatuses = false;
	let droppedCount = 0;
	const droppedTokens = 0;
	let emergency = false;
	let autoReclaimDidMutateThisPass = false;
	let suppressDeferredHistoryDrain = false;
	let deferredMaterializationConsumedThisPass = false;
	let casLost = false;
	const deferredHistoryWasPendingAtPassStart =
		deferredHistoryRefreshSessions.has(args.sessionId);

	// 0. Inject temporal `<!-- +Xm -->` markers into user messages
	// BEFORE tagging so the §N§ tag prefix wraps around our marker on
	// re-tagging. Idempotent: existing markers are detected by regex
	// and skipped. Same invariants as OpenCode's `injectTemporalMarkers`
	// at transform.ts:648 — runs on every pass, deterministic from
	// timestamps, retroactive when the flag flips.
	if (args.temporalAwareness) {
		const tTemporal = performance.now();
		try {
			const injected = injectPiTemporalMarkers(args.messages);
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
	const tTranscriptBuild = performance.now();
	const transcript = createPiTranscript(
		args.messages,
		args.sessionId,
		args.entryIds,
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
	// Stable-id resolver for the reasoning/placeholder paths. MUST match the id the
	// transcript assigned each message (so reasoning's messageIdToMaxTag lookup
	// hits). Reasoning runs on `workingMessages` where tagging may have cloned
	// working[i] → entryIdByRef misses those, so positional args.entryIds is the
	// mandatory fallback (same precedence resolvePiStableId enforces).
	const stableIdResolver = (msg: unknown, index: number): string | undefined =>
		resolvePiStableId(
			msg,
			index,
			args.entryIds,
			args.entryIdByRef ?? undefined,
		);
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
	// Mid-turn-aware gate for consuming DEFERRED publication signals — mirrors
	// OpenCode's canConsumeDeferredOnThisPass. `args.schedulerDecision` is ALREADY
	// the mid-turn-adjusted decision (applyMidTurnDeferral downgrades execute→defer
	// mid-turn), so a deferred-publication signal that lands mid-turn is NOT
	// consumed here — it waits for the next non-mid-turn execute/force pass. This
	// breaks the previous inverted dependency where shouldRunHeuristics read the
	// RAW deferredMaterializationSessions.has() (no mid-turn gate) and then
	// canConsumeDeferredLate was derived FROM shouldRunHeuristics — so Pi ran
	// heuristics + drained the native compaction marker mid-turn where OpenCode
	// stays deferred (busting the Anthropic prompt cache while a multi-step turn
	// was still accumulating tool calls). (OpenCode also consumes on
	// justAwaitedPublication, but Pi's historian is detached and signals via the
	// deferred sets post-publish, so there's no inline await to special-case.)
	const canConsumeDeferredLate =
		args.schedulerDecision === "execute" ||
		args.forceMaterialization === true ||
		args.contextUsage.percentage >= forceMaterializationPercentage;
	const deferredMaterializeEligible =
		canConsumeDeferredLate &&
		deferredMaterializationSessions.has(args.sessionId);
	// A HARD decision alone is not a cache bust. Execute it against a shadow
	// message array first, then let pending drops, heuristics, and reasoning cleanup
	// ride the bust only when m[0] actually materialized. Contention or any other
	// suppressed attempt keeps defer replay immutable; the wire injection below
	// still performs its own late decision for races after this preflight.
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
	// Build the fold state once and reuse it for both the preflight and the wire
	// injection. Omitting a render-affecting field from only one of those calls can
	// manufacture a HARD signal that the real injection immediately disproves.
	const piM0State =
		args.injection && piHardSignals
			? {
					sessionId: args.sessionId,
					projectIdentity: args.projectIdentity,
					projectDirectory: args.projectDirectory,
					memoryEnabled: args.injection.memoryEnabled,
					injectDocs: args.injection.injectDocs,
					injectionBudgetTokens: args.injection.injectionBudgetTokens,
					historyBudgetTokens: args.injection.historyBudgetTokens,
					hardSignals: piHardSignals,
					muralEnabled: args.injection.muralEnabled === true,
				}
			: undefined;
	const foldDueDecision = piM0State
		? mustMaterializePi(
				piM0State,
				args.db,
				getCompartments(args.db, args.sessionId),
			)
		: { value: false, reason: null };
	let foldExecutedThisPass = false;
	let preFoldInjectionResult: PiInjectionResult | null = null;
	const persistedM0BeforeFold = getOrCreateSessionMeta(args.db, args.sessionId);
	const m0CoverageBeforeFold =
		persistedM0BeforeFold.cachedM0Bytes === null
			? -1
			: persistedM0BeforeFold.cachedM0MaxCompartmentSeq;
	if (foldDueDecision.value && piM0State) {
		try {
			// Persist the fold before opening mutation gates. The shadow array keeps
			// this pre-execution off the outgoing wire; the normal injection below
			// replays the persisted pair into the real message array.
			preFoldInjectionResult = injectM0M1PiForRun(
				piM0State,
				args.db,
				[],
				undefined,
				false,
			);
			foldExecutedThisPass = foldExecutesThisPass(
				foldDueDecision.value,
				preFoldInjectionResult.m0Materialized === true,
			);
			const m0CoverageAfterFold = getOrCreateSessionMeta(
				args.db,
				args.sessionId,
			).cachedM0MaxCompartmentSeq;
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
			`pi m[0] HARD fold decision: reason=${foldDueDecision.reason ?? "unknown"}${mismatch} executed=${foldExecutedThisPass}`,
		);
	}
	const historianRunning = inFlightHistorian.has(args.sessionId);
	// A normal execute/deferred drain waits while the historian reads its raw
	// snapshot. Only a fold that was persisted successfully may bypass the veto;
	// an advisory mismatch or contention fallback cannot authorize mutations.
	const bypassHistorianGate =
		args.forceMaterialization === true || foldExecutedThisPass;
	const hasPendingMaterializeSignal = hasPendingMaterialization(args.sessionId);
	// Pi sessions are primary-equivalent today. If Pi adds subagents on this
	// transform path, subagents should bypass this once-per-turn guard like
	// OpenCode does, because they do not share the primary agent's turn cache.
	const shouldRunHeuristics =
		args.heuristics !== undefined &&
		(!historianRunning || bypassHistorianGate) &&
		(args.forceMaterialization === true ||
			hasPendingMaterializeSignal ||
			deferredMaterializeEligible ||
			// A fold persisted earlier in this pass already busted the prefix, so
			// reductions may ride it without causing an independent bust.
			foldExecutedThisPass ||
			(args.schedulerDecision === "execute" && !alreadyRanHeuristicsThisTurn));

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
	const tFallbackIdentity = performance.now();
	// This indexed preflight avoids rebuilding fingerprints for every old message.
	// A negative result is rechecked by adoption after this map is complete, while
	// tool-owner adoption performs its only existence probe at that later point.
	const hasFallbackMessageTags = hasPiFallbackMessageTags(
		args.db,
		args.sessionId,
	);
	const entryFingerprintByMessageId = buildEntryFingerprintMap(
		args.messages as PiAgentMessage[],
		stableIdResolver,
		args.reusableMessageIds,
		// Existing fallback rows may match any old real-id message. Once the
		// indexed gate is empty, only the newly observed tail needs fingerprints.
		hasFallbackMessageTags,
	);
	adoptPiFallbackTags(
		args.db,
		args.sessionId,
		args.tagger,
		entryFingerprintByMessageId,
		{
			messages: args.messages as PiAgentMessage[],
			resolveStableId: stableIdResolver,
			hasFallbackMessageTags,
		},
	);
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
	const { targets } = tagTranscript(
		args.sessionId,
		transcript,
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
	logTransformTiming(args.sessionId, "tagMessages", tTag);

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
		(args.schedulerDecision === "execute" ||
			args.forceMaterialization ||
			hasPendingMaterializeSignal ||
			foldExecutedThisPass ||
			historianRunning);
	const pendingOps = shouldReadPendingOps
		? getPendingOps(args.db, args.sessionId)
		: [];
	const pendingOperationTags =
		pendingOps.length > 0
			? getTagsForPendingOperations(
					args.db,
					args.sessionId,
					pendingOps.map((operation) => operation.tagId),
					args.protectedTags,
					RECENT_TOOL_SKELETON_WINDOW,
				)
			: [];
	// The deferred-execute flag is drain-on-success ONLY — it must NOT appear
	// here. OpenCode never gates work on the flag (peekDeferredExecutePending is
	// read solely by the drain in transform-postprocess-phase.ts); the idempotent
	// scheduler re-returns "execute" on the next non-mid-turn pass (pressure ≥
	// threshold or TTL elapsed) and THAT drives the deferred execute. Including
	// the flag here made Pi apply pending ops on a defer pass purely because the
	// flag existed — a cache-busting half-execute (ops without heuristics) on a
	// pass OpenCode keeps byte-stable. The flag is drained below on the next pass
	// that genuinely executes.
	const baseShouldApplyPendingOps =
		args.schedulerDecision === "execute" ||
		args.forceMaterialization ||
		hasPendingMaterializeSignal ||
		foldExecutedThisPass;
	// `canConsumeDeferredLate` is computed ONCE, earlier (above shouldRunHeuristics),
	// as a mid-turn-aware gate independent of shouldRunHeuristics — mirroring
	// OpenCode's canConsumeDeferredOnThisPass. It must NOT be re-derived from
	// shouldRunHeuristics here (the old inverted dependency that let deferred
	// publication drain mid-turn). Explicit flush (hasPendingMaterializeSignal)
	// still forces application via baseShouldApplyPendingOps, exactly as OpenCode
	// keeps isExplicitFlush separate from the deferred-consumption gate.
	const deferredMaterialize =
		canConsumeDeferredLate && deferredMaterializationWasPending;
	const deferredHistoryRefresh =
		canConsumeDeferredLate && deferredHistoryRefreshWasPending;
	const shouldApplyPendingOps =
		(baseShouldApplyPendingOps || deferredMaterialize) &&
		(!historianRunning || bypassHistorianGate);
	mutationGateObserverForTests?.({
		foldDue: foldDueDecision.value,
		foldExecuted: foldExecutedThisPass,
		shouldApplyPendingOps,
		shouldRunHeuristics,
		shouldRunReasoningCleanup:
			args.reasoningClearing !== undefined && shouldRunHeuristics,
	});
	if (shouldApplyPendingOps) {
		const applyReason = hasPendingMaterializeSignal
			? "explicit_flush"
			: deferredMaterialize
				? "deferred_publication"
				: args.forceMaterialization
					? "force_materialization"
					: foldExecutedThisPass && args.schedulerDecision !== "execute"
						? `m0_hard_fold (drain folded into executed m[0] bust, scheduler=${args.schedulerDecision})`
						: `scheduler_execute (scheduler=${args.schedulerDecision})`;
		sessionLog(
			args.sessionId,
			`pending ops WILL APPLY — reason=${applyReason}, pendingOps=${pendingOps.length}, context=${args.contextUsage.percentage.toFixed(1)}%`,
		);
		try {
			const tApplyPending = performance.now();
			pendingOpsDidMutate = applyPendingOperations(
				args.sessionId,
				args.db,
				targets,
				args.protectedTags,
				pendingOperationTags,
				pendingOps,
			);
			if (pendingOpsDidMutate) {
				droppedCount += pendingOps.length;
			}
			logTransformTiming(
				args.sessionId,
				"applyPendingOperations",
				tApplyPending,
			);
			executedWorkThisPass = true;
			// materializationSatisfiedThisPass enables the deferred-HISTORY drain
			// below. OpenCode drains deferred-history on history-consumption alone
			// (not heuristics success), so setting this right after pending-ops
			// success matches OpenCode for the history drain.
			materializationSatisfiedThisPass = true;
			pendingOpsAppliedThisPass = true;
			if (hasPendingMaterializeSignal) {
				if (args.heuristics === undefined) {
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
		sessionLog(
			args.sessionId,
			`pending ops WILL NOT APPLY — reason=scheduler_defer pendingOps=${pendingOps.length} context=${args.contextUsage.percentage.toFixed(1)}%`,
		);
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
	didMutateFromFlushedStatuses = applyFlushedStatuses(
		args.sessionId,
		args.db,
		targets,
		flushedDroppedTags,
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
	if (args.reasoningClearing) {
		try {
			const tReplayReasoning = performance.now();
			const clearedReplay = replayClearedReasoningPi({
				db: args.db,
				sessionId: args.sessionId,
				messages: workingMessages,
				messageIdToMaxTag,
				piMessageStableId: stableIdResolver,
			});
			const inlineReplay = replayStrippedInlineThinkingPi({
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

	// 3c. Caveman compression replay (cache-stable, runs on EVERY pass).
	// applyPiHeuristicCleanup persists per-tag caveman_depth on execute
	// passes, but the actual compressed text only lives in memory; on
	// the next defer pass the AgentMessage[] is rebuilt fresh from the
	// JSONL and arrives uncompressed. Without replay, every defer pass
	// after a caveman pass would bust the provider cache prefix because
	// the compressed text vanishes and reverts to the original.
	//
	// Mirrors OpenCode's `replayCavemanCompression` call in
	// transform.ts:793. Idempotent — `cavemanCompress(originalText, level)`
	// is deterministic, so replay produces the exact text the original
	// execute pass produced, regardless of how many times it runs.
	if (args.heuristics?.caveman?.enabled && !args.isSubagent) {
		const tCavemanReplay = performance.now();
		try {
			// P0 perf: caveman replay only acts on tags whose tag_number is in
			// `targets`, so fetch just that slice instead of the whole session
			// (~50k rows on long sessions).
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
	let heuristicsResult: PiHeuristicCleanupResult | null = null;
	const tActiveTags = performance.now();
	// Pending ops have already materialized above; reread active tags so the
	// emergency-drop floor excludes tags reclaimed earlier in this same pass.
	const activeTags = getActiveTagsBySession(args.db, args.sessionId);
	logTransformTiming(
		args.sessionId,
		"getActiveTagsBySession",
		tActiveTags,
		`count=${activeTags.length}`,
	);
	if (shouldRunHeuristics) {
		const reason = args.forceMaterialization
			? "force_materialization"
			: foldExecutedThisPass && args.schedulerDecision !== "execute"
				? `m0_hard_fold (drain folded into executed m[0] bust, scheduler=${args.schedulerDecision})`
				: `scheduler_execute (pendingOps=${pendingOps.length}, scheduler=${args.schedulerDecision})`;
		sessionLog(
			args.sessionId,
			`heuristics WILL RUN — reason=${reason}, context=${args.contextUsage.percentage.toFixed(1)}%, turn=n/a`,
		);
	} else {
		const reason =
			args.heuristics === undefined ? "disabled" : "scheduler_defer";
		sessionLog(args.sessionId, `heuristics WILL NOT RUN — reason=${reason}`);
	}
	if (shouldRunHeuristics && args.heuristics) {
		try {
			const tHeuristic = performance.now();
			heuristicsResult = applyPiHeuristicCleanup(
				args.sessionId,
				args.db,
				targets,
				args.messages,
				{
					protectedTags: args.protectedTags,
					staleReduceStripEnabled: args.canUseEmptySentinels,
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
								}
							: undefined,
					caveman: args.isSubagent ? undefined : args.heuristics.caveman,
				},
				activeTags,
				stableIdResolver,
			);
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
			if (heuristicMutationCount > 0) heuristicOrReasoningDidMutate = true;
			heuristicsExecuted = true;
			executedWorkThisPass = true;
			if (hasPendingMaterializeSignal) {
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
	if (args.reasoningClearing && shouldRunHeuristics) {
		const rollbackReasoning = captureReasoningMutationRollback(workingMessages);
		try {
			const tClearReasoning = performance.now();
			const prevWatermark = args.sessionMeta.clearedReasoningThroughTag ?? 0;
			const clearOutcome = clearOldReasoningPi({
				messages: workingMessages,
				messageIdToMaxTag,
				clearReasoningAge: args.reasoningClearing.clearReasoningAge,
				piMessageStableId: stableIdResolver,
			});
			const stripOutcome = stripInlineThinkingPi({
				messages: workingMessages,
				messageIdToMaxTag,
				clearReasoningAge: args.reasoningClearing.clearReasoningAge,
				piMessageStableId: stableIdResolver,
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
			if (
				combinedWatermark > prevWatermark ||
				clearOutcome.cleared > 0 ||
				stripOutcome.stripped > 0
			) {
				executedWorkThisPass = true;
			}
		} catch (err) {
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

	const toolReclaimExecutePass = args.schedulerDecision === "execute";
	const alreadyMutatingThisPass =
		pendingOpsDidMutate || heuristicOrReasoningDidMutate;
	const emergencyDropEligible =
		args.forceMaterialization === true ||
		args.contextUsage.percentage >= forceMaterializationPercentage;
	let autoReclaimTargetCount = 0;
	let autoReclaimDidMutate = false;
	if (
		toolReclaimExecutePass &&
		alreadyMutatingThisPass &&
		!emergencyDropEligible
	) {
		const reclaimMeta = args.sessionMeta;
		const syntheticPendingOps = buildSyntheticToolReclaimOps({
			db: args.db,
			sessionId: args.sessionId,
			targets,
			watermark: reclaimMeta.toolReclaimWatermark ?? 0,
			pendingOps,
		});
		// Smart-drops: also reclaim older todowrite/ctx_reduce/meta outputs that
		// a later call supersedes, and compress superseded edits to an
		// edit_marker (keep filePath + region hint). Merged into the same
		// already-gated drop apply as the age-based sweep above. Dedupe (a tag
		// can qualify under more than one rule).
		const editMarkerTagIds = new Set<number>();
		if (args.smartDrops) {
			const selectedIds = new Set(syntheticPendingOps.map((op) => op.tagId));
			const supersessionOps = buildSupersessionReclaimOps({
				db: args.db,
				sessionId: args.sessionId,
				targets,
				pendingOps,
			});
			for (const op of supersessionOps) {
				if (!selectedIds.has(op.tagId)) {
					syntheticPendingOps.push(op);
					selectedIds.add(op.tagId);
				}
			}
			const editReclaim = buildEditSupersessionReclaim({
				db: args.db,
				sessionId: args.sessionId,
				targets,
				pendingOps,
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
				targets,
				args.protectedTags,
				undefined,
				[],
				syntheticPendingOps,
				editMarkerTagIds,
			);
			if (autoReclaimDidMutate) {
				droppedCount += syntheticPendingOps.length;
				autoReclaimDidMutateThisPass = true;
			}
		}
	}

	// 4c. Processed-image replay/detection. Pi carries base64 image data in
	// user and tool-result parts. Frozen ids replay on every Anthropic pass;
	// newly aged ids are detected only while this pass is already busting and
	// are persisted before their bytes are replaced with empty text sentinels.
	if (args.canUseEmptySentinels) {
		const tProcessedImages = performance.now();
		try {
			const imageResult = stripPiProcessedImages({
				db: args.db,
				sessionId: args.sessionId,
				messages: workingMessages,
				detect:
					args.isCacheBusting || shouldApplyPendingOps || shouldRunHeuristics,
				watermark: getMaxDroppedTagNumber(args.db, args.sessionId),
				messageIdToMaxTag,
				stableId: stableIdResolver,
			});
			if (imageResult.newlyStrippedIds.length > 0) {
				heuristicOrReasoningDidMutate = true;
				executedWorkThisPass = true;
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

	// 5. Commit tagging mutations back to Pi messages BEFORE injecting
	// the history block. Otherwise the injection write target is the
	// pre-tagged content. Pi's transcript adapter writes mutations
	// back to the underlying AgentMessage[] via the part proxies, so
	// commit() just locks the result in.
	const tTranscriptCommit = performance.now();
	transcript.commit();
	logTransformTiming(args.sessionId, "transcriptCommit", tTranscriptCommit);
	if (toolReclaimExecutePass) {
		advanceToolReclaimWatermarkToCurrentMax(args.db, args.sessionId);
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
	//   1. postCommitStableIdByRef (FULL fallback via resolvePiStableId, incl.
	//      pi-msg-* index ids) — for stripPiDroppedPlaceholderMessages, which needs
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
	for (let i = 0; i < args.messages.length; i++) {
		const m = args.messages[i];
		if (!m || typeof m !== "object") continue;
		const id = resolvePiStableId(
			m,
			i,
			args.entryIds,
			args.entryIdByRef ?? undefined,
		);
		if (id) postCommitStableIdByRef.set(m as object, id);
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
			const wireInjectionResult = injectM0M1PiForRun(
				piM0State!,
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
				args.isCacheBusting || deferredHistoryRefresh || executedWorkThisPass,
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
			// Temporal markers are derived before history injection trims raw messages.
			// If that trim promotes a user message to the raw-history head, its marker
			// was based on a predecessor that is no longer visible. Remove it now so the
			// marker-applying pass matches the next pass, where trimming happens first.
			if (
				args.temporalAwareness &&
				injectionResult.skippedVisibleMessages > 0
			) {
				const firstRetainedMessage =
					args.messages[injectionResult.syntheticLeadingCount];
				stripPiLeadingTemporalMarker(firstRetainedMessage);
			}
			// PEEK-then-drain-on-success (Oracle audit Round 8 #6):
			// only drain `historyRefreshSessions` if the rebuild
			// succeeded AND this pass was busting the cache. If
			// injection throws, the flag survives so the next pass
			// retries the rebuild. Deferred-history is NOT drained
			// here; Pi-native compaction marker application happens at
			// the end of runPipeline after materializing work succeeds.
			if (args.isCacheBusting) {
				historyRefreshSessions.delete(args.sessionId);
				historyWasConsumedThisPass = true;
			}
			if (deferredHistoryRefresh) {
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

	const tDroppedPlaceholders = performance.now();
	stripPiDroppedPlaceholderMessages({
		db: args.db,
		sessionId: args.sessionId,
		messages: args.messages,
		// Discovery is gated to history-refresh passes ONLY (args.isCacheBusting) —
		// deliberately NARROWER than OpenCode's `shouldApplyPendingOps ||
		// shouldRunHeuristics`. The two harnesses diverge in strip SEMANTICS:
		// OpenCode NEUTRALIZES a placeholder-only message in place (replaces parts
		// with an empty sentinel, message stays in the array), so discovering on a
		// fresh-drop execute pass is harmless. Pi REMOVES (splices) the message.
		// A freshly-dropped tool stub renders as `[dropped §N§]`, which
		// isDroppedOnlyText matches — so discovering on the same execute pass that
		// created it would splice out the just-dropped turn and collapse it. We
		// therefore discover only at history-refresh boundaries (where the array is
		// rebuilt anyway); a stub created on a drop-only execute pass is tiny and
		// gets discovered on the next refresh pass. Replay still runs every pass.
		isCacheBusting: args.isCacheBusting,
		stableIdByRef: postCommitStableIdByRef,
		// F4 cutover: when the stable-id scheme just changed, force rediscovery so
		// previously-stripped placeholders get re-keyed under the new scheme this
		// pass (discovery is otherwise gated on isCacheBusting = history-refresh).
		forceDiscovery: args.stableIdSchemeCutover === true,
	});
	logTransformTiming(
		args.sessionId,
		"stripDroppedPlaceholders",
		tDroppedPlaceholders,
	);

	// Drain predicate intentionally has two Pi-specific terms beyond OpenCode's
	// `historyWasConsumedThisPass && deferredHistoryWasPendingAtPassStart &&
	// !suppress`:
	//   • `materializationSatisfiedThisPass` — Pi's m[0]/m[1] materialization is
	//     a separate signal from history consumption; the deferred-history
	//     one-shot must not drain until materialization actually landed this pass,
	//     or the next pass would rebuild against a half-applied snapshot.
	//   • `|| hasPendingMaterializeSignal` — Pi rebuilds a fresh AgentMessage[]
	//     per `context` event (no persistent transform array), so a pending
	//     materialize signal that arrived mid-pass is an equally valid drain
	//     trigger as a pass-start-pending refresh.
	// Net effect is signal-equivalent to OpenCode's model for the same
	// scheduler/materialization input (Oracle Round 8 peek-then-drain).
	const deferredHistoryDrainEligible =
		historyWasConsumedThisPass &&
		materializationSatisfiedThisPass &&
		(deferredHistoryWasPendingAtPassStart || hasPendingMaterializeSignal) &&
		!suppressDeferredHistoryDrain &&
		!casLost;
	let preserveDeferredMaterializationForMarkerDrain = false;
	if (deferredHistoryDrainEligible) {
		try {
			const pending = getPendingPiCompactionMarkerState(
				args.db,
				args.sessionId,
			);
			if (!pending) {
				if (injectionResult?.contentionExhausted === true) {
					suppressDeferredHistoryDrain = true;
					preserveDeferredMaterializationForMarkerDrain = true;
					sessionLog(
						args.sessionId,
						"Pi deferred-history drain skipped: m[0]/m[1] used a contention fallback; preserving deferred signals",
					);
				} else {
					consumeDeferredHistoryRefresh(args.sessionId);
				}
			} else if (
				!pendingPiMarkerCoveredByRenderedBoundary(pending, injectionResult)
			) {
				suppressDeferredHistoryDrain = true;
				preserveDeferredMaterializationForMarkerDrain = true;
				const boundary = injectionResult?.renderedBoundary;
				const m1Coverage = injectionResult?.m1RenderedCoverage;
				sessionLog(
					args.sessionId,
					`Pi compaction-marker drain skipped: pending ordinal ${pending.ordinal} is newer than rendered boundary ${boundary?.ordinal ?? "<none>"} endMessageId=${boundary?.endMessageId ?? "<none>"} (m[1] coverage ${m1Coverage?.ordinal ?? "<none>"} endMessageId=${m1Coverage?.endMessageId ?? "<none>"}); preserving deferred signals`,
				);
			} else if (!args.appendCompaction || !args.readBranchEntries) {
				suppressDeferredHistoryDrain = true;
				sessionLog(
					args.sessionId,
					"Pi compaction-marker drain skipped: sessionManager appendCompaction/getBranch unavailable; preserving deferred-history signal",
				);
			} else {
				const outcome = applyDeferredPiCompactionMarker(
					{
						db: args.db,
						appendCompaction: args.appendCompaction,
						readBranchEntries: args.readBranchEntries,
					},
					args.sessionId,
					pending,
				);
				if (outcome.kind === "retryable-failure") {
					sessionLog(
						args.sessionId,
						`Pi compaction-marker drain retryable failure: ${outcome.error.message}`,
					);
				} else if (
					clearPendingPiCompactionMarkerStateIf(
						args.db,
						args.sessionId,
						pending,
					)
				) {
					consumeDeferredHistoryRefresh(args.sessionId);
				} else {
					casLost = true;
					sessionLog(
						args.sessionId,
						"CAS-clear failed (newer blob written or another actor cleared); preserving deferred-history signal",
					);
				}
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`Pi compaction-marker drain failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	if (
		preserveDeferredMaterializationForMarkerDrain &&
		deferredMaterializationConsumedThisPass
	) {
		signalPiDeferredMaterialization(args.sessionId);
	}

	if (executedWorkThisPass) {
		try {
			const currentFlag = peekDeferredExecutePending(args.db, args.sessionId);
			if (currentFlag !== null) {
				clearDeferredExecutePendingIfMatches(
					args.db,
					args.sessionId,
					currentFlag,
				);
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`[boundary-exec] drain failed (continuing): ${err}`,
			);
		}
	}
	logTransformTiming(
		args.sessionId,
		"batchFinalize:heuristics",
		performance.now(),
	);

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

	const materialized = injectionResult?.m0Materialized === true;
	const materializeReason = injectionResult?.m0Reason ?? null;
	const bustedThisPass =
		didMutateFromFlushedStatuses ||
		pendingOpsDidMutate ||
		heuristicOrReasoningDidMutate ||
		autoReclaimDidMutateThisPass ||
		materialized ||
		historyWasConsumedThisPass;

	return {
		messages: outputMessages,
		heuristicsExecuted,
		executedWorkThisPass,
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
		targetCount: targets.size,
		reasoningWatermark: args.sessionMeta.clearedReasoningThroughTag ?? 0,
		activeTags,
		postCommitEntryIdByRef,
	};
}

// ---------------------------------------------------------------------------
// Nudge / note-nudge helpers
// ---------------------------------------------------------------------------

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
	for (const anchor of getNoteNudgeAnchors(db, sessionId)) {
		appendReminderToUserMessageByIdPi(
			messages,
			replayMessageIdByIndex,
			anchor.messageId,
			anchor.text,
		);
	}
	for (const decision of getAutoSearchHintDecisions(db, sessionId)) {
		if (decision.decision === "hint") {
			appendReminderToUserMessageByIdPi(
				messages,
				replayMessageIdByIndex,
				decision.messageId,
				decision.text,
			);
		}
	}
	logTransformTiming(sessionId, "stickyReplayDecisions", tStickyReplay);

	// Path 2: fresh delivery. Use the latest user message id (or null if
	// no user messages yet) as the trigger-message hint to peekNoteNudgeText.
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
	const noteReadStillVisible = hasVisibleNoteReadCallPi(messages);
	const deferredNoteText = peekNoteNudgeText(
		db,
		sessionId,
		latestUserId,
		projectIdentity,
		noteReadStillVisible,
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
			pruneAutoSearchHintDecisions(db, sessionId, visibleIds);
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
	pendingMaterializationSessions.delete(sessionId);
	deferredMaterializationSessions.delete(sessionId);
	clearPiChannel1State(sessionId);
}

/**
 * Per-session cleanup. Pi has no `session_deleted` event, but it does
 * fire `session_before_switch` when the user switches to a different
 * session within the same Pi process, and `session_shutdown` when the
 * process exits. Both are valid moments to drain caches keyed by the
 * outgoing session id so we don't leak unbounded memory across many
 * session switches in a long-lived Pi process.
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
// `session_shutdown` and `session_before_switch`, NEITHER of which means the
// session was deleted — the session still exists on disk and may be resumed.
// Pi has no `session_deleted` event (OpenCode's event-handler is the only place
// the durable DB clearSession fires). Calling DB clearSession here would DESTROY
// live durable state (compartments, tags, memories) for a session the user
// merely switched away from — a data-loss bug far worse than the bounded
// orphan-row cost for sessions that are genuinely abandoned and never resumed.
// Do not add DB clearSession here.
export function clearContextHandlerSession(sessionId: string): void {
	invalidateTrueRawTokenCache({ sessionId, reason: "pi.branch.changed" });
	activeContextHandlerSessions.delete(sessionId);
	clearAutoSearchForPiSession(sessionId);
	lastEmergencyNotificationAtMs.delete(sessionId);
	historyRefreshSessions.delete(sessionId);
	pendingMaterializationSessions.delete(sessionId);
	systemPromptRefreshSessions.delete(sessionId);
	deferredHistoryRefreshSessions.delete(sessionId);
	deferredMaterializationSessions.delete(sessionId);
	firstContextPassSeenBySession.delete(sessionId);
	commitSeenLastPass.delete(sessionId);
	liveModelBySession.delete(sessionId);
	taggedStableMessageIdsBySession.delete(sessionId);
	const tagger = taggersBySession.get(sessionId);
	if (tagger) {
		tagger.cleanup(sessionId);
		taggersBySession.delete(sessionId);
	}
	piMessageTokenCacheBySession.delete(sessionId);
	piTagTextTokenCacheBySession.delete(sessionId);
	piTagToolTokenCacheBySession.delete(sessionId);
	piTextIdentitySourceCacheBySession.delete(sessionId);
	piBranchProjectionBySession.delete(sessionId);
	clearPiInjectionTokenCountCache(sessionId);
	clearPiChannel1State(sessionId);
	lastHeuristicsTurnIdBySession.delete(sessionId);
	lastSeenProjectIdentityBySession.delete(sessionId);
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
