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

export interface Compartment {
  id: number;
  session_id: string;
  sequence: number;
  start_message: number;
  end_message: number;
  title: string;
  content: string;
  created_at: number;
}

export interface SessionFact {
  id: number;
  session_id: string;
  category: string;
  content: string;
  created_at: number;
  updated_at: number;
}

export interface SessionNote {
  id: number;
  session_id: string;
  content: string;
  created_at: number;
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

export type NavSection =
  | "memories"
  | "sessions"
  | "cache"
  | "dreamer"
  | "config"
  | "logs";
