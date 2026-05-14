import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  formatDateTime,
  getCacheEventsFromDb,
  getSessionCacheEventsByTurns,
  listSessions,
  truncate,
} from "../../lib/api";
import type { DbCacheEvent, Harness, SessionCacheStats, SessionRow } from "../../lib/types";
import HarnessBadge from "../HarnessBadge";
import FilterSelect from "../shared/FilterSelect";

type HarnessFilter = "all" | Harness;
type CacheSessionStats = SessionCacheStats & { harness: Harness };
type SelectedSession = { harness: Harness; sessionId: string };

// Module-level state — survives component unmount/remount (page navigation).
// We persist EVERYTHING needed to skip work on remount, not just events,
// because the previous implementation lost session_stats / session_names /
// subagent_ids on remount and the picker disappeared.
let cachedEvents: DbCacheEvent[] = [];
let cachedWatermark: number | null = null;
let cachedSessions: SessionRow[] = [];
let cachedSelectedSession: SelectedSession | null = null;
// Top-N session keys we've lazy-loaded for the Recent Sessions strip. Tracked
// separately from `cachedHasGlobal` because the top-N mode covers just the
// 5 most-recent non-subagent sessions, not the full corpus — the polling
// tick refreshes only these instead of doing the 3s global query.
let cachedLoadedSessionKeys: SelectedSession[] = [];
// True once the user has opted into the cross-session global view ("Show all"
// or harness/session change requiring the full corpus). Defaults to false so
// the expensive global query never runs implicitly.
let cachedHasGlobal = false;
// Cap for the Recent Sessions strip. Matches the existing client-side
// `filteredStats().slice(0, 5)` so we don't fetch sessions we'd never render.
const RECENT_SESSIONS_LIMIT = 5;

export default function CacheDiagnostics() {
  const [events, setEvents] = createSignal<DbCacheEvent[]>(cachedEvents);
  const [sessionStats, setSessionStats] = createSignal<CacheSessionStats[]>([]);
  const [sessionNames, setSessionNames] = createSignal<Record<string, string>>({});
  const [loading, setLoading] = createSignal(cachedEvents.length === 0);
  const [paused, setPaused] = createSignal(false);
  const [selectedSession, setSelectedSession] = createSignal<SelectedSession | null>(
    cachedSelectedSession,
  );
  const [harnessFilter, setHarnessFilter] = createSignal<HarnessFilter>("all");
  const [hideSubagents, setHideSubagents] = createSignal(true);
  const [subagentIds, setSubagentIds] = createSignal<Set<string>>(new Set());
  const [expandedTurns, setExpandedTurns] = createSignal<Set<string>>(new Set());

  interface CacheTurn {
    turnId: string;
    sessionId: string;
    harness: Harness;
    startTime: number;
    endTime: number;
    events: DbCacheEvent[];
    totalCacheWrite: number;
    firstCacheRead: number;
    lastCacheRead: number;
    worstSeverity: DbCacheEvent["severity"];
    totalInputTokens: number;
    agent: string | null;
  }

  // The Rust backend windows by session: each session_id gets up to PER_SESSION
  // recent events, capped globally at PER_SESSION × 10. With this client-side
  // cap matching the global ceiling, every visible session keeps a full bar
  // chart even when many sessions are active in parallel.
  const PER_SESSION = 200;
  const TOTAL_CAP = PER_SESSION * 10;
  // For the per-session timeline we ask the backend for a turn count, not an
  // event count, so multi-step tool-use turns don't collapse the bar chart.
  const TARGET_TURNS_PER_SESSION = 200;

  // Synchronously rebuild every derived signal from a (events, sessions) pair.
  // Used both for fresh data from a fetch and for cache rehydration on remount.
  // `bumpWatermark` is only meaningful when `events` represents a global view
  // (covers all active sessions); pass false when `events` was scoped to a
  // single session so the watermark doesn't filter out other sessions later.
  const applyState = (
    allEvents: DbCacheEvent[],
    sessions: SessionRow[],
    bumpWatermark = true,
  ) => {
    setEvents(allEvents);
    cachedEvents = allEvents;
    if (bumpWatermark && allEvents.length > 0) {
      cachedWatermark = Math.max(...allEvents.map((e) => e.timestamp));
    }

    const statsMap = new Map<
      string,
      {
        count: number;
        harness: Harness;
        read: number;
        write: number;
        input: number;
        lastTs: number;
        busts: number;
      }
    >();
    for (const e of allEvents) {
      if (!e.session_id) continue;
      const key = `${e.harness}:${e.session_id}`;
      const s = statsMap.get(key) ?? {
        count: 0,
        harness: e.harness,
        read: 0,
        write: 0,
        input: 0,
        lastTs: 0,
        busts: 0,
      };
      s.count++;
      s.read += e.cache_read;
      s.write += e.cache_write;
      s.input += e.input_tokens;
      if (e.timestamp > s.lastTs) s.lastTs = e.timestamp;
      if (e.severity === "bust" || e.severity === "full_bust") s.busts++;
      statsMap.set(key, s);
    }
    const stats = [...statsMap.entries()]
      .map(([key, s]) => {
        const sid = key.slice(key.indexOf(":") + 1);
        const total = s.read + s.write + s.input;
        return {
          harness: s.harness,
          session_id: sid,
          event_count: s.count,
          total_cache_read: s.read,
          total_cache_write: s.write,
          total_input: s.input,
          hit_ratio: total > 0 ? s.read / total : 0,
          last_timestamp: new Date(s.lastTs).toISOString(),
          bust_count: s.busts,
        };
      })
      .sort((a, b) => b.last_timestamp.localeCompare(a.last_timestamp));
    setSessionStats(stats);

    const names: Record<string, string> = {};
    const subs = new Set<string>();
    for (const s of sessions) {
      const key = `${s.harness}:${s.session_id}`;
      if (s.title) names[key] = s.title;
      if (s.is_subagent) subs.add(key);
    }
    setSessionNames(names);
    setSubagentIds(subs);
    cachedSessions = sessions;
  };

  // Refresh events for a given set of session keys in parallel and apply the
  // combined result. Used for top-N mode (initial lazy load + live polling).
  // We keep `bumpWatermark=false` because the combined set still covers only
  // a subset of all sessions; advancing the watermark would silently mask
  // pre-cutoff events for any session outside the top-N window when the user
  // later clicks "Show all" and triggers `fetchGlobal()` with that watermark
  // as a `since` filter.
  const refreshSessions = async (keys: SelectedSession[]) => {
    if (keys.length === 0) return;
    const results = await Promise.all(
      keys.map((k) =>
        getSessionCacheEventsByTurns(k.harness, k.sessionId, TARGET_TURNS_PER_SESSION),
      ),
    );
    const merged = results.flat();
    applyState(merged, cachedSessions, false);
  };

  // Lazy global fetch. Only called when the user opts in (Show all, harness
  // filter, or a card click for a session not yet in the loaded events).
  // After this runs the live polling tick switches to incremental global
  // refreshes so newly-arriving events across all sessions stay visible.
  const fetchGlobal = async () => {
    try {
      const [newEvents, sessions] = await Promise.all([
        getCacheEventsFromDb(PER_SESSION, cachedWatermark),
        listSessions(),
      ]);
      if (cachedWatermark === null) {
        applyState(newEvents, sessions);
      } else if (newEvents.length > 0) {
        const merged = [...events(), ...newEvents].slice(-TOTAL_CAP);
        applyState(merged, sessions);
      } else {
        // No new events; still refresh session metadata so newly-created
        // sessions show their titles without waiting for an eventful tick.
        cachedSessions = sessions;
        const names: Record<string, string> = {};
        const subs = new Set<string>();
        for (const s of sessions) {
          const key = `${s.harness}:${s.session_id}`;
          if (s.title) names[key] = s.title;
          if (s.is_subagent) subs.add(key);
        }
        setSessionNames(names);
        setSubagentIds(subs);
      }
      cachedHasGlobal = true;
    } finally {
      setLoading(false);
    }
  };

  // Ensure global data is loaded (idempotent — no-ops if already fetched).
  const ensureGlobal = async () => {
    if (cachedHasGlobal) return;
    await fetchGlobal();
  };

  const resolveTitle = (harness: Harness, sessionId: string) =>
    sessionNames()[`${harness}:${sessionId}`] || truncate(sessionId, 16);

  onMount(async () => {
    // Remount fast path: if we have cached state from a prior mount, rebuild
    // every derived signal synchronously and return — no DB work, no IPC,
    // no main-thread JSON-parse stall, no blank picker. The live polling
    // tick takes over from here.
    if (cachedEvents.length > 0) {
      applyState(cachedEvents, cachedSessions, false);
      // Restore the user's prior selection so a previously-deselected
      // ("Show all") view stays as-is across navigation.
      setSelectedSession(cachedSelectedSession);
      setLoading(false);
      return;
    }

    // Cold start, two-stage load:
    //   Stage 1 (blocking, ~300-500ms): list sessions + fetch the most-recent
    //   non-subagent session's events. As soon as this finishes the chart and
    //   one card render — the user sees a useful page immediately.
    //
    //   Stage 2 (deferred, ~100-150ms parallel): fetch up to N-1 more sessions
    //   so the Recent Sessions strip fills out to 5 cards. We deliberately do
    //   not run the 3s global query here — that's gated behind "Show all" so
    //   the cold start stays cheap on dev DBs with 30k+ events on one session.
    try {
      const sessions = await listSessions();
      const topN = sessions.filter((s) => !s.is_subagent).slice(0, RECENT_SESSIONS_LIMIT);
      if (topN.length === 0) {
        // Empty environment — still store sessions so we don't refetch later.
        applyState([], sessions, false);
        return;
      }

      const first = topN[0];
      const firstKey: SelectedSession = { harness: first.harness, sessionId: first.session_id };
      const firstEvents = await getSessionCacheEventsByTurns(
        first.harness,
        first.session_id,
        TARGET_TURNS_PER_SESSION,
      );
      applyState(firstEvents, sessions, false);
      setSelectedSession(firstKey);
      cachedSelectedSession = firstKey;
      cachedLoadedSessionKeys = [firstKey];
      setLoading(false);

      // Stage 2: fan out to the rest of top-N in the background. Using
      // queueMicrotask so the Stage 1 render commits to the DOM before we
      // start the next batch — that's the difference between a noticeable
      // initial-paint jank and a smooth fill-in afterward.
      const rest = topN.slice(1);
      if (rest.length > 0) {
        queueMicrotask(() => {
          const restKeys: SelectedSession[] = rest.map((s) => ({
            harness: s.harness,
            sessionId: s.session_id,
          }));
          // Refresh ALL loaded sessions (first + rest) in parallel so the
          // combined events list passed to `applyState` covers every card.
          // If we only fetched `rest` we'd then have to merge against
          // `firstEvents` which is fine — but a single refresh is simpler
          // and the cost difference is one extra ~70ms parallel fetch.
          const allKeys = [firstKey, ...restKeys];
          void refreshSessions(allKeys).then(() => {
            cachedLoadedSessionKeys = allKeys;
          }).catch(() => {
            // Stage 2 failure leaves us with the Stage 1 single-card view —
            // still functional; user can click "Show all" to retry via the
            // global fetch path.
          });
        });
      }
    } catch {
      // Swallow — leave loading state visible and let the user retry by
      // clicking around. Throwing here would crash the whole page.
    } finally {
      setLoading(false);
    }
  });

  // Live polling. Scope follows the active view:
  //   - global mode (hasGlobal=true): incremental global fetch (cheap because
  //     of the `since` watermark filter).
  //   - top-N mode: re-fetch every loaded session in parallel so the cards
  //     and the chart for the selected session stay live without paying for
  //     the global scan.
  const refreshInterval = setInterval(() => {
    if (paused()) return;
    if (cachedHasGlobal) {
      void fetchGlobal();
    } else if (cachedLoadedSessionKeys.length > 0) {
      void refreshSessions(cachedLoadedSessionKeys).catch(() => {
        // Ignore transient errors; the next tick will retry.
      });
    }
  }, 15000);
  onCleanup(() => clearInterval(refreshInterval));

  // Selection helper used by card clicks and Show-all. Mirrors module-level
  // cache so a remount restores the same view.
  const selectSession = (next: SelectedSession | null) => {
    setSelectedSession(next);
    cachedSelectedSession = next;
  };

  const isSubagent = (harness: Harness, sessionId: string) => subagentIds().has(`${harness}:${sessionId}`);

  const filteredStats = () => {
    const harness = harnessFilter();
    let filtered = sessionStats();
    if (harness !== "all") filtered = filtered.filter((s) => s.harness === harness);
    if (hideSubagents()) filtered = filtered.filter((s) => !isSubagent(s.harness, s.session_id));
    return filtered.slice(0, 5);
  };

  const filteredEvents = () => {
    const selected = selectedSession();
    const harness = harnessFilter();
    let all = events();
    if (harness !== "all") all = all.filter((e) => e.harness === harness);
    if (hideSubagents()) all = all.filter((e) => !isSubagent(e.harness, e.session_id));
    return selected
      ? all.filter((e) => e.session_id === selected.sessionId && e.harness === selected.harness)
      : all;
  };

  // Ordering used for worst-severity promotion across multi-step turns.
  // Higher rank wins — full_bust > bust > warming > warning > info > stable > unknown.
  const SEVERITY_RANK: Record<string, number> = {
    full_bust: 6,
    bust: 5,
    warming: 4,
    warning: 3,
    info: 2,
    stable: 1,
  };
  const severityRank = (severity: string): number => SEVERITY_RANK[severity] ?? 0;

  const cacheTurns = createMemo(() => {
    const turns: CacheTurn[] = [];
    const map = new Map<string, CacheTurn>();
    for (const event of filteredEvents()) {
      let turn = map.get(event.turn_id);
      if (!turn) {
        turn = {
          turnId: event.turn_id,
          sessionId: event.session_id,
          harness: event.harness,
          startTime: event.timestamp,
          endTime: event.timestamp,
          events: [],
          totalCacheWrite: 0,
          firstCacheRead: event.cache_read,
          lastCacheRead: event.cache_read,
          worstSeverity: event.severity,
          totalInputTokens: 0,
          agent: event.agent,
        };
        map.set(event.turn_id, turn);
        turns.push(turn);
      }
      turn.events.push(event);
      turn.endTime = Math.max(turn.endTime, event.timestamp);
      turn.totalCacheWrite += event.cache_write;
      turn.lastCacheRead = event.cache_read;
      turn.totalInputTokens += event.input_tokens;
      // Promote worst severity across all steps so a multi-step turn with a
      // mid-turn cache bust doesn't render as STABLE in the parent row.
      if (severityRank(event.severity) > severityRank(turn.worstSeverity)) {
        turn.worstSeverity = event.severity;
      }
    }
    // Sort by start time descending (newest first) so the list is chronological
    // when reversed below, matching the original event order.
    return turns.sort((a, b) => a.startTime - b.startTime);
  });

  const toggleTurn = (turnId: string) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) {
        next.delete(turnId);
      } else {
        next.add(turnId);
      }
      return next;
    });
  };

  const severityIcon = (severity: string) => {
    switch (severity) {
      case "stable":
        return "🟢";
      case "info":
        return "🔵";
      case "warning":
        return "🟡";
      case "warming":
        return "⚪";
      case "bust":
        return "🔴";
      case "full_bust":
        return "⚫";
      default:
        return "⚪";
    }
  };

  const severityBarClass = (ratio: number) => {
    if (ratio >= 0.9) return "green";
    if (ratio >= 0.5) return "amber";
    return "red";
  };

  const hitColor = (ratio: number) =>
    ratio >= 0.9 ? "var(--green)" : ratio >= 0.5 ? "var(--amber)" : "var(--red)";

  return (
    <>
      <div class="section-header">
        <h1 class="section-title">Cache Diagnostics</h1>
        <div class="section-actions" style={{ "align-items": "center" }}>
          <FilterSelect
            value={harnessFilter()}
            onChange={(value) => {
              setHarnessFilter(value as HarnessFilter);
              selectSession(null);
              // Switching harness implies the user wants to see across
              // sessions; ensure we have the global corpus loaded.
              void ensureGlobal();
            }}
            placeholder="Harness"
            options={[
              { value: "all", label: "Harness: All" },
              { value: "opencode", label: "OpenCode" },
              { value: "pi", label: "Pi" },
            ]}
          />
          <button
            type="button"
            class={`btn sm ${!hideSubagents() ? "primary" : ""}`}
            onClick={() => setHideSubagents(!hideSubagents())}
          >
            {hideSubagents() ? "Show subagents" : "Hide subagents"}
          </button>
          <button
            type="button"
            class={`btn sm ${paused() ? "primary" : ""}`}
            onClick={() => setPaused(!paused())}
          >
            {paused() ? "▶ Resume" : "⏸ Pause"}
          </button>
          <Show when={!paused()}>
            <span
              style={{
                color: "var(--green)",
                "font-size": "12px",
                display: "inline-flex",
                "align-items": "center",
                "margin-left": "4px",
              }}
            >
              ● Live
            </span>
          </Show>
        </div>
      </div>

      {/* Session cards */}
      <div style={{ padding: "0 20px 12px" }}>
        <Show when={filteredStats().length > 0}>
          <div
            style={{ "font-size": "11px", color: "var(--text-secondary)", "margin-bottom": "8px" }}
          >
            Recent Sessions
            <Show when={selectedSession()}>
              <span> · </span>
              <button
                type="button"
                class="btn sm"
                style={{ padding: "1px 6px", "font-size": "10px", "margin-left": "4px" }}
                onClick={() => {
                  selectSession(null);
                  // First Show-all click triggers the global fetch so
                  // "all sessions" actually means all sessions.
                  void ensureGlobal();
                }}
              >
                Show all
              </button>
            </Show>
          </div>
          <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
            <For each={filteredStats()}>
              {(stat) => {
                const isActive = () => {
                  const selected = selectedSession();
                  return selected?.sessionId === stat.session_id && selected.harness === stat.harness;
                };
                return (
                  <button
                    type="button"
                    class="card"
                    style={{
                      cursor: "pointer",
                      flex: "1 1 0",
                      "min-width": "140px",
                      "max-width": "220px",
                      "border-color": isActive() ? "var(--accent)" : undefined,
                      "text-align": "left",
                    }}
                    onClick={() => {
                      const next = isActive()
                        ? null
                        : { harness: stat.harness, sessionId: stat.session_id };
                      selectSession(next);
                      // Clearing selection means "show all" — load the
                      // global corpus on demand. Selecting a card just
                      // re-filters the already-loaded top-N events (set
                      // by Stage 2 of the cold start), so no fetch needed
                      // here; the next polling tick will refresh the
                      // top-N set including this one.
                      if (next === null) {
                        void ensureGlobal();
                      }
                    }}
                  >
                    <div
                      style={{
                        "font-size": "11px",
                        color: "var(--text-muted)",
                        "margin-bottom": "4px",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                        "white-space": "nowrap",
                      }}
                    >
                      <span style={{ display: "inline-flex", "align-items": "center", gap: "6px" }}>
                        <HarnessBadge harness={stat.harness} />
                        <span>{resolveTitle(stat.harness, stat.session_id)}</span>
                      </span>
                    </div>
                    <div
                      style={{
                        "font-size": "20px",
                        "font-weight": "700",
                        color: hitColor(stat.hit_ratio),
                        "font-family": "var(--mono-font)",
                      }}
                    >
                      {(stat.hit_ratio * 100).toFixed(1)}%
                    </div>
                    <div class="card-meta" style={{ "margin-top": "4px" }}>
                      <span>{stat.event_count} events</span>
                      <Show when={stat.bust_count > 0}>
                        <span style={{ color: "var(--red)" }}>{stat.bust_count} busts</span>
                      </Show>
                    </div>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      {/* Chart */}
      <div style={{ padding: "0 20px 12px" }}>
        <Show when={filteredEvents().length > 0}>
          <div class="chart-container">
            <div
              style={{
                "font-size": "11px",
                color: "var(--text-secondary)",
                "margin-bottom": "8px",
                display: "flex",
                "justify-content": "space-between",
              }}
            >
              <span>Cache Hit Timeline</span>
              <span>{cacheTurns().length} turns</span>
            </div>
            <div class="chart-bars">
              <For each={cacheTurns()}>
                {(turn) => {
                  // Parent represents the turn's FINAL state — the last step's
                  // prompt is what actually got sent at the end of the turn.
                  // Aggregating prompts/tokens across steps double-counts the
                  // bust child and produces nonsense totals.
                  const last = turn.events[turn.events.length - 1];
                  const totalPrompt = last.cache_read + last.cache_write + last.input_tokens;
                  const turnHitRatio =
                    totalPrompt > 0 ? last.cache_read / totalPrompt : last.hit_ratio;
                  const stepLabel = turn.events.length > 1 ? `\n${turn.events.length} steps` : "";
                  return (
                    <div
                      class={`chart-bar ${turnHitRatio === 0 ? "black" : severityBarClass(turnHitRatio)}`}
                      style={{ height: `${Math.max(3, turnHitRatio * 100)}%` }}
                      title={`${formatDateTime(turn.startTime)}${stepLabel}\nHit: ${(turnHitRatio * 100).toFixed(1)}%\nPrompt: ${totalPrompt.toLocaleString()}\nCached: ${last.cache_read.toLocaleString()}\nNew (last step): ${last.cache_write.toLocaleString()}\nUncached: ${last.input_tokens.toLocaleString()}${last.cause ? `\nCause: ${last.cause}` : ""}`}
                    />
                  );
                }}
              </For>
            </div>
          </div>
        </Show>
      </div>

      {/* Event log */}
      <div class="scroll-area">
        <Show when={!loading()} fallback={<div class="empty-state">Loading cache events...</div>}>
          <Show
            when={cacheTurns().length > 0}
            fallback={
              <div class="empty-state">
                <span class="empty-state-icon">📊</span>
                <span>No cache events found</span>
                <span style={{ "font-size": "11px" }}>Cache data is read from OpenCode DB and Pi JSONL</span>
              </div>
            }
          >
            <div class="list-gap">
              <For each={[...cacheTurns()].reverse()}>
                {(turn) => {
                  // Parent stats reflect the turn's FINAL step (the prompt that
                  // actually shipped), not an aggregate across steps. Aggregation
                  // double-counts a bust child and produces nonsense like
                  // prompt=823k for a 540k actual turn (see fix in chart-bar above).
                  const first = turn.events[0];
                  const last = turn.events[turn.events.length - 1];
                  const isExpanded = () => expandedTurns().has(turn.turnId);
                  const totalPrompt = last.cache_read + last.cache_write + last.input_tokens;
                  const turnHitRatio =
                    totalPrompt > 0 ? last.cache_read / totalPrompt : last.hit_ratio;
                  const isMultiStep = turn.events.length > 1;
                  return (
                    <div
                      class="card cache-turn-row"
                      onClick={() => isMultiStep && toggleTurn(turn.turnId)}
                      style={{ cursor: isMultiStep ? "pointer" : "default" }}
                    >
                      <div
                        style={{
                          display: "flex",
                          "align-items": "center",
                          gap: "8px",
                          "margin-bottom": "4px",
                          "min-width": "0",
                        }}
                      >
                        <span style={{ "flex-shrink": "0" }}>
                          {severityIcon(turn.worstSeverity)}
                        </span>
                        <span style={{ "flex-shrink": "0", display: "inline-flex" }}>
                          <HarnessBadge harness={turn.harness} />
                        </span>
                        <span
                          class="mono"
                          style={{
                            "font-size": "11px",
                            color: "var(--text-secondary)",
                            "flex-shrink": "0",
                          }}
                        >
                          {formatDateTime(turn.startTime)}
                        </span>
                        <span
                          class={`pill ${
                            turn.worstSeverity === "stable"
                              ? "green"
                              : turn.worstSeverity === "info"
                                ? "blue"
                                : turn.worstSeverity === "warning"
                                  ? "amber"
                                  : turn.worstSeverity === "warming"
                                    ? "gray"
                                    : "red"
                          }`}
                          style={{ "flex-shrink": "0" }}
                        >
                          {turn.worstSeverity === "full_bust"
                            ? "FULL BUST"
                            : turn.worstSeverity === "info"
                              ? "NEW SESSION"
                              : turn.worstSeverity.toUpperCase()}
                        </span>
                        <Show when={isMultiStep}>
                          <span class="pill gray" style={{ "flex-shrink": "0" }}>
                            {isExpanded() ? "▾" : "▸"} {turn.events.length} steps
                          </span>
                        </Show>
                        <span
                          class="mono"
                          style={{
                            "font-size": "10px",
                            color: "var(--text-muted)",
                            "min-width": "0",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                            flex: "1 1 auto",
                          }}
                          title={resolveTitle(turn.harness, turn.sessionId)}
                        >
                          {resolveTitle(turn.harness, turn.sessionId)}
                        </span>
                      </div>
                      <div class="card-meta" style={{ gap: "12px" }}>
                        <span
                          class="mono"
                          style={{ color: hitColor(turnHitRatio), "font-weight": "600" }}
                        >
                          {(turnHitRatio * 100).toFixed(1)}%
                        </span>
                        <span class="mono">prompt={totalPrompt.toLocaleString()}</span>
                        <span class="mono">cached={last.cache_read.toLocaleString()}</span>
                        <span class="mono">new={turn.totalCacheWrite.toLocaleString()}</span>
                        <div class="cache-bar">
                          <div
                            class={`cache-bar-fill ${severityBarClass(turnHitRatio)}`}
                            style={{ width: `${turnHitRatio * 100}%` }}
                          />
                        </div>
                      </div>
                      <Show when={last.cause ?? first.cause}>
                        <div
                          style={{
                            "margin-top": "6px",
                            "font-size": "11px",
                            color: "var(--amber)",
                          }}
                        >
                          Cause: {last.cause ?? first.cause}
                        </div>
                      </Show>
                      <Show when={isExpanded()}>
                        <div class="cache-turn-expanded">
                          {/* Newest-step first inside the drill-down so the user
                              reads top-to-bottom matching the outer recent-turn
                              ordering (which is also newest-first). */}
                          <For each={[...turn.events].reverse()}>
                            {(event) => {
                              const evTotalPrompt =
                                event.cache_read + event.cache_write + event.input_tokens;
                              return (
                                <div class="cache-step-row">
                                  <div class="cache-step-header">
                                    <span style={{ "flex-shrink": "0" }}>
                                      {severityIcon(event.severity)}
                                    </span>
                                    <span
                                      class="mono"
                                      style={{
                                        "font-size": "11px",
                                        color: "var(--text-secondary)",
                                        "flex-shrink": "0",
                                      }}
                                    >
                                      {formatDateTime(event.timestamp)}
                                    </span>
                                    <span
                                      class={`pill ${
                                        event.severity === "stable"
                                          ? "green"
                                          : event.severity === "info"
                                            ? "blue"
                                            : event.severity === "warning"
                                              ? "amber"
                                              : event.severity === "warming"
                                                ? "gray"
                                                : "red"
                                      }`}
                                      style={{ "flex-shrink": "0" }}
                                    >
                                      {event.severity === "full_bust"
                                        ? "FULL BUST"
                                        : event.severity === "info"
                                          ? "NEW SESSION"
                                          : event.severity.toUpperCase()}
                                    </span>
                                  </div>
                                  <div class="cache-step-meta">
                                    <span
                                      class="mono"
                                      style={{
                                        color: hitColor(event.hit_ratio),
                                        "font-weight": "600",
                                      }}
                                    >
                                      {(event.hit_ratio * 100).toFixed(1)}%
                                    </span>
                                    <span class="mono">
                                      prompt={evTotalPrompt.toLocaleString()}
                                    </span>
                                    <span class="mono">
                                      cached={event.cache_read.toLocaleString()}
                                    </span>
                                    <span class="mono">
                                      new={event.cache_write.toLocaleString()}
                                    </span>
                                    <div class="cache-bar">
                                      <div
                                        class={`cache-bar-fill ${severityBarClass(event.hit_ratio)}`}
                                        style={{ width: `${event.hit_ratio * 100}%` }}
                                      />
                                    </div>
                                  </div>
                                  <Show when={event.cause}>
                                    <div
                                      style={{
                                        "margin-top": "4px",
                                        "font-size": "11px",
                                        color: "var(--amber)",
                                      }}
                                    >
                                      Cause: {event.cause}
                                    </div>
                                  </Show>
                                </div>
                              );
                            }}
                          </For>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </>
  );
}
