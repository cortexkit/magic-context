/**
 * Pi-side wrapper for the `ctx_search` tool.
 *
 * The core search logic in `unifiedSearch()` is harness-agnostic — it operates
 * over the shared SQLite store. The pi-plugin only needs to:
 *
 *   1. Translate the LLM-provided arguments into the search options shape.
 *   2. Resolve session ID and project identity from the Pi extension context.
 *   3. Format results for the LLM the same way the OpenCode plugin does.
 *
 * Note: `ctx_expand` is intentionally NOT registered yet. It currently relies
 * on raw OpenCode message ordinals indexed via `message_history_index`. Pi
 * sessions are JSONL files, not OpenCode's `opencode.db`, so we'd need a
 * separate Pi-side message indexer before `ctx_expand` becomes meaningful.
 * Defer until the transform pipeline lands in Step 4b.
 */

import { getLastCompartmentEndMessage } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	type UnifiedSearchResult,
	unifiedSearch,
} from "@magic-context/core/features/magic-context/search";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getVisibleMemoryIds } from "@magic-context/core/hooks/magic-context/inject-compartments";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "typebox";

const DEFAULT_LIMIT = 10;

const ParamsSchema = Type.Object({
	query: Type.String({
		description:
			"Search query. Matches against memory content, git commit messages, and raw user/assistant message text.",
	}),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum results to return (default: 10)",
		}),
	),
	sources: Type.Optional(
		Type.Array(
			Type.Union([
				Type.Literal("memory"),
				Type.Literal("message"),
				Type.Literal("git_commit"),
			]),
			{
				description:
					'Optional. Restrict to specific sources. Examples: ["git_commit"] for "when did we change X", ["memory"] for naming conventions, ["message"] for "did we discuss this earlier", ["git_commit","message"] for regression hunts. Omit for a broad search across all enabled sources.',
			},
		),
	),
});

type CtxSearchParams = Static<typeof ParamsSchema>;

function normalizeLimit(limit?: number): number {
	if (typeof limit !== "number" || !Number.isFinite(limit))
		return DEFAULT_LIMIT;
	return Math.max(1, Math.floor(limit));
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

	return [
		`[${index}] [message] score=${result.score.toFixed(2)} ordinal=${result.messageOrdinal} role=${result.role}`,
		result.content,
	].join("\n");
}

function formatSearchResults(
	query: string,
	results: UnifiedSearchResult[],
): string {
	if (results.length === 0) {
		return `No results found for "${query}" across memories, git commits, or message history.`;
	}
	const body = results
		.map((result, index) => formatResult(result, index + 1))
		.join("\n\n");
	return `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}":\n\n${body}`;
}

export interface CtxSearchToolDeps {
	db: ContextDatabase;
	memoryEnabled: boolean;
	embeddingEnabled: boolean;
	gitCommitsEnabled?: boolean;
}

export function createCtxSearchTool(
	deps: CtxSearchToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	return {
		name: "ctx_search",
		label: "Magic Context: Search",
		description:
			"Search across project memories, indexed git commits, and raw conversation history.\n\n" +
			"Sources:\n" +
			"- memory: curated cross-session knowledge for this project\n" +
			"- message: raw user/assistant messages from older compartmentalized history\n" +
			"- git_commit: HEAD git commits (when git commit indexing is enabled)\n\n" +
			"Narrow via the `sources` param when the question maps to a specific channel:\n" +
			'- "was this working before / when did this break" → ["git_commit", "message"]\n' +
			'- "when did we change this" → ["git_commit"]\n' +
			'- "what is our naming convention" → ["memory"]\n' +
			'- "did we discuss this earlier" → ["message"]\n' +
			"Omit sources for a broad search across all enabled channels.",
		parameters: ParamsSchema,
		async execute(
			_toolCallId,
			params: CtxSearchParams,
			_signal,
			_onUpdate,
			ctx,
		) {
			const query = params.query?.trim();
			if (!query) {
				return {
					content: [{ type: "text", text: "Error: 'query' is required." }],
					details: undefined,
					isError: true,
				};
			}

			const sessionId = ctx.sessionManager.getSessionId();
			const projectIdentity = resolveProjectIdentity(ctx.cwd);

			// Only search message history up to the last compartment boundary —
			// anything after that is still in the live context and already visible to the agent.
			const lastCompartmentEnd = getLastCompartmentEndMessage(
				deps.db,
				sessionId,
			);

			// Hard-filter memories already rendered in <session-history>.
			const visibleMemoryIds = getVisibleMemoryIds(deps.db, sessionId);

			const results = await unifiedSearch(
				deps.db,
				sessionId,
				projectIdentity,
				query,
				{
					limit: normalizeLimit(params.limit),
					memoryEnabled: deps.memoryEnabled,
					embeddingEnabled: deps.embeddingEnabled,
					maxMessageOrdinal:
						lastCompartmentEnd >= 0 ? lastCompartmentEnd : undefined,
					gitCommitsEnabled: deps.gitCommitsEnabled ?? false,
					sources: params.sources,
					visibleMemoryIds,
				},
			);

			return {
				content: [{ type: "text", text: formatSearchResults(query, results) }],
				details: undefined,
			};
		},
	};
}
