/**
 * The provider id OpenCode 2.3 gives its built-in Claude Agent provider, which
 * runs the local Claude Code executable through the Claude Agent SDK
 * (`Provider.ID.claudeAgent` in OpenCode's `packages/schema/src/provider.ts`).
 * OpenCode 2.0.x has no such provider.
 */
export const CLAUDE_AGENT_PROVIDER_ID = "claude-agent";

/**
 * Whether a hidden run's request must carry its task instructions in the first
 * user message instead of relying on the system prompt.
 *
 * The Claude Agent provider builds the system prompt from Claude Code's own
 * preset, the agent definition's `system` text, and the request's system parts
 * after the first. Its session hooks read those before Magic Context's hook
 * shapes the request, so the system text a hidden run writes never reaches the
 * model there. The first user message is the one part of the request that the
 * provider passes through as written.
 */
export function deliversInstructionsInUserMessage(providerID: string | undefined): boolean {
    return providerID === CLAUDE_AGENT_PROVIDER_ID;
}

/**
 * The leading text part that carries a hidden run's task instructions on the
 * Claude Agent provider. It is a pure function of the run's system text, so
 * every step and retry of one run sends identical bytes and the provider's
 * prompt cache holds across them.
 */
export function claudeAgentInstructionsText(system: string): string {
    return `Instructions for this task:\n\n<instructions>\n${system}\n</instructions>`;
}
