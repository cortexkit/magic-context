import {
    buildCompartmentBlock,
    type CompartmentDateRanges,
    escapeXmlContent,
    getCompartments,
    getSessionFacts,
} from "../../features/magic-context/compartment-storage";
import { CATEGORY_PRIORITY } from "../../features/magic-context/memory/constants";
import { getMemoriesByProject } from "../../features/magic-context/memory/storage-memory";
import type { Memory, MemoryCategory } from "../../features/magic-context/memory/types";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { getMessageTimesFromOpenCodeDb } from "./read-session-db";
import { estimateTokens } from "./read-session-formatting";
import type { MessageLike } from "./tag-messages";
import { formatDate } from "./temporal-awareness";

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
 * On non-flush passes, the cached result is replayed so that historian
 * publications between passes do not bust the Anthropic prompt-cache prefix.
 * The cache is invalidated explicitly via clearInjectionCache() after
 * historian/compressor/recomp write new compartments or facts.
 *
 * Bounded LRU: session.deleted clears entries explicitly, but sessions that
 * are never deleted (crashed OpenCode, force-quit, archived sessions) would
 * otherwise leak PreparedCompartmentInjection objects holding tens of KB of
 * XML each. 100 is generously above any realistic working set of active
 * sessions — evicted entries are simply recomputed on the next cache-busting
 * pass from the authoritative SQLite compartment state.
 */
const INJECTION_CACHE_MAX = 100;
const injectionCache = new BoundedSessionMap<PreparedCompartmentInjection>(INJECTION_CACHE_MAX);

export function clearInjectionCache(sessionId: string): void {
    injectionCache.delete(sessionId);
}

/**
 * Return the set of memory ids currently rendered in the cached
 * <session-history> block for this session, if any. Used by ctx_search
 * to hard-filter memories the agent already sees in context — retrieving
 * them from search wastes tokens and pushes high-signal raw-history hits
 * further down the ranking.
 *
 * Returns null when no cache exists or the JSON payload is malformed
 * (callers should treat null as "don't filter" — the worst case is a
 * redundant memory result, not a correctness issue).
 */
export function getVisibleMemoryIds(db: Database, sessionId: string): Set<number> | null {
    try {
        const row = db
            .prepare("SELECT memory_block_ids FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { memory_block_ids: string | null } | null;
        if (!row?.memory_block_ids) return null;
        const parsed = JSON.parse(row.memory_block_ids) as unknown;
        if (!Array.isArray(parsed)) return null;
        const ids = new Set<number>();
        for (const value of parsed) {
            if (typeof value === "number" && Number.isFinite(value)) {
                ids.add(value);
            }
        }
        return ids.size > 0 ? ids : null;
    } catch {
        return null;
    }
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

/** Constraint keywords that signal a memory encodes a rule rather than a description. */
const CONSTRAINT_KEYWORDS = /\b(must|never|always|cannot|should not|must not)\b/i;

/**
 * Assign a utility tier to a memory for injection priority.
 * Lower tier = higher priority (packed first).
 *
 * Tier 0: Agent actually searched for and found this memory.
 * Tier 1: Contains constraint/rule keywords — likely guards against a real bug.
 * Tier 2: Everything else.
 */
function utilityTier(m: Memory): number {
    if (m.retrievalCount > 0) return 0;
    if (CONSTRAINT_KEYWORDS.test(m.content)) return 1;
    return 2;
}

/**
 * Sort memories by priority and trim to budget.
 *
 * Priority order:
 *   1. permanent status first
 *   2. utility tier (retrieved > constraint > other)
 *   3. seen count descending
 *   4. shorter content first (fit more memories in budget)
 *   5. deterministic id tiebreaker for cache stability
 *
 * Uses the real Claude tokenizer (via estimateTokens) so the trim stays
 * consistent with the rest of the plugin's token math — mismatching units
 * (chars/4 here vs real tokens elsewhere) caused either under- or
 * over-injection of memories, depending on memory content shape.
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
        // Then by utility tier (lower = higher priority)
        const tierDiff = utilityTier(a) - utilityTier(b);
        if (tierDiff !== 0) return tierDiff;
        // Then by seen count descending (more frequently seen = higher priority)
        const seenDiff = b.seenCount - a.seenCount;
        if (seenDiff !== 0) return seenDiff;
        // Prefer shorter memories so more fit in budget
        const lenDiff = a.content.length - b.content.length;
        if (lenDiff !== 0) return lenDiff;
        // Deterministic tiebreaker by id to ensure stable ordering for cache safety
        return a.id - b.id;
    });

    const result: Memory[] = [];
    let usedTokens = 0;

    for (const memory of sorted) {
        // Estimate the rendered memory line ("- {content}") with the real
        // Claude tokenizer, plus a fixed ~6-token allowance for opening and
        // closing XML category tags amortized per item. Keeps units
        // consistent with rpc-handlers.ts / transform.ts / system-prompt-hash.ts
        // so the sidebar's "Memories" segment matches what actually lands in
        // the injection block.
        const memoryTokens = estimateTokens(`- ${memory.content}`) + 6;
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
    temporalAwareness?: boolean,
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
                // Boundary message not in array — covered messages were already
                // trimmed by OpenCode (compaction, old history not sent). The splice
                // is effectively a no-op because there's nothing to splice out.
                // Keep the cached injection so <session-history> stays stable on
                // defer passes instead of alternating between injected/not-injected.
                sessionLog(
                    sessionId,
                    `compartment injection: cached boundary ${cached.compartmentEndMessageId} not in messages (already trimmed), reusing cache`,
                );
            }
        }
        return cached;
    }

    const compartments = getCompartments(db, sessionId);
    const facts = getSessionFacts(db, sessionId);

    let memoryBlock: string | undefined;
    let memoryCount = 0;
    if (projectPath) {
        // Use cached memory block to avoid cache busting on background changes (ctx_memory write, promotion).
        // Cache is cleared by replaceSessionFacts/replaceAllCompartmentState after historian/compressor/recomp.
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
            // Capture ids of memories actually rendered in the block. Stored in
            // session_meta.memory_block_ids as JSON so ctx_search can hard-filter
            // them out of search results (the agent already sees them in <session-history>).
            const renderedIds = memories.map((m) => m.id);

            // Snapshot so subsequent turns reuse the same block without cache bust.
            // Swallow SQLITE_BUSY: the cache is a pure optimization (the block itself
            // is already computed and returned below). If another writer holds the DB
            // past busy_timeout=5s — typically a concurrent dreamer/historian child
            // session or a second OpenCode process — we'd rather let the transform
            // proceed with a one-turn cache miss than crash the user's prompt.
            // Issue: https://github.com/cortexkit/opencode-magic-context/issues/23
            try {
                db.prepare(
                    "UPDATE session_meta SET memory_block_cache = ?, memory_block_count = ?, memory_block_ids = ? WHERE session_id = ?",
                ).run(memoryBlock ?? "", memoryCount, JSON.stringify(renderedIds), sessionId);
            } catch (error) {
                const code = (error as { code?: string } | null)?.code;
                if (code === "SQLITE_BUSY") {
                    sessionLog(
                        sessionId,
                        "memory_block_cache UPDATE hit SQLITE_BUSY, skipping snapshot for this turn",
                    );
                } else {
                    throw error;
                }
            }
        }
    }

    // Nothing to inject if we have no compartments, no facts, and no memories
    if (compartments.length === 0 && facts.length === 0 && !memoryBlock) {
        injectionCache.delete(sessionId);
        return null;
    }

    let dateRanges: CompartmentDateRanges | undefined;
    if (temporalAwareness && compartments.length > 0) {
        // Resolve start/end message times from OpenCode's DB in a single batched query.
        const ids = new Set<string>();
        for (const c of compartments) {
            if (c.startMessageId) ids.add(c.startMessageId);
            if (c.endMessageId) ids.add(c.endMessageId);
        }
        const times = getMessageTimesFromOpenCodeDb(sessionId, Array.from(ids));
        const byId = new Map<number, { start: string; end: string }>();
        for (const c of compartments) {
            const startMs = times.get(c.startMessageId);
            const endMs = times.get(c.endMessageId);
            if (startMs !== undefined && endMs !== undefined) {
                byId.set(c.id, { start: formatDate(startMs), end: formatDate(endMs) });
            }
        }
        if (byId.size > 0) dateRanges = { byId };
    }

    const block = buildCompartmentBlock(compartments, facts, memoryBlock, dateRanges);

    // When there are no compartments yet (new session, or memories seeded before
    // historian first run), inject memories/facts without a boundary cutoff.
    // No messages are spliced because there's nothing to replace — the block is
    // prepended to message[0] the same way system-level context is.
    if (compartments.length === 0) {
        const result: PreparedCompartmentInjection = {
            block,
            compartmentEndMessage: 0,
            compartmentEndMessageId: "",
            compartmentCount: 0,
            skippedVisibleMessages: 0,
            factCount: facts.length,
            memoryCount,
        };
        injectionCache.set(sessionId, result);
        return result;
    }

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
    if (prepared.compartmentCount > 0) {
        sessionLog(
            sessionId,
            `injected ${prepared.compartmentCount} compartments + ${prepared.factCount} facts${memoryLabel} into message[0]`,
        );
    } else {
        sessionLog(
            sessionId,
            `injected ${prepared.factCount} facts${memoryLabel} into message[0] (no compartments yet)`,
        );
    }

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
