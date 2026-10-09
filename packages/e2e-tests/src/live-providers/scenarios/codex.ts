import type { ProviderRoute, ScenarioSpec } from "../types";

/** Codex HTTP transport; openai-auth owns subscription auth and final endpoint shaping. */
export const codex: ProviderRoute = {
    id: "codex",
    credentialId: "chatgpt:openai",
    authPlugin: "openai-auth",
    providerId: "openai",
    npm: "@ai-sdk/openai",
    upstreamBase: "https://chatgpt.com/backend-api/codex",
    model: "gpt-5.4-mini",
    protocol: "openai-responses",
    modelConfig: { limit: { context: 400_000, output: 1024 } },
    modelOptions: { store: false, include: ["reasoning.encrypted_content"], reasoningEffort: "low", reasoningSummary: "auto" },
};

export const scenarios: ScenarioSpec[] = [
    { route: codex, kind: "age", loopSteps: 12, keepReasoningTokens: 1000, callBudget: 24 },
];
