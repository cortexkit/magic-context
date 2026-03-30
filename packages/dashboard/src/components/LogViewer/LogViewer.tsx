import { createSignal, createResource, createEffect, For, Show, onMount, onCleanup } from "solid-js";
import type { LogEntry } from "../../lib/types";
import { getLogEntries, truncate } from "../../lib/api";
import FilterSelect from "../shared/FilterSelect";

export default function LogViewer() {
  const [sessionFilter, setSessionFilter] = createSignal<string>("");
  const [componentFilter, setComponentFilter] = createSignal<string>("");
  const [searchQuery, setSearchQuery] = createSignal<string>("");
  const [paused, setPaused] = createSignal(false);
  const [maxLines, setMaxLines] = createSignal(500);

  const [entries, { refetch }] = createResource(
    () => maxLines(),
    (lines) => getLogEntries(lines)
  );

  // Auto-refresh every 3 seconds when not paused
  let refreshInterval: ReturnType<typeof setInterval>;
  onMount(() => {
    refreshInterval = setInterval(() => {
      if (!paused()) refetch();
    }, 3000);
  });
  onCleanup(() => clearInterval(refreshInterval));

  // Auto-scroll log container to bottom on new data when not paused
  let logContainerRef: HTMLDivElement | undefined;
  createEffect(() => {
    const _entries = filteredEntries();
    if (!paused() && logContainerRef) {
      logContainerRef.scrollTop = logContainerRef.scrollHeight;
    }
  });

  // Extract unique sessions and components for filters
  const uniqueSessions = () => {
    const e = entries() ?? [];
    const sessions = new Set<string>();
    for (const entry of e) {
      if (entry.session_id) sessions.add(entry.session_id);
    }
    return Array.from(sessions);
  };

  const uniqueComponents = () => {
    const e = entries() ?? [];
    const components = new Set<string>();
    for (const entry of e) {
      if (entry.component) components.add(entry.component);
    }
    return Array.from(components).sort();
  };

  // Filtered entries
  const filteredEntries = () => {
    let e = entries() ?? [];

    const sessionF = sessionFilter();
    if (sessionF) {
      e = e.filter((entry) => entry.session_id === sessionF);
    }

    const componentF = componentFilter();
    if (componentF) {
      e = e.filter((entry) => entry.component === componentF);
    }

    const search = searchQuery().toLowerCase();
    if (search) {
      e = e.filter((entry) => entry.message.toLowerCase().includes(search) || entry.raw.toLowerCase().includes(search));
    }

    return e;
  };

  const componentColor = (comp: string) => {
    switch (comp) {
      case "event": return "var(--accent)";
      case "transform": return "var(--green)";
      case "dreamer": return "var(--indigo)";
      case "historian": return "var(--purple)";
      case "nudge": return "var(--amber)";
      case "note-nudge": return "var(--amber)";
      default: return "var(--text-secondary)";
    }
  };

  const cacheBarColor = (ratio: number) => {
    if (ratio >= 0.9) return "green";
    if (ratio >= 0.5) return "amber";
    return "red";
  };

  return (
    <>
      <div class="section-header">
        <h1 class="section-title">Logs</h1>
        <div class="section-actions">
          <Show when={!paused()}>
            <span style={{ color: "var(--green)", "font-size": "12px", "margin-right": "8px" }}>● Live</span>
          </Show>
          <button
            class={`btn sm ${paused() ? "primary" : ""}`}
            onClick={() => setPaused(!paused())}
          >
            {paused() ? "▶ Resume" : "⏸ Pause"}
          </button>
        </div>
      </div>

      <div class="filter-bar">
        <input
          class="search-input"
          type="text"
          placeholder="Search logs..."
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
        />
        <FilterSelect
          value={sessionFilter()}
          onChange={setSessionFilter}
          placeholder="All sessions"
          options={[
            { value: "", label: "All sessions" },
            ...uniqueSessions().map((sid) => ({ value: sid, label: truncate(sid, 16) })),
          ]}
        />
        <FilterSelect
          value={componentFilter()}
          onChange={setComponentFilter}
          placeholder="All components"
          options={[
            { value: "", label: "All components" },
            ...uniqueComponents().map((c) => ({ value: c, label: c })),
          ]}
        />
      </div>

      <div class="scroll-area" ref={logContainerRef}>
        <Show
          when={!entries.loading || (entries() ?? []).length > 0}
          fallback={<div class="empty-state">Loading logs...</div>}
        >
          <Show
            when={filteredEntries().length > 0}
            fallback={
              <div class="empty-state">
                <span class="empty-state-icon">📋</span>
                <span>No log entries found</span>
                <span style={{ "font-size": "11px" }}>
                  Log file: /tmp/magic-context.log
                </span>
              </div>
            }
          >
            <div
              style={{
                "font-family": "var(--mono-font)",
                "font-size": "11px",
                "line-height": "1.7",
              }}
            >
              <For each={filteredEntries()}>
                {(entry) => (
                  <div
                    style={{
                      padding: "3px 0",
                      "border-bottom": "1px solid var(--border)",
                      display: "flex",
                      gap: "8px",
                      "align-items": "flex-start",
                    }}
                  >
                    {/* Timestamp */}
                    <span style={{ color: "var(--text-muted)", "white-space": "nowrap", "flex-shrink": "0" }}>
                      {entry.timestamp.split("T").pop()?.split(".")[0] ?? entry.timestamp.slice(0, 19)}
                    </span>
                    {/* Session */}
                    <Show when={entry.session_id}>
                      <span style={{ color: "var(--accent)", "flex-shrink": "0" }}>
                        {truncate(entry.session_id, 8)}
                      </span>
                    </Show>
                    {/* Component */}
                    <span style={{ color: componentColor(entry.component), "flex-shrink": "0", "min-width": "60px" }}>
                      {entry.component}
                    </span>
                    {/* Message */}
                    <span style={{ "word-break": "break-word", flex: "1" }}>
                      {entry.message}
                    </span>
                    {/* Cache bar */}
                    <Show when={entry.hit_ratio != null}>
                      <div style={{ display: "flex", "align-items": "center", gap: "4px", "flex-shrink": "0" }}>
                        <div class="cache-bar" style={{ width: "60px" }}>
                          <div
                            class={`cache-bar-fill ${cacheBarColor(entry.hit_ratio!)}`}
                            style={{ width: `${entry.hit_ratio! * 100}%` }}
                          />
                        </div>
                        <span style={{ color: "var(--text-muted)", "font-size": "10px" }}>
                          {(entry.hit_ratio! * 100).toFixed(0)}%
                        </span>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </>
  );
}
