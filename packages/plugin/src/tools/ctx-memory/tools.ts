import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { DREAMER_AGENT } from "../../agents/dreamer";
import { SIDEKICK_AGENT } from "../../agents/sidekick";
import { getAuthorityManagedMarker } from "../../features/magic-context/context-authority";
import {
    archiveMemory,
    CATEGORY_PRIORITY,
    clearMemoryVerifications,
    getMemoriesByIds,
    getMemoriesByProject,
    getMemoryByHash,
    getMemoryById,
    insertMemoryIdempotent,
    type Memory,
    type MemoryCategory,
    mergeMemoryStats,
    saveEmbeddingIfHashMatches,
    supersededMemory,
    updateMemorySeenCount,
    V2_MEMORY_CATEGORIES,
} from "../../features/magic-context/memory";
import {
    embedTextForProject,
    enqueueShadowEmbeddingItems,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/memory/embedding";
import { invalidateMemory } from "../../features/magic-context/memory/embedding-cache";
import { computeNormalizedHash } from "../../features/magic-context/memory/normalize-hash";
import {
    hasMemoryClassifiedAtColumn,
    hasMemoryShareableColumn,
} from "../../features/magic-context/memory/storage-memory";
import {
    normalizeStoredProjectPath,
    queueMemoryMutation,
    storedPathBelongsToIdentity,
} from "../../features/magic-context/storage";
import {
    expandWorkspaceIdentitySetWithAliases,
    resolveStoredPathWorkspaceIdentity,
    resolveWorkspaceIdentitySet,
    resolveWorkspaceShareCategories,
    storedPathBelongsToWorkspace,
} from "../../features/magic-context/workspaces";
import {
    isRustAuthorityDrainingError,
    toolCallIdFromContext,
} from "../../plugin/rust-tool-backends";
import { sessionLog } from "../../shared/logger";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import { CTX_MEMORY_DESCRIPTION, CTX_MEMORY_TOOL_NAME, DEFAULT_SEARCH_LIMIT } from "./constants";
import {
    CTX_MEMORY_ACTIONS,
    CTX_MEMORY_DREAMER_ACTIONS,
    type CtxMemoryAction,
    type CtxMemoryArgs,
    type CtxMemoryToolDeps,
} from "./types";
import { runImmediateTransaction } from "./verification-recording";

export { CTX_MEMORY_LIGHT_DESCRIPTION } from "../light-descriptions";

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

function memoryAuthorityRefusal(args: CtxMemoryArgs, cause?: string): string {
    const readiness = "Rust memory authority is not ready.";
    const refusal =
        (args.action === "write" || args.action === "update" || args.action === "merge") &&
        typeof args.content === "string"
            ? `Error: ${readiness} Write REFUSED and NOT saved; RESEND the same call after authority is ready; the Rust module typically recovers in seconds-to-minutes.\nContent to resend:\n${args.content}`
            : `Error: ${readiness} Request REFUSED and NOT applied; RESEND the same call after authority is ready; the Rust module typically recovers in seconds-to-minutes.`;
    return cause ? `${cause}\n${refusal}` : refusal;
}

function moduleMemoryText(response: unknown, args: CtxMemoryArgs): string | null {
    let value = response;
    if (value !== null && typeof value === "object" && "result" in value) {
        value = (value as { result?: unknown }).result;
    }
    if (isRustAuthorityDrainingError(value)) {
        return memoryAuthorityRefusal(args);
    }
    if (typeof value === "string") return value;
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (record.ok === false || record.error || typeof record.message === "string") {
            const detail = record.error ?? record.message ?? "module rejected ctx_memory";
            const message =
                detail !== null && typeof detail === "object" && "message" in detail
                    ? String((detail as { message?: unknown }).message)
                    : String(detail);
            return `Error: ${message}`;
        }
        if (Array.isArray(record.content)) {
            const text = record.content.find(
                (item): item is { text: string } =>
                    item !== null &&
                    typeof item === "object" &&
                    typeof (item as { text?: unknown }).text === "string",
            )?.text;
            if (text) return text;
        }
    }
    return null;
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

    return [
        `Found ${rows.length} active ${rows.length === 1 ? "memory" : "memories"}:`,
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

function filterByCategory(memories: Memory[], category?: string): Memory[] {
    if (!category) {
        return memories;
    }

    return memories.filter((memory) => memory.category === category);
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

function getSourceType(deps: CtxMemoryToolDeps) {
    return deps.sourceType ?? "agent";
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

function memoryBelongsToProject(memory: Memory, projectPath: string): boolean {
    return storedPathBelongsToIdentity(memory.projectPath, projectPath);
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

function updateMemoryContentInCurrentTransaction(
    db: CtxMemoryToolDeps["db"],
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
    // Clear the classify marker so the changed fact is re-scored on the next
    // classify run (importance/scope were judged against the old content).
    if (hasMemoryClassifiedAtColumn(db)) {
        db.prepare("UPDATE memories SET classified_at = NULL WHERE id = ?").run(memory.id);
    }
    db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memory.id);
    clearMemoryVerifications(db, memory.id);
    invalidateMemory(memory.projectPath, memory.id);
}

const ctxMemoryArgsShape = {
    // Keep the complete action argument shape available to execute(); it can reject
    // actions that are unsafe for the current agent once that agent is known. The
    // passthrough parser also retains extra arguments sent by older callers.
    action: tool.schema
        .enum([...CTX_MEMORY_DREAMER_ACTIONS])
        .optional()
        .describe("What to do: write, update, archive, merge, get, or list"),
    content: tool.schema
        .string()
        .optional()
        .describe("The memory text — one standalone fact (required for write, update, merge)"),
    category: tool.schema
        .enum([...V2_MEMORY_CATEGORIES])
        .optional()
        .describe("What kind of fact this is (required for write; optional merge override)"),
    ids: tool.schema
        .array(tool.schema.number())
        .optional()
        .describe(
            "Target memory id(s) from <project-memory>: update takes exactly one, archive one or more, merge two or more, get one to twenty",
        ),
    limit: tool.schema.number().optional().describe("Max results for list (default: 10)"),
    reason: tool.schema
        .string()
        .optional()
        .describe("Why the memory is being archived (optional, recommended)"),
};
const ctxMemoryArgsSchema = tool.schema.object(ctxMemoryArgsShape).passthrough();

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
            });
            // Sidekick consumes untrusted `/ctx-aug` prompt text and is retrieval-only;
            // fail closed even if a future permission list accidentally exposes this tool.
            if (toolContext.agent === SIDEKICK_AGENT) {
                return "Error: ctx_memory is not available to the sidekick agent.";
            }
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
                return "Error: Could not resolve project identity for memory action.";
            }
            await deps.ensureProjectRegistered?.(toolContext.directory, deps.db);
            if (args.action !== "list") {
                const marker = getAuthorityManagedMarker(deps.db, projectPath);
                let authorityState: "TS" | "PREPARING" | "MODULE" | "DRAINING" | null = null;
                try {
                    authorityState =
                        (await deps.rustToolBackends?.authorityState?.({
                            projectPath,
                            projectRoot: toolContext.directory,
                            domain: "memories",
                        })) ?? null;
                } catch (error) {
                    if (marker) {
                        const detail = error instanceof Error ? error.message : String(error);
                        return memoryAuthorityRefusal(
                            args,
                            `Error: Rust memory authority is unavailable. ${detail}`,
                        );
                    }
                }
                if (authorityState === "MODULE") {
                    const memoryBackend = deps.rustToolBackends?.memory;
                    if (!memoryBackend) {
                        return "Error: Rust memory authority is active, but this module transport does not support ctx_memory.";
                    }
                    try {
                        const commandId = toolCallIdFromContext(toolContext);
                        const text = moduleMemoryText(
                            await memoryBackend({
                                ...(commandId ? { commandId } : {}),
                                sessionId: toolContext.sessionID,
                                projectRoot: toolContext.directory,
                                projectPath,
                                memoryProject: projectPath,
                                action: args.action,
                                content: args.content,
                                category: args.category,
                                ids: args.ids,
                                reason: args.reason,
                            }),
                            args,
                        );
                        return (
                            text ?? "Error: Rust module returned an invalid ctx_memory response."
                        );
                    } catch (error) {
                        if (isRustAuthorityDrainingError(error)) {
                            return memoryAuthorityRefusal(args);
                        }
                        const detail = error instanceof Error ? error.message : String(error);
                        return memoryAuthorityRefusal(
                            args,
                            `Error: Rust module ctx_memory failed. ${detail}`,
                        );
                    }
                }
                if (marker || authorityState === "PREPARING" || authorityState === "DRAINING") {
                    return memoryAuthorityRefusal(args);
                }
            }
            const workspaceIdentitySet = resolveWorkspaceIdentitySet(deps.db, projectPath);
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
                      ) ?? projectIdentityForStoredPath(rawProjectPath))
                    : projectIdentityForStoredPath(rawProjectPath);
            // The workspace's share-category policy matches the render path.
            // null means there is no workspace filter; a workspaced caller gets
            // an explicit list where [] shares no foreign categories.
            const toolShareCategories =
                workspaceIdentitySet.identities.length > 1
                    ? resolveWorkspaceShareCategories(deps.db, projectPath)
                    : null;
            // Visibility is the READ contract: own memories are visible in every
            // category, while foreign workspace memories are visible only in
            // categories the workspace explicitly shares. Mutations by primary
            // agents use memoryOwnedByTool below so shared visibility never
            // grants write access to another project.
            const memoryVisibleToTool = (memory: Memory): boolean => {
                if (workspaceIdentitySet.identities.length <= 1) {
                    return memoryBelongsToProject(memory, projectPath);
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
                const isOwn = targetIdentityForStoredPath(memory.projectPath) === projectPath;
                if (isOwn) return true;
                return (
                    (memory.status === "active" || memory.status === "permanent") &&
                    (memory.expiresAt === null || memory.expiresAt > Date.now()) &&
                    memory.shareable === 1 &&
                    ["project", "ecosystem", "universe"].includes(memory.scope) &&
                    (toolShareCategories?.includes(memory.category) ?? false)
                );
            };
            const memoryOwnedByTool = (memory: Memory): boolean =>
                workspaceIdentitySet.identities.length > 1
                    ? targetIdentityForStoredPath(memory.projectPath) === projectPath
                    : memoryBelongsToProject(memory, projectPath);
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

                const existingMemory = getMemoryByHash(
                    deps.db,
                    projectPath,
                    category,
                    computeNormalizedHash(content),
                );
                if (existingMemory) {
                    updateMemorySeenCount(deps.db, existingMemory.id);
                    requestRustMemorySync(deps, toolContext.sessionID);
                    return `Memory already exists [ID: ${existingMemory.id}] in ${category} (seen count incremented).`;
                }

                const insertResult = insertMemoryIdempotent(deps.db, {
                    projectPath: projectPath,
                    category,
                    content,
                    sourceSessionId: toolContext.sessionID,
                    sourceType:
                        toolContext.agent === DREAMER_AGENT ? "dreamer" : getSourceType(deps),
                });
                if (!insertResult.inserted) {
                    return `Memory already exists [ID: ${insertResult.memory.id}] in ${category} (seen count incremented).`;
                }

                queueMemoryEmbedding({
                    deps,
                    sessionId: toolContext.sessionID,
                    projectPath,
                    memoryId: insertResult.memory.id,
                    content,
                });
                requestRustMemorySync(deps, toolContext.sessionID);

                return `Saved memory [ID: ${insertResult.memory.id}] in ${category}.`;
            }

            if (args.action === "list") {
                const limit = normalizeLimit(args.limit);
                const category = normalizeCategory(args.category);
                const memories = filterByCategory(
                    getMemoriesByProject(deps.db, projectPath),
                    category,
                ).slice(0, limit);

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

                const normalizedHash = computeNormalizedHash(content);
                const duplicate = getMemoryByHash(
                    deps.db,
                    targetIdentityForStoredPath(rawProjectPath),
                    memory.category,
                    normalizedHash,
                );
                if (duplicate && duplicate.id !== memory.id) {
                    return `Error: Memory content already exists as ID ${duplicate.id}; merge or archive duplicates instead.`;
                }

                const projectIdentity = targetIdentityForStoredPath(rawProjectPath);
                runImmediateTransaction(deps.db, () => {
                    updateMemoryContentInCurrentTransaction(
                        deps.db,
                        memory,
                        content,
                        normalizedHash,
                    );
                    queueMemoryMutation(deps.db, {
                        projectPath: projectIdentity,
                        mutationType: "update",
                        targetMemoryId: memory.id,
                        category: memory.category,
                        newContent: content,
                    });
                });
                queueMemoryEmbedding({
                    deps,
                    sessionId: toolContext.sessionID,
                    projectPath: projectIdentity,
                    memoryId: memory.id,
                    content,
                });
                requestRustMemorySync(deps, toolContext.sessionID);

                return `Updated memory [ID: ${memory.id}] in ${memory.category}.`;
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
                // Cross-identity consolidation is a DREAMER-ONLY capability: the
                // loop below supersedes each source under ITS OWN project identity
                // and queues a per-project supersede-delta row, so every affected
                // project's m[1] reconciles. But `merge` is now in the primary
                // action set too, and a primary agent must not be able to reach
                // into ANOTHER project's memories. So mirror update/archive: a
                // non-dreamer caller may only merge memories that all belong to
                // its own resolved project. The dreamer keeps the cross-identity
                // path (see the "merging across identities" test).
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
                } else if (workspaceIdentitySet.identities.length > 1) {
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

                const normalizedHash = computeNormalizedHash(content);

                const mergedFrom = JSON.stringify(
                    Array.from(
                        new Set(
                            sourceMemories.flatMap((memory) => {
                                let parsed: unknown[];
                                try {
                                    parsed = memory.mergedFrom ? JSON.parse(memory.mergedFrom) : [];
                                } catch {
                                    parsed = [];
                                }
                                return [
                                    memory.id,
                                    ...(Array.isArray(parsed)
                                        ? parsed.filter(
                                              (value): value is number => typeof value === "number",
                                          )
                                        : []),
                                ];
                            }),
                        ),
                    ).sort((left, right) => left - right),
                );
                const mergedSeenCount = sourceMemories.reduce(
                    (sum, memory) => sum + memory.seenCount,
                    0,
                );
                const mergedRetrievalCount = sourceMemories.reduce(
                    (sum, memory) => sum + memory.retrievalCount,
                    0,
                );
                const mergedStatus = sourceMemories.some((memory) => memory.status === "permanent")
                    ? "permanent"
                    : "active";

                let mergeConflict: string | null = null;
                const canonicalMemory = runImmediateTransaction(deps.db, () => {
                    const lockedDuplicate = getMemoryByHash(
                        deps.db,
                        projectPath,
                        category,
                        normalizedHash,
                    );
                    const canonicalExisting =
                        lockedDuplicate && ids.includes(lockedDuplicate.id)
                            ? lockedDuplicate
                            : null;
                    if (lockedDuplicate && !canonicalExisting) {
                        mergeConflict = `Error: Memory content already exists as ID ${lockedDuplicate.id}; update or archive existing duplicates instead.`;
                        return null;
                    }

                    const nextCanonical =
                        canonicalExisting?.id != null
                            ? canonicalExisting
                            : insertMemoryIdempotent(deps.db, {
                                  projectPath: projectPath,
                                  category,
                                  content,
                                  sourceSessionId: toolContext.sessionID,
                                  sourceType:
                                      toolContext.agent === DREAMER_AGENT
                                          ? "dreamer"
                                          : getSourceType(deps),
                              }).memory;
                    const canonicalContentChanged =
                        nextCanonical.content !== content ||
                        nextCanonical.normalizedHash !== normalizedHash;

                    if (canonicalContentChanged) {
                        updateMemoryContentInCurrentTransaction(
                            deps.db,
                            nextCanonical,
                            content,
                            normalizedHash,
                        );
                    }

                    mergeMemoryStats(
                        deps.db,
                        nextCanonical.id,
                        mergedSeenCount,
                        mergedRetrievalCount,
                        mergedFrom,
                        mergedStatus,
                    );

                    for (const memory of sourceMemories) {
                        if (memory.id === nextCanonical.id) {
                            continue;
                        }
                        supersededMemory(deps.db, memory.id, nextCanonical.id);
                        queueMemoryMutation(deps.db, {
                            projectPath: projectIdentityForStoredPath(memory.projectPath),
                            mutationType: "superseded",
                            targetMemoryId: memory.id,
                            supersededById: nextCanonical.id,
                        });
                    }

                    if (canonicalExisting && canonicalContentChanged) {
                        queueMemoryMutation(deps.db, {
                            projectPath: projectIdentityForStoredPath(nextCanonical.projectPath),
                            mutationType: "update",
                            targetMemoryId: nextCanonical.id,
                            category,
                            newContent: content,
                        });
                    }

                    return nextCanonical;
                });
                if (mergeConflict || !canonicalMemory) {
                    return mergeConflict ?? "Error: Failed to merge memories.";
                }

                queueMemoryEmbedding({
                    deps,
                    sessionId: toolContext.sessionID,
                    projectPath,
                    memoryId: canonicalMemory.id,
                    content,
                });
                requestRustMemorySync(deps, toolContext.sessionID);

                const supersededIds = sourceMemories
                    .map((memory) => memory.id)
                    .filter((id) => id !== canonicalMemory.id);
                return `Merged memories [${ids.join(", ")}] into canonical memory [ID: ${canonicalMemory.id}] in ${category}; superseded [${supersededIds.join(", ")}].`;
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
                // De-dupe (first-seen order) so `ids:[42,42]` archives once and
                // queues one mutation-log row instead of two.
                const archiveIds = [...new Set(rawArchiveIds)];

                // Validate the whole batch BEFORE mutating anything so a typo'd
                // id can't half-archive a batch (all-or-nothing, matching the
                // single-transaction write below).
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

                runImmediateTransaction(deps.db, () => {
                    for (const target of targets) {
                        archiveMemory(deps.db, target.memoryId, args.reason);
                        queueMemoryMutation(deps.db, {
                            projectPath: target.projectIdentity,
                            mutationType: "archive",
                            targetMemoryId: target.memoryId,
                        });
                    }
                });
                requestRustMemorySync(deps, toolContext.sessionID);
                const idList = targets.map((t) => t.memoryId).join(", ");
                const plural = targets.length > 1 ? "memories" : "memory";
                return args.reason?.trim()
                    ? `Archived ${plural} [ID: ${idList}] (${args.reason.trim()}).`
                    : `Archived ${plural} [ID: ${idList}].`;
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
