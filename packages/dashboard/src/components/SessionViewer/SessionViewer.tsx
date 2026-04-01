import { createSignal, createResource, createMemo, For, Index, Show } from "solid-js";
import type { SessionSummary, Compartment, SessionFact, SessionNote, SessionMetaRow, ContextTokenBreakdown } from "../../lib/types";
import {
  getProjects,
  getSessions,
  getCompartments,
  getSessionFacts,
  getSessionNotes,
  getSessionMeta,
  getContextTokenBreakdown,
  formatRelativeTime,
  truncate,
} from "../../lib/api";
import FilterSelect from "../shared/FilterSelect";

export default function SessionViewer() {
  const [selectedSession, setSelectedSession] = createSignal<string | null>(null);
  const [activeTab, setActiveTab] = createSignal<"compartments" | "facts" | "notes" | "meta" | "tokens">("compartments");
  const [expandedCompartment, setExpandedCompartment] = createSignal<number | null>(null);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [projectFilter, setProjectFilter] = createSignal("");
  const [showSubagents, setShowSubagents] = createSignal(false);

  const [projects] = createResource(getProjects);
  const [sessions] = createResource(getSessions);

  const filteredSessions = createMemo(() => {
    let list = sessions() ?? [];
    const query = searchQuery().toLowerCase();
    const project = projectFilter();
    if (query) {
      list = list.filter(s =>
        (s.title ?? "").toLowerCase().includes(query) ||
        s.session_id.toLowerCase().includes(query)
      );
    }
    if (project) {
      list = list.filter(s => s.project_identity === project);
    }
    if (!showSubagents()) {
      list = list.filter(s => !s.is_subagent);
    }
    return list;
  });

  let searchTimeout: number;
  const handleSearch = (value: string) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => setSearchQuery(value), 300) as unknown as number;
  };

  const [compartments] = createResource(selectedSession, async (sid) => {
    if (!sid) return [];
    return getCompartments(sid);
  });

  const [facts] = createResource(selectedSession, async (sid) => {
    if (!sid) return [];
    return getSessionFacts(sid);
  });

  const [notes] = createResource(selectedSession, async (sid) => {
    if (!sid) return [];
    return getSessionNotes(sid);
  });

  const [meta] = createResource(selectedSession, async (sid) => {
    if (!sid) return null;
    return getSessionMeta(sid);
  });

  const [tokenBreakdown] = createResource(selectedSession, async (sid) => {
    if (!sid) return null;
    return getContextTokenBreakdown(sid);
  });

  const toggleCompartment = (id: number) => {
    const isOpening = expandedCompartment() !== id;
    setExpandedCompartment((prev) => (prev === id ? null : id));
    if (isOpening) {
      // Wait for expansion to render before scrolling
      setTimeout(() => {
        document.getElementById(`compartment-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }, 50);
    }
  };

  // Grouped facts by category
  const groupedFacts = () => {
    const f = facts() ?? [];
    const groups: Record<string, SessionFact[]> = {};
    for (const fact of f) {
      if (!groups[fact.category]) groups[fact.category] = [];
      groups[fact.category].push(fact);
    }
    return Object.entries(groups);
  };

  // Total message range across all compartments for proportional timeline widths
  const totalRange = createMemo(() => {
    const comps = compartments() ?? [];
    if (comps.length === 0) return 1;
    const minStart = Math.min(...comps.map(c => c.start_message));
    const maxEnd = Math.max(...comps.map(c => c.end_message));
    return Math.max(1, maxEnd - minStart);
  });

  return (
    <>
      <div class="section-header">
        <h1 class="section-title">
          <Show when={selectedSession()} fallback="Sessions">
            <button
              class="btn sm"
              style={{ "margin-right": "8px" }}
              onClick={() => setSelectedSession(null)}
            >
              ←
            </button>
            {sessions()?.find(s => s.session_id === selectedSession())?.title || truncate(selectedSession()!, 20)}
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
          <label style={{ display: "flex", "align-items": "center", gap: "4px", "font-size": "12px", color: "var(--text-secondary)", cursor: "pointer", "white-space": "nowrap" }}>
            <input
              type="checkbox"
              checked={showSubagents()}
              onChange={(e) => setShowSubagents(e.currentTarget.checked)}
            />
            Subagents
          </label>
        </div>

        {/* Session list */}
        <div class="scroll-area">
          <Show
            when={!sessions.loading}
            fallback={<div class="empty-state">Loading sessions...</div>}
          >
            <div class="list-gap">
              <For each={filteredSessions()}>
                {(session) => {
                  return (
                    <div class="card" style={{ cursor: "pointer" }} onClick={() => setSelectedSession(session.session_id)}>
                      <div class="card-title" style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                        <span>{session.title || truncate(session.session_id, 20)}</span>
                        <Show when={session.is_subagent}>
                          <span class="pill gray">subagent</span>
                        </Show>
                        <Show when={!session.title}>
                          <span class="mono" style={{ "font-size": "10px", color: "var(--text-muted)" }}>
                            {truncate(session.session_id, 16)}
                          </span>
                        </Show>
                      </div>
                      <div class="card-meta">
                        <span>{session.compartment_count} compartments</span>
                        <span>·</span>
                        <span>{session.fact_count} facts</span>
                        <span>·</span>
                        <span>{session.note_count} notes</span>
                        <Show when={session.last_response_time}>
                          <span>·</span>
                          <span>Last active: {formatRelativeTime(session.last_response_time!)}</span>
                        </Show>
                      </div>
                    </div>
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
          <button class={`tab-pill ${activeTab() === "compartments" ? "active" : ""}`} onClick={() => setActiveTab("compartments")}>
            Compartments ({compartments()?.length ?? 0})
          </button>
          <button class={`tab-pill ${activeTab() === "facts" ? "active" : ""}`} onClick={() => setActiveTab("facts")}>
            Facts ({facts()?.length ?? 0})
          </button>
          <button class={`tab-pill ${activeTab() === "notes" ? "active" : ""}`} onClick={() => setActiveTab("notes")}>
            Notes ({notes()?.length ?? 0})
          </button>
          <button class={`tab-pill ${activeTab() === "meta" ? "active" : ""}`} onClick={() => setActiveTab("meta")}>
            Meta
          </button>
          <button class={`tab-pill ${activeTab() === "tokens" ? "active" : ""}`} onClick={() => setActiveTab("tokens")}>
            Tokens
          </button>
        </div>

        {/* Timeline bar - fixed outside scroll, aligned with scroll content */}
        <Show when={activeTab() === "compartments" && (compartments() ?? []).length > 0}>
          <div style={{ padding: "0 28px 12px 20px" }}>
            <div class="timeline-bar">
              <For each={compartments() ?? []}>
                {(comp) => {
                  const range = comp.end_message - comp.start_message;
                  const width = () => Math.max(0.5, (range / totalRange()) * 100);
                  return (
                    <div
                      class="timeline-segment"
                      style={{
                        width: `${width()}%`,
                        background: expandedCompartment() === comp.id
                          ? `hsl(${(comp.sequence * 37) % 360}, 70%, 55%)`
                          : `hsl(${(comp.sequence * 37) % 360}, 50%, 40%)`,
                        outline: expandedCompartment() === comp.id ? "2px solid var(--accent)" : "none",
                      }}
                      title={`#${comp.sequence}: ${comp.title}`}
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
          <Show when={activeTab() === "compartments"}>
            <Show when={!compartments.loading} fallback={<div class="empty-state">Loading...</div>}>
              <Show
                when={(compartments() ?? []).length > 0}
                fallback={<div class="empty-state"><span class="empty-state-icon">📜</span>No compartments</div>}
              >
                <div class="list-gap">
                  <For each={compartments() ?? []}>
                    {(comp) => (
                      <div id={`compartment-${comp.id}`} class="card" onClick={() => toggleCompartment(comp.id)} style={{ cursor: "pointer" }}>
                        <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                          <div class="card-title">
                            <span class="mono" style={{ color: "var(--text-muted)", "margin-right": "6px" }}>
                              #{comp.sequence}
                            </span>
                            Messages {comp.start_message}–{comp.end_message}
                          </div>
                          <span style={{ "font-size": "11px", color: "var(--text-muted)" }}>
                            {expandedCompartment() === comp.id ? "▲" : "▼"}
                          </span>
                        </div>
                        <div class="card-meta">
                          {truncate(comp.title, 120)}
                        </div>
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
                                  <div style={{
                                    "font-weight": isUser() ? "600" : "normal",
                                    color: isUser() ? "var(--text-primary)" : "var(--text-secondary)",
                                    "margin-bottom": "2px",
                                    "white-space": "pre-wrap",
                                  }}>
                                    {line()}
                                  </div>
                                );
                              }}
                            </Index>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>

          {/* Facts tab */}
          <Show when={activeTab() === "facts"}>
            <Show
              when={(facts() ?? []).length > 0}
              fallback={<div class="empty-state"><span class="empty-state-icon">📝</span>No facts</div>}
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
                            <div style={{ "font-size": "12px", "white-space": "pre-wrap", "line-height": "1.6" }}>
                              {fact.content}
                            </div>
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
            <Show
              when={(notes() ?? []).length > 0}
              fallback={<div class="empty-state"><span class="empty-state-icon">📌</span>No notes</div>}
            >
              <div class="list-gap">
                <For each={notes() ?? []}>
                  {(note) => (
                    <div class="card">
                      <div style={{ "font-size": "12px", "white-space": "pre-wrap", "line-height": "1.6" }}>
                        {note.content}
                      </div>
                      <div class="card-meta" style={{ "margin-top": "6px" }}>
                        {formatRelativeTime(note.created_at)}
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>

          {/* Meta tab */}
          <Show when={activeTab() === "meta"}>
            <Show when={meta()} fallback={<div class="empty-state">No meta data</div>}>
              {(metaData) => (
                <table class="kv-table">
                  <tbody>
                    <tr><td>Session ID</td><td>{metaData().session_id}</td></tr>
                    <tr><td>Counter</td><td>{metaData().counter}</td></tr>
                    <tr><td>Context %</td><td>{metaData().last_context_percentage.toFixed(1)}%</td></tr>
                    <tr><td>Input tokens</td><td>{metaData().last_input_tokens.toLocaleString()}</td></tr>
                    <tr><td>Cache TTL</td><td>{metaData().cache_ttl ?? "—"}</td></tr>
                    <tr><td>Nudge tokens</td><td>{metaData().last_nudge_tokens.toLocaleString()}</td></tr>
                    <tr><td>Nudge band</td><td>{metaData().last_nudge_band || "—"}</td></tr>
                    <tr><td>Execute hits</td><td>{metaData().times_execute_threshold_reached}</td></tr>
                    <tr><td>Subagent</td><td>{metaData().is_subagent ? "Yes" : "No"}</td></tr>
                    <tr><td>Compartment WIP</td><td>{metaData().compartment_in_progress ? "Yes" : "No"}</td></tr>
                    <tr><td>Memory blocks</td><td>{metaData().memory_block_count}</td></tr>
                    <tr><td>System hash</td><td>{truncate(metaData().system_prompt_hash, 16) || "—"}</td></tr>
                  </tbody>
                </table>
              )}
            </Show>
          </Show>

          {/* Tokens tab */}
          <Show when={activeTab() === "tokens"}>
            <Show when={tokenBreakdown()} fallback={<div class="empty-state">No token data available</div>}>
              {(data) => {
                const total = () => data().total_input_tokens;
                const hasData = () => total() > 0;
                
                // Calculate percentages
                const systemPct = () => hasData() ? (data().system_prompt_tokens / total()) * 100 : 0;
                const compartmentPct = () => hasData() ? (data().compartment_tokens / total()) * 100 : 0;
                const factPct = () => hasData() ? (data().fact_tokens / total()) * 100 : 0;
                const memoryPct = () => hasData() ? (data().memory_tokens / total()) * 100 : 0;
                const conversationPct = () => hasData() ? (data().conversation_tokens / total()) * 100 : 0;

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
                      
                      <Show when={hasData()} fallback={<div class="empty-state">No input token data recorded</div>}>
                        {/* Stacked bar visualization */}
                        <div style={{
                          display: "flex",
                          height: "32px",
                          "border-radius": "8px",
                          overflow: "hidden",
                          "margin-bottom": "20px",
                        }}>
                          <Show when={data().system_prompt_tokens > 0}>
                            <div style={{
                              width: `${systemPct()}%`,
                              background: colors.system,
                              display: "flex",
                              "align-items": "center",
                              "justify-content": "center",
                              "font-size": "11px",
                              "font-weight": "600",
                              color: "#fff",
                              "min-width": systemPct() > 8 ? "auto" : "0",
                            }}>
                              {systemPct() > 8 ? `${systemPct().toFixed(0)}%` : ""}
                            </div>
                          </Show>
                          <Show when={data().compartment_tokens > 0}>
                            <div style={{
                              width: `${compartmentPct()}%`,
                              background: colors.compartments,
                              display: "flex",
                              "align-items": "center",
                              "justify-content": "center",
                              "font-size": "11px",
                              "font-weight": "600",
                              color: "#fff",
                              "min-width": compartmentPct() > 8 ? "auto" : "0",
                            }}>
                              {compartmentPct() > 8 ? `${compartmentPct().toFixed(0)}%` : ""}
                            </div>
                          </Show>
                          <Show when={data().fact_tokens > 0}>
                            <div style={{
                              width: `${factPct()}%`,
                              background: colors.facts,
                              display: "flex",
                              "align-items": "center",
                              "justify-content": "center",
                              "font-size": "11px",
                              "font-weight": "600",
                              color: "#1a1a1a",
                              "min-width": factPct() > 8 ? "auto" : "0",
                            }}>
                              {factPct() > 8 ? `${factPct().toFixed(0)}%` : ""}
                            </div>
                          </Show>
                          <Show when={data().memory_tokens > 0}>
                            <div style={{
                              width: `${memoryPct()}%`,
                              background: colors.memories,
                              display: "flex",
                              "align-items": "center",
                              "justify-content": "center",
                              "font-size": "11px",
                              "font-weight": "600",
                              color: "#fff",
                              "min-width": memoryPct() > 8 ? "auto" : "0",
                            }}>
                              {memoryPct() > 8 ? `${memoryPct().toFixed(0)}%` : ""}
                            </div>
                          </Show>
                          <Show when={data().conversation_tokens > 0}>
                            <div style={{
                              width: `${conversationPct()}%`,
                              background: colors.conversation,
                              display: "flex",
                              "align-items": "center",
                              "justify-content": "center",
                              "font-size": "11px",
                              "font-weight": "600",
                              color: "#1a1a1a",
                              "min-width": conversationPct() > 8 ? "auto" : "0",
                            }}>
                              {conversationPct() > 8 ? `${conversationPct().toFixed(0)}%` : ""}
                            </div>
                          </Show>
                        </div>

                        {/* Legend with details */}
                        <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
                          {/* System Prompt */}
                          <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                            <div style={{
                              width: "12px",
                              height: "12px",
                              "border-radius": "3px",
                              background: colors.system,
                              "flex-shrink": "0",
                            }} />
                            <div style={{ flex: 1, display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                              <span style={{ "font-size": "13px" }}>
                                System Prompt
                              </span>
                              <span style={{ "font-size": "13px", "font-weight": "500", "font-family": "var(--font-mono)" }}>
                                {data().system_prompt_tokens.toLocaleString()} <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>({systemPct().toFixed(1)}%)</span>
                              </span>
                            </div>
                          </div>

                          {/* Compartments */}
                          <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                            <div style={{
                              width: "12px",
                              height: "12px",
                              "border-radius": "3px",
                              background: colors.compartments,
                              "flex-shrink": "0",
                            }} />
                            <div style={{ flex: 1, display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                              <span style={{ "font-size": "13px" }}>
                                Compartments <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>({data().compartment_count})</span>
                              </span>
                              <span style={{ "font-size": "13px", "font-weight": "500", "font-family": "var(--font-mono)" }}>
                                {data().compartment_tokens.toLocaleString()} <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>({compartmentPct().toFixed(1)}%)</span>
                              </span>
                            </div>
                          </div>

                          {/* Facts */}
                          <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                            <div style={{
                              width: "12px",
                              height: "12px",
                              "border-radius": "3px",
                              background: colors.facts,
                              "flex-shrink": "0",
                            }} />
                            <div style={{ flex: 1, display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                              <span style={{ "font-size": "13px" }}>
                                Facts <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>({data().fact_count})</span>
                              </span>
                              <span style={{ "font-size": "13px", "font-weight": "500", "font-family": "var(--font-mono)" }}>
                                {data().fact_tokens.toLocaleString()} <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>({factPct().toFixed(1)}%)</span>
                              </span>
                            </div>
                          </div>

                          {/* Memories */}
                          <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                            <div style={{
                              width: "12px",
                              height: "12px",
                              "border-radius": "3px",
                              background: colors.memories,
                              "flex-shrink": "0",
                            }} />
                            <div style={{ flex: 1, display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                              <span style={{ "font-size": "13px" }}>
                                Memories <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>({data().memory_count})</span>
                              </span>
                              <span style={{ "font-size": "13px", "font-weight": "500", "font-family": "var(--font-mono)" }}>
                                {data().memory_tokens.toLocaleString()} <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>({memoryPct().toFixed(1)}%)</span>
                              </span>
                            </div>
                          </div>

                          {/* Conversation */}
                          <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                            <div style={{
                              width: "12px",
                              height: "12px",
                              "border-radius": "3px",
                              background: colors.conversation,
                              "flex-shrink": "0",
                            }} />
                            <div style={{ flex: 1, display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                              <span style={{ "font-size": "13px" }}>
                                Conversation
                              </span>
                              <span style={{ "font-size": "13px", "font-weight": "500", "font-family": "var(--font-mono)" }}>
                                {data().conversation_tokens.toLocaleString()} <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>({conversationPct().toFixed(1)}%)</span>
                              </span>
                            </div>
                          </div>

                          {/* Divider */}
                          <div style={{ borderTop: "1px solid var(--border-color)", margin: "8px 0" }} />

                          {/* Total */}
                          <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                            <span style={{ "font-size": "13px", "font-weight": "600" }}>Total Input Tokens</span>
                            <span style={{ "font-size": "14px", "font-weight": "600", "font-family": "var(--font-mono)" }}>
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
        </div>
      </Show>
    </>
  );
}
