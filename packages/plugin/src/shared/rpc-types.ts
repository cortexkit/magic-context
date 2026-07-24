/**
 * Shared types for RPC between server and TUI plugins.
 * Both sides import these — no SQLite dependency.
 */

export interface SidebarSnapshot {
    sessionId: string;
    usagePercentage: number;
    inputTokens: number;
    contextLimit: number;
    /**
     * Raw wire-input pressure against the resolved model window. This is separate
     * from Magic Context's execute threshold so native-compaction UI never shows
     * a threshold-relative fill percentage.
     */
    native_context_usage_percentage?: number;
    /**
     * Magic Context compaction mode is resolved at startup and sent in the
     * status-detail wire payload; snake_case matches that payload's field naming.
     */
    compaction_enabled?: boolean;
    systemPromptTokens: number;
    compartmentCount: number;
    /** Historical compartment rows retained while native compaction owns the window. */
    archivedCompartmentCount?: number;
    memoryCount: number;
    memoryBlockCount: number;
    pendingOpsCount: number;
    historianRunning: boolean;
    compartmentInProgress: boolean;
    sessionNoteCount: number;
    readySmartNoteCount: number;
    cacheTtl: string;
    /** Persistent runtime failure shown directly in the sidebar when non-null. */
    lastTransformError: string | null;
    lastDreamerRunAt: number | null;
    projectIdentity: string | null;
    compartmentTokens: number;
    factTokens: number;
    memoryTokens: number;
    /**
     * Token estimate of the injected <project-docs> block (root ARCHITECTURE.md
     * + STRUCTURE.md) that lives in m[0] in v2. Part of the message stream, not
     * conversation. Display layer shows this as "Docs".
     */
    docsTokens: number;
    /**
     * Token estimate of the injected <user-profile> block (promoted user
     * memories) that lives in m[0] in v2. Part of the message stream, not
     * conversation. Display layer shows this as "Profile".
     */
    profileTokens: number;
    /**
     * Token estimate of real user/assistant discussion (text + reasoning +
     * image parts) inside messages, excluding injected <session-history>,
     * <project-docs>, and <user-profile> blocks. Display layer shows this as
     * "Conversation".
     */
    conversationTokens: number;
    /**
     * Token estimate of tool call I/O inside messages (tool_use, tool_result,
     * tool, tool-invocation parts). Actionable — users can reduce via
     * ctx_reduce. Display layer shows this as "Tool Calls".
     */
    toolCallTokens: number;
    /**
     * Measured token cost of tool schemas (description + JSON-schema
     * parameters) OpenCode sends in the request `tools` parameter. Populated
     * by the `tool.definition` plugin hook, keyed by
     * `{providerID, modelID, agentName}`. Zero until the first turn after
     * plugin startup measures the current agent's tool set. Display layer
     * shows this as "Tool Definitions".
     */
    toolDefinitionTokens: number;
    /**
     * Effective execute-threshold percentage for this session's active model,
     * after per-model resolution and the tokens→percentage conversion (when
     * `execute_threshold_tokens` applies). Surfaces in the sidebar / status
     * dialog header alongside `usagePercentage` so users can see how close
     * the session is to triggering compaction. Defaults to `65` when no live
     * model is known yet — matches the runtime fallback used by the
     * scheduler and transform paths.
     */
    executeThreshold: number;
    /**
     * True when `executeThreshold` was clamped down from a higher configured value
     * (tokens config above 80% × contextLimit, or a percentage above the 80% cap).
     * The sidebar/status dialog append a small marker so the user knows their
     * configured value was reduced rather than applied verbatim (issue #241).
     * Absent when no clamp occurred.
     */
    executeThresholdClamped?: boolean;
    /** Rust module cache boundary state, when the session uses Rust authority mode. */
    boundaryPresent?: boolean;
    coverageOrdinal?: number | null;
    newWorkTokens?: number | null;
    totalInputTokens?: number | null;
    /**
     * Live recomp / session-upgrade progress for this session, or null when no
     * recomp is running (and no recent terminal state is being shown). Drives the
     * sidebar "Recomp"/"Upgrade" progress bar and the /ctx-status dialog. Mirrors
     * the runtime `RecompProgress` shape from compartment-runner-types.ts.
     */
    recompProgress?: {
        /** "recomp" → "Recomp" labels; "upgrade" → "Upgrade" labels. */
        kind?: "recomp" | "upgrade" | "embed" | "wrapup";
        phase: "recomp" | "migration" | "done" | "failed" | "skipped";
        processedMessages: number;
        totalMessages: number;
        passCount: number;
        compartmentsCreated: number;
        message?: string;
        note?: string;
    } | null;
}

export interface StatusDetail extends SidebarSnapshot {
    tagCounter: number;
    activeTags: number;
    droppedTags: number;
    totalTags: number;
    activeBytes: number;
    lastResponseTime: number;
    lastNudgeTokens: number;
    lastTransformError: string | null;
    isSubagent: boolean;
    pendingOps: Array<{ tagId: number; operation: string }>;
    contextLimit: number;
    cacheTtlMs: number;
    cacheRemainingMs: number;
    cacheExpired: boolean;
    /** True when cacheTtl is "never" — the idle-TTL heuristic is disabled on this lane. */
    cacheNeverExpires?: boolean;
    executeThreshold: number;
    /**
     * Which config source produced `executeThreshold`. "tokens" means
     * execute_threshold_tokens matched for this session's model and was
     * converted to a percentage. "percentage" means percentage config was used.
     */
    executeThresholdMode: "percentage" | "tokens";
    /**
     * When `executeThresholdMode === "tokens"`, the absolute clamped token value
     * (≤ 80% × contextLimit) that will trigger execute. Undefined in percentage mode.
     */
    executeThresholdTokens?: number;
    protectedTagCount: number;
    historyBudgetPercentage: number;
    historyBlockTokens: number;
    compressionBudget: number | null;
    compressionUsage: string | null;
    /** Effective configured toast duration in ms after config resolution. */
    toastDurationMs: number;
    /** One-line status data for the experimental memory mural. */
    mural?: { present: boolean; ageMs: number | null };
    /**
     * Stable storage-version probe: "which schema is the DB at, which fence does
     * this binary carry". Field names are deliberately snake_case, mirroring the
     * `storage_versions` block of the mc-module status envelope, so fleet probes
     * parse one shape across both surfaces. The module cannot read context.db
     * (the plugin owns it), so this surface supplies the live DB value; the module
     * surface supplies the module-store value instead.
     */
    storage_versions: {
        /**
         * Persisted schema version of context.db (MAX of schema_migrations).
         * null = the version probe FAILED (read threw — broken/unreachable store);
         * 0 = probe succeeded on a fresh DB without a migrations table. Distinct so
         * readers never conflate broken-with-empty (fleet status-surface contract).
         */
        context_db_schema_version: number | null;
        /** Highest context.db schema version this plugin build supports. */
        plugin_supported_version: number;
    };
}

/** Embedding coverage for `/ctx-embed` status (mirrors getEmbeddingCoverageStatus). */
export interface EmbedDetail {
    enabled: boolean;
    model: string;
    provider: string;
    session: { embedded: number; total: number };
    memories: { embedded: number; total: number };
    commits: { embedded: number; total: number; gitEnabled: boolean };
    statusText: string;
}

export interface RpcNotificationMessage {
    id: number;
    type: string;
    payload: Record<string, unknown>;
    sessionId?: string;
}
