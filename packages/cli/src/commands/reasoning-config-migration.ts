/** Age counts cannot be converted to tokens without the session's reasoning costs. */
export function removeDeprecatedReasoningAge(config: Record<string, unknown>): string[] {
    if (!Object.hasOwn(config, "clear_reasoning_age")) return [];
    const age = config.clear_reasoning_age;
    delete config.clear_reasoning_age;
    const messages = [
        "Removed deprecated clear_reasoning_age (reasoning is now kept up to a token budget, keep_reasoning_tokens, default 10,000).",
    ];
    if (typeof age === "number" && age < 50)
        messages.push(
            "You had set a lower age to keep less reasoning; set keep_reasoning_tokens (for example 8000) to keep less than the default.",
        );
    return messages;
}
