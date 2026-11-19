/**
 * Reference retrieval for the v2 historian prompt (E1.6b).
 *
 * The historian receives two reference blocks (replacing the old unbounded
 * `<existing_state>` compartment dump):
 *
 *   <compartment_examples_from_other_projects>  — 3 rotating cross-project SEEDS
 *       (permanent floor). Calibration anchors for importance scoring, tier
 *       decay, paraphrase rhythm, and fact-extraction shape. Never dedup-able.
 *
 *   <session_references> — 3 importance-diverse older compartments, then the
 *       4 most recent, each group chronological with all stored tiers.
 *       One-compartment runs anchor on recent scores, so recent examples omit
 *       importance. Diverse older examples retain scores and fill bands the
 *       seeds leave uncovered or underrepresented.
 *
 * Budget: 3 seeds + up to 3 diverse + 4 recent = 10 calibration examples.
 * Embedding work at historian time: ZERO.
 */
import { escapeXmlAttr, escapeXmlContent } from "../../features/magic-context/compartment-storage";
import { isNoContentCompartment } from "../../features/magic-context/no-content-compartment";
import { REFERENCE_SEEDS, type ReferenceSeed } from "./reference-seeds.generated";

/**
 * Structural minimum a compartment must satisfy to render as a session
 * reference. Both `Compartment` (stored rows, incremental runner) and
 * `CandidateCompartment` (in-flight recomp staging) are assignable — they
 * differ only in null/undefined widening on the tier/importance fields.
 */
export interface ReferenceCompartment {
    startMessage: number;
    endMessage: number;
    title: string;
    content: string;
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    importance?: number | null;
    episodeType?: string | null;
}

/** Permanent seed floor — never drops, even when the session is mature. */
export const SEED_FLOOR = 3;
/** Recency window of this-session compartments shown for continuity/calibration. */
export const SESSION_REF_WINDOW = 4;
export const SESSION_REF_DIVERSE = 3;
export const SESSION_REF_LIMIT = SESSION_REF_WINDOW + SESSION_REF_DIVERSE;

/**
 * Importance bands the 60-seed corpus is balanced across (12 per band). We pick
 * one seed from each of 3 rotating bands per run, not 3 clustered scores.
 * Older session references preferentially fill the bands these seeds leave
 * uncovered. Recent scores are hidden, so they do not count toward coverage.
 */
const SEED_BANDS: ReadonlyArray<readonly [number, number]> = [
    [85, 100], // very high
    [60, 84], // high
    [30, 59], // mid
    [10, 29], // low-mid
    [1, 9], // low
];

function seedBandIndex(importance: number): number {
    for (let i = 0; i < SEED_BANDS.length; i++) {
        const [lo, hi] = SEED_BANDS[i];
        if (importance >= lo && importance <= hi) return i;
    }
    // Defensive: importance is validated 1-100, but clamp out-of-range to nearest band.
    return importance > 100 ? 0 : SEED_BANDS.length - 1;
}

/** Group seeds by importance band, preserving corpus order within each band. */
function seedsByBand(): ReferenceSeed[][] {
    const bands: ReferenceSeed[][] = SEED_BANDS.map(() => []);
    for (const seed of REFERENCE_SEEDS) {
        bands[seedBandIndex(seed.importance)].push(seed);
    }
    return bands;
}

/**
 * Deterministic non-cryptographic hash (FNV-1a). The seed selection MUST be
 * stable for a given (sessionId, chunkStart) so a historian re-run on the same
 * chunk — e.g. after a discarded last compartment, or a retried transient
 * failure — sees the identical reference block. Reproducibility, not security.
 */
function fnv1a(input: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        // h *= 16777619, kept in 32-bit unsigned range
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
}

/**
 * Select 3 seeds from distinct importance bands, deterministically rotating
 * both band order and the picks within each band by session. The same examples
 * can be cached across requests even as the summarized chunk advances.
 */
export function selectSeeds(
    sessionId: string,
    _chunkStart: number,
    count = SEED_FLOOR,
): ReferenceSeed[] {
    const bands = seedsByBand();
    const seed = fnv1a(sessionId);
    const picks: ReferenceSeed[] = [];

    // Walk bands round-robin so `count` picks spread across the importance range.
    // With count=3 and 5 bands this covers 3 distinct bands; the rotation offset
    // also shifts which bands are represented.
    const bandOrder: number[] = [];
    for (let i = 0; i < SEED_BANDS.length; i++) {
        bandOrder.push((i + (seed % SEED_BANDS.length)) % SEED_BANDS.length);
    }

    let bi = 0;
    let guard = 0;
    while (picks.length < count && guard < SEED_BANDS.length * 4) {
        const band = bands[bandOrder[bi % bandOrder.length]];
        bi++;
        guard++;
        if (band.length === 0) continue;
        // Rotate within the band by the hash + how many we've already taken so two
        // picks from the same band (if a band is empty and we wrap) differ.
        const idx = (seed + picks.length) % band.length;
        const candidate = band[idx];
        if (!picks.includes(candidate)) picks.push(candidate);
    }

    // Fallback: if band-walking under-fills (tiny/oddly-distributed corpus),
    // top up from the flat corpus deterministically.
    for (let i = 0; picks.length < count && i < REFERENCE_SEEDS.length; i++) {
        const candidate = REFERENCE_SEEDS[(seed + i) % REFERENCE_SEEDS.length];
        if (!picks.includes(candidate)) picks.push(candidate);
    }

    return picks;
}

/** Render the cross-project calibration block. Empty string if no seeds. */
export function renderSeedExamplesBlock(seeds: ReferenceSeed[]): string {
    if (seeds.length === 0) return "";
    const body = seeds.map((s) => s.block).join("\n\n");
    return `<compartment_examples_from_other_projects>\n${body}\n</compartment_examples_from_other_projects>`;
}

/**
 * Render one this-session compartment in its full stored form for the
 * `<session_references>` block. v2 rows emit all four tiers; legacy rows (no
 * tiers) fall back to flat `content`. Keep episode_type in both groups, but
 * show importance only on diverse examples: newest scores cause anchoring.
 */
export function renderSessionRefCompartment(
    c: ReferenceCompartment,
    showImportance: boolean,
): string {
    const importance = c.importance ?? 50;
    const attrs =
        `start="${c.startMessage}" end="${c.endMessage}" title="${escapeXmlAttr(c.title)}"` +
        (c.episodeType ? ` episode_type="${escapeXmlAttr(c.episodeType)}"` : "") +
        (showImportance ? ` importance="${importance}"` : "");

    // Tier presence: a row is v2-tiered ONLY when `p1` is a non-empty string
    // (matches the compartment parser's contract + the NEEDS_UPGRADE predicate
    // `legacy=1 OR p1 IS NULL OR p1=''`). Legacy rows (NULL p1) AND malformed
    // pseudo-v2 rows (`p1=''` from an interrupted upgrade) both fall through to
    // flat `content` — otherwise the reference block emitted empty <p1>/<p2>/<p3>
    // and lost the row's continuity/calibration content.
    // Tier bodies are XML-escaped: user/assistant text containing <, >, & would
    // otherwise produce malformed XML in the historian's reference-input prompt.
    if (typeof c.p1 === "string" && c.p1.length > 0) {
        // v2 tiered row: show all four paraphrase tiers exactly as stored. p4 may be
        // empty (self-closing) per the three valid P4 shapes.
        const p4 = c.p4 && c.p4.length > 0 ? `<p4>\n${escapeXmlContent(c.p4)}\n</p4>` : "<p4/>";
        return [
            `<compartment ${attrs}>`,
            `<p1>\n${escapeXmlContent(c.p1)}\n</p1>`,
            `<p2>\n${escapeXmlContent(c.p2 ?? "")}\n</p2>`,
            `<p3>\n${escapeXmlContent(c.p3 ?? "")}\n</p3>`,
            p4,
            `</compartment>`,
        ].join("\n");
    }

    // Legacy (pre-v2) row: no tiers, show flat content. The historian treats this
    // as continuity context only; it never has to reproduce this shape.
    return `<compartment ${attrs}>\n${escapeXmlContent(c.content)}\n</compartment>`;
}

/**
 * Select older calibration examples against the bands of the seeds alone.
 * Recent references carry no scores, so their bands do not count as anchors.
 * Repeatedly pick the least-represented available band (uncovered bands first),
 * breaking ties in the seed's rotating band order. Within a band, rotate by the
 * same UTF-16 hash. Remove each pick so sparse histories never duplicate a row.
 * Input is chronological; output is diverse chronological, then recent chronological.
 */
export function selectSessionReferences(
    allCompartments: ReferenceCompartment[],
    seeds: readonly ReferenceSeed[],
    sessionId: string,
    chunkStart: number,
): ReferenceCompartment[] {
    const eligible = allCompartments.filter((c) => !isNoContentCompartment(c));
    const olderCount = Math.max(0, eligible.length - SESSION_REF_WINDOW);
    const recent = eligible.slice(olderCount);
    const bands: number[][] = SEED_BANDS.map(() => []);
    const counts = SEED_BANDS.map(() => 0);
    for (const c of seeds) counts[seedBandIndex(c.importance)]++;
    for (let i = 0; i < olderCount; i++) {
        bands[seedBandIndex(eligible[i].importance ?? 50)].push(i);
    }
    const hash = fnv1a(`${sessionId}:${chunkStart}`);
    const bandOrder = SEED_BANDS.map(
        (_, i) => (i + (hash % SEED_BANDS.length)) % SEED_BANDS.length,
    );
    const picks: number[] = [];
    while (picks.length < SESSION_REF_DIVERSE) {
        let best = -1;
        for (const bi of bandOrder) {
            if (bands[bi].length > 0 && (best < 0 || counts[bi] < counts[best])) best = bi;
        }
        if (best < 0) break;
        const band = bands[best];
        const [pick] = band.splice((hash + picks.length) % band.length, 1);
        picks.push(pick);
        counts[best]++;
    }
    picks.sort((a, b) => a - b);
    return [...picks.map((i) => eligible[i]), ...recent];
}

/**
 * Render already-selected references. Keeping a suffix drops diverse examples
 * before recent examples, then drops the oldest recent first. Selection happens
 * once, before fitting, so trimming cannot reshuffle calibration examples.
 */
export function renderSessionReferencesBlock(
    selected: ReferenceCompartment[],
    window: number = SESSION_REF_LIMIT,
): string {
    selected = selected.filter((c) => !isNoContentCompartment(c));
    const count = Math.max(0, Math.min(SESSION_REF_LIMIT, Math.floor(window)));
    if (selected.length === 0 || count === 0) return "";
    // The selected list is diverse first, recent last. Determine the scored
    // boundary before trimming so retained recent rows never acquire scores.
    const recentStart = Math.max(0, selected.length - SESSION_REF_WINDOW);
    const trimStart = Math.max(0, selected.length - count);
    const body = selected
        .slice(trimStart)
        .map((c, i) => renderSessionRefCompartment(c, i + trimStart < recentStart))
        .join("\n\n");
    return `<session_references>\n${body}\n</session_references>`;
}

export interface ReferenceBlocks {
    /** `<compartment_examples_from_other_projects>` — always present (3-seed floor). */
    seedExamples: string;
    /** `<session_references>` — empty for a young session with no prior compartments. */
    sessionReferences: string;
}

/**
 * Build both reference blocks for a historian run. Pure + deterministic for a
 * given (sessionId, chunkStart, compartments) — no embedding, no DB, no clock.
 */
export function buildReferenceBlocks(args: {
    sessionId: string;
    chunkStart: number;
    /** Full ordered list of this session's persisted compartments (asc). */
    sessionCompartments: ReferenceCompartment[];
}): ReferenceBlocks {
    const seeds = selectSeeds(args.sessionId, args.chunkStart);
    return {
        seedExamples: renderSeedExamplesBlock(seeds),
        sessionReferences: renderSessionReferencesBlock(
            selectSessionReferences(
                args.sessionCompartments,
                seeds,
                args.sessionId,
                args.chunkStart,
            ),
        ),
    };
}
