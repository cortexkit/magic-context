/**
 * Server-side RPC handlers. Queries the server's own SQLite DB
 * and returns typed responses for TUI consumption.
 */
import { isCompactionEnabled } from "../config/agent-disable";
import type { MagicContextConfig } from "../config/schema/magic-context";
import { getMostRecentTaskRunAt } from "../features/magic-context/dreamer/storage-task-schedule";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import { getMural } from "../features/magic-context/mural/storage-mural";
import { getEmbeddingCoverageStatus } from "../features/magic-context/project-embedding-registry";
import { parseCacheTtl } from "../features/magic-context/scheduler";
import {
    type ContextDatabase as Database,
    openDatabase,
    setSessionWorkMetrics,
} from "../features/magic-context/storage";
import {
    getPersistedSchemaVersion,
    LATEST_SUPPORTED_VERSION,
} from "../features/magic-context/storage-db";
import { getMeasuredToolDefinitionTokens } from "../features/magic-context/tool-definition-tokens";
import {
    computeOpenCodeWorkMetricsIncremental,
    emptyWorkMetricsCarry,
    type WorkMetricsCarry,
} from "../features/magic-context/work-metrics";
import { getEmbedDrainUiStatus } from "../hooks/magic-context/embed-session-state";
import {
    resolveContextLimit,
    resolveExecuteThresholdDetail,
} from "../hooks/magic-context/event-resolvers";
import { formatEmbedStatusText } from "../hooks/magic-context/format-embed-status";
import { getLiveNotificationParams } from "../hooks/magic-context/hook-handlers";
import type { LiveSessionState } from "../hooks/magic-context/live-session-state";
import { computeM0BlockTokens } from "../hooks/magic-context/m0-token-breakdown";
import {
    findLastAssistantModelFromOpenCodeDb,
    openCodeDbExists,
    withReadOnlySessionDb,
} from "../hooks/magic-context/read-session-db";
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
import { log } from "../shared/logger";
import type { MagicContextRpcServer } from "../shared/rpc-server";
import type { EmbedDetail, SidebarSnapshot, StatusDetail } from "../shared/rpc-types";
import { applyStickySnapshotCache } from "./sidebar-snapshot-cache";

// Per-process incremental work-metrics state, keyed by session. The RPC server
// is long-lived, so the carry survives across polls and each poll folds only
// assistant rows newer than its watermark (≈0 when idle). Lost on restart —
// the next poll cold-starts from the persisted session_meta value's session by
// re-folding once, which is the acceptable one-time cost design A accepts.
const workMetricsCarryBySession = new Map<string, WorkMetricsCarry>();
const RUST_STATUS_CACHE_TTL_MS = 2_000;
export interface RustSessionStatus {
    usage?: { current_total_input_tokens?: number; context_limit_tokens?: number };
    boundary_present?: boolean;
    coverage_ordinal?: number | null;
    compartment_count?: number;
    compartment_tokens?: number;
    pending_drop_count?: number;
    pending_m1_delta?: boolean;
    pending_m1_age_ms?: number | null;
    wrapup_active?: boolean;
    wrapup_rounds?: number | null;
}
const rustStatusCache = new Map<string, { status: RustSessionStatus; cachedAt: number }>();

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

async function loadRustSessionStatus(
    client: RustModeModuleClient | undefined,
    sessionId: string,
    directory: string,
): Promise<RustSessionStatus | undefined> {
    if (!client) return undefined;
    const cached = rustStatusCache.get(sessionId);
    if (cached && Date.now() - cached.cachedAt < RUST_STATUS_CACHE_TTL_MS) {
        return cached.status;
    }
    try {
        const response = await client.call({
            sessionId,
            projectRoot: directory,
            method: "session.status",
            body: { method: "session.status", v: 1, session_id: sessionId },
        });
        const raw =
            response && typeof response === "object" ? (response as Record<string, unknown>) : {};
        const value =
            raw.result && typeof raw.result === "object"
                ? (raw.result as Record<string, unknown>)
                : raw;
        if (value.error || value.ok === false) return undefined;
        const status = value as RustSessionStatus;
        rustStatusCache.set(sessionId, { status, cachedAt: Date.now() });
        return status;
    } catch (error) {
        log(`[rpc] Rust session.status unavailable for ${sessionId}:`, error);
        return undefined;
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
        const m0Bytes = meta?.cached_m0_bytes;
        const m0Text =
            m0Bytes instanceof Uint8Array
                ? Buffer.from(m0Bytes).toString("utf8")
                : typeof m0Bytes === "string"
                  ? (m0Bytes as string)
                  : "";
        const m0Blocks = computeM0BlockTokens(db, sessionId, {
            m0Text,
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
        if (projectIdentity) {
            try {
                // Dreamer V2 retired the V1 dream_state['last_dream_at'] field;
                // the live "last successful run" is MAX(last_run_at) across the
                // project's task_schedule_state rows (issue #194).
                lastDreamerRunAt = getMostRecentTaskRunAt(db, projectIdentity);
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
        // execute threshold. Keep this measurement independent of persisted
        // threshold-relative state so the TUI cannot relabel a threshold fill.
        const nativeContextUsagePercentage =
            contextLimit > 0 ? (effectiveInputTokens / contextLimit) * 100 : undefined;

        const calibration = resolveModelCalibration(activeProviderID, activeModelID);
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
            compartmentTokens: calibrated.compartmentTokens,
            factTokens: calibrated.factTokens,
            memoryTokens: calibrated.memoryTokens,
            docsTokens: calibrated.docsTokens,
            profileTokens: calibrated.profileTokens,
            conversationTokens: calibrated.conversationTokens,
            toolCallTokens: calibrated.toolCallTokens,
            toolDefinitionTokens: calibrated.toolDefinitionTokens,
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
    const detail: StatusDetail = {
        ...base,
        tagCounter: 0,
        activeTags: 0,
        droppedTags: 0,
        totalTags: 0,
        activeBytes: 0,
        lastResponseTime: 0,
        lastNudgeTokens: 0,
        lastTransformError: null,
        isSubagent: false,
        pendingOps: [],
        contextLimit: 0,
        cacheTtlMs: 0,
        cacheRemainingMs: 0,
        cacheExpired: false,
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
        // Safe defaults; the live context.db value is filled in the try block below.
        storage_versions: {
            // null = the probe FAILED (read threw); 0 = probe succeeded on a fresh DB
            // with no migrations table; N = live schema version. Distinct values so a
            // reader never has to guess whether a falsy version means broken or empty
            // (fleet Q1 discrimination — SUBC status-surface contract).
            context_db_schema_version: null as number | null,
            plugin_supported_version: LATEST_SUPPORTED_VERSION,
        },
    };

    try {
        // Storage-version probe: live DB schema vs this binary's fence. Fills the
        // safe default from above; getPersistedSchemaVersion itself returns 0 when
        // the migrations table is absent.
        detail.storage_versions = {
            context_db_schema_version: getPersistedSchemaVersion(db),
            plugin_supported_version: LATEST_SUPPORTED_VERSION,
        };
        const muralConfig = (config?.experimental as { mural?: { enabled?: boolean } } | undefined)
            ?.mural;
        if (muralConfig?.enabled && base.projectIdentity) {
            const row = getMural(db, base.projectIdentity);
            detail.mural = {
                present: row !== null,
                ageMs: row ? Math.max(0, Date.now() - row.renderedAt) : null,
            };
        }
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
            detail.isSubagent = Boolean(meta.is_subagent);
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
        } catch {
            // tags table might have different schema
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

            const ct = resolveConfigValue<string>(config, "cache_ttl", modelKey, "5m");
            detail.cacheTtl = ct;

            if (typeof config.protected_tags === "number") {
                detail.protectedTagCount = config.protected_tags;
            }
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
            detail.cacheNeverExpires = true;
            detail.cacheTtlMs = 0;
        }
        if (detail.lastResponseTime > 0) {
            const elapsed = Date.now() - detail.lastResponseTime;
            if (detail.cacheNeverExpires) {
                // Infinity does not survive JSON-RPC; cacheNeverExpires is the
                // authoritative flag — the TUI keys on it first.
                detail.cacheRemainingMs = 0;
                detail.cacheExpired = false;
            } else {
                detail.cacheRemainingMs = Math.max(0, detail.cacheTtlMs - elapsed);
                detail.cacheExpired = detail.cacheRemainingMs === 0;
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
        session: coverage.session,
        memories: coverage.memories,
        commits: coverage.commits,
        statusText,
    };
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
            config.toast_duration_ms,
        );

    const injectionBudgetTokens = config.memory?.injection_budget_tokens;

    rpcServer.handle("sidebar-snapshot", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        const dir = String(params.directory ?? directory);
        const db = getDb();
        if (!db || !sessionId) return { error: "unavailable" };
        const moduleStatus =
            config.transform_mode === "rust"
                ? await loadRustSessionStatus(rustModeModuleClient, sessionId, dir)
                : undefined;
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
        const moduleStatus =
            config.transform_mode === "rust"
                ? await loadRustSessionStatus(rustModeModuleClient, sessionId, dir)
                : undefined;
        return buildStatusDetail(
            db,
            sessionId,
            dir,
            modelKey,
            rawConfig,
            liveSessionState,
            injectionBudgetTokens,
            moduleStatus,
            compactionEnabled,
        ) as unknown as Record<string, unknown>;
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
        const db = getDb();
        if (!db || !sessionId) return { count: 0 };
        try {
            const row = db
                .prepare<[string], { count: number }>(
                    "SELECT COUNT(*) as count FROM compartments WHERE session_id = ?",
                )
                .get(sessionId);
            return { count: row?.count ?? 0 };
        } catch {
            return { count: 0 };
        }
    });

    // ── Recomp / session-upgrade: delegate to the shared orchestrator ───────
    // The RPC dialog paths ("/ctx-recomp" + "Run upgrade now") run through the
    // SAME runManagedRecomp/runManagedUpgrade as the /ctx-* command paths, so
    // they get identical model fallback, live progress, terminal state, and
    // clean messaging. Dogfood 2026-05-30: the old RPC upgrade handler lacked
    // model fallback (failed when the primary historian model returned empty,
    // while /ctx-session-upgrade succeeded via fallback) and the command path
    // lacked progress (left the sidebar stuck on a stale "failed"). One runner
    // closes both gaps permanently.
    const buildManagedCtx = async (
        db: NonNullable<ReturnType<typeof getDb>>,
    ): Promise<ManagedRecompContext> => {
        const { deriveHistorianChunkTokens, resolveHistorianContextLimit } = await import(
            "../hooks/magic-context/derive-budgets"
        );
        const { resolveFallbackChain } = await import("../shared/resolve-fallbacks");
        const { userMemoryCollectionEnabled } = await import(
            "../features/magic-context/dreamer/task-config"
        );
        const DEFAULT_HISTORIAN_TIMEOUT_MS = 10 * 60 * 1000;
        return {
            client: args.client as ManagedRecompContext["client"],
            db,
            liveSessionState,
            directory,
            historianChunkTokens: deriveHistorianChunkTokens(
                resolveHistorianContextLimit(config.historian?.model),
            ),
            historianTimeoutMs: config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
            memoryEnabled: config.memory?.enabled ?? true,
            autoPromote: config.memory?.auto_promote ?? true,
            fallbackModels: resolveFallbackChain(config.historian?.fallback_models),
            runMigration: config.memory?.enabled !== false && !!config.historian?.model,
            userMemoriesEnabled: userMemoryCollectionEnabled(config.dreamer),
            historianTwoPass: config.historian?.two_pass === true,
            getNotificationParams,
        };
    };

    rpcServer.handle("recomp", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "no session" };
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

    // TUI-triggered `/ctx-session-upgrade`: full recomp + once-per-project memory
    // migration. Fired from the upgrade dialog's "Run upgrade now" action.
    rpcServer.handle("upgrade", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "no session" };
        const db = getDb();
        if (!db) return { ok: false, error: "db unavailable" };

        const { runManagedUpgrade } = await import("../hooks/magic-context/recomp-orchestrator");
        const { sendIgnoredMessage } = await import(
            "../hooks/magic-context/send-session-notification"
        );
        log(`[rpc] session-upgrade requested for session ${sessionId}`);
        const ctx = await buildManagedCtx(db);
        void runManagedUpgrade(ctx, sessionId)
            .then((message) => {
                void sendIgnoredMessage(
                    args.client,
                    sessionId,
                    message,
                    getNotificationParams(sessionId),
                    true, // force-persist: a multi-minute upgrade's outcome must stay visible
                ).catch(() => {});
            })
            .catch((error: unknown) => log("[rpc] session-upgrade failed:", error));
        return { ok: true };
    });

    // The user made an explicit choice on the upgrade dialog (Confirm or Cancel).
    // Set the durable stamp so the FRESH reminder won't re-show. We deliberately
    // do NOT stamp when the dialog is merely displayed — a display that the user
    // closed/ctrl-c'd before acting must re-show on the next process (dogfood
    // 2026-05-30). Resume prompts are staging-driven and unaffected by this stamp.
    rpcServer.handle("dismiss-upgrade-reminder", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "no session" };
        const db = getDb();
        if (!db) return { ok: false, error: "db unavailable" };
        try {
            const { updateSessionMeta } = await import(
                "../features/magic-context/storage-meta-session"
            );
            updateSessionMeta(db, sessionId, { upgradeRemindedAt: Date.now() });
            return { ok: true };
        } catch (error) {
            log("[rpc] dismiss-upgrade-reminder failed:", error);
            return { ok: false, error: String(error) };
        }
    });

    rpcServer.handle("toast-duration", async () => {
        const resolved =
            typeof config.toast_duration_ms === "number" &&
            Number.isFinite(config.toast_duration_ms)
                ? config.toast_duration_ms
                : 5000;
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
