import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import type { Memory } from "../../features/magic-context/memory";
import {
    getMemoriesByProject,
    loadAllEmbeddings,
    searchMemoriesFTS,
    updateMemoryRetrievalCount,
} from "../../features/magic-context/memory";
import { cosineSimilarity, embedText } from "../../features/magic-context/memory/embedding";
import { CTX_RECALL_DESCRIPTION, CTX_RECALL_TOOL_NAME, DEFAULT_RECALL_LIMIT } from "./constants";
import type { CtxRecallArgs, CtxRecallResult, CtxRecallToolDeps } from "./types";

const SEMANTIC_WEIGHT = 0.7;
const FTS_WEIGHT = 0.3;
const SINGLE_SOURCE_PENALTY = 0.8;

function normalizeLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_RECALL_LIMIT;
    }

    return Math.max(1, Math.floor(limit));
}

function normalizeCategory(category?: string): string | undefined {
    const trimmed = category?.trim();
    return trimmed ? trimmed : undefined;
}

function normalizeCosineScore(score: number): number {
    if (!Number.isFinite(score)) {
        return 0;
    }

    return Math.min(1, Math.max(0, score));
}

function formatResults(query: string, results: CtxRecallResult[]): string {
    if (results.length === 0) {
        return `No memories found matching "${query}".`;
    }

    const noun = results.length === 1 ? "memory" : "memories";
    const body = results
        .map(
            (result, index) =>
                `[${index + 1}] (score: ${result.score.toFixed(2)}) [${result.category}]\n${result.content}`,
        )
        .join("\n\n");

    return `Found ${results.length} ${noun} matching "${query}":\n\n${body}`;
}

function filterByCategory(memories: Memory[], category?: string): Memory[] {
    if (!category) {
        return memories;
    }

    return memories.filter((memory) => memory.category === category);
}

async function getSemanticScores(
    deps: CtxRecallToolDeps,
    query: string,
    memories: Memory[],
): Promise<Map<number, number>> {
    const semanticScores = new Map<number, number>();

    if (deps.embeddingProvider === "off" || memories.length === 0) {
        return semanticScores;
    }

    const queryEmbedding = await embedText(query, { embedding_provider: deps.embeddingProvider });
    if (!queryEmbedding) {
        return semanticScores;
    }

    const embeddings = loadAllEmbeddings(deps.db, deps.projectPath);

    for (const memory of memories) {
        const memoryEmbedding = embeddings.get(memory.id);
        if (!memoryEmbedding) {
            continue;
        }

        semanticScores.set(
            memory.id,
            normalizeCosineScore(cosineSimilarity(queryEmbedding, memoryEmbedding)),
        );
    }

    return semanticScores;
}

function getFtsScores(
    deps: CtxRecallToolDeps,
    query: string,
    category?: string,
    limit = DEFAULT_RECALL_LIMIT,
): Map<number, number> {
    try {
        const matches = filterByCategory(
            searchMemoriesFTS(deps.db, deps.projectPath, query, limit),
            category,
        );

        return new Map(matches.map((memory, rank) => [memory.id, 1 / (rank + 1)]));
    } catch {
        return new Map();
    }
}

function mergeResults(
    memories: Memory[],
    semanticScores: Map<number, number>,
    ftsScores: Map<number, number>,
    limit: number,
): CtxRecallResult[] {
    const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
    const candidateIds = new Set<number>([...semanticScores.keys(), ...ftsScores.keys()]);

    const results: CtxRecallResult[] = [];

    for (const id of candidateIds) {
        const memory = memoryById.get(id);
        if (!memory) {
            continue;
        }

        const semanticScore = semanticScores.get(id);
        const ftsScore = ftsScores.get(id);

        let score = 0;
        let source = "fts";

        if (semanticScore !== undefined && ftsScore !== undefined) {
            score = SEMANTIC_WEIGHT * semanticScore + FTS_WEIGHT * ftsScore;
            source = "hybrid";
        } else if (semanticScore !== undefined) {
            score = semanticScore * SINGLE_SOURCE_PENALTY;
            source = "semantic";
        } else if (ftsScore !== undefined) {
            score = ftsScore * SINGLE_SOURCE_PENALTY;
            source = "fts";
        }

        if (score > 0) {
            results.push({
                id,
                category: memory.category,
                content: memory.content,
                score,
                source,
            });
        }
    }

    return results
        .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }

            return left.id - right.id;
        })
        .slice(0, limit);
}

function createCtxRecallTool(deps: CtxRecallToolDeps): ToolDefinition {
    return tool({
        description: CTX_RECALL_DESCRIPTION,
        args: {
            query: tool.schema
                .string()
                .describe("Natural language search query for project memories"),
            category: tool.schema
                .string()
                .optional()
                .describe("Optional category filter (e.g., ARCHITECTURE_DECISIONS, CONSTRAINTS)"),
            limit: tool.schema
                .number()
                .optional()
                .describe("Maximum results to return (default: 10)"),
        },
        async execute(args: CtxRecallArgs) {
            if (!deps.memoryEnabled) {
                return "Project memory is disabled. Enable memory to use ctx_recall.";
            }

            if (typeof args.query !== "string") {
                return "Error: 'query' must be provided.";
            }

            const query = args.query.trim();
            if (!query) {
                return "Error: 'query' must be provided.";
            }

            const limit = normalizeLimit(args.limit);
            const category = normalizeCategory(args.category);
            const projectMemories = filterByCategory(
                [
                    ...getMemoriesByProject(deps.db, deps.projectPath),
                    ...getMemoriesByProject(deps.db, "__global__"),
                ],
                category,
            );
            const ftsLimit = Math.max(limit * 5, projectMemories.length, DEFAULT_RECALL_LIMIT);

            const semanticScores = await getSemanticScores(deps, query, projectMemories);
            const ftsScores = getFtsScores(deps, query, category, ftsLimit);
            const results = mergeResults(projectMemories, semanticScores, ftsScores, limit);

            if (results.length > 0) {
                deps.db.transaction(() => {
                    for (const result of results) {
                        updateMemoryRetrievalCount(deps.db, result.id);
                    }
                })();
            }

            return formatResults(query, results);
        },
    });
}

export function createCtxRecallTools(deps: CtxRecallToolDeps): Record<string, ToolDefinition> {
    return {
        [CTX_RECALL_TOOL_NAME]: createCtxRecallTool(deps),
    };
}
