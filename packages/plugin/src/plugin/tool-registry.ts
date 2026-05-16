import type { ToolDefinition } from "@opencode-ai/plugin";
import type { MagicContextPluginConfig } from "../config";
import { DEFAULT_PROTECTED_TAGS } from "../features/magic-context/defaults";
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
import { createCtxSearchTools } from "../tools/ctx-search";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "./embedding-bootstrap";
import { normalizeToolArgSchemas } from "./normalize-tool-arg-schemas";
import type { PluginContext } from "./types";

export function createToolRegistry(args: {
    ctx: PluginContext;
    pluginConfig: MagicContextPluginConfig;
}): Record<string, ToolDefinition> {
    const { ctx, pluginConfig } = args;

    if (pluginConfig.enabled !== true) {
        return {};
    }

    // Storage failure (binary ABI mismatch, unwritable path, etc.) must
    // disable Magic Context cleanly instead of silently degrading. We never
    // expose ctx_* tools when storage isn't healthy — see openDatabase()
    // for the reasoning.
    let db: ReturnType<typeof openDatabase>;
    try {
        db = openDatabase();
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // console.warn intentional: this runs during plugin init before the file logger is
        // guaranteed to be ready, and storage failure is user-visible enough to warrant stderr.
        console.warn(
            `[magic-context] persistent storage unavailable; disabling magic-context tools: ${reason}`,
        );
        return {};
    }
    if (!isDatabasePersisted(db)) {
        const reason = getDatabasePersistenceError(db);
        console.warn(
            `[magic-context] persistent storage unavailable; disabling magic-context tools${reason ? `: ${reason}` : ""}`,
        );
        return {};
    }

    void ensureProjectRegisteredFromOpenCodeDirectory(ctx.directory, db);

    // Tools resolve project per-call from `toolContext.directory` because
    // OpenCode's top-level `ctx.directory` reflects the launch dir, not the
    // session's actual working directory (e.g. when launched via
    // `opencode -s <id>` from outside the project).
    const resolveProjectPath = (directory: string) => resolveProjectIdentity(directory);

    const ctxReduceEnabled = pluginConfig.ctx_reduce_enabled !== false;
    const allTools: Record<string, ToolDefinition> = {
        ...(ctxReduceEnabled
            ? createCtxReduceTools({
                  db,
                  protectedTags: pluginConfig.protected_tags ?? DEFAULT_PROTECTED_TAGS,
              })
            : {}),
        ...createCtxExpandTools(),
        ...createCtxNoteTools({
            db,
            dreamerEnabled: pluginConfig.dreamer?.enabled === true,
            resolveProjectPath,
        }),
        ...createCtxSearchTools({
            db,
            resolveProjectPath,
            ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
        }),
        ...createCtxMemoryTools({
            db,
            resolveProjectPath,
            ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
            allowedActions: ["write", "delete"],
        }),
    };

    // Patch arg schemas so property-level .describe() text survives JSON Schema serialization.
    // Without this, the LLM sees bare types with no description for each parameter.
    for (const toolDefinition of Object.values(allTools)) {
        normalizeToolArgSchemas(toolDefinition);
    }

    return allTools;
}
