import type { ProviderRoute, ScenarioSpec } from "../types";

/**
 * DeepSeek chat completions with thinking on: reasoning travels as `reasoning_content` on
 * assistant messages. The `age` scenario asks whether a request is accepted after older steps
 * lose their reasoning while newer steps keep theirs; the `drop` scenario asks whether it is
 * accepted after a tool call and its result are removed entirely.
 */
export const deepseek: ProviderRoute = {
    id: "deepseek",
    credentialId: "apikey:deepseek",
    providerId: "deepseek",
    npm: "@ai-sdk/openai-compatible",
    upstreamBase: "https://api.deepseek.com",
    model: "deepseek-flash",
    protocol: "chat-completions",
    modelConfig: { interleaved: { field: "reasoning_content" }, limit: { context: 128_000, output: 8_192 } },
    modelOptions: { thinking: { type: "enabled" } },
};

export const scenarios: ScenarioSpec[] = [
    { route: deepseek, kind: "age", loopSteps: 12, keepReasoningTokens: 1000, callBudget: 21 },
    { route: deepseek, kind: "drop", loopSteps: 12, keepReasoningTokens: 1_000_000, callBudget: 21 },
];
