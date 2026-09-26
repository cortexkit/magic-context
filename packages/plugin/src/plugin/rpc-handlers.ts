/**
 * Server-side RPC handlers. Queries the server's own SQLite DB
 * and returns typed responses for TUI consumption.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, createWriteStream, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { COMPACTION_ENABLED_PATH, isCompactionEnabled } from "../config/agent-disable";
import { currentPluginConfigReader, historianRunConfig } from "../config/live-run-config";
import type { MagicContextConfig } from "../config/schema/magic-context";
import {
    getAuthorityManagedMarker,
    getMemoryMirrorStatus,
} from "../features/magic-context/context-authority";
import {
    getFailingDreamTasks,
    getMostRecentTaskRunAt,
} from "../features/magic-context/dreamer/storage-task-schedule";
import { getDreamTaskBacklogs } from "../features/magic-context/dreamer/task-gates";
import {
    CANONICAL_DREAM_TASKS,
    type DreamTaskBacklogMap,
    type DreamTaskFailureState,
    toolLoopDreamTasks,
} from "../features/magic-context/dreamer/task-registry";
import {
    type DreamerTickFailure,
    getDreamerTickFailure,
} from "../features/magic-context/dreamer/tick-failure";
import { getLocalEmbeddingNativeMemoryStats } from "../features/magic-context/memory/embedding-local";
import {
    emptyMemoryImportanceHistogram,
    getActiveMemoryImportanceHistogram,
} from "../features/magic-context/memory/memory-diagnostics";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import { getMessageIndexQueueHeapStats } from "../features/magic-context/message-index-async";
import { getMural } from "../features/magic-context/mural/storage-mural";
import { getEmbeddingCoverageStatus } from "../features/magic-context/project-embedding-registry";
import { getProtectionWindowForSession } from "../features/magic-context/protection-window";
import { parseCacheTtl } from "../features/magic-context/scheduler";
import { getQuickJsNativeMemoryStats } from "../features/magic-context/smart-notes/sandbox-runner";
import {
    type ContextDatabase as Database,
    openDatabase,
    setSessionWorkMetrics,
} from "../features/magic-context/storage";
import {
    getPersistedSchemaVersion,
    LATEST_SUPPORTED_VERSION,
} from "../features/magic-context/storage-db";
import {
    getCompactionMarkerHealth,
    getObservedEpochFloor,
} from "../features/magic-context/storage-meta-persisted";
import { getMeasuredToolDefinitionTokens } from "../features/magic-context/tool-definition-tokens";
import {
    computeOpenCodeWorkMetricsIncremental,
    emptyWorkMetricsCarry,
    type WorkMetricsCarry,
} from "../features/magic-context/work-metrics";
import type { HiddenCompletionExecutor } from "../hooks/magic-context/compartment-runner-types";
import {
    type EmbedHistoryDeps,
    pauseEmbedHistoryDrain,
    runEmbedHistoryDrain,
} from "../hooks/magic-context/embed-history-runner";
import { getEmbedDrainUiStatus } from "../hooks/magic-context/embed-session-state";
import {
    resolveContextLimit,
    resolveContextWindowGeometry,
    resolveExecuteThresholdDetail,
} from "../hooks/magic-context/event-resolvers";
import { executeFlush } from "../hooks/magic-context/execute-flush";
import { formatEmbedStatusText } from "../hooks/magic-context/format-embed-status";
import type { RunnerRefusalCanonicalCause } from "../hooks/magic-context/historian-no-fire-cause";
import { getLiveNotificationParams } from "../hooks/magic-context/hook-handlers";
import type { LiveSessionState } from "../hooks/magic-context/live-session-state";
import { getLkgSlotHeapStats } from "../hooks/magic-context/lkg-slot";
import { computeM0BlockTokens } from "../hooks/magic-context/m0-token-breakdown";
import { getCompartmentMirrorHeapStats } from "../hooks/magic-context/module-state-sync";
import {
    findLastAssistantModelFromOpenCodeDb,
    openCodeDbExists,
    withReadOnlySessionDb,
} from "../hooks/magic-context/read-session-db";
import { getTokenizerNativeMemoryStats } from "../hooks/magic-context/read-session-formatting";
import type { ManagedRecompContext } from "../hooks/magic-context/recomp-orchestrator";
import type { RustModeModuleClient } from "../hooks/magic-context/rust-mode-transform";
import {
    calibrateBuckets,
    resolveModelCalibration,
} from "../hooks/magic-context/tokenizer-calibration";
import {
    ANNOUNCEMENT_FEATURES,
    ANNOUNCEMENT_FOOTER,
    ANNOUNCEMENT_VERSION,
    markAnnouncementSeen,
    shouldShowAnnouncement,
} from "../shared/announcement";
import { resolveCacheTtlDisplay } from "../shared/cache-ttl-display";
import type { ConfigParseFailure } from "../shared/config-diagnostics";
import { getMagicContextStorageDir } from "../shared/data-path";
import { listHiddenVariantWarnings } from "../shared/hidden-variant-warnings";
import { activeHostLimitations } from "../shared/host-limitations";
import { getLoggerDiagnostics, log } from "../shared/logger";
import { pushNotification } from "../shared/rpc-notifications";
import type { MagicContextRpcServer } from "../shared/rpc-server";
import type {
    DebugHeapSnapshotResponse,
    DebugMemoryHolders,
    DebugMemoryUsageResponse,
    EmbedDetail,
    RunnerStatus,
    SidebarSnapshot,
    StatusDetail,
} from "../shared/rpc-types";
import { getSqliteMemoryStats } from "../shared/sqlite";
import { shouldEnforcePrivateStoragePermissions } from "../shared/storage-permissions";
import {
    resolveTailHygieneStatus,
    type WireTailHygieneBaseline,
} from "../shared/tail-hygiene-status";
import { renderCapabilityRefusal } from "../shared/user-facing-codes";
import { applyStickySnapshotCache } from "./sidebar-snapshot-cache";

// Per-process incremental work-metrics state, keyed by session. The RPC server
// is long-lived, so the carry survives across polls and each poll folds only
// assistant rows newer than its watermark (≈0 when idle). Lost on restart —
// the next poll cold-starts from the persisted session_meta value's session by
// re-folding once, which is the acceptable one-time cost design A accepts.
const workMetricsCarryBySession = new Map<string, WorkMetricsCarry>();
export async function executeRustRecompRpc(
    moduleClient: RustModeModuleClient | undefined,
    sessionId: string,
    projectRoot: string,
): Promise<{ ok: boolean; error?: string }> {
    if (!moduleClient) return { ok: false, error: "Rust module client is unavailable" };
    try {
        await moduleClient.call({
            sessionId,
            projectRoot,
            method: "session.recomp",
            body: {
                method: "session.recomp",
                v: 1,
                session_id: sessionId,
                command_id: `rpc-recomp:${randomUUID()}`,
            },
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

export interface RustSessionStatus {
    usage?: { current_total_input_tokens?: number; context_limit_tokens?: number };
    memory_mirror?: {
        feed_head?: number;
        module_live_rows?: number;
        host_cursor?: number;
        host_cursor_updated_at_ms?: number;
        stalled?: boolean;
        code?: string | null;
    };
    authority?: {
        memories?: { project?: string; state?: "TS" | "PREPARING" | "MODULE" | "DRAINING" } | null;
        notes?: { project?: string; state?: "TS" | "PREPARING" | "MODULE" | "DRAINING" } | null;
    };
    tail_hygiene?: WireTailHygieneBaseline | null;
    boundary_present?: boolean;
    coverage_ordinal?: number | null;
    compartment_count?: number;
    compartment_tokens?: number;
    pending_drop_count?: number;
    tag_count?: number;
    pending_m1_delta?: boolean;
    pending_m1_age_ms?: number | null;
    wrapup_active?: boolean;
    wrapup_rounds?: number | null;
    historian?: {
        last_outcome?: string;
        last_failure?: string | null;
        last_no_fire?: string | null;
        refusal_stage?: "credential" | "provider" | "model" | "resolution" | null;
        canonical_cause?: RunnerRefusalCanonicalCause | null;
        runner?: ModuleRunnerStatus;
    };
    dreamer?: {
        runner?: ModuleRunnerStatus;
    };
}

/** The module's account of which completion runner a session used, and why. */
interface ModuleRunnerStatus {
    runner?: string;
    source?: string;
    harness?: string;
    observed?: string;
}

function runnerStatusFromModule(status: ModuleRunnerStatus | undefined): RunnerStatus | undefined {
    if (status?.runner !== "host" && status?.runner !== "broca") return undefined;
    if (status.source !== "configured" && status.source !== "default_for_harness") return undefined;
    return {
        runner: status.runner,
        source: status.source,
        harness: typeof status.harness === "string" ? status.harness : "",
        observed: status.observed === "last_completion" ? "last_completion" : "resolved_for_route",
    };
}
const rustStatusInFlight = new Map<string, Promise<RustSessionStatus | undefined>>();

/**
 * Lazily compute work-metrics for the sidebar. Returns the persisted fallback
 * (instant warm-start value) when OpenCode's DB is absent or the read fails,
 * and write-throughs the fresh value to session_meta on success.
 */
function resolveSidebarWorkMetrics(
    db: Database,
    sessionId: string,
    persistedNewWork: number,
    persistedTotalInput: number,
): { newWorkTokens: number; totalInputTokens: number } {
    if (!openCodeDbExists()) {
        return { newWorkTokens: persistedNewWork, totalInputTokens: persistedTotalInput };
    }
    try {
        const carry = workMetricsCarryBySession.get(sessionId) ?? emptyWorkMetricsCarry();
        const { carry: nextCarry, metrics } = withReadOnlySessionDb((openCodeDb) =>
            computeOpenCodeWorkMetricsIncremental(openCodeDb, sessionId, carry),
        );
        workMetricsCarryBySession.set(sessionId, nextCarry);
        // Write-through so the value warm-starts the sidebar after a restart.
        try {
            setSessionWorkMetrics(db, sessionId, metrics.newWorkTokens, metrics.totalInputTokens);
        } catch {
            // Non-fatal: the in-memory value is still returned below.
        }
        return metrics;
    } catch {
        return { newWorkTokens: persistedNewWork, totalInputTokens: persistedTotalInput };
    }
}

function getDb(): Database | null {
    try {
        return openDatabase();
    } catch {
        return null;
    }
}

/**
 * Coalesce only overlapping reads. Reusing a completed response would let a burst of module
 * writes leave status fields behind the durable store while still appearing authoritative.
 */
export async function loadRustSessionStatus(
    client: RustModeModuleClient | undefined,
    sessionId: string,
    directory: string,
): Promise<RustSessionStatus | undefined> {
    if (!client) return undefined;
    const requestKey = `${directory}\0${sessionId}`;
    const existing = rustStatusInFlight.get(requestKey);
    if (existing) return existing;

    const request = (async () => {
        try {
            const response = await client.call({
                sessionId,
                projectRoot: directory,
                method: "session.status",
                body: { method: "session.status", v: 1, session_id: sessionId },
            });
            const raw =
                response && typeof response === "object"
                    ? (response as Record<string, unknown>)
                    : {};
            const value =
                raw.result && typeof raw.result === "object"
                    ? (raw.result as Record<string, unknown>)
                    : raw;
            if (value.error || value.ok === false) return undefined;
            return value as RustSessionStatus;
        } catch (error) {
            log(`[rpc] Rust session.status unavailable for ${sessionId}:`, error);
            return undefined;
        }
    })();
    rustStatusInFlight.set(requestKey, request);
    try {
        return await request;
    } finally {
        if (rustStatusInFlight.get(requestKey) === request) {
            rustStatusInFlight.delete(requestKey);
        }
    }
}

function safeParseTtl(ttl: string): number {
    try {
        return parseCacheTtl(ttl);
    } catch {
        return 5 * 60 * 1000;
    }
}

function resolveConfigValue<T>(
    cfg: Record<string, unknown> | undefined,
    key: string,
    modelKey: string | undefined,
    defaultValue: T,
): T {
    if (!cfg) return defaultValue;
    const val = cfg[key];
    if (typeof val === typeof defaultValue) return val as T;
    if (val && typeof val === "object") {
        const obj = val as Record<string, T>;
        if (modelKey && obj[modelKey] !== undefined) return obj[modelKey];
        if (modelKey) {
            const bare = modelKey.split("/").slice(1).join("/");
            if (bare && obj[bare] !== undefined) return obj[bare];
        }
        if (obj.default !== undefined) return obj.default;
    }
    return defaultValue;
}

// Exported for test access. Production code reaches this via the
// "sidebar-snapshot" RPC handler registered below.
export function buildSidebarSnapshot(
    db: Database,
    sessionId: string,
    directory: string,
    liveSessionState?: LiveSessionState,
    injectionBudgetTokens?: number,
    // Optional config so the sidebar can show the effective execute threshold
    // alongside `usagePercentage` (e.g. "47.5% / 65%"). Resolved per-model from
    // `liveSessionState.liveModelBySession`. When omitted (e.g. legacy test
    // callers), the snapshot falls back to the runtime default of 65%.
    config?: Record<string, unknown>,
    moduleStatus?: RustSessionStatus,
    compactionEnabled = true,
): SidebarSnapshot {
    try {
        const projectIdentity = resolveProjectIdentity(directory);

        const meta = db
            .prepare<[string], Record<string, unknown>>(
                "SELECT * FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId);

        const usagePercentage = meta
            ? Number(meta.last_context_percentage ?? meta.last_usage_percentage ?? 0)
            : 0;
        const inputTokens = meta ? Number(meta.last_input_tokens ?? 0) : 0;
        const moduleUsage = moduleStatus?.usage;
        const moduleInputTokens = moduleUsage?.current_total_input_tokens;
        const moduleContextLimit = moduleUsage?.context_limit_tokens;
        const effectiveInputTokens =
            typeof moduleInputTokens === "number" && moduleInputTokens > 0
                ? moduleInputTokens
                : inputTokens;
        const effectiveUsagePercentage =
            typeof moduleInputTokens === "number" &&
            moduleInputTokens > 0 &&
            typeof moduleContextLimit === "number" &&
            moduleContextLimit > 0
                ? (moduleInputTokens / moduleContextLimit) * 100
                : usagePercentage;
        // Work-metrics are computed lazily + incrementally HERE (the only
        // consumer), not in the transform hot path. The persisted session_meta
        // columns are a warm-start fallback used on cold start / DB-absent.
        const persistedNewWork = meta ? Number(meta.new_work_tokens ?? 0) : 0;
        const persistedTotalInput = meta ? Number(meta.total_input_tokens ?? 0) : 0;
        const { newWorkTokens, totalInputTokens } = resolveSidebarWorkMetrics(
            db,
            sessionId,
            persistedNewWork,
            persistedTotalInput,
        );
        const systemPromptTokens = meta ? Number(meta.system_prompt_tokens ?? 0) : 0;
        // messagesBlockTokens = token estimate of text/reasoning/image parts
        // in output.messages[] after transform, persisted by transform.ts.
        // Includes injected compartments/facts/memories (they're in message[0]).
        const messagesBlockTokens = meta ? Number(meta.conversation_tokens ?? 0) : 0;
        // toolCallTokensRaw = token estimate of tool_use/tool_result/tool/
        // tool-invocation parts in output.messages[], persisted by transform.
        // These are tool call I/O inside conversation (not tool schemas).
        const toolCallTokensRaw = meta ? Number(meta.tool_call_tokens ?? 0) : 0;
        const compartmentInProgress = meta ? Boolean(meta.compartment_in_progress) : false;
        const cacheTtl = meta ? String(meta.cache_ttl ?? "5m") : "5m";
        const memoryBlockCount = meta ? Number(meta.memory_block_count ?? 0) : 0;

        const compartmentRow = db
            .prepare<[string], { count: number }>(
                "SELECT COUNT(*) as count FROM compartments WHERE session_id = ?",
            )
            .get(sessionId);
        const archivedCompartmentCount = compartmentRow?.count ?? 0;
        const compartmentCount =
            typeof moduleStatus?.compartment_count === "number"
                ? moduleStatus.compartment_count
                : archivedCompartmentCount;

        let memoryCount = 0;
        if (projectIdentity) {
            const memRow = db
                .prepare<[string], { count: number }>(
                    "SELECT COUNT(*) as count FROM memories WHERE project_path = ? AND status = 'active'",
                )
                .get(projectIdentity);
            memoryCount = memRow?.count ?? 0;
        }

        let pendingOpsCount = 0;
        try {
            const pendingRow = db
                .prepare<[string], { count: number }>(
                    "SELECT COUNT(*) as count FROM pending_ops WHERE session_id = ?",
                )
                .get(sessionId);
            pendingOpsCount = pendingRow?.count ?? 0;
        } catch {
            // pending_ops table may not exist
        }
        if (typeof moduleStatus?.pending_drop_count === "number") {
            pendingOpsCount = moduleStatus.pending_drop_count;
        }

        let sessionNoteCount = 0;
        try {
            const noteRow = db
                .prepare<[string], { count: number }>(
                    "SELECT COUNT(*) as count FROM notes WHERE session_id = ? AND type = 'session' AND status = 'active'",
                )
                .get(sessionId);
            sessionNoteCount = noteRow?.count ?? 0;
        } catch {
            // notes table may not exist
        }

        let readySmartNoteCount = 0;
        if (projectIdentity) {
            try {
                const smartRow = db
                    .prepare<[string], { count: number }>(
                        "SELECT COUNT(*) as count FROM notes WHERE project_path = ? AND type = 'smart' AND status = 'ready'",
                    )
                    .get(projectIdentity);
                readySmartNoteCount = smartRow?.count ?? 0;
            } catch {
                // notes table may not exist
            }
        }

        // Token estimates via real Claude tokenizer (ai-tokenizer). The m[0]
        // per-block attribution (docs / user-profile / project-memory /
        // session-history) is computed by the SHARED helper so the OpenCode
        // sidebar and the Pi /ctx-status dialog can never diverge on what the
        // categories are or how they're measured.
        const decodeCachedBytes = (bytes: unknown): string =>
            bytes instanceof Uint8Array
                ? Buffer.from(bytes).toString("utf8")
                : typeof bytes === "string"
                  ? bytes
                  : "";
        const m0Blocks = computeM0BlockTokens(db, sessionId, {
            m0Text: decodeCachedBytes(meta?.cached_m0_bytes),
            m1Text: decodeCachedBytes(meta?.cached_m1_bytes),
            projectIdentity,
            injectionBudgetTokens,
            memoryBlockCount,
            compartmentTokensOverride: moduleStatus?.compartment_tokens,
        });
        const compartmentTokens = m0Blocks.compartmentTokens;
        const factTokens = m0Blocks.factTokens;
        const memoryTokens = m0Blocks.memoryTokens;
        const docsTokens = m0Blocks.docsTokens;
        const profileTokens = m0Blocks.profileTokens;

        let lastDreamerRunAt: number | null = null;
        let dreamerBacklog: DreamTaskBacklogMap | undefined;
        let dreamerFailures: DreamTaskFailureState[] | undefined;
        const dreamerProgress = projectIdentity
            ? (liveSessionState?.dreamerProgressByProject?.get(projectIdentity) ?? null)
            : null;
        if (projectIdentity) {
            try {
                dreamerBacklog = getDreamTaskBacklogs(db, projectIdentity, CANONICAL_DREAM_TASKS);
            } catch {
                // A pre-Dreamer-V2 database may not have all task tables yet.
            }
        }
        if (projectIdentity) {
            try {
                // Dreamer V2 retired the V1 dream_state['last_dream_at'] field;
                // the live "last successful run" is MAX(last_run_at) across the
                // project's task_schedule_state rows (issue #194).
                lastDreamerRunAt = getMostRecentTaskRunAt(db, projectIdentity);
                // A scheduled task can fail on every slot for weeks. Without this the
                // only in-session trace is a backlog count that never falls.
                dreamerFailures = getFailingDreamTasks(db, projectIdentity);
            } catch {
                // task_schedule_state may not exist on a pre-V2 DB
            }
        }

        // Display-layer attribution.
        //
        // Local raw counts come from ai-tokenizer. Per-model calibration in
        // tokenizer-calibration.ts captures the empirically-measured drift
        // between local raw counts and the API's actual token counts (varies
        // significantly across providers and model generations). We:
        //   1. scale stable buckets (system, tool defs) by per-model ratios,
        //   2. compute the dynamic remainder as inputTokens - calibrated_stable,
        //   3. proportionally distribute the remainder to dynamic buckets so
        //      they sum to exactly inputTokens. Overhead becomes 0.
        //
        // messagesBlockTokens persisted by transform.ts includes the injected
        // <session-history> block (compartments + facts + memories live in
        // message[0]). Subtract those so "conversationLocal" reflects real
        // user/assistant dialog only.
        const injectedInMessages =
            compartmentTokens + factTokens + memoryTokens + docsTokens + profileTokens;
        const conversationLocal = Math.max(0, messagesBlockTokens - injectedInMessages);
        const toolCallsLocal = Math.max(0, toolCallTokensRaw);

        // Measured tool schema cost. Resolved via the live-session-state latch
        // (session → agent/model). When the in-memory map is empty (post-restart,
        // before this session's first chat.message has fired in this process)
        // fall back to OpenCode's SQLite DB to recover provider/model/agent
        // from the last assistant message, mirroring the model-recovery path
        // already in place for hook.ts. Populate the cache so subsequent reads
        // hit memory directly. This eliminates the "Tool Defs shows 0 until
        // next chat.message" cold-start gap.
        let measuredToolDefTokens = 0;
        let activeProviderID: string | undefined;
        let activeModelID: string | undefined;
        if (liveSessionState) {
            let model = liveSessionState.liveModelBySession.get(sessionId);
            let agent = liveSessionState.agentBySession.get(sessionId);
            if (!model || !agent) {
                const recovered = findLastAssistantModelFromOpenCodeDb(sessionId);
                if (recovered) {
                    if (!model) {
                        model = {
                            providerID: recovered.providerID,
                            modelID: recovered.modelID,
                        };
                        liveSessionState.liveModelBySession.set(sessionId, model);
                    }
                    if (!agent && recovered.agent) {
                        agent = recovered.agent;
                        liveSessionState.agentBySession.set(sessionId, agent);
                    }
                }
            }
            if (model) {
                activeProviderID = model.providerID;
                activeModelID = model.modelID;
                measuredToolDefTokens =
                    getMeasuredToolDefinitionTokens(model.providerID, model.modelID, agent) ?? 0;
            }
        }

        const contextLimit =
            typeof moduleContextLimit === "number" && moduleContextLimit > 0
                ? moduleContextLimit
                : activeProviderID && activeModelID
                  ? resolveContextLimit(activeProviderID, activeModelID, {
                        db,
                        sessionID: sessionId,
                    })
                  : 0;

        // Resolve the effective execute-threshold percentage for this
        // session's active model so the sidebar header can show
        // "47.5% / 65%" alongside the absolute "475K / 1.0M". Falls back
        // to 65% (the runtime default) when no live model is known yet
        // or when no config was passed in. Mirrors the resolution flow
        // used by `buildStatusDetail` so the dialog and sidebar agree.
        let executeThreshold = 65;
        let executeThresholdClamped = false;
        if (config) {
            const modelKey =
                activeProviderID && activeModelID
                    ? `${activeProviderID}/${activeModelID}`
                    : undefined;
            const pctCfg = config.execute_threshold_percentage as
                | number
                | { default: number; [k: string]: number }
                | undefined;
            const tokensCfg = config.execute_threshold_tokens as
                | { default?: number; [k: string]: number | undefined }
                | undefined;
            const thresholdDetail = resolveExecuteThresholdDetail(pctCfg ?? 65, modelKey, 65, {
                tokensConfig: tokensCfg,
                contextLimit: contextLimit || undefined,
                sessionId,
            });
            executeThreshold = thresholdDetail.percentage;
            executeThresholdClamped = thresholdDetail.clamped === true;
        }

        // Native compaction watches the model's full window, not Magic Context's
        // output-reserved budget or execute threshold. Resolve the same catalog
        // chokepoint without reservation so this display metric cannot inherit a
        // budget denominator; every scheduling consumer keeps `contextLimit`.
        const nativeContextLimit =
            activeProviderID && activeModelID
                ? resolveContextLimit(activeProviderID, activeModelID, {
                      db,
                      sessionID: sessionId,
                      reservation: "none",
                  })
                : contextLimit;
        const nativeContextUsagePercentage =
            nativeContextLimit > 0 ? (effectiveInputTokens / nativeContextLimit) * 100 : undefined;

        const hostLimitations = activeHostLimitations();
        const calibration = resolveModelCalibration(activeProviderID, activeModelID);
        const tailHygiene = resolveTailHygieneStatus(
            liveSessionState?.channel1StateBySession.get(sessionId),
            moduleStatus?.tail_hygiene,
        );

        const calibrated = calibrateBuckets({
            inputTokens: effectiveInputTokens,
            systemLocal: systemPromptTokens,
            toolDefsLocal: measuredToolDefTokens,
            compartmentsLocal: compartmentTokens,
            factsLocal: factTokens,
            memoriesLocal: memoryTokens,
            docsLocal: docsTokens,
            profileLocal: profileTokens,
            conversationLocal,
            toolCallsLocal,
            calibration,
        });

        const fresh: SidebarSnapshot = {
            sessionId,
            usagePercentage: effectiveUsagePercentage,
            inputTokens: effectiveInputTokens,
            contextLimit,
            native_context_usage_percentage: nativeContextUsagePercentage,
            compaction_enabled: compactionEnabled,
            systemPromptTokens: calibrated.systemTokens,
            compartmentCount,
            archivedCompartmentCount,
            memoryCount,
            memoryBlockCount,
            pendingOpsCount,
            historianRunning: moduleStatus?.wrapup_active === true || compartmentInProgress,
            compartmentInProgress: moduleStatus?.wrapup_active === true || compartmentInProgress,
            sessionNoteCount,
            readySmartNoteCount,
            cacheTtl,
            lastTransformError: meta?.last_transform_error
                ? String(meta.last_transform_error)
                : null,
            lastDreamerRunAt,
            projectIdentity,
            dreamerBacklog,
            dreamerProgress,
            ...(dreamerFailures === undefined ? {} : { dreamerFailures }),
            compartmentTokens: calibrated.compartmentTokens,
            factTokens: calibrated.factTokens,
            memoryTokens: calibrated.memoryTokens,
            docsTokens: calibrated.docsTokens,
            profileTokens: calibrated.profileTokens,
            conversationTokens: calibrated.conversationTokens,
            toolCallTokens: calibrated.toolCallTokens,
            toolDefinitionTokens: calibrated.toolDefinitionTokens,
            ...(hostLimitations.length > 0 ? { hostLimitations } : {}),
            ...(tailHygiene === undefined ? {} : { tailHygiene }),
            executeThreshold,
            executeThresholdClamped,
            boundaryPresent: moduleStatus?.boundary_present,
            coverageOrdinal: moduleStatus?.coverage_ordinal,
            newWorkTokens,
            totalInputTokens,
            recompProgress: (() => {
                const p = liveSessionState?.recompProgressBySession.get(sessionId);
                if (!p) return null;
                return {
                    kind: p.kind ?? "recomp",
                    phase: p.phase,
                    processedMessages: p.processedMessages,
                    totalMessages: p.totalMessages,
                    passCount: p.passCount,
                    compartmentsCreated: p.compartmentsCreated,
                    message: p.message,
                    note: p.note,
                };
            })(),
        };
        // Defensive sticky cache: if `inputTokens` briefly drops to 0 mid-turn
        // (intermittent — possibly streaming events with empty token shape, or
        // first-pass reset firing on existing-session messages), serve the
        // last good breakdown instead of letting the bar flicker.
        return applyStickySnapshotCache(sessionId, fresh);
    } catch (err) {
        log("[rpc] sidebar-snapshot error:", err);
        throw err;
    }
}

/** Convert snapshot-build failures into a transport-failure envelope. A genuine
 * zero snapshot remains a successful value so deleted sessions stay deleted. */
export function buildSidebarSnapshotRpcResponse(
    db: Database,
    sessionId: string,
    directory: string,
    liveSessionState?: LiveSessionState,
    injectionBudgetTokens?: number,
    config?: Record<string, unknown>,
    moduleStatus?: RustSessionStatus,
    compactionEnabled = true,
): Record<string, unknown> {
    try {
        return buildSidebarSnapshot(
            db,
            sessionId,
            directory,
            liveSessionState,
            injectionBudgetTokens,
            config,
            moduleStatus,
            compactionEnabled,
        ) as unknown as Record<string, unknown>;
    } catch {
        return { error: "sidebar snapshot unavailable" };
    }
}

/** The recorded maintenance-tick failure; storage trouble here reports none. */
function safeTickFailure(db: Database): DreamerTickFailure | null {
    try {
        return getDreamerTickFailure(db);
    } catch {
        return null;
    }
}

export function buildStatusDetail(
    db: Database,
    sessionId: string,
    directory: string,
    modelKey?: string,
    config?: Record<string, unknown>,
    liveSessionState?: LiveSessionState,
    injectionBudgetTokens?: number,
    moduleStatus?: RustSessionStatus,
    compactionEnabled = true,
): StatusDetail {
    const base = buildSidebarSnapshot(
        db,
        sessionId,
        directory,
        liveSessionState,
        injectionBudgetTokens,
        config,
        moduleStatus,
        compactionEnabled,
    );
    const rustMode = config?.transform_mode === "rust";
    const projectIdentity = rustMode ? resolveProjectIdentity(directory) : null;
    const moduleMemoryAuthority = moduleStatus?.authority?.memories;
    const moduleMemoryState = moduleMemoryAuthority?.state;
    const moduleFeedHead = moduleStatus?.memory_mirror?.feed_head;
    const moduleHistorian = moduleStatus?.historian;
    const historianRefusalDetail =
        moduleHistorian?.last_failure ?? moduleHistorian?.last_no_fire ?? null;
    const historianRefusal =
        moduleHistorian?.refusal_stage && moduleHistorian.canonical_cause && historianRefusalDetail
            ? {
                  stage: moduleHistorian.refusal_stage,
                  canonicalCause: moduleHistorian.canonical_cause,
                  detail: historianRefusalDetail,
              }
            : undefined;
    const liveConfig = currentPluginConfigReader(directory);
    const liveFailure = liveConfig?.lastFailure();
    const detail: StatusDetail = {
        ...base,
        configGeneration: liveConfig?.current().generation,
        configAdoptedAt: liveConfig?.current().adoptedAt,
        configReloadFailure: liveFailure
            ? { path: liveFailure.path, message: liveFailure.message }
            : undefined,
        memoryImportanceHistogram: emptyMemoryImportanceHistogram(),
        // Not project-scoped: the maintenance timer is one per process, and a
        // pass that ends early costs every project its work, so this is read
        // from the shared store rather than from a project's schedule rows.
        dreamerTickFailure: safeTickFailure(db),
        hiddenVariantWarnings: listHiddenVariantWarnings(),
        hostBackendsModuleSide: rustMode,
        memoryMirror: rustMode ? getMemoryMirrorStatus(db, moduleFeedHead) : undefined,
        compactionMarker: getCompactionMarkerHealth(db, sessionId),
        memoryAuthorityMismatch:
            rustMode &&
            moduleStatus?.authority !== undefined &&
            projectIdentity !== null &&
            getAuthorityManagedMarker(db, projectIdentity) !== null &&
            (moduleMemoryState === "TS" || moduleMemoryAuthority === null),
        activeProfile: typeof config?.profile === "string" ? config.profile : null,
        tagCounter: 0,
        activeTags: 0,
        droppedTags: 0,
        totalTags: 0,
        tagCountsAuthoritative: true,
        activeBytes: 0,
        lastResponseTime: 0,
        lastNudgeTokens: 0,
        lastTransformError: null,
        historianFailureCount: 0,
        historianRefusal,
        historianRunner: runnerStatusFromModule(moduleHistorian?.runner),
        dreamerRunner: runnerStatusFromModule(moduleStatus?.dreamer?.runner),
        isSubagent: false,
        pendingOps: [],
        contextLimit: 0,
        cacheTtlMs: 0,
        cacheRemainingMs: 0,
        cacheExpired: false,
        cacheTtlSource: "default",
        configParseFailures: [],
        cacheNeverExpires: false,
        executeThreshold: 65,
        executeThresholdMode: "percentage",
        protectedTagCount: 20,
        historyBudgetPercentage: 0.15,
        historyBlockTokens: 0,
        compressionBudget: null,
        compressionUsage: null,
        toastDurationMs: 5000,
        mural: undefined,
        loggerDiagnostics: getLoggerDiagnostics(),
        // Safe defaults; the live context.db value is filled in the try block below.
        storage_versions: {
            // null = the probe FAILED (read threw); 0 = probe succeeded on a fresh DB
            // with no migrations table; N = max applied upstream-lane migration
            // (version < 10000). Distinct values so a
            // reader never has to guess whether a falsy version means broken or empty
            // (fleet Q1 discrimination — SUBC status-surface contract).
            context_db_schema_version: null as number | null,
            plugin_supported_version: LATEST_SUPPORTED_VERSION,
        },
    };

    try {
        // Storage-version probe: live upstream migration lane vs this binary's fence. Fills the
        // safe default from above; getPersistedSchemaVersion itself returns 0 when
        // the migrations table is absent.
        detail.storage_versions = {
            context_db_schema_version: getPersistedSchemaVersion(db),
            plugin_supported_version: LATEST_SUPPORTED_VERSION,
        };
        if (base.projectIdentity) {
            detail.memoryImportanceHistogram = getActiveMemoryImportanceHistogram(
                db,
                base.projectIdentity,
            );
        }
        const muralConfig = config?.mural as { enabled?: boolean } | undefined;
        if (muralConfig?.enabled && base.projectIdentity) {
            const row = getMural(db, base.projectIdentity);
            detail.mural = {
                present: row !== null,
                ageMs: row ? Math.max(0, Date.now() - row.renderedAt) : null,
            };
        }
        let persistedCacheTtl = "5m";
        let persistedModelKey: string | null = null;
        const meta = db
            .prepare<[string], Record<string, unknown>>(
                "SELECT * FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId);
        if (meta) {
            detail.tagCounter = Number(meta.counter ?? 0);
            detail.lastResponseTime = Number(meta.last_response_time ?? 0);
            detail.lastNudgeTokens = Number(meta.last_nudge_tokens ?? 0);
            detail.lastTransformError = meta.last_transform_error
                ? String(meta.last_transform_error)
                : null;
            detail.historianFailureCount = Number(meta.historian_failure_count ?? 0);
            detail.isSubagent = Boolean(meta.is_subagent);
            persistedCacheTtl =
                typeof meta.cache_ttl === "string" && meta.cache_ttl.length > 0
                    ? meta.cache_ttl
                    : "5m";
            persistedModelKey =
                typeof meta.last_observed_model_key === "string" &&
                meta.last_observed_model_key.length > 0
                    ? meta.last_observed_model_key
                    : null;
        }

        // Tags
        try {
            const activeRow = db
                .prepare<[string], { count: number; bytes: number }>(
                    "SELECT COUNT(*) as count, COALESCE(SUM(byte_size), 0) as bytes FROM tags WHERE session_id = ? AND status = 'active'",
                )
                .get(sessionId);
            detail.activeTags = activeRow?.count ?? 0;
            detail.activeBytes = activeRow?.bytes ?? 0;
            const droppedRow = db
                .prepare<[string], { count: number }>(
                    "SELECT COUNT(*) as count FROM tags WHERE session_id = ? AND status = 'dropped'",
                )
                .get(sessionId);
            detail.droppedTags = droppedRow?.count ?? 0;
            detail.totalTags = detail.activeTags + detail.droppedTags;
            const observedProtectionFloor = getObservedEpochFloor(db, sessionId);
            if (observedProtectionFloor !== null) {
                detail.protectedTagCount = getProtectionWindowForSession(
                    db,
                    sessionId,
                    observedProtectionFloor,
                ).status.protectedCount;
            }
        } catch {
            // tags table might have different schema
        }
        if (typeof moduleStatus?.tag_count === "number") {
            // mc-store retains exact minted-tag totals but does not classify its rows with
            // context.db's active/dropped status vocabulary. Use the module total while
            // telling the TUI not to present host-mirror breakdowns as Rust authority truth.
            detail.totalTags = moduleStatus.tag_count;
            detail.tagCountsAuthoritative = false;
        }

        // Pending ops. The dialog only displays pendingOpsCount (computed
        // elsewhere); this array is unused by the UI, so cap it — without a LIMIT a
        // large pending queue serializes thousands of {tag_id, operation} rows over
        // RPC on every status poll for nothing.
        try {
            const ops = db
                .prepare<[string], { tag_id: number; operation: string }>(
                    "SELECT tag_id, operation FROM pending_ops WHERE session_id = ? LIMIT 100",
                )
                .all(sessionId);
            detail.pendingOps = ops.map((o) => ({ tagId: o.tag_id, operation: o.operation }));
        } catch {
            // pending_ops may not exist
        }

        const modelSlash = modelKey?.indexOf("/") ?? -1;
        if (modelKey && modelSlash > 0) {
            detail.windowGeometry = resolveContextWindowGeometry(
                modelKey.slice(0, modelSlash),
                modelKey.slice(modelSlash + 1),
                { db, sessionID: sessionId },
            );
        }

        // Derived context limit needed for tokens-based threshold resolution.
        const contextLimitForTokens =
            base.contextLimit > 0
                ? base.contextLimit
                : base.usagePercentage > 0
                  ? Math.round(base.inputTokens / (base.usagePercentage / 100))
                  : 0;

        // Config values (resolve per-model)
        if (config) {
            const pctCfg = config.execute_threshold_percentage as
                | number
                | { default: number; [k: string]: number }
                | undefined;
            const tokensCfg = config.execute_threshold_tokens as
                | { default?: number; [k: string]: number | undefined }
                | undefined;
            // Use the detail resolver so we can surface mode + absolute tokens
            // consistently with /ctx-status. Avoids the "progressive lookup drift"
            // where RPC and status-text disagreed on whether tokens mode was active.
            const thresholdDetail = resolveExecuteThresholdDetail(pctCfg ?? 65, modelKey, 65, {
                tokensConfig: tokensCfg,
                contextLimit: contextLimitForTokens || undefined,
                sessionId,
            });
            detail.executeThreshold = thresholdDetail.percentage;
            detail.executeThresholdMode = thresholdDetail.mode;
            detail.executeThresholdClamped = thresholdDetail.clamped;
            if (thresholdDetail.absoluteTokens !== undefined) {
                detail.executeThresholdTokens = thresholdDetail.absoluteTokens;
            }

            const ttlDisplay = resolveCacheTtlDisplay({
                configured: (config.cache_ttl ?? "5m") as MagicContextConfig["cache_ttl"],
                configuredExplicitly: config.cacheTtlConfigured === true,
                modelKey,
                sessionValue: persistedCacheTtl,
                sessionModelKey: persistedModelKey,
            });
            detail.cacheTtl = ttlDisplay.value;
            detail.cacheTtlSource = ttlDisplay.source;
            detail.cacheTtlModelKey = ttlDisplay.modelKey;
            detail.configParseFailures = Array.isArray(config.configParseFailures)
                ? (config.configParseFailures as ConfigParseFailure[])
                : [];

            if (typeof config.history_budget_percentage === "number") {
                detail.historyBudgetPercentage = config.history_budget_percentage;
            }
            detail.toastDurationMs = resolveConfigValue<number>(
                config,
                "toast_duration_ms",
                modelKey,
                5000,
            );
        }

        // Derived values
        if (base.contextLimit > 0) {
            detail.contextLimit = base.contextLimit;
        } else if (base.usagePercentage > 0) {
            detail.contextLimit = Math.round(base.inputTokens / (base.usagePercentage / 100));
        }
        detail.cacheTtlMs = safeParseTtl(detail.cacheTtl);
        if (detail.cacheTtlMs === Number.POSITIVE_INFINITY) {
            // Infinity does not survive JSON-RPC (JSON.stringify emits null), and
            // 0 would be indistinguishable from a fresh/expired lane to a consumer
            // that never learned the cacheNeverExpires convention. -1 is the
            // never-expires sentinel: the VALUES discriminate on their own
            // (-1 never / 0 expired-or-unset / N live), and the flag stays as a
            // convenience for consumers that prefer it.
            detail.cacheNeverExpires = true;
            detail.cacheTtlMs = -1;
        }
        if (detail.lastResponseTime > 0) {
            const elapsed = Date.now() - detail.lastResponseTime;
            if (detail.cacheNeverExpires) {
                detail.cacheRemainingMs = -1;
                detail.cacheExpired = false;
            } else {
                detail.cacheRemainingMs = Math.max(0, detail.cacheTtlMs - elapsed);
                detail.cacheExpired = detail.cacheRemainingMs === 0;
            }
        }

        if (base.projectIdentity) {
            try {
                const coverage = getEmbeddingCoverageStatus(db, base.projectIdentity, sessionId);
                const runState = getEmbedDrainUiStatus(
                    sessionId,
                    base.recompProgress ?? undefined,
                ).status;
                detail.embedding = {
                    state: !coverage.enabled
                        ? "off"
                        : runState !== "idle"
                          ? runState
                          : coverage.session.total > 0 &&
                              coverage.session.embedded >= coverage.session.total
                            ? "ready"
                            : "waiting",
                    indexed: coverage.session.embedded,
                    total: coverage.session.total,
                };
            } catch {
                detail.embedding = { state: "waiting", indexed: 0, total: 0 };
            }
        }

        // History compression
        try {
            const histTokens = base.compartmentTokens + base.factTokens;
            detail.historyBlockTokens = histTokens;

            if (detail.contextLimit > 0) {
                const budget = Math.floor(
                    detail.contextLimit *
                        (Math.min(detail.executeThreshold, 80) / 100) *
                        detail.historyBudgetPercentage,
                );
                detail.compressionBudget = budget;
                detail.compressionUsage = `${((histTokens / budget) * 100).toFixed(0)}%`;
            }
        } catch {
            // history-token derivation failure
        }
    } catch (err) {
        log("[rpc] status-detail error:", err);
    }

    return detail;
}

function buildEmbedDetail(
    db: Database,
    sessionId: string,
    dir: string,
    liveSessionState: LiveSessionState,
): EmbedDetail {
    const projectIdentity = resolveProjectIdentity(dir);
    const coverage = getEmbeddingCoverageStatus(db, projectIdentity, sessionId);
    const progress = liveSessionState.recompProgressBySession.get(sessionId);
    const drainUi = getEmbedDrainUiStatus(sessionId, progress);
    const statusText = formatEmbedStatusText(coverage, {
        status: drainUi.status,
        embedded: progress?.processedMessages,
        total: progress?.totalMessages,
    });
    return {
        enabled: coverage.enabled,
        model: coverage.model,
        provider: coverage.provider,
        ...(coverage.synapseDescriptor ? { synapseDescriptor: coverage.synapseDescriptor } : {}),
        session: coverage.session,
        memories: coverage.memories,
        commits: coverage.commits,
        statusText,
    };
}

export function buildCompartmentCount(
    db: Database,
    sessionId: string,
    moduleStatus?: RustSessionStatus,
): number {
    if (typeof moduleStatus?.compartment_count === "number") {
        return moduleStatus.compartment_count;
    }
    try {
        const row = db
            .prepare<[string], { count: number }>(
                "SELECT COUNT(*) as count FROM compartments WHERE session_id = ?",
            )
            .get(sessionId);
        return row?.count ?? 0;
    } catch {
        return 0;
    }
}

interface RuntimeDebugMemoryHolders {
    taggerCache?: {
        sessionCount: number;
        assignmentEntries: number;
        toolAccountingEntries: number;
        loadSignatureEntries: number;
        sessions: Array<{
            sessionId: string;
            assignments: number;
            toolAccounting: number;
        }>;
    };
    wireCache?: {
        snapshots: number;
        rawContentSnapshots: number;
        estimatedBytes: number;
        sessions: Array<{
            sessionId: string;
            rawMessages: number;
            wireMessages: number;
            rawContentSnapshots: number;
            estimatedBytes: number;
        }>;
    };
}

const EMPTY_TAGGER_HEAP_STATS = {
    sessionCount: 0,
    assignmentEntries: 0,
    toolAccountingEntries: 0,
    loadSignatureEntries: 0,
    sessions: [],
} satisfies NonNullable<RuntimeDebugMemoryHolders["taggerCache"]>;

const EMPTY_WIRE_HEAP_STATS = {
    snapshots: 0,
    rawContentSnapshots: 0,
    estimatedBytes: 0,
    sessions: [],
} satisfies NonNullable<RuntimeDebugMemoryHolders["wireCache"]>;

export function isDebugRpcEnabled(
    config: Pick<MagicContextConfig, "debug_rpc">,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return config.debug_rpc === true || env.MAGIC_CONTEXT_DEBUG_RPC === "1";
}

export function buildDebugMemoryUsage(
    runtimeHolders: RuntimeDebugMemoryHolders = {},
): DebugMemoryUsageResponse {
    const usage = process.memoryUsage();
    const lkg = getLkgSlotHeapStats();
    const tagger = runtimeHolders.taggerCache ?? EMPTY_TAGGER_HEAP_STATS;
    const wire = runtimeHolders.wireCache ?? EMPTY_WIRE_HEAP_STATS;
    const mirrors = getCompartmentMirrorHeapStats();
    const messageIndexQueue = getMessageIndexQueueHeapStats();
    const sessions = new Map<string, DebugMemoryHolders["sessions"][number]>();
    const session = (sessionId: string) => {
        let current = sessions.get(sessionId);
        if (!current) {
            current = {
                sessionId,
                lkgBytes: 0,
                taggerAssignments: 0,
                taggerToolAccounting: 0,
                wireRawMessages: 0,
                wireMessages: 0,
                wireContentSnapshots: 0,
                wireEstimatedBytes: 0,
            };
            sessions.set(sessionId, current);
        }
        return current;
    };
    for (const slot of lkg.sessions) session(slot.sessionId).lkgBytes += slot.bytes;
    for (const entry of tagger.sessions) {
        const target = session(entry.sessionId);
        target.taggerAssignments += entry.assignments;
        target.taggerToolAccounting += entry.toolAccounting;
    }
    for (const entry of wire.sessions) {
        const target = session(entry.sessionId);
        target.wireRawMessages += entry.rawMessages;
        target.wireMessages += entry.wireMessages;
        target.wireContentSnapshots += entry.rawContentSnapshots;
        target.wireEstimatedBytes += entry.estimatedBytes;
    }

    return {
        pid: process.pid,
        bunVersion:
            typeof Bun !== "undefined" && typeof Bun.version === "string"
                ? Bun.version
                : "unavailable",
        memoryUsage: {
            rss: usage.rss,
            heapTotal: usage.heapTotal,
            heapUsed: usage.heapUsed,
            external: usage.external,
            arrayBuffers: usage.arrayBuffers,
        },
        native: {
            sqlite: getSqliteMemoryStats(),
            tokenizer: getTokenizerNativeMemoryStats(),
            localEmbedding: getLocalEmbeddingNativeMemoryStats(),
            quickJs: getQuickJsNativeMemoryStats(),
        },
        holders: {
            lkgSlots: { count: lkg.count, totalBytes: lkg.totalBytes },
            taggerCache: {
                sessionCount: tagger.sessionCount,
                assignmentEntries: tagger.assignmentEntries,
                toolAccountingEntries: tagger.toolAccountingEntries,
                loadSignatureEntries: tagger.loadSignatureEntries,
            },
            wireCache: {
                snapshots: wire.snapshots,
                rawContentSnapshots: wire.rawContentSnapshots,
                estimatedBytes: wire.estimatedBytes,
            },
            compartmentMirrors: { entries: mirrors.entries },
            messageIndexQueue,
            sessions: [...sessions.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
        },
    };
}

async function writeSnapshotJson(
    path: string,
    snapshot: Record<string, unknown>,
    enforcePrivatePermissions: boolean,
): Promise<void> {
    const writer = createWriteStream(path, enforcePrivatePermissions ? { mode: 0o600 } : undefined);
    const writeChunk = async (chunk: string): Promise<void> => {
        if (!writer.write(chunk)) await once(writer, "drain");
    };
    const writeNumberArray = async (values: number[]): Promise<void> => {
        await writeChunk("[");
        const chunkSize = 50_000;
        for (let offset = 0; offset < values.length; offset += chunkSize) {
            if (offset > 0) await writeChunk(",");
            await writeChunk(values.slice(offset, offset + chunkSize).join(","));
        }
        await writeChunk("]");
    };

    try {
        await writeChunk("{");
        let first = true;
        for (const [key, value] of Object.entries(snapshot)) {
            if (!first) await writeChunk(",");
            first = false;
            await writeChunk(`${JSON.stringify(key)}:`);
            if ((key === "nodes" || key === "edges") && Array.isArray(value)) {
                await writeNumberArray(value as number[]);
            } else {
                await writeChunk(JSON.stringify(value));
            }
        }
        await writeChunk("}");
        writer.end();
        await once(writer, "finish");
    } catch (error) {
        writer.destroy();
        try {
            rmSync(path, { force: true });
        } catch {
            // Keep the original write failure when the best-effort partial-file cleanup also fails.
        }
        throw error;
    }
}

const DEFAULT_HEAP_SNAPSHOT_MAX_RSS_MB = 2048;

function resolveHeapSnapshotMaxRssBytes(): number {
    const raw = process.env.MAGIC_CONTEXT_DEBUG_HEAP_SNAPSHOT_MAX_RSS_MB;
    const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    const megabytes =
        Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEAP_SNAPSHOT_MAX_RSS_MB;
    return megabytes * 1024 * 1024;
}

async function generateDebugHeapSnapshot(
    storageDir: string,
    memory: DebugMemoryUsageResponse,
): Promise<DebugHeapSnapshotResponse> {
    if (typeof Bun === "undefined" || typeof Bun.generateHeapSnapshot !== "function") {
        throw new Error("Bun.generateHeapSnapshot is unavailable in this runtime");
    }
    // Bun walks the whole JSC heap synchronously to build the snapshot. On a
    // long-running serve (6.5 GB RSS, 2026-09-11) that walk tripped an
    // EXC_BREAKPOINT inside Bun and took the host down, so the endpoint refuses
    // above a resident-size ceiling instead of risking the process; the cheap
    // debug.memoryUsage counters remain available at any size.
    const rssBytes = memory.memoryUsage.rss;
    const maxRssBytes = resolveHeapSnapshotMaxRssBytes();
    if (rssBytes > maxRssBytes) {
        throw new Error(
            `heap snapshot refused: process rss ${Math.round(rssBytes / (1024 * 1024))} MiB exceeds the ${Math.round(maxRssBytes / (1024 * 1024))} MiB ceiling (MAGIC_CONTEXT_DEBUG_HEAP_SNAPSHOT_MAX_RSS_MB); use debug.memoryUsage instead`,
        );
    }

    const directory = join(storageDir, "heap-snapshots");
    const enforcePrivatePermissions = shouldEnforcePrivateStoragePermissions();
    mkdirSync(
        directory,
        enforcePrivatePermissions ? { recursive: true, mode: 0o700 } : { recursive: true },
    );
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(directory, `${timestamp}-${process.pid}.heapsnapshot`);

    let format: "jsc" | "v8" = "jsc";
    let snapshotVersion: number | undefined;
    let snapshot: Bun.HeapSnapshot | string;
    try {
        snapshot = Bun.generateHeapSnapshot();
        snapshotVersion = snapshot.version;
    } catch (jscError) {
        try {
            format = "v8";
            snapshot = Bun.generateHeapSnapshot("v8");
        } catch (v8Error) {
            throw new Error(
                `Heap snapshot generation failed (jsc=${String(jscError)}; v8=${String(v8Error)})`,
            );
        }
    }

    if (typeof snapshot === "string") {
        await Bun.write(path, snapshot);
    } else {
        await writeSnapshotJson(
            path,
            {
                ...snapshot,
                magicContext: {
                    capturedAt: Date.now(),
                    memory,
                },
            },
            enforcePrivatePermissions,
        );
    }
    if (enforcePrivatePermissions) {
        try {
            chmodSync(path, 0o600);
        } catch {
            // A tightening failure does not invalidate the completed diagnostic capture.
        }
    }
    return { ...memory, path, format, snapshotVersion };
}

/**
 * Register all RPC handlers on the server.
 */
export function registerRpcHandlers(
    rpcServer: MagicContextRpcServer,
    args: {
        directory: string;
        config: MagicContextConfig;
        client: unknown;
        liveSessionState: LiveSessionState;
        rustModeModuleClient?: RustModeModuleClient;
        hiddenCompletionExecutor?: HiddenCompletionExecutor;
        storageDir?: string;
        getDebugMemoryHolders?: () => RuntimeDebugMemoryHolders | undefined;
    },
): void {
    const { directory, config, liveSessionState, rustModeModuleClient } = args;
    // Resolve mode once at the RPC boundary. The TUI receives this data and
    // never reads the config itself.
    const compactionEnabled = isCompactionEnabled(config);

    // Read config as raw object for per-model resolution
    const rawConfig = config as unknown as Record<string, unknown>;
    const getNotificationParams = (sessionId: string) =>
        getLiveNotificationParams(
            sessionId,
            liveSessionState.liveModelBySession,
            liveSessionState.variantBySession,
            liveSessionState.agentBySession,
            currentPluginConfigReader(directory)?.poll().effective.toast_duration_ms ??
                config.toast_duration_ms,
        );

    const injectionBudgetTokens = config.memory?.injection_budget_tokens;

    if (isDebugRpcEnabled(config)) {
        const readMemory = () => buildDebugMemoryUsage(args.getDebugMemoryHolders?.());
        rpcServer.handle("debug.memoryUsage", async () => ({ ...readMemory() }));
        rpcServer.handle("debug.heapSnapshot", async () => ({
            ...(await generateDebugHeapSnapshot(
                args.storageDir ?? getMagicContextStorageDir(),
                readMemory(),
            )),
        }));
    }

    rpcServer.handle("sidebar-snapshot", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        const dir = String(params.directory ?? directory);
        const db = getDb();
        if (!db || !sessionId) return { error: "unavailable" };
        const rustMode = config.transform_mode === "rust";
        const moduleStatus = rustMode
            ? await loadRustSessionStatus(rustModeModuleClient, sessionId, dir)
            : undefined;
        if (rustMode && !moduleStatus) {
            return {
                error: "Rust module status unavailable; canonical session state was not read",
            };
        }
        return buildSidebarSnapshotRpcResponse(
            db,
            sessionId,
            dir,
            liveSessionState,
            injectionBudgetTokens,
            rawConfig,
            moduleStatus,
            compactionEnabled,
        );
    });

    rpcServer.handle("status-detail", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        const dir = String(params.directory ?? directory);
        const modelKey = params.modelKey ? String(params.modelKey) : undefined;
        const db = getDb();
        if (!db || !sessionId) return { error: "unavailable" };
        const rustMode = config.transform_mode === "rust";
        const moduleStatus = rustMode
            ? await loadRustSessionStatus(rustModeModuleClient, sessionId, dir)
            : undefined;
        if (rustMode && !moduleStatus) {
            return {
                error: "Rust module status unavailable; canonical session state was not read",
            };
        }
        const detail = buildStatusDetail(
            db,
            sessionId,
            dir,
            modelKey,
            rawConfig,
            liveSessionState,
            injectionBudgetTokens,
            moduleStatus,
            compactionEnabled,
        );
        // Name the tasks this host cannot run. Only the RPC boundary knows which
        // completion transport the host supplies, and a user who never sees the
        // list has no way to tell a task that is unavailable here from one that
        // simply has no backlog.
        if (args.hiddenCompletionExecutor?.capabilities.tools === false) {
            detail.dreamerUnsupportedTasks = toolLoopDreamTasks();
        }
        return detail as unknown as Record<string, unknown>;
    });

    rpcServer.handle("embed-detail", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        const dir = String(params.directory ?? directory);
        const db = getDb();
        if (!db || !sessionId) return { error: "unavailable" };
        try {
            return buildEmbedDetail(db, sessionId, dir, liveSessionState) as unknown as Record<
                string,
                unknown
            >;
        } catch (err) {
            log("[rpc] embed-detail error:", err);
            return { error: "unavailable" };
        }
    });

    rpcServer.handle("compartment-count", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        const dir = String(params.directory ?? directory);
        const db = getDb();
        if (!db || !sessionId) return { count: 0 };
        const rustMode = config.transform_mode === "rust";
        const moduleStatus = rustMode
            ? await loadRustSessionStatus(rustModeModuleClient, sessionId, dir)
            : undefined;
        if (rustMode && !moduleStatus) {
            return {
                count: 0,
                error: "Rust module status unavailable; canonical compartment count was not read",
            };
        }
        return { count: buildCompartmentCount(db, sessionId, moduleStatus) };
    });

    // Under TypeScript authority, the RPC dialogs share the same recomp
    // orchestrator as the /ctx-* commands. Rust authority branches below: recomp
    // goes to session.recomp because the module owns state.
    const buildManagedCtx = async (
        db: NonNullable<ReturnType<typeof getDb>>,
    ): Promise<ManagedRecompContext> => {
        const { deriveHistorianChunkTokens, resolveHistorianContextLimit } = await import(
            "../hooks/magic-context/derive-budgets"
        );
        const { resolveHistorianModel } = await import("../shared/model-resolution");
        const { userMemoryCollectionEnabled } = await import(
            "../features/magic-context/dreamer/task-config"
        );
        const DEFAULT_HISTORIAN_TIMEOUT_MS = 10 * 60 * 1000;
        const runConfig = historianRunConfig(
            config,
            currentPluginConfigReader(directory)?.poll().effective ?? config,
        );
        const historianModel = resolveHistorianModel(runConfig, "opencode");
        return {
            client: args.client as ManagedRecompContext["client"],
            hiddenCompletionExecutor: args.hiddenCompletionExecutor,
            db,
            liveSessionState,
            directory,
            historianChunkTokens: deriveHistorianChunkTokens(
                resolveHistorianContextLimit(historianModel.primary?.model),
            ),
            historianTimeoutMs: runConfig.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
            memoryEnabled: config.memory?.enabled ?? true,
            autoPromote: runConfig.memory?.auto_promote ?? true,
            historianModel: historianModel.primary,
            fallbackModels: historianModel.fallbacks,
            userMemoriesEnabled: userMemoryCollectionEnabled(runConfig.dreamer),
            historianTwoPass: runConfig.historian?.two_pass === true,
            getNotificationParams: (sessionId) =>
                getLiveNotificationParams(
                    sessionId,
                    liveSessionState.liveModelBySession,
                    liveSessionState.variantBySession,
                    liveSessionState.agentBySession,
                    runConfig.toast_duration_ms,
                ),
        };
    };

    rpcServer.handle("recomp", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "no session" };
        const dir = String(params.directory ?? directory);
        if (config.transform_mode === "rust") {
            return executeRustRecompRpc(rustModeModuleClient, sessionId, dir);
        }
        const db = getDb();
        if (!db) return { ok: false, error: "db unavailable" };

        const { runManagedRecomp } = await import("../hooks/magic-context/recomp-orchestrator");
        const { sendIgnoredMessage } = await import(
            "../hooks/magic-context/send-session-notification"
        );
        log(`[rpc] recomp requested for session ${sessionId}`);
        const ctx = await buildManagedCtx(db);
        // Fire-and-forget; outcome is force-persisted so a multi-minute recomp's
        // result stays visible in scrollback instead of a 5s toast.
        void runManagedRecomp(ctx, sessionId)
            .then((message) => {
                void sendIgnoredMessage(
                    args.client,
                    sessionId,
                    message,
                    getNotificationParams(sessionId),
                    true,
                ).catch(() => {});
            })
            .catch((error: unknown) => log("[rpc] recomp failed:", error));
        return { ok: true };
    });

    // The three handlers below exist for a host whose only command seam is the
    // TUI (OpenCode 2 registers /ctx-* through its keymap layer, and its lane
    // never runs the OpenCode 1 `command.execute.before` hook). Each performs the
    // same server-side work as the matching command branch and returns its text,
    // so the caller can render it in a dialog or toast instead of a chat row.
    const compactionOffRefusal = (command: string): string =>
        `Magic Context compaction is disabled (${COMPACTION_ENABLED_PATH}: false) — /${command} manages compacted history and has no effect in this mode.`;

    /** Show a completed background run's text on whichever TUI is listening. */
    const pushResultDialog = (sessionId: string, title: string, message: string): void => {
        pushNotification("action", { action: "show-result-dialog", title, message }, sessionId);
    };

    rpcServer.handle("flush", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "no session" };
        if (!compactionEnabled) return { ok: true, message: compactionOffRefusal("ctx-flush") };
        let message: string;
        if (config.transform_mode === "rust" && rustModeModuleClient) {
            try {
                const response = await rustModeModuleClient.call({
                    sessionId,
                    projectRoot: String(params.directory ?? directory),
                    method: "session.flush",
                    body: { method: "session.flush", v: 1, session_id: sessionId },
                });
                const value = (response ?? {}) as Record<string, unknown>;
                message =
                    value.armed === false
                        ? "No pending operations to flush."
                        : "Flushed: Changes take effect on next message.";
            } catch (error) {
                log("[rpc] flush failed:", error);
                return { ok: false, error: renderCapabilityRefusal("context_cleanup") };
            }
        } else {
            const db = getDb();
            if (!db) return { ok: false, error: "db unavailable" };
            message = executeFlush(db, sessionId);
        }
        // The user asked for a full refresh, so signal all three one-shot sets:
        // rebuild <session-history>, re-read the system-prompt adjuncts, and force
        // the queued drops to materialize. That makes the next request a priced
        // pass instead of leaving the flush invisible until one happens anyway.
        liveSessionState.historyRefreshSessions.add(sessionId);
        liveSessionState.systemPromptRefreshSessions.add(sessionId);
        liveSessionState.pendingMaterializationSessions.add(sessionId);
        return { ok: true, message };
    });

    rpcServer.handle("wrapup", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "no session" };
        if (!compactionEnabled) return { ok: true, message: compactionOffRefusal("ctx-wrapup") };
        const requested = Number(params.messagesToKeep ?? 20);
        const messagesToKeep = Number.isSafeInteger(requested) && requested > 0 ? requested : 20;
        if (config.transform_mode === "rust") {
            return { ok: false, error: renderCapabilityRefusal("history_compression") };
        }
        const db = getDb();
        if (!db) return { ok: false, error: "db unavailable" };

        const { runManagedWrapup } = await import("../hooks/magic-context/wrapup-orchestrator");
        const model = liveSessionState.liveModelBySession.get(sessionId);
        const contextLimit = model
            ? resolveContextLimit(model.providerID, model.modelID, { db, sessionID: sessionId })
            : 128_000;
        const ctx = {
            ...(await buildManagedCtx(db)),
            contextLimit,
            executeThresholdPercentage: resolveExecuteThresholdDetail(
                config.execute_threshold_percentage ?? 65,
                model ? `${model.providerID}/${model.modelID}` : undefined,
                65,
                {
                    tokensConfig: config.execute_threshold_tokens,
                    contextLimit,
                    sessionId,
                },
            ).percentage,
            hasPendingNaturalBust: (sid: string) =>
                liveSessionState.historyRefreshSessions.has(sid) ||
                liveSessionState.systemPromptRefreshSessions.has(sid) ||
                liveSessionState.pendingMaterializationSessions.has(sid),
        };
        log(`[rpc] wrapup requested for session ${sessionId} (keep ${messagesToKeep})`);
        // Fire-and-forget: a wrapup runs the historian over the live tail and can
        // take minutes, which is far longer than an RPC caller can wait.
        void runManagedWrapup(ctx, sessionId, { messagesToKeep })
            .then((message) => pushResultDialog(sessionId, "Wrapup", message))
            .catch((error: unknown) => log("[rpc] wrapup failed:", error));
        return { ok: true, started: true };
    });

    rpcServer.handle("embed", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "no session" };
        const db = getDb();
        if (!db) return { ok: false, error: "db unavailable" };
        const action = String(params.action ?? "status");
        const embedDeps: EmbedHistoryDeps = {
            db,
            resolveDirectory: (id) =>
                liveSessionState.sessionDirectoryBySession.get(id) ??
                String(params.directory ?? directory),
            allowHomeProject: config.allow_home_project,
            recompProgressBySession: liveSessionState.recompProgressBySession,
        };
        if (action === "pause") {
            return { ok: true, message: pauseEmbedHistoryDrain(embedDeps, sessionId) };
        }
        if (action === "start") {
            log(`[rpc] embed start requested for session ${sessionId}`);
            // Same reason as wrapup: a backfill over a long session's compartments
            // outlives the request, so the outcome arrives as a dialog.
            void runEmbedHistoryDrain(embedDeps, sessionId)
                .then((message) => pushResultDialog(sessionId, "Embed", message))
                .catch((error: unknown) => log("[rpc] embed start failed:", error));
            return { ok: true, started: true };
        }
        try {
            return {
                ok: true,
                message: buildEmbedDetail(
                    db,
                    sessionId,
                    String(params.directory ?? directory),
                    liveSessionState,
                ).statusText,
            };
        } catch (error) {
            log("[rpc] embed status error:", error);
            return { ok: false, error: "unavailable" };
        }
    });

    rpcServer.handle("toast-duration", async () => {
        const duration =
            currentPluginConfigReader(directory)?.poll().effective.toast_duration_ms ??
            config.toast_duration_ms;
        const resolved =
            typeof duration === "number" && Number.isFinite(duration) ? duration : 5000;
        return { toastDurationMs: resolved };
    });

    // Server→TUI notification delivery is no longer an HTTP poll. The TUI holds a
    // persistent WebSocket (rpc-server `/ws`); the server pushes each queued
    // notification over it and replays the unacked backlog on the hello. See
    // rpc-server.ts + rpc-notifications.ts.

    // Startup announcement — called by the TUI plugin once per session to decide
    // whether to show the "What's new" dialog. We deliberately read state via
    // the file in getMagicContextStorageDir() (not an SQLite table) so that
    // both OpenCode and Pi share one source of truth and a dismissal in either
    // harness suppresses the dialog in the other for the same announcement.
    rpcServer.handle("get-announcement", async () => {
        // shouldShowAnnouncement already covers the empty-version / empty-features
        // case as "nothing to show", so this is the single gate.
        if (!shouldShowAnnouncement()) {
            return { show: false } as unknown as Record<string, unknown>;
        }
        return {
            show: true,
            version: ANNOUNCEMENT_VERSION,
            features: [...ANNOUNCEMENT_FEATURES],
            footer: ANNOUNCEMENT_FOOTER,
        } as unknown as Record<string, unknown>;
    });

    rpcServer.handle("mark-announced", async () => {
        if (ANNOUNCEMENT_VERSION) {
            markAnnouncementSeen(ANNOUNCEMENT_VERSION);
        }
        return { ok: true } as unknown as Record<string, unknown>;
    });
}
