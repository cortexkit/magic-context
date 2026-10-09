import { TASKS } from "./DreamerTasksField";

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
  // Memory & search
  "mural",
  // Context window (defaults and compact PerModelTable)
  "cache_ttl",
  "output_reserve",
  "execute_threshold_percentage",
  "execute_threshold_tokens",
  "protected_tools",
  // Tags & cleanup
  "protected_tokens",
  "keep_reasoning_tokens",
  // Historian
  "history_budget_percentage",
  "historian_timeout_ms",
  // Background models: only execution fields, not arbitrary agent metadata.
  ...["historian", "dreamer"].flatMap((agent) =>
    ["opencode", "pi", "omp"].flatMap((harness) =>
      ["model", "fallback_models", harness === "opencode" ? "variant" : "thinking_level"].map(
        (field) => `${agent}.${harness}.${field}`,
      ),
    ),
  ),
  "commit_cluster_trigger",
  "dreamer.disable",
  "dreamer.inject_docs",
  ...TASKS.map((task) => `dreamer.tasks.${task.name}.schedule`),
  "dreamer.tasks.review-user-memories.promotion_threshold",
  "dreamer.tasks.promote-primers.promotion_threshold",
  // These are schema map leaves. The table edits model/qualifier entries only;
  // task fallback_models and timeout_minutes remain available in Raw JSONC.
  ...["opencode", "pi", "omp"].map((harness) => `dreamer.${harness}.tasks`),
  // Only the embedding controls actually present in the form.
  "embedding.provider",
  "embedding.local_dtype",
  "embedding.model",
  "embedding.endpoint",
  "embedding.api_key",
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
  clear_reasoning_age: "deprecated and ignored; doctor removes it",
  ...Object.fromEntries(
    ["historian", "dreamer"].flatMap((agent) =>
      [
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
        "runner",
      ].map((field) => [
        `${agent}.${field}`,
        "advanced agent metadata; preserved by structured edits and editable in Raw JSONC",
      ]),
    ),
  ),
  "historian.disable": "advanced agent registration control; raw JSONC",
  "historian.expand_tools": "custom tool expansion templates; raw JSONC",
  "historian.host_runner": "advanced host runner ownership; raw JSONC",
  "historian.two_pass": "advanced historian editor pass; raw JSONC",
  "historian.disallowed_tools": "legacy compatibility option; raw JSONC",
  ...Object.fromEntries(
    TASKS.map((task) => [
      `dreamer.tasks.${task.name}.token_budget`,
      "advanced investigation budget; raw JSONC",
    ]),
  ),
  "dreamer.tasks.retrospective.recency_days": "advanced retrospective source window; raw JSONC",
  "dreamer.tasks.maintain-docs.max_tokens": "advanced docs proposal limit; raw JSONC",
  "embedding.fallback_provider": "advanced Synapse fallback lane; raw JSONC",
  "embedding.input_type": "provider-specific request setting; raw JSONC",
  "embedding.query_input_type": "asymmetric embedding request setting; raw JSONC",
  "embedding.query_instruction": "advanced query prefix override; raw JSONC",
  "embedding.document_prefix": "advanced stored-document prefix; raw JSONC",
  "embedding.truncate": "provider-specific truncate mode; raw JSONC",
  "embedding.max_input_tokens": "advanced embedding chunk limit; raw JSONC",
  "embedding.local_runtime": "advanced ONNX runtime selection; raw JSONC",
  profile:
    "per-repository model-profile selector; deferred until the Alfonso Desktop profile editor is available",
  profiles:
    "user-owned model-profile definitions; deferred until the Alfonso Desktop profile editor is available",
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
  protected_tags:
    "deprecated and ignored by every runtime; retained only so existing files receive a migration warning",
  smart_drops: "deprecated and ignored; supersession is always on and old configs remain loadable",
  debug_rpc:
    "developer-only diagnostics toggle (memory/heap endpoints on the local RPC); never a dashboard knob",
};

/** True when `leaf` is covered by `prefix` (exact match or a dotted descendant). */
export function isCoveredBy(leaf: string, prefix: string): boolean {
  return leaf === prefix || leaf.startsWith(`${prefix}.`);
}
