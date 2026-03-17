import type { ToolDefinition } from "@opencode-ai/plugin";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../config/schema/magic-context";
import type { MagicContextPluginConfig } from "../config";
import { DEFAULT_PROTECTED_TAGS } from "../features/magic-context/defaults";
import {
    clearAllEmbeddings,
    getStoredModelId,
    initializeEmbedding,
    loadAllEmbeddings,
} from "../features/magic-context/memory";
import { getEmbeddingModelId } from "../features/magic-context/memory/embedding";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import {
    getDatabasePersistenceError,
    isDatabasePersisted,
    openDatabase,
} from "../features/magic-context/storage";
import { createCtxMemoryTools } from "../tools/ctx-memory";
import { createCtxNoteTools } from "../tools/ctx-note";
import { createCtxRecallTools } from "../tools/ctx-recall";
import { createCtxReduceTools } from "../tools/ctx-reduce";
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
        const storedModelId = getStoredModelId(db);
        const hasEmbeddings = loadAllEmbeddings(db, projectPath).size > 0;

        if (hasEmbeddings && storedModelId !== currentModelId) {
            clearAllEmbeddings(db);
            console.warn(
                `[magic-context] embedding model changed from ${storedModelId} to ${currentModelId}; cleared stored embeddings for lazy re-generation`,
            );
        }
    }

    return {
        ...createCtxReduceTools({
            db,
            protectedTags: pluginConfig.protected_tags ?? DEFAULT_PROTECTED_TAGS,
        }),
        ...createCtxNoteTools({ db }),
        ...(memoryEnabled
            ? {
                  ...createCtxRecallTools({
                      db,
                      projectPath,
                      memoryEnabled: true,
                      embeddingEnabled: embeddingConfig.provider !== "off",
                  }),
                  ...createCtxMemoryTools({
                      db,
                      projectPath,
                      memoryEnabled: true,
                  }),
              }
            : {}),
    };
}
