import * as crypto from "node:crypto";
import {
    type AuthorityModuleClient,
    checksumAuthoritySeedRows,
    drainAuthority,
    ensureContextStoreUuid,
    getAuthorityManagedMarker,
} from "../../features/magic-context/context-authority";
import {
    resolveProjectIdentity,
    resolveProjectIdentityForSession,
    takeDubiousOwnershipProjectIdentityWarning,
} from "../../features/magic-context/memory/project-identity";
import { scheduleReconciliation } from "../../features/magic-context/message-index-async";
import type { Scheduler } from "../../features/magic-context/scheduler";
import { parseCacheTtl } from "../../features/magic-context/scheduler";
import { recordSessionProjectIdentity } from "../../features/magic-context/session-project-storage";
import {
    type ContextDatabase,
    deriveTagLoadFloor,
    getActiveTagsBySession,
    getActiveTagTokenAggregate,
    getActiveTagTokenTotalsByMessage,
    getHistorianFailureState,
    getMaxDroppedTagNumber,
    getOldestActiveUnprotectedToolTags,
    getOrCreateSessionMeta,
    getTagsByNumbers,
    loadPersistedUsage,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    casChannel2NudgeState,
    clearDetectedContextLimit,
    clearEmergencyDropSample,
    clearEmergencyRecovery,
    clearHistorianFailureState,
    clearPersistedReasoningWatermark,
    getOverflowState,
    loadProtectedTailMeta,
    recordOverflowDetected,
    resetLastNudgeCycleIfTailShrank,
    resetProtectedTailNoEligibleHead,
    setDeferredExecutePendingIfAbsent,
} from "../../features/magic-context/storage-meta-persisted";
import { bumpProjectMemoryEpoch } from "../../features/magic-context/storage-project-state";
import type { Tagger } from "../../features/magic-context/tagger";
import {
    clearOpenCodePendingTransformDecision,
    normalizeMaterializeReason,
    recordPendingTransformDecision,
} from "../../features/magic-context/transform-decision-log";
import type { ContextUsage, SchedulerDecision } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { getErrorMessage } from "../../shared/error-message";
import { log, sessionLog } from "../../shared/logger";
import { getSdkContextLimit } from "../../shared/models-dev-cache";
import { applyMidTurnDeferral, detectMidTurnBypassReason } from "./boundary-execution";
import { canConsumeDeferredOnThisPass } from "./cache-busting-signals";
import { replayCavemanCompression } from "./caveman-cleanup";
import {
    commitCompactionModeRecord,
    reconcileCompactionMode,
} from "./compaction-off-transition";
import { getActiveCompartmentRun, startCompartmentAgent } from "./compartment-runner";
import {
    buildTriggerInMemoryTail,
    checkCompartmentTrigger,
    FORCE_MATERIALIZE_PERCENTAGE,
} from "./compartment-trigger";
import {
    type CtxReduceAvailabilityVerdict,
    resolveCtxReduceAvailabilityFromMessages,
    resolveTodowriteAvailabilityFromMessages,
    type ToolAvailabilityVerdict,
} from "./ctx-reduce-availability";
import { computeTailTokenEstimate, shouldTriggerChannel2 } from "./ctx-reduce-nudge";
import { DEFAULT_HISTORY_BUDGET_TOKENS } from "./decay-render";
import { deriveTriggerBudget } from "./derive-budgets";
import { EmergencyFailClosedError } from "./emergency-fail-closed";
import {
    resolveExecuteThreshold,
    resolveModelKey,
    resolveTrustedContextLimit,
} from "./event-resolvers";
import { estimateFinalWireInputTokens, estimateMessageTokens } from "./final-wire-token-estimate";
import type { LiveModelBySession } from "./hook-handlers";
import {
    type PreparedCompartmentInjection,
    prepareCompartmentInjection,
} from "./inject-compartments";
import { captureLkgSlot, projectLkgEntry, resolveLkgModelKeys } from "./lkg-replay";
import { dropSlot } from "./lkg-slot";
import { onNoteTrigger } from "./note-nudger";
import { createPassOutcome } from "./pass-outcome";
import {
    createDefaultBoundarySnapshotForTests,
    hasRunnableCompartmentWindow,
    type ProtectedTailBoundarySnapshot,
    RECOVERY_NO_HEAD_LIMIT,
    recordHighPressureNoEligibleHead,
    resolveOpenCodeProtectedTailBoundary,
} from "./protected-tail-boundary";
import { readRawSessionMessages } from "./read-session-chunk";
import { findLastAssistantModelFromOpenCodeDb, isMidTurn } from "./read-session-db";
import { extractInMemoryMessageViews } from "./read-session-raw";
import { createRustModeTransform, type RustModeModuleClient } from "./rust-mode-transform";
import { sendIgnoredMessage } from "./send-session-notification";
import { modelAcceptsEmptyContent } from "./sentinel";
import {
    replayClearedReasoning,
    replayStrippedInlineThinking,
    stripClearedReasoning,
} from "./strip-content";
import { injectTemporalMarkers } from "./temporal-awareness";
import { runCompartmentPhase } from "./transform-compartment-phase";
import { loadContextUsage, resolveSchedulerDecision } from "./transform-context-state";
import { findLastUserMessageId, findSessionId } from "./transform-message-helpers";
import {
    applyFlushedStatuses,
    type MessageLike,
    stripStructuralNoise,
    type TagNormalizationTarget,
    type TagTarget,
    tagMessages,
} from "./transform-operations";
import {
    abortSessionFailClosed,
    evaluateEmergencyFailClosed,
    runPostTransformPhase,
} from "./transform-postprocess-phase";
import { logTransformTiming } from "./transform-stage-logger";

export { EmergencyFailClosedError } from "./emergency-fail-closed";

// Per-session message token cache. Keyed by message ID, value is the token
// contribution of that message split into conversation (text/reasoning/images)
// and tool call (tool_use/tool_result/tool/tool-invocation) buckets.
//
// Messages are append-only once streaming completes, so the cached value is
// stable across transform passes. Cleared on session.deleted and entries are
// invalidated on message.removed via clearMessageTokensCache().
//
// Bounded LRU on the outer key: sessions that are never explicitly deleted
// (crashed OpenCode, archived but not deleted sessions, sessions outliving
// the plugin process's interest) would otherwise leak their inner Maps
// forever. 100 sessions is generously above any realistic active working
// set — evicted entries are recomputed lazily on the next transform pass.
const MESSAGE_TOKENS_CACHE_MAX = 100;
const messageTokensBySession = new BoundedSessionMap<
    Map<string, { conversation: number; toolCall: number }>
>(MESSAGE_TOKENS_CACHE_MAX);

function getMessageTokensCache(
    sessionId: string,
): Map<string, { conversation: number; toolCall: number }> {
    let cache = messageTokensBySession.get(sessionId);
    if (!cache) {
        cache = new Map();
        messageTokensBySession.set(sessionId, cache);
    }
    return cache;
}

function maybeSendProjectIdentityWarning(
    deps: TransformDeps,
    sessionId: string,
    directory: string,
    notificationParams: import("./send-session-notification").NotificationParams,
): void {
    if (!deps.client) return;
    const warning = takeDubiousOwnershipProjectIdentityWarning(directory);
    if (!warning) return;
    void sendIgnoredMessage(deps.client, sessionId, warning, notificationParams).catch((error) => {
        sessionLog(
            sessionId,
            `project identity warning delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    });
}

export function clearMessageTokensCache(sessionId: string, messageId?: string): void {
    if (messageId === undefined) {
        messageTokensBySession.delete(sessionId);
        return;
    }
    const cache = messageTokensBySession.get(sessionId);
    if (cache) cache.delete(messageId);
}

// Hot-path guard: the session→project ownership binding is immutable per session,
// so the DB upsert+repair only needs to run when the resolved identity first
// appears (or changes) for a session in this process — not on every transform
// pass. Bounded so crashed/abandoned sessions can't leak the guard forever.
const recordedSessionProjectIdentity = new BoundedSessionMap<string>(MESSAGE_TOKENS_CACHE_MAX);

// Tagger / trigger load-scoping floor (OpenCode only). Several hot-path reads
// preload an in-memory map or aggregate over a session's tags; on a large/old
// session that is the full tag history (100K+ rows): the tagger's content-key
// map (~32ms), the boundary's stored-token map (~52ms), the trigger pre-gate's
// upper-bound sum (~37ms). The wire passed to the transform is the
// post-compaction-boundary tail (m[0]/m[1] are prepended LATER, in postprocess),
// and tag_number is monotonic with message order, so the front of the wire holds
// the lowest tags — everything below is compacted-away history not in the wire.
// We derive one floor per pass and scope every such read to `tag_number >= floor`.
//
// `deriveTagLoadFloor` takes the MIN over the first K id-bearing messages, NOT
// the first one's tag: a tagged leading compaction-summary has a RECENTLY-assigned
// (high) tag despite sitting at the front, so the first message's tag could wrongly
// exclude the genuinely-oldest message behind it. A small margin is subtracted —
// a LOWER floor only ever loads MORE (strictly safe; never excludes an in-wire
// tag) and absorbs near-boundary tool-result straddles and minor id reordering.
// Deriving live every pass (not memoized) is ~K×2.8µs and is inherently
// revert-safe: it tracks the actual post-cleanup wire with no stored state to go
// stale. Returns 0 (today's full load) when nothing is tagged yet.
function deriveTaggerLoadFloor(
    messages: MessageLike[],
    sessionId: string,
    db: ContextDatabase,
): number {
    return deriveTagLoadFloor(
        db,
        sessionId,
        (function* () {
            for (const message of messages) yield message.info?.id;
        })(),
    );
}

/**
 * Test-only accessor that returns (and lazily creates) the per-session token
 * cache map so tests can seed and inspect entries without running the full
 * transform pipeline. Not exported from any barrel.
 */
export function __getMessageTokensCacheForTest(
    sessionId: string,
): Map<string, { conversation: number; toolCall: number }> {
    return getMessageTokensCache(sessionId);
}

/**
 * Compute whether the provider cache expired due to idle time.
 * Extracted so callers that don't run the full transform pipeline can still
 * evaluate the TTL idle window with the same parseCacheTtl semantics.
 *
 * Returns false when cacheTtl is "never" (Infinity) because any finite
 * elapsed time is < Infinity.
 */
export function computeHardCacheExpired(
    cacheTtl: string,
    lastResponseTime: number,
    now: number,
): boolean {
    let ttlMs: number;
    try {
        ttlMs = parseCacheTtl(cacheTtl);
    } catch {
        ttlMs = 5 * 60 * 1000;
    }
    return lastResponseTime > 0 && now - lastResponseTime >= ttlMs;
}

/**
 * Extract the provider/model from the last assistant message in the array.
 * Used for early model-change detection before loadContextUsage.
 */
function findLastAssistantModel(
    messages: MessageLike[],
): { providerID: string; modelID: string } | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        // OpenCode message objects have providerID/modelID under info, though
        // our narrow MessageInfo type doesn't declare them.
        const info = messages[i].info as {
            role?: string;
            providerID?: string;
            modelID?: string;
        };
        if (info.role === "assistant" && info.providerID && info.modelID) {
            return { providerID: info.providerID, modelID: info.modelID };
        }
    }
    return null;
}

/**
 * Extract the selected model from the newest USER message in the array. This is
 * the model the outgoing request will ACTUALLY go to: OpenCode's loop resolves
 * the request model from `lastUser.model` (verified with the OpenCode
 * maintainer). On a mid-session model switch, the array ends with
 * `[..., OLD-model assistant, NEW user message]` (the new model has not
 * produced an assistant message yet), so the last ASSISTANT still carries the
 * OLD model while the newest USER carries the NEW one. Preferring this over the
 * last-assistant model is what stops the model-change detector from false-firing
 * on the switching turn.
 *
 * Note the role asymmetry in OpenCode's schema: user messages nest the model
 * under `info.model.{providerID,modelID}`, whereas assistant messages carry it
 * flat as `info.providerID`/`info.modelID`.
 */
function findNewestUserModel(
    messages: MessageLike[],
): { providerID: string; modelID: string } | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const info = messages[i].info as {
            role?: string;
            model?: { providerID?: string; modelID?: string };
        };
        if (info.role !== "user") continue;
        // The NEWEST (last) user message is the one OpenCode resolves the
        // outgoing request model from (`lastUser.model`). Return its model, or
        // null if it carries none (do NOT keep scanning to an OLDER user, whose
        // model is not what this request goes to). A null return lets the caller
        // fall back to the last-assistant model.
        if (info.model?.providerID && info.model.modelID) {
            return { providerID: info.model.providerID, modelID: info.model.modelID };
        }
        return null;
    }
    return null;
}

type TsAuthorityRecoveryOutcome = "completed" | "retryable";

const tsAuthorityRecoveryStateByProject = new Map<string, "running" | "complete">();
const tsAuthorityMismatchLoggedProjects = new Set<string>();
const tsAuthorityUnreachableLoggedProjects = new Set<string>();

function authorityModuleForProject(
    module: RustModeModuleClient,
    projectRoot: string,
): AuthorityModuleClient {
    if (!module.authorityStatus || !module.authorityDrain || !module.mirrorPull) {
        throw new Error(
            "the module does not expose authority.status, authority.drain, and mirror.pull",
        );
    }
    return {
        authorityStatus: (request) => module.authorityStatus!({ ...request, projectRoot }),
        authorityPrepare: (request) => {
            if (!module.authorityPrepare) {
                throw new Error("the module does not expose authority.prepare");
            }
            return module.authorityPrepare({ ...request, projectRoot });
        },
        authorityDrain: (request) => module.authorityDrain!({ ...request, projectRoot }),
        mirrorPull: (request) => module.mirrorPull!({ ...request, projectRoot }),
    };
}

/**
 * Restore a project to TypeScript ownership after its transform_mode setting no
 * longer selects Rust. The durable marker keeps writes fenced until the module
 * confirms every module-owned domain has drained back through its normal protocol.
 */
export async function recoverTsAuthorityProject(args: {
    db: ContextDatabase;
    projectPath: string;
    projectRoot: string;
    module: RustModeModuleClient;
}): Promise<TsAuthorityRecoveryOutcome> {
    const module = authorityModuleForProject(args.module, args.projectRoot);
    const domains = ["memories", "notes"] as const;
    const statuses = await Promise.all(
        domains.map(async (domain) => ({
            domain,
            authority: (
                await module.authorityStatus({
                    context_store_uuid: ensureContextStoreUuid(args.db),
                    project: args.projectPath,
                    domain,
                })
            ).authority,
        })),
    );

    let drainedDomain = false;
    for (const { domain, authority } of statuses) {
        if (!authority || authority.state === "TS") continue;
        // The module's begin route owns MODULE → DRAINING. Calling drainAuthority
        // preserves the lease, mirror replay, checksum, and recovery choreography.
        if (authority.state !== "MODULE" && authority.state !== "DRAINING") {
            return "retryable";
        }
        let drained: Awaited<ReturnType<typeof drainAuthority>> | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            drained = await drainAuthority({
                db: args.db,
                projectPath: args.projectPath,
                domain,
                module,
                checksum: () => {
                    const table = domain === "memories" ? "memories" : "notes";
                    const rows = args.db
                        .prepare(`SELECT * FROM ${table} WHERE project_path = ? ORDER BY id ASC`)
                        .all(args.projectPath)
                        .filter(
                            (row): row is Record<string, unknown> =>
                                row !== null && typeof row === "object",
                        );
                    return checksumAuthoritySeedRows(rows);
                },
            });
            if (!("code" in drained)) break;
        }
        if (!drained || "code" in drained) return "retryable";
        drainedDomain = true;
    }

    // drainAuthority removes the shared marker only after every domain is TS.
    // After a completed replay, bump the project memory epoch once so the memory
    // view re-renders any changes mirrored during recovery.
    if (drainedDomain && !getAuthorityManagedMarker(args.db, args.projectPath)) {
        bumpProjectMemoryEpoch(args.db, args.projectPath);
        return "completed";
    }
    return "retryable";
}

function scheduleTsAuthorityRecovery(args: {
    db: ContextDatabase;
    projectPath: string;
    projectRoot: string;
    module?: RustModeModuleClient;
}): void {
    if (!getAuthorityManagedMarker(args.db, args.projectPath)) return;
    if (tsAuthorityRecoveryStateByProject.has(args.projectPath)) return;

    if (!tsAuthorityMismatchLoggedProjects.has(args.projectPath)) {
        tsAuthorityMismatchLoggedProjects.add(args.projectPath);
        log(
            `[magic-context] project ${args.projectPath} is module-authority-managed but transform_mode is TS; draining authority back to TypeScript`,
        );
    }
    if (!args.module) {
        tsAuthorityRecoveryStateByProject.set(args.projectPath, "complete");
        if (!tsAuthorityUnreachableLoggedProjects.has(args.projectPath)) {
            tsAuthorityUnreachableLoggedProjects.add(args.projectPath);
            log(
                `[magic-context] authority recovery for ${args.projectPath} cannot reach subc; writes remain fenced. Run magic-context doctor drain-authority ${args.projectRoot} with rust mode or restore subc connectivity.`,
            );
        }
        return;
    }

    tsAuthorityRecoveryStateByProject.set(args.projectPath, "running");
    void Promise.resolve()
        .then(() => recoverTsAuthorityProject({ ...args, module: args.module! }))
        .then((outcome) => {
            if (outcome === "completed") {
                tsAuthorityRecoveryStateByProject.set(args.projectPath, "complete");
                log(`[magic-context] authority drain complete for project ${args.projectPath}`);
            } else {
                // A bounded contention result is durable and resumable. Do not cache it
                // so the next project setup can resume the module's DRAINING state.
                tsAuthorityRecoveryStateByProject.delete(args.projectPath);
            }
        })
        .catch((error) => {
            tsAuthorityRecoveryStateByProject.set(args.projectPath, "complete");
            if (!tsAuthorityUnreachableLoggedProjects.has(args.projectPath)) {
                tsAuthorityUnreachableLoggedProjects.add(args.projectPath);
                log(
                    `[magic-context] authority recovery for ${args.projectPath} cannot reach subc; writes remain fenced. Run magic-context doctor drain-authority ${args.projectRoot} with rust mode or restore subc connectivity.`,
                    error,
                );
            }
        });
}

export interface TransformDeps {
    tagger: Tagger;
    scheduler: Scheduler;
    contextUsageMap: Map<
        string,
        { usage: ContextUsage; updatedAt: number; lastResponseTime?: number }
    >;
    db: ContextDatabase;
    /**
     * Channel 1 (ctx_reduce tool-output nudge) per-session metric baseline,
     * refreshed at the end of each transform pass where ctx_reduce is callable
     * and read in tool.execute.after.
     */
    channel1StateBySession?: Map<string, import("./ctx-reduce-nudge").Channel1State>;
    /** Module-authored Channel 2 text held until the terminal `message.updated` event, when the host delivers the pending nudge. */
    channel2DirectiveTextBySession?: Map<string, string>;
    protectedTags: number;
    /**
     * ctx_reduce visibility is resolved per session from the session's tool
     * allow-list. Tag DB rows are still maintained when the tool is unavailable,
     * but §N§ prefixes and nudges are suppressed. See tag-messages.ts for the gate.
     */
    /** Smart-drops (experimental, default off): also reclaim tool output that a
     *  later call supersedes, on top of the age-based auto-drop. Off → messages
     *  sent to the model are byte-identical to the age-based-only behavior. */
    smartDrops?: boolean;
    clearReasoningAge: number;
    /** Commit-cluster historian trigger config (`commit_cluster_trigger`). */
    commitClusterTrigger?: { enabled: boolean; min_clusters: number };
    /**
     * One-shot signal that `<session-history>` injection cache is stale and
     * `prepareCompartmentInjection` should rebuild on this pass. Drained
     * after the rebuild so subsequent defer passes hit the fresh cache.
     * See Oracle review 2026-04-26 for the three-set split rationale.
     */
    historyRefreshSessions: Set<string>;
    deferredHistoryRefreshSessions?: Set<string>;
    /**
     * Persistent signal that pending ops + heuristics need to materialize.
     * Survives across defer passes when `compartmentRunning` blocks the
     * heuristic pass. Drained only after `shouldRunHeuristics` succeeds.
     */
    pendingMaterializationSessions: Set<string>;
    deferredMaterializationSessions?: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
    commitSeenLastPass?: Map<string, boolean>;
    client?: PluginContext["client"];
    directory?: string;
    memoryConfig?: {
        enabled: boolean;
        injectionBudgetTokens: number;
        /** When true, historian/recomp auto-promote eligible session facts
         *  to project memories. When false, promotion is skipped — agents can
         *  still write memories explicitly via `ctx_memory write`. Issue #44. */
        autoPromote: boolean;
    };
    /** Defaults true. When false, m[0] omits the <project-docs> block and docs hash. */
    injectDocs?: boolean;
    ensureProjectRegistered?: (directory: string, db: ContextDatabase) => Promise<void>;
    /**
     * Returns the historian chunk budget. Called at each historian spawn site
     * so the value is always derived from current config — keeping hook,
     * RPC, and TUI trigger paths consistent and honoring runtime config changes.
     * Optional for tests; production (hook.ts) always provides it.
     */
    getHistorianChunkTokens?: () => number;
    historyBudgetPercentage?: number;
    executeThresholdPercentage?: number | { default: number; [modelKey: string]: number };
    executeThresholdTokens?: { default?: number; [modelKey: string]: number | undefined };
    historianTimeoutMs?: number;
    /** Resolved fallback chain for historian-family calls. */
    fallbackModels?: readonly string[];
    /** False when historian.disable=true, blocking historian-backed child agents. */
    historianRunnable?: boolean;
    /**
     * Compaction-off mode (issue #266), boot-resolved and process-stable.
     * When true the transform runs additive-only: m[0]/m[1] memory/docs
     * injection, measurement and identity recording stay; every mutating
     * compaction gate (historian, drops, strips, nudges, emergency, markers,
     * tag writes) is off. Precedence: every mutating gate becomes
     * `existingGate && !compactionOff` — the mode wins over both the primary
     * and the subagent path. It does NOT alias fullFeatureMode=false: the
     * m[0]/m[1] injection gate is re-expressed as identity-present AND
     * (fullFeatureMode || compactionOff) so the mode cannot swallow memory
     * delivery.
     */
    compactionOff?: boolean;
    getNotificationParams?: (
        sessionId: string,
    ) => import("./send-session-notification").NotificationParams;
    getModelKey?: (sessionId: string) => string | undefined;
    getFallbackModelId?: (sessionId: string) => string | undefined;
    projectPath?: string;
    experimentalUserMemories?: boolean;

    /** When true, inject wall-clock gap markers (<!-- +Xm -->) on user messages and
     *  add compact date ranges to compartment headings in <session-history>.
     *  Controlled by `experimental.temporal_awareness` config. */
    experimentalTemporalAwareness?: boolean;
    /** experimental.mural.enabled — when true (and the fold's model accepts
     *  images), materializeM0 renders the deterministic mural on demand and folds
     *  its image into the m[0] baseline. */
    experimentalMuralEnabled?: boolean;
    /** When true, run a second editor pass after historian to clean U: lines.
     *  Enables the historian-editor agent. Controlled by `historian.two_pass` config. */
    historianTwoPass?: boolean;
    liveModelBySession?: LiveModelBySession;
    /**
     * Process-scoped cache of resolved session.directory values. When provided,
     * we look up here before hitting OpenCode's API and populate after a
     * successful lookup. The session→project binding is immutable in OpenCode,
     * so this cache lives until the session is deleted.
     */
    sessionDirectoryBySession?: Map<string, string>;
    /**
     * Process-scoped set of Magic Context's OWN hidden child sessions
     * (historian/dreamer/sidekick/memory-migration), detected by title prefix
     * at `session.created`. When a session is in this set the transform returns
     * immediately (messages unmodified) — these children have their own fixed
     * agent identity and never use any MC feature, so even reduced-mode work
     * (tagging, heuristic drops) is pure overhead. See live-session-state.ts.
     */
    internalChildSessions?: Set<string>;
    /** Experimental auto-search hint — transform-time ctx_search on each new
     *  user message; when top hit clears the threshold, append a compact
     *  fragment hint to the user message. Controlled by
     *  `experimental.auto_search.*` config. */
    autoSearch?: {
        enabled: boolean;
        scoreThreshold: number;
        minPromptChars: number;
        directory?: string;
        ensureProjectRegistered?: (directory: string, db: ContextDatabase) => Promise<void>;
    };
    /**
     * Experimental age-tier caveman text compression — rewrites long
     * user/assistant text parts with progressively aggressive caveman
     * rules based on their position in the eligible tag window. Only runs for
     * primary sessions; subagents are excluded because their context is curated
     * by the parent and they have no ctx_expand recovery path.
     */
    cavemanTextCompression?: {
        enabled: boolean;
        minChars: number;
    };
    /** Fire-and-forget active-session embed backfill after transform returns. */
    maybeAutoEmbedSession?: (sessionId: string) => void;
    /** Resolved project mode. Rust mode bypasses every TS mutation below. */
    transformMode?: "ts" | "rust";
    /** Module transport injected by the hook; tests use a deterministic mock. */
    rustModeModuleClient?: RustModeModuleClient;
    /** Test-only opt-out for transform-wire fixtures without the authority protocol. */
    rustModeAllowAuthorityProtocolBypassForTests?: boolean;
    rustModeProjectRoot?: string;
    /**
     * Module route used only to recover a project whose config changed from Rust
     * transforms back to TypeScript while the durable authority marker remains.
     */
    tsAuthorityRecoveryModuleClient?: RustModeModuleClient;
    onRustModeParked?: (sessionId: string, message: string) => void;
    onRustModeProjectPrepared?: (projectPath: string) => void;
    rustMemorySyncRequestedSessions?: Set<string>;
}

export function createTransform(deps: TransformDeps) {
    const loadedSessions = new Set<string>();
    const rustModeTransform =
        deps.transformMode === "rust" && deps.rustModeModuleClient
            ? createRustModeTransform(deps, {
                  moduleClient: deps.rustModeModuleClient,
                  hostClient: deps.client,
                  projectRoot: deps.rustModeProjectRoot,
                  notifyParked: deps.onRustModeParked,
                  onProjectPrepared: deps.onRustModeProjectPrepared,
                  memorySyncRequestedSessions: deps.rustMemorySyncRequestedSessions,
                  allowAuthorityProtocolBypassForTests:
                      deps.rustModeAllowAuthorityProtocolBypassForTests,
              })
            : undefined;
    const deferredHistoryRefreshSessions = deps.deferredHistoryRefreshSessions ?? new Set<string>();
    const deferredMaterializationSessions =
        deps.deferredMaterializationSessions ?? new Set<string>();

    const transform = async (
        _input: Record<string, never>,
        output: { messages: unknown[] },
    ): Promise<void> => {
        const startTime = performance.now();
        const messages = output.messages as MessageLike[];
        const passOutcome = createPassOutcome();
        const lkgInput = projectLkgEntry(messages);
        const sessionId = findSessionId(messages);
        if (!sessionId) {
            return;
        }
        const resolvedSessionId = sessionId;
        clearOpenCodePendingTransformDecision(sessionId);
        logTransformTiming(sessionId, "findSessionId", startTime, `messages=${messages.length}`);

        const db = deps.db;
        if (deps.client !== undefined) {
            scheduleReconciliation(db, sessionId, readRawSessionMessages);
        }

        const tUserMsg = performance.now();
        const currentTurnId = findLastUserMessageId(messages);
        logTransformTiming(sessionId, "findLastUserMessageId", tUserMsg);

        const tMeta = performance.now();
        let sessionMeta: import("../../features/magic-context/types").SessionMeta | undefined;
        try {
            // Intentional fail-open: magic-context should not block live chat if session state read fails.
            sessionMeta = getOrCreateSessionMeta(db, sessionId);
        } catch (error) {
            passOutcome.record("session-meta-early-return", "fatal");
            sessionLog(sessionId, "transform failed reading session meta:", error);
            return;
        }
        logTransformTiming(sessionId, "getOrCreateSessionMeta", tMeta);

        // Magic Context's OWN hidden children (historian/dreamer/sidekick/
        // memory-migration) are fully exempt from the transform. They have a
        // fixed agent identity + single-shot/bounded job and use zero MC
        // features, so even reduced-mode work (tagging, heuristic drops) is
        // pure overhead and conceptual noise. Detected at session.created by
        // the `magic-context-` title prefix. Returning here leaves messages
        // unmodified. (Worst case the very first pass races the session.created
        // event and runs reduced-mode once — harmless for these short sessions.)
        if (deps.internalChildSessions?.has(sessionId)) {
            sessionLog(sessionId, "transform skipped (internal magic-context child session)");
            return;
        }

        // Rust mode is an authority adapter, not a second implementation of the
        // TypeScript renderer. Internal children returned above retain their identity
        // in both modes; every other rust-mode session is handed to the module here.
        if (deps.transformMode === "rust") {
            if (!rustModeTransform) {
                sessionLog(sessionId, "rust transform unavailable; using raw passthrough");
                return;
            }
            await rustModeTransform.run(sessionId, messages, output, sessionMeta);
            return;
        }

        // System prompt change detection is handled in experimental.chat.system.transform
        // (see system-prompt-hash.ts), not here. The messages transform only receives
        // user/assistant messages, not the system prompt.

        const reducedMode = sessionMeta.isSubagent;
        const fullFeatureMode = !reducedMode;
        // Compaction-off mode (issue #266) is a THIRD flag, orthogonal to the
        // subagent split above: every mutating gate below becomes
        // `existingGate && !compactionOff`, and the m[0]/m[1] injection gate
        // is re-expressed as identity-present AND (fullFeatureMode ||
        // compactionOff) so the mode cannot swallow memory delivery.
        const compactionOff = deps.compactionOff === true;

        // Mode-transition reconciliation runs on every pass and is a no-op
        // once the session's durable record matches the boot-resolved mode —
        // so the transition work (marker cleanup, latch/intent/pending-op
        // clears, catch-up signal) happens exactly once per session, on the
        // first pass after a restart that changed the resolved value. A notice
        // transition first stages a durable pending record, then commits its
        // settled value only after delivery; a failure therefore retries the
        // same logical transition across process restarts.
        try {
            const transition = reconcileCompactionMode({
                db,
                sessionId,
                compactionOff,
                historianRunnable: deps.historianRunnable !== false,
                compartmentInProgress: sessionMeta.compartmentInProgress,
            });
            const hasTransitionEffects =
                transition.recordToWrite !== null ||
                transition.notice !== null ||
                transition.invalidatedM0Baseline ||
                transition.clearedCompartmentInProgress ||
                transition.historianCatchUpSignaled;
            if (hasTransitionEffects) {
                if (transition.invalidatedM0Baseline) {
                    // The persisted baseline bytes were nulled; drop the
                    // pass-local copies too so this pass re-materializes
                    // instead of replaying the pre-flip render.
                    sessionMeta = {
                        ...sessionMeta,
                        cachedM0Bytes: null,
                        cachedM1Bytes: null,
                        cachedM0MuralDataUrl: null,
                        cachedM0MuralHash: null,
                    };
                }
                if (transition.clearedCompartmentInProgress) {
                    sessionMeta = { ...sessionMeta, compartmentInProgress: false };
                }
                if (transition.historianCatchUpSignaled) {
                    sessionMeta = { ...sessionMeta, compartmentInProgress: true };
                }
                const notice = transition.notice;
                // A missing client is the existing no-notification test/headless
                // seam. Production OpenCode transforms always provide one; when
                // present, its delivery result controls whether the settled record
                // commits. The reconciler has already persisted a pending notice
                // record, so a restart retries instead of losing this delivery.
                let noticeDelivered = notice === null || deps.client === undefined;
                if (notice && deps.client) {
                    // Out-of-band only — never the message array or nudge
                    // channels. A failed delivery leaves the durable pending
                    // record in place, accepting a duplicate after a crash
                    // rather than permanently losing the notice.
                    noticeDelivered =
                        (await sendIgnoredMessage(
                            deps.client,
                            sessionId,
                            notice,
                            deps.getNotificationParams?.(sessionId) ?? {},
                        )) === "sent";
                }
                if (noticeDelivered && transition.recordToWrite !== null) {
                    commitCompactionModeRecord(db, sessionId, transition.recordToWrite);
                } else if (!noticeDelivered) {
                    sessionLog(
                        sessionId,
                        "compaction mode notice was not delivered; durable pending record will retry on the next pass",
                    );
                }
            }
        } catch (error) {
            passOutcome.record("compaction-mode-transition-failure");
            sessionLog(
                sessionId,
                "compaction mode transition failed (retrying next pass):",
                error,
            );
        }
        // §N§ prefix + ctx_reduce + Channel 1 are gated on this single signal,
        // NOT on subagent status. `ctx_reduce` is registered process-globally
        // (tool-registry.ts), so subagents may have the tool — they just need
        // the §N§ prefix + Channel 1 baseline + guidance to use it.
        //
        // ALSO gated on the session's actual tool availability: a parent agent
        // can spawn this session with an explicit allow-list tools map that
        // filters ctx_reduce out entirely — §N§ prefixes and nudges for a tool
        // the model can't call are pure overhead plus cargo-cult risk. The
        // verdict is frozen per session (first user message's tools map) so it
        // can never flap mid-session and bust the cache.
        const ctxReduceAvailability: CtxReduceAvailabilityVerdict =
            resolveCtxReduceAvailabilityFromMessages(sessionId, messages);
        const ctxReduceCallable = ctxReduceAvailability.callable;

        // Same frozen-per-session verdict for the native `todowrite` tool. When
        // a session's tools map filters todowrite out, the synthetic todo-pair
        // injection (postprocess B7 block) must not replay a pair for a tool the
        // model cannot call. Resolved here from the same first-user-message map
        // so the verdict is frozen identically and never flaps mid-session.
        const todowriteAvailability: ToolAvailabilityVerdict =
            resolveTodowriteAvailabilityFromMessages(sessionId, messages);

        // Resolve the *session's* working directory, not the OpenCode launch
        // directory. When the user runs `opencode -s <id>` from outside the
        // project, `deps.directory` (captured at plugin init) reflects the
        // launch dir (often $HOME) while the session itself is bound to the
        // project. Historian/dreamer/recomp child sessions and project-scoped
        // memory all need the session's real directory.
        //
        // We call `client.session.get(...)` (OpenCode's public SDK) once per
        // session per plugin-process lifetime and cache the result in
        // `liveSessionState.sessionDirectoryBySession`. The session→project
        // binding is immutable in OpenCode (the `directory` field is set at
        // session create time and never modified), so caching for the entire
        // session lifetime is safe.
        //
        // Without the cache, this HTTP round trip ran on every transform pass
        // and was observed to take 1.5s+ for large sessions under Electron
        // Desktop, dominating transform latency. We deliberately keep using
        // the public SDK rather than reading OpenCode's internal SQLite
        // directly — the schema is OpenCode's private contract and could
        // change without notice.
        //
        // session.get failure is non-fatal — fall back to deps.directory so
        // transform never blocks on a permanent SDK error.
        let sessionDirectory: string = deps.directory ?? "";
        let sessionDirectoryResolvedFromHost = false;
        const cachedDirectory = deps.sessionDirectoryBySession?.get(sessionId);
        if (cachedDirectory && cachedDirectory.length > 0) {
            sessionDirectory = cachedDirectory;
            sessionDirectoryResolvedFromHost = true;
        } else if (deps.client !== undefined) {
            try {
                const sessionResponse = await deps.client.session
                    .get({ path: { id: sessionId } })
                    .catch(() => null);
                const sessionInfo = (sessionResponse as { data?: { directory?: string } } | null)
                    ?.data;
                if (
                    sessionInfo &&
                    typeof sessionInfo.directory === "string" &&
                    sessionInfo.directory.length > 0
                ) {
                    sessionDirectory = sessionInfo.directory;
                    // Populate cache for future transforms in this session.
                    // Don't cache the fallback (deps.directory) — it might be
                    // wrong for `opencode -s <id>` launches from a different
                    // cwd, and the next transform should retry the SDK lookup.
                    deps.sessionDirectoryBySession?.set(sessionId, sessionDirectory);
                    sessionDirectoryResolvedFromHost = true;
                }
            } catch (error) {
                passOutcome.record("session-directory-fallback");
                sessionLog(sessionId, "session directory lookup failed; using fallback:", error);
            }
            if (!sessionDirectoryResolvedFromHost) passOutcome.record("session-directory-fallback");
        }
        const compartmentDirectory = sessionDirectory;
        const historianRunnable = deps.historianRunnable !== false;
        const canRunCompartments =
            fullFeatureMode &&
            !compactionOff &&
            historianRunnable &&
            deps.client !== undefined &&
            compartmentDirectory.length > 0;
        const fallbackModelId = deps.getFallbackModelId?.(sessionId);

        const tModelDetect = performance.now();
        // Snapshot persisted usage BEFORE any reset this pass. Both the
        // model-change clear (just below) and the first-pass reset (further down)
        // zero last_context_percentage / last_input_tokens; the proactive
        // shrinking-switch arm and the protected-tail boundary sizing need the
        // pre-reset values, so capture them once, here, up front.
        const persistedUsageBeforeResets = loadPersistedUsage(db, sessionId);

        // Detect model changes early in the transform, BEFORE loading context
        // usage, so threshold checks (95% blocking, 80% emergency nudge) and the
        // history budget don't run on the previous model's numbers.
        if (deps.liveModelBySession) {
            // The model the request will ACTUALLY go to. The newest USER message
            // carries the selected (possibly just-switched) model, and OpenCode
            // resolves the outgoing request from it (`lastUser.model`). On a
            // switching turn the array ends with [..., OLD assistant, NEW user]:
            // the last ASSISTANT still reads OLD (assistant model is flat
            // info.providerID/modelID) while the newest USER reads NEW (nested
            // info.model). Prefer the newest user; if that message somehow
            // carries no model, prefer the live map (chat.message set it to the
            // just-selected model BEFORE this pass) over the last assistant. The
            // last assistant still reads the OLD model on a switching turn, so
            // falling straight to it would reintroduce the mis-resolution. Use the
            // last assistant only when neither is available (fork / cold-start
            // replay with an empty live map).
            const currentOutgoingModel =
                findNewestUserModel(messages) ??
                deps.liveModelBySession.get(sessionId) ??
                findLastAssistantModel(messages);
            if (currentOutgoingModel) {
                // Always track the outgoing model as the live model (seeds an
                // empty map after restart; keeps it current otherwise).
                deps.liveModelBySession.set(sessionId, currentOutgoingModel);

                // Model-change detection drives stale per-model state clearing.
                // Trigger off the model that produced the LAST PERSISTED USAGE
                // (lastObservedModelKey), NOT the volatile liveModelBySession: on
                // a LIVE switch chat.message has already set liveModelBySession to
                // the new model before transform runs, so a liveModel-vs-outgoing
                // comparison never sees the change, and hook-handlers.ts does not
                // clear on a live switch either. The persisted usage's model is
                // the authoritative "what the last measured turn ran on" signal;
                // when it differs from the outgoing model the model genuinely
                // changed since the last turn, so the old model's detected-limit /
                // reasoning watermark / emergency state must be cleared. One
                // trigger covers live switch, cold start, and fork alike.
                const outgoingModelKey = resolveModelKey(
                    currentOutgoingModel.providerID,
                    currentOutgoingModel.modelID,
                );
                const lastUsageModelKey = persistedUsageBeforeResets?.lastObservedModelKey ?? null;
                if (
                    lastUsageModelKey != null &&
                    outgoingModelKey != null &&
                    lastUsageModelKey !== outgoingModelKey
                ) {
                    dropSlot(sessionId, "model-change");
                    sessionLog(
                        sessionId,
                        `transform: model change since last usage (${lastUsageModelKey} -> ${outgoingModelKey}), clearing stale per-model state`,
                    );
                    updateSessionMeta(db, sessionId, {
                        lastContextPercentage: 0,
                        lastInputTokens: 0,
                        observedSafeInputTokens: 0,
                        cacheAlertSent: false,
                        clearedReasoningThroughTag: 0,
                    });
                    clearHistorianFailureState(db, sessionId);
                    clearPersistedReasoningWatermark(db, sessionId);
                    // The emergency-drop watermark is keyed to the prior model's
                    // ceiling (contextLimit × executeThreshold); a model change
                    // moves the ceiling, so reset the latch to re-evaluate the
                    // full tail. The detected-overflow limit + recovery flag were
                    // specific to the prior model and must not leak into the new
                    // model's pressure math, so clear them too (the proactive arm
                    // below re-arms from scratch against the new model if needed).
                    clearEmergencyDropSample(db, sessionId);
                    clearDetectedContextLimit(db, sessionId);
                    clearEmergencyRecovery(db, sessionId);
                    // Clear the in-memory usage map so loadContextUsage recomputes.
                    deps.contextUsageMap.delete(sessionId);
                    sessionMeta = {
                        ...sessionMeta,
                        lastContextPercentage: 0,
                        lastInputTokens: 0,
                        clearedReasoningThroughTag: 0,
                        observedSafeInputTokens: 0,
                        cacheAlertSent: false,
                    };
                }
            }
        }

        logTransformTiming(sessionId, "modelChangeDetection", tModelDetect);
        logTransformTiming(sessionId, "schedulerAndUsage", tModelDetect);
        const tFirstPass = performance.now();
        const isFirstTransformPassForSession = !loadedSessions.has(sessionId);
        loadedSessions.add(sessionId);

        // First-pass reset MUST run BEFORE loadContextUsage so threshold checks
        // (95% blocking, 80% emergency nudge) don't fire on stale data from a
        // different model, reverted message, or previous session state.
        // `persistedUsageBeforeResets` (captured above, before the model-change
        // clear too) holds the pre-reset usage that restart recovery and
        // protected-tail boundary sizing rely on.
        const historianFailureState = getHistorianFailureState(db, sessionId);

        if (isFirstTransformPassForSession && sessionMeta) {
            const persistedPct = sessionMeta.lastContextPercentage ?? 0;
            if (persistedPct > 0) {
                sessionLog(
                    sessionId,
                    `transform: first pass reset — percentage=${persistedPct.toFixed(1)}% — clearing stale usage state`,
                );
                updateSessionMeta(db, sessionId, {
                    lastContextPercentage: 0,
                    lastInputTokens: 0,
                    // Do NOT clear compartmentInProgress here — runCompartmentPhase needs it
                    // to resume a historian run that was in progress when the process restarted.
                    // The compartment phase checks hasEligibleHistoryForCompartment() and either
                    // starts a new run or clears the flag if there's no eligible history.
                });
                // Do NOT clear historian failure state here — restart recovery uses it
                deps.contextUsageMap.delete(sessionId);
                // Update local sessionMeta copy so downstream checks don't use stale values
                sessionMeta = { ...sessionMeta, lastContextPercentage: 0, lastInputTokens: 0 };
            }
        }

        // Compute context usage AFTER first-pass reset so threshold checks use
        // clean state (0%) instead of stale values from a previous model/session.
        let contextUsageEarly = loadContextUsage(deps.contextUsageMap, db, sessionId);

        let recoveryNoHeadEscapeActive = false;
        let emergencyRecoveryArmed = false;
        let emergencyRecoveryOrigin: "provider_overflow" | "proactive_model_shrink" | null = null;
        let usagePercentageSynthetic = false;

        // Overflow-triggered emergency recovery: if a prior provider response
        // included a context-overflow error, the event handler persisted
        // needs_emergency_recovery=1. On the very next transform pass we bump
        // the effective percentage to 95% so the existing emergency path
        // (abort + historian + aggressive drops) fires regardless of what
        // pressure math says. Without this, an overflow on a session whose
        // limit resolver over-reported the real limit would never enter the
        // emergency path — we'd just keep hitting the same overflow error.
        //
        // Compaction-off mode: the whole overflow/emergency machinery is
        // gated off — no proactive arming, no synthetic 95% bump, no
        // no-head escape notice. A persisted latch is cleared by the
        // off-transition, never consumed; overflow propagates to native
        // compaction instead.
        if (fullFeatureMode && !compactionOff) {
            try {
                // Proactive arm for a shrinking model switch (large->small
                // context). After switching to a smaller-context model, the
                // last-measured input (produced by the previous, larger model)
                // can already exceed the new model's hard cap. On this first pass
                // the pressure math still reads the OLD model's ratio (well under
                // threshold), so without this the oversized prompt is sent and
                // rejected, and recovery only arms on the NEXT pass from the
                // provider error. Detect it here: if the last input (measured on
                // a DIFFERENT model) exceeds the CURRENT model's catalog cap, the
                // next request will overflow, so arm recovery now and let the bump
                // below compact before the request goes out.
                //
                // Guards (each prevents a gratuitous compaction/cache bust):
                //  - DIFFERENT-model only: lastObservedModelKey !== current. A
                //    same-model "input > limit" is NOT an overflow: that input
                //    was already ACCEPTED under this model, so a now-smaller limit
                //    is cache regression (#179), not a real shrink.
                //  - getSdkContextLimit (NOT resolveTrustedContextLimit): the new
                //    model's catalog/auth cap only, never a detected-overflow
                //    limit. A stale unkeyed detected limit from the old model
                //    could otherwise read low and false-arm.
                //  - flag-only arm: never writes detected_context_limit from a
                //    catalog value (that would pin a stale-low cap).
                const armModel = deps.liveModelBySession?.get(sessionId);
                const armModelKey = deps.getModelKey?.(sessionId);
                const armSnapshot = persistedUsageBeforeResets;
                const lastMeasuredInput =
                    armSnapshot?.usage.inputTokens ?? sessionMeta?.lastInputTokens ?? 0;
                const lastMeasuredModelKey = armSnapshot?.lastObservedModelKey ?? null;
                const armCatalogLimit = armModel
                    ? getSdkContextLimit(armModel.providerID, armModel.modelID)
                    : undefined;
                if (
                    !sessionMeta?.isSubagent &&
                    armModel &&
                    typeof armCatalogLimit === "number" &&
                    armCatalogLimit > 0 &&
                    lastMeasuredInput > armCatalogLimit &&
                    // different-model guard: the prior input was measured on a
                    // model other than the one we're about to send to.
                    lastMeasuredModelKey != null &&
                    armModelKey != null &&
                    lastMeasuredModelKey !== armModelKey &&
                    !getOverflowState(db, sessionId).needsEmergencyRecovery
                ) {
                    sessionLog(
                        sessionId,
                        `transform: last input ${lastMeasuredInput} (model ${lastMeasuredModelKey}) exceeds new model ${armModelKey} catalog limit ${armCatalogLimit}; arming overflow recovery proactively for the shrinking switch`,
                    );
                    // Flag-only arm: undefined reportedLimit sets
                    // needs_emergency_recovery WITHOUT writing
                    // detected_context_limit.
                    dropSlot(sessionId, "overflow-recovery-arm");
                    recordOverflowDetected(
                        db,
                        sessionId,
                        undefined,
                        armModelKey,
                        "proactive_model_shrink",
                    );
                    // recordOverflowDetected does NOT reset the no-eligible-head
                    // count. A stale count from the prior model would make
                    // noHeadEscape (below) suppress the bump we just armed, so
                    // reset it for a fresh evaluation against the new model.
                    resetProtectedTailNoEligibleHead(db, sessionId);
                }

                const overflowState = getOverflowState(db, sessionId);
                emergencyRecoveryArmed = overflowState.needsEmergencyRecovery;
                emergencyRecoveryOrigin = overflowState.emergencyRecoveryOrigin;
                if (contextUsageEarly.percentage < 80 && !overflowState.needsEmergencyRecovery) {
                    resetProtectedTailNoEligibleHead(db, sessionId);
                }
                const protectedTailMeta = loadProtectedTailMeta(db, sessionId);
                const noHeadEscape =
                    overflowState.needsEmergencyRecovery &&
                    protectedTailMeta.recoveryNoEligibleHeadCount >= RECOVERY_NO_HEAD_LIMIT;
                recoveryNoHeadEscapeActive = noHeadEscape;
                if (
                    overflowState.needsEmergencyRecovery &&
                    contextUsageEarly.percentage < 95 &&
                    !noHeadEscape
                ) {
                    sessionLog(
                        sessionId,
                        `transform: bumping percentage to 95% due to overflow recovery flag (was ${contextUsageEarly.percentage.toFixed(1)}%, detectedLimit=${overflowState.detectedContextLimit || "unknown"})`,
                    );
                    contextUsageEarly = {
                        ...contextUsageEarly,
                        percentage: 95,
                    };
                    usagePercentageSynthetic = true;
                } else if (recoveryNoHeadEscapeActive && deps.client) {
                    void sendIgnoredMessage(
                        deps.client,
                        sessionId,
                        "Magic Context can't compact yet — the recent history is a single in-progress block. Continuing; it will compact once the block completes. Run `/ctx-recomp` if this persists.",
                        deps.getNotificationParams?.(sessionId) ?? {},
                    );
                }
            } catch (error) {
                passOutcome.record("overflow-state-read-failure");
                sessionLog(
                    sessionId,
                    "transform: overflow recovery state read failed:",
                    getErrorMessage(error),
                );
            }
        }
        // Resolve the model's stable context limit directly so the history
        // budget does not depend on volatile live-usage percentage (which is 0
        // on the first pass after restart). Mirrors how the event handler
        // computes percentage — same (providerID, modelID) + detected-overflow
        // override from session_meta.
        //
        // Model resolution order: the in-memory live map (seeded above from the
        // visible message array) first, then a read-only OpenCode-DB recovery
        // (findLastAssistantModelFromOpenCodeDb) for the case where older
        // messages — including the last assistant tuple — are NOT in the visible
        // array (trimmed window). Without the DB fallback a compartmented
        // session could miss its model on a cold pass and fall back to 60K.
        //
        // We use resolveTrustedContextLimit (NOT resolveContextLimit): it
        // returns a limit only on a real models.dev hit or a detected-overflow
        // limit, and `undefined` for an unknown model. Passing the generic 128K
        // default for an unknown large-context model would shrink history below
        // what the live-usage back-derivation yields — so for unknown models we
        // deliberately fall through to the live-usage path inside the resolver.
        let modelForBudget = deps.liveModelBySession?.get(sessionId);
        if (!modelForBudget) {
            const recovered = findLastAssistantModelFromOpenCodeDb(sessionId);
            if (recovered) {
                modelForBudget = recovered;
                // Seed the live map so the scheduler / notification / sidebar
                // paths reuse it this process without re-hitting the DB.
                deps.liveModelBySession?.set(sessionId, recovered);
            }
        }
        // Single pass-local provider resolution for every empty-sentinel producer.
        // A cold pass may recover the model from OpenCode's DB above; hot passes hit
        // the live map. Reusing this value keeps cold/hot output identical and keeps
        // postprocess from making a divergent provider decision later in the pass.
        const resolvedProviderID = modelForBudget?.providerID;
        const canUseEmptySentinels = modelAcceptsEmptyContent(resolvedProviderID);
        const resolvedContextLimit = modelForBudget
            ? resolveTrustedContextLimit(modelForBudget.providerID, modelForBudget.modelID, {
                  db,
                  sessionID: sessionId,
              })
            : undefined;
        const currentModelKeyForBoundary = deps.getModelKey?.(sessionId);
        const persistedUsageFreshForBoundary =
            persistedUsageBeforeResets &&
            Date.now() - persistedUsageBeforeResets.updatedAt <= 10 * 60 * 1000 &&
            (persistedUsageBeforeResets.lastObservedModelKey === null ||
                currentModelKeyForBoundary === undefined ||
                persistedUsageBeforeResets.lastObservedModelKey === currentModelKeyForBoundary) &&
            (resolvedContextLimit === undefined ||
                persistedUsageBeforeResets.lastUsageContextLimit === 0 ||
                persistedUsageBeforeResets.lastUsageContextLimit === resolvedContextLimit)
                ? persistedUsageBeforeResets.usage
                : null;
        const boundaryUsageForProtectedTail = persistedUsageFreshForBoundary ?? contextUsageEarly;
        const boundaryUsageSource = persistedUsageFreshForBoundary ? "persisted" : "live";

        const historyBudgetTokens = resolveHistoryBudgetTokens(
            deps.historyBudgetPercentage,
            contextUsageEarly,
            deps.executeThresholdPercentage,
            deps.getModelKey?.(sessionId),
            deps.executeThresholdTokens,
            resolvedContextLimit,
        );
        // Ceiling for the tiered emergency drop = contextLimit × executeThreshold%
        // (the usable working ceiling, NOT scaled by history_budget_percentage).
        // Resolve the limit the same way resolveHistoryBudgetTokens does: prefer
        // the model's stable limit, else back-derive from live usage. The
        // emergency drop only fires at ≥85%, where percentage is reliably high,
        // so the back-derivation is sound (it would only be unreliable at the
        // percentage=0 cold start, which is far below the trigger). Undefined
        // when neither is available → emergency drop skips, 95% block backstops.
        let emergencyCeilingLimit =
            resolvedContextLimit && resolvedContextLimit > 0 ? resolvedContextLimit : 0;
        if (emergencyCeilingLimit <= 0 && contextUsageEarly.percentage > 0) {
            emergencyCeilingLimit =
                contextUsageEarly.inputTokens / (contextUsageEarly.percentage / 100);
        }
        const emergencyCeilingTokens =
            Number.isFinite(emergencyCeilingLimit) && emergencyCeilingLimit > 0
                ? Math.floor(
                      emergencyCeilingLimit *
                          (resolveExecuteThreshold(
                              deps.executeThresholdPercentage ?? 65,
                              deps.getModelKey?.(sessionId),
                              65,
                              {
                                  tokensConfig: deps.executeThresholdTokens,
                                  contextLimit: emergencyCeilingLimit,
                              },
                          ) /
                              100),
                  )
                : undefined;
        // Compaction-off: drop scheduling is gated off — the scheduler never
        // approves an execute pass, so no pending-op drain, heuristic cleanup,
        // age sweep or smart drop can fire, and the execute-only
        // lastResponseTime watermark write below stays quiet too.
        const schedulerDecisionEarly = compactionOff
            ? ("defer" as const)
            : resolveSchedulerDecision(
                deps.scheduler,
                sessionMeta,
                contextUsageEarly,
                sessionId,
                deps.getModelKey?.(sessionId),
                resolvedContextLimit,
            );
        const midTurn = isMidTurn(deps, resolvedSessionId);
        const bypassReason = detectMidTurnBypassReason({
            contextUsage: contextUsageEarly,
            sessionMeta,
            historyRefreshSessions: deps.historyRefreshSessions,
            sessionId,
        });

        const { midTurnAdjustedSchedulerDecision, sideEffect } = applyMidTurnDeferral({
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
            setDeferredExecutePendingIfAbsent(db, sessionId, flagPayload);
        }

        sessionLog(
            sessionId,
            `[boundary-exec] base=${schedulerDecisionEarly} bypass=${bypassReason} midTurn=${midTurn} effective=${midTurnAdjustedSchedulerDecision} sideEffect=${sideEffect}`,
        );
        // Capture explicit history refresh immediately before the first
        // prepareCompartmentInjection consumer and before any drain. This is a
        // per-pass local, not shared deps state: concurrent transforms must not
        // overwrite each other's explicit/deferred attribution.
        //
        const historyRefreshExplicitBeforePrepare = deps.historyRefreshSessions.has(sessionId);
        const deferredHistoryWasPendingAtPassStart = deferredHistoryRefreshSessions.has(sessionId);
        const earlyActiveRunBlocksMaterialization =
            (getActiveCompartmentRun(sessionId) !== undefined ||
                sessionMeta.compartmentInProgress) &&
            contextUsageEarly.percentage < FORCE_MATERIALIZE_PERCENTAGE;
        const canConsumeDeferredEarly = canConsumeDeferredOnThisPass({
            schedulerDecision: midTurnAdjustedSchedulerDecision,
            contextPercentage: contextUsageEarly.percentage,
            justAwaitedPublication: false,
            activeRunBlocksMaterialization: earlyActiveRunBlocksMaterialization,
        });
        const consumingDeferredEarly =
            canConsumeDeferredEarly && deferredHistoryWasPendingAtPassStart;
        const isCacheBusting = historyRefreshExplicitBeforePrepare || consumingDeferredEarly;
        const notificationParams = deps.getNotificationParams?.(sessionId) ?? {};
        const boundaryContextLimit =
            resolvedContextLimit && resolvedContextLimit > 0
                ? resolvedContextLimit
                : emergencyCeilingLimit > 0
                  ? emergencyCeilingLimit
                  : contextUsageEarly.percentage > 0
                    ? Math.round(
                          contextUsageEarly.inputTokens / (contextUsageEarly.percentage / 100),
                      )
                    : 128_000;
        const boundaryExecuteThreshold = resolveExecuteThreshold(
            deps.executeThresholdPercentage ?? 65,
            deps.getModelKey?.(sessionId),
            65,
            {
                tokensConfig: deps.executeThresholdTokens,
                contextLimit: boundaryContextLimit,
            },
        );
        let _boundarySnapshotCache: ProtectedTailBoundarySnapshot | null | undefined;
        const getRunnableBoundaryForCompartment = (
            emergencyTailScale?: 0.5 | 0.25,
        ): ProtectedTailBoundarySnapshot | null => {
            if (!canRunCompartments) return null;
            if (_boundarySnapshotCache === undefined || emergencyTailScale) {
                const snapshot = resolveOpenCodeProtectedTailBoundary({
                    db,
                    sessionId: resolvedSessionId,
                    mode: "transform-force",
                    contextLimit: boundaryContextLimit,
                    executeThresholdPercentage: boundaryExecuteThreshold,
                    usage: boundaryUsageForProtectedTail,
                    usageSource: boundaryUsageSource,
                    emergencyTailScale,
                });
                if (emergencyTailScale) return snapshot;
                _boundarySnapshotCache = snapshot;
            }
            return _boundarySnapshotCache;
        };
        const getEligibleHistoryForCompartment = (): boolean => {
            const snapshot = getRunnableBoundaryForCompartment();
            if (snapshot !== null && hasRunnableCompartmentWindow(snapshot)) return true;
            if (process.env.NODE_ENV === "test" && !emergencyRecoveryArmed) {
                return hasRunnableCompartmentWindow(
                    createDefaultBoundarySnapshotForTests(sessionId),
                );
            }
            return false;
        };
        let skipCompartmentAwaitForThisPass = false;

        const startRecoveryRun = (): boolean => {
            const scale = contextUsageEarly.percentage >= 95 ? 0.25 : 0.5;
            let boundarySnapshot = getRunnableBoundaryForCompartment();
            if (!boundarySnapshot || !hasRunnableCompartmentWindow(boundarySnapshot)) {
                boundarySnapshot = getRunnableBoundaryForCompartment(scale);
            }
            if (
                process.env.NODE_ENV === "test" &&
                !emergencyRecoveryArmed &&
                (!boundarySnapshot || !hasRunnableCompartmentWindow(boundarySnapshot))
            ) {
                const legacyTestSnapshot = createDefaultBoundarySnapshotForTests(sessionId);
                if (hasRunnableCompartmentWindow(legacyTestSnapshot)) {
                    boundarySnapshot = legacyTestSnapshot;
                }
            }
            if (
                !canRunCompartments ||
                !deps.client ||
                !boundarySnapshot ||
                !hasRunnableCompartmentWindow(boundarySnapshot)
            ) {
                return false;
            }
            if (getActiveCompartmentRun(sessionId)) {
                return false;
            }

            updateSessionMeta(db, sessionId, { compartmentInProgress: true });
            startCompartmentAgent({
                client: deps.client,
                db,
                sessionId,
                historianChunkTokens: deps.getHistorianChunkTokens?.() ?? 20_000,
                boundarySnapshot,
                currentContextLimit: boundaryContextLimit,
                historyBudgetTokens,
                historianTimeoutMs: deps.historianTimeoutMs,
                fallbackModels: deps.fallbackModels,
                directory: compartmentDirectory,
                fallbackModelId,
                getNotificationParams: () => notificationParams,
                experimentalUserMemories: deps.experimentalUserMemories,
                experimentalTemporalAwareness: deps.experimentalTemporalAwareness,
                historianTwoPass: deps.historianTwoPass,
                // Issue #44: gate historian-driven memory promotion so users
                // who disable the feature actually see no memories created.
                memoryEnabled: deps.memoryConfig?.enabled,
                autoPromote: deps.memoryConfig?.autoPromote,
                ensureProjectRegistered: deps.ensureProjectRegistered,
                // Historian publication invalidates the injection cache AND
                // changes compartments/facts that render into message[0]. We
                // signal:
                //   - deferredHistoryRefreshSessions: rebuilds only when a
                //     materializing pass can consume history + drops together.
                //   - deferredMaterializationSessions: queues drops that
                //     historian published until heuristics actually run.
                // We deliberately do NOT signal systemPromptRefreshSessions —
                // historian doesn't change disk-backed adjuncts (docs/profile/
                // key-files), so re-reading them would burn IO for nothing.
                preserveInjectionCacheUntilConsumed: true,
                onCompartmentStatePublished: (sid) => {
                    deferredHistoryRefreshSessions.add(sid);
                    deferredMaterializationSessions.add(sid);
                },
            });
            skipCompartmentAwaitForThisPass = true;
            return true;
        };

        if (
            fullFeatureMode &&
            !compactionOff &&
            historianFailureState.failureCount > 0 &&
            contextUsageEarly.percentage >= 95 &&
            !recoveryNoHeadEscapeActive
        ) {
            skipCompartmentAwaitForThisPass = true;
            const emergencyPercentage = contextUsageEarly.percentage.toFixed(1);
            const recoveryStarted = startRecoveryRun();
            // If recovery can't start because there is no eligible pre-tail
            // history to compact, the runner no-op that normally counts this
            // condition never fires. Count it here too so a genuinely in-progress
            // tail can escape the abort loop after a bounded number of passes;
            // keep recovery armed so compaction still happens once the arc closes.
            if (!recoveryStarted && !getEligibleHistoryForCompartment()) {
                const noHeadSnapshot =
                    getRunnableBoundaryForCompartment(
                        contextUsageEarly.percentage >= 95 ? 0.25 : 0.5,
                    ) ?? getRunnableBoundaryForCompartment();
                if (noHeadSnapshot) {
                    recordHighPressureNoEligibleHead(db, noHeadSnapshot);
                }
                sessionLog(
                    sessionId,
                    "transform: emergency recovery remains armed — no complete eligible head before protected tail",
                );
            }
            sessionLog(
                sessionId,
                `EMERGENCY: historian recovery requested at ${emergencyPercentage}%, failures: ${historianFailureState.failureCount}`,
            );
        } else if (
            fullFeatureMode &&
            !compactionOff &&
            isFirstTransformPassForSession &&
            historianFailureState.failureCount > 0 &&
            getEligibleHistoryForCompartment() &&
            startRecoveryRun()
        ) {
            sessionLog(
                sessionId,
                `transform: historian recovery triggered on session load after ${historianFailureState.failureCount} failure(s)`,
            );
            if (deps.client) {
                void sendIgnoredMessage(
                    deps.client,
                    sessionId,
                    `## Historian recovery\n\nHistorian previously failed ${historianFailureState.failureCount} time(s), so Magic Context is retrying history comparting immediately after restart.`,
                    notificationParams,
                );
            }
        }

        logTransformTiming(sessionId, "emergencyRecoveryBlock", tFirstPass);

        // Resolve project identity ONCE per transform pass. Used by both
        // prepareCompartmentInjection (memory filtering by project) and
        // runCompartmentPhase (historian memory resolution). Computing it
        // twice per turn is wasteful — resolveProjectIdentity caches by
        // directory but still does a cache lookup on each call, and the
        // first call per directory in a new process spawns `git rev-list`.
        const memoryProjectDirectory = compartmentDirectory || process.cwd();
        const projectIdentity = deps.memoryConfig?.enabled
            ? resolveProjectIdentity(memoryProjectDirectory)
            : undefined;
        if (deps.memoryConfig?.enabled) {
            maybeSendProjectIdentityWarning(
                deps,
                sessionId,
                memoryProjectDirectory,
                notificationParams,
            );
        }
        // Session-scoped project identity for note-nudge and auto-search, which
        // must target the SESSION's project — not the launch cwd. `deps.projectPath`
        // is resolved once at hook init from the launch directory; on
        // `opencode -s <id>` started from a different repo it points at the wrong
        // project, so note nudges and auto-search would query the launch project's
        // notes/memories. Reuse the memory identity when memory is enabled
        // (identical value, no extra resolve); otherwise resolve from the session
        // directory, falling back to the launch identity only when unavailable.
        // resolveProjectIdentity is per-directory cached, so the common case
        // (session dir == launch dir) costs nothing extra.
        const sessionProjectIdentity =
            projectIdentity ??
            (sessionDirectory ? resolveProjectIdentity(sessionDirectory) : deps.projectPath);
        const sessionIdentityForBinding = sessionDirectory
            ? resolveProjectIdentityForSession(sessionDirectory)
            : undefined;
        if (sessionDirectory) {
            maybeSendProjectIdentityWarning(deps, sessionId, sessionDirectory, notificationParams);
        }
        // Keep the marker lookup in the same identity vocabulary that Rust authority
        // setup used: memory-enabled projects use their MC identity, never a raw path.
        // Scheduling only starts background recovery; this transform continues normally.
        const authorityProjectPath =
            (deps.memoryConfig?.enabled ? projectIdentity : undefined) ??
            deps.projectPath ??
            sessionProjectIdentity;
        if (authorityProjectPath) {
            scheduleTsAuthorityRecovery({
                db,
                projectPath: authorityProjectPath,
                projectRoot: sessionDirectory || memoryProjectDirectory,
                module: deps.tsAuthorityRecoveryModuleClient,
            });
        }
        // Persist only host-resolved session bindings. The launch-directory
        // fallback keeps transforms non-fatal, but storing it as ownership would
        // let a transient SDK failure permanently mis-scope chunk backfills.
        // Guarded to fire once per (session, identity) in this process so the
        // hot path carries no per-pass DB write once the binding is recorded.
        if (
            sessionIdentityForBinding &&
            sessionDirectoryResolvedFromHost &&
            recordedSessionProjectIdentity.get(sessionId) !== sessionIdentityForBinding
        ) {
            recordSessionProjectIdentity(db, sessionId, sessionIdentityForBinding);
            recordedSessionProjectIdentity.set(sessionId, sessionIdentityForBinding);
        }

        // Historian trigger decision — relocated here from the message.updated
        // event handler. The event handler has no message array, so it re-read
        // the session tail from opencode.db on EVERY streaming delta (~186ms of
        // synchronous SQLite per event on a large session, freezing the event
        // loop and making parallel hooks like tool.definition measure seconds).
        // The transform already receives the post-compaction-marker tail —
        // the exact eligible window — as parsed objects, so the inspection runs
        // from memory with zero opencode.db reads (live-verified byte-identical
        // boundary on every decision field before the cutover). Cadence is
        // once per LLM request (this hook) instead of per streaming delta,
        // which is when the decision inputs actually change. Runs here because
        // `messages` is still the clean pre-injection, pre-mutation tail.
        // On shouldFire we set the flag AND mutate the local sessionMeta so
        // runCompartmentPhase starts the historian in this same pass (the same
        // pass it would have started under the event-handler flow). The
        // resolved boundary snapshot is handed through so the phase doesn't
        // re-resolve it.
        // Tag load-scoping floor: derived once per pass from the raw wire ids and
        // reused by the trigger's tag scans (below) AND the tagger initFromDb
        // (later). Computed here — NOT inside the trigger from inMemoryTail —
        // because the trigger's in-memory tail is gated on the compaction-marker
        // anchor and bails (undefined) post-restart / during marker-drain lag;
        // the floor only needs the leading wire ids, which are always present, so
        // deriving it here keeps both tag scans scoped on every pass (those
        // anchor-miss passes were the residual ~90ms full-scan regression).
        const taggerFloor = compactionOff ? 0 : deriveTaggerLoadFloor(messages, sessionId, db);
        // floor 0 = no leading wire message resolved to a tag → BOTH tag scans
        // (tagger initFromDb + the trigger's token scans) fall back to the full
        // ~O(session) load. On a large session that's the ~70ms compartmentTrigger
        // we are trying to avoid, so surface it as a one-line health signal rather
        // than letting it hide as silent latency.
        if (!compactionOff && taggerFloor === 0 && messages.length > 0) {
            sessionLog(
                sessionId,
                `tag floor: 0 (full-scan fallback) — no leading wire message resolved a tag across ${messages.length} msgs`,
            );
        }

        let triggerBoundarySnapshot: ProtectedTailBoundarySnapshot | undefined;
        if (
            fullFeatureMode &&
            !compactionOff &&
            historianRunnable &&
            !sessionMeta.compartmentInProgress
        ) {
            const tTrigger = performance.now();
            try {
                const inMemoryTail = buildTriggerInMemoryTail(
                    db,
                    sessionId,
                    extractInMemoryMessageViews(messages),
                );
                const triggerResult = checkCompartmentTrigger(
                    db,
                    sessionId,
                    sessionMeta,
                    boundaryUsageForProtectedTail,
                    sessionMeta.lastContextPercentage,
                    boundaryExecuteThreshold,
                    deriveTriggerBudget(boundaryContextLimit, boundaryExecuteThreshold),
                    deps.clearReasoningAge,
                    deps.commitClusterTrigger,
                    undefined,
                    boundaryContextLimit,
                    inMemoryTail,
                    taggerFloor,
                );
                if (triggerResult.shouldFire) {
                    sessionLog(
                        sessionId,
                        `compartment trigger: firing (reason=${triggerResult.reason})`,
                    );
                    updateSessionMeta(db, sessionId, { compartmentInProgress: true });
                    sessionMeta.compartmentInProgress = true;
                    triggerBoundarySnapshot = triggerResult.boundarySnapshot;
                }
            } catch (error) {
                passOutcome.record("compartment-trigger-failure");
                sessionLog(sessionId, "compartment trigger failed (non-fatal):", error);
            }
            logTransformTiming(sessionId, "compartmentTrigger", tTrigger);
        }

        let pendingCompartmentInjection: PreparedCompartmentInjection | null = null;
        let rebuiltHistoryFromInitialPrepare = false;
        // Compaction-off bypasses compartment-history preparation entirely,
        // even when historical compartment rows exist: no <session-history>
        // render, no raw-tail trim, no boundary splice, no marker write.
        // Memory/docs surfaces materialize independently through the
        // zero-compartment m[0]/m[1] path in postprocess.
        if (fullFeatureMode && !compactionOff) {
            const tInj = performance.now();
            pendingCompartmentInjection = prepareCompartmentInjection(
                db,
                sessionId,
                messages,
                isCacheBusting,
                projectIdentity,
                deps.memoryConfig?.injectionBudgetTokens,
                deps.experimentalTemporalAwareness,
            );
            logTransformTiming(sessionId, "prepareCompartmentInjection", tInj);

            // ── Drain historyRefreshSessions (one-shot semantics) ──
            // The injection rebuild — the only consumer of this signal in
            // the messages-transform path — has now run. Future defer
            // passes within the same TTL window MUST hit the cached
            // injection result so the Anthropic prompt-cache prefix
            // stays stable. The captured local `isCacheBusting` const
            // above retains its value for downstream background-compressor
            // gating, so this drain doesn't affect later behavior in this
            // pass — only future passes.
            //
            // This is the core of the Oracle 2026-04-26 fix: the previous
            // single-set design left the flush flag alive whenever
            // compartmentRunning blocked heuristics, so every defer pass
            // re-fired prepareCompartmentInjection with isCacheBusting=true
            // and burned cache reuse for nothing.
            if (isCacheBusting) {
                // Cache-busting pass invoked prepareCompartmentInjection. Treat
                // this as a history rebuild regardless of whether the prepare
                // returned a populated injection — even a null result (no
                // compartments yet) consumes the deferred-history signal
                // because the next pass will get a fresh prepare. The
                // separate `compartmentInjectionRebuiltFromDb` flag (plan v6)
                // exposes the narrower "real rebuild happened" signal to
                // postprocess for the marker-drain decision.
                rebuiltHistoryFromInitialPrepare = true;
            }
            if (historyRefreshExplicitBeforePrepare) {
                deps.historyRefreshSessions.delete(sessionId);
            }
        }

        let targets = new Map<number, TagTarget>();
        // ──────────────────────────────────────────────────────────────────────

        let reasoningByMessage = new Map<
            MessageLike,
            { type: string; thinking?: string; text?: string }[]
        >();
        let messageTagNumbers = new Map<MessageLike, number>();
        let tagNormalizationTargets: TagNormalizationTarget[] = [];
        let batch: { finalize: () => void } | null = null;
        let hasRecentReduceCall = false;
        // Inject temporal markers before tagging so the §N§ tag prefix wraps
        // around our marker.
        //
        // Intentional — this runs on EVERY transform pass, including defer /
        // cache-safe passes that are otherwise gated. Three invariants make
        // that safe:
        //   1. Idempotent: injectTemporalMarkers detects existing markers by
        //      regex and will not double-prefix.
        //   2. Deterministic: the marker value derives from immutable
        //      message.time.created / time.completed timestamps — same input,
        //      same output, every pass.
        //   3. Required every pass: OpenCode rebuilds the messages array from
        //      its DB for every transform, so markers must be re-applied on
        //      each pass or they would disappear on defer passes. Skipping
        //      defer passes here would cause the marker to flicker in/out and
        //      bust cache when it reappeared.
        //
        // The retroactive-on-flag-flip behavior is the same mechanism — when
        // the flag turns on, the first pass marks every eligible user message
        // and subsequent passes just observe the already-marked content.
        // Compaction-off: temporal markers/overlays are part of the gated
        // compaction surface (additive but mode-owned), so the wire stays
        // untouched in this mode.
        if (deps.experimentalTemporalAwareness && !compactionOff) {
            const tTemporal = performance.now();
            const injected = injectTemporalMarkers(messages);
            if (injected > 0) {
                sessionLog(sessionId, `temporal: injected ${injected} gap markers`);
            }
            logTransformTiming(sessionId, "injectTemporalMarkers", tTemporal);
        }

        let taggingSucceeded = false;
        // Compaction-off mode: the tagger writes ZERO tag rows and emits no
        // §N§ prefixes (spec #266 decision #6). Every consumer of the tag
        // walk's outputs (drops, heuristics, nudges, caveman, flushed-status
        // replay) is itself gated off in this mode, so the whole walk is
        // skipped — no rows, no prefixes, no commit scan. Flip-back
        // self-heals: the tagger lazily mints on first observation of
        // untagged wire content once this gate reopens.
        if (!compactionOff) {
        try {
            const t0 = performance.now();
            const tInitFromDb = performance.now();
            // taggerFloor was derived once above (before the trigger block) and is
            // reused here so the tagger map and the trigger's tag scans scope to
            // the identical live-wire floor.
            deps.tagger.initFromDb(sessionId, db, taggerFloor);
            logTransformTiming(sessionId, "tag.initFromDb", tInitFromDb);
            // Skip §N§ prefix injection only when ctx_reduce is unavailable in
            // this session's tool allow-list. Subagents with the tool DO get
            // prefixes now — they self-manage tool bloat. DB tag records are
            // maintained either way so heuristics and drops continue to work;
            // only the agent-visible prefix is gated.
            const skipPrefixInjection = !ctxReduceCallable;
            const result = tagMessages(sessionId, messages, deps.tagger, db, {
                skipPrefixInjection,
            });
            targets = result.targets;
            reasoningByMessage = result.reasoningByMessage;
            messageTagNumbers = result.messageTagNumbers;
            tagNormalizationTargets = result.normalizationTargets;
            batch = result.batch;
            hasRecentReduceCall = result.hasRecentReduceCall;
            const hadPriorCommitState = deps.commitSeenLastPass?.has(sessionId) ?? false;
            const sawCommitLastPass = deps.commitSeenLastPass?.get(sessionId) ?? false;
            // Only trigger on NEW commits — not on first pass after restart where
            // we have no baseline. First pass establishes the baseline silently.
            // Subagents never deliver note nudges (gated in postprocess), so skip
            // accumulating orphan trigger state.
            if (
                fullFeatureMode &&
                hadPriorCommitState &&
                result.hasRecentCommit &&
                !sawCommitLastPass
            ) {
                onNoteTrigger(db, sessionId, "commit_detected");
            }
            deps.commitSeenLastPass?.set(sessionId, result.hasRecentCommit);
            logTransformTiming(sessionId, "tagMessages", t0);
            taggingSucceeded = true;
        } catch (error) {
            passOutcome.record("tagging-persistence-failure");
            sessionLog(
                sessionId,
                "transform tag persistence failed; continuing without tagging:",
                error,
            );
            // Drop in-memory tagger state for this session so the next pass
            // re-loads from the DB. Without this, a stale counter or stale
            // assignments map can keep producing the same UNIQUE collision
            // turn after turn until the process restarts. With the DB-
            // authoritative allocation in tagger.assignTag, a fresh load
            // typically self-heals in one pass.
            try {
                deps.tagger.cleanup(sessionId);
            } catch (cleanupError) {
                sessionLog(sessionId, "tagger cleanup after failure threw:", cleanupError);
            }
        }
        }

        // P0 perf: replace single SELECT-everything load with three
        // targeted queries. The hot transform path used to load every
        // tag in the session (~50k rows on long-lived sessions) every
        // pass; benchmark in scripts/benchmark-tag-queries.ts showed
        // this single change recovers ~67ms per pass.
        //
        //   activeTags          → drives heuristic cleanup, nudger,
        //                         caveman scope (active subset only;
        //                         partial-index scan, ~0.6ms)
        //   targetsSliceTags    → drives applyFlushedStatuses + caveman
        //                         replay (visible target subset only;
        //                         IN-list lookup against the existing
        //                         (session_id, tag_number) index)
        //   maxDroppedTagNumber → replaces the watermark for-loop with
        //                         a single MAX() aggregate
        //
        // applyHeuristicCleanup and nudger both filter on
        // status === "active" and short-circuit otherwise, so feeding
        // them active-only is identical behavior. applyFlushedStatuses
        // and caveman replay both filter to targets.has(tagNumber), so
        // pre-filtering by tag_number is a no-op for correctness.
        const t1 = performance.now();
        const activeTags = compactionOff ? [] : getActiveTagsBySession(db, sessionId);
        logTransformTiming(sessionId, "getActiveTagsBySession", t1, `count=${activeTags.length}`);

        const t1b = performance.now();
        const targetTagNumbers = [...targets.keys()];
        const targetsSliceTags = compactionOff
            ? []
            : getTagsByNumbers(db, sessionId, targetTagNumbers);
        logTransformTiming(
            sessionId,
            "getTagsByNumbers",
            t1b,
            `targets=${targetTagNumbers.length} fetched=${targetsSliceTags.length}`,
        );

        let didMutateFromFlushedStatuses = false;
        // Only run mutation stages when tagging succeeded. With targets={}
        // applyFlushedStatuses can't drive any of the persisted drops/
        // truncates/source restores it's responsible for, and running it
        // anyway risks fanning out partial work that can't be undone on the
        // next pass. Skip it cleanly so the session enters the next pass
        // with consistent state and the next initFromDb refresh re-binds
        // tags from the DB.
        if (taggingSucceeded) {
            try {
                const t2 = performance.now();
                didMutateFromFlushedStatuses = applyFlushedStatuses(
                    sessionId,
                    db,
                    targets,
                    targetsSliceTags,
                );
                logTransformTiming(sessionId, "applyFlushedStatuses", t2);
                batch?.finalize();
                logTransformTiming(sessionId, "batchFinalize:flushed", t2);
            } catch (error) {
                passOutcome.record("flushed-status-failure");
                sessionLog(sessionId, "transform failed applying flushed statuses:", error);
            }
        }

        const t3 = performance.now();
        // Empty text part sentinels are safe only for canonical Anthropic, where
        // OpenCode filters them before the wire. Other providers keep native
        // structural parts so an empty text block cannot break tool adjacency.
        const strippedStructuralNoise =
            canUseEmptySentinels && !compactionOff ? stripStructuralNoise(messages) : 0;
        logTransformTiming(
            sessionId,
            "stripStructuralNoise",
            t3,
            `strippedParts=${strippedStructuralNoise}`,
        );

        // Replay persisted reasoning clearing on EVERY pass (including defer).
        // This ensures reasoning cleared on a previous cache-busting pass stays cleared
        // even when OpenCode rebuilds messages fresh from its own DB.
        const persistedReasoningWatermark = sessionMeta?.clearedReasoningThroughTag ?? 0;
        if (persistedReasoningWatermark > 0 && !compactionOff) {
            const tReplay = performance.now();
            // Typed reasoning replay is canonical-Anthropic-only, matching the
            // clearOldReasoning WRITE gate (transform-postprocess-phase.ts). The
            // watermark can outlive a provider switch (anthropic → proxy), so
            // gating the replay on the CURRENT provider prevents re-applying
            // "[cleared]" reasoning text onto a non-canonical Claude proxy wire.
            // Inline-thinking replay stays provider-independent — it strips
            // literal <thinking> tags from text, never typed reasoning parts.
            const replayed = canUseEmptySentinels
                ? replayClearedReasoning(
                      messages,
                      reasoningByMessage,
                      messageTagNumbers,
                      persistedReasoningWatermark,
                  )
                : 0;
            const replayedInline = replayStrippedInlineThinking(
                messages,
                messageTagNumbers,
                persistedReasoningWatermark,
            );
            if (replayed > 0 || replayedInline > 0) {
                sessionLog(
                    sessionId,
                    `reasoning replay: cleared=${replayed} inlineStripped=${replayedInline} (watermark=${persistedReasoningWatermark})`,
                );
            }
            logTransformTiming(sessionId, "replayReasoningClearing", tReplay);
        }

        // Re-apply persisted caveman compression on EVERY pass (defer too).
        // tagMessages restores the pristine original from source_contents on
        // every pass, so without this replay step compressed text would
        // oscillate between compressed (post-execute) and original (defer),
        // busting the provider prompt cache. Cheap when no tags carry
        // caveman_depth > 0 (early exit). Only runs for primary sessions —
        // matches the gate that lets applyCavemanCleanup deepen depth in the
        // first place.
        //
        // We feed the targets-slice subset (already loaded above for
        // applyFlushedStatuses) — replay only acts on tags whose
        // tag_number is in `targets` anyway, so passing the wider list
        // would just give it more rows to filter and discard.
        if (!reducedMode && !compactionOff && deps.cavemanTextCompression?.enabled) {
            const tCavemanReplay = performance.now();
            const replayedCaveman = replayCavemanCompression(
                sessionId,
                db,
                targets,
                targetsSliceTags,
            );
            if (replayedCaveman > 0) {
                sessionLog(sessionId, `caveman replay: re-applied ${replayedCaveman} text tags`);
            }
            logTransformTiming(sessionId, "replayCavemanCompression", tCavemanReplay);
        }

        const t4 = performance.now();
        // `clearOldReasoning` replays `[cleared]` as native reasoning text for all
        // providers. Only Anthropic may replace those shells with empty text
        // sentinels; other providers can forward the empty part to the wire.
        const strippedClearedReasoning =
            canUseEmptySentinels && !compactionOff ? stripClearedReasoning(messages) : 0;
        logTransformTiming(
            sessionId,
            "stripClearedReasoning",
            t4,
            `strippedParts=${strippedClearedReasoning}`,
        );

        // Watermark = highest dropped tag_number for this session. Backed by
        // the partial index `idx_tags_dropped_session_tag_number` (migration
        // v8) so SQLite resolves this with a single backward index seek
        // instead of the full-array scan we used to do here.
        const watermark = getMaxDroppedTagNumber(db, sessionId);

        // Reuse the early scheduler result — inputs haven't changed.
        const contextUsage = contextUsageEarly;
        const schedulerDecision = midTurnAdjustedSchedulerDecision;
        const rawGetNotifParams = deps.getNotificationParams;
        const tCompartmentPhase = performance.now();
        const compartmentPhase = await runCompartmentPhase({
            canRunCompartments,
            fullFeatureMode,
            compactionOff,
            historianRunnable,
            sessionMeta,
            contextUsage,
            boundaryContextLimit,
            boundaryExecuteThresholdPercentage: boundaryExecuteThreshold,
            boundaryUsage: boundaryUsageForProtectedTail,
            boundaryUsageSource,
            preResolvedBoundarySnapshot: triggerBoundarySnapshot,
            client: deps.client,
            db,
            sessionId,
            resolvedSessionId,
            historianChunkTokens: deps.getHistorianChunkTokens?.() ?? 20_000,
            historyBudgetTokens,
            historianTimeoutMs: deps.historianTimeoutMs,
            fallbackModels: deps.fallbackModels,
            compartmentDirectory,
            messages,
            pendingCompartmentInjection,
            fallbackModelId,
            projectPath: projectIdentity,
            injectionBudgetTokens: deps.memoryConfig?.injectionBudgetTokens,
            getNotificationParams: rawGetNotifParams
                ? () => rawGetNotifParams(sessionId)
                : undefined,
            // The compressor needs to know if this is a safe pass to run on.
            // Scheduler "execute" passes are safe for compressor (they already bust cache
            // via pending ops); snapshot-drain keeps same-pass compressor signals safe.
            safeForBackgroundCompression:
                historianRunnable &&
                (isCacheBusting || midTurnAdjustedSchedulerDecision === "execute"),
            deferredHistoryRefreshSessions,
            skipAwaitForThisPass: skipCompartmentAwaitForThisPass,
            experimentalUserMemories: deps.experimentalUserMemories,
            experimentalTemporalAwareness: deps.experimentalTemporalAwareness,
            historianTwoPass: deps.historianTwoPass,
            // Issue #44: forward memory gating so the normal historian path
            // (not just the recovery path above) honors memory.enabled and
            // memory.auto_promote.
            memoryEnabled: deps.memoryConfig?.enabled,
            autoPromote: deps.memoryConfig?.autoPromote,
            ensureProjectRegistered: deps.ensureProjectRegistered,
            // See startRecoveryRun above for the full rationale —
            // historian/recomp publication signals history rebuild +
            // pending materialization, but NOT system-prompt adjuncts.
            onCompartmentStatePublished: (sid) => {
                deferredHistoryRefreshSessions.add(sid);
                deferredMaterializationSessions.add(sid);
            },
        });
        pendingCompartmentInjection = compartmentPhase.pendingCompartmentInjection;
        const awaitedCompartmentRun = compartmentPhase.awaitedCompartmentRun;
        const compartmentInProgress = compartmentPhase.compartmentInProgress;
        sessionMeta = { ...sessionMeta, compartmentInProgress };
        logTransformTiming(sessionId, "compartmentPhase", tCompartmentPhase);

        // Layer-B fallback (#264): the injection stayed degraded and no durable
        // compartment boundary is visible, so there was no safe re-anchor splice.
        // Queue a fresh materialization so the baseline is re-cut on the next
        // bust instead of the session silently looping in degraded mode.
        if (pendingCompartmentInjection?.needsFreshMaterialization) {
            deps.pendingMaterializationSessions.add(sessionId);
            deferredMaterializationSessions.add(sessionId);
        }

        // HARD-bust signals for the m[0]/m[1] materialization decision. These
        // capture provider-side cache-eviction events (model switch, system-block
        // change, tools-block change) plus the TTL idle window. A change in any
        // means the Anthropic prompt cache was already dead, so folding m[1] into
        // m[0] is "free". systemHash is the PERSISTED last-turn hash (system.transform
        // runs AFTER this messages.transform), so a system change is detected on the
        // next pass — the accepted one-pass lag.
        const hardModel = deps.liveModelBySession?.get(sessionId);
        const hardModelKey = hardModel ? `${hardModel.providerID}/${hardModel.modelID}` : "";
        const hardSystemHash =
            typeof sessionMeta.systemPromptHash === "string" ? sessionMeta.systemPromptHash : "";
        const hardCacheExpired = computeHardCacheExpired(
            sessionMeta.cacheTtl,
            sessionMeta.lastResponseTime,
            Date.now(),
        );
        const m0HardSignals = {
            systemHash: hardSystemHash,
            modelKey: hardModelKey,
            cacheExpired: hardCacheExpired,
            lastResponseTime: sessionMeta.lastResponseTime,
        };

        const lateActiveRunBlocksMaterialization =
            getActiveCompartmentRun(sessionId) !== undefined &&
            contextUsageEarly.percentage < FORCE_MATERIALIZE_PERCENTAGE;
        const canConsumeDeferredLate = canConsumeDeferredOnThisPass({
            schedulerDecision: midTurnAdjustedSchedulerDecision,
            contextPercentage: contextUsageEarly.percentage,
            justAwaitedPublication: compartmentPhase.justAwaitedPublication,
            activeRunBlocksMaterialization: lateActiveRunBlocksMaterialization,
        });
        const wasEmergencyBlock =
            contextUsageEarly.percentage >= FORCE_MATERIALIZE_PERCENTAGE &&
            compartmentPhase.justAwaitedPublication;
        const historyRebuiltThisPass = wasEmergencyBlock
            ? compartmentPhase.rebuiltHistoryThisPass
            : rebuiltHistoryFromInitialPrepare || compartmentPhase.rebuiltHistoryThisPass;

        const tPostProcess = performance.now();
        const postTransformResult = await runPostTransformPhase({
            sessionId,
            db,
            messages,
            // P0 perf: pass active-only tags. The downstream consumers
            // (applyHeuristicCleanup, nudger) both filter on
            // status === "active" and short-circuit otherwise — feeding
            // them active-only is identical behavior with much smaller
            // input. applyPendingOperations is the only consumer that
            // genuinely needs all statuses; it already handles a missing
            // preload by lazy-loading via getTagsBySession() internally,
            // and pending-op execution is the rare case (most passes have
            // 0 pending ops and skip applyPendingOperations entirely).
            tags: activeTags,
            targets,
            reasoningByMessage,
            messageTagNumbers,
            tagger: deps.tagger,
            ctxReduceAvailability,
            todowriteAvailability,
            batch,
            contextUsage,
            schedulerDecision,
            fullFeatureMode,
            compactionOff,
            canRunCompartments,
            awaitedCompartmentRun,
            phaseJustAwaitedPublication: compartmentPhase.justAwaitedPublication,
            compartmentInProgress,
            historyRefreshExplicitBeforePrepare,
            deferredHistoryWasPendingAtPassStart,
            compartmentInjectionRebuiltFromDb: pendingCompartmentInjection?.rebuiltFromDb === true,
            rebuiltHistoryFromInitialPrepare,
            historyRebuiltThisPass,
            canConsumeDeferredLate,
            sessionMeta,
            currentTurnId,
            // Postprocess reads pendingMaterializationSessions to decide
            // whether `/ctx-flush`-style materialization is queued, and
            // drains it after heuristics actually run. NOT the history
            // set — postprocess doesn't refresh `<session-history>`.
            pendingMaterializationSessions: deps.pendingMaterializationSessions,
            deferredHistoryRefreshSessions,
            deferredMaterializationSessions,
            lastHeuristicsTurnId: deps.lastHeuristicsTurnId,
            clearReasoningAge: deps.clearReasoningAge,
            protectedTags: deps.protectedTags,
            emergencyCeilingTokens,
            pendingCompartmentInjection,
            didMutateFromFlushedStatuses,
            watermark,
            forceMaterializationPercentage: FORCE_MATERIALIZE_PERCENTAGE,
            hasRecentReduceCall,
            // Session-scoped (not launch) identity so note-nudge + auto-search
            // target the resumed session's real project. See sessionProjectIdentity.
            projectPath: sessionProjectIdentity,
            sessionDirectory,
            autoSearch: deps.autoSearch,
            // Only forward caveman config for primary sessions. Subagents should
            // never receive their own caveman compression because they have no
            // equivalent recovery path and their context is already curated by
            // the primary agent that spawned them.
            cavemanTextCompression: !reducedMode ? deps.cavemanTextCompression : undefined,
            smartDrops: deps.smartDrops === true,
            // Pass the single resolved provider through to postprocess so every
            // empty-sentinel gate and whole-message placeholder choice agrees for
            // this transform pass, including cold DB-recovered passes.
            resolvedProviderID,
            passOutcome,
            historyRefreshSessions: deps.historyRefreshSessions,
            m0M1: {
                // Memory identity ONLY (drives <project-memory> selection in
                // materializeM0). Must stay undefined when memory.enabled=false —
                // falling back to deps.projectPath here re-enabled memory injection
                // despite the config being off (materializeM0 renders memory purely
                // on projectPath presence). projectDirectory below independently
                // drives docs/key-files/history, so dropping the fallback does not
                // disable those.
                projectPath: projectIdentity,
                projectDirectory: sessionDirectory,
                injectDocs: deps.injectDocs,
                memoryInjectionBudgetTokens: deps.memoryConfig?.injectionBudgetTokens,
                historyBudgetTokens,
                temporalAwareness: deps.experimentalTemporalAwareness,
                hardSignals: m0HardSignals,
                muralEnabled: deps.experimentalMuralEnabled,
            },
        });
        passOutcome.markFinalized();
        // Compaction-off: the emergency/overflow machinery is fully disarmed
        // (≥85% tiered drop, 95% fail-closed block, overflow-recovery latch).
        // A persisted latch is cleared by the off-transition, never consumed
        // here; overflow propagates to native compaction instead of blocking.
        if (!compactionOff) {
        // Fresh-tokenize only in the emergency band. This estimate is telemetry,
        // never an abort gate: provider-accurate accounting is deferred to the
        // module-side implementation.
        const finalWireEstimate =
            contextUsage.percentage >= 95
                ? estimateFinalWireInputTokens({
                      messages,
                      systemPromptTokens: sessionMeta.systemPromptTokens,
                      providerID: modelForBudget?.providerID,
                      modelID: modelForBudget?.modelID,
                      agentName: notificationParams.agent,
                  })
                : undefined;
        if (finalWireEstimate) {
            sessionLog(
                sessionId,
                `transform: final-wire telemetry estimate=${finalWireEstimate.tokens} trusted=${finalWireEstimate.trusted} conversation=${finalWireEstimate.messageTokens.conversation} tools=${finalWireEstimate.messageTokens.toolCall} system=${finalWireEstimate.systemTokens} toolDefinitions=${finalWireEstimate.toolDefinitionTokens ?? "unknown"}`,
            );
        }
        const currentModelKeyForRecovery = deps.getModelKey?.(sessionId);
        const overflowStateForFinalWire = getOverflowState(
            db,
            sessionId,
            currentModelKeyForRecovery,
        );
        // A catalog or user-configured limit is useful for budgeting, but it cannot
        // prove that this provider accepts the recovered wire shape. Only the limit
        // parsed from this model's own overflow response may disarm recovery.
        const providerProvenLimitTokens =
            typeof currentModelKeyForRecovery === "string" &&
            currentModelKeyForRecovery.length > 0 &&
            overflowStateForFinalWire.detectedContextLimit > 0 &&
            overflowStateForFinalWire.detectedContextLimitModelKey === currentModelKeyForRecovery
                ? overflowStateForFinalWire.detectedContextLimit
                : undefined;
        const emergencyFailClosed = evaluateEmergencyFailClosed({
            usagePercentage: contextUsage.percentage,
            emergencyRecoveryArmed,
            emergencyRecoveryOrigin,
            foldMaterializedThisPass: postTransformResult.historianFoldMaterializedThisPass,
            finalWireEstimate,
            providerProvenLimitTokens,
        });
        if (emergencyFailClosed.disarm) {
            clearEmergencyRecovery(db, sessionId);
            sessionLog(
                sessionId,
                `emergency disarm: trusted final-wire ${emergencyFailClosed.disarm.finalWireTokens} under limit ${emergencyFailClosed.disarm.provenLimitTokens}`,
            );
        }
        if (emergencyFailClosed.shouldAbort) {
            if (!deps.client) {
                throw new EmergencyFailClosedError(
                    "Cannot fail closed: OpenCode client is unavailable",
                );
            }
            // The notice must finish before self-abort so recovery instructions survive interruption.
            let notification: Awaited<ReturnType<typeof sendIgnoredMessage>>;
            try {
                notification = await sendIgnoredMessage(
                    deps.client,
                    sessionId,
                    "Context full — /ctx-flush or /clear to continue.",
                    notificationParams,
                );
            } catch (error) {
                throw new EmergencyFailClosedError("Emergency recovery notification failed", {
                    cause: error,
                });
            }
            if (notification !== "sent") {
                throw new EmergencyFailClosedError(
                    `Emergency recovery notification was ${notification}`,
                );
            }
            try {
                await abortSessionFailClosed(deps.client, sessionId);
            } catch (error) {
                sessionLog(
                    sessionId,
                    "transform: emergency fail-closed abort failed; refusing to return a sendable prompt:",
                    getErrorMessage(error),
                );
                throw new EmergencyFailClosedError("Emergency recovery abort failed", {
                    cause: error,
                });
            }
            // The abort prevents a fresh provider usage sample. Release the
            // stale-sample latch so the retry can reclaim additional tools.
            try {
                clearEmergencyDropSample(db, sessionId);
            } catch (error) {
                throw new EmergencyFailClosedError("Emergency recovery cleanup failed", {
                    cause: error,
                });
            }
            sessionLog(
                sessionId,
                `EMERGENCY: fail-closed (reason=${emergencyFailClosed.reason}, recoveryOrigin=${emergencyRecoveryOrigin ?? "unknown"}, finalEstimate=${finalWireEstimate?.tokens ?? "unavailable"}, estimateTrusted=${finalWireEstimate?.trusted ?? false}, syntheticUsage=${usagePercentageSynthetic})`,
            );
            return;
        }
        }

        if (passOutcome.captureEligible) {
            const keys = resolveLkgModelKeys(messages);
            const modelKey = modelForBudget
                ? `${modelForBudget.providerID}/${modelForBudget.modelID}`
                : keys.modelKey;
            const providerKey = modelForBudget?.providerID ?? keys.providerKey;
            const captured = captureLkgSlot({
                sessionId,
                input: lkgInput,
                output: messages,
                modelKey,
                providerKey,
            });
            if (postTransformResult.bustedThisPass && !captured) {
                dropSlot(sessionId, "lkg_refresh_declined");
            }
        } else if (passOutcome.degradations.length > 0) {
            sessionLog(
                sessionId,
                `lkg_capture_declined degradations=${passOutcome.degradations.map((item) => item.site).join(",")}`,
            );
        }

        if (postTransformResult.bustedThisPass) {
            recordPendingTransformDecision(sessionId, {
                tsMs: Date.now(),
                decision: schedulerDecision,
                materialized: postTransformResult.materialized,
                materializeReason: normalizeMaterializeReason(
                    "opencode",
                    postTransformResult.materializeReason,
                    postTransformResult.materialized,
                ),
                emergency: postTransformResult.emergency,
                droppedTokens: postTransformResult.droppedTokens,
                droppedCount: postTransformResult.droppedCount,
                inputTokens: contextUsage.inputTokens,
                bustedThisPass: true,
            });
        }
        logTransformTiming(sessionId, "postTransformPhase", tPostProcess);

        // Estimate the total token size of the transformed messages array so
        // the sidebar / dashboard can attribute inputTokens between System
        // (from system.transform), Tool Definitions (inferred as the
        // remainder), and Conversation (actual messages minus injected
        // compartments/facts/memories).
        //
        // Counts every token-bearing field across all part types Anthropic
        // serializes: text, reasoning (signed thinking we still forward for
        // the latest assistant), tool inputs, tool outputs, tool_result
        // content. Previously only `text` parts were counted, which produced
        // ~10x underestimates on sessions with long tool traces and pushed
        // the delta into Tool Definitions. This value intentionally includes
        // the injected <session-history> block — the display layer subtracts
        // compartmentTokens/factTokens/memoryTokens to isolate real
        // user/assistant conversation.
        // Split message content into two honest buckets for the sidebar:
        //   conversationTokens = real user/assistant discussion
        //                        (text, reasoning, images) — the part users
        //                        actually wrote/read
        //   toolCallTokens     = tool call I/O inside messages
        //                        (tool, tool_use, tool_result, tool-invocation)
        //                        — actionable, can be compacted by ctx_reduce
        // Tool DEFINITIONS (schemas OpenCode sends in the separate `tools`
        // parameter) are not in messages — they surface as a residual at
        // display time (inputTokens − system − messagesBlock − toolCalls).
        //
        // Cached per message ID. Messages are append-only once streaming
        // completes, so the token contribution of a completed message is
        // stable across transform passes. Cleared on message.removed events
        // (see hook-handlers.ts). On the rare mid-transform mutation (e.g.
        // historian-driven drop), the cache will be ~slightly stale until
        // the next cache-busting pass; acceptable drift for a display
        // estimate.
        const msgTokens = getMessageTokensCache(sessionId);
        // Durable second tier: the tag store holds per-message real-token counts
        // computed ONCE at tag-insert time and persisted, so a cold pass (empty
        // in-process cache after restart) reads them instead of re-tokenizing the
        // tail. Injected m[0]/m[1] blocks and synthetic-todowrite are never
        // tagged, so they fall through to the live walk below and stay counted in
        // conversation_tokens — preserving the display-layer subtraction contract
        // (the RPC handler subtracts compartments/memories/docs/profile from this
        // total to isolate real conversation). A message with any NULL-count tag
        // (legacy, mid-backfill) is absent here this pass and live-tokenizes,
        // converging to the stored path once the tagger backfills it.
        let storedByMessage: Map<
            string,
            { conversation: number; toolCall: number; hasNull: boolean }
        >;
        try {
            storedByMessage = getActiveTagTokenTotalsByMessage(db, sessionId);
        } catch {
            storedByMessage = new Map();
        }
        let conversationTokens = 0;
        let toolCallTokens = 0;
        for (const message of messages) {
            const mid = (message.info as { id?: string }).id;
            if (mid) {
                const cached = msgTokens.get(mid);
                if (cached) {
                    conversationTokens += cached.conversation;
                    toolCallTokens += cached.toolCall;
                    continue;
                }
                const stored = storedByMessage.get(mid);
                if (stored && !stored.hasNull) {
                    conversationTokens += stored.conversation;
                    toolCallTokens += stored.toolCall;
                    msgTokens.set(mid, {
                        conversation: stored.conversation,
                        toolCall: stored.toolCall,
                    });
                    continue;
                }
            }
            const estimated = estimateMessageTokens(message);
            if (mid) msgTokens.set(mid, estimated);
            conversationTokens += estimated.conversation;
            toolCallTokens += estimated.toolCall;
        }
        try {
            updateSessionMeta(db, sessionId, { conversationTokens, toolCallTokens });
        } catch (error) {
            // Pure display/telemetry optimization — never fail transform on a
            // BUSY/transient error here. Next pass will refresh the value.
            const code = (error as { code?: string } | null)?.code;
            if (code !== "SQLITE_BUSY") {
                sessionLog(sessionId, "conversation_tokens UPDATE failed:", error);
            }
        }

        // Channel 1 baseline snapshot (post-drop, post-injection). Computed from
        // the final `messages` array, which the compartment-injection step has
        // already trimmed to the live tail — so summing non-dropped tool output
        // gives the post-boundary undropped tokens directly. Refreshing here (a
        // proven transform boundary) zeroes the per-turn accumulator without the
        // chat.message mid-turn race.
        //
        // Gated on ctx_reduce being effective (NOT fullFeatureMode): Channel 1
        // nudges the agent to call ctx_reduce, so it's meaningful exactly when
        // the agent has the §N§ prefix + the tool — i.e. any session with
        // ctx_reduce enabled, INCLUDING subagents (which self-manage tool
        // bloat). It must NOT fire when the session's tool allow-list denies
        // ctx_reduce. Channel 2 (the synthetic-user ceiling) rides the same gate
        // — it fires for any ctx_reduce-effective session, subagents included.
        if (ctxReduceCallable && !compactionOff && deps.channel1StateBySession) {
            try {
                // Always resolve through resolveExecuteThreshold — even when the
                // percentage config is a bare number — so an execute_threshold_tokens
                // override is honored (a per-model absolute cap converts to an
                // effective %). Skipping it for the numeric case made the Channel
                // pressure math use the wrong threshold on token-configured models.
                const resolvedExecuteThresholdPct = resolveExecuteThreshold(
                    deps.executeThresholdPercentage ?? 65,
                    deps.getModelKey?.(sessionId),
                    65,
                    {
                        tokensConfig: deps.executeThresholdTokens,
                        contextLimit: resolvedContextLimit ?? 0,
                    },
                );
                // Real-tokenizer counts from the durable tag store (injected
                // m[0]/m[1] blocks are never tagged, so this is the injected-free
                // live tail). reclaimable = non-dropped tool OUTPUT; liveTail =
                // conversation + tool I/O. Falls back to a byte-approx live-tail walk
                // only if the store read fails. Replaces the old output-only path.
                let tailToolTokens: number;
                let liveTailTokens: number;
                try {
                    // reclaimable (toolOutput) excludes the protected top-N tags —
                    // the agent can't ctx_reduce those, so they must not count
                    // toward the nudge's "reclaimable" figure (else it nags forever
                    // about protected-tail output it cannot drop).
                    const agg = getActiveTagTokenAggregate(db, sessionId, deps.protectedTags);
                    tailToolTokens = agg.toolOutput;
                    liveTailTokens = agg.conversation + agg.toolCall;
                } catch {
                    const estimate = computeTailTokenEstimate(messages);
                    tailToolTokens = estimate.tailToolTokens;
                    liveTailTokens = estimate.liveTailTokens;
                }
                const executeThresholdTokens = Math.round(
                    ((resolvedContextLimit ?? 0) * resolvedExecuteThresholdPct) / 100,
                );
                const usableTokens = Math.max(
                    0,
                    executeThresholdTokens - contextUsage.inputTokens + liveTailTokens,
                );
                // If the measured tail already shrank below the last persisted
                // watermark before this tool turn (historian publish, emergency
                // drop, pending-op replay), the old band referred to a pile that
                // no longer exists. Clear it now so regrowth starts a fresh cycle.
                resetLastNudgeCycleIfTailShrank(db, sessionId, tailToolTokens);
                const oldestReclaimableToolTags = getOldestActiveUnprotectedToolTags(
                    db,
                    sessionId,
                    deps.protectedTags,
                );
                deps.channel1StateBySession.set(sessionId, {
                    tailToolTokens,
                    historyBudgetTokens: historyBudgetTokens ?? 0,
                    contextLimit: resolvedContextLimit ?? 0,
                    executeThresholdPercentage: resolvedExecuteThresholdPct,
                    lastInputTokens: contextUsage.inputTokens,
                    turnToolTokens: 0,
                    usableTokens,
                    reducedSinceRefresh: false,
                    oldestReclaimableToolTags,
                });

                // Channel 2 (ceiling) trigger — record a one-shot pending intent
                // when pressure is near the execute threshold AND a large pile of
                // reclaimable tool output remains. Delivery happens later from the
                // event handler (`message.updated`) via the in-process client.
                // Uses the real post-transform pressure (current usage% / threshold)
                // and the just-computed tail tokens. Only escalate from the empty
                // ('') state so we never reset an in-flight claim/delivery; the cap
                // is one delivery per session lifetime.
                //
                // Subagents included: Channel 2 injects a synthetic user message
                // via promptAsync, which a subagent's run loop picks up at its next
                // step boundary and addresses like any queued message — verified
                // safe (a subagent runs under the same in-process client as a
                // primary). The only gate is ctx_reduce being effectively enabled
                // (this whole block), so we never nudge toward an uncallable tool.
                // resolvedContextLimit/threshold known is all that's required.
                // usable = the agent's working range = the gap between the fixed
                // overhead floor (everything that ISN'T live tail: system + tool
                // defs + m[0] + m[1]) and the execute-threshold ceiling. Derived
                // by identity: executeThresholdTokens − inputTokens + liveTail
                // (inputTokens − liveTail IS the fixed overhead on the wire). As
                // pressure rises, usable shrinks toward 0, so the single
                // reclaimable ≥ usable/3 ratio encodes both "near comparting" and
                // "big reclaimable pile" without a separate pressure gate.
                // (executeThresholdTokens/usableTokens computed above, alongside
                // the Channel-1 baseline they're persisted with.)
                const channel2MetricsKnown =
                    resolvedContextLimit !== undefined &&
                    resolvedContextLimit > 0 &&
                    resolvedExecuteThresholdPct > 0;
                if (channel2MetricsKnown) {
                    const channel2ShouldTrigger = shouldTriggerChannel2({
                        reclaimableTokens: tailToolTokens,
                        usableTokens,
                    });
                    try {
                        if (channel2ShouldTrigger) {
                            casChannel2NudgeState(db, sessionId, "", "pending");
                        } else {
                            // Cancel stale, undelivered intents when the same
                            // trigger predicate no longer holds; never touch an
                            // in-flight claim or the delivered terminal cap.
                            casChannel2NudgeState(db, sessionId, "pending", "");
                        }
                    } catch (error) {
                        sessionLog(sessionId, "channel2 trigger CAS failed (ignored):", error);
                    }
                }
            } catch (error) {
                sessionLog(sessionId, "channel1 baseline snapshot failed (ignored):", error);
            }
        } else {
            deps.channel1StateBySession?.delete(sessionId);
        }

        const elapsed = (performance.now() - startTime).toFixed(1);
        sessionLog(
            sessionId,
            `transform completed in ${elapsed}ms (${messages.length} messages, ${targets.size} targets, watermark: ${watermark})`,
        );

        deps.maybeAutoEmbedSession?.(sessionId);
    };

    return Object.assign(transform, {
        invalidateRustWireState(sessionId: string): void {
            rustModeTransform?.invalidateWireState(sessionId);
        },
        clearRustSession(sessionId: string): void {
            rustModeTransform?.clearSession(sessionId);
        },
    });
}

export function resolveHistoryBudgetTokens(
    historyBudgetPercentage: number | undefined,
    contextUsage: ContextUsage,
    executeThresholdPercentage:
        | number
        | { default: number; [modelKey: string]: number }
        | undefined,
    modelKey: string | undefined,
    executeThresholdTokens?: { default?: number; [modelKey: string]: number | undefined },
    resolvedContextLimit?: number,
): number | undefined {
    if (!historyBudgetPercentage) {
        return undefined;
    }

    // Derive the budget from the model's STABLE context limit, resolved
    // directly (models.dev + any detected-overflow override). The previous
    // design back-derived the limit from live usage as inputTokens/percentage,
    // which collapses to 0/0 on the FIRST transform pass after a restart
    // (percentage=0, inputTokens=0). When a re-materialize was forced on that
    // very pass (e.g. the m[1] cache was cleared by a migration), the budget
    // fell through to the hard-coded 60K default — far below a large model's
    // real history budget — and the decay renderer archived the oldest
    // compartments to fit 60K, then stuck there via cache_hit replay. The
    // resolved limit is available even at percentage=0 (recovered from the
    // OpenCode DB), so it removes the hole. The live-usage back-derivation is
    // kept only as a last-resort fallback if a limit couldn't be resolved.
    let contextLimit = resolvedContextLimit && resolvedContextLimit > 0 ? resolvedContextLimit : 0;
    if (contextLimit <= 0) {
        if (contextUsage.percentage <= 0) {
            return undefined;
        }
        contextLimit = contextUsage.inputTokens / (contextUsage.percentage / 100);
    }
    if (!Number.isFinite(contextLimit) || contextLimit <= 0) {
        return undefined;
    }

    return Math.floor(
        contextLimit *
            (resolveExecuteThreshold(executeThresholdPercentage ?? 65, modelKey, 65, {
                tokensConfig: executeThresholdTokens,
                contextLimit,
            }) /
                100) *
            historyBudgetPercentage,
    );
}
