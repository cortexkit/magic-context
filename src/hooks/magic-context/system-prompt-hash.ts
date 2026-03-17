import {
    type ContextDatabase,
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { log } from "../../shared/logger";

/**
 * Detect system prompt changes via experimental.chat.system.transform.
 *
 * The system array contains the full assembled prompt: agent instructions,
 * environment info, skills, AGENTS.md, and per-message system overrides.
 * If the hash changes between turns, the Anthropic prompt-cache prefix is
 * already busted, so we flush queued operations immediately instead of
 * waiting for TTL or threshold.
 */
export function createSystemPromptHashHandler(deps: {
    db: ContextDatabase;
    flushedSessions: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
}): (input: { sessionID?: string }, output: { system: string[] }) => Promise<void> {
    return async (input, output): Promise<void> => {
        const sessionId = input.sessionID;
        if (!sessionId) return;

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
