/**
 * Pi-side wrapper for the `ctx_memory` tool.
 *
 * Action surface mirrors OpenCode's `packages/plugin/src/tools/ctx-memory/tools.ts`.
 * Two tiers of actions:
 *
 *  Always-allowed (for any agent that can call ctx_memory):
 *    - write: insert a new memory (or no-op + bump seenCount on dedup hit)
 *    - delete: archive the memory (soft delete via status = 'archived')
 *    - list: list active memories for the current project
 *
 *  Dreamer-only (gated on `allowDreamerActions: true`):
 *    - update: rewrite a memory's content (recomputes normalized_hash + queues re-embed)
 *    - merge: combine N memories into one canonical, supersede the rest
 *    - archive: soft-delete with optional reason (different from delete in that it can take a reason)
 *
 * Allowlist gating mirrors OpenCode's `allowedActions` deps field. In OpenCode,
 * the dreamer subagent gets the full action surface because `toolContext.agent
 * === DREAMER_AGENT`. Pi has no agent identity inside child processes, so we
 * use an explicit flag (`--magic-context-dreamer-actions`) wired through the
 * subagent extension entry. Same effective behavior, different transport.
 *
 * Parity reference (OpenCode):
 *   - `tools/ctx-memory/types.ts` for action enum
 *   - `tools/ctx-memory/tools.ts` for handler logic
 *   - `plugin/tool-registry.ts:114` for allowedActions = ["write", "delete"] default
 *
 * Memories are project-scoped via `resolveProjectIdentity(ctx.cwd)` and stored
 * in the shared cortexkit DB, so a memory written from the pi-plugin is
 * immediately visible to OpenCode sessions on the same project (and vice
 * versa).
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { invalidateAllMemoryBlockCaches } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	archiveMemory,
	CATEGORY_PRIORITY,
	getMemoriesByProject,
	getMemoryByHash,
	getMemoryById,
	insertMemory,
	type Memory,
	type MemoryCategory,
	mergeMemoryStats,
	saveEmbedding,
	supersededMemory,
	updateMemoryContent,
	updateMemorySeenCount,
} from "@magic-context/core/features/magic-context/memory";
import {
	embedText,
	getEmbeddingModelId,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { computeNormalizedHash } from "@magic-context/core/features/magic-context/memory/normalize-hash";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { log } from "@magic-context/core/shared/logger";
import { type Static, Type } from "typebox";

const DEFAULT_LIST_LIMIT = 10;
const VALID_CATEGORIES = new Set<string>(CATEGORY_PRIORITY);

function isMemoryCategory(value: string): value is MemoryCategory {
	return VALID_CATEGORIES.has(value);
}

const ALL_ACTIONS = [
	"write",
	"delete",
	"list",
	"update",
	"merge",
	"archive",
] as const;
type CtxMemoryAction = (typeof ALL_ACTIONS)[number];

const DREAMER_ONLY_ACTIONS: ReadonlySet<CtxMemoryAction> = new Set([
	"update",
	"merge",
	"archive",
]);

const ParamsSchema = Type.Object({
	action: Type.Union(
		ALL_ACTIONS.map((a) => Type.Literal(a)),
		{ description: "Action to perform on memories" },
	),
	content: Type.Optional(
		Type.String({
			description: "Memory content (required for write, update, merge)",
		}),
	),
	category: Type.Optional(
		Type.String({
			description:
				"Memory category (required for write, optional filter for list, optional override for merge). One of: " +
				CATEGORY_PRIORITY.join(", "),
		}),
	),
	id: Type.Optional(
		Type.Number({
			description: "Memory ID (required for delete, update, archive)",
		}),
	),
	ids: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Memory IDs to merge (required for merge)",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum results to return for list (default: 10)",
		}),
	),
	reason: Type.Optional(
		Type.String({ description: "Archive reason (optional for archive)" }),
	),
});

type CtxMemoryParams = Static<typeof ParamsSchema>;

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function err(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined,
		isError: true,
	};
}

function normalizeLimit(limit?: number): number {
	if (typeof limit !== "number" || !Number.isFinite(limit))
		return DEFAULT_LIST_LIMIT;
	return Math.max(1, Math.floor(limit));
}

function formatMemoryList(memories: Memory[]): string {
	if (memories.length === 0) return "No active memories found.";

	const rows = memories.map((m) => ({
		id: String(m.id),
		category: m.category,
		status: m.status,
		updated: new Date(m.updatedAt).toISOString(),
		content: m.content.replace(/\s+/g, " ").trim(),
	}));
	const widths = {
		id: Math.max(2, ...rows.map((r) => r.id.length)),
		category: Math.max(8, ...rows.map((r) => r.category.length)),
		status: Math.max(6, ...rows.map((r) => r.status.length)),
		updated: Math.max(7, ...rows.map((r) => r.updated.length)),
	};
	const fmt = (r: (typeof rows)[number]) =>
		[
			r.id.padEnd(widths.id),
			r.category.padEnd(widths.category),
			r.status.padEnd(widths.status),
			r.updated.padEnd(widths.updated),
			r.content,
		].join(" | ");
	return [
		`Found ${rows.length} active ${rows.length === 1 ? "memory" : "memories"}:`,
		"",
		...rows.map(fmt),
	].join("\n");
}

function queueEmbedding(args: {
	deps: CtxMemoryToolDeps;
	memoryId: number;
	content: string;
}) {
	if (!args.deps.embeddingEnabled) return;
	void (async () => {
		try {
			const embedding = await embedText(args.content);
			if (!embedding) {
				log(
					`[magic-context-pi] embedding skipped for memory ${args.memoryId}: provider unavailable.`,
				);
				return;
			}
			const modelId = getEmbeddingModelId();
			if (modelId === "off") return;
			saveEmbedding(args.deps.db, args.memoryId, embedding, modelId);
			log(`[magic-context-pi] proactively embedded memory ${args.memoryId}.`);
		} catch (error) {
			log(
				`[magic-context-pi] embedding failed for memory ${args.memoryId}:`,
				error,
			);
		}
	})();
}

export interface CtxMemoryToolDeps {
	db: ContextDatabase;
	memoryEnabled: boolean;
	embeddingEnabled: boolean;
	/** When true, dreamer-only actions (update, merge, archive) are exposed.
	 *  Set by the subagent extension entry when the parent passes
	 *  `--magic-context-dreamer-actions`. Default: false (write/delete/list only). */
	allowDreamerActions?: boolean;
}

export function createCtxMemoryTool(
	deps: CtxMemoryToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	const dreamerAllowed = deps.allowDreamerActions === true;
	const description = dreamerAllowed
		? "Manage cross-session project memories. Memories persist across sessions and are " +
			"shared with OpenCode sessions on the same project. " +
			"Supported actions: write, delete, list, update, merge, archive."
		: "Manage cross-session project memories. Memories persist across sessions and are " +
			"shared with OpenCode sessions on the same project. " +
			"Supported actions: write, delete, list.";

	return {
		name: "ctx_memory",
		label: "Magic Context: Memory",
		description,
		parameters: ParamsSchema,
		async execute(
			_toolCallId,
			params: CtxMemoryParams,
			_signal,
			_onUpdate,
			ctx,
		) {
			if (!deps.memoryEnabled) {
				return err("Cross-session memory is disabled for this project.");
			}

			// Gate dreamer-only actions on the allowlist flag. Mirrors
			// OpenCode's `if (toolContext.agent !== DREAMER_AGENT && !allowedActions.includes(args.action))`.
			if (!dreamerAllowed && DREAMER_ONLY_ACTIONS.has(params.action)) {
				return err(
					`Error: Action '${params.action}' is not allowed in this context.`,
				);
			}

			const projectIdentity = resolveProjectIdentity(ctx.cwd);
			const sessionId = ctx.sessionManager.getSessionId();

			if (params.action === "write") {
				const content = params.content?.trim();
				if (!content)
					return err("Error: 'content' is required when action is 'write'.");

				const rawCategory = params.category?.trim();
				if (!rawCategory) {
					return err("Error: 'category' is required when action is 'write'.");
				}
				if (!isMemoryCategory(rawCategory)) {
					return err(
						`Error: Unknown memory category '${rawCategory}'. Valid: ${CATEGORY_PRIORITY.join(", ")}`,
					);
				}

				const existing = getMemoryByHash(
					deps.db,
					projectIdentity,
					rawCategory,
					computeNormalizedHash(content),
				);
				if (existing) {
					updateMemorySeenCount(deps.db, existing.id);
					return ok(
						`Memory already exists [ID: ${existing.id}] in ${rawCategory} (seen count incremented).`,
					);
				}

				const memory = insertMemory(deps.db, {
					projectPath: projectIdentity,
					category: rawCategory,
					content,
					sourceSessionId: sessionId,
					sourceType: dreamerAllowed ? "dreamer" : "agent",
				});

				queueEmbedding({ deps, memoryId: memory.id, content });
				invalidateAllMemoryBlockCaches(deps.db);
				return ok(`Saved memory [ID: ${memory.id}] in ${rawCategory}.`);
			}

			if (params.action === "delete") {
				if (typeof params.id !== "number" || !Number.isInteger(params.id)) {
					return err("Error: 'id' is required when action is 'delete'.");
				}
				const memory = getMemoryById(deps.db, params.id);
				if (!memory || memory.projectPath !== projectIdentity) {
					return err(`Error: Memory with ID ${params.id} was not found.`);
				}
				archiveMemory(deps.db, params.id);
				invalidateAllMemoryBlockCaches(deps.db);
				return ok(`Archived memory [ID: ${params.id}].`);
			}

			if (params.action === "list") {
				const limit = normalizeLimit(params.limit);
				const filtered = getMemoriesByProject(deps.db, projectIdentity);
				const category = params.category?.trim();
				const filtered2 = category
					? filtered.filter((m) => m.category === category)
					: filtered;
				return ok(formatMemoryList(filtered2.slice(0, limit)));
			}

			if (params.action === "update") {
				if (typeof params.id !== "number" || !Number.isInteger(params.id)) {
					return err("Error: 'id' is required when action is 'update'.");
				}
				const content = params.content?.trim();
				if (!content) {
					return err("Error: 'content' is required when action is 'update'.");
				}

				const memory = getMemoryById(deps.db, params.id);
				if (!memory || memory.projectPath !== projectIdentity) {
					return err(`Error: Memory with ID ${params.id} was not found.`);
				}

				const normalizedHash = computeNormalizedHash(content);
				const duplicate = getMemoryByHash(
					deps.db,
					projectIdentity,
					memory.category,
					normalizedHash,
				);
				if (duplicate && duplicate.id !== memory.id) {
					return err(
						`Error: Memory content already exists as ID ${duplicate.id}; merge or archive duplicates instead.`,
					);
				}

				updateMemoryContent(deps.db, memory.id, content, normalizedHash);
				queueEmbedding({ deps, memoryId: memory.id, content });
				invalidateAllMemoryBlockCaches(deps.db);
				return ok(`Updated memory [ID: ${memory.id}] in ${memory.category}.`);
			}

			if (params.action === "merge") {
				const ids = params.ids?.filter((id): id is number =>
					Number.isInteger(id),
				);
				if (!ids || ids.length < 2) {
					return err(
						"Error: 'ids' must include at least two memory IDs when action is 'merge'.",
					);
				}

				const content = params.content?.trim();
				if (!content) {
					return err("Error: 'content' is required when action is 'merge'.");
				}

				const sourceMemories = ids
					.map((id) => getMemoryById(deps.db, id))
					.filter((memory): memory is Memory => Boolean(memory));
				if (sourceMemories.length !== ids.length) {
					return err("Error: One or more source memories were not found.");
				}

				if (
					sourceMemories.some(
						(memory) => memory.projectPath !== projectIdentity,
					)
				) {
					return err(
						"Error: All memories to merge must belong to the current project.",
					);
				}

				const requestedCategory = params.category?.trim();
				if (requestedCategory && !isMemoryCategory(requestedCategory)) {
					return err(
						`Error: Unknown memory category '${requestedCategory}'. Valid: ${CATEGORY_PRIORITY.join(", ")}`,
					);
				}
				const requestedCategoryTyped: MemoryCategory | undefined =
					requestedCategory && isMemoryCategory(requestedCategory)
						? requestedCategory
						: undefined;
				const fallbackCategory = sourceMemories[0]?.category;
				const category: MemoryCategory | undefined =
					requestedCategoryTyped ?? fallbackCategory;
				if (!category) {
					return err(
						"Error: A valid category is required when action is 'merge'.",
					);
				}

				if (
					!requestedCategoryTyped &&
					sourceMemories.some((memory) => memory.category !== category)
				) {
					return err(
						"Error: Mixed-category merges require an explicit 'category'.",
					);
				}

				const normalizedHash = computeNormalizedHash(content);
				const duplicate = getMemoryByHash(
					deps.db,
					projectIdentity,
					category,
					normalizedHash,
				);
				const canonicalExisting =
					duplicate && ids.includes(duplicate.id) ? duplicate : null;

				// Aggregate stats from all source memories.
				const mergedSeenCount = sourceMemories.reduce(
					(sum, memory) => sum + memory.seenCount,
					0,
				);
				const mergedRetrievalCount = sourceMemories.reduce(
					(sum, memory) => sum + memory.retrievalCount,
					0,
				);
				// `mergedFrom` is JSON-stringified in the DB. Flatten any prior
				// merge chains so the lineage stays accurate when merging
				// already-merged memories. Mirrors OpenCode's parity construction
				// at packages/plugin/src/tools/ctx-memory/tools.ts:381-405.
				const mergedFromIds = Array.from(
					new Set(
						sourceMemories.flatMap((memory) => {
							let parsed: unknown[] = [];
							try {
								parsed = memory.mergedFrom ? JSON.parse(memory.mergedFrom) : [];
							} catch {
								parsed = [];
							}
							const priorIds = Array.isArray(parsed)
								? parsed.filter(
										(value): value is number => typeof value === "number",
									)
								: [];
							return [memory.id, ...priorIds];
						}),
					),
				);
				const mergedFrom = JSON.stringify(mergedFromIds);
				const mergedStatus: "active" | "permanent" = sourceMemories.some(
					(memory) => memory.status === "permanent",
				)
					? "permanent"
					: "active";

				let canonicalMemory: Memory;
				if (canonicalExisting) {
					// One of the source memories already has the merged content.
					// Update it in place to absorb stats from the others.
					canonicalMemory = canonicalExisting;
					if (
						canonicalMemory.content !== content ||
						canonicalMemory.normalizedHash !== normalizedHash
					) {
						updateMemoryContent(
							deps.db,
							canonicalMemory.id,
							content,
							normalizedHash,
						);
					}
				} else {
					// Insert a fresh canonical memory with the merged content.
					canonicalMemory = insertMemory(deps.db, {
						projectPath: projectIdentity,
						category,
						content,
						sourceSessionId: sessionId,
						sourceType: dreamerAllowed ? "dreamer" : "agent",
					});
				}

				mergeMemoryStats(
					deps.db,
					canonicalMemory.id,
					mergedSeenCount,
					mergedRetrievalCount,
					mergedFrom,
					mergedStatus,
				);

				for (const memory of sourceMemories) {
					if (memory.id === canonicalMemory.id) {
						continue;
					}
					supersededMemory(deps.db, memory.id, canonicalMemory.id);
				}

				queueEmbedding({
					deps,
					memoryId: canonicalMemory.id,
					content,
				});

				invalidateAllMemoryBlockCaches(deps.db);
				const supersededIds = sourceMemories
					.map((memory) => memory.id)
					.filter((id) => id !== canonicalMemory.id);
				return ok(
					`Merged memories [${ids.join(", ")}] into canonical memory [ID: ${canonicalMemory.id}] in ${category}; superseded [${supersededIds.join(", ")}].`,
				);
			}

			if (params.action === "archive") {
				if (typeof params.id !== "number" || !Number.isInteger(params.id)) {
					return err("Error: 'id' is required when action is 'archive'.");
				}
				const memory = getMemoryById(deps.db, params.id);
				if (!memory || memory.projectPath !== projectIdentity) {
					return err(`Error: Memory with ID ${params.id} was not found.`);
				}
				archiveMemory(deps.db, params.id, params.reason);
				invalidateAllMemoryBlockCaches(deps.db);
				const reasonSuffix = params.reason ? ` (${params.reason})` : "";
				return ok(`Archived memory [ID: ${params.id}]${reasonSuffix}.`);
			}

			return err("Error: Unknown action.");
		},
	};
}
