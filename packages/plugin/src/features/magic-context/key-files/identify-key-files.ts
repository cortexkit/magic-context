import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { type FileReadStat, getSessionReadStats } from "./read-stats";
import { greedyFitFiles, setKeyFiles } from "./storage-key-files";

export const KEY_FILES_SYSTEM_PROMPT =
    "You are a file importance evaluator. Given read statistics about files in a coding session, identify which are core orientation files worth pinning in context. Return a JSON array.";

/**
 * Build the LLM prompt for key file identification.
 * Called from the dreamer runner which handles session creation.
 */
export function buildKeyFilesPrompt(
    candidates: FileReadStat[],
    tokenBudget: number,
    minReads: number,
): string {
    const statsText = candidates
        .map(
            (s) =>
                `- **${s.filePath}** — ${s.fullReadCount} full reads, ${s.editCount} edits, ~${s.latestReadTokens} tokens`,
        )
        .join("\n");

    return `## Identify Key Files for Pinning

The following files were fully read ${minReads}+ times during a coding session.
Identify which ones are **core orientation files** worth keeping permanently in context.

### Signals of a core orientation file:
- Read many times across different phases of work (not clustered in one task)
- Read without editing — consulted for understanding, not modification
- Contains architecture, configuration, types, or key abstractions

### Signals of a NON-core file (exclude):
- Read many times but always edited — actively working on it
- Very large (>5000 tokens) — too expensive to pin
- Test files, scripts, or generated files

### Token budget: ${tokenBudget} tokens total

### Files:
${statsText}

### Output Format
Return a JSON array ranked by importance (most important first):
\`\`\`json
[
  {"filePath": "src/path/to/file.ts", "tokens": 2500, "reason": "brief reason"}
]
\`\`\`

Only include files you're confident are true orientation files. Return empty array if none qualify.`;
}

/**
 * Parse the LLM's response into a ranked file list.
 */
export function parseKeyFilesOutput(text: string): Array<{ filePath: string; tokens: number }> {
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ?? text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    try {
        const raw = jsonMatch[1] ?? jsonMatch[0];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];

        return parsed
            .filter(
                (item: unknown): item is { filePath: string; tokens: number } =>
                    typeof item === "object" &&
                    item !== null &&
                    typeof (item as Record<string, unknown>).filePath === "string" &&
                    typeof (item as Record<string, unknown>).tokens === "number",
            )
            .map((item) => ({ filePath: item.filePath, tokens: item.tokens }));
    } catch {
        return [];
    }
}

/**
 * Get candidate files for key-file analysis from OpenCode's DB.
 * Returns files with full reads >= minReads and size under half the budget.
 */
export function getKeyFileCandidates(
    openCodeDb: Database,
    sessionId: string,
    minReads: number,
    tokenBudget: number,
    projectDirectory?: string,
): FileReadStat[] {
    const stats = getSessionReadStats(openCodeDb, sessionId, minReads);
    const maxPerFileTokens = Math.min(tokenBudget / 2, 5000);
    // Filter to files within the project directory — long-running sessions may have
    // read files from other repos, which should not be pinned as key files.
    const projectPrefix = projectDirectory ? `${projectDirectory.replace(/\/$/, "")}/` : undefined;
    return stats.filter(
        (s) =>
            s.latestReadTokens > 0 &&
            s.latestReadTokens <= maxPerFileTokens &&
            (!projectPrefix || s.filePath.startsWith(projectPrefix)),
    );
}

/**
 * Apply LLM-ranked results through the knapsack solver and persist.
 */
export function applyKeyFileResults(
    db: Database,
    sessionId: string,
    llmRanked: Array<{ filePath: string; tokens: number }>,
    tokenBudget: number,
    candidatePaths?: Set<string>,
): { filesIdentified: number; totalTokens: number } {
    // Filter LLM output to only include files that were in the candidate set.
    // Prevents hallucinated paths from being pinned.
    const filtered = candidatePaths
        ? llmRanked.filter((f) => candidatePaths.has(f.filePath))
        : llmRanked;
    const selected = greedyFitFiles(filtered, tokenBudget);
    setKeyFiles(db, sessionId, selected);

    const totalTokens = selected.reduce((sum, f) => sum + f.tokens, 0);
    log(
        `[key-files][${sessionId}] pinned ${selected.length} files (${totalTokens} tokens): ${selected.map((f) => f.filePath).join(", ")}`,
    );

    return { filesIdentified: selected.length, totalTokens };
}

/**
 * Pure heuristic fallback when LLM is unavailable.
 * Ranks by: high read count, low edit count, reasonable size.
 */
export function heuristicKeyFileSelection(
    db: Database,
    sessionId: string,
    candidates: FileReadStat[],
    tokenBudget: number,
): { filesIdentified: number; totalTokens: number } {
    const scored = candidates
        .map((c) => ({
            filePath: c.filePath,
            tokens: c.latestReadTokens,
            score: c.fullReadCount * 2 - c.editCount * 3,
        }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score);

    const selected = greedyFitFiles(scored, tokenBudget);
    setKeyFiles(db, sessionId, selected);

    const totalTokens = selected.reduce((sum, f) => sum + f.tokens, 0);
    log(
        `[key-files][${sessionId}] heuristic pinned ${selected.length} files (${totalTokens} tokens)`,
    );

    return { filesIdentified: selected.length, totalTokens };
}
