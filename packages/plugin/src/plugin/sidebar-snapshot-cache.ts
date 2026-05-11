/**
 * Sticky in-memory cache of the last "good" sidebar snapshot per session.
 *
 * Why this exists: the sidebar reads `last_input_tokens` from `session_meta` to
 * gate breakdown rendering on `inputTokens > 0`. There are intermittent windows
 * mid-turn where this value can briefly read 0 (mid-stream events that haven't
 * populated tokens yet, the first transform pass after restart resetting state
 * to clear stale percentages, etc.) — even though the session demonstrably has
 * existing context (compartments, facts, memories) and just rendered a healthy
 * breakdown a moment ago.
 *
 * The defensive UX rule: if the freshly built snapshot has `inputTokens === 0`
 * BUT we have a recent good snapshot for this session AND the session shows
 * explicit evidence of being "in flight" (historian/compartment work, pending
 * ops, or other active work signals), serve the cached values for the
 * breakdown instead of letting the bar flicker.
 *
 * What we never do:
 *   - Override anything when the live build genuinely succeeded
 *     (`inputTokens > 0`). Fresh data always wins.
 *   - Serve cached data forever — we cap age (default 5 min) so a session that
 *     legitimately rolls back to zero (revert, manual flush) eventually shows
 *     real state.
 *   - Cache before we have a real reading. The very first time we serve a
 *     session, if `inputTokens === 0`, we just pass through (true new session).
 *
 * Bounded by `BoundedSessionMap` to prevent leaks for sessions that are
 * never explicitly deleted (process crash, force-quit, archive).
 */
import { BoundedSessionMap } from "../shared/bounded-session-map";
import type { SidebarSnapshot } from "../shared/rpc-types";

interface CachedSnapshot {
    snapshot: SidebarSnapshot;
    cachedAt: number;
}

const MAX_CACHED_SESSIONS = 100;
const STALE_SNAPSHOT_AGE_MS = 5 * 60 * 1000; // 5 minutes

const cache = new BoundedSessionMap<CachedSnapshot>(MAX_CACHED_SESSIONS);

/**
 * Apply the sticky-cache policy to a freshly built snapshot.
 *
 * Returns either the live snapshot (preferred) or a hybrid snapshot that
 * preserves token-breakdown values from the previous good reading while keeping
 * fresh DB-backed counts (compartmentCount, memoryCount, historian state, etc.)
 * from the current build.
 */
export function applyStickySnapshotCache(
    sessionId: string,
    fresh: SidebarSnapshot,
): SidebarSnapshot {
    const now = Date.now();

    // Live build succeeded — cache it and return it.
    if (fresh.inputTokens > 0) {
        cache.set(sessionId, { snapshot: fresh, cachedAt: now });
        return fresh;
    }

    // Live build returned zero. Decide whether to stick.
    const cached = cache.peek(sessionId);
    if (!cached) {
        // No prior reading for this session — true new-session case. Pass through.
        return fresh;
    }
    if (now - cached.cachedAt > STALE_SNAPSHOT_AGE_MS) {
        // Cached value is too old to trust — drop it and pass through fresh zero.
        cache.delete(sessionId);
        return fresh;
    }
    if (!hasInFlightEvidence(fresh)) {
        // A fresh zero-token snapshot with no active-work signal means the
        // session was reset/deleted/reverted, not a mid-turn flicker. Drop the
        // cache so old sidebar values cannot survive the reset window.
        cache.delete(sessionId);
        return fresh;
    }

    // Hybrid: preserve token-breakdown fields from the cached snapshot, but
    // keep fresh values for everything that's authoritative right now from
    // SQLite (counts, queue state, historian flag, dreamer time, etc.). This
    // way the bar stays visible during the brief zero-window without showing
    // stale counts.
    return {
        ...fresh,
        usagePercentage: cached.snapshot.usagePercentage,
        inputTokens: cached.snapshot.inputTokens,
        systemPromptTokens: cached.snapshot.systemPromptTokens,
        compartmentTokens: cached.snapshot.compartmentTokens,
        factTokens: cached.snapshot.factTokens,
        memoryTokens: cached.snapshot.memoryTokens,
        conversationTokens: cached.snapshot.conversationTokens,
        toolCallTokens: cached.snapshot.toolCallTokens,
        toolDefinitionTokens: cached.snapshot.toolDefinitionTokens,
    };
}

function hasInFlightEvidence(snapshot: SidebarSnapshot): boolean {
    return (
        snapshot.compartmentInProgress || snapshot.historianRunning || snapshot.pendingOpsCount > 0
    );
}

/**
 * Drop the cached snapshot for a session. Wired to `session.deleted`.
 */
export function clearSidebarSnapshotCache(sessionId: string): void {
    cache.delete(sessionId);
}

/**
 * Test helper — drop the entire cache.
 */
export function resetSidebarSnapshotCache(): void {
    cache.clear();
}
