import type { ProviderRoute, ScenarioSpec } from "../types";

/**
 * Kimi For Coding, OpenAI-compatible chat completions with `reasoning_content`. The `age`
 * scenario tests acceptance after older steps lose their reasoning while newer steps keep it;
 * the `drop` scenario tests acceptance after a tool call and its result are removed entirely.
 */
export const kimi: ProviderRoute = {
    id: "kimi",
    credentialId: "apikey:kimi-for-coding",
    providerId: "kimi-for-coding",
    npm: "@ai-sdk/openai-compatible",
    upstreamBase: "https://api.kimi.com/coding/v1",
    model: "kimi-for-coding",
    protocol: "chat-completions",
    modelConfig: { interleaved: { field: "reasoning_content" }, limit: { context: 256_000, output: 8_192 } },
};

export const scenarios: ScenarioSpec[] = [
    { route: kimi, kind: "age", loopSteps: 12, keepReasoningTokens: 1000, callBudget: 21 },
    { route: kimi, kind: "drop", loopSteps: 12, keepReasoningTokens: 1_000_000, callBudget: 21 },
];
