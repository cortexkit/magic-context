import type { Database } from "bun:sqlite";
import {
    buildCompartmentBlock,
    escapeXmlContent,
    getCompartments,
    getSessionFacts,
} from "../../features/magic-context/compartment-storage";
import { CATEGORY_PRIORITY } from "../../features/magic-context/memory/constants";
import { getMemoriesByProject } from "../../features/magic-context/memory/storage-memory";
import type { Memory, MemoryCategory } from "../../features/magic-context/memory/types";
import { sessionLog } from "../../shared/logger";
import type { MessageLike } from "./tag-messages";

export interface PreparedCompartmentInjection {
    block: string;
    compartmentEndMessage: number;
    compartmentEndMessageId: string;
    compartmentCount: number;
    skippedVisibleMessages: number;
    factCount: number;
    memoryCount: number;
}

/**
 * In-memory cache of the last compartment injection result per session.
 * On defer (cache-safe) passes, the cached result is replayed so that historian
 * publications between passes do not bust the Anthropic prompt-cache prefix.
 * The cache is refreshed only on cache-busting passes (execute / explicit flush).
 */
const injectionCache = new Map<string, PreparedCompartmentInjection>();

export function clearInjectionCache(sessionId: string): void {
    injectionCache.delete(sessionId);
}

export interface CompartmentInjectionResult {
    injected: boolean;
    compartmentEndMessage: number;
    compartmentCount: number;
    skippedVisibleMessages: number;
}

export function renderMemoryBlock(memories: Memory[]): string | null {
    const byCategory = new Map<MemoryCategory, Memory[]>();
    for (const m of memories) {
        const existing = byCategory.get(m.category);
        if (existing) {
            existing.push(m);
        } else {
            byCategory.set(m.category, [m]);
        }
    }

    const sections: string[] = [];
    for (const category of CATEGORY_PRIORITY) {
        const categoryMemories = byCategory.get(category);
        if (!categoryMemories || categoryMemories.length === 0) {
            continue;
        }
        sections.push(
            `<${category}>`,
            ...categoryMemories.map((m) => `- ${escapeXmlContent(m.content)}`),
            `</${category}>`,
        );
    }

    if (sections.length === 0) {
        return null;
    }

    return `<project-memory>\n${sections.join("\n")}\n</project-memory>`;
}

const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Sort memories by priority (permanent first, then higher seen_count) and trim to budget.
 * Estimates ~4 chars per token for budget enforcement.
 */
function trimMemoriesToBudget(
    sessionId: string,
    memories: Memory[],
    budgetTokens: number,
): Memory[] {
    const sorted = [...memories].sort((a, b) => {
        // Permanent memories first
        if (a.status === "permanent" && b.status !== "permanent") return -1;
        if (b.status === "permanent" && a.status !== "permanent") return 1;
        // Then by seen count descending (more frequently seen = higher priority)
        return b.seenCount - a.seenCount;
    });

    const result: Memory[] = [];
    let usedTokens = 0;

    for (const memory of sorted) {
        // Estimate: category tag overhead (~20 chars) + "- " prefix + content
        const memoryTokens = Math.ceil((memory.content.length + 22) / CHARS_PER_TOKEN_ESTIMATE);
        if (usedTokens + memoryTokens > budgetTokens) {
            break;
        }
        result.push(memory);
        usedTokens += memoryTokens;
    }

    if (result.length < memories.length) {
        sessionLog(
            sessionId,
            `trimmed memories from ${memories.length} to ${result.length} to fit injection budget of ${budgetTokens} tokens`,
        );
    }

    return result;
}

export function prepareCompartmentInjection(
    db: Database,
    sessionId: string,
    messages: MessageLike[],
    isCacheBusting: boolean,
    projectPath?: string,
    injectionBudgetTokens?: number,
): PreparedCompartmentInjection | null {
    // On defer (cache-safe) passes, replay the cached injection result so that
    // historian publications between passes do not bust the prompt-cache prefix.
    const cached = injectionCache.get(sessionId);
    if (!isCacheBusting && cached) {
        // Re-do the splice with the cached boundary (messages are rebuilt fresh each pass)
        if (cached.compartmentEndMessageId.length > 0) {
            const cutoffIndex = messages.findIndex(
                (message) => message.info.id === cached.compartmentEndMessageId,
            );
            if (cutoffIndex >= 0) {
                const remaining = messages.slice(cutoffIndex + 1);
                messages.splice(0, messages.length, ...remaining);
            } else {
                // Anchored message no longer in array (dropped/compacted).
                // Invalidate cache to avoid injecting history with stale boundaries.
                sessionLog(
                    sessionId,
                    `compartment injection: cached boundary ${cached.compartmentEndMessageId} not found in messages, invalidating cache`,
                );
                injectionCache.delete(sessionId);
                return null;
            }
        }
        return cached;
    }

    const compartments = getCompartments(db, sessionId);
    if (compartments.length === 0) {
        injectionCache.delete(sessionId);
        return null;
    }

    const facts = getSessionFacts(db, sessionId);

    let memoryBlock: string | undefined;
    let memoryCount = 0;
    if (projectPath) {
        // Use cached memory block to avoid cache busting on background changes (ctx_memory write, promotion).
        // Cache is cleared by replaceAllCompartmentState after historian runs (which already bust cache).
        // Audit note: `as` cast is safe here — session_meta schema is owned by this plugin and the two
        // columns are guaranteed present after initializeDatabase(). A type guard would add overhead on a
        // hot path (every transform) for a table we fully control.
        const cachedMemory = db
            .prepare(
                "SELECT memory_block_cache, memory_block_count FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as { memory_block_cache: string; memory_block_count: number } | null;

        if (cachedMemory?.memory_block_cache) {
            memoryBlock = cachedMemory.memory_block_cache;
            memoryCount = cachedMemory.memory_block_count;
        } else {
            let memories = getMemoriesByProject(db, projectPath, ["active", "permanent"]);
            if (injectionBudgetTokens && memories.length > 0) {
                memories = trimMemoriesToBudget(sessionId, memories, injectionBudgetTokens);
            }
            memoryCount = memories.length;
            memoryBlock = renderMemoryBlock(memories) ?? undefined;

            // Snapshot so subsequent turns reuse the same block without cache bust
            db.prepare(
                "UPDATE session_meta SET memory_block_cache = ?, memory_block_count = ? WHERE session_id = ?",
            ).run(memoryBlock ?? "", memoryCount, sessionId);
        }
    }

    const block = buildCompartmentBlock(compartments, facts, memoryBlock);
    const lastCompartment = compartments[compartments.length - 1];
    const lastEnd = lastCompartment.endMessage;
    const lastEndMessageId = lastCompartment.endMessageId;

    if (lastEndMessageId.length === 0) {
        sessionLog(
            sessionId,
            "injecting legacy compartments without visible-prefix trimming because latest stored compartment has no end_message_id",
            {
                compartmentCount: compartments.length,
                compartmentEndMessage: lastEnd,
            },
        );
        const result: PreparedCompartmentInjection = {
            block,
            compartmentEndMessage: lastEnd,
            compartmentEndMessageId: "",
            compartmentCount: compartments.length,
            skippedVisibleMessages: 0,
            factCount: facts.length,
            memoryCount,
        };
        injectionCache.set(sessionId, result);
        return result;
    }

    let skippedVisibleMessages = 0;
    const cutoffIndex = messages.findIndex((message) => message.info.id === lastEndMessageId);
    if (cutoffIndex >= 0) {
        skippedVisibleMessages = cutoffIndex + 1;
        const remaining = messages.slice(cutoffIndex + 1);
        messages.splice(0, messages.length, ...remaining);
    }

    const result: PreparedCompartmentInjection = {
        block,
        compartmentEndMessage: lastEnd,
        compartmentEndMessageId: lastEndMessageId,
        compartmentCount: compartments.length,
        skippedVisibleMessages,
        factCount: facts.length,
        memoryCount,
    };
    injectionCache.set(sessionId, result);
    return result;
}

export function renderCompartmentInjection(
    sessionId: string,
    messages: MessageLike[],
    prepared: PreparedCompartmentInjection,
): CompartmentInjectionResult {
    const historyBlock = `<session-history>\n${prepared.block}\n</session-history>`;
    const firstMessage = messages[0];
    const textPart = firstMessage ? findFirstTextPart(firstMessage.parts) : null;
    if (!firstMessage || !textPart || isDroppedPlaceholder(textPart.text)) {
        messages.unshift({
            info: { role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: historyBlock }],
        });
    } else {
        textPart.text = `${historyBlock}\n\n${textPart.text}`;
    }

    const memoryLabel = prepared.memoryCount > 0 ? ` + ${prepared.memoryCount} memories` : "";
    sessionLog(
        sessionId,
        `injected ${prepared.compartmentCount} compartments + ${prepared.factCount} facts${memoryLabel} into message[0]`,
    );

    return {
        injected: true,
        compartmentEndMessage: prepared.compartmentEndMessage,
        compartmentCount: prepared.compartmentCount,
        skippedVisibleMessages: prepared.skippedVisibleMessages,
    };
}

function findFirstTextPart(parts: unknown[]): { type: string; text: string } | null {
    for (const part of parts) {
        if (part === null || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string" && !p.ignored) {
            return p as unknown as { type: string; text: string };
        }
    }
    return null;
}

function isDroppedPlaceholder(text: string): boolean {
    return /^\[dropped §\d+§\]$/.test(text.trim());
}
