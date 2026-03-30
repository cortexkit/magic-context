import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { type UnifiedSearchResult, unifiedSearch } from "../../features/magic-context/search";
import {
    CTX_SEARCH_DESCRIPTION,
    CTX_SEARCH_TOOL_NAME,
    DEFAULT_CTX_SEARCH_LIMIT,
} from "./constants";
import type { CtxSearchArgs, CtxSearchToolDeps } from "./types";

function normalizeLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_CTX_SEARCH_LIMIT;
    }

    return Math.max(1, Math.floor(limit));
}

function formatResult(result: UnifiedSearchResult, index: number): string {
    if (result.source === "memory") {
        return [
            `[${index}] [memory] score=${result.score.toFixed(2)} id=${result.memoryId} category=${result.category} match=${result.matchType}`,
            result.content,
        ].join("\n");
    }

    if (result.source === "fact") {
        return [
            `[${index}] [fact] score=${result.score.toFixed(2)} category=${result.factCategory} id=${result.factId}`,
            result.content,
        ].join("\n");
    }

    const expandStart = Math.max(1, result.messageOrdinal - 3);
    const expandEnd = result.messageOrdinal + 3;
    return [
        `[${index}] [message] score=${result.score.toFixed(2)} ordinal=${result.messageOrdinal} role=${result.role}`,
        result.content,
        `Expand with ctx_expand(start=${expandStart}, end=${expandEnd}).`,
    ].join("\n");
}

function formatSearchResults(query: string, results: UnifiedSearchResult[]): string {
    if (results.length === 0) {
        return `No results found for "${query}" across memories, session facts, or message history.`;
    }

    const body = results.map((result, index) => formatResult(result, index + 1)).join("\n\n");
    return `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}":\n\n${body}`;
}

function createCtxSearchTool(deps: CtxSearchToolDeps): ToolDefinition {
    return tool({
        description: CTX_SEARCH_DESCRIPTION,
        args: {
            query: tool.schema
                .string()
                .describe("Search query across memories, facts, and conversation history."),
            limit: tool.schema
                .number()
                .optional()
                .describe("Maximum results to return (default: 10)"),
        },
        async execute(args: CtxSearchArgs, toolContext) {
            const query = args.query?.trim();
            if (!query) {
                return "Error: 'query' is required.";
            }

            const results = await unifiedSearch(
                deps.db,
                toolContext.sessionID,
                deps.projectPath,
                query,
                {
                    limit: normalizeLimit(args.limit),
                    memoryEnabled: deps.memoryEnabled,
                    embeddingEnabled: deps.embeddingEnabled,
                    readMessages: deps.readMessages,
                },
            );

            return formatSearchResults(query, results);
        },
    });
}

export function createCtxSearchTools(deps: CtxSearchToolDeps): Record<string, ToolDefinition> {
    return {
        [CTX_SEARCH_TOOL_NAME]: createCtxSearchTool(deps),
    };
}
