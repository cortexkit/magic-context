/** Inspect transport messages, never the assistant's text, for forbidden tool activity. */
export function hasHistorianToolActivity(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(hasHistorianToolActivity);
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    const toolKinds = [
        "tool",
        "toolCall",
        "toolResult",
        "tool-call",
        "tool-result",
        "tool_use",
        "tool_result",
    ];
    if (toolKinds.includes(String(record.type)) || toolKinds.includes(String(record.role)))
        return true;
    if (
        record.toolActivity === true ||
        (typeof record.toolCallCount === "number" && record.toolCallCount > 0)
    )
        return true;
    if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) return true;
    return Object.values(record).some(hasHistorianToolActivity);
}
