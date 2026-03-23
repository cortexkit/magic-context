import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { getMemoryByHash, updateMemorySeenCount } from "../../features/magic-context/memory";
import {
    archiveMemory,
    CATEGORY_PRIORITY,
    getMemoriesByProject,
    getMemoryById,
    insertMemory,
    type Memory,
    type MemoryCategory,
    saveEmbedding,
    updateMemoryStatus,
} from "../../features/magic-context/memory";
import { embedText, getEmbeddingModelId } from "../../features/magic-context/memory/embedding";
import { computeNormalizedHash } from "../../features/magic-context/memory/normalize-hash";
import { log } from "../../shared/logger";
import { CTX_MEMORY_DESCRIPTION, CTX_MEMORY_TOOL_NAME } from "./constants";
import type { CtxMemoryArgs, CtxMemoryToolDeps } from "./types";

const MAX_CONTENT_PREVIEW_LENGTH = 120;
const MEMORY_CATEGORIES = new Set<string>(CATEGORY_PRIORITY);

function isMemoryCategory(value: string): value is MemoryCategory {
    return MEMORY_CATEGORIES.has(value);
}

function truncateContent(content: string): string {
    const normalized = content.replace(/\s+/g, " ").trim();
    if (normalized.length <= MAX_CONTENT_PREVIEW_LENGTH) {
        return normalized;
    }

    return `${normalized.slice(0, MAX_CONTENT_PREVIEW_LENGTH - 3)}...`;
}

function groupMemoriesByCategory(memories: Memory[]): Map<MemoryCategory, Memory[]> {
    const grouped = new Map<MemoryCategory, Memory[]>();

    for (const category of CATEGORY_PRIORITY) {
        grouped.set(category, []);
    }

    for (const memory of memories) {
        grouped.get(memory.category)?.push(memory);
    }

    for (const [category, items] of [...grouped.entries()]) {
        if (items.length === 0) {
            grouped.delete(category);
        }
    }

    return grouped;
}

function formatMemoryLine(memory: Memory): string {
    return `- [ID: ${memory.id}] [${memory.category}] ${truncateContent(memory.content)} (${memory.status}, seen: ${memory.seenCount}, retrieved: ${memory.retrievalCount})`;
}

function formatScopeSection(title: string, memories: Memory[]): string | null {
    if (memories.length === 0) {
        return null;
    }

    const grouped = groupMemoriesByCategory(memories);
    const sections = [...grouped.entries()].map(([category, items]) =>
        [`### ${category} (${items.length})`, items.map(formatMemoryLine).join("\n")].join("\n\n"),
    );

    return [`## ${title} (${memories.length} total)`, sections.join("\n\n")]
        .filter(Boolean)
        .join("\n\n");
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

function createCtxMemoryTool(deps: CtxMemoryToolDeps): ToolDefinition {
    return tool({
        description: CTX_MEMORY_DESCRIPTION,
        args: {
            action: tool.schema
                .enum(["write", "delete", "promote", "list"])
                .describe("Action to perform on memories"),
            content: tool.schema
                .string()
                .optional()
                .describe("Memory content (required for write)"),
            category: tool.schema
                .string()
                .optional()
                .describe("Memory category (required for write, optional filter for list)"),
            id: tool.schema
                .number()
                .optional()
                .describe("Memory ID (required for delete and promote)"),
        },
        async execute(args: CtxMemoryArgs, toolContext) {
            if (!deps.memoryEnabled) {
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

                // Check for duplicate before inserting to avoid SQLite UNIQUE constraint errors
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
                    sourceType: "agent",
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

            if (args.action === "promote") {
                if (typeof args.id !== "number" || !Number.isInteger(args.id)) {
                    return "Error: 'id' is required when action is 'promote'.";
                }

                const memory = getMemoryById(deps.db, args.id);
                if (!memory || memory.projectPath !== deps.projectPath) {
                    return `Error: Memory with ID ${args.id} was not found.`;
                }

                updateMemoryStatus(deps.db, args.id, "permanent");
                return `Promoted memory [ID: ${args.id}] to permanent.`;
            }

            const requestedCategory = args.category?.trim();
            if (requestedCategory && !isMemoryCategory(requestedCategory)) {
                return `Error: Unknown memory category '${requestedCategory}'.`;
            }

            const memories = getMemoriesByProject(deps.db, deps.projectPath).filter(
                (memory) => !requestedCategory || memory.category === requestedCategory,
            );

            if (memories.length === 0) {
                return "No cross-session memories stored yet.";
            }

            return (
                formatScopeSection("Project Memories", memories) ??
                "No cross-session memories stored yet."
            );
        },
    });
}

export function createCtxMemoryTools(deps: CtxMemoryToolDeps): Record<string, ToolDefinition> {
    return {
        [CTX_MEMORY_TOOL_NAME]: createCtxMemoryTool(deps),
    };
}
