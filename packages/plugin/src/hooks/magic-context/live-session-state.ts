import type { AgentBySession, LiveModelBySession, VariantBySession } from "./hook-handlers";

/**
 * Plugin-process-scoped shared state. Lives in `index.ts` and is threaded into
 * every component that needs to share signals with the others (the magic-
 * context hook, RPC handlers, command handlers, etc).
 *
 * The three `*Sessions` sets are the cache-busting signal channels added in
 * the Oracle 2026-04-26 review (replaces the old single `flushedSessions`).
 * See `hook-handlers.ts` for the full lifetime/semantics doc-comment on
 * each set, and `system-prompt-hash.ts` / `transform.ts` /
 * `transform-postprocess-phase.ts` for the consumer drain points.
 *
 * Storing them here lets RPC-driven recomp (TUI command path) signal the
 * same sets the hook-driven recomp (server `/ctx-recomp` path) signals.
 * Without this, the TUI recomp publish would silently leave injection cache
 * stale and the next defer pass would reuse old `<session-history>`.
 */
export interface LiveSessionState {
    liveModelBySession: LiveModelBySession;
    variantBySession: VariantBySession;
    agentBySession: AgentBySession;
    historyRefreshSessions: Set<string>;
    systemPromptRefreshSessions: Set<string>;
    pendingMaterializationSessions: Set<string>;
}

export function createLiveSessionState(): LiveSessionState {
    return {
        liveModelBySession: new Map<string, { providerID: string; modelID: string }>(),
        variantBySession: new Map<string, string | undefined>(),
        agentBySession: new Map<string, string>(),
        historyRefreshSessions: new Set<string>(),
        systemPromptRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
    };
}
