// Types matching Rust backend structs

export interface Memory {
  id: number;
  project_path: string;
  category: MemoryCategory;
  content: string;
  normalized_hash: string;
  source_session_id: string | null;
  source_type: MemorySourceType;
  seen_count: number;
  retrieval_count: number;
  first_seen_at: number;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
  last_retrieved_at: number | null;
  status: MemoryStatus;
  expires_at: number | null;
  verification_status: string;
  verified_at: number | null;
  superseded_by_memory_id: number | null;
  merged_from: string | null;
  metadata_json: string | null;
  has_embedding: boolean;
}

export type MemoryCategory =
  | "ARCHITECTURE_DECISIONS"
  | "CONSTRAINTS"
  | "CONFIG_DEFAULTS"
  | "NAMING"
  | "USER_PREFERENCES"
  | "USER_DIRECTIVES"
  | "ENVIRONMENT"
  | "WORKFLOW_RULES"
  | "KNOWN_ISSUES";

export type MemoryStatus = "active" | "permanent" | "archived";
export type MemorySourceType = "historian" | "agent" | "dreamer" | "user";

export interface MemoryStats {
  total: number;
  active: number;
  permanent: number;
  archived: number;
  with_embeddings: number;
  categories: CategoryCount[];
}

export interface CategoryCount {
  category: string;
  count: number;
}

export interface SessionSummary {
  session_id: string;
  title: string | null;
  project_identity: string | null;
  compartment_count: number;
  fact_count: number;
  note_count: number;
  first_compartment_start: number | null;
  last_compartment_end: number | null;
  last_response_time: number | null;
  last_context_percentage: number | null;
  is_subagent: boolean;
}

export type Harness = "opencode" | "pi";

export interface SessionFilter {
  harness?: Harness;
  project_identity?: string;
  search?: string;
  /**
   * `true` = subagents only, `false` = primary sessions only, omitted = both.
   * The "Subagents" toggle on the Hist tab sends `false` when unchecked so
   * subagent sessions (which dominate the row count) are filtered server-side.
   */
  is_subagent?: boolean;
  offset?: number;
  limit?: number;
}

export interface SessionRow {
  harness: Harness;
  session_id: string;
  title: string;
  project_identity: string;
  project_display: string;
  message_count: number;
  last_activity_ms: number;
  is_subagent: boolean;
}

export interface PagedSessions {
  rows: SessionRow[];
  total: number;
  has_more: boolean;
}

export interface SessionMessageRow {
  message_id: string;
  timestamp_ms: number;
  role: string;
  text_preview: string;
  raw_json: unknown;
}

export interface PiCompactionEntry {
  entry_id: string;
  parent_id: string | null;
  timestamp_ms: number;
  summary: string;
  first_kept_entry_id: string;
  tokens_before: number;
  from_hook: boolean;
  raw_json?: unknown;
}

export interface SessionDetail {
  harness: Harness;
  session_id: string;
  title: string;
  project_identity: string;
  project_display: string;
  project_path: string | null;
  opencode_session_json: unknown | null;
  pi_jsonl_path: string | null;
  // Cheap counts so the Messages and Cache tab badges render without paying
  // the cost of the underlying lists. Messages are fetched lazily by
  // `getSessionMessages`; cache events by `getSessionCacheEvents`.
  messages_count: number;
  cache_events_count: number;
  compartments: Compartment[];
  facts: SessionFact[];
  notes: Note[];
  meta: SessionMetaRow | null;
  token_breakdown: ContextTokenBreakdown | null;
  pi_compaction_entries: PiCompactionEntry[];
}

export interface KeyFileRow {
  project_path: string;
  path: string;
  content: string;
  content_hash: string;
  local_token_estimate: number;
  generated_at: number;
  generated_by_model: string | null;
  generation_config_hash: string;
  stale_reason: string | null;
  version: number;
}

export interface ProjectRow {
  identity: string;
  display_name: string;
  primary_path: string;
  harnesses: Harness[];
  session_count: number;
}

export interface Compartment {
  id: number;
  session_id: string;
  sequence: number;
  start_message: number;
  end_message: number;
  start_message_id?: string;
  end_message_id?: string;
  title: string;
  content: string;
  created_at: number;
  /** Resolved from OpenCode DB — epoch ms */
  start_time?: number;
  /** Resolved from OpenCode DB — epoch ms */
  end_time?: number;
  /**
   * Compression depth (max across the compartment's ordinal range):
   * 0 = uncompressed, 1 = merged, 2 = caveman-lite, 3 = caveman-full,
   * 4 = caveman-ultra, 5 = title-only collapse.
   */
  compression_depth: number;
}

export interface SessionFact {
  id: number;
  session_id: string;
  category: string;
  content: string;
  created_at: number;
  updated_at: number;
}

export interface Note {
  id: number;
  type: "session" | "smart";
  status: "active" | "pending" | "ready" | "dismissed";
  content: string;
  session_id: string | null;
  project_path: string | null;
  surface_condition: string | null;
  created_at: number;
  updated_at: number;
  last_checked_at: number | null;
  ready_at: number | null;
  ready_reason: string | null;
}

export interface SessionMetaRow {
  session_id: string;
  last_response_time: number | null;
  cache_ttl: string | null;
  counter: number;
  last_nudge_tokens: number;
  last_nudge_band: string;
  is_subagent: boolean;
  last_context_percentage: number;
  last_input_tokens: number;
  times_execute_threshold_reached: number;
  compartment_in_progress: boolean;
  system_prompt_hash: string;
  memory_block_count: number;
}

export interface ContextTokenBreakdown {
  total_input_tokens: number;
  system_prompt_tokens: number;
  compartment_tokens: number;
  fact_tokens: number;
  memory_tokens: number;
  conversation_tokens: number;
  compartment_count: number;
  fact_count: number;
  memory_count: number;
}

export interface DreamQueueEntry {
  id: number;
  project_path: string;
  reason: string;
  enqueued_at: number;
  started_at: number | null;
  retry_count: number;
}

export interface DreamStateEntry {
  key: string;
  value: string;
}

export interface DreamRunTask {
  name: string;
  durationMs: number;
  resultChars: number;
  error?: string;
}

export interface DreamRunMemoryChanges {
  written?: number;
  deleted?: number;
  archived?: number;
  merged?: number;
}

export interface DreamRun {
  id: number;
  project_path: string;
  started_at: number;
  finished_at: number;
  holder_id: string;
  tasks_json: DreamRunTask[];
  tasks_succeeded: number;
  tasks_failed: number;
  smart_notes_surfaced: number;
  smart_notes_pending: number;
  memory_changes_json: DreamRunMemoryChanges | null;
}

export interface LogEntry {
  timestamp: string;
  component: string;
  session_id: string;
  message: string;
  raw: string;
  cache_read: number | null;
  cache_write: number | null;
  hit_ratio: number | null;
}

export interface CacheEvent {
  timestamp: string;
  session_id: string;
  cache_read: number;
  cache_write: number;
  input_tokens: number;
  hit_ratio: number;
  cause: string | null;
  severity: "stable" | "info" | "warning" | "bust" | "full_bust";
}

export interface DbCacheEvent {
  harness: Harness;
  message_id: string;
  session_id: string;
  timestamp: number;
  input_tokens: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  hit_ratio: number;
  severity: "stable" | "info" | "warning" | "bust" | "full_bust" | "warming";
  cause: string | null;
  agent: string | null;
  finish?: string;
  turn_id: string;
  is_turn_start: boolean;
}

export interface SessionCacheStats {
  session_id: string;
  event_count: number;
  total_cache_read: number;
  total_cache_write: number;
  total_input: number;
  hit_ratio: number;
  last_timestamp: string;
  bust_count: number;
}

export interface ConfigFile {
  path: string;
  exists: boolean;
  content: string;
  source: string;
}

export interface ProjectConfigEntry {
  project_name: string;
  worktree: string;
  config_path: string;
  exists: boolean;
  alt_config_path: string | null;
  alt_exists: boolean;
}

export interface DbHealth {
  exists: boolean;
  path: string;
  size_bytes: number;
  wal_size_bytes: number;
  table_counts: TableCount[];
}

export interface TableCount {
  table_name: string;
  row_count: number;
}

export interface ProjectInfo {
  identity: string;
  label: string;
  path: string | null;
}

export interface UserMemory {
  id: number;
  content: string;
  status: "active" | "dismissed";
  promoted_at: number | null;
  source_candidate_ids: number[] | null;
  created_at: number;
  updated_at: number;
}

export interface UserMemoryCandidate {
  id: number;
  content: string;
  session_id: string;
  source_compartment_start: number | null;
  source_compartment_end: number | null;
  created_at: number;
}

export type NavSection =
  | "memories"
  | "sessions"
  | "cache"
  | "dreamer"
  | "user-memories"
  | "config"
  | "logs";
