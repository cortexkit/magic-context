/**
 * Pi-side wrapper for the `ctx_memory` tool.
 *
 * Action surface mirrors OpenCode's `packages/plugin/src/tools/ctx-memory/tools.ts`.
 * Two tiers of actions:
 *
 *  Primary (for any agent that can call ctx_memory):
 *    - write: insert a new memory (or no-op + bump seenCount on dedup hit)
 *    - archive: soft-delete a memory (status = 'archived'), optional reason
 *    - update: rewrite a memory's content (recomputes normalized_hash + queues re-embed)
 *    - merge: combine N memories into one canonical, supersede the rest
 *
 *  Dreamer-only (gated on `allowDreamerActions: true`):
 *    - list: list active memories for the current project
 *  (memory verification + classification are no longer tool actions — the verify
 *   and classify dreamer tasks apply them host-side from a manifest.)
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
 *   - `plugin/tool-registry.ts` for the primary allowedActions (CTX_MEMORY_ACTIONS)
 *
 * Memories are project-scoped via `resolveProjectIdentity(ctx.cwd)` and stored
 * in the shared cortexkit DB, so a memory written from the pi-plugin is
 * immediately visible to OpenCode sessions on the same project (and vice
 * versa).
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	archiveMemory,
	getMemoriesByIds,
	getMemoriesByProject,
	getMemoryByHash,
	getMemoryById,
	hasMemoryClassifiedAtColumn,
	hasMemoryShareableColumn,
	insertMemory,
	insertMemoryIdempotent,
	type Memory,
	type MemoryCategory,
	mergeMemoryStats,
	recordMemoryEvidence,
	saveEmbedding,
	supersededMemory,
	updateMemoryContent,
	V2_MEMORY_CATEGORIES,
} from "@magic-context/core/features/magic-context/memory";
import {
	embedTextForProject,
	getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { invalidateMemory } from "@magic-context/core/features/magic-context/memory/embedding-cache";
import { computeNormalizedHash } from "@magic-context/core/features/magic-context/memory/normalize-hash";
import {
	normalizeStoredProjectPath,
	resolveProjectIdentityForSession,
	storedPathBelongsToIdentity,
} from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	type ContextDatabase,
	queueMemoryMutation,
} from "@magic-context/core/features/magic-context/storage";
import {
	expandWorkspaceIdentitySetWithAliases,
	resolveStoredPathWorkspaceIdentity,
	resolveWorkspaceIdentitySet,
	resolveWorkspaceShareCategories,
	storedPathBelongsToWorkspace,
} from "@magic-context/core/features/magic-context/workspaces";
import { log } from "@magic-context/core/shared/logger";
import { CTX_MEMORY_DESCRIPTION } from "@magic-context/core/tools/ctx-memory/constants";
import { runImmediateTransaction } from "@magic-context/core/tools/ctx-memory/verification-recording";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";

const DEFAULT_LIST_LIMIT = 10;

// Mirrors OpenCode CTX_MEMORY_DREAMER_ACTIONS. `delete` was removed — it was an
// exact alias of `archive` (both soft-archive); `archive` is the single
// soft-remove action. Primary agents get write/archive/update/merge/get on the
// memories they already see (with ids) in the injected project-memory block;
// `list` (bulk enumeration) stays dreamer-only. `get` is the id-shaped read
// that the user-facing <project-memory> ids imply but no other primary action
// covered — the agent is given a memory id (dashboard, guidance) and there is
// no other way to look it up. Memory verification (file mapping) and
// classification are no longer tool actions — the verify and classify dreamer
// tasks apply them host-side from a manifest.
const ALL_ACTIONS = [
	"write",
	"archive",
	"update",
	"merge",
	"get",
	"list",
] as const;
type CtxMemoryAction = (typeof ALL_ACTIONS)[number];

const DREAMER_ONLY_ACTIONS: ReadonlySet<CtxMemoryAction> = new Set(["list"]);

const GET_MAX_IDS = 20;

const ParamsSchema = Type.Object(
	{
		action: Type.Optional(
			Type.Union(
				ALL_ACTIONS.map((a) => Type.Literal(a)),
				{
					description:
						"What to do: write, update, archive, merge, get, or list",
				},
			),
		),
		content: Type.Optional(
			Type.String({
				description:
					"The memory text — one standalone fact (required for write, update, merge)",
			}),
		),
		category: Type.Optional(
			Type.Union(
				V2_MEMORY_CATEGORIES.map((c) => Type.Literal(c)),
				{
					description:
						"What kind of fact this is (required for write; optional merge override)",
				},
			),
		),
		ids: Type.Optional(
			Type.Array(Type.Number(), {
				description:
					"Target memory id(s) from <project-memory>: update takes exactly one, archive one or more, merge two or more, get one to twenty",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: "Max results for list (default: 10)",
			}),
		),
		reason: Type.Optional(
			Type.String({
				description: "Why the memory is being archived (optional, recommended)",
			}),
		),
	},
	{ additionalProperties: true },
);

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
		verification: m.verificationStatus,
		updated: new Date(m.updatedAt).toISOString(),
		content: m.content.replace(/\s+/g, " ").trim(),
	}));
	const headers = {
		id: "ID",
		category: "CATEGORY",
		status: "STATUS",
		verification: "VERIFY",
		updated: "UPDATED",
		content: "CONTENT",
	};
	const widths = {
		id: Math.max(headers.id.length, ...rows.map((r) => r.id.length)),
		category: Math.max(
			headers.category.length,
			...rows.map((r) => r.category.length),
		),
		status: Math.max(
			headers.status.length,
			...rows.map((r) => r.status.length),
		),
		verification: Math.max(
			headers.verification.length,
			...rows.map((r) => r.verification.length),
		),
		updated: Math.max(
			headers.updated.length,
			...rows.map((r) => r.updated.length),
		),
	};
	const fmt = (r: (typeof rows)[number] | typeof headers) =>
		[
			r.id.padEnd(widths.id),
			r.category.padEnd(widths.category),
			r.status.padEnd(widths.status),
			r.verification.padEnd(widths.verification),
			r.updated.padEnd(widths.updated),
			r.content,
		].join(" | ");
	return [
		`Found ${rows.length} active ${rows.length === 1 ? "memory" : "memories"}:`,
		"",
		fmt(headers),
		[
			"-".repeat(widths.id),
			"-".repeat(widths.category),
			"-".repeat(widths.status),
			"-".repeat(widths.verification),
			"-".repeat(widths.updated),
			"-------",
		].join("-+-"),
		...rows.map(fmt),
	].join("\n");
}

function isPrimaryMutableMemory(memory: Memory): boolean {
	return (
		(memory.status === "active" || memory.status === "permanent") &&
		memory.supersededByMemoryId === null
	);
}

function inactiveMemoryError(
	id: number,
	action: "updating" | "merging" | "archiving",
): string {
	return `Error: Memory with ID ${id} is archived or superseded; restore it before ${action}.`;
}

// Per-id not-found / not-visible wording. Sharing one message between the two
// states avoids an existence oracle for foreign memories — a caller that knows
// a memory is hidden by workspace share policy should not be able to
// distinguish "this id is foreign and not shared" from "this id does not
// exist" by reading the error text.
const getNotVisibleMessage = (id: number): string =>
	`id ${id}: not found or not visible from this project`;

function formatGetOutput(args: {
	requestedIds: number[];
	memoriesById: Map<number, Memory>;
}): string {
	const parts: string[] = [];
	for (const id of args.requestedIds) {
		const memory = args.memoriesById.get(id);
		if (!memory) {
			parts.push(getNotVisibleMessage(id));
		} else {
			parts.push(formatMemoryList([memory]));
		}
	}
	return parts.join("\n\n");
}

function updateMemoryContentInCurrentTransaction(
	db: ContextDatabase,
	memory: Memory,
	content: string,
	normalizedHash: string,
): void {
	db.prepare(
		"UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
	).run(content, normalizedHash, Date.now(), memory.id);
	// The classify `shareable` verdict was scored against the OLD content; new
	// content invalidates it. Fail closed → private; the dreamer re-scores later.
	if (hasMemoryShareableColumn(db)) {
		db.prepare("UPDATE memories SET shareable = 0 WHERE id = ?").run(memory.id);
	}
	// Clear the classify marker so the changed fact is re-scored next classify run.
	if (hasMemoryClassifiedAtColumn(db)) {
		db.prepare("UPDATE memories SET classified_at = NULL WHERE id = ?").run(
			memory.id,
		);
	}
	db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(
		memory.id,
	);
	invalidateMemory(memory.projectPath, memory.id);
}

function queueEmbedding(args: {
	deps: CtxMemoryToolDeps;
	projectIdentity: string;
	memoryId: number;
	content: string;
}) {
	const snapshot = getProjectEmbeddingSnapshot(args.projectIdentity);
	if (!snapshot?.enabled) return;
	void (async () => {
		try {
			const result = await embedTextForProject(
				args.projectIdentity,
				args.content,
			);
			if (!result) {
				log(
					`[magic-context-pi] embedding skipped for memory ${args.memoryId}: provider unavailable.`,
				);
				return;
			}
			saveEmbedding(args.deps.db, args.memoryId, result.vector, result.modelId);
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
	ensureProjectRegistered?: (
		directory: string,
		db: ContextDatabase,
	) => Promise<void>;
	memoryEnabled?: boolean;
	embeddingEnabled?: boolean;
	/** Resolve a directory's project identity, allowing home only when user-level configuration enables it. */
	resolveProjectIdentity?: (directory: string) => string | undefined;
	/** When true, the dreamer-only `list` action is exposed. Set by the subagent
	 *  extension entry when the parent passes `--magic-context-dreamer-actions`.
	 *  Default: false (primary set only: write/archive/update/merge). */
	allowDreamerActions?: boolean;
}

export function createCtxMemoryTool(
	deps: CtxMemoryToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	const dreamerAllowed = deps.allowDreamerActions === true;
	const resolveProject =
		deps.resolveProjectIdentity ?? resolveProjectIdentityForSession;
	const description = dreamerAllowed
		? `${CTX_MEMORY_DESCRIPTION}\n- list: enumerate stored memories (maintenance sessions).`
		: CTX_MEMORY_DESCRIPTION;

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
			params = unwrapImitatedReducedArgs(params, ["action"], {
				action: { type: "enum", values: ALL_ACTIONS },
				content: "string",
				category: { type: "enum", values: V2_MEMORY_CATEGORIES },
				ids: { type: "array", items: "number", maxItems: 100 },
				limit: "number",
				reason: "string",
			});
			if (params.action === undefined) {
				return err("Error: Action 'undefined' is not allowed in this context.");
			}
			// Gate dreamer-only actions on the allowlist flag. Mirrors
			// OpenCode's `if (toolContext.agent !== DREAMER_AGENT && !allowedActions.includes(args.action))`.
			if (!dreamerAllowed && DREAMER_ONLY_ACTIONS.has(params.action)) {
				return err(
					`Error: Action '${params.action}' is not allowed in this context.`,
				);
			}

			const projectIdentity = resolveProject(ctx.cwd);
			if (!projectIdentity) {
				return err(
					"Error: Could not resolve project identity for memory action.",
				);
			}
			await deps.ensureProjectRegistered?.(ctx.cwd, deps.db);
			const workspaceIdentitySet = resolveWorkspaceIdentitySet(
				deps.db,
				projectIdentity,
			);
			const expandedWorkspace = expandWorkspaceIdentitySetWithAliases(
				deps.db,
				workspaceIdentitySet.identities,
			);
			const workspaceVisibleIdentities =
				workspaceIdentitySet.identities.length > 1
					? expandedWorkspace.expandedIdentities
					: workspaceIdentitySet.identities;
			const targetIdentityForStoredPath = (rawProjectPath: string) =>
				workspaceIdentitySet.identities.length > 1
					? (resolveStoredPathWorkspaceIdentity(
							rawProjectPath,
							workspaceIdentitySet.identities,
							expandedWorkspace.canonicalIdentityByStoredPath,
						) ?? normalizeStoredProjectPath(rawProjectPath))
					: normalizeStoredProjectPath(rawProjectPath);
			// The workspace's share-category policy matches the render path.
			// null means there is no workspace filter; a workspaced caller gets
			// an explicit list where [] shares no foreign categories.
			const toolShareCategories =
				workspaceIdentitySet.identities.length > 1
					? resolveWorkspaceShareCategories(deps.db, projectIdentity)
					: null;
			// Visibility is the READ contract: own memories are visible in every
			// category, while foreign workspace memories are visible only in
			// categories the workspace explicitly shares. Mutations by primary
			// agents use memoryOwnedByTool below so shared visibility never
			// grants write access to another project.
			const memoryVisibleToTool = (memory: Memory): boolean => {
				if (workspaceIdentitySet.identities.length <= 1) {
					return storedPathBelongsToIdentity(
						memory.projectPath,
						projectIdentity,
					);
				}
				if (
					!storedPathBelongsToWorkspace(
						memory.projectPath,
						workspaceIdentitySet.identities,
						workspaceVisibleIdentities,
						expandedWorkspace.canonicalIdentityByStoredPath,
					)
				) {
					return false;
				}
				const isOwn =
					targetIdentityForStoredPath(memory.projectPath) === projectIdentity;
				if (isOwn) return true;
				return toolShareCategories?.includes(memory.category) ?? false;
			};
			const memoryOwnedByTool = (memory: Memory): boolean =>
				workspaceIdentitySet.identities.length > 1
					? targetIdentityForStoredPath(memory.projectPath) === projectIdentity
					: storedPathBelongsToIdentity(memory.projectPath, projectIdentity);
			const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
			if (
				snapshot
					? !snapshot.features.memoryEnabled
					: deps.memoryEnabled === false
			) {
				return err("Cross-session memory is disabled for this project.");
			}
			const sessionId = ctx.sessionManager.getSessionId();

			if (params.action === "write") {
				const content = params.content?.trim();
				if (!content)
					return err("Error: 'content' is required when action is 'write'.");

				const rawCategory = params.category;
				if (!rawCategory) {
					return err("Error: 'category' is required when action is 'write'.");
				}

				const insertResult = insertMemoryIdempotent(deps.db, {
					projectPath: projectIdentity,
					category: rawCategory,
					content,
					sourceSessionId: sessionId,
					sourceType: dreamerAllowed ? "dreamer" : "agent",
				});
				if (!insertResult.inserted) {
					return ok(
						`Memory already exists [ID: ${insertResult.memory.id}] in ${rawCategory}.`,
					);
				}
				const memory = insertResult.memory;

				queueEmbedding({ deps, projectIdentity, memoryId: memory.id, content });
				// Do NOT invalidate the m[0]/m[1] cache here. An additive write is a
				// supersede-delta operation: it surfaces in m[1] via the maxMemoryId
				// watermark (renderM1 reads memories with id > cachedM0MaxMemoryId) on
				// the next cache-busting pass, WITHOUT busting m[0]. Clearing the cache
				// re-materialized m[0] for every session (the call was global over
				// session_meta), defeating the whole additive/non-additive split and
				// busting unrelated projects. Matches OpenCode's write path, which
				// likewise does no cache invalidation.
				return ok(`Saved memory [ID: ${memory.id}] in ${rawCategory}.`);
			}

			if (params.action === "list") {
				const limit = normalizeLimit(params.limit);
				const filtered = getMemoriesByProject(deps.db, projectIdentity);
				const category = params.category;
				const filtered2 = category
					? filtered.filter((m) => m.category === category)
					: filtered;
				return ok(formatMemoryList(filtered2.slice(0, limit)));
			}

			if (params.action === "get") {
				const getIds = params.ids;
				if (!getIds || getIds.length === 0 || !getIds.every(Number.isInteger)) {
					return err(
						"Error: 'ids' must contain at least one integer memory ID when action is 'get'.",
					);
				}
				if (getIds.length > GET_MAX_IDS) {
					return err(
						`Error: 'ids' must contain at most ${GET_MAX_IDS} memory IDs when action is 'get' (got ${getIds.length}).`,
					);
				}
				// De-dupe while preserving first-seen order so the output lists
				// each requested id exactly once and never reflects a row twice.
				const uniqueIds = [...new Set(getIds)];
				const fetched = getMemoriesByIds(deps.db, uniqueIds);
				const memoriesById = new Map<number, Memory>(
					fetched
						.filter((memory) => memoryVisibleToTool(memory))
						.map((memory) => [memory.id, memory]),
				);
				return ok(
					formatGetOutput({
						requestedIds: uniqueIds,
						memoriesById,
					}),
				);
			}

			if (params.action === "update") {
				const updateIds = params.ids;
				if (updateIds?.length !== 1 || !updateIds.every(Number.isInteger)) {
					return err(
						"Error: 'ids' must contain exactly one integer memory ID when action is 'update'.",
					);
				}
				const updateId = updateIds[0];
				const content = params.content?.trim();
				if (!content) {
					return err("Error: 'content' is required when action is 'update'.");
				}

				const memory = getMemoryById(deps.db, updateId);
				const updateAllowed = memory
					? dreamerAllowed
						? memoryVisibleToTool(memory)
						: memoryOwnedByTool(memory)
					: false;
				if (!memory || !updateAllowed) {
					return err(`Error: Memory with ID ${updateId} was not found.`);
				}
				if (!dreamerAllowed && !isPrimaryMutableMemory(memory)) {
					return err(inactiveMemoryError(updateId, "updating"));
				}

				const normalizedHash = computeNormalizedHash(content);
				const targetIdentity = targetIdentityForStoredPath(memory.projectPath);
				const duplicate = getMemoryByHash(
					deps.db,
					targetIdentity,
					memory.category,
					normalizedHash,
				);
				if (duplicate && duplicate.id !== memory.id) {
					return err(
						`Error: Memory content already exists as ID ${duplicate.id}; merge or archive duplicates instead.`,
					);
				}

				runImmediateTransaction(deps.db, () => {
					updateMemoryContentInCurrentTransaction(
						deps.db,
						memory,
						content,
						normalizedHash,
					);
					queueMemoryMutation(deps.db, {
						projectPath: targetIdentity,
						mutationType: "update",
						targetMemoryId: memory.id,
						category: memory.category,
						newContent: content,
					});
					recordMemoryEvidence(deps.db, memory.id, {
						projectPath: targetIdentity,
						category: memory.category,
						content,
						sourceSessionId: sessionId,
						sourceType: dreamerAllowed ? "dreamer" : "agent",
					});
				});
				queueEmbedding({
					deps,
					projectIdentity: targetIdentity,
					memoryId: memory.id,
					content,
				});
				return ok(`Updated memory [ID: ${memory.id}] in ${memory.category}.`);
			}

			if (params.action === "merge") {
				const ids = params.ids;
				if (!ids || ids.length < 2 || !ids.every(Number.isInteger)) {
					return err(
						"Error: 'ids' must include at least two integer memory IDs when action is 'merge'.",
					);
				}
				if (new Set(ids).size !== ids.length) {
					return err(
						"Error: 'ids' must include at least two distinct memory IDs when action is 'merge'.",
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

				// Cross-identity consolidation is a DREAMER-ONLY capability: each
				// source is superseded under ITS OWN project identity with a
				// per-project supersede-delta row (see the supersede loop below),
				// so every affected project's m[1] reconciles correctly. But
				// `merge` is in the primary action set too, and a primary agent
				// must not reach into ANOTHER project's memories — mirror
				// update/archive ownership (parity with OpenCode).
				if (!dreamerAllowed) {
					const foreign = sourceMemories.find(
						(memory) => !memoryOwnedByTool(memory),
					);
					if (foreign) {
						return err(`Error: Memory with ID ${foreign.id} was not found.`);
					}
					const inactive = sourceMemories.find(
						(memory) => !isPrimaryMutableMemory(memory),
					);
					if (inactive) {
						return err(inactiveMemoryError(inactive.id, "merging"));
					}
				} else if (workspaceIdentitySet.identities.length > 1) {
					// The dreamer keeps cross-PROJECT merge power (#5971) OUTSIDE a
					// workspace, but INSIDE a workspace per-category sharing is the
					// user's explicit privacy boundary the dreamer honors too: a
					// foreign member's memory in a non-shared category is off-limits.
					// memoryVisibleToTool already encodes own→true,
					// foreign-shared→true, else→false. (Parity with OpenCode D1.)
					const blocked = sourceMemories.find(
						(memory) => !memoryVisibleToTool(memory),
					);
					if (blocked) {
						return err(
							`Error: Memory with ID ${blocked.id} is in a category not shared with this workspace member and cannot be merged.`,
						);
					}
				}

				// A fact has exactly one category. If sources span categories they
				// are NOT genuine duplicates — one is miscategorized; archive the
				// redundant one instead. Merging across categories silently destroys
				// a distinct fact, so reject it structurally (not a prompt rule).
				const sourceCategories = new Set(
					sourceMemories.map((memory) => memory.category),
				);
				if (sourceCategories.size > 1) {
					return err(
						`Error: Cannot merge memories from different categories (${[...sourceCategories].join(", ")}). If they are genuine duplicates, one is miscategorized — archive the redundant one instead of merging across categories.`,
					);
				}

				// Schema-validated literal union — no runtime re-check needed.
				const requestedCategoryTyped: MemoryCategory | undefined =
					params.category;
				const fallbackCategory = sourceMemories[0]?.category;
				const category: MemoryCategory | undefined =
					requestedCategoryTyped ?? fallbackCategory;
				if (!category) {
					return err(
						"Error: A valid category is required when action is 'merge'.",
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
				if (duplicate && !canonicalExisting) {
					return err(
						`Error: Memory content already exists as ID ${duplicate.id}; update or archive existing duplicates instead.`,
					);
				}

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
				).sort((left, right) => left - right);
				const mergedFrom = JSON.stringify(mergedFromIds);
				const mergedStatus: "active" | "permanent" = sourceMemories.some(
					(memory) => memory.status === "permanent",
				)
					? "permanent"
					: "active";

				let canonicalMemory!: Memory;
				deps.db.transaction(() => {
					let canonicalContentChanged = false;
					if (canonicalExisting) {
						// One of the source memories already has the merged content.
						// Update it in place to absorb stats from the others.
						canonicalMemory = canonicalExisting;
						canonicalContentChanged =
							canonicalMemory.content !== content ||
							canonicalMemory.normalizedHash !== normalizedHash;
						if (canonicalContentChanged) {
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
					recordMemoryEvidence(deps.db, canonicalMemory.id, {
						projectPath: projectIdentity,
						category,
						content,
						sourceSessionId: sessionId,
						sourceType: dreamerAllowed ? "dreamer" : "agent",
					});

					for (const memory of sourceMemories) {
						if (memory.id === canonicalMemory.id) {
							continue;
						}
						supersededMemory(deps.db, memory.id, canonicalMemory.id);
						queueMemoryMutation(deps.db, {
							// Normalize the stored path to the resolved identity
							// before queueing — the render-side mutation-log reader
							// matches exact project_path, and OpenCode + dashboard
							// both normalize first. A legacy raw filesystem path here
							// would write a row that normalized git:/dir: sessions
							// never read (the supersede delta would silently vanish).
							projectPath: normalizeStoredProjectPath(memory.projectPath),
							mutationType: "superseded",
							targetMemoryId: memory.id,
							supersededById: canonicalMemory.id,
						});
					}

					if (canonicalExisting && canonicalContentChanged) {
						queueMemoryMutation(deps.db, {
							projectPath: normalizeStoredProjectPath(
								canonicalMemory.projectPath,
							),
							mutationType: "update",
							targetMemoryId: canonicalMemory.id,
							category,
							newContent: content,
						});
					}
				})();

				queueEmbedding({
					deps,
					projectIdentity,
					memoryId: canonicalMemory.id,
					content,
				});
				const supersededIds = sourceMemories
					.map((memory) => memory.id)
					.filter((id) => id !== canonicalMemory.id);
				return ok(
					`Merged memories [${ids.join(", ")}] into canonical memory [ID: ${canonicalMemory.id}] in ${category}; superseded [${supersededIds.join(", ")}].`,
				);
			}

			if (params.action === "archive") {
				const rawArchiveIds = params.ids;
				if (
					!rawArchiveIds ||
					rawArchiveIds.length === 0 ||
					!rawArchiveIds.every(Number.isInteger)
				) {
					return err(
						"Error: 'ids' must contain at least one integer memory ID when action is 'archive'.",
					);
				}
				// De-dupe (first-seen order): `ids:[42,42]` archives once.
				const archiveIds = [...new Set(rawArchiveIds)];
				// Validate the whole batch BEFORE mutating so a typo'd id can't
				// half-archive a batch (all-or-nothing, matching the transaction).
				for (const memoryId of archiveIds) {
					const memory = getMemoryById(deps.db, memoryId);
					const archiveAllowed = memory
						? dreamerAllowed
							? memoryVisibleToTool(memory)
							: memoryOwnedByTool(memory)
						: false;
					if (!memory || !archiveAllowed) {
						return err(`Error: Memory with ID ${memoryId} was not found.`);
					}
					if (!dreamerAllowed && !isPrimaryMutableMemory(memory)) {
						// Match update/merge: once a primary caller archived or
						// superseded a memory, re-archiving it should stop with the same
						// friendly inactive-memory error instead of rewriting it.
						return err(inactiveMemoryError(memoryId, "archiving"));
					}
				}
				const targets = archiveIds.map((memoryId) => {
					const memory = getMemoryById(deps.db, memoryId);
					if (!memory)
						throw new Error(`validated memory ${memoryId} disappeared`);
					return {
						memoryId,
						projectIdentity: targetIdentityForStoredPath(memory.projectPath),
					};
				});
				runImmediateTransaction(deps.db, () => {
					for (const target of targets) {
						archiveMemory(deps.db, target.memoryId, params.reason);
						queueMemoryMutation(deps.db, {
							projectPath: target.projectIdentity,
							mutationType: "archive",
							targetMemoryId: target.memoryId,
						});
					}
				});
				const reasonSuffix = params.reason ? ` (${params.reason})` : "";
				const idList = archiveIds.join(", ");
				const plural = archiveIds.length > 1 ? "memories" : "memory";
				return ok(`Archived ${plural} [ID: ${idList}]${reasonSuffix}.`);
			}

			return err("Error: Unknown action.");
		},
	};
}
