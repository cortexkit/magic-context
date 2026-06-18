import type { Database } from "../../../shared/sqlite";
import { cosineSimilarity } from "../memory/cosine-similarity";
import { embedTextForProject } from "../memory/embedding";
import { toFloat32Array } from "../memory/storage-memory-embeddings";
import type { SkillMemoryConfig } from "./frontmatter";
import {
    bumpRecallCountByIds,
    getPinnedNotes,
    getRankingCandidates,
    getSkillMemoryNotes,
    partitionKey,
    type SkillMemoryNote,
    searchSkillMemoryFts,
} from "./storage";

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
    const candidates = getSkillMemoryNotes(db, skillId, tier, projectIdentity, 50);
    if (candidates.length === 0) return [];
    return budgetFill(candidates, options.maxTokens, options.maxPinnedTokens);
}

/**
 * Build the <skill-memory> XML block to append to the skill tool result.
 * Returns empty string for cold-start (no notes) — no empty stub injected.
 */
/** Escape a natural-language intent into a safe FTS5 MATCH query: quote each alphanumeric token. */
export function sanitizeSkillIntentForFts(intent: string): string {
    const tokens = intent.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export interface Rung1Note {
    id: number;
    intentVec: Float32Array | null;
    deltaVec: Float32Array | null;
    ts: number;
    hit: number;
}
export interface Rung1Weights {
    relevance: number;
    recency: number;
    hit: number;
}

export function rankRung1(
    q: Float32Array,
    notes: Rung1Note[],
    w: Rung1Weights,
): Array<{ id: number; score: number }> {
    if (notes.length === 0) return [];
    const tsVals = notes.map((n) => n.ts);
    const minTs = Math.min(...tsVals),
        maxTs = Math.max(...tsVals);
    const maxHit = Math.max(...notes.map((n) => n.hit));
    const denR = maxTs - minTs;
    return notes
        .map((n) => {
            const ic = n.intentVec ? cosineSimilarity(q, n.intentVec) : -1;
            const dc = n.deltaVec ? cosineSimilarity(q, n.deltaVec) : -1;
            const relevance = Math.max(0, Math.max(ic, dc));
            const recency = denR === 0 ? 1.0 : (n.ts - minTs) / denR;
            const hitN = maxHit === 0 ? 0.0 : n.hit / maxHit;
            return {
                id: n.id,
                score: w.relevance * relevance + w.recency * recency + w.hit * hitN,
            };
        })
        .sort((a, b) => b.score - a.score);
}

/** Normalize the 3 weights to sum 1; all-zero (or omitted) → defaults. */
function resolveWeights(cfg: SkillMemoryConfig): Rung1Weights {
    const r = cfg.ranking_relevance ?? 0.6,
        c = cfg.ranking_recency ?? 0.25,
        h = cfg.ranking_hit ?? 0.15;
    const sum = r + c + h;
    if (sum === 0) return { relevance: 0.6, recency: 0.25, hit: 0.15 };
    return { relevance: r / sum, recency: c / sum, hit: h / sum };
}

/** Prepend pinned notes (already pinned-first ordered by getPinnedNotes) ahead of `rest`, deduped by id. */
function unionPinnedFirst(pinned: SkillMemoryNote[], rest: SkillMemoryNote[]): SkillMemoryNote[] {
    const seen = new Set(pinned.map((n) => n.id));
    return [...pinned, ...rest.filter((n) => !seen.has(n.id))];
}

/** Greedy fill pinned-first up to token budget; pinned up to maxPinnedTokens, total up to maxTokens. */
function budgetFill(
    notes: SkillMemoryNote[],
    maxTokens: number,
    maxPinnedTokens: number,
): SkillMemoryNote[] {
    const result: SkillMemoryNote[] = [];
    let pinnedTokens = 0;
    let totalTokens = 0;

    for (const note of notes) {
        const tokens = estimateTokens(note.delta);
        if (note.pinned === 1) {
            if (pinnedTokens + tokens > maxPinnedTokens) continue;
            pinnedTokens += tokens;
        }
        if (totalTokens + tokens > maxTokens) continue;
        result.push(note);
        totalTokens += tokens;
    }

    return result;
}

export function buildSkillMemoryBlock(
    skillId: string,
    mode: "no-intent" | "flat-fts" | "full" | "fts5-fallback",
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
export async function recallSkillMemoryBlock(
    db: Database,
    opts: {
        skill: string;
        intent?: string;
        scope: "project" | "global";
        projectIdentity: string;
        frontmatterConfig: SkillMemoryConfig | null;
        maxTokens?: number;
    },
): Promise<string> {
    if (!opts.frontmatterConfig?.enabled) return "";
    try {
        const part = partitionKey(opts.scope, opts.projectIdentity);
        const maxTokens = opts.maxTokens ?? opts.frontmatterConfig.max_tokens;
        const maxPinned = opts.frontmatterConfig.max_pinned_tokens;
        const intent = opts.intent?.trim();

        // Single chokepoint for every rung: bump read-side recall_count for the notes
        // actually surfaced, then format the block. Empty selection → empty string (no bump).
        const finalize = (
            mode: "no-intent" | "flat-fts" | "full" | "fts5-fallback",
            notes: SkillMemoryNote[],
        ): string => {
            if (notes.length === 0) return "";
            bumpRecallCountByIds(
                db,
                notes.map((n) => n.id),
            );
            return buildSkillMemoryBlock(
                opts.skill,
                mode,
                notes,
                notes.filter((n) => n.pinned === 1).length,
            );
        };

        // Rung 2: no intent → flat recency×hit (nothing to embed/FTS-match → always "no-intent").
        if (!intent) {
            const notes = flatRecall(db, opts.skill, opts.scope, part, {
                maxTokens,
                maxPinnedTokens: maxPinned,
            });
            return finalize("no-intent", notes);
        }

        const q = await embedTextForProject(opts.projectIdentity, intent);
        if (q) {
            const candidates = getRankingCandidates(db, opts.skill, opts.scope, part, 200);
            const matched = candidates.filter(
                (n) =>
                    n.embedding_model_version === q.modelId &&
                    (n.intent_embedding || n.delta_embedding),
            );
            if (matched.length > 0) {
                const weights = resolveWeights(opts.frontmatterConfig);
                const ranked = rankRung1(
                    q.vector,
                    matched.map((n) => ({
                        id: n.id,
                        intentVec: n.intent_embedding ? toFloat32Array(n.intent_embedding) : null,
                        deltaVec: n.delta_embedding ? toFloat32Array(n.delta_embedding) : null,
                        ts: n.last_used_at ?? n.created_at,
                        hit: n.hit_count,
                    })),
                    weights,
                );
                const byId = new Map(candidates.map((n) => [n.id, n]));
                const rankedNotes = ranked
                    .map((r) => byId.get(r.id))
                    .filter((n): n is SkillMemoryNote => n != null);
                const ordered = unionPinnedFirst(
                    getPinnedNotes(db, opts.skill, opts.scope, part),
                    rankedNotes,
                );
                const selected = budgetFill(ordered, maxTokens, maxPinned);
                return finalize("full", selected);
            }
            // zero model-matched → fall to FTS rung 3.
        }

        const match = sanitizeSkillIntentForFts(intent);
        if (match === "") {
            const notes = flatRecall(db, opts.skill, opts.scope, part, {
                maxTokens,
                maxPinnedTokens: maxPinned,
            });
            return finalize("flat-fts", notes);
        }
        const ftsNotes = searchSkillMemoryFts(db, opts.skill, opts.scope, part, match, 50);
        const ordered = unionPinnedFirst(
            getPinnedNotes(db, opts.skill, opts.scope, part),
            ftsNotes,
        );
        const selected = budgetFill(ordered, maxTokens, maxPinned);
        return finalize("fts5-fallback", selected);
    } catch {
        return "";
    }
}
