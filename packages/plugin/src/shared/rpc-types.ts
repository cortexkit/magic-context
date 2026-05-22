/**
 * Shared types for RPC between server and TUI plugins.
 * Both sides import these — no SQLite dependency.
 */

export interface SidebarSnapshot {
    sessionId: string;
    usagePercentage: number;
    inputTokens: number;
    contextLimit: number;
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
        kind?: "recomp" | "upgrade" | "embed";
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
