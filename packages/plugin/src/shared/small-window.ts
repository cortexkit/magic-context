/**
 * The small-window condition: the system prompt and tool definitions alone take
 * more than half of the reduction point, the request size at which Magic
 * Context starts reducing (the usable window times the execute threshold the
 * session runs with). Every request carries both and no context management can
 * remove them, so what is left for the conversation before reduction starts is
 * the reduction point minus them. In issue 860 that was 29,250 − 21,196, about
 * 8,000 tokens: two tool results. The only remedies are the user's: a larger
 * context setting for the model, or fewer tools.
 *
 * Shared by every surface that reports it (the one-time notification,
 * `/ctx-status`, the sidebar, `doctor`), so they all apply the same rule to the
 * numbers they show. It is display-only: nothing here changes a request.
 */

/**
 * Fraction of the reduction point above which the system prompt and tool
 * definitions are reported. At half, the conversation gets less room before
 * reduction starts than the fixed part takes.
 */
export const SMALL_WINDOW_REDUCTION_POINT_SHARE = 0.5;

export interface SmallWindowCondition {
    systemPromptTokens: number;
    toolDefinitionTokens: number;
    /** The request size at which reduction starts. */
    reductionPointTokens: number;
}

function positive(value: number | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** The reduction point of a usable window at an execute threshold given in percent. */
export function reductionPointTokens(
    usableWindowTokens: number | undefined,
    executeThresholdPercentage: number | undefined,
): number | undefined {
    if (!positive(usableWindowTokens) || !positive(executeThresholdPercentage)) return undefined;
    return Math.floor(usableWindowTokens * (executeThresholdPercentage / 100));
}

/**
 * The condition, when all three numbers are known and it holds; null when it
 * does not hold or a number is unknown, so a surface never reports it from a
 * guess. The system prompt and the reduction point are unknown when absent or
 * not positive. A tool-definition count of zero is a known count (a request
 * that carries no tools); only an absent or non-finite count is unknown.
 */
export function smallWindowCondition(input: {
    systemPromptTokens?: number;
    toolDefinitionTokens?: number;
    reductionPointTokens?: number;
}): SmallWindowCondition | null {
    const { systemPromptTokens, toolDefinitionTokens, reductionPointTokens } = input;
    if (!positive(systemPromptTokens)) return null;
    if (
        typeof toolDefinitionTokens !== "number" ||
        !Number.isFinite(toolDefinitionTokens) ||
        toolDefinitionTokens < 0
    )
        return null;
    if (!positive(reductionPointTokens)) return null;
    if (
        systemPromptTokens + toolDefinitionTokens <=
        reductionPointTokens * SMALL_WINDOW_REDUCTION_POINT_SHARE
    )
        return null;
    return {
        systemPromptTokens: Math.round(systemPromptTokens),
        toolDefinitionTokens: Math.round(toolDefinitionTokens),
        reductionPointTokens: Math.round(reductionPointTokens),
    };
}

const count = (value: number) => value.toLocaleString("en-US");

/** The sentence every surface shows for the condition. */
export function formatSmallWindowCondition(
    condition: SmallWindowCondition,
    model?: string,
): string {
    const fixed = condition.systemPromptTokens + condition.toolDefinitionTokens;
    const share = Math.round((fixed / condition.reductionPointTokens) * 100);
    const room = Math.max(0, condition.reductionPointTokens - fixed);
    return `Context window too small${model ? ` for ${model}` : ""}: the system prompt (${count(condition.systemPromptTokens)} tokens) and tool definitions (${count(condition.toolDefinitionTokens)} tokens) take ${share}% of the ${count(condition.reductionPointTokens)} tokens at which reduction starts, leaving about ${count(room)} tokens for the conversation. Raise the model's context setting or remove tools.`;
}
