import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
    buildMagicContextSection,
    detectAgentFromSystemPrompt,
} from "../../agents/magic-context-prompt";
import { escapeXmlAttr, escapeXmlContent } from "../../features/magic-context/compartment-storage";
import { getKeyFiles } from "../../features/magic-context/key-files/storage-key-files";
import {
    type ContextDatabase,
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { getActiveUserMemories } from "../../features/magic-context/user-memory/storage-user-memory";
import { log, sessionLog } from "../../shared/logger";
import { estimateTokens } from "./read-session-formatting";

const MAGIC_CONTEXT_MARKER = "## Magic Context";
const PROJECT_DOCS_MARKER = "<project-docs>";
const USER_PROFILE_MARKER = "<user-profile>";
const KEY_FILES_MARKER = "<key-files>";
const cachedUserProfileBySession = new Map<string, string | null>();
const cachedKeyFilesBySession = new Map<string, string | null>();

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
    dropToolStructure: boolean;
    dreamerEnabled: boolean;
    /** When true + dreamerEnabled, inject ARCHITECTURE.md and STRUCTURE.md into system prompt */
    injectDocs: boolean;
    /** Project root directory for reading doc files */
    directory: string;
    flushedSessions: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
    /** When true, inject stable user memories as <user-profile> into system prompt */
    experimentalUserMemories?: boolean;
    /** When true, inject pinned key files as <key-files> into system prompt */
    experimentalPinKeyFiles?: boolean;
    /** Token budget for key files injection (default 10000) */
    experimentalPinKeyFilesTokenBudget?: number;
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
                deps.dropToolStructure,
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

        // ── Step 1.6: Inject stable user memories as user profile ──
        if (deps.experimentalUserMemories) {
            const hasCachedProfile = cachedUserProfileBySession.has(sessionId);

            if (!hasCachedProfile || isCacheBusting) {
                const memories = getActiveUserMemories(deps.db);
                if (memories.length > 0) {
                    const items = memories.map((m) => `- ${m.content}`).join("\n");
                    cachedUserProfileBySession.set(
                        sessionId,
                        `${USER_PROFILE_MARKER}\n${items}\n</user-profile>`,
                    );
                    if (!hasCachedProfile) {
                        sessionLog(sessionId, `loaded ${memories.length} user profile memorie(s)`);
                    }
                } else {
                    cachedUserProfileBySession.set(sessionId, null);
                }
            }

            const profileBlock = cachedUserProfileBySession.get(sessionId);
            if (profileBlock && !fullPrompt.includes(USER_PROFILE_MARKER)) {
                output.system.push(profileBlock);
            }
        }

        // ── Step 1.7: Inject pinned key files ──
        if (deps.experimentalPinKeyFiles) {
            const hasCachedKeyFiles = cachedKeyFilesBySession.has(sessionId);

            if (!hasCachedKeyFiles || isCacheBusting) {
                const keyFileEntries = getKeyFiles(deps.db, sessionId);
                if (keyFileEntries.length > 0) {
                    const sections: string[] = [];
                    const projectRoot = resolve(deps.directory);
                    let remainingBudgetTokens = deps.experimentalPinKeyFilesTokenBudget ?? 10_000;

                    for (const entry of keyFileEntries) {
                        try {
                            const absPath = resolve(deps.directory, entry.filePath);
                            // Path traversal guard: resolved path must be inside project root.
                            // Use realpathSync to follow symlinks — a symlink inside the project
                            // could point outside it, bypassing the resolve() check.
                            if (!absPath.startsWith(projectRoot + sep) && absPath !== projectRoot) {
                                log(
                                    `[magic-context] key file path escapes project root, skipping: ${entry.filePath}`,
                                );
                                continue;
                            }
                            if (!existsSync(absPath)) continue;

                            let realPath: string;
                            try {
                                realPath = realpathSync(absPath);
                            } catch {
                                continue; // broken symlink
                            }
                            if (
                                !realPath.startsWith(projectRoot + sep) &&
                                realPath !== projectRoot
                            ) {
                                log(
                                    `[magic-context] key file symlink escapes project root, skipping: ${entry.filePath} → ${realPath}`,
                                );
                                continue;
                            }

                            const content = readFileSync(realPath, "utf-8").trim();
                            if (content.length === 0) continue;

                            // Token budget enforcement using shared estimator
                            const fileTokens = estimateTokens(content);
                            if (fileTokens > remainingBudgetTokens) {
                                log(
                                    `[magic-context] key file ${entry.filePath} exceeds remaining budget (${fileTokens} > ${remainingBudgetTokens}), skipping`,
                                );
                                continue;
                            }
                            remainingBudgetTokens -= fileTokens;

                            sections.push(
                                `<file path="${escapeXmlAttr(entry.filePath)}">\n${escapeXmlContent(content)}\n</file>`,
                            );
                        } catch (error) {
                            log(
                                `[magic-context] failed to read key file ${entry.filePath}:`,
                                error,
                            );
                        }
                    }
                    if (sections.length > 0) {
                        cachedKeyFilesBySession.set(
                            sessionId,
                            `${KEY_FILES_MARKER}\n${sections.join("\n\n")}\n</key-files>`,
                        );
                        if (!hasCachedKeyFiles) {
                            sessionLog(
                                sessionId,
                                `loaded ${sections.length} key file(s) into system prompt`,
                            );
                        } else {
                            sessionLog(sessionId, "refreshed key files (cache-busting pass)");
                        }
                    } else {
                        cachedKeyFilesBySession.set(sessionId, null);
                    }
                } else {
                    cachedKeyFilesBySession.set(sessionId, null);
                }
            }

            const keyFilesBlock = cachedKeyFilesBySession.get(sessionId);
            if (keyFilesBlock && !fullPrompt.includes(KEY_FILES_MARKER)) {
                output.system.push(keyFilesBlock);
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

        // Estimate system prompt tokens for dashboard visibility.
        // Always refresh when the count has drifted by > 50 tokens — this
        // matters when the tokenizer algorithm itself changed (e.g. upgrade
        // from /3.5 heuristic to real Claude tokenizer) and the stored value
        // is stale even though the hash is unchanged.
        const systemPromptTokens = estimateTokens(systemContent);

        if (currentHash !== previousHash) {
            updateSessionMeta(deps.db, sessionId, {
                systemPromptHash: currentHash,
                systemPromptTokens,
            });
        } else if (Math.abs(sessionMeta.systemPromptTokens - systemPromptTokens) > 50) {
            updateSessionMeta(deps.db, sessionId, { systemPromptTokens });
        }
    };
}
