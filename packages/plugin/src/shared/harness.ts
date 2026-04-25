/**
 * Identifier for the host harness this plugin is running inside.
 *
 * Magic Context's SQLite database lives at a vendor-scoped path
 * (`~/.local/share/cortexkit/magic-context/`) so OpenCode and Pi can share
 * project memories, embedding cache, dreamer runs, and other project-scoped
 * state. Session-scoped tables carry a `harness` column populated from this
 * constant so we can disambiguate which harness wrote each session row,
 * filter by harness in the dashboard, and (eventually) migrate sessions
 * between harnesses.
 *
 * Each plugin entry point (OpenCode plugin / Pi plugin) overrides this by
 * setting it before any DB writes happen — the OpenCode plugin defaults to
 * "opencode", the Pi plugin will set "pi" when it lands.
 *
 * NEVER read this from configuration or session state — it is a
 * compile-time constant per build target. Cross-harness leakage is a
 * correctness bug, not a feature.
 */
export type HarnessId = "opencode" | "pi";

export const HARNESS: HarnessId = "opencode";
