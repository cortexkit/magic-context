/**
 * Shared types for RPC between server and TUI plugins.
 * Both sides import these — no SQLite dependency.
 */

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
    compartmentTokens: number;
    factTokens: number;
    memoryTokens: number;
    /**
     * Token estimate of the real user/assistant conversation, excluding
     * injected <session-history> blocks. Equals messageTokens −
     * (compartmentTokens + factTokens + memoryTokens). Display layer shows
     * this as "Conversation".
     */
    conversationTokens: number;
    /**
     * Token estimate of tool schemas in the prompt (bash, edit, grep, MCP
     * servers, ctx_* tools, etc.). Computed as inputTokens − systemPromptTokens
     * − messageTokens and clamped to ≥ 0. Display layer shows this as "Tools".
     */
    toolTokens: number;
}

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
    contextLimit: number;
    cacheTtlMs: number;
    cacheRemainingMs: number;
    cacheExpired: boolean;
    executeThreshold: number;
    protectedTagCount: number;
    nudgeInterval: number;
    historyBudgetPercentage: number;
    nextNudgeAfter: number;
    historyBlockTokens: number;
    compressionBudget: number | null;
    compressionUsage: string | null;
}

export interface RpcNotificationMessage {
    type: string;
    payload: Record<string, unknown>;
    sessionId?: string;
}
