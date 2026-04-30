import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import { type UnifiedSearchResult, unifiedSearch } from "../../features/magic-context/search";
import { getVisibleMemoryIds } from "../../hooks/magic-context/inject-compartments";
import {
    CTX_SEARCH_DESCRIPTION,
    CTX_SEARCH_TOOL_NAME,
    DEFAULT_CTX_SEARCH_LIMIT,
} from "./constants";
import type { CtxSearchArgs, CtxSearchSource, CtxSearchToolDeps } from "./types";

const VALID_SOURCES: ReadonlySet<CtxSearchSource> = new Set(["memory", "message", "git_commit"]);

function normalizeLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_CTX_SEARCH_LIMIT;
    }

    return Math.max(1, Math.floor(limit));
}

/** Validate and normalize the `sources` arg. Drops unknown strings (the enum
 *  constraint catches them at the schema layer, but we still want a safe
 *  runtime check for plugins/tests that call this directly). Returns
 *  `undefined` when no `sources` were provided so unifiedSearch falls back to
 *  its default (all sources). */
function normalizeSources(sources?: string[]): CtxSearchSource[] | undefined {
    if (!sources || sources.length === 0) return undefined;
    const result: CtxSearchSource[] = [];
    const seen = new Set<CtxSearchSource>();
    for (const source of sources) {
        if (VALID_SOURCES.has(source as CtxSearchSource)) {
            const typed = source as CtxSearchSource;
            if (!seen.has(typed)) {
                seen.add(typed);
                result.push(typed);
            }
        }
    }
    return result.length > 0 ? result : undefined;
}

function formatAge(committedAtMs: number): string {
    const ageMs = Date.now() - committedAtMs;
    if (ageMs < 0) return "future";
    const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    if (days <= 0) return "today";
    if (days === 1) return "1d ago";
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months === 1) return "1mo ago";
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(days / 365);
    return years === 1 ? "1y ago" : `${years}y ago`;
}

function formatResult(result: UnifiedSearchResult, index: number): string {
    if (result.source === "memory") {
        return [
            `[${index}] [memory] score=${result.score.toFixed(2)} id=${result.memoryId} category=${result.category} match=${result.matchType}`,
            result.content,
        ].join("\n");
    }

    if (result.source === "git_commit") {
        return [
            `[${index}] [git_commit] score=${result.score.toFixed(2)} sha=${result.shortSha} ${formatAge(result.committedAtMs)} match=${result.matchType}`,
            result.content,
        ].join("\n");
    }

    const expandStart = Math.max(1, result.messageOrdinal - 3);
    const expandEnd = result.messageOrdinal + 3;
    return [
        `[${index}] [message] score=${result.score.toFixed(2)} ordinal=${result.messageOrdinal} range=${expandStart}-${expandEnd} role=${result.role}`,
        result.content,
    ].join("\n");
}

function formatSearchResults(query: string, results: UnifiedSearchResult[]): string {
    if (results.length === 0) {
        return `No results found for "${query}" across memories, git commits, or message history.`;
    }

    const bodyParts = results.map((result, index) => formatResult(result, index + 1));
    if (results.some((result) => result.source === "message")) {
        bodyParts.push(
            "Use ctx_expand(start, end) with the range from any message result above to read the full conversation context.",
        );
    }
    const body = bodyParts.join("\n\n");
    return `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}":\n\n${body}`;
}

function createCtxSearchTool(deps: CtxSearchToolDeps): ToolDefinition {
    return tool({
        description: CTX_SEARCH_DESCRIPTION,
        args: {
            query: tool.schema
                .string()
                .describe(
                    "Search query. Matches against memory content, git commit messages, and raw user/assistant message text.",
                ),
            limit: tool.schema
                .number()
                .optional()
                .describe("Maximum results to return (default: 10)"),
            sources: tool.schema
                .array(tool.schema.enum(["memory", "message", "git_commit"]))
                .optional()
                .describe(
                    'Optional. Restrict to specific sources. Examples: ["git_commit"] for "when did we change X", ["memory"] for naming conventions, ["message"] for "did we discuss this earlier", ["git_commit","message"] for regression hunts. Omit for a broad search across all enabled sources.',
                ),
        },
        async execute(args: CtxSearchArgs, toolContext) {
            const query = args.query?.trim();
            if (!query) {
                return "Error: 'query' is required.";
            }

            // Only search message history up to the last compartment boundary —
            // anything after that is still in the live context and already visible to the agent.
            const lastCompartmentEnd = getLastCompartmentEndMessage(deps.db, toolContext.sessionID);

            // Hard-filter memories already rendered in <session-history>.
            // They're visible in message[0], so returning them wastes output
            // tokens and crowds out high-signal raw-history hits.
            const visibleMemoryIds = getVisibleMemoryIds(deps.db, toolContext.sessionID);

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
                    maxMessageOrdinal: lastCompartmentEnd >= 0 ? lastCompartmentEnd : undefined,
                    gitCommitsEnabled: deps.gitCommitsEnabled ?? false,
                    sources: normalizeSources(args.sources),
                    visibleMemoryIds,
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
