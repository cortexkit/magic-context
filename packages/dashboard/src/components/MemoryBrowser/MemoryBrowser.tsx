import { ask } from "@tauri-apps/plugin-dialog";
import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import {
  bulkDeleteMemory,
  bulkUpdateMemoryStatus,
  deleteMemory,
  enumerateMemoryProjects,
  formatRelativeTime,
  getMemories,
  getMemoryStats,
  truncate,
  updateMemoryContent,
  updateMemoryStatus,
} from "../../lib/api";
import type { Memory } from "../../lib/types";
import HarnessBadge from "../HarnessBadge";
import FilterSelect from "../shared/FilterSelect";
import MemoryDetail from "./MemoryDetail";

// LocalStorage key for persisted collapsed-category state. Versioned so future
// schema changes to stored value don't poison old clients.
const COLLAPSED_STORAGE_KEY = "mc.memory.collapsedCategories.v1";

function loadCollapsedCategories(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function saveCollapsedCategories(set: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // localStorage full / disabled — ignore, in-memory state still works.
  }
}

export default function MemoryBrowser() {
  const [projectFilter, setProjectFilter] = createSignal<string>("");
  const [statusFilter, setStatusFilter] = createSignal<string>("");
  const [categoryFilter, setCategoryFilter] = createSignal<string>("");
  const [searchQuery, setSearchQuery] = createSignal<string>("");
  const [selectedMemory, setSelectedMemory] = createSignal<Memory | null>(null);

  // Multi-select state.
  const [selectedIds, setSelectedIds] = createSignal<Set<number>>(new Set());

  // Collapsed category state. Persisted to localStorage so reloads preserve
  // navigation focus.
  const [collapsedCategories, setCollapsedCategories] = createSignal<Set<string>>(
    loadCollapsedCategories(),
  );
  createEffect(() => saveCollapsedCategories(collapsedCategories()));

  const [projects] = createResource(enumerateMemoryProjects);

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
    () => ({ project: projectFilter() || undefined }),
    (params) => getMemoryStats(params.project),
  );

  // Group memories by category (stable alphabetical order).
  const groupedMemories = () => {
    const m = memories() ?? [];
    const groups: Record<string, Memory[]> = {};
    for (const mem of m) {
      if (!groups[mem.category]) groups[mem.category] = [];
      groups[mem.category].push(mem);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  };

  // Reset selection whenever the filtered list changes — leaving stale IDs in
  // the selection set would produce a confusing "12 selected" count when only
  // 3 are visible, and bulk actions would still target the hidden ones.
  createEffect(() => {
    // Track filter signals so this runs when they change.
    projectFilter();
    statusFilter();
    categoryFilter();
    searchQuery();
    setSelectedIds(new Set<number>());
  });

  const [error, setError] = createSignal<string | null>(null);

  const handleStatusChange = async (memoryId: number, newStatus: string) => {
    try {
      setError(null);
      await updateMemoryStatus(memoryId, newStatus);
      refetchMemories();
      refetchStats();
      setSelectedMemory(null);
    } catch (e: unknown) {
      setError(`Failed to update status: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleContentChange = async (memoryId: number, content: string) => {
    try {
      setError(null);
      await updateMemoryContent(memoryId, content);
      refetchMemories();
    } catch (e: unknown) {
      setError(`Failed to update content: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleDelete = async (memoryId: number) => {
    try {
      setError(null);
      await deleteMemory(memoryId);
      refetchMemories();
      refetchStats();
      setSelectedMemory(null);
    } catch (e: unknown) {
      setError(`Failed to delete memory: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── Selection helpers ───────────────────────────────────────

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const categorySelectionState = (mems: Memory[]): "none" | "some" | "all" => {
    const sel = selectedIds();
    let count = 0;
    for (const m of mems) if (sel.has(m.id)) count++;
    if (count === 0) return "none";
    if (count === mems.length) return "all";
    return "some";
  };

  const toggleCategorySelection = (mems: Memory[]) => {
    const state = categorySelectionState(mems);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (state === "all") {
        // Deselect category
        for (const m of mems) next.delete(m.id);
      } else {
        // Select all in category (handles both "none" and "some")
        for (const m of mems) next.add(m.id);
      }
      return next;
    });
  };

  const allVisibleMemoryIds = (): number[] => (memories() ?? []).map((m) => m.id);

  const allVisibleSelectionState = (): "none" | "some" | "all" => {
    const visible = allVisibleMemoryIds();
    if (visible.length === 0) return "none";
    const sel = selectedIds();
    let count = 0;
    for (const id of visible) if (sel.has(id)) count++;
    if (count === 0) return "none";
    if (count === visible.length) return "all";
    return "some";
  };

  const toggleAllVisibleSelection = () => {
    const state = allVisibleSelectionState();
    const visible = allVisibleMemoryIds();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (state === "all") {
        for (const id of visible) next.delete(id);
      } else {
        for (const id of visible) next.add(id);
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set<number>());

  // ── Collapse helpers ─────────────────────────────────────────

  const toggleCategoryCollapse = (category: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  const collapseAll = () => {
    const categories = groupedMemories().map(([c]) => c);
    setCollapsedCategories(new Set(categories));
  };

  const expandAll = () => {
    setCollapsedCategories(new Set<string>());
  };

  // ── Bulk actions ─────────────────────────────────────────────

  const handleBulkArchive = async () => {
    const ids = [...selectedIds()];
    if (ids.length === 0) return;
    const confirmed = await ask(
      `Archive ${ids.length} memor${ids.length === 1 ? "y" : "ies"}? Archived memories are hidden from injection but can be restored later.`,
      { title: "Confirm Archive", kind: "warning" },
    );
    if (!confirmed) return;
    try {
      setError(null);
      await bulkUpdateMemoryStatus(ids, "archived");
      clearSelection();
      refetchMemories();
      refetchStats();
    } catch (e: unknown) {
      setError(`Failed to archive memories: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleBulkDelete = async () => {
    const ids = [...selectedIds()];
    if (ids.length === 0) return;
    const confirmed = await ask(
      `Permanently delete ${ids.length} memor${ids.length === 1 ? "y" : "ies"}? This cannot be undone.`,
      { title: "Confirm Delete", kind: "warning" },
    );
    if (!confirmed) return;
    try {
      setError(null);
      await bulkDeleteMemory(ids);
      clearSelection();
      refetchMemories();
      refetchStats();
    } catch (e: unknown) {
      setError(`Failed to delete memories: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── Render helpers ───────────────────────────────────────────

  const statusPillClass = (status: string) => {
    switch (status) {
      case "active":
        return "green";
      case "permanent":
        return "blue";
      case "archived":
        return "gray";
      default:
        return "gray";
    }
  };

  const sourcePillClass = (source: string) => {
    switch (source) {
      case "historian":
        return "purple";
      case "agent":
        return "blue";
      case "dreamer":
        return "indigo";
      case "user":
        return "green";
      default:
        return "gray";
    }
  };

  let searchTimeout: number;
  const handleSearch = (value: string) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => setSearchQuery(value), 300) as unknown as number;
  };

  const selectedCount = () => selectedIds().size;

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
        <h1 class="section-title">Memories</h1>
        <div class="section-actions">
          <Show when={stats()}>
            {(s) => (
              <span style={{ "font-size": "12px", color: "var(--text-secondary)" }}>
                {s().active + s().permanent} active · {s().archived} archived ·{" "}
                {s().with_embeddings} embedded
              </span>
            )}
          </Show>
        </div>
      </div>

      <div class="filter-bar">
        <FilterSelect
          value={projectFilter()}
          onChange={setProjectFilter}
          placeholder="All projects"
          align="left"
          options={[
            { value: "", label: "All projects" },
            ...(projects() ?? []).map((p) => ({
              value: p.identity,
              label: (
                <span style={{ display: "inline-flex", "align-items": "center", gap: "6px" }}>
                  <span>{p.display_name}</span>
                  <span style={{ display: "inline-flex", gap: "3px" }}>
                    <For each={p.harnesses}>{(harness) => <HarnessBadge harness={harness} />}</For>
                  </span>
                </span>
              ),
            })),
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
            ...(stats()?.categories ?? []).map((c) => ({
              value: c.category,
              label: `${c.category} (${c.count})`,
            })),
          ]}
        />
      </div>

      {/* Sticky bulk-action bar: appears only when ≥1 memory is selected.
          Keeps vertical space free in the common case of no selection. */}
      <Show when={selectedCount() > 0}>
        <div class="bulk-action-bar">
          <div class="bulk-action-left">
            <TriStateCheckbox
              state={allVisibleSelectionState()}
              onToggle={toggleAllVisibleSelection}
              ariaLabel="Toggle all visible memories"
            />
            <span class="bulk-action-count">
              {selectedCount()} selected
              <Show when={selectedCount() < allVisibleMemoryIds().length}>
                <button type="button" class="bulk-action-link" onClick={toggleAllVisibleSelection}>
                  Select all {allVisibleMemoryIds().length} visible
                </button>
              </Show>
            </span>
          </div>
          <div class="bulk-action-right">
            <button type="button" class="btn sm" onClick={handleBulkArchive}>
              Archive
            </button>
            <button type="button" class="btn sm danger" onClick={handleBulkDelete}>
              Delete
            </button>
            <button type="button" class="btn sm ghost" onClick={clearSelection}>
              Clear
            </button>
          </div>
        </div>
      </Show>

      {/* Expand/collapse controls — small link-style buttons above the list. */}
      <Show when={!memories.loading && (memories() ?? []).length > 0}>
        <div class="memory-controls">
          <button type="button" class="bulk-action-link" onClick={expandAll}>
            Expand all
          </button>
          <span style={{ color: "var(--text-muted)" }}>·</span>
          <button type="button" class="bulk-action-link" onClick={collapseAll}>
            Collapse all
          </button>
        </div>
      </Show>

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
                {([category, mems]) => {
                  const collapsed = () => collapsedCategories().has(category);
                  return (
                    <>
                      <button
                        type="button"
                        class="category-header clickable"
                        onClick={() => toggleCategoryCollapse(category)}
                      >
                        {/* Tri-state checkbox: clicking stops propagation so it
                            doesn't also collapse the category. */}
                        <span style={{ display: "flex", "align-items": "center" }}>
                          <TriStateCheckbox
                            state={categorySelectionState(mems)}
                            onToggle={() => toggleCategorySelection(mems)}
                            ariaLabel={`Toggle all in ${category}`}
                          />
                        </span>
                        <span>{category}</span>
                        <span class="category-count">({mems.length})</span>
                        <span class="category-divider" />
                        <span
                          class="category-chevron"
                          classList={{ collapsed: collapsed() }}
                          aria-hidden="true"
                        >
                          ▾
                        </span>
                      </button>
                      <Show when={!collapsed()}>
                        <For each={mems}>
                          {(mem) => {
                            const isSelected = () => selectedIds().has(mem.id);
                            return (
                              <button
                                type="button"
                                class="card memory-card"
                                classList={{ selected: isSelected() }}
                                onClick={() => setSelectedMemory(mem)}
                                style={{ width: "100%", "text-align": "left" }}
                              >
                                <span class="memory-card-checkbox">
                                  <input
                                    type="checkbox"
                                    checked={isSelected()}
                                    onChange={() => toggleSelect(mem.id)}
                                    onClick={(e) => e.stopPropagation()}
                                    aria-label={`Select memory ${mem.id}`}
                                  />
                                </span>
                                <div class="memory-card-body">
                                  <div class="card-title">
                                    <span
                                      class="mono"
                                      style={{
                                        color: "var(--text-muted)",
                                        "margin-right": "6px",
                                      }}
                                    >
                                      #{mem.id}
                                    </span>
                                    {truncate(mem.content, 100)}
                                  </div>
                                  <div class="card-meta">
                                    <span class={`pill ${statusPillClass(mem.status)}`}>
                                      {mem.status}
                                    </span>
                                    <span class={`pill ${sourcePillClass(mem.source_type)}`}>
                                      {mem.source_type}
                                    </span>
                                    <span>seen {mem.seen_count}×</span>
                                    <span>retrieved {mem.retrieval_count}×</span>
                                    <span>{formatRelativeTime(mem.updated_at)}</span>
                                    <span
                                      style={{
                                        color: mem.has_embedding
                                          ? "var(--accent)"
                                          : "var(--text-muted)",
                                      }}
                                    >
                                      {mem.has_embedding ? "● embedded" : "○ no embedding"}
                                    </span>
                                  </div>
                                </div>
                              </button>
                            );
                          }}
                        </For>
                      </Show>
                    </>
                  );
                }}
              </For>
            </div>
          </Show>
        </Show>
      </div>

      <Show when={selectedMemory()}>
        {(mem) => (
          <MemoryDetail
            memory={mem()}
            onClose={() => setSelectedMemory(null)}
            onStatusChange={handleStatusChange}
            onContentChange={handleContentChange}
            onDelete={handleDelete}
          />
        )}
      </Show>
    </>
  );
}

// ── Tri-state checkbox ─────────────────────────────────────────

interface TriStateCheckboxProps {
  state: "none" | "some" | "all";
  onToggle: () => void;
  ariaLabel: string;
}

function TriStateCheckbox(props: TriStateCheckboxProps) {
  // We can't bind `indeterminate` declaratively in SolidJS (it's not a
  // reactive HTML attribute), so we use a ref + effect. This is the standard
  // workaround across all JS frameworks.
  let ref: HTMLInputElement | undefined;

  createEffect(() => {
    if (ref) {
      ref.indeterminate = props.state === "some";
    }
  });

  return (
    <input
      ref={ref}
      type="checkbox"
      class="tri-checkbox"
      checked={props.state === "all"}
      onChange={() => props.onToggle()}
      onClick={(e) => e.stopPropagation()}
      aria-label={props.ariaLabel}
    />
  );
}
