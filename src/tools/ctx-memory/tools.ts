import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import {
    ensureMemoryEmbeddings,
    getMemoryByHash,
    getMemoriesByProject,
    loadAllEmbeddings,
    searchMemoriesFTS,
    updateMemoryRetrievalCount,
    updateMemorySeenCount,
} from "../../features/magic-context/memory";
import {
    archiveMemory,
    CATEGORY_PRIORITY,
    getMemoryById,
    insertMemory,
    type Memory,
    type MemoryCategory,
    saveEmbedding,
} from "../../features/magic-context/memory";
import {
    embedText,
    getEmbeddingModelId,
    isEmbeddingEnabled,
} from "../../features/magic-context/memory/embedding";
import { cosineSimilarity } from "../../features/magic-context/memory/cosine-similarity";
import { computeNormalizedHash } from "../../features/magic-context/memory/normalize-hash";
import { log } from "../../shared/logger";
import { CTX_MEMORY_DESCRIPTION, CTX_MEMORY_TOOL_NAME, DEFAULT_SEARCH_LIMIT } from "./constants";
import type { CtxMemoryArgs, CtxMemorySearchResult, CtxMemoryToolDeps } from "./types";

const SEMANTIC_WEIGHT = 0.7;
const FTS_WEIGHT = 0.3;
const SINGLE_SOURCE_PENALTY = 0.8;

const MEMORY_CATEGORIES = new Set<string>(CATEGORY_PRIORITY);

function isMemoryCategory(value: string): value is MemoryCategory {
    return MEMORY_CATEGORIES.has(value);
}

function normalizeLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_SEARCH_LIMIT;
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

function formatSearchResults(query: string, results: CtxMemorySearchResult[]): string {
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
    deps: CtxMemoryToolDeps,
    query: string,
    memories: Memory[],
): Promise<Map<number, number>> {
    const semanticScores = new Map<number, number>();

    if (!deps.embeddingEnabled || !isEmbeddingEnabled() || memories.length === 0) {
        return semanticScores;
    }

    const queryEmbedding = await embedText(query);
    if (!queryEmbedding) {
        return semanticScores;
    }

    const embeddings = await ensureMemoryEmbeddings({
        db: deps.db,
        memories,
        existingEmbeddings: loadAllEmbeddings(deps.db, deps.projectPath),
    });

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
    deps: CtxMemoryToolDeps,
    query: string,
    category?: string,
    limit = DEFAULT_SEARCH_LIMIT,
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
): CtxMemorySearchResult[] {
    const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
    const candidateIds = new Set<number>([...semanticScores.keys(), ...ftsScores.keys()]);

    const results: CtxMemorySearchResult[] = [];

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

function queueMemoryEmbedding(deps: CtxMemoryToolDeps, memoryId: number, content: string): void {
    void (async () => {
        const embedding = await embedText(content);
        if (!embedding) {
            return;
        }

        saveEmbedding(deps.db, memoryId, embedding, getEmbeddingModelId());
    })().catch((error: unknown) => {
        log("[ctx-memory] failed to save memory embedding:", error);
    });
}

function getValidatedCategory(category: string | undefined): MemoryCategory | null {
    const trimmedCategory = category?.trim();

    if (!trimmedCategory) {
        return null;
    }

    if (!isMemoryCategory(trimmedCategory)) {
        return null;
    }

    return trimmedCategory;
}

function getDisabledMessage(): string {
    return "Cross-session memory is disabled for this project.";
}

function createCtxMemoryTool(deps: CtxMemoryToolDeps): ToolDefinition {
    return tool({
        description: CTX_MEMORY_DESCRIPTION,
        args: {
            action: tool.schema
                .enum(["write", "delete", "search"])
                .describe("Action to perform on memories"),
            content: tool.schema
                .string()
                .optional()
                .describe("Memory content (required for write)"),
            category: tool.schema
                .string()
                .optional()
                .describe("Memory category (required for write, optional filter for search)"),
            id: tool.schema.number().optional().describe("Memory ID (required for delete)"),
            query: tool.schema
                .string()
                .optional()
                .describe(
                    "Natural language search query for project memories (required for search)",
                ),
            limit: tool.schema
                .number()
                .optional()
                .describe("Maximum results to return for search (default: 10)"),
        },
        async execute(args: CtxMemoryArgs, toolContext) {
            if (!deps.memoryEnabled) {
                return getDisabledMessage();
            }

            if (args.action === "write") {
                const content = args.content?.trim();
                if (!content) {
                    return "Error: 'content' is required when action is 'write'.";
                }

                const rawCategory = args.category?.trim();
                if (!rawCategory) {
                    return "Error: 'category' is required when action is 'write'.";
                }

                const category = getValidatedCategory(rawCategory);
                if (!category) {
                    return `Error: Unknown memory category '${rawCategory}'.`;
                }

                // Check for duplicate before inserting to avoid SQLite UNIQUE constraint errors
                const existingMemory = getMemoryByHash(
                    deps.db,
                    deps.projectPath,
                    category,
                    computeNormalizedHash(content),
                );
                if (existingMemory) {
                    updateMemorySeenCount(deps.db, existingMemory.id);
                    return `Memory already exists [ID: ${existingMemory.id}] in ${category} (seen count incremented).`;
                }

                const memory = insertMemory(deps.db, {
                    projectPath: deps.projectPath,
                    category,
                    content,
                    sourceSessionId: toolContext.sessionID,
                    sourceType: "agent",
                });

                queueMemoryEmbedding(deps, memory.id, content);

                return `Saved memory [ID: ${memory.id}] in ${category}.`;
            }

            if (args.action === "delete") {
                if (typeof args.id !== "number" || !Number.isInteger(args.id)) {
                    return "Error: 'id' is required when action is 'delete'.";
                }

                const memory = getMemoryById(deps.db, args.id);
                if (!memory || memory.projectPath !== deps.projectPath) {
                    return `Error: Memory with ID ${args.id} was not found.`;
                }

                archiveMemory(deps.db, args.id);
                return `Archived memory [ID: ${args.id}].`;
            }

            if (args.action === "search") {
                if (typeof args.query !== "string") {
                    return "Error: 'query' must be provided when action is 'search'.";
                }

                const query = args.query.trim();
                if (!query) {
                    return "Error: 'query' must be provided when action is 'search'.";
                }

                const limit = normalizeLimit(args.limit);
                const category = normalizeCategory(args.category);
                const projectMemories = filterByCategory(
                    getMemoriesByProject(deps.db, deps.projectPath),
                    category,
                );
                const ftsLimit = Math.max(limit * 5, projectMemories.length, DEFAULT_SEARCH_LIMIT);

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

                return formatSearchResults(query, results);
            }

            return "Error: Unknown action.";
        },
    });
}

export function createCtxMemoryTools(deps: CtxMemoryToolDeps): Record<string, ToolDefinition> {
    return {
        [CTX_MEMORY_TOOL_NAME]: createCtxMemoryTool(deps),
    };
}
