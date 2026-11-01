import type { ToolDefinition } from "@opencode-ai/plugin";
import type { MagicContextPluginConfig } from "../config";
import {
    isCompactionEnabled,
    isDreamerRunnable,
    isSmartNoteSurfaceAvailable,
} from "../config/agent-disable";
import { resolveSessionProjectIdentity } from "../features/magic-context/memory/session-identity-decision";
import { getProtectionWindowForSession } from "../features/magic-context/protection-window";
import {
    getDatabasePersistenceError,
    isDatabasePersisted,
    openCurrentDatabase as openDatabase,
} from "../features/magic-context/storage";
import { getObservedEpochFloor } from "../features/magic-context/storage-meta-persisted";
import { agentSaveClassificationAnchor } from "../hooks/magic-context/agent-save-classification";
import { setCtxReduceRegisteredGlobally } from "../hooks/magic-context/ctx-reduce-availability";
import { getErrorMessage } from "../shared/error-message";
import { log } from "../shared/logger";
import type { PromptSurfaceConfig } from "../shared/prompt-surface";
import type { PromptSurfaceRuntime } from "../shared/prompt-surface-runtime";
import { createPromptSurfaceRuntime } from "../shared/prompt-surface-runtime";
import type { Database } from "../shared/sqlite";
import { createCtxExpandTools } from "../tools/ctx-expand";
import {
    CTX_MEMORY_ACTIONS,
    createCtxMemoryListTools,
    createCtxMemoryTools,
} from "../tools/ctx-memory";
import { createCtxNoteTools } from "../tools/ctx-note";
import { withoutSmartNoteText } from "../tools/ctx-note/constants";
import { createCtxReduceTools } from "../tools/ctx-reduce";
import { createCtxSearchTools } from "../tools/ctx-search";
import { CTX_NOTE_LIGHT_DESCRIPTION } from "../tools/light-descriptions";
import { parameterDescriptionsFor } from "../tools/parameter-descriptions";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "./embedding-bootstrap";
import { normalizeToolArgSchemas } from "./normalize-tool-arg-schemas";
import { guardSubagentTools } from "./subagent-tool-policy";
import type { PluginContext } from "./types";

/**
 * The exact tool IDs emitted by `createCtxReduceTools`. In compaction-off mode
 * (the `compaction` config block's `enabled` field set to false) the registry
 * skips registering this factory entirely, so this enumeration is the
 * removed-set diffed against the mode-on tool list in the acceptance test.
 * The factory is plural (it returns a record keyed by tool name), so the test
 * must distinguish "factory skipped" from "one ID filtered" — listing the IDs
 * by name makes a future tool the factory grows fail the diff rather than
 * silently vanishing in compaction-off mode.
 *
 * Spec #266 decision #3: only ctx_reduce unregisters; ctx_expand/ctx_note/
 * ctx_search/ctx_memory stay (subject to their existing gates).
 */
const COMPACTION_OFF_REMOVED_TOOL_IDS = ["ctx_reduce"] as const;

/**
 * The enumerated tool IDs removed in compaction-off mode (today exactly
 * `["ctx_reduce"]`). Exported so the acceptance test diffs the mode-off tool
 * set against the mode-on set and asserts the difference equals exactly this
 * list — a future tool the reduce factory grows appears here and fails the
 * diff rather than silently vanishing in compaction-off mode.
 */
export function getCompactionOffRemovedToolIds(): readonly string[] {
    return COMPACTION_OFF_REMOVED_TOOL_IDS;
}

export function createToolRegistry(args: {
    ctx: PluginContext;
    pluginConfig: MagicContextPluginConfig;
    promptSurfaceRuntime?: PromptSurfaceRuntime;
    registrationPromptSurface?: PromptSurfaceConfig;
    includeDreamerOnlyTools?: boolean;
    internalChildSessions?: ReadonlySet<string>;
}): Record<string, ToolDefinition> {
    const { ctx, pluginConfig } = args;

    if (pluginConfig.enabled !== true) {
        return {};
    }

    // Compaction-off mode is boot-resolved and process-stable (the mode is
    // determined once at startup from config and does not change during the
    // process). The mode removes exactly the tool IDs emitted by
    // createCtxReduceTools (enumerated in COMPACTION_OFF_REMOVED_TOOL_IDS)
    // and nothing else. All other ctx_* tools register normally. The
    // process-global registration override in ctx-reduce-availability.ts is
    // set from this same resolution so the no-reduce guidance variant,
    // Channel-1/Channel-2 nudges, and §N§ prefix injection all flow false
    // naturally for every session (the per-session tools map would otherwise
    // fail-open to "callable" for normal sessions).
    const compactionOff = !isCompactionEnabled(pluginConfig);
    setCtxReduceRegisteredGlobally(!compactionOff);

    // Storage failure (binary ABI mismatch, unwritable path, etc.) must
    // disable Magic Context cleanly instead of silently degrading. We never
    // expose ctx_* tools when storage isn't healthy — see openDatabase()
    // for the reasoning.
    let db: Database;
    try {
        const opened = openDatabase();
        // openDatabase returns null on the schema-fence path (DB newer than this
        // binary) and throws on a fatal open error — handle both as "storage
        // unavailable, disable tools cleanly".
        if (!opened || !isDatabasePersisted(opened)) {
            const reason = getDatabasePersistenceError(opened);
            console.warn(
                `[magic-context] persistent storage unavailable; disabling magic-context tools${reason ? `: ${reason}` : ""}`,
            );
            return {};
        }
        db = opened;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // console.warn intentional: this runs during plugin init before the file logger is
        // guaranteed to be ready, and storage failure is user-visible enough to warrant stderr.
        console.warn(
            `[magic-context] persistent storage unavailable; disabling magic-context tools: ${reason}`,
        );
        return {};
    }

    // Fire-and-forget: registration failure (including a database handle that
    // closed during process teardown) must never surface as an unhandled
    // rejection from plugin init. The next boot or embed path re-registers.
    void ensureProjectRegisteredFromOpenCodeDirectory(ctx.directory, db).catch((error) => {
        log(`[magic-context] embedding registration skipped: ${getErrorMessage(error)}`);
    });

    // A directory lookup can disagree with the decision used by project-memory,
    // especially when a linked worktree cannot persist the registry's pin.
    const resolveProjectPath = (directory: string, sessionId: string) =>
        resolveSessionProjectIdentity(sessionId, directory, {
            db,
            allowHomeProject: pluginConfig.allow_home_project,
            connectionFile: pluginConfig.subc?.connection_file,
        });

    // When memory is off the <project-memory> block is never injected, so an
    // agent's memory writes would never resurface. Omit ctx_memory entirely
    // (the matching guidance is gated in buildMagicContextSection). ctx_search
    // stays: it still recalls conversation + git commits, just not memories.
    const memoryEnabled = pluginConfig.memory?.enabled !== false;
    const allTools: Record<string, ToolDefinition> = {
        // In compaction-off mode the ctx_reduce factory is skipped entirely
        // (COMPACTION_OFF_REMOVED_TOOL_IDS enumerates its emitted IDs). The
        // spread is conditional rather than filtering after the fact so the
        // factory never runs — the acceptance test diffs the mode-off tool
        // set against the mode-on set and asserts the difference equals
        // exactly the removed-set, catching any future ID the factory grows.
        ...(compactionOff
            ? {}
            : createCtxReduceTools({
                  db,
                  protectedTools: pluginConfig.protected_tools,
                  getProtectionWindow: (sessionId) =>
                      getProtectionWindowForSession(
                          db,
                          sessionId,
                          getObservedEpochFloor(db, sessionId),
                      ),
              })),
        ...createCtxExpandTools({
            db,
            expandTools: pluginConfig.historian?.expand_tools,
        }),
        ...createCtxNoteTools({
            db,
            dreamerEnabled: isDreamerRunnable(pluginConfig),
            smartNotesEnabled: pluginConfig.smart_notes?.enabled,
            resolveProjectPath,
        }),
        ...createCtxSearchTools({
            db,
            rerankConnectionFile: pluginConfig.subc?.connection_file,
            rerankConfig: pluginConfig.rerank,
            resolveProjectPath,
            ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
        }),
        ...(memoryEnabled
            ? createCtxMemoryTools({
                  db,
                  resolveProjectPath,
                  ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
                  // Primary agents get the full mutation surface (write/archive/
                  // update/merge) on memories they can already see (with ids) in
                  // the injected <project-memory> block. Only `list` (bulk
                  // enumeration) stays dreamer-only (runtime-gated via
                  // toolContext.agent in tools.ts).
                  allowedActions: [...CTX_MEMORY_ACTIONS],
                  agentSaveClassificationAnchor: (location) =>
                      agentSaveClassificationAnchor(location),
              })
            : {}),
        ...(memoryEnabled && args.includeDreamerOnlyTools
            ? createCtxMemoryListTools({
                  db,
                  resolveProjectPath,
                  ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
              })
            : {}),
    };

    const promptSurfaceRuntime =
        args.promptSurfaceRuntime ??
        createPromptSurfaceRuntime({
            harness: "opencode",
            directory: ctx.directory,
            warn: (message) => log(`[magic-context] config warning: ${message}`),
        });
    // OpenCode materializes this map once per plugin process. Resolve only the
    // registration owner's default here: model/session routes cannot safely swap
    // provider tool text because the host exposes no session identity at this seam.
    const registration = promptSurfaceRuntime.resolveRegistration(
        args.registrationPromptSurface ?? pluginConfig.prompt_surface,
    );
    // Smart notes need both smart_notes.enabled and a runnable dreamer, which
    // evaluates their conditions; without either, ctx_note is surfaced without
    // its surface_condition argument and smart-note text.
    const smartNotesAvailable = isSmartNoteSurfaceAvailable(pluginConfig);
    const surfacedTools = Object.fromEntries(
        Object.entries(allTools).map(([toolId, definition]) => {
            const parameterDescriptions = parameterDescriptionsFor(
                toolId,
                registration.preset,
                smartNotesAvailable,
            );
            const argsWithPresetDescriptions = parameterDescriptions
                ? Object.fromEntries(
                      Object.entries(definition.args).map(([name, schema]) => [
                          name,
                          parameterDescriptions[name]
                              ? (
                                    schema as typeof schema & {
                                        describe(description: string): typeof schema;
                                    }
                                ).describe(parameterDescriptions[name])
                              : schema,
                      ]),
                  )
                : definition.args;
            return [
                toolId,
                {
                    ...definition,
                    args: argsWithPresetDescriptions,
                    description:
                        toolId === "ctx_note" && !smartNotesAvailable
                            ? withoutSmartNoteText(
                                  registration.preset === "light"
                                      ? CTX_NOTE_LIGHT_DESCRIPTION
                                      : (definition.description ?? ""),
                              )
                            : registration.descriptionFor(toolId, definition.description ?? ""),
                },
            ];
        }),
    ) as Record<string, ToolDefinition>;

    // Patch arg schemas so property-level .describe() text survives JSON Schema serialization.
    // Without this, the LLM sees bare types with no description for each parameter.
    for (const toolDefinition of Object.values(surfacedTools)) {
        normalizeToolArgSchemas(toolDefinition);
    }

    return guardSubagentTools(
        surfacedTools,
        db,
        (id) => args.internalChildSessions?.has(id) === true,
    );
}
