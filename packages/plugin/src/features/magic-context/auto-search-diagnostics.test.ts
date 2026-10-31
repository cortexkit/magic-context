import { expect, test } from "bun:test";
import {
    autoSearchRelevance,
    createAutoSearchDiagnostics,
    recordAutoSearchLane,
} from "./auto-search-diagnostics";
import type { UnifiedSearchResult } from "./search";

test("lane aggregates use threshold relevance and count the inclusive 0.5, exclusive threshold band", () => {
    const diagnostics = createAutoSearchDiagnostics(0.6);
    const result = (score: number): UnifiedSearchResult => ({
        source: "memory",
        memoryId: 1,
        category: "WORKFLOW_RULES",
        matchType: "semantic",
        content: "PRIVATE MEMORY",
        score,
    });
    recordAutoSearchLane(
        diagnostics,
        "memory",
        "PRIVATE QUERY",
        [0.49, 0.5, 0.599, 0.6, 0.9].map(result),
    );
    recordAutoSearchLane(diagnostics, "git", "PRIVATE QUERY", []);
    recordAutoSearchLane(diagnostics, "messages", "PRIVATE QUERY", [
        { ...result(1), relevanceScore: 0.55 },
    ]);
    expect(diagnostics.lanes).toEqual({
        memory: { top: 0.9, nearMisses: 2 },
        git: { top: null, nearMisses: 0 },
        messages: { top: 0.55, nearMisses: 1 },
    });
    expect(diagnostics.lanes.summaries).toBeUndefined();
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE");
    expect(autoSearchRelevance("anything", { ...result(1), content: "" })).toBe(0);
});
