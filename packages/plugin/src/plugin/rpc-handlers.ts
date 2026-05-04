/**
 * Server-side RPC handlers. Queries the server's own SQLite DB
 * and returns typed responses for TUI consumption.
 */
import type { MagicContextConfig } from "../config/schema/magic-context";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import { type ContextDatabase as Database, openDatabase } from "../features/magic-context/storage";
import { getMeasuredToolDefinitionTokens } from "../features/magic-context/tool-definition-tokens";
import { resolveExecuteThresholdDetail } from "../hooks/magic-context/event-resolvers";
import { getLiveNotificationParams } from "../hooks/magic-context/hook-handlers";
import type { LiveSessionState } from "../hooks/magic-context/live-session-state";
import { estimateTokens } from "../hooks/magic-context/read-session-formatting";
import {
    calibrateBuckets,
    resolveModelCalibration,
} from "../hooks/magic-context/tokenizer-calibration";
import { log } from "../shared/logger";
import { drainNotifications } from "../shared/rpc-notifications";
import type { MagicContextRpcServer } from "../shared/rpc-server";
import type { SidebarSnapshot, StatusDetail } from "../shared/rpc-types";
import { applyStickySnapshotCache } from "./sidebar-snapshot-cache";

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

function buildSidebarSnapshot(
    db: Database,
    sessionId: string,
    directory: string,
    liveSessionState?: LiveSessionState,
): SidebarSnapshot {
    const empty: SidebarSnapshot = {
        sessionId,
        usagePercentage: 0,
        inputTokens: 0,
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
        conversationTokens: 0,
        toolCallTokens: 0,
        toolDefinitionTokens: 0,
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

        const factRow = db
            .prepare<[string], { count: number }>(
                "SELECT COUNT(*) as count FROM session_facts WHERE session_id = ?",
            )
            .get(sessionId);
        const factCount = factRow?.count ?? 0;

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

        // Token estimates via real Claude tokenizer (ai-tokenizer).
        let compartmentTokens = 0;
        let factTokens = 0;
        let memoryTokens = 0;
        try {
            const compRows = db
                .prepare<
                    [string],
                    { content: string; title: string; start_message: number; end_message: number }
                >(
                    "SELECT content, title, start_message, end_message FROM compartments WHERE session_id = ?",
                )
                .all(sessionId);
            for (const c of compRows) {
                compartmentTokens += estimateTokens(
                    `<compartment start="${c.start_message}" end="${c.end_message}" title="${c.title}">\n${c.content}\n</compartment>\n`,
                );
            }
        } catch {
            /* compartments table may not exist */
        }
        try {
            const factRows = db
                .prepare<[string], { content: string }>(
                    "SELECT content FROM session_facts WHERE session_id = ?",
                )
                .all(sessionId);
            for (const f of factRows) {
                factTokens += estimateTokens(`* ${f.content}\n`);
            }
        } catch {
            /* session_facts table may not exist */
        }
        if (meta) {
            const cached = meta.memory_block_cache;
            if (typeof cached === "string" && cached.length > 0) {
                memoryTokens = estimateTokens(cached);
            }
        }

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
        const injectedInMessages = compartmentTokens + factTokens + memoryTokens;
        const conversationLocal = Math.max(0, messagesBlockTokens - injectedInMessages);
        const toolCallsLocal = Math.max(0, toolCallTokensRaw);

        // Measured tool schema cost. Resolved via the live-session-state latch
        // (session → agent/model). When the plugin hasn't fired tool.definition
        // yet for this session's current agent+model (brand-new session before
        // first turn, or post-restart before any flight), returns 0 and tool
        // defs are excluded from calibration until the measurement lands.
        let measuredToolDefTokens = 0;
        let activeProviderID: string | undefined;
        let activeModelID: string | undefined;
        if (liveSessionState) {
            const model = liveSessionState.liveModelBySession.get(sessionId);
            const agent = liveSessionState.agentBySession.get(sessionId);
            if (model) {
                activeProviderID = model.providerID;
                activeModelID = model.modelID;
                measuredToolDefTokens =
                    getMeasuredToolDefinitionTokens(model.providerID, model.modelID, agent) ?? 0;
            }
        }

        const calibration = resolveModelCalibration(activeProviderID, activeModelID);
        const calibrated = calibrateBuckets({
            inputTokens,
            systemLocal: systemPromptTokens,
            toolDefsLocal: measuredToolDefTokens,
            compartmentsLocal: compartmentTokens,
            factsLocal: factTokens,
            memoriesLocal: memoryTokens,
            conversationLocal,
            toolCallsLocal,
            calibration,
        });

        const fresh: SidebarSnapshot = {
            sessionId,
            usagePercentage,
            inputTokens,
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
            conversationTokens: calibrated.conversationTokens,
            toolCallTokens: calibrated.toolCallTokens,
            toolDefinitionTokens: calibrated.toolDefinitionTokens,
        };
        // Defensive sticky cache: if `inputTokens` briefly drops to 0 mid-turn
        // (intermittent — possibly streaming events with empty token shape, or
        // first-pass reset firing on existing-session messages), serve the
        // last good breakdown instead of letting the bar flicker.
        return applyStickySnapshotCache(sessionId, fresh);
    } catch (err) {
        log("[rpc] sidebar-snapshot error:", err);
        return empty;
    }
}

function buildStatusDetail(
    db: Database,
    sessionId: string,
    directory: string,
    modelKey?: string,
    config?: Record<string, unknown>,
    liveSessionState?: LiveSessionState,
): StatusDetail {
    const base = buildSidebarSnapshot(db, sessionId, directory, liveSessionState);
    const detail: StatusDetail = {
        ...base,
        tagCounter: 0,
        activeTags: 0,
        droppedTags: 0,
        totalTags: 0,
        activeBytes: 0,
        lastResponseTime: 0,
        lastNudgeTokens: 0,
        lastNudgeBand: "",
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
        nudgeInterval: 20000,
        historyBudgetPercentage: 0.15,
        nextNudgeAfter: 0,
        historyBlockTokens: 0,
        compressionBudget: null,
        compressionUsage: null,
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
            detail.lastNudgeBand = String(meta.last_nudge_band ?? "");
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

        // Pending ops
        try {
            const ops = db
                .prepare<[string], { tag_id: number; operation: string }>(
                    "SELECT tag_id, operation FROM pending_ops WHERE session_id = ?",
                )
                .all(sessionId);
            detail.pendingOps = ops.map((o) => ({ tagId: o.tag_id, operation: o.operation }));
        } catch {
            // pending_ops may not exist
        }

        // Derived context limit needed for tokens-based threshold resolution.
        const contextLimitForTokens =
            base.usagePercentage > 0
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

            if (typeof config.protected_tag_count === "number") {
                detail.protectedTagCount = config.protected_tag_count;
            }
            if (typeof config.nudge_interval_tokens === "number") {
                detail.nudgeInterval = config.nudge_interval_tokens;
            }
            if (typeof config.history_budget_percentage === "number") {
                detail.historyBudgetPercentage = config.history_budget_percentage;
            }
        }

        // Derived values
        if (base.usagePercentage > 0) {
            detail.contextLimit = Math.round(base.inputTokens / (base.usagePercentage / 100));
        }
        detail.cacheTtlMs = parseTtlString(detail.cacheTtl);
        if (detail.lastResponseTime > 0) {
            const elapsed = Date.now() - detail.lastResponseTime;
            detail.cacheRemainingMs = Math.max(0, detail.cacheTtlMs - elapsed);
            detail.cacheExpired = detail.cacheRemainingMs === 0;
        }
        detail.nextNudgeAfter = detail.lastNudgeTokens + detail.nudgeInterval;

        // History compression
        try {
            const compartments = db
                .prepare<
                    [string],
                    { content: string; title: string; start_message: number; end_message: number }
                >(
                    "SELECT content, title, start_message, end_message FROM compartments WHERE session_id = ?",
                )
                .all(sessionId);
            const facts = db
                .prepare<[string], { content: string }>(
                    "SELECT content FROM session_facts WHERE session_id = ?",
                )
                .all(sessionId);

            let histTokens = 0;
            for (const c of compartments) {
                histTokens += estimateTokens(
                    `<compartment start="${c.start_message}" end="${c.end_message}" title="${c.title}">\n${c.content}\n</compartment>\n`,
                );
            }
            for (const f of facts) {
                histTokens += estimateTokens(`* ${f.content}\n`);
            }
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
            // compartments/facts read failure
        }
    } catch (err) {
        log("[rpc] status-detail error:", err);
    }

    return detail;
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
        );

    rpcServer.handle("sidebar-snapshot", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        const dir = String(params.directory ?? directory);
        const db = getDb();
        if (!db || !sessionId) return { error: "unavailable" };
        return buildSidebarSnapshot(db, sessionId, dir, liveSessionState) as unknown as Record<
            string,
            unknown
        >;
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
        ) as unknown as Record<string, unknown>;
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

    rpcServer.handle("recomp", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "no session" };

        const { executeContextRecomp } = await import("../hooks/magic-context/compartment-runner");
        const { sendIgnoredMessage } = await import(
            "../hooks/magic-context/send-session-notification"
        );
        const { deriveHistorianChunkTokens, resolveHistorianContextLimit } = await import(
            "../hooks/magic-context/derive-budgets"
        );

        const db = getDb();
        if (!db) return { ok: false, error: "db unavailable" };

        const DEFAULT_HISTORIAN_TIMEOUT_MS = 10 * 60 * 1000;

        const historianChunkTokens = deriveHistorianChunkTokens(
            resolveHistorianContextLimit(config.historian?.model),
        );

        log(`[rpc] recomp requested for session ${sessionId}`);

        // Fire-and-forget: start recomp in background
        void executeContextRecomp({
            client: args.client as never,
            db,
            sessionId,
            historianChunkTokens,
            historianTimeoutMs: config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
            directory,
            // Issue #44: TUI-triggered recomp must respect memory feature gates
            // exactly the same way as server-triggered /ctx-recomp does.
            memoryEnabled: config.memory?.enabled,
            autoPromote: config.memory?.auto_promote ?? true,
            getNotificationParams: () => getNotificationParams(sessionId),
            // Recomp publication invalidates the injection cache and queues
            // drop ops. Signal the same two sets the hook-side recomp
            // signals (history rebuild + pending materialization) so the
            // next transform pass rebuilds `<session-history>` and
            // materializes the new drops. NOT systemPromptRefresh — recomp
            // doesn't change disk-backed adjuncts.
            //
            // Without these signals the TUI recomp would silently leave
            // injection cache stale, causing defer passes to render an
            // outdated history block until the next natural cache bust.
            onInjectionCacheCleared: (sid) => {
                liveSessionState.historyRefreshSessions.add(sid);
                liveSessionState.pendingMaterializationSessions.add(sid);
            },
        })
            .then((result: string) => {
                void sendIgnoredMessage(
                    args.client,
                    sessionId,
                    result,
                    getNotificationParams(sessionId),
                ).catch(() => {});
            })
            .catch((error: unknown) => {
                log("[rpc] recomp failed:", error);
            });

        return { ok: true };
    });

    rpcServer.handle("pending-notifications", async () => {
        const notifications = drainNotifications();
        return { messages: notifications } as unknown as Record<string, unknown>;
    });
}
