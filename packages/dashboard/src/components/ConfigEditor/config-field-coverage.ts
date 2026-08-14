// Single source of truth for which magic-context config fields the dashboard
// ConfigEditor surfaces. Enforced by config-parity.test.ts against the
// generated assets/magic-context.schema.json: every schema leaf must be either
// RENDERED by the form or explicitly OMITTED_BY_DESIGN here. A newly-added
// schema field that is neither fails CI — which is the mechanism that stops the
// dashboard form from silently drifting out of sync with the plugin schema (the
// failure mode that left the `experimental.*` namespace rendering long after it
// was graduated).
//
// A schema leaf `L` is covered by an entry `P` when `L === P` or
// `L.startsWith(P + ".")`, so an object prefix (e.g. "embedding") covers all of
// its children when the form renders the whole subtree.

/**
 * Path prefixes the form actually renders. Keep in sync with the JSX below it
 * in this directory. Once the form becomes schema-driven this list can be
 * derived instead of hand-maintained.
 */
export const RENDERED_PREFIXES: readonly string[] = [
  // General
  "enabled",
  "allow_home_project",
  "language",
  "toast_duration_ms",
  // Mural
  "mural",
  // Thresholds (custom PerModelField widgets)
  "cache_ttl",
  "output_reserve",
  "execute_threshold_percentage",
  "execute_threshold_tokens",
  // Tags & cleanup
  "protected_tags",
  "clear_reasoning_age",
  // Historian
  "history_budget_percentage",
  "historian_timeout_ms",
  "historian.model",
  "historian.fallback_models",
  "commit_cluster_trigger",
  // Dreamer (panel renders a curated subset of the agent-override schema)
  "dreamer.model",
  "dreamer.fallback_models",
  "dreamer.disable",
  "dreamer.inject_docs",
  // Dreamer v2 per-task editor (DreamerTasksField) renders the whole tasks
  // subtree: per-task schedule preset/custom, model override, and task-specific
  // params (promotion_threshold, token_budget, min_reads).
  "dreamer.tasks",
  // Sidekick (panel renders a curated subset)
  "sidekick.model",
  "sidekick.fallback_models",
  "sidekick.disable",
  "sidekick.timeout_ms",
  // Embedding (whole subtree)
  "embedding",
  // Memory
  "memory.enabled",
  "memory.injection_budget_tokens",
  "memory.auto_promote",
  "memory.retrieval_count_promotion_threshold",
  "memory.auto_search",
  "memory.git_commit_indexing",
  // History & recall features (graduated out of experimental.* in v0.22.0)
  "temporal_awareness",
  "caveman_text_compression",
  // Advanced
  "auto_update",
  "keep_subagents",
  "todowrite",
  "prompt_surface",
  "smart_drops",
  "sqlite",
  "storage.enforce_private_permissions",
  "compaction.enabled",
  "pi.subagent_extensions",
  "system_prompt_injection.enabled",
];

/**
 * Fields intentionally absent from the form — editable via the raw JSONC editor
 * only. Each entry carries a reason so a future maintainer (or audit) sees the
 * omission was deliberate, not forgotten.
 */
export const OMITTED_BY_DESIGN: Readonly<Record<string, string>> = {
  ...agentOverrideTailOmissions(),
  "historian.disable":
    "historian is core to magic-context; disabling it is an advanced raw-JSONC choice, not a form toggle",
  "historian.two_pass": "advanced historian tuning; raw JSONC",
  "historian.disallowed_tools": "advanced historian tuning; raw JSONC",
  "sidekick.system_prompt": "free-form prompt override; raw JSONC",
  "system_prompt_injection.skip_signatures":
    "free-form substring array; raw JSONC (no array widget in the form yet)",
  subc: "user-only subc daemon routing; raw JSONC because project configs cannot provide this connection",
  shadow_embedding: "developer-only shadow embedding lane; raw JSONC and never a dashboard knob",
  transform_mode:
    "experimental project-wide Rust runtime cutover; requires user-level subc configuration and is not exposed in the dashboard yet",
  fail_closed_blocking:
    "user-only inoperability policy; raw JSONC because project configs cannot change it",
  "smart_notes.retina_handoff":
    "external-events plane flip; stays raw JSONC until the retina consumer ships and the flag has a user-facing meaning",
  // Listed as the exact leaf rather than omitting the whole `models` subtree, so
  // a future sibling field still trips this gate instead of being absorbed by a
  // prefix match.
  "models.window_overlay_path":
    "user-only Fusiform overlay path; raw JSONC because it is a filesystem location with a computed default (<dataDir>/fusiform/window-overlay.json), not a value worth a form widget",
};

/**
 * The shared AgentOverride schema gives historian/dreamer/sidekick a long tail
 * of advanced knobs (sampling, prompt, tool/permission overrides, etc.). The
 * form surfaces only the high-signal ones per agent; the rest are raw-JSONC by
 * design. Generated for all three agents from one list so adding a new
 * agent-override field classifies consistently.
 */
function agentOverrideTailOmissions(): Record<string, string> {
  const tail = [
    "temperature",
    "top_p",
    "prompt",
    "tools",
    "description",
    "mode",
    "color",
    "maxSteps",
    "permission",
    "maxTokens",
    "variant",
    "thinking_level",
  ];
  const agents = ["historian", "dreamer", "sidekick"];
  const out: Record<string, string> = {};
  for (const agent of agents) {
    for (const field of tail) {
      out[`${agent}.${field}`] = "advanced agent-override knob; raw JSONC";
    }
  }
  return out;
}

/** True when `leaf` is covered by `prefix` (exact match or a dotted descendant). */
export function isCoveredBy(leaf: string, prefix: string): boolean {
  return leaf === prefix || leaf.startsWith(`${prefix}.`);
}
