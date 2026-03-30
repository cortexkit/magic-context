import { createSignal, createResource, For, Show, createEffect } from "solid-js";
import type { Memory, MemoryStats } from "../../lib/types";
import {
  getProjects,
  getMemories,
  getMemoryStats,
  updateMemoryStatus,
  updateMemoryContent,
  deleteMemory,
  formatRelativeTime,
  truncate,
} from "../../lib/api";
import MemoryDetail from "./MemoryDetail";
import FilterSelect from "../shared/FilterSelect";

export default function MemoryBrowser() {
  const [projectFilter, setProjectFilter] = createSignal<string>("");
  const [statusFilter, setStatusFilter] = createSignal<string>("");
  const [categoryFilter, setCategoryFilter] = createSignal<string>("");
  const [searchQuery, setSearchQuery] = createSignal<string>("");
  const [selectedMemory, setSelectedMemory] = createSignal<Memory | null>(null);

  const [projects] = createResource(getProjects);

  const fetchParams = () => ({
    project: projectFilter() || undefined,
    status: statusFilter() || undefined,
    category: categoryFilter() || undefined,
    search: searchQuery() || undefined,
    limit: 200,
    offset: 0,
  });

  const [memories, { refetch: refetchMemories }] = createResource(fetchParams, getMemories);
  const [stats, { refetch: refetchStats }] = createResource(
    () => projectFilter() || undefined,
    (proj) => getMemoryStats(proj),
  );

  // Group memories by category
  const groupedMemories = () => {
    const m = memories() ?? [];
    const groups: Record<string, Memory[]> = {};
    for (const mem of m) {
      if (!groups[mem.category]) groups[mem.category] = [];
      groups[mem.category].push(mem);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  };

  const handleStatusChange = async (memoryId: number, newStatus: string) => {
    await updateMemoryStatus(memoryId, newStatus);
    refetchMemories();
    refetchStats();
    setSelectedMemory(null);
  };

  const handleContentChange = async (memoryId: number, content: string) => {
    await updateMemoryContent(memoryId, content);
    refetchMemories();
  };

  const handleDelete = async (memoryId: number) => {
    await deleteMemory(memoryId);
    refetchMemories();
    refetchStats();
    setSelectedMemory(null);
  };

  const statusPillClass = (status: string) => {
    switch (status) {
      case "active": return "green";
      case "permanent": return "blue";
      case "archived": return "gray";
      default: return "gray";
    }
  };

  const sourcePillClass = (source: string) => {
    switch (source) {
      case "historian": return "purple";
      case "agent": return "blue";
      case "dreamer": return "indigo";
      case "user": return "green";
      default: return "gray";
    }
  };

  let searchTimeout: number;
  const handleSearch = (value: string) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => setSearchQuery(value), 300) as unknown as number;
  };

  return (
    <>
      <div class="section-header">
        <h1 class="section-title">Memories</h1>
        <div class="section-actions">
          <Show when={stats()}>
            <span style={{ "font-size": "12px", color: "var(--text-secondary)" }}>
              {stats()!.active + stats()!.permanent} active · {stats()!.archived} archived · {stats()!.with_embeddings} embedded
            </span>
          </Show>
        </div>
      </div>

      <div class="filter-bar">
        <FilterSelect
          value={projectFilter()}
          onChange={setProjectFilter}
          placeholder="All projects"
          options={[
            { value: "", label: "All projects" },
            ...(projects() ?? []).map((p) => ({ value: p.identity, label: p.label })),
          ]}
        />
        <input
          class="search-input"
          type="text"
          placeholder="Search memories..."
          onInput={(e) => handleSearch(e.currentTarget.value)}
        />
        <FilterSelect
          value={statusFilter()}
          onChange={setStatusFilter}
          placeholder="All status"
          options={[
            { value: "", label: "All status" },
            { value: "active", label: "Active" },
            { value: "permanent", label: "Permanent" },
            { value: "archived", label: "Archived" },
          ]}
        />
        <FilterSelect
          value={categoryFilter()}
          onChange={setCategoryFilter}
          placeholder="All categories"
          options={[
            { value: "", label: "All categories" },
            ...(stats()?.categories ?? []).map((c) => ({ value: c.category, label: `${c.category} (${c.count})` })),
          ]}
        />
      </div>

      <div class="scroll-area">
        <Show
          when={!memories.loading}
          fallback={<div class="empty-state">Loading memories...</div>}
        >
          <Show
            when={(memories() ?? []).length > 0}
            fallback={
              <div class="empty-state">
                <span class="empty-state-icon">🧠</span>
                <span>No memories found</span>
              </div>
            }
          >
            <div class="list-gap">
              <For each={groupedMemories()}>
                {([category, mems]) => (
                  <>
                    <div class="category-header">
                      {category}
                      <span class="category-count">({mems.length})</span>
                    </div>
                    <For each={mems}>
                      {(mem) => (
                        <div
                          class="card"
                          style={{ cursor: "pointer" }}
                          onClick={() => setSelectedMemory(mem)}
                        >
                          <div class="card-title">
                            <span class="mono" style={{ color: "var(--text-muted)", "margin-right": "6px" }}>
                              #{mem.id}
                            </span>
                            {truncate(mem.content, 100)}
                          </div>
                          <div class="card-meta">
                            <span class={`pill ${statusPillClass(mem.status)}`}>{mem.status}</span>
                            <span class={`pill ${sourcePillClass(mem.source_type)}`}>{mem.source_type}</span>
                            <span>seen {mem.seen_count}×</span>
                            <span>retrieved {mem.retrieval_count}×</span>
                            <span>{formatRelativeTime(mem.updated_at)}</span>
                            <span style={{ color: mem.has_embedding ? "var(--accent)" : "var(--text-muted)" }}>
                              {mem.has_embedding ? "● embedded" : "○ no embedding"}
                            </span>
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
      </div>

      <Show when={selectedMemory()}>
        <MemoryDetail
          memory={selectedMemory()!}
          onClose={() => setSelectedMemory(null)}
          onStatusChange={handleStatusChange}
          onContentChange={handleContentChange}
          onDelete={handleDelete}
        />
      </Show>
    </>
  );
}
