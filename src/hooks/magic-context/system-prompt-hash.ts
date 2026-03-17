import {
    buildMagicContextSection,
    detectAgentFromSystemPrompt,
} from "../../agents/magic-context-prompt";
import {
    type ContextDatabase,
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { log } from "../../shared/logger";

const MAGIC_CONTEXT_MARKER = "## Magic Context";

/**
 * Handle system prompt via experimental.chat.system.transform:
 *
 * 1. Inject per-agent magic-context guidance into the system prompt.
 *    Detects known agents (Sisyphus, Atlas, etc.) from prompt content and
 *    injects tailored reduction guidance. Falls back to generic guidance
 *    for unknown agents. Skips injection if guidance is already present
 *    (e.g., baked into the agent prompt by oh-my-opencode).
 *
 * 2. Detect system prompt changes for cache-flush triggering.
 *    If the hash changes between turns, the Anthropic prompt-cache prefix is
 *    already busted, so we flush queued operations immediately.
 */
export function createSystemPromptHashHandler(deps: {
    db: ContextDatabase;
    protectedTags: number;
    flushedSessions: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
}): (input: { sessionID?: string }, output: { system: string[] }) => Promise<void> {
    return async (input, output): Promise<void> => {
        const sessionId = input.sessionID;
        if (!sessionId) return;

        // ── Step 1: Inject magic-context guidance ──
        const fullPrompt = output.system.join("\n");
        if (fullPrompt.length > 0 && !fullPrompt.includes(MAGIC_CONTEXT_MARKER)) {
            const detectedAgent = detectAgentFromSystemPrompt(fullPrompt);
            const guidance = buildMagicContextSection(detectedAgent, deps.protectedTags);
            output.system.push(guidance);
            log(
                `[magic-context] injected ${detectedAgent ?? "generic"} guidance into system prompt`,
            );
        }

        // ── Step 2: Detect system prompt changes ──
        const systemContent = output.system.join("\n");
        if (systemContent.length === 0) return;

        const currentHash = Number(Bun.hash(systemContent));

        let sessionMeta: import("../../features/magic-context/types").SessionMeta | undefined;
        try {
            sessionMeta = getOrCreateSessionMeta(deps.db, sessionId);
        } catch {
            return;
        }

        const previousHash = sessionMeta.systemPromptHash;
        if (previousHash !== 0 && previousHash !== currentHash) {
            log(`[magic-context] system prompt changed for session ${sessionId}, triggering flush`);
            deps.flushedSessions.add(sessionId);
            deps.lastHeuristicsTurnId.delete(sessionId);
        }

        if (currentHash !== previousHash) {
            updateSessionMeta(deps.db, sessionId, { systemPromptHash: currentHash });
        }
    };
}
