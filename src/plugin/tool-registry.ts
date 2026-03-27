import type { ToolDefinition } from "@opencode-ai/plugin";
import type { MagicContextPluginConfig } from "../config";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../config/schema/magic-context";
import { DEFAULT_PROTECTED_TAGS } from "../features/magic-context/defaults";
import {
    clearEmbeddingsForProject,
    getStoredModelId,
    initializeEmbedding,
} from "../features/magic-context/memory";
import { getEmbeddingModelId } from "../features/magic-context/memory/embedding";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import {
    getDatabasePersistenceError,
    isDatabasePersisted,
    openDatabase,
} from "../features/magic-context/storage";
import { createCtxExpandTools } from "../tools/ctx-expand";
import { createCtxMemoryTools } from "../tools/ctx-memory";
import { createCtxNoteTools } from "../tools/ctx-note";
import { createCtxReduceTools } from "../tools/ctx-reduce";
import { normalizeToolArgSchemas } from "./normalize-tool-arg-schemas";
import type { PluginContext } from "./types";

export function createToolRegistry(args: {
    ctx: PluginContext;
    pluginConfig: MagicContextPluginConfig;
}): Record<string, ToolDefinition> {
    const { ctx, pluginConfig } = args;
    const embeddingConfig = pluginConfig.embedding ?? {
        provider: "local" as const,
        model: DEFAULT_LOCAL_EMBEDDING_MODEL,
    };

    if (pluginConfig.enabled !== true) {
        return {};
    }

    const db = openDatabase();
    if (!isDatabasePersisted(db)) {
        const reason = getDatabasePersistenceError(db);
        // console.warn intentional: this runs during plugin init before the file logger is
        // guaranteed to be ready, and storage failure is user-visible enough to warrant stderr.
        console.warn(
            `[magic-context] persistent storage unavailable; disabling magic-context tools${reason ? `: ${reason}` : ""}`,
        );
        return {};
    }

    const memoryEnabled = pluginConfig.memory?.enabled === true;
    initializeEmbedding(embeddingConfig);
    const projectPath = resolveProjectIdentity(ctx.directory);

    if (memoryEnabled) {
        const currentModelId = getEmbeddingModelId();
        const storedModelId = getStoredModelId(db, projectPath);
        const hasEmbeddings =
            (db
                .prepare(
                    "SELECT 1 FROM memory_embeddings me JOIN memories m ON me.memory_id = m.id WHERE m.project_path = ? LIMIT 1",
                )
                .get(projectPath) as { 1: number } | null) !== null;

        if (hasEmbeddings && storedModelId !== currentModelId) {
            clearEmbeddingsForProject(db, projectPath);
            // console.warn intentional: embedding wipe is a rare, user-visible event during init.
            console.warn(
                `[magic-context] embedding model changed from ${storedModelId} to ${currentModelId}; cleared embeddings for project ${projectPath}`,
            );
        }
    }

    const ctxReduceEnabled = pluginConfig.ctx_reduce_enabled !== false;
    const allTools: Record<string, ToolDefinition> = {
        ...(ctxReduceEnabled
            ? createCtxReduceTools({
                  db,
                  protectedTags: pluginConfig.protected_tags ?? DEFAULT_PROTECTED_TAGS,
              })
            : {}),
        ...createCtxExpandTools(),
        ...createCtxNoteTools({ db }),
        ...(memoryEnabled
            ? {
                  ...createCtxMemoryTools({
                      db,
                      projectPath,
                      memoryEnabled: true,
                      embeddingEnabled: embeddingConfig.provider !== "off",
                      allowedActions: ["write", "delete", "search"],
                  }),
              }
            : {}),
    };

    // Patch arg schemas so property-level .describe() text survives JSON Schema serialization.
    // Without this, the LLM sees bare types with no description for each parameter.
    for (const toolDefinition of Object.values(allTools)) {
        normalizeToolArgSchemas(toolDefinition);
    }

    return allTools;
}
