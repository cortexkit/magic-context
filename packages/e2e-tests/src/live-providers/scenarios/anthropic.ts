import type { ProviderRoute, ScenarioSpec } from "../types";

/** Native Claude subscription requests shaped by the installed anthropic-auth plugin. */
export const claudeOAuth: ProviderRoute = {
    id: "claude-oauth",
    credentialId: "oauth:anthropic",
    authPlugin: "anthropic-auth",
    providerId: "anthropic",
    npm: "@ai-sdk/anthropic",
    upstreamBase: "https://api.anthropic.com/v1",
    model: "claude-opus-5-5",
    protocol: "anthropic-messages",
    modelConfig: { limit: { context: 200_000, output: 1024 } },
    modelOptions: { thinking: { type: "adaptive" }, effort: "low" },
};

export const scenarios: ScenarioSpec[] = [
    { route: claudeOAuth, kind: "trim-only", loopSteps: 12, keepReasoningTokens: 1000, callBudget: 24 },
];
