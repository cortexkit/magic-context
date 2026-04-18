/**
 * Server-side RPC handlers. Queries the server's own SQLite DB
 * and returns typed responses for TUI consumption.
 */
import type { Database } from "bun:sqlite";
import type { MagicContextConfig } from "../config/schema/magic-context";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import { openDatabase } from "../features/magic-context/storage";
import { getLiveNotificationParams } from "../hooks/magic-context/hook-handlers";
import type { LiveSessionState } from "../hooks/magic-context/live-session-state";
import { log } from "../shared/logger";
import { drainNotifications } from "../shared/rpc-notifications";
import type { MagicContextRpcServer } from "../shared/rpc-server";
import type { SidebarSnapshot, StatusDetail } from "../shared/rpc-types";

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

function buildSidebarSnapshot(db: Database, sessionId: string, directory: string): SidebarSnapshot {
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
        toolTokens: 0,
    };

    try {
        const projectIdentity = resolveProjectIdentity(directory);

        const meta = db
            .query<Record<string, unknown>, [string]>(
                "SELECT * FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId);

        const usagePercentage = meta
            ? Number(meta.last_context_percentage ?? meta.last_usage_percentage ?? 0)
            : 0;
        const inputTokens = meta ? Number(meta.last_input_tokens ?? 0) : 0;
        const systemPromptTokens = meta ? Number(meta.system_prompt_tokens ?? 0) : 0;
        // messagesBlockTokens = token estimate of output.messages[] after
        // transform, persisted by transform.ts. Includes injected
        // compartments/facts/memories (they're in message[0]).
        const messagesBlockTokens = meta ? Number(meta.conversation_tokens ?? 0) : 0;
        const compartmentInProgress = meta ? Boolean(meta.compartment_in_progress) : false;
        const cacheTtl = meta ? String(meta.cache_ttl ?? "5m") : "5m";
        const memoryBlockCount = meta ? Number(meta.memory_block_count ?? 0) : 0;

        const compartmentRow = db
            .query<{ count: number }, [string]>(
                "SELECT COUNT(*) as count FROM compartments WHERE session_id = ?",
            )
            .get(sessionId);
        const compartmentCount = compartmentRow?.count ?? 0;

        const factRow = db
            .query<{ count: number }, [string]>(
                "SELECT COUNT(*) as count FROM session_facts WHERE session_id = ?",
            )
            .get(sessionId);
        const factCount = factRow?.count ?? 0;

        let memoryCount = 0;
        if (projectIdentity) {
            const memRow = db
                .query<{ count: number }, [string]>(
                    "SELECT COUNT(*) as count FROM memories WHERE project_path = ? AND status = 'active'",
                )
                .get(projectIdentity);
            memoryCount = memRow?.count ?? 0;
        }

        let pendingOpsCount = 0;
        try {
            const pendingRow = db
                .query<{ count: number }, [string]>(
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
                .query<{ count: number }, [string]>(
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
                    .query<{ count: number }, [string]>(
                        "SELECT COUNT(*) as count FROM notes WHERE project_path = ? AND type = 'smart' AND status = 'ready'",
                    )
                    .get(projectIdentity);
                readySmartNoteCount = smartRow?.count ?? 0;
            } catch {
                // notes table may not exist
            }
        }

        // Token estimates (~3.5 chars/token)
        let compartmentTokens = 0;
        let factTokens = 0;
        let memoryTokens = 0;
        try {
            const compRows = db
                .query<
                    { content: string; title: string; start_message: number; end_message: number },
                    [string]
                >(
                    "SELECT content, title, start_message, end_message FROM compartments WHERE session_id = ?",
                )
                .all(sessionId);
            for (const c of compRows) {
                compartmentTokens += Math.ceil(
                    `<compartment start="${c.start_message}" end="${c.end_message}" title="${c.title}">\n${c.content}\n</compartment>\n`
                        .length / 3.5,
                );
            }
        } catch {
            /* compartments table may not exist */
        }
        try {
            const factRows = db
                .query<{ content: string }, [string]>(
                    "SELECT content FROM session_facts WHERE session_id = ?",
                )
                .all(sessionId);
            for (const f of factRows) {
                factTokens += Math.ceil(`* ${f.content}\n`.length / 3.5);
            }
        } catch {
            /* session_facts table may not exist */
        }
        if (meta) {
            const cached = meta.memory_block_cache;
            if (typeof cached === "string" && cached.length > 0) {
                memoryTokens = Math.ceil(cached.length / 3.5);
            }
        }

        let lastDreamerRunAt: number | null = null;
        if (projectIdentity) {
            try {
                const dreamRow = db
                    .query<{ value: string }, [string]>(
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

        // Display-layer attribution: messagesBlockTokens is the transform's
        // persisted estimate of all messages sent to the provider (includes
        // injected compartments/facts/memories). Strip those injected bits to
        // isolate real user/assistant conversation. Tools is the remainder of
        // inputTokens after accounting for system prompt and messages block.
        const injectedInMessages = compartmentTokens + factTokens + memoryTokens;
        const conversationTokens = Math.max(0, messagesBlockTokens - injectedInMessages);
        const toolTokens = Math.max(
            0,
            inputTokens - systemPromptTokens - messagesBlockTokens,
        );

        return {
            sessionId,
            usagePercentage,
            inputTokens,
            systemPromptTokens,
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
            compartmentTokens,
            factTokens,
            memoryTokens,
            conversationTokens,
            toolTokens,
        };
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
): StatusDetail {
    const base = buildSidebarSnapshot(db, sessionId, directory);
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
            .query<Record<string, unknown>, [string]>(
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
                .query<{ count: number; bytes: number }, [string]>(
                    "SELECT COUNT(*) as count, COALESCE(SUM(byte_size), 0) as bytes FROM tags WHERE session_id = ? AND status = 'active'",
                )
                .get(sessionId);
            detail.activeTags = activeRow?.count ?? 0;
            detail.activeBytes = activeRow?.bytes ?? 0;
            const droppedRow = db
                .query<{ count: number }, [string]>(
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
                .query<{ tag_id: number; operation: string }, [string]>(
                    "SELECT tag_id, operation FROM pending_ops WHERE session_id = ?",
                )
                .all(sessionId);
            detail.pendingOps = ops.map((o) => ({ tagId: o.tag_id, operation: o.operation }));
        } catch {
            // pending_ops may not exist
        }

        // Config values (resolve per-model)
        if (config) {
            const etp = resolveConfigValue<number>(
                config,
                "execute_threshold_percentage",
                modelKey,
                65,
            );
            detail.executeThreshold = Math.min(etp, 80);

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
                .query<
                    { content: string; title: string; start_message: number; end_message: number },
                    [string]
                >(
                    "SELECT content, title, start_message, end_message FROM compartments WHERE session_id = ?",
                )
                .all(sessionId);
            const facts = db
                .query<{ content: string }, [string]>(
                    "SELECT content FROM session_facts WHERE session_id = ?",
                )
                .all(sessionId);

            let histTokens = 0;
            for (const c of compartments) {
                histTokens += Math.ceil(
                    `<compartment start="${c.start_message}" end="${c.end_message}" title="${c.title}">\n${c.content}\n</compartment>\n`
                        .length / 3.5,
                );
            }
            for (const f of facts) {
                histTokens += Math.ceil(`* ${f.content}\n`.length / 3.5);
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
        return buildSidebarSnapshot(db, sessionId, dir) as unknown as Record<string, unknown>;
    });

    rpcServer.handle("status-detail", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        const dir = String(params.directory ?? directory);
        const modelKey = params.modelKey ? String(params.modelKey) : undefined;
        const db = getDb();
        if (!db || !sessionId) return { error: "unavailable" };
        return buildStatusDetail(db, sessionId, dir, modelKey, rawConfig) as unknown as Record<
            string,
            unknown
        >;
    });

    rpcServer.handle("compartment-count", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        const db = getDb();
        if (!db || !sessionId) return { count: 0 };
        try {
            const row = db
                .query<{ count: number }, [string]>(
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
            getNotificationParams: () => getNotificationParams(sessionId),
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
