import type { ProviderRoute, ScenarioSpec } from "../types";

/**
 * OpenAI Responses with an API key, `store:false`, encrypted reasoning returned inline. The
 * question: is a request accepted when older `reasoning` items are gone but their
 * `function_call` items stay, and what does removal do to billed input on the same session?
 */
export const openaiResponses: ProviderRoute = {
    id: "openai",
    credentialId: "apikey:openai",
    providerId: "openai",
    npm: "@ai-sdk/openai",
    upstreamBase: "https://api.openai.com/v1",
    model: "gpt-5-nano",
    protocol: "openai-responses",
    modelConfig: { limit: { context: 400_000, output: 16_384 } },
    modelOptions: {
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoningEffort: "medium",
        reasoningSummary: "auto",
    },
};

export const scenarios: ScenarioSpec[] = [
    { route: openaiResponses, kind: "age", loopSteps: 12, keepReasoningTokens: 1000, callBudget: 24 },
];
