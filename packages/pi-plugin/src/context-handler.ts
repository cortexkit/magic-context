/**
 * Pi `context` event handler — the per-LLM-call transform pipeline.
 *
 * Pi fires `pi.on("context", ...)` immediately before each LLM
 * invocation, with the full `AgentMessage[]` that's about to be sent.
 * The handler can return `{ messages }` to replace the array.
 *
 * Step 4b.2 wires the smallest meaningful pipeline:
 *   1. Wrap the AgentMessage[] in a Transcript via `createPiTranscript`.
 *   2. Tag eligible parts with the shared `Tagger` and inject `§N§ `
 *      prefixes (unless `ctx_reduce_enabled: false`).
 *   3. Apply queued drops from `pending_ops` via the shared
 *      `applyPendingOperations` flow.
 *   4. Apply persistent dropped/truncated states from the `tags` table
 *      via `applyFlushedStatuses` so cross-session drops survive.
 *   5. Return the rebuilt messages so Pi sees the mutations.
 *
 * What's deliberately NOT in 4b.2:
 *
 * - Historian invocation. Compartment trigger logic and historian
 *   subprocess spawn live in 4b.3.
 * - Nudges (rolling, note-nudge, ctx_reduce reminders). 4b.4.
 * - Auto-search hint injection. 4b.4.
 * - Sentinel stripping for cache stability. Pi's transform model is
 *   single-pass-per-LLM-call, so OpenCode-style cache-bust avoidance
 *   doesn't apply. If a Pi provider exposes prompt cache later we'd
 *   add the relevant subset.
 * - Compaction marker injection. OpenCode-only — Pi doesn't have a
 *   compaction-event surface to inject into.
 *
 * Error handling: any thrown error is caught and logged, then the
 * original messages pass through unmodified. Pi's LLM call should
 * never fail because of a transform bug — same fail-open philosophy
 * as the OpenCode `messages-transform` wrapper.
 */

import * as crypto from "node:crypto";
import { getLastCompartmentEndMessage } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	clearSessionTracking,
	scheduleIncrementalIndex,
	scheduleReconciliation,
} from "@magic-context/core/features/magic-context/message-index-async";
import { createScheduler } from "@magic-context/core/features/magic-context/scheduler";
import {
	type ContextDatabase,
	getActiveTagsBySession,
	getHistorianFailureState,
	getTagsByNumbers,
	getTopNBySize,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import {
	clearDeferredExecutePendingIfMatches,
	clearEmergencyRecovery,
	getOverflowState,
	getPersistedStickyTurnReminder,
	peekDeferredExecutePending,
	setDeferredExecutePendingIfAbsent,
	setPersistedStickyTurnReminder,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
	createTagger,
	type Tagger,
} from "@magic-context/core/features/magic-context/tagger";
import {
	applyFlushedStatuses,
	applyPendingOperations,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import {
	applyMidTurnDeferral,
	detectMidTurnBypassReason,
} from "@magic-context/core/hooks/magic-context/boundary-execution";
import { replayCavemanCompression } from "@magic-context/core/hooks/magic-context/caveman-cleanup";
import { checkCompartmentTrigger } from "@magic-context/core/hooks/magic-context/compartment-trigger";
import { resolveExecuteThreshold } from "@magic-context/core/hooks/magic-context/event-resolvers";
import { getVisibleMemoryIds } from "@magic-context/core/hooks/magic-context/inject-compartments";
import {
	clearNoteNudgeState,
	getStickyNoteNudge,
	markNoteNudgeDelivered,
	onNoteTrigger,
	peekNoteNudgeText,
} from "@magic-context/core/hooks/magic-context/note-nudger";
import { createNudger } from "@magic-context/core/hooks/magic-context/nudger";
import {
	getProtectedTailStartOrdinal,
	getRawSessionMessageCount,
	readRawSessionMessages,
	setRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";

import { log, sessionLog } from "@magic-context/core/shared/logger";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	clearAutoSearchForPiSession,
	runAutoSearchHintForPi,
} from "./auto-search-pi";
import { detectRecentCommit } from "./detect-recent-commit";
import {
	applyPiHeuristicCleanup,
	type PiHeuristicCleanupResult,
} from "./heuristic-cleanup-pi";
import {
	injectSessionHistoryIntoPi,
	type PiInjectionResult,
} from "./inject-compartments-pi";
import { hasVisibleNoteReadCallPi } from "./note-visibility-pi";
import { injectPiNudge } from "./nudge-injector";
import {
	clearPiCompressorState,
	isPiCompressorOnCooldown,
	markPiCompressorRun,
	runPiCompressionPassIfNeeded,
} from "./pi-compressor-runner";
import { type PiHistorianDeps, runPiHistorian } from "./pi-historian-runner";
import { isMidTurnPi, readPiSessionMessages } from "./read-session-pi";
import {
	buildMessageIdToMaxTag,
	clearOldReasoningPi,
	piMessageStableId,
	replayClearedReasoningPi,
	replayStrippedInlineThinkingPi,
} from "./reasoning-replay-pi";
import { stripPiDroppedPlaceholderMessages } from "./strip-placeholders-pi";
import { injectPiTemporalMarkers } from "./temporal-awareness-pi";
import { tokenizePiMessages } from "./tokenize-pi-messages";
import { createPiTranscript } from "./transcript-pi";

/** Force-materialization threshold — mirrors OpenCode's FORCE_MATERIALIZE_PERCENTAGE (85%). */
const FORCE_MATERIALIZATION_PERCENTAGE = 85;

/** Emergency-block threshold — mirrors OpenCode's >=95% emergency path. */
const EMERGENCY_BLOCK_PERCENTAGE = 95;
const TOOL_HEAVY_TURN_REMINDER_THRESHOLD = 5;
const TOOL_HEAVY_TURN_REMINDER_TEXT =
	'\n\n<instruction name="ctx_reduce_turn_cleanup">Also drop via `ctx_reduce` things you don\'t need anymore from the last turn before continuing.</instruction>';

/**
 * Default `clear_reasoning_age` when neither the Pi caller nor the user
 * config specifies one. Matches OpenCode's schema default
 * (`packages/plugin/src/config/schema/magic-context.ts:303` → `.default(50)`).
 */
const DEFAULT_CLEAR_REASONING_AGE = 50;

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
const firstContextPassSeenBySession = new Set<string>();
const recentReduceBySession = new Map<string, number>();
const liveModelBySession = new Map<string, string>();
const toolUsageSinceUserTurn = new Map<string, number>();
const latestUserMessageBySession = new Map<string, string>();

function readPiSessionMessageById(
	ctx: ExtensionContext,
	messageId: string,
): ReturnType<typeof readPiSessionMessages>[number] | null {
	return (
		readPiSessionMessages(ctx).find((message) => message.id === messageId) ??
		null
	);
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

export function recordPiLiveModel(sessionId: string, modelKey: string): void {
	liveModelBySession.set(sessionId, modelKey);
}

export function recordPiCtxReduceExecution(sessionId: string): void {
	recentReduceBySession.set(sessionId, Date.now());
}

export function recordPiToolExecution(sessionId: string): void {
	const current = toolUsageSinceUserTurn.get(sessionId) ?? 0;
	toolUsageSinceUserTurn.set(sessionId, current + 1);
}

export function getPiToolUsageSinceUserTurnForTest(
	sessionId: string,
): number | undefined {
	return toolUsageSinceUserTurn.get(sessionId);
}

function onPiNewUserMessage(args: {
	db: ContextDatabase;
	sessionId: string;
}): void {
	const sessionMeta = getOrCreateSessionMeta(args.db, args.sessionId);
	const turnUsage = toolUsageSinceUserTurn.get(args.sessionId);
	const agentAlreadyReduced = recentReduceBySession.has(args.sessionId);
	if (
		!sessionMeta.isSubagent &&
		!agentAlreadyReduced &&
		getPersistedStickyTurnReminder(args.db, args.sessionId) === null &&
		turnUsage !== undefined &&
		turnUsage >= TOOL_HEAVY_TURN_REMINDER_THRESHOLD
	) {
		setPersistedStickyTurnReminder(
			args.db,
			args.sessionId,
			TOOL_HEAVY_TURN_REMINDER_TEXT,
		);
	}
	toolUsageSinceUserTurn.set(args.sessionId, 0);
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
			`pi transform error persistence failed: ${err instanceof Error ? err.message : String(err)}`,
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
			`pi transform error clear failed: ${err instanceof Error ? err.message : String(err)}`,
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
 * with @mariozechner/pi-coding-agent without us re-declaring it.
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
	/** Optional ordered fallback chain. */
	fallbackModels?: readonly string[];
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
	/** Automatic-promotion gate (`memory.auto_promote`). */
	autoPromote?: boolean;
	/** Notify UI/status surfaces after historian/compressor state changes. */
	onStatusChange?: (ctx: ExtensionContext, sessionId: string) => void;
	/**
	 * Execute-threshold percentage used by the trigger logic to compute
	 * pressure-driven trigger points. Mirrors OpenCode's
	 * `execute_threshold_percentage` config; defaults to 65 when omitted.
	 */
	executeThresholdPercentage?:
		| number
		| { default: number; [modelKey: string]: number };
	/**
	 * Trigger budget (tokens) used by the commit-cluster and tail-size
	 * triggers. Mirrors `compartment_token_budget` derived value in
	 * OpenCode; defaults to 8000 when omitted.
	 */
	triggerBudget?: number;
	/** Fraction of executable context reserved for rendered <session-history>. */
	historyBudgetPercentage?: number;
	/** Compressor config loaded from magic-context.jsonc. */
	compressor?: {
		enabled: boolean;
		minCompartmentRatio: number;
		maxMergeDepth: number;
		cooldownMs: number;
		maxCompartmentsPerPass: number;
		graceCompartments: number;
	};
}

/**
 * Optional rolling/iteration nudge config (Step 4b.4). When omitted,
 * Pi runs without any rolling reminder text appended to the LLM input —
 * existing tagging + drop behavior is unchanged. When provided, the
 * shared `createNudger` is used to evaluate band-based reminders after
 * each tagging pass and injects them as a synthetic assistant message
 * via `injectPiNudge`.
 */
export interface PiNudgeOptions {
	/** Number of most-recent tags treated as protected (mirrors OpenCode `protected_tags`). */
	protectedTags: number;
	/** Base interval between rolling reminders, in tokens (mirrors OpenCode `nudge_interval_tokens`). */
	nudgeIntervalTokens: number;
	/** Tool-iteration threshold — N+ tool calls without user input fires the iteration nudge. */
	iterationNudgeThreshold: number;
	/** Same execute threshold the historian trigger uses (default 65). */
	executeThresholdPercentage:
		| number
		| { default: number; [modelKey: string]: number };
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
	memoryEnabled: boolean;
	embeddingEnabled: boolean;
	gitCommitsEnabled: boolean;
}

/** Heuristic-cleanup config — drops aged tools, dedups, strips system injections. */
export interface PiHeuristicsOptions {
	autoDropToolAge: number;
	dropToolStructure: boolean;
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
	injectionBudgetTokens: number;
	temporalAwareness?: boolean;
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
	/**
	 * Whether the agent-facing `ctx_reduce` tool is exposed. When false,
	 * tag prefixes are still assigned in the DB (so drops still work
	 * via /ctx-flush or future automatic triggers) but the visible
	 * `§N§ ` markers are NOT injected — agents shouldn't see markers
	 * they can't act on. Mirrors OpenCode behavior.
	 */
	ctxReduceEnabled: boolean;
	/**
	 * Heuristic-cleanup config (auto_drop_tool_age, drop_tool_structure,
	 * caveman). When omitted, heuristic cleanup is disabled — tagging
	 * and queued-drop application still run, but the transform won't
	 * proactively shrink context. Use this only for tests; production
	 * always passes this.
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
	/**
	 * Optional historian wiring (Step 4b.3b). When omitted, the trigger
	 * check is skipped — context events still tag + drop normally, and
	 * historian state stays untouched. When provided, the trigger fires
	 * async after each tagging pass.
	 */
	historian?: PiHistorianOptions;
	/**
	 * Optional rolling/iteration nudge wiring (Step 4b.4). When omitted,
	 * no nudges are injected. When provided, evaluated AFTER each tagging
	 * pass and injected via `injectPiNudge`.
	 */
	nudge?: PiNudgeOptions;
	/**
	 * Optional auto-search hint wiring (Step 4b.4). When omitted or
	 * disabled, no hint computation runs. Notes that auto-search shares
	 * the cortexkit DB with OpenCode, so memories ARE cross-harness.
	 */
	autoSearch?: PiAutoSearchHandlerOptions;
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
 * Algorithm — mirrors @mariozechner/pi-coding-agent's
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
	options: PiContextHandlerOptions,
): void {
	const tagger = createTagger();
	const projectIdentity = resolveProjectIdentity(process.cwd());

	// Build a real shared scheduler so cache-busting stages (heuristic
	// cleanup, compartment injection rebuild) only run on execute passes.
	// On defer passes the cache-stable replay path runs and the provider
	// prompt cache stays warm. Mirrors OpenCode's createTransform deps.
	const schedulerConfig = options.scheduler ?? {
		executeThresholdPercentage: 65,
	};
	const scheduler = createScheduler({
		executeThresholdPercentage: schedulerConfig.executeThresholdPercentage,
		executeThresholdTokens: schedulerConfig.executeThresholdTokens,
	});

	// Build the rolling/iteration nudger lazily — it's stateless across
	// invocations apart from the `recentReduceBySession` map and the per-
	// session meta it reads from the DB. Skipped when no `options.nudge` is
	// configured (returns null below at the call site).
	const nudgerFn = options.nudge
		? createNudger({
				protected_tags: options.nudge.protectedTags,
				nudge_interval_tokens: options.nudge.nudgeIntervalTokens,
				iteration_nudge_threshold: options.nudge.iterationNudgeThreshold,
				execute_threshold_percentage: options.nudge.executeThresholdPercentage,
				recentReduceBySession,
			})
		: null;

	pi.on("context", async (event, ctx) => {
		let sessionIdForError: string | undefined;
		try {
			const sessionId = resolveSessionId(ctx);
			if (sessionId === undefined) {
				// No active session — fall through with no mutation.
				log(
					"[magic-context][pi] context event fired with no session id (falling through unmodified)",
				);
				return;
			}
			sessionIdForError = sessionId;

			const rawMessageProvider = {
				readMessages: () => readPiSessionMessages(ctx),
				readMessageById: (messageId: string) =>
					readPiSessionMessageById(ctx, messageId),
			};
			setRawMessageProvider(sessionId, rawMessageProvider);
			scheduleReconciliation(options.db, sessionId, readRawSessionMessages);

			const latestUserId = findLatestUserMessageIdPi(
				event.messages as PiAgentMessage[],
			);
			if (latestUserId) {
				scheduleIncrementalIndex(
					options.db,
					sessionId,
					latestUserId,
					(_sessionId, messageId) => readPiSessionMessageById(ctx, messageId),
				);
				const previousUserId = latestUserMessageBySession.get(sessionId);
				if (previousUserId !== latestUserId) {
					onPiNewUserMessage({ db: options.db, sessionId });
					latestUserMessageBySession.set(sessionId, latestUserId);
				}
			}

			// Lazy-initialize tagger state from DB. Idempotent: re-init
			// during the same session is a no-op because the in-memory
			// counter is already populated. Required because the tag
			// counter persists across plugin restarts via the
			// `session_meta.counter` column.
			tagger.initFromDb(sessionId, options.db);
			const isFirstContextPassForSession =
				!firstContextPassSeenBySession.has(sessionId);
			firstContextPassSeenBySession.add(sessionId);

			// Resolve scheduler decision: execute-vs-defer based on TTL
			// + threshold. Drives whether heuristic cleanup runs on this
			// pass. Read live context usage from Pi (tokens/percent) and
			// the persisted session-meta record (last_response_time,
			// cache_ttl).
			const piUsage = ctx.getContextUsage?.();
			let usagePercentage =
				typeof piUsage?.percent === "number" ? piUsage.percent : 0;
			const usageInputTokens =
				typeof piUsage?.tokens === "number" ? piUsage.tokens : 0;
			let usageContextLimit =
				typeof piUsage?.contextWindow === "number" && piUsage.contextWindow > 0
					? piUsage.contextWindow
					: undefined;

			// Overflow recovery: a previous LLM call ended with a
			// provider context-overflow error AND the pi.on("message_end")
			// handler persisted needs_emergency_recovery=1. On THIS pass:
			//
			//   1. Bump effective percentage to 95% so the existing
			//      emergency path (await historian + drop-all-tools)
			//      fires regardless of pressure math.
			//   2. If the error reported a real context limit, prefer
			//      that limit over Pi's reported contextWindow (which
			//      was clearly wrong if we just overflowed).
			//
			// Mirrors OpenCode's transform.ts:401 wiring exactly. The
			// recovery flag is cleared by the historian publication
			// path on success (see signalPiHistoryRefresh), so we won't
			// keep bumping forever.
			try {
				const overflowState = getOverflowState(options.db, sessionId);
				if (overflowState.detectedContextLimit > 0) {
					// Always prefer detected limit over reported window
					// when one exists — the reported window came from
					// metadata that produced a wrong answer last time.
					usageContextLimit = Math.min(
						usageContextLimit ?? overflowState.detectedContextLimit,
						overflowState.detectedContextLimit,
					);
				}
				if (overflowState.needsEmergencyRecovery && usagePercentage < 95) {
					sessionLog(
						sessionId,
						`pi transform: overflow recovery flag set — bumping percentage from ${usagePercentage.toFixed(1)}% to 95% (detectedLimit=${overflowState.detectedContextLimit || "unknown"})`,
					);
					usagePercentage = 95;
				}
			} catch (err) {
				sessionLog(
					sessionId,
					`pi transform: overflow state read failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			const sessionMeta = getOrCreateSessionMeta(options.db, sessionId);
			const modelKey = liveModelBySession.get(sessionId);
			let schedulerDecision: "execute" | "defer";
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
					`pi scheduler failed (defaulting to defer): ${err instanceof Error ? err.message : String(err)}`,
				);
				schedulerDecision = "defer";
			}

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
			const piMessageCount = Array.isArray(event.messages)
				? event.messages.length
				: 0;
			const looksLikeImportedSession =
				schedulerDecision === "defer" &&
				usagePercentage === 0 &&
				sessionMeta.lastResponseTime === 0 &&
				piMessageCount >= 50;
			if (looksLikeImportedSession) {
				schedulerDecision = "execute";
				sessionLog(
					sessionId,
					`pi transform: large imported session detected (${piMessageCount} messages, no usage baseline) — forcing execute on first pass`,
				);
			}

			const schedulerDecisionEarly = schedulerDecision;
			const midTurn = isMidTurnPi(event, sessionId);
			const bypassReason = detectMidTurnBypassReason({
				contextUsage: { percentage: usagePercentage },
				sessionMeta,
				historyRefreshSessions,
				sessionId,
			});

			const { midTurnAdjustedSchedulerDecision, sideEffect } =
				applyMidTurnDeferral({
					base: schedulerDecisionEarly,
					bypassReason,
					midTurn,
				});

			if (sideEffect === "set-flag") {
				const flagPayload = {
					id: crypto.randomUUID(),
					reason: `${schedulerDecisionEarly}-${bypassReason}`,
					recordedAt: Date.now(),
				};
				setDeferredExecutePendingIfAbsent(options.db, sessionId, flagPayload);
			}

			schedulerDecision = midTurnAdjustedSchedulerDecision;
			sessionLog(
				sessionId,
				`pi [boundary-exec] base=${schedulerDecisionEarly} bypass=${bypassReason} midTurn=${midTurn} effective=${midTurnAdjustedSchedulerDecision} sideEffect=${sideEffect}`,
			);

			// Force-materialization @ 85%+: aggressive drop-all-tools mode.
			// Mirrors OpenCode transform-postprocess-phase.ts:145-146.
			const forceMaterialization =
				usagePercentage >= FORCE_MATERIALIZATION_PERCENTAGE;

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
			//     still active via the 85%+ branch).
			const isEmergency = usagePercentage >= EMERGENCY_BLOCK_PERCENTAGE;
			if (isEmergency) {
				const lastNotifiedAt =
					lastEmergencyNotificationAtMs.get(sessionId) ?? 0;
				const now = Date.now();
				if (now - lastNotifiedAt >= EMERGENCY_NOTIFICATION_COOLDOWN_MS) {
					lastEmergencyNotificationAtMs.set(sessionId, now);
					sessionLog(
						sessionId,
						`pi EMERGENCY: usage=${usagePercentage.toFixed(1)}% — awaiting in-flight historian + applying drop-all-tools`,
					);
				}

				// Wait for in-flight historian (if any) so its drops can
				// be applied on this pass. Bounded so a hung historian
				// doesn't stall the user's turn.
				const histPromise = inFlightHistorian.get(sessionId);
				if (histPromise) {
					try {
						await Promise.race([
							histPromise,
							new Promise((resolve) => setTimeout(resolve, 30_000)),
						]);
						sessionLog(
							sessionId,
							"pi EMERGENCY: historian wait completed (or timed out)",
						);
					} catch {
						// Historian already logged its own failure; just continue.
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

			sessionLog(
				sessionId,
				`pi transform: usage=${usagePercentage.toFixed(1)}% (${usageInputTokens} tokens, limit=${usageContextLimit ?? "?"}) decision=${schedulerDecision}${forceMaterialization ? " force=true" : ""}${isEmergency ? " EMERGENCY=true" : ""}${isCacheBusting ? " busting=true" : ""}`,
			);

			// Resolve SessionEntry IDs for each AgentMessage in event.messages
			// so the boundary lookup in `<session-history>` injection uses
			// the same id format historian persists. Pi's
			// `buildSessionContext` walks `getBranch()` and emits
			// `entry.message` for `type === "message"` entries — so the
			// AgentMessage[] order maps 1:1 to those entry ids.
			const entryIds = collectMessageEntryIds(
				ctx,
				event.messages.length,
				sessionId,
			);

			const result = await runPipeline({
				db: options.db,
				tagger,
				sessionId,
				projectIdentity,
				messages: event.messages,
				ctxReduceEnabled: options.ctxReduceEnabled,
				protectedTags: options.protectedTags ?? 20,
				heuristics: options.heuristics,
				injection: options.injection,
				entryIds,
				schedulerDecision,
				// 95% emergency forces drop-all-tools regardless of the
				// 85% gate, so the LLM call sees the smallest possible
				// prompt before we hand control back to Pi.
				forceMaterialization: forceMaterialization || isEmergency,
				isCacheBusting,
				reasoningClearing: {
					clearReasoningAge:
						options.heuristics?.clearReasoningAge ??
						DEFAULT_CLEAR_REASONING_AGE,
				},
				temporalAwareness: options.injection?.temporalAwareness === true,
			});

			// After tagging+drops have committed, check whether historian
			// should fire. Historian config is optional — tagging-only
			// behavior is the Step 4b.2 contract, and historian is
			// fire-and-forget so we never block the LLM call on it.
			if (options.historian) {
				maybeFireHistorian({
					ctx,
					sessionId,
					db: options.db,
					historian: options.historian,
					isFirstContextPassForSession,
				});
				maybeFireCompressor({
					ctx,
					sessionId,
					db: options.db,
					historian: options.historian,
					isCacheBusting,
					usagePercentage,
					usageInputTokens,
					usageContextLimit,
				});
			}

			// Step 4b.4: nudge + note-nudge + auto-search hint. All three
			// run AFTER tagging/drops finish so they see the post-mutation
			// message shape. Each is independently optional and fail-open —
			// any thrown error is logged and the pipeline returns the
			// already-mutated messages unchanged.
			let outputMessages = result.messages as PiAgentMessage[];

			if (nudgerFn && options.nudge) {
				try {
					outputMessages = applyRollingNudge({
						sessionId,
						db: options.db,
						messages: outputMessages,
						ctx,
						nudgerFn,
					});
				} catch (err) {
					sessionLog(
						sessionId,
						`pi rolling nudge failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			try {
				outputMessages = applyNoteNudges({
					sessionId,
					db: options.db,
					messages: outputMessages,
					projectIdentity,
				});
			} catch (err) {
				sessionLog(
					sessionId,
					`pi note nudges failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			if (options.autoSearch?.enabled) {
				try {
					outputMessages = await runAutoSearchHintForPi({
						sessionId,
						db: options.db,
						messages: outputMessages,
						options: {
							enabled: true,
							scoreThreshold: options.autoSearch.scoreThreshold,
							minPromptChars: options.autoSearch.minPromptChars,
							projectPath: projectIdentity,
							memoryEnabled: options.autoSearch.memoryEnabled,
							embeddingEnabled: options.autoSearch.embeddingEnabled,
							gitCommitsEnabled: options.autoSearch.gitCommitsEnabled,
							visibleMemoryIds:
								getVisibleMemoryIds(options.db, sessionId) ?? null,
						},
					});
				} catch (err) {
					sessionLog(
						sessionId,
						`pi auto-search failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			// Cast the rebuilt array back to the AgentMessage[] shape Pi's
			// ContextEventResult expects. The nudge/note/auto-search paths
			// preserve message identity for unchanged messages and only
			// rebuild the mutated ones, so this cast is safe at runtime.
			clearLastTransformErrorIfSet(options.db, sessionId);
			return { messages: outputMessages } as {
				messages: typeof event.messages;
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? err.stack : undefined;
			log(
				`[magic-context][pi] context handler failed (continuing without mutation): ${message}`,
				stack,
			);
			if (sessionIdForError) {
				persistLastTransformErrorIfChanged(
					options.db,
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
const inFlightCompressor = new Map<string, Promise<unknown>>();

/**
 * Wait for all in-flight historian runs to complete. Called from the
 * Pi `session_shutdown` event handler so historian can finish writing
 * compartments before the process exits. Returns immediately if no
 * runs are in-flight.
 */
export async function awaitInFlightHistorians(): Promise<void> {
	if (inFlightHistorian.size === 0 && inFlightCompressor.size === 0) return;
	const promises = [
		...Array.from(inFlightHistorian.values()),
		...Array.from(inFlightCompressor.values()),
	];
	await Promise.allSettled(promises);
}

function resolveHistoryBudgetTokensForPi(args: {
	historyBudgetPercentage: number | undefined;
	usagePercentage: number;
	usageInputTokens: number;
	usageContextLimit: number | undefined;
	executeThresholdPercentage: PiHistorianOptions["executeThresholdPercentage"];
	modelKey: string | undefined;
}): number | undefined {
	const {
		historyBudgetPercentage,
		usagePercentage,
		usageInputTokens,
		usageContextLimit,
		executeThresholdPercentage,
		modelKey,
	} = args;
	if (!historyBudgetPercentage || usagePercentage <= 0) return undefined;
	const derivedLimit =
		usageContextLimit && usageContextLimit > 0
			? usageContextLimit
			: usageInputTokens > 0
				? usageInputTokens / (usagePercentage / 100)
				: 0;
	if (!Number.isFinite(derivedLimit) || derivedLimit <= 0) return undefined;
	return Math.floor(
		derivedLimit *
			(resolveExecuteThreshold(executeThresholdPercentage ?? 65, modelKey, 65, {
				contextLimit: derivedLimit,
			}) /
				100) *
			historyBudgetPercentage,
	);
}

function maybeFireCompressor(args: {
	ctx: ExtensionContext;
	sessionId: string;
	db: ContextDatabase;
	historian: PiHistorianOptions;
	isCacheBusting: boolean;
	usagePercentage: number;
	usageInputTokens: number;
	usageContextLimit: number | undefined;
}): void {
	const { ctx, sessionId, db, historian } = args;
	const compressor = historian.compressor;
	if (!compressor?.enabled) return;
	if (!args.isCacheBusting) return;
	if (inFlightHistorian.has(sessionId) || inFlightCompressor.has(sessionId)) {
		sessionLog(
			sessionId,
			"pi-compressor trigger eval: in-flight historian/compressor, skipping",
		);
		return;
	}
	if (isPiCompressorOnCooldown(sessionId, compressor.cooldownMs)) {
		sessionLog(
			sessionId,
			"pi-compressor trigger eval: cooldown active, skipping",
		);
		return;
	}

	const historyBudgetTokens = resolveHistoryBudgetTokensForPi({
		historyBudgetPercentage: historian.historyBudgetPercentage,
		usagePercentage: args.usagePercentage,
		usageInputTokens: args.usageInputTokens,
		usageContextLimit: args.usageContextLimit,
		executeThresholdPercentage: historian.executeThresholdPercentage,
		modelKey: liveModelBySession.get(sessionId),
	});
	if (!historyBudgetTokens || historyBudgetTokens <= 0) return;

	markPiCompressorRun(sessionId);
	const runPromise = runPiCompressionPassIfNeeded({
		db,
		sessionId,
		directory: ctx.cwd,
		runner: historian.runner,
		historianModel: historian.model,
		fallbackModels: historian.fallbackModels,
		historyBudgetTokens,
		historianTimeoutMs: historian.timeoutMs,
		thinkingLevel: historian.thinkingLevel,
		minCompartmentRatio: compressor.minCompartmentRatio,
		maxMergeDepth: compressor.maxMergeDepth,
		maxCompartmentsPerPass: compressor.maxCompartmentsPerPass,
		graceCompartments: compressor.graceCompartments,
		onPublished: () => {
			// Compressor publication invalidates the injection cache AND
			// queues drops for the merged compartments. Mirrors OpenCode's
			// onInjectionCacheCleared callback in transform.ts:502-505:
			//   - signalPiHistoryRefresh: triggers ONE rebuild on the next
			//     transform pass (drained immediately after rebuild).
			//   - signalPiPendingMaterialization: queues the drops the
			//     compressor published; persists until the next pipeline
			//     pass actually materializes them. Without this signal,
			//     drops sit in pending_ops and context climbs until the
			//     85% force-materialization threshold — exactly the
			//     "context kept going up after historian/compressor ran"
			//     symptom users observed in Pi.
			//
			// We deliberately do NOT signal systemPromptRefresh — historian
			// /compressor don't change disk-backed adjuncts (docs/profile/
			// key-files), so re-reading them would burn IO for nothing.
			signalPiHistoryRefresh(sessionId);
			signalPiPendingMaterialization(sessionId);
			historian.onStatusChange?.(ctx, sessionId);
		},
	})
		.catch((err) => {
			sessionLog(
				sessionId,
				`pi-compressor failed in background: ${err instanceof Error ? err.message : String(err)}`,
			);
		})
		.finally(() => {
			inFlightCompressor.delete(sessionId);
			historian.onStatusChange?.(ctx, sessionId);
		});
	inFlightCompressor.set(sessionId, runPromise);
}

function hasEligiblePiCompartmentHistory(
	db: ContextDatabase,
	sessionId: string,
): boolean {
	try {
		const lastCompartmentEnd = getLastCompartmentEndMessage(db, sessionId);
		const nextStartOrdinal = Math.max(1, lastCompartmentEnd + 1);
		const rawMessageCount = getRawSessionMessageCount(sessionId);
		const protectedTailStart = getProtectedTailStartOrdinal(sessionId);
		return (
			rawMessageCount >= nextStartOrdinal &&
			nextStartOrdinal < protectedTailStart
		);
	} catch (err) {
		sessionLog(
			sessionId,
			`pi-historian recovery eligibility failed: ${err instanceof Error ? err.message : String(err)}`,
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
			void uiNotify.call(ctx.ui, message);
			return;
		} catch {
			// Fall through to session log below.
		}
	}
	sessionLog("pi", message);
}

function spawnPiHistorianRun(args: {
	ctx: ExtensionContext;
	sessionId: string;
	db: ContextDatabase;
	historian: PiHistorianOptions;
	provider: { readMessages: () => ReturnType<typeof readPiSessionMessages> };
	unregister: () => void;
}): void {
	const { ctx, sessionId, db, historian, provider, unregister } = args;
	const runPromise = runPiHistorian({
		db,
		sessionId,
		directory: ctx.cwd,
		provider,
		appendCompaction: resolvePiAppendCompaction(ctx),
		readBranchEntries: resolvePiReadBranchEntries(ctx),
		runner: historian.runner,
		historianModel: historian.model,
		fallbackModels: historian.fallbackModels,
		historianChunkTokens: historian.historianChunkTokens,
		historianTimeoutMs: historian.timeoutMs,
		twoPass: historian.twoPass,
		thinkingLevel: historian.thinkingLevel,
		memoryEnabled: historian.memoryEnabled,
		autoPromote: historian.autoPromote,
		onPublished: () => {
			try {
				clearEmergencyRecovery(db, sessionId);
			} catch (err) {
				sessionLog(
					sessionId,
					`pi historian: clearEmergencyRecovery failed: ${err instanceof Error ? err.message : String(err)}`,
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
			//     85% force-materialization threshold — exactly the
			//     "context kept going up after historian ran" symptom
			//     users observed at 64% → 69%+ on Pi.
			//
			// We deliberately do NOT signal systemPromptRefresh — historian
			// doesn't change disk-backed adjuncts (docs/profile/key-files),
			// so re-reading them would burn IO for nothing.
			signalPiHistoryRefresh(sessionId);
			signalPiPendingMaterialization(sessionId);
			historian.onStatusChange?.(ctx, sessionId);
		},
	}).finally(() => {
		inFlightHistorian.delete(sessionId);
		unregister();
		historian.onStatusChange?.(ctx, sessionId);
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
		try {
			const entries = sm.getBranch?.call(sm);
			return Array.isArray(entries) ? entries : [];
		} catch {
			return [];
		}
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
	ctx: ExtensionContext;
	sessionId: string;
	db: ContextDatabase;
	historian: PiHistorianOptions;
	isFirstContextPassForSession?: boolean;
}): void {
	const { ctx, sessionId, db, historian, isFirstContextPassForSession } = args;

	if (inFlightHistorian.has(sessionId)) {
		sessionLog(sessionId, "pi-historian trigger eval: in-flight, skipping");
		return;
	}

	// Pi exposes ctx.getContextUsage() returning { tokens, contextWindow,
	// percent }. We map to OpenCode's ContextUsage shape ({ percentage,
	// inputTokens }) used by the shared trigger.
	let usage: { percentage: number; inputTokens: number };
	try {
		const piUsage = ctx.getContextUsage?.();
		if (
			!piUsage ||
			piUsage.tokens === null ||
			piUsage.percent === null ||
			piUsage.contextWindow === 0
		) {
			sessionLog(
				sessionId,
				`pi-historian trigger eval: no usage info yet (tokens=${piUsage?.tokens ?? "<no piUsage>"}, percent=${piUsage?.percent ?? "<no piUsage>"}, contextWindow=${piUsage?.contextWindow ?? "<no piUsage>"})`,
			);
			return;
		}
		usage = {
			percentage: piUsage.percent,
			inputTokens: piUsage.tokens,
		};
		sessionLog(
			sessionId,
			`pi-historian trigger eval: usage=${usage.percentage.toFixed(1)}% (${usage.inputTokens} tokens), checking trigger...`,
		);
	} catch (err) {
		sessionLog(
			sessionId,
			`pi-historian trigger eval: getContextUsage threw: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	// Register the Pi RawMessageProvider for this sessionId so the
	// shared trigger logic + historian can read Pi session messages
	// via the standard `readRawSessionMessages` etc. helpers. The
	// provider stays registered while the historian runs and
	// unregisters in finally.
	const provider = {
		readMessages: () => readPiSessionMessages(ctx),
	};
	const unregister = setRawMessageProvider(sessionId, provider);

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
					"pi-historian: cleared stale compartmentInProgress flag on first context pass after restart",
				);
			}

			const failureState = getHistorianFailureState(db, sessionId);
			const shouldRecoverOnFirstPass =
				failureState.failureCount > 0 &&
				hasEligiblePiCompartmentHistory(db, sessionId);
			if (shouldRecoverOnFirstPass) {
				triggered = true;
				sessionLog(
					sessionId,
					`pi-historian recovery triggered on session load after ${failureState.failureCount} failure(s)`,
				);
				sendPiIgnoredNotification(
					ctx,
					`## Historian recovery\n\nHistorian previously failed ${failureState.failureCount} time(s), so magic-context is retrying compaction immediately after restart.`,
				);
				spawnPiHistorianRun({
					ctx,
					sessionId,
					db,
					historian,
					provider,
					unregister,
				});
				return;
			}
		}

		const sessionMeta = getOrCreateSessionMeta(db, sessionId);
		const trigger = checkCompartmentTrigger(
			db,
			sessionId,
			sessionMeta,
			usage,
			0, // _previousPercentage — unused by current trigger logic
			resolveExecuteThreshold(
				historian.executeThresholdPercentage ?? 65,
				liveModelBySession.get(sessionId),
				65,
			),
			historian.triggerBudget ?? 8000,
		);

		if (!trigger.shouldFire) {
			sessionLog(
				sessionId,
				`pi-historian trigger eval: shouldFire=false (no trigger condition met)`,
			);
			return;
		}

		triggered = true;
		sessionLog(
			sessionId,
			`pi-historian trigger fired (reason=${trigger.reason ?? "unknown"}) usage=${usage.percentage.toFixed(1)}% — spawning subagent`,
		);

		// Fire-and-forget for the user's LLM call: the parent agent
		// turn never awaits this. But we DO track the Promise in
		// inFlightHistorian so `awaitInFlightHistorians()` can wait
		// at session_shutdown — without that, `pi --print` mode would
		// kill the historian subprocess mid-run when the parent exits.
		spawnPiHistorianRun({
			ctx,
			sessionId,
			db,
			historian,
			provider,
			unregister,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		sessionLog(sessionId, `pi-historian trigger eval failed: ${message}`);
		if (!triggered) unregister();
	}
}
interface RunPipelineArgs {
	db: ContextDatabase;
	tagger: Tagger;
	sessionId: string;
	projectIdentity: string;
	messages: Parameters<typeof createPiTranscript>[0];
	ctxReduceEnabled: boolean;
	protectedTags: number;
	/** Heuristic-cleanup config — when omitted, defaults to OpenCode parity values. */
	heuristics?: {
		autoDropToolAge: number;
		dropToolStructure: boolean;
		caveman?: { enabled: boolean; minChars: number };
	};
	/** Memory-injection config — when omitted, no <session-history> injection runs. */
	injection?: {
		injectionBudgetTokens: number;
		temporalAwareness?: boolean;
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
	 * Pre-resolved scheduler decision for THIS pass. When `"execute"`,
	 * heuristic cleanup runs (cache-busting). When `"defer"`, only the
	 * cache-stable stages run (tagging + applyFlushedStatuses + replay
	 * cached injection). Mirrors OpenCode's `schedulerDecisionEarly`.
	 */
	schedulerDecision: "execute" | "defer";
	/**
	 * Force-materialization signal: when true, drop-all-tools mode
	 * activates (mirrors OpenCode's >=85% emergency cleanup). Caller
	 * computes from current usage percentage.
	 */
	forceMaterialization?: boolean;
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
	/**
	 * Whether to inject temporal `<!-- +Xm -->` markers into user
	 * messages with large gaps. Mirrors OpenCode's
	 * `experimental.temporal_awareness`. Idempotent across passes.
	 */
	temporalAwareness?: boolean;
}

interface RunPipelineResult {
	messages: unknown[];
	/** Whether heuristic cleanup actually ran on this pass. */
	heuristicsExecuted: boolean;
	/** Whether <session-history> was written into message[0]. */
	historyInjected: boolean;
	/** Aggregate counts for log parity with OpenCode. */
	heuristicsResult: PiHeuristicCleanupResult | null;
	injectionResult: PiInjectionResult | null;
}

async function runPipeline(args: RunPipelineArgs): Promise<RunPipelineResult> {
	let executedWorkThisPass = false;

	// 0. Inject temporal `<!-- +Xm -->` markers into user messages
	// BEFORE tagging so the §N§ tag prefix wraps around our marker on
	// re-tagging. Idempotent: existing markers are detected by regex
	// and skipped. Same invariants as OpenCode's `injectTemporalMarkers`
	// at transform.ts:648 — runs on every pass, deterministic from
	// timestamps, retroactive when the flag flips.
	if (args.temporalAwareness) {
		try {
			const injected = injectPiTemporalMarkers(args.messages);
			if (injected > 0) {
				sessionLog(
					args.sessionId,
					`pi temporal-awareness: injected ${injected} gap markers`,
				);
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`pi temporal-awareness failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	const transcript = createPiTranscript(args.messages, args.sessionId);

	// 1. Tagging: assigns tag numbers + injects §N§ prefixes (unless
	// ctx_reduce_enabled is false, in which case prefixes are skipped
	// but DB-side tag IDs still get created so drops continue to work).
	const { targets } = tagTranscript(
		args.sessionId,
		transcript,
		args.tagger,
		args.db,
		{
			skipPrefixInjection: !args.ctxReduceEnabled,
		},
	);

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
		const sessionMeta = getOrCreateSessionMeta(args.db, args.sessionId);
		if (!sessionMeta.isSubagent) {
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
			`pi commit-detect failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
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
	//
	// PEEK-then-drain-on-success pattern (Oracle audit Round 8 #6):
	// the signal is only deleted AFTER applyPendingOperations succeeds.
	// If the call throws, the flag survives so the next pass retries.
	//
	// Drops in the protected window are deferred (re-queued) so the
	// agent's recent working context stays intact.
	const hasPendingMaterializeSignal = hasPendingMaterialization(args.sessionId);
	if (
		args.schedulerDecision === "execute" ||
		args.forceMaterialization ||
		hasPendingMaterializeSignal
	) {
		try {
			applyPendingOperations(
				args.sessionId,
				args.db,
				targets,
				args.protectedTags,
			);
			executedWorkThisPass = true;
			// Drain only after success — if applyPendingOperations throws
			// the flag stays set so the next pass retries.
			if (hasPendingMaterializeSignal) {
				consumePendingMaterialization(args.sessionId);
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`pi pending operations failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			throw err;
		}
	}

	// 3. Apply persistent dropped/truncated tag statuses so cross-pass
	// drops survive. Always runs, regardless of scheduler decision —
	// this is the cache-stable replay of mutations persisted on prior
	// execute passes. Mirrors OpenCode's `applyFlushedStatuses` call
	// at transform.ts:728.
	//
	// P0 perf: applyFlushedStatuses only ever mutates tags whose
	// tag_number is in `targets`, so feed it just that slice instead
	// of the whole session (~50k rows on long sessions). Without this
	// pre-load it lazy-loads via getTagsBySession internally — exactly
	// the full-table scan we eliminated in OpenCode's transform.
	const flushedSliceTags = getTagsByNumbers(args.db, args.sessionId, [
		...targets.keys(),
	]);
	applyFlushedStatuses(args.sessionId, args.db, targets, flushedSliceTags);

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
			const clearedReplay = replayClearedReasoningPi({
				db: args.db,
				sessionId: args.sessionId,
				messages: args.messages,
				messageIdToMaxTag,
				piMessageStableId,
			});
			const inlineReplay = replayStrippedInlineThinkingPi({
				db: args.db,
				sessionId: args.sessionId,
				messages: args.messages,
				messageIdToMaxTag,
				piMessageStableId,
			});
			if (clearedReplay > 0 || inlineReplay > 0) {
				sessionLog(
					args.sessionId,
					`pi reasoning replay: cleared=${clearedReplay} inline=${inlineReplay}`,
				);
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`pi reasoning replay failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
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
	try {
		// P0 perf: caveman replay only acts on tags whose tag_number is in
		// `targets`, so fetch just that slice instead of the whole session
		// (~50k rows on long sessions).
		const targetTagNumbers = [...targets.keys()];
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
				`pi caveman replay: ${replayed} tags re-compressed from source`,
			);
		}
	} catch (err) {
		sessionLog(
			args.sessionId,
			`pi caveman replay failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
		);
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
	// - stripProcessedImages: replaces large base64 image payloads in
	//   user `file` parts with sentinels after the assistant has
	//   processed them. Pi's image part shape is different (kind:
	//   "image" with a URL) and large base64 images are rare in Pi
	//   sessions — the equivalent path here would only fire for the
	//   pasted-screenshot case, which we don't currently optimize.
	//   Can be added later with a Pi-specific image-content stripper.

	// 4. Heuristic cleanup — drops aged tools, dedups, strips system
	// injections, age-tier caveman compression. Gated on scheduler
	// decision because mutations bust provider cache; persisted to DB
	// so subsequent defer passes replay via applyFlushedStatuses.
	// Mirrors OpenCode's `applyHeuristicCleanup` call in
	// transform-postprocess-phase.ts.
	let heuristicsExecuted = false;
	let heuristicsResult: PiHeuristicCleanupResult | null = null;
	const shouldRunHeuristics =
		args.heuristics !== undefined &&
		(args.schedulerDecision === "execute" ||
			args.forceMaterialization === true);
	if (shouldRunHeuristics && args.heuristics) {
		try {
			heuristicsResult = applyPiHeuristicCleanup(
				args.sessionId,
				args.db,
				targets,
				args.messages,
				{
					autoDropToolAge: args.heuristics.autoDropToolAge,
					dropToolStructure: args.heuristics.dropToolStructure,
					protectedTags: args.protectedTags,
					dropAllTools: args.forceMaterialization === true,
					caveman: args.heuristics.caveman,
				},
			);
			heuristicsExecuted = true;
			executedWorkThisPass = true;
		} catch (err) {
			sessionLog(
				args.sessionId,
				`pi heuristic cleanup failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
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
	if (
		args.reasoningClearing &&
		(args.schedulerDecision === "execute" || args.forceMaterialization === true)
	) {
		try {
			const clearOutcome = clearOldReasoningPi({
				messages: args.messages,
				messageIdToMaxTag,
				clearReasoningAge: args.reasoningClearing.clearReasoningAge,
				piMessageStableId,
			});
			if (clearOutcome.cleared > 0 && clearOutcome.newWatermark > 0) {
				const meta = getOrCreateSessionMeta(args.db, args.sessionId);
				const prevWatermark = meta.clearedReasoningThroughTag ?? 0;
				if (clearOutcome.newWatermark > prevWatermark) {
					updateSessionMeta(args.db, args.sessionId, {
						clearedReasoningThroughTag: clearOutcome.newWatermark,
					});
					sessionLog(
						args.sessionId,
						`pi reasoning cleared on execute: cleared=${clearOutcome.cleared} watermark=${prevWatermark}->${clearOutcome.newWatermark}`,
					);
				}
			}
			executedWorkThisPass = true;
		} catch (err) {
			sessionLog(
				args.sessionId,
				`pi reasoning clearing failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// 5. Commit tagging mutations back to Pi messages BEFORE injecting
	// the history block. Otherwise the injection write target is the
	// pre-tagged content. Pi's transcript adapter writes mutations
	// back to the underlying AgentMessage[] via the part proxies, so
	// commit() just locks the result in.
	transcript.commit();

	// 6. <session-history> injection — writes compartments, facts, and
	// project memories into message[0]. This is the second-biggest
	// reduction lever after heuristic cleanup: a session that's been
	// summarized has its bulk history replaced by a compact compartment
	// block. Mirrors OpenCode's prepareCompartmentInjection +
	// renderCompartmentInjection pair (transform.ts:587-616 + ~960).
	let injectionResult: PiInjectionResult | null = null;
	if (args.injection) {
		try {
			injectionResult = injectSessionHistoryIntoPi(
				args.db,
				args.sessionId,
				args.messages as Parameters<typeof injectSessionHistoryIntoPi>[2],
				args.isCacheBusting,
				args.projectIdentity,
				args.injection.injectionBudgetTokens,
				args.injection.temporalAwareness,
				args.entryIds,
			);
			// PEEK-then-drain-on-success (Oracle audit Round 8 #6):
			// only drain `historyRefreshSessions` if the rebuild
			// succeeded AND this pass was busting the cache. If
			// injection throws, the flag survives so the next pass
			// retries the rebuild.
			if (args.isCacheBusting) {
				historyRefreshSessions.delete(args.sessionId);
			}
		} catch (err) {
			sessionLog(
				args.sessionId,
				`pi compartment injection failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	stripPiDroppedPlaceholderMessages({
		db: args.db,
		sessionId: args.sessionId,
		messages: args.messages,
		isCacheBusting: args.isCacheBusting,
	});

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
				`pi [boundary-exec] drain failed (continuing): ${err}`,
			);
		}
	}

	const outputMessages = transcript.getOutputMessages();

	// 7. Persist conversation/tool-call token totals for /ctx-status and
	// the dashboard. Walks the post-everything message array (tagged,
	// injected, stripped) so the numbers reflect what the LLM actually
	// receives. Mirrors OpenCode's transform.ts:996-1127. Best-effort —
	// never fail the pipeline on a stats write error.
	try {
		const counts = tokenizePiMessages(outputMessages as unknown[]);
		updateSessionMeta(args.db, args.sessionId, {
			conversationTokens: counts.conversation,
			toolCallTokens: counts.toolCall,
		});
	} catch (err) {
		sessionLog(
			args.sessionId,
			`pi token accounting failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return {
		messages: outputMessages,
		heuristicsExecuted,
		historyInjected: injectionResult?.injected ?? false,
		heuristicsResult,
		injectionResult,
	};
}

// ---------------------------------------------------------------------------
// Nudge / note-nudge helpers
// ---------------------------------------------------------------------------

/**
 * Apply the rolling/iteration nudge after tagging. Mirrors OpenCode's
 * `transform-postprocess-phase.ts` (around lines 568-604) — but for Pi
 * there is no anchored-assistant cache, so we use the simpler
 * insert-before-latest-user strategy from `injectPiNudge`.
 *
 * Pi delivers a fresh `AgentMessage[]` per `context` event, so every
 * pass behaves like an OpenCode "cache-busting" pass: nudges always
 * apply when the nudger says so, and there is no defer-pass replay or
 * anchor retirement to manage.
 */
function applyRollingNudge(args: {
	sessionId: string;
	db: ContextDatabase;
	messages: PiAgentMessage[];
	ctx: ExtensionContext;
	nudgerFn: ReturnType<typeof createNudger>;
}): PiAgentMessage[] {
	const { sessionId, db, messages, ctx, nudgerFn } = args;

	const piUsage = ctx.getContextUsage?.();
	if (
		!piUsage ||
		piUsage.tokens === null ||
		piUsage.percent === null ||
		piUsage.contextWindow === 0
	) {
		// No usage info yet — nudger requires real numbers, so skip.
		return messages;
	}

	const usage = {
		percentage: piUsage.percent,
		inputTokens: piUsage.tokens,
		// Nudger's ContextUsage type carries a contextLimit too; pass it
		// for completeness even though the rolling-nudge math doesn't
		// consume it directly.
		contextLimit: piUsage.contextWindow,
	};

	// P0 perf: nudger filters to status === "active" anyway, so feed it
	// active-only directly. Saves a full-table scan on long sessions.
	const tags = getActiveTagsBySession(db, sessionId);
	const messagesSinceLastUser = countMessagesSinceLastUserPi(messages);

	const nudge = nudgerFn(
		sessionId,
		usage,
		db,
		getTopNBySize,
		tags,
		messagesSinceLastUser,
		// Let the nudger fetch session meta itself — Pi doesn't have the
		// preloaded-meta optimization the OpenCode transform uses.
		undefined,
	);
	if (!nudge) return messages;

	return injectPiNudge(messages, nudge);
}

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
}): PiAgentMessage[] {
	const { sessionId, db, messages, projectIdentity } = args;

	// Path 1: sticky replay first, so any newly-delivered nudge below
	// doesn't get double-attached on the same pass.
	const sticky = getStickyNoteNudge(db, sessionId);
	if (sticky) {
		const reinjected = appendReminderToUserMessageByIdPi(
			messages,
			sticky.messageId,
			sticky.text,
		);
		if (!reinjected) {
			// Anchor message gone — clear stale state. Mirrors OpenCode
			// transform-postprocess-phase.ts:621-630. New nudges only
			// re-appear when a fresh trigger fires.
			clearNoteNudgeState(db, sessionId);
			sessionLog(
				sessionId,
				`pi note-nudge: sticky anchor ${sticky.messageId} gone, cleared`,
			);
		}
	}

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
	const latestUserId = findLatestUserMessageIdPi(messages);
	const noteReadStillVisible = hasVisibleNoteReadCallPi(messages);
	const deferredNoteText = peekNoteNudgeText(
		db,
		sessionId,
		latestUserId,
		projectIdentity,
		noteReadStillVisible,
	);
	if (deferredNoteText) {
		const noteInstruction = `\n\n<instruction name="deferred_notes">${deferredNoteText}</instruction>`;
		const anchoredId = appendReminderToLatestUserMessagePi(
			messages,
			noteInstruction,
		);
		// Always mark delivered once text is generated — the trigger is
		// consumed even if no anchor was found, so future passes don't
		// re-fire on every transform.
		markNoteNudgeDelivered(db, sessionId, noteInstruction, anchoredId);
	}

	return messages;
}

/**
 * Count messages since the latest meaningful user message. "Meaningful"
 * here means a `user` role with non-empty text content. Mirrors
 * `countMessagesSinceLastUser` from
 * `packages/plugin/src/hooks/magic-context/transform-message-helpers.ts`,
 * adapted to the Pi `AgentMessage` shape.
 */
function countMessagesSinceLastUserPi(messages: PiAgentMessage[]): number {
	let count = 0;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role === "user" && hasMeaningfulUserTextPi(msg)) break;
		count += 1;
	}
	return count;
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

/**
 * Find the id of the latest meaningful user message. Pi messages don't
 * carry a stable id field per `AgentMessage`, so we synthesize one from
 * timestamp + index. Same approach as `auto-search-pi.ts`'s
 * `buildUserMessageTurnId` — duplicated locally to keep the modules
 * decoupled (note-nudge anchor and auto-search cache key are independent
 * concerns even though both currently use the same id shape).
 */
function findLatestUserMessageIdPi(messages: PiAgentMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role !== "user" || !hasMeaningfulUserTextPi(msg)) continue;
		const ts = readTimestamp(msg);
		return `pi:${i}:${ts}`;
	}
	return null;
}

/**
 * Append `reminder` to the user message at `messageId` (synthetic id
 * built by `findLatestUserMessageIdPi`). Idempotent: skips if the exact
 * reminder text is already present. Mirrors
 * `appendReminderToUserMessageById` from OpenCode's
 * `transform-message-helpers.ts:54`.
 */
function appendReminderToUserMessageByIdPi(
	messages: PiAgentMessage[],
	messageId: string,
	reminder: string,
): boolean {
	for (let i = 0; i < messages.length; i += 1) {
		const msg = messages[i];
		if (msg?.role !== "user" || !hasMeaningfulUserTextPi(msg)) continue;
		const ts = readTimestamp(msg);
		const synthId = `pi:${i}:${ts}`;
		if (synthId !== messageId) continue;
		appendReminderToPiUserMessage(msg, reminder);
		return true;
	}
	return false;
}

/**
 * Append `reminder` to the latest meaningful user message. Returns the
 * synthetic id for sticky anchor tracking, or null when no user message
 * exists. Mirrors `appendReminderToLatestUserMessage` from
 * `transform-message-helpers.ts:37`.
 */
function appendReminderToLatestUserMessagePi(
	messages: PiAgentMessage[],
	reminder: string,
): string | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role !== "user" || !hasMeaningfulUserTextPi(msg)) continue;
		appendReminderToPiUserMessage(msg, reminder);
		const ts = readTimestamp(msg);
		return `pi:${i}:${ts}`;
	}
	return null;
}

/**
 * Read the optional `timestamp` property from any message role without
 * tripping the structural type checker on roles that don't carry one.
 * Falls back to `"no-ts"` so synthetic ids stay stable across passes.
 */
function readTimestamp(message: PiAgentMessage): string {
	const ts = (message as { timestamp?: unknown }).timestamp;
	return typeof ts === "number" && Number.isFinite(ts) ? String(ts) : "no-ts";
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
 *
 * NOT cleaned (intentional):
 *   - `inFlightHistorian` / `inFlightCompressor` — these promises
 *     own their own cleanup in `.finally()` and a session switch
 *     doesn't cancel a background subagent that's already running.
 *   - `recentReduceBySession` / `pendingNoteNudgeState` — module-
 *     private to other files; they expose their own clear helpers
 *     called from where they live.
 */
export function clearContextHandlerSession(sessionId: string): void {
	clearAutoSearchForPiSession(sessionId);
	lastEmergencyNotificationAtMs.delete(sessionId);
	historyRefreshSessions.delete(sessionId);
	pendingMaterializationSessions.delete(sessionId);
	systemPromptRefreshSessions.delete(sessionId);
	firstContextPassSeenBySession.delete(sessionId);
	commitSeenLastPass.delete(sessionId);
	recentReduceBySession.delete(sessionId);
	liveModelBySession.delete(sessionId);
	toolUsageSinceUserTurn.delete(sessionId);
	latestUserMessageBySession.delete(sessionId);
	clearSessionTracking(sessionId);
	clearPiCompressorState(sessionId);
}
