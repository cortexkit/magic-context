import { randomUUID } from "node:crypto";
import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { DREAMER_AGENT } from "../../agents/dreamer";
import {
    curateCategoryForMemoryCategory,
    getActiveCurateCategory,
    getCurateCategoryScopeRefusal,
} from "../../features/magic-context/dreamer/curate-category-rotation";
import {
    assessCurateMutationSafety,
    recordCurateSafetyRefusal,
} from "../../features/magic-context/dreamer/curate-memory-safety";
import {
    CATEGORY_PRIORITY,
    getMemoriesByIds,
    getMemoryByHash,
    getMemoryById,
    type Memory,
    type MemoryCategory,
    saveEmbeddingIfHashMatches,
    V2_MEMORY_CATEGORIES,
} from "../../features/magic-context/memory";
import {
    embedTextForProject,
    enqueueShadowEmbeddingItems,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/memory/embedding";
import {
    type ApplierReceipt,
    applyAgentMemoryMutation,
    applyMemoryAdmission,
    getMemoryRevision,
    MemoryContentDuplicateError,
    proposeMemoryMutation,
} from "../../features/magic-context/memory/lifecycle-applier";
import { createMemoryVisibilityPolicy } from "../../features/magic-context/memory/memory-visibility";
import { computeNormalizedHash } from "../../features/magic-context/memory/normalize-hash";
import { describeUnresolvedProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { getMemoriesForList } from "../../features/magic-context/memory/storage-memory";
import { normalizeStoredProjectPath } from "../../features/magic-context/storage";
import {
    projectNeedsSingleStoreMigration,
    renderSingleStoreMigrationRequiredRefusal,
} from "../../hooks/magic-context/single-store-refusal";
import { sessionLog } from "../../shared/logger";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import {
    CTX_MEMORY_DESCRIPTION,
    CTX_MEMORY_LIST_DESCRIPTION,
    CTX_MEMORY_LIST_TOOL_NAME,
    CTX_MEMORY_TOOL_NAME,
    DEFAULT_SEARCH_LIMIT,
} from "./constants";
import {
    CTX_MEMORY_ACTIONS,
    CTX_MEMORY_DREAMER_ACTIONS,
    type CtxMemoryAction,
    type CtxMemoryArgs,
    type CtxMemoryToolDeps,
} from "./types";

export { CTX_MEMORY_LIGHT_DESCRIPTION } from "../light-descriptions";

const MEMORY_CATEGORIES = new Set<string>(CATEGORY_PRIORITY);

function isMemoryCategory(value: string): value is MemoryCategory {
    return MEMORY_CATEGORIES.has(value);
}

function normalizeLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit === 0) {
        return DEFAULT_SEARCH_LIMIT;
    }

    return Math.max(1, Math.floor(limit));
}

// When a caller omits `allowedActions`, fall back
// to the least-privileged set instead of the dreamer's full action list. The
// only production caller (`tool-registry.ts`) passes the primary set
// (`CTX_MEMORY_ACTIONS`) explicitly, and dreamer child sessions are gated by the
// runtime `toolContext.agent === DREAMER_AGENT` check below — they bypass
// `allowedActions` entirely. A future caller that forgets the field would
// previously have inadvertently let primary agents run the dreamer-only `list`;
// fail-closed default prevents that class of regression.
function getAllowedActions(deps: CtxMemoryToolDeps): [CtxMemoryAction, ...CtxMemoryAction[]] {
    const allowed = deps.allowedActions?.length ? deps.allowedActions : CTX_MEMORY_ACTIONS;
    return [...allowed] as [CtxMemoryAction, ...CtxMemoryAction[]];
}

function normalizeCategory(category?: string): string | undefined {
    const trimmed = category?.trim();
    return trimmed ? trimmed : undefined;
}

function formatMemoryList(memories: Memory[]): string {
    if (memories.length === 0) {
        return "No active memories found.";
    }

    const rows = memories.map((memory) => ({
        id: String(memory.id),
        category: memory.category,
        status: memory.status,
        verification: memory.verificationStatus,
        updated: new Date(memory.updatedAt).toISOString(),
        content: memory.content.replace(/\s+/g, " ").trim(),
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
        id: Math.max(headers.id.length, ...rows.map((row) => row.id.length)),
        category: Math.max(headers.category.length, ...rows.map((row) => row.category.length)),
        status: Math.max(headers.status.length, ...rows.map((row) => row.status.length)),
        verification: Math.max(
            headers.verification.length,
            ...rows.map((row) => row.verification.length),
        ),
        updated: Math.max(headers.updated.length, ...rows.map((row) => row.updated.length)),
    };
    const formatRow = (row: (typeof rows)[number] | typeof headers) =>
        [
            row.id.padEnd(widths.id),
            row.category.padEnd(widths.category),
            row.status.padEnd(widths.status),
            row.verification.padEnd(widths.verification),
            row.updated.padEnd(widths.updated),
            row.content,
        ].join(" | ");

    // `get` returns rows of any status, so the header only claims "active" when it is true
    // of every row; the STATUS column carries the rest.
    const allActive = memories.every((memory) => memory.status === "active");
    return [
        `Found ${rows.length} ${allActive ? "active " : ""}${rows.length === 1 ? "memory" : "memories"}:`,
        "",
        formatRow(headers),
        [
            "-".repeat(widths.id),
            "-".repeat(widths.category),
            "-".repeat(widths.status),
            "-".repeat(widths.verification),
            "-".repeat(widths.updated),
            "-------",
        ].join("-+-"),
        ...rows.map(formatRow),
    ].join("\n");
}

// Per-id not-found / not-visible wording. Sharing one message between the two
// states avoids an existence oracle for foreign memories — a caller that knows
// a memory is hidden by workspace share policy should not be able to
// distinguish "this id is foreign and not shared" from "this id does not
// exist" by reading the error text.
const GET_NOT_VISIBLE_MESSAGE = (id: number): string =>
    `id ${id}: not found or not visible from this project`;

const GET_MAX_IDS = 20;

function formatGetOutput(args: {
    requestedIds: number[];
    memoriesById: Map<number, Memory>;
}): string {
    const parts: string[] = [];
    for (const id of args.requestedIds) {
        const memory = args.memoriesById.get(id);
        if (!memory) {
            parts.push(GET_NOT_VISIBLE_MESSAGE(id));
        } else {
            parts.push(formatMemoryList([memory]));
        }
    }
    return parts.join("\n\n");
}

function queueMemoryEmbedding(args: {
    deps: CtxMemoryToolDeps;
    sessionId: string;
    projectPath: string;
    memoryId: number;
    content: string;
}): void {
    const snapshot = getProjectEmbeddingSnapshot(args.projectPath);
    if (!snapshot?.enabled) {
        return;
    }

    const normalizedHash = computeNormalizedHash(args.content);
    void (async () => {
        const result = await embedTextForProject(args.projectPath, args.content);
        if (!result) {
            sessionLog(
                args.sessionId,
                `memory embedding skipped for memory ${args.memoryId}: provider unavailable or embedding generation failed.`,
            );
            return;
        }

        const saved = saveEmbeddingIfHashMatches(
            args.deps.db,
            args.memoryId,
            result.vector,
            result.modelId,
            normalizedHash,
        );
        if (!saved) {
            sessionLog(
                args.sessionId,
                `memory embedding skipped for memory ${args.memoryId}: content changed before the embedding finished.`,
            );
            return;
        }

        enqueueShadowEmbeddingItems(args.projectPath, "memory", [String(args.memoryId)]);
        sessionLog(args.sessionId, `proactively embedded memory ${args.memoryId}.`);
    })().catch((error: unknown) => {
        sessionLog(args.sessionId, `memory embedding failed for memory ${args.memoryId}:`, error);
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

function requestRustMemorySync(deps: CtxMemoryToolDeps, sessionId: string): void {
    try {
        deps.rustToolBackends?.memorySync?.(sessionId);
    } catch (error) {
        sessionLog(sessionId, "rust memory sync trigger failed (ignored):", error);
    }
}

interface MemoryProjectPathRow {
    project_path: string;
}

function projectPathForMemoryId(db: CtxMemoryToolDeps["db"], id: number): string | null {
    const row = db.prepare("SELECT project_path FROM memories WHERE id = ?").get(id) as
        | MemoryProjectPathRow
        | undefined;
    return row?.project_path ?? null;
}

function projectIdentityForStoredPath(rawProjectPath: string): string {
    return normalizeStoredProjectPath(rawProjectPath);
}

function preflightCurateMutation(args: {
    db: CtxMemoryToolDeps["db"];
    params: CtxMemoryArgs;
    sessionId: string;
}): { skip: string | null; successor: Memory | null } {
    const { params } = args;
    if (params.action !== "archive" && params.action !== "update") {
        return { skip: null, successor: null };
    }

    const ids = params.ids;
    const content = params.content?.trim();
    if (
        !ids ||
        ids.length === 0 ||
        !ids.every(Number.isInteger) ||
        (params.action === "update" && (ids.length !== 1 || !content))
    ) {
        return { skip: null, successor: null };
    }

    const uniqueIds = [...new Set(ids)];
    const memories = uniqueIds.map((id) => getMemoryById(args.db, id));
    if (memories.some((memory) => !memory)) {
        return { skip: null, successor: null };
    }

    const successor = Number.isInteger(params.superseded_by)
        ? getMemoryById(args.db, params.superseded_by as number)
        : null;
    const refusals = memories.flatMap((memory) => {
        if (!memory) return [];
        const refusal = assessCurateMutationSafety({
            memory,
            verdict: params.action as "archive" | "update",
            reason: params.reason,
            replacementContent: content,
            successor,
            projectIdentity: (candidate) => projectIdentityForStoredPath(candidate.projectPath),
        });
        return refusal ? [refusal] : [];
    });
    if (refusals.length === 0) return { skip: null, successor };

    let refused = 0;
    for (const refusal of refusals) {
        refused = recordCurateSafetyRefusal(args.sessionId, refusal);
    }
    const memoryIds = refusals.map((refusal) => refusal.memoryId).join(", ");
    const reasons = [...new Set(refusals.map((refusal) => refusal.reason))].join(",");
    return {
        skip: `Skipped ${params.action} for memory [ID: ${memoryIds}]: curate safety refusal (${reasons}); refused=${refused}.`,
        successor,
    };
}

function isPrimaryMutableMemory(memory: Memory): boolean {
    return (
        (memory.status === "active" || memory.status === "permanent") &&
        memory.supersededByMemoryId === null
    );
}

function inactiveMemoryError(id: number, action: "updating" | "merging" | "archiving"): string {
    return `Error: Memory with ID ${id} is archived or superseded; restore it before ${action}.`;
}

function isMemoryUniqueConstraint(error: unknown): boolean {
    return (
        error instanceof Error &&
        error.message.includes(
            "UNIQUE constraint failed: memories.project_path, memories.category, memories.normalized_hash",
        )
    );
}

const ctxMemoryArgsShape = {
    // Advertise only primary actions. The separate ctx_memory_list tool reuses this
    // handler with the internal list action, while passthrough parsing keeps older
    // callers compatible without publishing that action here.
    action: tool.schema
        .enum([...CTX_MEMORY_ACTIONS])
        .optional()
        .describe("write | update | archive | merge | get"),
    content: tool.schema
        .string()
        .optional()
        .describe("The memory text — one standalone fact (write, update, merge)."),
    category: tool.schema
        .enum([...V2_MEMORY_CATEGORIES])
        .optional()
        .describe(
            "Kind of fact (required for write; on update/merge optional, omitted keeps the current category).",
        ),
    ids: tool.schema
        .array(tool.schema.number())
        .optional()
        .describe(
            "Memory ids from <project-memory>: one for update, one or more for archive, two or more for merge, 1–20 for get.",
        ),
    reason: tool.schema.string().optional().describe("Why it is being archived (optional)."),
};
const ctxMemoryListArgsShape = {
    category: tool.schema
        .enum([...V2_MEMORY_CATEGORIES])
        .optional()
        .describe(
            "Kind of fact (required for write; on update/merge optional, omitted keeps the current category).",
        ),
    limit: tool.schema.number().optional().describe("Max results for list (default 10)."),
};

const ctxMemoryArgsSchema = tool.schema
    .object({
        ...ctxMemoryArgsShape,
        // The scheduled Curate integration is the only caller that uses this
        // field. Exclude it from the standard provider schema, but validate its
        // type when Curate sends it.
        superseded_by: tool.schema.number().optional(),
        // `limit` only sizes the internal list action, which primary agents cannot
        // run; ctx_memory_list advertises it. It stays validated here so the list
        // tool's forwarded value and older calls that still carry it keep parsing.
        limit: tool.schema.number().optional(),
    })
    .passthrough();

function createCtxMemoryTool(deps: CtxMemoryToolDeps): ToolDefinition {
    const allowedActions = getAllowedActions(deps);

    return tool({
        description: CTX_MEMORY_DESCRIPTION,
        args: ctxMemoryArgsShape,
        async execute(rawArgs: CtxMemoryArgs, toolContext) {
            const parsedArgs = ctxMemoryArgsSchema.safeParse(rawArgs);
            let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxMemoryArgs;
            args = unwrapImitatedReducedArgs(args, ["action"], {
                action: { type: "enum", values: CTX_MEMORY_DREAMER_ACTIONS },
                content: "string",
                category: { type: "enum", values: V2_MEMORY_CATEGORIES },
                ids: { type: "array", items: "number", maxItems: 100 },
                limit: "number",
                reason: "string",
                superseded_by: "number",
            });
            if (
                args.action === undefined ||
                (toolContext.agent !== DREAMER_AGENT && !allowedActions.includes(args.action))
            ) {
                return `Error: Action '${args.action}' is not allowed in this context.`;
            }

            // Resolve the session's actual project from `toolContext.directory`
            // each call. OpenCode's top-level `ctx.directory` (the launch dir)
            // can differ from the session's working directory when the user
            // runs `opencode -s <id>` from outside the project.
            const projectPath = deps.resolveProjectPath(toolContext.directory);
            if (!projectPath) {
                return `Error: Could not resolve project identity for memory action: ${describeUnresolvedProjectIdentity(toolContext.directory)}`;
            }
            await deps.ensureProjectRegistered?.(toolContext.directory, deps.db);
            const activeCurateCategory =
                toolContext.agent === DREAMER_AGENT
                    ? getActiveCurateCategory(deps.db, projectPath)
                    : null;
            if (activeCurateCategory) {
                const usesCategory = ["write", "update", "merge", "list"].includes(args.action);
                const usesIds = ["update", "archive", "merge", "get"].includes(args.action);
                const usesSuccessor = args.action === "update" || args.action === "archive";
                const scopeRefusal = getCurateCategoryScopeRefusal({
                    scope: activeCurateCategory,
                    action: args.action,
                    requestedCategory: usesCategory ? args.category : undefined,
                    ids: usesIds
                        ? [
                              ...(args.ids ?? []),
                              ...(usesSuccessor && Number.isInteger(args.superseded_by)
                                  ? [args.superseded_by as number]
                                  : []),
                          ]
                        : [],
                    categoryForId: (id) => {
                        const category = getMemoryById(deps.db, id)?.category;
                        return category ? curateCategoryForMemoryCategory(category) : null;
                    },
                });
                if (scopeRefusal) return scopeRefusal;
            }
            const curatePreflight =
                toolContext.agent === DREAMER_AGENT
                    ? preflightCurateMutation({
                          db: deps.db,
                          params: args,
                          sessionId: toolContext.sessionID,
                      })
                    : { skip: null, successor: null };
            if (curatePreflight.skip) return curatePreflight.skip;

            const visibility = createMemoryVisibilityPolicy(deps.db, projectPath);

            if (projectNeedsSingleStoreMigration(deps.db, projectPath)) {
                return renderSingleStoreMigrationRequiredRefusal();
            }
            // Visibility is the READ contract: own memories are visible in every
            // category, while foreign workspace memories are visible only in
            // categories the workspace explicitly shares. Mutations by primary
            // agents use memoryOwnedByTool so shared visibility never grants
            // write access to another project. Both predicates come from the
            // shared policy the Rust-mode facade uses, so the two surfaces
            // cannot drift apart on who may read or edit what.
            const targetIdentityForStoredPath = (rawProjectPath: string): string =>
                visibility.identityFor(rawProjectPath);
            const memoryVisibleToTool = (memory: Memory): boolean => visibility.visible(memory);
            const memoryOwnedByTool = (memory: Memory): boolean => visibility.owned(memory);
            const embeddingSnapshot = getProjectEmbeddingSnapshot(projectPath);
            if (
                embeddingSnapshot
                    ? !embeddingSnapshot.features.memoryEnabled
                    : deps.memoryEnabled === false
            ) {
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

                const receipt = applyMemoryAdmission(deps.db, {
                    key: randomUUID(),
                    operation: "agent_save",
                    input: {
                        projectPath,
                        category,
                        content,
                        sourceSessionId: toolContext.sessionID,
                    },
                });
                if (receipt.state !== "applied") return `${receipt.reason}: memory was not saved.`;
                if (!receipt.inserted)
                    return `Memory already exists [ID: ${receipt.memoryId}] in ${category} (seen count incremented).`;
                queueMemoryEmbedding({
                    deps,
                    sessionId: toolContext.sessionID,
                    projectPath,
                    memoryId: receipt.memoryId!,
                    content,
                });
                requestRustMemorySync(deps, toolContext.sessionID);
                return `Saved memory [ID: ${receipt.memoryId}] in ${category}.`;
            }

            if (args.action === "list") {
                const limit = normalizeLimit(args.limit);
                const category = normalizeCategory(args.category);
                const categories = activeCurateCategory
                    ? CATEGORY_PRIORITY.filter(
                          (value) =>
                              curateCategoryForMemoryCategory(value) === activeCurateCategory,
                      )
                    : category
                      ? [category]
                      : null;
                const memories = getMemoriesForList(deps.db, projectPath, categories, limit);

                return formatMemoryList(memories);
            }

            if (args.action === "get") {
                const getIds = args.ids;
                if (!getIds || getIds.length === 0 || !getIds.every(Number.isInteger)) {
                    return "Error: 'ids' must contain at least one integer memory ID when action is 'get'.";
                }
                if (getIds.length > GET_MAX_IDS) {
                    return `Error: 'ids' must contain at most ${GET_MAX_IDS} memory IDs when action is 'get' (got ${getIds.length}).`;
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
                return formatGetOutput({
                    requestedIds: uniqueIds,
                    memoriesById,
                });
            }

            if (args.action === "update") {
                const updateIds = args.ids;
                if (updateIds?.length !== 1 || !updateIds.every(Number.isInteger)) {
                    return "Error: 'ids' must contain exactly one integer memory ID when action is 'update'.";
                }
                const updateId = updateIds[0];

                const content = args.content?.trim();
                if (!content) {
                    return "Error: 'content' is required when action is 'update'.";
                }

                const rawProjectPath = projectPathForMemoryId(deps.db, updateId);
                const memory = getMemoryById(deps.db, updateId);
                const updateAllowed = memory
                    ? toolContext.agent === DREAMER_AGENT
                        ? memoryVisibleToTool(memory)
                        : memoryOwnedByTool(memory)
                    : false;
                if (!memory || !rawProjectPath || !updateAllowed) {
                    return `Error: Memory with ID ${updateId} was not found.`;
                }
                if (toolContext.agent !== DREAMER_AGENT && !isPrimaryMutableMemory(memory)) {
                    return inactiveMemoryError(updateId, "updating");
                }

                if (toolContext.agent !== DREAMER_AGENT) {
                    const category =
                        args.category &&
                        (V2_MEMORY_CATEGORIES as readonly string[]).includes(args.category)
                            ? (args.category as MemoryCategory)
                            : memory.category;
                    let receipt: ApplierReceipt;
                    try {
                        receipt = applyAgentMemoryMutation(deps.db, {
                            key: randomUUID(),
                            projectPath,
                            operation: "update",
                            sourceSessionId: toolContext.sessionID,
                            targets: [
                                { id: memory.id, revision: getMemoryRevision(deps.db, memory.id)! },
                            ],
                            content,
                            category,
                            reason: args.reason,
                        });
                    } catch (error) {
                        if (error instanceof MemoryContentDuplicateError)
                            return `Error: ${error.message}`;
                        if (isMemoryUniqueConstraint(error)) {
                            const duplicate = getMemoryByHash(
                                deps.db,
                                rawProjectPath,
                                category,
                                computeNormalizedHash(content),
                            );
                            if (duplicate && duplicate.id !== memory.id)
                                return `Error: Memory content already exists as ID ${duplicate.id}; merge or archive duplicates instead.`;
                        }
                        throw error;
                    }
                    if (receipt.state !== "applied")
                        return `Error: ${receipt.reason}; memory [ID: ${memory.id}] is unchanged.`;
                    queueMemoryEmbedding({
                        deps,
                        sessionId: toolContext.sessionID,
                        projectPath: targetIdentityForStoredPath(rawProjectPath),
                        memoryId: memory.id,
                        content,
                    });
                    requestRustMemorySync(deps, toolContext.sessionID);
                    return `Updated memory [ID: ${memory.id}] in ${category}.`;
                }
                const receipt = proposeMemoryMutation(deps.db, {
                    projectPath: targetIdentityForStoredPath(rawProjectPath),
                    sourceSessionId: toolContext.sessionID,
                    writer: "curate",
                    operation: "update",
                    targetIds: [memory.id],
                    proposal: { content, category: args.category, reason: args.reason },
                });
                return `${receipt.reason}: update retained as a pending proposal; memory [ID: ${memory.id}] is unchanged.`;
            }

            if (args.action === "merge") {
                const ids = args.ids;
                if (!ids || ids.length < 2 || !ids.every(Number.isInteger)) {
                    return "Error: 'ids' must include at least two integer memory IDs when action is 'merge'.";
                }
                if (new Set(ids).size !== ids.length) {
                    return "Error: 'ids' must include at least two distinct memory IDs when action is 'merge'.";
                }

                const content = args.content?.trim();
                if (!content) {
                    return "Error: 'content' is required when action is 'merge'.";
                }

                const sourceMemories = ids
                    .map((id) => getMemoryById(deps.db, id))
                    .filter((memory): memory is Memory => Boolean(memory));
                if (sourceMemories.length !== ids.length) {
                    return "Error: One or more source memories were not found.";
                }
                // Primary agents may apply changes only to their own project's memories.
                // The dreamer may propose cross-project consolidation, but workspace sharing
                // still controls which source rows it is allowed to read.
                if (toolContext.agent !== DREAMER_AGENT) {
                    const foreign = sourceMemories.find((memory) => !memoryOwnedByTool(memory));
                    if (foreign) {
                        return `Error: Memory with ID ${foreign.id} was not found.`;
                    }
                    const inactive = sourceMemories.find(
                        (memory) => !isPrimaryMutableMemory(memory),
                    );
                    if (inactive) {
                        return inactiveMemoryError(inactive.id, "merging");
                    }
                } else if (visibility.workspaced) {
                    // The dreamer keeps its cross-PROJECT merge power (#5971) OUTSIDE
                    // a workspace (the branch above leaves non-workspace dreamer
                    // merges unrestricted). But INSIDE a workspace, per-category
                    // sharing is the user's explicit privacy boundary that even the
                    // system's own consolidation worker honors: a FOREIGN member's
                    // memory in a non-shared category (or a non-member project's
                    // memory) is off-limits. memoryVisibleToTool already encodes
                    // exactly that for the workspace case (own → true,
                    // foreign-shared-category → true, else → false).
                    const blocked = sourceMemories.find((memory) => !memoryVisibleToTool(memory));
                    if (blocked) {
                        return `Error: Memory with ID ${blocked.id} is in a category not shared with this workspace member and cannot be merged.`;
                    }
                }

                // A fact has exactly one category. If sources span categories they
                // are NOT genuine duplicates — one is miscategorized; archive the
                // redundant one instead. Merging across categories silently destroys
                // a distinct fact, so reject it structurally (not a prompt rule).
                const sourceCategories = new Set(sourceMemories.map((memory) => memory.category));
                if (sourceCategories.size > 1) {
                    return `Error: Cannot merge memories from different categories (${[...sourceCategories].join(", ")}). If they are genuine duplicates, one is miscategorized — archive the redundant one instead of merging across categories.`;
                }

                const category =
                    getValidatedCategory(args.category) ?? sourceMemories[0]?.category ?? null;
                if (!category) {
                    return "Error: A valid category is required when action is 'merge'.";
                }

                if (toolContext.agent !== DREAMER_AGENT) {
                    let receipt: ApplierReceipt;
                    try {
                        receipt = applyAgentMemoryMutation(deps.db, {
                            key: randomUUID(),
                            projectPath,
                            operation: "merge",
                            sourceSessionId: toolContext.sessionID,
                            targets: sourceMemories.map((memory) => ({
                                id: memory.id,
                                revision: getMemoryRevision(deps.db, memory.id)!,
                            })),
                            content,
                            category,
                            reason: args.reason,
                        });
                    } catch (error) {
                        if (error instanceof MemoryContentDuplicateError)
                            return `Error: Memory content already exists as ID ${error.memoryId}; update or archive existing duplicates instead.`;
                        throw error;
                    }
                    if (receipt.state !== "applied")
                        return `Error: ${receipt.reason}; memories [${ids.join(", ")}] are unchanged.`;
                    queueMemoryEmbedding({
                        deps,
                        sessionId: toolContext.sessionID,
                        projectPath,
                        memoryId: receipt.memoryId!,
                        content,
                    });
                    requestRustMemorySync(deps, toolContext.sessionID);
                    return `Merged memories [${ids.join(", ")}] into canonical memory [ID: ${receipt.memoryId}] in ${category}; superseded [${receipt.supersededIds?.join(", ")}].`;
                }
                const receipt = proposeMemoryMutation(deps.db, {
                    projectPath,
                    sourceSessionId: toolContext.sessionID,
                    writer: "curate",
                    operation: "merge",
                    targetIds: ids,
                    proposal: { content, category, reason: args.reason },
                });
                return `${receipt.reason}: merge retained as a pending proposal; memories [${ids.join(", ")}] are unchanged.`;
            }

            if (args.action === "archive") {
                const rawArchiveIds = args.ids;
                if (
                    !rawArchiveIds ||
                    rawArchiveIds.length === 0 ||
                    !rawArchiveIds.every(Number.isInteger)
                ) {
                    return "Error: 'ids' must contain at least one integer memory ID when action is 'archive'.";
                }
                // Preserve first-seen order and record each requested target only once.
                const archiveIds = [...new Set(rawArchiveIds)];

                // Validate the entire batch first so a bad id cannot leave a partial archive.
                const targets: Array<{ memoryId: number; projectIdentity: string }> = [];
                for (const memoryId of archiveIds) {
                    const rawProjectPath = projectPathForMemoryId(deps.db, memoryId);
                    const memory = getMemoryById(deps.db, memoryId);
                    const archiveAllowed = memory
                        ? toolContext.agent === DREAMER_AGENT
                            ? memoryVisibleToTool(memory)
                            : memoryOwnedByTool(memory)
                        : false;
                    if (!memory || !rawProjectPath || !archiveAllowed) {
                        return `Error: Memory with ID ${memoryId} was not found.`;
                    }
                    if (toolContext.agent !== DREAMER_AGENT && !isPrimaryMutableMemory(memory)) {
                        // Mirror update/merge: once the primary agent archived or
                        // superseded this memory, re-archiving it should return the
                        // same friendly inactive-memory error instead of mutating it.
                        return inactiveMemoryError(memoryId, "archiving");
                    }
                    targets.push({
                        memoryId,
                        projectIdentity: targetIdentityForStoredPath(rawProjectPath),
                    });
                }

                if (toolContext.agent !== DREAMER_AGENT) {
                    const receipt = applyAgentMemoryMutation(deps.db, {
                        key: randomUUID(),
                        projectPath,
                        operation: "archive",
                        sourceSessionId: toolContext.sessionID,
                        targets: targets.map((target) => ({
                            id: target.memoryId,
                            revision: getMemoryRevision(deps.db, target.memoryId)!,
                        })),
                        reason: args.reason,
                    });
                    if (receipt.state !== "applied")
                        return `Error: ${receipt.reason}; memories [${archiveIds.join(", ")}] are unchanged.`;
                    requestRustMemorySync(deps, toolContext.sessionID);
                    const plural = archiveIds.length > 1 ? "memories" : "memory";
                    return args.reason?.trim()
                        ? `Archived ${plural} [ID: ${archiveIds.join(", ")}] (${args.reason.trim()}).`
                        : `Archived ${plural} [ID: ${archiveIds.join(", ")}].`;
                }
                const receipt = proposeMemoryMutation(deps.db, {
                    projectPath,
                    sourceSessionId: toolContext.sessionID,
                    writer: "curate",
                    operation: "archive",
                    targetIds: archiveIds,
                    proposal: { reason: args.reason, supersededBy: args.superseded_by },
                });
                return `${receipt.reason}: archive retained as a pending proposal; memories [${archiveIds.join(", ")}] are unchanged.`;
            }

            return "Error: Unknown action.";
        },
    });
}

function createCtxMemoryListTool(deps: CtxMemoryToolDeps): ToolDefinition {
    const memoryTool = createCtxMemoryTool({
        ...deps,
        allowedActions: [...CTX_MEMORY_DREAMER_ACTIONS],
    });
    return tool({
        description: CTX_MEMORY_LIST_DESCRIPTION,
        args: ctxMemoryListArgsShape,
        async execute(args, toolContext) {
            if (toolContext.agent !== DREAMER_AGENT) {
                return "Error: ctx_memory_list is only available to the dreamer agent.";
            }
            return memoryTool.execute({ ...args, action: "list" }, toolContext);
        },
    });
}

export function createCtxMemoryTools(deps: CtxMemoryToolDeps): Record<string, ToolDefinition> {
    return {
        [CTX_MEMORY_TOOL_NAME]: createCtxMemoryTool(deps),
    };
}

export function createCtxMemoryListTools(deps: CtxMemoryToolDeps): Record<string, ToolDefinition> {
    return {
        [CTX_MEMORY_LIST_TOOL_NAME]: createCtxMemoryListTool(deps),
    };
}
