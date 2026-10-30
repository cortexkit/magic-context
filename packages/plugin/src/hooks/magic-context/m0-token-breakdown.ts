import { getMemoriesByProject } from "../../features/magic-context/memory/storage-memory";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { extractM0Block } from "./decay-render";
import { measureHostTokenText as estimateTokens } from "./host-token-breakdown";
import { renderMemoryBlockV2, trimMemoriesToBudgetV2 } from "./inject-compartments";

/**
 * Per-block token attribution for the synthetic m[0] message, shared by BOTH
 * harnesses (OpenCode sidebar/RPC + Pi /ctx-status dialog) so they NEVER
 * diverge on what the categories are or how they're measured.
 *
 * v2 reality this encodes:
 *  - Compartments are DECAY-RENDERED under `## start-end · date · title`
 *    headings — the real on-wire `<session-history>` slice is far smaller than
 *    Σ(full p1 content), so we measure the ACTUAL
 *    slice of the persisted m[0] snapshot (cached_m0_bytes), not Σp1.
 *  - `<project-docs>` and `<user-profile>` moved into m[0] (out of the system
 *    prompt) — they are their own buckets, not Conversation.
 *  - Memories render as the compact v2 `<project-memory>` slice (category groups
 *    containing `#id: fact` lines), not the legacy `memory_block_cache` shape.
 *  - Facts are RETIRED as a render source (promoted to memories) → factTokens
 *    is always 0; the field is kept only for dashboard/back-compat shape.
 *
 * Cold-start fallbacks (no materialized m[0] yet) mirror what WILL be injected
 * on first render: Σp1 for compartments and an on-demand v2 memory render.
 */
export interface M0BlockTokens {
    docsTokens: number;
    profileTokens: number;
    memoryTokens: number;
    /** Anthropic vision cost for the 1092x1092 mural image. */
    muralTokens: number;
    compartmentTokens: number;
    /** Always 0 in v2 (facts promoted to memories); kept for shape stability. */
    factTokens: number;
}

export function computeM0BlockTokens(
    db: ContextDatabase,
    sessionId: string,
    args: {
        m0Text: string;
        /**
         * Persisted m[1] delta. Compartments published since the last m[0] fold
         * are served there, in a `<new-compartments>` block, until the next
         * fold moves them into m[0]'s `<session-history>`.
         */
        m1Text?: string;
        projectIdentity: string | undefined;
        injectionBudgetTokens: number | undefined;
        memoryBlockCount: number;
        /** Exact history token count managed by the Rust module outside this local database. */
        compartmentTokensOverride?: number;
    },
): M0BlockTokens {
    const {
        m0Text,
        m1Text,
        projectIdentity,
        injectionBudgetTokens,
        memoryBlockCount,
        compartmentTokensOverride,
    } = args;

    const docsBlock = extractM0Block(m0Text, "project-docs");
    const docsTokens = docsBlock ? estimateTokens(docsBlock) : 0;

    const profileBlock = extractM0Block(m0Text, "user-profile");
    const profileTokens = profileBlock ? estimateTokens(profileBlock) : 0;

    let memoryTokens = 0;
    let memoryFromM0 = false;
    const memoryBlock = extractM0Block(m0Text, "project-memory");
    if (memoryBlock) {
        memoryTokens = estimateTokens(memoryBlock);
        memoryFromM0 = true;
    }

    const muralTokens = m0Text.includes("<memory-mural>") ? 1_521 : 0;

    let compartmentTokens = 0;
    const historyBlock = extractM0Block(m0Text, "session-history");
    if (
        typeof compartmentTokensOverride === "number" &&
        Number.isFinite(compartmentTokensOverride) &&
        compartmentTokensOverride >= 0
    ) {
        // The active Rust module stores the canonical m0 data. Use its exact tokenizer
        // count instead of estimating from mirrored raw-history p1 rows.
        compartmentTokens = compartmentTokensOverride;
    } else if (historyBlock) {
        // Real decayed render, counted exactly from the cached wire block, plus
        // any compartments still riding in m[1]. Counting m[0] alone pins the
        // bucket at the empty wrapper's size for a session whose compartments
        // were all published after its first m[0] render.
        compartmentTokens = estimateTokens(historyBlock);
        const newCompartmentsBlock = m1Text ? extractM0Block(m1Text, "new-compartments") : null;
        if (newCompartmentsBlock) compartmentTokens += estimateTokens(newCompartmentsBlock);
    } else {
        // No materialized m[0] yet (brand-new / pre-first-materialization).
        // Fall back to the Σp1 estimate so the bucket isn't blank on a cold
        // session; it self-corrects to the decayed size on first render.
        try {
            const compRows = db
                .prepare<
                    [string],
                    {
                        content: string;
                        title: string;
                        start_message: number;
                        end_message: number;
                    }
                >(
                    "SELECT content, title, start_message, end_message FROM compartments WHERE session_id = ?",
                )
                .all(sessionId);
            for (const c of compRows) {
                compartmentTokens += estimateTokens(
                    `## ${c.start_message}-${c.end_message} · ${c.title}\n${c.content}\n`,
                );
            }
        } catch {
            // compartments table may not exist
        }
    }

    // Memory cold-start fallback: render on-demand with the SAME v2 path the
    // injection uses so the reading matches what WILL be injected.
    if (!memoryFromM0 && memoryBlockCount > 0 && projectIdentity) {
        try {
            const memories = getMemoriesByProject(db, projectIdentity, ["active", "permanent"]);
            const selected = injectionBudgetTokens
                ? trimMemoriesToBudgetV2(sessionId, memories, injectionBudgetTokens).renderOrder
                : memories;
            const block = renderMemoryBlockV2(selected);
            memoryTokens = block ? estimateTokens(block) : 0;
        } catch {
            memoryTokens = 0;
        }
    }

    return {
        docsTokens,
        profileTokens,
        memoryTokens,
        muralTokens,
        compartmentTokens,
        factTokens: 0,
    };
}
