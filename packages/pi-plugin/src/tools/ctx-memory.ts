/**
 * Pi-side wrapper for the `ctx_memory` tool.
 *
 * Spike scope (Step 4a): write + delete + list. Dreamer-only actions
 * (update, merge, archive) live in the OpenCode plugin's tool until the
 * pi-plugin's own dreamer integration lands.
 *
 * Memories are project-scoped via `resolveProjectIdentity(ctx.cwd)` and stored
 * in the shared cortexkit DB, so a memory written from the pi-plugin is
 * immediately visible to OpenCode sessions on the same project (and vice
 * versa). This is the cross-harness data sharing capability we set up in
 * Step 1.
 */

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
	saveEmbedding,
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
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "typebox";

const DEFAULT_LIST_LIMIT = 10;
const VALID_CATEGORIES = new Set<string>(CATEGORY_PRIORITY);

function isMemoryCategory(value: string): value is MemoryCategory {
	return VALID_CATEGORIES.has(value);
}

const ParamsSchema = Type.Object({
	action: Type.Union(
		[Type.Literal("write"), Type.Literal("delete"), Type.Literal("list")],
		{ description: "Action to perform on memories" },
	),
	content: Type.Optional(
		Type.String({ description: "Memory content (required for write)" }),
	),
	category: Type.Optional(
		Type.String({
			description:
				"Memory category (required for write, optional filter for list). One of: " +
				CATEGORY_PRIORITY.join(", "),
		}),
	),
	id: Type.Optional(
		Type.Number({ description: "Memory ID (required for delete)" }),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum results to return for list (default: 10)",
		}),
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
}

export function createCtxMemoryTool(
	deps: CtxMemoryToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	return {
		name: "ctx_memory",
		label: "Magic Context: Memory",
		description:
			"Manage cross-session project memories. Memories persist across sessions and are " +
			"shared with OpenCode sessions on the same project. " +
			"Supported actions: write, delete, list.",
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
					sourceType: "agent",
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

			return err("Error: Unknown action.");
		},
	};
}
