import { cleanSearchText, keywordRelevance } from "../../shared/search-text";
import type { UnifiedSearchResult } from "./search";

export type AutoSearchLane = "memory" | "messages" | "summaries" | "git";
export type ChunkPoolPeek =
    | "not-run"
    | "hit"
    | "missing"
    | "transaction"
    | "signature-changed"
    | "no-model";

/** Only numeric aggregates and enumerated state values cross the worker boundary. */
export interface AutoSearchDiagnostics {
    threshold: number;
    lanes: Partial<Record<AutoSearchLane, { top: number | null; nearMisses: number }>>;
    pool: "unknown" | "cold" | "warm" | "off" | "no-vector";
    poolRows: number | null;
    peek: ChunkPoolPeek;
    workerStarted: boolean | null;
}

export function createAutoSearchDiagnostics(threshold: number): AutoSearchDiagnostics {
    return {
        threshold,
        lanes: {},
        pool: "unknown",
        poolRows: null,
        peek: "not-run",
        workerStarted: false,
    };
}

/** The unboosted relevance used by the automatic-hint threshold. */
export function autoSearchRelevance(query: string, result: UnifiedSearchResult): number {
    if (
        cleanSearchText(result.source === "compartment" ? result.title : result.content).length ===
        0
    )
        return 0;
    return result.source === "message" ||
        ("matchType" in result &&
            result.source !== "compartment" &&
            result.matchType !== "semantic")
        ? keywordRelevance(query, result.content)
        : result.score;
}

/** Sample each retrieval lane before cross-lane merging and the final result limit. */
export function recordAutoSearchLane(
    diagnostics: AutoSearchDiagnostics | undefined,
    lane: AutoSearchLane,
    query: string,
    results: UnifiedSearchResult[],
): void {
    if (!diagnostics) return;
    const scores = results.map(
        (result) => result.relevanceScore ?? autoSearchRelevance(query, result),
    );
    diagnostics.lanes[lane] = {
        top: scores.length ? Math.max(...scores) : null,
        nearMisses: scores.filter((score) => score >= 0.5 && score < diagnostics.threshold).length,
    };
}
