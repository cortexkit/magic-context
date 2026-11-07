import { expect, test } from "bun:test";
import {
    autoSearchRelevance,
    createAutoSearchDiagnostics,
    recordAutoSearchLane,
    withMemoryHintContent,
} from "./auto-search-diagnostics";
import type { UnifiedSearchResult } from "./search";

function hybridMemory(content: string): UnifiedSearchResult & { source: "memory" } {
    return {
        source: "memory",
        memoryId: 1,
        category: "WORKFLOW_RULES",
        matchType: "hybrid",
        content,
        score: 0.95,
    };
}

test("hybrid hint relevance matches shared Chinese phrases without trusting retrieval rank", () => {
    const query = "MC_Maze 残差怎样汇总？";
    const memory = hybridMemory("MC_Maze 残差按种子汇总。");
    expect(autoSearchRelevance(query, memory)).toBeCloseTo(2 / 3);
    expect(autoSearchRelevance(query, memory)).toBeGreaterThan(0.6);
    expect(autoSearchRelevance(query, { ...memory, score: 0.2 })).toBe(
        autoSearchRelevance(query, memory),
    );
    expect(autoSearchRelevance(query, hybridMemory("MC_Maze 差旅报销规定。"))).toBeLessThan(0.6);
    expect(
        autoSearchRelevance("我们可以怎样汇总残差", hybridMemory("我们可以去吃饭")),
    ).toBeLessThan(0.6);
    expect(autoSearchRelevance(query, { ...memory, matchType: "semantic" })).toBe(0.95);
});

test("memory hint relevance is independent of display preview length", () => {
    const fullContent = `${"unrelated ".repeat(40)}historian cache wiring`;
    for (const length of [0, 80, 220, fullContent.length]) {
        const preview = fullContent.slice(0, length);
        const memory = withMemoryHintContent(hybridMemory(preview), fullContent);
        expect(autoSearchRelevance("historian cache wiring", memory)).toBe(0.8000000000000002);
        expect(JSON.stringify(memory)).toBe(JSON.stringify(hybridMemory(preview)));
    }
});

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
