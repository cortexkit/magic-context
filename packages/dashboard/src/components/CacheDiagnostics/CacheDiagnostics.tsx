import { createSignal, For, Show, onCleanup, onMount } from "solid-js";
import type { CacheEvent, SessionCacheStats } from "../../lib/types";
import { getCacheEvents, getSessionCacheStats, getSessions } from "../../lib/api";
import { truncate } from "../../lib/api";

export default function CacheDiagnostics() {
  const [events, setEvents] = createSignal<CacheEvent[]>([]);
  const [sessionStats, setSessionStats] = createSignal<SessionCacheStats[]>([]);
  const [sessionNames, setSessionNames] = createSignal<Record<string, string>>({});
  const [loading, setLoading] = createSignal(true);
  const [paused, setPaused] = createSignal(false);
  const [selectedSession, setSelectedSession] = createSignal<string | null>(null);
  const [hideSubagents, setHideSubagents] = createSignal(true);
  const [subagentIds, setSubagentIds] = createSignal<Set<string>>(new Set());

  const fetchData = async () => {
    try {
      const [eventsData, statsData, sessions] = await Promise.all([
        getCacheEvents(2000),
        getSessionCacheStats(5),
        getSessions(),
      ]);
      setEvents(eventsData);
      setSessionStats(statsData);
      // Build session ID → title lookup and subagent set
      const names: Record<string, string> = {};
      const subs = new Set<string>();
      for (const s of sessions) {
        if (s.title) names[s.session_id] = s.title;
        if (s.is_subagent) subs.add(s.session_id);
      }
      setSessionNames(names);
      setSubagentIds(subs);
    } finally {
      setLoading(false);
    }
  };

  const resolveTitle = (sessionId: string) =>
    sessionNames()[sessionId] || truncate(sessionId, 16);

  onMount(() => { fetchData(); });

  const refreshInterval = setInterval(() => {
    if (!paused()) fetchData();
  }, 5000);
  onCleanup(() => clearInterval(refreshInterval));

  const isSubagent = (sessionId: string) => subagentIds().has(sessionId);

  const filteredStats = () => {
    const stats = sessionStats();
    return hideSubagents() ? stats.filter(s => !isSubagent(s.session_id)) : stats;
  };

  const filteredEvents = () => {
    const sid = selectedSession();
    let all = events();
    if (hideSubagents()) all = all.filter(e => !isSubagent(e.session_id));
    return sid ? all.filter(e => e.session_id === sid) : all;
  };

  const severityIcon = (severity: string) => {
    switch (severity) {
      case "stable": return "🟢";
      case "info": return "🔵";
      case "warning": return "🟡";
      case "bust": return "🔴";
      case "full_bust": return "⚫";
      default: return "⚪";
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
        <div class="section-actions">
          <Show when={!paused()}>
            <span style={{ color: "var(--green)", "font-size": "12px", "margin-right": "8px" }}>● Live</span>
          </Show>
          <button
            class={`btn sm ${!hideSubagents() ? "primary" : ""}`}
            onClick={() => setHideSubagents(!hideSubagents())}
          >
            {hideSubagents() ? "Show subagents" : "Hide subagents"}
          </button>
          <button
            class={`btn sm ${paused() ? "primary" : ""}`}
            onClick={() => setPaused(!paused())}
          >
            {paused() ? "▶ Resume" : "⏸ Pause"}
          </button>
        </div>
      </div>

      {/* Session cards */}
      <div style={{ padding: "0 20px 12px" }}>
        <Show when={filteredStats().length > 0}>
          <div style={{ "font-size": "11px", color: "var(--text-secondary)", "margin-bottom": "8px" }}>
            Recent Sessions
            <Show when={selectedSession()}>
              <span> · </span>
              <button
                class="btn sm"
                style={{ padding: "1px 6px", "font-size": "10px", "margin-left": "4px" }}
                onClick={() => setSelectedSession(null)}
              >
                Show all
              </button>
            </Show>
          </div>
          <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
            <For each={filteredStats()}>
              {(stat) => {
                const isActive = () => selectedSession() === stat.session_id;
                return (
                  <div
                    class="card"
                    style={{
                      cursor: "pointer",
                      flex: "1 1 0",
                      "min-width": "140px",
                      "max-width": "220px",
                      "border-color": isActive() ? "var(--accent)" : undefined,
                    }}
                    onClick={() => setSelectedSession(isActive() ? null : stat.session_id)}
                  >
                    <div style={{ "font-size": "11px", color: "var(--text-muted)", "margin-bottom": "4px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                      {resolveTitle(stat.session_id)}
                    </div>
                    <div style={{ "font-size": "20px", "font-weight": "700", color: hitColor(stat.hit_ratio), "font-family": "var(--mono-font)" }}>
                      {(stat.hit_ratio * 100).toFixed(1)}%
                    </div>
                    <div class="card-meta" style={{ "margin-top": "4px" }}>
                      <span>{stat.event_count} events</span>
                      <Show when={stat.bust_count > 0}>
                        <span style={{ color: "var(--red)" }}>{stat.bust_count} busts</span>
                      </Show>
                    </div>
                  </div>
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
            <div style={{ "font-size": "11px", color: "var(--text-secondary)", "margin-bottom": "8px", display: "flex", "justify-content": "space-between" }}>
              <span>Cache Hit Timeline</span>
              <span>{filteredEvents().length} events</span>
            </div>
            <div class="chart-bars">
              <For each={filteredEvents()}>
                {(event) => (
                  <div
                    class={`chart-bar ${event.hit_ratio === 0 ? "black" : severityBarClass(event.hit_ratio)}`}
                    style={{ height: `${Math.max(3, event.hit_ratio * 100)}%` }}
                    title={`${event.timestamp}\nHit: ${(event.hit_ratio * 100).toFixed(1)}%\nPrompt: ${(event.cache_read + event.cache_write + event.input_tokens).toLocaleString()}\nCached: ${event.cache_read.toLocaleString()}\nNew: ${event.cache_write.toLocaleString()}\nUncached: ${event.input_tokens.toLocaleString()}${event.cause ? `\nCause: ${event.cause}` : ""}`}
                  />
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>

      {/* Event log */}
      <div class="scroll-area">
        <Show
          when={!loading()}
          fallback={<div class="empty-state">Loading cache events...</div>}
        >
          <Show
            when={filteredEvents().length > 0}
            fallback={
              <div class="empty-state">
                <span class="empty-state-icon">📊</span>
                <span>No cache events found</span>
                <span style={{ "font-size": "11px" }}>
                  Cache data is parsed from /tmp/magic-context.log
                </span>
              </div>
            }
          >
            <div class="list-gap">
              <For each={[...filteredEvents()].reverse()}>
                {(event) => {
                  const totalPrompt = event.cache_read + event.cache_write + event.input_tokens;
                  return (
                    <div class="card">
                      <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "4px" }}>
                        <span>{severityIcon(event.severity)}</span>
                        <span class="mono" style={{ "font-size": "11px", color: "var(--text-secondary)" }}>
                          {event.timestamp.split("T").pop()?.split(".")[0] ?? event.timestamp}
                        </span>
                        <span class={`pill ${event.severity === "stable" ? "green" : event.severity === "info" ? "blue" : event.severity === "warning" ? "amber" : "red"}`}>
                          {event.severity === "full_bust" ? "FULL BUST" : event.severity === "info" ? "NEW SESSION" : event.severity.toUpperCase()}
                        </span>
                        <span class="mono" style={{ "font-size": "10px", color: "var(--text-muted)" }}>
                          {resolveTitle(event.session_id)}
                        </span>
                      </div>
                      <div class="card-meta" style={{ gap: "12px" }}>
                        <span class="mono" style={{ color: hitColor(event.hit_ratio), "font-weight": "600" }}>
                          {(event.hit_ratio * 100).toFixed(1)}%
                        </span>
                        <span class="mono">prompt={totalPrompt.toLocaleString()}</span>
                        <span class="mono">cached={event.cache_read.toLocaleString()}</span>
                        <span class="mono">new={event.cache_write.toLocaleString()}</span>
                        <div class="cache-bar">
                          <div
                            class={`cache-bar-fill ${severityBarClass(event.hit_ratio)}`}
                            style={{ width: `${event.hit_ratio * 100}%` }}
                          />
                        </div>
                      </div>
                      <Show when={event.cause}>
                        <div style={{ "margin-top": "6px", "font-size": "11px", color: "var(--amber)" }}>
                          Cause: {event.cause}
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
