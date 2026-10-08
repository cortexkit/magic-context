type Part = Record<string, unknown>;

/** The context hook sees normalized results; checkpoint replay sees raw error envelopes. */
export function isToolError(part: Part): boolean {
    const result = part.result as Part | undefined;
    return (
        part.resultType === "error" ||
        result?.type === "error" ||
        (result !== null && typeof result === "object" && "error" in result)
    );
}

/** Match the host's error wire text, including the content and the structured error. */
export function toolErrorText(result: Part): string {
    const value = result.value === undefined ? result : result.value;
    return typeof value === "string" ? value : JSON.stringify(value);
}

export function toolStateContent(state: Part): string {
    if (typeof state.output === "string") return state.output;
    if (state.status === "error")
        return toolErrorText({ error: state.error, content: state.content ?? [] });
    if (typeof state.content === "string") return state.content;
    if (!Array.isArray(state.content)) return "";
    return state.content
        .map((part) => {
            if (typeof part === "string") return part;
            if (!part || typeof part !== "object") return "";
            const value = part as Part;
            if (typeof value.text === "string") return value.text;
            if (typeof value.value === "string") return value.value;
            return "";
        })
        .filter(Boolean)
        .join("\n");
}
