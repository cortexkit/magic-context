import { createEffect, createSignal, on, Show } from "solid-js";
import { formatTimestamp, getMemoryHistory } from "../../lib/api";
import type { Memory, MemoryHistoryDecision } from "../../lib/types";
import FilterSelect from "../shared/FilterSelect";
import { SHARE_CATEGORY_OPTIONS } from "../WorkspacesPanel/workspace-staging";
import { MEMORY_HISTORY_REQUIREMENT } from "./database-features";
import EditNotice from "./EditNotice";
import MemoryHistoryTimeline from "./MemoryHistoryTimeline";
import { decisionView, type EditOutcome, HISTORY_PAGE_SIZE } from "./memory-history";

interface Props {
  memory: Memory;
  historyAvailable: boolean;
  /** Bumped by the parent after an undo so the history tab reloads. */
  historyReload: number;
  onClose: () => void;
  // Every edit sends the revision of the memory shown here and resolves to
  // what the panel should tell the user (saved, changed elsewhere, refused).
  onStatusChange: (memory: Memory, status: string) => Promise<EditOutcome>;
  onContentChange: (memory: Memory, content: string) => Promise<EditOutcome>;
  onCategoryChange: (memory: Memory, category: string) => Promise<EditOutcome>;
  onArchive: (memory: Memory) => Promise<EditOutcome>;
  /** Re-reads this memory after a conflict. */
  onReload: (memoryId: number) => Promise<void>;
  onUndo: (decisionKey: string, projectPath: string, title: string) => void;
}

type Tab = "details" | "history";

export default function MemoryDetail(props: Props) {
  const [tab, setTab] = createSignal<Tab>("details");
  const [editing, setEditing] = createSignal(false);
  const [editContent, setEditContent] = createSignal(props.memory.content);
  const [notice, setNotice] = createSignal<EditOutcome | null>(null);
  const [busy, setBusy] = createSignal(false);

  // Sync editContent when the shown memory changes (another row, or a reload).
  createEffect(() => {
    setEditContent(props.memory.content);
    setEditing(false);
  });
  // A different memory starts on its details with no leftover message.
  createEffect(
    on(
      () => props.memory.id,
      () => {
        setNotice(null);
        setTab("details");
      },
      { defer: true },
    ),
  );

  const mergedFrom = () => {
    if (!props.memory.merged_from) return null;
    try {
      return JSON.parse(props.memory.merged_from) as number[];
    } catch {
      return null;
    }
  };

  const run = async (edit: () => Promise<EditOutcome>): Promise<EditOutcome | null> => {
    if (busy()) return null;
    setBusy(true);
    try {
      const outcome = await edit();
      setNotice(outcome);
      return outcome;
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    const outcome = await run(() => props.onContentChange(props.memory, editContent()));
    if (outcome?.kind === "applied") setEditing(false);
  };

  const isPinned = () => props.memory.status === "permanent";

  const loadHistory = (cursor: string | undefined) =>
    getMemoryHistory({
      projectPath: props.memory.project_path,
      memoryId: props.memory.id,
      limit: HISTORY_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });

  const undoDecision = (decision: MemoryHistoryDecision) =>
    props.onUndo(decision.decisionKey, decision.projectPath, decisionView(decision).headline);

  return (
    <div class="slide-panel-overlay">
      <button
        type="button"
        class="slide-panel-backdrop"
        onClick={props.onClose}
        style={{
          background: "transparent",
          border: "none",
          position: "absolute",
          inset: 0,
          cursor: "pointer",
        }}
        aria-label="Close panel"
      />
      <div class="slide-panel" classList={{ wide: tab() === "history" }}>
        <div
          style={{
            display: "flex",
            "justify-content": "space-between",
            "align-items": "center",
            "margin-bottom": "12px",
          }}
        >
          <h2 style={{ "font-size": "15px", "font-weight": "600" }}>Memory #{props.memory.id}</h2>
          <button type="button" class="btn sm" onClick={props.onClose}>
            ✕ Close
          </button>
        </div>
        <div class="tab-pills memory-detail-tabs">
          <button
            type="button"
            class="tab-pill"
            classList={{ active: tab() === "details" }}
            onClick={() => setTab("details")}
          >
            Details
          </button>
          <Show when={props.historyAvailable}>
            <button
              type="button"
              class="tab-pill"
              classList={{ active: tab() === "history" }}
              onClick={() => setTab("history")}
            >
              History
            </button>
          </Show>
        </div>
        <Show when={!props.historyAvailable}>
          <p class="history-intro">{MEMORY_HISTORY_REQUIREMENT}</p>
        </Show>

        <Show when={tab() === "history" && props.historyAvailable}>
          <MemoryHistoryTimeline
            load={loadHistory}
            reloadToken={`${props.memory.id}:${props.historyReload}`}
            focusMemoryId={props.memory.id}
            emptyText="No recorded changes for this memory yet."
            onUndo={undoDecision}
          />
        </Show>

        <Show when={tab() === "details"}>
          <Show when={notice()}>
            {(n) => (
              <EditNotice
                outcome={n()}
                onReload={async () => {
                  await props.onReload(props.memory.id);
                  setNotice(null);
                }}
                onUndo={(key) =>
                  props.onUndo(
                    key,
                    props.memory.project_path,
                    `Your edit to memory #${props.memory.id}`,
                  )
                }
              />
            )}
          </Show>

          {/* Metadata */}
          <table class="kv-table" style={{ "margin-bottom": "16px" }}>
            <tbody>
              <tr>
                <td>Category</td>
                <td>
                  <FilterSelect
                    compact
                    value={props.memory.category}
                    onChange={(v) => void run(() => props.onCategoryChange(props.memory, v))}
                    options={SHARE_CATEGORY_OPTIONS}
                  />
                </td>
              </tr>
              <tr>
                <td>Status</td>
                <td>
                  <FilterSelect
                    compact
                    value={props.memory.status}
                    onChange={(v) => void run(() => props.onStatusChange(props.memory, v))}
                    options={[
                      { value: "active", label: "active" },
                      { value: "permanent", label: "permanent" },
                      { value: "archived", label: "archived" },
                    ]}
                  />
                </td>
              </tr>
              <tr>
                <td>Source</td>
                <td>{props.memory.source_type}</td>
              </tr>
              <tr>
                <td>Importance</td>
                <td>
                  {props.memory.importance}
                  <span style={{ color: "var(--text-muted)" }}> / 100 · scored by classify</span>
                </td>
              </tr>
              <tr>
                <td>Scope</td>
                <td>
                  {props.memory.scope}
                  {props.memory.shareable ? " · shareable with teammates" : " · private"}
                </td>
              </tr>
              <tr>
                <td>Project</td>
                <td style={{ "word-break": "break-all" }}>{props.memory.project_path}</td>
              </tr>
            </tbody>
          </table>

          {/* Content */}
          <div style={{ "margin-bottom": "16px" }}>
            <Show
              when={editing()}
              fallback={
                <div>
                  <div
                    style={{
                      background: "var(--bg-base)",
                      border: "1px solid var(--border)",
                      "border-radius": "var(--radius-md)",
                      padding: "12px",
                      "font-family": "var(--mono-font)",
                      "font-size": "12px",
                      "line-height": "1.6",
                      "white-space": "pre-wrap",
                      "word-break": "break-word",
                      "max-height": "200px",
                      "overflow-y": "auto",
                    }}
                  >
                    {props.memory.content}
                  </div>
                  <button
                    type="button"
                    class="btn sm"
                    style={{ "margin-top": "8px" }}
                    onClick={() => setEditing(true)}
                  >
                    Edit Content
                  </button>
                </div>
              }
            >
              <textarea
                class="code-editor"
                style={{ "min-height": "150px" }}
                value={editContent()}
                onInput={(e) => setEditContent(e.currentTarget.value)}
              />
              <div style={{ display: "flex", gap: "8px", "margin-top": "8px" }}>
                <button type="button" class="btn primary sm" disabled={busy()} onClick={handleSave}>
                  Save
                </button>
                <button
                  type="button"
                  class="btn sm"
                  onClick={() => {
                    setEditing(false);
                    setEditContent(props.memory.content);
                  }}
                >
                  Cancel
                </button>
              </div>
            </Show>
          </div>

          {/* Stats */}
          <div class="category-header">Stats</div>
          <table class="kv-table" style={{ "margin-bottom": "16px" }}>
            <tbody>
              <tr>
                <td>Seen</td>
                <td>{props.memory.seen_count} times</td>
              </tr>
              <tr>
                <td>Retrieved</td>
                <td>{props.memory.retrieval_count} times</td>
              </tr>
              <tr>
                <td>First seen</td>
                <td>{formatTimestamp(props.memory.first_seen_at)}</td>
              </tr>
              <tr>
                <td>Last seen</td>
                <td>{formatTimestamp(props.memory.last_seen_at)}</td>
              </tr>
              <tr>
                <td>Created</td>
                <td>{formatTimestamp(props.memory.created_at)}</td>
              </tr>
              <tr>
                <td>Updated</td>
                <td>{formatTimestamp(props.memory.updated_at)}</td>
              </tr>
            </tbody>
          </table>

          {/* Embedding */}
          <div class="category-header">Embedding</div>
          <div style={{ "margin-bottom": "16px", "font-size": "12px" }}>
            <Show
              when={props.memory.has_embedding}
              fallback={<span style={{ color: "var(--text-muted)" }}>○ No embedding</span>}
            >
              <span style={{ color: "var(--accent)" }}>● Embedded</span>
            </Show>
          </div>

          {/* Merge History */}
          <Show when={mergedFrom()}>
            <div class="category-header">Merge History</div>
            <div style={{ "margin-bottom": "16px", "font-size": "12px" }}>
              Merged from:{" "}
              {mergedFrom()
                ?.map((id) => `#${id}`)
                .join(", ")}
            </div>
          </Show>

          {/* Actions */}
          <div class="memory-detail-actions">
            <button
              type="button"
              class="btn sm"
              disabled={busy() || props.memory.status === "archived"}
              title={
                isPinned() ? "Return to normal (active) status" : "Keep this memory permanently"
              }
              onClick={() =>
                void run(() =>
                  props.onStatusChange(props.memory, isPinned() ? "active" : "permanent"),
                )
              }
            >
              {isPinned() ? "Unpin" : "Pin"}
            </button>
            <Show when={props.memory.status !== "archived"}>
              <button
                type="button"
                class="btn sm"
                disabled={busy()}
                title="Stop using this memory in sessions. You can undo this from History."
                onClick={() => void run(() => props.onArchive(props.memory))}
              >
                Archive
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
