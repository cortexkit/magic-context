import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import {
    embedTextForProject,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/memory/embedding";
import {
    describeUnresolvedProjectIdentity,
    directoryHasGitMetadata,
} from "../../features/magic-context/memory/project-identity";
import {
    createUnifiedSearchDiagnostics,
    formatSearchResults,
    parseIdShapedQuery,
    resolveMemoriesByIdsForSearch,
    unifiedSearch,
} from "../../features/magic-context/search";
import { getVisibleMemoryIds } from "../../hooks/magic-context/inject-compartments";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import {
    CTX_SEARCH_DESCRIPTION,
    CTX_SEARCH_TOOL_NAME,
    DEFAULT_CTX_SEARCH_LIMIT,
} from "./constants";
import { parseSearchDateRange, SearchDateRangeError } from "./date-range";
import type { CtxSearchArgs, CtxSearchSource, CtxSearchToolDeps } from "./types";

export { CTX_SEARCH_LIGHT_DESCRIPTION } from "../light-descriptions";

const VALID_SOURCES: ReadonlySet<CtxSearchSource> = new Set([
    "memory",
    "message",
    "git_commit",
    "primer",
    "note",
]);

function normalizeLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit === 0) {
        return DEFAULT_CTX_SEARCH_LIMIT;
    }

    return Math.max(1, Math.floor(limit));
}

/** Validate and normalize the `sources` arg. Drops unknown strings (the enum
 *  constraint catches them at the schema layer, but we still want a safe
 *  runtime check for plugins/tests that call this directly). Required-all
 *  surfaces fill unused arrays with `[]`; treat that the same as omitting
 *  `sources` so the search covers every enabled source instead of silently
 *  returning nothing. */
function normalizeSources(sources?: string[]): CtxSearchSource[] | undefined {
    if (sources === undefined) return undefined;
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
    return sources.length === 0 ? undefined : result;
}

const ctxSearchArgsShape = {
    query: tool.schema
        .string()
        .optional()
        .describe("A natural-language question carrying the exact terms you expect in the answer."),
    limit: tool.schema.number().optional().describe("Maximum results (default 10)."),
    from: tool.schema.string().optional().describe("Earliest date, YYYY-MM-DD (inclusive)."),
    to: tool.schema
        .string()
        .optional()
        .describe("Latest date, YYYY-MM-DD (inclusive; default open)."),
    sources: tool.schema
        .array(tool.schema.enum(["memory", "message", "git_commit", "primer", "note"]))
        .optional()
        .describe("Restrict to these sources; omit for all. [] searches none."),
};
// The tool definition exposes only the documented argument shape to the model
// provider, but older callers may still send extra arguments. Parse with
// passthrough so execute() can receive those fields without advertising them.
const ctxSearchArgsSchema = tool.schema.object(ctxSearchArgsShape).passthrough();

function createCtxSearchTool(deps: CtxSearchToolDeps): ToolDefinition {
    return tool({
        description: CTX_SEARCH_DESCRIPTION,
        args: ctxSearchArgsShape,
        async execute(rawArgs: CtxSearchArgs, toolContext) {
            const parsedArgs = ctxSearchArgsSchema.safeParse(rawArgs);
            let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxSearchArgs;
            args = unwrapImitatedReducedArgs(args, ["query"], {
                query: "string",
                limit: "number",
                from: "string",
                to: "string",
                sources: {
                    type: "array",
                    items: "string",
                    maxItems: 5,
                    values: ["memory", "message", "git_commit", "primer", "note"],
                },
            });
            const query = args.query?.trim();
            if (!query) {
                return "Error: 'query' is required.";
            }
            let dateRange: ReturnType<typeof parseSearchDateRange>;
            try {
                dateRange = parseSearchDateRange(args.from, args.to);
            } catch (error) {
                if (error instanceof SearchDateRangeError) return `Error: ${error.message}`;
                throw error;
            }

            // Only search message history up to the last compartment boundary —
            // anything after that (the live tail, including the current turn) is
            // still in context and already visible to the agent. When NO compartment
            // exists yet, the historian hasn't scrolled anything out of context, so
            // the boundary is 0: every indexed message (ordinals are 1-based) is in
            // the live tail and must be excluded. A negative sentinel here would mean
            // "search everything" and leak the current prompt back to the agent — the
            // exact opposite of the intent (issue #131).
            const lastCompartmentEnd = getLastCompartmentEndMessage(deps.db, toolContext.sessionID);
            const messageOrdinalCutoff = lastCompartmentEnd >= 0 ? lastCompartmentEnd : 0;

            // Hard-filter memories already rendered in <session-history>.
            // They're visible in message[0], so returning them wastes output
            // tokens and crowds out high-signal raw-history hits.
            const visibleMemoryIds = getVisibleMemoryIds(deps.db, toolContext.sessionID);
            const diagnostics = createUnifiedSearchDiagnostics();

            // Resolve the session's actual project from `toolContext.directory`
            // each call. OpenCode's top-level `ctx.directory` (the launch dir)
            // can differ from the session's working directory when the user
            // runs `opencode -s <id>` from outside the project.
            const projectPath = deps.resolveProjectPath(toolContext.directory);
            if (!projectPath) {
                return `Error: Could not resolve project identity for search: ${describeUnresolvedProjectIdentity(toolContext.directory)}`;
            }
            await deps.ensureProjectRegistered?.(toolContext.directory, deps.db);
            const embeddingSnapshot = getProjectEmbeddingSnapshot(projectPath);
            const memoryEnabled = embeddingSnapshot?.features.memoryEnabled ?? deps.memoryEnabled;
            // Query embedding serves history, memory and commit lanes alike, so it
            // follows the provider alone; each lane applies its own feature gate.
            const embeddingEnabled = embeddingSnapshot
                ? embeddingSnapshot.historyEnabled
                : deps.embeddingEnabled;
            const gitCommitsEnabled =
                embeddingSnapshot?.gitCommitEnabled ?? deps.gitCommitsEnabled ?? false;

            // ID-shaped short-circuit: when the whole query is one or more
            // memory ids, bypass the lexical+semantic lanes and look the ids
            // up directly. The agent is given memory ids everywhere
            // (<project-memory> shows `#id:` lines, dashboard, guidance) and
            // ctx_search was the only tool that could surface content for
            // an id but it did so through text matching. Whole-query id list
            // only — `parseIdShapedQuery` returns null for "fix bug 1234" so
            // numeric phrases still search text. If no ids resolve (foreign
            // hidden, missing, hard-deleted) the call falls through to the
            // normal lanes so a query like "7234" with no such memory still
            // returns the corpus text matches.
            const idShape = parseIdShapedQuery(query);
            if (idShape && memoryEnabled) {
                const idResults = resolveMemoriesByIdsForSearch({
                    db: deps.db,
                    projectPath,
                    ids: idShape,
                    limit: Math.max(normalizeLimit(args.limit), idShape.length),
                    visibleMemoryIds,
                    diagnostics,
                    ...dateRange,
                });
                if (idResults !== null || diagnostics.suppressedVisibleMemoryIds.length > 0) {
                    return formatSearchResults(
                        query,
                        idResults ?? [],
                        toolContext.sessionID,
                        diagnostics,
                    );
                }
            }

            const results = await unifiedSearch(
                deps.db,
                toolContext.sessionID,
                projectPath,
                query,
                {
                    limit: normalizeLimit(args.limit),
                    memoryEnabled,
                    embeddingEnabled,
                    embedQuery: async (text, signal) => {
                        const result = await embedTextForProject(
                            projectPath,
                            text,
                            signal,
                            "query",
                        );
                        return result;
                    },
                    isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
                    readMessages: deps.readMessages,
                    maxMessageOrdinal: messageOrdinalCutoff,
                    gitCommitsEnabled,
                    sources: normalizeSources(args.sources),
                    visibleMemoryIds,
                    diagnostics,
                    gitRepositoryAvailable:
                        typeof toolContext.directory === "string"
                            ? directoryHasGitMetadata(toolContext.directory)
                            : undefined,
                    // Explicit agent search → enable literal-probe multi-query
                    // recall for symbol/command/path lookups. Auto-search hints
                    // (the hot path) leave this off to protect their latency.
                    explicitSearch: true,
                    ...dateRange,
                },
            );

            return formatSearchResults(query, results, toolContext.sessionID, diagnostics);
        },
    });
}

export function createCtxSearchTools(deps: CtxSearchToolDeps): Record<string, ToolDefinition> {
    return {
        [CTX_SEARCH_TOOL_NAME]: createCtxSearchTool(deps),
    };
}
