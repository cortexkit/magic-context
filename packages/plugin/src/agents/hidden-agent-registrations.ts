import { applyDisallowedTools, buildAllowOnlyPermission } from "./permissions";

/**
 * Hidden-agent registration builders.
 *
 * # Why this lives in its own module (NOT in the plugin entry `index.ts`)
 *
 * OpenCode loads a plugin module and, for the legacy plugin shape (a function
 * `default` export rather than a `{ server, tui }` object), treats EVERY
 * exported function in that module as a plugin factory and invokes it with the
 * plugin input `{ client, directory, ... }` (see opencode
 * `plugin/index.ts` → `getLegacyPlugins`). magic-context uses that legacy shape.
 *
 * If `buildHiddenAgentRegistrations` is exported from the entry module it gets
 * called by the loader as `buildHiddenAgentRegistrations(pluginInput)` — with
 * the wrong argument — so `args.historianDisallowed` is `undefined` and
 * `applyDisallowedTools([...], undefined)` throws
 * `undefined is not an object (evaluating 'disallowed.includes')`, which fails
 * the WHOLE plugin load. Keeping these helpers out of the entry module means the
 * entry module's only export is `default` (the real plugin factory); these
 * builders are still bundled (inlined) into `dist/index.js`, just never treated
 * as plugin factories.
 */

// Clamp a user-provided step override to the hidden-agent's built-in cap (loop
// insurance — see buildHiddenAgentConfig). Caps live as inline literals in
// buildHiddenAgentRegistrations (historian=40, dreamer=150): a handful
// of tool calls for the historian, a real multi-step maintenance loop
// for the dreamer.
function clampHiddenAgentStepLimit(value: unknown, cap: number): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.min(value, cap) : cap;
}

/**
 * Static registration data for one hidden agent. The id / allow-list / step cap
 * are INLINE LITERALS in {@link buildHiddenAgentRegistrations} rather than
 * cross-module `const` imports.
 *
 * # Why inline
 *
 * Belt-and-suspenders, not the load-bearing fix. The load failure was caused by
 * exporting helpers from the entry module (see the module header) — that is what
 * the entry-only-`default` rule fixes. Inlining the small id/tool/step values
 * additionally removes any dependency on cross-module top-level `const` init
 * timing, so this builder returns a complete, valid registration set the instant
 * it is called regardless of module-evaluation order. Cheap insurance for a path
 * that runs once per plugin-instance boot.
 *
 * The only value that cannot be inlined is the multi-KB generated system prompt;
 * it stays a module `var` and is guarded at the call site (skip the agent + log
 * if undefined, never register a broken/deny-all agent).
 *
 * `agent-registration-drift.test.ts` asserts the inline literals here stay
 * byte-identical to the canonical exported constants so they can't silently
 * diverge.
 */
export const HIDDEN_AGENT_DESCRIPTION_MARKER = "Internal Magic Context";
let internalAgentNames: ReadonlySet<string> | undefined;

export function isMagicContextInternalAgentName(name: string | undefined): boolean {
    if (!name) return false;
    internalAgentNames ??= new Set(
        buildHiddenAgentRegistrations({
            dreamerPrompt: undefined,
            historianPrompt: undefined,
            historianEditorPrompt: undefined,
            historianDisallowed: [],
        }).map((agent) => agent.id),
    );
    return internalAgentNames.has(name);
}

const HIDDEN_AGENT_DESCRIPTION =
    "Internal Magic Context maintenance agent. Not for general tasks — do not select for user work.";

export interface HiddenAgentRegistration {
    id: string;
    /** OpenCode's task registry excludes primary agents from general subagent routing. */
    mode: "primary";
    /** Hidden agents stay out of the UI picker while remaining directly resolvable. */
    hidden: true;
    /** Description used by OpenCode's automatic name/description-based task router; keep it generic so this hidden agent is not selected for unrelated tasks. */
    description: string;
    prompt: string | undefined;
    allowedTools: readonly string[];
    maxSteps: number;
    overrides?: Record<string, unknown>;
    /** Drop any user `permission` override (privacy-critical agents only). */
    lockPermissions?: boolean;
}

/**
 * Hoisted function declaration: returns the hidden-agent registrations with
 * INLINE id / allow-list / step-cap literals (see {@link HiddenAgentRegistration}
 * for why these must not come from module-level `var` consts). Prompts and
 * computed overrides are passed in by the caller; the historian disallow filter
 * is applied here against an inline default allow-list.
 */
export function buildHiddenAgentRegistrations(args: {
    dreamerPrompt: string | undefined;
    smartNoteCompilerPrompt?: string | undefined;
    historianPrompt: string | undefined;
    historianRecompPrompt?: string | undefined;
    historianEditorPrompt: string | undefined;
    dreamerOverrides?: Record<string, unknown>;
    historianOverrides?: Record<string, unknown>;
    historianDisallowed: readonly string[];
}): HiddenAgentRegistration[] {
    const historianAllowedTools = applyDisallowedTools(
        ["read", "aft_outline", "aft_zoom", "aft_search"],
        args.historianDisallowed,
    );
    return [
        {
            id: "dreamer",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.dreamerPrompt,
            // CURATE-ONLY now. Curate edits the memory store via ctx_memory and
            // never reads code (a separate verify task owns memory-vs-code
            // correctness), so it needs only ctx_memory — not the former
            // bash/write/edit/read/aft/ctx_search/ctx_note surface. maintain-docs
            // and review-user-memories moved to their own scoped agents below.
            // (Inline literal — kept byte-identical to DREAMER_CURATE_ALLOWED_TOOLS
            // by agent-registration-drift.test.ts; see the module header for why
            // these are not const imports.)
            allowedTools: ["ctx_memory"],
            // Curate is a genuine multi-step whole-pool hygiene loop, so it keeps a
            // high cap.
            maxSteps: 150,
            overrides: args.dreamerOverrides,
            // Lock the curate tool surface: a user dreamer `tools`/`permission`
            // override must not re-grant bash/write/edit to this unsupervised
            // memory-hygiene agent. Model/temperature overrides still apply.
            lockPermissions: true,
        },
        {
            id: "dreamer-docs",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.dreamerPrompt,
            // maintain-docs: explore code + write/edit ARCHITECTURE.md/STRUCTURE.md
            // + bash (git log, find). NO ctx_memory/ctx_search/ctx_note — it edits
            // docs, never the memory store. (Inline literal — kept byte-identical to
            // DREAMER_DOCS_ALLOWED_TOOLS by agent-registration-drift.test.ts.)
            allowedTools: [
                "read",
                "grep",
                "glob",
                "bash",
                "write",
                "edit",
                "aft_outline",
                "aft_zoom",
                "aft_search",
            ],
            // Docs maintenance reads the tree and writes two files — a bounded loop,
            // not the whole-pool 150.
            maxSteps: 60,
            overrides: args.dreamerOverrides,
            // Lock so a user override can't add the memory surface back.
            lockPermissions: true,
        },
        {
            id: "dreamer-reviewer",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.dreamerPrompt,
            // review-user-memories: a pure JSON reviewer of behavioral observations.
            // It calls NO tools — the host applies its verdict — so zero tools,
            // locked (mirrors dreamer-classifier).
            allowedTools: [],
            maxSteps: 4,
            overrides: args.dreamerOverrides,
            lockPermissions: true,
        },
        {
            id: "dreamer-retrospective",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.dreamerPrompt,
            allowedTools: ["ctx_search"],
            maxSteps: 40,
            overrides: args.dreamerOverrides,
            // Privacy-critical: this child reads OTHER sessions' raw user text.
            // Lock it to ctx_search-only — a user dreamer `permission` override
            // must never broaden it.
            lockPermissions: true,
        },
        {
            id: "dreamer-primer-investigator",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.dreamerPrompt,
            // Read-only code investigation: read/navigate/search the CURRENT
            // source to answer a primer. Deliberately NO write/edit/bash (could
            // corrupt user source) and NO ctx_memory/ctx_note (ctx_memory
            // update/archive/merge bumps the project memory epoch → busts m[0],
            // violating the primers cache-neutral contract).
            allowedTools: [
                "read",
                "grep",
                "glob",
                "aft_outline",
                "aft_zoom",
                "aft_search",
                "ctx_search",
            ],
            // Tight read-only-lookup budget — NOT the dreamer's 150. A single
            // primer is a targeted investigation, not a whole-pool maintenance
            // loop; it also bounds the per-primer cost of an unsupervised run.
            maxSteps: 40,
            overrides: args.dreamerOverrides,
            // A user dreamer `permission`/`tools` override must never re-grant the
            // denied write/bash/ctx_memory surface to this unsupervised agent.
            lockPermissions: true,
        },
        {
            id: "dreamer-memory-mapper",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.dreamerPrompt,
            // Read-only local-source reader for map-memories / verify: open and
            // check the CURRENT source. NO write/edit/bash (could corrupt user
            // source), NO ctx_memory (mutations bump the project memory epoch →
            // bust m[0]; the host applies the manifest's DB writes itself), and NO
            // ctx_search (these tasks check against local code, not cross-session
            // recall).
            allowedTools: ["read", "grep", "glob", "aft_outline", "aft_zoom", "aft_search"],
            // Bounded read-only-lookup budget (mirrors the primer investigator) —
            // NOT the dreamer's 150. A map/verify batch is a targeted file-lookup
            // pass, and this bounds the per-batch cost of an unsupervised run.
            maxSteps: 60,
            overrides: args.dreamerOverrides,
            // A user dreamer `permission`/`tools` override must never re-grant the
            // denied write/bash/ctx_memory surface to this unsupervised agent.
            lockPermissions: true,
        },
        {
            id: "dreamer-classifier",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.dreamerPrompt,
            // ZERO tools: classify scores importance/scope/shareable from the
            // memory text alone (no code inspection), emits ONE XML manifest, and
            // the host applies the column writes. A pure transform — no tool can
            // help it, and locking prevents a user override from granting one.
            allowedTools: [],
            maxSteps: 4,
            overrides: args.dreamerOverrides,
            lockPermissions: true,
        },
        {
            id: "smart-note-compiler",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.smartNoteCompilerPrompt,
            allowedTools: [],
            maxSteps: 8,
            overrides: args.dreamerOverrides,
            // Security-critical: condition text is untrusted prompt data; never
            // let user dreamer overrides grant tools to the compiler.
            lockPermissions: true,
        },
        {
            id: "historian",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.historianPrompt,
            allowedTools: historianAllowedTools,
            maxSteps: 40,
            overrides: args.historianOverrides,
        },
        {
            id: "historian-recomp",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.historianRecompPrompt ?? args.historianPrompt,
            allowedTools: historianAllowedTools,
            maxSteps: 40,
            overrides: args.historianOverrides,
        },
        {
            id: "historian-editor",
            mode: "primary",
            hidden: true,
            description: HIDDEN_AGENT_DESCRIPTION,
            prompt: args.historianEditorPrompt,
            allowedTools: historianAllowedTools,
            maxSteps: 40,
            overrides: args.historianOverrides,
        },
    ];
}

/**
 * Build a hidden-agent config with a deny-everything-by-default permission
 * baseline and a hard tool-iteration ceiling. User overrides may lower
 * `steps`/`maxSteps`, but cannot raise either above the built-in cap.
 */
export function buildHiddenAgentConfig(
    prompt: string,
    allowedTools: readonly string[],
    maxSteps: number,
    overrides?: Record<string, unknown>,
    agentLabel?: string,
    lockPermissions = false,
    description?: string,
) {
    const {
        permission: overridePermission,
        tools: overrideTools,
        // Pulled out so they can be conditionally re-added: under lockPermissions
        // a user `prompt`/`system` override must NOT replace the hardened
        // system prompt (see below). Spreading `...rest` below would otherwise
        // clobber the positional `prompt` arg, since `...rest` lands after it.
        prompt: overridePrompt,
        system: overrideSystem,
        ...rest
    } = (overrides ?? {}) as {
        permission?: Record<string, unknown>;
        tools?: Record<string, boolean>;
        prompt?: unknown;
        system?: unknown;
        [key: string]: unknown;
    };
    // When locked (privacy-critical agents), the user `tools` enable/disable map
    // AND the `prompt`/`system` text are ALL dropped — each is a
    // privilege/behavior-escalation surface. A user `dreamer.tools: { bash: true }`
    // would otherwise re-enable a denied tool; a user `dreamer.prompt`/`system`
    // would otherwise replace the privacy-hardened prompt that, e.g., keeps the
    // retrospective agent from transcribing raw user text. Unlocked agents keep
    // their `tools`/`prompt`/`system` overrides.
    const promptOverrides: Record<string, unknown> = lockPermissions
        ? {}
        : {
              ...(overridePrompt !== undefined ? { prompt: overridePrompt } : {}),
              ...(overrideSystem !== undefined ? { system: overrideSystem } : {}),
          };
    const restOverrides: Record<string, unknown> = lockPermissions
        ? { ...rest, ...promptOverrides }
        : {
              ...rest,
              ...promptOverrides,
              ...(overrideTools !== undefined ? { tools: overrideTools } : {}),
          };
    const basePermission = buildAllowOnlyPermission(allowedTools, agentLabel);
    return {
        prompt,
        // No builtin fallback chain: the user's `fallback_models` (if any) flow
        // through `restOverrides`. A hardcoded chain names providers the user may
        // not have, producing `Model not found` retry storms.
        ...restOverrides,
        steps: clampHiddenAgentStepLimit(restOverrides.steps, maxSteps),
        maxSteps: clampHiddenAgentStepLimit(restOverrides.maxSteps, maxSteps),
        // Permission baseline goes after `restOverrides` so that accidental
        // `permission` keys in user overrides we DIDN'T explicitly destructure
        // can't bypass the deny. The explicit override (destructured above) is
        // then layered on top — UNLESS lockPermissions is set, in which case the
        // user override is dropped entirely. lockPermissions is for
        // privacy-critical agents (dreamer-retrospective reads other sessions'
        // raw user text and MUST stay ctx_search-only; a user dreamer `permission`
        // override must never grant it bash/edit/ctx_memory/etc).
        permission: {
            ...basePermission,
            ...(lockPermissions ? {} : (overridePermission ?? {})),
        },
        mode: "primary" as const,
        hidden: true,
        ...(description !== undefined ? { description } : {}),
    };
}
