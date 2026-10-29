import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";

import {
  bulkDeleteMemory,
  bulkUpdateMemoryStatus,
  deleteMemory,
  enumerateMemoryProjects,
  formatDateTime,
  formatRelativeTime,
  getMemories,
  getMemoryStats,
  getMural,
  listWorkspaceSummaries,
  truncate,
  updateMemoryCategory,
  updateMemoryContent,
  updateMemoryStatus,
} from "../../lib/api";
import { ask } from "../../lib/platform";
import type { Memory, MemoryCategory } from "../../lib/types";
import HarnessBadge from "../HarnessBadge";
import FilterSelect from "../shared/FilterSelect";
import MemoryDetail from "./MemoryDetail";
import {
  categoryCountText,
  DEFAULT_STATUS_SELECTION,
  memoryListQuery,
  memoryStatsQuery,
  showingLabel,
  visibleCategoryCounts,
} from "./memory-pages";
import { muralDisplaySrc } from "./mural-image";

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

interface MemoryBrowserProps {
  /** When set, the browser is locked to this project: the project + workspace
   *  pickers are hidden and the breadcrumb is owned by the ProjectDetail shell. */
  project?: { identity: string; label: string };
}

export default function MemoryBrowser(props: MemoryBrowserProps = {}) {
  const embedded = () => props.project != null;
  const [projectFilter, setProjectFilter] = createSignal<string>("");
  const [workspaceFilter, setWorkspaceFilter] = createSignal<number | "">("");
  const [statusFilter, setStatusFilter] = createSignal<string>(DEFAULT_STATUS_SELECTION);
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
  const [workspaceSummaries] = createResource(listWorkspaceSummaries);
  const [mural] = createResource(
    () => props.project?.identity,
    (project) => (project ? getMural(project) : Promise.resolve(null)),
  );
  const [muralSrc, setMuralSrc] = createSignal<string | null>(null);
  const [muralCollapsed, setMuralCollapsed] = createSignal(false);
  // A data URL of a full-size mural is blocked by the desktop content policy
  // and can also exceed the webview's URL length. Paint a blob URL instead,
  // and drop it when the manifest changes.
  createEffect(() => {
    const entry = mural();
    const shown = entry ? muralDisplaySrc(entry.image) : null;
    setMuralSrc(shown?.src ?? null);
    onCleanup(() => shown?.revoke());
  });

  const listScope = () => {
    if (props.project) {
      return {
        project: props.project.identity,
        workspaceId: undefined as number | undefined,
        statusSelection: statusFilter(),
        search: searchQuery() || undefined,
      };
    }
    const workspace = workspaceFilter();
    return {
      project: workspace === "" ? projectFilter() || undefined : undefined,
      workspaceId: workspace === "" ? undefined : workspace,
      statusSelection: statusFilter(),
      search: searchQuery() || undefined,
    };
  };

  const [listEpoch, setListEpoch] = createSignal(0);
  const statsParams = () => memoryStatsQuery(listScope());
  const [stats, { refetch: refetchStats }] = createResource(statsParams, getMemoryStats);
  const reloadLists = () => {
    setListEpoch((epoch) => epoch + 1);
    refetchStats();
  };
  const categoryHeaders = () => visibleCategoryCounts(stats()?.categories ?? [], categoryFilter());

  type CategoryPage = { rows: Memory[]; complete: boolean };
  const [pages, setPages] = createSignal<Record<string, CategoryPage>>({});
  const [loadingCategories, setLoadingCategories] = createSignal<Set<string>>(new Set());
  const [failedCategories, setFailedCategories] = createSignal<Set<string>>(new Set());
  const requestTokens = new Map<string, number>();
  let requestSerial = 0;
  let activeListKey = "";
  const listKey = () =>
    JSON.stringify({
      ...listScope(),
      category: categoryFilter(),
      epoch: listEpoch(),
    });

  const [error, setError] = createSignal<string | null>(null);

  const loadCategory = async (category: string, key: string, offset: number) => {
    const token = ++requestSerial;
    requestTokens.set(category, token);
    setLoadingCategories((prev) => {
      const next = new Set(prev);
      next.add(category);
      return next;
    });
    setFailedCategories((prev) => {
      if (!prev.has(category)) return prev;
      const next = new Set(prev);
      next.delete(category);
      return next;
    });
    try {
      const query = memoryListQuery({ ...listScope(), category, offset });
      const rows = await getMemories(query);
      if (requestTokens.get(category) !== token || listKey() !== key) return;
      setPages((prev) => {
        const existing = offset === 0 ? [] : (prev[category]?.rows ?? []);
        if (offset !== 0 && existing.length !== offset) return prev;
        return {
          ...prev,
          [category]: {
            rows: [...existing, ...rows],
            complete: rows.length < query.limit,
          },
        };
      });
    } catch (e: unknown) {
      if (requestTokens.get(category) !== token || listKey() !== key) return;
      setFailedCategories((prev) => new Set(prev).add(category));
      setError(`Failed to load ${category}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (requestTokens.get(category) === token) {
        setLoadingCategories((prev) => {
          const next = new Set(prev);
          next.delete(category);
          return next;
        });
      }
    }
  };

  // Expanded categories load their own pages. A filter change drops every page
  // so a stale offset cannot be appended onto a new search.
  createEffect(() => {
    const key = listKey();
    if (key !== activeListKey) {
      activeListKey = key;
      requestTokens.clear();
      setPages({});
      setLoadingCategories(new Set<string>());
      setFailedCategories(new Set<string>());
    }
    const collapsed = collapsedCategories();
    for (const header of categoryHeaders()) {
      if (collapsed.has(header.category)) continue;
      if (
        pages()[header.category] ||
        loadingCategories().has(header.category) ||
        failedCategories().has(header.category)
      ) {
        continue;
      }
      void loadCategory(header.category, key, 0);
    }
  });

  // Reset selection whenever the filtered list changes — leaving stale IDs in
  // the selection set would produce a confusing "12 selected" count when only
  // 3 are visible, and bulk actions would still target the hidden ones.
  createEffect(() => {
    projectFilter();
    workspaceFilter();
    statusFilter();
    categoryFilter();
    searchQuery();
    setSelectedIds(new Set<number>());
  });

  const handleStatusChange = async (memoryId: number, newStatus: string) => {
    try {
      setError(null);
      await updateMemoryStatus(memoryId, newStatus);
      reloadLists();
      setSelectedMemory(null);
    } catch (e: unknown) {
      setError(`Failed to update status: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleContentChange = async (memoryId: number, content: string) => {
    try {
      setError(null);
      await updateMemoryContent(memoryId, content);
      reloadLists();
      setSelectedMemory((prev) => (prev && prev.id === memoryId ? { ...prev, content } : prev));
    } catch (e: unknown) {
      setError(`Failed to update content: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleCategoryChange = async (memoryId: number, category: string) => {
    try {
      setError(null);
      await updateMemoryCategory(memoryId, category);
      reloadLists();
      setSelectedMemory((prev) =>
        prev && prev.id === memoryId ? { ...prev, category: category as MemoryCategory } : prev,
      );
    } catch (e: unknown) {
      setError(`Failed to update category: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleDelete = async (memoryId: number) => {
    try {
      setError(null);
      await deleteMemory(memoryId);
      reloadLists();
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

  const categoryRows = (category: string): Memory[] => pages()[category]?.rows ?? [];

  const allVisibleMemoryIds = (): number[] => {
    const collapsed = collapsedCategories();
    const ids: number[] = [];
    for (const header of categoryHeaders()) {
      if (collapsed.has(header.category)) continue;
      for (const row of categoryRows(header.category)) ids.push(row.id);
    }
    return ids;
  };

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
    setCollapsedCategories(new Set(categoryHeaders().map((header) => header.category)));
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
      reloadLists();
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
      reloadLists();
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

  // Importance band → pill color, mirroring the SessionViewer compartment bands
  // (classify-memories scores 1-100; the budget trim keeps the top, drops the
  // bottom). The numeric score is always shown alongside.
  const importanceBand = (importance: number): { label: string; cls: string } => {
    if (importance >= 80) return { label: "critical", cls: "red" };
    if (importance >= 60) return { label: "high", cls: "amber" };
    if (importance >= 40) return { label: "medium", cls: "blue" };
    return { label: "low", cls: "gray" };
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
              background: "var(--error-bg)",
              border: "1px solid var(--error-border)",
              "border-radius": "var(--radius-md)",
              padding: "8px 12px",
              "font-size": "12px",
              color: "var(--error-text)",
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
      <Show when={!embedded()}>
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
      </Show>

      <Show when={embedded() && !mural.loading && mural()}>
        {(entry) => (
          <section class="memory-mural-section" style={{ padding: "0 20px 12px" }}>
            <button
              type="button"
              class="category-header clickable"
              style={{ width: "100%" }}
              aria-expanded={!muralCollapsed()}
              onClick={() => setMuralCollapsed((collapsed) => !collapsed)}
            >
              <span>Memory mural</span>
              <span class="category-divider" />
              <span
                class="category-chevron"
                classList={{ collapsed: muralCollapsed() }}
                aria-hidden="true"
              >
                ▾
              </span>
            </button>
            <Show when={!muralCollapsed()}>
              <div class="card" style={{ padding: "12px" }}>
                <Show
                  when={muralSrc()}
                  fallback={<div class="empty-state">Mural image is unavailable.</div>}
                >
                  {(src) => (
                    <img
                      src={src()}
                      alt="Memory mural"
                      width={entry().width}
                      height={entry().height}
                      decoding="async"
                      style={{
                        display: "block",
                        width: "100%",
                        height: "auto",
                        "max-height": "70vh",
                        "object-fit": "contain",
                        "border-radius": "var(--radius-sm)",
                      }}
                    />
                  )}
                </Show>
                <div class="card-meta" style={{ "margin-top": "8px" }}>
                  <span>Rendered {formatDateTime(entry().rendered_at)}</span>
                  <span>·</span>
                  <span>{entry().token_estimate.toLocaleString()} token estimate</span>
                </div>
              </div>
            </Show>
          </section>
        )}
      </Show>

      <div class="filter-bar">
        <Show when={!embedded()}>
          <FilterSelect
            value={workspaceFilter() === "" ? "" : String(workspaceFilter())}
            onChange={(v) => {
              if (v === "") {
                setWorkspaceFilter("");
              } else {
                setWorkspaceFilter(Number(v));
                setProjectFilter("");
              }
            }}
            placeholder="All workspaces"
            align="left"
            options={[
              { value: "", label: "All workspaces" },
              ...(workspaceSummaries() ?? []).map((w) => ({
                value: String(w.id),
                label: w.name,
              })),
            ]}
          />
          <FilterSelect
            value={projectFilter()}
            onChange={(v) => {
              setProjectFilter(v);
              if (v) setWorkspaceFilter("");
            }}
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
                      <For each={p.harnesses}>
                        {(harness) => <HarnessBadge harness={harness} />}
                      </For>
                    </span>
                  </span>
                ),
              })),
            ]}
          />
        </Show>
        <input
          class="search-input"
          type="text"
          placeholder="Search memories..."
          onInput={(e) => handleSearch(e.currentTarget.value)}
        />
        <FilterSelect
          value={statusFilter()}
          onChange={setStatusFilter}
          placeholder="Not archived"
          options={[
            { value: DEFAULT_STATUS_SELECTION, label: "Not archived" },
            { value: "any", label: "All status" },
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
      <Show when={!stats.loading && categoryHeaders().length > 0}>
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
          when={!stats.loading || categoryHeaders().length > 0}
          fallback={<div class="empty-state">Loading memories...</div>}
        >
          <Show
            when={categoryHeaders().length > 0}
            fallback={
              <div class="empty-state">
                <span class="empty-state-icon">🧠</span>
                <span>{stats.error ? "Couldn't load memory counts." : "No memories found"}</span>
              </div>
            }
          >
            <div class="list-gap">
              <For each={categoryHeaders()}>
                {(header) => {
                  const collapsed = () => collapsedCategories().has(header.category);
                  const page = () => pages()[header.category];
                  const mems = () => page()?.rows ?? [];
                  const loading = () => loadingCategories().has(header.category);
                  const failed = () => failedCategories().has(header.category);
                  const truncated = () => {
                    const loaded = page();
                    if (!loaded || loaded.complete) return null;
                    return showingLabel(loaded.rows.length, header.count);
                  };
                  return (
                    <>
                      <button
                        type="button"
                        class="category-header clickable"
                        onClick={() => toggleCategoryCollapse(header.category)}
                      >
                        {/* Tri-state checkbox: clicking stops propagation so it
                            doesn't also collapse the category. It covers loaded
                            rows only; unloaded pages are not selected. */}
                        <span style={{ display: "flex", "align-items": "center" }}>
                          <TriStateCheckbox
                            state={categorySelectionState(mems())}
                            onToggle={() => toggleCategorySelection(mems())}
                            ariaLabel={`Toggle loaded memories in ${header.category}`}
                          />
                        </span>
                        <span>{header.category}</span>
                        <span class="category-count">{categoryCountText(header.count)}</span>
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
                        <Show when={loading() && !page()}>
                          <div class="empty-state">Loading {header.category}...</div>
                        </Show>
                        <Show when={failed() && !page()}>
                          <button
                            type="button"
                            class="bulk-action-link"
                            onClick={() => void loadCategory(header.category, listKey(), 0)}
                          >
                            Retry {header.category}
                          </button>
                        </Show>
                        <For each={mems()}>
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
                                    <span
                                      class={`pill ${importanceBand(mem.importance).cls}`}
                                      title={`importance ${mem.importance} · ${importanceBand(mem.importance).label} (classify)`}
                                    >
                                      imp {mem.importance}
                                    </span>
                                    <Show when={mem.scope !== "project"}>
                                      <span class="pill indigo" title="memory scope (classify)">
                                        {mem.scope}
                                      </span>
                                    </Show>
                                    <Show when={mem.shareable}>
                                      <span
                                        class="pill green"
                                        title="safe to share with teammates (classify)"
                                      >
                                        shareable
                                      </span>
                                    </Show>
                                    <Show
                                      when={workspaceFilter() !== "" && mem.source_display_name}
                                    >
                                      <span class="pill gray">
                                        source: {mem.source_display_name}
                                      </span>
                                    </Show>
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
                        <Show when={truncated()}>
                          <div class="category-page-status">
                            <span class="category-count">{truncated()}</span>
                            <button
                              type="button"
                              class="bulk-action-link"
                              disabled={loading()}
                              onClick={() =>
                                void loadCategory(header.category, listKey(), mems().length)
                              }
                            >
                              {loading() ? "Loading…" : "Load more"}
                            </button>
                          </div>
                        </Show>
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
            onCategoryChange={handleCategoryChange}
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
