import { invoke } from "./platform";

import type {
  CacheEvent,
  Compartment,
  ConfigFile,
  ContextTokenBreakdown,
  DbCacheEvent,
  DbHealth,
  DreamRun,
  DreamRunMemoryDetail,
  DreamStateEntry,
  Harness,
  LogEntry,
  Memory,
  MemoryEditReceipt,
  MemoryHistoryPage,
  MemoryHistoryRequest,
  MemoryRestorePreview,
  MemoryRestoreReceipt,
  MemoryRestoreRequest,
  MemoryRevisionRef,
  MemoryStats,
  ModelCatalogs,
  MuralManifest,
  Note,
  OpencodeInstallState,
  PagedSessions,
  Primer,
  PrimerCandidate,
  ProjectRow,
  SessionDetail,
  SessionFact,
  SessionFilter,
  SessionMessageRow,
  SessionMetaRow,
  SessionRow,
  SessionSummary,
  SubagentInvocation,
  SubagentTotals,
  TaskScheduleEntry,
  UserMemory,
  UserMemoryCandidate,
  WorkspaceListItem,
  WorkspaceShareCategory,
  WorkspaceSummary,
} from "./types";

// ── Memory API ──────────────────────────────────────────────

export async function getProjects(): Promise<import("./types").ProjectInfo[]> {
  return invoke("get_projects");
}

export async function getMemories(params?: {
  project?: string;
  workspaceId?: number;
  status?: string;
  category?: string;
  search?: string;
  /** Omit archived rows when no exact status is set. Matches the default stats totals. */
  excludeArchived?: boolean;
  limit?: number;
  offset?: number;
}): Promise<Memory[]> {
  return invoke("get_memories", {
    project: params?.project ?? null,
    workspaceId: params?.workspaceId ?? null,
    status: params?.status ?? null,
    category: params?.category ?? null,
    search: params?.search ?? null,
    excludeArchived: params?.excludeArchived ?? false,
    limit: params?.limit ?? 100,
    offset: params?.offset ?? 0,
  });
}

export async function getMemoryStats(params?: {
  project?: string;
  workspaceId?: number;
  status?: string;
  search?: string;
  /** Category totals include archived rows. Ignored when `status` is set. */
  includeArchived?: boolean;
}): Promise<MemoryStats> {
  return invoke("get_memory_stats", {
    project: params?.project ?? null,
    workspaceId: params?.workspaceId ?? null,
    status: params?.status ?? null,
    search: params?.search ?? null,
    includeArchived: params?.includeArchived ?? false,
  });
}

export async function getMural(project?: string): Promise<MuralManifest | null> {
  return invoke("get_mural", { project: project ?? null });
}

export async function getPrimers(project?: string): Promise<Primer[]> {
  return invoke("get_primers", { project: project ?? null });
}

export async function getPrimerCandidates(project?: string): Promise<PrimerCandidate[]> {
  return invoke("get_primer_candidates", { project: project ?? null });
}

export async function workspaceSchemaReady(): Promise<boolean> {
  return invoke("workspace_schema_ready");
}

export async function listWorkspaces(): Promise<WorkspaceListItem[]> {
  return invoke("list_workspaces");
}

export async function listWorkspaceSummaries(): Promise<WorkspaceSummary[]> {
  return invoke("list_workspace_summaries");
}

export async function createWorkspace(name: string): Promise<number> {
  return invoke("create_workspace", { name });
}

export async function renameWorkspace(workspaceId: number, name: string): Promise<void> {
  return invoke("rename_workspace", { workspaceId, name });
}

export async function deleteWorkspace(workspaceId: number): Promise<void> {
  return invoke("delete_workspace", { workspaceId });
}

export interface WorkspaceMemberChange {
  project_path: string;
  display_name: string;
  display_path: string;
}

export interface WorkspaceDisplayNameChange {
  project_path: string;
  display_name: string;
}

export async function applyWorkspaceChanges(params: {
  workspaceId: number;
  rename: string | null;
  addMembers: WorkspaceMemberChange[];
  removeMembers: string[];
  setDisplayNames: WorkspaceDisplayNameChange[];
  shareCategories: WorkspaceShareCategory[];
}): Promise<void> {
  return invoke("apply_workspace_changes", params);
}

/** Client-generated id for one write request. The backend replays the stored
 *  reply for a repeated id, so a retried click can never apply twice. */
export function newOperationId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // randomUUID needs a secure context; the served dashboard on a LAN address
  // is not one, so fall back to 128 random bits rendered as hex.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The memory a single-row edit targets, with the revision the UI displayed.
 *  The edit is refused as a conflict when the stored revision has moved on. */
export interface MemoryEditTarget {
  projectPath: string;
  memoryId: number;
  expectedRevision: number;
  operationId: string;
}

/** A bulk edit: one expected revision per memory, applied all-or-nothing. */
export interface MemoryBulkEditTarget {
  projectPath: string;
  memoryIds: number[];
  expectedRevisions: MemoryRevisionRef[];
  operationId: string;
}

export async function updateMemoryStatus(
  target: MemoryEditTarget,
  status: string,
): Promise<MemoryEditReceipt> {
  return invoke("update_memory_status", { ...target, status });
}

export async function updateMemoryContent(
  target: MemoryEditTarget,
  content: string,
): Promise<MemoryEditReceipt> {
  return invoke("update_memory_content", { ...target, content });
}

export async function updateMemoryCategory(
  target: MemoryEditTarget,
  category: string,
): Promise<MemoryEditReceipt> {
  return invoke("update_memory_category", { ...target, category });
}

/** Archives the memory (the command keeps its historical name; it never
 *  hard-deletes). The reply's decision key lets the archive be undone. */
export async function archiveMemory(target: MemoryEditTarget): Promise<MemoryEditReceipt> {
  return invoke("delete_memory", { ...target });
}

export async function bulkUpdateMemoryStatus(
  target: MemoryBulkEditTarget,
  status: string,
): Promise<MemoryEditReceipt> {
  return invoke("bulk_update_memory_status", { ...target, status });
}

/** Archives every listed memory in one undoable decision (never hard-deletes). */
export async function bulkArchiveMemories(
  target: MemoryBulkEditTarget,
): Promise<MemoryEditReceipt> {
  return invoke("bulk_delete_memory", { ...target });
}

// ── Memory history and undo ───────────────────────────────

/** Newest decision first; pass the returned cursor to read older ones. */
export async function getMemoryHistory(request: MemoryHistoryRequest): Promise<MemoryHistoryPage> {
  return invoke("get_memory_history", { request });
}

/** Plans an undo without changing anything. */
export async function previewMemoryRestore(request: {
  projectPath: string;
  decisionKey: string;
}): Promise<MemoryRestorePreview> {
  return invoke("preview_memory_restore", { request });
}

/** Restores the memories a decision touched to their state before it. */
export async function restoreMemoryHistory(
  request: MemoryRestoreRequest,
): Promise<MemoryRestoreReceipt> {
  return invoke("restore_memory_history", { request });
}

// ── Session API ─────────────────────────────────────────────

export async function getSessions(): Promise<SessionSummary[]> {
  return invoke("get_sessions");
}

export async function listSessions(filter?: SessionFilter): Promise<SessionRow[]> {
  const sanitized: SessionFilter = {};
  if (filter?.harness) sanitized.harness = filter.harness;
  if (filter?.project_identity) sanitized.project_identity = filter.project_identity;
  if (filter?.search) sanitized.search = filter.search;
  // is_subagent: pass `false` to filter OUT subagents, `true` to keep only
  // subagents. Skip the key entirely when unset so the backend treats it as
  // "no filter" — note `typeof === "boolean"` so we don't drop a literal
  // `false` via truthy check.
  if (typeof filter?.is_subagent === "boolean") sanitized.is_subagent = filter.is_subagent;

  return invoke("list_sessions", {
    filter: Object.keys(sanitized).length > 0 ? sanitized : null,
  });
}

function sanitizeSessionFilter(filter?: SessionFilter): SessionFilter {
  const sanitized: SessionFilter = {};
  if (filter?.harness) sanitized.harness = filter.harness;
  if (filter?.project_identity) sanitized.project_identity = filter.project_identity;
  if (filter?.search) sanitized.search = filter.search;
  if (typeof filter?.is_subagent === "boolean") sanitized.is_subagent = filter.is_subagent;
  if (typeof filter?.offset === "number") sanitized.offset = filter.offset;
  if (typeof filter?.limit === "number") sanitized.limit = filter.limit;
  return sanitized;
}

export async function listSessionsPaged(filter?: SessionFilter): Promise<PagedSessions> {
  const sanitized = sanitizeSessionFilter(filter);

  return invoke("list_sessions_paged", {
    filter: Object.keys(sanitized).length > 0 ? sanitized : null,
  });
}

export async function getSessionDetail(
  harness: Harness,
  sessionId: string,
): Promise<SessionDetail> {
  return invoke("get_session_detail", { harness, sessionId });
}

export async function getSubagentInvocations(sessionId: string): Promise<SubagentInvocation[]> {
  return invoke("get_subagent_invocations", { sessionId });
}

export async function getSubagentTotalsBySubagent(sessionId: string): Promise<SubagentTotals[]> {
  return invoke("get_subagent_totals_by_subagent", { sessionId });
}

export async function getSessionCacheEvents(
  harness: Harness,
  sessionId: string,
  // Caps the returned event count to the most recent N. Pass undefined or omit
  // for the whole session — but be aware that a hot OpenCode session can emit
  // 30k+ events (≈8MB of JSON across the Tauri IPC boundary), so chart-bound
  // callers should always pass a small bound. The dashboard's Cache page uses
  // the window picker (200–1000) for the initial/full load.
  limit?: number,
  // Incremental mode: when set, return this session's events with
  // `time_created >= sinceTimestamp` in chronological order (the `>=` overlaps
  // the caller's last-seen event by one row so cross-step severity is computed
  // correctly; dedupe by message_id). `limit` is ignored when this is set.
  sinceTimestamp?: number | null,
): Promise<DbCacheEvent[]> {
  return invoke("get_session_cache_events", {
    harness,
    sessionId,
    limit,
    sinceTimestamp: sinceTimestamp ?? null,
  });
}

/**
 * Fetch cache events for a session, trimmed to at most `targetTurns` complete
 * turns (most recent first). Use this for the Cache Hit Timeline so multi-step
 * tool-use turns don't collapse the bar chart.
 */
export async function getSessionCacheEventsByTurns(
  harness: Harness,
  sessionId: string,
  targetTurns: number,
): Promise<DbCacheEvent[]> {
  return invoke("get_session_cache_events_by_turns", {
    harness,
    sessionId,
    targetTurns,
  });
}

/**
 * Lazy fetch for the Messages tab. Returns the full message list for a session
 * (37k+ rows for long OpenCode sessions, ~28MB IPC payload). Only call this
 * when the user activates the Messages tab; `getSessionDetail()` returns a
 * cheap `messages_count` for the tab badge so we never pay this cost up front.
 */
export async function getSessionMessages(
  harness: Harness,
  sessionId: string,
): Promise<SessionMessageRow[]> {
  return invoke("get_session_messages", { harness, sessionId });
}

export async function enumerateProjects(): Promise<ProjectRow[]> {
  return invoke("enumerate_projects");
}

export async function getProjectCards(): Promise<import("./types").ProjectCard[]> {
  return invoke("get_project_cards");
}

export async function refreshProjectNames(): Promise<void> {
  return invoke("refresh_project_names");
}

export async function enumerateMemoryProjects(): Promise<ProjectRow[]> {
  return invoke("enumerate_memory_projects");
}

export async function getCompartments(sessionId: string): Promise<Compartment[]> {
  return invoke("get_compartments", { sessionId });
}

export async function getSessionFacts(sessionId: string): Promise<SessionFact[]> {
  return invoke("get_session_facts", { sessionId });
}

export async function getSessionNotes(sessionId: string): Promise<Note[]> {
  return invoke("get_session_notes", { sessionId });
}

export async function getSmartNotes(projectPath: string): Promise<Note[]> {
  return invoke("get_smart_notes", { projectPath });
}

export async function updateSessionFact(factId: number, content: string): Promise<void> {
  return invoke("update_session_fact", { factId, content });
}

export async function deleteSessionFact(factId: number): Promise<void> {
  return invoke("delete_session_fact", { factId });
}

export async function updateNote(noteId: number, content: string): Promise<void> {
  return invoke("update_note", { noteId, content });
}

export async function deleteNote(noteId: number): Promise<void> {
  return invoke("delete_note", { noteId });
}

export async function dismissNote(noteId: number): Promise<void> {
  return invoke("dismiss_note", { noteId });
}

export async function getSessionMeta(sessionId: string): Promise<SessionMetaRow | null> {
  return invoke("get_session_meta", { sessionId });
}

export async function getContextTokenBreakdown(
  sessionId: string,
): Promise<ContextTokenBreakdown | null> {
  return invoke("get_context_token_breakdown", { sessionId });
}

export async function getSessionCacheStats(
  limit?: number,
): Promise<import("./types").SessionCacheStats[]> {
  return invoke("get_session_cache_stats", { maxLines: 5000, limit: limit ?? 5 });
}

export async function getSessionCacheStatsFromDb(
  limit?: number,
  showUnmanaged?: boolean,
  hideSubagents?: boolean,
  harnessFilter?: import("./types").Harness,
): Promise<import("./types").SessionCacheStats[]> {
  return invoke("get_session_cache_stats_from_db", {
    limit: limit ?? 5,
    showUnmanaged: showUnmanaged ?? false,
    hideSubagents: hideSubagents ?? false,
    harnessFilter,
  });
}

// ── Dreamer API ─────────────────────────────────────────────

export async function getTaskScheduleState(): Promise<TaskScheduleEntry[]> {
  return invoke("get_task_schedule_state");
}

export async function getDreamState(): Promise<DreamStateEntry[]> {
  return invoke("get_dream_state");
}

export async function getDreamerProjects(): Promise<import("./types").DreamerProject[]> {
  return invoke("get_dreamer_projects");
}

export async function getDreamRuns(projectPath?: string, limit?: number): Promise<DreamRun[]> {
  return invoke("get_dream_runs", {
    projectPath: projectPath ?? null,
    limit: limit ?? 20,
  });
}

export async function getDreamRunMemoryChanges(runId: number): Promise<DreamRunMemoryDetail> {
  return invoke("get_dream_run_memory_changes", { runId });
}

// ── Log & Cache API ─────────────────────────────────────────

export async function getLogPaths(): Promise<string[]> {
  return invoke("get_log_paths");
}

export async function getLogEntries(maxLines?: number): Promise<LogEntry[]> {
  return invoke("get_log_entries", { maxLines: maxLines ?? 500 });
}

export async function getCacheEvents(maxLines?: number): Promise<CacheEvent[]> {
  return invoke("get_cache_events", { maxLines: maxLines ?? 2000 });
}

export async function getCacheEventsFromDb(
  limit?: number,
  sinceTimestamp?: number | null,
): Promise<DbCacheEvent[]> {
  return invoke("get_cache_events_from_db", {
    limit: limit ?? 200,
    sinceTimestamp: sinceTimestamp ?? null,
  });
}

// ── Config API ──────────────────────────────────────────────

export async function getConfig(source: string, projectPath?: string): Promise<ConfigFile> {
  return invoke("get_config", { source, projectPath });
}

export async function saveConfig(source: string, content: string): Promise<void> {
  return invoke("save_config", { source, content });
}

export async function getPiConfig(): Promise<ConfigFile> {
  return invoke("read_pi_config");
}

export async function savePiConfig(content: string): Promise<void> {
  return invoke("write_pi_config", { content });
}

// ── Health API ──────────────────────────────────────────────

export async function getDbHealth(): Promise<DbHealth> {
  return invoke("get_db_health");
}

export async function getProjectConfigs(): Promise<import("./types").ProjectConfigEntry[]> {
  return invoke("get_project_configs");
}

export async function saveProjectConfig(projectPath: string, content: string): Promise<void> {
  return invoke("save_project_config", { projectPath, content });
}

export async function getOpencodeInstallState(): Promise<OpencodeInstallState> {
  return invoke("get_opencode_install_state");
}

export async function getModelCatalogs(): Promise<ModelCatalogs> {
  return invoke("get_model_catalogs");
}

// ── User Memory API ─────────────────────────────────────────

export async function getUserMemories(status?: string): Promise<UserMemory[]> {
  return invoke("get_user_memories", { status: status ?? null });
}

export async function getUserMemoryCandidates(): Promise<UserMemoryCandidate[]> {
  return invoke("get_user_memory_candidates");
}

export async function dismissUserMemory(id: number): Promise<void> {
  return invoke("dismiss_user_memory", { id });
}

export async function restoreUserMemory(id: number): Promise<void> {
  return invoke("restore_user_memory", { id });
}

export async function deleteUserMemory(id: number): Promise<void> {
  return invoke("delete_user_memory", { id });
}

export async function updateUserMemoryContent(id: number, content: string): Promise<void> {
  return invoke("update_user_memory_content", { id, content });
}

export async function deleteUserMemoryCandidate(id: number): Promise<void> {
  return invoke("delete_user_memory_candidate", { id });
}

export async function promoteUserMemoryCandidate(id: number): Promise<void> {
  return invoke("promote_user_memory_candidate", { id });
}

// ── Utilities ───────────────────────────────────────────────

export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  // Future timestamp (e.g. a not-yet-due schedule) → "in X" rather than a
  // nonsensical negative "-72912s ago".
  if (diff < 0) {
    const seconds = Math.floor(-diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `in ${days}d`;
    if (hours > 0) return `in ${hours}h`;
    if (minutes > 0) return `in ${minutes}m`;
    return `in ${seconds}s`;
  }
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days === 1) return "yesterday";
  if (days > 1) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  const month = d.toLocaleString("en", { month: "short" });
  return `${month} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}…`;
}
