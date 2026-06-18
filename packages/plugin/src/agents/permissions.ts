/**
 * Permission rulesets for Magic Context's hidden subagents.
 *
 * # Why this exists
 *
 * Hidden agents (`historian`, `historian-editor`, `dreamer`, `sidekick`) are
 * registered with `mode: "subagent"` and `hidden: true`, but those flags
 * only control visibility in the UI picker — they do NOT restrict which
 * tools the spawned session can call. By default a registered subagent
 * inherits the FULL primary-agent tool surface: `task`, `bash`, `edit`,
 * `webfetch`, `websearch`, `read`, `grep`, `glob`, every MCP tool, etc.
 *
 * That default is wrong for our agents:
 *   - Historian should be a pure XML-emitting summarizer. It must not
 *     dispatch `task(subagent_type=explore)` to fan out, edit files,
 *     run bash, or fetch the web — its job is to read offloaded state
 *     files and emit `<compartment>` blocks.
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
 * User-supplied agent overrides (`pluginConfig.historian.permission`,
 * etc.) still merge on top via OpenCode's `Permission.merge`, so
 * advanced users can extend the allow-list without us blocking them.
 *
 * # What each agent needs
 *
 *   - **historian / historian-editor / compressor**: `read` plus the
 *     read-only AFT navigation/search tools `aft_outline`, `aft_zoom`,
 *     and `aft_search`. The runner offloads large existing-state XML to
 *     a temp file under `<project>/.opencode/magic-context/historian/`
 *     and the prompt instructs the model to read that file. AFT
 *     navigation is allowed so historian can find or verify a symbol or
 *     file structure when writing accurate compartment summaries.
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
 *
 *   - **sidekick**: `ctx_search`, plus the read-only AFT
 *     navigation tools `aft_outline` and `aft_zoom`. Sidekick's job
 *     is augmenting user prompts via memory retrieval — see
 *     `features/magic-context/sidekick/agent.ts`. AFT navigation lets
 *     it pull symbol-scoped structural context for prompts that
 *     reference a specific file or symbol.
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
    allowedTools: readonly string[],
): Record<string, "deny" | "allow"> {
    const permission: Record<string, "deny" | "allow"> = { "*": "deny" };
    for (const tool of allowedTools) {
        permission[tool] = "allow";
    }
    return permission;
}

/**
 * Tools the historian + historian-editor + compressor agents need.
 *
 * Historian runners offload large `<existing_state>` XML to disk and
 * tell the model to `read` it before emitting the summary XML. The
 * core need is `read`; we also allow the read-only AFT navigation
 * tools `aft_outline` and `aft_zoom` so that if a historian/compressor
 * ever needs to verify a symbol or skim a file's structure to write
 * an accurate compartment summary, it can do so token-efficiently
 * instead of pulling whole files via `read`.
 *
 * Still denied: bash, edit, write, task, grep/glob, webfetch/
 * websearch. Historian's job is summarizing the input it was given,
 * not exploring the repo.
 */
export const HISTORIAN_ALLOWED_TOOLS = ["read", "aft_outline", "aft_zoom", "aft_search"] as const;

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

/**
 * Tools the dreamer agent needs. This is the broadest hidden-agent
 * surface because dreamer's tasks legitimately require local-repo
 * exploration plus external command execution:
 *
 *   - `ctx_memory` / `ctx_search` / `ctx_note` — the canonical memory
 *     CRUD and retrieval path for consolidate / verify / archive /
 *     improve and smart-note dismissal.
 *   - `read` / `grep` / `glob` — the verify task prompt
 *     (`task-prompts.ts`) explicitly tells the model to grep schema
 *     files for default values, read source to confirm claimed
 *     behavior, and use glob for project structure inventory.
 *   - `bash` — required for smart-note condition evaluation (the
 *     prompt explicitly mentions `gh` / `git` / `curl` / file reads),
 *     for the verify task's `git log --oneline --since=...` step, and
 *     for the improve task's `find` / `grep` directory inventory. The
 *     live OpenCode DB shows over 100 `bash` invocations across
 *     consolidate / verify / improve / archive-stale / smart-notes
 *     dreamer child sessions, so removing it would regress real,
 *     documented dreamer behavior.
 *   - `write` / `edit` — the maintain-docs task (`task-prompts.ts`)
 *     explicitly instructs the model to "Write or update using the
 *     Write tool" to keep `ARCHITECTURE.md` / `STRUCTURE.md` at the
 *     project root synchronized. Without these tools the dreamer was
 *     forced to emit docs through `bash` heredocs/`sed` — fragile and
 *     hard to review. Granting `write` + `edit` lets it use the proper
 *     file tools (which back up + validate) instead.
 *   - `aft_search` — primary read-only code search for the verify /
 *     improve / maintain-docs tasks; finds the symbols and call sites a
 *     doc/memory rewrite must describe, more precisely than raw `grep`.
 *
 * Deliberately NOT allowed:
 *   - `task` — no subagent fanout from dreamer
 *   - `webfetch` / `websearch` — out of scope; smart-note URL fetches
 *     go through `bash` + `curl` instead
 *
 * Note: `write` / `edit` grant general file-write capability (the
 * permission gate is tool-level, not path-level). Dreamer is a trusted
 * hidden agent whose prompts scope writes to docs + memory; the
 * task-prompts still say "Do not commit changes," so it edits the
 * working tree but never commits.
 */
export const DREAMER_ALLOWED_TOOLS = [
    "read",
    "grep",
    "glob",
    "bash",
    "write",
    "edit",
    "aft_outline",
    "aft_zoom",
    "aft_search",
    "ctx_memory",
    "ctx_search",
    "ctx_note",
] as const;

/**
 * Tools the sidekick agent needs. Sidekick is a read-only memory
 * retriever for `/ctx-aug` — it queries the project's memory store
 * through `ctx_search` only. Keep `ctx_memory` out of this list because
 * its OpenCode tool definition is mutation-capable for primary agents.
 *
 * Also allow `aft_outline` and `aft_zoom` so sidekick can pull
 * lightweight structural context about a file or symbol when the
 * user's prompt references it directly — token-efficient navigation
 * without dragging in whole files.
 *
 * Still denied: spawning subagents, edits, bash, web fetches.
 */
export const SIDEKICK_ALLOWED_TOOLS = ["ctx_search", "aft_outline", "aft_zoom"] as const;
