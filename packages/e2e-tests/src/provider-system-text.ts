function text(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(text).join("\n");
    if (value && typeof value === "object" && "text" in value) return text(value.text);
    return "";
}

/** OpenCode 2.3+ puts Responses API instructions in developer input items. */
export function providerSystemText(body: Record<string, unknown>): string {
    const developer = Array.isArray(body.input)
        ? body.input.flatMap((item) => item?.role === "developer" ? [text(item.content)] : [])
        : [];
    return [text(body.system), text(body.instructions), ...developer].filter(Boolean).join("\n");
}

/** Title requests copy the opening conversation, so the user text alone cannot identify a turn. */
export function isTitleRequest(body: Record<string, unknown>): boolean {
    const system = providerSystemText(body);
    return system.includes("title generator") || system.includes("You name conversations so the user can find them later");
}
