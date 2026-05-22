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
  "ctx_reduce_enabled",
  "toast_duration_ms",
  // Thresholds (custom PerModelField widgets)
  "cache_ttl",
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
  "dreamer.schedule",
  "dreamer.inject_docs",
  "dreamer.user_memories.enabled",
  "dreamer.pin_key_files",
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
  "sqlite",
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
  "dreamer.max_runtime_minutes": "advanced dreamer scheduling; raw JSONC",
  "dreamer.tasks": "advanced dreamer task list; raw JSONC",
  "dreamer.task_timeout_minutes": "advanced dreamer scheduling; raw JSONC",
  "dreamer.user_memories.promotion_threshold": "advanced dreamer tuning; raw JSONC",
  "sidekick.system_prompt": "free-form prompt override; raw JSONC",
  "system_prompt_injection.skip_signatures":
    "free-form substring array; raw JSONC (no array widget in the form yet)",
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
