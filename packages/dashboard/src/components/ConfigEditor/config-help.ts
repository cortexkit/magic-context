export const CONFIG_HELP = {
  cache_ttl: {
    page: "concepts/cache-architecture",
    text: "How long Magic Context assumes the provider keeps the cached prompt. It doesn't change the provider's cache lifetime, and an expiry triggers no rebuild. Enter a duration such as 5m, or ‘never’ when a keep-warm tool holds the cache.",
  },
  temporal_awareness: {
    page: "reference/configuration",
    text: "Add start-date/end-date attributes on rendered compartments. Helps the agent reason about session pacing across long-running and multi-day sessions. On by default.",
  },
  auto_search: {
    page: "reference/configuration",
    text: "Does not inject full content — just nudges the agent to run ctx_search for the real result if relevant. Adds one embedding round-trip per new user turn. On by default.",
  },
  git_commit_indexing: {
    page: "reference/configuration",
    text: "Useful for agents recalling regressions, prior fixes, and decisions without running git log manually. Off by default.",
  },
  caveman_text_compression: {
    page: "concepts/session-modes",
    text: "Active for primary sessions when enabled; subagents are excluded because their context is curated by the parent. Outside the protected tail, oldest 20% of eligible tags get ultra compression, next 20% full, next 20% lite, newest 40% untouched. Always compresses from the original source. Off by default.",
  },
  keep_subagents: {
    page: "reference/configuration",
    text: "By default these are deleted on success; enable this to keep their full transcript and token usage for debugging. Kept sessions accumulate until cleared. Off by default.",
  },
  smart_drops: {
    page: "concepts/context-reduction",
    text: "Drops superseded todowrite, spent ctx_reduce, and zero-value status outputs, and compresses older edits to a file while keeping the newest. Only acts on passes already busting the cache, so it never causes a cache bust on its own. Off by default while cache stability is being proven.",
  },
} as const;

export function docsUrl(page: string): string {
  return `https://docs.cortexkit.io/magic-context/${page}/`;
}
