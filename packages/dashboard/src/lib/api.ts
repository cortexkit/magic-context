import { invoke } from "@tauri-apps/api/core";
import type {
  CacheEvent,
  Compartment,
  ConfigFile,
  ContextTokenBreakdown,
  DbCacheEvent,
  DbHealth,
  DreamQueueEntry,
  DreamRun,
  DreamStateEntry,
  Harness,
  LogEntry,
  Memory,
  MemoryStats,
  Note,
  PagedSessions,
  ProjectRow,
  SessionDetail,
  SessionFact,
  SessionFilter,
  SessionMessageRow,
  KeyFileRow,
  SessionMetaRow,
  SessionRow,
  SessionSummary,
  UserMemory,
  UserMemoryCandidate,
} from "./types";

// ── Memory API ──────────────────────────────────────────────

export async function getProjects(): Promise<import("./types").ProjectInfo[]> {
  return invoke("get_projects");
}

export async function getMemories(params?: {
  project?: string;
  status?: string;
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<Memory[]> {
  return invoke("get_memories", {
    project: params?.project ?? null,
    status: params?.status ?? null,
    category: params?.category ?? null,
    search: params?.search ?? null,
    limit: params?.limit ?? 100,
    offset: params?.offset ?? 0,
  });
}

export async function getMemoryStats(project?: string): Promise<MemoryStats> {
  return invoke("get_memory_stats", { project: project ?? null });
}

export async function updateMemoryStatus(memoryId: number, status: string): Promise<void> {
  return invoke("update_memory_status", { memoryId, status });
}

export async function updateMemoryContent(memoryId: number, content: string): Promise<void> {
  return invoke("update_memory_content", { memoryId, content });
}

export async function deleteMemory(memoryId: number): Promise<void> {
  return invoke("delete_memory", { memoryId });
}

export async function bulkUpdateMemoryStatus(memoryIds: number[], status: string): Promise<number> {
  return invoke("bulk_update_memory_status", { memoryIds, status });
}

export async function bulkDeleteMemory(memoryIds: number[]): Promise<number> {
  return invoke("bulk_delete_memory", { memoryIds });
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

export async function getSessionCacheEvents(
  harness: Harness,
  sessionId: string,
  // Caps the returned event count to the most recent N. Pass undefined or omit
  // for the whole session — but be aware that a hot OpenCode session can emit
  // 30k+ events (≈8MB of JSON across the Tauri IPC boundary), so chart-bound
  // callers should always pass a small bound. The dashboard's Cache page uses
  // 200 to match the per-session window of the global cache-events query.
  limit?: number,
): Promise<DbCacheEvent[]> {
  return invoke("get_session_cache_events", { harness, sessionId, limit });
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

export async function getProjectKeyFiles(projectPath: string): Promise<KeyFileRow[]> {
  return invoke("get_project_key_files", { projectPath });
}

export async function enumerateProjects(): Promise<ProjectRow[]> {
  return invoke("enumerate_projects");
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
): Promise<import("./types").SessionCacheStats[]> {
  return invoke("get_session_cache_stats_from_db", { limit: limit ?? 5 });
}

// ── Dreamer API ─────────────────────────────────────────────

export async function getDreamQueue(): Promise<DreamQueueEntry[]> {
  return invoke("get_dream_queue");
}

export async function getDreamState(): Promise<DreamStateEntry[]> {
  return invoke("get_dream_state");
}

export async function getDreamRuns(projectPath?: string, limit?: number): Promise<DreamRun[]> {
  return invoke("get_dream_runs", {
    projectPath: projectPath ?? null,
    limit: limit ?? 20,
  });
}

export async function enqueueDream(projectPath: string, reason: string): Promise<number> {
  return invoke("enqueue_dream", { projectPath, reason });
}

// ── Log & Cache API ─────────────────────────────────────────

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

export async function getConfig(source: string): Promise<ConfigFile> {
  return invoke("get_config", { source });
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

export async function getAvailableModels(): Promise<string[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("get_available_models");
}

export async function getAvailablePiModels(): Promise<string[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("get_available_pi_models");
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

export async function deleteUserMemory(id: number): Promise<void> {
  return invoke("delete_user_memory", { id });
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
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}…`;
}
