import type { Database } from "../../../shared/sqlite";
import { getMemoriesByProject } from "../memory";
import { getMemoryCategoryOrder } from "../memory/constants";
import type { Memory } from "../memory/types";
import { DEFAULT_MURAL_MEMORY_BUDGET, muralOverflowMemories } from "./mural-selection";
import { drawableMuralCue } from "./render-mural";
import { computeCueContentHash, getMuralCueState, type MuralCueState } from "./storage-mural-cues";

/** Wire options for the m0 mural image injection: whether the feature is on,
 *  whether the fold's model accepts images, and (when both hold) the rendered
 *  data URL plus its content hash. Produced by resolveMuralWire (render-trigger). */
export interface MuralWireOptions {
    enabled: boolean;
    supportsVision: boolean;
    dataUrl?: string;
    contentHash?: string;
}

/** A single deterministic mural entry: a compressed cue plus the ordering
 *  facts. No rooms, no merges — flat category bands. */
export interface ResolvedMuralEntry {
    id: number;
    category: string;
    importance: number;
    cue: string;
}

export interface MuralCoverage {
    /** Active and permanent memories eligible for mural cueing. */
    activeMemoryCount: number;
    /** Eligible memories with a non-null compressed cue generated for current
     *  content that the mural font can draw. */
    cuedMemoryCount: number;
    /** Current cues left out because the mural font cannot draw them. The renderer
     *  never shows them, so they are not counted in cuedMemoryCount. */
    undrawableCueCount: number;
}

export interface MuralPool {
    memories: Memory[];
    cueState: Map<number, MuralCueState>;
    contentHashes: Map<number, { content: string; hash: string }>;
}

/** A call-local snapshot, never retained across refreshes or database writes. */
export function readMuralPool(db: Database, projectIdentity: string): MuralPool {
    const memories = getMemoriesByProject(db, projectIdentity, ["active", "permanent"]);
    return {
        memories,
        cueState: getMuralCueState(
            db,
            memories.map((memory) => memory.id),
        ),
        contentHashes: new Map(),
    };
}

function poolContentHash(pool: MuralPool | undefined, memory: Memory): string {
    const cached = pool?.contentHashes.get(memory.id);
    if (cached?.content === memory.content) return cached.hash;
    const value = computeCueContentHash(memory.content);
    pool?.contentHashes.set(memory.id, { content: memory.content, hash: value });
    return value;
}

/** Count current cues across the full live pool before the overflow trim. A cue the
 *  font cannot draw counts apart from the drawable ones, because the coverage gate
 *  must not open for cues the mural would leave out. */
export function getMuralCoverage(
    db: Database,
    projectIdentity: string,
    pool?: MuralPool,
): MuralCoverage {
    const { memories, cueState } = pool ?? readMuralPool(db, projectIdentity);
    let cuedMemoryCount = 0;
    let undrawableCueCount = 0;
    for (const memory of memories) {
        const state = cueState.get(memory.id);
        if (
            state &&
            typeof state.cue === "string" &&
            state.cue.trim() !== "" &&
            state.hash !== null &&
            state.hash === poolContentHash(pool, memory)
        ) {
            if (drawableMuralCue(state.cue) === null) undrawableCueCount += 1;
            else cuedMemoryCount += 1;
        }
    }
    return { activeMemoryCount: memories.length, cuedMemoryCount, undrawableCueCount };
}

/**
 * Compute the deterministic mural entry list for a project — the zero-LLM half
 * of the cutover, callable any time.
 *
 * 1. SELECTION: the overflow set is the complement of the m0 budget trim (the
 *    memories that did NOT fit the injected memory budget). Same trim the m0
 *    path uses, so the mural shows exactly what the budget dropped.
 * 2. FILTER: keep only overflow memories with a hash-CURRENT compressed cue
 *    (mural_cue set AND mural_cue_hash == sha256(content)). Uncompressed or
 *    stale memories are simply absent until the compress-cues trickle catches
 *    up — render what exists, never block on coverage.
 * 3. ORDER: category (MEMORY_CATEGORY_ORDER) → importance DESC → id ASC. The
 *    id-ASC tiebreak makes the order APPEND-STABLE: inserting a new memory never
 *    reshuffles the relative order of the existing ones within their band.
 */
export function resolveMural(
    db: Database,
    projectIdentity: string,
    budgetTokens: number = DEFAULT_MURAL_MEMORY_BUDGET,
    pool?: MuralPool,
): ResolvedMuralEntry[] {
    const memories =
        pool?.memories ?? getMemoriesByProject(db, projectIdentity, ["active", "permanent"]);
    const overflow = muralOverflowMemories(memories, budgetTokens);
    if (overflow.length === 0) return [];

    const cueState =
        pool?.cueState ??
        getMuralCueState(
            db,
            overflow.map((memory) => memory.id),
        );
    const entries: ResolvedMuralEntry[] = [];
    for (const memory of overflow) {
        const state = cueState.get(memory.id);
        if (!state || state.cue === null || state.hash === null) continue;
        // Hash-current only: a cue whose content hash no longer matches is stale
        // (the memory was edited after compression) and must not render.
        if (state.hash !== poolContentHash(pool, memory)) continue;
        entries.push({
            id: memory.id,
            category: memory.category,
            importance: memory.importance ?? 50,
            cue: state.cue,
        });
    }

    entries.sort(compareMuralEntries);
    return entries;
}

/** category order → importance DESC → id ASC (append-stable). */
function compareMuralEntries(a: ResolvedMuralEntry, b: ResolvedMuralEntry): number {
    const categoryDelta = getMemoryCategoryOrder(a.category) - getMemoryCategoryOrder(b.category);
    if (categoryDelta !== 0) return categoryDelta;
    if (a.importance !== b.importance) return b.importance - a.importance;
    return a.id - b.id;
}
