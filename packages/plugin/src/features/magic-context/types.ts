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
    /**
     * Caveman compression depth applied to this tag's text part. 0 = none,
     * 1 = lite, 2 = full, 3 = ultra. Only meaningful for `type: "message"`;
     * tool/file tags stay at 0. Used by experimental age-tier caveman
     * heuristic to avoid re-compressing text that already matches the
     * target depth for its age band.
     */
    cavemanDepth: number;
    /**
     * For `type: "tool"` tags: the assistant message id where the
     * underlying tool call was invoked. Identity for a tool tag is the
     * triple `(sessionId, messageId/callID, toolOwnerMessageId)` —
     * including this field disambiguates collisions when OpenCode's
     * per-turn callID counter produces the same id across turns.
     *
     * NULL on:
     *   - all `type: "message"` and `type: "file"` tags (not applicable)
     *   - legacy tool tags written before plugin v0.16.x (the
     *     tag-owner-fix migration v10). The runtime lazily adopts these
     *     orphan rows on first observation; backfill populates them at
     *     plugin startup against the OpenCode DB.
     *
     * See plan v3.3.1 in `.alfonso/plans/tag-owner-fix-plan.md`.
     */
    toolOwnerMessageId: string | null;
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
    observedSafeInputTokens: number;
    cacheAlertSent: boolean;
    timesExecuteThresholdReached: number;
    compartmentInProgress: boolean;
    systemPromptHash: string;
    systemPromptTokens: number;
    conversationTokens: number;
    toolCallTokens: number;
    clearedReasoningThroughTag: number;
    lastTodoState: string;
}

export type SchedulerDecision = "execute" | "defer";

export interface ContextUsage {
    percentage: number;
    inputTokens: number;
}
