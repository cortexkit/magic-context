import { createResource, createSignal, For, Show } from "solid-js";
import {
  deleteUserMemory,
  deleteUserMemoryCandidate,
  dismissUserMemory,
  formatRelativeTime,
  getUserMemories,
  getUserMemoryCandidates,
  promoteUserMemoryCandidate,
  truncate,
} from "../../lib/api";
import FilterSelect from "../shared/FilterSelect";

export default function UserMemories() {
  const [statusFilter, setStatusFilter] = createSignal<string>("");
  const [error, setError] = createSignal<string | null>(null);

  const fetchMemories = () => ({ status: statusFilter() || undefined });
  const [memories, { refetch: refetchMemories }] = createResource(fetchMemories, (params) =>
    getUserMemories(params.status),
  );

  const [candidates, { refetch: refetchCandidates }] = createResource(getUserMemoryCandidates);

  const activeMemories = () => (memories() ?? []).filter((m) => m.status === "active");
  const dismissedMemories = () => (memories() ?? []).filter((m) => m.status === "dismissed");

  const handleDismiss = async (id: number) => {
    try {
      setError(null);
      await dismissUserMemory(id);
      refetchMemories();
    } catch (e: unknown) {
      setError(`Failed to dismiss memory: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleDeleteMemory = async (id: number) => {
    try {
      setError(null);
      await deleteUserMemory(id);
      refetchMemories();
    } catch (e: unknown) {
      setError(`Failed to delete memory: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleDeleteCandidate = async (id: number) => {
    try {
      setError(null);
      await deleteUserMemoryCandidate(id);
      refetchCandidates();
    } catch (e: unknown) {
      setError(`Failed to delete candidate: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handlePromoteCandidate = async (id: number) => {
    try {
      setError(null);
      await promoteUserMemoryCandidate(id);
      refetchCandidates();
      refetchMemories();
    } catch (e: unknown) {
      setError(`Failed to promote candidate: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const statusPillClass = (status: string) => {
    switch (status) {
      case "active":
        return "green";
      case "dismissed":
        return "gray";
      default:
        return "gray";
    }
  };

  const truncateSessionId = (sessionId: string) => {
    if (sessionId.length <= 12) return sessionId;
    return `${sessionId.slice(0, 8)}…`;
  };

  return (
    <>
      {/* Error toast */}
      <Show when={error()}>
        <div style={{ padding: "8px 20px" }}>
          <div
            style={{
              background: "var(--error-bg, #3a1c1c)",
              border: "1px solid var(--error-border, #6b2c2c)",
              "border-radius": "var(--radius-md)",
              padding: "8px 12px",
              "font-size": "12px",
              color: "var(--error-text, #ef4444)",
              display: "flex",
              "justify-content": "space-between",
              "align-items": "center",
            }}
          >
            <span>{error()}</span>
            <button
              type="button"
              class="btn sm"
              onClick={() => setError(null)}
              style={{ "min-width": "auto", padding: "2px 8px" }}
            >
              ✕
            </button>
          </div>
        </div>
      </Show>

      <div class="section-header">
        <h1 class="section-title">User Memories</h1>
        <div class="section-actions">
          <Show when={memories()}>
            <span style={{ "font-size": "12px", color: "var(--text-secondary)" }}>
              {activeMemories().length} active · {dismissedMemories().length} dismissed
            </span>
          </Show>
        </div>
      </div>

      <div class="filter-bar">
        <FilterSelect
          value={statusFilter()}
          onChange={setStatusFilter}
          placeholder="All status"
          align="left"
          options={[
            { value: "", label: "All status" },
            { value: "active", label: "Active" },
            { value: "dismissed", label: "Dismissed" },
          ]}
        />
      </div>

      <div class="scroll-area">
        {/* Stable User Memories Section */}
        <div class="list-gap" style={{ "margin-bottom": "24px" }}>
          <div class="category-header">
            Stable User Memories
            <span class="category-count">
              ({activeMemories().length + dismissedMemories().length})
            </span>
          </div>

          <Show
            when={!memories.loading}
            fallback={<div class="empty-state">Loading memories...</div>}
          >
            <Show
              when={(memories() ?? []).length > 0}
              fallback={
                <div class="empty-state">
                  <span class="empty-state-icon">👤</span>
                  <span>No user memories found</span>
                </div>
              }
            >
              <For each={memories()}>
                {(memory) => (
                  <div class="card">
                    <div class="card-title">
                      <span
                        class="mono"
                        style={{
                          color: "var(--text-muted)",
                          "margin-right": "6px",
                        }}
                      >
                        #{memory.id}
                      </span>
                      {truncate(memory.content, 120)}
                    </div>
                    <div class="card-meta">
                      <span class={`pill ${statusPillClass(memory.status)}`}>{memory.status}</span>
                      <Show when={memory.promoted_at}>
                        {(t) => <span>promoted {formatRelativeTime(t())}</span>}
                      </Show>
                      <Show
                        when={memory.source_candidate_ids && memory.source_candidate_ids.length > 0}
                      >
                        <span style={{ color: "var(--text-muted)" }}>
                          from candidates: {memory.source_candidate_ids?.join(", ")}
                        </span>
                      </Show>
                      <span>{formatRelativeTime(memory.created_at)}</span>
                    </div>
                    <div
                      class="card-actions"
                      style={{
                        display: "flex",
                        gap: "8px",
                        "margin-top": "8px",
                      }}
                    >
                      <Show when={memory.status === "active"}>
                        <button
                          type="button"
                          class="btn sm"
                          onClick={() => handleDismiss(memory.id)}
                        >
                          Dismiss
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="btn sm danger"
                        onClick={() => handleDeleteMemory(memory.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>

        {/* Candidates Section */}
        <div class="list-gap">
          <div class="category-header">
            Candidates
            <span class="category-count">({(candidates() ?? []).length})</span>
          </div>

          <Show
            when={!candidates.loading}
            fallback={<div class="empty-state">Loading candidates...</div>}
          >
            <Show
              when={(candidates() ?? []).length > 0}
              fallback={
                <div class="empty-state">
                  <span class="empty-state-icon">📝</span>
                  <span>No pending candidates</span>
                </div>
              }
            >
              <For each={candidates()}>
                {(candidate) => (
                  <div class="card">
                    <div class="card-title">
                      <span
                        class="mono"
                        style={{
                          color: "var(--text-muted)",
                          "margin-right": "6px",
                        }}
                      >
                        #{candidate.id}
                      </span>
                      {truncate(candidate.content, 120)}
                    </div>
                    <div class="card-meta">
                      <span class="pill blue">candidate</span>
                      <span title={candidate.session_id}>
                        session: {truncateSessionId(candidate.session_id)}
                      </span>
                      <Show
                        when={
                          candidate.source_compartment_start && candidate.source_compartment_end
                        }
                      >
                        <span style={{ color: "var(--text-muted)" }}>
                          compartments: {candidate.source_compartment_start}–
                          {candidate.source_compartment_end}
                        </span>
                      </Show>
                      <span>{formatRelativeTime(candidate.created_at)}</span>
                    </div>
                    <div
                      class="card-actions"
                      style={{
                        display: "flex",
                        gap: "8px",
                        "margin-top": "8px",
                      }}
                    >
                      <button
                        type="button"
                        class="btn sm"
                        onClick={() => handlePromoteCandidate(candidate.id)}
                      >
                        Promote
                      </button>
                      <button
                        type="button"
                        class="btn sm danger"
                        onClick={() => handleDeleteCandidate(candidate.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </>
  );
}
