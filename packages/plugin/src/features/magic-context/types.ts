export interface TagEntry {
    tagNumber: number;
    messageId: string;
    type: "message" | "tool" | "file";
    status: "active" | "dropped" | "compacted";
    dropMode: "full" | "truncated";
    toolName: string | null;
    inputByteSize: number;
    byteSize: number;
    reasoningByteSize: number;
    sessionId: string;
}

export interface PendingOp {
    id: number;
    sessionId: string;
    tagId: number;
    operation: "drop";
    queuedAt: number;
}

export interface SessionMeta {
    sessionId: string;
    lastResponseTime: number;
    cacheTtl: string;
    counter: number;
    lastNudgeTokens: number;
    lastNudgeBand: "far" | "near" | "urgent" | "critical" | null;
    lastTransformError: string | null;
    isSubagent: boolean;
    lastContextPercentage: number;
    lastInputTokens: number;
    timesExecuteThresholdReached: number;
    compartmentInProgress: boolean;
    systemPromptHash: string;
    systemPromptTokens: number;
    conversationTokens: number;
    clearedReasoningThroughTag: number;
}

export type SchedulerDecision = "execute" | "defer";

export interface ContextUsage {
    percentage: number;
    inputTokens: number;
}
