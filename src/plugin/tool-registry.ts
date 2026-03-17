import type { ToolDefinition } from "@opencode-ai/plugin";
import type { MagicContextPluginConfig } from "../config";
import { DEFAULT_PROTECTED_TAGS } from "../features/magic-context/defaults";
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

    if (pluginConfig.magic_context?.enabled !== true) {
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

    const memoryEnabled = pluginConfig.magic_context.memory?.enabled === true;
    const projectPath = resolveProjectIdentity(ctx.directory);

    return {
        ...createCtxReduceTools({
            db,
            protectedTags: pluginConfig.magic_context.protected_tags ?? DEFAULT_PROTECTED_TAGS,
        }),
        ...createCtxNoteTools({ db }),
        ...(memoryEnabled
            ? {
                  ...createCtxRecallTools({
                      db,
                      projectPath,
                      memoryEnabled: true,
                      embeddingProvider:
                          pluginConfig.magic_context.memory?.embedding_provider ?? "transformers",
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
