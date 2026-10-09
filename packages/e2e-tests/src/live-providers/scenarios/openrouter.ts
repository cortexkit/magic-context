import type { ProviderRoute, ScenarioSpec } from "../types";

/**
 * OpenRouter chat completions, where reasoning comes back as `reasoning_details`. One Anthropic
 * model, whose thinking blocks carry provider signatures, and one non-Anthropic reasoning
 * model, so both kinds of `reasoning_details` are covered.
 */
const openrouterBase = {
    credentialId: "apikey:openrouter",
    providerId: "openrouter",
    npm: "@openrouter/ai-sdk-provider",
    upstreamBase: "https://openrouter.ai/api/v1",
    protocol: "chat-completions",
} as const satisfies Omit<ProviderRoute, "id" | "model">;

export const openrouterClaude: ProviderRoute = {
    ...openrouterBase,
    id: "openrouter-claude-haiku-4.5",
    model: "anthropic/claude-haiku-4.5",
    modelOptions: { reasoning: { max_tokens: 1024 } },
};

export const openrouterGemini: ProviderRoute = {
    ...openrouterBase,
    id: "openrouter-gemini-3-flash",
    model: "google/gemini-3-flash-preview",
    modelOptions: { reasoning: { effort: "low" } },
};

export const scenarios: ScenarioSpec[] = [
    { route: openrouterClaude, kind: "age", loopSteps: 12, keepReasoningTokens: 1000, callBudget: 21 },
    { route: openrouterGemini, kind: "age", loopSteps: 12, keepReasoningTokens: 1000, callBudget: 21 },
];
