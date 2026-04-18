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
     * Token estimate of real user/assistant discussion (text + reasoning +
     * image parts) inside messages, excluding injected <session-history>
     * blocks. Display layer shows this as "Conversation".
     */
    conversationTokens: number;
    /**
     * Token estimate of tool call I/O inside messages (tool_use, tool_result,
     * tool, tool-invocation parts). Actionable — users can reduce via
     * ctx_reduce. Display layer shows this as "Tool Calls".
     */
    toolCallTokens: number;
    /**
     * Token estimate of tool schemas OpenCode sends alongside in the request
     * `tools` parameter (bash, edit, grep, MCP servers, ctx_* tools, etc.).
     * Computed as inputTokens − systemPromptTokens − messagesBlock −
     * toolCallTokens and clamped to ≥ 0. Display layer shows this as
     * "Tool Definitions". Includes tokenizer imprecision residual.
     */
    toolDefinitionTokens: number;
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
