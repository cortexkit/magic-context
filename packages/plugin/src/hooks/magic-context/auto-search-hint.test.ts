import { describe, expect, it } from "bun:test";
import type { UnifiedSearchResult } from "../../features/magic-context/search";
import { buildAutoSearchHint } from "./auto-search-hint";

function memory(content: string, score = 0.85, id = 1): UnifiedSearchResult {
    return {
        source: "memory",
        content,
        score,
        memoryId: id,
        category: "ARCHITECTURE_DECISIONS",
        matchType: "hybrid",
    };
}

function commit(message: string, daysAgo = 3): UnifiedSearchResult {
    return {
        source: "git_commit",
        content: message,
        score: 0.8,
        sha: "a".repeat(40),
        shortSha: "abcd123",
        author: "dev@example.com",
        committedAtMs: Date.now() - daysAgo * 24 * 60 * 60 * 1000,
        matchType: "fts",
    };
}

describe("buildAutoSearchHint", () => {
    it("returns null for empty results", () => {
        expect(buildAutoSearchHint([])).toBeNull();
    });

    it("wraps fragments in <ctx-search-hint>", () => {
        const hint = buildAutoSearchHint([memory("install.sh uses bunx without --bun flag")]);
        expect(hint).not.toBeNull();
        expect(hint?.startsWith("<ctx-search-hint>")).toBe(true);
        expect(hint?.endsWith("</ctx-search-hint>")).toBe(true);
        expect(hint).toContain("ctx_search");
        expect(hint).toContain("If the fragments above seem relevant");
    });

    it("caps to max fragments", () => {
        const results = [memory("one"), memory("two"), memory("three"), memory("four")];
        const hint = buildAutoSearchHint(results, { maxFragments: 2 });
        const lines = (hint ?? "").split("\n").filter((l) => l.startsWith("- "));
        expect(lines).toHaveLength(2);
    });

    it("truncates overlong fragments with ellipsis", () => {
        const long = "a".repeat(500);
        const hint = buildAutoSearchHint([memory(long)], { fragmentCharCap: 40 });
        expect(hint).not.toBeNull();
        // Find the bullet line
        const bullet = (hint ?? "").split("\n").find((l) => l.startsWith("- "));
        expect(bullet).toBeDefined();
        expect((bullet?.length ?? 0) <= 45).toBe(true);
        expect(bullet?.endsWith("…")).toBe(true);
    });

    it("prefixes commit fragments with sha and relative age", () => {
        const hint = buildAutoSearchHint([commit("install: force bun runtime", 5)]);
        expect(hint).toContain("commit abcd123");
        expect(hint).toContain("5d ago");
        expect(hint).toContain("install: force bun runtime");
    });

    it("compresses memory content with caveman-ultra", () => {
        // "because" should become "//" under ultra compression.
        const hint = buildAutoSearchHint([
            memory("install fails because Node handles stdin differently"),
        ]);
        expect(hint).toContain("//");
    });

    it("singular vs plural header", () => {
        const single = buildAutoSearchHint([memory("one")]);
        expect(single).toContain("1 related fragment");
        const many = buildAutoSearchHint([memory("one"), memory("two")]);
        expect(many).toContain("2 related fragments");
    });
});
