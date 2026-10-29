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
 *  Dreamer-only:
 *    - ctx_memory_list: list active memories for the current project through a separate tool
 *  (memory verification + classification are no longer tool actions — the verify
 *   and classify dreamer tasks apply them host-side from a manifest.)
 *
 * Allowlist gating mirrors OpenCode's `allowedActions` deps field. In OpenCode,
 * the dreamer subagent gets the full action surface because `toolContext.agent
 * === DREAMER_AGENT`. Pi has no agent identity inside child processes, so the
 * lean subagent extension registers ctx_memory_list only when the parent passes
 * `--magic-context-dreamer-actions`. Same effective behavior, different transport.
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

import { randomUUID } from "node:crypto";
import type {
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	curateCategoryForMemoryCategory,
	getActiveCurateCategory,
	getCurateCategoryScopeRefusal,
} from "@magic-context/core/features/magic-context/dreamer/curate-category-rotation";
import {
	assessCurateMutationSafety,
	recordCurateSafetyRefusal,
} from "@magic-context/core/features/magic-context/dreamer/curate-memory-safety";
import {
	getMemoriesByIds,
	getMemoriesByProject,
	getMemoryByHash,
	getMemoryById,
	type Memory,
	type MemoryCategory,
	saveEmbedding,
	V2_MEMORY_CATEGORIES,
} from "@magic-context/core/features/magic-context/memory";
import {
	embedTextForProject,
	getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import {
	type AgentMemoryMutation,
	type ApplierReceipt,
	applyAgentMemoryMutation,
	applyCurateMemoryMutation,
	applyMemoryAdmission,
	getMemoryRevision,
	MemoryContentDuplicateError,
} from "@magic-context/core/features/magic-context/memory/lifecycle-applier";
import { computeNormalizedHash } from "@magic-context/core/features/magic-context/memory/normalize-hash";
import {
	normalizeStoredProjectPath,
	resolveProjectIdentityForSession,
	storedPathBelongsToIdentity,
} from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	expandWorkspaceIdentitySetWithAliases,
	resolveStoredPathWorkspaceIdentity,
	resolveWorkspaceIdentitySet,
	resolveWorkspaceShareCategories,
	storedPathBelongsToWorkspace,
} from "@magic-context/core/features/magic-context/workspaces";
import { log } from "@magic-context/core/shared/logger";
import {
	CTX_MEMORY_DESCRIPTION,
	CTX_MEMORY_LIST_DESCRIPTION,
} from "@magic-context/core/tools/ctx-memory/constants";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";

const DEFAULT_LIST_LIMIT = 10;

// Mirrors OpenCode's internal action vocabulary. `delete` was removed — it was
// an exact alias of `archive` (both soft-archive); `archive` is the single
// soft-remove action. ctx_memory advertises write/update/archive/merge/get on the
// memories agents already see; `list` remains internal so ctx_memory_list can
// reuse the handler without advertising bulk enumeration on ctx_memory. `get` is the id-shaped read
// that the user-facing <project-memory> ids imply but no other primary action
// covered — the agent is given a memory id (dashboard, guidance) and there is
// no other way to look it up. Memory verification (file mapping) and
// classification are no longer tool actions — the verify and classify dreamer
// tasks apply them host-side from a manifest.
const PRIMARY_ACTIONS = ["write", "update", "archive", "merge", "get"] as const;
const ALL_ACTIONS = [...PRIMARY_ACTIONS, "list"] as const;
type CtxMemoryAction = (typeof ALL_ACTIONS)[number];

const DREAMER_ONLY_ACTIONS: ReadonlySet<CtxMemoryAction> = new Set(["list"]);

const GET_MAX_IDS = 20;

const ParamsShape = {
	action: Type.Union(
		PRIMARY_ACTIONS.map((a) => Type.Literal(a)),
		{
			description: "write | update | archive | merge | get",
		},
	),
	content: Type.String({
		description:
			"The memory text — one standalone fact (write, update, merge).",
	}),
	category: Type.Union(
		V2_MEMORY_CATEGORIES.map((c) => Type.Literal(c)),
		{
			description:
				"Kind of fact (required for write; on update/merge, pass the memory's current category to keep it).",
		},
	),
	ids: Type.Array(Type.Number(), {
		description:
			"Memory ids from <project-memory>: one for update, one or more for archive, two or more for merge, 1–20 for get.",
	}),
	reason: Type.Optional(
		Type.String({
			description: "Why it is being archived (optional).",
		}),
	),
};
const ListParamsSchema = Type.Object(
	{
		category: Type.Optional(
			Type.Union(
				V2_MEMORY_CATEGORIES.map((category) => Type.Literal(category)),
				{
					description:
						"Kind of fact (required for write; on update/merge optional, omitted keeps the current category).",
				},
			),
		),
		limit: Type.Optional(
			Type.Number({ description: "Max results for list (default 10)." }),
		),
	},
	{ additionalProperties: true },
);
type CtxMemoryListParams = Static<typeof ListParamsSchema>;

const PrimaryParamsSchema = Type.Object(ParamsShape, {
	additionalProperties: true,
});
// The primary schema omits `limit`: it only sizes the list action, which primary
// agents cannot run (ctx_memory_list advertises it). `additionalProperties: true`
// keeps older calls that still carry `limit` valid. The dreamer schema keeps it.
const DreamerParamsSchema = Type.Object(
	{
		...ParamsShape,
		limit: Type.Optional(
			Type.Number({
				description: "Max results for list (default 10).",
			}),
		),
		superseded_by: Type.Optional(
			Type.Number({
				description:
					"Active same-project/category memory that survives a curate consolidation",
			}),
		),
	},
	{ additionalProperties: true },
);

type CtxMemoryParams = Static<typeof DreamerParamsSchema>;

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
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit === 0)
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
	// `get` returns rows of any status; claim "active" only when every row is.
	const allActive = memories.every((memory) => memory.status === "active");
	return [
		`Found ${rows.length} ${allActive ? "active " : ""}${rows.length === 1 ? "memory" : "memories"}:`,
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
	resolveProjectIdentity?: (
		directory: string,
		ctx: ExtensionContext,
	) => string | undefined;
	/** When true, Curate-only execution fields and guards are enabled. The separate
	 *  ctx_memory_list registration uses this mode to reuse the list handler. */
	allowDreamerActions?: boolean;
}

export function createCtxMemoryTool(
	deps: CtxMemoryToolDeps,
): ToolDefinition<typeof PrimaryParamsSchema | typeof DreamerParamsSchema> {
	const dreamerAllowed = deps.allowDreamerActions === true;
	/**
	 * A primary agent's update, merge or archive applies immediately through the
	 * shared applier: revision-checked, with undo history and the fragment that
	 * shows the change in this session's next busting m[1]. Returns the error
	 * text to report when the change was refused.
	 */
	const applyPrimaryAgentMutation = (
		mutation: AgentMemoryMutation,
	): ApplierReceipt | string => {
		let receipt: ApplierReceipt;
		try {
			receipt = applyAgentMemoryMutation(deps.db, mutation);
		} catch (error) {
			if (error instanceof MemoryContentDuplicateError)
				return `Error: ${error.message}`;
			throw error;
		}
		return receipt.state === "applied"
			? receipt
			: `Error: ${receipt.reason}; memory is unchanged.`;
	};
	const resolveProject = (directory: string, ctx: ExtensionContext) =>
		deps.resolveProjectIdentity
			? deps.resolveProjectIdentity(directory, ctx)
			: resolveProjectIdentityForSession(directory);
	return {
		name: "ctx_memory",
		label: "Magic Context: Memory",
		description: CTX_MEMORY_DESCRIPTION,
		parameters: dreamerAllowed ? DreamerParamsSchema : PrimaryParamsSchema,
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
				superseded_by: "number",
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

			const projectIdentity = resolveProject(ctx.cwd, ctx);
			if (!projectIdentity) {
				return err(
					"Error: Could not resolve project identity for memory action.",
				);
			}
			await deps.ensureProjectRegistered?.(ctx.cwd, deps.db);
			const activeCurateCategory = dreamerAllowed
				? getActiveCurateCategory(deps.db, projectIdentity)
				: null;
			if (activeCurateCategory) {
				const usesCategory = ["write", "update", "merge", "list"].includes(
					params.action,
				);
				const usesIds = ["update", "archive", "merge", "get"].includes(
					params.action,
				);
				const usesSuccessor =
					params.action === "update" || params.action === "archive";
				const scopeRefusal = getCurateCategoryScopeRefusal({
					scope: activeCurateCategory,
					action: params.action,
					requestedCategory: usesCategory ? params.category : undefined,
					ids: usesIds
						? [
								...(params.ids ?? []),
								...(usesSuccessor && Number.isInteger(params.superseded_by)
									? [params.superseded_by as number]
									: []),
							]
						: [],
					categoryForId: (id) => {
						const category = getMemoryById(deps.db, id)?.category;
						return category ? curateCategoryForMemoryCategory(category) : null;
					},
				});
				if (scopeRefusal) return err(scopeRefusal);
			}
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
				return err(
					snapshot?.memoryDisabledReason ??
						"Cross-session memory is disabled for this project.",
				);
			}
			const sessionId = ctx.sessionManager.getSessionId();
			let curateSuccessor: Memory | null = null;
			if (
				dreamerAllowed &&
				(params.action === "archive" || params.action === "update")
			) {
				const verdict = params.action;
				const ids = params.ids;
				const content = params.content?.trim();
				const validShape =
					ids &&
					ids.length > 0 &&
					ids.every(Number.isInteger) &&
					(verdict !== "update" || (ids.length === 1 && Boolean(content)));
				if (validShape) {
					const uniqueIds = [...new Set(ids)];
					const memories = uniqueIds.map((id) => getMemoryById(deps.db, id));
					if (
						memories.every((memory) => memory && memoryVisibleToTool(memory))
					) {
						curateSuccessor = Number.isInteger(params.superseded_by)
							? getMemoryById(deps.db, params.superseded_by as number)
							: null;
						const refusals = memories.flatMap((memory) => {
							if (!memory) return [];
							const refusal = assessCurateMutationSafety({
								memory,
								verdict,
								reason: params.reason,
								replacementContent: content,
								successor: curateSuccessor,
								projectIdentity: (candidate) =>
									targetIdentityForStoredPath(candidate.projectPath),
							});
							return refusal ? [refusal] : [];
						});
						if (refusals.length > 0) {
							let refused = 0;
							for (const refusal of refusals) {
								refused = recordCurateSafetyRefusal(sessionId, refusal);
							}
							const memoryIds = refusals
								.map((refusal) => refusal.memoryId)
								.join(", ");
							const reasons = [
								...new Set(refusals.map((refusal) => refusal.reason)),
							].join(",");
							return ok(
								`Skipped ${verdict} for memory [ID: ${memoryIds}]: curate safety refusal (${reasons}); refused=${refused}.`,
							);
						}
					}
				}
			}

			if (params.action === "write") {
				const content = params.content?.trim();
				if (!content)
					return err("Error: 'content' is required when action is 'write'.");

				const rawCategory = params.category;
				if (!rawCategory) {
					return err("Error: 'category' is required when action is 'write'.");
				}

				// Every save goes through the shared applier. A primary agent's save also
				// records the fragment that shows it in this session's next busting m[1]; a
				// dreamer save is an automated insert that writes no fragment and waits for
				// the next HARD fold.
				const receipt = applyMemoryAdmission(deps.db, {
					key: randomUUID(),
					operation: "agent_save",
					input: {
						projectPath: projectIdentity,
						category: rawCategory,
						content,
						sourceSessionId: sessionId,
						sourceType: dreamerAllowed ? "dreamer" : "agent",
					},
				});
				if (receipt.state !== "applied")
					return err(`${receipt.reason}: memory was not saved.`);
				if (!receipt.inserted)
					return ok(
						`Memory already exists [ID: ${receipt.memoryId}] in ${rawCategory} (seen count incremented).`,
					);
				queueEmbedding({
					deps,
					projectIdentity,
					memoryId: receipt.memoryId!,
					content,
				});
				return ok(`Saved memory [ID: ${receipt.memoryId}] in ${rawCategory}.`);
			}

			if (params.action === "list") {
				const limit = normalizeLimit(params.limit);
				const filtered = getMemoriesByProject(deps.db, projectIdentity);
				const category = params.category;
				const filtered2 = activeCurateCategory
					? filtered.filter(
							(memory) =>
								curateCategoryForMemoryCategory(memory.category) ===
								activeCurateCategory,
						)
					: category
						? filtered.filter((memory) => memory.category === category)
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
				const targetCategory = params.category ?? memory.category;
				const targetIdentity = targetIdentityForStoredPath(memory.projectPath);
				const duplicate = getMemoryByHash(
					deps.db,
					targetIdentity,
					targetCategory,
					normalizedHash,
				);
				if (duplicate && duplicate.id !== memory.id) {
					return err(
						`Error: Memory content already exists as ID ${duplicate.id}; merge or archive duplicates instead.`,
					);
				}

				if (!dreamerAllowed) {
					const receipt = applyPrimaryAgentMutation({
						key: randomUUID(),
						projectPath: targetIdentity,
						operation: "update",
						sourceSessionId: sessionId,
						targets: [
							{
								id: memory.id,
								revision: getMemoryRevision(deps.db, memory.id)!,
							},
						],
						content,
						category: targetCategory,
					});
					if (typeof receipt === "string") return err(receipt);
					queueEmbedding({
						deps,
						projectIdentity: targetIdentity,
						memoryId: memory.id,
						content,
					});
					return ok(`Updated memory [ID: ${memory.id}] in ${targetCategory}.`);
				}
				const receipt = applyCurateMemoryMutation(deps.db, {
					key: randomUUID(),
					projectPath: targetIdentity,
					sourceSessionId: sessionId,
					operation: "update",
					targets: [
						{ id: memory.id, revision: getMemoryRevision(deps.db, memory.id)! },
					],
					content,
					category: targetCategory,
				});
				if (receipt.state !== "applied")
					return err(`Error: ${receipt.reason}; memory is unchanged.`);
				queueEmbedding({
					deps,
					projectIdentity: targetIdentity,
					memoryId: memory.id,
					content,
				});
				return ok(`Updated memory [ID: ${memory.id}] in ${targetCategory}.`);
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

				if (!dreamerAllowed) {
					const receipt = applyPrimaryAgentMutation({
						key: randomUUID(),
						projectPath: projectIdentity,
						operation: "merge",
						sourceSessionId: sessionId,
						targets: sourceMemories.map((memory) => ({
							id: memory.id,
							revision: getMemoryRevision(deps.db, memory.id)!,
						})),
						content,
						category,
					});
					if (typeof receipt === "string") return err(receipt);
					queueEmbedding({
						deps,
						projectIdentity,
						memoryId: receipt.memoryId!,
						content,
					});
					return ok(
						`Merged memories [${ids.join(", ")}] into canonical memory [ID: ${receipt.memoryId}] in ${category}; superseded [${(receipt.supersededIds ?? []).join(", ")}].`,
					);
				}
				const receipt = applyCurateMemoryMutation(deps.db, {
					key: randomUUID(),
					projectPath: projectIdentity,
					sourceSessionId: sessionId,
					operation: "merge",
					targets: sourceMemories.map((memory) => ({
						id: memory.id,
						revision: getMemoryRevision(deps.db, memory.id)!,
					})),
					content,
					category,
				});
				if (receipt.state !== "applied")
					return err(`Error: ${receipt.reason}; memories are unchanged.`);
				queueEmbedding({
					deps,
					projectIdentity,
					memoryId: receipt.memoryId!,
					content,
				});
				return ok(
					`Merged memories [${ids.join(", ")}] into canonical memory [ID: ${receipt.memoryId}] in ${category}; superseded [${(receipt.supersededIds ?? []).join(", ")}].`,
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
				const reasonSuffix = params.reason ? ` (${params.reason})` : "";
				const idList = archiveIds.join(", ");
				const plural = archiveIds.length > 1 ? "memories" : "memory";
				if (!dreamerAllowed) {
					const receipt = applyPrimaryAgentMutation({
						key: randomUUID(),
						projectPath: projectIdentity,
						operation: "archive",
						sourceSessionId: sessionId,
						targets: archiveIds.map((id) => ({
							id,
							revision: getMemoryRevision(deps.db, id)!,
						})),
						reason: params.reason,
					});
					if (typeof receipt === "string") return err(receipt);
					return ok(`Archived ${plural} [ID: ${idList}]${reasonSuffix}.`);
				}
				const receipt = applyCurateMemoryMutation(deps.db, {
					key: randomUUID(),
					projectPath: projectIdentity,
					sourceSessionId: sessionId,
					operation: "archive",
					targets: archiveIds.map((id) => ({
						id,
						revision: getMemoryRevision(deps.db, id)!,
					})),
					reason: params.reason,
					supersededById: curateSuccessor?.id,
				});
				if (receipt.state !== "applied")
					return err(`Error: ${receipt.reason}; memories are unchanged.`);
				return ok(`Archived ${plural} [ID: ${idList}]${reasonSuffix}.`);
			}

			return err("Error: Unknown action.");
		},
	};
}

export function createCtxMemoryListTool(
	deps: CtxMemoryToolDeps,
): ToolDefinition<typeof ListParamsSchema> {
	const memoryTool = createCtxMemoryTool({
		...deps,
		allowDreamerActions: true,
	});
	return {
		name: "ctx_memory_list",
		label: "Magic Context: Memory List",
		description: CTX_MEMORY_LIST_DESCRIPTION,
		parameters: ListParamsSchema,
		async execute(
			toolCallId,
			params: CtxMemoryListParams,
			signal,
			onUpdate,
			ctx,
		) {
			return memoryTool.execute(
				toolCallId,
				{ ...params, action: "list" } as never,
				signal,
				onUpdate,
				ctx,
			);
		},
	};
}
