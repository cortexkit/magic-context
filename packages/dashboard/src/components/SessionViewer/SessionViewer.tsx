import { ask } from "@tauri-apps/plugin-dialog";
import { createEffect, createMemo, createResource, createSignal, For, Index, Show } from "solid-js";
import {
  deleteNote,
  deleteSessionFact,
  dismissNote,
  formatDateTime,
  formatRelativeTime,
  getProjects,
  getSessionCacheEvents,
  getSessionDetail,
  getSmartNotes,
  listSessions,
  truncate,
  updateNote,
  updateSessionFact,
} from "../../lib/api";
import type { DbCacheEvent, Harness, SessionFact, SessionFilter, SessionRow } from "../../lib/types";
import HarnessBadge from "../HarnessBadge";
import FilterSelect from "../shared/FilterSelect";

const PROJECT_FILTER_KEY = "mc_sessions_project_filter";
const HARNESS_FILTER_KEY = "mc_sessions_harness_filter";

/**
 * Compression depth → user-facing label + `.pill` color variant.
 *
 * Maps Magic Context compressor tiers:
 *   0 → no compression (uncompressed historian output)
 *   1 → merge-only (no caveman text compression)
 *   2 → caveman-lite
 *   3 → caveman-full
 *   4 → caveman-ultra
 *   5 → title-only collapse (no LLM call, full body discarded)
 *
 * Returns `null` for depth 0 so callers can render nothing in the common case.
 */
function compressionDepthInfo(
  depth: number,
): { label: string; pillColor: "gray" | "blue" | "amber" | "red"; title: string } | null {
  if (!depth || depth < 1) return null;
  switch (depth) {
    case 1:
      return {
        label: "merged",
        pillColor: "blue",
        title: "Depth 1 · merged with neighbors (no text compression yet)",
      };
    case 2:
      return {
        label: "lite",
        pillColor: "gray",
        title: "Depth 2 · caveman-lite text compression",
      };
    case 3:
      return {
        label: "full",
        pillColor: "amber",
        title: "Depth 3 · caveman-full text compression",
      };
    case 4:
      return {
        label: "ultra",
        pillColor: "amber",
        title: "Depth 4 · caveman-ultra text compression",
      };
    case 5:
      return {
        label: "title-only",
        pillColor: "red",
        title: "Depth 5 · title-only collapse (body discarded, no LLM call)",
      };
    default:
      return {
        label: `d${depth}`,
        pillColor: "red",
        title: `Depth ${depth} · beyond standard tier table`,
      };
  }
}

type ActiveTab = "messages" | "compartments" | "facts" | "notes" | "tokens" | "cache";
type HarnessFilter = "all" | Harness;
type SelectedSession = { harness: Harness; sessionId: string };

const sessionsCache = new Map<string, SessionRow[]>();

function sessionFilterKey(filter: SessionFilter): string {
  return JSON.stringify({
    harness: filter.harness ?? null,
    project_identity: filter.project_identity ?? null,
    search: filter.search ?? null,
  });
}

function loadStoredValue(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function loadHarnessFilter(): HarnessFilter {
  const stored = loadStoredValue(HARNESS_FILTER_KEY);
  return stored === "opencode" || stored === "pi" ? stored : "all";
}

export default function SessionViewer() {
  const [selectedSession, setSelectedSession] = createSignal<SelectedSession | null>(null);
  const [activeTab, setActiveTab] = createSignal<ActiveTab>("messages");
  const [expandedCompartment, setExpandedCompartment] = createSignal<number | null>(null);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [projectFilter, setProjectFilterSignal] = createSignal(loadStoredValue(PROJECT_FILTER_KEY));
  const [harnessFilter, setHarnessFilterSignal] = createSignal<HarnessFilter>(loadHarnessFilter());
  const [showSubagents, setShowSubagents] = createSignal(false);
  const [editingFact, setEditingFact] = createSignal<number | null>(null);
  const [editFactContent, setEditFactContent] = createSignal("");
  const [editingNote, setEditingNote] = createSignal<number | null>(null);
  const [editNoteContent, setEditNoteContent] = createSignal("");

  const [projects] = createResource(getProjects);
  const setProjectFilter = (value: string) => {
    setProjectFilterSignal(value);
    try {
      value ? localStorage.setItem(PROJECT_FILTER_KEY, value) : localStorage.removeItem(PROJECT_FILTER_KEY);
    } catch {}
  };

  const setHarnessFilter = (value: HarnessFilter) => {
    setHarnessFilterSignal(value);
    try {
      value === "all"
        ? localStorage.removeItem(HARNESS_FILTER_KEY)
        : localStorage.setItem(HARNESS_FILTER_KEY, value);
    } catch {}
  };

  const sessionFilter = createMemo<SessionFilter>(() => {
    const filter: SessionFilter = {};
    const harness = harnessFilter();
    if (harness !== "all") filter.harness = harness;
    if (projectFilter()) filter.project_identity = projectFilter();
    if (searchQuery()) filter.search = searchQuery();
    // Server-side subagent filter (issue: subagent rows dominate the table
    // since most dashboards see 90%+ subagent sessions; client-side filter
    // also no-op'd because the backend never populated is_subagent). Send
    // `false` to filter out subagents; skip the key entirely when showing
    // both so the backend treats it as "no filter".
    if (!showSubagents()) filter.is_subagent = false;
    return filter;
  });

  const [sessions, setSessions] = createSignal<SessionRow[]>([]);
  const [sessionsLoading, setSessionsLoading] = createSignal(false);
  let sessionRequestId = 0;

  createEffect(() => {
    const filter = sessionFilter();
    const key = sessionFilterKey(filter);
    const cached = sessionsCache.get(key);
    const requestId = ++sessionRequestId;

    if (cached) {
      setSessions(cached);
      setSessionsLoading(false);
    } else {
      setSessions([]);
      setSessionsLoading(true);
    }

    void listSessions(filter)
      .then((fresh) => {
        sessionsCache.set(key, fresh);
        if (requestId === sessionRequestId) setSessions(fresh);
      })
      .finally(() => {
        if (requestId === sessionRequestId) setSessionsLoading(false);
      });
  });

  const detailKey = createMemo(() => selectedSession());
  const [sessionDetail, { refetch: refetchSessionDetail }] = createResource(detailKey, async (selected) => {
    if (!selected) return null;
    return getSessionDetail(selected.harness, selected.sessionId);
  });

  const [cacheEvents] = createResource(detailKey, async (selected) => {
    if (!selected) return [];
    return getSessionCacheEvents(selected.harness, selected.sessionId);
  });

  // Subagent filtering now lives in `sessionFilter` (server-side) so result
  // limits never silently drop primary sessions in favor of subagents.
  // Keep `filteredSessions` as a memo passthrough so any future client-only
  // filtering (e.g. search-as-you-type before debounce settles) has one
  // obvious place to hook into.
  const filteredSessions = createMemo(() => sessions() ?? []);

  let searchTimeout: number;
  const handleSearch = (value: string) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => setSearchQuery(value), 300) as unknown as number;
  };

  const messages = () => sessionDetail()?.messages ?? [];
  const visibleMessages = () =>
    messages().filter(
      (message) => message.role.toLowerCase() !== "assistant" || message.text_preview.trim().length > 0,
    );
  const compartments = () => sessionDetail()?.compartments ?? [];
  const facts = () => sessionDetail()?.facts ?? [];
  const notes = () => sessionDetail()?.notes ?? [];
  const meta = () => sessionDetail()?.meta ?? null;
  const tokenBreakdown = () => sessionDetail()?.token_breakdown ?? null;
  const piCompactions = () => sessionDetail()?.pi_compaction_entries ?? [];

  const selectedRow = () => {
    const selected = selectedSession();
    if (!selected) return null;
    return (
      sessions()?.find(
        (s) => s.session_id === selected.sessionId && s.harness === selected.harness,
      ) ?? null
    );
  };

  const displayTitle = () =>
    sessionDetail()?.title || selectedRow()?.title || truncate(selectedSession()?.sessionId ?? "", 20);

  const roleClass = (role: string) => {
    switch (role.toLowerCase()) {
      case "user":
        return "blue";
      case "assistant":
        return "green";
      case "system":
        return "gray";
      default:
        return "purple";
    }
  };

  const cacheHitRatio = (event: DbCacheEvent) => {
    const total = event.cache_read + event.cache_write + event.input_tokens;
    return total > 0 ? event.cache_read / total : 0;
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

  const refetchFacts = () => refetchSessionDetail();
  const refetchNotes = () => refetchSessionDetail();

  const [smartNotes, { refetch: refetchSmartNotes }] = createResource(
    () => sessionDetail(),
    async (detail) => {
      if (!detail) return [];
      const project = detail.project_path ?? detail.project_identity;
      if (!project) return [];
      return getSmartNotes(project);
    },
  );

  const toggleCompartment = (id: number) => {
    const isOpening = expandedCompartment() !== id;
    setExpandedCompartment((prev) => (prev === id ? null : id));
    if (isOpening) {
      // Wait for expansion to render before scrolling
      setTimeout(() => {
        document
          .getElementById(`compartment-${id}`)
          ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }, 50);
    }
  };

  // Grouped facts by category
  const groupedFacts = () => {
    const f = facts();
    const groups: Record<string, SessionFact[]> = {};
    for (const fact of f) {
      if (!groups[fact.category]) groups[fact.category] = [];
      groups[fact.category].push(fact);
    }
    return Object.entries(groups);
  };

  // Total message range across all compartments for proportional timeline widths
  const totalRange = createMemo(() => {
    const comps = compartments();
    if (comps.length === 0) return 1;
    const minStart = Math.min(...comps.map((c) => c.start_message));
    const maxEnd = Math.max(...comps.map((c) => c.end_message));
    return Math.max(1, maxEnd - minStart);
  });

  return (
    <>
      <div class="section-header">
        <h1
          class="section-title"
          style={{
            display: "flex",
            "align-items": "flex-start",
            gap: "8px",
            "min-width": 0,
            "flex-wrap": "wrap",
          }}
        >
          <Show when={selectedSession()} fallback="Sessions">
            <button
              type="button"
              class="btn sm"
              style={{ "margin-right": "8px", "flex-shrink": 0 }}
              onClick={() => setSelectedSession(null)}
            >
              ←
            </button>
            <span
              style={{
                display: "inline-flex",
                "align-items": "flex-start",
                gap: "8px",
                "min-width": 0,
                "flex": "1 1 0",
                "overflow-wrap": "anywhere",
                "word-break": "break-word",
              }}
            >
              <Show when={sessionDetail() ?? selectedRow()}>
                {(session) => <HarnessBadge harness={session().harness} />}
              </Show>
              <span style={{ "min-width": 0, "overflow-wrap": "anywhere" }}>{displayTitle()}</span>
            </span>
          </Show>
        </h1>
      </div>

      <Show when={!selectedSession()}>
        {/* Filter bar */}
        <div class="filter-bar">
          <FilterSelect
            value={projectFilter()}
            onChange={setProjectFilter}
            placeholder="All projects"
            align="left"
            options={[
              { value: "", label: "All projects" },
              ...(projects() ?? []).map((p) => ({ value: p.identity, label: p.label })),
            ]}
          />
          <input
            class="search-input"
            type="text"
            placeholder="Search sessions..."
            onInput={(e) => handleSearch(e.currentTarget.value)}
          />
          <FilterSelect
            value={harnessFilter()}
            onChange={(value) => setHarnessFilter(value as HarnessFilter)}
            placeholder="Harness"
            align="right"
            options={[
              { value: "all", label: "Harness: All" },
              { value: "opencode", label: "OpenCode" },
              { value: "pi", label: "Pi" },
            ]}
          />
          <label
            style={{
              display: "flex",
              "align-items": "center",
              gap: "6px",
              "font-size": "12px",
              color: "var(--text-secondary)",
              cursor: "pointer",
              "white-space": "nowrap",
              "user-select": "none",
            }}
          >
            <input
              type="checkbox"
              class="tri-checkbox"
              checked={showSubagents()}
              onChange={(e) => setShowSubagents(e.currentTarget.checked)}
              aria-label="Show subagent sessions"
            />
            Subagents
          </label>
        </div>

        {/* Session list */}
        <div class="scroll-area">
          <Show when={!sessionsLoading()} fallback={<div class="empty-state">Loading sessions...</div>}>
            <div class="list-gap">
              <For each={filteredSessions()}>
                {(session) => {
                  return (
                    <button
                      type="button"
                      class="card"
                      style={{ cursor: "pointer", "text-align": "left", width: "100%" }}
                      onClick={() => {
                        setSelectedSession({ harness: session.harness, sessionId: session.session_id });
                        setActiveTab("messages");
                      }}
                    >
                      <div
                        class="card-title"
                        style={{ display: "flex", "align-items": "center", gap: "8px", "min-width": "0" }}
                      >
                        <HarnessBadge harness={session.harness} />
                        <span
                          style={{
                            flex: "1 1 auto",
                            "min-width": "0",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                          }}
                        >
                          {session.title || truncate(session.session_id, 20)}
                        </span>
                        <Show when={session.is_subagent}>
                          <span class="pill gray">subagent</span>
                        </Show>
                        <Show when={!session.title}>
                          <span
                            class="mono"
                            style={{ "font-size": "10px", color: "var(--text-muted)" }}
                          >
                            {truncate(session.session_id, 16)}
                          </span>
                        </Show>
                      </div>
                      <div class="card-meta">
                        <span>{session.message_count} messages</span>
                        <span>·</span>
                        <span>{session.project_display}</span>
                        <span>·</span>
                        <span>Last active: {formatRelativeTime(session.last_activity_ms)}</span>
                      </div>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={selectedSession()}>
        {/* Session detail */}
        <div class="tab-pills">
          <button
            type="button"
            class={`tab-pill ${activeTab() === "messages" ? "active" : ""}`}
            onClick={() => setActiveTab("messages")}
          >
            Messages ({visibleMessages().length})
          </button>
          <button
            type="button"
            class={`tab-pill ${activeTab() === "compartments" ? "active" : ""}`}
            onClick={() => setActiveTab("compartments")}
          >
            Compartments ({compartments().length})
          </button>
          <button
            type="button"
            class={`tab-pill ${activeTab() === "facts" ? "active" : ""}`}
            onClick={() => setActiveTab("facts")}
          >
            Facts ({facts().length})
          </button>
          <button
            type="button"
            class={`tab-pill ${activeTab() === "notes" ? "active" : ""}`}
            onClick={() => setActiveTab("notes")}
          >
            Notes ({notes().length + (smartNotes()?.length ?? 0)})
          </button>
          <button
            type="button"
            class={`tab-pill ${activeTab() === "tokens" ? "active" : ""}`}
            onClick={() => setActiveTab("tokens")}
          >
            Meta
          </button>
          <button
            type="button"
            class={`tab-pill ${activeTab() === "cache" ? "active" : ""}`}
            onClick={() => setActiveTab("cache")}
          >
            Cache ({cacheEvents()?.length ?? 0})
          </button>
        </div>

        <Show when={sessionDetail()}>
          {(detail) => (
            <div class="card" style={{ margin: "0 20px 12px", padding: "10px 14px" }}>
              <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "4px" }}>
                <HarnessBadge harness={detail().harness} />
                <span class="card-title" style={{ margin: 0 }}>{detail().project_display}</span>
              </div>
              <div class="card-meta">
                <span class="mono">{detail().session_id}</span>
                <Show when={detail().pi_jsonl_path}>
                  {(path) => <span class="mono">JSONL: {path()}</span>}
                </Show>
                <Show when={detail().opencode_session_json}>
                  <span class="pill gray">OpenCode session JSON available</span>
                </Show>
              </div>
            </div>
          )}
        </Show>

        {/* Timeline bar - fixed outside scroll, aligned with scroll content */}
        <Show when={activeTab() === "compartments" && (compartments()).length > 0}>
          <div style={{ padding: "0 28px 12px 20px" }}>
            <div class="timeline-bar">
              <For each={compartments()}>
                {(comp) => {
                  const range = comp.end_message - comp.start_message;
                  const width = () => Math.max(0.5, (range / totalRange()) * 100);
                  // Fade saturation and lightness with depth so compressed
                  // compartments visually recede on the timeline (depth 0 =
                  // full color, depth 5 = nearly gray). Clamped so even the
                  // most compressed segments stay visible.
                  const isExpanded = () => expandedCompartment() === comp.id;
                  const depth = comp.compression_depth ?? 0;
                  const sat = Math.max(15, (isExpanded() ? 70 : 50) - depth * 8);
                  const light = Math.max(28, (isExpanded() ? 55 : 40) - depth * 2);
                  const depthInfo = compressionDepthInfo(depth);
                  const titleSuffix = depthInfo ? ` · d${depth} ${depthInfo.label}` : "";
                  return (
                    <button
                      type="button"
                      class="timeline-segment"
                      style={{
                        width: `${width()}%`,
                        background: `hsl(${(comp.sequence * 37) % 360}, ${sat}%, ${light}%)`,
                        outline: isExpanded() ? "2px solid var(--accent)" : "none",
                        border: "none",
                        padding: 0,
                      }}
                      title={`#${comp.sequence}: ${comp.title}${titleSuffix}`}
                      onClick={() => toggleCompartment(comp.id)}
                    />
                  );
                }}
              </For>
            </div>
          </div>
        </Show>

        <div class="scroll-area">
          {/* Compartments tab */}
          <Show when={activeTab() === "messages"}>
            <Show when={!sessionDetail.loading} fallback={<div class="empty-state">Loading...</div>}>
              <div class="list-gap">
                <Show when={piCompactions().length > 0}>
                  <div class="card" style={{ "border-left": "3px solid var(--purple)" }}>
                    <div class="card-title">Pi compaction markers: {piCompactions().length}</div>
                    <div class="card-meta">
                      <For each={piCompactions()}>
                        {(entry) => (
                          <span>
                            before {truncate(entry.first_kept_entry_id, 12)} summarized · {entry.tokens_before.toLocaleString()} tokens
                          </span>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
                <Show
                  when={visibleMessages().length > 0}
                  fallback={<div class="empty-state"><span class="empty-state-icon">💬</span>No messages</div>}
                >
                  <For each={visibleMessages()}>
                    {(message) => (
                      <div class="card">
                        <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "6px" }}>
                          <span class={`pill ${roleClass(message.role)}`}>{message.role}</span>
                          <span class="mono" style={{ "font-size": "11px", color: "var(--text-secondary)" }}>
                            {formatDateTime(message.timestamp_ms)}
                          </span>
                          <span class="mono" style={{ "font-size": "10px", color: "var(--text-muted)" }}>
                            {truncate(message.message_id, 16)}
                          </span>
                        </div>
                        <div
                          style={{
                            "font-size": "12px",
                            "line-height": "1.6",
                            "white-space": "pre-wrap",
                            color: ["user", "assistant", "system"].includes(message.role.toLowerCase())
                              ? "var(--text-primary)"
                              : "var(--text-secondary)",
                            "font-style": ["user", "assistant", "system"].includes(message.role.toLowerCase())
                              ? "normal"
                              : "italic",
                          }}
                        >
                          {message.text_preview}
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </Show>
          </Show>

          {/* Compartments tab */}
          <Show when={activeTab() === "compartments"}>
            <Show when={!sessionDetail.loading} fallback={<div class="empty-state">Loading...</div>}>
              <Show
                when={(compartments()).length > 0}
                fallback={
                  <div class="empty-state">
                    <span class="empty-state-icon">📜</span>No compartments
                  </div>
                }
              >
                <div class="list-gap">
                  <For each={compartments()}>
                    {(comp) => (
                      <button
                        type="button"
                        id={`compartment-${comp.id}`}
                        class="card"
                        onClick={() => toggleCompartment(comp.id)}
                        style={{ cursor: "pointer", "text-align": "left", width: "100%" }}
                      >
                        <div
                          style={{
                            display: "flex",
                            "justify-content": "space-between",
                            "align-items": "center",
                          }}
                        >
                          <div class="card-title">
                            <span
                              class="mono"
                              style={{ color: "var(--text-muted)", "margin-right": "6px" }}
                            >
                              #{comp.sequence}
                            </span>
                            Messages {comp.start_message}–{comp.end_message}
                            {(() => {
                              const info = compressionDepthInfo(comp.compression_depth);
                              return info ? (
                                <span
                                  class={`pill ${info.pillColor}`}
                                  style={{ "margin-left": "8px" }}
                                  title={info.title}
                                >
                                  d{comp.compression_depth} · {info.label}
                                </span>
                              ) : null;
                            })()}
                            {comp.start_time && comp.end_time && (
                              <span
                                style={{
                                  color: "var(--text-muted)",
                                  "font-size": "11px",
                                  "margin-left": "8px",
                                }}
                              >
                                {formatDateTime(comp.start_time)} → {formatDateTime(comp.end_time)}
                              </span>
                            )}
                          </div>
                          <span style={{ "font-size": "11px", color: "var(--text-muted)" }}>
                            {expandedCompartment() === comp.id ? "▲" : "▼"}
                          </span>
                        </div>
                        <div class="card-meta">{truncate(comp.title, 120)}</div>
                        <div
                          class={`expandable-content ${expandedCompartment() === comp.id ? "expanded" : "collapsed"}`}
                        >
                          <div
                            style={{
                              "margin-top": "10px",
                              padding: "10px",
                              background: "var(--bg-base)",
                              "border-radius": "var(--radius-md)",
                              "font-size": "12px",
                              "line-height": "1.6",
                              "word-break": "break-word",
                            }}
                          >
                            <Index each={comp.content.split("\n")}>
                              {(line) => {
                                const isUser = () => line().startsWith("U:");
                                return (
                                  <div
                                    style={{
                                      "font-weight": isUser() ? "600" : "normal",
                                      color: isUser()
                                        ? "var(--text-primary)"
                                        : "var(--text-secondary)",
                                      "margin-bottom": "2px",
                                      "white-space": "pre-wrap",
                                    }}
                                  >
                                    {line()}
                                  </div>
                                );
                              }}
                            </Index>
                          </div>
                        </div>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>

          {/* Facts tab */}
          <Show when={activeTab() === "facts"}>
            <Show
              when={(facts()).length > 0}
              fallback={
                <div class="empty-state">
                  <span class="empty-state-icon">📝</span>No facts
                </div>
              }
            >
              <div class="list-gap">
                <For each={groupedFacts()}>
                  {([category, categoryFacts]) => (
                    <>
                      <div class="category-header">
                        {category} <span class="category-count">({categoryFacts.length})</span>
                      </div>
                      <For each={categoryFacts}>
                        {(fact) => (
                          <div class="card">
                            <Show
                              when={editingFact() === fact.id}
                              fallback={
                                <>
                                  <div
                                    style={{
                                      "font-size": "12px",
                                      "white-space": "pre-wrap",
                                      "line-height": "1.6",
                                    }}
                                  >
                                    {fact.content}
                                  </div>
                                  <div
                                    style={{
                                      display: "flex",
                                      gap: "6px",
                                      "margin-top": "6px",
                                      "justify-content": "flex-end",
                                    }}
                                  >
                                    <button
                                      type="button"
                                      class="btn sm"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setEditingFact(fact.id);
                                        setEditFactContent(fact.content);
                                      }}
                                    >
                                      Edit
                                    </button>
                                    <button
                                      type="button"
                                      class="btn sm"
                                      style={{ color: "var(--red)" }}
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        if (
                                          !(await ask("Delete this fact? This cannot be undone.", {
                                            title: "Confirm Delete",
                                            kind: "warning",
                                          }))
                                        )
                                          return;
                                        try {
                                          await deleteSessionFact(fact.id);
                                          refetchFacts();
                                        } catch (err) {
                                          console.error(err);
                                        }
                                      }}
                                    >
                                      Delete
                                    </button>
                                  </div>
                                </>
                              }
                            >
                              <textarea
                                class="code-editor"
                                style={{ "min-height": "80px", "font-size": "12px" }}
                                value={editFactContent()}
                                onInput={(e) => setEditFactContent(e.currentTarget.value)}
                              />
                              <div
                                style={{
                                  display: "flex",
                                  gap: "6px",
                                  "margin-top": "6px",
                                  "justify-content": "flex-end",
                                }}
                              >
                                <button
                                  type="button"
                                  class="btn primary sm"
                                  onClick={async () => {
                                    try {
                                      await updateSessionFact(fact.id, editFactContent());
                                      setEditingFact(null);
                                      refetchFacts();
                                    } catch (err) {
                                      console.error(err);
                                    }
                                  }}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  class="btn sm"
                                  onClick={() => setEditingFact(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </Show>
                          </div>
                        )}
                      </For>
                    </>
                  )}
                </For>
              </div>
            </Show>
          </Show>

          {/* Notes tab */}
          <Show when={activeTab() === "notes"}>
            <div class="list-gap">
              {/* Session Notes */}
              <Show
                when={notes().length > 0}
                fallback={
                  <div class="empty-state">
                    <span class="empty-state-icon">📌</span>No session notes
                  </div>
                }
              >
                <div class="list-gap">
                  <For each={notes()}>
                    {(note) => (
                      <div class="card">
                        <Show
                          when={editingNote() === note.id}
                          fallback={
                            <>
                              <div
                                style={{
                                  "font-size": "12px",
                                  "white-space": "pre-wrap",
                                  "line-height": "1.6",
                                }}
                              >
                                {note.content}
                              </div>
                              <div
                                style={{
                                  display: "flex",
                                  "justify-content": "space-between",
                                  "align-items": "center",
                                  "margin-top": "6px",
                                }}
                              >
                                <div class="card-meta">{formatRelativeTime(note.created_at)}</div>
                                <div style={{ display: "flex", gap: "6px" }}>
                                  <button
                                    type="button"
                                    class="btn sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEditingNote(note.id);
                                      setEditNoteContent(note.content);
                                    }}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    class="btn sm"
                                    style={{ color: "var(--red)" }}
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      if (
                                        !(await ask("Delete this note? This cannot be undone.", {
                                          title: "Confirm Delete",
                                          kind: "warning",
                                        }))
                                      )
                                        return;
                                      try {
                                        await deleteNote(note.id);
                                        refetchNotes();
                                      } catch (err) {
                                        console.error(err);
                                      }
                                    }}
                                  >
                                    Delete
                                  </button>
                                </div>
                              </div>
                            </>
                          }
                        >
                          <textarea
                            class="code-editor"
                            style={{ "min-height": "80px", "font-size": "12px" }}
                            value={editNoteContent()}
                            onInput={(e) => setEditNoteContent(e.currentTarget.value)}
                          />
                          <div
                            style={{
                              display: "flex",
                              gap: "6px",
                              "margin-top": "6px",
                              "justify-content": "flex-end",
                            }}
                          >
                            <button
                              type="button"
                              class="btn primary sm"
                              onClick={async () => {
                                try {
                                  await updateNote(note.id, editNoteContent());
                                  setEditingNote(null);
                                  refetchNotes();
                                } catch (err) {
                                  console.error(err);
                                }
                              }}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              class="btn sm"
                              onClick={() => setEditingNote(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              {/* Smart Notes */}
              <Show when={(smartNotes() ?? []).length > 0}>
                <div class="category-header" style={{ "margin-top": "16px" }}>
                  Smart Notes <span class="category-count">({smartNotes()?.length})</span>
                </div>
                <div class="list-gap">
                  <For each={smartNotes() ?? []}>
                    {(smartNote) => (
                      <div class="card" style={{ "border-left": "3px solid var(--accent)" }}>
                        <div
                          style={{
                            "font-size": "12px",
                            "white-space": "pre-wrap",
                            "line-height": "1.6",
                          }}
                        >
                          {smartNote.content}
                        </div>
                        <div
                          style={{
                            "margin-top": "8px",
                            "font-size": "11px",
                            color: "var(--text-secondary)",
                          }}
                        >
                          <span style={{ "font-weight": 500 }}>Trigger:</span>{" "}
                          {smartNote.surface_condition}
                        </div>
                        <div
                          style={{
                            "margin-top": "6px",
                            display: "flex",
                            "align-items": "center",
                            "justify-content": "space-between",
                          }}
                        >
                          <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                            <span
                              class="pill"
                              style={{
                                "font-size": "10px",
                                "text-transform": "uppercase",
                                background:
                                  smartNote.status === "ready"
                                    ? "var(--success)"
                                    : "var(--text-muted)",
                                color:
                                  smartNote.status === "ready" ? "#fff" : "var(--text-primary)",
                              }}
                            >
                              {smartNote.status}
                            </span>
                            <Show when={smartNote.status === "ready" && smartNote.ready_reason}>
                              <span
                                style={{
                                  "font-size": "11px",
                                  color: "var(--text-secondary)",
                                  "font-style": "italic",
                                }}
                              >
                                {smartNote.ready_reason}
                              </span>
                            </Show>
                          </div>
                          <div style={{ display: "flex", gap: "6px" }}>
                            <button
                              type="button"
                              class="btn sm"
                              style={{ color: "var(--text-muted)" }}
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (
                                  !(await ask("Dismiss this smart note?", {
                                    title: "Confirm Dismiss",
                                    kind: "info",
                                  }))
                                )
                                  return;
                                try {
                                  await dismissNote(smartNote.id);
                                  refetchSmartNotes();
                                } catch (err) {
                                  console.error(err);
                                }
                              }}
                            >
                              Dismiss
                            </button>
                            <button
                              type="button"
                              class="btn sm"
                              style={{ color: "var(--red)" }}
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (
                                  !(await ask("Delete this smart note? This cannot be undone.", {
                                    title: "Confirm Delete",
                                    kind: "warning",
                                  }))
                                )
                                  return;
                                try {
                                  await deleteNote(smartNote.id);
                                  refetchSmartNotes();
                                } catch (err) {
                                  console.error(err);
                                }
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>

          {/* OpenCode meta table shown inside Meta tab */}
          <Show when={activeTab() === "tokens" && meta()}>
            <Show when={meta()} fallback={<div class="empty-state">No meta data</div>}>
              {(metaData) => (
                <table class="kv-table">
                  <tbody>
                    <tr>
                      <td>Session ID</td>
                      <td>{metaData().session_id}</td>
                    </tr>
                    <tr>
                      <td>Counter</td>
                      <td>{metaData().counter}</td>
                    </tr>
                    <tr>
                      <td>Context %</td>
                      <td>{metaData().last_context_percentage.toFixed(1)}%</td>
                    </tr>
                    <tr>
                      <td>Input tokens</td>
                      <td>{metaData().last_input_tokens.toLocaleString()}</td>
                    </tr>
                    <tr>
                      <td>Cache TTL</td>
                      <td>{metaData().cache_ttl ?? "—"}</td>
                    </tr>
                    <tr>
                      <td>Nudge tokens</td>
                      <td>{metaData().last_nudge_tokens.toLocaleString()}</td>
                    </tr>
                    <tr>
                      <td>Nudge band</td>
                      <td>{metaData().last_nudge_band || "—"}</td>
                    </tr>
                    <tr>
                      <td>Execute hits</td>
                      <td>{metaData().times_execute_threshold_reached}</td>
                    </tr>
                    <Show when={sessionDetail()?.harness !== "pi"}>
                      <tr>
                        <td>Subagent</td>
                        <td>{metaData().is_subagent ? "Yes" : "No"}</td>
                      </tr>
                    </Show>
                    <tr>
                      <td>Compartment WIP</td>
                      <td>{metaData().compartment_in_progress ? "Yes" : "No"}</td>
                    </tr>
                    <tr>
                      <td>Memory blocks</td>
                      <td>{metaData().memory_block_count}</td>
                    </tr>
                    <tr>
                      <td>System hash</td>
                      <td>{truncate(metaData().system_prompt_hash, 16) || "—"}</td>
                    </tr>
                  </tbody>
                </table>
              )}
            </Show>
          </Show>

          {/* Spacer between Meta key-value table and the Context Token Breakdown card. */}
          <Show when={activeTab() === "tokens"}>
            <div style={{ height: "16px" }} />
          </Show>

          {/* Token breakdown shown inside Meta tab */}
          <Show when={activeTab() === "tokens"}>
            <Show
              when={tokenBreakdown()}
              fallback={<div class="empty-state">No token data available</div>}
            >
              {(data) => {
                const total = () => data().total_input_tokens;
                const hasData = () => total() > 0;

                // Calculate percentages
                const systemPct = () =>
                  hasData() ? (data().system_prompt_tokens / total()) * 100 : 0;
                const compartmentPct = () =>
                  hasData() ? (data().compartment_tokens / total()) * 100 : 0;
                const factPct = () => (hasData() ? (data().fact_tokens / total()) * 100 : 0);
                const memoryPct = () => (hasData() ? (data().memory_tokens / total()) * 100 : 0);
                const conversationPct = () =>
                  hasData() ? (data().conversation_tokens / total()) * 100 : 0;

                // Colors for each section
                const colors = {
                  system: "#c084fc",
                  compartments: "#4a9eff",
                  facts: "#f0b429",
                  memories: "#48bb78",
                  conversation: "#a0aec0",
                };

                return (
                  <div class="list-gap">
                    {/* Stacked bar */}
                    <div class="card">
                      <div class="card-title" style={{ "margin-bottom": "16px" }}>
                        Context Token Breakdown
                      </div>

                      <Show
                        when={hasData()}
                        fallback={<div class="empty-state">No input token data recorded</div>}
                      >
                        {/* Stacked bar visualization */}
                        <div
                          style={{
                            display: "flex",
                            height: "32px",
                            "border-radius": "8px",
                            overflow: "hidden",
                            "margin-bottom": "20px",
                          }}
                        >
                          <Show when={data().system_prompt_tokens > 0}>
                            <div
                              style={{
                                width: `${systemPct()}%`,
                                background: colors.system,
                                display: "flex",
                                "align-items": "center",
                                "justify-content": "center",
                                "font-size": "11px",
                                "font-weight": "600",
                                color: "#fff",
                                "min-width": systemPct() > 8 ? "auto" : "0",
                              }}
                            >
                              {systemPct() > 8 ? `${systemPct().toFixed(0)}%` : ""}
                            </div>
                          </Show>
                          <Show when={data().compartment_tokens > 0}>
                            <div
                              style={{
                                width: `${compartmentPct()}%`,
                                background: colors.compartments,
                                display: "flex",
                                "align-items": "center",
                                "justify-content": "center",
                                "font-size": "11px",
                                "font-weight": "600",
                                color: "#fff",
                                "min-width": compartmentPct() > 8 ? "auto" : "0",
                              }}
                            >
                              {compartmentPct() > 8 ? `${compartmentPct().toFixed(0)}%` : ""}
                            </div>
                          </Show>
                          <Show when={data().fact_tokens > 0}>
                            <div
                              style={{
                                width: `${factPct()}%`,
                                background: colors.facts,
                                display: "flex",
                                "align-items": "center",
                                "justify-content": "center",
                                "font-size": "11px",
                                "font-weight": "600",
                                color: "#1a1a1a",
                                "min-width": factPct() > 8 ? "auto" : "0",
                              }}
                            >
                              {factPct() > 8 ? `${factPct().toFixed(0)}%` : ""}
                            </div>
                          </Show>
                          <Show when={data().memory_tokens > 0}>
                            <div
                              style={{
                                width: `${memoryPct()}%`,
                                background: colors.memories,
                                display: "flex",
                                "align-items": "center",
                                "justify-content": "center",
                                "font-size": "11px",
                                "font-weight": "600",
                                color: "#fff",
                                "min-width": memoryPct() > 8 ? "auto" : "0",
                              }}
                            >
                              {memoryPct() > 8 ? `${memoryPct().toFixed(0)}%` : ""}
                            </div>
                          </Show>
                          <Show when={data().conversation_tokens > 0}>
                            <div
                              style={{
                                width: `${conversationPct()}%`,
                                background: colors.conversation,
                                display: "flex",
                                "align-items": "center",
                                "justify-content": "center",
                                "font-size": "11px",
                                "font-weight": "600",
                                color: "#1a1a1a",
                                "min-width": conversationPct() > 8 ? "auto" : "0",
                              }}
                            >
                              {conversationPct() > 8 ? `${conversationPct().toFixed(0)}%` : ""}
                            </div>
                          </Show>
                        </div>

                        {/* Legend with details */}
                        <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
                          {/* System Prompt */}
                          <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                            <div
                              style={{
                                width: "12px",
                                height: "12px",
                                "border-radius": "3px",
                                background: colors.system,
                                "flex-shrink": "0",
                              }}
                            />
                            <div
                              style={{
                                flex: 1,
                                display: "flex",
                                "justify-content": "space-between",
                                "align-items": "center",
                              }}
                            >
                              <span style={{ "font-size": "13px" }}>System Prompt</span>
                              <span
                                style={{
                                  "font-size": "13px",
                                  "font-weight": "500",
                                  "font-family": "var(--font-mono)",
                                }}
                              >
                                {data().system_prompt_tokens.toLocaleString()}{" "}
                                <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>
                                  ({systemPct().toFixed(1)}%)
                                </span>
                              </span>
                            </div>
                          </div>

                          {/* Compartments */}
                          <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                            <div
                              style={{
                                width: "12px",
                                height: "12px",
                                "border-radius": "3px",
                                background: colors.compartments,
                                "flex-shrink": "0",
                              }}
                            />
                            <div
                              style={{
                                flex: 1,
                                display: "flex",
                                "justify-content": "space-between",
                                "align-items": "center",
                              }}
                            >
                              <span style={{ "font-size": "13px" }}>
                                Compartments{" "}
                                <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>
                                  ({data().compartment_count})
                                </span>
                              </span>
                              <span
                                style={{
                                  "font-size": "13px",
                                  "font-weight": "500",
                                  "font-family": "var(--font-mono)",
                                }}
                              >
                                {data().compartment_tokens.toLocaleString()}{" "}
                                <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>
                                  ({compartmentPct().toFixed(1)}%)
                                </span>
                              </span>
                            </div>
                          </div>

                          {/* Facts */}
                          <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                            <div
                              style={{
                                width: "12px",
                                height: "12px",
                                "border-radius": "3px",
                                background: colors.facts,
                                "flex-shrink": "0",
                              }}
                            />
                            <div
                              style={{
                                flex: 1,
                                display: "flex",
                                "justify-content": "space-between",
                                "align-items": "center",
                              }}
                            >
                              <span style={{ "font-size": "13px" }}>
                                Facts{" "}
                                <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>
                                  ({data().fact_count})
                                </span>
                              </span>
                              <span
                                style={{
                                  "font-size": "13px",
                                  "font-weight": "500",
                                  "font-family": "var(--font-mono)",
                                }}
                              >
                                {data().fact_tokens.toLocaleString()}{" "}
                                <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>
                                  ({factPct().toFixed(1)}%)
                                </span>
                              </span>
                            </div>
                          </div>

                          {/* Memories */}
                          <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                            <div
                              style={{
                                width: "12px",
                                height: "12px",
                                "border-radius": "3px",
                                background: colors.memories,
                                "flex-shrink": "0",
                              }}
                            />
                            <div
                              style={{
                                flex: 1,
                                display: "flex",
                                "justify-content": "space-between",
                                "align-items": "center",
                              }}
                            >
                              <span style={{ "font-size": "13px" }}>
                                Memories{" "}
                                <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>
                                  ({data().memory_count})
                                </span>
                              </span>
                              <span
                                style={{
                                  "font-size": "13px",
                                  "font-weight": "500",
                                  "font-family": "var(--font-mono)",
                                }}
                              >
                                {data().memory_tokens.toLocaleString()}{" "}
                                <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>
                                  ({memoryPct().toFixed(1)}%)
                                </span>
                              </span>
                            </div>
                          </div>

                          {/* Conversation */}
                          <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                            <div
                              style={{
                                width: "12px",
                                height: "12px",
                                "border-radius": "3px",
                                background: colors.conversation,
                                "flex-shrink": "0",
                              }}
                            />
                            <div
                              style={{
                                flex: 1,
                                display: "flex",
                                "justify-content": "space-between",
                                "align-items": "center",
                              }}
                            >
                              <span style={{ "font-size": "13px" }}>Conversation</span>
                              <span
                                style={{
                                  "font-size": "13px",
                                  "font-weight": "500",
                                  "font-family": "var(--font-mono)",
                                }}
                              >
                                {data().conversation_tokens.toLocaleString()}{" "}
                                <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>
                                  ({conversationPct().toFixed(1)}%)
                                </span>
                              </span>
                            </div>
                          </div>

                          {/* Divider */}
                          <div
                            style={{
                              "border-top": "1px solid var(--border-color)",
                              margin: "8px 0",
                            }}
                          />

                          {/* Total */}
                          <div
                            style={{
                              display: "flex",
                              "justify-content": "space-between",
                              "align-items": "center",
                            }}
                          >
                            <span style={{ "font-size": "13px", "font-weight": "600" }}>
                              Total Input Tokens
                            </span>
                            <span
                              style={{
                                "font-size": "14px",
                                "font-weight": "600",
                                "font-family": "var(--font-mono)",
                              }}
                            >
                              {data().total_input_tokens.toLocaleString()}
                            </span>
                          </div>
                        </div>
                      </Show>
                    </div>
                  </div>
                );
              }}
            </Show>
          </Show>

          {/* Cache tab */}
          <Show when={activeTab() === "cache"}>
            <Show when={!cacheEvents.loading} fallback={<div class="empty-state">Loading cache events...</div>}>
              <Show
                when={(cacheEvents() ?? []).length > 0}
                fallback={
                  <div class="empty-state">
                    <span class="empty-state-icon">📊</span>
                    <span>No cache data yet</span>
                  </div>
                }
              >
                <div class="list-gap">
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
                      <span>{cacheEvents()?.length ?? 0} events</span>
                    </div>
                    <div class="chart-bars">
                      <For each={cacheEvents() ?? []}>
                        {(event) => {
                          const ratio = () => cacheHitRatio(event);
                          return (
                            <div
                              class={`chart-bar ${ratio() === 0 ? "black" : severityBarClass(ratio())}`}
                              style={{ height: `${Math.max(3, ratio() * 100)}%` }}
                              title={`${formatDateTime(event.timestamp)}\nHit: ${(ratio() * 100).toFixed(1)}%\nPrompt: ${(event.cache_read + event.cache_write + event.input_tokens).toLocaleString()}\nCached: ${event.cache_read.toLocaleString()}\nNew: ${event.cache_write.toLocaleString()}\nUncached: ${event.input_tokens.toLocaleString()}${event.cause ? `\nCause: ${event.cause}` : ""}`}
                            />
                          );
                        }}
                      </For>
                    </div>
                  </div>

                  <For each={[...(cacheEvents() ?? [])].reverse()}>
                    {(event) => {
                      const ratio = cacheHitRatio(event);
                      const totalPrompt = event.cache_read + event.cache_write + event.input_tokens;
                      return (
                        <div class="card">
                          <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "4px" }}>
                            <span>{severityIcon(event.severity)}</span>
                            <span class="mono" style={{ "font-size": "11px", color: "var(--text-secondary)" }}>
                              {formatDateTime(event.timestamp)}
                            </span>
                            <span class={`pill ${event.severity === "stable" ? "green" : event.severity === "info" ? "blue" : event.severity === "warning" ? "amber" : "red"}`}>
                              {event.severity === "full_bust" ? "FULL BUST" : event.severity.toUpperCase()}
                            </span>
                          </div>
                          <div class="card-meta" style={{ gap: "12px" }}>
                            <span class="mono" style={{ color: hitColor(ratio), "font-weight": "600" }}>
                              {(ratio * 100).toFixed(1)}%
                            </span>
                            <span class="mono">prompt={totalPrompt.toLocaleString()}</span>
                            <span class="mono">cached={event.cache_read.toLocaleString()}</span>
                            <span class="mono">new={event.cache_write.toLocaleString()}</span>
                            <div class="cache-bar">
                              <div class={`cache-bar-fill ${severityBarClass(ratio)}`} style={{ width: `${ratio * 100}%` }} />
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
          </Show>
        </div>
      </Show>
    </>
  );
}
