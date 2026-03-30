import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { DREAMER_AGENT } from "../../agents/dreamer";
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
} from "../../features/magic-context/memory";
import { embedText, getEmbeddingModelId } from "../../features/magic-context/memory/embedding";
import { computeNormalizedHash } from "../../features/magic-context/memory/normalize-hash";
import { log } from "../../shared/logger";
import { CTX_MEMORY_DESCRIPTION, CTX_MEMORY_TOOL_NAME, DEFAULT_SEARCH_LIMIT } from "./constants";
import {
    CTX_MEMORY_DREAMER_ACTIONS,
    type CtxMemoryAction,
    type CtxMemoryArgs,
    type CtxMemoryToolDeps,
} from "./types";

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

function getAllowedActions(deps: CtxMemoryToolDeps): [CtxMemoryAction, ...CtxMemoryAction[]] {
    const allowed = deps.allowedActions?.length
        ? deps.allowedActions
        : [...CTX_MEMORY_DREAMER_ACTIONS];
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

function queueMemoryEmbedding(deps: CtxMemoryToolDeps, memoryId: number, content: string): void {
    void (async () => {
        const embedding = await embedText(content);
        if (!embedding) {
            return;
        }

        saveEmbedding(deps.db, memoryId, embedding, getEmbeddingModelId());
    })().catch((error: unknown) => {
        log("[ctx-memory] failed to save memory embedding:", error);
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

function createCtxMemoryTool(deps: CtxMemoryToolDeps): ToolDefinition {
    const allowedActions = getAllowedActions(deps);

    return tool({
        description: CTX_MEMORY_DESCRIPTION,
        args: {
            action: tool.schema
                .enum(CTX_MEMORY_DREAMER_ACTIONS)
                .describe("Action to perform on memories"),
            content: tool.schema
                .string()
                .optional()
                .describe("Memory content (required for write, update, merge)"),
            category: tool.schema
                .string()
                .optional()
                .describe(
                    "Memory category (required for write, optional filter for list, optional override for merge)",
                ),
            id: tool.schema
                .number()
                .optional()
                .describe("Memory ID (required for delete, update, archive)"),
            ids: tool.schema
                .array(tool.schema.number())
                .optional()
                .describe("Memory IDs to merge (required for merge)"),
            limit: tool.schema
                .number()
                .optional()
                .describe("Maximum results to return for list (default: 10)"),
            reason: tool.schema
                .string()
                .optional()
                .describe("Archive reason (optional for archive)"),
        },
        async execute(args: CtxMemoryArgs, toolContext) {
            if (!deps.memoryEnabled) {
                return getDisabledMessage();
            }

            if (toolContext.agent !== DREAMER_AGENT && !allowedActions.includes(args.action)) {
                return `Error: Action '${args.action}' is not allowed in this context.`;
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
                    deps.projectPath,
                    category,
                    computeNormalizedHash(content),
                );
                if (existingMemory) {
                    updateMemorySeenCount(deps.db, existingMemory.id);
                    return `Memory already exists [ID: ${existingMemory.id}] in ${category} (seen count incremented).`;
                }

                const memory = insertMemory(deps.db, {
                    projectPath: deps.projectPath,
                    category,
                    content,
                    sourceSessionId: toolContext.sessionID,
                    sourceType:
                        toolContext.agent === DREAMER_AGENT ? "dreamer" : getSourceType(deps),
                });

                queueMemoryEmbedding(deps, memory.id, content);

                return `Saved memory [ID: ${memory.id}] in ${category}.`;
            }

            if (args.action === "delete") {
                if (typeof args.id !== "number" || !Number.isInteger(args.id)) {
                    return "Error: 'id' is required when action is 'delete'.";
                }

                const memory = getMemoryById(deps.db, args.id);
                if (!memory || memory.projectPath !== deps.projectPath) {
                    return `Error: Memory with ID ${args.id} was not found.`;
                }

                archiveMemory(deps.db, args.id);
                return `Archived memory [ID: ${args.id}].`;
            }

            if (args.action === "list") {
                const limit = normalizeLimit(args.limit);
                const category = normalizeCategory(args.category);
                const memories = filterByCategory(
                    getMemoriesByProject(deps.db, deps.projectPath),
                    category,
                ).slice(0, limit);

                return formatMemoryList(memories);
            }

            if (args.action === "update") {
                if (typeof args.id !== "number" || !Number.isInteger(args.id)) {
                    return "Error: 'id' is required when action is 'update'.";
                }

                const content = args.content?.trim();
                if (!content) {
                    return "Error: 'content' is required when action is 'update'.";
                }

                const memory = getMemoryById(deps.db, args.id);
                if (!memory || memory.projectPath !== deps.projectPath) {
                    return `Error: Memory with ID ${args.id} was not found.`;
                }

                const normalizedHash = computeNormalizedHash(content);
                const duplicate = getMemoryByHash(
                    deps.db,
                    deps.projectPath,
                    memory.category,
                    normalizedHash,
                );
                if (duplicate && duplicate.id !== memory.id) {
                    return `Error: Memory content already exists as ID ${duplicate.id}; merge or archive duplicates instead.`;
                }

                updateMemoryContent(deps.db, memory.id, content, normalizedHash);
                queueMemoryEmbedding(deps, memory.id, content);

                return `Updated memory [ID: ${memory.id}] in ${memory.category}.`;
            }

            if (args.action === "merge") {
                const ids = args.ids?.filter((id): id is number => Number.isInteger(id));
                if (!ids || ids.length < 2) {
                    return "Error: 'ids' must include at least two memory IDs when action is 'merge'.";
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

                if (sourceMemories.some((memory) => memory.projectPath !== deps.projectPath)) {
                    return "Error: All memories to merge must belong to the current project.";
                }

                const category =
                    getValidatedCategory(args.category) ?? sourceMemories[0]?.category ?? null;
                if (!category) {
                    return "Error: A valid category is required when action is 'merge'.";
                }

                if (
                    !args.category &&
                    sourceMemories.some((memory) => memory.category !== category)
                ) {
                    return "Error: Mixed-category merges require an explicit 'category'.";
                }

                const normalizedHash = computeNormalizedHash(content);
                const duplicate = getMemoryByHash(
                    deps.db,
                    deps.projectPath,
                    category,
                    normalizedHash,
                );
                const canonicalExisting =
                    duplicate && ids.includes(duplicate.id) ? duplicate : null;
                if (duplicate && !canonicalExisting) {
                    return `Error: Memory content already exists as ID ${duplicate.id}; update or archive existing duplicates instead.`;
                }

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

                const canonicalMemory = deps.db.transaction(() => {
                    const nextCanonical =
                        canonicalExisting ??
                        insertMemory(deps.db, {
                            projectPath: deps.projectPath,
                            category,
                            content,
                            sourceSessionId: toolContext.sessionID,
                            sourceType:
                                toolContext.agent === DREAMER_AGENT
                                    ? "dreamer"
                                    : getSourceType(deps),
                        });

                    if (
                        nextCanonical.content !== content ||
                        nextCanonical.normalizedHash !== normalizedHash
                    ) {
                        updateMemoryContent(deps.db, nextCanonical.id, content, normalizedHash);
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
                    }

                    return nextCanonical;
                })();

                queueMemoryEmbedding(deps, canonicalMemory.id, content);

                const supersededIds = sourceMemories
                    .map((memory) => memory.id)
                    .filter((id) => id !== canonicalMemory.id);
                return `Merged memories [${ids.join(", ")}] into canonical memory [ID: ${canonicalMemory.id}] in ${category}; superseded [${supersededIds.join(", ")}].`;
            }

            if (args.action === "archive") {
                if (typeof args.id !== "number" || !Number.isInteger(args.id)) {
                    return "Error: 'id' is required when action is 'archive'.";
                }

                const memory = getMemoryById(deps.db, args.id);
                if (!memory || memory.projectPath !== deps.projectPath) {
                    return `Error: Memory with ID ${args.id} was not found.`;
                }

                archiveMemory(deps.db, args.id, args.reason);
                return args.reason?.trim()
                    ? `Archived memory [ID: ${args.id}] (${args.reason.trim()}).`
                    : `Archived memory [ID: ${args.id}].`;
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
