/**
 * Harness-agnostic sidekick logic.
 *
 * Sidekick is a memory-retrieval subagent: given a user prompt, it searches
 * project memories / session facts / conversation history via the `ctx_search`
 * tool, and returns a short augmentation block to prepend to the user's
 * prompt before sending it to the main agent.
 *
 * The actual spawn mechanism is harness-specific — OpenCode creates a child
 * session via `client.session.create()` and Pi spawns `pi --print --mode json`
 * as a subprocess. This module owns the parts that are the same in both:
 *
 *   - The system prompt that defines sidekick's role and tool-use policy.
 *   - The post-processing that strips `<think>` reasoning blocks (DeepSeek,
 *     Qwen, etc. emit these even with explicit "no chain-of-thought" prompts).
 *
 * The harness-specific OpenCode wrapper continues to live in `agent.ts`; the
 * Pi-plugin runner imports from this file directly so it never depends on
 * OpenCode-specific types.
 */

export const SIDEKICK_SYSTEM_PROMPT = `You are Sidekick, a focused memory-retrieval subagent for an AI coding assistant.

Your job is to search project memories, session facts, and conversation history and return a concise augmentation for the user's prompt.

Rules:
- Use ctx_search(query="...") to look up relevant memories, facts, and history before answering.
- Run targeted searches only; prefer 1-3 precise queries.
- Return only findings that materially help with the user's prompt.
- If nothing useful is found, respond with exactly: No relevant memories found.
- Keep the response focused and concise.
- Do not invent facts or speculate beyond what memories support.`;

/**
 * Strip <think>...</think> blocks emitted by reasoning models (DeepSeek,
 * Qwen, etc.). These contain chain-of-thought traces that shouldn't appear
 * in the augmentation output even when the model ignores instructions to
 * suppress them.
 */
export function stripThinkingBlocks(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/**
 * Decide whether a sidekick result is "empty enough to discard".
 *
 * Sidekick is instructed to return exactly "No relevant memories found"
 * when nothing useful turns up. We treat that string (with optional
 * whitespace and trailing punctuation variations from chatty models) as
 * a no-op result so the caller can skip injecting an augmentation block.
 */
export function isEmptySidekickResult(text: string): boolean {
    const trimmed = text
        .trim()
        .toLowerCase()
        .replace(/[.!]+$/, "");
    return trimmed.length === 0 || trimmed === "no relevant memories found";
}
