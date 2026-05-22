/**
 * Server-side RPC handlers. Queries the server's own SQLite DB
 * and returns typed responses for TUI consumption.
 */
import type { MagicContextConfig } from "../config/schema/magic-context";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import { getEmbeddingCoverageStatus } from "../features/magic-context/project-embedding-registry";
import {
    type ContextDatabase as Database,
    openDatabase,
    setSessionWorkMetrics,
} from "../features/magic-context/storage";
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
import { drainNotifications } from "../shared/rpc-notifications";
import type { MagicContextRpcServer } from "../shared/rpc-server";
import type { EmbedDetail, SidebarSnapshot, StatusDetail } from "../shared/rpc-types";
import { applyStickySnapshotCache } from "./sidebar-snapshot-cache";

// Per-process incremental work-metrics state, keyed by session. The RPC server
// is long-lived, so the carry survives across polls and each poll folds only
// assistant rows newer than its watermark (≈0 when idle). Lost on restart —
// the next poll cold-starts from the persisted session_meta value's session by
// re-folding once, which is the acceptable one-time cost design A accepts.
const workMetricsCarryBySession = new Map<string, WorkMetricsCarry>();

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

function parseTtlString(ttl: string): number {
    const match = ttl.match(/^(\d+)(s|m|h)$/);
    if (!match) return 5 * 60 * 1000;
    const val = Number.parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
        case "s":
            return val * 1000;
        case "m":
            return val * 60 * 1000;
        case "h":
            return val * 3600 * 1000;
        default:
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
): SidebarSnapshot {
    const empty: SidebarSnapshot = {
        sessionId,
        usagePercentage: 0,
        inputTokens: 0,
        contextLimit: 0,
        systemPromptTokens: 0,
        compartmentCount: 0,
        factCount: 0,
        memoryCount: 0,
        memoryBlockCount: 0,
        pendingOpsCount: 0,
        historianRunning: false,
        compartmentInProgress: false,
        sessionNoteCount: 0,
        readySmartNoteCount: 0,
        cacheTtl: "5m",
        lastDreamerRunAt: null,
        projectIdentity: null,
        compartmentTokens: 0,
        factTokens: 0,
        memoryTokens: 0,
        docsTokens: 0,
        profileTokens: 0,
        conversationTokens: 0,
        toolCallTokens: 0,
        toolDefinitionTokens: 0,
        executeThreshold: 65,
        newWorkTokens: null,
        totalInputTokens: null,
    };

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
        const compartmentCount = compartmentRow?.count ?? 0;

        // v2: facts are retired as a render source (promoted to memories), so the
        // sidebar reports 0 facts rather than counting the vestigial session_facts
        // table — a non-zero count would mislead operators into thinking facts
        // still render in <session-history>.
        const factCount = 0;

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
        });
        const compartmentTokens = m0Blocks.compartmentTokens;
        const factTokens = m0Blocks.factTokens;
        const memoryTokens = m0Blocks.memoryTokens;
        const docsTokens = m0Blocks.docsTokens;
        const profileTokens = m0Blocks.profileTokens;

        let lastDreamerRunAt: number | null = null;
        if (projectIdentity) {
            try {
                const dreamRow = db
                    .prepare<[string], { value: string }>(
                        "SELECT value FROM dream_state WHERE key = ?",
                    )
                    .get(`last_dream_at:${projectIdentity}`);
                if (dreamRow?.value) {
                    lastDreamerRunAt = Number(dreamRow.value) || null;
                }
            } catch {
                // dream_state may not exist
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
            activeProviderID && activeModelID
                ? resolveContextLimit(activeProviderID, activeModelID, { db, sessionID: sessionId })
                : 0;

        // Resolve the effective execute-threshold percentage for this
        // session's active model so the sidebar header can show
        // "47.5% / 65%" alongside the absolute "475K / 1.0M". Falls back
        // to 65% (the runtime default) when no live model is known yet
        // or when no config was passed in. Mirrors the resolution flow
        // used by `buildStatusDetail` so the dialog and sidebar agree.
        let executeThreshold = 65;
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
        }

        const calibration = resolveModelCalibration(activeProviderID, activeModelID);
        const calibrated = calibrateBuckets({
            inputTokens,
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
            usagePercentage,
            inputTokens,
            contextLimit,
            systemPromptTokens: calibrated.systemTokens,
            compartmentCount,
            factCount,
            memoryCount,
            memoryBlockCount,
            pendingOpsCount,
            historianRunning: compartmentInProgress,
            compartmentInProgress,
            sessionNoteCount,
            readySmartNoteCount,
            cacheTtl,
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
        // Preserve live recomp/upgrade progress even when the full snapshot build
        // throws (e.g. a concurrent BEGIN-IMMEDIATE publish makes a DB read hit
        // SQLITE_BUSY mid-recomp). Without this, a transient build failure emits a
        // progress-less snapshot and the TUI's recomp poll would lose the bar
        // (dogfood 2026-05-30).
        const p = liveSessionState?.recompProgressBySession.get(sessionId);
        if (!p) return empty;
        return {
            ...empty,
            recompProgress: {
                kind: p.kind ?? "recomp",
                phase: p.phase,
                processedMessages: p.processedMessages,
                totalMessages: p.totalMessages,
                passCount: p.passCount,
                compartmentsCreated: p.compartmentsCreated,
                message: p.message,
                note: p.note,
            },
        };
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
): StatusDetail {
    const base = buildSidebarSnapshot(
        db,
        sessionId,
        directory,
        liveSessionState,
        injectionBudgetTokens,
        config,
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
        executeThreshold: 65,
        executeThresholdMode: "percentage",
        protectedTagCount: 20,
        historyBudgetPercentage: 0.15,
        historyBlockTokens: 0,
        compressionBudget: null,
        compressionUsage: null,
        toastDurationMs: 5000,
    };

    try {
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
        detail.cacheTtlMs = parseTtlString(detail.cacheTtl);
        if (detail.lastResponseTime > 0) {
            const elapsed = Date.now() - detail.lastResponseTime;
            detail.cacheRemainingMs = Math.max(0, detail.cacheTtlMs - elapsed);
            detail.cacheExpired = detail.cacheRemainingMs === 0;
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
    },
): void {
    const { directory, config, liveSessionState } = args;

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
        return buildSidebarSnapshot(
            db,
            sessionId,
            dir,
            liveSessionState,
            injectionBudgetTokens,
            rawConfig,
        ) as unknown as Record<string, unknown>;
    });

    rpcServer.handle("status-detail", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        const dir = String(params.directory ?? directory);
        const modelKey = params.modelKey ? String(params.modelKey) : undefined;
        const db = getDb();
        if (!db || !sessionId) return { error: "unavailable" };
        return buildStatusDetail(
            db,
            sessionId,
            dir,
            modelKey,
            rawConfig,
            liveSessionState,
            injectionBudgetTokens,
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
            userMemoriesEnabled: config.dreamer?.user_memories?.enabled === true,
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

    rpcServer.handle("pending-notifications", async (params) => {
        const lastReceivedId = Number(params.lastReceivedId ?? 0);
        // Scope drain to the TUI's active session so a notification tagged for a
        // different session (e.g. an upgrade dialog triggered by another client
        // sharing this process) is never delivered here. sessionId is optional
        // for back-compat: an older TUI that omits it falls back to the previous
        // unscoped behavior.
        const sessionId =
            typeof params.sessionId === "string" && params.sessionId.length > 0
                ? params.sessionId
                : undefined;
        const notifications = drainNotifications(
            Number.isFinite(lastReceivedId) ? lastReceivedId : 0,
            sessionId,
        );
        return { messages: notifications } as unknown as Record<string, unknown>;
    });

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
