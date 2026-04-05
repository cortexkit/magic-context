import { Database } from "bun:sqlite";
import * as os from "node:os";
import * as path from "node:path";
import { log } from "../../shared/logger";

export interface SidebarSnapshot {
    sessionId: string;
    usagePercentage: number;
    inputTokens: number;
    systemPromptTokens: number;
    compartmentCount: number;
    factCount: number;
    memoryCount: number;
    memoryBlockCount: number;
    pendingOpsCount: number;
    historianRunning: boolean;
    compartmentInProgress: boolean;
    sessionNoteCount: number;
    readySmartNoteCount: number;
    cacheTtl: string;
    lastDreamerRunAt: number | null;
    projectIdentity: string | null;
    // Token estimates for breakdown bar (~4 chars/token)
    compartmentTokens: number;
    factTokens: number;
    memoryTokens: number;
}

/** Extended status info for the status dialog — reads more from DB */
export interface StatusDetail extends SidebarSnapshot {
    tagCounter: number;
    activeTags: number;
    droppedTags: number;
    totalTags: number;
    activeBytes: number;
    lastResponseTime: number;
    lastNudgeTokens: number;
    lastNudgeBand: string;
    lastTransformError: string | null;
    isSubagent: boolean;
    pendingOps: Array<{ tagId: number; operation: string }>;
    // Derived
    contextLimit: number;
    cacheTtlMs: number;
    cacheRemainingMs: number;
    cacheExpired: boolean;
    // Config-dependent (read from magic-context.jsonc or defaults)
    executeThreshold: number;
    protectedTagCount: number;
    nudgeInterval: number;
    historyBudgetPercentage: number;
    nextNudgeAfter: number;
    // History compression
    historyBlockTokens: number;
    compressionBudget: number | null;
    compressionUsage: string | null;
}

function getContextDbPath(): string {
    const dataDir = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
    return path.join(dataDir, "opencode", "storage", "plugin", "magic-context", "context.db");
}

let cachedDb: Database | null = null;
let dbPath: string | null = null;

function getDb(): Database | null {
    const targetPath = getContextDbPath();
    if (cachedDb && dbPath === targetPath) {
        return cachedDb;
    }
    try {
        // Open read-write: WAL-mode DBs need write access to the -shm file,
        // and the TUI writes to plugin_messages for the message bus.
        cachedDb = new Database(targetPath);
        cachedDb.exec("PRAGMA journal_mode = WAL");
        cachedDb.exec("PRAGMA busy_timeout = 3000");
        dbPath = targetPath;
        return cachedDb;
    } catch (err) {
        log("[tui] failed to open context.db", err);
        cachedDb = null;
        dbPath = null;
        return null;
    }
}

export function closeDb(): void {
    if (cachedDb) {
        try {
            cachedDb.close();
        } catch {
            // Ignore close errors
        }
        cachedDb = null;
        dbPath = null;
    }
}

function resolveProjectIdentity(directory: string): string | null {
    if (!directory) return null;
    try {
        // Match the plugin's own project identity resolution: git root commit hash
        const { execSync } = require("node:child_process") as typeof import("node:child_process");
        const rootCommit = execSync("git rev-list --max-parents=0 HEAD", {
            cwd: directory,
            encoding: "utf-8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"],
        })
            .trim()
            .split("\n")[0];
        if (rootCommit && rootCommit.length >= 40) {
            return `git:${rootCommit}`;
        }
    } catch {
        // Not a git repo or git not available
    }
    // Fallback: canonical directory hash (matches plugin's directoryFallback)
    try {
        const realPath = require("node:fs").realpathSync(directory);
        const hash = require("node:crypto").createHash("sha256").update(realPath).digest("hex");
        return `dir:${hash}`;
    } catch {
        return null;
    }
}

export function loadSidebarSnapshot(sessionId: string, directory: string): SidebarSnapshot {
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
    };

    const db = getDb();
    if (!db) return empty;

    try {
        const projectIdentity = resolveProjectIdentity(directory);

        // Session meta
        const meta = db
            .query<Record<string, unknown>, [string]>(
                `SELECT * FROM session_meta WHERE session_id = ?`,
            )
            .get(sessionId);

        const usagePercentage = meta
            ? Number(
                  (meta as Record<string, unknown>).last_context_percentage ??
                      (meta as Record<string, unknown>).last_usage_percentage ??
                      0,
              )
            : 0;
        const inputTokens = meta
            ? Number((meta as Record<string, unknown>).last_input_tokens ?? 0)
            : 0;
        const systemPromptTokens = meta
            ? Number((meta as Record<string, unknown>).system_prompt_tokens ?? 0)
            : 0;
        const compartmentInProgress = meta
            ? Boolean((meta as Record<string, unknown>).compartment_in_progress)
            : false;
        const cacheTtl = meta ? String((meta as Record<string, unknown>).cache_ttl ?? "5m") : "5m";

        // Compartments
        const compartmentRow = db
            .query<{ count: number }, [string]>(
                `SELECT COUNT(*) as count FROM compartments WHERE session_id = ?`,
            )
            .get(sessionId);
        const compartmentCount = compartmentRow?.count ?? 0;

        // Session facts
        const factRow = db
            .query<{ count: number }, [string]>(
                `SELECT COUNT(*) as count FROM session_facts WHERE session_id = ?`,
            )
            .get(sessionId);
        const factCount = factRow?.count ?? 0;

        // Project memories
        let memoryCount = 0;
        if (projectIdentity) {
            const memRow = db
                .query<{ count: number }, [string]>(
                    `SELECT COUNT(*) as count FROM memories WHERE project_path = ? AND status = 'active'`,
                )
                .get(projectIdentity);
            memoryCount = memRow?.count ?? 0;
        }

        // Memory block count from session meta
        const memoryBlockCount = meta
            ? Number((meta as Record<string, unknown>).memory_block_count ?? 0)
            : 0;

        // Pending operations
        let pendingOpsCount = 0;
        try {
            const pendingRow = db
                .query<{ count: number }, [string]>(
                    `SELECT COUNT(*) as count FROM pending_ops WHERE session_id = ?`,
                )
                .get(sessionId);
            pendingOpsCount = pendingRow?.count ?? 0;
        } catch (pendingErr) {
            log("[magic-context-tui] pending_ops query failed", pendingErr);
        }

        // Historian running — check if compartmentInProgress is truthy
        const historianRunning = compartmentInProgress;

        // Session notes (from notes table if it exists)
        let sessionNoteCount = 0;
        try {
            const noteRow = db
                .query<{ count: number }, [string]>(
                    `SELECT COUNT(*) as count FROM notes WHERE session_id = ? AND type = 'session' AND status = 'active'`,
                )
                .get(sessionId);
            sessionNoteCount = noteRow?.count ?? 0;
        } catch {
            // notes table may not exist
        }

        // Ready smart notes
        let readySmartNoteCount = 0;
        if (projectIdentity) {
            try {
                const smartRow = db
                    .query<{ count: number }, [string]>(
                        `SELECT COUNT(*) as count FROM notes WHERE project_path = ? AND type = 'smart' AND status = 'ready'`,
                    )
                    .get(projectIdentity);
                readySmartNoteCount = smartRow?.count ?? 0;
            } catch {
                // notes table may not exist
            }
        }

        // Token estimates for breakdown bar (~4 chars/token)
        let compartmentTokens = 0;
        let factTokens = 0;
        let memoryTokens = 0;
        try {
            const compRows = db
                .query<
                    { content: string; title: string; start_message: number; end_message: number },
                    [string]
                >(
                    `SELECT content, title, start_message, end_message FROM compartments WHERE session_id = ?`,
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
                    `SELECT content FROM session_facts WHERE session_id = ?`,
                )
                .all(sessionId);
            for (const f of factRows) {
                factTokens += Math.ceil(`* ${f.content}\n`.length / 3.5);
            }
        } catch {
            /* session_facts table may not exist */
        }
        // Memory tokens from cached block in session_meta
        if (meta) {
            const cached = (meta as Record<string, unknown>).memory_block_cache;
            if (typeof cached === "string" && cached.length > 0) {
                memoryTokens = Math.ceil(cached.length / 3.5);
            }
        }

        // Last dreamer run
        let lastDreamerRunAt: number | null = null;
        if (projectIdentity) {
            try {
                const dreamRow = db
                    .query<{ value: string }, [string]>(
                        `SELECT value FROM dream_state WHERE key = ?`,
                    )
                    .get(`last_dream_at:${projectIdentity}`);
                if (dreamRow?.value) {
                    lastDreamerRunAt = Number(dreamRow.value) || null;
                }
            } catch {
                // dream_state may not exist
            }
        }

        const result = {
            sessionId,
            usagePercentage,
            inputTokens,
            systemPromptTokens,
            compartmentCount,
            factCount,
            memoryCount,
            memoryBlockCount,
            pendingOpsCount,
            historianRunning,
            compartmentInProgress,
            sessionNoteCount,
            readySmartNoteCount,
            cacheTtl,
            lastDreamerRunAt,
            projectIdentity,
            compartmentTokens,
            factTokens,
            memoryTokens,
        };
        return result;
    } catch (err) {
        log("[magic-context-tui] snapshot error:", err);
        return empty;
    }
}

export function loadStatusDetail(
    sessionId: string,
    directory: string,
    modelKey?: string,
): StatusDetail {
    const base = loadSidebarSnapshot(sessionId, directory);
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

    const db = getDb();
    if (!db) return detail;

    try {
        // Session meta extras
        const meta = db
            .query<Record<string, unknown>, [string]>(
                `SELECT * FROM session_meta WHERE session_id = ?`,
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

        // Tag counts
        try {
            const activeRow = db
                .query<{ count: number; bytes: number }, [string]>(
                    `SELECT COUNT(*) as count, COALESCE(SUM(byte_size), 0) as bytes FROM tags WHERE session_id = ? AND status = 'active'`,
                )
                .get(sessionId);
            detail.activeTags = activeRow?.count ?? 0;
            detail.activeBytes = activeRow?.bytes ?? 0;

            const droppedRow = db
                .query<{ count: number }, [string]>(
                    `SELECT COUNT(*) as count FROM tags WHERE session_id = ? AND status = 'dropped'`,
                )
                .get(sessionId);
            detail.droppedTags = droppedRow?.count ?? 0;
            detail.totalTags = detail.activeTags + detail.droppedTags;
        } catch {
            // tags table might have different schema
        }

        // Pending ops detail
        try {
            const ops = db
                .query<{ tag_id: number; operation: string }, [string]>(
                    `SELECT tag_id, operation FROM pending_ops WHERE session_id = ?`,
                )
                .all(sessionId);
            detail.pendingOps = ops.map((o) => ({ tagId: o.tag_id, operation: o.operation }));
        } catch {
            // pending_ops may not exist
        }

        // Read config for threshold/budget values, resolving per-model overrides
        try {
            const cfg = readMagicContextConfig(directory);
            if (cfg) {
                // execute_threshold_percentage: number | { default, "provider/model" }
                const etp = cfg.execute_threshold_percentage;
                if (typeof etp === "number") {
                    detail.executeThreshold = Math.min(etp, 80);
                } else if (etp && typeof etp === "object") {
                    const etpObj = etp as Record<string, number>;
                    let resolved = etpObj.default ?? 65;
                    if (modelKey && typeof etpObj[modelKey] === "number") {
                        resolved = etpObj[modelKey];
                    } else if (modelKey) {
                        const bare = modelKey.split("/").slice(1).join("/");
                        if (bare && typeof etpObj[bare] === "number") resolved = etpObj[bare];
                    }
                    detail.executeThreshold = Math.min(resolved, 80);
                }

                // cache_ttl: string | { default, "provider/model" }
                const ct = cfg.cache_ttl;
                if (typeof ct === "string") {
                    detail.cacheTtl = ct;
                } else if (ct && typeof ct === "object") {
                    const ctObj = ct as Record<string, string>;
                    let resolved = ctObj.default ?? "5m";
                    if (modelKey && typeof ctObj[modelKey] === "string") {
                        resolved = ctObj[modelKey];
                    } else if (modelKey) {
                        const bare = modelKey.split("/").slice(1).join("/");
                        if (bare && typeof ctObj[bare] === "string") resolved = ctObj[bare];
                    }
                    detail.cacheTtl = resolved;
                }

                if (typeof cfg.protected_tag_count === "number") {
                    detail.protectedTagCount = cfg.protected_tag_count;
                }
                if (typeof cfg.nudge_interval_tokens === "number") {
                    detail.nudgeInterval = cfg.nudge_interval_tokens;
                }
                if (typeof cfg.history_budget_percentage === "number") {
                    detail.historyBudgetPercentage = cfg.history_budget_percentage;
                }
            }
        } catch {
            // config read failure — keep defaults
        }

        // Derived: context limit
        if (base.usagePercentage > 0) {
            detail.contextLimit = Math.round(base.inputTokens / (base.usagePercentage / 100));
        }

        // Derived: cache TTL (re-resolve with potentially model-specific value)
        detail.cacheTtlMs = parseTtlString(detail.cacheTtl);
        if (detail.lastResponseTime > 0) {
            const elapsed = Date.now() - detail.lastResponseTime;
            detail.cacheRemainingMs = Math.max(0, detail.cacheTtlMs - elapsed);
            detail.cacheExpired = detail.cacheRemainingMs === 0;
        }

        // Derived: next nudge
        detail.nextNudgeAfter = detail.lastNudgeTokens + detail.nudgeInterval;

        // History compression: estimate tokens from compartment/fact content
        try {
            const compartments = db
                .query<
                    { content: string; title: string; start_message: number; end_message: number },
                    [string]
                >(
                    `SELECT content, title, start_message, end_message FROM compartments WHERE session_id = ?`,
                )
                .all(sessionId);
            const facts = db
                .query<{ content: string }, [string]>(
                    `SELECT content FROM session_facts WHERE session_id = ?`,
                )
                .all(sessionId);

            let histTokens = 0;
            for (const c of compartments) {
                // ~3.5 chars per token estimate (matches plugin's estimateTokens)
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
        log("[magic-context-tui] loadStatusDetail error:", err);
    }

    return detail;
}

function parseTtlString(ttl: string): number {
    const match = ttl.match(/^(\d+)(s|m|h)$/);
    if (!match) return 5 * 60 * 1000; // default 5m
    const value = Number(match[1]);
    switch (match[2]) {
        case "s":
            return value * 1000;
        case "m":
            return value * 60 * 1000;
        case "h":
            return value * 3600 * 1000;
        default:
            return 5 * 60 * 1000;
    }
}

function readMagicContextConfig(directory: string): Record<string, unknown> | null {
    const fs = require("node:fs") as typeof import("node:fs");
    // Try project config first, then user config
    const candidates = [
        path.join(directory, "magic-context.jsonc"),
        path.join(directory, ".opencode", "magic-context.jsonc"),
    ];
    const homeConfig = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
    candidates.push(path.join(homeConfig, "opencode", "magic-context.jsonc"));

    for (const p of candidates) {
        try {
            const raw = fs.readFileSync(p, "utf-8");
            // Strip JSONC comments
            const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
            return JSON.parse(stripped);
        } catch {
            // try next candidate
        }
    }
    return null;
}

/**
 * Get compartment count for a session (used by recomp confirmation dialog).
 */
export function getCompartmentCount(sessionId: string): number {
    const db = getDb();
    if (!db) return 0;
    try {
        const row = db
            .prepare("SELECT COUNT(*) as count FROM compartments WHERE session_id = ?")
            .get(sessionId) as { count: number } | null;
        return row?.count ?? 0;
    } catch {
        return 0;
    }
}

/**
 * Consume pending server→TUI messages from the plugin_messages table.
 * Returns consumed messages and marks them as consumed.
 */
export interface TuiMessage {
    id: number;
    type: string;
    payload: Record<string, unknown>;
    sessionId: string | null;
    createdAt: number;
}

export function consumeTuiMessages(): TuiMessage[] {
    const db = getDb();
    if (!db) return [];

    try {
        // Check if plugin_messages table exists (migration may not have run yet)
        const tableCheck = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_messages'")
            .get();
        if (!tableCheck) return [];

        const now = Date.now();
        const rows = db
            .prepare(
                "SELECT id, type, payload, session_id, created_at FROM plugin_messages WHERE direction = 'server_to_tui' AND consumed_at IS NULL ORDER BY created_at ASC",
            )
            .all() as Array<{
            id: number;
            type: string;
            payload: string;
            session_id: string | null;
            created_at: number;
        }>;

        if (rows.length === 0) return [];

        const ids = rows.map((r) => r.id);
        db.prepare(
            `UPDATE plugin_messages SET consumed_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`,
        ).run(now, ...ids);

        // Cleanup old messages
        db.prepare("DELETE FROM plugin_messages WHERE created_at < ?").run(now - 5 * 60 * 1000);

        return rows.map((r) => {
            let payload: Record<string, unknown> = {};
            try {
                payload = JSON.parse(r.payload);
            } catch {
                // Intentional: malformed payload treated as empty
            }
            return {
                id: r.id,
                type: r.type,
                payload,
                sessionId: r.session_id,
                createdAt: r.created_at,
            };
        });
    } catch {
        return [];
    }
}

/**
 * Send a message from TUI to server via plugin_messages.
 */
export function sendMessageToServer(
    type: string,
    payload: Record<string, unknown>,
    sessionId?: string,
): boolean {
    const db = getDb();
    if (!db) return false;

    try {
        const tableCheck = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_messages'")
            .get();
        if (!tableCheck) return false;

        db.prepare(
            "INSERT INTO plugin_messages (direction, type, payload, session_id, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run("tui_to_server", type, JSON.stringify(payload), sessionId ?? null, Date.now());
        return true;
    } catch {
        return false;
    }
}
