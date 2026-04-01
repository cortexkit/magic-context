import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    buildMagicContextSection,
    detectAgentFromSystemPrompt,
} from "../../agents/magic-context-prompt";
import {
    type ContextDatabase,
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { log, sessionLog } from "../../shared/logger";

const MAGIC_CONTEXT_MARKER = "## Magic Context";
const PROJECT_DOCS_MARKER = "<project-docs>";

const DOC_FILES = ["ARCHITECTURE.md", "STRUCTURE.md"] as const;

/**
 * Read dreamer-maintained project docs from the repo root.
 * Returns a wrapped XML block or null if no docs exist.
 */
function readProjectDocs(directory: string): string | null {
    const sections: string[] = [];

    for (const filename of DOC_FILES) {
        const filePath = join(directory, filename);
        try {
            if (existsSync(filePath)) {
                const content = readFileSync(filePath, "utf-8").trim();
                if (content.length > 0) {
                    sections.push(`<${filename}>\n${content}\n</${filename}>`);
                }
            }
        } catch (error) {
            log(`[magic-context] failed to read ${filename}:`, error);
        }
    }

    if (sections.length === 0) return null;

    return `${PROJECT_DOCS_MARKER}\n${sections.join("\n\n")}\n</project-docs>`;
}

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
    ctxReduceEnabled: boolean;
    dreamerEnabled: boolean;
    /** When true + dreamerEnabled, inject ARCHITECTURE.md and STRUCTURE.md into system prompt */
    injectDocs: boolean;
    /** Project root directory for reading doc files */
    directory: string;
    flushedSessions: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
}): (input: { sessionID?: string }, output: { system: string[] }) => Promise<void> {
    // Per-session sticky date: we freeze the date string from the system prompt
    // and only update it on cache-busting passes. This prevents a midnight date
    // flip from causing an unnecessary flush + cache rebuild.
    const stickyDateBySession = new Map<string, string>();

    // Per-session cached doc content: read from disk on first access, refreshed
    // only on cache-busting passes so mid-session dreamer doc updates don't cause
    // spurious cache busts.
    const cachedDocsBySession = new Map<string, string | null>();

    const shouldInjectDocs = deps.dreamerEnabled && deps.injectDocs;

    return async (input, output): Promise<void> => {
        const sessionId = input.sessionID;
        if (!sessionId) return;

        // ── Step 1: Inject magic-context guidance ──
        const fullPrompt = output.system.join("\n");
        if (fullPrompt.length > 0 && !fullPrompt.includes(MAGIC_CONTEXT_MARKER)) {
            const detectedAgent = detectAgentFromSystemPrompt(fullPrompt);
            const guidance = buildMagicContextSection(
                detectedAgent,
                deps.protectedTags,
                deps.ctxReduceEnabled,
                deps.dreamerEnabled,
            );
            output.system.push(guidance);
            sessionLog(
                sessionId,
                `injected ${detectedAgent ?? "generic"} guidance into system prompt`,
            );
        }

        // ── Step 1.5: Inject dreamer-maintained project docs ──
        const isCacheBusting = deps.flushedSessions.has(sessionId);

        if (shouldInjectDocs) {
            const hasCached = cachedDocsBySession.has(sessionId);

            if (!hasCached || isCacheBusting) {
                // Read fresh from disk on first access or cache-busting pass
                const docsContent = readProjectDocs(deps.directory);
                cachedDocsBySession.set(sessionId, docsContent);
                if (docsContent && !hasCached) {
                    sessionLog(sessionId, `loaded project docs (${docsContent.length} chars)`);
                } else if (docsContent && isCacheBusting) {
                    sessionLog(sessionId, "refreshed project docs (cache-busting pass)");
                }
            }

            const docsBlock = cachedDocsBySession.get(sessionId);
            if (docsBlock && !fullPrompt.includes(PROJECT_DOCS_MARKER)) {
                output.system.push(docsBlock);
            }
        }

        // ── Step 2: Freeze volatile date to prevent unnecessary cache busts ──
        const DATE_PATTERN = /Today's date: .+/;

        for (let i = 0; i < output.system.length; i++) {
            const match = output.system[i].match(DATE_PATTERN);
            if (!match) continue;

            const currentDate = match[0];
            const stickyDate = stickyDateBySession.get(sessionId);

            if (!stickyDate) {
                // First time seeing this session — store the date
                stickyDateBySession.set(sessionId, currentDate);
            } else if (currentDate !== stickyDate) {
                if (isCacheBusting) {
                    // Cache is already busting — update to the real date
                    stickyDateBySession.set(sessionId, currentDate);
                    sessionLog(
                        sessionId,
                        `system prompt date updated: ${stickyDate} → ${currentDate} (cache-busting pass)`,
                    );
                } else {
                    // Defer pass — replace with the sticky date to keep prompt stable
                    output.system[i] = output.system[i].replace(DATE_PATTERN, stickyDate);
                    sessionLog(
                        sessionId,
                        `system prompt date frozen: real=${currentDate}, using=${stickyDate} (defer pass)`,
                    );
                }
            }
            break;
        }

        // ── Step 3: Detect system prompt changes ──
        const systemContent = output.system.join("\n");
        if (systemContent.length === 0) return;

        // Use hex digest — numeric strings get coerced by SQLite INTEGER column affinity,
        // causing precision loss on read-back and infinite hash-change flushes.
        const currentHash = new Bun.CryptoHasher("md5").update(systemContent).digest("hex");

        let sessionMeta: import("../../features/magic-context/types").SessionMeta | undefined;
        try {
            sessionMeta = getOrCreateSessionMeta(deps.db, sessionId);
        } catch (error) {
            sessionLog(sessionId, "system-prompt-hash DB update failed:", error);
            return;
        }

        const previousHash = sessionMeta.systemPromptHash;
        if (previousHash !== "" && previousHash !== "0" && previousHash !== currentHash) {
            sessionLog(
                sessionId,
                `system prompt hash changed: ${previousHash} → ${currentHash} (len=${systemContent.length}), triggering flush`,
            );
            deps.flushedSessions.add(sessionId);
            deps.lastHeuristicsTurnId.delete(sessionId);
        } else if (previousHash === "" || previousHash === "0") {
            sessionLog(
                sessionId,
                `system prompt hash initialized: ${currentHash} (len=${systemContent.length})`,
            );
        }

        // Estimate system prompt tokens (~4 chars per token) for dashboard visibility
        const systemPromptTokens = Math.ceil(systemContent.length / 4);

        if (currentHash !== previousHash) {
            updateSessionMeta(deps.db, sessionId, {
                systemPromptHash: currentHash,
                systemPromptTokens,
            });
        } else if (sessionMeta.systemPromptTokens === 0 && systemPromptTokens > 0) {
            // Backfill on first pass when hash was already initialized
            updateSessionMeta(deps.db, sessionId, { systemPromptTokens });
        }
    };
}
