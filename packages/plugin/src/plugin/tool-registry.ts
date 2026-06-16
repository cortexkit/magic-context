import type { ToolDefinition } from "@opencode-ai/plugin";
import type { MagicContextPluginConfig } from "../config";
import { isCompactionEnabled, isDreamerRunnable } from "../config/agent-disable";
import { DEFAULT_PROTECTED_TAGS } from "../features/magic-context/defaults";
import { resolveProjectIdentityForSession } from "../features/magic-context/memory/project-identity";
import type { SkillLoadRegistry } from "../features/magic-context/skill-memory/provenance";
import {
    getDatabasePersistenceError,
    isDatabasePersisted,
    openDatabase,
} from "../features/magic-context/storage";
import { setCtxReduceRegisteredGlobally } from "../hooks/magic-context/ctx-reduce-availability";
import { getErrorMessage } from "../shared/error-message";
import { log } from "../shared/logger";
import type { PromptSurfaceConfig } from "../shared/prompt-surface";
import type { PromptSurfaceRuntime } from "../shared/prompt-surface-runtime";
import { createPromptSurfaceRuntime } from "../shared/prompt-surface-runtime";
import type { Database } from "../shared/sqlite";
import { createCtxExpandTools } from "../tools/ctx-expand";
import { CTX_MEMORY_ACTIONS, createCtxMemoryTools } from "../tools/ctx-memory";
import { createCtxNoteTools } from "../tools/ctx-note";
import { createCtxReduceTools } from "../tools/ctx-reduce";
import { createCtxSearchTools } from "../tools/ctx-search";
import { CTX_SKILL_NOTE_TOOL_NAME, createCtxSkillNoteTool } from "../tools/ctx-skill-note";
import { CTX_SKILL_RECALL_TOOL_NAME, createCtxSkillRecallTool } from "../tools/ctx-skill-recall";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "./embedding-bootstrap";
import { normalizeToolArgSchemas } from "./normalize-tool-arg-schemas";
import type { RustToolBackends } from "./rust-tool-backends";
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
    rustToolBackends?: RustToolBackends;
    promptSurfaceRuntime?: PromptSurfaceRuntime;
    registrationPromptSurface?: PromptSurfaceConfig;
    skillLoadRegistry: SkillLoadRegistry;
}): Record<string, ToolDefinition> {
    const { ctx, pluginConfig, rustToolBackends } = args;

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

    // Tools resolve project per-call from `toolContext.directory` because
    // OpenCode's top-level `ctx.directory` reflects the launch dir, not the
    // session's actual working directory (e.g. when launched via
    // `opencode -s <id>` from outside the project).
    const resolveProjectPath = (directory: string) =>
        resolveProjectIdentityForSession(directory, pluginConfig.allow_home_project);

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
                  protectedTags: pluginConfig.protected_tags ?? DEFAULT_PROTECTED_TAGS,
                  rustToolBackends,
              })),
        ...createCtxExpandTools({ db }),
        ...createCtxNoteTools({
            db,
            dreamerEnabled: isDreamerRunnable(pluginConfig),
            resolveProjectPath,
            rustToolBackends,
        }),
        ...createCtxSearchTools({
            db,
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
                  rustToolBackends,
              })
            : {}),
        // ctx_skill_note: skill-specific memory tool. Reads the session-scoped
        // skillLoadRegistry to verify the skill was actually loaded this session
        // before allowing a note to be written. The fail-loud guard for a missing
        // registry lives in index.ts (the only place hooks.magicContext is in
        // scope) so a wiring regression is caught at startup, not at runtime.
        // NOT gated on memoryEnabled — skill-memory is an independent store.
        [CTX_SKILL_NOTE_TOOL_NAME]: createCtxSkillNoteTool({
            db,
            skillLoadRegistry: args.skillLoadRegistry,
        }),
        // ctx_skill_recall: explicit agent-callable recall tool. Registry-first
        // (reuses the already-parsed frontmatterConfig from the transparent path)
        // with disk-fallback for cold-start sessions where the skill hasn't been
        // loaded yet. projectDirectory is a fallback only — execute() prefers
        // toolContext.directory (the session's actual working dir) so `opencode -s`
        // from outside the project resolves correctly. No fail-loud guard needed:
        // skillLoadRegistry is optional for ctx_skill_recall.
        [CTX_SKILL_RECALL_TOOL_NAME]: createCtxSkillRecallTool({
            db,
            projectDirectory: ctx.directory,
            skillLoadRegistry: args.skillLoadRegistry,
        }),
    };

    const promptSurfaceRuntime =
        args.promptSurfaceRuntime ??
        createPromptSurfaceRuntime({
            harness: "opencode",
            directory: ctx.directory,
            warn: (message) => console.warn(`[magic-context] config warning: ${message}`),
        });
    // OpenCode materializes this map once per plugin process. Resolve only the
    // registration owner's default here: model/session routes cannot safely swap
    // provider tool text because the host exposes no session identity at this seam.
    const registration = promptSurfaceRuntime.resolveRegistration(
        args.registrationPromptSurface ?? pluginConfig.prompt_surface,
    );
    const surfacedTools = Object.fromEntries(
        Object.entries(allTools).map(([toolId, definition]) => [
            toolId,
            {
                ...definition,
                description: registration.descriptionFor(toolId, definition.description ?? ""),
            },
        ]),
    ) as Record<string, ToolDefinition>;

    // Patch arg schemas so property-level .describe() text survives JSON Schema serialization.
    // Without this, the LLM sees bare types with no description for each parameter.
    for (const toolDefinition of Object.values(surfacedTools)) {
        normalizeToolArgSchemas(toolDefinition);
    }

    return surfacedTools;
}
