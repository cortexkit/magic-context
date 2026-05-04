import { DREAMER_AGENT } from "../agents/dreamer";
import { HISTORIAN_AGENT, HISTORIAN_EDITOR_AGENT } from "../agents/historian";
import { SIDEKICK_AGENT } from "../agents/sidekick";

/**
 * Provider-agnostic fallback chain entry.
 * Each entry specifies a model and the providers to try in priority order.
 * Follows oh-my-opencode's FallbackEntry pattern — `opencode` acts as a
 * catch-all proxy provider and is listed last in most entries.
 */
export type FallbackEntry = {
    providers: string[];
    model: string;
    variant?: string;
};

export type AgentModelRequirement = {
    fallbackChain: FallbackEntry[];
};

// Historian: quality matters, single long prompt.
// Copilot first (request-based pricing, ideal for single-prompt background work).
const HISTORIAN_FALLBACK_CHAIN: FallbackEntry[] = [
    { providers: ["github-copilot", "anthropic", "opencode"], model: "claude-sonnet-4-6" },
    { providers: ["opencode-go"], model: "minimax-m2.7" },
    {
        providers: ["zai-coding-plan", "bailian-coding-plan", "opencode-go", "opencode"],
        model: "glm-5",
    },
    { providers: ["openai", "github-copilot", "opencode"], model: "gpt-5.4" },
    { providers: ["google", "github-copilot", "opencode"], model: "gemini-3.1-pro" },
];

// Dreamer: runs overnight during idle time, can be slow.
// Copilot first (request-based pricing). Local models also work well here.
const DREAMER_FALLBACK_CHAIN: FallbackEntry[] = [
    { providers: ["github-copilot", "anthropic", "opencode"], model: "claude-sonnet-4-6" },
    { providers: ["google", "github-copilot", "opencode"], model: "gemini-3-flash" },
    {
        providers: ["zai-coding-plan", "bailian-coding-plan", "opencode-go", "opencode"],
        model: "glm-5",
    },
    { providers: ["opencode-go"], model: "minimax-m2.7" },
    { providers: ["github-copilot", "openai", "opencode"], model: "gpt-5.4-mini" },
];

// Sidekick: speed is critical — fast inference providers first.
// No Copilot preference (low token count, request-based pricing doesn't help).
const SIDEKICK_FALLBACK_CHAIN: FallbackEntry[] = [
    { providers: ["cerebras"], model: "qwen-3-235b-a22b-instruct-2507" },
    { providers: ["google", "github-copilot", "opencode"], model: "gemini-3-flash" },
    { providers: ["openai", "github-copilot", "opencode"], model: "gpt-5.4-mini" },
    { providers: ["opencode"], model: "gpt-5-nano" },
];

export const AGENT_MODEL_REQUIREMENTS: Record<string, AgentModelRequirement> = {
    [HISTORIAN_AGENT]: { fallbackChain: HISTORIAN_FALLBACK_CHAIN },
    // Editor reuses historian's fallback chain — same input profile (long single prompt).
    [HISTORIAN_EDITOR_AGENT]: { fallbackChain: HISTORIAN_FALLBACK_CHAIN },
    [DREAMER_AGENT]: { fallbackChain: DREAMER_FALLBACK_CHAIN },
    [SIDEKICK_AGENT]: { fallbackChain: SIDEKICK_FALLBACK_CHAIN },
};

/**
 * Expand a provider-agnostic fallback chain into a flat `provider/model` list
 * that OpenCode's agent config accepts as `fallback_models`.
 */
export function expandFallbackChain(chain: FallbackEntry[]): string[] {
    const models: string[] = [];
    for (const entry of chain) {
        for (const provider of entry.providers) {
            models.push(`${provider}/${entry.model}`);
        }
    }
    return models;
}

/**
 * Get the expanded fallback_models list for an agent.
 * Returns undefined if no requirement is defined.
 */
export function getAgentFallbackModels(agent: string): string[] | undefined {
    const requirement = AGENT_MODEL_REQUIREMENTS[agent];
    if (!requirement) return undefined;
    return expandFallbackChain(requirement.fallbackChain);
}
