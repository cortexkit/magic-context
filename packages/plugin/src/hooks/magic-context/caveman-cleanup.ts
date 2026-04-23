/**
 * Age-tier caveman text compression for long user/assistant text parts.
 *
 * Two entry points:
 *
 * 1. `applyCavemanCleanup` — runs ONLY on cache-busting heuristic passes
 *    (execute / flush / force-materialize) and is the only path that may
 *    INCREASE `tags.caveman_depth`. Computes age tiers (20/20/20/40),
 *    persists the new depth, and applies the compressed text in place.
 *
 * 2. `replayCavemanCompression` — runs on EVERY transform pass (defer too)
 *    and re-applies the persisted depth to message text without ever
 *    increasing it. This exists because `tagMessages` restores
 *    `textPart.text = source_contents.content` (the pristine original) on
 *    every pass; without a replay step the compressed text would oscillate
 *    between compressed (post-execute) and original (defer), which would
 *    bust the provider prompt cache on every turn.
 *
 * Partitioning: eligible tags (message-type, active, byte_size >= threshold,
 * tag_number <= protected cutoff) are sorted by tag_number ascending, then
 * bucketed 20/20/20/40:
 *  - oldest 20%  → ultra
 *  - next 20%    → full
 *  - next 20%    → lite
 *  - newest 40%  → untouched
 *
 * Source-of-truth invariant: compression is ALWAYS computed from the
 * pristine original (`source_contents.content`), never from an already-
 * cavemaned intermediate. So repeated tier shifts converge identically to
 * direct compression at the target depth, and the replay path can produce
 * the exact same output as the original execute pass.
 *
 * Persisted state:
 *  - tags.caveman_depth records the applied depth
 *  - source_contents.content is unchanged (remains the pristine original)
 *  - message-part text holds the cavemaned result visible to the agent
 */
import type { ContextDatabase } from "../../features/magic-context/storage";
import { getSourceContents, updateCavemanDepth } from "../../features/magic-context/storage";
import type { TagEntry } from "../../features/magic-context/types";
import { sessionLog } from "../../shared";
import { type CavemanLevel, cavemanCompress } from "./caveman";
import type { TagTarget } from "./tag-messages";

const DEPTH_UNTOUCHED = 0;
const DEPTH_LITE = 1;
const DEPTH_FULL = 2;
const DEPTH_ULTRA = 3;

const DEPTH_TO_LEVEL: Record<number, CavemanLevel> = {
    [DEPTH_LITE]: "lite",
    [DEPTH_FULL]: "full",
    [DEPTH_ULTRA]: "ultra",
};

export interface CavemanCleanupConfig {
    enabled: boolean;
    minChars: number;
}

export interface CavemanCleanupResult {
    compressedToLite: number;
    compressedToFull: number;
    compressedToUltra: number;
}

/**
 * Compute target caveman depth for a tag by its position in the sorted
 * eligible list. Visible for testing.
 */
export function computeTargetDepth(positionIndex: number, totalEligible: number): number {
    if (totalEligible <= 0) return DEPTH_UNTOUCHED;
    const fraction = positionIndex / totalEligible;
    if (fraction < 0.2) return DEPTH_ULTRA;
    if (fraction < 0.4) return DEPTH_FULL;
    if (fraction < 0.6) return DEPTH_LITE;
    return DEPTH_UNTOUCHED;
}

/**
 * Apply age-tier caveman compression to eligible message tags.
 *
 * Preconditions: caller has already acquired the DB transaction context for
 * this heuristic pass (or this function opens its own). Caller is expected
 * to gate on `ctx_reduce_enabled === false` and `config.enabled === true`.
 */
export function applyCavemanCleanup(
    sessionId: string,
    db: ContextDatabase,
    targets: Map<number, TagTarget>,
    tags: TagEntry[],
    config: CavemanCleanupConfig & { protectedTags: number },
): CavemanCleanupResult {
    const result: CavemanCleanupResult = {
        compressedToLite: 0,
        compressedToFull: 0,
        compressedToUltra: 0,
    };

    if (!config.enabled) return result;

    const maxTag = tags.reduce((max, t) => Math.max(max, t.tagNumber), 0);
    const protectedCutoff = maxTag - config.protectedTags;

    // Build the eligible list: active message tags outside protected tail with
    // a byte_size at least min_chars. byte_size is the current length in
    // bytes; for short/long-text discrimination this is a close enough proxy
    // for character count (UTF-8 prose averages ~1.05 bytes/char).
    const eligible = tags
        .filter(
            (tag) =>
                tag.type === "message" &&
                tag.status === "active" &&
                tag.tagNumber <= protectedCutoff &&
                tag.byteSize >= config.minChars,
        )
        // Sort by tag_number ascending — oldest first. This matches the
        // insertion order the tagger uses and is the stable age ordering.
        .sort((a, b) => a.tagNumber - b.tagNumber);

    if (eligible.length === 0) return result;

    // Skip any tags that need compression — targets holds only the tags the
    // current transform pass has message-part references for. If the target
    // is missing, we cannot mutate the visible content and must leave the
    // tag's depth unchanged (it will be reconsidered on the next pass).
    const tagsNeedingCompression = eligible.filter((tag, index) => {
        const target = targets.get(tag.tagNumber);
        if (!target || !target.getContent || !target.setContent) return false;
        const targetDepth = computeTargetDepth(index, eligible.length);
        return targetDepth > tag.cavemanDepth;
    });

    if (tagsNeedingCompression.length === 0) return result;

    // Batch-load originals for all candidates in one query.
    const originalByTag = getSourceContents(
        db,
        sessionId,
        tagsNeedingCompression.map((t) => t.tagNumber),
    );

    // Build a position lookup once — the previous implementation called
    // findIndex inside the hot loop which is O(n²) over eligible tags.
    const positionByTag = new Map<number, number>();
    for (let i = 0; i < eligible.length; i += 1) {
        positionByTag.set(eligible[i].tagNumber, i);
    }

    db.transaction(() => {
        for (const tag of tagsNeedingCompression) {
            const originalText = originalByTag.get(tag.tagNumber);
            if (typeof originalText !== "string" || originalText.length === 0) continue;

            const positionIndex = positionByTag.get(tag.tagNumber) ?? 0;
            const targetDepth = computeTargetDepth(positionIndex, eligible.length);
            if (targetDepth <= tag.cavemanDepth) continue;

            const level = DEPTH_TO_LEVEL[targetDepth];
            if (!level) continue;

            // Compress from the ORIGINAL, never from an already-cavemaned
            // intermediate. Idempotent: compressing the same original at the
            // same level always produces the same output.
            const compressed = cavemanCompress(originalText, level);
            if (compressed.length === 0) continue;

            const target = targets.get(tag.tagNumber);
            if (!target) continue;

            // Always persist the new depth, even when setContent returns false
            // (which happens when the compressed output is byte-identical to
            // the current text — e.g. the text had no caveman-droppable words).
            // Without this, that tag would be re-evaluated on every execute
            // pass forever, producing log noise and burning DB transactions.
            target.setContent(compressed);
            updateCavemanDepth(db, sessionId, tag.tagNumber, targetDepth);
            if (targetDepth === DEPTH_LITE) result.compressedToLite += 1;
            else if (targetDepth === DEPTH_FULL) result.compressedToFull += 1;
            else if (targetDepth === DEPTH_ULTRA) result.compressedToUltra += 1;
        }
    })();

    const total = result.compressedToLite + result.compressedToFull + result.compressedToUltra;
    if (total > 0) {
        sessionLog(
            sessionId,
            `caveman cleanup: compressed ${total} text tags (lite=${result.compressedToLite}, full=${result.compressedToFull}, ultra=${result.compressedToUltra})`,
        );
    }

    return result;
}

/**
 * Re-apply persisted caveman compression on every transform pass (defer
 * included). This is the cache-stability counterpart to applyCavemanCleanup.
 *
 * Why this exists: tagMessages restores `textPart.text = source_contents.content`
 * (the pristine original) for every existing tag on every pass. Without this
 * replay step, a tag compressed during an execute pass would revert to its
 * original text on the next defer pass. Anthropic's prompt cache hashes the
 * full message prefix, so an oscillating tag would bust cache on every turn
 * after compression first runs.
 *
 * Mirrors the pattern used by replayClearedReasoning / replayStrippedInline
 * for typed reasoning. Pure read \u2014 never increases caveman_depth, never
 * mutates the database. Only execute/flush passes (via applyCavemanCleanup)
 * can deepen the depth.
 *
 * Idempotent: cavemanCompress is deterministic over (originalText, level),
 * so calling this on every pass produces the exact same text the original
 * execute pass produced.
 */
export function replayCavemanCompression(
    sessionId: string,
    db: ContextDatabase,
    targets: Map<number, TagTarget>,
    tags: TagEntry[],
): number {
    // Pre-filter to only tags that need replay so we avoid loading source
    // contents for everything in the session.
    const compressedTags = tags.filter(
        (tag) =>
            tag.type === "message" &&
            tag.status === "active" &&
            tag.cavemanDepth > 0 &&
            targets.has(tag.tagNumber),
    );

    if (compressedTags.length === 0) return 0;

    const originalByTag = getSourceContents(
        db,
        sessionId,
        compressedTags.map((t) => t.tagNumber),
    );

    let replayed = 0;
    for (const tag of compressedTags) {
        const originalText = originalByTag.get(tag.tagNumber);
        if (typeof originalText !== "string" || originalText.length === 0) continue;

        const level = DEPTH_TO_LEVEL[tag.cavemanDepth];
        if (!level) continue;

        const compressed = cavemanCompress(originalText, level);
        if (compressed.length === 0) continue;

        const target = targets.get(tag.tagNumber);
        if (!target) continue;

        // setContent returns true only when text actually changed. Either
        // outcome is fine: a no-op means the prior pass already had this
        // exact compressed content, which is the goal.
        if (target.setContent(compressed)) {
            replayed += 1;
        }
    }

    return replayed;
}
