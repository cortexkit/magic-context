import { log } from "../shared/logger";

/**
 * Permission rulesets for Magic Context's hidden subagents.
 *
 * # Why this exists
 *
 * Hidden agents (`historian`, `historian-editor`, `dreamer`) are
 * registered with `mode: "primary"` and `hidden: true`: primary mode keeps
 * them out of OpenCode's general Task candidate list, while hidden keeps them
 * out of the UI picker. Those flags do NOT restrict which tools the spawned
 * session can call. By default a registered agent
 * inherits the FULL primary-agent tool surface: `task`, `bash`, `edit`,
 * `webfetch`, `websearch`, `read`, `grep`, `glob`, every MCP tool, etc.
 *
 * That default is wrong for our agents:
 *   - Historian should be a pure XML-emitting summarizer. It must not
 *     dispatch `task(subagent_type=explore)` to fan out, edit files,
 *     run bash, or fetch the web — it receives all reference state inline
 *     and emits `<compartment>` blocks without tools.
 *   - The `task` permission only gets auto-denied when an agent is
 *     INVOKED via the parent's `task()` tool (see OpenCode's
 *     `deriveSubagentSessionPermission`). Our hidden agents are spawned
 *     directly via `client.session.prompt(...)` from the plugin
 *     runtime, so that auto-deny never fires — they get the same
 *     `task` permission as a primary `build` agent.
 *
 * # Design
 *
 * Each hidden agent's `permission` field starts with `{ "*": "deny" }`
 * and adds explicit `allow` entries for ONLY the tool ids it needs.
 * OpenCode's `Permission.fromConfig` converts this flat map into a
 * `Rule[]` ruleset where later entries override earlier ones, so the
 * named allows always win against the wildcard deny.
 *
 * This is the same pattern OpenCode's own `explore` subagent uses
 * (see `packages/opencode/src/agent/agent.ts:179-201`).
 *
 * Locked hidden agents discard user tools and permission overrides so their
 * capability boundaries cannot be broadened. Unlocked agents may merge overrides.
 *
 * # What each agent needs
 *
 *   - **historian / historian-recomp / historian-editor**: no tools. Each pass
 *     receives its transcript and bounded reference state in the prompt.
 *
 *   - **dreamer**: `read`, `grep`, `glob`, `bash`, `write`, `edit`, the
 *     read-only AFT navigation/search tools `aft_outline`, `aft_zoom`,
 *     `aft_search`, plus the Magic Context MCP tools `ctx_memory`,
 *     `ctx_search`, `ctx_note`.
 *     Dreamer task prompts in
 *     `features/magic-context/dreamer/task-prompts.ts` explicitly tell
 *     the model to grep schema files for defaults, read source to
 *     confirm claims, run `git log` / `gh` / `curl` for verify and
 *     smart-note evaluation, and use glob/find for directory
 *     inventory. Live DB shows >100 bash invocations across all
 *     dreamer task variants. `task` / `edit` / `write` / `webfetch` /
 *     `websearch` remain denied — dreamer must not spawn subagents
 *     or commit changes.
 */

/**
 * Build a `permission` map suitable for `AgentConfig.permission`. Starts
 * with a wildcard deny, then layers in the named tool allows on top.
 * OpenCode's `Permission.fromConfig` preserves insertion order and its
 * `evaluate` uses `findLast`, so named allows defeat the wildcard deny.
 *
 * Returns `Record<string, "deny" | "allow">` which the SDK's
 * `AgentConfig.permission` type accepts via its `[key: string]: unknown`
 * index signature. The same pattern is used by OpenCode's built-in
 * `explore`/`scout`/`general` agents and by Alfonso for its static
 * agent profiles.
 */
export function buildAllowOnlyPermission(
    allowedTools: readonly string[] | undefined,
    agentLabel?: string,
): Record<string, "deny" | "allow"> {
    const permission: Record<string, "deny" | "allow"> = { "*": "deny" };
    // Defensive: never throw on an undefined allow-list. A `for..of` on undefined
    // crashes with "undefined is not an object (evaluating 'allowedTools')", and
    // because this runs inside the plugin's `config` hook a throw there fails the
    // ENTIRE plugin load — disabling the transform/compaction. Degrade to a
    // deny-all agent instead of taking Magic Context down.
    if (allowedTools === undefined) {
        // Observed only inside OpenCode's plugin loader (never in an isolated
        // import of the same dist), so capture WHICH agent + a stack to pin the
        // real cause on the next natural restart. Should never fire.
        log(
            `[magic-context] buildAllowOnlyPermission: allow-list UNDEFINED for ${agentLabel ?? "unknown agent"} — registering deny-all (defensive)`,
            { stackHead: new Error().stack?.split("\n").slice(1, 6).join("\n") },
        );
    }
    for (const tool of allowedTools ?? []) {
        permission[tool] = "allow";
    }
    return permission;
}

type PermissionAction = "ask" | "allow" | "deny";

function isPermissionAction(value: unknown): value is PermissionAction {
    return value === "ask" || value === "allow" || value === "deny";
}

function isPermissionMap(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Add final `permission.task` denies for Magic Context's internal workers.
 *
 * OpenCode accepts either a whole-permission action or a pattern map for
 * `permission.task`; its visibility evaluator uses the last matching rule.
 * Normalize the whole-permission form, retain unrelated user rules, then append
 * our exact agent-id denies. When the ambient task policy is a wildcard deny
 * whose only companions are our own appended agent-id denies, re-emit that
 * wildcard after the named denies so the Task tool is hidden rather than shown
 * as a callable-but-refused tool. When the wildcard deny sits next to any of
 * the agent's own rules (the deny-by-default-with-exceptions shape), keep the
 * agent's own ordering untouched: OpenCode resolves with the last matching
 * rule, so moving the wildcard to the end there would override every named
 * allow and empty the Task tool (#777).
 */
export function denyTaskRoutingToAgents(
    permission: unknown,
    internalAgentIds: readonly string[],
): Record<string, unknown> {
    const configured = isPermissionAction(permission)
        ? { "*": permission }
        : isPermissionMap(permission)
          ? permission
          : {};
    const { task, ...otherPermissions } = configured;
    const configuredTask = isPermissionAction(task)
        ? { "*": task }
        : isPermissionMap(task)
          ? task
          : {};
    const internalAgentIdSet = new Set(internalAgentIds);
    const hasAmbientWildcardDeny = configuredTask["*"] === "deny";
    // Only our own appended agent-id denies may accompany the wildcard for the
    // move to stay correct — a user's named allow next to it must keep winning.
    // Excluding internal ids here also keeps re-merging our own output
    // idempotent: that output is exactly internal denies plus the wildcard.
    const movesAmbientWildcardDeny =
        hasAmbientWildcardDeny &&
        Object.keys(configuredTask).every(
            (agentId) => agentId === "*" || internalAgentIdSet.has(agentId),
        );
    const retainedTask = Object.fromEntries(
        Object.entries(configuredTask).filter(
            ([agentId]) =>
                !internalAgentIdSet.has(agentId) && (agentId !== "*" || !movesAmbientWildcardDeny),
        ),
    );

    return {
        ...otherPermissions,
        task: {
            ...retainedTask,
            ...Object.fromEntries(internalAgentIds.map((agentId) => [agentId, "deny"])),
            // OpenCode's Permission.disabled uses findLast. Re-inserting the
            // ambient wildcard after our named routing denies keeps its whole-tool
            // deny as the final match and makes the Task tool invisible — but
            // only when it stood alone; with named rules the agent's own
            // ordering must win (#777).
            ...(movesAmbientWildcardDeny ? { "*": "deny" } : {}),
        },
    };
}

const BUILTIN_TASK_CALLER_IDS = ["build", "plan"] as const;

function isTaskRoutingCaller(agentId: string, config: Record<string, unknown>): boolean {
    const mode = config.mode;
    // OpenCode compatibility:
    // Only strictly-primary callers receive explicit Task routing rules.
    // Agents that may execute as Task children are intentionally left untouched,
    // because explicit task permissions can alter OpenCode's default anti-nesting
    // behavior in the currently supported permission model.
    if (mode === "primary") return true;
    if (mode === "subagent" || mode === "all") return false;
    return agentId === "build" || agentId === "plan";
}

/**
 * Apply Task routing denies only to agents that can act as Task callers.
 *
 * A top-level permission rule is merged into every OpenCode agent. Adding one
 * there would suppress the Task tool's default deny for ordinary subagents, so
 * seed only the built-in interactive callers and configured primary agents.
 */
export function denyTaskRoutingToCallerAgents(
    agentConfigs: Record<string, Record<string, unknown>>,
    internalAgentIds: readonly string[],
): Record<string, Record<string, unknown>> {
    const result = { ...agentConfigs };
    const candidateIds = new Set([...BUILTIN_TASK_CALLER_IDS, ...Object.keys(agentConfigs)]);

    for (const agentId of candidateIds) {
        const agentConfig = agentConfigs[agentId] ?? {};
        if (!isTaskRoutingCaller(agentId, agentConfig)) continue;
        result[agentId] = {
            ...agentConfig,
            permission: denyTaskRoutingToAgents(agentConfig.permission, internalAgentIds),
        };
    }

    return result;
}

/** Historians summarize the supplied transcript; no file access or tools are needed. */
export const HISTORIAN_ALLOWED_TOOLS = [] as const;

/**
 * Subtract `disallowed` from the default historian allow-list. `"*"` removes
 * all tools. Unknown tool names are silently ignored (the Zod enum in the
 * config schema rejects them at parse time, so this is defense-in-depth).
 */
export function applyDisallowedTools(
    defaults: readonly string[],
    disallowed: readonly string[],
): readonly string[] {
    if (disallowed.includes("*")) return [];
    return defaults.filter((t) => !disallowed.includes(t));
}

// The old kitchen-sink DREAMER_ALLOWED_TOOLS is retired: each dreamer task now
// runs on its own scoped agent. Curate uses DREAMER_CURATE_ALLOWED_TOOLS
// (ctx_memory only) and maintain-docs uses DREAMER_DOCS_ALLOWED_TOOLS (file
// read/write/bash, no memory) — both in `dreamer.ts` alongside the other
// per-task allow-lists (mapper/classifier/etc).

export const DREAMER_RETROSPECTIVE_ALLOWED_TOOLS = ["ctx_search"] as const;

/**
 * The refresh-primers code investigator: read + navigate + search the CURRENT
 * source to answer a primer question. NO write/edit/bash (could corrupt user
 * source) and NO ctx_memory/ctx_note (a ctx_memory mutation bumps the project
 * memory epoch → busts m[0], breaking the primers cache-neutral contract).
 */
export const DREAMER_PRIMER_INVESTIGATOR_ALLOWED_TOOLS = [
    "read",
    "grep",
    "glob",
    "aft_outline",
    "aft_zoom",
    "aft_search",
    "ctx_search",
] as const;

/**
 * The smart-note compiler consumes untrusted note text and emits code that will
 * later run in the QuickJS sandbox. It must not have ambient tools: all I/O is
 * performed only when the compiled check runs through the host capability API.
 */
export const SMART_NOTE_COMPILER_ALLOWED_TOOLS = [] as const;
