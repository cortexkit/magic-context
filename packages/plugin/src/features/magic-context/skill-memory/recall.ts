import type { Database } from "../../../shared/sqlite";
import type { SkillMemoryConfig } from "./frontmatter";
import { getSkillMemoryNotes, type SkillMemoryNote } from "./storage";

export interface FlatRecallOptions {
    maxTokens: number;
    maxPinnedTokens: number;
}

// Rough token estimate: 1 token ≈ 4 chars (conservative for XML overhead)
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * Flat recall (rungs 2 + 4): recency × hit_count, no embeddings.
 * Greedy fill by composite score up to maxTokens budget.
 * Pinned notes are always included (up to maxPinnedTokens).
 */
export function flatRecall(
    db: Database,
    skillId: string,
    tier: "project" | "global",
    projectIdentity: string,
    options: FlatRecallOptions,
): SkillMemoryNote[] {
    // Fetch a generous candidate set (2× budget as a heuristic)
    const candidates = getSkillMemoryNotes(db, skillId, tier, projectIdentity, 50);
    if (candidates.length === 0) return [];

    const pinned = candidates.filter((n) => n.pinned === 1);
    const unpinned = candidates.filter((n) => n.pinned === 0);

    const result: SkillMemoryNote[] = [];
    let pinnedTokens = 0;
    let totalTokens = 0;

    // Always include pinned notes (up to maxPinnedTokens)
    for (const note of pinned) {
        const tokens = estimateTokens(note.delta);
        if (pinnedTokens + tokens > options.maxPinnedTokens) break;
        result.push(note);
        pinnedTokens += tokens;
        totalTokens += tokens;
    }

    // Fill remaining budget with unpinned notes
    for (const note of unpinned) {
        if (totalTokens >= options.maxTokens) break;
        const tokens = estimateTokens(note.delta);
        if (totalTokens + tokens > options.maxTokens) break;
        result.push(note);
        totalTokens += tokens;
    }

    return result;
}

/**
 * Build the <skill-memory> XML block to append to the skill tool result.
 * Returns empty string for cold-start (no notes) — no empty stub injected.
 */
export function buildSkillMemoryBlock(
    skillId: string,
    mode: "no-intent" | "flat-fts",
    notes: SkillMemoryNote[],
    pinnedCount: number,
): string {
    if (notes.length === 0) return "";

    const noteXml = notes
        .map((n) => {
            const intentAttr = n.intent ? ` intent="${escapeXml(n.intent)}"` : "";
            const pinnedAttr = n.pinned === 1 ? ` pinned="true"` : ` pinned="false"`;
            return (
                `<note kind="${n.kind}"${intentAttr} hit_count="${n.hit_count}"${pinnedAttr}>\n` +
                `<delta>${escapeXml(n.delta)}</delta>\n` +
                `</note>`
            );
        })
        .join("\n");

    const footer =
        `\n\n---\n` +
        `*After using this skill, call \`ctx_skill_note\` — record only gotchas, novel discoveries, or error→fix; skip routine successes.*`;

    return (
        `<skill-memory skill="${escapeXml(skillId)}" mode="${mode}" count="${notes.length}" pinned="${pinnedCount}">\n` +
        noteXml +
        `\n</skill-memory>` +
        footer
    );
}

function escapeXml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Shared recall core: reads notes from DB, ranks/budgets them, and formats the
 * <skill-memory> block string. Returns empty string when no notes exist or
 * skill-memory is not enabled.
 *
 * Used by BOTH:
 *   - maybeInjectSkillMemory (transparent after-hook path) — appends to output.output
 *   - ctx_skill_recall tool (explicit agent-callable path) — returns as tool result
 *
 * Lives in the feature layer (not hook-handlers.ts) to avoid tools→hooks layering.
 * P2 embeddings benefit both paths automatically when this function is upgraded.
 */
export function recallSkillMemoryBlock(
    db: Database,
    opts: {
        skill: string;
        intent?: string;
        scope: "project" | "global";
        projectIdentity: string;
        frontmatterConfig: SkillMemoryConfig | null;
        maxTokens?: number;
    },
): string {
    // Guard: skill-memory must be enabled for this skill
    if (!opts.frontmatterConfig?.enabled) return "";

    try {
        const maxTokens = opts.maxTokens ?? opts.frontmatterConfig.max_tokens;
        const notes = flatRecall(db, opts.skill, opts.scope, opts.projectIdentity, {
            maxTokens,
            maxPinnedTokens: opts.frontmatterConfig.max_pinned_tokens,
        });
        if (notes.length === 0) return ""; // cold-start: no block

        const pinnedCount = notes.filter((n) => n.pinned === 1).length;
        // P1: always "no-intent" flat recall. P2 will add intent-aware ranking (fts5-fallback rung).
        // TODO (P2): const mode: "no-intent" | "flat-fts" = opts.intent ? "flat-fts" : "no-intent";
        const mode: "no-intent" | "flat-fts" = "no-intent";
        return buildSkillMemoryBlock(opts.skill, mode, notes, pinnedCount);
    } catch {
        // Non-fatal: recall failure must never block the tool result
        return "";
    }
}
