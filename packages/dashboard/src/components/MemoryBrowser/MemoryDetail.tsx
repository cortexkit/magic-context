import { createSignal, Show } from "solid-js";
import type { Memory } from "../../lib/types";
import { formatTimestamp } from "../../lib/api";
import FilterSelect from "../shared/FilterSelect";

interface Props {
  memory: Memory;
  onClose: () => void;
  onStatusChange: (id: number, status: string) => Promise<void>;
  onContentChange: (id: number, content: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

export default function MemoryDetail(props: Props) {
  const [editing, setEditing] = createSignal(false);
  const [editContent, setEditContent] = createSignal(props.memory.content);
  const [confirmDelete, setConfirmDelete] = createSignal(false);

  const mergedFrom = () => {
    if (!props.memory.merged_from) return null;
    try {
      return JSON.parse(props.memory.merged_from) as number[];
    } catch {
      return null;
    }
  };

  const handleSave = async () => {
    await props.onContentChange(props.memory.id, editContent());
    setEditing(false);
  };

  const handleDelete = async () => {
    if (!confirmDelete()) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    await props.onDelete(props.memory.id);
  };

  return (
    <div class="slide-panel-overlay">
      <div class="slide-panel-backdrop" onClick={props.onClose} />
      <div class="slide-panel">
        <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "16px" }}>
          <h2 style={{ "font-size": "15px", "font-weight": "600" }}>Memory #{props.memory.id}</h2>
          <button class="btn sm" onClick={props.onClose}>✕ Close</button>
        </div>

        {/* Metadata */}
        <table class="kv-table" style={{ "margin-bottom": "16px" }}>
          <tbody>
            <tr>
              <td>Category</td>
              <td>{props.memory.category}</td>
            </tr>
            <tr>
              <td>Status</td>
              <td>
                <FilterSelect
                  compact
                  value={props.memory.status}
                  onChange={(v) => props.onStatusChange(props.memory.id, v)}
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
                <button class="btn sm" style={{ "margin-top": "8px" }} onClick={() => setEditing(true)}>
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
              <button class="btn primary sm" onClick={handleSave}>Save</button>
              <button class="btn sm" onClick={() => { setEditing(false); setEditContent(props.memory.content); }}>
                Cancel
              </button>
            </div>
          </Show>
        </div>

        {/* Stats */}
        <div class="category-header">Stats</div>
        <table class="kv-table" style={{ "margin-bottom": "16px" }}>
          <tbody>
            <tr><td>Seen</td><td>{props.memory.seen_count} times</td></tr>
            <tr><td>Retrieved</td><td>{props.memory.retrieval_count} times</td></tr>
            <tr><td>First seen</td><td>{formatTimestamp(props.memory.first_seen_at)}</td></tr>
            <tr><td>Last seen</td><td>{formatTimestamp(props.memory.last_seen_at)}</td></tr>
            <tr><td>Created</td><td>{formatTimestamp(props.memory.created_at)}</td></tr>
            <tr><td>Updated</td><td>{formatTimestamp(props.memory.updated_at)}</td></tr>
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
            Merged from: {mergedFrom()!.map((id) => `#${id}`).join(", ")}
          </div>
        </Show>

        {/* Actions */}
        <div style={{ display: "flex", gap: "8px", "padding-top": "12px", "border-top": "1px solid var(--border)" }}>
          <Show when={props.memory.status !== "archived"}>
            <button
              class="btn sm"
              onClick={() => props.onStatusChange(props.memory.id, "archived")}
            >
              Archive
            </button>
          </Show>
          <button class="btn sm danger" onClick={handleDelete}>
            {confirmDelete() ? "Click again to confirm" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
