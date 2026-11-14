import { createResource, createSignal, Index, Show } from "solid-js";
import {
  applyWorkspaceChanges,
  createWorkspace,
  deleteWorkspace,
  enumerateMemoryProjects,
  listWorkspaces,
  workspaceSchemaReady,
} from "../../lib/api";
import type { WorkspaceListItem } from "../../lib/types";
import FilterSelect from "../shared/FilterSelect";
import {
  availableProjectsForWorkspace,
  categorySummary,
  createWorkspaceStage,
  finalMemberCount,
  SHARE_CATEGORY_OPTIONS,
  stagedMemberRows,
  toggleShareCategory,
  type WorkspaceStage,
  workspaceStageDirty,
  workspaceStageToPayload,
} from "./workspace-staging";

export default function WorkspacesPanel() {
  const [ready] = createResource(workspaceSchemaReady);
  const [workspaces, { refetch }] = createResource(listWorkspaces);
  const [projects] = createResource(enumerateMemoryProjects);
  const [error, setError] = createSignal<string | null>(null);
  const [newName, setNewName] = createSignal("");
  const [stages, setStages] = createSignal<Record<number, WorkspaceStage>>({});
  const [addMemberWsId, setAddMemberWsId] = createSignal<number | null>(null);
  const [addMemberProject, setAddMemberProject] = createSignal("");
  const [addMemberDisplayName, setAddMemberDisplayName] = createSignal("");
  const [confirmDeleteId, setConfirmDeleteId] = createSignal<number | null>(null);
  const [confirmRemoveKey, setConfirmRemoveKey] = createSignal<string | null>(null);
  const [editingDisplayKey, setEditingDisplayKey] = createSignal<string | null>(null);
  const [editingDisplayValue, setEditingDisplayValue] = createSignal("");
  let confirmDeleteTimer: ReturnType<typeof setTimeout> | undefined;
  let confirmRemoveTimer: ReturnType<typeof setTimeout> | undefined;

  const cloneStage = (stage: WorkspaceStage): WorkspaceStage => ({
    rename: stage.rename,
    addMembers: stage.addMembers.map((member) => ({ ...member })),
    removeMembers: [...stage.removeMembers],
    setNames: { ...stage.setNames },
    shareCategories: [...stage.shareCategories],
    categoriesEdited: stage.categoriesEdited,
  });

  const stageFor = (workspace: WorkspaceListItem): WorkspaceStage =>
    stages()[workspace.id] ?? createWorkspaceStage(workspace);

  const updateStage = (
    workspace: WorkspaceListItem,
    updater: (stage: WorkspaceStage) => WorkspaceStage,
  ) => {
    setStages((prev) => {
      const current = cloneStage(prev[workspace.id] ?? createWorkspaceStage(workspace));
      return { ...prev, [workspace.id]: updater(current) };
    });
  };

  const clearStage = (workspaceId: number) => {
    setStages((prev) => {
      const next = { ...prev };
      delete next[workspaceId];
      return next;
    });
  };

  const discardStage = (workspace: WorkspaceListItem) => {
    clearStage(workspace.id);
    if (addMemberWsId() === workspace.id) {
      setAddMemberWsId(null);
      setAddMemberProject("");
      setAddMemberDisplayName("");
    }
    if (editingDisplayKey()?.startsWith(`${workspace.id}:`)) {
      setEditingDisplayKey(null);
      setEditingDisplayValue("");
    }
  };

  const twoClickDelete = (id: number, perform: () => void) => {
    if (confirmDeleteId() !== id) {
      setConfirmDeleteId(id);
      if (confirmDeleteTimer) clearTimeout(confirmDeleteTimer);
      confirmDeleteTimer = setTimeout(() => setConfirmDeleteId(null), 3000);
      return;
    }
    if (confirmDeleteTimer) clearTimeout(confirmDeleteTimer);
    setConfirmDeleteId(null);
    perform();
  };

  const twoClickRemove = (key: string, perform: () => void) => {
    if (confirmRemoveKey() !== key) {
      setConfirmRemoveKey(key);
      if (confirmRemoveTimer) clearTimeout(confirmRemoveTimer);
      confirmRemoveTimer = setTimeout(() => setConfirmRemoveKey(null), 3000);
      return;
    }
    if (confirmRemoveTimer) clearTimeout(confirmRemoveTimer);
    setConfirmRemoveKey(null);
    perform();
  };

  const handleCreate = async () => {
    const name = newName().trim();
    if (!name) return;
    try {
      setError(null);
      await createWorkspace(name);
      setNewName("");
      refetch();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDelete = async (id: number) => {
    try {
      setError(null);
      await deleteWorkspace(id);
      clearStage(id);
      refetch();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const memberProjectsForWorkspace = (ws: WorkspaceListItem) =>
    availableProjectsForWorkspace(ws, projects() ?? [], stageFor(ws));

  const handleStageAddMember = (workspace: WorkspaceListItem) => {
    const identity = addMemberProject();
    if (!identity) return;
    const row = (projects() ?? []).find((p) => p.identity === identity);
    if (!row) return;
    const displayName = addMemberDisplayName().trim() || row.display_name;
    updateStage(workspace, (stage) => {
      if (!stage.addMembers.some((member) => member.project_path === row.identity)) {
        stage.addMembers.push({
          project_path: row.identity,
          display_name: displayName,
          display_path: row.primary_path,
        });
      }
      return stage;
    });
    setAddMemberWsId(null);
    setAddMemberProject("");
    setAddMemberDisplayName("");
  };

  const handleStageRemoveMember = (
    workspace: WorkspaceListItem,
    projectPath: string,
    pending: boolean,
  ) => {
    updateStage(workspace, (stage) => {
      if (pending) {
        stage.addMembers = stage.addMembers.filter((member) => member.project_path !== projectPath);
        return stage;
      }
      if (!stage.removeMembers.includes(projectPath)) {
        stage.removeMembers.push(projectPath);
      }
      return stage;
    });
  };

  const handleUndoRemoveMember = (workspace: WorkspaceListItem, projectPath: string) => {
    updateStage(workspace, (stage) => {
      stage.removeMembers = stage.removeMembers.filter((identity) => identity !== projectPath);
      return stage;
    });
  };

  const handleStageDisplayName = (workspace: WorkspaceListItem, projectPath: string) => {
    const name = editingDisplayValue().trim();
    if (!name) {
      setError("Display name cannot be empty.");
      return;
    }
    updateStage(workspace, (stage) => {
      const pending = stage.addMembers.find((member) => member.project_path === projectPath);
      if (pending) pending.display_name = name;
      else stage.setNames[projectPath] = name;
      return stage;
    });
    setEditingDisplayKey(null);
    setEditingDisplayValue("");
  };

  const handleSaveChanges = async (workspace: WorkspaceListItem) => {
    const stage = stageFor(workspace);
    if (!workspaceStageDirty(workspace, stage)) return;
    if (!stage.rename.trim()) {
      setError("Workspace name cannot be empty.");
      return;
    }
    try {
      setError(null);
      await applyWorkspaceChanges(workspaceStageToPayload(workspace, stage));
      clearStage(workspace.id);
      setEditingDisplayKey(null);
      setEditingDisplayValue("");
      if (addMemberWsId() === workspace.id) {
        setAddMemberWsId(null);
        setAddMemberProject("");
        setAddMemberDisplayName("");
      }
      refetch();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
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
            }}
          >
            {error()}
            <button
              type="button"
              class="btn sm"
              style={{ "margin-left": "8px" }}
              onClick={() => setError(null)}
            >
              ✕
            </button>
          </div>
        </div>
      </Show>

      <div class="section-header">
        <h1 class="section-title">Workspaces</h1>
      </div>

      <div class="scroll-area">
        <Show when={!ready.loading && ready() === false}>
          <div class="empty-state" style={{ "max-width": "480px", margin: "40px auto" }}>
            <span class="empty-state-icon">🗂️</span>
            <p style={{ "margin-top": "12px", "line-height": "1.5" }}>
              Update the Magic Context plugin and start a session to enable workspaces.
            </p>
          </div>
        </Show>

        <Show when={ready() === true}>
          <div style={{ padding: "0 0 16px", display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
            <input
              class="search-input"
              type="text"
              placeholder="New workspace name"
              value={newName()}
              onInput={(e) => setNewName(e.currentTarget.value)}
              style={{ "max-width": "240px" }}
            />
            <button type="button" class="btn primary sm" onClick={handleCreate}>
              Create
            </button>
          </div>

          <Show when={workspaces.loading}>
            <div class="empty-state">Loading workspaces...</div>
          </Show>

          <Show when={!workspaces.loading && (workspaces() ?? []).length === 0}>
            <div class="empty-state">
              <span class="empty-state-icon">🗂️</span>
              <span>No workspaces yet — create one to pool memories across projects.</span>
            </div>
          </Show>

          <div class="list-gap">
            <Index each={workspaces() ?? []}>
              {(ws) => {
                const item = () => ws() as WorkspaceListItem;
                const stage = () => stageFor(item());
                const dirty = () => workspaceStageDirty(item(), stage());
                const removeKey = (projectPath: string) => `${item().id}:${projectPath}`;
                return (
                  <div class="card" style={{ padding: "12px 14px" }}>
                    <div
                      style={{
                        display: "flex",
                        "justify-content": "space-between",
                        "align-items": "flex-start",
                        gap: "8px",
                        "flex-wrap": "wrap",
                      }}
                    >
                      <div style={{ display: "grid", gap: "6px", "min-width": "220px" }}>
                        <span
                          style={{
                            "font-size": "11px",
                            color: "var(--text-muted)",
                            "text-transform": "uppercase",
                            "letter-spacing": "0.04em",
                          }}
                        >
                          Workspace name
                        </span>
                        <input
                          class="search-input"
                          value={stage().rename}
                          onInput={(e) =>
                            updateStage(item(), (next) => {
                              next.rename = e.currentTarget.value;
                              return next;
                            })
                          }
                          style={{ "max-width": "260px" }}
                        />
                        <Show when={dirty()}>
                          <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>
                            {finalMemberCount(item(), stage())} members, categories:{" "}
                            {categorySummary(stage().shareCategories)} — unsaved
                          </span>
                        </Show>
                      </div>
                      <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
                        {/* Save + Discard only appear when there are unsaved
                            edits — this keeps Save out of the way at rest and
                            disambiguates Discard (revert unsaved edits) from
                            Delete (remove the workspace), which is always shown. */}
                        <Show when={dirty()}>
                          <button
                            type="button"
                            class="btn sm primary"
                            onClick={() => handleSaveChanges(item())}
                          >
                            Save changes
                          </button>
                          <button type="button" class="btn sm" onClick={() => discardStage(item())}>
                            Discard
                          </button>
                        </Show>
                        <button
                          type="button"
                          class="btn sm danger"
                          onClick={() => twoClickDelete(item().id, () => handleDelete(item().id))}
                        >
                          {confirmDeleteId() === item().id ? "Click again to confirm" : "Delete"}
                        </button>
                      </div>
                    </div>

                    <div style={{ "margin-top": "14px" }}>
                      <div class="category-header" style={{ "margin-bottom": "8px" }}>
                        Shared categories
                      </div>
                      <div class="share-categories-row">
                        <Index each={SHARE_CATEGORY_OPTIONS}>
                          {(option) => (
                            <label class="share-category-label">
                              <input
                                type="checkbox"
                                checked={stage().shareCategories.includes(option().value)}
                                onChange={() =>
                                  updateStage(item(), (next) => {
                                    next.shareCategories = toggleShareCategory(
                                      next.shareCategories,
                                      option().value,
                                    );
                                    next.categoriesEdited = true;
                                    return next;
                                  })
                                }
                              />
                              {option().label}
                            </label>
                          )}
                        </Index>
                      </div>
                    </div>

                    <div style={{ "margin-top": "14px" }}>
                      <div class="category-header" style={{ "margin-bottom": "8px" }}>
                        Members{" "}
                        <span class="category-count">({finalMemberCount(item(), stage())})</span>
                      </div>
                      <Index each={stagedMemberRows(item(), stage())}>
                        {(member) => {
                          const m = () => member();
                          const key = () => removeKey(m().project_path);
                          return (
                            <div
                              class="card"
                              style={{
                                padding: "8px 10px",
                                "margin-bottom": "6px",
                                display: "flex",
                                "align-items": "center",
                                gap: "8px",
                                "flex-wrap": "wrap",
                                opacity: m().removed ? 0.62 : 1,
                              }}
                            >
                              <Show
                                when={editingDisplayKey() === key()}
                                fallback={
                                  <>
                                    <span
                                      class="pill blue"
                                      style={{
                                        "text-decoration": m().removed ? "line-through" : "none",
                                      }}
                                    >
                                      {m().pending
                                        ? `+ ${m().display_name} (pending)`
                                        : m().display_name}
                                      {m().removed ? " (remove pending)" : ""}
                                    </span>
                                    <span
                                      style={{
                                        color: "var(--text-muted)",
                                        "font-size": "12px",
                                        "text-decoration": m().removed ? "line-through" : "none",
                                      }}
                                    >
                                      {m().pending ? "Pending" : `${m().memory_count} memories`} ·{" "}
                                      {m().display_path}
                                    </span>
                                    <button
                                      type="button"
                                      class="btn sm ghost"
                                      disabled={m().removed}
                                      onClick={() => {
                                        setEditingDisplayKey(key());
                                        setEditingDisplayValue(m().display_name);
                                      }}
                                    >
                                      Edit name
                                    </button>
                                  </>
                                }
                              >
                                <input
                                  class="search-input"
                                  value={editingDisplayValue()}
                                  onInput={(e) => setEditingDisplayValue(e.currentTarget.value)}
                                  style={{ "max-width": "140px" }}
                                />
                                <button
                                  type="button"
                                  class="btn sm"
                                  onClick={() => handleStageDisplayName(item(), m().project_path)}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  class="btn sm"
                                  onClick={() => setEditingDisplayKey(null)}
                                >
                                  Cancel
                                </button>
                              </Show>
                              <Show
                                when={m().removed}
                                fallback={
                                  <button
                                    type="button"
                                    class="btn sm danger"
                                    style={{ "margin-left": "auto" }}
                                    onClick={() => {
                                      if (m().pending)
                                        handleStageRemoveMember(item(), m().project_path, true);
                                      else
                                        twoClickRemove(key(), () =>
                                          handleStageRemoveMember(item(), m().project_path, false),
                                        );
                                    }}
                                  >
                                    {m().pending
                                      ? "Remove pending"
                                      : confirmRemoveKey() === key()
                                        ? "Confirm remove"
                                        : "Remove"}
                                  </button>
                                }
                              >
                                <button
                                  type="button"
                                  class="btn sm"
                                  style={{ "margin-left": "auto" }}
                                  onClick={() => handleUndoRemoveMember(item(), m().project_path)}
                                >
                                  Undo remove
                                </button>
                              </Show>
                            </div>
                          );
                        }}
                      </Index>

                      <Show when={addMemberWsId() === item().id}>
                        <div
                          style={{
                            display: "flex",
                            gap: "8px",
                            "flex-wrap": "wrap",
                            "align-items": "center",
                            "margin-top": "8px",
                          }}
                        >
                          <FilterSelect
                            value={addMemberProject()}
                            onChange={setAddMemberProject}
                            placeholder="Select project"
                            align="left"
                            options={[
                              { value: "", label: "Select project" },
                              ...memberProjectsForWorkspace(item()).map((p) => ({
                                value: p.identity,
                                label: p.display_name,
                              })),
                            ]}
                          />
                          <input
                            class="search-input"
                            placeholder="Display name (optional)"
                            value={addMemberDisplayName()}
                            onInput={(e) => setAddMemberDisplayName(e.currentTarget.value)}
                            style={{ "max-width": "160px" }}
                          />
                          <button
                            type="button"
                            class="btn sm primary"
                            onClick={() => handleStageAddMember(item())}
                          >
                            Add
                          </button>
                          <button
                            type="button"
                            class="btn sm"
                            onClick={() => {
                              setAddMemberWsId(null);
                              setAddMemberProject("");
                              setAddMemberDisplayName("");
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </Show>
                      <Show when={addMemberWsId() !== item().id}>
                        <button
                          type="button"
                          class="btn sm"
                          style={{ "margin-top": "8px" }}
                          onClick={() => {
                            setAddMemberWsId(item().id);
                            setAddMemberProject("");
                            setAddMemberDisplayName("");
                          }}
                        >
                          + Add member
                        </button>
                      </Show>
                    </div>
                  </div>
                );
              }}
            </Index>
          </div>
        </Show>
      </div>
    </>
  );
}
