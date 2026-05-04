import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { formatDateTime, getCacheEventsFromDb, listSessions, truncate } from "../../lib/api";
import type { DbCacheEvent, Harness, SessionCacheStats } from "../../lib/types";
import HarnessBadge from "../HarnessBadge";
import FilterSelect from "../shared/FilterSelect";

// Module-level cache — survives component unmount/remount (page navigation)
let cachedEvents: DbCacheEvent[] = [];
let cachedWatermark: number | null = null;

type HarnessFilter = "all" | Harness;
type CacheSessionStats = SessionCacheStats & { harness: Harness };
type SelectedSession = { harness: Harness; sessionId: string };

export default function CacheDiagnostics() {
  const [events, setEvents] = createSignal<DbCacheEvent[]>(cachedEvents);
  const [sessionStats, setSessionStats] = createSignal<CacheSessionStats[]>([]);
  const [sessionNames, setSessionNames] = createSignal<Record<string, string>>({});
  const [loading, setLoading] = createSignal(cachedEvents.length === 0);
  const [paused, setPaused] = createSignal(false);
  const [selectedSession, setSelectedSession] = createSignal<SelectedSession | null>(null);
  const [harnessFilter, setHarnessFilter] = createSignal<HarnessFilter>("all");
  const [hideSubagents, setHideSubagents] = createSignal(true);
  const [subagentIds, setSubagentIds] = createSignal<Set<string>>(new Set());

  // The Rust backend windows by session: each session_id gets up to PER_SESSION
  // recent events, capped globally at PER_SESSION × 10. With this client-side
  // cap matching the global ceiling, every visible session keeps a full bar
  // chart even when many sessions are active in parallel.
  const PER_SESSION = 200;
  const TOTAL_CAP = PER_SESSION * 10;

  const fetchData = async () => {
    try {
      const [newEvents, sessions] = await Promise.all([
        getCacheEventsFromDb(PER_SESSION, cachedWatermark),
        listSessions(),
      ]);

      if (cachedWatermark === null) {
        // Initial load — use full result
        setEvents(newEvents);
      } else if (newEvents.length > 0) {
        // Incremental — prepend new events (they're newest-first from DB, but
        // build_db_cache_events reverses to chronological), trim to total cap
        setEvents((prev) => [...prev, ...newEvents].slice(-TOTAL_CAP));
      }

      // Sync to module-level cache and update watermark
      const allEvents = events();
      cachedEvents = allEvents;
      if (allEvents.length > 0) {
        cachedWatermark = Math.max(...allEvents.map((e) => e.timestamp));
      }

      // Compute session stats client-side from cached events (no extra DB query)
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

      // Build session ID → title lookup and subagent set
      const names: Record<string, string> = {};
      const subs = new Set<string>();
      for (const s of sessions) {
        const key = `${s.harness}:${s.session_id}`;
        if (s.title) names[key] = s.title;
        if (s.is_subagent) subs.add(key);
      }
      setSessionNames(names);
      setSubagentIds(subs);
    } finally {
      setLoading(false);
    }
  };

  const resolveTitle = (harness: Harness, sessionId: string) =>
    sessionNames()[`${harness}:${sessionId}`] || truncate(sessionId, 16);

  onMount(() => {
    fetchData();
  });

  const refreshInterval = setInterval(() => {
    if (!paused()) fetchData();
  }, 15000);
  onCleanup(() => clearInterval(refreshInterval));

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

  const severityIcon = (severity: string) => {
    switch (severity) {
      case "stable":
        return "🟢";
      case "info":
        return "🔵";
      case "warning":
        return "🟡";
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
              setSelectedSession(null);
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
                onClick={() => setSelectedSession(null)}
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
                    onClick={() =>
                      setSelectedSession(
                        isActive() ? null : { harness: stat.harness, sessionId: stat.session_id },
                      )
                    }
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
              <span>{filteredEvents().length} events</span>
            </div>
            <div class="chart-bars">
              <For each={filteredEvents()}>
                {(event) => (
                  <div
                    class={`chart-bar ${event.hit_ratio === 0 ? "black" : severityBarClass(event.hit_ratio)}`}
                    style={{ height: `${Math.max(3, event.hit_ratio * 100)}%` }}
                    title={`${formatDateTime(event.timestamp)}\nHit: ${(event.hit_ratio * 100).toFixed(1)}%\nPrompt: ${(event.cache_read + event.cache_write + event.input_tokens).toLocaleString()}\nCached: ${event.cache_read.toLocaleString()}\nNew: ${event.cache_write.toLocaleString()}\nUncached: ${event.input_tokens.toLocaleString()}${event.cause ? `\nCause: ${event.cause}` : ""}`}
                  />
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>

      {/* Event log */}
      <div class="scroll-area">
        <Show when={!loading()} fallback={<div class="empty-state">Loading cache events...</div>}>
          <Show
            when={filteredEvents().length > 0}
            fallback={
              <div class="empty-state">
                <span class="empty-state-icon">📊</span>
                <span>No cache events found</span>
                <span style={{ "font-size": "11px" }}>Cache data is read from OpenCode DB and Pi JSONL</span>
              </div>
            }
          >
            <div class="list-gap">
              <For each={[...filteredEvents()].reverse()}>
                {(event) => {
                  const totalPrompt = event.cache_read + event.cache_write + event.input_tokens;
                  return (
                    <div class="card">
                      <div
                        style={{
                          display: "flex",
                          "align-items": "center",
                          gap: "8px",
                          "margin-bottom": "4px",
                          "min-width": "0",
                        }}
                      >
                        <span style={{ "flex-shrink": "0" }}>{severityIcon(event.severity)}</span>
                        <span style={{ "flex-shrink": "0", display: "inline-flex" }}>
                          <HarnessBadge harness={event.harness} />
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
                          class={`pill ${event.severity === "stable" ? "green" : event.severity === "info" ? "blue" : event.severity === "warning" ? "amber" : "red"}`}
                          style={{ "flex-shrink": "0" }}
                        >
                          {event.severity === "full_bust"
                            ? "FULL BUST"
                            : event.severity === "info"
                              ? "NEW SESSION"
                              : event.severity.toUpperCase()}
                        </span>
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
                          title={resolveTitle(event.harness, event.session_id)}
                        >
                          {resolveTitle(event.harness, event.session_id)}
                        </span>
                      </div>
                      <div class="card-meta" style={{ gap: "12px" }}>
                        <span
                          class="mono"
                          style={{ color: hitColor(event.hit_ratio), "font-weight": "600" }}
                        >
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
                        <div
                          style={{
                            "margin-top": "6px",
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
        </Show>
      </div>
    </>
  );
}
